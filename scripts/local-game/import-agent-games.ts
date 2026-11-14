// Fills the local game's database with the games the explorer pages read, in the shape the
// online game writes (one `game_state_snapshots` row per seat per round) plus the tables that are
// views in the cloud (`game_summaries`, `player_match_results`, `player_ratings_leaderboard`, ...).
//
//   node --import tsx scripts/local-game/import-agent-games.ts --base http://127.0.0.1:5317
//        [--root ~/arcspirits-harness] [--watch 30] [--force]
//
// Sources (read only):
//   <root>/<name>/league.json + versions/<v>/games/*.jsonl   AI games of a league or benchmark
//   <root>/tournament/<run>/games/*.jsonl                    AI games of an older tournament
//   arc_spirits_game.replay_frames                           games played on this local game
// An AI game is replayed through the real engine from its record (no AI call) and must reach
// the recorded final state hash. Files without a result (still playing) and files set aside
// (`.abandoned-`, `.failed-`) are skipped. Each seat's result row also carries what the Trends
// page counts: the final spirits, classes and origins, the runes and relics held and the
// Navigation Powers used, each origin's peak count (with its relic), the monster fights and
// each round's Max Barrier, average attack and initiative (`stat_rounds`). Everything is keyed
// by game id, so a pass can run again at any time; a file that changed is imported again, a
// file that is gone is removed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ordinal, rate, rating } from 'openskill';
import { catalogHash, loadLocalDesignCatalog } from '../../src/lib/play/agents/catalog';
import { modelName } from '../../src/lib/play/agents/league/agents';
import { expectedAttack, resetCombatFlags } from '../../src/lib/play/combat';
import { applyTrigger } from '../../src/lib/play/effects/apply';
import { ORIGIN_REWARDS, spiritsByOrigin } from '../../src/lib/play/effects/relicTools';
import { NAVIGATION_POWERS } from '../../src/lib/play/navigationPowers';
import { loadRunCatalog } from '../../src/lib/play/agents/runCatalog';
import type { GameSummary } from '../../src/lib/play/agents/runner';
import { createAgentLobby } from '../../src/lib/play/agents/setup';
import { computeStandings, parseEntrant, seatResults, type GameResult } from '../../src/lib/play/agents/tournament';
import { commandFromActionId, type HeaderRecord, type TranscriptRecord } from '../../src/lib/play/agents/transcript';
import { applyDeadlineAdvance, applyGameCommand, buildHistorySnapshotRows } from '../../src/lib/play/runtime';
import { botActorFor } from '../../src/lib/play/server/botPolicy';
import { hashGameState } from '../../src/lib/play/stateHash';
import type { PlayCatalog, PublicGameState } from '../../src/lib/play/types';

type Row = Record<string, unknown>;

const { values: args } = parseArgs({
	options: {
		base: { type: 'string', default: 'http://127.0.0.1:5317' },
		root: { type: 'string', default: join(homedir(), 'arcspirits-harness') },
		watch: { type: 'string' },
		force: { type: 'boolean', default: false }
	}
});
const base = args.base!.replace(/\/$/, '');
const root = resolve(args.root!.replace(/^~/, homedir()));
const SCHEMA = 'arc_spirits_game';
/** Version of the rows written: raise it and every game is imported again. */
const FORMAT = 'v7';
const log = (line: string) => console.log(`${new Date().toISOString()} [import] ${line}`);

// ---------------------------------------------------------------------------------------------
// Database (PostgREST shape, served by the local backend)

