/**
 * RemotePolicy — a NeuralPolicy-compatible client for ml/infer_server.py.
 *
 * Wire: 4-byte little-endian length prefix on every frame; the first payload
 * byte disambiguates '{' = JSON vs 0xB1/0xB2 = binary (see the wire doc in
 * ml/infer_server.py). The info handshake is always JSON. SCORING frames pick
 * their encoding from the served checkpoint: binary for arc-entity-scorer-v2
 * (3,419-float rows — binary skips the float→text→float round trip that
 * dominates JSON cost there, 6-9x measured server-side at batch shapes), JSON
 * for v1's 188-float rows (where text encode is cheap and pre-binary servers
 * keep working by default). `wire: 'binary' | 'json'` overrides the cut.
 * Magic bytes are the protocol version: an unknown response magic is an
 * error, never a guess.
 *
 * Sync facade: playRecordingGame is synchronous, so socket IO cannot run on the
 * calling thread's event loop. Each RemotePolicy owns a tiny IO worker thread —
 * a dumb byte pipe that frames/deframes but never parses — and each request
 * blocks on Atomics.wait, then drains the reply with receiveMessageOnPort (the
 * synckit pattern). One request in flight at a time — the driver's cadence.
 * Server-side GPU batching comes from MANY actor workers' concurrent B=1
 * requests coalescing inside the server's --window-ms batcher.
 *
 * Determinism: the server computes in float32 (and per-batch padding can
 * perturb reductions), while net.ts runs float64. pick() is a stable argmax
 * within one backend, but remote vs in-process may diverge on decisions where
 * two candidates' logits differ near fp precision. Acceptable: league play
 * needs within-backend determinism only. Do not mix backends inside one
 * seed-comparison experiment. (The JSON and binary wires carry the same f32
 * values — wire choice does not affect results.)
 */
import {
	Worker,
	MessageChannel,
	receiveMessageOnPort,
	type MessagePort
} from 'node:worker_threads';
import type { NeuralPolicy } from './net';

export interface RemotePolicyInfo {
	format: string;
	obs_dim: number;
	act_dim: number;
	device: string;
	weights: string;
	aux: {
		farm_value: boolean;
		route_mode: boolean;
		reward_pick: boolean;
		placement: boolean;
		reach30: boolean;
	};
	reach30_horizon: number | null;
}

interface InferResponse {
	id?: unknown;
	error?: string;
	info?: RemotePolicyInfo;
	logits?: number[][];
	value?: number[];
	farm_value?: number[];
	route_mode?: number[];
	reward_pick?: number[][];
	placement?: number[][];
	reach30?: number[];
}

/** Sections a scoring request can ask for (subset of InferResponse). */
type ScoreResponse = Pick<
	InferResponse,
	'logits' | 'value' | 'farm_value' | 'route_mode' | 'reward_pick' | 'placement' | 'reach30'
>;

// Binary wire constants — MUST mirror ml/infer_server.py (BIN_* there).
const BIN_MAGIC_REQUEST = 0xb1;
const BIN_MAGIC_RESPONSE = 0xb2;
const BIN_ERROR_FLAG = 0x80;
const JSON_MAGIC = 0x7b; // '{'
const WANT = {
	logits: 1,
	value: 2,
	farm_value: 4,
	route_mode: 8,
	reward_pick: 16,
	reach30: 32,
	placement: 64
} as const;
/** Response/flag section order is fixed; bit i of the flags byte = SECTION_ORDER[i]. */
const SECTION_ORDER = [
	'logits',
	'value',
	'farm_value',
	'route_mode',
	'reward_pick',
	'reach30',
	'placement'
] as const;

/**
 * Request = [0xB1 u8][want u8][id_len u32][B u32][obs_dim u32][act_dim u32]
 *           [C_i u32 x B][id utf8][obs f32 x B*obs_dim][cands f32 row-major].
 */
