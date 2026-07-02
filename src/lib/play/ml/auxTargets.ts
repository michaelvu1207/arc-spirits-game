import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import type { LegalAction } from './actions';
import { evaluateFarmValue } from './farmValue';

export interface SampleAuxTargets {
	farmValue: number;
	rewardPi?: number[];
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
	withNext?: LegalAction[]
): SampleAuxTargets {
	const rewardPi = withNext ? rewardPickTarget(state, seat, withNext) : undefined;
	return {
		farmValue: evaluateFarmValue(state, seat, catalog, { threshold: 0 }).score,
		...(rewardPi ? { rewardPi } : {})
	};
}
