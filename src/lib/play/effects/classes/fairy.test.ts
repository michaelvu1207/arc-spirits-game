/**
 * Fairy — bespoke `awakening` handler.
 *
 * DB-intended behavior (source of truth):
 *   - When Awakened, gain 1 Exalted Attack die for every spirit matching this
 *     Fairy's origin (a spirit counts if any of its origins overlaps the Fairy's).
 *   - Gain 3 Initiative.
 *
 * Per-awakening + origin-aware: the grant only fires when the spirit that just
 * awakened (`ctx.command.slotIndex`) is itself a Fairy. Exalted dice land in the
 * attack-dice pool (flat cap of 10).
 *
 * UX channel: passive combat numbers — "Gained N exalted attack dice." and
 * "Gained 3 initiative." log lines plus the mechanical attackDice / initiative.
 */

import { describe, it, expect } from 'vitest';
import { fire, makePlayer, spirit, ctxFor } from './testHelpers';
import { ability } from './fairy';

describe('Fairy', () => {
	it('hangs a single awakening handler', () => {
		expect(ability).toHaveLength(1);
		expect(ability[0].on).toBe('awakening');
		expect(typeof ability[0].run).toBe('function');
	});

	it('gains 1 exalted die per origin-matching spirit and +3 initiative on awakening', () => {
		// Fairy in slot 1 (origin Floral). Two other spirits share the Floral origin,
		// one does not. Matching count includes the Fairy itself = 3.
		const fairy = spirit(1, { 'Fairy': 1 }, { origins: { Floral: 1 } });
		const ally1 = spirit(2, { Fighter: 1 }, { origins: { Floral: 1 } });
		const ally2 = spirit(3, { Healer: 1 }, { origins: { Floral: 1 } });
		const other = spirit(4, { Fighter: 1 }, { origins: { Tidal: 1 } });
		const { player } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits: [fairy, ally1, ally2, other] },
			command: { slotIndex: 1 }
		});
		expect(player.attackDice).toHaveLength(3);
		expect(player.attackDice.every((d) => d.tier === 'exalted')).toBe(true);
		expect(player.initiative).toBe(3);
	});

	it('surfaces both halves as attributed log lines (no silent no-op)', () => {
		const fairy = spirit(1, { 'Fairy': 1 }, { origins: { Floral: 1 } });
		const ally = spirit(2, { Fighter: 1 }, { origins: { Floral: 1 } });
		const { log } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits: [fairy, ally] },
			command: { slotIndex: 1 }
		});
		expect(log.some((l) => l.includes('Gained 2 exalted attack dice.'))).toBe(true);
		expect(log.some((l) => l.includes('Gained 3 initiative.'))).toBe(true);
	});

	it('counts only spirits whose origin overlaps the Fairy', () => {
		// Fairy is Floral; only itself matches (the other two are Tidal/Lantern).
		const fairy = spirit(1, { 'Fairy': 1 }, { origins: { Floral: 1 } });
		const t = spirit(2, { Fighter: 1 }, { origins: { Tidal: 1 } });
		const l = spirit(3, { Healer: 1 }, { origins: { Lantern: 1 } });
		const { player } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits: [fairy, t, l] },
			command: { slotIndex: 1 }
		});
		expect(player.attackDice).toHaveLength(1);
		expect(player.initiative).toBe(3);
	});

	it('matches a multi-origin spirit if ANY of its origins overlap', () => {
		const fairy = spirit(1, { 'Fairy': 1 }, { origins: { Floral: 1 } });
		const multi = spirit(2, { Fighter: 1 }, { origins: { Tidal: 1, Floral: 1 } });
		const { player } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits: [fairy, multi] },
			command: { slotIndex: 1 }
		});
		expect(player.attackDice).toHaveLength(2); // fairy + multi
	});

	it('still grants the +3 initiative even when the Fairy has no origin (no dice)', () => {
		// No origins on the Fairy => no origin matches => no dice, but the spec's
		// "+3 Initiative" is unconditional and must still apply in that degenerate case.
		const fairy = spirit(1, { 'Fairy': 1 }, { origins: {} });
		const { player } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits: [fairy] },
			command: { slotIndex: 1 }
		});
		expect(player.attackDice).toHaveLength(0); // no origin → no dice
		expect(player.initiative).toBe(3); // …but the +3 initiative always lands
	});

	it('does nothing when the awakened spirit (slotIndex) is not a Fairy', () => {
		const notFairy = spirit(1, { Fighter: 1 }, { origins: { Floral: 1 } });
		const fairyElsewhere = spirit(2, { 'Fairy': 1 }, { origins: { Floral: 1 } });
		const { player, log } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits: [notFairy, fairyElsewhere] },
			command: { slotIndex: 1 }
		});
		expect(player.attackDice).toHaveLength(0);
		expect(player.initiative).toBe(0);
		expect(log.some((l) => l.includes('attack dice') || l.includes('initiative'))).toBe(false);
	});

	it('does nothing when no command.slotIndex is threaded', () => {
		const fairy = spirit(1, { 'Fairy': 1 }, { origins: { Floral: 1 } });
		const { player } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits: [fairy] }
		});
		expect(player.attackDice).toHaveLength(0);
		expect(player.initiative).toBe(0);
	});

	it('caps the exalted dice grant at the flat attack-dice cap of 10', () => {
		// 12 Floral spirits (Fairy + 11) would request 12 dice; the pool caps at 10.
		const spirits = [spirit(1, { 'Fairy': 1 }, { origins: { Floral: 1 } })];
		for (let i = 2; i <= 12; i += 1) {
			spirits.push(spirit(i, { Fighter: 1 }, { origins: { Floral: 1 } }));
		}
		const { player } = fire({ 'Fairy': 1 }, 'awakening', {
			player: { spirits },
			command: { slotIndex: 1 }
		});
		expect(player.attackDice).toHaveLength(10);
		expect(player.initiative).toBe(3);
	});

	it('handler unit test: mutates ctx.player directly via ctxFor', () => {
		const fairy = spirit(1, { 'Fairy': 1 }, { origins: { Floral: 1 } });
		const ally = spirit(2, { Fighter: 1 }, { origins: { Floral: 1 } });
		const player = makePlayer({ spirits: [fairy, ally] });
		const ctx = ctxFor(player, { trigger: 'awakening', command: { slotIndex: 1 } });
		ability[0].run!(ctx);
		expect(player.attackDice).toHaveLength(2);
		expect(player.attackDice.every((d) => d.tier === 'exalted')).toBe(true);
		expect(player.initiative).toBe(3);
	});
});