function encodeBinaryRequest(
	id: string,
	wantBits: number,
	obs: number[][],
	cands: number[][][]
): Buffer {
	const idb = Buffer.from(id, 'utf8');
	const B = obs.length;
	const obsDim = obs[0]?.length ?? 0;
	const actDim = cands[0]?.[0]?.length ?? 0;
	const sumC = cands.reduce((a, c) => a + c.length, 0);
	const out = Buffer.allocUnsafe(18 + 4 * B + idb.length + 4 * B * obsDim + 4 * sumC * actDim);
	out.writeUInt8(BIN_MAGIC_REQUEST, 0);
	out.writeUInt8(wantBits, 1);
	out.writeUInt32LE(idb.length, 2);
	out.writeUInt32LE(B, 6);
	out.writeUInt32LE(obsDim, 10);
	out.writeUInt32LE(actDim, 14);
	let off = 18;
	for (const c of cands) {
		out.writeUInt32LE(c.length, off);
		off += 4;
	}
	idb.copy(out, off);
	off += idb.length;
	const writeRow = (row: number[]): void => {
		for (let i = 0; i < row.length; i++) {
			out.writeFloatLE(row[i], off);
			off += 4;
		}
	};
	for (const row of obs) writeRow(row);
	for (const c of cands) for (const row of c) writeRow(row);
	return out;
}

/**
 * Response = [0xB2 u8][flags u8][id_len u32][id utf8], then either the error
 * block (flags & 0x80: [msg_len u32][msg utf8]) or [B u32][C_i u32 x B] plus
 * one f32 section per set flag bit in SECTION_ORDER (ragged sections sliced
 * by the echoed C_i).
 */
function decodeBinaryResponse(payload: Uint8Array): { id: string; error?: string } & ScoreResponse {
	const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
	if (buf.length < 6 || buf.readUInt8(0) !== BIN_MAGIC_RESPONSE) {
		throw new Error(
			`RemotePolicy: unknown response magic 0x${buf.readUInt8(0).toString(16)} — protocol mismatch`
		);
	}
	const flags = buf.readUInt8(1);
	const idLen = buf.readUInt32LE(2);
	let off = 6;
	const id = buf.toString('utf8', off, off + idLen);
	off += idLen;
	if (flags & BIN_ERROR_FLAG) {
		const msgLen = buf.readUInt32LE(off);
		off += 4;
		return { id, error: buf.toString('utf8', off, off + msgLen) };
	}
	const B = buf.readUInt32LE(off);
	off += 4;
	const counts: number[] = [];
	for (let i = 0; i < B; i++) {
		counts.push(buf.readUInt32LE(off));
		off += 4;
	}
	const total = counts.reduce((a, b) => a + b, 0);
	const readFlat = (n: number): number[] => {
		const a = new Array<number>(n);
		for (let i = 0; i < n; i++) {
			a[i] = buf.readFloatLE(off);
			off += 4;
		}
		return a;
	};
	const ragged = (flat: number[]): number[][] => {
		const rows: number[][] = [];
		let i = 0;
		for (const c of counts) {
			rows.push(flat.slice(i, i + c));
			i += c;
		}
		return rows;
	};
	const out: { id: string; error?: string } & ScoreResponse = { id };
	for (let bit = 0; bit < SECTION_ORDER.length; bit++) {
		if (!(flags & (1 << bit))) continue;
		const key = SECTION_ORDER[bit];
		if (key === 'logits' || key === 'reward_pick') out[key] = ragged(readFlat(total));
		else if (key === 'placement') {
			const flat = readFlat(B * 4);
			out.placement = Array.from({ length: B }, (_, i) => flat.slice(i * 4, i * 4 + 4));
		} else out[key] = readFlat(B);
	}
	return out;
}

/**
 * IO worker: owns the net.Socket and the 4-byte length framing, nothing else —
 * payloads cross the port as raw bytes in both directions (the requesting
 * thread is blocked anyway, so it does its own JSON/binary parsing). Plain CJS
 * eval'd source: no TS loader needed, works under vitest and jiti alike.
 */
const IO_WORKER = `
const { workerData } = require('node:worker_threads');
const net = require('node:net');
const { socketPath, port, flag } = workerData;
const sig = new Int32Array(flag);
const wake = (msg) => {
	port.postMessage(msg);
	Atomics.store(sig, 0, 1);
	Atomics.notify(sig, 0);
};
let awaiting = false; // one in-flight request per bridge
let dead = null;
let buf = Buffer.alloc(0);
const sock = net.connect(socketPath);
sock.on('error', (e) => {
	dead = 'infer socket error: ' + e.message;
	if (awaiting) { awaiting = false; wake({ __error: dead }); }
});
sock.on('close', () => {
	dead = dead || 'infer socket closed';
	if (awaiting) { awaiting = false; wake({ __error: dead }); }
});
sock.on('data', (chunk) => {
	buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
	while (buf.length >= 4) {
		const len = buf.readUInt32LE(0);
		if (buf.length < 4 + len) break;
		const payload = Uint8Array.prototype.slice.call(buf, 4, 4 + len); // fresh copy
		buf = buf.subarray(4 + len);
		if (awaiting) { awaiting = false; wake(payload); }
	}
});
port.on('message', (bytes) => {
	if (dead) { wake({ __error: dead }); return; }
	awaiting = true;
	const frame = Buffer.allocUnsafe(4 + bytes.length);
	frame.writeUInt32LE(bytes.length, 0);
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).copy(frame, 4);
	sock.write(frame);
});
`;

