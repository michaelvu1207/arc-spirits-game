import { LOCATIONS } from '../../locations';
import { ruleValue } from '../../rules';
import type { NavigationDestination, SeatColor } from '../../types';
import type { EffectContext } from '../context';
import type { ClassAbility, ClassDecisions } from './types';

// Spellblade — redirect after Navigation Reveal and always attack first.
export const ability: ClassAbility[] = [
	{
		on: 'onNavigate',
		breakpoints: [
			{
				count: 1,
				actions: [
					{
						kind: 'choose',
						decisionKind: 'deepSeaHunterRedirect',
						prompt: 'On Navigation Reveal, you may change your destination.',
						options: [
							{ id: 'keep', label: 'Keep my destination' },
							{ id: 'Forest Region', label: 'Move to Forest Region' },
							{ id: 'Mountain Region', label: 'Move to Mountain Region' },
							{ id: 'Water Region', label: 'Move to Water Region' },
							{ id: 'Fire Region', label: 'Move to Fire Region' },
							{ id: 'Arcane Abyss', label: 'Move to Arcane Abyss' }
						]
					}
				]
			}
		]
	},
	{
		on: 'inCombat',
		run(ctx) {
			ctx.player.alwaysAttackFirst = true;
			ctx.log.push(ruleValue(ctx.catalog, 'initiativeDie') ? 'Spellblade: gains the initiative if the die misses.' : 'Spellblade: attacks first.');
		}
	}
];

function rebuildOccupancy(ctx: EffectContext): void {
	const occ: Partial<Record<NavigationDestination, SeatColor[]>> = {};
	for (const seat of ctx.state.activeSeats) {
		const dest = ctx.state.players[seat]?.navigationDestination as NavigationDestination | null;
		if (dest) (occ[dest] ??= []).push(seat);
	}
	ctx.state.locationOccupancy = occ;
}

export const decisions: ClassDecisions = {
	deepSeaHunterRedirect(ctx, optionId) {
		if (optionId === 'keep' || !(optionId in LOCATIONS)) return;
		const dest = optionId as NavigationDestination;
		if (ctx.player.navigationDestination === dest) return;
		ctx.player.navigationDestination = dest;
		ctx.player.pendingDestination = dest;
		rebuildOccupancy(ctx);
		ctx.log.push(`Spellblade: changed destination to ${dest}.`);
	}
};
