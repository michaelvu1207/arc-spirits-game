import { describe, expect, test } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import type { AttackDie, GameActor, GameCommand, PlayCatalog, PublicGameState, SeatColor } from './types';

// ── Harness: a 3-seat game (Red / Blue / Orange) so we can test group Encounter
//    (PvP) combat with multiple players per side. ────────────────────────────────
const HOST: GameActor = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null };
const G2: GameActor = { memberId: 'm-g2', displayName: 'G2', role: 'player', seatColor: null };
const G3: GameActor = { memberId: 'm-g3', displayName: 'G3', role: 'player', seatColor: null };
const RED: GameActor = { ...HOST, seatColor: 'Red' };
const BLUE: GameActor = { ...G2, seatColor: 'Blue' };
const ORANGE: GameActor = { ...G3, seatColor: 'Orange' };

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' },
		{ id: 'g-c', name: 'Orro', originId: 'o3' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 6 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: 2,
		classes: {},
		origins: {}
	}))
};

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
	return result.state;
}

function tryApply(state: PublicGameState, actor: GameActor, command: GameCommand) {
	return applyGameCommand(state, actor, command, CATALOG);
}

function started3(seed = 1): PublicGameState {
	let state = createLobbyState({ roomCode: 'ENC1', guardianNames: ['Myrtle', 'Nyra', 'Orro'] });
	state = apply(state, HOST, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, G2, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, G3, { type: 'claimSeat', seatColor: 'Orange' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Myrtle' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Nyra' });
	state = apply(state, ORANGE, { type: 'selectGuardian', guardianName: 'Orro' });
	state = apply(state, RED, { type: 'startGame', seed });
	return state;
}

const arcane = (n: number): AttackDie[] =>
	Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));

/** Lock everyone into Cyber City, configure sides, then force the reveal into the
 *  Encounter phase. `setup` runs after locks (statusLevel/dice survive the reveal). */
function intoEncounter(
	seed: number,
	setup: (s: PublicGameState) => void
): PublicGameState {
	let state = started3(seed);
	state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
	state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Cyber City' });
	state = apply(state, ORANGE, { type: 'lockNavigation', destination: 'Cyber City' });
	// All spirits cleared so no awaken/trigger noise perturbs barriers.
	for (const seat of state.activeSeats) {
		const p = state.players[seat]!;
		p.spirits = [];
		p.attackDice = [];
	}
	setup(state);
	state = apply(state, RED, { type: 'forceAdvancePhase' });
	return state;
}

