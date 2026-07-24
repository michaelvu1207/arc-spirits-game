/**
 * Remote v2 (entity-transformer) live bot planner.
 *
 * The v2 champion (`arc-entity-scorer-v2`, obs-v2 3419 floats / 104 action features)
 * cannot run in-process: it is a PyTorch set-transformer served by ml/infer_server.py.
 * This module is the production bridge: an HTTP client for the infer shim plus an async
 * port of `planNeuralPhaseActions` that builds obs-v2 per decision and scores candidates
 * remotely. Selection reproduces the exact hybrid contract the checkpoint was validated
 * under (hybridIndex → policyIndexWithProgressGuard → softmax pick over logits).
 *
 * Configuration (all server-side env):
 *   ARC_INFER_URL    base URL of the shim, e.g. https://host.ts.net/arc-infer
 *   ARC_INFER_TOKEN  shared secret sent as X-Arc-Token
 *
 * Every failure throws; callers (botSim) degrade to the bundled v1 policy, so a remote
 * outage can never take down bot play — it just plays the older champion.
 */

import { botSeatNeedsToAct } from '../server/botPolicy';
import {
	VP_TO_WIN,
	type GameCommand,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { encodeAction } from './encode';
import { encodeEntityObsV2, flattenObsV2 } from './encodeV2';
import { legalActionsWithNext, policyPreviewState, type LegalAction } from './actions';
import { isProgressTransition } from './neuralBot';

/** Safety cap on actions per phase; mirrors neuralBot's MAX_ACTIONS_PER_PHASE. */
const MAX_ACTIONS_PER_PHASE = 40;
/** Per-request timeout: a poll tick must never hang on a dead remote. */
const REQUEST_TIMEOUT_MS = 8_000;
/** After a handshake failure, don't retry the remote for this long. */
const FAILURE_COOLDOWN_MS = 60_000;

export interface RemoteV2Info {
	format: string;
	obs_dim: number;
	act_dim: number;
	device: string;
	weights_sha256?: string;
}

export class RemoteV2Client {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		readonly info: RemoteV2Info
	) {}

	static async connect(baseUrl: string, token: string): Promise<RemoteV2Client> {
		const res = await fetchWithTimeout(`${baseUrl}/info`, {
			headers: { 'X-Arc-Token': token }
		});
		if (!res.ok) throw new Error(`remoteV2 handshake: HTTP ${res.status}`);
		// The shim forwards infer_server's envelope: {"info": {...}}. Accept flat too.
		const body = (await res.json()) as { info?: RemoteV2Info } & RemoteV2Info;
		const info = body.info ?? body;
		if (info.format !== 'arc-entity-scorer-v2') {
			throw new Error(`remoteV2 handshake: unexpected format ${String(info.format)}`);
		}
		return new RemoteV2Client(baseUrl, token, info);
	}

	/** Raw logits for one decision's candidate set (batch of 1). */
	async scoreCandidates(obs: number[], cands: number[][]): Promise<number[]> {
		if (obs.length !== this.info.obs_dim) {
			throw new Error(`remoteV2: obs length ${obs.length} != server obs_dim ${this.info.obs_dim}`);
		}
		for (const cand of cands) {
			if (cand.length !== this.info.act_dim) {
				throw new Error(
					`remoteV2: action feature length ${cand.length} != act_dim ${this.info.act_dim}`
				);
			}
		}
		const res = await fetchWithTimeout(`${this.baseUrl}/score`, {
			method: 'POST',
			headers: { 'X-Arc-Token': this.token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ obs: [obs], cands: [cands], want: ['logits'] })
		});
		if (!res.ok) throw new Error(`remoteV2 score: HTTP ${res.status}`);
		const payload = (await res.json()) as { logits?: number[][]; error?: string };
		if (payload.error) throw new Error(`remoteV2 score: ${payload.error}`);
		const logits = payload.logits?.[0];
		if (
			!Array.isArray(logits) ||
			logits.length !== cands.length ||
			logits.some((l) => !Number.isFinite(l))
		) {
			throw new Error('remoteV2 score: malformed logits');
		}
		return logits;
	}
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