async function db(method: string, table: string, query = '', body?: unknown): Promise<Row[]> {
	const res = await fetch(`${base}/rest/v1/${table}${query}`, {
		method,
		headers: {
			apikey: 'local-emu',
			'content-type': 'application/json',
			'accept-profile': SCHEMA,
			'content-profile': SCHEMA
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`${method} ${table}${query}: ${res.status} ${(await res.text()).slice(0, 200)}`);
	const text = await res.text();
	return text ? (JSON.parse(text) as Row[]) : [];
}
const select = (table: string, query = '') => db('GET', table, query);

/** Attack-die tier -> custom_dice id (the viewer's dice pool reads dice by id). */
let diceIds: Map<string, string> | null = null;
async function dicePool(attackDice: { tier?: string }[] | undefined): Promise<Row[]> {
	if (!diceIds) {
		const res = await fetch(`${base}/rest/v1/custom_dice?select=id,name`, {
			headers: { apikey: 'local-emu', 'accept-profile': 'arc_spirits_assets' }
		});
		const rows = res.ok ? ((await res.json()) as { id: string; name: string }[]) : [];
		diceIds = new Map(rows.map((d) => [d.name.toLowerCase().replace(/ attack$/, ''), d.id]));
	}
	const counts = new Map<string, number>();
	for (const die of attackDice ?? []) {
		const id = diceIds.get(String(die.tier));
		if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return [...counts].map(([diceId, count]) => ({ diceId, count }));
}
const upsert = (table: string, keys: string, rows: Row[]) =>
	rows.length ? db('POST', table, `?on_conflict=${keys}`, rows) : Promise.resolve([]);
const remove = (table: string, query: string) => db('DELETE', table, query);
const eq = (value: string) => `eq.${encodeURIComponent(value)}`;

// ---------------------------------------------------------------------------------------------
// Run folders

interface Seat {
	seat: string;
	/** Player name on the leaderboard: one per agent and run. */
	name: string;
	agent: string;
	/** The seat's strategy (league agents only; a benchmark or tournament seat is a model). */
	strategy: string | null;
	model: string;
	effort: string;
}
interface Source {
	gameId: string;
	run: string;
	version: string;
	path: string;
	sig: string;
	dir: string;
	kind: 'league' | 'tournament';
}
interface Profile {
	username: string;
	run: string;
	agent: string;
	model: string;
	effort: string;
	strategy: string;
	notebook: string;
}

const isDir = (p: string) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};
const readJson = <T>(path: string): T | null => {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		return null;
	}
};
const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');
const title = (id: string) => id.replace(/(^|-)(\w)/g, (_, dash, c) => `${dash ? ' ' : ''}${c.toUpperCase()}`);
const usernameKey = (name: string) => name.trim().toLowerCase();

interface LeagueDef {
	run: string;
	dir: string;
	benchmark: boolean;
	defaults: { model: string; effort: string };
}

function leagues(): LeagueDef[] {
	const out: LeagueDef[] = [];
	for (const name of isDir(root) ? readdirSync(root).sort() : []) {
		const dir = join(root, name);
		const cfg = readJson<{ defaultModel?: string; defaultEffort?: string; benchmark?: boolean }>(join(dir, 'league.json'));
		if (!cfg || !isDir(join(dir, 'versions'))) continue;
		out.push({
			run: name,
			dir,
			benchmark: cfg.benchmark === true,
			defaults: { model: cfg.defaultModel ?? '', effort: cfg.defaultEffort ?? '' }
		});
	}
	return out;
}

/** "Moon (Sol low)" for a strategy agent, the agent's own name for a benchmark entrant. */
function agentName(league: LeagueDef, agent: string, model: string, effort: string): string {
	const file = readJson<{ name?: string }>(join(league.dir, 'agents', agent, 'agent.json'));
	if (league.benchmark) return file?.name?.trim() || agent;
	const short = modelName(model.replace(/^gw:/, '')).split(' ').pop() ?? '';
	return `${title(agent)} (${`${short} ${effort}`.trim()})`;
}

function sources(): Source[] {
	const out: Source[] = [];
	const add = (run: string, version: string, kind: Source['kind'], dir: string, gamesDir: string, idOf: (stem: string) => string) => {
		if (!isDir(gamesDir)) return;
		for (const file of readdirSync(gamesDir).sort()) {
			if (!file.endsWith('.jsonl') || file.includes('.abandoned-') || file.includes('.failed-')) continue;
			const path = join(gamesDir, file);
			const st = statSync(path);
			out.push({ gameId: idOf(file.slice(0, -6)), run, version, path, sig: `${FORMAT}:${Math.round(st.mtimeMs)}:${st.size}`, dir, kind });
		}
	};
	for (const league of leagues())
		for (const v of readdirSync(join(league.dir, 'versions')).sort())
			add(league.run, v, 'league', league.dir, join(league.dir, 'versions', v, 'games'), (stem) => `${league.run}-${stem}-${v.slice(0, 4)}`);
	const tdir = join(root, 'tournament');
	for (const name of isDir(tdir) ? readdirSync(tdir).sort() : [])
		if (!name.startsWith('test'))
			add('tournament', name, 'tournament', join(tdir, name), join(tdir, name, 'games'), (stem) => `${name}-${stem}`);
	return out;
}

// ---------------------------------------------------------------------------------------------
// One AI game

const powerName = new Map<string, string>(NAVIGATION_POWERS.map((p) => [p.id, p.name]));
const catalogs = new Map<string, PlayCatalog>();

/** The card data the game played: the run's saved copy with the same hash, else the design folder. */
function catalogFor(header: HeaderRecord): PlayCatalog {
	const want = header.catalog.hash;
	const hit = catalogs.get(want);
	if (hit) return hit;
	for (const league of leagues()) {
		const dir = join(league.dir, 'data', want.slice(0, 12));
		if (!existsSync(join(dir, 'catalog', 'play-catalog.json'))) continue;
		try {
			const saved = loadRunCatalog(dir);
			if (saved.hash === want) {
				catalogs.set(want, saved.catalog);
				return saved.catalog;
			}
		} catch {
			// a damaged copy: try the next one
		}
	}
	if (header.catalog.source === 'local-design' && existsSync(header.catalog.path)) {
		const catalog = loadLocalDesignCatalog(header.catalog.path);
		if (catalogHash(catalog) === want) {
			catalogs.set(want, catalog);
			return catalog;
		}
	}
	throw new Error(`the card data ${want.slice(0, 12)} is not saved`);
}

function readRecords(path: string): TranscriptRecord[] {
	const records: TranscriptRecord[] = [];
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as TranscriptRecord);
		} catch {
			// a line still being written
		}
	}
	return records;
}

interface SeatOutcome {
	seat: string;
	username: string;
	guardian: string;
	vp: number;
	placement: number;
	barrierGained: number;
	barrierLost: number;
	bloodGained: number;
	bloodSpent: number;
	spirits: Row[];
	classes: string[];
	origins: string[];
	items: string[];
	/** Every spirit the seat had on its board at the end of any round: rounds held, rounds awake. */
	held: { id: string; name: string; cost: number; origins: number; rounds: number; awake: number }[];
}

