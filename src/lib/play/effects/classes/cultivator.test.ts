import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';

// Cultivator — DB intent: on Cultivate, an awakened Cultivator POOL grants potential
// on a super-linear ladder by Cultivator count: 2/3/4/5 traits -> +1/+2/+5/+10 potential.
// A lone Cultivator (count 1) grants nothing. gainPotential is capped at maxTokens 10.
//
// UX channel: an engine action (gainPotential) that surfaces as a "Gained N potential."
// log line and grows the acting player's max barrier while restoring each new barrier.
//
// `fire` builds ONE awakened spirit carrying the class counts, so {Cultivator: N}
// gives an awakened pool of N. maxTokens defaults to 4 (cap 10), so to observe the
// raw ladder amount below the cap we start from maxTokens 0.

describe('Cultivator', () => {
	it('count 2 grants +1 potential on Cultivate', () => {
		const { player, log } = fire({ Cultivator: 2 }, 'onCultivate', {
			player: { maxBarrier: 4, barrier: 2, brokenBarrier: 2 }
		});
		expect(player.maxBarrier).toBe(5);
		expect(player.barrier).toBe(3);
		expect(player.brokenBarrier).toBe(2);
		expect(log.join("\n")).toContain('Gained 1 max barrier.');
	});

	it('count 3 grants +2 potential on Cultivate', () => {
		const { player, log } = fire({ Cultivator: 3 }, 'onCultivate', {
			player: { maxBarrier: 0, barrier: 0, brokenBarrier: 0 }
		});
		expect(player.maxBarrier).toBe(2);
		expect(log.join("\n")).toContain('Gained 2 max barrier.');
	});

	it('count 4 grants +5 potential on Cultivate', () => {
		const { player, log } = fire({ Cultivator: 4 }, 'onCultivate', {
			player: { maxBarrier: 0, barrier: 0, brokenBarrier: 0 }
		});
		expect(player.maxBarrier).toBe(5);
		expect(log.join("\n")).toContain('Gained 5 max barrier.');
	});

	it('count 5 grants +10 potential on Cultivate (maxes the pool from zero)', () => {
		const { player, log } = fire({ Cultivator: 5 }, 'onCultivate', {
			player: { maxBarrier: 0, barrier: 0, brokenBarrier: 0 }
		});
		expect(player.maxBarrier).toBe(10);
		expect(log.join("\n")).toContain('Gained 10 max barrier.');
	});

	it('count 5 caps gained potential at 10 (no overflow past maxTokens 10)', () => {
		// Starting from maxTokens 4, +10 would be 14 but caps at 10 -> grew 6.
		const { player, log } = fire({ Cultivator: 5 }, 'onCultivate', {
			player: { maxBarrier: 4, barrier: 4, brokenBarrier: 0 }
		});
		expect(player.maxBarrier).toBe(10);
		expect(log.join("\n")).toContain('Gained 6 max barrier.');
	});

	it('a lone Cultivator (count 1) grants nothing — below the lowest breakpoint', () => {
		const { player, log } = fire({ Cultivator: 1 }, 'onCultivate', {
			player: { maxBarrier: 0, barrier: 0, brokenBarrier: 0 }
		});
		expect(player.maxBarrier).toBe(0);
		expect(log.some((l) => l.includes('potential'))).toBe(false);
	});

	it('picks the highest breakpoint at/below the count (count 6 still uses the count-5 rung)', () => {
		const { player } = fire({ Cultivator: 6 }, 'onCultivate', {
			player: { maxBarrier: 0, barrier: 0, brokenBarrier: 0 }
		});
		expect(player.maxBarrier).toBe(10);
	});

	it('does not grant potential on an unrelated trigger (no silent stacking)', () => {
		const { player } = fire({ Cultivator: 5 }, 'awakening', {
			player: { maxBarrier: 0, barrier: 0, brokenBarrier: 0 }
		});
		expect(player.maxBarrier).toBe(0);
	});

	it('surfaces to the player via a log line (no silent no-op)', () => {
		const { log } = fire({ Cultivator: 4 }, 'onCultivate', {
			player: { maxBarrier: 0, barrier: 0, brokenBarrier: 0 }
		});
		expect(log.some((l) => /Gained \d+ max barrier\./.test(l))).toBe(true);
	});
});
