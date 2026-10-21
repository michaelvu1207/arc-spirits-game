/**
 * Relic Warden — "For every unique Relic you hold, reduce incoming damage by 2."
 *
 * Most cases drive the handler directly via `ability[0].run(ctxFor(...))` to unit-
 * test the unique-relic counting; the final case drives `fire(...)` to confirm the
 * class is wired into the assembler (`abilities.ts` MODULES) and dispatched by
 * `applyTrigger` on `onTakeDamage`.
 */

import { describe, expect, it } from 'vitest';
import type { MatSlotSnapshot } from '$lib/types';
import { ability } from './ancientMagus';
import { ctxFor, fire, makePlayer } from './testHelpers';

/** A held relic slot (type='relic'); `name` drives the uniqueness dedupe. */
function relic(slotIndex: number, name?: string): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name, type: 'relic' };
}

/** A held non-relic rune slot (must NOT count toward the reduction). */
function rune(slotIndex: number, name: string): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name, type: 'rune' };
}

const handler = ability[0];

function run(runes: MatSlotSnapshot[]) {
	const player = makePlayer({ mats: runes, damageReduction: 0 });
	const ctx = ctxFor(player, { trigger: 'onTakeDamage' });
	handler.run!(ctx);
	return { player, log: ctx.log };
}

describe('Relic Warden', () => {
	it('hangs a single onTakeDamage handler', () => {
		expect(ability).toHaveLength(1);
		expect(ability[0].on).toBe('onTakeDamage');
		expect(typeof ability[0].run).toBe('function');
	});

	it('reduces incoming damage by 2 per unique relic held', () => {
		const { player } = run([relic(1, 'Teapot'), relic(2, 'Keepsake'), relic(3, 'Flower Charm')]);
		expect(player.damageReduction).toBe(6); // 3 unique relics × 2
	});

	it('counts DUPLICATE relics by name only once', () => {
		const { player } = run([relic(1, 'Teapot'), relic(2, 'Teapot'), relic(3, 'Keepsake')]);
		expect(player.damageReduction).toBe(4); // 2 unique (Teapot, Keepsake) × 2
	});

	it('ignores non-relic runes', () => {
		const { player } = run([rune(1, 'Fairy Rune'), rune(2, 'Water Rune'), relic(3, 'Teapot')]);
		expect(player.damageReduction).toBe(2); // only the single relic
	});

	it('adds to existing damageReduction rather than overwriting it', () => {
		const player = makePlayer({ mats: [relic(1, 'Teapot')], damageReduction: 3 });
		const ctx = ctxFor(player, { trigger: 'onTakeDamage' });
		handler.run!(ctx);
		expect(player.damageReduction).toBe(5); // 3 prior + 2 from one relic
	});

	// ── No silent no-op: a unique relic surfaces a passive combat number + log ──
	it('surfaces a log line when it reduces damage (no silent no-op)', () => {
		const { player, log } = run([relic(1, 'Teapot'), relic(2, 'Keepsake')]);
		expect(player.damageReduction).toBe(4);
		expect(log.join('\n')).toMatch(/Relic Warden.*reduced incoming damage by 4.*2 unique relics/i);
	});

	it('does nothing (no reduction, no log) when no relics are held', () => {
		const { player, log } = run([rune(1, 'Fairy Rune')]);
		expect(player.damageReduction).toBe(0);
		expect(log).toHaveLength(0);
	});

	// Integration: confirm the class is wired into the assembler and dispatched by
	// applyTrigger on onTakeDamage (not just callable in isolation).
	it('is dispatched through the assembler on onTakeDamage', () => {
		const { player } = fire({ 'Relic Warden': 1 }, 'onTakeDamage', {
			player: { mats: [relic(1, 'Teapot'), relic(2, 'Keepsake')] }
		});
		expect(player.damageReduction).toBe(4); // 2 unique relics × 2, via the real dispatch
	});
});
