/**
 * Supabase client for Arc Spirits Spectate app
 * Configured with realtime support for live game updates
 */

import {
	createClient,
	type RealtimeChannel,
	type RealtimePostgresChangesPayload
} from '@supabase/supabase-js';
import type {
	BagsData,
	CharacterOccurrenceRow,
	CharacterStatsRow,
	ClassTrait,
	CompositionTagOccurrenceRow,
	CompositionTagStatsRow,
	GameNotes,
	GameSnapshot,
	GameSnapshotRow,
	GameSummaryRow,
	GameResultRow,
	GameLocationAsset,
	GameLocationRewardRow,
	FavoriteSpiritEntry,
	GuardianAsset,
	HandDrawSnapshot,
	HexSpiritAsset,
	IconPoolEntry,
	LeaderboardEntryRow,
	RatingLeaderboardRow,
	MonsterAsset,
	CustomDiceAsset,
	CustomDiceSideAsset,
	OriginTrait,
	PlayerFeedback,
	PlayerBarrierTotalsRow,
	PlayerBloodTotalsRow,
	PlayerDiceEntry,
	PlayerFavoriteSpiritsRow,
	PlayerStatsRow,
	MatAsset,
	MatSlotSnapshot,
	SpiritAugmentAttachment,
	Spirit,
	TraitOccurrenceRow,
	TraitStatsRow
} from './types';
import { env as publicEnv } from '$env/dynamic/public';

const PUBLIC_SUPABASE_URL = publicEnv.PUBLIC_SUPABASE_URL || 'https://unconfigured.invalid';
const PUBLIC_SUPABASE_ANON_KEY = publicEnv.PUBLIC_SUPABASE_ANON_KEY || 'unconfigured-public-anon-key';

// Schema names
export const SCHEMA = 'arc_spirits_game'; // Game state data
export const ASSETS_SCHEMA = 'arc_spirits_assets'; // Static assets (spirits, guardians, etc.)

// Export the Supabase URL for use in other modules
export const SUPABASE_URL = PUBLIC_SUPABASE_URL;

// Supabase storage bucket base URL (bucket is 'game_assets')
export const STORAGE_BASE_URL = `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/game_assets`;

// Table names
export const TABLES = {
	GAME_STATE_SNAPSHOTS: 'game_state_snapshots',
	GAME_NOTES: 'game_notes',
	PLAYER_FEEDBACK: 'player_feedback',
	VERIFIED_GAMES: 'verified_games',
	GAME_SUMMARIES: 'game_summaries',
	GAME_RESULTS_ALL: 'game_results_all',
	GAME_RESULTS_VERIFIED: 'game_results_verified',
	LEADERBOARD_ENTRIES_VERIFIED: 'leaderboard_entries_verified',
	PLAYER_RATINGS_LEADERBOARD: 'player_ratings_leaderboard',
	PLAYER_MATCH_RESULTS: 'player_match_results',
	PLAYER_STATS_VERIFIED: 'player_stats_verified',
	PLAYER_FAVORITE_SPIRITS_VERIFIED: 'player_favorite_spirits_verified',
	PLAYER_FAVORITE_SPIRITS_BY_KEY: 'player_favorite_spirits_by_key',
	PLAYER_BARRIER_TOTALS_VERIFIED: 'player_barrier_totals_verified',
	PLAYER_BARRIER_TOTALS_BY_KEY: 'player_barrier_totals_by_key',
	PLAYER_BLOOD_TOTALS_VERIFIED: 'player_blood_totals_verified',
	PLAYER_BLOOD_TOTALS_BY_KEY: 'player_blood_totals_by_key',
	COMPOSITION_TAG_STATS_VERIFIED: 'composition_tag_stats_verified',
	COMPOSITION_TAG_OCCURRENCES_VERIFIED: 'composition_tag_occurrences_verified',
	CHARACTER_STATS_VERIFIED: 'character_stats_verified',
	CHARACTER_OCCURRENCES_VERIFIED: 'character_occurrences_verified',
	TRAIT_STATS_VERIFIED: 'trait_stats_exact_verified',
	TRAIT_OCCURRENCES_VERIFIED: 'trait_occurrences_verified',
	HEX_SPIRITS: 'hex_spirits',
	MAT_ITEMS: 'mat_items',
	MONSTERS: 'monsters_v2',
	GUARDIANS: 'guardians',
	CLASSES: 'classes',
	ORIGINS: 'origins',
	ICON_POOL: 'icon_pool',
	CUSTOM_DICE: 'custom_dice',
	DICE_SIDES: 'dice_sides',
	GAME_LOCATIONS: 'game_locations',
	// Reward rows were reworked out of the game_locations.reward_rows jsonb into their
	// own records (game_location_rows) assigned to a location + slot (reward_row_assignments).
	GAME_LOCATION_ROWS: 'game_location_rows',
	REWARD_ROW_ASSIGNMENTS: 'reward_row_assignments',
	EDITIONS: 'editions'
} as const;

// Create the Supabase client for game state (arc_spirits_game schema)
export const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
	db: {
		schema: SCHEMA
	},
	realtime: {
		params: {
			eventsPerSecond: 10
		}
	},
	auth: {
		// Data/realtime only — never the user session. A distinct storageKey keeps this
		// GoTrue instance from clobbering the @supabase/ssr auth client's session cookie
		// (which otherwise triggers "Multiple GoTrueClient instances" + sign-out bugs).
		persistSession: false,
		autoRefreshToken: false,
		storageKey: 'arc-data-anon'
	}
});

