import { describe, it, expect } from 'vitest';
import { fire, makePlayer, ctxFor, spirit } from './testHelpers';
import { ALCHEMIST_AUGMENT_KIND, decisions } from './arcMage';
import { applyTrigger } from '../apply';
import type { AttackDie, PrivatePlayerState } from '../../types';

// Arcane Alchemist — "When you Cultivate, you may convert 1 of your Spirit Augments into 1 Arcane
// Attack Dice (once a round)." A card lists every placed augment ("No" last); the chosen one is
// removed from its spirit and gives 1 Arcane die. At most one conversion a round.

const AUGMENT = { runeId: 'aug-fighter', spiritId: 's2', spiritSlotIndex: 2, className: 'Fighter', classId: 'c-fighter' };

function alchemist(overrides: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
	return makePlayer({
		spirits: [spirit(1, { 'Arcane Alchemist': 1 }), spirit(2, {}, { name: 'Carrier' })],
		spiritAugmentAttachments: [{ ...AUGMENT }],
		...overrides
	});
}

function basicDice(n: number): AttackDie[] {
	return Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as const }));
}

describe('Arcane Alchemist', () => {
	it('offers the opt-in conversion card on cultivate when a Spirit Augment is placed', () => {
		const { player, log } = fire({ 'Arcane Alchemist': 1 }, 'onCultivate', {
			player: { spirits: alchemist().spirits, spiritAugmentAttachments: [{ ...AUGMENT }] }
		});
		expect(player.pendingDecisions).toHaveLength(1);
		const dec = player.pendingDecisions[0];
		expect(dec.kind).toBe(ALCHEMIST_AUGMENT_KIND);
		expect(dec.options.map((o) => o.id)).toEqual(['aug:2:aug-fighter', 'no']);
		expect(log.some((l) => l.includes('convert a Spirit Augment'))).toBe(true);
	});

	it('does NOT offer a card without a placed augment, however many dice are held', () => {
		const { player } = fire({ 'Arcane Alchemist': 1 }, 'onCultivate', {
			player: { attackDice: basicDice(8) }
		});
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('does not offer the card on a non-cultivate trigger', () => {
		const { player } = fire({ 'Arcane Alchemist': 1 }, 'awakening', {
			player: { spirits: alchemist().spirits, spiritAugmentAttachments: [{ ...AUGMENT }] }
		});
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('converting removes the chosen augment and gives 1 Arcane die (other dice untouched)', () => {
		const player = alchemist({ attackDice: [{ instanceId: 'x', tier: 'exalted' }] });
		const ctx = ctxFor(player);
		ctx.state.round = 2;
		decisions[ALCHEMIST_AUGMENT_KIND](ctx, 'aug:2:aug-fighter');
		expect(player.spiritAugmentAttachments).toEqual([]);
		expect(player.attackDice.map((d) => d.tier).sort()).toEqual(['arcane', 'exalted']);
		expect(ctx.log).toContain('Arcane Alchemist: converted the Fighter augment into 1 Arcane Attack Dice.');
	});

	it('No does nothing (opt-out)', () => {
		const player = alchemist();
		const ctx = ctxFor(player);
		ctx.state.round = 2;
		decisions[ALCHEMIST_AUGMENT_KIND](ctx, 'no');
		expect(player.spiritAugmentAttachments).toHaveLength(1);
		expect(player.attackDice).toHaveLength(0);
	});

	it('is once a round: a second conversion in the same round is refused, and no new card comes', () => {
		const player = alchemist({
			spiritAugmentAttachments: [{ ...AUGMENT }, { ...AUGMENT, runeId: 'aug-mage', className: 'Mage', classId: 'c-mage' }]
		});
		const ctx = ctxFor(player, { trigger: 'onCultivate' });
		ctx.state.round = 2;
		decisions[ALCHEMIST_AUGMENT_KIND](ctx, 'aug:2:aug-fighter');
		decisions[ALCHEMIST_AUGMENT_KIND](ctx, 'aug:2:aug-mage');
		expect(player.attackDice).toHaveLength(1);
		expect(player.spiritAugmentAttachments).toHaveLength(1);
		expect(ctx.log).toContain('Arcane Alchemist: already converted an augment this round.');
		applyTrigger(ctx.state, 'Red', 'onCultivate', []);
		expect(player.pendingDecisions).toHaveLength(0);
	});
});
