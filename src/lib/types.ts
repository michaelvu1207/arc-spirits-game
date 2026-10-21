/**
 * TypeScript types for Arc Spirits Spectate app
 * Matches the TTS game sync payload structure
 */

// Spirit slot on a player mat (1-7 slots)
export interface Spirit {
	slotIndex: number; // 1-7
	id: string; // UUID from Supabase hex_spirits table
	name: string;
	cost: number;
	classes: Record<string, number>; // e.g., {"Archer": 1, "Mage": 2}
	origins: Record<string, number>; // e.g., {"Astral Zone": 1}
}

// Mat slot entry on a player mat (4 slots). Holds a held rune or relic.
export interface MatSlotSnapshot {
	slotIndex: number;
	hasRune: boolean;
	guid?: string;
	id?: string;
	name?: string;
	type?: string;
	originId?: string;
	classId?: string;
	/** True for class/named special runes (carried from the reward path's resolved rune). */
	special?: boolean;
}

// Augment attached directly on a spirit card (from game sync)
export interface SpiritAugmentAttachment {
	runeId: string;
	spiritId: string;
	spiritSlotIndex: number;
	/** Cached display name (e.g. the augment's name) so the UI need not re-resolve it. */
	name?: string;
	/** For spirit AUGMENTS: the class this augment contributes toward the owner's trait
	 *  totals, resolved at placement time. Plain rune attachments leave these unset. */
	classId?: string;
	className?: string;
	localPos?: { x: number; y: number; z: number };
	localRotY?: number;
	// Allow forward-compatible keys without breaking parsing
	[key: string]: unknown;
}

// One entry of a player's configured attack-dice pool (from TTS dice spawner panel).
// Counts of zero are dropped at the source so consumers can iterate as-is.
export interface PlayerDiceEntry {
	diceId: string; // Either a `custom_dice.id` or the literal "defense_dice" sentinel
	count: number;
}

// Spirits drawn to hand for the current navigation round
export interface HandDrawSnapshot {
	guid: string;
	id?: string;
	name?: string;
	cost?: number;
	sourceBag?: string;
}

// Generic entry from a bag's contents (bag.getObjects())
export interface BagEntrySnapshot {
	name: string;
	guid: string;
	id?: string;
	cost?: number;
	state?: string;
	barrier?: number;
	damage?: number;
}

// Bag snapshot (count + contents)
export interface BagSnapshot {
	count: number;
	contents: BagEntrySnapshot[];
}

// Legacy sealed spirit bag (purge bag) shape (older sync versions)
export interface PurgeBag {
	index: number;
	name: string;
	count: number;
	contents: BagEntrySnapshot[];
}

// Bags data from TTS sync
export interface BagsData {
	hexSpirits?: BagSnapshot;
	abyssFallen?: BagSnapshot;
	monstersV2?: BagSnapshot;
	// Legacy fields kept for snapshots synced before the bag-key migration.
	monsters?: BagSnapshot;
	stageDeck?: BagSnapshot;
	purgeBags?: PurgeBag[] | Record<string, unknown>;
	// Allow forward-compatible keys without breaking parsing
	[key: string]: unknown;
}

// Player data for a single navigation round
export interface PlayerSnapshot {
	playerColor: string; // "Red", "Blue", "Orange", "Green", "Purple", "Yellow"
	ttsUsername: string | null;
	selectedCharacter: string; // Guardian name
	navigationDestination: string | null;
	blood: number;
	victoryPoints: number;
	barrier: number;
	maxTokens?: number; // potential token count / barrier slot capacity (0-10), default 4
	statusLevel: number;
	statusToken: string | null;
	spirits: Spirit[];
	mats: MatSlotSnapshot[];
	handDraws: HandDrawSnapshot[];
	spiritAugmentAttachments: SpiritAugmentAttachment[];
	dice: PlayerDiceEntry[];
}