// Create a separate client for static assets (arc_spirits_assets schema)
export const supabaseAssets = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
	db: {
		schema: ASSETS_SCHEMA
	},
	auth: {
		persistSession: false,
		autoRefreshToken: false,
		storageKey: 'arc-assets-anon'
	}
});

// Store active channels for cleanup
const activeChannels = new Map<string, RealtimeChannel>();

/**
 * Parse a JSONB column that arrives either already-decoded or as a raw string.
 * A genuinely absent value (`null`) is normalized to `empty` — the caller's
 * legitimate "no rows yet" default. A malformed JSON string is NOT masked: it
 * signals corrupt data, so we throw rather than silently substitute a default.
 */
function parseJsonColumn<T>(value: string | T | null, empty: T): T {
	if (value == null) return empty;
	if (typeof value !== 'string') return value;
	return JSON.parse(value) as T;
}

// Payload type for realtime postgres changes
export type RealtimePayload = RealtimePostgresChangesPayload<GameSnapshotRow>;

// Helper to subscribe to game state changes
export function subscribeToGame(
	gameId: string,
	onInsert: (payload: RealtimePayload) => void,
	onUpdate?: (payload: RealtimePayload) => void
): RealtimeChannel {
	// Unsubscribe from existing channel if present
	unsubscribeFromGame(gameId);

	const channelName = `game:${gameId}`;
	const channel = supabase.channel(channelName);

	// Listen for INSERT events (new snapshots)
	channel.on(
		'postgres_changes',
		{
			event: 'INSERT',
			schema: SCHEMA,
			table: TABLES.GAME_STATE_SNAPSHOTS,
			filter: `game_id=eq.${gameId}`
		},
		(payload) => {
			console.log('[Realtime] INSERT received:', payload);
			onInsert(payload as RealtimePayload);
		}
	);

	// Listen for UPDATE events (modified snapshots)
	if (onUpdate) {
		channel.on(
			'postgres_changes',
			{
				event: 'UPDATE',
				schema: SCHEMA,
				table: TABLES.GAME_STATE_SNAPSHOTS,
				filter: `game_id=eq.${gameId}`
			},
			(payload) => {
				console.log('[Realtime] UPDATE received:', payload);
				onUpdate(payload as RealtimePayload);
			}
		);
	}

	// Subscribe and track the channel
	channel.subscribe((status) => {
		console.log(`[Realtime] Channel ${channelName} status:`, status);
		if (status === 'SUBSCRIBED') {
			console.log(`[Realtime] Successfully subscribed to game ${gameId}`);
		}
	});

	activeChannels.set(gameId, channel);

	return channel;
}

// Helper to unsubscribe from a game channel
export function unsubscribeFromGame(gameId: string): void {
	const channel = activeChannels.get(gameId);
	if (channel) {
		console.log(`[Realtime] Unsubscribing from game ${gameId}`);
		supabase.removeChannel(channel);
		activeChannels.delete(gameId);
	}
}

// Cleanup all active channels
export function unsubscribeAll(): void {
	for (const [gameId, channel] of activeChannels) {
		console.log(`[Realtime] Unsubscribing from game ${gameId}`);
		supabase.removeChannel(channel);
	}
	activeChannels.clear();
}

// ============ Game Snapshot Functions ============

export function unwrapGameSnapshotRow(row: GameSnapshotRow): GameSnapshot {
	return {
		id: row.id,
		game_id: row.game_id,
		navigation_count: row.navigation_count,
		game_timestamp: row.game_timestamp,
		scenario: parseJsonColumn<GameSnapshot['scenario']>(row.scenario, null),
		player_color: row.player_color,
		selected_character: row.selected_character,
		blood: row.blood,
		victory_points: row.victory_points,
		barrier: row.barrier,
		max_tokens: row.max_tokens ?? 4,
		status_level: row.status_level,
		status_token: row.status_token,
		spirits: parseJsonColumn<Spirit[]>(row.spirits, []),
		mats: parseJsonColumn<MatSlotSnapshot[]>(row.mats, []),
		hand_draws: parseJsonColumn<HandDrawSnapshot[]>(row.hand_draws, []),
		bags: parseJsonColumn<BagsData>(row.bags, {}),
		tts_username: row.tts_username ?? null,
		navigation_destination: row.navigation_destination ?? null,
		spirit_augment_attachments: parseJsonColumn<SpiritAugmentAttachment[]>(
			row.spirit_augment_attachments,
			[]
		),
		dice: parseJsonColumn<PlayerDiceEntry[]>(row.dice, []),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

export async function fetchGameSnapshotsForRound(
	gameId: string,
	navCount: number
): Promise<GameSnapshot[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.GAME_STATE_SNAPSHOTS)
		.select('*')
		.eq('game_id', gameId)
		.eq('navigation_count', navCount)
		.order('player_color');

	if (fetchError) {
		throw new Error(`Failed to fetch snapshots: ${fetchError.message}`);
	}

	return ((data as GameSnapshotRow[] | null) ?? []).map(unwrapGameSnapshotRow);
}

export async function fetchMaxNavigationCount(gameId: string): Promise<number> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.GAME_STATE_SNAPSHOTS)
		.select('navigation_count')
		.eq('game_id', gameId)
		.order('navigation_count', { ascending: false })
		.limit(1)
		.single();

	if (fetchError) {
		// No rows found is not an error, just return 0
		if (fetchError.code === 'PGRST116') {
			return 0;
		}
		throw new Error(`Failed to fetch max navigation: ${fetchError.message}`);
	}

	return data?.navigation_count ?? 0;
}

