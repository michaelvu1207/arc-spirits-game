import { buildMonsterRewards } from '../monsterRewards';
import { computeKillProbability } from '../server/botPolicy';
import { VP_TO_WIN, type PlayCatalog, type PublicGameState, type SeatColor } from '../types';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface FarmValueSignal {
	valid: boolean;
	farmable: boolean;
	bossFarmable: boolean;
	cleanKillProb: number;
	rewardVp: number;
	opportunityVp: number;
	remainingOpportunityVp: number;
	normalizedOpportunity: number;
	livesRemaining: number;
	livesTotal: number;
	playerVp: number;
	bestOpponentVp: number;
	racePressure: number;
	statusLevel: number;
	score: number;
}

export interface FarmValueOptions {
	/** Clean-kill probability threshold for the binary farmable diagnostic. */
	threshold?: number;
}

export function claimableMonsterRewardVp(
	rewardTrack: string[] | null | undefined,
	chooseAmount: number
): number {
	return buildMonsterRewards(rewardTrack)
		.map((opt) => (opt.effect.type === 'vp' ? opt.effect.amount : 0))
		.sort((a, b) => b - a)
		.slice(0, Math.max(0, chooseAmount))
		.reduce((sum, vp) => sum + vp, 0);
}

export function evaluateFarmValue(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	opts: FarmValueOptions = {}
): FarmValueSignal {
	const threshold = clamp01(opts.threshold ?? 0.5);
	const player = state.players[seat];
	const monster = state.monster;
	const empty: FarmValueSignal = {
		valid: false,
		farmable: false,
		bossFarmable: false,
		cleanKillProb: 0,
		rewardVp: 0,
		opportunityVp: 0,
		remainingOpportunityVp: 0,
		normalizedOpportunity: 0,
		livesRemaining: monster?.livesRemaining ?? 0,
		livesTotal: monster?.livesTotal ?? 0,
		playerVp: player?.victoryPoints ?? 0,
		bestOpponentVp: 0,
		racePressure: 0,
		statusLevel: player?.statusLevel ?? 0,
		score: 0
	};
	if (!player || !monster || monster.livesRemaining <= 0) return empty;

	const rewardVp = claimableMonsterRewardVp(monster.rewardTrack, monster.chooseAmount);
	const cleanKillProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const opportunityVp = cleanKillProb * rewardVp;
	const remainingOpportunityVp = opportunityVp * Math.max(1, monster.livesRemaining);
	let bestOpponentVp = 0;
	for (const [otherSeat, other] of Object.entries(state.players)) {
		if (otherSeat === seat) continue;
		bestOpponentVp = Math.max(bestOpponentVp, other?.victoryPoints ?? 0);
	}
	const racePressure = clamp01((bestOpponentVp - player.victoryPoints) / VP_TO_WIN);
	const statusPenalty = clamp01((player.statusLevel ?? 0) / 3);
	const livesMultiplier = 1 + Math.min(0.5, Math.max(0, monster.livesRemaining - 1) * 0.15);
	const normalizedOpportunity = clamp01(opportunityVp / VP_TO_WIN);
	const score = clamp01(normalizedOpportunity * livesMultiplier * (1 + racePressure * 0.25) * (1 - statusPenalty * 0.25));
	const farmable = cleanKillProb >= threshold && rewardVp > 0;
	return {
		valid: true,
		farmable,
		bossFarmable: farmable && (monster.maxHp ?? monster.hp ?? 0) >= 10,
		cleanKillProb,
		rewardVp,
		opportunityVp,
		remainingOpportunityVp,
		normalizedOpportunity,
		livesRemaining: monster.livesRemaining,
		livesTotal: monster.livesTotal,
		playerVp: player.victoryPoints,
		bestOpponentVp,
		racePressure,
		statusLevel: player.statusLevel ?? 0,
		score
	};
}