describe('group Encounter (PvP) combat', () => {
	test('one Evil attacker hits EVERY co-located Good for the full amount (no splitting)', () => {
		const state = intoEncounter(2024, (s) => {
			const red = s.players.Red!;
			red.statusLevel = 3;
			red.statusToken = 'Fallen';
			red.attackDice = arcane(3); // 3–9 damage; below the goods' barrier so no corruption
			for (const seat of ['Blue', 'Orange'] as const) {
				const g = s.players[seat]!;
				g.statusLevel = 0;
				g.maxBarrier = 12;
				g.barrier = 12;
				g.brokenBarrier = 0;
				g.attackDice = []; // goods deal nothing back here
			}
		});
		expect(state.phase).toBe('encounter');

		const after = apply(state, RED, { type: 'initiatePvp' });
		const blue = after.players.Blue!;
		const orange = after.players.Orange!;
		// Same full damage applied to BOTH goods — identical resulting barrier, both hit.
		expect(blue.barrier).toBe(orange.barrier);
		expect(blue.barrier).toBeLessThan(12);
		// 2 VP for engaging (goods' barrier is above the max roll here, so no
		// corruption bonus is in play).
		const pvp = after.combats.find((c) => c.kind === 'pvp')!;
		const redSide = pvp.sides.find((s) => s.seat === 'Red')!;
		expect(redSide.damageDealt).toBeGreaterThan(0);
		expect(after.players.Red!.victoryPoints).toBe(2);
	});

	test('two Evil attackers: unanimous → both fire, +2 VP each (+2/corruption), pooled damage', () => {
		const state = intoEncounter(7, (s) => {
			for (const seat of ['Red', 'Orange'] as const) {
				const e = s.players[seat]!;
				e.statusLevel = 3;
				e.statusToken = 'Fallen';
				e.attackDice = arcane(3);
			}
			const blue = s.players.Blue!;
			blue.statusLevel = 0;
			blue.maxBarrier = 14;
			blue.barrier = 14;
			blue.brokenBarrier = 0;
		});
		const blueBefore = state.players.Blue!.barrier;

		// First Evil votes → waits for the second (no combat yet).
		let after = apply(state, RED, { type: 'initiatePvp' });
		expect(after.combats.some((c) => c.kind === 'pvp')).toBe(false);
		expect(after.players.Blue!.barrier).toBe(blueBefore);

		// Second Evil votes → unanimous → group strike resolves. Each attacker scores
		// 2 VP for engaging, plus 2 per corrupted Good player.
		after = apply(after, ORANGE, { type: 'initiatePvp' });
		const pvp = after.combats.find((c) => c.kind === 'pvp')!;
		expect(pvp).toBeTruthy();
		const corruptedGood = pvp.sides.filter((s) => s.side === 'good' && s.corrupted).length;
		for (const seat of ['Red', 'Orange'] as const) {
			const side = pvp.sides.find((s) => s.seat === seat)!;
			expect(side.damageDealt).toBeGreaterThan(0);
			expect(after.players[seat]!.victoryPoints).toBe(2 + 2 * corruptedGood);
		}
		// Blue either took the pooled hit or was corrupted (barrier reset to full).
		const bluePvp = pvp.sides.find((s) => s.seat === 'Blue')!;
		if (bluePvp.corrupted) expect(after.players.Blue!.barrier).toBe(14);
		else expect(after.players.Blue!.barrier).toBeLessThan(blueBefore);
	});

	test('corrupting Good players grants +2 VP each on top of the engage VP', () => {
		const state = intoEncounter(99, (s) => {
			const red = s.players.Red!;
			red.statusLevel = 3;
			red.statusToken = 'Fallen';
			red.attackDice = arcane(3); // rolls at least 3 — always corrupts a 2-barrier Good
			for (const seat of ['Blue', 'Orange'] as const) {
				const g = s.players[seat]!;
				g.statusLevel = 0;
				g.maxBarrier = 2;
				g.barrier = 2;
				g.brokenBarrier = 0;
				g.attackDice = [];
			}
		});

		const after = apply(state, RED, { type: 'initiatePvp' });
		const pvp = after.combats.find((c) => c.kind === 'pvp')!;
		// Both Good players corrupt (roll ≥ 3 vs barrier 2) → +4 on top of the engage 2.
		expect(pvp.sides.filter((s) => s.side === 'good' && s.corrupted)).toHaveLength(2);
		expect(after.players.Red!.victoryPoints).toBe(2 + 4);
	});

	test('non-unanimous: one Evil holds → no combat, no VP, no damage', () => {
		const state = intoEncounter(11, (s) => {
			for (const seat of ['Red', 'Orange'] as const) {
				const e = s.players[seat]!;
				e.statusLevel = 3;
				e.statusToken = 'Fallen';
				e.attackDice = arcane(4);
			}
			const blue = s.players.Blue!;
			blue.statusLevel = 0;
			blue.maxBarrier = 14;
			blue.barrier = 14;
			blue.brokenBarrier = 0;
		});
		const blueBefore = state.players.Blue!.barrier;

		let after = apply(state, RED, { type: 'initiatePvp' }); // Red votes attack
		after = apply(after, ORANGE, { type: 'passEncounter' }); // Orange declines → cancels

		expect(after.combats.some((c) => c.kind === 'pvp')).toBe(false);
		expect(after.players.Blue!.barrier).toBe(blueBefore);
		expect(after.players.Red!.victoryPoints).toBe(0);
		expect(after.players.Orange!.victoryPoints).toBe(0);
	});

	test('tied initiative (0 vs 0): both sides strike at once — the Good side retaliates', () => {
		const state = intoEncounter(99, (s) => {
			const red = s.players.Red!;
			red.statusLevel = 3;
			red.statusToken = 'Fallen';
			red.maxBarrier = 14;
			red.barrier = 14;
			red.brokenBarrier = 0;
			red.attackDice = arcane(2);
			const blue = s.players.Blue!;
			blue.statusLevel = 0;
			blue.maxBarrier = 14;
			blue.barrier = 14;
			blue.brokenBarrier = 0;
			blue.attackDice = arcane(2); // goods have dice → they hit back simultaneously
			// Orange present but neutral with high barrier; it takes damage too.
			const orange = s.players.Orange!;
			orange.statusLevel = 0;
			orange.maxBarrier = 14;
			orange.barrier = 14;
			orange.brokenBarrier = 0;
			orange.attackDice = [];
		});
		const after = apply(state, RED, { type: 'initiatePvp' });
		// Evil struck the goods AND the goods (with dice) struck Evil back — neither
		// side was stunned first because initiative tied, so both took damage.
		expect(after.players.Blue!.barrier).toBeLessThan(14);
		expect(after.players.Orange!.barrier).toBeLessThan(14);
		expect(after.players.Red!.barrier).toBeLessThan(14);
	});

	test('a Good reduced past its barrier is flagged stunned', () => {
		const state = intoEncounter(5, (s) => {
			const red = s.players.Red!;
			red.statusLevel = 3;
			red.statusToken = 'Fallen';
			red.attackDice = arcane(6); // ≥6 damage — overruns a tiny barrier
			const blue = s.players.Blue!;
			blue.statusLevel = 0;
			blue.maxBarrier = 2;
			blue.barrier = 2;
			blue.brokenBarrier = 0;
			blue.attackDice = [];
			blue.stunImmune = false;
			const orange = s.players.Orange!;
			orange.statusLevel = 0;
			orange.maxBarrier = 14;
			orange.barrier = 14;
			orange.brokenBarrier = 0;
			orange.attackDice = [];
		});
		const after = apply(state, RED, { type: 'initiatePvp' });
		expect(after.players.Blue!.stunned).toBe(true);
	});

	test('Good players cannot initiate the attack', () => {
		const state = intoEncounter(3, (s) => {
			s.players.Red!.statusLevel = 3;
			s.players.Red!.statusToken = 'Fallen';
			s.players.Blue!.statusLevel = 0;
			s.players.Orange!.statusLevel = 0;
		});
		const res = tryApply(state, BLUE, { type: 'initiatePvp' });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe('not_evil');
	});
});
