import { describe, expect, it } from 'vitest';
import { makePlayer, makeState, spirit } from './testHelpers';
import { resolveEncounterCombat, takeDamage } from '../../combat';
import { buildEffectContext } from '../context';
import {
	AWAKEN_HANDLERS,
	AWAKEN_PROGRESS_KEYS as KEYS,
	AWAKEN_SPIRIT_IDS as IDS,
	recordAwakenProgress
} from '../awakenHandlers';
import { setCorruptionDiscardObligation, type AttackDie, type PlaySpirit, type PrivatePlayerState } from '../../types';

/** Moon rework (Michael, approved 2026-11-12): Witch, Cultist, Acolyte and the four Moon awakens.
 *  Assassin and Sorcerer are in darkFighter.test.ts / arcaneAdvisor.test.ts. */

const die = (id: string, tier: AttackDie['tier']): AttackDie => ({ instanceId: id, tier });

/** Good Red vs Evil Blue at the same location. */
function pvp(red: Partial<PrivatePlayerState>, blue: Partial<PrivatePlayerState>) {
	const r = makePlayer({ navigationDestination: 'Forest Region', barrier: 10, maxBarrier: 10, ...red });
	const b = makePlayer({
		playerColor: 'Blue',
		statusLevel: 3,
		statusToken: 'Fallen',
		navigationDestination: 'Forest Region',
		barrier: 10,
		maxBarrier: 10,
		...blue
	});
	return { state: makeState(r, { Blue: b }), red: r, blue: b };
}

const faceDown = (id: string, slotIndex = 5): PlaySpirit => spirit(slotIndex, {}, { id, faceDown: true });

function canAwaken(player: PrivatePlayerState, target: PlaySpirit) {
	const state = makeState(player);
	return AWAKEN_HANDLERS[target.id].check({
		...buildEffectContext({ state, seat: 'Red', player, trigger: 'awakening', log: [], traitCount: 0 }),
		spirit: target
	}).ok;
}

describe('Witch — "At the start of combat with a player, take the best attack dice of that player for this combat."', () => {
	it('takes the highest-tier die for the combat and gives it back after', () => {
		const { state, red, blue } = pvp(
			{ spirits: [spirit(1, { Witch: 1 })], attackDice: [die('r1', 'basic')] },
			{ attackDice: [die('b1', 'basic'), die('b2', 'arcane'), die('b3', 'exalted')] }
		);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(combat.log.some((l) => l.includes("Witch: takes Blue's best attack die (arcane)"))).toBe(true);
		// After the combat: the die is back with its owner, the Witch has only its own.
		expect(blue.attackDice.map((d) => d.instanceId).sort()).toEqual(['b1', 'b2', 'b3']);
		expect(red.attackDice.map((d) => d.instanceId)).toEqual(['r1']);
		expect(red.witchBorrowedDice).toEqual([]);
	});

	it('the Witch rolls the taken die; the opponent does not', () => {
		// Same seed: the Witch's roll of the taken die equals the owner's roll without a Witch.
		const base = pvp({ attackDice: [] }, { attackDice: [die('b2', 'arcane')] });
		const plain = resolveEncounterCombat(base.state, undefined, ['Blue'], ['Red']);
		const blueDealtPlain = plain.sides.find((s) => s.seat === 'Blue')!.damageDealt;
		const witch = pvp({ spirits: [spirit(1, { Witch: 1 })], attackDice: [] }, { attackDice: [die('b2', 'arcane')] });
		const hexed = resolveEncounterCombat(witch.state, undefined, ['Blue'], ['Red']);
		expect(hexed.sides.find((s) => s.seat === 'Blue')!.damageDealt).toBe(0);
		expect(hexed.sides.find((s) => s.seat === 'Red')!.damageDealt).toBe(blueDealtPlain);
	});

	it('no dice to take, face-down Witch, or monster combat: nothing', () => {
		const none = pvp({ spirits: [spirit(1, { Witch: 1 })] }, { attackDice: [] });
		const log = resolveEncounterCombat(none.state, undefined, ['Blue'], ['Red']).log;
		expect(log.some((l) => l.startsWith('Witch:'))).toBe(false);
		const down = pvp({ spirits: [spirit(1, { Witch: 1 }, { faceDown: true })] }, { attackDice: [die('b', 'arcane')] });
		expect(resolveEncounterCombat(down.state, undefined, ['Blue'], ['Red']).log.some((l) => l.startsWith('Witch:'))).toBe(false);
	});

	it('the take happens before Assassin compares dice counts', () => {
		// Blue (Evil) Witch takes Red's only die → Red (Assassin, now 0 dice) vs Blue 1+1 → Red deals 3 more.
		const { state } = pvp(
			{ spirits: [spirit(1, { Assassin: 1 })], attackDice: [die('r1', 'basic')] },
			{ spirits: [spirit(1, { Witch: 1 }), spirit(2, { Titan: 1 })], attackDice: [die('b1', 'basic')] }
		);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		const witchAt = combat.log.findIndex((l) => l.startsWith("Witch: takes Red's best attack die"));
		const assassinAt = combat.log.findIndex((l) => l.startsWith('Assassin: Blue has more attack dice — deal 3 more.'));
		expect(witchAt).toBeGreaterThanOrEqual(0);
		expect(assassinAt).toBeGreaterThan(witchAt);
		// Red rolls no die (the Witch has it), so all of Red's damage is the Assassin's 3.
		expect(combat.sides.find((s) => s.seat === 'Red')!.damageDealt).toBe(3);
	});
});

