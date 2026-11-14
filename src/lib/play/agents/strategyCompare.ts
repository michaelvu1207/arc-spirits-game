/**
 * Before/after compare (Step 3): two finished run folders that played the same seeds, seats and
 * strategies on two catalogs (old data, new data). It reports what changed in the card data
 * (spirits, classes, monsters by name and field; any other table as a whole) and what changed in
 * play (per strategy win rate and VP; per changed card how often it was collected / awakened /
 * fought before and after). The data comes from each run's own catalog copy and strategy report.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayCatalog, PlayCatalogSpirit } from '../types';
import { stableStringify } from './catalog';
import { buildRulesBrief } from './rulesBrief';
import { loadRunCatalog } from './runCatalog';
import { readStrategyReport, type StrategyReport } from './strategyReport';

export const COMPARE_VERSION = 'strategy-compare-v1';

export interface FieldChange {
	field: string;
	before: string;
	after: string;
}

export interface CatalogChange {
	kind: 'spirit' | 'class' | 'monster' | 'other';
	name: string;
	change: 'added' | 'removed' | 'changed';
	fields: FieldChange[];
}

const counts = (record: Record<string, number>) =>
	Object.entries(record)
		.map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
		.sort()
		.join(', ') || 'none';

function awakenText(spirit: PlayCatalogSpirit): string {
	if (!spirit.awaken) return 'none';
	if (spirit.awaken.kind === 'text') return `"${spirit.awaken.text}"`;
	return spirit.awaken.mats.map((m) => `${m.count}× ${m.name}`).join(' + ');
}

/** Class name → its breakpoint text, exactly as the rules brief shows it. */
function classTexts(catalog: PlayCatalog): Map<string, string> {
	const brief = buildRulesBrief(catalog).split('\n');
	const start = brief.indexOf('## Classes (count in brackets → effect)');
	const out = new Map<string, string>();
	for (const line of brief.slice(start + 1)) {
		if (!line.startsWith('- ')) break;
		const at = line.indexOf(': ');
		if (at > 0) out.set(line.slice(2, at), line.slice(at + 2));
	}
	return out;
}

