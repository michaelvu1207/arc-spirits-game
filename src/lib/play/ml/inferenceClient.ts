/**
 * RemotePolicy — a NeuralPolicy-compatible client for ml/infer_server.py.
 *
 * Speaks the server's Unix-socket protocol: 4-byte little-endian length prefix +
 * JSON. Request {id, obs: [B x obs_dim], cands: [B x C_i x act_dim], want: [...]};
 * response {id, logits: [B x C_i], value: [B], ...}; handshake {want: ["info"]}
 * returns dims + which aux heads the loaded checkpoint carries.
 *
 * Sync facade: playRecordingGame is synchronous, so socket IO cannot run on the
 * calling thread's event loop. Each RemotePolicy owns a tiny IO worker thread that
 * holds the socket; a request posts the message to the IO worker, blocks on
 * Atomics.wait, then drains the reply with receiveMessageOnPort (the synckit
 * pattern). One request is in flight at a time — exactly the driver's cadence.
 * Server-side GPU batching comes from MANY actor workers' concurrent B=1 requests
 * coalescing inside the server's --window-ms batcher, not from client batching.
 *
 * Determinism: the server computes in float32 (and per-batch padding can perturb
 * reductions), while net.ts runs float64. pick() is a stable argmax within one
 * backend, but remote vs in-process may diverge on decisions where two candidates'
 * logits differ near fp precision. That is acceptable: league play needs
 * within-backend determinism only. Do not mix backends inside one seed-comparison
 * experiment.
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
	aux: { farm_value: boolean; route_mode: boolean; reward_pick: boolean };
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
}

/**
 * IO worker: owns the net.Socket, frames/deframes the protocol, and wakes the
 * requesting thread via the shared flag. Plain CJS eval'd source — no TS loader
 * needed for these ~40 lines, so RemotePolicy works under vitest and jiti alike.
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
let pending = null; // id of the single in-flight request
let dead = null;
let buf = Buffer.alloc(0);
const sock = net.connect(socketPath);
sock.on('error', (e) => {
	dead = 'infer socket error: ' + e.message;
	if (pending !== null) { wake({ id: pending, error: dead }); pending = null; }
});
sock.on('close', () => {
	dead = dead || 'infer socket closed';
	if (pending !== null) { wake({ id: pending, error: dead }); pending = null; }
});
sock.on('data', (chunk) => {
	buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
	while (buf.length >= 4) {
		const len = buf.readUInt32LE(0);
		if (buf.length < 4 + len) break;
		const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
		buf = buf.subarray(4 + len);
		if (pending !== null) { pending = null; wake(msg); }
	}
});
port.on('message', (req) => {
	if (dead) { wake({ id: req.id, error: dead }); return; }
	pending = req.id;
	const data = Buffer.from(JSON.stringify(req), 'utf8');
	const frame = Buffer.allocUnsafe(4 + data.length);
	frame.writeUInt32LE(data.length, 0);
	data.copy(frame, 4);
	sock.write(frame);
});
`;

class SyncInferBridge {
	private readonly worker: Worker;
	private readonly port: MessagePort;
	private readonly sig: Int32Array;
	private readonly timeoutMs: number;
	private nextId = 0;

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

	request(msg: Record<string, unknown>): InferResponse {
		const id = ++this.nextId;
		Atomics.store(this.sig, 0, 0);
		this.port.postMessage({ ...msg, id });
		if (Atomics.wait(this.sig, 0, 0, this.timeoutMs) === 'timed-out') {
			throw new Error(`RemotePolicy: no response within ${this.timeoutMs}ms (id ${id})`);
		}
		const received = receiveMessageOnPort(this.port);
		if (!received) throw new Error('RemotePolicy: woken with no message queued');
		const resp = received.message as InferResponse;
		if (resp.error) throw new Error(`RemotePolicy: server error: ${resp.error}`);
		if (resp.id !== id)
			throw new Error(`RemotePolicy: response id ${String(resp.id)} != request id ${id}`);
		return resp;
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
	private readonly zeroCand: number[];
	// Per-decision memo: the driver calls probs(obs, …) then value(obs) with the SAME obs
	// array, so fetching logits+value together halves the roundtrips on recorded decisions.
	private lastObs: number[] | null = null;
	private lastValue = 0;

	/**
	 * `expectObsDim` pins the server's observation width at handshake time (62 for the
	 * v1 MLP, obsV2Meta().flatLength for arc-entity-scorer-v2). A mismatch — e.g. the
	 * server still holds a v1 checkpoint while the caller plays at policyObsVersion 2 —
	 * fails HERE with one clear error instead of per-request shape errors mid-game.
	 */
	constructor(socketPath: string, opts?: { timeoutMs?: number; expectObsDim?: number }) {
		this.bridge = new SyncInferBridge(socketPath, opts?.timeoutMs ?? 30_000);
		const resp = this.bridge.request({ want: ['info'] });
		if (!resp.info) throw new Error('RemotePolicy: handshake returned no info');
		this.info = resp.info;
		if (opts?.expectObsDim !== undefined && this.info.obs_dim !== opts.expectObsDim) {
			const served = `${this.info.obs_dim} (${this.info.weights})`;
			this.bridge.close();
			throw new Error(
				`RemotePolicy: server obs_dim ${served} != expected ${opts.expectObsDim} — wrong checkpoint for this obs version`
			);
		}
		this.zeroCand = new Array<number>(this.info.act_dim).fill(0);
	}

	scoreCandidates(obs: number[], cands: number[][]): number[] {
		const resp = this.bridge.request({ obs: [obs], cands: [cands], want: ['logits', 'value'] });
		this.lastObs = obs;
		this.lastValue = resp.value![0];
		return resp.logits![0];
	}

	value(obs: number[]): number {
		if (obs === this.lastObs) return this.lastValue;
		const resp = this.bridge.request({ obs: [obs], cands: [[this.zeroCand]], want: ['value'] });
		return resp.value![0];
	}

	farmValue(obs: number[]): number {
		if (!this.info.aux.farm_value) return 0;
		return this.bridge.request({ obs: [obs], cands: [[this.zeroCand]], want: ['farm_value'] })
			.farm_value![0];
	}

	routeMode(obs: number[]): number | null {
		if (!this.info.aux.route_mode) return null;
		const raw = this.bridge.request({ obs: [obs], cands: [[this.zeroCand]], want: ['route_mode'] })
			.route_mode![0];
		return 1 / (1 + Math.exp(-raw));
	}

	rewardPickScores(obs: number[], cands: number[][]): number[] | null {
		if (!this.info.aux.reward_pick) return null;
		return this.bridge.request({ obs: [obs], cands: [cands], want: ['reward_pick'] })
			.reward_pick![0];
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