describe('Cultist — "When you become Corrupted, sacrifice 1 fewer spirit."', () => {
	it('a corruption: 1 fewer sacrifice and no VP', () => {
		const player = makePlayer({
			barrier: 1,
			maxBarrier: 4,
			spirits: [spirit(1, { Cultist: 1 }), spirit(2, {}), spirit(3, {})]
		});
		takeDamage(player, 2, { state: makeState(player), seat: 'Red' }, []);
		expect(player.victoryPoints).toBe(0);
		expect(player.pendingCorruptionDiscard ?? null).toBeNull(); // the 1st corruption owes 0, not 1
		player.corruptionCount = 2;
		setCorruptionDiscardObligation(player);
		expect(player.pendingCorruptionDiscard?.count).toBe(1); // the 2nd owes 1, not 2
	});
	it('face-down Cultist: no VP and the full sacrifice', () => {
		const player = makePlayer({ barrier: 1, maxBarrier: 4, spirits: [spirit(1, { Cultist: 1 }, { faceDown: true }), spirit(2, {})] });
		takeDamage(player, 2, { state: makeState(player), seat: 'Red' }, []);
		expect(player.victoryPoints).toBe(0);
		expect(player.pendingCorruptionDiscard?.count).toBe(1);
	});
});

describe('Acolyte — "When you deal damage to a player, restore the same quantity of Barrier."', () => {
	it('restores the Barrier the opponent lost (up to Max Barrier)', () => {
		const { state, red, blue } = pvp(
			{ spirits: [spirit(1, { Acolyte: 1 }), spirit(2, { Titan: 1 })], barrier: 3, maxBarrier: 10 },
			{ spirits: [spirit(1, {})] }
		);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		const lost = 10 - blue.barrier; // Titan's +6 damage
		expect(lost).toBe(6);
		expect(red.barrier).toBe(9);
		expect(combat.log.some((l) => l.includes('Acolyte: restores 6 Barrier'))).toBe(true);
	});
	it('no Barrier lost (0 damage), or face-down: no restore', () => {
		const { state, red } = pvp({ spirits: [spirit(1, { Acolyte: 1 })], barrier: 3 }, {});
		resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(red.barrier).toBe(3);
		const down = pvp({ spirits: [spirit(1, { Acolyte: 1 }, { faceDown: true }), spirit(2, { Titan: 1 })], barrier: 3 }, {});
		resolveEncounterCombat(down.state, undefined, ['Blue'], ['Red']);
		expect(down.red.barrier).toBe(3);
	});
	it('the restore stops at Max Barrier', () => {
		const { state, red } = pvp({ spirits: [spirit(1, { Acolyte: 1 }), spirit(2, { Titan: 1 })], barrier: 8, maxBarrier: 10 }, {});
		resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(red.barrier).toBe(10);
	});
});

