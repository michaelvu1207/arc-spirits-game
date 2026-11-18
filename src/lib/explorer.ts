import { env as publicEnv } from '$env/dynamic/public';
import { ARCANE_ABYSS_BAG, bagForSpiritCost } from '$lib/play/bags';
import { supabase } from '$lib/supabase';

/**
 * The local game explorer (scripts/local-game/start.mjs sets PUBLIC_ARC_LOCAL_EXPLORER=1):
 * /explorer shows the balance of the AI test games (Balance, Spirit World, Arcane Abyss, Heroes;
 * data: $lib/explorerBalance.ts) without the site chrome, and the data editor shows it in a
 * frame. The round-by-round game viewer is also served there (/explorer/game/<id>), for the
 * game's own "full replay" link. Unset (production, Vercel) nothing here changes behaviour:
 * /explorer answers 404 and the links below keep their values.
 */
export const LOCAL_EXPLORER = publicEnv.PUBLIC_ARC_LOCAL_EXPLORER === '1';

const enc = encodeURIComponent;

/**
 * Links from the records, leaderboard, player and game pages. The explorer no longer has
 * record, leaderboard or player pages, so only the game viewer and its way back differ there.
 */
export const explorerLinks = {
	records: (fallback: string) => (LOCAL_EXPLORER ? '/explorer' : fallback),
	leaderboard: () => '/admin/leaderboard',
	players: () => '/admin/players',
	player: (username: string) => `/players/${enc(username)}`,
	game: (gameId: string, query = '') => `${LOCAL_EXPLORER ? '/explorer' : ''}/game/${enc(gameId)}${query}`
};

/**
 * The three kinds of spirit. The card data has no field for it; this is the engine's own rule:
 * a Hero has no origin, and a spirit's cost decides its bag (src/lib/play/bags.ts: cost 7-9 is
 * the Arcane Abyss bag, the rest the Spirit World bag).
 */
export type SpiritGroup = 'world' | 'arcane' | 'hero';
export const SPIRIT_GROUPS: { id: SpiritGroup; label: string }[] = [
	{ id: 'world', label: 'Spirit World' },
	{ id: 'arcane', label: 'Arcane' },
	{ id: 'hero', label: 'Heroes' }
];
export function spiritGroup(cost: number, originCount: number): SpiritGroup {
	if (originCount === 0) return 'hero';
	return bagForSpiritCost(cost) === ARCANE_ABYSS_BAG ? 'arcane' : 'world';
}

/** Where a game came from: an AI run folder (league, benchmark, tournament) or "played". */
export const RUN_ORDER = ['league', 'benchmark', 'tournament', 'played'];
export const runLabel = (run: string) => run.charAt(0).toUpperCase() + run.slice(1);
export function runsOf(rows: { run?: string | null }[]): string[] {
	const seen = new Set(rows.map((r) => r.run).filter((r): r is string => !!r));
	return [...seen].sort((a, b) => {
		const ia = RUN_ORDER.indexOf(a);
		const ib = RUN_ORDER.indexOf(b);
		return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
	});
}

/** Run and data version of every game (local explorer only). */
export async function fetchGameRuns(): Promise<Map<string, { run: string; version: string }>> {
	if (!LOCAL_EXPLORER) return new Map();
	const { data } = await supabase.from('game_summaries').select('game_id, run, version');
	const rows = (data as { game_id: string; run: string | null; version: string | null }[] | null) ?? [];
	return new Map(rows.map((r) => [r.game_id, { run: r.run ?? '', version: r.version ?? '' }]));
}

/** The winning player's name of every game (local explorer only). */
export async function fetchGameWinners(): Promise<Map<string, string>> {
	if (!LOCAL_EXPLORER) return new Map();
	const { data } = await supabase.from('player_match_results').select('game_id, username').eq('placement', 1);
	const rows = (data as { game_id: string; username: string }[] | null) ?? [];
	return new Map(rows.map((r) => [r.game_id, r.username]));
}

/** The run of every player on the leaderboard (local explorer only). */
export async function fetchPlayerRuns(): Promise<Map<string, string>> {
	if (!LOCAL_EXPLORER) return new Map();
	const { data } = await supabase.from('player_ratings_leaderboard').select('username_key, run');
	const rows = (data as { username_key: string; run: string | null }[] | null) ?? [];
	return new Map(rows.map((r) => [r.username_key, r.run ?? '']));
}

/** What a player holds at the end of a round, beside the board (local explorer only). */
export interface RoundHand {
	held_powers: { name: string; used: boolean }[];
	monsters: { name: string; difficulty: number | null; hp: number; maxHp: number }[];
}

/** Powers and monster hands of a game, keyed by `<round>:<seat>`. */
export async function fetchRoundHands(gameId: string): Promise<Map<string, RoundHand>> {
	if (!LOCAL_EXPLORER) return new Map();
	const { data } = await supabase
		.from('game_state_snapshots')
		.select('navigation_count, player_color, held_powers, monsters')
		.eq('game_id', gameId);
	const rows = (data as ({ navigation_count: number; player_color: string } & Partial<RoundHand>)[] | null) ?? [];
	return new Map(rows.map((r) => [`${r.navigation_count}:${r.player_color}`, { held_powers: r.held_powers ?? [], monsters: r.monsters ?? [] }]));
}

/** The winner's story of a game (local explorer only). */
export interface GameStory {
	game_id: string;
	headline: string;
	luck: string;
	story: string;
}

export async function fetchGameStories(gameId?: string): Promise<Map<string, GameStory>> {
	if (!LOCAL_EXPLORER) return new Map();
	const query = supabase.from('game_stories').select('game_id, headline, luck, story');
	const { data } = await (gameId ? query.eq('game_id', gameId) : query);
	return new Map(((data as GameStory[] | null) ?? []).map((s) => [s.game_id, s]));
}

export interface AgentProfile {
	run: string;
	agent: string;
	model: string;
	effort: string;
	strategy: string;
	notebook: string;
}

/** The AI agent behind a player name (local explorer only). */
export async function fetchAgentProfile(usernameKey: string): Promise<AgentProfile | null> {
	if (!LOCAL_EXPLORER) return null;
	const { data } = await supabase
		.from('agent_profiles')
		.select('run, agent, model, effort, strategy, notebook')
		.eq('username_key', usernameKey.trim().toLowerCase())
		.limit(1)
		.maybeSingle();
	return (data as AgentProfile | null) ?? null;
}
