import { isRelic } from '../../locationInteractions';
import { elementalistNoRelicUpgrades, elementalistRestLadder, elementalistUpgradeAction, ruleValue } from '../../rules';
import type { PlayCatalog, PrivatePlayerState } from '../../types';
import { runAction } from '../actions';
import type { EffectCombatInfo, EffectContext } from '../context';
import type { ClassAbility } from './types';

// Elementalist — dice QUALITY. An upgrade raises the player's lowest Basic or Enchanted die one
// step (Basic → Enchanted → Exalted; never to Arcane).
//
// Default rule: super-linear (2/3/4/5 → upgrade 1/2/5/10 times) per Rest; a lone Elementalist
// does nothing.
//
// Rule `elementalistMethods` (Michael, 2026-11-20): "upgrade an attack dice twice" per action, and
// each breakpoint adds one action:
//   (2) defeat a monster (the permanent one, the Abyss Lurker, counts too)
//   (3) Rest
//   (4) Cultivate
//   (5) a Spirit World Summon (fired by the runtime where the summon is granted, see
//       `elementalistSpiritWorldSummon` in runtime.ts)
// Ten Basic dice are ten Exalted dice after ten such actions (20 upgrades).
// Rule `elementalistOneUpgrade`: one upgrade per action. Rule `elementalistBigKills` (Michael,
// 2026-11-21): a kill of a Difficulty 2 or 3 card upgrades twice.

/** The old ladder: upgrades per Rest at 2 / 3 / 4 / 5 Elementalists. */
const REST_LADDER: [count: number, times: number][] = [
	[5, 10],
	[4, 5],
	[3, 2],
	[2, 1]
];


/** Whether the player holds a relic (any relic; a used relic tool is gone). */
export function holdsRelic(player: Pick<PrivatePlayerState, 'mats'>): boolean {
	return (player.mats ?? []).some((m) => m.hasRune && isRelic(m));
}

/**
 * Under `elementalistRest1235`: the upgrades one Rest (one Cultivate with the rule
 * `elementalistOnCultivate`; see `elementalistUpgradeAction` in rules.ts) gives a player with `count` Elementalists
 * (1 / 2 / 3 / 5 at 2 / 3 / 4 / 5, or the catalog's `numbers.elementalistRest`).
 * With the rule `elementalist5NeedsRelic` the top step (5) counts only while the player holds a
 * relic; without one, five Elementalists upgrade as four do.
 */
export function elementalistRestUpgrades(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	count: number,
	player: Pick<PrivatePlayerState, 'mats'>
): number {
	// Five Elementalists without a relic: as four do, or the catalog's `numbers.elementalistNoRelic`.
	if (count >= 5 && !holdsRelic(player)) return elementalistNoRelicUpgrades(catalog);
	const capped = Math.min(count, 5);
	// 1 / 2 / 3 / 5 at 2 / 3 / 4 / 5 Elementalists, or the catalog's `numbers.elementalistRest`.
	return capped >= 2 ? elementalistRestLadder(catalog)[capped - 2] : 0;
}

/** Under `elementalistMethods`: the Elementalist count at which each action starts to upgrade. */
export const ELEMENTALIST_METHOD_AT = { monsterKill: 2, rest: 3, cultivate: 4, spiritWorldSummon: 5 } as const;
/** Under `elementalistMethods`: upgrades per action. */
export const ELEMENTALIST_UPGRADES_PER_ACTION = 2;
/** Under `elementalistMethods`: upgrades per action, 1 with the rule `elementalistOneUpgrade`. */
export function elementalistUpgradesPerAction(catalog: Parameters<typeof ruleValue>[0]): number {
	return 1;
}

/** Under `elementalistBigKills`: upgrades for a kill of a Difficulty 2 or 3 card. */
export const ELEMENTALIST_BIG_KILL_UPGRADES = 2;
/**
 * Under `elementalistMethods`: upgrades for a monster kill. With the rule `elementalistBigKills` a
 * Difficulty 2 or 3 card gives two; a Difficulty 1 card and the permanent monster (the Abyss Lurker)
 * give the upgrades of one action.
 */
export function elementalistKillUpgrades(
	catalog: Parameters<typeof ruleValue>[0],
	combat: Pick<EffectCombatInfo, 'monsterDifficulty' | 'monsterPermanent'> | undefined
): number {
	const perAction = elementalistUpgradesPerAction(catalog);
	const big = !combat?.monsterPermanent && (combat?.monsterDifficulty ?? 1) >= 2;
	return big ? Math.max(perAction, ELEMENTALIST_BIG_KILL_UPGRADES) : perAction;
}

/** The upgrades for the action `method`, if the rule is on and the player has enough Elementalists. */
function upgradeFor(ctx: EffectContext, method: keyof typeof ELEMENTALIST_METHOD_AT): void {
	// Rule `elementalistRest1235`: upgrades come from Rest only (the ladder in the onRest ability below).
	return;
}

/** Under `elementalistRest1235`: the upgrades of the ladder for this player, now. */
function ladderUpgrades(ctx: EffectContext): void {
	const times = elementalistRestUpgrades(ctx.catalog, ctx.traitCount, ctx.player);
	if (times) runAction(ctx, { kind: 'upgradeDice', times });
}

export const ability: ClassAbility[] = [
	{
		on: 'onRest',
		run(ctx) {
			if (elementalistUpgradeAction(ctx.catalog) === 'rest') ladderUpgrades(ctx);
			return;
		}
	},
	{
		on: 'onMonsterKill',
		run(ctx) {
			if (!ctx.combat?.killed) return;
			upgradeFor(ctx, 'monsterKill');
		}
	},
	{
		on: 'onCultivate',
		run(ctx) {
			// Rule `elementalistOnCultivate`: the ladder's upgrades come here, not on Rest.
			if (elementalistUpgradeAction(ctx.catalog) === 'cultivate') {
				ladderUpgrades(ctx);
				return;
			}
			upgradeFor(ctx, 'cultivate');
		}
	}
];