let cachedClient: RemoteV2Client | null | undefined;
let lastFailureAt = 0;

/**
 * Env-configured singleton. Null when ARC_INFER_URL is unset, the handshake fails, or a
 * failure happened within the cooldown window — callers then use the bundled v1 policy.
 */
export async function getRemoteV2Client(): Promise<RemoteV2Client | null> {
	const url = process.env.ARC_INFER_URL?.replace(/\/+$/, '');
	const token = process.env.ARC_INFER_TOKEN;
	if (!url || !token) return null;
	if (cachedClient) return cachedClient;
	if (Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) return null;
	try {
		cachedClient = await RemoteV2Client.connect(url, token);
		return cachedClient;
	} catch (err) {
		console.error('[remoteV2] handshake failed; using bundled v1 policy', err);
		lastFailureAt = Date.now();
		cachedClient = undefined;
		return null;
	}
}

/** Drop the cached client so the next tick re-handshakes (called on scoring failures). */
export function resetRemoteV2Client(): void {
	cachedClient = undefined;
	cachedFleet = undefined;
	lastFailureAt = Date.now();
}

let cachedFleet: RemoteV2Client[] | undefined;

/**
 * Champion fleet for multi-bot rooms. The shim optionally serves extra frozen champions
 * at `/m/b` and `/m/c` (same protocol, same token); seating DIFFERENT champions across a
 * room's bot seats breaks the mirror-clone starvation where identical policies chase the
 * same plan and split the shared monster ladder. Index 0 is always the primary (current)
 * champion, so single-bot rooms — heads-up — are unaffected. Endpoints that don't exist
 * or fail the handshake are simply absent: the fleet degrades toward [primary] and play
 * continues. ARC_FLEET=0 forces single-champion serving.
 */
export async function getRemoteV2Fleet(): Promise<RemoteV2Client[]> {
	const primary = await getRemoteV2Client();
	if (!primary) return [];
	if (process.env.ARC_FLEET === '0') return [primary];
	if (cachedFleet) return cachedFleet;
	const url = process.env.ARC_INFER_URL?.replace(/\/+$/, '');
	const token = process.env.ARC_INFER_TOKEN;
	if (!url || !token) return [primary];
	const extras: RemoteV2Client[] = [];
	for (const key of ['b', 'c']) {
		try {
			extras.push(await RemoteV2Client.connect(`${url}/m/${key}`, token));
		} catch {
			// Absent or down — serve without it. Never block play on a fleet member.
		}
	}
	cachedFleet = [primary, ...extras];
	return cachedFleet;
}

/** Port of net.ts `pick` semantics onto precomputed logits: argmax, or softmax sample. */
function pickFromLogits(
	logits: number[],
	opts: { sample: boolean; temperature: number; rand?: () => number }
): number {
	if (logits.length <= 1) return 0;
	if (!opts.sample || !(opts.temperature > 0)) {
		let best = 0;
		for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
		return best;
	}
	const t = Math.max(1e-6, opts.temperature);
	let max = -Infinity;
	for (const l of logits) if (l > max) max = l;
	const exps = logits.map((l) => Math.exp((l - max) / t));
	const sum = exps.reduce((a, b) => a + b, 0) || 1;
	const r = (opts.rand ?? Math.random)();
	let acc = 0;
	for (let i = 0; i < exps.length; i++) {
		acc += exps[i] / sum;
		if (r <= acc) return i;
	}
	return exps.length - 1;
}

/** Mirror of neuralBot's (unexported) progressCandidateIndices, built from its exports. */
function progressSupport(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[]
): number[] {
	const out: number[] = [];
	for (let i = 0; i < withNext.length; i++) {
		const action = withNext[i];
		if (action.hasHiddenOutcome || isProgressTransition(state, seat, policyPreviewState(action)))
			out.push(i);
	}
	return out;
}

/**
 * hybridIndex ported to precomputed logits: immediate win, then deterministic VP gain,
 * else the learned policy over the progress-guarded support. Identical decision contract
 * to hybridIndex → policyIndexWithProgressGuard with learnMonsterRewardChoices=false
 * (the live default), so v2 live play matches the validated gauntlet/benchmark behavior.
 */