export async function fetchAllGameSnapshots(gameId: string): Promise<GameSnapshot[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.GAME_STATE_SNAPSHOTS)
		.select('*')
		.eq('game_id', gameId)
		.order('navigation_count')
		.order('player_color');

	if (fetchError) {
		throw new Error(`Failed to fetch game snapshots: ${fetchError.message}`);
	}

	return ((data as GameSnapshotRow[] | null) ?? []).map(unwrapGameSnapshotRow);
}

export type GameListSnapshotRow = Pick<
	GameSnapshotRow,
	| 'game_id'
	| 'game_timestamp'
	| 'navigation_count'
	| 'player_color'
	| 'selected_character'
	| 'victory_points'
	| 'created_at'
>;

export async function fetchGameListSnapshotRows(): Promise<GameListSnapshotRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.GAME_STATE_SNAPSHOTS)
		.select(
			'game_id, game_timestamp, navigation_count, player_color, selected_character, victory_points, created_at'
		)
		.order('created_at', { ascending: false });

	if (fetchError) {
		throw new Error(`Failed to fetch game list snapshots: ${fetchError.message}`);
	}

	return (data as GameListSnapshotRow[] | null) ?? [];
}

export type LeaderboardSnapshotRow = Pick<
	GameSnapshotRow,
	| 'game_id'
	| 'tts_username'
	| 'player_color'
	| 'selected_character'
	| 'victory_points'
	| 'navigation_count'
	| 'created_at'
>;

export async function fetchLeaderboardSnapshotRows(): Promise<LeaderboardSnapshotRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.GAME_STATE_SNAPSHOTS)
		.select(
			'game_id, tts_username, player_color, selected_character, victory_points, navigation_count, created_at'
		);

	if (fetchError) {
		throw new Error(`Failed to fetch leaderboard snapshots: ${fetchError.message}`);
	}

	return (data as LeaderboardSnapshotRow[] | null) ?? [];
}

export async function fetchGameSummaries(): Promise<GameSummaryRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.GAME_SUMMARIES)
		.select(
			'game_id, verified, verified_at, verified_by, started_at, ended_at, navigation_count, player_count, avg_navigation_ms, winner_guardian, winner_vp'
		)
		.order('ended_at', { ascending: false });

	if (fetchError) {
		throw new Error(`Failed to fetch game summaries: ${fetchError.message}`);
	}

	return (data as GameSummaryRow[] | null) ?? [];
}

export async function fetchLeaderboardEntriesVerified(): Promise<LeaderboardEntryRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.LEADERBOARD_ENTRIES_VERIFIED)
		.select('username, games_played, avg_points, avg_placement, last_games');

	if (fetchError) {
		throw new Error(`Failed to fetch leaderboard: ${fetchError.message}`);
	}

	return (data as LeaderboardEntryRow[] | null) ?? [];
}

export async function fetchRatingLeaderboard(): Promise<RatingLeaderboardRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_RATINGS_LEADERBOARD)
		.select(
			'username, username_key, games_played, wins, win_rate, avg_victory_points, avg_placement, mu, sigma, ordinal, last_game_at, last_games'
		);

	if (fetchError) {
		throw new Error(`Failed to fetch rating leaderboard: ${fetchError.message}`);
	}

	return (data as RatingLeaderboardRow[] | null) ?? [];
}

/** One row of the NEW 2D ranked leaderboard (arc_spirits_2d.player_ratings). */
export interface Rating2DRow {
	userId: string;
	displayName: string;
	mu: number;
	sigma: number;
	gamesPlayed: number;
	/** Conservative skill estimate (openskill ordinal = mu - 3*sigma), for ranking + display. */
	ordinal: number;
}

/**
 * Fetch the 2D ranked leaderboard from arc_spirits_2d.player_ratings (anon read).
 * Ordered by the conservative rating (ordinal = mu - 3·sigma) descending. Distinct
 * from the TTS {@link fetchRatingLeaderboard}; the 2D ratings are user_id-keyed.
 */
export async function fetch2DRatingLeaderboard(): Promise<Rating2DRow[]> {
	const { data, error: fetchError } = await supabase
		.schema('arc_spirits_2d')
		.from('player_ratings')
		.select('user_id, display_name, mu, sigma, games_played');

	if (fetchError) {
		throw new Error(`Failed to fetch 2D rating leaderboard: ${fetchError.message}`);
	}

	const rows = (data as
		| { user_id: string; display_name: string | null; mu: number; sigma: number; games_played: number }[]
		| null) ?? [];

	return rows
		.map((r) => ({
			userId: r.user_id,
			displayName: r.display_name ?? 'Player',
			mu: r.mu,
			sigma: r.sigma,
			gamesPlayed: r.games_played,
			// Conservative rating (matches openskill's default ordinal: mu - 3*sigma).
			ordinal: r.mu - 3 * r.sigma
		}))
		.sort((a, b) => b.ordinal - a.ordinal);
}

/** The current 2D rating for a single user (arc_spirits_2d.player_ratings), or null
 *  if they have no rated games yet. */