describe('Moon awaken conditions (Fallen: the action while Fallen, and Fallen to awaken)', () => {
	/** The awaken check result (ok + reason) for `target`. */
	function awakenCheck(player: PrivatePlayerState, target: PlaySpirit) {
		return AWAKEN_HANDLERS[target.id].check({
			...buildEffectContext({ state: makeState(player), seat: 'Red', player, trigger: 'awakening', log: [], traitCount: 0 }),
			spirit: target
		});
	}

	it('Moonrend — "While Fallen, attack another player.": the Fallen (attacking) side of a PvP combat', () => {
		const rend = faceDown(IDS.moonrend);
		const { state, red, blue } = pvp({ spirits: [rend] }, { spirits: [rend] });
		resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(canAwaken(blue, rend)).toBe(true); // Fallen attacker
		expect(canAwaken(red, rend)).toBe(false); // defender, not Fallen
	});

	it('Night Witch — "Become Corrupted while Fallen.": only a corruption while already Fallen', () => {
		const witch = faceDown(IDS.nightWitch);
		const notFallen = makePlayer({ statusLevel: 2, barrier: 1, maxBarrier: 4, spirits: [witch, spirit(2, {})] });
		takeDamage(notFallen, 1, { state: makeState(notFallen), seat: 'Red' }, []);
		expect(notFallen.statusLevel).toBe(3); // the corruption made it Fallen ...
		expect(canAwaken(notFallen, witch)).toBe(false); // ... but it was not Fallen when Corrupted
		const fallen = makePlayer({ statusLevel: 3, barrier: 1, maxBarrier: 4, spirits: [witch, spirit(2, {})] });
		takeDamage(fallen, 1, { state: makeState(fallen), seat: 'Red' }, []);
		expect(canAwaken(fallen, witch)).toBe(true);
	});

	it('Veiled Acolyte — "While Fallen, deal damage to another player.": a Fallen player makes the target lose Barrier', () => {
		const acolyte = faceDown(IDS.veiledAcolyte);
		const hit = pvp({ statusLevel: 3, spirits: [acolyte, spirit(1, { Titan: 1 })] }, {});
		resolveEncounterCombat(hit.state, undefined, ['Blue'], ['Red']);
		expect(canAwaken(hit.red, acolyte)).toBe(true);
		const notFallen = pvp({ spirits: [acolyte, spirit(1, { Titan: 1 })] }, {});
		resolveEncounterCombat(notFallen.state, undefined, ['Blue'], ['Red']);
		expect(notFallen.blue.barrier).toBeLessThan(10); // the damage was dealt ...
		expect(canAwaken(notFallen.red, acolyte)).toBe(false); // ... but not while Fallen
		const miss = pvp({ statusLevel: 3, spirits: [acolyte] }, {});
		resolveEncounterCombat(miss.state, undefined, ['Blue'], ['Red']);
		expect(canAwaken(miss.red, acolyte)).toBe(false);
	});

	it('the owner must be Fallen at the moment of awakening (the flag alone is not enough)', () => {
		for (const [id, key] of [
			[IDS.moonrend, KEYS.moonrend],
			[IDS.nightWitch, KEYS.nightWitch],
			[IDS.moonCultist, KEYS.moonCultist],
			[IDS.veiledAcolyte, KEYS.veiledAcolyte]
		] as const) {
			const target = faceDown(id);
			const player = makePlayer({ statusLevel: 3, spirits: [target] });
			recordAwakenProgress(player, id, key);
			expect(awakenCheck(player, target)).toEqual({ ok: true });
			player.statusLevel = 2; // no longer Fallen (for example, a cleanse)
			expect(awakenCheck(player, target)).toEqual({ ok: false, reason: 'fallen_required' });
		}
	});

	it('the flags are paid (cleared) when the spirit awakens', () => {
		const witch = faceDown(IDS.nightWitch);
		const player = makePlayer({ statusLevel: 3, barrier: 1, maxBarrier: 4, spirits: [witch, spirit(2, {})] });
		takeDamage(player, 1, { state: makeState(player), seat: 'Red' }, []);
		expect(canAwaken(player, witch)).toBe(true);
		const ctx = {
			...buildEffectContext({ state: makeState(player), seat: 'Red', player, trigger: 'awakening', log: [], traitCount: 0 }),
			spirit: witch
		};
		AWAKEN_HANDLERS[IDS.nightWitch].pay(ctx);
		expect(canAwaken(player, witch)).toBe(false);
	});
});
