
import type { ClassAbility } from './types';

// The old Summoner is wired at the summon/discard boundaries in runtime.ts because both halves
// depend on the card's source bag: Spirit World summons may open an Abyss draw, and
// discarded Arcane Abyss spirits grant 4 VP.
//
// Rule switch `summonerCultivate` (rules.ts; default false; Michael, 2026-11-18): on ⇒ the
// Summoner is "When you Cultivate with at least 5 Forest spirits, gain 2 points." and nothing
// else: no Arcane Abyss draw on a Spirit World summon, no points for a discarded Arcane Abyss
// spirit (runtime.ts reads the switch for both). Forest spirits = every spirit you hold with the
// Forest Region origin, awakened or not (origins always count).

export const SUMMONER_FOREST_NEED = 5;
export const SUMMONER_CULTIVATE_VP = 2;

export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		run(ctx) {
			const forest = ctx.player.spirits.filter((s) => (s.origins?.['Forest Region'] ?? 0) > 0).length;
			if (forest < SUMMONER_FOREST_NEED) {
				ctx.log.push(`Summoner: ${forest} Forest spirits (needs ${SUMMONER_FOREST_NEED}) — no points.`);
				return;
			}
			ctx.player.victoryPoints += SUMMONER_CULTIVATE_VP;
			ctx.log.push(`Summoner: Cultivated with ${forest} Forest spirits — gain ${SUMMONER_CULTIVATE_VP} VP.`);
		}
	}
];
