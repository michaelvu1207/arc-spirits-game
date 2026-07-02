/**
 * P1 effect-framework tests.
 *
 * Proves the new EffectContext + extended action/breakpoint primitives WITHOUT
 * regressing the original numeric ladder. New action kinds are exercised through
 * the real `applyTrigger` dispatch using tiny synthetic CLASS_EFFECTS entries
 * (registered under throwaway class names and torn down after each test), so the
 * full context-build → selectBreakpoint → runAction path is covered end-to-end.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from '../runtime';
import { applyTrigger } from './apply';
import { colocatedPlayers } from './colocated';
import { selectBreakpoint, CLASS_EFFECTS, type ClassEffect } from './registry';
import { takeDamage, rollAttack, fightMonster } from '../combat';
import { createRng } from '../rng';
import type {
	GameActor,
	MonsterState,
	PlayCatalog,
	PlaySpirit,
	PrivatePlayerState,
	PublicGameState,
	SeatColor
} from '../types';
import type { GameLocationRewardRow } from '$lib/types';

function makePlayer(overrides: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
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

function spirit(
	slotIndex: number,
	name: string,
	classes: Record<string, number>,
	origins: Record<string, number> = {},
	isFaceDown = false
): PlaySpirit {
	return { slotIndex, id: `s${slotIndex}`, name, cost: 2, classes, origins, isFaceDown };
}

function makeState(
	players: Partial<Record<SeatColor, PrivatePlayerState>>,
	seed = 1
): PublicGameState {
	return {
		rng: createRng(seed),
		players,
		activeSeats: Object.keys(players) as SeatColor[]
	} as unknown as PublicGameState;
}

/** Register a synthetic class effect for the duration of one test. */
const SYNTHETIC: string[] = [];
function withSynthClass(name: string, effects: ClassEffect[]): void {
	CLASS_EFFECTS[name] = effects;
	SYNTHETIC.push(name);
}
afterEach(() => {
	for (const name of SYNTHETIC.splice(0)) delete CLASS_EFFECTS[name];
});

/** Fire onRest for a single-seat state whose only spirit carries `cls` × `count`. */
function fireRest(cls: string, count: number, overrides: Partial<PrivatePlayerState> = {}) {
	const player = makePlayer({ spirits: [spirit(1, 'A', { [cls]: count })], ...overrides });
	applyTrigger(makeState({ Red: player }), 'Red', 'onRest', []);
	return player;
}

describe('selectBreakpoint return shape', () => {
	const ladder: ClassEffect['breakpoints'] = [
		{ count: 2, actions: [] },
		{ count: 3, actions: [] },
		{ count: 4, actions: [] }
	];

	it('numeric breakpoints return multiplier 1 and the highest met bp', () => {
		const sel = selectBreakpoint(ladder, 3);
		expect(sel).not.toBeNull();
		expect(sel!.bp.count).toBe(3);
		expect(sel!.multiplier).toBe(1);
	});

	it('numeric path picks the highest threshold ≤ count (Fighter 5 path)', () => {
		const sel = selectBreakpoint(
			[
				{ count: 2, actions: [] },
				{ count: 5, actions: [] }
			],
			5
		);
		expect(sel!.bp.count).toBe(5);
		expect(sel!.multiplier).toBe(1);
	});

	it('returns null below the lowest numeric threshold', () => {
		expect(selectBreakpoint(ladder, 1)).toBeNull();
	});

	it("a '1+' breakpoint applies at count ≥ 1 with multiplier = count", () => {
		const sel = selectBreakpoint([{ count: '1+', actions: [] }], 4);
		expect(sel!.multiplier).toBe(4);
		expect(sel!.bp.count).toBe('1+');
	});

	it("a numeric breakpoint wins over '1+' when both qualify", () => {
		const sel = selectBreakpoint(
			[
				{ count: '1+', actions: [] },
				{ count: 2, actions: [] }
			],
			3
		);
		expect(sel!.bp.count).toBe(2);
		expect(sel!.multiplier).toBe(1);
	});
});