export async function fetchMy2DRating(userId: string): Promise<Rating2DRow | null> {
	const { data, error: fetchError } = await supabase
		.schema('arc_spirits_2d')
		.from('player_ratings')
		.select('user_id, display_name, mu, sigma, games_played')
		.eq('user_id', userId)
		.maybeSingle();

	if (fetchError) throw new Error(`Failed to fetch 2D rating: ${fetchError.message}`);
	if (!data) return null;

	const r = data as { user_id: string; display_name: string | null; mu: number; sigma: number; games_played: number };
	return {
		userId: r.user_id,
		displayName: r.display_name ?? 'Player',
		mu: r.mu,
		sigma: r.sigma,
		gamesPlayed: r.games_played,
		ordinal: r.mu - 3 * r.sigma
	};
}

/** One finished 2D match from a player's perspective (for the profile "Past games" list). */
export interface MatchHistoryEntry {
	sessionId: string;
	endedAt: string;
	mode: string;
	ranked: boolean;
	rated: boolean;
	playerCount: number;
	winnerSeat: string | null;
	mySeat: string;
	myPlacement: number;
	myVictoryPoints: number;
	didWin: boolean;
	/** Conservative-rating change (ordinal after − before) for ranked/rated games; null otherwise. */
	ratingDelta: number | null;
	/** The other seats in the match, best placement first. */
	opponents: { displayName: string; placement: number; isBot: boolean }[];
}

/**
 * A player's recent finished 2D matches (arc_spirits_2d), newest first. Joins the
 * per-seat standings to the canonical result for date/mode, attaches the other
 * seats as opponents, and (for ranked games) the OpenSkill ordinal delta. All
 * tables are anon-readable, so this runs on the data-only client filtered by uid.
 */
export async function fetchMyMatchHistory(userId: string, limit = 25): Promise<MatchHistoryEntry[]> {
	const db = supabase.schema('arc_spirits_2d');

	// 1) My seat in each match + the canonical result (embedded via the session_id FK).
	const mineRes = await db
		.from('match_result_players')
		.select(
			'session_id, seat_color, placement, victory_points, match_results!inner(mode, ranked, rated, player_count, winner_seat, ended_at)'
		)
		.eq('user_id', userId)
		.order('ended_at', { ascending: false, foreignTable: 'match_results' })
		.limit(limit);
	if (mineRes.error) throw new Error(`Failed to fetch match history: ${mineRes.error.message}`);

	type Embedded = {
		mode: string;
		ranked: boolean;
		rated: boolean;
		player_count: number;
		winner_seat: string | null;
		ended_at: string;
	};
	type MineRow = {
		session_id: string;
		seat_color: string;
		placement: number;
		victory_points: number;
		// PostgREST returns an embedded to-one as an object; type it permissively.
		match_results: Embedded | Embedded[];
	};
	const mine = (mineRes.data as MineRow[] | null) ?? [];
	if (mine.length === 0) return [];

	const sessionIds = mine.map((m) => m.session_id);

	// 2) All seats for those sessions (opponents) + 3) my rating events, in parallel.
	const [playersRes, eventsRes] = await Promise.all([
		db
			.from('match_result_players')
			.select('session_id, display_name, placement, is_bot, user_id')
			.in('session_id', sessionIds),
		db
			.from('player_rating_events')
			.select('session_id, mu_before, sigma_before, mu_after, sigma_after')
			.eq('user_id', userId)
			.in('session_id', sessionIds)
	]);
	if (playersRes.error) throw new Error(`Failed to fetch match opponents: ${playersRes.error.message}`);

	const bySession = new Map<string, { displayName: string; placement: number; isBot: boolean; userId: string | null }[]>();
	for (const p of (playersRes.data as
		| { session_id: string; display_name: string | null; placement: number; is_bot: boolean; user_id: string | null }[]
		| null) ?? []) {
		const list = bySession.get(p.session_id) ?? [];
		list.push({ displayName: p.display_name ?? 'Player', placement: p.placement, isBot: p.is_bot, userId: p.user_id });
		bySession.set(p.session_id, list);
	}

	const deltaBySession = new Map<string, number>();
	for (const e of (eventsRes.data as
		| { session_id: string; mu_before: number; sigma_before: number; mu_after: number; sigma_after: number }[]
		| null) ?? []) {
		const before = e.mu_before - 3 * e.sigma_before;
		const after = e.mu_after - 3 * e.sigma_after;
		deltaBySession.set(e.session_id, after - before);
	}

	return mine.map((m) => {
		const res = (Array.isArray(m.match_results) ? m.match_results[0] : m.match_results) as Embedded;
		const opponents = (bySession.get(m.session_id) ?? [])
			.filter((p) => p.userId !== userId)
			.sort((a, b) => a.placement - b.placement)
			.map(({ displayName, placement, isBot }) => ({ displayName, placement, isBot }));
		return {
			sessionId: m.session_id,
			endedAt: res.ended_at,
			mode: res.mode,
			ranked: res.ranked,
			rated: res.rated,
			playerCount: res.player_count,
			winnerSeat: res.winner_seat,
			mySeat: m.seat_color,
			myPlacement: m.placement,
			myVictoryPoints: m.victory_points,
			didWin: m.placement === 1,
			ratingDelta: deltaBySession.get(m.session_id) ?? null,
			opponents
		};
	});
}

