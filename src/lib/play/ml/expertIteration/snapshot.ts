/**
 * Outcome-blind snapshot primitives for the V34 expert-iteration lane.
 *
 * This module is deliberately Node-only: the collector writes auditable JSONL shards and
 * hashes their canonical JSON representation.  It imports the frozen game reducer and ML
 * encoders, but does not change either contract.
 */

import { createHash } from 'node:crypto';
import { expectedAttack } from '../../combat';
import { awakenedClassCounts } from '../../effects/apply';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../../runtime';
import {
	MAX_ATTACK_DICE,
	MAX_SPIRITS,
	RUNE_CARRY_LIMIT,
	SEAT_COLORS,
	type GameActor,
	type GameCommand,
	type PlayCatalog
} from '../../types';
import type { PrivatePlayerState, PublicGameState, SeatColor } from '../../types';
import { botSeatNeedsToAct } from '../../server/botPolicy';
import {
	legalActions,
	legalActionsWithNext,
	policyPreviewState,
	type LegalAction
} from '../actions';
import { encodeAction, encodeObs } from '../encode';
import { encodeEntityObsV2, flattenObsV2 } from '../encodeV2';

export const SNAPSHOT_SCHEMA = 'arc-v34-outcome-blind-snapshot-v1' as const;
export const TRACE_EVENT_SCHEMA = 'arc-v34-reset-trace-event-v1' as const;
export const STRUCTURAL_STATE_SCHEMA = 'arc-v34-structural-public-state-v1' as const;

type JsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
	| JsonPrimitive
	| CanonicalJsonValue[]
	| { [key: string]: CanonicalJsonValue };

const OMIT = Symbol('canonical-json-omit');

/**
 * Convert a JSON-compatible value into its canonical form (sorted object keys).
 * Undefined object members follow JSON semantics and are omitted; undefined array members,
 * non-finite numbers, exotic objects, bigint, functions, symbols, and cycles fail closed.
 */
function canonicalValue(
	value: unknown,
	path: string,
	ancestors: Set<object>,
	objectMember: boolean
): CanonicalJsonValue | typeof OMIT {
	if (value === undefined) {
		if (objectMember) return OMIT;
		throw new TypeError(`Canonical JSON does not allow undefined at ${path}.`);
	}
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError(`Canonical JSON requires a finite number at ${path}.`);
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
		throw new TypeError(`Canonical JSON does not allow ${typeof value} at ${path}.`);
	}
	if (typeof value !== 'object') {
		throw new TypeError(`Canonical JSON cannot encode ${typeof value} at ${path}.`);
	}
	if (ancestors.has(value)) throw new TypeError(`Canonical JSON cycle detected at ${path}.`);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry, index) => {
				const normalized = canonicalValue(entry, `${path}[${index}]`, ancestors, false);
				if (normalized === OMIT) throw new TypeError(`Unexpected omitted array value at ${path}.`);
				return normalized;
			});
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(`Canonical JSON requires a plain object at ${path}.`);
		}
		const source = value as Record<string, unknown>;
		const out: Record<string, CanonicalJsonValue> = {};
		for (const key of Object.keys(source).sort()) {
			const normalized = canonicalValue(source[key], `${path}.${key}`, ancestors, true);
			if (normalized !== OMIT) out[key] = normalized;
		}
		return out;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	const normalized = canonicalValue(value, '$', new Set(), false);
	if (normalized === OMIT) throw new TypeError('Canonical JSON root cannot be omitted.');
	return JSON.stringify(normalized);
}