describe('new EffectAction kinds (via applyTrigger)', () => {
	it('gainVP adds to victoryPoints', () => {
		withSynthClass('SynthVP', [
			{ trigger: 'onRest', breakpoints: [{ count: 1, actions: [{ kind: 'gainVP', amount: 5 }] }] }
		]);
		expect(fireRest('SynthVP', 1).victoryPoints).toBe(5);
	});

	it('gainInitiative adds to initiative', () => {
		withSynthClass('SynthInit', [
			{
				trigger: 'onRest',
				breakpoints: [{ count: 1, actions: [{ kind: 'gainInitiative', amount: 2 }] }]
			}
		]);
		expect(fireRest('SynthInit', 1).initiative).toBe(2);
	});

	it('reduceIncomingDamage raises damageReduction, then is consumed by takeDamage', () => {
		withSynthClass('SynthDR', [
			{
				trigger: 'onRest',
				breakpoints: [{ count: 1, actions: [{ kind: 'reduceIncomingDamage', amount: 2 }] }]
			}
		]);
		const p = fireRest('SynthDR', 1, { barrier: 4, maxBarrier: 4 });
		expect(p.damageReduction).toBe(2);
		// 5 incoming − 2 reduction = 3 → barrier 4-3 = 1, no corruption.
		const r = takeDamage(p, 5);
		expect(r.corrupted).toBe(false);
		expect(p.barrier).toBe(1);
	});

	it('deflect raises deflect, then is consumed by takeDamage', () => {
		withSynthClass('SynthDeflect', [
			{ trigger: 'onRest', breakpoints: [{ count: 1, actions: [{ kind: 'deflect', amount: 3 }] }] }
		]);
		const p = fireRest('SynthDeflect', 1, { barrier: 4, maxBarrier: 4 });
		expect(p.deflect).toBe(3);
		// 3 incoming fully deflected → no barrier loss.
		const r = takeDamage(p, 3);
		expect(r.barrierLost).toBe(0);
		expect(p.barrier).toBe(4);
	});

	it('combatBonus raises combatDamageBonus, then adds in rollAttack', () => {
		withSynthClass('SynthBonus', [
			{
				trigger: 'onRest',
				breakpoints: [{ count: 1, actions: [{ kind: 'combatBonus', amount: 4 }] }]
			}
		]);
		const p = fireRest('SynthBonus', 1);
		expect(p.combatDamageBonus).toBe(4);
		// Zero dice → only the flat bonus is dealt.
		expect(rollAttack(makeState({ Red: p }), p)).toBe(4);
	});

	it('combatBonus flows into fightMonster dealt damage', () => {
		// P4: per-combat flags reset at the start of each fight, so the bonus must
		// be granted by an `inCombat` class effect (not pre-set on the player).
		withSynthClass('SynthInCombatBonus', [
			{
				trigger: 'inCombat',
				breakpoints: [{ count: 1, actions: [{ kind: 'combatBonus', amount: 6 }] }]
			}
		]);
		const monster: MonsterState = {
			id: 'm',
			name: 'Imp',
			hp: 10,
			maxHp: 10,
			damage: 0,
			rewardTrack: [],
			chooseAmount: 2,
			livesRemaining: 1,
			livesTotal: 1,
			ladderIndex: 0,
			ladderMax: 3
		};
		const p = makePlayer({
			navigationDestination: 'Arcane Abyss',
			attackDice: [],
			spirits: [spirit(1, 'A', { SynthInCombatBonus: 1 })]
		});
		const state = makeState({ Red: p });
		state.monster = monster;
		const result = fightMonster(state, 'Red');
		// No dice, +6 bonus from the inCombat effect, monster damage 0 → dealt 6.
		expect(result!.playerDamage).toBe(6);
		// The 6 lands against the monster's FULL health for this combat (snapshot), but shared
		// state keeps maxHp — monster HP never persists between combats.
		expect(result!.fought?.hp).toBe(monster.maxHp - 6);
		expect(monster.hp).toBe(monster.maxHp);
	});

	it('gainAugment / gainRelic populate their fields', () => {
		withSynthClass('SynthSpecials', [
			{
				trigger: 'onRest',
				breakpoints: [
					{
						count: 1,
						actions: [
							{ kind: 'gainAugment', amount: 2 },
							{ kind: 'gainRelic', amount: 1 }
						]
					}
				]
			}
		]);
		const p = fireRest('SynthSpecials', 1, { barrier: 4, maxBarrier: 4 });
		expect(p.unplacedAugments?.length ?? 0).toBe(2);
		expect(p.relics).toBe(1);
	});

	it('purifyArcaneBlood heals arcane blood (clamped at full health)', () => {
		withSynthClass('SynthPurify', [
			{
				trigger: 'onRest',
				breakpoints: [{ count: 1, actions: [{ kind: 'purifyArcaneBlood', amount: 5 }] }]
			}
		]);
		// Start corrupted (arcane blood 2: maxTokens 6 − barrier 4); purify ≥2 ⇒ 0.
		const p = fireRest('SynthPurify', 1, { maxBarrier: 6, barrier: 4 });
		expect(p.maxBarrier - p.barrier).toBe(0);
	});

	it('extraAction accumulates into extraActions by key', () => {
		withSynthClass('SynthExtra', [
			{
				trigger: 'onRest',
				breakpoints: [
					{ count: 1, actions: [{ kind: 'extraAction', actionKey: 'rest', amount: 1 }] }
				]
			}
		]);
		const p = fireRest('SynthExtra', 1);
		expect(p.extraActions.rest).toBe(1);
	});

	it('manual still surfaces a prompt', () => {
		withSynthClass('SynthManual', [
			{
				trigger: 'onRest',
				breakpoints: [{ count: 1, actions: [{ kind: 'manual', prompt: 'Resolve by hand.' }] }]
			}
		]);
		const p = fireRest('SynthManual', 1);
		expect(p.manualPrompts).toHaveLength(1);
		expect(p.manualPrompts[0].text).toBe('Resolve by hand.');
	});
});

