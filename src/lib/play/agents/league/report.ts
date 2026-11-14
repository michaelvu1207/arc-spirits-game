/**
 * The page the owner reads (`report.md`): plain words, short at the top. Built from the league's
 * game traces (strategyReport.ts) after every finished game; the comparison with the data version
 * before uses strategyCompare.ts on the games both versions played (same seeds, same seats).
 */

import type { PlayCatalog } from '../../types';
import { compareReports, describeChange, type CompareReport } from '../strategyCompare';
import {
	strategyReportFrom,
	winnerPatterns,
	type GameTrace,
	type NameCount,
	type StrategyReport,
	type WinnerPatterns
} from '../strategyReport';
import {
	computeStandings,
	type GameResult,
	type Interval,
	type StandingRow,
	type Standings
} from '../tournament';
import { modelLabel, modelName, type LeagueAgent } from './agents';

/** One finished league game (`versions/<id>/traces/g<index>.json`). */
export interface TraceFile {
	index: number;
	gameId: string;
	finishedAt: string;
	trace: GameTrace;
	/** Places, calls and tokens per seat (keyed by agent id); absent in older files. */
	result?: GameResult;
}

export interface VersionReport {
	version: string;
	games: number;
	report: StrategyReport;
	winners: WinnerPatterns;
}

export function versionReport(
	version: { id: string; hash: string; catalog: PlayCatalog },
	files: TraceFile[],
	agents: LeagueAgent[]
): VersionReport {
	const traces = [...files].sort((a, b) => a.index - b.index).map((f) => f.trace);
	const texts = new Map(agents.map((a) => [a.id, a.strategy.text]));
	return {
		version: version.id,
		games: traces.length,
		report: strategyReportFrom(`league-${version.id}`, version.hash, traces, version.catalog, texts),
		winners: winnerPatterns(traces, version.catalog)
	};
}

/** Compare two versions on the game numbers both have finished (pair by pair). */
export function compareVersions(
	before: { id: string; hash: string; catalog: PlayCatalog; files: TraceFile[] },
	after: { id: string; hash: string; catalog: PlayCatalog; files: TraceFile[] },
	agents: LeagueAgent[]
): { compare: CompareReport; pairs: number } {
	const inAfter = new Set(after.files.map((f) => f.index));
	const shared = new Set(before.files.map((f) => f.index).filter((i) => inAfter.has(i)));
	const pick = (files: TraceFile[]) => files.filter((f) => shared.has(f.index));
	const a = versionReport(before, pick(before.files), agents).report;
	const b = versionReport(after, pick(after.files), agents).report;
	return {
		compare: compareReports(
			{ dir: `versions/${before.id}`, report: a, catalog: before.catalog },
			{ dir: `versions/${after.id}`, report: b, catalog: after.catalog }
		),
		pairs: shared.size
	};
}

/**
 * Benchmark standings: per agent, per model and per effort, from the games' seat results
 * (the tournament's Plackett-Luce fit and bootstrap; games without a result are left out).
 */
