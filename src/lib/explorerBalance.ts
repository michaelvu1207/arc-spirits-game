/**
 * The game explorer's data (local game only): what the balance tools measured in the finished
 * AI test games. Served by /explorer/balance.json from one file; see that route.
 */

/** The most recent finished test against the targets. */
export interface BalanceHeadline {
	setup: string;
	table: string;
	games: number;
	end_round_median: number;
	end_round_low: number;
	end_round_high: number;
	target_round: number;
	target_low: number;
	target_high: number;
	gap_median: number;
	gap_low: number;
	gap_high: number;
	gap_target: number;
	other_pct: number;
	updated: string;
}
/** Share of all points from one source, against its goal. */
export interface BalanceSplit {
	source: string;
	goal_pct: number;
	now_pct: number;
	points_per_seat: number;
}
/** Seats that ended the game in one status. */
export interface BalanceStatus {
	status: string;
	seats: number;
	share_pct: number;
	avg_points: number;
	winners: number;
}
/** Average damage in one round: against monsters in turns with a fight, and all combat over every seat. */
export interface BalanceDamage {
	round: number;
	monster_damage: number | null;
	monster_turns: number;
	per_seat_damage: number;
	seats: number;
}
/** Monsters still alive in each pool at the end of a round (average over the games). */
export interface BalancePools {
	round: number;
	difficulty_1: number;
	difficulty_2: number;
	difficulty_3: number;
}
export interface BalanceMonster {
	monster: string;
	difficulty: number;
	barrier: number;
	fights: number;
	kills: number;
	avg_kill_round: number | null;
}
/** One spirit: its list, cost to awaken, the two levels (0 lowest to 4 highest) and the tier from both. */
export interface BalanceSpirit {
	spirit: string;
	pool: 'Spirit World' | 'Arcane Abyss' | 'Heroes';
	tier: string;
	cls: string;
	awaken_cost: string;
	desirability: string;
	desirability_level: number | null;
	power: string;
	power_level: number | null;
	flag: '' | 'Too powerful' | 'Danger zone';
}
export interface BalanceData {
	headline: BalanceHeadline[];
	split: BalanceSplit[];
	status: BalanceStatus[];
	damage: BalanceDamage[];
	pooled: { games: number; seats: number }[];
	pools: BalancePools[];
	monsters: BalanceMonster[];
	spirits: BalanceSpirit[];
}

export async function fetchBalance(): Promise<BalanceData> {
	const res = await fetch('/explorer/balance.json', { cache: 'no-store' });
	if (!res.ok) throw new Error(res.status === 404 ? 'No balance data yet.' : `Failed to load the balance data (${res.status}).`);
	return (await res.json()) as BalanceData;
}

/** Share of a pool that may be left for it to count as "mostly dead". */
const MOSTLY_DEAD = 0.25;
/** Michael's pool targets: Difficulty 1 mostly dead by round 10, 2 by round 20, 3 by round 30. */
const POOL_TARGETS: [keyof Omit<BalancePools, 'round'>, number][] = [
	['difficulty_1', 10],
	['difficulty_2', 20],
	['difficulty_3', 30]
];
/** How far a point source may be from its goal, in percentage points. */
const SPLIT_TOLERANCE = 5;

/** Whether each box meets its target (null: no data). */
export function balanceChecks(d: BalanceData) {
	const h = d.headline[0];
	const first = d.pools[0];
	const at = (round: number) => d.pools.filter((r) => r.round <= round).pop();
	return {
		round: h ? h.end_round_median >= h.target_low && h.end_round_median <= h.target_high : null,
		gap: h ? h.gap_median <= h.gap_target : null,
		split: d.split.length ? d.split.every((s) => Math.abs(s.now_pct - s.goal_pct) <= SPLIT_TOLERANCE) : null,
		// A game that ends before the target round is judged at its last round.
		pools: first ? POOL_TARGETS.every(([key, round]) => (at(round)?.[key] ?? first[key]) <= MOSTLY_DEAD * first[key]) : null
	};
}