export async function fetchRatingLeaderboardByUsernameKey(
	usernameKey: string
): Promise<RatingLeaderboardRow | null> {
	const normalized = usernameKey.trim().toLowerCase();
	if (!normalized) return null;

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_RATINGS_LEADERBOARD)
		.select(
			'username, username_key, games_played, wins, win_rate, avg_victory_points, avg_placement, mu, sigma, ordinal, last_game_at, last_games'
		)
		.eq('username_key', normalized)
		.limit(1)
		.maybeSingle();

	if (fetchError) {
		throw new Error(`Failed to fetch rating profile: ${fetchError.message}`);
	}

	return (data as RatingLeaderboardRow | null) ?? null;
}

export async function fetchPlayerMatchResultsByUsernameKey(usernameKey: string): Promise<GameResultRow[]> {
	const normalized = usernameKey.trim().toLowerCase();
	if (!normalized) return [];

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_MATCH_RESULTS)
		.select(
			'game_id, verified, started_at, ended_at, navigation_count, player_color, username, raw_username, selected_character, victory_points, placement, player_count'
		)
		.eq('username_key', normalized)
		.order('ended_at', { ascending: false, nullsFirst: false })
		.order('game_id', { ascending: false });

	if (fetchError) {
		throw new Error(`Failed to fetch player matches: ${fetchError.message}`);
	}

	return (data as GameResultRow[] | null) ?? [];
}

export async function fetchPlayerFavoriteSpiritsByUsernameKey(
	usernameKey: string
): Promise<FavoriteSpiritEntry[]> {
	const normalized = usernameKey.trim().toLowerCase();
	if (!normalized) return [];

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_FAVORITE_SPIRITS_BY_KEY)
		.select('favorites')
		.eq('username_key', normalized)
		.limit(1)
		.maybeSingle();

	if (fetchError) {
		throw new Error(`Failed to fetch favorite spirits: ${fetchError.message}`);
	}

	const favoritesRaw = (data as Pick<PlayerFavoriteSpiritsRow, 'favorites'> | null)?.favorites ?? [];
	return parseJsonColumn<FavoriteSpiritEntry[]>(favoritesRaw, []);
}

export async function fetchPlayerBarrierTotalsByUsernameKey(
	usernameKey: string
): Promise<{ gained: number; lost: number } | null> {
	const normalized = usernameKey.trim().toLowerCase();
	if (!normalized) return null;

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_BARRIER_TOTALS_BY_KEY)
		.select('barrier_gained, barrier_lost')
		.eq('username_key', normalized)
		.limit(1)
		.maybeSingle();

	if (fetchError) {
		throw new Error(`Failed to fetch barrier totals: ${fetchError.message}`);
	}

	const row = (data as Omit<PlayerBarrierTotalsRow, 'username'> | null) ?? null;
	if (!row) return null;

	return {
		gained: Number(row.barrier_gained ?? 0),
		lost: Number(row.barrier_lost ?? 0)
	};
}

export async function fetchPlayerBloodTotalsByUsernameKey(
	usernameKey: string
): Promise<{ gained: number; spent: number } | null> {
	const normalized = usernameKey.trim().toLowerCase();
	if (!normalized) return null;

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_BLOOD_TOTALS_BY_KEY)
		.select('blood_gained, blood_spent')
		.eq('username_key', normalized)
		.limit(1)
		.maybeSingle();

	if (fetchError) {
		throw new Error(`Failed to fetch blood totals: ${fetchError.message}`);
	}

	const row = (data as Omit<PlayerBloodTotalsRow, 'username'> | null) ?? null;
	if (!row) return null;

	return {
		gained: Number(row.blood_gained ?? 0),
		spent: Number(row.blood_spent ?? 0)
	};
}

export async function fetchPlayerStatsVerified(): Promise<PlayerStatsRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_STATS_VERIFIED)
		.select(
			'username, games_played, wins, win_rate, avg_victory_points, avg_placement, best_victory_points, best_placement, first_game_at, last_game_at'
		);

	if (fetchError) {
		throw new Error(`Failed to fetch player stats: ${fetchError.message}`);
	}

	return (data as PlayerStatsRow[] | null) ?? [];
}

export async function fetchPlayerStatsVerifiedByUsername(
	username: string
): Promise<PlayerStatsRow | null> {
	const normalized = username.trim();
	if (!normalized) return null;

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_STATS_VERIFIED)
		.select(
			'username, games_played, wins, win_rate, avg_victory_points, avg_placement, best_victory_points, best_placement, first_game_at, last_game_at'
		)
		.eq('username', normalized)
		.limit(1);

	if (fetchError) {
		throw new Error(`Failed to fetch player stats: ${fetchError.message}`);
	}

	return (data as PlayerStatsRow[] | null)?.[0] ?? null;
}

export async function fetchGameResultsVerifiedForUsername(
	username: string
): Promise<GameResultRow[]> {
	const normalized = username.trim();
	if (!normalized) return [];

	const { data, error: fetchError } = await supabase
		.from(TABLES.GAME_RESULTS_VERIFIED)
		.select(
			'game_id, verified, started_at, ended_at, navigation_count, player_color, username, raw_username, selected_character, victory_points, placement, player_count'
		)
		.eq('username', normalized)
		.order('ended_at', { ascending: false });

	if (fetchError) {
		throw new Error(`Failed to fetch player games: ${fetchError.message}`);
	}

	return (data as GameResultRow[] | null) ?? [];
}