describe("'1+' per-trait scaling", () => {
	it('scales numeric amounts by traitCount', () => {
		withSynthClass('SynthScale', [
			{
				trigger: 'onRest',
				breakpoints: [{ count: '1+', actions: [{ kind: 'gainVP', amount: 2 }] }]
			}
		]);
		// 3 traits × 2 VP = 6.
		expect(fireRest('SynthScale', 3).victoryPoints).toBe(6);
	});

	it('does not apply at zero traits (no awakened spirit)', () => {
		withSynthClass('SynthScale0', [
			{
				trigger: 'onRest',
				breakpoints: [{ count: '1+', actions: [{ kind: 'gainVP', amount: 2 }] }]
			}
		]);
		const p = makePlayer({ spirits: [spirit(1, 'A', { SynthScale0: 1 }, {}, true)] }); // face-down
		applyTrigger(makeState({ Red: p }), 'Red', 'onRest', []);
		expect(p.victoryPoints).toBe(0);
	});
});

describe('conditional action', () => {
	it('takes the then-branch when the predicate holds', () => {
		withSynthClass('SynthCondEvil', [
			{
				trigger: 'onRest',
				breakpoints: [
					{
						count: 1,
						actions: [
							{
								kind: 'conditional',
								when: { kind: 'isEvil' },
								then: [{ kind: 'gainVP', amount: 7 }],
								else: [{ kind: 'gainVP', amount: 1 }]
							}
						]
					}
				]
			}
		]);
		// statusLevel 3 = Fallen = evil (Corrupt is Good).
		expect(fireRest('SynthCondEvil', 1, { statusLevel: 3 }).victoryPoints).toBe(7);
	});

	it('takes the else-branch when the predicate fails', () => {
		withSynthClass('SynthCondGood', [
			{
				trigger: 'onRest',
				breakpoints: [
					{
						count: 1,
						actions: [
							{
								kind: 'conditional',
								when: { kind: 'isEvil' },
								then: [{ kind: 'gainVP', amount: 7 }],
								else: [{ kind: 'gainVP', amount: 1 }]
							}
						]
					}
				]
			}
		]);
		expect(fireRest('SynthCondGood', 1, { statusLevel: 0 }).victoryPoints).toBe(1);
	});

	it('no-ops when the predicate fails and there is no else-branch', () => {
		withSynthClass('SynthCondNoElse', [
			{
				trigger: 'onRest',
				breakpoints: [
					{
						count: 1,
						actions: [
							{
								kind: 'conditional',
								when: { kind: 'isEvil' },
								then: [{ kind: 'gainVP', amount: 9 }]
							}
						]
					}
				]
			}
		]);
		expect(fireRest('SynthCondNoElse', 1, { statusLevel: 0 }).victoryPoints).toBe(0);
	});
});

describe('colocatedPlayers helper', () => {
	it('returns active seats sharing the destination, in activeSeats order, excluding self', () => {
		const red = makePlayer({ playerColor: 'Red', navigationDestination: 'Tidal Cove' });
		const blue = makePlayer({ playerColor: 'Blue', navigationDestination: 'Tidal Cove' });
		const green = makePlayer({ playerColor: 'Green', navigationDestination: 'Cyber City' });
		const state = makeState({ Red: red, Blue: blue, Green: green });
		const out = colocatedPlayers(state, 'Red');
		expect(out.map((p) => p.playerColor)).toEqual(['Blue']);
	});

	it('is empty when the acting seat has no destination', () => {
		const red = makePlayer({ playerColor: 'Red', navigationDestination: null });
		const blue = makePlayer({ playerColor: 'Blue', navigationDestination: 'Tidal Cove' });
		expect(colocatedPlayers(makeState({ Red: red, Blue: blue }), 'Red')).toHaveLength(0);
	});

	it('feeds the conditional hasColocated predicate', () => {
		withSynthClass('SynthColo', [
			{
				trigger: 'onRest',
				breakpoints: [
					{
						count: 1,
						actions: [
							{
								kind: 'conditional',
								when: { kind: 'hasColocated' },
								then: [{ kind: 'gainVP', amount: 4 }]
							}
						]
					}
				]
			}
		]);
		const red = makePlayer({
			playerColor: 'Red',
			navigationDestination: 'Tidal Cove',
			spirits: [spirit(1, 'A', { SynthColo: 1 })]
		});
		const blue = makePlayer({ playerColor: 'Blue', navigationDestination: 'Tidal Cove' });
		applyTrigger(makeState({ Red: red, Blue: blue }), 'Red', 'onRest', []);
		expect(red.victoryPoints).toBe(4);
	});
});

