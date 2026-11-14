import { nextId } from '../../rng';
import { relicOptions } from '../../locationInteractions';
import { RELIC_TOOLS } from '../relicTools';
import { ruleValue } from '../../rules';
import type { ClassAbility, ClassDecisions } from './types';

// Cultivator — the max barrier engine, super-linear ladder (2/3/4/5 → +1/+2/+5/+10):
// a 5-Cultivator pool MAXES max barrier (cap 10) in a single Cultivate. A lone
// Cultivator grants nothing. gainMaxBarrier is capped at 10 and raises capacity
// without restoring current barrier.
export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		breakpoints: [
			{ count: 2, actions: [{ kind: 'gainMaxBarrier', amount: 1 }] },
			{ count: 3, actions: [{ kind: 'gainMaxBarrier', amount: 2 }] },
			{ count: 4, actions: [{ kind: 'gainMaxBarrier', amount: 5 }] },
			{ count: 5, actions: [{ kind: 'gainMaxBarrier', amount: 10 }] }
		]
	},
	{
		on: 'onCultivate',
		run(ctx) {
			if (ctx.traitCount < 5) return;
			// Rule switch `cultivatorRelicOnce` (rules.ts; default false). On (proposal C6): the relic
			// only the first time per game. The flag is written only under the rule.
			if (ruleValue(ctx.catalog, 'cultivatorRelicOnce')) {
				if (ctx.player.cultivatorRelicGained) return;
				ctx.player.cultivatorRelicGained = true;
			}
			ctx.player.pendingDecisions.push({
				id: nextId(ctx.state.rng, 'dec'),
				source: 'class',
				kind: 'cultivatorRelic',
				prompt: 'Cultivator: choose any relic.',
				options: relicChoiceOptions()
			});
			ctx.log.push('Cultivator: choose 1 relic.');
		}
	}
];

/** The "relic of your choice" card's options (option id = index into `relicOptions()`). */
export function relicChoiceOptions(): { id: string; label: string }[] {
	return relicOptions().map((r, index) => ({ id: String(index), label: r.name }));
}

/** Grant the relic picked on a "relic of your choice" card (Cultivator (5); Cleric under `sunRework`). */
export function gainChosenRelic(ctx: Parameters<ClassDecisions[string]>[0], optionId: string, source: string): void {
	const relics = relicOptions();
	const index = Math.max(0, Math.min(relics.length - 1, Number(optionId) || 0));
	const relic = relics[index];
	ctx.player.mats.push({
		slotIndex: ctx.player.mats.length + 1,
		hasRune: true,
		id: relic.runeId,
		name: relic.name,
		type: 'relic',
		special: true,
		// A named relic with a tool text (Firecracker, Flower, Diamond, Cleansing Teapot)
		// is a one-time relic tool; it stays a relic instead of becoming a base rune.
		...(RELIC_TOOLS[relic.runeId] ? { relicTool: true } : {})
	});
	ctx.player.relics += 1;
	ctx.log.push(`${source}: gained ${relic.name}.`);
}

export const decisions: ClassDecisions = {
	cultivatorRelic(ctx, optionId) {
		gainChosenRelic(ctx, optionId, 'Cultivator');
	}
};