class SyncInferBridge {
	private readonly worker: Worker;
	private readonly port: MessagePort;
	private readonly sig: Int32Array;
	private readonly timeoutMs: number;

	constructor(socketPath: string, timeoutMs: number) {
		this.timeoutMs = timeoutMs;
		const { port1, port2 } = new MessageChannel();
		this.port = port1;
		this.sig = new Int32Array(new SharedArrayBuffer(4));
		this.worker = new Worker(IO_WORKER, {
			eval: true,
			workerData: { socketPath, port: port2, flag: this.sig.buffer },
			transferList: [port2]
		});
		// The bridge must not keep the process alive on its own; close() is still the
		// polite shutdown (unref only covers forgotten bridges at process exit).
		this.worker.unref();
	}

	/** Send one payload, block until its reply payload arrives (raw bytes). */
	roundtrip(payload: Buffer | Uint8Array): Uint8Array {
		Atomics.store(this.sig, 0, 0);
		this.port.postMessage(payload);
		if (Atomics.wait(this.sig, 0, 0, this.timeoutMs) === 'timed-out') {
			throw new Error(`RemotePolicy: no response within ${this.timeoutMs}ms`);
		}
		// The IO worker posts the reply and THEN signals (postMessage → Atomics.notify),
		// but cross-thread MessagePort delivery is decoupled from the wake: under heavy
		// concurrency the notify routinely beats the posted message into this port's
		// queue, so the first receiveMessageOnPort can come back empty. The signal
		// guarantees a message is en route — spin (bounded by the same timeout) until it
		// lands instead of treating the delivery lag as a failure.
		let received = receiveMessageOnPort(this.port);
		if (!received) {
			const deadline = Date.now() + this.timeoutMs;
			do {
				received = receiveMessageOnPort(this.port);
			} while (!received && Date.now() < deadline);
			if (!received) throw new Error('RemotePolicy: woken but reply never arrived');
		}
		const msg = received.message as Uint8Array | { __error?: string };
		if (!(msg instanceof Uint8Array)) {
			throw new Error(`RemotePolicy: ${(msg as { __error?: string }).__error ?? 'bridge failure'}`);
		}
		return msg;
	}

	close(): void {
		this.port.close();
		void this.worker.terminate();
	}
}

function softmax(logits: number[], temperature: number): number[] {
	// Mirrors net.ts probs() exactly so behavior stats match across backends.
	const t = Math.max(1e-6, temperature);
	let max = -Infinity;
	for (const l of logits) if (l > max) max = l;
	const exps = logits.map((l) => Math.exp((l - max) / t));
	const sum = exps.reduce((a, b) => a + b, 0) || 1;
	return exps.map((e) => e / sum);
}

export class RemotePolicy {
	readonly info: RemotePolicyInfo;
	private readonly bridge: SyncInferBridge;
	private readonly wire: 'binary' | 'json';
	private readonly zeroCand: number[];
	private nextId = 0;
	/** Scoring roundtrips issued (handshake excluded) — memo-hit verification hook. */
	scoringRequests = 0;
	// Per-decision memo. Within ONE decision the policy is asked twice about the same
	// state: selection's pick() (via neuralBot, which RE-ENCODES the candidate features —
	// same content, different array identity) and then the driver's probs()+value() for
	// logpOld/vPred. Keying the cached logits+value on observation and candidate CONTENT
	// collapses those two roundtrips into one; a content compare (~C×52 floats) is noise
	// next to a socket RTT. Progress-guard-filtered picks reuse the matching rows from
	// the prefetched candidate superset.
	private lastObs: number[] | null = null;
	private lastCands: number[][] | null = null;
	private lastLogits: number[] | null = null;
	private lastValue = 0;
	private lastReach30: number | null = null;
	private lastPlacementLogits: number[] | null = null;

