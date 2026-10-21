import type { ClassAbility, ClassHandler } from './types';

/**
 * Relic Warden — "For every unique Relic you hold, reduce incoming damage by 2."
 *
 * Bespoke `onTakeDamage` handler: it counts the UNIQUE relics the player holds
 * (`player.mats` entries with `type === 'relic'`, deduped by `name`) and raises
 * `player.damageReduction` by 2 per unique relic. `takeDamage` later consumes
 * `damageReduction` against the incoming hit, exactly like the declarative
 * `reduceIncomingDamage` action does for Aquamaiden/Firekeeper — so this surfaces
 * as a passive combat number plus a log line.
 *
 * Counting unique relics requires reading `player.mats` (not a fixed amount), so
 * this can't be expressed by the declarative `reduceIncomingDamage` action and is
 * implemented as a `run` handler instead.
 */

/** Count distinct relics held, deduped by name (un-named relics each count once). */
function uniqueRelicCount(runes: { type?: string; name?: string; slotIndex: number }[]): number {
	const seen = new Set<string>();
	for (const slot of runes) {
		if (slot.type !== 'relic') continue;
		// Dedupe by name; fall back to the slot index so an un-named relic still counts.
		const key = slot.name ?? `__slot_${slot.slotIndex}`;
		seen.add(key);
	}
	return seen.size;
}

const reduceByRelics: ClassHandler = (ctx) => {
	const unique = uniqueRelicCount(ctx.player.mats);
	if (unique <= 0) return;
	const amount = unique * 2;
	ctx.player.damageReduction += amount;
	ctx.log.push(
		`Relic Warden: reduced incoming damage by ${amount} (${unique} unique relic${unique === 1 ? '' : 's'}).`
	);
};

export const ability: ClassAbility[] = [{ on: 'onTakeDamage', run: reduceByRelics }];
