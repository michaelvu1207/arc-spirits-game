/**
 * V24 solo terminal teacher for ambiguous Arcane Abyss monster rewards.
 *
 * This module is deliberately offline-only.  It replaces the source game's
 * future RNG cursor and hidden bag order, reapplies each root command through
 * the reducer, and then rolls the frozen greedy policy to the real round cap.
 * No inference path imports this file.
 */

import type { BagsData } from '$lib/types';
import { shuffleBag } from '../bags';
import { applyGameCommand } from '../runtime';
import { createRng, hashString, nextInt } from '../rng';
import { botActorFor, profileFor, type BotRandom } from '../server/botPolicy';
import {
	MAX_ROUNDS,
	VP_TO_WIN,
	type GameCommand,
	type PlayCatalog,
	type PublicGameState,
	type RuntimeBagEntry,
	type SeatColor
} from '../types';
import { policyPreviewState, type LegalAction } from './actions';
import { rolloutPolicyToRound } from './gumbelPlanner';
import { hybridIndex } from './neuralBot';
import type { NeuralPolicy } from './net';

export const TERMINAL_TEACHER_VERSION = 1;
export const DEFAULT_TERMINAL_ROLLOUTS = 8;
export const DEFAULT_TERMINAL_TEMPERATURE = 0.1;
export const DEFAULT_PAIRED_UTILITY_MARGIN = 0.05;

export interface TerminalTeacherOptions {
	rollouts?: number;
	temperature?: number;
	/** Must identify the immutable captured state, never a candidate index/order. */
	stateId: string;
	/** Separates discovery, validation, and teacher-in-loop random streams. */
	salt?: string;
	maxStatusLevel?: number;
	pairedUtilityMargin?: number;
}

export interface TerminalRolloutOutcome {
	reached30: boolean;
	finalVP: number;
	post15VpPerRound: number;
	first30Round: number | null;
	stalled: boolean;
}

export interface TerminalCandidateStats {
	commandSignature: string;
	evaluated: boolean;
	reach30Wins: number;
	meanFinalVP: number;
	meanPost15VpPerRound: number;
	meanFirst30Round: number | null;
	meanUtility: number;
	stalls: number;
	q: number;
}

export interface TerminalTeacherLabel {
	version: typeof TERMINAL_TEACHER_VERSION;
	stateId: string;
	rollouts: number;
	bestIndex: number;
	decisive: boolean;
	pairedUtilityMargin: number;
	evaluatedMask: number[];
	terminalPi: number[];
	stats: TerminalCandidateStats[];
}

/** Exact JSONL schema consumed by the Python terminal-teacher loader. */
export interface TerminalTeacherCollectorRow {
	stateId: string;
	obs: number[];
	cands: number[][];
	evaluatedMask: number[];
	terminalPi: number[];
	teacherWeight?: number;
}

export interface TerminalTeacherDecision {
	index: number;
	label: TerminalTeacherLabel;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.filter((key) => record[key] !== undefined)
				.map((key) => [key, stableValue(record[key])])
		);
	}
	return value;
}

/** Stable identity for a command, independent of object key order. */
export function canonicalCommandSignature(command: GameCommand): string {
	if (command.type === 'resolveMonsterReward') {
		const pairs = command.picks.map((pick, index) => ({
			pick,
			choice: command.choices?.[index]
		}));
		pairs.sort((a, b) => a.pick - b.pick || (a.choice ?? -1) - (b.choice ?? -1));
		return JSON.stringify({
			type: command.type,
			picks: pairs.map((pair) => pair.pick),
			...(command.choices ? { choices: pairs.map((pair) => pair.choice ?? 0) } : {})
		});
	}
	return JSON.stringify(stableValue(command));
}

function compareBagEntries(a: RuntimeBagEntry, b: RuntimeBagEntry): number {
	const ka = [
		a.id ?? '',
		a.name,
		a.cost ?? -1,
		a.state ?? '',
		a.barrier ?? -1,
		a.damage ?? -1,
		a.guid
	];
	const kb = [
		b.id ?? '',
		b.name,
		b.cost ?? -1,
		b.state ?? '',
		b.barrier ?? -1,
		b.damage ?? -1,
		b.guid
	];
	for (let i = 0; i < ka.length; i += 1) {
		const cmp = String(ka[i]).localeCompare(String(kb[i]));
		if (cmp !== 0) return cmp;
	}
	return 0;
}

function rebuildHistory(state: PublicGameState): void {
	state.bags.history = {
		hexSpirits: state.bags.hexSpirits,
		monsters: state.bags.monsters,
		abyssFallen: state.bags.abyssFallen,
		stageDeck: state.bags.stageDeck,
		purgeBags: state.bags.purgeBags
	} satisfies BagsData;
}

