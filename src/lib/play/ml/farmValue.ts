import { buildMonsterRewards } from '../monsterRewards';
import { bestHandMonster } from '../bots/monsterCardAutopilot';
import { computeKillProbability } from '../server/botPolicy';
import {
	VP_TO_WIN,
	type MonsterState,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';

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
	/** The card to farm. Omitted → the best card in the seat's own monster hand. */
	monster?: MonsterState | null;
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
	// A player fights cards from their own hand; each card is a single kill (legacy lives = 1).
	const monster =
		opts.monster !== undefined ? opts.monster : (bestHandMonster(state, seat, catalog)?.card ?? null);
	const live = !!monster && monster.hp > 0;
	const empty: FarmValueSignal = {
		valid: false,
		farmable: false,
		bossFarmable: false,
		cleanKillProb: 0,
		rewardVp: 0,
		opportunityVp: 0,
		remainingOpportunityVp: 0,
		normalizedOpportunity: 0,
		livesRemaining: live ? 1 : 0,
		livesTotal: monster ? 1 : 0,
		playerVp: player?.victoryPoints ?? 0,
		bestOpponentVp: 0,
		racePressure: 0,
		statusLevel: player?.statusLevel ?? 0,
		score: 0
	};
	if (!player || !monster || !live) return empty;

	const rewardVp = claimableMonsterRewardVp(monster.rewardTrack, monster.chooseAmount);
	const cleanKillProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false, monster });
	const opportunityVp = cleanKillProb * rewardVp;
	const remainingOpportunityVp = opportunityVp;
	let bestOpponentVp = 0;
	for (const [otherSeat, other] of Object.entries(state.players)) {
		if (otherSeat === seat) continue;
		bestOpponentVp = Math.max(bestOpponentVp, other?.victoryPoints ?? 0);
	}
	const racePressure = clamp01((bestOpponentVp - player.victoryPoints) / VP_TO_WIN);
	const statusPenalty = clamp01((player.statusLevel ?? 0) / 3);
	const normalizedOpportunity = clamp01(opportunityVp / VP_TO_WIN);
	const score = clamp01(normalizedOpportunity * (1 + racePressure * 0.25) * (1 - statusPenalty * 0.25));
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
		livesRemaining: 1,
		livesTotal: 1,
		playerVp: player.victoryPoints,
		bestOpponentVp,
		racePressure,
		statusLevel: player.statusLevel ?? 0,
		score
	};
}
