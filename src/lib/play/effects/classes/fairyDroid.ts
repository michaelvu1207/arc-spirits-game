import { nextId } from '../../rng';
import type { ClassAbility, ClassHandler } from './types';

// Runebound Vessel — "You may place unlimited Spirit Augments on this spirit. On awaken,
// gain any 2 augments for this spirit." Unlimited capacity is modeled by
// augmentCapacityForSpirit; the awaken grant gives 2 Spirit Augments BOUND to this
// spirit, so they can only be placed on the Runebound Vessel (not any spirit). The owner
// still picks WHICH Spirit Augment (one of the six classes) for each at placement.
const fairyDroidAwakening: ClassHandler = (ctx) => {
	const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
	if (slot == null) return;
	const droid = ctx.player.spirits.find((s) => s.slotIndex === slot);
	if (!droid || (droid.classes?.['Runebound Vessel'] ?? 0) <= 0) return;
	ctx.player.unplacedAugments ??= [];
	for (let i = 0; i < 2; i += 1) {
		ctx.player.unplacedAugments.push({
			runeId: nextId(ctx.state.rng, 'aug'),
			name: 'Spirit Augment',
			boundSlotIndex: slot,
			boundLabel: droid.name
		});
	}
	ctx.log.push(`Runebound Vessel: gained 2 Spirit Augments for ${droid.name}.`);
};

export const ability: ClassAbility[] = [{ on: 'awakening', run: fairyDroidAwakening }];