/** Places from the last round's rows: the winner first, then by Victory Points (ties share). */
function outcomes(byRound: Map<number, Row[]>, winnerSeat: string | null): SeatOutcome[] {
	const rounds = [...byRound.keys()].sort((a, b) => a - b);
	const last = byRound.get(rounds[rounds.length - 1]) ?? [];
	const key = (r: Row) => (r.player_color === winnerSeat ? 1e6 : 0) + Number(r.victory_points ?? 0);
	return last.map((row) => {
		const seat = String(row.player_color);
		let barrierGained = 0, barrierLost = 0, bloodGained = 0, bloodSpent = 0;
		let prev: Row | null = null;
		const held = new Set<string>(); // runes and relics held at the end of any round
		const kept = new Map<string, { id: string; name: string; cost: number; origins: number; rounds: number; awake: number }>();
		const spirits = (row.spirits as { id?: string; name?: string; isFaceDown?: boolean; classes?: Row; origins?: Row }[] | null) ?? [];
		for (const r of rounds) {
			const cur = byRound.get(r)?.find((x) => x.player_color === seat) ?? null;
			const onBoard = new Map<string, boolean>(); // spirit id -> awake (two copies count once)
			for (const sp of (cur?.spirits as { id?: string; name?: string; cost?: number; isFaceDown?: boolean; origins?: Row }[] | null) ?? []) {
				if (!sp?.id) continue;
				onBoard.set(sp.id, (onBoard.get(sp.id) ?? false) || !sp.isFaceDown);
				if (!kept.has(sp.id)) kept.set(sp.id, { id: sp.id, name: String(sp.name ?? ''), cost: Number(sp.cost ?? 0), origins: Object.keys(sp.origins ?? {}).length, rounds: 0, awake: 0 });
			}
			for (const [id, awake] of onBoard) {
				const k = kept.get(id)!;
				k.rounds++;
				if (awake) k.awake++;
			}
			for (const m of (cur?.mats as { name?: string; type?: string; classId?: string }[] | null) ?? [])
				if (m?.name && !m.classId && m.type !== 'class') held.add(m.name);
			if (prev && cur) {
				const b = Number(cur.barrier ?? 0) - Number(prev.barrier ?? 0);
				if (b > 0) barrierGained += b;
				else barrierLost -= b;
				const blood = Number(cur.blood ?? 0) - Number(prev.blood ?? 0);
				if (blood > 0) bloodGained += blood;
				else bloodSpent -= blood;
			}
			if (cur) prev = cur;
		}
		return {
			seat,
			username: String(row.tts_username ?? seat),
			guardian: String(row.selected_character ?? ''),
			vp: Number(row.victory_points ?? 0),
			placement: 1 + last.filter((other) => key(other) > key(row)).length,
			barrierGained,
			barrierLost,
			bloodGained,
			bloodSpent,
			spirits: spirits.filter((s) => s?.id).map((s) => ({ ...s, id: String(s.id), name: String(s.name ?? '') })),
			// Classes and origins count for awakened spirits (classes also for placed augments).
			classes: [
				...new Set([
					...spirits.filter((s) => !s.isFaceDown).flatMap((s) => Object.keys(s.classes ?? {})),
					...((row.spirit_augment_attachments as { className?: string }[] | null) ?? []).map((a) => a.className ?? '').filter(Boolean)
				])
			],
			origins: [...new Set(spirits.filter((s) => !s.isFaceDown).flatMap((s) => Object.keys(s.origins ?? {})))],
			items: [...held],
			held: [...kept.values()]
		};
	});
}

/**
 * The round's bags for row `i` of `n`. The bags are the same for every seat, so only the first
 * and last rows carry them (the viewer reads either), and each bag keeps its count and the first
 * 8 entries, which is all the viewer's bag panel shows.
 */
function roundBags(bags: unknown, i: number, n: number): unknown {
	if (!bags || typeof bags !== 'object' || (i > 0 && i < n - 1)) return null;
	const out: Row = {};
	for (const [name, bag] of Object.entries(bags as Row)) {
		const contents = (bag as { contents?: unknown[] } | null)?.contents;
		out[name] = Array.isArray(contents) ? { ...(bag as Row), contents: contents.slice(0, 8) } : bag;
	}
	return out;
}

/**
 * Per seat and origin: the highest count during the game, whether the seat gained the origin's
 * relic (null: the origin has no relic) and the count on the final board. Counted as the engine
 * counts for the Cultivate rewards (effects/relicTools.ts `spiritsByOrigin`): every spirit on the
 * board with that origin, awake or face-down, each spirit once. Call it with every state the game
 * passes through; the last call sets the final count.
 */
type OriginCounts = Record<string, { peak: number; relic: boolean | null; final: number }>;
function trackOrigins(state: PublicGameState, into: Map<string, OriginCounts>): void {
	for (const [seat, player] of Object.entries(state.players)) {
		if (!player) continue;
		const of = into.get(seat) ?? {};
		into.set(seat, of);
		const now = spiritsByOrigin(player.spirits ?? []);
		for (const e of Object.values(of)) e.final = 0;
		for (const [origin, n] of Object.entries(now)) {
			const e = (of[origin] ??= { peak: 0, relic: null, final: 0 });
			e.peak = Math.max(e.peak, n);
			e.final = n;
		}
		for (const [origin, e] of Object.entries(of))
			e.relic = ORIGIN_REWARDS[origin] ? (player.originRelicsGained ?? []).includes(origin) : null;
	}
}

/**
 * A seat's combat numbers at the end of a round (the Stats tab): Max Barrier, the average
 * damage of one attack (combat.ts `expectedAttack`: dice average plus flat Beast) and the
 * initiative it would have against a monster. Initiative is read as a monster fight sets it
 * (combat.ts `fightMonster`): per-combat flags reset, then the `inCombat` trigger with no
 * opponent, on a copy of the state, so the replay is never touched; null when that throws.
 */
interface StatRound {
	round: number;
	max_barrier: number;
	attack: number | null;
	initiative: number | null;
}
function trackStats(state: PublicGameState, catalog: PlayCatalog | undefined, into: Map<string, Map<number, StatRound>>): void {
	for (const [seat, player] of Object.entries(state.players)) {
		if (!player) continue;
		let initiative: number | null = null;
		try {
			const copy = structuredClone(state);
			const p = copy.players[seat as keyof typeof copy.players]!;
			resetCombatFlags(p);
			applyTrigger(copy, seat as keyof typeof copy.players, 'inCombat', [], { catalog });
			initiative = Number.isFinite(p.initiative) ? Number(p.initiative) : null;
		} catch {
			initiative = null;
		}
		let attack: number | null = null;
		try {
			attack = Math.round(expectedAttack(player) * 100) / 100;
		} catch {
			attack = null;
		}
		const rounds = into.get(seat) ?? new Map<number, StatRound>();
		into.set(seat, rounds);
		// Called with every state: the round's last call (its committed state) wins.
		rounds.set(state.round, { round: state.round, max_barrier: Number(player.maxBarrier ?? 0), attack, initiative });
	}
}
const statRoundsOf = (stats: Map<string, Map<number, StatRound>> | undefined, seat: string): StatRound[] | null =>
	stats?.has(seat) ? [...stats.get(seat)!.values()].sort((a, b) => a.round - b.round) : null;

