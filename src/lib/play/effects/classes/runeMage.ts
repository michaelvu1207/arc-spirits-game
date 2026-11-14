import { runAction } from '../actions';
import { nextId } from '../../rng';
import { ruleValue } from '../../rules';
import type { DiceTier } from '../../types';
import type { ClassAbility, ClassDecisions } from './types';

// Mage — "In the Awakening Phase, you may discard a rune to gain an Enchanted Attack."
//
// A bespoke `awakeningPhase` handler offers the opt-in card only while the player holds a
// rune (`player.mats` entry with `type === 'rune'` and `hasRune`). One rune, one die, once per
// Awakening Phase. (The earlier Rune Mage text also traded a relic for an Exalted Attack and
// re-offered the card; that part is not in the November 2026 catalog.)
//
// Rule `sunRework` (default false): "On this spirit's Awakening, gain 2 Exalted Attack Dice. In
// the Awakening Phase, you may discard a rune to gain 1 Exalted Attack Dice." The same card, for
// an Exalted die; the 2 dice come once, when the awakened spirit itself is a Mage.

type EffectContextLike = Parameters<ClassDecisions[string]>[0];

/** Mage's on-awakening Exalted dice under `sunRework`. */
export const MAGE_SUN_AWAKEN_DICE = 2;

const heldRunes = (player: EffectContextLike['player']) =>
	player.mats.filter((slot) => slot.type === 'rune' && slot.hasRune);

/** The die tier the trade gives (Enchanted; Exalted under `sunRework`). */
function tradeTier(ctx: Pick<EffectContextLike, 'catalog'>): DiceTier {
	return ruleValue(ctx.catalog, 'sunRework') ? 'exalted' : 'enchanted';
}

/** One option per distinct held rune (so the owner chooses which one), else a single "rune". */
function tradeOptions(player: EffectContextLike['player'], die: string) {
	const runes = heldRunes(player);
	if (runes.length === 0) return null;
	const identities = new Set(runes.map((slot) => slot.id ?? slot.name ?? 'rune'));
	const options: { id: string; label: string }[] = [];
	if (identities.size > 1) {
		const seen = new Set<string>();
		for (const rune of runes) {
			const key = rune.id ?? rune.name ?? 'rune';
			if (seen.has(key)) continue;
			seen.add(key);
			options.push({
				id: `rune:${rune.slotIndex}`,
				label: `Discard ${rune.name ?? 'rune'} → 1 ${die} Attack`
			});
		}
	} else {
		options.push({ id: 'rune', label: `Discard rune → 1 ${die} Attack` });
	}
	options.push({ id: 'no', label: 'No' });
	return options;
}

export const ability: ClassAbility[] = [
	{
		on: 'awakeningPhase',
		run(ctx) {
			const { player, log, state } = ctx;
			const die = tradeTier(ctx) === 'exalted' ? 'Exalted' : 'Enchanted';
			const options = tradeOptions(player, die);
			if (!options) {
				log.push('Mage: no rune to discard.');
				return;
			}
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: 'runeMageTrade',
				prompt: `Awakening: you may discard a rune to gain an ${die} Attack.`,
				options
			});
			log.push(`Decision: Awakening — discard a rune for 1 ${die} Attack?`);
		}
	},
	{
		on: 'awakening',
		run(ctx) {
			if (!ruleValue(ctx.catalog, 'sunRework')) return;
			const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
			const awakened = slot == null ? undefined : ctx.player.spirits.find((s) => s.slotIndex === slot);
			if (!awakened || (awakened.classes?.['Mage'] ?? 0) <= 0) return;
			runAction(ctx, { kind: 'gainAttackDice', tier: 'exalted', amount: MAGE_SUN_AWAKEN_DICE });
		}
	}
];

export const decisions: ClassDecisions = {
	runeMageTrade(ctx, optionId) {
		const [kind, rawSlotIndex] = optionId.split(':');
		if (kind !== 'rune') return; // "no" / unknown
		const slotIndex = rawSlotIndex === undefined ? undefined : Number(rawSlotIndex);
		const slot = ctx.player.mats.find(
			(r) => r.type === 'rune' && r.hasRune && (slotIndex === undefined || r.slotIndex === slotIndex)
		);
		if (!slot) return; // stale card
		slot.hasRune = false;
		ctx.log.push(`Discarded ${slot.name ?? 'a rune'}.`);
		runAction(ctx, { kind: 'gainAttackDice', tier: tradeTier(ctx), amount: 1 });
	}
};
