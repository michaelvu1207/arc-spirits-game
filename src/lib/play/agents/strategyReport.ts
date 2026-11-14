/**
 * Strategy report (Step 2): per strategy win rate, place and VP; which spirits and classes were
 * collected and awakened (and by which strategy), and which were never taken; each game's
 * winner path; each player's end-of-game statement.
 *
 * Every number comes from the engine: each transcript is replayed on the run's own catalog copy
 * (runCatalog.ts) and the states are read step by step (destinations at the reveal, spirits that
 * enter a seat's tableau, face-down → face-up flips, resolved monster combats). VP by round and
 * status rounds come from the game summary in the `result` record. Nothing is read from text.
 *
 * Build it from a finished run folder at any time: `buildStrategyReport(runDir)`.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDeadlineAdvance, applyGameCommand } from '../runtime';
import { botActorFor } from '../server/botPolicy';
import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import { loadRunCatalog } from './runCatalog';
import type { GameSummary, SeatSummary } from './runner';
import { createAgentLobby } from './setup';
import { finalPlaces, FREE_STRATEGY_ID } from './strategy';
import {
	commandFromActionId,
	readTranscript,
	type HeaderRecord,
	type StatementRecord,
	type TranscriptRecord
} from './transcript';

export const STRATEGY_REPORT_VERSION = 'strategy-report-v1';
/** Seats without a strategy are grouped under this id. */
export const NO_STRATEGY_ID = 'none';

export interface MonsterFight {
	round: number;
	name: string;
	difficulty: number | null;
	killed: boolean;
}

export interface SeatTrace {
	seat: SeatColor;
	strategyId: string;
	strategyName: string;
	model: string;
	guardian: string;
	finalVp: number;
	place: number;
	won: boolean;
	vpByRound: number[];
	/** Destination of each round (index 0 = round 1); null when the round had no reveal. */
	locations: (string | null)[];
	monsters: MonsterFight[];
	/** First round at each status (absent = never); Evil = Fallen. */
	statusRounds: SeatSummary['statusRounds'];
	evil: boolean;
	/** Spirits that entered the seat's tableau during the game (starting spirits excluded). */
	collected: string[];
	/** Spirits that became awake (face-up) during the game. */
	awakened: string[];
	statement: string | null;
	statementError: string | null;
}

export interface GameTrace {
	gameId: string;
	seed: number;
	finished: boolean;
	stopReason: string;
	rounds: number;
	winner: SeatColor | null;
	seats: SeatTrace[];
}

export interface StrategyRow {
	id: string;
	name: string;
	text: string;
	games: number;
	wins: number;
	winRate: number;
	avgPlace: number;
	avgVp: number;
	monsterKills: number;
	wentEvil: number;
}

export interface CardCount {
	name: string;
	total: number;
	byStrategy: Record<string, number>;
}

export interface StrategyReport {
	version: string;
	runId: string;
	catalogHash: string;
	games: number;
	finishedGames: number;
	models: string[];
	strategies: StrategyRow[];
	spirits: { collected: CardCount[]; awakened: CardCount[]; neverTaken: string[] };
	classes: { collected: CardCount[]; neverTaken: string[] };
	monsters: { name: string; fought: number; killed: number }[];
	gameTraces: GameTrace[];
}

