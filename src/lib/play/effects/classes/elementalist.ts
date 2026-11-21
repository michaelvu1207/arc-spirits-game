import { ruleValue } from '../../rules';
import { runAction } from '../actions';
import type { EffectContext } from '../context';
import type { ClassAbility } from './types';

// Elementalist — dice QUALITY. An upgrade raises the player's lowest Basic or Enchanted die one
// step (Basic → Enchanted → Exalted; never to Arcane).
//
// Default rule: super-linear (2/3/4/5 → upgrade 1/2/5/10 times) per Rest; a lone Elementalist
// does nothing.
//
// Rule `elementalistMethods` (Michael, 2026-11-20): "upgrade an attack dice twice" per action, and
// each breakpoint adds one action:
//   (2) defeat a monster (not the permanent one, the Abyss Lurker)
//   (3) Rest
//   (4) Cultivate
//   (5) a Spirit World Summon (fired by the runtime where the summon is granted, see
//       `elementalistSpiritWorldSummon` in runtime.ts)
// Ten Basic dice are ten Exalted dice after ten such actions (20 upgrades).

/** The old ladder: upgrades per Rest at 2 / 3 / 4 / 5 Elementalists. */
const REST_LADDER: [count: number, times: number][] = [
	[5, 10],
	[4, 5],
	[3, 2],
	[2, 1]
];

/** Under `elementalistMethods`: the Elementalist count at which each action starts to upgrade. */
export const ELEMENTALIST_METHOD_AT = { monsterKill: 2, rest: 3, cultivate: 4, spiritWorldSummon: 5 } as const;
/** Under `elementalistMethods`: upgrades per action. */
export const ELEMENTALIST_UPGRADES_PER_ACTION = 2;

/** The upgrades for the action `method`, if the rule is on and the player has enough Elementalists. */
function upgradeFor(ctx: EffectContext, method: keyof typeof ELEMENTALIST_METHOD_AT): void {
	if (!ruleValue(ctx.catalog, 'elementalistMethods')) return;
	if (ctx.traitCount < ELEMENTALIST_METHOD_AT[method]) return;
	runAction(ctx, { kind: 'upgradeDice', times: ELEMENTALIST_UPGRADES_PER_ACTION });
}

export const ability: ClassAbility[] = [
	{
		on: 'onRest',
		run(ctx) {
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
			if (!ctx.combat?.killed || ctx.combat.permanent) return;
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