function validateSoloState(state: PublicGameState, seat: SeatColor): void {
	if (
		state.activeSeats.length !== 1 ||
		state.activeSeats[0] !== seat ||
		!state.players[seat] ||
		Object.keys(state.players).some((key) => key !== seat)
	) {
		throw new Error('terminalTeacher: snapshot must contain exactly one active/private seat');
	}
	for (const [name, bag] of [
		['hexSpirits', state.bags.hexSpirits],
		['abyssFallen', state.bags.abyssFallen],
		['monsters', state.bags.monsters],
		['stageDeck', state.bags.stageDeck]
	] as const) {
		if (bag.count !== bag.contents.length) {
			throw new Error(`terminalTeacher: ${name} count/content mismatch`);
		}
	}
	// The current runtime represents the monster ladder outside these legacy bags.
	// Fail closed if that contract changes instead of accidentally leaking a deck order.
	if (state.bags.monsters.contents.length > 0 || state.bags.stageDeck.contents.length > 0) {
		throw new Error('terminalTeacher: unsupported ordered monster/stage bag');
	}
}

/**
 * Remove the source future RNG cursor and canonicalize every still-hidden bag.
 * The canonical order is only a neutral representation of the public multiset;
 * every rollout reshuffles it before a root command is applied.
 */
export function sanitizeSoloTerminalState(
	state: PublicGameState,
	seat: SeatColor
): PublicGameState {
	validateSoloState(state, seat);
	const clean = structuredClone(state) as PublicGameState;
	clean.rng = createRng(hashString('v24-terminal-sanitized'));
	clean.bags.hexSpirits.contents.sort(compareBagEntries);
	clean.bags.abyssFallen.contents.sort(compareBagEntries);
	clean.bags.monsters.contents.sort(compareBagEntries);
	clean.bags.stageDeck.contents.sort(compareBagEntries);
	rebuildHistory(clean);
	validateSoloState(clean, seat);
	return clean;
}

/** Common-random-number seed. Candidate identity/order is intentionally absent. */
export function terminalRolloutSeed(
	stateId: string,
	rolloutIndex: number,
	salt = 'discovery'
): number {
	if (!stateId) throw new Error('terminalTeacher: stateId is required');
	if (!Number.isInteger(rolloutIndex) || rolloutIndex < 0) {
		throw new Error('terminalTeacher: rolloutIndex must be a non-negative integer');
	}
	return hashString(`v24-terminal:${salt}:${stateId}:${rolloutIndex}`) || 1;
}

/** Install a synthetic future and independently reshuffle hidden bag order. */
export function redeterminizeSoloTerminalState(
	sanitized: PublicGameState,
	seat: SeatColor,
	stateId: string,
	rolloutIndex: number,
	salt = 'discovery'
): PublicGameState {
	validateSoloState(sanitized, seat);
	const state = structuredClone(sanitized) as PublicGameState;
	state.rng = createRng(terminalRolloutSeed(stateId, rolloutIndex, salt));
	shuffleBag(state.bags.hexSpirits.contents, state.rng);
	shuffleBag(state.bags.abyssFallen.contents, state.rng);
	rebuildHistory(state);
	return state;
}