	/**
	 * `expectObsDim` pins the server's observation width at handshake time (OBS_DIM for
	 * the v1 MLP — 77 at obs v1.1, obsV2Meta().flatLength for arc-entity-scorer-v2). A mismatch — e.g. the
	 * server still holds a v1 checkpoint while the caller plays at policyObsVersion 2 —
	 * fails HERE with one clear error instead of per-request shape errors mid-game.
	 * `wire` overrides the scoring encoding (default: binary for v2 checkpoints, JSON
	 * for v1 — see the header; the handshake is always JSON either way).
	 */
	constructor(
		socketPath: string,
		opts?: { timeoutMs?: number; expectObsDim?: number; wire?: 'binary' | 'json' }
	) {
		this.bridge = new SyncInferBridge(socketPath, opts?.timeoutMs ?? 30_000);
		const resp = this.requestJson({ want: ['info'] });
		if (!resp.info) throw new Error('RemotePolicy: handshake returned no info');
		this.info = resp.info;
		this.wire = opts?.wire ?? (this.info.format === 'arc-entity-scorer-v2' ? 'binary' : 'json');
		if (opts?.expectObsDim !== undefined && this.info.obs_dim !== opts.expectObsDim) {
			const served = `${this.info.obs_dim} (${this.info.weights})`;
			this.bridge.close();
			throw new Error(
				`RemotePolicy: server obs_dim ${served} != expected ${opts.expectObsDim} — wrong checkpoint for this obs version`
			);
		}
		this.zeroCand = new Array<number>(this.info.act_dim).fill(0);
	}

	private requestJson(msg: Record<string, unknown>): InferResponse {
		const id = ++this.nextId;
		const payload = this.bridge.roundtrip(Buffer.from(JSON.stringify({ ...msg, id }), 'utf8'));
		if (payload[0] !== JSON_MAGIC) {
			throw new Error(
				`RemotePolicy: expected a JSON frame, got magic 0x${payload[0].toString(16)}`
			);
		}
		const resp = JSON.parse(
			Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8')
		) as InferResponse;
		if (resp.error) throw new Error(`RemotePolicy: server error: ${resp.error}`);
		if (resp.id !== id) {
			throw new Error(`RemotePolicy: response id ${String(resp.id)} != request id ${id}`);
		}
		return resp;
	}

	/** One B=1 scoring roundtrip for this decision's obs + candidate set. */
	private score(obs: number[], cands: number[][], wantBits: number): ScoreResponse {
		this.scoringRequests += 1;
		if (this.wire === 'json') {
			const want = SECTION_ORDER.filter((_, bit) => wantBits & (1 << bit));
			return this.requestJson({ obs: [obs], cands: [cands], want });
		}
		const id = String(++this.nextId);
		const resp = decodeBinaryResponse(
			this.bridge.roundtrip(encodeBinaryRequest(id, wantBits, [obs], [cands]))
		);
		if (resp.error) throw new Error(`RemotePolicy: server error: ${resp.error}`);
		if (resp.id !== id) throw new Error(`RemotePolicy: response id ${resp.id} != request id ${id}`);
		return resp;
	}

	private static rowEqual(a: number[], b: number[]): boolean {
		if (a === b) return true;
		if (a.length !== b.length) return false;
		for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return false;
		return true;
	}