export async function fetchPlayerFavoriteSpiritsVerified(
	username: string
): Promise<FavoriteSpiritEntry[]> {
	const normalized = username.trim();
	if (!normalized) return [];

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_FAVORITE_SPIRITS_VERIFIED)
		.select('username, favorites')
		.eq('username', normalized)
		.limit(1);

	if (fetchError) {
		throw new Error(`Failed to fetch favorite spirits: ${fetchError.message}`);
	}

	const row = (data as PlayerFavoriteSpiritsRow[] | null)?.[0] ?? null;
	const favoritesRaw = row?.favorites ?? [];
	return parseJsonColumn<FavoriteSpiritEntry[]>(favoritesRaw, []);
}

export async function fetchPlayerBarrierTotalsVerified(
	username: string
): Promise<{ gained: number; lost: number } | null> {
	const normalized = username.trim();
	if (!normalized) return null;

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_BARRIER_TOTALS_VERIFIED)
		.select('username, barrier_gained, barrier_lost')
		.eq('username', normalized)
		.limit(1);

	if (fetchError) {
		throw new Error(`Failed to fetch barrier totals: ${fetchError.message}`);
	}

	const row = (data as PlayerBarrierTotalsRow[] | null)?.[0] ?? null;
	if (!row) return null;

	return {
		gained: Number(row.barrier_gained ?? 0),
		lost: Number(row.barrier_lost ?? 0)
	};
}

export async function fetchPlayerBloodTotalsVerified(
	username: string
): Promise<{ gained: number; spent: number } | null> {
	const normalized = username.trim();
	if (!normalized) return null;

	const { data, error: fetchError } = await supabase
		.from(TABLES.PLAYER_BLOOD_TOTALS_VERIFIED)
		.select('username, blood_gained, blood_spent')
		.eq('username', normalized)
		.limit(1);

	if (fetchError) {
		throw new Error(`Failed to fetch blood totals: ${fetchError.message}`);
	}

	const row = (data as PlayerBloodTotalsRow[] | null)?.[0] ?? null;
	if (!row) return null;

	return {
		gained: Number(row.blood_gained ?? 0),
		spent: Number(row.blood_spent ?? 0)
	};
}

export async function fetchCompositionTagStatsVerified(): Promise<CompositionTagStatsRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.COMPOSITION_TAG_STATS_VERIFIED)
		.select('tag, tagged_players, games, avg_victory_points, avg_placement');

	if (fetchError) {
		throw new Error(`Failed to fetch tag stats: ${fetchError.message}`);
	}

	return (data as CompositionTagStatsRow[] | null) ?? [];
}

export async function fetchCompositionTagOccurrencesVerified(params: {
	tag: string;
	limit?: number;
}): Promise<CompositionTagOccurrenceRow[]> {
	const tag = params.tag.trim().toLowerCase().replace(/\s+/g, ' ');
	if (!tag) return [];

	const { data, error: fetchError } = await supabase
		.from(TABLES.COMPOSITION_TAG_OCCURRENCES_VERIFIED)
		.select(
			'tag, game_id, player_color, username, raw_username, selected_character, victory_points, placement, player_count, navigation_count, ended_at'
		)
		.eq('tag', tag)
		.order('ended_at', { ascending: false, nullsFirst: false })
		.order('game_id', { ascending: false })
		.limit(params.limit ?? 25);

	if (fetchError) {
		throw new Error(`Failed to fetch tag games: ${fetchError.message}`);
	}

	return (data as CompositionTagOccurrenceRow[] | null) ?? [];
}

export async function fetchCharacterStatsVerified(): Promise<CharacterStatsRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.CHARACTER_STATS_VERIFIED)
		.select('character, games_played, wins, avg_victory_points, avg_placement');

	if (fetchError) {
		throw new Error(`Failed to fetch character stats: ${fetchError.message}`);
	}

	return (data as CharacterStatsRow[] | null) ?? [];
}

export async function fetchCharacterOccurrencesVerified(params: {
	character: string;
	limit?: number;
}): Promise<CharacterOccurrenceRow[]> {
	const character = params.character.trim();
	if (!character) return [];

	const { data, error: fetchError } = await supabase
		.from(TABLES.CHARACTER_OCCURRENCES_VERIFIED)
		.select(
			'character, game_id, player_color, username, raw_username, victory_points, placement, player_count, navigation_count, ended_at'
		)
		.eq('character', character)
		.order('ended_at', { ascending: false, nullsFirst: false })
		.order('game_id', { ascending: false })
		.limit(params.limit ?? 25);

	if (fetchError) {
		throw new Error(`Failed to fetch character games: ${fetchError.message}`);
	}

	return (data as CharacterOccurrenceRow[] | null) ?? [];
}

export async function fetchTraitStatsVerified(): Promise<TraitStatsRow[]> {
	const { data, error: fetchError } = await supabase
		.from(TABLES.TRAIT_STATS_VERIFIED)
		.select(
			'trait_type, trait_key, trait_name, trait_count, players, games, avg_victory_points, avg_placement, wins, example_game_id, example_player_color, example_round'
		);

	if (fetchError) {
		throw new Error(`Failed to fetch trait stats: ${fetchError.message}`);
	}

	return (data as TraitStatsRow[] | null) ?? [];
}

