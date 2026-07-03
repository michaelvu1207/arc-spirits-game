/**
 * GAUNTLET-V1 — the FROZEN evaluation spec. This file is the single fixed measure of bot
 * strength. Nothing here may change: not the seeds, not the anchor pool, not maxRounds,
 * not the scoring math. Any change — however small — REQUIRES forking this directory to
 * gauntlet-v2 and re-baselining every score. Scores from different gauntlet versions are
 * not comparable.
 *
 * Spec:
 *   • 800 paired games: 200 base seeds (9_000_000..9_000_199), each played 4 times with
 *     the candidate rotated through every seat (rotation r ⇒ candidate in seat index r).
 *     The same engine seed is reused across the 4 rotations, so the 4 games of a base
 *     seed share the world draw and differ only in seating ("paired seeds").
 *   • Each game is 4-player FFA: the candidate + 3 distinct anchors drawn deterministically
 *     from the active anchor pool (partial Fisher–Yates keyed off ANCHOR_FIELD_SEED and the
 *     base-seed index — same fields every run, forever). Anchor j sits in the j-th
 *     non-candidate seat rotated by r ((j + r) % 3), so anchors also move seats.
 *   • maxRounds = 120 per game (the eval-gate convention).
 *   • Placement = rank by final VP, ties share the better place (1 + #strictly-greater).
 *     A "win" = the engine's real winnerSeat (reached the 30-VP target), not best-VP.
 *   • Elo vs an anchor is the closed-form logistic conversion of the pairwise placement
 *     score against that anchor (win 1 / tie 0.5 / loss 0, Laplace-smoothed), NOT a
 *     sequential K-update — so the number is independent of game order and stable.
 */

import { createRng, nextInt } from '../../rng';

// v2 = rules v1.1 (market hole closed); seeds/anchors/metric unchanged from v1.
// v3 = fair-gen24 champion added to the checkpoint anchor pool: gauntlet-v2 was
// SATURATED (the champion scored 99% win / placement 1.00), so post-champion
// candidates could not gain measurable Elo. Adding the champion restores
// headroom. The anchor-field draw shifts with the pool → v3 scores are a NEW
// SCALE, non-comparable to v2 (v2 result files remain the historical record).
// v4 = rules v1.2 (Fallen corruption shortfall costs VP — docs/rules-v1.2.md);
// schedule/anchors/metric identical to v3, scored under the new rules.
// v5 = obs v1.1 encoder (OBS_DIM 62 → 78, ladder forward-value features): every
// 62-dim checkpoint anchor became dim-incompatible (same fate as act52-full-g6
// at the 55→62 bump), so the pool is the 8 heuristics until a 78-dim champion
// is promoted in. NEW SCALE vs v4 (anchor-field draw shifts with the pool).
// v6 = two eval-visible behavior changes after the 2026-07-02 live playtest:
// (a) STATUS_SHAPE (the pre-v1.2 "descend to Fallen" pull in the hybrid value
// lookahead) deleted — it sabotaged the v1.1 ladder champion in live play; and
// (b) the unpayable-corruption-debt rule (zero spirits ⇒ remaining owed
// discards settle as -1 VP each instead of freezing the seat). Both shift
// game outcomes → NEW SCALE vs v5.
// v7 = final-scoring-at-cap engine rule (Michael's ruling, commit 96ec2e3: a
// game that hits the round cap scores final VP for placement instead of the
// pre-cap snapshot — the U94RP3 31-VP case) + the Phase 3c tempo recipe
// (--win-bonus now actually fires: the `won`/`endRound` fields were stamped but
// never serialized before, so v6 champions trained with an inert win bonus).
// The cap-scoring change is eval-visible at cap-end → NEW SCALE vs v6.
export const GAUNTLET_VERSION = 'gauntlet-v7';

export const BASE_SEED_FIRST = 9_000_000;
export const N_BASE_SEEDS = 200;
export const ROTATIONS = 4; // = seats; candidate visits every seat once per base seed
export const TOTAL_GAMES = N_BASE_SEEDS * ROTATIONS; // 800
export const GAUNTLET_SEATS = 4;
export const GAUNTLET_MAX_ROUNDS = 120;

/** Deterministic key for the per-base-seed anchor-field draw. Frozen. */
export const ANCHOR_FIELD_SEED = 0x9a01e7;

/**
 * The 8 heuristic anchors (names in BOT_PROFILES), chosen for maximal strategic spread:
 *   medium      — the shipped mid-tier safe scaler (the historical reference bot)
 *   hard        — safe scaler + fight urgency (the tempo baseline, no search)
 *   insane      — deep solo-rollout search tier (the ladder's practical strength ceiling;
 *                 chosen over godly, whose 2× rollout budget added ~3h of wall-clock per
 *                 full gauntlet for near-zero extra discrimination)
 *   survivor    — sustain-first, cautious fights (Healer/Cultivator lean)
 *   cultivator  — capacity-first: rush max barrier before damage
 *   rushpatient — data-driven hybrid: capacity rush + 4 Cultivators, patient fights
 *   paragon     — the optimized never-corrupt Good line (opportunistic + arcane finish)
 *   pvphunter   — the aggressive Evil line: corrupt on purpose, descend, hunt players
 */
export const HEURISTIC_ANCHORS: readonly string[] = [
	'medium',
	'hard',
	'insane',
	'survivor',
	'cultivator',
	'rushpatient',
	'paragon',
	'pvphunter'
] as const;

export type CheckpointStatus = 'active' | 'dim-incompatible' | 'missing';

