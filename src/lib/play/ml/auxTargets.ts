import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import type { LegalAction } from './actions';
import { evaluateFarmValue } from './farmValue';

export interface SampleAuxTargets {
	farmValue: number;
	rewardPi?: number[];
	routeMode?: number;
}

/** Behavior label for the real Fallen navigation decision. At status 3, returning to
 * Arcane Abyss is route mode 0; choosing a Spirit World location to seek PvP is mode 1.
 * This is intentionally attached only to an actually chosen navigation action, rather
 * than fabricating route supervision on unrelated states. */
export function fallenRouteModeTarget(
	state: PublicGameState,
	seat: SeatColor,
	chosen?: LegalAction
): number | undefined {
	if ((state.players[seat]?.statusLevel ?? 0) < 3 || !chosen) return undefined;
	if (chosen.cmd.type !== 'lockNavigation' && chosen.cmd.type !== 'selectNavigationDestination') {
		return undefined;
	}
	return chosen.cmd.destination === 'Arcane Abyss' ? 0 : 1;
}

export function rewardPickTarget(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[]
): number[] | undefined {
	const beforeVp = state.players[seat]?.victoryPoints ?? 0;
	const weights = withNext.map((x) => {
		if (x.cmd.type !== 'resolveMonsterReward') return 0;
		return Math.max(0, (x.next.players[seat]?.victoryPoints ?? beforeVp) - beforeVp);
	});
	const sum = weights.reduce((a, b) => a + b, 0);
	return sum > 0 ? weights.map((w) => w / sum) : undefined;
}

export function sampleAuxTargets(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext?: LegalAction[],
	chosen?: LegalAction
): SampleAuxTargets {
	const rewardPi = withNext ? rewardPickTarget(state, seat, withNext) : undefined;
	const routeMode = fallenRouteModeTarget(state, seat, chosen);
	return {
		farmValue: evaluateFarmValue(state, seat, catalog, { threshold: 0 }).score,
		...(rewardPi ? { rewardPi } : {}),
		...(typeof routeMode === 'number' ? { routeMode } : {})
	};
}