export async function fetchTraitOccurrencesVerified(params: {
	traitType: 'class' | 'origin';
	traitKey: string;
	traitCount: number;
	limit?: number;
}): Promise<TraitOccurrenceRow[]> {
	const traitKey = params.traitKey.trim().toLowerCase();
	const traitCount = params.traitCount;
	if (!traitKey) return [];
	if (!Number.isFinite(traitCount) || traitCount <= 0) return [];

	const { data, error: fetchError } = await supabase
		.from(TABLES.TRAIT_OCCURRENCES_VERIFIED)
		.select(
			'trait_type, trait_key, trait_name, trait_count, game_id, player_color, username, raw_username, selected_character, victory_points, placement, player_count, navigation_count, ended_at'
		)
		.eq('trait_type', params.traitType)
		.eq('trait_key', traitKey)
		.eq('trait_count', traitCount)
		.order('ended_at', { ascending: false, nullsFirst: false })
		.order('game_id', { ascending: false })
		.limit(params.limit ?? 25);

	if (fetchError) {
		throw new Error(`Failed to fetch trait games: ${fetchError.message}`);
	}

	return (data as TraitOccurrenceRow[] | null) ?? [];
}

// Aggregate of every static-asset table the play engine needs. Exported so the
// pure catalog builder and its tests can type fixtures without re-deriving it.
export interface AssetsData {
	spirits: HexSpiritAsset[];
	mats: MatAsset[];
	customDice: CustomDiceAsset[];
	monsters: MonsterAsset[];
	statusIcons: IconPoolEntry[];
	iconPool: IconPoolEntry[];
	gameLocations: GameLocationAsset[];
	guardians: GuardianAsset[];
	classes: ClassTrait[];
	origins: OriginTrait[];
	/** Per-cost bag copy-counts from the Complete edition (`editions.cost_duplicates`). */
	costDuplicates: Record<string, number> | null;
}

export async function fetchAssetsData(): Promise<AssetsData> {
	const [
		spiritsResult,
		matsResult,
		customDiceResult,
		customDiceSidesResult,
		monstersResult,
		statusIconsResult,
		iconPoolResult,
		gameLocationsResult,
		guardiansResult,
		classesResult,
		originsResult,
		editionsResult,
		rewardRowAssignmentsResult,
		gameLocationRowsResult
	] = await Promise.all([
		supabaseAssets
			.from(TABLES.HEX_SPIRITS)
			.select('id, name, cost, traits, awaken_condition, game_print_image_path, art_raw_image_path'),
		supabaseAssets.from(TABLES.MAT_ITEMS).select('id, name, origin_id, icon_path'),
		supabaseAssets
			.from(TABLES.CUSTOM_DICE)
			.select(
				'id, name, description, color, dice_type, background_image_path, template_image_path, exported_template_path'
			),
		supabaseAssets
			.from(TABLES.DICE_SIDES)
			.select(
				'id, dice_id, side_number, reward_type, reward_value, reward_description, image_path, template_x, template_y'
			),
		supabaseAssets
			.from(TABLES.MONSTERS)
			.select('id, name, stage, order_num, damage, barrier, card_image_path, reward_track, dice_pool, choose_amount'),
		supabaseAssets
			.from(TABLES.ICON_POOL)
			.select('id, name, file_path, tags')
			.contains('tags', ['status']),
		supabaseAssets.from(TABLES.ICON_POOL).select('id, name, file_path, tags'),
		supabaseAssets
			.from(TABLES.GAME_LOCATIONS)
			.select('id, name, origin_id, background_image_path'),
		supabaseAssets
			.from(TABLES.GUARDIANS)
			.select('id, name, origin_id, icon_image_path, image_mat_path, chibi_image_path'),
		supabaseAssets.from(TABLES.CLASSES).select('id, name, position, icon_png, augment_token_path, color, description, effect_schema, footer, class_type, is_special'),
		supabaseAssets
			.from(TABLES.ORIGINS)
			.select('id, name, position, icon_png, icon_token_png, color, description, calling_card'),
		supabaseAssets.from(TABLES.EDITIONS).select('id, name, is_default, cost_duplicates'),
		// New reward-row model: assignments bind a row to a location at a slot (row_index).
		supabaseAssets.from(TABLES.REWARD_ROW_ASSIGNMENTS).select('location_id, row_id, row_index'),
		supabaseAssets.from(TABLES.GAME_LOCATION_ROWS).select('id, config')
	]);

	if (spiritsResult.error) throw spiritsResult.error;
	if (matsResult.error) throw matsResult.error;
	if (customDiceResult.error) throw customDiceResult.error;
	if (customDiceSidesResult.error) throw customDiceSidesResult.error;
	if (monstersResult.error) throw monstersResult.error;
	if (statusIconsResult.error) throw statusIconsResult.error;
	if (iconPoolResult.error) throw iconPoolResult.error;
	if (gameLocationsResult.error) throw gameLocationsResult.error;
	if (guardiansResult.error) throw guardiansResult.error;
	if (classesResult.error) throw classesResult.error;
	if (originsResult.error) throw originsResult.error;

	const customDiceSides = (customDiceSidesResult.data as CustomDiceSideAsset[]) ?? [];
	const sidesByDiceId = new Map<string, CustomDiceSideAsset[]>();
	for (const side of customDiceSides) {
		const existing = sidesByDiceId.get(side.dice_id) ?? [];
		existing.push(side);
		sidesByDiceId.set(side.dice_id, existing);
	}
	for (const sides of sidesByDiceId.values()) {
		sides.sort((a, b) => a.side_number - b.side_number);
	}

	// Bag copy-counts come from the editions table. The Complete edition is the
	// canonical play set (the TTS export is fixed to it); fall back to the default
	// edition, then the first. A fetch error leaves it null → engine uses its
	// built-in default. Not fatal, so it isn't thrown above.
	const editions =
		(editionsResult.data as
			| { name: string; is_default: boolean; cost_duplicates: Record<string, number> | null }[]
			| null) ?? [];
	const playEdition =
		editions.find((e) => e.name?.toLowerCase() === 'complete') ??
		editions.find((e) => e.is_default) ??
		editions[0] ??
		null;

	// Reward rows live in their own records (game_location_rows), bound to a location
	// + slot via reward_row_assignments. Rebuild each location's ordered reward_rows
	// from that authoritative model. A fetch error here is surfaced, not swallowed —
	// the engine must see real interactions, never a stale/empty stand-in.
	if (rewardRowAssignmentsResult.error) throw rewardRowAssignmentsResult.error;
	if (gameLocationRowsResult.error) throw gameLocationRowsResult.error;
	const rawLocations = (gameLocationsResult.data as GameLocationAsset[]) ?? [];
	const assignments =
		(rewardRowAssignmentsResult.data as
			| { location_id: string; row_id: string; row_index: number | null }[]
			| null) ?? [];
	const rowConfigById = new Map<string, GameLocationRewardRow>();
	for (const row of (gameLocationRowsResult.data as { id: string; config: unknown }[] | null) ?? []) {
		if (row.config && typeof row.config === 'object') {
			rowConfigById.set(row.id, row.config as GameLocationRewardRow);
		}
	}
	const rewardRowsByLocation = new Map<string, GameLocationRewardRow[]>();
	for (const a of [...assignments].sort((x, y) => (x.row_index ?? 0) - (y.row_index ?? 0))) {
		const config = rowConfigById.get(a.row_id);
		if (!config) continue;
		const list = rewardRowsByLocation.get(a.location_id) ?? [];
		list.push(config);
		rewardRowsByLocation.set(a.location_id, list);
	}
	const gameLocations = rawLocations.map((loc) => ({
		...loc,
		reward_rows: rewardRowsByLocation.get(loc.id) ?? []
	}));

	return {
		spirits: (spiritsResult.data as HexSpiritAsset[]) ?? [],
		mats: (matsResult.data as MatAsset[]) ?? [],
		customDice: (((customDiceResult.data as Omit<CustomDiceAsset, 'sides'>[]) ?? []).map((die) => ({
			...die,
			sides: sidesByDiceId.get(die.id) ?? []
		})) as CustomDiceAsset[]) ?? [],
		monsters: (monstersResult.data as MonsterAsset[]) ?? [],
		statusIcons: (statusIconsResult.data as IconPoolEntry[]) ?? [],
		iconPool: (iconPoolResult.data as IconPoolEntry[]) ?? [],
		gameLocations,
		guardians: (guardiansResult.data as GuardianAsset[]) ?? [],
		classes: (classesResult.data as ClassTrait[]) ?? [],
		origins: (originsResult.data as OriginTrait[]) ?? [],
		costDuplicates: playEdition?.cost_duplicates ?? null
	};
}

