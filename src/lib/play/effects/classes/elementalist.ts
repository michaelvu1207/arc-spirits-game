import { isRelic } from '../../locationInteractions';
import { ruleValue } from '../../rules';
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

/** Rule `elementalistRest1235` (Michael, 2026-11-22): upgrades per Rest at 2 / 3 / 4 / 5 Elementalists. */
const REST_LADDER_1235: [count: number, times: number][] = [
	[5, 5],
	[4, 3],
	[3, 2],
	[2, 1]
];

/** Whether the player holds a relic (any relic; a used relic tool is gone). */
export function holdsRelic(player: Pick<PrivatePlayerState, 'mats'>): boolean {
	return (player.mats ?? []).some((m) => m.hasRune && isRelic(m));
}

/**
 * Under `elementalistRest1235`: the upgrades one Rest gives a player with `count` Elementalists.
 * With the rule `elementalist5NeedsRelic` the top step (5) counts only while the player holds a
 * relic; without one, five Elementalists upgrade as four do.
 */
export function elementalistRestUpgrades(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	count: number,
	player: Pick<PrivatePlayerState, 'mats'>
): number {
	const capped = count >= 5 && ruleValue(catalog, 'elementalist5NeedsRelic') && !holdsRelic(player) ? 4 : count;
	return REST_LADDER_1235.find(([at]) => capped >= at)?.[1] ?? 0;
}

/** Under `elementalistMethods`: the Elementalist count at which each action starts to upgrade. */
export const ELEMENTALIST_METHOD_AT = { monsterKill: 2, rest: 3, cultivate: 4, spiritWorldSummon: 5 } as const;
/** Under `elementalistMethods`: upgrades per action. */
export const ELEMENTALIST_UPGRADES_PER_ACTION = 2;
/** Under `elementalistMethods`: upgrades per action, 1 with the rule `elementalistOneUpgrade`. */
export function elementalistUpgradesPerAction(catalog: Parameters<typeof ruleValue>[0]): number {
	return ruleValue(catalog, 'elementalistOneUpgrade') ? 1 : ELEMENTALIST_UPGRADES_PER_ACTION;
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
	if (!ruleValue(catalog, 'elementalistBigKills')) return perAction;
	const big = !combat?.monsterPermanent && (combat?.monsterDifficulty ?? 1) >= 2;
	return big ? Math.max(perAction, ELEMENTALIST_BIG_KILL_UPGRADES) : perAction;
}

/** The upgrades for the action `method`, if the rule is on and the player has enough Elementalists. */
function upgradeFor(ctx: EffectContext, method: keyof typeof ELEMENTALIST_METHOD_AT): void {
	if (!ruleValue(ctx.catalog, 'elementalistMethods')) return;
	// Rule `elementalistRest1235`: upgrades come from Rest only (the ladder in the onRest ability below).
	if (ruleValue(ctx.catalog, 'elementalistRest1235')) return;
	if (ctx.traitCount < ELEMENTALIST_METHOD_AT[method]) return;
	// Rule `arcaneBlood` (Michael, 2026-11-21): a kill upgrades nothing by itself; Elementalist (2)
	// upgrades once per Arcane Blood taken in place of the kill's rewards (runtime.ts, `gainArcaneBlood`).
	if (method === 'monsterKill' && ruleValue(ctx.catalog, 'arcaneBlood')) return;
	const times = method === 'monsterKill' ? elementalistKillUpgrades(ctx.catalog, ctx.combat) : elementalistUpgradesPerAction(ctx.catalog);
	runAction(ctx, { kind: 'upgradeDice', times });
}

export const ability: ClassAbility[] = [
	{
		on: 'onRest',
		run(ctx) {
			if (ruleValue(ctx.catalog, 'elementalistRest1235')) {
				const times = elementalistRestUpgrades(ctx.catalog, ctx.traitCount, ctx.player);
				if (times) runAction(ctx, { kind: 'upgradeDice', times });
				return;
			}
			if (ruleValue(ctx.catalog, 'elementalistMethods')) {
				upgradeFor(ctx, 'rest');
				return;
			}
			const times = REST_LADDER.find(([count]) => ctx.traitCount >= count)?.[1];
			if (times) runAction(ctx, { kind: 'upgradeDice', times });
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
			upgradeFor(ctx, 'cultivate');
		}
	}
];
