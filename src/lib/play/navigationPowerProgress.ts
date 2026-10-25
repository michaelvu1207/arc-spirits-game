/** Resolve only outstanding owner-visible work; never spend a rune or play a new power. */
import type { GameCommand, PublicGameState, SeatColor } from './types';

/**
 * A conservative bot/deadline action. Each caller must apply and re-evaluate it
 * against the next state rather than queueing commands from an old snapshot.
 * Choices do not inspect another player's inventory, hidden destination, or RNG.
 */
export function getPowerAutoCommand(state: PublicGameState, seat: SeatColor): GameCommand | null {
	if (state.status !== 'active' || !state.activeSeats.includes(seat)) return null;
	const player = state.players[seat];
	if (!player) return null;

	// A rune's owner must answer an outstanding theft even if they already readied.
	const mandatory = player.navigationPowerOffers?.find((offer) => offer.mandatory);
	if (mandatory) {
		const option = mandatory.options[0];
		return option
			? { type: 'resolveNavigationPower', offerId: mandatory.id, optionId: option.id }
			: null;
	}
	const optional = player.navigationPowerOffers?.[0];
	if (optional) {
		const decline = optional.options.find((option) => option.id === 'decline');
		return decline
			? { type: 'resolveNavigationPower', offerId: optional.id, optionId: decline.id }
			: null;
	}

	// A player can decline a proposal without mutating either side's assets.
	if (player.pendingNavigationTrade?.toSeat === seat)
		return {
			type: 'respondNavigationPowerTrade',
			tradeId: player.pendingNavigationTrade.id,
			accept: false
		};
	if (player.phaseReady || (state.phase === 'navigation' && state.navigation?.[seat]?.locked))
		return null;

	if (state.phase !== 'navigation' && !player.actionsUsedThisRound.includes('gain-power'))
		return null;
	const firstOffered = player.pendingPowerDrafts?.[0]?.[0];
	return firstOffered ? { type: 'chooseNavigationPower', powerId: firstOffered, ...(player.pendingPowerReplacement ? { replacePowerId: player.powerInventory?.find(id => id !== firstOffered) } : {}) } : null;
}

/** Bounded compatibility wrapper: at most one action from any one snapshot. */
export function navigationPowerAutoCommands(
	state: PublicGameState,
	seat: SeatColor
): GameCommand[] {
	const command = getPowerAutoCommand(state, seat);
	return command ? [command] : [];
}
