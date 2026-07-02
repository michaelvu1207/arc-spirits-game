/**
 * PFSP — prioritized fictitious self-play opponent sampling (pure; unit-tested).
 *
 * Given a learner's pairwise match stats, weight candidate opponents so training
 * time goes where it buys the most:
 *   - 'squared' (default, p=2): weight = (1 − winrate)^p — prioritize opponents the
 *     learner LOSES to (AlphaStar's PFSP curve).
 *   - 'hard': weight = winrate·(1 − winrate) — peak effort on ~50% opponents.
 *
 * Lane rules (BOT_METHODOLOGY_DIRECTION.md Phase C):
 *   - main:             samples over the WHOLE league (every playable member but itself).
 *   - main_exploiter:   ALWAYS faces only the current main agent(s).
 *   - league_exploiter: uniform over the frozen historical pool (frozen snapshots +
 *     the heuristic anchors that seeded the league).
 *
 * Winrate vs an opponent = pairwise placement score (better 1 / tie 0.5 / worse 0)
 * from MatchStats; no shared games yet ⇒ 0.5 (neutral prior). A small floor keeps
 * fully-beaten opponents in rotation so wins against them stay verified.
 */

import type { LeagueMember, MatchStats, PfspConfig } from './types';

/** Minimum sampling weight — beaten opponents still appear occasionally. */
export const PFSP_WEIGHT_FLOOR = 1e-3;

/** Pairwise placement winrate of `learner` vs opponent `oppId` (0.5 when no games). */
export function winrateVs(learner: LeagueMember, oppId: string): number {
	const s: MatchStats | undefined = learner.matchStats[oppId];
	if (!s || s.games <= 0) return 0.5;
	const ties = Math.max(0, s.games - s.better - s.worse);
	return (s.better + 0.5 * ties) / s.games;
}

/** PFSP weight for one opponent given the learner's winrate against them. */
export function pfspWeight(winrate: number, cfg: PfspConfig): number {
	const w = Math.min(1, Math.max(0, winrate));
	const raw = cfg.variant === 'hard' ? w * (1 - w) : Math.pow(1 - w, cfg.p);
	return Math.max(PFSP_WEIGHT_FLOOR, raw);
}

/**
 * A member that can sit in an OPPONENT seat: a heuristic profile or a v1-JSON
 * checkpoint (opponents always load in-process — v1-JSON-only). A v2 member
 * qualifies through its distilled student; a v2 learner with only a .pt does
 * NOT (the .pt plays via the lane's inference server, learner-side only).
 */
export function isPlayable(m: LeagueMember): boolean {
	if (m.profile) return true;
	return [m.distilledPath, m.weightsPath, m.initFrom].some((p) => !!p && p.endsWith('.json'));
}

/** The candidate opponent pool for a learner, by lane rules (see header). */
export function opponentPool(learner: LeagueMember, members: LeagueMember[]): LeagueMember[] {
	const others = members.filter((m) => m.id !== learner.id && isPlayable(m));
	switch (learner.kind) {
		case 'main_exploiter':
			return others.filter((m) => m.kind === 'main');
		case 'league_exploiter':
			return others.filter((m) => m.kind === 'frozen' || m.kind === 'heuristic');
		default:
			return others;
	}
}

/** Per-member sampling weights for a learner (uniform for league exploiters). */
export function opponentWeights(
	learner: LeagueMember,
	pool: LeagueMember[],
	cfg: PfspConfig
): number[] {
	if (learner.kind === 'league_exploiter') return pool.map(() => 1);
	return pool.map((m) => pfspWeight(winrateVs(learner, m.id), cfg));
}

/**
 * Sample `count` opponents (with replacement — one lineup may repeat a member)
 * for a learner. `rand` supplies uniforms in [0,1); pass a seeded generator for
 * a deterministic draw. Throws when the lane's pool is empty.
 */
export function sampleOpponents(
	learner: LeagueMember,
	members: LeagueMember[],
	count: number,
	cfg: PfspConfig,
	rand: () => number
): LeagueMember[] {
	const pool = opponentPool(learner, members);
	if (pool.length === 0) {
		throw new Error(`pfsp: empty opponent pool for ${learner.id} (${learner.kind})`);
	}
	const weights = opponentWeights(learner, pool, cfg);
	const total = weights.reduce((a, b) => a + b, 0);
	const picks: LeagueMember[] = [];
	for (let i = 0; i < count; i++) {
		let t = rand() * total;
		let idx = 0;
		for (; idx < pool.length - 1; idx++) {
			t -= weights[idx];
			if (t < 0) break;
		}
		picks.push(pool[idx]);
	}
	return picks;
}

/**
 * Fold one game's pairwise outcome into a learner's MatchStats vs `oppId`.
 * `learnerPlacement`/`oppPlacement` are the GameSummary placements (1 = best).
 */
export function recordPairwise(
	learner: LeagueMember,
	oppId: string,
	learnerPlacement: number,
	oppPlacement: number
): void {
	const s = (learner.matchStats[oppId] ??= { games: 0, better: 0, worse: 0 });
	s.games += 1;
	if (learnerPlacement < oppPlacement) s.better += 1;
	else if (learnerPlacement > oppPlacement) s.worse += 1;
}