export function benchmarkStandings(
	files: TraceFile[],
	agents: LeagueAgent[],
	samples = 1000
): Standings {
	const byId = new Map(agents.map((a) => [a.id, a]));
	const results = [...files]
		.sort((a, b) => a.index - b.index)
		.flatMap((f) => (f.result ? [f.result] : []));
	return computeStandings(
		results,
		agents.map((a) => a.id),
		{
			samples,
			describe: (id) => {
				const a = byId.get(id);
				return { id, model: a ? modelName(a.model) : id, effort: a?.effort ?? '?' };
			}
		}
	);
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const range = (i: Interval, f: (x: number) => string) => `${f(i.value)} (${f(i.lo)}–${f(i.hi)})`;

/** One benchmark table with plain column names; `name` labels a row's key. */
function standingsTable(first: string, rows: StandingRow[], name: (key: string) => string): string[] {
	return [
		`| # | ${first} | Rating (95% range) | Games | Wins | Average place (95% range) | Average VP (95% range) | Average round of a win | Illegal answers | Seconds per call | Tokens read per game | Of those cached | Tokens written per game | Of those reasoning |`,
		'|---:|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|',
		...rows.map(
			(r, i) =>
				`| ${i + 1} | ${cell(name(r.key))} | ${range(r.rating, (x) => x.toFixed(0))} | ${r.games} | ${r.wins} | ${range(r.avgPlace, f2)} | ${range(r.avgVp, f1)} | ${r.avgWinRound === null ? '-' : f1(r.avgWinRound)} | ${(r.illegalAnswerRate * 100).toFixed(1)}% | ${f1(r.secondsPerCall)} | ${r.perGame.input} | ${r.perGame.cached} | ${r.perGame.output} | ${r.perGame.reasoning} |`
		)
	];
}

function renderBenchmark(standings: Standings, agents: LeagueAgent[]): string[] {
	const byId = new Map(agents.map((a) => [a.id, a]));
	return [
		'## Model benchmark',
		'',
		`${standings.games} game(s). Rating: Plackett-Luce on each game's finishing order (Elo scale, 1500 = average); the range is a 95% bootstrap over games. Place 1 = best. Tokens are per game for one seat.`,
		'',
		'### By agent',
		'',
		...standingsTable('Agent', standings.entrants, (id) => {
			const a = byId.get(id);
			return a ? `${a.name}${a.name.startsWith(modelLabel(a)) ? '' : ` (${modelLabel(a)})`}` : id;
		}),
		'',
		'### By model',
		'',
		...standingsTable('Model', standings.models, (k) => k),
		'',
		'### By effort',
		'',
		...standingsTable('Effort', standings.efforts, (k) => k),
		''
	];
}

export interface AgentView {
	agent: LeagueAgent;
	notebook: string;
	statement: { text: string; game: number } | null;
}

/** Each agent's newest statement (by finish time) and its notebook now. */
export function agentViews(
	agents: LeagueAgent[],
	files: TraceFile[],
	notebook: (agent: LeagueAgent) => string
): AgentView[] {
	const byTime = [...files].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
	return agents.map((agent) => {
		let statement: AgentView['statement'] = null;
		for (const f of byTime)
			for (const s of f.trace.seats)
				if (s.strategyId === agent.id && s.statement)
					statement = { text: s.statement, game: f.index + 1 };
		return { agent, notebook: agent.learn ? notebook(agent) : '', statement };
	});
}

export function sureness(games: number): string {
	if (games < 20) return 'early, weak: read every number as a hint only';
	if (games < 100) return 'some signal, still noisy';
	return 'solid enough to act on';
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const cell = (t: string) => t.replaceAll('|', '/').replaceAll('\n', ' ');
const list = (rows: NameCount[]) =>
	rows.length ? rows.map((r) => `${r.name} (${r.count})`).join(', ') : 'none yet';
const placeName = (name: string) => name.replace(' Region', '').replace('Arcane Abyss', 'Abyss');

export interface LeagueReportInput {
	current: VersionReport;
	running: number;
	dataNote: string | null;
	agents: AgentView[];
	compare: { previous: string; compare: CompareReport; pairs: number } | null;
	/** Benchmark leagues: the standings shown at the top. */
	standings?: Standings | null;
	updatedAt: string;
}

export function renderLeagueReport(input: LeagueReportInput): string {
	const { current, compare } = input;
	const { report, winners } = current;
	const lines: string[] = [
		'# What the agents are doing',
		'',
		`Data version ${current.version} · ${current.games} game(s) played${input.running ? `, ${input.running} playing now` : ''} · how sure: ${sureness(current.games)}.`,
		''
	];
	if (input.dataNote) lines.push(`Note: ${input.dataNote}`, '');
	if (input.standings)
		lines.push(...renderBenchmark(input.standings, input.agents.map((a) => a.agent)));

	lines.push(
		'## How each agent did',
		'',
		'| Agent | Model | Learns | Games | Wins | Win rate | Average place | Average VP |',
		'|---|---|---|---:|---:|---:|---:|---:|'
	);
	const rows = new Map(report.strategies.map((r) => [r.id, r]));
	const ordered = [...input.agents].sort((x, y) => {
		const a = rows.get(x.agent.id);
		const b = rows.get(y.agent.id);
		return (b?.winRate ?? -1) - (a?.winRate ?? -1) || (a?.avgPlace ?? 9) - (b?.avgPlace ?? 9);
	});
	for (const { agent } of ordered) {
		const r = rows.get(agent.id);
		const head = `| ${cell(agent.name)} | ${cell(modelLabel(agent))} | ${agent.learn ? 'yes' : 'no'}`;
		lines.push(
			r
				? `${head} | ${r.games} | ${r.wins} | ${pct(r.winRate)} | ${r.avgPlace.toFixed(2)} | ${r.avgVp.toFixed(1)} |`
				: `${head} | 0 | - | - | - | - |`
		);
	}
	lines.push('');

	lines.push('## What strategies emerge', '');
	if (!winners.winners) lines.push('No game has finished yet.', '');
	else {
		const unfinished = report.games - report.finishedGames;
		lines.push(
			`What the ${winners.winners} winner(s) did${unfinished ? ` (in ${unfinished} game(s) stopped early, the leader counts as the winner)` : ''}:`,
			'',
			`- Spirits they collected most: ${list(winners.spiritsCollected)}`,
			`- Spirits they awakened most: ${list(winners.spiritsAwakened)}`,
			`- Classes they collected most: ${list(winners.classesCollected)}`,
			`- Classes they awakened most: ${list(winners.classesAwakened)}`,
			`- Where winners went: ${winners.stages
				.filter((s) => s.top.length)
				.map((s) => `rounds ${s.rounds} mostly ${s.top.map((t) => placeName(t.name)).join(', ')}`)
				.join('; ')}`,
			`- A typical win: round ${winners.avgWinRound.toFixed(0)}, ${winners.avgKills.toFixed(1)} monsters defeated; ${winners.wentEvil} of ${winners.winners} winners went Evil.`,
			`- Spirits nobody took (${report.spirits.neverTaken.length}): ${report.spirits.neverTaken.join('; ') || 'none'}`,
			`- Classes nobody took (${report.classes.neverTaken.length}): ${report.classes.neverTaken.join('; ') || 'none'}`,
			''
		);
	}

	lines.push('## What the agents think', '');
	for (const { agent, notebook, statement } of ordered) {
		lines.push(`### ${agent.name}`, '');
		lines.push(`Strategy: ${agent.strategy.text || 'free choice (no instruction)'}`, '');
		lines.push(
			statement
				? `Latest words (after game ${statement.game}): "${statement.text.replaceAll('\n', ' ')}"`
				: 'Latest words: none yet.',
			''
		);
		if (!agent.learn) lines.push('Notebook: this agent does not learn (fixed for comparisons).', '');
		else if (!notebook.trim()) lines.push('Notebook: empty so far.', '');
		else {
			const nb = notebook.trim().split('\n');
			lines.push(`Notebook (${nb.length} lines):`, '', ...nb.map((l) => `> ${l}`), '');
		}
	}

	if (compare) {
		const c = compare.compare;
		lines.push(
			`## What changed since the data before (version ${compare.previous})`,
			'',
			`Compared on the ${compare.pairs} game(s) both versions played: the same games, the same seats.${c.sameSetup ? '' : ` Warning: ${c.setupNote}.`}`,
			'',
			'In the data:',
			'',
			...(c.dataChanges.length ? c.dataChanges.map((d) => `- ${cell(describeChange(d))}`) : ['- nothing']),
			''
		);
		if (compare.pairs) {
			const name = new Map(input.agents.map((a) => [a.agent.id, a.agent.name]));
			lines.push(
				'In play:',
				'',
				'| Agent | Win rate before | Win rate after | Average VP before | Average VP after |',
				'|---|---:|---:|---:|---:|',
				...c.strategies.map(
					(s) =>
						`| ${cell(name.get(s.id) ?? s.name)} | ${s.before ? pct(s.before.winRate) : '-'} | ${s.after ? pct(s.after.winRate) : '-'} | ${s.before ? s.before.avgVp.toFixed(1) : '-'} | ${s.after ? s.after.avgVp.toFixed(1) : '-'} |`
				),
				''
			);
			if (c.cards.length) {
				const show = (r: Record<string, number>) =>
					Object.entries(r)
						.map(([k, v]) => `${k} ${v}`)
						.join(', ');
				lines.push(
					'The changed cards in play:',
					'',
					'| Card | Before | After |',
					'|---|---|---|',
					...c.cards.map((card) => `| ${cell(card.name)} | ${show(card.before)} | ${show(card.after)} |`),
					''
				);
			}
		} else lines.push('No game has been played on both versions yet.', '');
	}
	lines.push(`Updated ${input.updatedAt}.`, '');
	return lines.join('\n');
}
