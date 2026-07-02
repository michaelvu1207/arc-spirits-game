/**
 * Production neural bot — the trained candidate-scoring policy, packaged to drop into the
 * live server bot driver (`server/botSim.ts`) exactly like the heuristic planner.
 *
 *   planNeuralPhaseActions(state, seat, catalog) → GameCommand[]
 *
 * Same shape/contract as `planBotPhaseActions`: returns the batch of commands the bot wants
 * to issue for the CURRENT phase. We greedily pick one legal action at a time (scored by the
 * net), simulating locally on the pure reducer to build the list, until the seat no longer
 * needs to act (a navigation lock / encounter resolve / commit ends its turn) or a safety
 * cap is hit. botSim then issues the returned commands for real via the CAS path.
 *
 * Weights are loaded once from the bundled export (ml/train.py → policy-weights.json). If no
 * trained weights are present the loader returns null and the caller falls back to heuristics,
 * so this never breaks a build or a live game.
 */

import { botSeatNeedsToAct } from '../server/botPolicy';
import {
	VP_TO_WIN,
	type GameCommand,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { buildBotObservation, type BotObservationV1 } from '../bots/contract';
import { buildMonsterRewards } from '../monsterRewards';
import { ACT_DIM, OBS_DIM, encodeAction, encodeObs } from './encode';
import { legalActionsWithNext, type LegalAction } from './actions';
import { planDecisionGumbel } from './gumbelPlanner';
import { loadPolicyWeights, type NeuralPolicy } from './net';

/** Safety cap on actions per phase so a degenerate policy can never loop forever. */
const MAX_ACTIONS_PER_PHASE = 40;

/**
 * Weight on the immediate VP gained by an action, on top of the value head's estimate of
 * the resulting position. VP is the win condition, so rewarding it directly makes the bot
 * actually fight monsters / launch the +3-VP PvP attack instead of idling — the policy head
 * alone (trained by imitation) collapses to frequent filler actions.
 */
const VP_SHAPE = 1.0;
/** Reward for an action that immediately wins the game (reaches the VP target). */
const WIN_SCORE = 1e6;
/**
 * Reward for descending the corruption ladder toward Fallen. Under current rules the ONLY
 * winning line at 4+ players is the Fallen group-attack (+3 VP/round) — so deliberately
 * corrupting to Fallen is correct, the opposite of normal play. This shaping makes the
 * value-lookahead actively seek the setup the sparse VP signal can't reach on its own.
 */
const STATUS_SHAPE =
	process.env.ARC_STATUS_SHAPE !== undefined ? parseFloat(process.env.ARC_STATUS_SHAPE) : 0.25;
/**
 * Penalty for an action that leaves the player's material situation unchanged within the same
 * phase (e.g. `refillMarket` with no purchase). The value head is smooth, so without this the
 * lookahead ties and collapses onto such no-ops, spamming them until the safety cap. Penalizing
 * them forces the bot toward actions that actually change its position or advance the phase.
 */
const NOOP_PENALTY = 0.5;
const REFILL_MARKET_PENALTY = 1.0;
const PENDING_REWARD_VP_SHAPE = 1.0;
const FARM_VALUE_AUX_SHAPE =
	process.env.ARC_FARM_VALUE_AUX_SHAPE !== undefined ? parseFloat(process.env.ARC_FARM_VALUE_AUX_SHAPE) : 0.25;
const FARM_NAV_AUX_SHAPE =
	process.env.ARC_FARM_NAV_AUX_SHAPE !== undefined ? parseFloat(process.env.ARC_FARM_NAV_AUX_SHAPE) : 0;
const FARM_NAV_AUX_THRESHOLD =
	process.env.ARC_FARM_NAV_AUX_THRESHOLD !== undefined ? parseFloat(process.env.ARC_FARM_NAV_AUX_THRESHOLD) : 0;
const FARM_NAV_AUX_MIN_MONSTER_HP =
	process.env.ARC_FARM_NAV_AUX_MIN_MONSTER_HP !== undefined ? parseFloat(process.env.ARC_FARM_NAV_AUX_MIN_MONSTER_HP) : 4;
const FARM_NAV_AUX_MAX_MONSTER_HP =
	process.env.ARC_FARM_NAV_AUX_MAX_MONSTER_HP !== undefined ? parseFloat(process.env.ARC_FARM_NAV_AUX_MAX_MONSTER_HP) : 5;
const FARM_NAV_AUX_MAX_STATUS =
	process.env.ARC_FARM_NAV_AUX_MAX_STATUS !== undefined ? parseInt(process.env.ARC_FARM_NAV_AUX_MAX_STATUS, 10) : 2;
const REWARD_PICK_AUX_SHAPE =
	process.env.ARC_REWARD_PICK_AUX_SHAPE !== undefined ? parseFloat(process.env.ARC_REWARD_PICK_AUX_SHAPE) : 0.5;
const REWARD_PICK_AUX_TEMP =
	process.env.ARC_REWARD_PICK_AUX_TEMP !== undefined ? parseFloat(process.env.ARC_REWARD_PICK_AUX_TEMP) : 0.5;
const LOOKAHEAD_DISCOUNT =
	process.env.ARC_LOOKAHEAD_DISCOUNT !== undefined ? parseFloat(process.env.ARC_LOOKAHEAD_DISCOUNT) : 0.95;
const DEFAULT_LOOKAHEAD_BEAM =
	process.env.ARC_LOOKAHEAD_BEAM !== undefined ? parseInt(process.env.ARC_LOOKAHEAD_BEAM, 10) : 8;
const DEFAULT_LOOKAHEAD_ROOT_BEAM =
	process.env.ARC_LOOKAHEAD_ROOT_BEAM !== undefined ? parseInt(process.env.ARC_LOOKAHEAD_ROOT_BEAM, 10) : 24;

function entriesSig(obj: Record<string, number> | undefined): string {
	return Object.entries(obj ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}:${v}`)
		.join(',');
}

/**
 * Cheap signature of a player's material/progression state; ignores table churn such as market
 * refills and object positions so only meaningful player/rules progress counts.
 */
function materialSig(state: PublicGameState, seat: SeatColor): string {
	const p = state.players[seat];
	if (!p) return `${state.phase}:${state.round}`;
	const spirits = [...(p.spirits ?? [])]
		.sort((a, b) => a.slotIndex - b.slotIndex)
		.map(
			(s) =>
				`${s.slotIndex}:${s.id}:${s.cost}:${s.isFaceDown ? 1 : 0}:${entriesSig(s.classes)}:${entriesSig(s.origins)}`
		)
		.join(',');
	const mats = [...(p.mats ?? [])]
		.sort((a, b) => a.slotIndex - b.slotIndex)
		.map((m) => `${m.slotIndex}:${m.id ?? ''}:${m.type ?? ''}:${m.classId ?? ''}:${m.originId ?? ''}:${m.special ? 1 : 0}`)
		.join(',');
	const dice = [...(p.attackDice ?? [])]
		.map((d) => d.tier)
		.sort()
		.join(',');
	const hand = [...(p.handDraws ?? [])]
		.sort((a, b) => a.guid.localeCompare(b.guid))
		.map((h) => `${h.id ?? ''}:${h.cost ?? 0}:${h.sourceBag ?? ''}`)
		.join(',');
	const pendingDraw = p.pendingDraw
		? `${p.pendingDraw.sourceBag}:${p.pendingDraw.drawCount}:${p.pendingDraw.summonLimit}:${p.pendingDraw.summonedCount}:${p.pendingDraw.autoAwaken ? 1 : 0}`
		: '';
	const pendingQueue = (p.pendingDrawQueue ?? [])
		.map((q) => `${q.sourceBag}:${q.drawCount}:${q.summonLimit}:${q.autoAwaken ? 1 : 0}`)
		.join(',');
	const pendingReward = p.pendingReward
		? `${p.pendingReward.monsterId}:${p.pendingReward.chooseAmount}:${p.pendingReward.rewardTrack.join(',')}`
		: '';
	const pendingAwakenReward = p.pendingAwakenReward
		? p.pendingAwakenReward.grants
				.map((g) => `${g.kind}:${'amount' in g ? g.amount : 0}:${g.source}`)
				.join(',')
		: '';
	const attachments = [...(p.spiritAugmentAttachments ?? [])]
		.sort((a, b) => a.spiritSlotIndex - b.spiritSlotIndex || a.runeId.localeCompare(b.runeId))
		.map((a) => `${a.spiritSlotIndex}:${a.runeId}:${a.classId ?? ''}`)
		.join(',');
	const unplacedAugments = [...(p.unplacedAugments ?? [])]
		.map((a) => `${a.runeId}:${a.classId ?? ''}:${a.boundSlotIndex ?? ''}:${a.hostClass ?? ''}`)
		.sort()
		.join(',');
	const monster = state.monster
		? `${state.monster.id}:${state.monster.hp}:${state.monster.livesRemaining}:${state.monster.ladderIndex}`
		: '';
	return [
		state.phase,
		state.round,
		state.navigation[seat]?.locked ? 1 : 0,
		p.navigationDestination ?? '',
		p.pendingDestination ?? '',
		p.phaseReady ? 1 : 0,
		p.victoryPoints,
		p.statusLevel,
		p.barrier,
		p.maxBarrier,
		p.brokenBarrier,
		p.corruptionCount ?? 0,
		(p.actionsUsedThisRound ?? []).join(','),
		spirits,
		dice,
		mats,
		hand,
		pendingDraw,
		pendingQueue,
		pendingReward,
		pendingAwakenReward,
		p.pendingCorruptionDiscard?.count ?? 0,
		p.awakenOffers?.length ?? 0,
		p.awakenLocked?.length ?? 0,
		p.pendingDecisions?.length ?? 0,
		p.manualPrompts?.length ?? 0,
		attachments,
		unplacedAugments,
		monster
	].join('|');
}

function nonProgressPenalty(cmd: GameCommand): number {
	return cmd.type === 'refillMarket' ? REFILL_MARKET_PENALTY : NOOP_PENALTY;
}

function isProgressTransition(state: PublicGameState, seat: SeatColor, next: PublicGameState): boolean {
	return materialSig(next, seat) !== materialSig(state, seat);
}

function progressCandidateIndices(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[]
): number[] {
	const out: number[] = [];
	for (let i = 0; i < withNext.length; i++) {
		if (isProgressTransition(state, seat, withNext[i].next)) out.push(i);
	}
	return out;
}

function selectableCandidateIndices(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[]
): number[] {
	const progress = progressCandidateIndices(state, seat, withNext);
	return progress.length > 0 ? progress : withNext.map((_, i) => i);
}

function pickMappedIndexFromScores(
	indices: number[],
	scores: number[],
	opts?: { sample?: boolean; temperature?: number; rand?: () => number }
): number {
	if (indices.length <= 1) return indices[0] ?? 0;
	const local = pickFromScores(indices.map((i) => scores[i]), opts);
	return indices[local] ?? 0;
}

function pendingRewardVpPotential(state: PublicGameState, seat: SeatColor): number {
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return 0;
	return buildMonsterRewards(pending.rewardTrack)
		.map((opt) => (opt.effect.type === 'vp' ? opt.effect.amount : 0))
		.sort((a, b) => b - a)
		.slice(0, pending.chooseAmount)
		.reduce((sum, vp) => sum + vp, 0);
}

function farmValueBonus(policy: NeuralPolicy, obs: number[]): number {
	const fn = (policy as unknown as { farmValue?: (obs: number[]) => number }).farmValue;
	if (FARM_VALUE_AUX_SHAPE <= 0 || typeof fn !== 'function') return 0;
	const raw = fn.call(policy, obs);
	if (!Number.isFinite(raw)) return 0;
	return FARM_VALUE_AUX_SHAPE * Math.max(0, Math.min(1, raw));
}

function farmValueRaw(policy: NeuralPolicy, obs: number[]): number {
	const fn = (policy as unknown as { farmValue?: (obs: number[]) => number }).farmValue;
	if (typeof fn !== 'function') return 0;
	const raw = fn.call(policy, obs);
	return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
}

function farmNavigationActionBonus(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	cmd: GameCommand
): number {
	if (FARM_NAV_AUX_SHAPE <= 0 || cmd.type !== 'lockNavigation' || cmd.destination !== 'Arcane Abyss') return 0;
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || monster.livesRemaining <= 0) return 0;
	const monsterHp = monster.hp ?? monster.maxHp ?? 0;
	if (monsterHp < FARM_NAV_AUX_MIN_MONSTER_HP || monsterHp > FARM_NAV_AUX_MAX_MONSTER_HP) return 0;
	if ((player.statusLevel ?? 0) > FARM_NAV_AUX_MAX_STATUS) return 0;
	const farm = farmValueRaw(policy, encodeObs(state, seat));
	if (farm < FARM_NAV_AUX_THRESHOLD) return 0;
	return FARM_NAV_AUX_SHAPE * farm;
}

function policyStateValue(policy: NeuralPolicy, state: PublicGameState, seat: SeatColor): number {
	const obs = encodeObs(state, seat);
	return policy.value(obs) + farmValueBonus(policy, obs);
}

function rewardPickAuxProbs(policy: NeuralPolicy, obs: number[], cands: number[][]): number[] | null {
	const fn = (policy as unknown as { rewardPickProbs?: (obs: number[], cands: number[][], temperature?: number) => number[] | null }).rewardPickProbs;
	if (REWARD_PICK_AUX_SHAPE <= 0 || typeof fn !== 'function') return null;
	return fn.call(policy, obs, cands, REWARD_PICK_AUX_TEMP);
}

/**
 * Score each legal candidate by 1-ply lookahead over the REAL engine: the value head's
 * estimate of the resulting position for `seat`, plus the immediate VP it gains. Uses the
 * next-states the legality dry-run already produced — no extra simulation cost.
 */
export function scoreByValue(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	catalog?: PlayCatalog
): number[] {
	const curVP = state.players[seat]?.victoryPoints ?? 0;
	const curStatus = state.players[seat]?.statusLevel ?? 0;
	const curSig = materialSig(state, seat);
	const curPendingRewardVp = pendingRewardVpPotential(state, seat);
	const rootObs = encodeObs(state, seat);
	const rewardPickProbs = state.players[seat]?.pendingReward
		? rewardPickAuxProbs(policy, rootObs, withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)))
		: null;
	// Only chase corruption while there are enough players for the PvP line to pay off.
	const pvpMeta = state.activeSeats.length >= 3;
	return withNext.map((action, i) => {
		const next = action.next;
		if (next.winnerSeat === seat) return WIN_SCORE;
		const v = policyStateValue(policy, next, seat);
		const dVP = ((next.players[seat]?.victoryPoints ?? 0) - curVP) / VP_TO_WIN;
		const dPendingRewardVP = Math.max(0, pendingRewardVpPotential(next, seat) - curPendingRewardVp) / VP_TO_WIN;
		const dStatus = pvpMeta ? ((next.players[seat]?.statusLevel ?? 0) - curStatus) / 3 : 0;
		const noop = materialSig(next, seat) === curSig ? nonProgressPenalty(action.cmd) : 0;
		const rewardPickBonus = action.cmd.type === 'resolveMonsterReward' ? REWARD_PICK_AUX_SHAPE * (rewardPickProbs?.[i] ?? 0) : 0;
		const farmNavBonus = farmNavigationActionBonus(policy, state, seat, action.cmd);
		return v + VP_SHAPE * dVP + PENDING_REWARD_VP_SHAPE * dPendingRewardVP + STATUS_SHAPE * dStatus + rewardPickBonus + farmNavBonus - noop;
	});
}

function transitionReward(state: PublicGameState, seat: SeatColor, action: LegalAction): number {
	const next = action.next;
	if (next.winnerSeat === seat) return WIN_SCORE;
	const curVP = state.players[seat]?.victoryPoints ?? 0;
	const curStatus = state.players[seat]?.statusLevel ?? 0;
	const curPendingRewardVp = pendingRewardVpPotential(state, seat);
	const dVP = ((next.players[seat]?.victoryPoints ?? 0) - curVP) / VP_TO_WIN;
	const dPendingRewardVP = Math.max(0, pendingRewardVpPotential(next, seat) - curPendingRewardVp) / VP_TO_WIN;
	const pvpMeta = state.activeSeats.length >= 3;
	const dStatus = pvpMeta ? ((next.players[seat]?.statusLevel ?? 0) - curStatus) / 3 : 0;
	const noop = isProgressTransition(state, seat, next) ? 0 : nonProgressPenalty(action.cmd);
	return VP_SHAPE * dVP + PENDING_REWARD_VP_SHAPE * dPendingRewardVP + STATUS_SHAPE * dStatus - noop;
}

function leafValue(policy: NeuralPolicy, state: PublicGameState, seat: SeatColor): number {
	if (state.winnerSeat === seat) return WIN_SCORE;
	if (state.status === 'finished') return 0;
	return policyStateValue(policy, state, seat);
}

function topIndices(scores: number[], limit: number): number[] {
	return scores
		.map((score, index) => ({ score, index }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, Math.max(1, Math.min(limit, scores.length)))
		.map((x) => x.index);
}

function pickFromScores(
	scores: number[],
	opts?: { sample?: boolean; temperature?: number; rand?: () => number }
): number {
	if (scores.length <= 1) return 0;
	if (!opts?.sample) {
		let best = 0;
		for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
		return best;
	}
	const t = Math.max(1e-3, opts.temperature ?? 0.1);
	let max = -Infinity;
	for (const s of scores) if (s > max) max = s;
	const exps = scores.map((s) => Math.exp((s - max) / t));
	const sum = exps.reduce((a, b) => a + b, 0) || 1;
	const r = (opts.rand ?? Math.random)();
	let acc = 0;
	for (let i = 0; i < exps.length; i++) {
		acc += exps[i] / sum;
		if (r <= acc) return i;
	}
	return exps.length - 1;
}

export function scoresToPolicyTarget(scores: number[], temperature = 0.25): number[] {
	if (scores.length === 0) return [];
	if (scores.length === 1) return [1];
	const t = Math.max(1e-3, temperature);
	let max = -Infinity;
	for (const s of scores) if (s > max) max = s;
	const exps = scores.map((s) => Math.exp((s - max) / t));
	const sum = exps.reduce((a, b) => a + b, 0) || 1;
	return exps.map((x) => x / sum);
}

function lookaheadActionScore(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	action: LegalAction,
	catalog: PlayCatalog,
	depth: number,
	beam: number
): number {
	const next = action.next;
	const reward = transitionReward(state, seat, action) + farmNavigationActionBonus(policy, state, seat, action.cmd);
	if (reward >= WIN_SCORE / 2) return reward;
	if (depth <= 0 || next.status !== 'active' || !botSeatNeedsToAct(next, seat)) {
		return reward + leafValue(policy, next, seat);
	}
	const children = legalActionsWithNext(next, seat, catalog);
	if (children.length === 0) return reward + leafValue(policy, next, seat);
	const shallow = children.map((child) =>
		transitionReward(next, seat, child) + farmNavigationActionBonus(policy, next, seat, child.cmd) + leafValue(policy, child.next, seat)
	);
	let best = -Infinity;
	for (const i of topIndices(shallow, beam)) {
		best = Math.max(best, lookaheadActionScore(policy, next, seat, children[i], catalog, depth - 1, beam));
	}
	return reward + LOOKAHEAD_DISCOUNT * best;
}

/**
 * Depth-limited full-command lookahead. This is intentionally still bounded and local:
 * expand all root candidates shallowly, then deepen only the best root/child beams. It
 * gives full-control AlphaZero a sequence-aware teacher for market/combat/cleanup
 * decisions without exploding the large parameterized action surface.
 */
export function lookaheadIndex(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	catalog: PlayCatalog,
	opts?: {
		depth?: number;
		beam?: number;
		rootBeam?: number;
		sample?: boolean;
		temperature?: number;
		rand?: () => number;
	}
): number {
	if (withNext.length <= 1) return 0;
	const scores = scoreByLookahead(policy, state, seat, withNext, catalog, opts);
	return pickMappedIndexFromScores(selectableCandidateIndices(state, seat, withNext), scores, opts);
}

export function scoreByLookahead(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	catalog: PlayCatalog,
	opts?: {
		depth?: number;
		beam?: number;
		rootBeam?: number;
	}
): number[] {
	if (withNext.length === 0) return [];
	const depth = Math.max(0, opts?.depth ?? 2);
	const beam = Math.max(1, opts?.beam ?? DEFAULT_LOOKAHEAD_BEAM);
	const rootBeam = Math.max(1, opts?.rootBeam ?? DEFAULT_LOOKAHEAD_ROOT_BEAM);
	const scores = withNext.map((action) => transitionReward(state, seat, action) + farmNavigationActionBonus(policy, state, seat, action.cmd) + leafValue(policy, action.next, seat));
	if (depth > 0) {
		for (const i of topIndices(scores, rootBeam)) {
			scores[i] = lookaheadActionScore(policy, state, seat, withNext[i], catalog, depth - 1, beam);
		}
	}
	return scores;
}

/**
 * HYBRID selection — the production policy. Combines the imitation policy (which learned the
 * champion's strategic POSITIONING: camp the Rest chokepoint, fight to corrupt → Fallen) with
 * a hard "never pass up VP" rule via 1-ply lookahead. The decisive winning action — the
 * Fallen group-attack `initiatePvp` (+3 VP) — is RARE in the data, so behaviour-cloning skips
 * it; but it gives immediate VP, so the lookahead always grabs it. This fixes the "sets up the
 * hunt but never pulls the trigger" failure that left BC-only at ~0 VP.
 */
export function hybridIndex(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	opts?: { sample?: boolean; temperature?: number; rand?: () => number },
	catalog?: PlayCatalog
): number {
	if (withNext.length <= 1) return 0;
	const curVP = state.players[seat]?.victoryPoints ?? 0;
	// 1) Take an outright win immediately; otherwise the largest immediate VP gain (if any).
	let bestVpIdx = -1;
	let bestVpGain = 0;
	for (let i = 0; i < withNext.length; i++) {
		const n = withNext[i].next;
		if (n.winnerSeat === seat) return i;
		const gain = (n.players[seat]?.victoryPoints ?? 0) - curVP;
		if (gain > bestVpGain) {
			bestVpGain = gain;
			bestVpIdx = i;
		}
	}
	if (bestVpIdx >= 0 && bestVpGain > 0) return bestVpIdx;
	// 1b) Always launch the Fallen group attack when it's available. `initiatePvp` is ONLY
	// legal when this seat is Fallen and co-located with Good players — i.e. exactly the
	// winning condition — but its +3 VP is applied at encounter RESOLUTION (next phase), so
	// the immediate-VP check above can't see it and behaviour-cloning skips the rare action.
	const pvp = withNext.findIndex((x) => x.cmd.type === 'initiatePvp');
	if (pvp >= 0) return pvp;
	// 2) No immediate VP → the learned POLICY head positions (distilled by AWR self-play from
	// the agent's OWN winning trajectories). Tactical VP/PvP grabs above are deterministic; the
	// policy handles the strategic positioning (go to the Abyss, corrupt, camp the chokepoint).
	return policyIndexWithProgressGuard(policy, state, seat, withNext, opts, catalog);
}

export function policyIndexWithProgressGuard(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	opts?: { sample?: boolean; temperature?: number; rand?: () => number },
	catalog?: PlayCatalog
): number {
	const progress = progressCandidateIndices(state, seat, withNext);
	const filtered =
		progress.length > 0 && progress.length < withNext.length
			? progress.map((i) => withNext[i])
			: withNext;
	const picked = policy.pick(
		encodeObs(state, seat),
		filtered.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
		{
			sample: opts?.sample,
			temperature: opts?.temperature,
			rand: opts?.rand
		}
	);
	return filtered === withNext ? picked : progress[picked];
}

/** Pick a candidate index by value-lookahead. Greedy by default; softmax-sample for
 *  exploration during self-play data generation. */
export function valueGuidedIndex(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	opts?: { sample?: boolean; temperature?: number; rand?: () => number },
	catalog?: PlayCatalog
): number {
	const scores = scoreByValue(policy, state, seat, withNext, catalog);
	return pickMappedIndexFromScores(selectableCandidateIndices(state, seat, withNext), scores, opts);
}

let cached: NeuralPolicy | null | undefined;

/**
 * Load the bundled trained weights once. Returns null (and caches it) if they're absent or
 * malformed, so callers transparently fall back to the heuristic. Uses a dynamic import so a
 * missing weights file is a caught runtime no-op, not a build failure.
 */
export async function getNeuralPolicy(): Promise<NeuralPolicy | null> {
	if (cached !== undefined) return cached;
	try {
		const mod = await import('./policy-weights.json');
		const json = (mod as { default?: unknown }).default ?? mod;
		if (!json || (json as { format?: string }).format !== 'arc-cand-scorer-v1') {
			cached = null;
		} else {
			cached = loadPolicyWeights(json, { expectedObsDim: OBS_DIM, expectedActDim: ACT_DIM });
		}
	} catch {
		cached = null;
	}
	return cached;
}

export function buildNeuralBotObservation(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): BotObservationV1 {
	return buildBotObservation(
		state,
		seat,
		legalActionsWithNext(state, seat, catalog).map((action) => action.cmd)
	);
}

export function planUniformLegalPhaseActions(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	rand: () => number = Math.random
): GameCommand[] {
	const out: GameCommand[] = [];
	let s = state;
	let guard = 0;
	while (botSeatNeedsToAct(s, seat) && guard < MAX_ACTIONS_PER_PHASE) {
		guard += 1;
		const withNext = legalActionsWithNext(s, seat, catalog);
		if (withNext.length === 0) break;
		const idx = Math.min(withNext.length - 1, Math.floor(rand() * withNext.length));
		out.push(withNext[idx].cmd);
		s = withNext[idx].next;
	}
	return out;
}

export interface NeuralPlanOptions {
	/**
	 * Expert tier: Gumbel root search at the STRATEGIC nodes — navigation
	 * (sampled from π': the simultaneous hidden pick must mix, a deterministic
	 * lock is exploitable) and encounter (argmax: replaces the hand-coded
	 * "always initiatePvp" rule with real lookahead, which can also veto).
	 * All other phases stay hybridIndex.
	 */
	search?: boolean;
	/** Sim budget per searched decision (default 16). */
	searchSims?: number;
	/** Search seed; live callers leave it undefined (fresh noise per decision). */
	searchSeed?: number;
}

/** Synchronous variant when the caller already holds a policy (e.g. self-play / eval).
 *  Returns the batch of commands for the current phase, chosen by value-lookahead. */
export function planNeuralPhaseActions(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	opts: NeuralPlanOptions = {}
): GameCommand[] {
	const out: GameCommand[] = [];
	let s = state;
	let guard = 0;
	while (botSeatNeedsToAct(s, seat) && guard < MAX_ACTIONS_PER_PHASE) {
		guard += 1;
		const withNext = legalActionsWithNext(s, seat, catalog);
		if (withNext.length === 0) break;
		// Production baseline = champion-imitation POLICY head (hunter-style positioning),
		// plus the hard "always fire the Fallen group attack when legal" rule (rare in data,
		// but the win condition). NOTE: this is a BASELINE — it positions like the hunter but
		// does not reliably execute the deliberate corruption→Fallen setup; beating the
		// heuristics needs the RL scale-up (see ml/README.md "Status").
		let idx = -1;
		if (opts.search && (s.phase === 'navigation' || s.phase === 'encounter') && withNext.length > 1) {
			const res = planDecisionGumbel(s, seat, catalog, policy, withNext, {
				simulations: opts.searchSims ?? 16,
				horizonRounds: 6,
				valueWeight: 0.5,
				seed: opts.searchSeed ?? (Math.random() * 0x7fffffff) >>> 0,
				temperature: s.phase === 'navigation' ? 0.8 : 0
			});
			if (res) idx = res.index;
		}
		if (idx < 0) idx = hybridIndex(policy, s, seat, withNext, { sample: false }, catalog);
		out.push(withNext[idx].cmd);
		s = withNext[idx].next;
	}
	return out;
}