// ============ Game Notes Functions ============

// Fetch game notes for a specific game (excludes host_secret)
export async function fetchGameNotes(gameId: string): Promise<GameNotes | null> {
	const { data, error } = await supabase
		.from(TABLES.GAME_NOTES)
		.select('id, game_id, summary, improvements, created_at, updated_at')
		.eq('game_id', gameId)
		.single();

	if (error || !data) {
		if (error?.code !== 'PGRST116') {
			// Not a "no rows" error
			console.error('[Supabase] Error fetching game notes:', error);
		}
		return null;
	}

	// Parse improvements JSONB
	const improvements = parseJsonColumn<string[] | null>(data.improvements, null);

	return {
		...data,
		improvements: improvements || []
	} as GameNotes;
}

export async function upsertGameNotes(params: {
	gameId: string;
	summary: string | null;
	improvements: string[];
}): Promise<void> {
	const { gameId, summary, improvements } = params;

	const { error: upsertError } = await supabase.from(TABLES.GAME_NOTES).upsert(
		{
			game_id: gameId,
			host_secret: 'env-validated',
			summary,
			improvements,
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'game_id' }
	);

	if (upsertError) {
		throw upsertError;
	}
}

// ============ Player Feedback Functions ============

// Fetch all player feedback for a specific game
export async function fetchPlayerFeedback(gameId: string): Promise<PlayerFeedback[]> {
	const { data, error } = await supabase
		.from(TABLES.PLAYER_FEEDBACK)
		.select('*')
		.eq('game_id', gameId)
		.order('created_at', { ascending: false });

	if (error) {
		console.error('[Supabase] Error fetching player feedback:', error);
		return [];
	}

	return data as PlayerFeedback[];
}

// Submit new player feedback
export async function submitPlayerFeedback(feedback: {
	gameId: string;
	playerName: string;
	feedbackText: string | null;
	ratingComplexity: number;
	ratingEnjoyment: number;
	ratingOthersEnjoyment: number;
}): Promise<{ success: boolean; message: string }> {
	const { error } = await supabase.from(TABLES.PLAYER_FEEDBACK).insert({
		game_id: feedback.gameId,
		player_name: feedback.playerName,
		feedback_text: feedback.feedbackText,
		rating_complexity: feedback.ratingComplexity,
		rating_enjoyment: feedback.ratingEnjoyment,
		rating_others_enjoyment: feedback.ratingOthersEnjoyment
	});

	if (error) {
		console.error('[Supabase] Error submitting player feedback:', error);
		return { success: false, message: error.message };
	}

	return { success: true, message: 'Feedback submitted successfully' };
}
