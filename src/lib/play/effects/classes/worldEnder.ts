import { nextId } from '../../rng';
import type { PrivatePlayerState } from '../../types';
import type { ClassAbility, ClassDecisions } from './types';

// Queen — "When this spirit awakens, every player must turn one of their awakened spirits
// face-down (their choice)." (Michael, 2026-11-18.) No VP. When the Queen spirit itself awakens,
// every player (the owner too) gets a card that lists their awakened spirits; the Queen that just
// awakened is not on her owner's card. A player with no awakened spirit to choose gets no card.
// The card holds the Awakening Phase for that player; unanswered at a forced advance, it turns
// the lowest-cost awakened spirit face-down (`expiryOptionId`). A spirit turned face-down keeps
// its augment and can be awakened again later for its normal cost.

export const QUEEN_UNAWAKEN_KIND = 'queenUnawaken';

/** The spirits a player may turn face-down for the Queen (`exceptSlot`: the Queen herself). */
function unawakenChoices(player: PrivatePlayerState, exceptSlot?: number) {
	return (player.spirits ?? []).filter((s) => !s.isFaceDown && s.slotIndex !== exceptSlot);
}

export const ability: ClassAbility[] = [
	{
		on: 'awakening',
		run(ctx) {
			const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
			if (slot == null) return;
			const queen = ctx.player.spirits.find((s) => s.slotIndex === slot);
			if (!queen || (queen.classes?.['Queen'] ?? 0) <= 0) return;
			ctx.log.push(`Queen: ${queen.name} awakened — every player must turn one awakened spirit face-down.`);
			for (const seat of ctx.state.activeSeats) {
				const target = ctx.state.players[seat];
				if (!target) continue;
				const choices = unawakenChoices(target, seat === ctx.seat ? slot : undefined);
				if (choices.length === 0) continue;
				// Unanswered: the lowest-cost awakened spirit (the highest slot among equals).
				const fallback = [...choices].sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0) || b.slotIndex - a.slotIndex)[0];
				target.pendingDecisions = [...(target.pendingDecisions ?? [])];
				target.pendingDecisions.push({
					id: nextId(ctx.state.rng, 'dec'),
					source: 'class',
					kind: QUEEN_UNAWAKEN_KIND,
					prompt: `Queen (${queen.name} awakened): you must turn one of your awakened spirits face-down. It stops counting for its classes until you awaken it again.`,
					options: choices.map((s) => ({ id: `slot:${s.slotIndex}`, label: `Turn ${s.name} (slot ${s.slotIndex}) face-down` })),
					expiryOptionId: `slot:${fallback.slotIndex}`
				});
				// The card is work in the Awakening Phase even for a seat that had finished.
				target.phaseReady = false;
			}
		}
	}
];

export const decisions: ClassDecisions = {
	[QUEEN_UNAWAKEN_KIND](ctx, optionId) {
		const slot = Number(optionId.replace(/^slot:/, ''));
		const spirit = ctx.player.spirits.find((s) => s.slotIndex === slot && !s.isFaceDown);
		if (!spirit) {
			ctx.log.push('Queen: that spirit is not awake.');
			return;
		}
		spirit.isFaceDown = true;
		ctx.log.push(`Queen: ${spirit.name} was turned face-down.`);
	}
};