/** Replay one transcript and read what each seat did from the engine states. */
export function traceGame(records: TranscriptRecord[], catalog: PlayCatalog): GameTrace {
	const header = records.find((r): r is HeaderRecord => r.type === 'header');
	if (!header) throw new Error('transcript has no header');
	const result = records.find((r) => r.type === 'result');
	const summary = (result?.type === 'result' ? result.summary : null) as GameSummary | null;
	if (!summary) throw new Error(`${header.gameId}: transcript has no result record`);
	let state: PublicGameState = createAgentLobby(catalog, header.seed, header.seats);
	const seats = header.seats.map((s) => s.seat);
	const collected = new Map(seats.map((s) => [s, [] as string[]]));
	const awakened = new Map(seats.map((s) => [s, [] as string[]]));
	const locations = new Map(seats.map((s) => [s, [] as (string | null)[]]));
	const monsters = new Map(seats.map((s) => [s, [] as MonsterFight[]]));
	const seenCombats = new Set<string>();

	/** Per seat: spirit name → [held copies, awake copies]. */
	const tally = (seat: SeatColor) => {
		const counts = new Map<string, [number, number]>();
		for (const spirit of state.players[seat]?.spirits ?? []) {
			const c = counts.get(spirit.name) ?? [0, 0];
			c[0] += 1;
			if (!spirit.isFaceDown) c[1] += 1;
			counts.set(spirit.name, c);
		}
		return counts;
	};
	// Starting spirits are the baseline: only what enters later counts as collected.
	const before = new Map(seats.map((s) => [s, tally(s)]));
	const observe = (): void => {
		for (const seat of seats) {
			const now = tally(seat);
			const was = before.get(seat)!;
			for (const [name, [held, awake]] of now) {
				const [heldBefore, awakeBefore] = was.get(name) ?? [0, 0];
				for (let k = heldBefore; k < held; k++) collected.get(seat)!.push(name);
				for (let k = awakeBefore; k < awake; k++) awakened.get(seat)!.push(name);
			}
			before.set(seat, now);
			if (state.revealedDestinations) {
				const dest = state.players[seat]?.navigationDestination ?? null;
				const list = locations.get(seat)!;
				while (list.length < state.round - 1) list.push(null);
				if (list.length === state.round - 1) list.push(dest);
			}
		}
		for (const combat of state.combats) {
			if (combat.kind !== 'monster' || combat.step !== 'resolved' || seenCombats.has(combat.id))
				continue;
			seenCombats.add(combat.id);
			monsters.get(combat.sides[0]?.seat as SeatColor)?.push({
				round: state.round,
				name: combat.monster?.name ?? '?',
				difficulty: combat.monster?.difficulty ?? null,
				killed: combat.killed
			});
		}
	};
	for (const record of records) {
		if (record.type === 'decision') {
			const res = applyGameCommand(
				state,
				botActorFor(state, record.seat),
				commandFromActionId(record.chosen.actionId),
				catalog
			);
			if (!res.ok)
				throw new Error(
					`${header.gameId}: decision ${record.n} rejected on replay (${res.error.code})`
				);
			state = res.state;
		} else if (record.type === 'advance') {
			applyDeadlineAdvance(state, catalog);
		} else continue;
		observe();
	}

	const statements = new Map(
		records.filter((r): r is StatementRecord => r.type === 'statement').map((r) => [r.seat, r])
	);
	const places = finalPlaces(summary.seats, summary.winner);
	return {
		gameId: header.gameId,
		seed: header.seed,
		finished: summary.finished,
		stopReason: summary.stopReason,
		rounds: summary.rounds,
		winner: summary.finished ? summary.winner : null,
		seats: summary.seats.map((s): SeatTrace => {
			const setup = header.seats.find((h) => h.seat === s.seat);
			const statement = statements.get(s.seat);
			return {
				seat: s.seat,
				strategyId: setup?.strategy?.id ?? NO_STRATEGY_ID,
				strategyName: setup?.strategy?.name ?? 'No strategy given',
				model: s.model,
				guardian: s.guardian,
				finalVp: s.finalVp,
				place: places.get(s.seat) ?? summary.seats.length,
				won: summary.finished && summary.winner === s.seat,
				vpByRound: s.vpByRound,
				locations: locations.get(s.seat)!,
				monsters: monsters.get(s.seat)!,
				statusRounds: s.statusRounds,
				evil: s.statusRounds.Fallen !== undefined,
				collected: collected.get(s.seat)!,
				awakened: awakened.get(s.seat)!,
				...seatStatement(statement)
			};
		})
	};
}

/** A seat's statement fields from its statement record (none, a placeholder, or an error). */
export function seatStatement(
	record: StatementRecord | undefined
): Pick<SeatTrace, 'statement' | 'statementError'> {
	return {
		statement: record && !record.placeholder && record.text ? record.text : null,
		statementError: record?.error ?? null
	};
}