/** One monster fight of a seat (startCombat; a kill by a Navigation Power is `fought: false`). */
interface MonsterFight {
	round: number;
	name: string;
	/** The Abyss deck the card is drawn from (1-3) and its printed Barrier. */
	difficulty: number | null;
	barrier: number;
	/** Barrier the card lost in this fight (the player's damage plus deflected damage). */
	dealt: number;
	/** Barrier the player lost to the monster's attack (the engine's combat log). */
	lost: number;
	killed: boolean;
	fought: boolean;
	/** Fights this seat had against this card so far, this one included. */
	nth: number;
}

interface GameWrite {
	gameId: string;
	run: string;
	version: string;
	sig: string;
	finished: boolean;
	startedAt: string;
	endedAt: string;
	byRound: Map<number, Row[]>;
	winnerSeat: string | null;
	/** Per seat: the Trends strategy row and the Navigation Powers used. */
	strategies: Map<string, string | null>;
	powers: Map<string, string[]>;
	/** Per seat: how many times the engine logged each class's ability ("<Class>: ..."). */
	classUses?: Map<string, Record<string, number>>;
	origins?: Map<string, OriginCounts>;
	/** Per seat (AI games): the monster fights and the monster cards kept. */
	monsterFights?: Map<string, MonsterFight[]>;
	monstersKept?: Map<string, { name: string; difficulty: number | null }[]>;
	/** Per seat and round: Max Barrier, average attack and initiative at the round's end. */
	stats?: Map<string, Map<number, StatRound>>;
	/** An AI game's result in the harness's own shape (for the Models table). */
	result?: Row;
}

async function writeGame(g: GameWrite): Promise<void> {
	const rounds = [...g.byRound.keys()].sort((a, b) => a - b);
	const lastRound = rounds[rounds.length - 1];
	const results = outcomes(g.byRound, g.winnerSeat);
	const winner = results.find((r) => r.placement === 1) ?? null;
	await remove('game_state_snapshots', `?game_id=${eq(g.gameId)}`);
	for (let i = 0; i < rounds.length; i += 8)
		await upsert(
			'game_state_snapshots',
			'game_id,navigation_count,player_color',
			rounds.slice(i, i + 8).flatMap((r) => g.byRound.get(r)!)
		);
	await remove('player_match_results', `?game_id=${eq(g.gameId)}`);
	await upsert(
		'player_match_results',
		'game_id,player_color',
		results.map((r) => ({
			game_id: g.gameId,
			run: g.run,
			version: g.version,
			strategy: g.strategies.get(r.seat) ?? null,
			...playedStrategyOf(g.gameId, r.seat),
			final_classes: r.classes,
			spirit_rounds: r.held,
			class_uses: g.classUses?.get(r.seat) ?? null,
			origin_counts: g.origins?.get(r.seat) ?? null,
			monster_fights: g.monsterFights?.get(r.seat) ?? null,
			monsters_kept: g.monstersKept?.get(r.seat) ?? null,
			stat_rounds: statRoundsOf(g.stats, r.seat),
			final_origins: r.origins,
			items: r.items,
			powers: g.powers.get(r.seat) ?? [],
			verified: g.finished,
			started_at: g.startedAt,
			ended_at: g.endedAt,
			navigation_count: lastRound,
			player_color: r.seat,
			username: r.username,
			raw_username: r.username,
			username_key: usernameKey(r.username),
			selected_character: r.guardian,
			victory_points: r.vp,
			placement: r.placement,
			player_count: results.length,
			barrier_gained: r.barrierGained,
			barrier_lost: r.barrierLost,
			blood_gained: r.bloodGained,
			blood_spent: r.bloodSpent,
			final_spirits: r.spirits
		}))
	);
	const ms = Date.parse(g.endedAt) - Date.parse(g.startedAt);
	// Written last: a game is in the list only when all of it is there.
	await upsert('game_summaries', 'game_id', [
		{
			game_id: g.gameId,
			run: g.run,
			version: g.version,
			source_sig: g.sig,
			result: g.result ?? null,
			verified: g.finished,
			verified_at: g.finished ? g.endedAt : null,
			verified_by: null,
			started_at: g.startedAt,
			ended_at: g.endedAt,
			navigation_count: lastRound,
			player_count: results.length,
			avg_navigation_ms: ms > 0 && lastRound > 0 ? Math.round(ms / lastRound) : null,
			winner_guardian: winner?.guardian ?? null,
			winner_vp: winner?.vp ?? 0
		}
	]);
}

async function removeGame(gameId: string): Promise<void> {
	for (const table of ['game_summaries', 'player_match_results', 'game_state_snapshots'])
		await remove(table, `?game_id=${eq(gameId)}`);
}