// Full game state snapshot row from Supabase
export interface GameSnapshot {
	id: string;
	game_id: string;
	navigation_count: number;
	game_timestamp: string;
	scenario: string | { id?: string; name?: string; requested?: string | null } | null;
	player_color: string;
	selected_character: string;
	blood: number;
	victory_points: number;
	barrier: number;
	max_tokens: number;
	status_level: number;
	status_token: string | null;
	spirits: Spirit[]; // JSONB parsed
	mats: MatSlotSnapshot[]; // JSONB parsed
	hand_draws: HandDrawSnapshot[]; // JSONB parsed
	bags: BagsData; // JSONB parsed
	tts_username: string | null;
	navigation_destination: string | null;
	spirit_augment_attachments: SpiritAugmentAttachment[]; // JSONB parsed
	dice: PlayerDiceEntry[]; // JSONB parsed
	created_at: string;
	updated_at: string;
}

// Raw row from Supabase before JSONB parsing
export interface GameSnapshotRow {
	id: string;
	game_id: string;
	navigation_count: number;
	game_timestamp: string;
	scenario: string | { id?: string; name?: string; requested?: string | null } | null;
	player_color: string;
	selected_character: string;
	blood: number;
	victory_points: number;
	barrier: number;
	max_tokens: number;
	status_level: number;
	status_token: string | null;
	spirits: string | Spirit[]; // JSONB may come as string or parsed
	mats: string | MatSlotSnapshot[];
	hand_draws: string | HandDrawSnapshot[];
	bags: string | BagsData; // JSONB may come as string or parsed
	tts_username: string | null;
	navigation_destination: string | null;
	spirit_augment_attachments: string | SpiritAugmentAttachment[]; // JSONB may come as string or parsed
	dice: string | PlayerDiceEntry[]; // JSONB may come as string or parsed
	created_at: string;
	updated_at: string;
}

// A spirit's awakening requirement, as stored in hex_spirits.awaken_condition (jsonb).
// `rune_cost` lists rune UUIDs; a UUID repeated N times means "N of that rune"
// (with two wildcard UUIDs — see WILDCARD_MAT_IDS — accepting any matching item).
// `text` is a free-form, not-yet-encodable requirement.
export type AwakenCondition =
	| { type: 'rune_cost'; rune_ids: string[] }
	| { type: 'text'; text: string };

// HexSpirit asset from Supabase for image lookup
export interface HexSpiritAsset {
	id: string;
	name: string;
	cost: number;
	traits: {
		class_ids: string[];
		origin_ids: string[];
	};
	awaken_condition: AwakenCondition | null;
	game_print_image_path: string | null;
	back_side_export?: string | null;
	art_raw_image_path: string | null;
}

// Guardian asset from Supabase
export interface GuardianAsset {
	id: string;
	name: string;
	origin_id: string;
	icon_image_path: string | null;
	image_mat_path: string | null;
	chibi_image_path: string | null;
}

// Mat (rune/relic) asset from Supabase (arc_spirits_assets.mat_items)
export interface MatAsset {
	id: string;
	name: string;
	origin_id: string | null;
	icon_path: string | null;
}

export interface CustomDiceAsset {
	id: string;
	name: string;
	description: string | null;
	color: string | null;
	dice_type: 'attack' | 'special';
	background_image_path: string | null;
	template_image_path: string | null;
	exported_template_path: string | null;
	sides: CustomDiceSideAsset[];
}

export interface CustomDiceSideAsset {
	id: string;
	dice_id: string;
	side_number: number;
	reward_type: 'attack' | 'special';
	reward_value: string;
	reward_description: string | null;
	image_path: string | null;
	template_x: number | null;
	template_y: number | null;
}

// Monster asset from Supabase (arc_spirits_assets.monsters)
export interface MonsterAsset {
	id: string;
	name: string;
	stage: number | string | null;
	/** Difficulty rung within a stage — the escalation order (0 = weakest). */
	order_num?: number | null;
	damage: number | null;
	barrier: number | null;
	card_image_path: string | null;
	reward_track?: string[] | null;
	dice_pool?: string[] | null;
	choose_amount?: number | null;
}

