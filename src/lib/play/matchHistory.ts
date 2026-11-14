/**
 * A player's finished games, read from the minimal database: arc_spirits_2d.match_result_players
 * (one row per seat) joined to match_results (one row per game, FK session_id) — both are
 * anon-readable. Ratings are dropped, so no rating delta is read. Each entry carries the
 * game id so the replay can be opened (POST /api/play/replays → /replay/<code>).
 */
import { supabase } from '$lib/supabase';

export interface MatchHistoryEntry {
	sessionId: string;
	/** Engine game id (replay_frames key); null only for a record written without one. */
	gameId: string | null;
	endedAt: string;
	mode: string;
	playerCount: number;
	winnerSeat: string | null;
	mySeat: string;
	myPlacement: number;
	myVictoryPoints: number;
	didWin: boolean;
	/** The other seats in the match, best placement first. */
	opponents: { displayName: string; placement: number; isBot: boolean }[];
}

type ResultEmbed = {
	game_id: string | null;
	mode: string;
	player_count: number;
	winner_seat: string | null;
	ended_at: string;
};

type MineRow = {
	session_id: string;
	seat_color: string;
	placement: number;
	victory_points: number;
	match_results: ResultEmbed | ResultEmbed[];
};

function embedded(row: MineRow): ResultEmbed {
	return (Array.isArray(row.match_results) ? row.match_results[0] : row.match_results) as ResultEmbed;
}

/** Newest first, at most `limit` games. */
export async function fetchMyMatchHistory(userId: string, limit = 25): Promise<MatchHistoryEntry[]> {
	const db = supabase.schema('arc_spirits_2d');

	// `match_results(ended_at)` orders the PARENT rows by the to-one embed (the
	// `foreignTable` option would only order the embedded rows, so the limit would
	// keep an arbitrary set of games).
	const mineRes = await db
		.from('match_result_players')
		.select(
			'session_id, seat_color, placement, victory_points, match_results!inner(game_id, mode, player_count, winner_seat, ended_at)'
		)
		.eq('user_id', userId)
		.eq('is_bot', false)
		.order('match_results(ended_at)', { ascending: false })
		.limit(limit);
	if (mineRes.error) throw new Error(`Failed to fetch match history: ${mineRes.error.message}`);

	const mine = ((mineRes.data as MineRow[] | null) ?? []).slice();
	if (mine.length === 0) return [];
	mine.sort((a, b) => Date.parse(embedded(b).ended_at ?? '') - Date.parse(embedded(a).ended_at ?? ''));

	const playersRes = await db
		.from('match_result_players')
		.select('session_id, display_name, placement, is_bot, user_id')
		.in(
			'session_id',
			mine.map((m) => m.session_id)
		);
	if (playersRes.error) throw new Error(`Failed to fetch match opponents: ${playersRes.error.message}`);

	type PlayerRow = {
		session_id: string;
		display_name: string | null;
		placement: number;
		is_bot: boolean;
		user_id: string | null;
	};
	const bySession = new Map<string, PlayerRow[]>();
	for (const p of (playersRes.data as PlayerRow[] | null) ?? []) {
		const list = bySession.get(p.session_id) ?? [];
		list.push(p);
		bySession.set(p.session_id, list);
	}

	return mine.map((m) => {
		const res = embedded(m);
		const opponents = (bySession.get(m.session_id) ?? [])
			.filter((p) => p.user_id !== userId)
			.sort((a, b) => a.placement - b.placement)
			.map((p) => ({ displayName: p.display_name ?? 'Player', placement: p.placement, isBot: p.is_bot }));
		return {
			sessionId: m.session_id,
			gameId: res?.game_id ?? null,
			endedAt: res?.ended_at ?? '',
			mode: res?.mode ?? 'casual',
			playerCount: res?.player_count ?? opponents.length + 1,
			winnerSeat: res?.winner_seat ?? null,
			mySeat: m.seat_color,
			myPlacement: m.placement,
			myVictoryPoints: m.victory_points,
			didWin: m.placement === 1,
			opponents
		};
	});
}
