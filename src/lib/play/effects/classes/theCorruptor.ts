import { bagForSpiritCost, shuffleBag, SPIRIT_WORLD_BAG } from '../../bags';
import { STATUS_LADDER, type PlaySpirit } from '../../types';
import { isHeroSpirit } from '../heroes';
import type { ClassAbility, ClassHandler } from './types';

// Corruptor — "Set your status to Fallen (this is not a corruption). Replace all Spirit World
// spirits with a random Arcane Abyss Spirit."
//
// It runs when the Corruptor spirit itself awakens (`ctx.command.slotIndex`):
//  - status goes straight to Fallen (a status change, NOT a corruption: no barrier restore and
//    no spirit sacrifice; the round's "became …" flags are set as for any status rise);
//  - every Spirit World spirit (Spirit World bag, not a Hero) goes back into the Spirit World
//    bag and its slot takes the top card of the Arcane Abyss bag, face-down like any Abyss
//    draw. Augments on a replaced spirit leave with it. If the Abyss bag is empty, the slot
//    stays empty.
// Corruptor gives no initiative and no Max Barrier. (The old The Corruptor Benefits claim — an
// Arcane die after a corruption — is not in the November 2026 text and is gone.)

const FALLEN = STATUS_LADDER.length - 1;

const corruptorAwakening: ClassHandler = (ctx) => {
	const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
	if (slot == null) return;
	const self = ctx.player.spirits.find((s) => s.slotIndex === slot);
	if (!self || (self.classes?.['Corruptor'] ?? 0) <= 0) return;
	const { player, state, log } = ctx;

	const oldStatus = player.statusLevel;
	if (oldStatus < FALLEN) {
		player.statusLevel = FALLEN;
		player.statusToken = STATUS_LADDER[FALLEN];
		player.corruptedThisRound = true;
		if (oldStatus < 1) player.becameTaintedThisRound = true;
		if (oldStatus < 2) player.becameCorruptThisRound = true;
		player.becameFallenThisRound = true;
		log.push('Corruptor: status drops to Fallen.');
	}
	const worldBag = state.bags?.hexSpirits;
	const abyssBag = state.bags?.abyssFallen;
	if (!worldBag || !abyssBag) return;
	const replaced: string[] = [];
	const next: PlaySpirit[] = [];
	for (const spirit of player.spirits) {
		const fromWorld =
			spirit.slotIndex !== slot &&
			bagForSpiritCost(spirit.cost) === SPIRIT_WORLD_BAG &&
			!isHeroSpirit(spirit, ctx.catalog);
		if (!fromWorld) {
			next.push(spirit);
			continue;
		}
		worldBag.contents.push({
			guid: `corruptor-${state.round ?? 0}-${ctx.seat}-${spirit.slotIndex}-${spirit.id}`,
			id: spirit.id,
			name: spirit.name,
			cost: spirit.cost
		});
		player.spiritAugmentAttachments = (player.spiritAugmentAttachments ?? []).filter(
			(a) => a.spiritSlotIndex !== spirit.slotIndex
		);
		const drawn = abyssBag.contents.shift();
		const card = drawn?.id ? ctx.catalog.spirits.find((s) => s.id === drawn.id) : undefined;
		if (drawn?.id) {
			next.push({
				slotIndex: spirit.slotIndex,
				id: drawn.id,
				name: card?.name ?? drawn.name,
				cost: card?.cost ?? drawn.cost ?? 0,
				classes: card?.classes ?? {},
				origins: card?.origins ?? {},
				isFaceDown: true
			});
			replaced.push(`${spirit.name} → ${card?.name ?? drawn.name}`);
		} else {
			replaced.push(`${spirit.name} → (Abyss bag empty)`);
		}
	}
	if (replaced.length === 0) return;
	player.spirits = next;
	shuffleBag(worldBag.contents, state.rng);
	worldBag.count = worldBag.contents.length;
	abyssBag.count = abyssBag.contents.length;
	log.push(`Corruptor: replaced Spirit World spirits — ${replaced.join(', ')}.`);
};

export const ability: ClassAbility[] = [{ on: 'awakening', run: corruptorAwakening }];