// ── Full-runtime smoke: Fighter dice output is identical post-refactor ─────────

const HOST: GameActor = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null };

// The Rest action icon id (REWARD_ICON_SEMANTICS). A location's available actions ARE
// its reward rows: the only way to Rest is to resolve a row whose gain is a Rest token.
const REST_ICON = 'bdded3f5-e405-4b68-b63a-9f5c2139beea';
// Floral Patch row 0: a free Rest (fires the onRest trigger).
const FLORAL_PATCH_ROWS: GameLocationRewardRow[] = [{ type: 'gain', gain_icon_ids: [REST_ICON] }];

const SMOKE_CATALOG: PlayCatalog = {
	guardians: [{ id: 'g-myrtle', name: 'Myrtle', originId: null }],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: [
		{ id: 'spirit-fighter', name: 'Duelist', cost: 2, classes: { Fighter: 4 }, origins: {} }
	],
	monsters: [],
	locations: [{ name: 'Floral Patch', originId: null, rewardRows: FLORAL_PATCH_ROWS }]
};

function startedLocationGame(): PublicGameState {
	let state = createLobbyState({ roomCode: 'SMOKE1', guardianNames: ['Myrtle'] });
	const claim = applyGameCommand(
		state,
		HOST,
		{ type: 'claimSeat', seatColor: 'Red' },
		SMOKE_CATALOG
	);
	if (!claim.ok) throw new Error(claim.error.message);
	state = claim.state;
	const guardian = applyGameCommand(
		state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'selectGuardian', guardianName: 'Myrtle' },
		SMOKE_CATALOG
	);
	if (!guardian.ok) throw new Error(guardian.error.message);
	state = guardian.state;
	const started = applyGameCommand(
		state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'startGame' },
		SMOKE_CATALOG
	);
	if (!started.ok) throw new Error(started.error.message);
	// Lock RED onto Floral Patch (free Rest at row 0) so the later force-advance reveal
	// stands RED there rather than at a random destination.
	const locked = applyGameCommand(
		started.state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'lockNavigation', destination: 'Floral Patch' },
		SMOKE_CATALOG
	);
	if (!locked.ok) throw new Error(locked.error.message);
	return locked.state;
}

describe('full-runtime smoke (startGame → rest)', () => {
	it('Fighter ×5 fills the 10-dice cap in one rest through the real command path', () => {
		const state = startedLocationGame();
		const red = state.players.Red!;
		// Control the tableau: a single face-up Fighter ×5 spirit, capacity for the dice.
		red.spirits = [spirit(1, 'Duelist', { Fighter: 5 })];
		red.maxBarrier = 10;
		red.attackDice = [];
		// Drive the phase machine to the Location phase.
		let s: PublicGameState = state;
		for (let i = 0; i < 4 && s.phase !== 'location'; i += 1) {
			const adv = applyGameCommand(
				s,
				{ ...HOST, seatColor: 'Red' },
				{ type: 'forceAdvancePhase' },
				SMOKE_CATALOG
			);
			if (!adv.ok) throw new Error(adv.error.message);
			s = adv.state;
		}
		expect(s.phase).toBe('location');
		expect(s.players.Red!.navigationDestination).toBe('Floral Patch');
		// forceAdvancePhase rebuilds players from a clone — re-assert the controlled tableau.
		s.players.Red!.spirits = [spirit(1, 'Duelist', { Fighter: 5 })];
		s.players.Red!.maxBarrier = 10;
		s.players.Red!.attackDice = [];
		s.players.Red!.actionsUsedThisRound = s.players.Red!.actionsUsedThisRound.filter(
			(a) => a !== 'row:0'
		);

		// Floral Patch row 0 is a free Rest — resolving it fires the onRest trigger.
		const rested = applyGameCommand(
			s,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveLocationInteraction', rowIndex: 0, choices: [] },
			SMOKE_CATALOG
		);
		if (!rested.ok) throw new Error(rested.error.message);
		const dice = rested.state.players.Red!.attackDice;
		expect(dice).toHaveLength(10); // Fighter-5 now grants +10 → caps the flat 10-dice pool in one rest
		expect(dice.every((d) => d.tier === 'basic')).toBe(true);
	});
});
