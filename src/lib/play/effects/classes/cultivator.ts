import { nextId } from '../../rng';
import { relicOptions } from '../../locationInteractions';
import { RELIC_TOOLS } from '../relicTools';
import type { ClassAbility, ClassDecisions } from './types';

// Cultivator — the max barrier engine: on Cultivate, 2 / 3 / 4 / 5 Cultivators give
// 1 / 2 / 3 / 5 Max Barrier. 5 Cultivators also give 1 relic of your choice, the first time only
// (once per game). A lone Cultivator grants nothing. gainMaxBarrier is capped at 10.
export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		breakpoints: [
			{ count: 2, actions: [{ kind: 'gainMaxBarrier', amount: 1 }] },
			{ count: 3, actions: [{ kind: 'gainMaxBarrier', amount: 2 }] },
			{ count: 4, actions: [{ kind: 'gainMaxBarrier', amount: 3 }] },
			{ count: 5, actions: [{ kind: 'gainMaxBarrier', amount: 5 }] }
		]
	},
	{
		on: 'onCultivate',
		run(ctx) {
			if (ctx.traitCount < 5) return;
			// The relic only the first time per game.
			if (ctx.player.cultivatorRelicGained) return;
			ctx.player.cultivatorRelicGained = true;
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

/** Grant the relic picked on a "relic of your choice" card (Cultivator (5); Cleric). */
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
