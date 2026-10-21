/**
 * Battle Adept — declarative `onMonsterKill` ability.
 *
 * DB-intended behavior (source of truth):
 *   - If you overkill by 2 damage, gain 1 potential.
 *   - If you don't kill, gain 1 Enchanted Attack (die).
 *
 * The two outcomes are mutually exclusive in practice (overkill implies a kill;
 * "not killed" implies no overkill), but both branches are exercised here. We fire
 * the real dispatcher (`applyTrigger`) with `combat` info threaded in, because the
 * shared `fire()` helper does not thread combat — and this is a declarative
 * breakpoint class, so there is no `run` handler to unit-test directly.
 *
 * UX channel: every branch surfaces as an attributed combat log line
 * ("Battle Adept: Gained N potential." / "… Gained N enchanted attack dice."),
 * so neither branch is a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { applyTrigger } from '../apply';
import type { EffectCombatInfo } from '../context';
import { makePlayer, makeState, spirit } from './testHelpers';
import type { PrivatePlayerState } from '../../types';

/** Fire onMonsterKill for a Red Battle Adept with the given combat outcome. */
function fireKill(
	combat: EffectCombatInfo,
	playerOverrides: Partial<PrivatePlayerState> = {}
): { player: PrivatePlayerState; log: string[] } {
	const player = makePlayer({
		spirits: [spirit(1, { 'Battle Adept': 1 })],
		...playerOverrides
	});
	const state = makeState(player);
	const log: string[] = [];
	applyTrigger(state, 'Red', 'onMonsterKill', log, { combat });
	return { player, log };
}

describe('Battle Adept', () => {
	it('overkill by 2: gains 1 potential', () => {
		const before = makePlayer().maxBarrier; // 4
		const { player, log } = fireKill(
			{ dealt: 10, overkill: 2, killed: true },
			{ barrier: 2, brokenBarrier: 2 }
		);

		expect(player.maxBarrier).toBe(before + 1);
		expect(player.barrier).toBe(2);
		expect(player.brokenBarrier).toBe(3);
		// Surfaces to the player as an attributed log line (no silent no-op).
		expect(log.some((l) => l.includes('Battle Adept: Gained 1 max barrier.'))).toBe(true);
		// Did NOT take the "not killed" branch.
		expect(player.attackDice.length).toBe(0);
	});

	it('overkill of exactly 2 is the threshold (>= 2)', () => {
		const { player } = fireKill({ dealt: 12, overkill: 4, killed: true });
		expect(player.maxBarrier).toBe(makePlayer().maxBarrier + 1);
	});

	it('overkill by only 1: no potential gained', () => {
		const { player, log } = fireKill({ dealt: 9, overkill: 1, killed: true });
		expect(player.maxBarrier).toBe(makePlayer().maxBarrier);
		expect(log.some((l) => l.includes('potential'))).toBe(false);
		// Killed, so no enchanted die either.
		expect(player.attackDice.length).toBe(0);
	});

	it('did not kill: gains 1 enchanted attack die', () => {
		const { player, log } = fireKill({ dealt: 3, overkill: 0, killed: false });

		expect(player.attackDice.length).toBe(1);
		expect(player.attackDice[0].tier).toBe('enchanted');
		// Surfaces to the player as an attributed log line (no silent no-op).
		expect(log.some((l) => l.includes('Battle Adept: Gained 1 enchanted attack dice.'))).toBe(true);
		// Did NOT take the overkill branch.
		expect(player.maxBarrier).toBe(makePlayer().maxBarrier);
	});

	it('exact kill (killed, zero overkill): no potential, no enchanted die', () => {
		const { player, log } = fireKill({ dealt: 8, overkill: 0, killed: true });
		expect(player.maxBarrier).toBe(makePlayer().maxBarrier);
		expect(player.attackDice.length).toBe(0);
		// Neither breakpoint branch fired -> no Battle Adept log lines.
		expect(log.some((l) => l.startsWith('Battle Adept:'))).toBe(false);
	});

	it('is inactive when the Battle Adept spirit is face-down (unawakened)', () => {
		const { player } = fireKill(
			{ dealt: 3, overkill: 0, killed: false },
			{ spirits: [spirit(1, { 'Battle Adept': 1 }, { faceDown: true })] }
		);
		expect(player.attackDice.length).toBe(0);
		expect(player.maxBarrier).toBe(makePlayer().maxBarrier);
	});
});
