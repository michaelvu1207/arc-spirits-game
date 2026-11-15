/**
 * The origin reward of a Cultivate under rule `cultivateRuneOrRelic` (Michael, 2026-11-14): one
 * reward per origin and per Cultivate. 3+ spirits of the origin → its rune. 5+ spirits → its rune,
 * or the origin's relic instead (the relic one time per player). The choice is a decision card
 * (`originCultivate`); with no relic to choose, the rune is given at once and no card is made.
 *
 * Option ids: `relic|<origin>|<n>` and `rune|<origin>|<n>`, n = the runes of the rune option (2 when
 * doubled). A card that is not answered when the Benefits step starts (or, for a later Cultivate,
 * when Cleanup starts) takes the relic. Two Cultivates in one round make two cards; the relic is
 * one time, so the second "relic" answer gives the runes.
 */

import { nextId } from '../rng';
import { originRuneForName } from '../locationInteractions';
import { ORIGIN_REWARDS, RELIC_TOOLS, grantRelicTool, spiritsByOrigin } from './relicTools';
import type { PrivatePlayerState, PublicGameState } from '../types';
import type { ClassDecisions } from './classes/types';

export const ORIGIN_CULTIVATE_KIND = 'originCultivate';

/** Put `count` runes of the origin on the player's mat (the Cultivate rune reward). */
export function gainOriginRunes(
	player: PrivatePlayerState,
	origin: string,
	count: number,
	log: string[]
): void {
	const rune = originRuneForName(origin);
	if (!rune) return;
	for (let i = 0; i < count; i += 1) {
		player.mats.push({
			slotIndex: player.mats.length + 1,
			hasRune: true,
			id: rune.runeId,
			name: rune.name,
			type: rune.type,
			originId: rune.originId ?? undefined,
			classId: rune.classId ?? undefined,
			special: rune.special
		});
	}
	const spirits = spiritsByOrigin(player.spirits)[origin] ?? 0;
	log.push(`Cultivated ${count} ${rune.name}${count === 1 ? '' : 's'} (${spirits} ${origin} spirits).`);
}

/** The card "the origin's relic, or its rune(s)" for one Cultivate at 5+ spirits. */
export function offerOriginCultivateChoice(
	state: PublicGameState,
	player: PrivatePlayerState,
	origin: string,
	runeCount: number,
	log: string[]
): void {
	const reward = ORIGIN_REWARDS[origin];
	const tool = reward ? RELIC_TOOLS[reward.relicId] : undefined;
	const rune = originRuneForName(origin);
	if (!tool || !rune) {
		gainOriginRunes(player, origin, runeCount, log);
		return;
	}
	const spirits = spiritsByOrigin(player.spirits)[origin] ?? 0;
	player.pendingDecisions.push({
		id: nextId(state.rng, 'dec'),
		source: 'class',
		kind: ORIGIN_CULTIVATE_KIND,
		prompt: `Cultivate with ${spirits} ${origin} spirits: take one reward.`,
		options: [
			{ id: `relic|${origin}|${runeCount}`, label: `The ${tool.name} relic (one time)` },
			{ id: `rune|${origin}|${runeCount}`, label: `${runeCount} ${rune.name}${runeCount === 1 ? '' : 's'}` }
		],
		sourceLabel: `Cultivate: ${origin}`,
		expiresAt: 'benefits',
		expiryOptionId: `relic|${origin}|${runeCount}`
	});
	log.push(`Decision: ${tool.name} relic or ${runeCount} ${rune.name}${runeCount === 1 ? '' : 's'}.`);
}

export const decisions: ClassDecisions = {
	originCultivate(ctx, optionId) {
		const [what, origin, count] = optionId.split('|');
		const reward = ORIGIN_REWARDS[origin];
		if (!reward) return;
		const { player, log } = ctx;
		const gained = (player.originRelicsGained ??= []);
		if (what === 'relic' && !gained.includes(origin)) {
			gained.push(origin);
			grantRelicTool(player, reward.relicId, log);
			return;
		}
		// The rune was chosen, or the relic was already taken through another card of this round.
		gainOriginRunes(player, origin, Number(count) === 2 ? 2 : 1, log);
	}
};
