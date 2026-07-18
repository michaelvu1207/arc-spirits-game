import { ordinal } from 'openskill';
import { error as kitError } from '@sveltejs/kit';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import { DEFAULT_MU, DEFAULT_SIGMA } from './rankedSeasonCore';

function admin() {
	const value = getSupabaseAdmin('arc_spirits_2d');
	if (!value) throw kitError(503, 'Ranked service is not configured.');
	return value;
}

export function confidencePercent(sigma: number, placementsComplete: boolean): number {
	if (!placementsComplete) return 0;
	return Math.max(1, Math.min(99, Math.round((1 - Math.min(DEFAULT_SIGMA, sigma) / DEFAULT_SIGMA) * 100)));
}

function divisionFor(
	rules: Array<{ division_key: string; label: string; tier_order: number; min_ordinal: number }>,
	value: number
) {
	return [...rules]
		.sort((a, b) => b.min_ordinal - a.min_ordinal)
		.find((rule) => value >= rule.min_ordinal) ?? rules[0] ?? null;
}

export async function rankedSnapshot(userId: string) {
	const db = admin();
	const seasonRes = await db.from('ranked_seasons').select('*').eq('status', 'active').maybeSingle();
	if (seasonRes.error || !seasonRes.data) throw kitError(503, 'No ranked season is active.');
	const season = seasonRes.data as Record<string, any>;
	// DB-clocked, weekly-bucketed and idempotent. A failed/lagging decay migration
	// never fabricates client state; the existing rating is still safe to display.
	await db.rpc('apply_ranked_decay', { p_season_id: season.id, p_user_id: userId });
	const [rulesRes, playerRes, achievementsRes, definitionsRes] = await Promise.all([
		db.from('ranked_division_rules').select('*').eq('season_id', season.id).order('tier_order'),
		db.from('ranked_player_seasons').select('*').eq('season_id', season.id).eq('user_id', userId).maybeSingle(),
		db.from('player_achievements').select('achievement_id,progress,target,unlocked_at').eq('user_id', userId),
		db.from('achievement_definitions').select('id,name,description,target,reward_item_id').eq('active', true).order('id')
	]);
	if (definitionsRes.error) throw kitError(503, 'Achievement catalog is unavailable.');
	const rules = (rulesRes.data ?? []) as Array<{ division_key: string; label: string; tier_order: number; min_ordinal: number }>;
	const player = playerRes.data as Record<string, any> | null;
	const progressById = new Map(((achievementsRes.data ?? []) as any[]).map((row) => [row.achievement_id, row]));
	const rewardIds = ((definitionsRes.data ?? []) as any[]).map((row) => row.reward_item_id).filter(Boolean);
	const rewardsRes = rewardIds.length
		? await db.from('cosmetic_catalog').select('id,name').in('id', rewardIds)
		: { data: [], error: null };
	const rewardNames = new Map(((rewardsRes.data ?? []) as any[]).map((row) => [row.id, row.name]));
	const value = player ? ordinal({ mu: Number(player.mu), sigma: Number(player.sigma) }) : 0;
	const placements = Number(player?.placements_completed ?? 0);
	const placementGoal = Number(season.placement_games);
	const division = divisionFor(rules, value);
	return {
		season: { id: season.id, name: season.name, startsAt: season.starts_at, endsAt: season.ends_at, rulesVersion: season.rules_version },
		self: {
			placementsCompleted: placements,
			placementsRequired: placementGoal,
			provisional: placements < placementGoal,
			division: placements < placementGoal ? null : division ? { key: division.division_key, label: division.label } : null,
			ordinal: Math.round(value * 100) / 100,
			confidence: confidencePercent(Number(player?.sigma ?? DEFAULT_SIGMA), placements >= placementGoal),
			gamesPlayed: Number(player?.games_played ?? 0), wins: Number(player?.wins ?? 0),
			peakOrdinal: Math.round(Number(player?.peak_ordinal ?? 0) * 100) / 100
		},
		achievements: ((definitionsRes.data ?? []) as any[]).map((definition) => {
			const progress = progressById.get(definition.id);
			return {
				id: definition.id, name: definition.name, description: definition.description,
				progress: Number(progress?.progress ?? 0),
				target: Number(progress?.target ?? definition.target ?? 1),
				unlockedAt: progress?.unlocked_at ?? null,
				rewardItemId: definition.reward_item_id ?? null,
				rewardName: rewardNames.get(definition.reward_item_id) ?? null
			};
		})
	};
}

export async function rankedLeaderboard(limit = 50) {
	const db = admin();
	const season = await db.from('ranked_seasons').select('id,name,placement_games').eq('status', 'active').maybeSingle();
	if (!season.data) throw kitError(503, 'No ranked season is active.');
	const [playersRes, rulesRes] = await Promise.all([
		db.from('ranked_player_seasons').select('display_name,mu,sigma,games_played,wins,placements_completed,peak_ordinal')
			.eq('season_id', season.data.id).eq('is_bot', false).order('mu', { ascending: false }).limit(Math.min(100, Math.max(1, limit))),
		db.from('ranked_division_rules').select('*').eq('season_id', season.data.id)
	]);
	const rules = (rulesRes.data ?? []) as any[];
	const placementGoal = Number(season.data.placement_games);
	return { seasonId: season.data.id, seasonName: season.data.name, entries: ((playersRes.data ?? []) as any[])
		.map((row) => ({ ...row, value: ordinal({ mu: Number(row.mu), sigma: Number(row.sigma) }) }))
		.sort((a, b) => b.value - a.value)
		.map((row, index) => ({ position: index + 1, displayName: row.display_name || 'Spirit',
			division: divisionFor(rules, row.value)?.label ?? 'Ember', ordinal: Math.round(row.value * 100) / 100,
			gamesPlayed: row.games_played, wins: row.wins, provisional: row.placements_completed < placementGoal })) };
}

