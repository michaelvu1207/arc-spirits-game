/**
 * The game explorer's data (local game only): what the balance tools measured in the finished
 * AI test games. Served by /explorer/balance.json from one file; see that route.
 */

import { writable } from 'svelte/store';

/** The most recent finished test against the targets. */
export interface BalanceHeadline {
	setup: string;
	table: string;
	games: number;
	/** Points that win the game in this test (30, or 40 under rule winAt40). */
	win_points?: number;
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
/** One tested rule set (40-point rules) against the four checks. */
export interface BalanceRun {
	/** What this run's rules change from the live game. */
	changes?: BalanceRuleChanges | null;
	id: string;
	/** The whole rule set, in words. */
	setup: string;
	/** What this run changed from the one before it. */
	change: string;
	table: string;
	note: string;
	games: number;
	win_points: number;
	end_rounds: number[];
	end_round_median: number;
	round_ok: boolean;
	gaps: number[];
	gap_median: number;
	first_second_median: number;
	gap_ok: boolean;
	monster_pct: number;
	spirit_pct: number;
	combat_pct: number;
	power_pct: number;
	split_ok: boolean;
	/** Monsters left in the Difficulty 1, 2 and 3 pools at rounds 10, 20 and 30 (or the last round). */
	pool_left: number[];
	pool_start: number[];
	pools_ok: boolean;
}
/** One seat of one test game. */
export interface BalanceRunSeat {
	agent: string;
	seat: string;
	place: number;
	points: number;
	status: string;
	kills: number;
	fights: number;
	from_monsters: number;
	from_attacks: number;
	from_spirits: number;
	from_powers: number;
	attacks_made: number | null;
	times_attacked: number | null;
	times_corrupted: number | null;
	fallen_round: number | null;
	spirits_lost: number | null;
	awakened: number;
	notable: string[];
	points_by_round: number[];
}
export interface BalanceRunGame {
	run: string;
	folder: string;
	game: string;
	/** Id of the game in the round-by-round viewer (null: not imported). */
	game_id: string | null;
	rounds: number;
	gap: number;
	seats: BalanceRunSeat[];
}
/** The newest setup's recorded games scored with a different payout (play assumed unchanged). */
export interface BalanceWhatIf {
	change: string;
	monster_pct: number;
	spirit_pct: number;
	combat_pct: number;
	split_ok: boolean;
}
/** One count of a class and what it does there. */
export interface BalanceClassLine {
	count: string;
	text: string;
}
/** What a tested rule set changes from the live game, as printed text. */
export interface BalanceRuleChanges {
	win_points: number;
	/** Classes whose ability differs: the live text and the tested one. */
	classes: { name: string; live: BalanceClassLine[]; test: BalanceClassLine[] }[];
	/** Spirits whose awakening differs. */
	spirits: { name: string; live: string; test: string }[];
	/** Monster numbers by Difficulty (a range over the cards), live and tested. */
	monsters: {
		group: string;
		barrier: string;
		hit: string;
		points: string;
		first: string;
		barrier_live?: string;
		hit_live?: string;
		points_live?: string;
		first_live?: string;
	}[];
	/** Other rules that differ, one sentence each. */
	other: string[];
}

export interface BalanceData {
	/** The rules the spirit lists describe (the latest tested setup). */
	test_rules?: (BalanceRuleChanges & { setup: string }) | null;
	runs?: BalanceRun[];
	run_games?: BalanceRunGame[];
	whatif?: BalanceWhatIf[];
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
	const data = (await res.json()) as BalanceData;
	testRules.set(data.test_rules ?? null);
	return data;
}

/**
 * The tested rules, for the pieces that print a class or a spirit (ClassInfo, SpiritInfo): the
 * card data they read is the live game's. Null until the balance data has loaded, and on pages
 * that do not load it; those show the live text.
 */
export const testRules = writable<BalanceData['test_rules']>(null);

/** Share of a pool that may be left for it to count as "mostly dead". */
const MOSTLY_DEAD = 0.25;
/** Michael's pool targets: Difficulty 1 mostly dead by round 10, 2 by round 20. Difficulty 3 has no target
 *  (Michael, 2026-11-20: nobody kills 40 of them). */
const POOL_TARGETS: [keyof Omit<BalancePools, 'round'>, number][] = [
	['difficulty_1', 10],
	['difficulty_2', 20]
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