// Icon pool entry (central icon registry)
export interface IconPoolEntry {
	id: string;
	name: string;
	file_path: string;
	tags: string[] | null;
}

// ── Game locations (Spirit World) + their reward rows (interactions) ──────────
// A reward icon is either a single icon_pool id or an "or" choice between several.
export type RewardIconToken = string | { kind: 'or'; icon_ids: string[] };

export type GameLocationRewardRow =
	| { type: 'gain'; gain_icon_ids: RewardIconToken[] }
	| { type: 'trade'; cost_icon_ids: RewardIconToken[]; gain_icon_ids: RewardIconToken[] }
	| { type: 'text'; text: string };

export interface GameLocationAsset {
	id: string;
	name: string;
	origin_id: string | null;
	reward_rows: GameLocationRewardRow[];
	background_image_path: string | null;
}

// Class trait from Supabase
export type BreakpointColor = 'bronze' | 'silver' | 'gold' | 'prismatic';

export interface EffectEntry {
	type?: string;
	description?: string;
	[k: string]: unknown;
}

export interface ClassBreakpoint {
	count: number | string;
	color?: BreakpointColor;
	description?: string;
	effects?: EffectEntry[];
	[k: string]: unknown;
}

export interface ClassTrait {
	id: string;
	name: string;
	position: number;
	icon_png: string | null;
	/** Hexagon Spirit-Augment token art for this class (when it's an augment class). */
	augment_token_path?: string | null;
	color: string;
	description: string | null;
	effect_schema?: ClassBreakpoint[] | null;
	footer?: string | null;
	class_type?: string | null;
	is_special?: boolean | null;
}

export interface OriginCallingCardBreakpoint {
	count: number;
	label?: string;
	icon_ids?: string[];
}

export interface OriginCallingCard {
	enabled?: boolean;
	breakpoints?: OriginCallingCardBreakpoint[];
	hex_spirit_id?: string | null;
}

// Origin trait from Supabase
export interface OriginTrait {
	id: string;
	name: string;
	position: number;
	icon_png: string | null;
	icon_token_png: string | null;
	color: string;
	description: string | null;
	calling_card?: OriginCallingCard | null;
}

// Resolved spirit asset with image URLs for display
export interface ResolvedSpiritAsset {
	id: string;
	name: string;
	cost: number;
	imageUrl: string | null;
	traits: {
		classes: ClassTrait[];
		origins: OriginTrait[];
	};
}

// Resolved guardian asset with image URLs for display
export interface ResolvedGuardianAsset {
	id: string;
	name: string;
	iconUrl: string | null;
	matUrl: string | null;
	chibiUrl: string | null;
	origin: OriginTrait | null;
}

// Player colors in TTS
export type PlayerColor = 'Red' | 'Blue' | 'Orange' | 'Green' | 'Purple' | 'Yellow';

export const PLAYER_COLORS: PlayerColor[] = ['Red', 'Blue', 'Orange', 'Green', 'Purple', 'Yellow'];

// Map TTS player colors to CSS-friendly hex colors
export const PLAYER_COLOR_HEX: Record<PlayerColor, string> = {
	Red: '#ef4444',
	Blue: '#3b82f6',
	Orange: '#f97316',
	Green: '#22c55e',
	Purple: '#a855f7',
	Yellow: '#eab308'
};

// Game notes for host summaries and improvements
export interface GameNotes {
	id: string;
	game_id: string;
	summary: string | null;
	improvements: string[];
	created_at: string;
	updated_at: string;
}

// Raw game notes row from Supabase (before JSONB parsing)
export interface GameNotesRow {
	id: string;
	game_id: string;
	host_secret: string;
	summary: string | null;
	improvements: string | string[];
	created_at: string;
	updated_at: string;
}

// Player feedback/review for a game
export interface PlayerFeedback {
	id: string;
	game_id: string;
	player_name: string;
	feedback_text: string | null;
	rating_complexity: number;
	rating_enjoyment: number;
	rating_others_enjoyment: number;
	created_at: string;
}