/** Replay one record and write it. False when the file has no result yet. */
async function importAgentGame(src: Source): Promise<boolean> {
	const records = readRecords(src.path);
	const header = records.find((r): r is HeaderRecord => r.type === 'header');
	const result = records.find((r) => r.type === 'result') as { summary: GameSummary; finalStateHash: string } | undefined;
	if (!header || !result) return false;

	const league = leagues().find((l) => l.run === src.run) ?? null;
	const seatOptions = (header.options?.league as { agents?: { model: string; effort: string }[] } | undefined)?.agents ?? [];
	const seats: Seat[] = header.seats.map((s, i) => {
		if (league) {
			const model = seatOptions[i]?.model ?? s.model;
			const effort = seatOptions[i]?.effort ?? league.defaults.effort;
			const name = agentName(league, s.controller, model, effort);
			return { seat: s.seat, name, agent: s.controller, strategy: league.benchmark ? null : title(s.controller), model: modelName(model.replace(/^gw:/, '')), effort };
		}
		const entrant = parseEntrant(s.controller);
		const model = modelName(entrant.model);
		return { seat: s.seat, name: `${model} ${entrant.effort} (${src.version})`, agent: s.controller, strategy: null, model, effort: entrant.effort };
	});
	const nameOf = new Map(seats.map((s) => [s.seat, s.name]));

	const catalog = catalogFor(header);
	let state: PublicGameState = createAgentLobby(catalog, header.seed, header.seats);
	const steps = records.filter((r) => r.type === 'decision' || r.type === 'advance').length;
	const startMs = Date.parse(header.startedAt);
	const durationMs = Math.max(0, Number(result.summary.durationMs) || 0);
	const roundJson = new Map<number, { json: string; step: number; dice: Record<string, { tier?: string }[]>; hand: Record<string, Row> }>();
	const powers = new Map<string, Set<string>>();
	// Ability uses: the engine writes "<Class>: <what happened>" into the acting seat's action
	// log and into a combat's log. Each such line is one use. A combat line counts for the
	// seat only when it is the combat's single player (a monster fight).
	const classNames = new Set(catalog.classes.map((c) => c.name));
	const classUses = new Map<string, Record<string, number>>();
	const combatSeen = new Map<string, number>();
	const classOf = (line: string) => {
		const i = line.indexOf(':');
		return i > 0 && classNames.has(line.slice(0, i)) ? line.slice(0, i) : null;
	};
	const use = (seat: string, cls: string) => {
		const of = classUses.get(seat) ?? {};
		of[cls] = (of[cls] ?? 0) + 1;
		classUses.set(seat, of);
	};
	const countUses = (actor: string | null) => {
		const own = actor ? (state.players[actor as keyof typeof state.players]?.lastAction?.log ?? []) : [];
		for (const line of own) {
			const cls = classOf(line);
			if (cls) use(actor!, cls);
		}
		for (const combat of state.combats ?? []) {
			const from = combatSeen.get(combat.id) ?? 0;
			combatSeen.set(combat.id, combat.log.length);
			if (combat.sides.length !== 1) continue;
			for (const line of combat.log.slice(from)) {
				const cls = classOf(line);
				if (cls && !own.includes(line)) use(combat.sides[0].seat, cls);
			}
		}
	};
	// Origins at every state; monster cards kept (new in a hand) and fights (new monster combats).
	const origins = new Map<string, OriginCounts>();
	const monsterFights = new Map<string, MonsterFight[]>();
	const monstersKept = new Map<string, { name: string; difficulty: number | null }[]>();
	const fightsOn = new Map<string, number>(); // "<seat>:<card id>" -> fights so far
	const hands = () =>
		new Map(Object.entries(state.players).map(([seat, p]) => [seat, new Map((p?.monsterHand ?? []).map((m) => [m.id, m.hp]))]));
	const seenCombats = new Set<string>();
	const stats = new Map<string, Map<number, StatRound>>();
	const countMonsters = (before: ReturnType<typeof hands>) => {
		for (const [seat, player] of Object.entries(state.players))
			for (const card of player?.monsterHand ?? [])
				if (!before.get(seat)?.has(card.id))
					monstersKept.set(seat, [...(monstersKept.get(seat) ?? []), { name: card.name, difficulty: card.difficulty ?? null }]);
		for (const combat of state.combats ?? []) {
			if (seenCombats.has(combat.id)) continue;
			seenCombats.add(combat.id);
			if (combat.kind !== 'monster' || !combat.monster || combat.sides.length !== 1) continue;
			const seat = combat.sides[0].seat;
			const m = combat.monster;
			const fought = combat.sides[0].rolled;
			const key = `${seat}:${m.id}`;
			if (fought) fightsOn.set(key, (fightsOn.get(key) ?? 0) + 1);
			const hit = combat.log.map((l) => /attacks for \d+ \((\d+) barrier lost\)/.exec(l)).find(Boolean);
			monsterFights.set(seat, [
				...(monsterFights.get(seat) ?? []),
				{
					round: state.round,
					name: m.name,
					difficulty: m.difficulty ?? null,
					barrier: m.maxHp,
					dealt: Math.max(0, (before.get(seat)?.get(m.id) ?? m.maxHp) - m.hp),
					lost: hit ? Number(hit[1]) : 0,
					killed: combat.killed,
					fought,
					nth: fightsOn.get(key) ?? 0
				}
			]);
		}
	};
	let step = 0;
	// The row of a round is its last state (the one the game commits).
	const keep = () => {
		const dice: Record<string, { tier?: string }[]> = {};
		for (const [seat, player] of Object.entries(state.players)) {
			dice[seat] = (player?.attackDice ?? []).map((d) => ({ tier: d.tier }));
			if (player?.navigationPower) powers.set(seat, (powers.get(seat) ?? new Set()).add(`${state.round}:${player.navigationPower}`));
		}
		// What the viewer shows next to the board: the Navigation Powers held (and the one used
		// this round) and the monster cards in hand.
		const hand: Record<string, Row> = {};
		for (const [seat, player] of Object.entries(state.players)) {
			const used = [...(powers.get(seat) ?? [])].filter((u) => u.startsWith(`${state.round}:`)).map((u) => powerName.get(u.slice(u.indexOf(':') + 1)) ?? u);
			hand[seat] = {
				held_powers: [
					...used.map((name) => ({ name, used: true })),
					...(player?.powerInventory ?? []).map((id) => ({ name: powerName.get(id) ?? id, used: false }))
				],
				monsters: (player?.monsterHand ?? []).map((m) => ({ name: m.name, difficulty: m.difficulty ?? null, hp: m.hp, maxHp: m.maxHp }))
			};
		}
		roundJson.set(state.round, { json: JSON.stringify(buildHistorySnapshotRows(state, '')), step, dice, hand });
		trackOrigins(state, origins);
		trackStats(state, catalog, stats);
	};
	keep();
	for (const r of records) {
		const before = hands();
		if (r.type === 'decision') {
			const res = applyGameCommand(state, botActorFor(state, r.seat), commandFromActionId(r.chosen.actionId), catalog);
			if (!res.ok) throw new Error(`decision ${r.n} was rejected: ${res.error.code}`);
			state = res.state;
			countUses(r.seat);
		} else if (r.type === 'advance') {
			applyDeadlineAdvance(state, catalog);
			countUses(null);
		} else continue;
		countMonsters(before);
		step++;
		keep();
	}
	if (hashGameState(state) !== result.finalStateHash) throw new Error('the replay does not reach the recorded final state');

	const byRound = new Map<number, Row[]>();
	for (const [round, { json, step: at, dice, hand }] of roundJson) {
		const stamp = new Date(startMs + (steps > 0 ? (durationMs * at) / steps : 0)).toISOString();
		const rows = JSON.parse(json) as Row[];
		rows.forEach((row, i) => {
			const seat = String(row.player_color);
			row.id = `${src.gameId}:${round}:${seat}`;
			row.game_id = src.gameId;
			row.game_timestamp = stamp;
			row.created_at = stamp;
			row.updated_at = stamp;
			row.tts_username = nameOf.get(seat) ?? seat;
			row.bags = roundBags(row.bags, i, rows.length);
		});
		for (const row of rows) {
			row.dice = await dicePool(dice[String(row.player_color)]);
			Object.assign(row, hand[String(row.player_color)] ?? {});
		}
		byRound.set(round, rows);
	}
	await writeGame({
		gameId: src.gameId,
		run: src.run,
		// The data version is the card data the game played (the same in every run folder).
		version: header.catalog.hash.slice(0, 12),
		sig: src.sig,
		finished: result.summary.finished === true,
		startedAt: header.startedAt,
		endedAt: new Date(startMs + durationMs).toISOString(),
		byRound,
		winnerSeat: result.summary.winner ?? null,
		result: {
			batch: 0,
			index: header.gameIndex,
			seed: header.seed,
			rounds: result.summary.rounds,
			stopReason: result.summary.stopReason,
			durationMs,
			seats: seatResults(result.summary, header.seats.map((s) => s.controller))
		},
		classUses,
		origins,
		monsterFights,
		monstersKept,
		stats,
		strategies: new Map(seats.map((s) => [s.seat, s.strategy])),
		powers: new Map([...powers].map(([seat, used]) => [seat, [...used].map((u) => powerName.get(u.slice(u.indexOf(':') + 1)) ?? u)]))
	});
	return true;
}