export interface CheckpointAnchor {
	name: string;
	/** Repo-root-relative path to the weights JSON. */
	path: string;
	status: CheckpointStatus;
	note: string;
}

/**
 * Frozen checkpoint anchors. Only `status: 'active'` entries join the anchor pool; the
 * others are recorded here so the historical intent of the pool is auditable.
 *
 *   • traceq-damage-nearmiss is the strongest 62/52 checkpoint at freeze time (40% win
 *     vs pvphunter, 79% vs a mixed field, 48-game evals) and was shipped as the live
 *     policy — src/lib/play/ml/policy-weights.json is a byte-identical copy at freeze.
 *     The gauntlet pins the immutable meta_runs path, NOT the live path (which will move
 *     with future ships), and the live copy is deliberately not a separate anchor.
 *   • routeexecq-shared-allseat is the co-strongest 62/52 checkpoint (40% / 81% on the
 *     same evals).
 *   • act52-full-g6 is obs_dim 55 (pre-62 encoder). loadPolicyWeights rejects it against
 *     the current 62/52 contract, so it CANNOT be scored — recorded as dim-incompatible
 *     rather than silently dropped.
 */
export const CHECKPOINT_ANCHORS: readonly CheckpointAnchor[] = [
	{
		name: 'fair-gen24-champion',
		path: 'ml/champions/fair/main-0-gen24.json',
		status: 'dim-incompatible',
		note: '[v5: obs_dim 62 vs v1.1 encoder 78] gauntlet-v3 anchor: the fair-rules champion (v2 Elo 1014 / 99% win / 29.8 meanVP; live since 1c7766a). Added because it saturated the v2 field.'
	},
	{
		name: 'traceq-damage-nearmiss',
		path: 'ml/meta_runs/traceq-damage-nearmiss-vp28-29-20260630T053132Z/best_policy.json',
		status: 'dim-incompatible',
		note: '[v5: obs_dim 62 vs v1.1 encoder 78] strongest 62/52 checkpoint at freeze (2026-07-01); byte-identical to the shipped live policy-weights.json'
	},
	{
		name: 'routeexecq-shared-allseat',
		path: 'ml/meta_runs/routeexecq-shared-allseat-candidate-20260701Ttrain/best_policy.json',
		status: 'dim-incompatible',
		note: '[v5: obs_dim 62 vs v1.1 encoder 78] co-strongest 62/52 checkpoint at freeze (2026-07-01): 40% vs pvphunter / 81% vs mixed'
	},
	{
		name: 'act52-full-g6',
		path: 'ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json',
		status: 'dim-incompatible',
		note: 'obs_dim 55 vs current encoder 62 — loadPolicyWeights rejects; not scoreable'
	}
] as const;

/** The active anchor pool, in frozen order (heuristics first, then active checkpoints). */
export function activeAnchorNames(): string[] {
	return [
		...HEURISTIC_ANCHORS,
		...CHECKPOINT_ANCHORS.filter((c) => c.status === 'active').map((c) => c.name)
	];
}

export interface GauntletGame {
	/** 0..TOTAL_GAMES-1, base-seed-major then rotation — truncation keeps pairs together. */
	game: number;
	/** Engine seed (shared by all 4 rotations of a base seed). */
	seed: number;
	/** 0..3 — also the candidate's seat index. */
	rotation: number;
	candidateSeatIdx: number;
	/** Anchor names for the 3 non-candidate seats; anchors[j] sits in the ((j + rotation) % 3)-th
	 *  non-candidate seat (ascending seat order). */
	anchors: string[];
}

/**
 * The full frozen schedule. `totalGames` truncates for smoke runs (base-seed-major order,
 * so a multiple of 4 keeps seed pairs intact); it never reorders or reseeds anything.
 */
export function buildSchedule(totalGames = TOTAL_GAMES): GauntletGame[] {
	const pool = activeAnchorNames();
	const rng = createRng(ANCHOR_FIELD_SEED);
	const games: GauntletGame[] = [];
	for (let b = 0; b < N_BASE_SEEDS; b++) {
		// Partial Fisher–Yates: draw 3 distinct anchors for this base seed. The rng is
		// consumed in base-seed order regardless of truncation, so fields are identical
		// whether you run 8 games or 800.
		const idx = [...pool.keys()];
		const anchors: string[] = [];
		for (let j = 0; j < GAUNTLET_SEATS - 1; j++) {
			const k = j + nextInt(rng, idx.length - j);
			[idx[j], idx[k]] = [idx[k], idx[j]];
			anchors.push(pool[idx[j]]);
		}
		for (let r = 0; r < ROTATIONS; r++) {
			const game = b * ROTATIONS + r;
			if (game >= totalGames) break;
			games.push({
				game,
				seed: BASE_SEED_FIRST + b,
				rotation: r,
				candidateSeatIdx: r,
				anchors
			});
		}
		if (games.length >= totalGames) break;
	}
	return games;
}

/**
 * Convert a pairwise score (win 1 / tie 0.5 / loss 0 averaged over n encounters) to a
 * relative Elo, Laplace-smoothed with half a virtual draw so 100%/0% stay finite:
 *   s' = (score·n + 0.5) / (n + 1);   elo = -400·log10(1/s' − 1)
 */
export function eloFromScore(scoreSum: number, n: number): number {
	if (n <= 0) return 0;
	const s = (scoreSum + 0.5) / (n + 1);
	return Math.round(-400 * Math.log10(1 / s - 1));
}
