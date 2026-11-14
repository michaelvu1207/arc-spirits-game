/**
 * Adaptive multi-seat tournament: balanced seeded schedules, placements, Plackett-Luce ratings
 * with bootstrap 95% intervals, and the stop rule. Pure functions (no I/O): the CLI in
 * scripts/agent-harness/tournament.ts runs the games and writes the files.
 *
 * - Entrants are seat specs such as `gw:gpt-6-luna@low`; the model is the part before `@`, the
 *   effort the part after it.
 * - A batch is `rounds` rounds; in each round every entrant plays exactly one game, so with 12
 *   entrants at 4 seats a batch is 18 games and every entrant plays 6. The tables are found by a
 *   seeded local search that spreads the meetings over all opponent pairs (counting earlier
 *   batches) and never makes a table that is all one model or all one effort; then the seat
 *   positions are set so each entrant's count per seat position stays as even as possible.
 * - Placement per game: the engine winner is 1st, the others by final VP; equal VP share the
 *   average place. Ratings: a Plackett-Luce fit on the full finishing order (ties use the Breslow
 *   form), with a weak normal prior so that an unbeaten entrant still gets a finite rating;
 *   shown on the Elo scale (1500 = average, +400 = 10× the odds).
 * - Intervals: bootstrap over games (resample whole games), percentile 2.5–97.5.
 */

import { hashString } from '../rng';
import type { GameSummary } from './runner';

export interface Entrant {
	id: string;
	model: string;
	effort: string;
}