// ---------------------------------------------------------------------------------------------
// Games played on this local game (the game saves a public frame after every move)

let frameCursor = '';
const played = new Map<string, Map<number, { revision: number; state: PublicGameState; at: string }>>();

async function importPlayedGames(known: Map<string, Row>): Promise<number> {
	const frames = await select('replay_frames', frameCursor ? `?created_at=gt.${encodeURIComponent(frameCursor)}` : '');
	const touched = new Set<string>();
	for (const f of frames) {
		const gameId = String(f.game_id ?? '');
		const round = Number(f.round);
		const at = String(f.created_at ?? '');
		if (at > frameCursor) frameCursor = at;
		if (!gameId || !(round > 0) || !f.public_state) continue;
		const rounds = played.get(gameId) ?? new Map();
		played.set(gameId, rounds);
		const have = rounds.get(round);
		if (!have || Number(f.revision) >= have.revision) {
			rounds.set(round, { revision: Number(f.revision), state: f.public_state as PublicGameState, at });
			touched.add(gameId);
		}
	}
	let done = 0;
	for (const gameId of touched) {
		const rounds = played.get(gameId)!;
		const order = [...rounds.keys()].sort((a, b) => a - b);
		const final = rounds.get(order[order.length - 1])!;
		const finished = final.state.status === 'finished';
		// A round is complete when a later one exists (or the game is over).
		const complete = finished ? order : order.slice(0, -1);
		const sig = `${FORMAT}:${complete.length}:${final.revision}:${finished}`;
		if (complete.length < 1 || known.get(gameId)?.source_sig === sig) continue;
		try {
			const byRound = new Map<number, Row[]>();
			const origins = new Map<string, OriginCounts>();
			const stats = new Map<string, Map<number, StatRound>>();
			for (const round of complete) {
				const { state, at } = rounds.get(round)!;
				trackOrigins(state, origins);
				// The saved frame has no card data: initiative from the class rules alone.
				trackStats(state, undefined, stats);
				// The saved frame is the public view: its bags have no `history` copy.
				const bags = { ...(state.bags ?? {}), history: state.bags?.history ?? state.bags ?? {} } as PublicGameState['bags'];
				const rows = buildHistorySnapshotRows({ ...state, gameId, round, bags }, at) as unknown as Row[];
				rows.forEach((row, i) => {
					const seat = String(row.player_color);
					row.id = `${gameId}:${round}:${seat}`;
					row.created_at = at;
					row.updated_at = at;
					row.tts_username = row.tts_username ?? state.seats?.[seat as keyof typeof state.seats]?.displayName ?? seat;
					row.bags = roundBags(row.bags ?? state.bags, i, rows.length);
				});
				for (const row of rows)
					row.dice = await dicePool(state.players?.[row.player_color as keyof typeof state.players]?.attackDice);
				byRound.set(round, rows);
			}
			await writeGame({
				gameId,
				run: 'played',
				version: '',
				sig,
				finished,
				startedAt: rounds.get(order[0])!.at,
				endedAt: rounds.get(complete[complete.length - 1])!.at,
				byRound,
				winnerSeat: (final.state.winnerSeat as string | null) ?? null,
				origins,
				stats,
				strategies: new Map(),
				powers: new Map()
			});
			done++;
		} catch (error) {
			log(`played game ${gameId}: ${(error as Error).message}`);
		}
	}
	return done;
}

// ---------------------------------------------------------------------------------------------
// The tables that are views in the cloud: ratings, favourite spirits, totals, agent profiles