	private static candsEqual(a: number[][], b: number[][]): boolean {
		if (a === b) return true;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!RemotePolicy.rowEqual(a[i], b[i])) return false;
		return true;
	}

	/**
	 * Per-candidate logits depend only on (obs, candidate) — batch mates are masked out —
	 * so any content-SUBSET of the cached candidate set (e.g. neuralBot's progress-filtered
	 * pick after the driver prefetched the full set) reuses the cached response row-by-row.
	 */
	private deriveFromCache(cands: number[][]): number[] | null {
		const cached = this.lastCands!;
		const logits = this.lastLogits!;
		const out = new Array<number>(cands.length);
		for (let i = 0; i < cands.length; i++) {
			let found = -1;
			for (let k = 0; k < cached.length; k++) {
				if (RemotePolicy.rowEqual(cands[i], cached[k])) {
					found = k;
					break;
				}
			}
			if (found < 0) return null;
			out[i] = logits[found];
		}
		return out;
	}

	scoreCandidates(obs: number[], cands: number[][]): number[] {
		if (
			this.lastObs &&
			RemotePolicy.rowEqual(obs, this.lastObs) &&
			this.lastLogits &&
			this.lastCands
		) {
			if (RemotePolicy.candsEqual(cands, this.lastCands)) return this.lastLogits;
			const derived = this.deriveFromCache(cands);
			if (derived) return derived; // cache keeps the superset — don't overwrite
		}
		const resp = this.score(
			obs,
			cands,
			WANT.logits |
				WANT.value |
				(this.info.aux.reach30 ? WANT.reach30 : 0) |
				(this.info.aux.placement ? WANT.placement : 0)
		);
		// Keep snapshots rather than caller-owned references: a later accidental mutation
		// must invalidate the memo instead of pairing new inputs with stale outputs.
		this.lastObs = obs.slice();
		this.lastCands = cands.map((row) => row.slice());
		this.lastLogits = resp.logits![0];
		this.lastValue = resp.value![0];
		this.lastReach30 = resp.reach30?.[0] ?? null;
		this.lastPlacementLogits = resp.placement?.[0] ?? null;
		return this.lastLogits;
	}

	value(obs: number[]): number {
		if (this.lastObs && RemotePolicy.rowEqual(obs, this.lastObs)) return this.lastValue;
		return this.score(obs, [this.zeroCand], WANT.value).value![0];
	}

	/** Optional 4-way final-placement probabilities (v1 KataGo outcome aux). */
	placementProbs(obs: number[]): number[] | null {
		if (!this.info.aux.placement) return null;
		let logits: number[];
		if (this.lastObs && RemotePolicy.rowEqual(obs, this.lastObs) && this.lastPlacementLogits) {
			logits = this.lastPlacementLogits;
		} else {
			logits = this.score(obs, [this.zeroCand], WANT.placement).placement![0];
		}
		return softmax(logits, 1);
	}

	farmValue(obs: number[]): number {
		if (!this.info.aux.farm_value) return 0;
		return this.score(obs, [this.zeroCand], WANT.farm_value).farm_value![0];
	}

	routeMode(obs: number[]): number | null {
		if (!this.info.aux.route_mode) return null;
		const raw = this.score(obs, [this.zeroCand], WANT.route_mode).route_mode![0];
		return 1 / (1 + Math.exp(-raw));
	}

	rewardPickScores(obs: number[], cands: number[][]): number[] | null {
		if (!this.info.aux.reward_pick) return null;
		return this.score(obs, cands, WANT.reward_pick).reward_pick![0];
	}

	reach30Probability(obs: number[]): number | null {
		if (!this.info.aux.reach30) return null;
		let raw: number;
		if (this.lastObs && RemotePolicy.rowEqual(obs, this.lastObs) && this.lastReach30 !== null)
			raw = this.lastReach30;
		else raw = this.score(obs, [this.zeroCand], WANT.reach30).reach30![0];
		return 1 / (1 + Math.exp(-raw));
	}

	reach30Horizon(): number | null {
		return this.info.aux.reach30 ? this.info.reach30_horizon : null;
	}

	rewardPickProbs(obs: number[], cands: number[][], temperature = 1): number[] | null {
		const logits = this.rewardPickScores(obs, cands);
		return logits ? softmax(logits, temperature) : null;
	}

	probs(obs: number[], cands: number[][], temperature = 1): number[] {
		return softmax(this.scoreCandidates(obs, cands), temperature);
	}

	/** Same selection semantics as net.ts pick(): greedy argmax, or seeded softmax sampling. */
	pick(
		obs: number[],
		cands: number[][],
		opts?: { sample?: boolean; temperature?: number; rand?: () => number }
	): number {
		if (cands.length <= 1) return 0;
		const logits = this.scoreCandidates(obs, cands);
		if (!opts?.sample) {
			let best = 0;
			for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
			return best;
		}
		const p = softmax(logits, opts.temperature ?? 1);
		const r = (opts.rand ?? Math.random)();
		let acc = 0;
		for (let i = 0; i < p.length; i++) {
			acc += p[i];
			if (r <= acc) return i;
		}
		return p.length - 1;
	}

	close(): void {
		this.bridge.close();
	}
}

/**
 * NeuralPolicy has a private member, so structural typing rejects RemotePolicy even
 * though it implements the full public surface. Every call site only uses that public
 * surface (nothing outside net.ts touches `.w`), so this cast is the supported way to
 * hand a RemotePolicy to driver/neuralBot code.
 */
export function asNeuralPolicy(remote: RemotePolicy): NeuralPolicy {
	return remote as unknown as NeuralPolicy;
}