// ======== Derived Views (game verification + stats) ========

// One row per game from arc_spirits_game.game_summaries
export interface GameSummaryRow {
	game_id: string;
	verified: boolean;
	verified_at: string | null;
	verified_by: string | null;
	started_at: string | null;
	ended_at: string | null;
	navigation_count: number;
	player_count: number;
	avg_navigation_ms: number | null;
	winner_guardian: string | null;
	winner_vp: number;
}

// One row per (game_id, player_color) from arc_spirits_game.game_results_verified / _all
export interface GameResultRow {
	game_id: string;
	verified: boolean;
	started_at: string | null;
	ended_at: string | null;
	navigation_count: number;
	player_color: string;
	username: string | null;
	raw_username: string | null;
	selected_character: string;
	victory_points: number;
	placement: number;
	player_count: number;
}

export interface LeaderboardLastGameEntry {
	gameId: string;
	round: number;
	playerColor: string;
	character: string;
	endedAt: string;
	victoryPoints: number;
	placement: number;
}

export interface LeaderboardEntryRow {
	username: string;
	games_played: number;
	avg_points: number;
	avg_placement: number;
	last_games: LeaderboardLastGameEntry[];
}

export interface RatingLeaderboardRow {
	username: string;
	username_key: string;
	games_played: number;
	wins: number;
	win_rate: number | null;
	avg_victory_points: number;
	avg_placement: number;
	mu: number | null;
	sigma: number | null;
	ordinal: number | null;
	last_game_at: string | null;
	last_games: LeaderboardLastGameEntry[];
}

export interface PlayerStatsRow {
	username: string;
	games_played: number;
	wins: number;
	win_rate: number | null;
	avg_victory_points: number;
	avg_placement: number;
	best_victory_points: number;
	best_placement: number;
	first_game_at: string | null;
	last_game_at: string | null;
}

export interface FavoriteSpiritEntry {
	spiritId: string;
	name: string;
	games: number;
}

export interface PlayerFavoriteSpiritsRow {
	username: string;
	favorites: FavoriteSpiritEntry[];
}

export interface PlayerBarrierTotalsRow {
	username: string;
	barrier_gained: number;
	barrier_lost: number;
}

export interface PlayerBloodTotalsRow {
	username: string;
	blood_gained: number;
	blood_spent: number;
}

export interface CompositionTagStatsRow {
	tag: string;
	tagged_players: number;
	games: number;
	avg_victory_points: number;
	avg_placement: number;
}

export interface CompositionTagOccurrenceRow {
	tag: string;
	game_id: string;
	player_color: string;
	username: string | null;
	raw_username: string | null;
	selected_character: string;
	victory_points: number;
	placement: number;
	player_count: number;
	navigation_count: number;
	ended_at: string | null;
}

export interface CharacterStatsRow {
	character: string;
	games_played: number;
	wins: number;
	avg_victory_points: number;
	avg_placement: number;
}

export interface CharacterOccurrenceRow {
	character: string;
	game_id: string;
	player_color: string;
	username: string | null;
	raw_username: string | null;
	victory_points: number;
	placement: number;
	player_count: number;
	navigation_count: number;
	ended_at: string | null;
}

export interface TraitStatsRow {
	trait_type: 'class' | 'origin';
	trait_key: string;
	trait_name: string;
	trait_count: number;
	players: number;
	games: number;
	avg_victory_points: number;
	avg_placement: number;
	wins: number;
	example_game_id: string | null;
	example_player_color: string | null;
	example_round: number | null;
}

export interface TraitOccurrenceRow {
	trait_type: 'class' | 'origin';
	trait_key: string;
	trait_name: string;
	trait_count: number;
	game_id: string;
	player_color: string;
	username: string | null;
	raw_username: string | null;
	selected_character: string;
	victory_points: number;
	placement: number;
	player_count: number;
	navigation_count: number;
	ended_at: string | null;
}