function agentProfiles(): Profile[] {
	const out: Profile[] = [];
	for (const league of leagues()) {
		const dir = join(league.dir, 'agents');
		for (const agent of isDir(dir) ? readdirSync(dir).sort() : []) {
			const file = readJson<{ model?: string; effort?: string }>(join(dir, agent, 'agent.json'));
			if (!file) continue;
			const model = !file.model || file.model === 'default' ? league.defaults.model : file.model;
			const effort = !file.effort || file.effort === 'default' ? league.defaults.effort : file.effort;
			out.push({
				username: agentName(league, agent, model, effort),
				run: league.run,
				agent,
				model: modelName(model),
				effort,
				strategy: readText(join(dir, agent, 'strategy.md')),
				notebook: readText(join(dir, agent, 'notebook.md'))
			});
		}
	}
	return out;
}

async function replaceAll(table: string, key: string, rows: Row[]): Promise<void> {
	const keep = new Set(rows.map((r) => String(r[key])));
	await upsert(table, key, rows);
	for (const old of await select(table)) if (!keep.has(String(old[key]))) await remove(table, `?${key}=${eq(String(old[key]))}`);
}

/**
 * The Models table: the harness's own standings (Plackett-Luce rating with a 95% bootstrap
 * range, as in a run's report.md) for every run whose seats are models, by entrant and by model.
 * A full-history entrant stays its own row in the by-model table.
 */
async function rebuildModelStandings(): Promise<void> {
	const summaries = (await select('game_summaries')).filter((g) => g.result);
	const rows: Row[] = [];
	const add = (run: string, mode: string, list: ReturnType<typeof computeStandings>['entrants'], name: (key: string) => string) => {
		for (const r of list)
			rows.push({
				id: `${run}:${mode}:${r.key}`,
				run,
				mode,
				name: name(r.key),
				games: r.games,
				wins: r.wins,
				avg_vp: r.avgVp.value,
				avg_place: r.avgPlace.value,
				rating: r.rating.value,
				rating_lo: r.rating.lo,
				rating_hi: r.rating.hi,
				seconds_per_call: r.secondsPerCall
			});
	};
	const resultsOf = (run: string) =>
		summaries
			.filter((g) => g.run === run)
			.map((g) => g.result as unknown as GameResult)
			.sort((a, b) => a.index - b.index);
	for (const league of leagues()) {
		if (!league.benchmark) continue;
		const results = resultsOf(league.run);
		if (!results.length) continue;
		const dir = join(league.dir, 'agents');
		const agents = new Map<string, { name: string; model: string; effort: string }>();
		for (const id of readdirSync(dir).sort()) {
			const file = readJson<{ name?: string; model?: string; effort?: string; memory?: string }>(join(dir, id, 'agent.json'));
			if (!file) continue;
			const model = !file.model || file.model === 'default' ? league.defaults.model : file.model;
			agents.set(id, {
				name: file.name?.trim() || id,
				model: `${modelName(model)}${file.memory === 'history' ? ' (full history)' : ''}`,
				effort: !file.effort || file.effort === 'default' ? league.defaults.effort : file.effort
			});
		}
		const s = computeStandings(results, [...agents.keys()], {
			describe: (id) => ({ id, model: agents.get(id)?.model ?? id, effort: agents.get(id)?.effort ?? '?' })
		});
		add(league.run, 'entrant', s.entrants, (id) => agents.get(id)?.name ?? id);
		add(league.run, 'model', s.models, (k) => k);
	}
	const results = resultsOf('tournament');
	if (results.length) {
		const entrants = [...new Set(results.flatMap((r) => r.seats.map((x) => x.entrant)))].sort();
		const describe = (id: string) => {
			const e = parseEntrant(id);
			return { id, model: modelName(e.model), effort: e.effort };
		};
		const s = computeStandings(results, entrants, { describe });
		add('tournament', 'entrant', s.entrants, (id) => `${describe(id).model} ${describe(id).effort}`);
		add('tournament', 'model', s.models, (k) => k);
	}
	await replaceAll('model_standings', 'id', rows);
}

async function rebuildViews(): Promise<void> {
	await rebuildModelStandings();
	const results = await select('player_match_results');
	const games = new Map<string, Row[]>();
	for (const r of results) games.set(String(r.game_id), [...(games.get(String(r.game_id)) ?? []), r]);
	const ordered = [...games.values()].sort((a, b) => String(a[0].ended_at).localeCompare(String(b[0].ended_at)));

	// Placement-only OpenSkill, as the online game rates: finished games, oldest first.
	const skill = new Map<string, ReturnType<typeof rating>>();
	const players = new Map<string, { username: string; run: string; rows: Row[] }>();
	for (const seats of ordered) {
		if (seats[0].verified !== true) continue;
		for (const s of seats) {
			const key = String(s.username_key);
			const p = players.get(key) ?? { username: String(s.username), run: String(s.run), rows: [] };
			p.rows.push(s);
			players.set(key, p);
		}
		const keys = seats.map((s) => String(s.username_key));
		if (new Set(keys).size < 2) continue;
		const rated = rate(keys.map((k) => [skill.get(k) ?? rating()]), { rank: seats.map((s) => Number(s.placement)) });
		keys.forEach((k, i) => skill.set(k, rated[i][0]));
	}

	const ratings: Row[] = [];
	const favorites: Row[] = [];
	const barrier: Row[] = [];
	const blood: Row[] = [];
	for (const [key, p] of players) {
		const n = p.rows.length;
		const wins = p.rows.filter((r) => Number(r.placement) === 1).length;
		const sum = (col: string) => p.rows.reduce((a, r) => a + Number(r[col] ?? 0), 0);
		const newest = [...p.rows].reverse();
		const s = skill.get(key) ?? null;
		ratings.push({
			username_key: key,
			username: p.username,
			run: p.run,
			games_played: n,
			wins,
			win_rate: n ? wins / n : null,
			avg_victory_points: n ? sum('victory_points') / n : 0,
			avg_placement: n ? sum('placement') / n : 0,
			mu: s?.mu ?? null,
			sigma: s?.sigma ?? null,
			ordinal: s ? ordinal(s) : null,
			last_game_at: newest[0]?.ended_at ?? null,
			last_games: newest.slice(0, 5).map((r) => ({
				gameId: r.game_id,
				round: r.navigation_count,
				playerColor: r.player_color,
				character: r.selected_character,
				endedAt: r.ended_at,
				victoryPoints: r.victory_points,
				placement: r.placement
			}))
		});
		const spirits = new Map<string, { spiritId: string; name: string; games: number }>();
		for (const r of p.rows) {
			const seen = new Set<string>();
			for (const sp of (r.final_spirits as { id: string; name: string }[] | null) ?? []) {
				if (seen.has(sp.id)) continue;
				seen.add(sp.id);
				const e = spirits.get(sp.id) ?? { spiritId: sp.id, name: sp.name, games: 0 };
				e.games++;
				spirits.set(sp.id, e);
			}
		}
		favorites.push({
			username_key: key,
			username: p.username,
			favorites: [...spirits.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name)).slice(0, 12)
		});
		barrier.push({ username_key: key, username: p.username, barrier_gained: sum('barrier_gained'), barrier_lost: sum('barrier_lost') });
		blood.push({ username_key: key, username: p.username, blood_gained: sum('blood_gained'), blood_spent: sum('blood_spent') });
	}
	await replaceAll('player_ratings_leaderboard', 'username_key', ratings);
	await replaceAll('player_favorite_spirits_by_key', 'username_key', favorites);
	await replaceAll('player_barrier_totals_by_key', 'username_key', barrier);
	await replaceAll('player_blood_totals_by_key', 'username_key', blood);
	await replaceAll(
		'agent_profiles',
		'username_key',
		agentProfiles().map((p) => ({ username_key: usernameKey(p.username), ...p }))
	);
}

