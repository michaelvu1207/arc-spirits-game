import { DICE_TIER_ORDER, type AttackDie } from '../../types';
import type { ClassAbility } from './types';

// Witch — "At the start of combat with a player, take the best attack dice of that player for
// this combat." Fires on `onPlayerInteraction`, the first beat of a PvP combat (before `inCombat`,
// so Assassin compares the dice counts after the take). The Witch takes the opposing player's
// highest-tier die (the first one on a tie) into its own pool: the Witch rolls it, the opponent
// does not. `combat.ts` gives it back when that combat ends. The opposing player is the combat's
// representative seat (the first one in seat order). A die that is already taken by another
// Witch cannot be taken again. The die may take the Witch above the 10-dice cap for that combat
// (it is not a gain). Monster combat is not affected.
export const ability: ClassAbility[] = [
	{
		on: 'onPlayerInteraction',
		run(ctx) {
			const seat = ctx.opponent;
			const opponent = seat ? ctx.state.players[seat] : undefined;
			if (!seat || !opponent) return;
			const taken = new Set<string>();
			for (const p of Object.values(ctx.state.players)) {
				for (const entry of p?.witchBorrowedDice ?? []) taken.add(entry.die.instanceId);
			}
			let best: AttackDie | undefined;
			for (const die of opponent.attackDice) {
				if (taken.has(die.instanceId)) continue;
				if (!best || DICE_TIER_ORDER.indexOf(die.tier) > DICE_TIER_ORDER.indexOf(best.tier)) best = die;
			}
			if (!best) return;
			const die = best;
			opponent.attackDice = opponent.attackDice.filter((d) => d.instanceId !== die.instanceId);
			ctx.player.attackDice.push(die);
			(ctx.player.witchBorrowedDice ??= []).push({ fromSeat: seat, die });
			ctx.log.push(`Witch: takes ${seat}'s best attack die (${die.tier}) for this combat.`);
		}
	}
];
