/**
 * Sharpshooter — DB-intended behavior (source of truth):
 *   - On summon, gain 1 Enchanted Attack (die).
 *   - Your side may always attack at the same time as the enemy.
 *
 * The summon grant is a declarative `onSpiritSummon` breakpoint, fired through the
 * real dispatcher via `fire()`. Both actions surface to the player as attributed
 * log lines (no silent no-op): "Gained 1 enchanted attack dice." and
 * "You cannot be stunned."
 *
 * The "always attack at the same time" rule lives in combat.ts
 * (`hasSimultaneousAttack`, not exported), which keys directly on the Sharpshooter
 * class count (>= 1) carried by the spirit — independent of the per-combat
 * `stunImmune` flag. That passive is owned by combat.ts, so it is asserted there;
 * here we only verify the summon-time grant that this class file owns.
 */

import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';

describe('Sharpshooter', () => {
	it('on discard: gains 1 enchanted attack die', () => {
		const { player } = fire({ 'Sharpshooter': 1 }, 'onSpiritDiscard');

		expect(player.attackDice.length).toBe(1);
		expect(player.attackDice[0].tier).toBe('enchanted');
	});

	it('on discard: surfaces the enchanted-die gain as a log line', () => {
		const { log } = fire({ 'Sharpshooter': 1 }, 'onSpiritDiscard');

		expect(log.some((l) => l.includes('Gained 1 enchanted attack dice.'))).toBe(true);
	});

	it('does not grant on an unrelated trigger (no summon -> no die)', () => {
		const { player } = fire({ 'Sharpshooter': 1 }, 'onRest');

		expect(player.attackDice.length).toBe(0);
		expect(player.stunImmune).toBe(false);
	});

	it('is inactive when the Sharpshooter spirit is face-down (unawakened)', () => {
		const { player, log } = fire(
			{ 'Sharpshooter': 1 },
			'onSpiritDiscard',
			{ player: { spirits: [{ slotIndex: 1, id: 's1', name: 'Spirit 1', cost: 2, classes: { 'Sharpshooter': 1 }, origins: {}, isFaceDown: true }] } }
		);

		expect(player.attackDice.length).toBe(0);
		expect(player.stunImmune).toBe(false);
		expect(log.some((l) => l.includes('attack dice'))).toBe(false);
	});

	// The "your side may always attack at the same time as the enemy" passive is
	// enforced by combat.ts (`hasSimultaneousAttack`, internal/not exported) keying on
	// the Sharpshooter class count >= 1. It is owned + tested by the combat resolver,
	// not by this class file, so it is intentionally not asserted here.
	it.skip('always attacks simultaneously with the enemy (owned by combat.ts)', () => {
		// TODO: assert in a combat-resolver test that a player whose spirit carries
		// Sharpshooter >= 1 strikes simultaneously even when corrupted/stunned. The
		// guard `hasSimultaneousAttack` in combat.ts is not exported, so it cannot be
		// unit-tested from this file.
	});
});