export function sha256Canonical(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function commandHash(command: GameCommand): string {
	return sha256Canonical(command);
}

export interface CommandTraceEventV1 {
	schema: typeof TRACE_EVENT_SCHEMA;
	kind: 'command';
	actor: GameActor;
	command: GameCommand;
	commandHash: string;
}

export interface DeadlineTraceEventV1 {
	schema: typeof TRACE_EVENT_SCHEMA;
	kind: 'deadlineAdvance';
	expectedBefore: {
		revision: number;
		round: number;
		phase: PublicGameState['phase'];
	};
}

export type SnapshotTraceEventV1 = CommandTraceEventV1 | DeadlineTraceEventV1;

export function commandTraceEvent(actor: GameActor, command: GameCommand): CommandTraceEventV1 {
	return {
		schema: TRACE_EVENT_SCHEMA,
		kind: 'command',
		actor: structuredClone(actor),
		command: structuredClone(command),
		commandHash: commandHash(command)
	};
}

export function deadlineTraceEvent(state: PublicGameState): DeadlineTraceEventV1 {
	return {
		schema: TRACE_EVENT_SCHEMA,
		kind: 'deadlineAdvance',
		expectedBefore: { revision: state.revision, round: state.round, phase: state.phase }
	};
}

export interface ReplaySnapshotTraceInput {
	roomCode: string;
	guardianNames: string[];
	catalog: PlayCatalog;
	sourceSeed: number;
	events: readonly SnapshotTraceEventV1[];
}

function requireSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a non-negative safe integer.`);
	}
}

function assertTraceSourceSeed(events: readonly SnapshotTraceEventV1[], sourceSeed: number): void {
	requireSafeInteger(sourceSeed, 'sourceSeed');
	const starts = events.filter(
		(
			event
		): event is CommandTraceEventV1 & {
			command: Extract<GameCommand, { type: 'startGame' }>;
		} => event.kind === 'command' && event.command.type === 'startGame'
	);
	if (starts.length !== 1) {
		throw new Error(
			`Reset trace must contain exactly one startGame command; found ${starts.length}.`
		);
	}
	const tracedSeed = starts[0].command.seed;
	if (tracedSeed === undefined) {
		throw new Error('Reset trace startGame must carry its explicit source seed.');
	}
	if (tracedSeed !== sourceSeed) {
		throw new Error(`Reset trace source seed ${tracedSeed} does not match ${sourceSeed}.`);
	}
}

/** Replay an exact command/deadline trace from a fresh lobby, failing at the first drift. */
export function replaySnapshotTrace(input: ReplaySnapshotTraceInput): PublicGameState {
	assertTraceSourceSeed(input.events, input.sourceSeed);
	let state = createLobbyState({ roomCode: input.roomCode, guardianNames: input.guardianNames });

	for (let index = 0; index < input.events.length; index += 1) {
		const event = input.events[index];
		if (event.schema !== TRACE_EVENT_SCHEMA) {
			throw new Error(`Trace event ${index} has unsupported schema ${String(event.schema)}.`);
		}
		if (event.kind === 'command') {
			const actualHash = commandHash(event.command);
			if (actualHash !== event.commandHash) {
				throw new Error(`Trace event ${index} command hash mismatch.`);
			}
			const result = applyGameCommand(state, event.actor, event.command, input.catalog);
			if (!result.ok) {
				throw new Error(
					`Trace event ${index} (${event.command.type}) failed: ${result.error.code}: ${result.error.message}`
				);
			}
			state = result.state;
			continue;
		}

		const before = event.expectedBefore;
		if (
			state.revision !== before.revision ||
			state.round !== before.round ||
			state.phase !== before.phase
		) {
			throw new Error(
				`Trace deadline ${index} expected r${before.round}/${before.phase}/rev${before.revision}, ` +
					`got r${state.round}/${state.phase}/rev${state.revision}.`
			);
		}
		if (state.status !== 'active') {
			throw new Error(`Trace deadline ${index} cannot advance a ${state.status} game.`);
		}
		const revision = state.revision;
		applyDeadlineAdvance(state, input.catalog);
		if (state.revision <= revision) {
			throw new Error(`Trace deadline ${index} did not advance the state revision.`);
		}
	}
	return state;
}

function sortedRecord(
	record: Record<string, number | boolean> | undefined
): Record<string, number | boolean> {
	return Object.fromEntries(Object.entries(record ?? {}).sort(([a], [b]) => codeUnitCompare(a, b)));
}

/** Locale-independent ordering for arrays that feed canonical hashes. */
function codeUnitCompare(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

function publicBagSummary(contents: PublicGameState['bags']['hexSpirits']['contents']) {
	const grouped = new Map<
		string,
		{ id: string | null; name: string; cost: number | null; count: number }
	>();
	for (const entry of contents) {
		const id = entry.id ?? null;
		const cost = entry.cost ?? null;
		const key = canonicalJson([id, entry.name, cost]);
		const current = grouped.get(key);
		if (current) current.count += 1;
		else grouped.set(key, { id, name: entry.name, cost, count: 1 });
	}
	return [...grouped.values()].sort((a, b) => codeUnitCompare(canonicalJson(a), canonicalJson(b)));
}

function structuralMonster(monster: PublicGameState['monster']) {
	return monster
		? {
				id: monster.id,
				name: monster.name,
				hp: monster.hp,
				maxHp: monster.maxHp,
				damage: monster.damage,
				rewardTrack: [...monster.rewardTrack],
				chooseAmount: monster.chooseAmount,
				livesRemaining: monster.livesRemaining,
				livesTotal: monster.livesTotal,
				ladderIndex: monster.ladderIndex,
				ladderMax: monster.ladderMax
			}
		: null;
}

function structuralCombats(state: PublicGameState) {
	return state.combats.map((combat) => ({
		kind: combat.kind,
		step: combat.step,
		sides: [...combat.sides]
			.sort((a, b) => SEAT_COLORS.indexOf(a.seat) - SEAT_COLORS.indexOf(b.seat))
			.map((side) => ({
				seat: side.seat,
				initiative: side.initiative,
				rolled: side.rolled,
				damageDealt: side.damageDealt,
				side: side.side,
				stunned: side.stunned ?? false,
				corrupted: side.corrupted ?? false
			})),
		monster: structuralMonster(combat.monster),
		log: [...combat.log],
		killed: combat.killed
	}));
}

function structuralPlayer(player: PrivatePlayerState, isOwner: boolean, revealed: boolean) {
	const heldMats = player.mats.filter((mat) => mat.hasRune).length;
	const publicFields = {
		selectedGuardian: player.selectedGuardian,
		navigationDestination: revealed ? player.navigationDestination : null,
		brokenBarrier: player.brokenBarrier,
		victoryPoints: player.victoryPoints,
		vpHistory: [...player.vpHistory],
		barrier: player.barrier,
		maxBarrier: player.maxBarrier,
		statusLevel: player.statusLevel,
		statusToken: player.statusToken,
		corruptionCount: player.corruptionCount ?? 0,
		spirits: [...player.spirits]
			.sort((a, b) => a.slotIndex - b.slotIndex)
			.map((spirit) => ({
				slotIndex: spirit.slotIndex,
				id: spirit.id,
				name: spirit.name,
				cost: spirit.cost,
				classes: sortedRecord(spirit.classes) as Record<string, number>,
				origins: sortedRecord(spirit.origins) as Record<string, number>,
				isFaceDown: spirit.isFaceDown
			})),
		mats: [...player.mats]
			.sort((a, b) => a.slotIndex - b.slotIndex)
			.map((mat) => ({
				slotIndex: mat.slotIndex,
				hasRune: mat.hasRune,
				id: mat.id,
				name: mat.name,
				type: mat.type,
				originId: mat.originId,
				classId: mat.classId,
				special: mat.special ?? false
			})),
		spawnedDice: player.spawnedDice
			.map((die) => ({
				diceId: die.diceId,
				name: die.name,
				diceType: die.diceType,
				faceIndex: die.faceIndex
			}))
			.sort((a, b) => codeUnitCompare(canonicalJson(a), canonicalJson(b))),
		spawnedItems: player.spawnedItems
			.map((item) => ({ runeId: item.runeId, name: item.name, kind: item.kind }))
			.sort((a, b) => codeUnitCompare(canonicalJson(a), canonicalJson(b))),
		spiritAugmentAttachments: player.spiritAugmentAttachments
			.map((attachment) => ({
				runeId: attachment.runeId,
				spiritId: attachment.spiritId,
				spiritSlotIndex: attachment.spiritSlotIndex,
				name: attachment.name,
				classId: attachment.classId,
				className: attachment.className
			}))
			.sort((a, b) => codeUnitCompare(canonicalJson(a), canonicalJson(b))),
		attackDice: Object.entries(
			player.attackDice.reduce<Record<string, number>>((counts, die) => {
				counts[die.tier] = (counts[die.tier] ?? 0) + 1;
				return counts;
			}, {})
		).sort(([a], [b]) => codeUnitCompare(a, b)),
		capacity: {
			spirits: { used: player.spirits.length, maximum: MAX_SPIRITS },
			attackDice: { used: player.attackDice.length, maximum: MAX_ATTACK_DICE },
			mats: {
				used: heldMats,
				carryLimit: RUNE_CARRY_LIMIT,
				overflow: Math.max(0, heldMats - RUNE_CARRY_LIMIT)
			}
		},
		activeClasses: Object.fromEntries(
			Object.entries(awakenedClassCounts(player)).sort(([a], [b]) => codeUnitCompare(a, b))
		),
		initiative: player.initiative,
		actionsUsedThisRound: [...player.actionsUsedThisRound].sort(),
		awakenEligible: [...player.awakenEligible].sort((a, b) => a - b),
		awakenOffers: structuredClone(player.awakenOffers),
		awakenLocked: structuredClone(player.awakenLocked),
		phaseReady: player.phaseReady,
		damageReduction: player.damageReduction,
		deflect: player.deflect,
		combatDamageBonus: player.combatDamageBonus,
		stunImmune: player.stunImmune,
		stunned: player.stunned ?? false,
		encounterVote: player.encounterVote ?? null,
		spiritAugments: player.spiritAugments,
		relics: player.relics,
		extraActions: sortedRecord(player.extraActions) as Record<string, number>,
		combatDamageMultiplier: player.combatDamageMultiplier,
		attackRollAdvantage: player.attackRollAdvantage,
		halveIncoming: player.halveIncoming,
		skipTakeDamage: player.skipTakeDamage,
		doubleRunes: player.doubleRunes,
		redrawAvailable: player.redrawAvailable,
		freeNextRelicTrade: player.freeNextRelicTrade,
		becameTaintedThisRound: player.becameTaintedThisRound,
		becameCorruptThisRound: player.becameCorruptThisRound,
		becameFallenThisRound: player.becameFallenThisRound,
		corruptedThisRound: player.corruptedThisRound,
		awakenProgress: sortedRecord(player.awakenProgress)
	};

	if (!isOwner) return publicFields;
	return {
		...publicFields,
		owner: {
			pendingDestination: player.pendingDestination,
			handDraws: player.handDraws.map((draw) => ({
				id: draw.id,
				name: draw.name,
				cost: draw.cost,
				sourceBag: draw.sourceBag
			})),
			pendingDraw: structuredClone(player.pendingDraw),
			pendingDrawQueue: structuredClone(player.pendingDrawQueue),
			pendingReward: structuredClone(player.pendingReward),
			pendingAwakenReward: structuredClone(player.pendingAwakenReward),
			pendingCorruptionDiscard: structuredClone(player.pendingCorruptionDiscard ?? null),
			manualPrompts: player.manualPrompts.map((prompt) => ({
				source: prompt.source,
				text: prompt.text
			})),
			pendingDecisions: player.pendingDecisions.map((decision) => ({
				source: decision.source,
				kind: decision.kind,
				prompt: decision.prompt,
				options: structuredClone(decision.options)
			})),
			lastAction: structuredClone(player.lastAction),
			unplacedAugments: structuredClone(player.unplacedAugments ?? [])
		}
	};
}

/**
 * Explicit, owner-aware projection for structural de-duplication.  No raw state spread is used.
 * Room/game/member identifiers, revisions, wall-clock deadlines, RNG state, future bag order,
 * and terminal winner fields are intentionally absent.
 */
export function structuralPublicState(
	state: PublicGameState,
	actingSeat: SeatColor,
	legalCommands: readonly GameCommand[]
) {
	if (state.status !== 'active') throw new Error('Snapshots require an active game state.');
	if (!state.activeSeats.includes(actingSeat) || !state.players[actingSeat]) {
		throw new Error(`Acting seat ${actingSeat} is not active.`);
	}
	const players = Object.fromEntries(
		SEAT_COLORS.filter((seat) => state.activeSeats.includes(seat) && state.players[seat]).map(
			(seat) => [
				seat,
				structuralPlayer(state.players[seat]!, seat === actingSeat, state.revealedDestinations)
			]
		)
	);
	const navigation = Object.fromEntries(
		state.activeSeats
			.map((seat) => [seat, { locked: state.navigation[seat]?.locked === true }] as const)
			.sort(([a], [b]) => SEAT_COLORS.indexOf(a) - SEAT_COLORS.indexOf(b))
	);
	const occupancy = Object.fromEntries(
		Object.entries(state.locationOccupancy)
			.filter((entry): entry is [string, SeatColor[]] => Array.isArray(entry[1]))
			.sort(([a], [b]) => codeUnitCompare(a, b))
			.map(([destination, seats]) => [
				destination,
				[...seats].sort((a, b) => SEAT_COLORS.indexOf(a) - SEAT_COLORS.indexOf(b))
			])
	);

	return {
		schema: STRUCTURAL_STATE_SCHEMA,
		status: state.status,
		round: state.round,
		phase: state.phase,
		actingSeat,
		activeSeats: SEAT_COLORS.filter((seat) => state.activeSeats.includes(seat)),
		guardianPool: [...state.guardianPool].sort(),
		market: [...state.market]
			.sort((a, b) => a.index - b.index)
			.map((slot) => ({ index: slot.index, spiritId: slot.spiritId })),
		bags: {
			counts: {
				spiritWorld: state.bags.hexSpirits.count,
				arcaneAbyss: state.bags.abyssFallen.count,
				monsters: state.bags.monsters.count,
				stageDeck: state.bags.stageDeck.count
			},
			spiritWorld: publicBagSummary(state.bags.hexSpirits.contents),
			arcaneAbyss: publicBagSummary(state.bags.abyssFallen.contents)
		},
		players,
		navigation,
		revealedDestinations: state.revealedDestinations,
		locationOccupancy: occupancy,
		monster: structuralMonster(state.monster),
		combats: structuralCombats(state),
		legalCommandHashes: legalCommands.map(commandHash).sort()
	};
}

export function structuralPublicStateHash(
	state: PublicGameState,
	actingSeat: SeatColor,
	legalCommands: readonly GameCommand[]
): string {
	return sha256Canonical(structuralPublicState(state, actingSeat, legalCommands));
}

export interface WeakEngineThresholdV1 {
	/** Weak-engine tagging is invalid before this active round (must be post-15). */
	minRoundInclusive: number;
	maxExpectedAttack: number;
	maxAttackDice: number;
	maxAwakenedSpirits: number;
	maxBarrier: number;
	maxInitiative: number;
}

export interface RecoveryDiagnosticsV1 {
	statusRecovery: boolean;
	weakEngine: boolean;
	noPositiveVpInPriorThreeCompletedRounds: boolean;
	recoveryEligible: boolean;
	reasons: Array<'corruptOrFallen' | 'weakPost15Engine' | 'stalledThreeRounds'>;
	observed: {
		statusLevel: number;
		expectedAttack: number;
		attackDice: number;
		awakenedSpirits: number;
		maxBarrier: number;
		initiative: number;
		priorThreeCompletedVpDeltas: number[];
	};
}

function validateWeakThreshold(threshold: WeakEngineThresholdV1): void {
	if (!Number.isInteger(threshold.minRoundInclusive) || threshold.minRoundInclusive < 16) {
		throw new RangeError('Weak-engine minRoundInclusive must be an integer at least 16.');
	}
	for (const [key, value] of Object.entries(threshold)) {
		if (key === 'minRoundInclusive') continue;
		if (!Number.isFinite(value) || value < 0) {
			throw new RangeError(`Weak-engine threshold ${key} must be finite and non-negative.`);
		}
	}
}

export function recoveryDiagnostics(
	state: PublicGameState,
	seat: SeatColor,
	threshold: WeakEngineThresholdV1
): RecoveryDiagnosticsV1 {
	validateWeakThreshold(threshold);
	const player = state.players[seat];
	if (!player) throw new Error(`Missing player state for ${seat}.`);
	const awakenedSpirits = player.spirits.filter((spirit) => !spirit.isFaceDown).length;
	const observedExpectedAttack = expectedAttack(player);
	const completed = player.vpHistory.slice(0, Math.max(0, state.round - 1));
	const start = Math.max(0, completed.length - 3);
	const deltas = completed.slice(start).map((value, offset) => {
		const index = start + offset;
		return value - (index > 0 ? completed[index - 1] : 0);
	});
	const noPositive = deltas.length === 3 && deltas.every((delta) => delta <= 0);
	const statusRecovery = player.statusLevel >= 2;
	const weakEngine =
		state.round >= threshold.minRoundInclusive &&
		observedExpectedAttack <= threshold.maxExpectedAttack &&
		player.attackDice.length <= threshold.maxAttackDice &&
		awakenedSpirits <= threshold.maxAwakenedSpirits &&
		player.maxBarrier <= threshold.maxBarrier &&
		player.initiative <= threshold.maxInitiative;
	const reasons: RecoveryDiagnosticsV1['reasons'] = [];
	if (statusRecovery) reasons.push('corruptOrFallen');
	if (weakEngine) reasons.push('weakPost15Engine');
	if (noPositive) reasons.push('stalledThreeRounds');
	return {
		statusRecovery,
		weakEngine,
		noPositiveVpInPriorThreeCompletedRounds: noPositive,
		recoveryEligible: reasons.length > 0,
		reasons,
		observed: {
			statusLevel: player.statusLevel,
			expectedAttack: observedExpectedAttack,
			attackDice: player.attackDice.length,
			awakenedSpirits,
			maxBarrier: player.maxBarrier,
			initiative: player.initiative,
			priorThreeCompletedVpDeltas: deltas
		}
	};
}

export interface PolicySafeCandidateV1 {
	cmd: GameCommand;
	policyNext: PublicGameState;
	hasHiddenOutcome: boolean;
}

function policySafeCandidate(action: LegalAction): PolicySafeCandidateV1 {
	return {
		cmd: structuredClone(action.cmd),
		policyNext: policyPreviewState(action),
		hasHiddenOutcome: action.hasHiddenOutcome
	};
}

export function semanticCandidateHash(
	state: PublicGameState,
	seat: SeatColor,
	candidate: PolicySafeCandidateV1,
	catalog: PlayCatalog
): string {
	const preview = candidate.policyNext;
	const nextLegal = legalActions(preview, seat, catalog);
	return sha256Canonical({
		actionFeatures: encodeAction(state, seat, candidate.cmd, preview, catalog),
		policyNext: structuralPublicState(preview, seat, nextLegal)
	});
}

export type ForcedClosureStopReason =
	| 'choice'
	| 'stochasticSingleton'
	| 'seatComplete'
	| 'terminal'
	| 'noLegalAction';

export interface ForcedClosureResultV1 {
	state: PublicGameState;
	forcedCommands: GameCommand[];
	candidates: PolicySafeCandidateV1[];
	stopReason: ForcedClosureStopReason;
}

export interface ForcedClosureOptions {
	maxSteps?: number;
	/** Test seam; production callers leave this unset and use the frozen legal-action oracle. */
	actionProvider?: (state: PublicGameState, seat: SeatColor, catalog: PlayCatalog) => LegalAction[];
}

/**
 * Apply deterministic singleton actions until a real choice is reached.  A singleton with a
 * hidden outcome is returned, uncommitted.  The returned candidates never contain authoritative
 * realized `next` states.
 */
export function closeDeterministicSingletons(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	options: ForcedClosureOptions = {}
): ForcedClosureResultV1 {
	const maxSteps = options.maxSteps ?? 64;
	if (!Number.isInteger(maxSteps) || maxSteps < 1) {
		throw new RangeError('Forced-closure maxSteps must be a positive integer.');
	}
	const actionProvider = options.actionProvider ?? legalActionsWithNext;
	let working = structuredClone(state);
	const forcedCommands: GameCommand[] = [];

	for (let step = 0; step < maxSteps; step += 1) {
		if (working.status !== 'active') {
			return { state: working, forcedCommands, candidates: [], stopReason: 'terminal' };
		}
		if (!botSeatNeedsToAct(working, seat)) {
			return { state: working, forcedCommands, candidates: [], stopReason: 'seatComplete' };
		}
		const actions = actionProvider(working, seat, catalog);
		const candidates = actions.map(policySafeCandidate);
		if (actions.length === 0) {
			return { state: working, forcedCommands, candidates, stopReason: 'noLegalAction' };
		}
		if (actions.length > 1) {
			return { state: working, forcedCommands, candidates, stopReason: 'choice' };
		}
		const only = actions[0];
		if (only.hasHiddenOutcome) {
			return { state: working, forcedCommands, candidates, stopReason: 'stochasticSingleton' };
		}
		forcedCommands.push(structuredClone(only.cmd));
		working = structuredClone(policyPreviewState(only));
	}
	throw new Error(`Forced deterministic closure exceeded ${maxSteps} steps.`);
}

/** A domain-separated seed for bot sampling. It never reads or advances the game RNG. */
export function botSamplingSeed(
	sourceSeed: number,
	decisionOrdinal: number,
	seat: SeatColor,
	stream = 0
): number {
	requireSafeInteger(sourceSeed, 'sourceSeed');
	requireSafeInteger(decisionOrdinal, 'decisionOrdinal');
	requireSafeInteger(stream, 'stream');
	const digest = createHash('sha256')
		.update(
			canonicalJson({
				domain: 'arc-v34-bot-sampling-seed-v1',
				sourceSeed,
				decisionOrdinal,
				seat,
				stream
			})
		)
		.digest();
	return digest.readUInt32BE(0);
}

const FORBIDDEN_FEATURE_KEYS = new Set(
	[
		'target',
		'targets',
		'outcome',
		'outcomes',
		'finalvp',
		'finalscore',
		'winnerseat',
		'won',
		'placement',
		'done',
		'ret',
		'episodereturn',
		'terminalreward',
		'reached30',
		'first30round',
		'post15vpperround',
		'teacherlabel',
		'teacherlabels',
		'teacherscores',
		'chosencandidate',
		'selectedcandidate',
		'realizednextstate',
		'authoritativenextstate',
		'futurestate',
		'futurerng',
		'futureseed',
		'nextrng',
		'rngcursor',
		'bagorder'
	].map((key) => key.toLowerCase())
);

function normalizedKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function forbiddenFeaturePaths(
	value: unknown,
	extraForbiddenKeys: readonly string[] = []
): string[] {
	const forbidden = new Set(FORBIDDEN_FEATURE_KEYS);
	for (const key of extraForbiddenKeys) forbidden.add(normalizedKey(key));
	const paths: string[] = [];
	const ancestors = new Set<object>();
	const visit = (current: unknown, path: string): void => {
		if (current === null || typeof current !== 'object') return;
		if (ancestors.has(current)) throw new TypeError(`Feature shard cycle detected at ${path}.`);
		ancestors.add(current);
		try {
			if (Array.isArray(current)) {
				current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
				return;
			}
			for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
				const child = `${path}.${key}`;
				if (forbidden.has(normalizedKey(key))) paths.push(child);
				visit(entry, child);
			}
		} finally {
			ancestors.delete(current);
		}
	};
	visit(value, '$');
	return paths.sort();
}

export function assertFeatureShardSafe(
	value: unknown,
	extraForbiddenKeys: readonly string[] = []
): void {
	const forbidden = forbiddenFeaturePaths(value, extraForbiddenKeys);
	if (forbidden.length > 0) {
		throw new Error(`Feature shard contains forbidden keys: ${forbidden.join(', ')}`);
	}
	// Canonicalization is the second fail-closed gate for non-JSON or non-finite values.
	canonicalJson(value);
}

export interface SnapshotModelDiagnosticsV1 {
	rawLogits: number[];
	probabilities: number[];
	reach30Probability: number;
	recoveryProbability: number;
}

export interface BuildOutcomeBlindSnapshotInput {
	sourceSeed: number;
	decisionOrdinal: number;
	seat: SeatColor;
	state: PublicGameState;
	catalog: PlayCatalog;
	trace: readonly SnapshotTraceEventV1[];
	weakEngineThreshold: WeakEngineThresholdV1;
	legalActions?: readonly LegalAction[];
	modelDiagnostics?: SnapshotModelDiagnosticsV1;
	samplingStream?: number;
}

export interface SnapshotCandidateV1 {
	command: GameCommand;
	commandHash: string;
	semanticHash: string;
	actionFeatures: number[];
	hasHiddenOutcome: boolean;
}

function validateFiniteVector(values: readonly number[], label: string): void {
	if (!values.every(Number.isFinite))
		throw new TypeError(`${label} must contain only finite numbers.`);
}

/** Build one feature-shard row; terminal labels and realized candidate states have no field here. */
export function buildOutcomeBlindSnapshot(input: BuildOutcomeBlindSnapshotInput) {
	requireSafeInteger(input.decisionOrdinal, 'decisionOrdinal');
	assertTraceSourceSeed(input.trace, input.sourceSeed);
	const actions = [
		...(input.legalActions ?? legalActionsWithNext(input.state, input.seat, input.catalog))
	];
	const commands = actions.map((action) => action.cmd);
	const visibleState = structuralPublicState(input.state, input.seat, commands);
	const obsV2 = encodeEntityObsV2(input.state, input.seat, input.catalog);
	const candidates: SnapshotCandidateV1[] = actions.map((action) => {
		const safe = policySafeCandidate(action);
		return {
			command: structuredClone(safe.cmd),
			commandHash: commandHash(safe.cmd),
			semanticHash: semanticCandidateHash(input.state, input.seat, safe, input.catalog),
			actionFeatures: encodeAction(
				input.state,
				input.seat,
				safe.cmd,
				safe.policyNext,
				input.catalog
			),
			hasHiddenOutcome: safe.hasHiddenOutcome
		};
	});

	const modelDiagnostics = input.modelDiagnostics
		? {
				rawLogits: [...input.modelDiagnostics.rawLogits],
				probabilities: [...input.modelDiagnostics.probabilities],
				reach30Probability: input.modelDiagnostics.reach30Probability,
				recoveryProbability: input.modelDiagnostics.recoveryProbability
			}
		: undefined;
	if (modelDiagnostics) {
		validateFiniteVector(modelDiagnostics.rawLogits, 'rawLogits');
		validateFiniteVector(modelDiagnostics.probabilities, 'probabilities');
		if (modelDiagnostics.rawLogits.length !== candidates.length) {
			throw new Error('rawLogits length must equal the legal candidate count.');
		}
		if (modelDiagnostics.probabilities.length !== candidates.length) {
			throw new Error('probabilities length must equal the legal candidate count.');
		}
		if (
			!Number.isFinite(modelDiagnostics.reach30Probability) ||
			!Number.isFinite(modelDiagnostics.recoveryProbability)
		) {
			throw new TypeError('Model scalar diagnostics must be finite.');
		}
	}

	const row = {
		schema: SNAPSHOT_SCHEMA,
		sourceSeed: input.sourceSeed,
		round: input.state.round,
		decisionOrdinal: input.decisionOrdinal,
		seat: input.seat,
		botSamplingSeed: botSamplingSeed(
			input.sourceSeed,
			input.decisionOrdinal,
			input.seat,
			input.samplingStream ?? 0
		),
		trace: structuredClone(input.trace),
		traceHash: sha256Canonical(input.trace),
		currentVisibleState: visibleState,
		publicStateHash: sha256Canonical(visibleState),
		obsV1: encodeObs(input.state, input.seat, input.catalog),
		obsV2: flattenObsV2(obsV2, input.catalog),
		candidates,
		semanticallyDistinctCandidates: new Set(candidates.map((candidate) => candidate.semanticHash))
			.size,
		eligibleStrategicChoice:
			candidates.length >= 2 &&
			new Set(candidates.map((candidate) => candidate.semanticHash)).size >= 2,
		recoveryDiagnostics: recoveryDiagnostics(input.state, input.seat, input.weakEngineThreshold),
		modelDiagnostics
	};
	assertFeatureShardSafe(row);
	return row;
}

/** Exposed for audit reports that need the active class-engine vector without private inputs. */
export function activeClassCounts(state: PublicGameState, seat: SeatColor): Record<string, number> {
	const player = state.players[seat];
	if (!player) throw new Error(`Missing player state for ${seat}.`);
	return Object.fromEntries(
		Object.entries(awakenedClassCounts(player)).sort(([a], [b]) => codeUnitCompare(a, b))
	);
}