function hybridIndexFromLogits(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	logits: number[],
	opts: { sample: boolean; temperature: number; rand?: () => number }
): number {
	if (withNext.length <= 1) return 0;
	const curVP = state.players[seat]?.victoryPoints ?? 0;
	let bestVpIdx = -1;
	let bestVpGain = 0;
	for (let i = 0; i < withNext.length; i++) {
		const n = policyPreviewState(withNext[i]);
		if (n.winnerSeat === seat || (n.players[seat]?.victoryPoints ?? 0) >= VP_TO_WIN) return i;
		const gain = (n.players[seat]?.victoryPoints ?? 0) - curVP;
		if (gain > bestVpGain) {
			bestVpGain = gain;
			bestVpIdx = i;
		}
	}
	if (bestVpIdx >= 0 && bestVpGain > 0) return bestVpIdx;
	const natural = progressSupport(state, seat, withNext);
	const support = natural.length > 0 ? natural : withNext.map((_, i) => i);
	const picked = pickFromLogits(
		support.map((i) => logits[i]),
		opts
	);
	return support[picked];
}

export interface RemoteV2PlanOptions {
	/** Sampling temperature (0 = argmax). The v2 champion was validated at 0.55. */
	temperature?: number;
	/**
	 * Where temperature applies. The v2 champion's benchmark/gauntlet runs sampled ALL
	 * phases (driver semantics), unlike v1 live's navigation-only default — so 'all' is
	 * the in-distribution setting here.
	 */
	temperatureScope?: 'all' | 'navigation';
}

/**
 * Async port of planNeuralPhaseActions for the remote v2 policy: same phase loop, same
 * corruption-debt handling, same safety cap; per decision it builds obs-v2 + action
 * features, scores them remotely, and picks via the hybrid contract. No search tier —
 * the v2 champion is a raw policy (search was measured harmful for v1 and is untrained
 * for v2).
 */
export async function planNeuralPhaseActionsV2(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	client: RemoteV2Client,
	opts: RemoteV2PlanOptions = {}
): Promise<GameCommand[]> {
	const out: GameCommand[] = [];
	let s = state;
	let guard = 0;
	let resolvingCorruption = !!s.players[seat]?.pendingCorruptionDiscard;
	while (botSeatNeedsToAct(s, seat) && guard < MAX_ACTIONS_PER_PHASE) {
		guard += 1;
		if (s.players[seat]?.pendingCorruptionDiscard) resolvingCorruption = true;
		let withNext = legalActionsWithNext(s, seat, catalog);
		if (withNext.length === 0) break;
		if (resolvingCorruption) {
			const debt = s.players[seat]?.pendingCorruptionDiscard;
			if (debt && (s.players[seat]?.spirits.length ?? 0) > 0) {
				const discards = withNext.filter((action) => action.cmd.type === 'discardSpirit');
				if (discards.length > 0) withNext = discards;
			} else {
				const yieldType =
					s.phase === 'location'
						? 'endLocationActions'
						: s.phase === 'cleanup'
							? 'commitCleanup'
							: null;
				const yieldAction = yieldType
					? withNext.find((action) => action.cmd.type === yieldType)
					: undefined;
				if (yieldAction) {
					out.push(yieldAction.cmd);
					s = yieldAction.next;
					resolvingCorruption = false;
					continue;
				}
			}
		}
		let idx = 0;
		if (withNext.length > 1) {
			const obs = flattenObsV2(encodeEntityObsV2(s, seat, catalog), catalog);
			const feats = withNext.map((x) =>
				encodeAction(s, seat, x.cmd, policyPreviewState(x), catalog)
			);
			const logits = await client.scoreCandidates(obs, feats);
			const temperature = opts.temperature ?? 0;
			const tempApplies = (opts.temperatureScope ?? 'all') === 'all' || s.phase === 'navigation';
			idx = hybridIndexFromLogits(s, seat, withNext, logits, {
				sample: temperature > 0 && tempApplies,
				temperature
			});
		}
		out.push(withNext[idx].cmd);
		s = withNext[idx].next;
	}
	return out;
}