export async function rankedHistory(userId: string) {
	const db = admin();
	const [events, snapshots] = await Promise.all([
		db.from('ranked_season_rating_events')
			.select('season_id,event_kind,placement,mu_before,sigma_before,mu_after,sigma_after,created_at')
			.eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
		db.from('ranked_season_snapshots')
			.select('season_id,final_ordinal,peak_ordinal,division_key,leaderboard_position,reward_item_ids,frozen_at')
			.eq('user_id', userId).order('frozen_at', { ascending: false }).limit(20)
	]);
	if (events.error) throw kitError(503, 'Ranked history is unavailable.');
	if (snapshots.error) throw kitError(503, 'Season archive is unavailable.');
	const seasonIds = [...new Set(((snapshots.data ?? []) as any[]).map((row) => row.season_id))];
	const seasonNames = new Map<string, any>();
	for (const seasonId of seasonIds) {
		const season = await db.from('ranked_seasons').select('id,name,starts_at,ends_at').eq('id', seasonId).maybeSingle();
		if (season.data) seasonNames.set(seasonId, season.data);
	}
	return {
		events: (events.data ?? []).map((row: any) => ({ seasonId: row.season_id, kind: row.event_kind,
			placement: row.placement, ordinalBefore: Math.round((row.mu_before - 3 * row.sigma_before) * 100) / 100,
			ordinalAfter: Math.round((row.mu_after - 3 * row.sigma_after) * 100) / 100, createdAt: row.created_at })),
		seasons: ((snapshots.data ?? []) as any[]).map((row) => ({
			seasonId: row.season_id, seasonName: seasonNames.get(row.season_id)?.name ?? row.season_id,
			startsAt: seasonNames.get(row.season_id)?.starts_at ?? null,
			endsAt: seasonNames.get(row.season_id)?.ends_at ?? null,
			finalOrdinal: Math.round(Number(row.final_ordinal) * 100) / 100,
			peakOrdinal: Math.round(Number(row.peak_ordinal) * 100) / 100,
			division: row.division_key, position: Number(row.leaderboard_position),
			rewardItemIds: row.reward_item_ids ?? [], frozenAt: row.frozen_at
		}))
	};
}

export async function rankedArchive(limit = 8) {
	const db = admin();
	const seasons = await db.from('ranked_seasons').select('id,name,starts_at,ends_at,rules_version')
		.eq('status', 'closed').order('ends_at', { ascending: false }).limit(Math.min(20, Math.max(1, limit)));
	if (seasons.error) throw kitError(503, 'Season archive is unavailable.');
	const output = [];
	for (const season of (seasons.data ?? []) as any[]) {
		const [snapshots, players] = await Promise.all([
			db.from('ranked_season_snapshots')
				.select('user_id,final_ordinal,peak_ordinal,division_key,leaderboard_position,reward_item_ids')
				.eq('season_id', season.id).order('leaderboard_position').limit(50),
			db.from('ranked_player_seasons').select('user_id,display_name').eq('season_id', season.id)
		]);
		if (snapshots.error || players.error) throw kitError(503, 'Season archive is unavailable.');
		const names = new Map(((players.data ?? []) as any[]).map((row) => [row.user_id, row.display_name || 'Spirit']));
		output.push({
			id: season.id, name: season.name, startsAt: season.starts_at, endsAt: season.ends_at,
			rulesVersion: season.rules_version,
			entries: ((snapshots.data ?? []) as any[]).map((row) => ({
				position: Number(row.leaderboard_position), displayName: names.get(row.user_id) ?? 'Spirit',
				division: row.division_key, finalOrdinal: Math.round(Number(row.final_ordinal) * 100) / 100,
				peakOrdinal: Math.round(Number(row.peak_ordinal) * 100) / 100,
				rewardItemIds: row.reward_item_ids ?? []
			}))
		});
	}
	return { seasons: output };
}

export async function concedeRanked(roomCode: string, userId: string) {
	const db = admin();
	const normalized = roomCode.trim().toUpperCase();
	if (!/^[A-Z0-9]{6}$/.test(normalized)) throw kitError(404, 'Ranked match not found.');
	const session = await db.from('play_game_sessions').select('id,status,mode,ranked_season_id')
		.eq('room_code', normalized).maybeSingle();
	if (session.error || !session.data) throw kitError(404, 'Ranked match not found.');
	const result = await db.rpc('concede_ranked_member', { p_session_id: session.data.id, p_user_id: userId });
	if (result.error) throw kitError(409, 'This ranked seat cannot be conceded now.');
	return { conceded: true };
}

export { DEFAULT_MU, DEFAULT_SIGMA };