function diffById<T extends { id: string; name: string }>(
	kind: CatalogChange['kind'],
	before: T[],
	after: T[],
	fields: (row: T, side: 'before' | 'after') => Record<string, string>
): CatalogChange[] {
	const out: CatalogChange[] = [];
	const old = new Map(before.map((r) => [r.id, r]));
	const now = new Map(after.map((r) => [r.id, r]));
	for (const [id, row] of now) {
		const was = old.get(id);
		if (!was) {
			out.push({ kind, name: row.name, change: 'added', fields: [] });
			continue;
		}
		const a = fields(was, 'before');
		const b = fields(row, 'after');
		const changed = Object.keys(b)
			.filter((field) => a[field] !== b[field])
			.map((field) => ({ field, before: a[field] ?? '', after: b[field] }));
		if (changed.length) out.push({ kind, name: row.name, change: 'changed', fields: changed });
	}
	for (const [id, row] of old)
		if (!now.has(id)) out.push({ kind, name: row.name, change: 'removed', fields: [] });
	return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** What differs between two built catalogs, by card name and field. */
export function diffCatalogs(before: PlayCatalog, after: PlayCatalog): CatalogChange[] {
	const textBefore = classTexts(before);
	const textAfter = classTexts(after);
	const spirits = diffById('spirit', before.spirits, after.spirits, (s) => ({
		name: s.name,
		cost: String(s.cost),
		classes: counts(s.classes),
		origins: counts(s.origins),
		'awaken cost': awakenText(s)
	}));
	const classes = diffById('class', before.classes, after.classes, (c, side) => ({
		name: c.name,
		ability: (side === 'before' ? textBefore : textAfter).get(c.name) ?? ''
	}));
	// The ability text can stay the same while its data changes (e.g. a value the text omits).
	for (const c of after.classes) {
		const was = before.classes.find((k) => k.id === c.id);
		if (!was || stableStringify(was.effectSchema) === stableStringify(c.effectSchema)) continue;
		const change = classes.find((x) => x.name === c.name && x.change === 'changed');
		if (change?.fields.some((f) => f.field === 'ability')) continue;
		const field = { field: 'ability data', before: 'old version', after: 'new version' };
		if (change) change.fields.push(field);
		else classes.push({ kind: 'class', name: c.name, change: 'changed', fields: [field] });
	}
	const monsters = diffById('monster', before.monsters ?? [], after.monsters ?? [], (m) => ({
		name: m.name,
		damage: String(m.damage),
		barrier: String(m.barrier),
		stage: String(m.stage),
		order: String(m.order),
		rewards: m.rewardTrack.join(', '),
		dice: m.dicePool.join(', ')
	}));
	const other: CatalogChange[] = (
		['guardians', 'mats', 'dice', 'locations', 'costDuplicates'] as const
	)
		.filter((key) => stableStringify(before[key]) !== stableStringify(after[key]))
		.map((key) => ({ kind: 'other', name: key, change: 'changed', fields: [] }));
	return [...spirits, ...classes, ...monsters, ...other];
}

export interface StrategyDelta {
	id: string;
	name: string;
	before: { games: number; wins: number; winRate: number; avgVp: number; avgPlace: number } | null;
	after: { games: number; wins: number; winRate: number; avgVp: number; avgPlace: number } | null;
}

export interface CardDelta {
	kind: CatalogChange['kind'];
	name: string;
	/** Spirits: collected / awakened. Classes: collected (spirits with it). Monsters: fought / defeated. */
	before: Record<string, number>;
	after: Record<string, number>;
}

export interface CompareReport {
	version: string;
	old: { runDir: string; runId: string; catalogHash: string; games: number };
	new: { runDir: string; runId: string; catalogHash: string; games: number };
	/** Same seeds, seats (models) and strategies, game by game. */
	sameSetup: boolean;
	setupNote: string | null;
	dataChanges: CatalogChange[];
	strategies: StrategyDelta[];
	cards: CardDelta[];
}

/** A game-by-game key of seeds, seat models and strategies. */
const setupKey = (report: StrategyReport) =>
	report.gameTraces.map(
		(g) => `${g.seed}:${g.seats.map((s) => `${s.seat}=${s.model}/${s.strategyId}`).join(',')}`
	);

function setupNote(a: StrategyReport, b: StrategyReport): string | null {
	const ka = setupKey(a);
	const kb = setupKey(b);
	if (ka.length !== kb.length) return `the runs have ${ka.length} and ${kb.length} finished games`;
	const i = ka.findIndex((k, j) => k !== kb[j]);
	return i < 0 ? null : `game ${i + 1} differs in seed, seats or strategies`;
}

function cardDeltas(changes: CatalogChange[], a: StrategyReport, b: StrategyReport): CardDelta[] {
	const find = (rows: { name: string; total: number }[], name: string) =>
		rows.find((r) => r.name === name)?.total ?? 0;
	const monster = (r: StrategyReport, name: string) =>
		r.monsters.find((m) => m.name === name) ?? { fought: 0, killed: 0 };
	return changes
		.filter((c) => c.kind !== 'other')
		.map((c) => {
			const pick = (r: StrategyReport): Record<string, number> =>
				c.kind === 'spirit'
					? {
							collected: find(r.spirits.collected, c.name),
							awakened: find(r.spirits.awakened, c.name)
						}
					: c.kind === 'class'
						? { collected: find(r.classes.collected, c.name) }
						: { fought: monster(r, c.name).fought, defeated: monster(r, c.name).killed };
			return { kind: c.kind, name: c.name, before: pick(a), after: pick(b) };
		});
}

/** Compare two finished run folders (old data first). */
export function compareRuns(oldDir: string, newDir: string): CompareReport {
	return compareReports(
		{ dir: oldDir, report: readStrategyReport(oldDir), catalog: loadRunCatalog(oldDir).catalog },
		{ dir: newDir, report: readStrategyReport(newDir), catalog: loadRunCatalog(newDir).catalog }
	);
}

/** Compare two strategy reports with the catalogs they played (old data first). */
export function compareReports(
	before: { dir: string; report: StrategyReport; catalog: PlayCatalog },
	after: { dir: string; report: StrategyReport; catalog: PlayCatalog }
): CompareReport {
	const [a, b] = [before.report, after.report];
	const [oldDir, newDir] = [before.dir, after.dir];
	const dataChanges = diffCatalogs(before.catalog, after.catalog);
	const ids = [...new Set([...a.strategies, ...b.strategies].map((s) => s.id))];
	const brief = (r: StrategyReport, id: string) => {
		const s = r.strategies.find((x) => x.id === id);
		return s
			? { games: s.games, wins: s.wins, winRate: s.winRate, avgVp: s.avgVp, avgPlace: s.avgPlace }
			: null;
	};
	const note = setupNote(a, b);
	return {
		version: COMPARE_VERSION,
		old: { runDir: oldDir, runId: a.runId, catalogHash: a.catalogHash, games: a.games },
		new: { runDir: newDir, runId: b.runId, catalogHash: b.catalogHash, games: b.games },
		sameSetup: note === null,
		setupNote: note,
		dataChanges,
		strategies: ids.map((id) => ({
			id,
			name: (b.strategies.find((s) => s.id === id) ?? a.strategies.find((s) => s.id === id))!.name,
			before: brief(a, id),
			after: brief(b, id)
		})),
		cards: cardDeltas(dataChanges, a, b)
	};
}

const KIND_NAME: Record<CatalogChange['kind'], string> = {
	spirit: 'Spirit',
	class: 'Class',
	monster: 'Monster',
	other: 'Table'
};
const pct = (n: number | undefined) => (n === undefined ? '-' : `${Math.round(n * 100)}%`);
const num = (n: number | undefined) => (n === undefined ? '-' : n.toFixed(1));
const cell = (text: string) => text.replaceAll('|', '/').replaceAll('\n', ' ');

/** One data change in plain words, e.g. "Spirit Huntress: awaken cost 2× Fire → 3× Fire". */
export function describeChange(c: CatalogChange): string {
	const what =
		c.change === 'changed'
			? c.fields.map((f) => `${f.field} ${f.before} → ${f.after}`).join('; ')
			: c.change;
	return `${KIND_NAME[c.kind]} ${c.name}: ${what || 'changed'}`;
}

export function renderCompareMarkdown(report: CompareReport): string {
	const lines = [
		'# Before and after',
		'',
		`Old data: version ${report.old.catalogHash.slice(0, 12)}, ${report.old.games} game(s). New data: version ${report.new.catalogHash.slice(0, 12)}, ${report.new.games} game(s).`,
		report.sameSetup
			? 'Both runs used the same games (same seeds), the same players and the same strategies.'
			: `Warning: the two runs are not the same setup (${report.setupNote}), so differences are not only from the data.`,
		'',
		'## What changed in the data',
		''
	];
	if (!report.dataChanges.length) lines.push('Nothing.');
	for (const c of report.dataChanges) lines.push(`- ${cell(describeChange(c))}`);
	lines.push(
		'',
		'## What changed in play',
		'',
		'| Strategy | Win rate before | Win rate after | Average VP before | Average VP after |',
		'|---|---:|---:|---:|---:|',
		...report.strategies.map(
			(s) =>
				`| ${cell(s.name)} | ${pct(s.before?.winRate)} | ${pct(s.after?.winRate)} | ${num(s.before?.avgVp)} | ${num(s.after?.avgVp)} |`
		),
		''
	);
	if (report.cards.length) {
		lines.push('## The changed cards in play', '', '| Card | Before | After |', '|---|---|---|');
		const show = (r: Record<string, number>) =>
			Object.entries(r)
				.map(([k, v]) => `${k} ${v}`)
				.join(', ');
		for (const c of report.cards)
			lines.push(`| ${KIND_NAME[c.kind]} ${cell(c.name)} | ${show(c.before)} | ${show(c.after)} |`);
		lines.push('');
	}
	lines.push(
		`A few games are a small sample: read small differences with care. Old run: ${report.old.runDir}. New run: ${report.new.runDir}.`,
		''
	);
	return lines.join('\n');
}

/** Write `compare.json` and `compare.md` into `outDir`. */
export function writeCompare(oldDir: string, newDir: string, outDir: string): CompareReport {
	const report = compareRuns(oldDir, newDir);
	writeFileSync(join(outDir, 'compare.json'), `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(join(outDir, 'compare.md'), renderCompareMarkdown(report));
	return report;
}
