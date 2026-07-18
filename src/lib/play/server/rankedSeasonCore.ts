/** Runtime-neutral season-rating core shared by SvelteKit HTTP and standalone
 * room-server processes. No `$env`, SvelteKit, or server-admin imports here. */
import { rate, rating } from 'openskill';
import type { PlayDbClient } from './commit';

export const DEFAULT_MU = 25;
export const DEFAULT_SIGMA = 25 / 3;
const APPLY_RPC = 'apply_ranked_season_result';

export type SeasonStanding = { user_id: string | null; display_name: string | null;
	is_bot: boolean; placement: number };

async function ratingPayload(db: PlayDbClient, seasonId: string, standings: SeasonStanding[]) {
	const rated = standings.filter((row): row is SeasonStanding & { user_id: string } => !!row.user_id);
	if (rated.length < 2) return [];
	const loaded = await db.from('ranked_player_seasons').select('user_id,mu,sigma,games_played')
		.eq('season_id', seasonId).in('user_id', rated.map((row) => row.user_id));
	if (loaded.error) return null;
	const current = new Map(((loaded.data as Array<{ user_id: string; mu: number; sigma: number; games_played: number }> | null) ?? [])
		.map((row) => [row.user_id, row]));
	const before = rated.map((row) => {
		const value = current.get(row.user_id);
		return value ? rating({ mu: value.mu, sigma: value.sigma }) : rating();
	});
	const updated = rate(before.map((value) => [value]), { rank: rated.map((row) => row.placement) });
	return rated.map((row, index) => {
		const base = current.get(row.user_id) ?? null;
		return { user_id: row.user_id, display_name: row.display_name, is_bot: row.is_bot,
			placement: row.placement, mu_before: before[index].mu, sigma_before: before[index].sigma,
			mu_after: updated[index][0].mu, sigma_after: updated[index][0].sigma,
			expected_mu: base?.mu ?? null, expected_sigma: base?.sigma ?? null,
			expected_games: base?.games_played ?? null };
	});
}

export async function reconcileRankedSeasonWith(db: PlayDbClient, sessionId: string,
	seasonId: string, standings: SeasonStanding[]): Promise<boolean> {
	if (!seasonId || typeof db.rpc !== 'function') return false;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const payload = await ratingPayload(db, seasonId, standings);
		if (!payload) return false;
		const result = await db.rpc(APPLY_RPC, { p_session_id: sessionId, p_season_id: seasonId, p_ratings: payload });
		if (!result.error) return true;
		if ((result.error.message ?? '').includes('stale_season_ratings')) continue;
		console.error('[ranked-season] reconciliation failed:', result.error.message);
		return false;
	}
	return false;
}
