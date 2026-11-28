/**
 * Resolver for the `relicTool` decision card (see `relicTools.ts`). Kept apart from
 * `relicTools.ts` because awakening a spirit fires the `awakening` trigger (`apply.ts`), and
 * `apply.ts` itself imports `relicTools.ts` for the Cultivate origin rewards.
 */

import { applyTrigger } from './apply';
import { runAction } from './actions';
import { RELIC_TOOLS, isHeldRelicTool, relicToolVp } from './relicTools';
import type { ClassDecisions } from './classes/types';

export const decisions: ClassDecisions = {
	relicTool(ctx, optionId) {
		const [choice, rawSlot, relicId, rawSpirit] = optionId.split(':');
		const slot = ctx.player.mats.find((m) => m.slotIndex === Number(rawSlot) && m.id === relicId);
		if (!slot || !isHeldRelicTool(slot)) return; // stale card: the relic is gone
		const tool = RELIC_TOOLS[slot.id!];
		if (choice === 'keep') return;

		if (choice === 'awaken') {
			const spirit = ctx.player.spirits.find((s) => s.slotIndex === Number(rawSpirit));
			if (!spirit || !spirit.isFaceDown) return; // stale: keep the relic
		}

		const vp = relicToolVp(ctx.catalog);
		if (choice === 'vp' && vp <= 0) return; // no VP side in this catalog: keep the relic

		// Either side uses the relic up.
		slot.hasRune = false;
		if ((ctx.player.relics ?? 0) > 0) ctx.player.relics -= 1;

		if (choice === 'vp') {
			runAction(ctx, { kind: 'gainVP', amount: vp });
			ctx.log.push(`${tool.name}: discarded for ${vp} VP.`);
			return;
		}
		switch (tool.effect) {
			case 'strikeFirst':
				ctx.player.strikeFirstCharges = (ctx.player.strikeFirstCharges ?? 0) + 1;
				// Shown at once: the next combat strikes first (resetCombatFlags keeps it while armed).
				ctx.player.alwaysAttackFirst = true;
				ctx.log.push(`${tool.name}: in your next combat you gain the initiative if your side does not have it.`);
				break;
			case 'fullBarrier': {
				const restored = ctx.player.maxBarrier - ctx.player.barrier;
				ctx.player.barrier = ctx.player.maxBarrier;
				ctx.player.brokenBarrier = 0;
				ctx.log.push(`${tool.name}: restored ${restored} barrier (full).`);
				break;
			}
			case 'augment':
				runAction(ctx, { kind: 'gainAugment', amount: 1 });
				ctx.log.push(`${tool.name}: gained 1 Spirit Augment of your choice.`);
				break;
			case 'awaken': {
				const spirit = ctx.player.spirits.find((s) => s.slotIndex === Number(rawSpirit))!;
				spirit.isFaceDown = false;
				ctx.log.push(`${tool.name}: awakened ${spirit.name}.`);
				applyTrigger(ctx.state, ctx.seat, 'awakening', ctx.log, {
					catalog: ctx.catalog,
					command: { type: 'awakenSpirit', slotIndex: spirit.slotIndex }
				});
				break;
			}
		}
	}
};
