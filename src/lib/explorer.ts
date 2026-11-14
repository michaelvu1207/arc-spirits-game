import { env as publicEnv } from '$env/dynamic/public';
import { ARCANE_ABYSS_BAG, bagForSpiritCost } from '$lib/play/bags';
import { supabase } from '$lib/supabase';

/**
 * The local game explorer (scripts/local-game/start.mjs sets PUBLIC_ARC_LOCAL_EXPLORER=1):
 * the records, game viewer, leaderboard and player pages are served without the site chrome
 * under /explorer, and the data editor shows them in a frame. Unset (production, Vercel)
 * nothing here changes behaviour: /explorer answers 404 and the links below keep their values.
 */
export const LOCAL_EXPLORER = publicEnv.PUBLIC_ARC_LOCAL_EXPLORER === '1';

const enc = encodeURIComponent;

/** Links between the explorer pages (their unchanged values when the explorer is off). */
export const explorerLinks = {
	records: (fallback: string) => (LOCAL_EXPLORER ? '/explorer/games' : fallback),
	leaderboard: () => (LOCAL_EXPLORER ? '/explorer/leaderboard' : '/admin/leaderboard'),
	players: () => (LOCAL_EXPLORER ? '/explorer/players' : '/admin/players'),
	player: (username: string) => `${LOCAL_EXPLORER ? '/explorer' : ''}/players/${enc(username)}`,
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

/** One row of the Models table (local explorer only). */
export interface ModelStanding {
	id: string;
	run: string;
	mode: 'entrant' | 'model';
	name: string;
	games: number;
	wins: number;
	avg_vp: number;
	avg_place: number;
	rating: number;
	rating_lo: number;
	rating_hi: number;
	seconds_per_call: number;
}

export async function fetchModelStandings(): Promise<ModelStanding[]> {
	if (!LOCAL_EXPLORER) return [];
	const { data } = await supabase.from('model_standings').select('*');
	return (data as ModelStanding[] | null) ?? [];
}

/** One seat of one game, with what the Trends page counts. */
export interface TrendSeat {
	game_id: string;
	run: string;
	version: string;
	verified: boolean;
	ended_at: string | null;
	username: string;
	strategy: string | null;
	selected_character: string;
	victory_points: number;
	placement: number;
	player_color: string;
	final_spirits: { id: string; name: string; slotIndex: number; isFaceDown?: boolean; cost: number; classes: Record<string, number>; origins: Record<string, number> }[];
	final_classes: string[];
	/** Per origin: highest count during the game, relic gained (null: no relic), count at the end. */
	origin_counts: Record<string, { peak: number; relic: boolean | null; final: number }> | null;
	/** AI games: every monster fight and every monster card kept. */
	monster_fights: { name: string; difficulty: number | null; barrier: number; dealt: number; lost: number; killed: boolean; fought: boolean; nth: number }[] | null;
	monsters_kept: { name: string; difficulty: number | null }[] | null;
	/** The strategy the seat played, judged from the game (stories/strategies.json). */
	played_strategy: string | null;
	items: string[];
	powers: string[];
	spirit_rounds: { id: string; name: string; cost: number; origins: number; rounds: number; awake: number }[] | null;
	class_uses: Record<string, number> | null;
	/** AI games: at the end of each round, Max Barrier, average damage of one attack and initiative against a monster (null: not computable). */
	stat_rounds: { round: number; max_barrier: number; attack: number | null; initiative: number | null }[] | null;
}

export async function fetchTrendSeats(): Promise<TrendSeat[]> {
	if (!LOCAL_EXPLORER) return [];
	const { data, error } = await supabase
		.from('player_match_results')
		.select(
			'game_id, run, version, verified, ended_at, player_color, username, strategy, selected_character, victory_points, placement, final_spirits, final_classes, items, powers, spirit_rounds, class_uses, origin_counts, monster_fights, monsters_kept, played_strategy, stat_rounds'
		);
	if (error) throw new Error(`Failed to fetch trends: ${error.message}`);
	return (data as TrendSeat[] | null) ?? [];
}

/** The strategies a seat can be judged to have played (local explorer only). */
export interface StrategyDefinition {
	id: string;
	name: string;
	description: string;
	rule: string;
}

export async function fetchStrategyDefinitions(): Promise<StrategyDefinition[]> {
	if (!LOCAL_EXPLORER) return [];
	const { data } = await supabase.from('strategy_definitions').select('id, name, description, rule');
	return (data as StrategyDefinition[] | null) ?? [];
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