function countCards(
	traces: GameTrace[],
	pick: (seat: SeatTrace) => string[],
	all: string[]
): { counts: CardCount[]; never: string[] } {
	const map = new Map<string, CardCount>();
	for (const game of traces)
		for (const seat of game.seats)
			for (const name of pick(seat)) {
				const row = map.get(name) ?? { name, total: 0, byStrategy: {} };
				row.total += 1;
				row.byStrategy[seat.strategyId] = (row.byStrategy[seat.strategyId] ?? 0) + 1;
				map.set(name, row);
			}
	const counts = [...map.values()].sort(
		(a, b) => b.total - a.total || a.name.localeCompare(b.name)
	);
	return { counts, never: all.filter((name) => !map.has(name)).sort() };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The report from game traces (pure; `buildStrategyReport` reads a run folder). */
export function strategyReportFrom(
	runId: string,
	catalogHash: string,
	traces: GameTrace[],
	catalog: PlayCatalog,
	texts: Map<string, string> = new Map()
): StrategyReport {
	const rows = new Map<string, StrategyRow & { places: number; vp: number }>();
	for (const game of traces)
		for (const seat of game.seats) {
			const row = rows.get(seat.strategyId) ?? {
				id: seat.strategyId,
				name: seat.strategyName,
				text: texts.get(seat.strategyId) ?? '',
				games: 0,
				wins: 0,
				winRate: 0,
				avgPlace: 0,
				avgVp: 0,
				monsterKills: 0,
				wentEvil: 0,
				places: 0,
				vp: 0
			};
			row.games += 1;
			if (seat.won) row.wins += 1;
			row.places += seat.place;
			row.vp += seat.finalVp;
			row.monsterKills += seat.monsters.filter((m) => m.killed).length;
			if (seat.evil) row.wentEvil += 1;
			rows.set(seat.strategyId, row);
		}
	const strategies = [...rows.values()]
		.map(({ places, vp, ...row }) => ({
			...row,
			winRate: round2(row.wins / row.games),
			avgPlace: round2(places / row.games),
			avgVp: round2(vp / row.games)
		}))
		.sort(
			(a, b) => b.winRate - a.winRate || a.avgPlace - b.avgPlace || a.name.localeCompare(b.name)
		);

	const spiritNames = [...new Set(catalog.spirits.map((s) => s.name))];
	const classesOf = new Map(catalog.spirits.map((s) => [s.name, Object.keys(s.classes)]));
	const spiritsCollected = countCards(traces, (s) => s.collected, spiritNames);
	const spiritsAwakened = countCards(traces, (s) => s.awakened, spiritNames);
	const classesCollected = countCards(
		traces,
		(s) => s.collected.flatMap((name) => classesOf.get(name) ?? []),
		catalog.classes.map((c) => c.name)
	);
	const monsterMap = new Map<string, { name: string; fought: number; killed: number }>();
	for (const game of traces)
		for (const seat of game.seats)
			for (const m of seat.monsters) {
				const row = monsterMap.get(m.name) ?? { name: m.name, fought: 0, killed: 0 };
				row.fought += 1;
				if (m.killed) row.killed += 1;
				monsterMap.set(m.name, row);
			}
	return {
		version: STRATEGY_REPORT_VERSION,
		runId,
		catalogHash,
		games: traces.length,
		finishedGames: traces.filter((g) => g.finished).length,
		models: [...new Set(traces.flatMap((g) => g.seats.map((s) => s.model)))],
		strategies,
		spirits: {
			collected: spiritsCollected.counts,
			awakened: spiritsAwakened.counts,
			neverTaken: spiritsCollected.never
		},
		classes: { collected: classesCollected.counts, neverTaken: classesCollected.never },
		monsters: [...monsterMap.values()].sort(
			(a, b) => b.fought - a.fought || a.name.localeCompare(b.name)
		),
		gameTraces: traces
	};
}

export interface NameCount {
	name: string;
	count: number;
}

/** What the first-placed seats did: the patterns that win (the league report). */
export interface WinnerPatterns {
	/** First-placed seats counted (the winner, or the leader of a game stopped early). */
	winners: number;
	spiritsCollected: NameCount[];
	spiritsAwakened: NameCount[];
	classesCollected: NameCount[];
	classesAwakened: NameCount[];
	/** The winners' most frequent destinations in the early, middle and late game. */
	stages: { rounds: string; top: NameCount[] }[];
	avgWinRound: number;
	wentEvil: number;
	avgKills: number;
}

const STAGES: [string, number, number][] = [
	['1-10', 1, 10],
	['11-20', 11, 20],
	['21+', 21, Infinity]
];

function topCounts(names: string[], top: number): NameCount[] {
	const map = new Map<string, number>();
	for (const n of names) map.set(n, (map.get(n) ?? 0) + 1);
	return [...map.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		.slice(0, top);
}

/** The patterns of the first-placed seats of `traces` (top `top` of each list). */
export function winnerPatterns(traces: GameTrace[], catalog: PlayCatalog, top = 5): WinnerPatterns {
	const winners = traces.flatMap((g) =>
		g.seats.filter((s) => s.place === 1).map((seat) => ({ seat, rounds: g.rounds }))
	);
	const classesOf = new Map(catalog.spirits.map((s) => [s.name, Object.keys(s.classes)]));
	const classes = (names: string[]) => names.flatMap((n) => classesOf.get(n) ?? []);
	const n = Math.max(1, winners.length);
	return {
		winners: winners.length,
		spiritsCollected: topCounts(winners.flatMap((w) => w.seat.collected), top),
		spiritsAwakened: topCounts(winners.flatMap((w) => w.seat.awakened), top),
		classesCollected: topCounts(winners.flatMap((w) => classes(w.seat.collected)), top),
		classesAwakened: topCounts(winners.flatMap((w) => classes(w.seat.awakened)), top),
		stages: STAGES.map(([rounds, from, to]) => ({
			rounds,
			top: topCounts(
				winners.flatMap((w) =>
					w.seat.locations.filter(
						(l, i): l is string => l !== null && i + 1 >= from && i + 1 <= to
					)
				),
				3
			)
		})),
		avgWinRound: round2(winners.reduce((a, w) => a + w.rounds, 0) / n),
		wentEvil: winners.filter((w) => w.seat.evil).length,
		avgKills: round2(winners.reduce((a, w) => a + w.seat.monsters.filter((m) => m.killed).length, 0) / n)
	};
}

/** The game transcripts of a run folder, in game order. */
export function runTranscripts(runDir: string): string[] {
	return readdirSync(runDir)
		.filter((f) => /^game-\d+\.jsonl$/.test(f))
		.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
		.map((f) => join(runDir, f));
}

/** Read a finished run folder (transcripts + its catalog copy) and build the report. */
export function buildStrategyReport(runDir: string, catalog?: PlayCatalog): StrategyReport {
	const loaded = loadRunCatalog(runDir);
	const play = catalog ?? loaded.catalog;
	const traces: GameTrace[] = [];
	const texts = new Map<string, string>();
	let runId = '';
	for (const path of runTranscripts(runDir)) {
		const records = readTranscript(path);
		// A game that was cut off (no result record) is not counted.
		if (!records.some((r) => r.type === 'result')) continue;
		const header = records.find((r): r is HeaderRecord => r.type === 'header')!;
		runId = header.runId;
		for (const s of header.seats) if (s.strategy) texts.set(s.strategy.id, s.strategy.text);
		traces.push(traceGame(records, play));
	}
	return strategyReportFrom(runId, loaded.hash, traces, play, texts);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const place = (n: number) => ['1st', '2nd', '3rd', '4th', '5th', '6th'][n - 1] ?? `${n}th`;
const shortPlace = (name: string | null) =>
	name ? name.replace(' Region', '').replace('Arcane Abyss', 'Abyss') : '-';
const cell = (text: string) => text.replaceAll('|', '/').replaceAll('\n', ' ');

/** Plain, short markdown: the strategy table, then the winners' paths, then details. */
export function renderStrategyReportMarkdown(report: StrategyReport): string {
	const nameOf = new Map(report.strategies.map((s) => [s.id, s.name]));
	const lines: string[] = [
		'# Strategy report',
		'',
		`${report.games} game(s), ${report.finishedGames} played to the end. Every player used the same AI (${report.models.join(', ')}); only the strategy text was different.`,
		'',
		'## How each strategy did',
		'',
		'| Strategy | Games | Wins | Win rate | Average place | Average VP |',
		'|---|---:|---:|---:|---:|---:|',
		...report.strategies.map(
			(s) =>
				`| ${cell(s.name)} | ${s.games} | ${s.wins} | ${pct(s.winRate)} | ${s.avgPlace.toFixed(2)} | ${s.avgVp.toFixed(1)} |`
		),
		''
	];
	if (report.finishedGames < report.games)
		lines.push(
			`A game that was stopped early has no winner; its places are by VP at the stop.`,
			''
		);

	lines.push('## How the winner played', '');
	for (const [i, game] of report.gameTraces.entries()) {
		const top = game.seats.find((s) => s.place === 1)!;
		const who = game.finished
			? `${top.seat} won with ${top.finalVp} VP in round ${game.rounds}`
			: `stopped in round ${game.rounds}; ${top.seat} led with ${top.finalVp} VP`;
		lines.push(`### Game ${i + 1}: ${who} (${cell(top.strategyName)})`, '');
		lines.push(
			`- Places: ${game.seats.map((s) => `${s.seat} ${place(s.place)} (${cell(s.strategyName)}, ${s.finalVp} VP)`).join('; ')}`
		);
		lines.push(
			`- Where it went, by round: ${top.locations.map((l, r) => `${r + 1} ${shortPlace(l)}`).join(', ') || '-'}`
		);
		const fights = top.monsters.map(
			(m) =>
				`round ${m.round} ${m.name}${m.difficulty ? ` (Difficulty ${m.difficulty})` : ''} ${m.killed ? 'defeated' : 'not defeated'}`
		);
		lines.push(`- Monsters: ${fights.length ? fights.join(', ') : 'none'}`);
		const status = (['Tainted', 'Corrupt', 'Fallen'] as const)
			.filter((k) => top.statusRounds[k] !== undefined)
			.map((k) => `${k} in round ${top.statusRounds[k]}`);
		lines.push(
			`- Evil: ${top.evil ? 'yes' : 'no'}${status.length ? ` (${status.join(', ')})` : ' (stayed Pure)'}`
		);
		lines.push(`- VP by round: ${top.vpByRound.join(', ') || '-'}`);
		lines.push(`- Spirits collected: ${top.collected.join('; ') || 'none'}`);
		lines.push(`- Spirits awakened: ${top.awakened.join('; ') || 'none'}`, '');
	}

	const strategyIds = report.strategies.map((s) => s.id);
	const byStrategy = (c: CardCount) =>
		strategyIds
			.filter((id) => c.byStrategy[id])
			.map((id) => `${nameOf.get(id)} ${c.byStrategy[id]}`)
			.join(', ');
	const cardTable = (title: string, rows: CardCount[], never: string[] | null) => {
		lines.push(`## ${title}`, '');
		if (rows.length) {
			lines.push('| Name | Times | By strategy |', '|---|---:|---|');
			for (const c of rows) lines.push(`| ${cell(c.name)} | ${c.total} | ${cell(byStrategy(c))} |`);
		} else lines.push('None.');
		if (never) lines.push('', `Never taken (${never.length}): ${never.join('; ') || 'none'}.`);
		lines.push('');
	};
	cardTable('Spirits collected', report.spirits.collected, report.spirits.neverTaken);
	cardTable('Spirits awakened', report.spirits.awakened, null);
	cardTable(
		'Classes collected (counted from the spirits collected)',
		report.classes.collected,
		report.classes.neverTaken
	);
	lines.push('## Monsters fought', '');
	lines.push(
		report.monsters.length
			? report.monsters.map((m) => `${m.name} ${m.fought}× (defeated ${m.killed})`).join(', ')
			: 'None.',
		''
	);

	lines.push('## What each player said after the game', '');
	for (const [i, game] of report.gameTraces.entries()) {
		lines.push(`### Game ${i + 1}`, '');
		for (const s of game.seats) {
			const text =
				s.statement ?? (s.statementError ? `(no answer: ${s.statementError})` : '(no statement)');
			lines.push(`- ${s.seat} (${cell(s.strategyName)}, ${place(s.place)}): ${cell(text)}`);
		}
		lines.push('');
	}

	lines.push('## Strategy texts', '');
	for (const s of report.strategies)
		lines.push(
			`- ${s.name}: ${s.id === FREE_STRATEGY_ID || !s.text ? '(no instruction)' : s.text}`
		);
	lines.push('', `Data version: ${report.catalogHash.slice(0, 12)}.`, '');
	return lines.join('\n');
}

/** Write `strategy-report.json` and `strategy-report.md` into the run folder. */
export function writeStrategyReport(runDir: string, catalog?: PlayCatalog): StrategyReport {
	const report = buildStrategyReport(runDir, catalog);
	writeFileSync(join(runDir, 'strategy-report.json'), `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(join(runDir, 'strategy-report.md'), renderStrategyReportMarkdown(report));
	return report;
}

/** Read a run's strategy report, building it when it is missing. */
export function readStrategyReport(runDir: string): StrategyReport {
	try {
		return JSON.parse(readFileSync(join(runDir, 'strategy-report.json'), 'utf8')) as StrategyReport;
	} catch {
		return writeStrategyReport(runDir);
	}
}