export function parseEntrant(id: string): Entrant {
	const body = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
	const at = body.lastIndexOf('@');
	const model = (at >= 0 ? body.slice(0, at) : body).replace(/^openai-codex\//, '');
	return { id, model, effort: at >= 0 ? body.slice(at + 1) : 'default' };
}

/** Seeded uniform [0, 1) (mulberry32). */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------------------------
// Schedule

export interface ScheduledGame {
	batch: number;
	/** Index in the batch (0-based). */
	index: number;
	/** Engine seed of the game. */
	seed: number;
	/** Entrant ids in seat order (seat 0 = first seat). */
	seats: string[];
}

/** Meetings and seat positions so far (earlier batches), so a new batch evens them out. */
export interface ScheduleHistory {
	pairs: Record<string, number>;
	positions: Record<string, number[]>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function emptyHistory(): ScheduleHistory {
	return { pairs: {}, positions: {} };
}

export function addToHistory(history: ScheduleHistory, games: ScheduledGame[]): ScheduleHistory {
	const pairs = { ...history.pairs };
	const positions: Record<string, number[]> = {};
	for (const [k, v] of Object.entries(history.positions)) positions[k] = [...v];
	for (const g of games) {
		g.seats.forEach((e, pos) => {
			positions[e] ??= [];
			positions[e][pos] = (positions[e][pos] ?? 0) + 1;
			for (const o of g.seats.slice(pos + 1))
				pairs[pairKey(e, o)] = (pairs[pairKey(e, o)] ?? 0) + 1;
		});
	}
	return { pairs, positions };
}

/** A table is "uniform" when all its seats share a model or all share an effort. */
export function uniformTable(seats: string[]): boolean {
	const es = seats.map(parseEntrant);
	return es.every((e) => e.model === es[0].model) || es.every((e) => e.effort === es[0].effort);
}

export interface BatchScheduleOptions {
	batch: number;
	baseSeed: number;
	tableSize?: number;
	/** Rounds per batch (each entrant plays once per round). Default 6. */
	rounds?: number;
	history?: ScheduleHistory;
	/** Local-search steps. Default 40 000. */
	steps?: number;
}

/** Engine seed of a game: fixed by the base seed, the batch and the index. */
export function gameSeed(baseSeed: number, batch: number, index: number): number {
	return baseSeed + batch * 1000 + index;
}

export function batchSchedule(entrants: string[], opts: BatchScheduleOptions): ScheduledGame[] {
	const size = opts.tableSize ?? 4;
	const rounds = opts.rounds ?? 6;
	const n = entrants.length;
	if (n % size !== 0) throw new Error(`${n} entrants do not fill tables of ${size}`);
	if (new Set(entrants).size !== n) throw new Error('entrant ids must be distinct');
	const history = opts.history ?? emptyHistory();
	const random = seededRandom(hashString(`schedule:${opts.baseSeed}:${opts.batch}`));
	const tablesPerRound = n / size;
	const priorPairs = new Float64Array(n * n);
	for (let a = 0; a < n; a++)
		for (let b = 0; b < n; b++)
			if (a !== b) priorPairs[a * n + b] = history.pairs[pairKey(entrants[a], entrants[b])] ?? 0;
	const tableCost = (table: number[]) => (uniformTable(table.map((i) => entrants[i])) ? 1000 : 0);
	const steps = opts.steps ?? 40_000;
	// One annealing search; the best of a few seeded restarts is kept.
	const search = () => {
		// rounds × tables × seats of entrant indices.
		const plan: number[][][] = [];
		for (let r = 0; r < rounds; r++) {
			const order = shuffle(
				entrants.map((_, i) => i),
				random
			);
			plan.push(
				Array.from({ length: tablesPerRound }, (_, t) => order.slice(t * size, t * size + size))
			);
		}
		const counts = new Float64Array(n * n);
		const bump = (table: number[], d: number) => {
			for (let i = 0; i < table.length; i++)
				for (let j = i + 1; j < table.length; j++) {
					counts[table[i] * n + table[j]] += d;
					counts[table[j] * n + table[i]] += d;
				}
		};
		for (const round of plan) for (const table of round) bump(table, 1);
		// Squared meeting counts (prior + this batch) push meetings apart. Only pairs inside the
		// two tables of a swap change, so the cost of those players' pairs gives the exact delta.
		const pairCost = (players: number[]) => {
			let c = 0;
			for (let i = 0; i < players.length; i++)
				for (let j = i + 1; j < players.length; j++) {
					const k = players[i] * n + players[j];
					const m = counts[k] + priorPairs[k];
					// A pair that never meets costs extra: meet every opponent before meeting one 3×.
					c += m * m + (m === 0 ? 6 : 0);
				}
			return c;
		};
		const local = (A: number[], B: number[]) =>
			pairCost([...A, ...B]) + tableCost(A) + tableCost(B);
		for (let s = 0; s < steps && tablesPerRound > 1; s++) {
			const r = Math.floor(random() * rounds);
			const ta = Math.floor(random() * tablesPerRound);
			let tb = Math.floor(random() * (tablesPerRound - 1));
			if (tb >= ta) tb += 1;
			const A = plan[r][ta];
			const B = plan[r][tb];
			const ia = Math.floor(random() * size);
			const ib = Math.floor(random() * size);
			const before = local(A, B);
			const swap = () => {
				bump(A, -1);
				bump(B, -1);
				[A[ia], B[ib]] = [B[ib], A[ia]];
				bump(A, 1);
				bump(B, 1);
			};
			swap();
			const after = local(A, B);
			// Annealing: accept equal moves (plateaus) and, early on, some worse ones.
			const temperature = 3 * (1 - s / steps);
			if (after > before && random() >= Math.exp((before - after) / Math.max(1e-9, temperature)))
				swap();
		}
		let cost = 0;
		for (const round of plan) for (const table of round) cost += tableCost(table);
		cost += pairCost(entrants.map((_, i) => i));
		return { plan, cost };
	};
	let best = search();
	for (let restart = 1; restart < 4; restart++) {
		const next = search();
		if (next.cost < best.cost) best = next;
	}
	const plan = best.plan;
	const tables = plan.flat();
	// Seat positions: coordinate descent over each table's permutation against the counts so far
	// (earlier batches included), from a few random starts; the most even result is kept.
	const perms = permutations(size);
	const seatSearch = () => {
		const pos = entrants.map((e) =>
			Array.from({ length: size }, (_, p) => history.positions[e]?.[p] ?? 0)
		);
		const choice = tables.map(() => Math.floor(random() * perms.length));
		const apply = (t: number, d: number) =>
			perms[choice[t]].forEach((from, p) => {
				pos[tables[t][from]][p] += d;
			});
		tables.forEach((_, t) => apply(t, 1));
		const seatCost = (t: number) =>
			tables[t].reduce((c, e) => c + pos[e].reduce((x, v) => x + v * v, 0), 0);
		for (let sweep = 0; sweep < 50; sweep++) {
			let changed = false;
			for (let t = 0; t < tables.length; t++) {
				apply(t, -1);
				let best = choice[t];
				let bestCost = Infinity;
				for (let k = 0; k < perms.length; k++) {
					choice[t] = k;
					apply(t, 1);
					const c = seatCost(t);
					apply(t, -1);
					if (c < bestCost || (c === bestCost && random() < 0.5)) {
						bestCost = c;
						best = k;
					}
				}
				if (best !== choice[t]) changed = true;
				choice[t] = best;
				apply(t, 1);
			}
			if (!changed) break;
		}
		const cost = pos.reduce((c, p) => c + p.reduce((x, v) => x + v * v, 0), 0);
		return { choice, cost };
	};
	let seats = seatSearch();
	for (let restart = 1; restart < 30; restart++) {
		const next = seatSearch();
		if (next.cost < seats.cost) seats = next;
	}
	const choice = seats.choice;
	const ordered = tables.map((table, t) => perms[choice[t]].map((from) => entrants[table[from]]));
	// Game order: interleave rounds so a partial batch still covers all entrants evenly.
	return ordered.map((seats, index) => ({
		batch: opts.batch,
		index,
		seed: gameSeed(opts.baseSeed, opts.batch, index),
		seats
	}));
}

export function shuffle<T>(xs: T[], random: () => number): T[] {
	const a = [...xs];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function permutations(n: number): number[][] {
	if (n === 1) return [[0]];
	const out: number[][] = [];
	for (const p of permutations(n - 1))
		for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
	return out;
}

/** Balance figures of a schedule (for tests and the run record). */
export function scheduleStats(entrants: string[], games: ScheduledGame[], size = 4) {
	const h = addToHistory(emptyHistory(), games);
	const gamesPer = entrants.map((e) => games.filter((g) => g.seats.includes(e)).length);
	const opponents = entrants.map(
		(e) => entrants.filter((o) => o !== e && (h.pairs[pairKey(e, o)] ?? 0) > 0).length
	);
	const positions = entrants.map((e) =>
		Array.from({ length: size }, (_, p) => h.positions[e]?.[p] ?? 0)
	);
	return {
		gamesPer,
		opponents,
		positions,
		uniformTables: games.filter((g) => uniformTable(g.seats)).length,
		duplicateSeats: games.filter((g) => new Set(g.seats).size !== g.seats.length).length,
		maxPairMeetings: Math.max(0, ...Object.values(h.pairs))
	};
}

// ---------------------------------------------------------------------------------------------
// Results and placements

export interface SeatResult {
	entrant: string;
	seat: string;
	finalVp: number;
	winner: boolean;
	/** 1 = best; equal VP (and no winner flag) share the average place. */
	place: number;
	kills: number;
	corruptions: number;
	pvp: number;
	agentDecisions: number;
	invalidAnswers: number;
	providerCalls: number;
	latencyMsTotal: number;
	promptTokens: number;
	cachedPromptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
}

export interface GameResult {
	batch: number;
	index: number;
	seed: number;
	rounds: number;
	stopReason: string;
	durationMs: number;
	seats: SeatResult[];
}

/** Places from final VP; the engine winner is always 1st. */
export function placements(seats: { finalVp: number; winner: boolean }[]): number[] {
	const order = seats
		.map((s, i) => ({ i, key: (s.winner ? 1e6 : 0) + s.finalVp }))
		.sort((a, b) => b.key - a.key);
	const places = new Array<number>(seats.length);
	for (let k = 0; k < order.length; ) {
		let j = k;
		while (j + 1 < order.length && order[j + 1].key === order[k].key) j++;
		const avg = (k + 1 + j + 1) / 2;
		for (let x = k; x <= j; x++) places[order[x].i] = avg;
		k = j + 1;
	}
	return places;
}

/** A finished game's seat results; `entrants[i]` is the entrant (or agent) key of seat i. */
export function seatResults(s: GameSummary, entrants: string[]): SeatResult[] {
	const places = placements(
		s.seats.map((seat) => ({ finalVp: seat.finalVp, winner: s.winner === seat.seat }))
	);
	return s.seats.map((seat, i) => ({
		entrant: entrants[i],
		seat: seat.seat,
		finalVp: seat.finalVp,
		winner: s.winner === seat.seat,
		place: places[i],
		kills: seat.monsterKills,
		corruptions: seat.corruptions,
		pvp: seat.pvpAttacks,
		agentDecisions: seat.agentDecisions,
		invalidAnswers: seat.invalidAnswers,
		providerCalls: seat.providerCalls,
		latencyMsTotal: seat.latencyMsTotal,
		promptTokens: seat.promptTokens,
		cachedPromptTokens: seat.cachedPromptTokens,
		completionTokens: seat.completionTokens,
		reasoningTokens: seat.reasoningTokens
	}));
}

// ---------------------------------------------------------------------------------------------
// Plackett-Luce

export interface RankedGame {
	/** Player keys (entrant ids, or group names for a group fit). */
	players: string[];
	places: number[];
}

/** Elo scale: 1500 = average strength; +400 = 10× the odds. */
export const toElo = (theta: number) => 1500 + (400 / Math.LN10) * theta;

/**
 * Plackett-Luce maximum a posteriori fit (Newton) with Breslow ties and a normal prior
 * (precision `lambda`) on the log-strengths. Returns centred log-strengths per key.
 */
export function fitPlackettLuce(
	games: RankedGame[],
	keys: string[],
	lambda = 0.1,
	iterations = 50
): Record<string, number> {
	const k = keys.length;
	const index = new Map(keys.map((key, i) => [key, i]));
	const theta = new Array<number>(k).fill(0);
	for (let it = 0; it < iterations; it++) {
		const grad = theta.map((t) => -lambda * t);
		const hess = Array.from({ length: k }, (_, i) =>
			Array.from({ length: k }, (_, j) => (i === j ? -lambda : 0))
		);
		for (const g of games) {
			const ids = g.players.map((p) => index.get(p)!);
			const distinct = [...new Set(g.places)].sort((a, b) => a - b);
			let remaining = ids.map((_, i) => i);
			for (const place of distinct) {
				const group = remaining.filter((i) => g.places[i] === place);
				if (remaining.length <= 1) break;
				const w = remaining.map((i) => Math.exp(theta[ids[i]]));
				const total = w.reduce((a, b) => a + b, 0);
				const m = group.length;
				// p per parameter (players of one group parameter add up).
				const p = new Map<number, number>();
				remaining.forEach((i, r) => p.set(ids[i], (p.get(ids[i]) ?? 0) + w[r] / total));
				for (const i of group) grad[ids[i]] += 1;
				for (const [a, pa] of p) {
					grad[a] -= m * pa;
					hess[a][a] -= m * pa;
					for (const [b, pb] of p) hess[a][b] += m * pa * pb;
				}
				remaining = remaining.filter((i) => g.places[i] !== place);
			}
		}
		const step = solve(
			hess,
			grad.map((x) => -x)
		);
		let maxStep = 0;
		for (let i = 0; i < k; i++) {
			theta[i] += step[i];
			maxStep = Math.max(maxStep, Math.abs(step[i]));
		}
		if (maxStep < 1e-9) break;
	}
	const mean = theta.reduce((a, b) => a + b, 0) / Math.max(1, k);
	return Object.fromEntries(keys.map((key, i) => [key, theta[i] - mean]));
}

/** Gaussian elimination with partial pivoting: solves A x = b. */
function solve(A: number[][], b: number[]): number[] {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
		[M[c], M[piv]] = [M[piv], M[c]];
		const d = M[c][c] || 1e-12;
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / d;
			if (!f) continue;
			for (let x = c; x <= n; x++) M[r][x] -= f * M[c][x];
		}
	}
	return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// ---------------------------------------------------------------------------------------------
// Standings

export interface Interval {
	value: number;
	lo: number;
	hi: number;
}

export interface StandingRow {
	key: string;
	rating: Interval;
	avgPlace: Interval;
	avgVp: Interval;
	games: number;
	wins: number;
	avgWinRound: number | null;
	killsPerGame: number;
	corruptionsPerGame: number;
	pvpPerGame: number;
	illegalAnswerRate: number;
	secondsPerCall: number;
	perGame: { input: number; cached: number; output: number; reasoning: number };
}

export interface Standings {
	games: number;
	entrants: StandingRow[];
	models: StandingRow[];
	efforts: StandingRow[];
}

const quantile = (sorted: number[], q: number) => {
	if (!sorted.length) return NaN;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

type Grouping = (entrant: string) => string;

function rowsFor(
	results: GameResult[],
	keys: string[],
	groupOf: Grouping,
	samples: number,
	seed: number
): StandingRow[] {
	const ranked = (rs: GameResult[]): RankedGame[] =>
		rs.map((r) => ({
			players: r.seats.map((s) => groupOf(s.entrant)),
			places: r.seats.map((s) => s.place)
		}));
	const plain = (rs: GameResult[]) => {
		const place: Record<string, number[]> = {};
		const vp: Record<string, number[]> = {};
		for (const r of rs)
			for (const s of r.seats) {
				const g = groupOf(s.entrant);
				(place[g] ??= []).push(s.place);
				(vp[g] ??= []).push(s.finalVp);
			}
		const avg = (xs?: number[]) => (xs?.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
		return Object.fromEntries(keys.map((k) => [k, { place: avg(place[k]), vp: avg(vp[k]) }]));
	};
	const point = fitPlackettLuce(ranked(results), keys);
	const pointPlain = plain(results);
	const random = seededRandom(hashString(`bootstrap:${seed}:${keys.join(',')}`));
	const boot: Record<string, { rating: number[]; place: number[]; vp: number[] }> =
		Object.fromEntries(keys.map((k) => [k, { rating: [], place: [], vp: [] }]));
	for (let b = 0; b < samples && results.length; b++) {
		const sample = results.map(() => results[Math.floor(random() * results.length)]);
		const fit = fitPlackettLuce(ranked(sample), keys, 0.1, 25);
		const pl = plain(sample);
		for (const k of keys) {
			boot[k].rating.push(fit[k]);
			if (Number.isFinite(pl[k].place)) boot[k].place.push(pl[k].place);
			if (Number.isFinite(pl[k].vp)) boot[k].vp.push(pl[k].vp);
		}
	}
	const interval = (value: number, xs: number[], f = (x: number) => x): Interval => {
		const s = [...xs].sort((a, b) => a - b);
		return { value: f(value), lo: f(quantile(s, 0.025)), hi: f(quantile(s, 0.975)) };
	};
	return keys
		.map((key) => {
			const seats = results.flatMap((r) =>
				r.seats.filter((s) => groupOf(s.entrant) === key).map((s) => ({ s, r }))
			);
			const games = seats.length;
			const wins = seats.filter(({ s }) => s.winner);
			const sum = (f: (s: SeatResult) => number) => seats.reduce((a, { s }) => a + f(s), 0);
			const calls = sum((s) => s.providerCalls);
			const decisions = sum((s) => s.agentDecisions);
			return {
				key,
				rating: interval(point[key], boot[key].rating, toElo),
				avgPlace: interval(pointPlain[key].place, boot[key].place),
				avgVp: interval(pointPlain[key].vp, boot[key].vp),
				games,
				wins: wins.length,
				avgWinRound: wins.length ? wins.reduce((a, { r }) => a + r.rounds, 0) / wins.length : null,
				killsPerGame: games ? sum((s) => s.kills) / games : 0,
				corruptionsPerGame: games ? sum((s) => s.corruptions) / games : 0,
				pvpPerGame: games ? sum((s) => s.pvp) / games : 0,
				illegalAnswerRate: decisions ? sum((s) => s.invalidAnswers) / decisions : 0,
				secondsPerCall: calls ? sum((s) => s.latencyMsTotal) / calls / 1000 : 0,
				perGame: {
					input: games ? Math.round(sum((s) => s.promptTokens) / games) : 0,
					cached: games ? Math.round(sum((s) => s.cachedPromptTokens) / games) : 0,
					output: games ? Math.round(sum((s) => s.completionTokens) / games) : 0,
					reasoning: games ? Math.round(sum((s) => s.reasoningTokens) / games) : 0
				}
			};
		})
		.sort((a, b) => b.rating.value - a.rating.value);
}

export function computeStandings(
	results: GameResult[],
	entrants: string[],
	opts: {
		samples?: number;
		seed?: number;
		/** The model and effort of an entrant key (default: parsed from `gw:<model>@<effort>`). */
		describe?: (entrant: string) => Entrant;
	} = {}
): Standings {
	const samples = opts.samples ?? 1000;
	const seed = opts.seed ?? 1;
	const parsed = entrants.map(opts.describe ?? parseEntrant);
	const models = [...new Set(parsed.map((e) => e.model))];
	const efforts = [...new Set(parsed.map((e) => e.effort))];
	const byId = new Map(parsed.map((e) => [e.id, e]));
	return {
		games: results.length,
		entrants: rowsFor(results, entrants, (e) => e, samples, seed),
		models: rowsFor(
			results,
			models,
			(e) => byId.get(e)?.model ?? parseEntrant(e).model,
			samples,
			seed
		),
		efforts: rowsFor(
			results,
			efforts,
			(e) => byId.get(e)?.effort ?? parseEntrant(e).effort,
			samples,
			seed
		)
	};
}

// ---------------------------------------------------------------------------------------------
// Stop rule

export interface StopDecision {
	stop: boolean;
	reason: string;
	/** Rank order split where neighbours' rating intervals do not overlap. */
	tieGroups: string[][];
	separated: boolean;
	sameOrderAsLastBatch: boolean;
}

/** Neighbours in rating order whose 95% intervals overlap fall in one group. */
export function tieGroups(rows: StandingRow[]): string[][] {
	const groups: string[][] = [];
	rows.forEach((row, i) => {
		if (i > 0 && rows[i - 1].rating.lo <= row.rating.hi) groups[groups.length - 1].push(row.key);
		else groups.push([row.key]);
	});
	return groups;
}

export function stopDecision(
	batch: number,
	rows: StandingRow[],
	previousOrder: string[] | null,
	opts: { tieAfter?: number; maxBatches?: number } = {}
): StopDecision {
	const tieAfter = opts.tieAfter ?? 6;
	const maxBatches = opts.maxBatches ?? 10;
	const order = rows.map((r) => r.key);
	const groups = tieGroups(rows);
	const separated = groups.every((g) => g.length === 1);
	const sameOrderAsLastBatch = !!previousOrder && previousOrder.join('\n') === order.join('\n');
	const base = { tieGroups: groups, separated, sameOrderAsLastBatch };
	if (sameOrderAsLastBatch && separated)
		return {
			...base,
			stop: true,
			reason: `stable: same rank order in batches ${batch - 1} and ${batch}, and no neighbouring intervals overlap`
		};
	if (batch >= tieAfter)
		return {
			...base,
			stop: true,
			reason: `${batch} batches: entrants that cannot be separated are shown as ties (${groups.filter((g) => g.length > 1).length} tie group(s))`
		};
	if (batch >= maxBatches)
		return { ...base, stop: true, reason: `hard stop: ${maxBatches} batches` };
	return {
		...base,
		stop: false,
		reason: !sameOrderAsLastBatch
			? 'rank order changed since the last batch'
			: 'neighbouring intervals still overlap'
	};
}

// ---------------------------------------------------------------------------------------------
// Rendering

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const iv = (i: Interval, f: (x: number) => string) => `${f(i.value)} [${f(i.lo)}–${f(i.hi)}]`;
const short = (key: string) => key.replace(/^gw:/, '').replace(/^openai-codex\//, '');

function table(rows: StandingRow[], full: boolean): string[] {
	const head = full
		? '| # | entrant | rating [95%] | games | wins | avg place [95%] | avg VP [95%] | avg win round | kills/g | corrupt/g | PvP/g | illegal | s/call | in/g | cached/g | out/g | reasoning/g |'
		: '| # | group | rating [95%] | games | wins | avg place [95%] | avg VP [95%] | avg win round | s/call | reasoning/g |';
	const sep = full
		? '|---|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
		: '|---|---|---|---:|---:|---|---|---:|---:|---:|';
	return [
		head,
		sep,
		...rows.map((r, i) =>
			full
				? `| ${i + 1} | ${short(r.key)} | ${iv(r.rating, (x) => x.toFixed(0))} | ${r.games} | ${r.wins} | ${iv(r.avgPlace, f2)} | ${iv(r.avgVp, f1)} | ${r.avgWinRound === null ? '-' : f1(r.avgWinRound)} | ${f1(r.killsPerGame)} | ${f2(r.corruptionsPerGame)} | ${f2(r.pvpPerGame)} | ${(r.illegalAnswerRate * 100).toFixed(1)}% | ${f1(r.secondsPerCall)} | ${r.perGame.input} | ${r.perGame.cached} | ${r.perGame.output} | ${r.perGame.reasoning} |`
				: `| ${i + 1} | ${short(r.key)} | ${iv(r.rating, (x) => x.toFixed(0))} | ${r.games} | ${r.wins} | ${iv(r.avgPlace, f2)} | ${iv(r.avgVp, f1)} | ${r.avgWinRound === null ? '-' : f1(r.avgWinRound)} | ${f1(r.secondsPerCall)} | ${r.perGame.reasoning} |`
		)
	];
}

export function renderStandingsMarkdown(
	title: string,
	standings: Standings,
	decision: StopDecision | null,
	orderHistory: { batch: number; order: string[] }[]
): string {
	const lines = [
		`# ${title}`,
		'',
		`${standings.games} finished games. Rating: Plackett-Luce on each game's finishing order (Elo scale, 1500 = average). [95%] = bootstrap over games. Place 1 = best.`,
		''
	];
	if (decision)
		lines.push(
			`**Stop rule:** ${decision.stop ? 'STOP' : 'continue'} — ${decision.reason}.`,
			'',
			`Tie groups (overlapping neighbours): ${decision.tieGroups.map((g) => g.map(short).join(' = ')).join('  >  ')}`,
			''
		);
	lines.push(
		'## Entrants',
		'',
		...table(standings.entrants, true),
		'',
		'## By model',
		'',
		...table(standings.models, false),
		'',
		'## By effort',
		'',
		...table(standings.efforts, false),
		''
	);
	if (orderHistory.length)
		lines.push(
			'## Rank order after each batch',
			'',
			...orderHistory.map((h) => `- batch ${h.batch}: ${h.order.map(short).join(' > ')}`),
			''
		);
	return lines.join('\n');
}
