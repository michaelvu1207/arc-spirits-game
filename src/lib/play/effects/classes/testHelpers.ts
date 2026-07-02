/**
 * Shared fixtures for the per-class test files (`classes/<name>.test.ts`).
 *
 * Keeps each class's test isolated to its own file while reusing one player/state
 * builder and a `fire()` convenience that runs a single trigger through the real
 * dispatcher (`applyTrigger`) against a player carrying the class. Tests assert on
 * the resulting player (dice, max barrier, initiative, VP, decisions, prompts, log).
 */

import { applyTrigger } from '../apply';
import { buildEffectContext } from '../context';
import type { EffectTrigger } from '../registry';
import { createRng } from '../../rng';
import type { PlaySpirit, PrivatePlayerState, PublicGameState, SeatColor } from '../../types';

/** A fully-defaulted player; override any field via `overrides`. */
export function makePlayer(overrides: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
	return {
		playerColor: 'Red',
		displayName: 'Tester',
		selectedGuardian: 'Myrtle',
		navigationDestination: null,
		brokenBarrier: 0,
		victoryPoints: 0,
		vpHistory: [],
		barrier: 4,
		maxBarrier: 4,
		statusLevel: 0,
		statusToken: 'Pure',
		spirits: [],
		mats: [],
		handDraws: [],
		pendingDraw: null,
		pendingDrawQueue: [],
		spawnedDice: [],
		spawnedItems: [],
		spiritAugmentAttachments: [],
		pendingDestination: null,
		attackDice: [],
		initiative: 0,
		actionsUsedThisRound: [],
		awakenEligible: [],
		awakenOffers: [],
		awakenLocked: [],
		phaseReady: false,
		manualPrompts: [],
		pendingDecisions: [],
		lastAction: null,
		pendingReward: null,
		pendingAwakenReward: null,
		damageReduction: 0,
		deflect: 0,
		combatDamageBonus: 0,
		stunImmune: false,
		spiritAugments: 0,
		relics: 0,
		extraActions: {},
		combatDamageMultiplier: 1,
		attackRollAdvantage: false,
		halveIncoming: false,
		skipTakeDamage: false,
		doubleRunes: false,
		redrawAvailable: false,
		freeNextRelicTrade: false,
		becameTaintedThisRound: false,
		becameCorruptThisRound: false,
		becameFallenThisRound: false,
		corruptedThisRound: false,
		awakenProgress: {},
		...overrides
	};
}

/** A minimal single-seat (Red) state wrapping `player`; pass more players via `extra`. */
export function makeState(
	player: PrivatePlayerState,
	extra: Partial<Record<SeatColor, PrivatePlayerState>> = {},
	seed = 1
): PublicGameState {
	const players: Partial<Record<SeatColor, PrivatePlayerState>> = { Red: player, ...extra };
	return {
		rng: createRng(seed),
		players,
		activeSeats: Object.keys(players) as SeatColor[]
	} as unknown as PublicGameState;
}

/** A spirit slot carrying `classes` (awakened by default; pass faceDown=true otherwise). */
export function spirit(
	slotIndex: number,
	classes: Record<string, number>,
	opts: { name?: string; id?: string; origins?: Record<string, number>; faceDown?: boolean } = {}
): PlaySpirit {
	return {
		slotIndex,
		id: opts.id ?? `s${slotIndex}`,
		name: opts.name ?? `Spirit ${slotIndex}`,
		cost: 2,
		classes,
		origins: opts.origins ?? {},
		isFaceDown: opts.faceDown ?? false
	};
}

/**
 * Fire one trigger for a Red player carrying `classCounts` (one awakened spirit),
 * through the real dispatcher. Returns the mutated player + the emitted log.
 * `opts.player` overrides the built player; `opts.command` threads a command
 * (e.g. `{ slotIndex }` for per-spirit awakening); `opts.colocated`/`opts.extra`
 * add other seats for co-location / global-predicate effects.
 */
export function fire(
	classCounts: Record<string, number>,
	trigger: EffectTrigger,
	opts: {
		player?: Partial<PrivatePlayerState>;
		extra?: Partial<Record<SeatColor, PrivatePlayerState>>;
		command?: unknown;
		seed?: number;
	} = {}
): { player: PrivatePlayerState; log: string[]; state: PublicGameState } {
	const player = makePlayer({
		spirits: [spirit(1, classCounts)],
		...opts.player
	});
	const state = makeState(player, opts.extra ?? {}, opts.seed ?? 1);
	const log: string[] = [];
	applyTrigger(state, 'Red', trigger, log, { command: opts.command });
	return { player, log, state };
}

/** Build a bare EffectContext for unit-testing a single handler in isolation. */
export function ctxFor(
	player: PrivatePlayerState,
	opts: {
		trigger?: EffectTrigger;
		command?: unknown;
		extra?: Partial<Record<SeatColor, PrivatePlayerState>>;
	} = {}
) {
	const state = makeState(player, opts.extra ?? {});
	return buildEffectContext({
		state,
		seat: 'Red',
		player,
		trigger: opts.trigger ?? 'awakening',
		log: [],
		traitCount: 0,
		command: opts.command
	});
}