// ---------------------------------------------------------------------------------------------

const failed = new Map<string, string>(); // game id -> file signature that did not import
let profileSig = '';
let storySig = '';
let strategySig: string | null = null; // null: not read yet (the first pass always syncs)

/**
 * The strategy each seat PLAYED, as another tool judges it from the game
 * (<root>/stories/strategies.json: definitions plus one row per game and seat). Read every pass;
 * when the file changes the definitions table is replaced and every seat's row is updated.
 */
interface PlayedStrategies {
	definitions?: { id: string; name: string; description?: string; rule?: string }[];
	seats?: { gameId: string; seat: string; strategy: string; secondary?: string | null }[];
}
let playedStrategies = new Map<string, { played_strategy: string | null; played_secondary: string | null }>();
const playedStrategyOf = (gameId: string, seat: string) =>
	playedStrategies.get(`${gameId}:${seat}`) ?? { played_strategy: null, played_secondary: null };

async function importStrategies(): Promise<void> {
	const path = join(root, 'stories', 'strategies.json');
	const sig = existsSync(path) ? `${Math.round(statSync(path).mtimeMs)}:${statSync(path).size}` : '';
	if (sig === strategySig) return;
	const file = sig ? readJson<PlayedStrategies>(path) : null;
	if (sig && !file) return; // a file still being written: try again next pass
	playedStrategies = new Map(
		(file?.seats ?? []).map((s) => [`${s.gameId}:${s.seat}`, { played_strategy: s.strategy ?? null, played_secondary: s.secondary ?? null }])
	);
	await replaceAll(
		'strategy_definitions',
		'id',
		(file?.definitions ?? []).map((d) => ({ id: d.id, name: d.name, description: d.description ?? '', rule: d.rule ?? '' }))
	);
	for (const row of await select('player_match_results', '?select=game_id,player_color,played_strategy,played_secondary')) {
		const want = playedStrategyOf(String(row.game_id), String(row.player_color));
		if ((row.played_strategy ?? null) === want.played_strategy && (row.played_secondary ?? null) === want.played_secondary) continue;
		await db('PATCH', 'player_match_results', `?game_id=${eq(String(row.game_id))}&player_color=${eq(String(row.player_color))}`, want);
	}
	strategySig = sig;
}

/** The winner's story of each game (<root>/stories/games/<game id>.json, written by another tool). */
async function importStories(): Promise<void> {
	const dir = join(root, 'stories', 'games');
	const files = isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
	const sig = files.map((f) => `${f}:${Math.round(statSync(join(dir, f)).mtimeMs)}`).join('|');
	if (sig === storySig) return;
	const rows: Row[] = [];
	for (const f of files) {
		const s = readJson<{ gameId?: string; headline?: string; luck?: string; story?: string }>(join(dir, f));
		if (!s?.story) continue; // a file still being written
		rows.push({ game_id: s.gameId ?? f.slice(0, -5), headline: s.headline ?? '', luck: s.luck ?? '', story: s.story });
	}
	await replaceAll('game_stories', 'game_id', rows);
	storySig = sig;
}

async function pass(): Promise<void> {
	await importStrategies();
	const known = new Map((await select('game_summaries')).map((r) => [String(r.game_id), r]));
	const files = sources();
	const wanted = new Set(files.map((f) => f.gameId));
	let changed = 0;
	for (const [gameId, row] of known) {
		if (row.run === 'played' || wanted.has(gameId)) continue;
		await removeGame(gameId);
		changed++;
	}
	for (const src of files) {
		if (!args.force && (known.get(src.gameId)?.source_sig === src.sig || failed.get(src.gameId) === src.sig)) continue;
		try {
			if (await importAgentGame(src)) {
				changed++;
				log(`${src.gameId} imported`);
			}
		} catch (error) {
			failed.set(src.gameId, src.sig);
			log(`${src.gameId} skipped: ${(error as Error).message}`);
		}
	}
	changed += await importPlayedGames(known);
	await importStories();
	const sig = JSON.stringify(agentProfiles());
	if (changed > 0 || sig !== profileSig) {
		await rebuildViews();
		profileSig = sig;
		log(`${changed} game(s) changed; the leaderboard and profiles are rebuilt`);
	}
}

const watch = Number(args.watch ?? 0);
for (;;) {
	try {
		await pass();
	} catch (error) {
		log(`pass failed: ${(error as Error).message}`);
		if (!watch) process.exit(1);
	}
	if (!watch) break;
	args.force = false;
	await new Promise((r) => setTimeout(r, watch * 1000));
}