function statusConstrainedActions(
	actions: LegalAction[],
	seat: SeatColor,
	maxStatusLevel: number | undefined
): LegalAction[] {
	if (maxStatusLevel === undefined) return actions;
	const filtered = actions.filter(
		(action) => (policyPreviewState(action).players[seat]?.statusLevel ?? 0) <= maxStatusLevel
	);
	// Matches the driver contract: forced progress is preferable to a deadlock.
	return filtered.length > 0 ? filtered : actions;
}

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed);
	return {
		int: (maxExclusive) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

function post15Pace(state: PublicGameState, seat: SeatColor): number {
	const player = state.players[seat];
	if (!player) return 0;
	const historyIndex = player.vpHistory.findIndex((vp) => vp >= 15);
	const first15Round =
		historyIndex >= 0 ? historyIndex + 1 : player.victoryPoints >= 15 ? state.round : null;
	if (first15Round === null) return 0;
	return Math.max(0, player.victoryPoints - 15) / Math.max(1, state.round - first15Round);
}

/** Reapply one root command and continue with the frozen greedy policy. */
export function rolloutTerminalCandidate(
	sanitized: PublicGameState,
	seat: SeatColor,
	command: GameCommand,
	policy: NeuralPolicy,
	catalog: PlayCatalog,
	options: TerminalTeacherOptions,
	rolloutIndex: number
): TerminalRolloutOutcome | null {
	const salt = options.salt ?? 'discovery';
	let state = applyTerminalRootCandidate(
		sanitized,
		seat,
		command,
		catalog,
		options.stateId,
		rolloutIndex,
		salt
	);
	if (!state) return null;
	if (
		options.maxStatusLevel !== undefined &&
		(state.players[seat]?.statusLevel ?? 0) > options.maxStatusLevel
	) {
		return null;
	}

	const choose = (
		current: PublicGameState,
		actingSeat: SeatColor,
		actions: LegalAction[]
	): number => {
		const support = statusConstrainedActions(actions, actingSeat, options.maxStatusLevel);
		const local = hybridIndex(policy, current, actingSeat, support, { sample: false }, catalog);
		return actions.indexOf(support[local] ?? support[0]);
	};
	state = rolloutPolicyToRound(
		state,
		catalog,
		profileFor('medium'),
		seededBotRandom(hashString(`${salt}:${options.stateId}:${rolloutIndex}:policy`)),
		MAX_ROUNDS,
		choose
	);
	const finalVP = state.players[seat]?.victoryPoints ?? 0;
	const reached30 = finalVP >= VP_TO_WIN;
	return {
		reached30,
		finalVP,
		post15VpPerRound: post15Pace(state, seat),
		first30Round: reached30 ? state.round : null,
		stalled: state.status === 'active' && state.round <= MAX_ROUNDS
	};
}

/** Redeterminize first, then apply the root through the reducer (never LegalAction.next). */
export function applyTerminalRootCandidate(
	sanitized: PublicGameState,
	seat: SeatColor,
	command: GameCommand,
	catalog: PlayCatalog,
	stateId: string,
	rolloutIndex: number,
	salt = 'discovery'
): PublicGameState | null {
	const state = redeterminizeSoloTerminalState(sanitized, seat, stateId, rolloutIndex, salt);
	const root = applyGameCommand(
		state,
		botActorFor(state, seat),
		structuredClone(command),
		catalog,
		{
			mutate: true
		}
	);
	return root.ok ? root.state : null;
}

function mean(xs: number[]): number {
	return xs.length === 0 ? 0 : xs.reduce((sum, value) => sum + value, 0) / xs.length;
}

function utility(outcome: TerminalRolloutOutcome): number {
	return Math.max(0, Math.min(1, outcome.finalVP / VP_TO_WIN));
}

function compareStats(a: TerminalCandidateStats, b: TerminalCandidateStats): number {
	return (
		b.reach30Wins - a.reach30Wins ||
		b.meanFinalVP - a.meanFinalVP ||
		b.meanPost15VpPerRound - a.meanPost15VpPerRound ||
		(a.meanFirst30Round ?? Infinity) - (b.meanFirst30Round ?? Infinity) ||
		a.commandSignature.localeCompare(b.commandSignature)
	);
}

function maskedSoftmax(q: number[], mask: number[], temperature: number): number[] {
	const evaluated = q.map((value, index) => (mask[index] ? value / temperature : -Infinity));
	const max = Math.max(...evaluated);
	if (!Number.isFinite(max)) return q.map(() => 0);
	const exp = evaluated.map((value) => (Number.isFinite(value) ? Math.exp(value - max) : 0));
	const sum = exp.reduce((acc, value) => acc + value, 0);
	return exp.map((value) => value / sum);
}

/** Pure label builder; outcomes stay aligned to their command and may be reordered together. */
export function labelTerminalOutcomes(
	commands: readonly GameCommand[],
	outcomes: readonly (readonly (TerminalRolloutOutcome | null)[])[],
	options: Pick<
		TerminalTeacherOptions,
		'stateId' | 'rollouts' | 'temperature' | 'pairedUtilityMargin'
	>
): TerminalTeacherLabel {
	const rollouts = options.rollouts ?? DEFAULT_TERMINAL_ROLLOUTS;
	const temperature = options.temperature ?? DEFAULT_TERMINAL_TEMPERATURE;
	const margin = options.pairedUtilityMargin ?? DEFAULT_PAIRED_UTILITY_MARGIN;
	if (!Number.isInteger(rollouts) || rollouts <= 0)
		throw new Error('terminalTeacher: bad rollout count');
	if (!(temperature > 0) || !Number.isFinite(temperature))
		throw new Error('terminalTeacher: bad temperature');
	if (commands.length !== outcomes.length)
		throw new Error('terminalTeacher: command/outcome mismatch');
	const signatures = commands.map(canonicalCommandSignature);
	if (new Set(signatures).size !== signatures.length) {
		throw new Error('terminalTeacher: duplicate canonical command signatures');
	}
	const stats = outcomes.map((candidateOutcomes, index): TerminalCandidateStats => {
		const valid = candidateOutcomes.filter((x): x is TerminalRolloutOutcome => x !== null);
		const evaluated = valid.length === rollouts && candidateOutcomes.length === rollouts;
		const first30 = valid.flatMap((x) => (x.first30Round === null ? [] : [x.first30Round]));
		const wins = valid.filter((x) => x.reached30).length;
		return {
			commandSignature: signatures[index],
			evaluated,
			reach30Wins: wins,
			meanFinalVP: mean(valid.map((x) => x.finalVP)),
			meanPost15VpPerRound: mean(valid.map((x) => x.post15VpPerRound)),
			meanFirst30Round: first30.length > 0 ? mean(first30) : null,
			meanUtility: mean(valid.map(utility)),
			stalls: valid.filter((x) => x.stalled).length,
			q: evaluated ? (wins + 0.5) / (rollouts + 1) : 0
		};
	});
	const evaluatedMask = stats.map((x) => (x.evaluated ? 1 : 0));
	const ranked = stats
		.map((stat, index) => ({ stat, index }))
		.filter(({ stat }) => stat.evaluated)
		.sort((a, b) => compareStats(a.stat, b.stat));
	if (ranked.length < 2) throw new Error('terminalTeacher: fewer than two evaluated candidates');
	const best = ranked[0];
	const runnerUp = ranked[1];
	const decisive =
		best.stat.reach30Wins - runnerUp.stat.reach30Wins >= 2 ||
		best.stat.meanUtility - runnerUp.stat.meanUtility >= margin;
	const terminalPi = maskedSoftmax(
		stats.map((x) => x.q),
		evaluatedMask,
		temperature
	);
	return {
		version: TERMINAL_TEACHER_VERSION,
		stateId: options.stateId,
		rollouts,
		bestIndex: best.index,
		decisive,
		pairedUtilityMargin: margin,
		evaluatedMask,
		terminalPi,
		stats
	};
}

export function isAmbiguousMonsterRewardDecision(commands: readonly GameCommand[]): boolean {
	return (
		commands.length > 1 && commands.every((command) => command.type === 'resolveMonsterReward')
	);
}

/** Evaluate all root commands with common random numbers, independent of root ordering. */
export function evaluateTerminalTeacher(
	state: PublicGameState,
	seat: SeatColor,
	commands: readonly GameCommand[],
	policy: NeuralPolicy,
	catalog: PlayCatalog,
	options: TerminalTeacherOptions
): TerminalTeacherDecision {
	if (!isAmbiguousMonsterRewardDecision(commands)) {
		throw new Error('terminalTeacher: expected only ambiguous resolveMonsterReward commands');
	}
	const sanitized = sanitizeSoloTerminalState(state, seat);
	const rollouts = options.rollouts ?? DEFAULT_TERMINAL_ROLLOUTS;
	const outcomes = commands.map((command) =>
		Array.from({ length: rollouts }, (_, rolloutIndex) =>
			rolloutTerminalCandidate(sanitized, seat, command, policy, catalog, options, rolloutIndex)
		)
	);
	const label = labelTerminalOutcomes(commands, outcomes, { ...options, rollouts });
	return { index: label.bestIndex, label };
}

/** Validate and build the exact minimal collector row expected by Python. */
export function terminalTeacherCollectorRow(
	label: TerminalTeacherLabel,
	obs: readonly number[],
	cands: readonly (readonly number[])[],
	teacherWeight?: number
): TerminalTeacherCollectorRow {
	if (
		obs.some((x) => !Number.isFinite(x)) ||
		cands.some((cand) => cand.some((x) => !Number.isFinite(x))) ||
		cands.length !== label.terminalPi.length ||
		label.evaluatedMask.length !== label.terminalPi.length ||
		label.evaluatedMask.filter(Boolean).length < 2
	) {
		throw new Error('terminalTeacher: invalid collector dimensions/mask');
	}
	let sum = 0;
	for (let i = 0; i < label.terminalPi.length; i += 1) {
		const pi = label.terminalPi[i];
		const evaluated = label.evaluatedMask[i] === 1;
		if (
			!Number.isFinite(pi) ||
			(evaluated && !(pi > 0)) ||
			(!evaluated && pi !== 0) ||
			(label.evaluatedMask[i] !== 0 && label.evaluatedMask[i] !== 1)
		) {
			throw new Error('terminalTeacher: invalid terminalPi');
		}
		if (evaluated) sum += pi;
	}
	if (Math.abs(sum - 1) > 1e-6) throw new Error(`terminalTeacher: terminalPi sums to ${sum}`);
	if (teacherWeight !== undefined && (!Number.isFinite(teacherWeight) || teacherWeight <= 0)) {
		throw new Error('terminalTeacher: invalid teacherWeight');
	}
	return {
		stateId: label.stateId,
		obs: [...obs],
		cands: cands.map((cand) => [...cand]),
		evaluatedMask: [...label.evaluatedMask],
		terminalPi: [...label.terminalPi],
		...(teacherWeight === undefined ? {} : { teacherWeight })
	};
}
