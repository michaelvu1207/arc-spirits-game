import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';
import type { AttackDie } from '../../types';
import { nextId, createRng } from '../../rng';

// Elementalist — DB intent: on Rest, dice QUALITY upgrades on a super-linear ladder
// by Elementalist count: 2/3/4/5 traits -> upgrade 1/2/5/10 times. A lone Elementalist
// (count 1) does nothing. Each "upgrade" steps the lowest basic/enchanted attack die up
// one tier (basic -> enchanted -> exalted); the generic ladder caps at exalted.
//
// UX channel: an engine action (upgradeDice) that surfaces as an
// "Upgraded N attack dice to a higher tier." log line and raises a die's tier.
//
// `fire` builds ONE awakened spirit carrying the class counts, so {'Elementalist': N}
// gives an awakened pool of N. To observe the raw ladder `times`, we seed a generous
// pool of basic attack dice so each upgrade has a distinct lowest-tier target.

/** A pool of `n` basic attack dice (deterministic ids via the test rng). */
function basicDice(n: number): AttackDie[] {
	const rng = createRng(1);
	return Array.from({ length: n }, () => ({ instanceId: nextId(rng, 'die'), tier: 'basic' as const }));
}

/** Count basic dice that were stepped up one tier (to enchanted) by the ladder. */
function upgradedCount(dice: AttackDie[]): number {
	return dice.filter((d) => d.tier === 'enchanted').length;
}

describe('Elementalist', () => {
	it('count 2 upgrades 1 die on Rest', () => {
		const { player, log } = fire({ 'Elementalist': 2 }, 'onRest', {
			player: { attackDice: basicDice(12) }
		});
		expect(upgradedCount(player.attackDice)).toBe(1);
		expect(log.join("\n")).toContain('Upgraded 1 attack dice to a higher tier.');
	});

	it('count 3 upgrades 2 dice on Rest', () => {
		const { player, log } = fire({ 'Elementalist': 3 }, 'onRest', {
			player: { attackDice: basicDice(12) }
		});
		expect(upgradedCount(player.attackDice)).toBe(2);
		expect(log.join("\n")).toContain('Upgraded 2 attack dice to a higher tier.');
	});

	it('count 4 upgrades 5 dice on Rest', () => {
		const { player, log } = fire({ 'Elementalist': 4 }, 'onRest', {
			player: { attackDice: basicDice(12) }
		});
		expect(upgradedCount(player.attackDice)).toBe(5);
		expect(log.join("\n")).toContain('Upgraded 5 attack dice to a higher tier.');
	});

	it('count 5 upgrades 10 dice on Rest', () => {
		const { player, log } = fire({ 'Elementalist': 5 }, 'onRest', {
			player: { attackDice: basicDice(12) }
		});
		expect(upgradedCount(player.attackDice)).toBe(10);
		expect(log.join("\n")).toContain('Upgraded 10 attack dice to a higher tier.');
	});

	it('a lone Elementalist (count 1) does nothing — below the lowest breakpoint', () => {
		const { player, log } = fire({ 'Elementalist': 1 }, 'onRest', {
			player: { attackDice: basicDice(12) }
		});
		expect(upgradedCount(player.attackDice)).toBe(0);
		expect(log.some((l) => /Upgraded/.test(l))).toBe(false);
	});

	it('picks the highest breakpoint at/below the count (count 6 still uses the count-5 rung)', () => {
		const { player } = fire({ 'Elementalist': 6 }, 'onRest', {
			player: { attackDice: basicDice(12) }
		});
		expect(upgradedCount(player.attackDice)).toBe(10);
	});

	it('does not upgrade on an unrelated trigger (no silent stacking)', () => {
		const { player, log } = fire({ 'Elementalist': 5 }, 'awakening', {
			player: { attackDice: basicDice(12) }
		});
		expect(upgradedCount(player.attackDice)).toBe(0);
		expect(log.some((l) => /Upgraded/.test(l))).toBe(false);
	});

	it('the generic ladder caps at exalted (never reaches arcane)', () => {
		// One basic die + the count-5 rung (10 upgrades): it steps basic -> enchanted ->
		// exalted and then stops (exalted is excluded from the ladder), so it never
		// becomes arcane regardless of how many upgrade `times` remain.
		const { player } = fire({ 'Elementalist': 5 }, 'onRest', {
			player: { attackDice: basicDice(1) }
		});
		expect(player.attackDice[0].tier).toBe('exalted');
		expect(player.attackDice.some((d) => d.tier === 'arcane')).toBe(false);
	});

	it('surfaces to the player via a log line (no silent no-op)', () => {
		const { log } = fire({ 'Elementalist': 4 }, 'onRest', {
			player: { attackDice: basicDice(12) }
		});
		expect(log.some((l) => /Upgraded \d+ attack dice to a higher tier\./.test(l))).toBe(true);
	});
});
