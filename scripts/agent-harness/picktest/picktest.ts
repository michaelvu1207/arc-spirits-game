/**
 * Pick test: re-ask a model the SUMMON decisions of recorded AI games on changed game data, and
 * measure how often each spirit is picked when offered. See README.md in this folder.
 *
 *   npx tsx scripts/agent-harness/picktest/picktest.ts extract
 *   npx tsx scripts/agent-harness/picktest/picktest.ts run --name base --data ~/ArcSpiritsArt/game
 *   npx tsx scripts/agent-harness/picktest/picktest.ts compare base changed
 *   npx tsx scripts/agent-harness/picktest/picktest.ts report base --noise noise-1
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BudgetGuard } from '../../../src/lib/play/agents/budget';
import { catalogHash, loadLocalDesignCatalog } from '../../../src/lib/play/agents/catalog';
import { LlmSeatController } from '../../../src/lib/play/agents/llmSeat';
import {
	extractSummonPoints,
	isFinishedGame,
	snapshotsAt,
	type SummonPoint
} from '../../../src/lib/play/agents/picktest/extract';
import { prepareTest, type OptionInfo } from '../../../src/lib/play/agents/picktest/request';
import {
	DESIRE_PROMPT,
	desireUserMessage,
	fitOf,
	parseDesire,
	CLASS_RULES,
	classify,
	desireStats,
	DESIRE_SCALE_HIGH,
	type DesireScore,
	type DesireStats,
	type Fit,
	type Offer,
	type SpiritClass
} from '../../../src/lib/play/agents/picktest/desire';
import { repairMessage, systemMessages } from '../../../src/lib/play/agents/prompt';
import type { AnswerAttempt, DecisionRequest } from '../../../src/lib/play/agents/contract';
import type { ChatMessage } from '../../../src/lib/play/agents/providers/types';
import {
	groupLabel,
	pct,
	rateText,
	reasonGroups,
	shortQuote,
	stratifiedSample,
	wilson
} from '../../../src/lib/play/agents/picktest/stats';
import { GatewayProvider, gatewayProviderOf } from '../../../src/lib/play/agents/providers/gateway';
import { GatewayPool, type GatewayAccount } from '../../../src/lib/play/agents/providers/gatewayPool';
import { buildRulesBrief } from '../../../src/lib/play/agents/rulesBrief';
import { readTranscript } from '../../../src/lib/play/agents/transcript';
import type { PlayCatalog, PlayCatalogSpirit } from '../../../src/lib/play/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const HARNESS = join(homedir(), 'arcspirits-harness');
const OUT = join(HARNESS, 'experiments', 'picktest');
const DEFAULT_MODEL = 'anthropic/claude-opus-5-5';
const DEFAULT_DATA = join(process.cwd(), 'data');

const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
const readJsonl = <T>(path: string): T[] =>
	existsSync(path)
		? readFileSync(path, 'utf8')
				.split('\n')
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as T)
		: [];
const writeJson = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

// ─── spirits ────────────────────────────────────────────────────────────────

type Group = 'Spirit World' | 'Arcane' | 'Hero' | 'Other';

function groupOf(s: PlayCatalogSpirit): Group {
	if (!Object.keys(s.origins).length) return 'Hero';
	if (s.cost <= 5) return 'Spirit World';
	if (s.cost >= 7 && s.cost <= 9) return 'Arcane';
	return 'Other';
}

interface SpiritInfo {
	id: string;
	name: string;
	classes: string;
	origin: string;
	cost: number;
	group: Group;
}

function spiritInfo(s: PlayCatalogSpirit): SpiritInfo {
	return {
		id: s.id,
		name: s.name,
		classes: Object.keys(s.classes).join(' / '),
		origin: Object.keys(s.origins).join(' / ').replace(/ Region/g, '') || 'none',
		cost: s.cost,
		group: groupOf(s)
	};
}

// ─── catalogs ───────────────────────────────────────────────────────────────

const catalogCache = new Map<string, PlayCatalog>();

/** The catalog a game was played with (from the league / benchmark data folders, hash checked). */
function gameCatalog(hash: string): PlayCatalog {
	const cached = catalogCache.get(hash);
	if (cached) return cached;
	for (const root of ['league', 'benchmark']) {
		const path = join(HARNESS, root, 'data', hash.slice(0, 12), 'catalog', 'play-catalog.json');
		if (!existsSync(path)) continue;
		const catalog = JSON.parse(readFileSync(path, 'utf8')) as PlayCatalog;
		if (catalogHash(catalog) !== hash) throw new Error(`${path}: hash does not match ${hash}`);
		catalogCache.set(hash, catalog);
		return catalog;
	}
	throw new Error(`no saved catalog for ${hash.slice(0, 12)}`);
}

// ─── extract ────────────────────────────────────────────────────────────────

function gameFiles(): { source: string; file: string }[] {
	const out: { source: string; file: string }[] = [];
	const add = (source: string, dir: string) => {
		if (!existsSync(dir)) return;
		for (const f of readdirSync(dir).sort())
			if (f.endsWith('.jsonl') && !f.includes('.abandoned')) out.push({ source, file: join(dir, f) });
	};
	for (const root of ['league', 'benchmark']) {
		const versions = join(HARNESS, root, 'versions');
		if (existsSync(versions))
			for (const v of readdirSync(versions).sort()) add(root, join(versions, v, 'games'));
	}
	const tournament = join(HARNESS, 'tournament');
	if (existsSync(tournament))
		for (const run of readdirSync(tournament).sort()) add(`tournament-${run}`, join(tournament, run, 'games'));
	return out;
}

interface HistoricRow extends SpiritInfo {
	offered: number;
	picked: number;
	draws: number;
	drawsPicked: number;
}

function extract(): void {
	const files = gameFiles();
	const points: SummonPoint[] = [];
	const skipped: Record<string, number> = {};
	let games = 0;
	for (const { source, file } of files) {
		const records = readTranscript(file);
		if (!isFinishedGame(records)) {
			skipped['not finished'] = (skipped['not finished'] ?? 0) + 1;
			continue;
		}
		const header = records[0];
		if (header.type !== 'header') continue;
		let catalog: PlayCatalog;
		try {
			catalog = gameCatalog(header.catalog.hash);
		} catch {
			skipped['no saved catalog'] = (skipped['no saved catalog'] ?? 0) + 1;
			continue;
		}
		let got: ReturnType<typeof extractSummonPoints>;
		try {
			got = extractSummonPoints(records, catalog, { source, file });
		} catch {
			// The current engine rejects a recorded command: the record no longer replays.
			skipped['replay rejected a recorded command'] = (skipped['replay rejected a recorded command'] ?? 0) + 1;
			continue;
		}
		if (!got.matches) {
			skipped['replay hash differs'] = (skipped['replay hash differs'] ?? 0) + 1;
			continue;
		}
		games += 1;
		points.push(...got.points);
		process.stdout.write(`\r${games} games, ${points.length} summon decisions`);
	}
	process.stdout.write('\n');
	mkdirSync(OUT, { recursive: true });
	writeFileSync(join(OUT, 'decisions.jsonl'), points.map((p) => JSON.stringify(p)).join('\n') + '\n');

	// Historic pick rate when offered (fallback answers left out). Per decision, and per draw: a
	// draw can be several decisions (summon up to 2); a spirit counts once per draw.
	const used = points.filter((p) => !p.fallback);
	const catalogs = [...new Set(used.map((p) => p.catalogHash))].map(gameCatalog);
	const spirits = new Map<string, PlayCatalogSpirit>();
	for (const c of catalogs) for (const s of c.spirits) spirits.set(s.id, s);
	const rows = new Map<string, HistoricRow>();
	const row = (id: string) => {
		let r = rows.get(id);
		if (!r) {
			const s = spirits.get(id);
			r = {
				...(s ? spiritInfo(s) : { id, name: id, classes: '?', origin: '?', cost: 0, group: 'Other' as Group }),
				offered: 0,
				picked: 0,
				draws: 0,
				drawsPicked: 0
			};
			rows.set(id, r);
		}
		return r;
	};
	for (const p of used) {
		for (const id of p.offered) row(id).offered += 1;
		if (p.pick === 'spirit' && p.pickedSpiritId) row(p.pickedSpiritId).picked += 1;
	}
	// Draws: consecutive decisions of a seat in one round whose hands are subsets of the first.
	let draw: { id: string; guids: Set<string>; offered: Set<string>; picked: Set<string> } | null = null;
	const finishDraw = () => {
		if (!draw) return;
		for (const id of draw.offered) {
			row(id).draws += 1;
			if (draw.picked.has(id)) row(id).drawsPicked += 1;
		}
		draw = null;
	};
	for (const p of used) {
		const guids = p.hand.map((h) => h.guid);
		const id = `${p.file}|${p.seat}|${p.round}`;
		if (!draw || draw.id !== id || !guids.every((g) => draw!.guids.has(g))) {
			finishDraw();
			draw = { id, guids: new Set(guids), offered: new Set(), picked: new Set() };
		}
		for (const s of p.offered) draw.offered.add(s);
		if (p.pickedSpiritId) draw.picked.add(p.pickedSpiritId);
	}
	finishDraw();
	const table = [...rows.values()].sort(
		(a, b) => a.picked / Math.max(1, a.offered) - b.picked / Math.max(1, b.offered) || b.offered - a.offered
	);
	writeJson(join(OUT, 'historic.json'), table);
	const csv = [
		'name,classes,origin,cost,group,offered,picked,pick_rate,draws_offered,draws_picked,draw_pick_rate',
		...table.map((r) =>
			[
				r.name,
				r.classes,
				r.origin,
				r.cost,
				r.group,
				r.offered,
				r.picked,
				(r.picked / Math.max(1, r.offered)).toFixed(3),
				r.draws,
				r.drawsPicked,
				(r.drawsPicked / Math.max(1, r.draws)).toFixed(3)
			]
				.map((v) => (typeof v === 'string' && /[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
				.join(',')
		)
	].join('\n');
	writeFileSync(join(OUT, 'historic.csv'), `${csv}\n`);
	const picks: Record<string, number> = {};
	for (const p of used) picks[p.pick] = (picks[p.pick] ?? 0) + 1;
	const summary = {
		at: new Date().toISOString(),
		files: files.length,
		games,
		skippedGames: skipped,
		decisions: points.length,
		fallbackDecisions: points.length - used.length,
		bySource: Object.fromEntries(
			[...new Set(points.map((p) => p.source))].map((s) => [s, points.filter((p) => p.source === s).length])
		),
		originalChoices: picks,
		spiritsOffered: table.length,
		spiritsInCatalog: spirits.size,
		neverOffered: [...spirits.values()].filter((s) => !rows.has(s.id)).map((s) => s.name)
	};
	writeJson(join(OUT, 'extract-summary.json'), summary);
	console.log(JSON.stringify(summary, null, 2));
	console.log(`wrote ${join(OUT, 'decisions.jsonl')}, historic.csv, historic.json`);
}

// ─── run ────────────────────────────────────────────────────────────────────

interface RunConfig {
	name: string;
	data: string;
	dataHash: string;
	model: string;
	effort: string;
	seed: number;
	perSpirit: number;
	n: number;
	spirits: string[];
	pointsFrom: string | null;
	/** The run whose stored questions (requests.jsonl + brief.txt) are sent again unchanged. */
	sameQuestionsAs?: string | null;
	/** plain (absent in older runs) or desire-v1. */
	prompt?: string;
	createdAt: string;
}

export interface TestResult {
	key: string;
	status: 'ok' | 'skip' | 'error';
	flags: string[];
	detail?: string;
	gameId: string;
	seat: string;
	round: number;
	source: string;
	originalModel: string;
	offered: string[];
	options?: OptionInfo[];
	/** Prompt version: plain (the seat's fresh question) or desire-v1 (plus a 0-10 score per offer). */
	prompt?: string;
	/** desire-v1: score per offered spirit id (null: the answer had no usable scores). */
	desire?: Record<string, DesireScore> | null;
	desireError?: string | null;
	/** The answer text when its scores could not be read. */
	desireRaw?: string;
	/** Whether each offered spirit fits the board (desire.ts). */
	fit?: Record<string, Fit>;
	answer?: string | null;
	pick?: string;
	pickedSpiritId?: string | null;
	reason?: string;
	repaired?: boolean;
	fallback?: boolean;
	original: { pick: string; spiritId: string | null; reason: string };
	sameAsRecorded?: boolean | null;
	promptTokens?: number;
	cachedPromptTokens?: number;
	completionTokens?: number;
	latencyMs?: number;
	at: string;
}

function loadPoints(): SummonPoint[] {
	const path = join(OUT, 'decisions.jsonl');
	if (!existsSync(path)) throw new Error(`no ${path}: run "extract" first`);
	return readJsonl<SummonPoint>(path);
}

interface GatewaySpec {
	label: string;
	url: string;
	provider?: string;
	tokenFile?: string;
}

/** A gateway that serves the model's provider, from the league / benchmark configs. */
function findGateway(model: string, label: string | undefined): GatewaySpec {
	const provider = gatewayProviderOf(model);
	for (const root of ['league', 'benchmark']) {
		const path = join(HARNESS, root, 'league.json');
		if (!existsSync(path)) continue;
		const config = JSON.parse(readFileSync(path, 'utf8')) as { gateways?: GatewaySpec[] };
		const hit = (config.gateways ?? []).find(
			(g) => (g.provider ?? 'openai-codex') === provider && (!label || g.label === label)
		);
		if (hit) return hit;
	}
	throw new Error(`no gateway for ${provider}${label ? ` with label ${label}` : ''} in league.json files`);
}

async function quota(pool: GatewayPool, account: GatewayAccount) {
	try {
		const u = await pool.readUsage(account);
		return u.windows.map((w) => `${w.id} ${w.usedPercent ?? '?'}%`).join(', ');
	} catch (err) {
		return `unknown (${(err as Error).message.slice(0, 100)})`;
	}
}

async function run(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			name: { type: 'string' },
			data: { type: 'string', default: DEFAULT_DATA },
			model: { type: 'string', default: DEFAULT_MODEL },
			effort: { type: 'string', default: 'medium' },
			n: { type: 'string', default: '600' },
			'per-spirit': { type: 'string', default: '9' },
			spirit: { type: 'string', multiple: true, default: [] },
			seed: { type: 'string', default: '1' },
			'points-from': { type: 'string' },
			'same-questions-as': { type: 'string' },
			concurrency: { type: 'string', default: '6' },
			gateway: { type: 'string' },
			'dry-run': { type: 'boolean', default: false },
			prompt: { type: 'string', default: 'desire' },
			'fit-only': { type: 'boolean', default: false },
			exclude: { type: 'string', multiple: true, default: [] }
		}
	});
	if (!values.name) throw new Error('give --name <run name>');
	const model = values.model!;
	if (model.startsWith('openrouter/')) throw new Error('openrouter models are not allowed');
	gatewayProviderOf(model);
	const dir = join(OUT, 'runs', values.name);
	if (!['plain', 'desire'].includes(values.prompt!)) throw new Error('--prompt is plain or desire');
	const promptVersion = values.prompt === 'desire' ? DESIRE_PROMPT : 'plain';
	const dataDir = expand(values.data!);
	const changed = loadLocalDesignCatalog(dataDir, REPO);
	const dataHash = catalogHash(changed);
	const configPath = join(dir, 'config.json');
	const planPath = join(dir, 'plan.json');
	let keys: string[];
	if (existsSync(configPath)) {
		const old = JSON.parse(readFileSync(configPath, 'utf8')) as RunConfig;
		if (old.dataHash !== dataHash || old.model !== model || (old.prompt ?? 'plain') !== promptVersion)
			throw new Error(
				`run ${values.name} exists with other data or model (${old.dataHash.slice(0, 12)} ${old.model}); use another --name`
			);
		keys = JSON.parse(readFileSync(planPath, 'utf8')) as string[];
		console.log(`resuming ${values.name}: ${keys.length} planned tests`);
	} else {
		const points = loadPoints().filter((p) => !p.fallback);
		const byName = new Map(changed.spirits.map((s) => [s.name.toLowerCase(), s.id]));
		const wanted = values.spirit!.map((n) => {
			const id = byName.get(n.toLowerCase());
			if (!id) throw new Error(`no spirit named "${n}" in ${dataDir}`);
			return id;
		});
		const n = Number(values.n);
		const reuse = values['same-questions-as'] ?? values['points-from'];
		if (reuse) {
			const from = JSON.parse(readFileSync(join(OUT, 'runs', reuse, 'plan.json'), 'utf8')) as string[];
			// With --spirit: only the decisions of that run that offer one of those spirits.
			const offers = new Map(points.map((p) => [p.key, p.offered]));
			keys = from
				.filter((k) => !wanted.length || (offers.get(k) ?? []).some((id) => wanted.includes(id)))
				.slice(0, n);
		} else {
			// --fit-only: a decision counts only for the spirits that FIT the board there;
			// --exclude: leave out the decisions of other runs.
			const excluded = new Set(
				values.exclude!.flatMap((r) => JSON.parse(readFileSync(join(OUT, 'runs', r, 'plan.json'), 'utf8')) as string[])
			);
			const pool = points.filter((p) => !excluded.has(p.key));
			keys = stratifiedSample(pool, (p) => (values['fit-only'] ? (p.fitting ?? []) : p.offered), {
				perSpirit: Number(values['per-spirit']),
				max: n,
				seed: Number(values.seed),
				...(wanted.length ? { spirits: new Set(wanted) } : {})
			}).map((p) => p.key);
		}
		const config: RunConfig = {
			name: values.name,
			data: dataDir,
			dataHash,
			model,
			effort: values.effort!,
			prompt: promptVersion,
			seed: Number(values.seed),
			perSpirit: Number(values['per-spirit']),
			n,
			spirits: values.spirit!,
			pointsFrom: values['same-questions-as'] ?? values['points-from'] ?? null,
			sameQuestionsAs: values['same-questions-as'] ?? null,
			createdAt: new Date().toISOString()
		};
		if (!values['dry-run']) {
			writeJson(configPath, config);
			writeJson(planPath, keys);
		}
		console.log(`planned ${keys.length} tests (data ${dataHash.slice(0, 12)}, model ${model})`);
	}

	const resultsPath = join(dir, 'results.jsonl');
	const done = new Set(readJsonl<TestResult>(resultsPath).filter((r) => r.status !== 'error').map((r) => r.key));
	const pointByKey = new Map(loadPoints().map((p) => [p.key, p]));
	const todo = keys.filter((k) => !done.has(k)).map((k) => {
		const p = pointByKey.get(k);
		if (!p) throw new Error(`planned test ${k} is not in decisions.jsonl (extract again?)`);
		return p;
	});
	console.log(`${done.size} done, ${todo.length} to go`);

	// Prepare every test (replay each game once), or load the stored questions of another run.
	type Ready = { point: SummonPoint; prepared: ReturnType<typeof prepareTest>; fit?: Record<string, Fit> };
	const ready: Ready[] = [];
	const byFile = new Map<string, SummonPoint[]>();
	const sameAs =
		(existsSync(configPath)
			? (JSON.parse(readFileSync(configPath, 'utf8')) as RunConfig).sameQuestionsAs
			: null) ?? values['same-questions-as'];
	let rulesBrief = buildRulesBrief(changed);
	if (sameAs) {
		const stored = new Map(
			readJsonl<{ key: string; prepared: ReturnType<typeof prepareTest>; fit?: Record<string, Fit> }>(
				join(OUT, 'runs', sameAs, 'requests.jsonl')
			).map((q) => [q.key, q])
		);
		rulesBrief = readFileSync(join(OUT, 'runs', sameAs, 'brief.txt'), 'utf8');
		for (const point of todo) {
			const q = stored.get(point.key);
			if (!q) throw new Error(`${point.key}: no stored question in run ${sameAs}`);
			const prepared = q.prepared;
			if (prepared.status === 'ok') {
				prepared.request.gameId = prepared.request.requestId = `picktest-${values.name}-${point.key}`;
			}
			ready.push({ point, prepared, ...(q.fit ? { fit: q.fit } : {}) });
		}
	} else for (const p of todo) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
	for (const [file, points] of byFile) {
		const records = readTranscript(file);
		const original = gameCatalog(points[0].catalogHash);
		const snaps = snapshotsAt(records, original, new Set(points.map((p) => p.line)));
		for (const point of points) {
			const snap = snaps.get(point.line);
			if (!snap) throw new Error(`${point.key}: decision not found by replay`);
			const prepared = prepareTest({
				point,
				state: snap.state,
				record: snap.record,
				original,
				changed,
				testId: `picktest-${values.name}-${point.key}`
			});
			// Fit is read on the state as asked (table spirits already updated to the changed data).
			const fit =
				prepared.status === 'ok'
					? Object.fromEntries(
							prepared.offered.map((id) => [id, fitOf(snap.state, point.seat, id, changed)])
						)
					: undefined;
			ready.push({ point, prepared, ...(fit ? { fit } : {}) });
		}
	}
	const skips = ready.filter((r) => r.prepared.status === 'skip');
	const flagCounts: Record<string, number> = {};
	for (const r of ready)
		for (const f of r.prepared.flags) {
			const k = f.replace(/:\d+$/, '');
			flagCounts[k] = (flagCounts[k] ?? 0) + 1;
		}
	const verbatim = ready.filter((r) => r.prepared.status === 'ok' && r.prepared.sameAsRecorded).length;
	console.log(
		`prepared ${ready.length}: ${ready.length - skips.length} valid (${verbatim} word for word the recorded question), ${skips.length} skipped; flags ${JSON.stringify(flagCounts)}`
	);
	for (const s of skips.slice(0, 5))
		if (s.prepared.status === 'skip') console.log(`  skip ${s.point.key}: ${s.prepared.detail}`);
	if (values['dry-run']) return;

	// Keep the exact questions (a later run can send them again unchanged: --same-questions-as).
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'brief.txt'), rulesBrief);
	for (const r of ready)
		appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify({ key: r.point.key, prepared: r.prepared, fit: r.fit })}\n`);

	const base = (point: SummonPoint) => ({
		key: point.key,
		gameId: point.gameId,
		seat: point.seat,
		round: point.round,
		source: point.source,
		originalModel: point.model,
		original: { pick: point.pick, spiritId: point.pickedSpiritId, reason: point.reason }
	});
	mkdirSync(dir, { recursive: true });
	for (const r of skips)
		if (r.prepared.status === 'skip')
			appendFileSync(
				resultsPath,
				`${JSON.stringify({ ...base(r.point), status: 'skip', flags: r.prepared.flags, detail: r.prepared.detail, offered: r.point.offered, at: new Date().toISOString() } satisfies TestResult)}\n`
			);

	const valid = ready.filter((r) => r.prepared.status === 'ok');
	if (!valid.length) return writeSummary(values.name);
	const gw = findGateway(model, values.gateway);
	const concurrency = Math.max(1, Number(values.concurrency));
	const pool = new GatewayPool(
		[{ label: gw.label, url: gw.url, provider: gatewayProviderOf(model), tokenFile: gw.tokenFile }],
		{
			gate: {
				maxConcurrent: concurrency,
				ratePerMin: 30,
				baseBackoffMs: 5_000,
				maxBackoffMs: 60_000,
				maxRateRetries: 30,
				maxLimitFailures: 20
			},
			onEvent: (t) => console.log(`gateway: ${t}`)
		}
	);
	await pool.check();
	const account = pool.accounts[0];
	const quotaBefore = await quota(pool, account);
	console.log(`quota before (${gw.label}): ${JSON.stringify(quotaBefore)}`);
	const provider = new GatewayProvider({ api: 'chat', history: 'messages', effort: values.effort!, pool });
	const controller = new LlmSeatController({
		provider,
		model,
		budget: new BudgetGuard({ maxSpendUsd: 1e9, maxTokens: 1e10, maxCalls: valid.length * 2 + 10 }),
		memory: 'fresh',
		statement: 'placeholder',
		label: 'picktest',
		maxTokens: 800
	});
	let next = 0;
	let finished = 0;
	const worker = async () => {
		for (;;) {
			const item = valid[next++];
			if (!item) return;
			const prepared = item.prepared;
			if (prepared.status !== 'ok') continue;
			let result: TestResult;
			try {
				const asked =
					promptVersion === DESIRE_PROMPT
						? await askWithDesire(controller, prepared.request, prepared.options, rulesBrief)
						: { answer: await controller.decide(prepared.request, { rulesBrief }), desire: undefined, desireError: undefined, desireRaw: '' };
				const answer = asked.answer;
				const chosen = prepared.options.find((o) => o.id === answer.response.actionId);
				const last = answer.attempts.at(-1);
				result = {
					...base(item.point),
					status: answer.fallback ? 'error' : 'ok',
					flags: prepared.flags,
					offered: prepared.offered,
					options: prepared.options,
					answer: answer.fallback ? null : answer.response.actionId,
					pick: answer.fallback ? undefined : chosen?.pick,
					pickedSpiritId: answer.fallback ? null : (chosen?.spiritId ?? null),
					reason: answer.fallback ? answer.fallbackReason : answer.response.reason,
					repaired: answer.repaired,
					fallback: answer.fallback,
					sameAsRecorded: prepared.sameAsRecorded,
					prompt: promptVersion,
					...(item.fit ? { fit: item.fit } : {}),
					...(asked.desire !== undefined ? { desire: asked.desire, desireError: asked.desireError } : {}),
					...(asked.desireRaw ? { desireRaw: asked.desireRaw } : {}),
					promptTokens: answer.attempts.reduce((n, a) => n + a.promptTokens, 0),
					cachedPromptTokens: answer.attempts.reduce((n, a) => n + (a.cachedPromptTokens ?? 0), 0),
					completionTokens: answer.attempts.reduce((n, a) => n + a.completionTokens, 0),
					latencyMs: last?.latencyMs ?? 0,
					at: new Date().toISOString()
				};
			} catch (err) {
				result = {
					...base(item.point),
					status: 'error',
					flags: prepared.flags,
					offered: prepared.offered,
					reason: (err as Error).message.slice(0, 200),
					at: new Date().toISOString()
				};
			} finally {
				pool.release(prepared.request.gameId);
			}
			appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
			finished += 1;
			if (finished % 10 === 0 || finished === valid.length)
				console.log(`${new Date().toISOString()} ${finished}/${valid.length} asked`);
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	const quotaAfter = await quota(pool, account);
	console.log(`quota after (${gw.label}): ${JSON.stringify(quotaAfter)}`);
	const qpath = join(dir, 'quota.jsonl');
	appendFileSync(qpath, `${JSON.stringify({ at: new Date().toISOString(), asked: valid.length, before: quotaBefore, after: quotaAfter })}\n`);
	writeSummary(values.name);
}

/**
 * One desire-v1 test: the same loop as LlmSeatController.decide (one repair turn on an unusable
 * action, provider failures retried, then the safe fallback), with the scoring line added to the
 * user message. The pick is parsed by the harness's parser; the scores come from the same answer.
 */
async function askWithDesire(
	controller: LlmSeatController,
	request: DecisionRequest,
	options: OptionInfo[],
	rulesBrief: string
) {
	const ids = options.filter((o) => o.pick === 'spirit').map((o) => o.id);
	const messages: ChatMessage[] = [
		...systemMessages(rulesBrief),
		{ role: 'user', content: desireUserMessage(request, ids) }
	];
	const attempts: AnswerAttempt[] = [];
	let desire: Record<string, DesireScore> | null = null;
	let desireError: string | null = 'no answer';
	let desireRaw = '';
	for (let attempt = 1; attempt <= 2; attempt++) {
		const res = await controller.callOnce(messages, request, attempt, { rulesBrief });
		attempts.push(res.attempt);
		if (!res.attempt.providerError) {
			const parsed = parseDesire(res.attempt.raw, ids);
			if (parsed.scores || !desire) {
				desire = parsed.scores;
				desireError = parsed.error;
				desireRaw = parsed.scores ? '' : res.attempt.raw.slice(0, 1500);
			}
		}
		if (res.attempt.parsedId) {
			// Scores by spirit id (the short ids are only valid inside this question).
			const bySpirit = desire
				? Object.fromEntries(
						Object.entries(desire).map(([id, d]) => [options.find((o) => o.id === id)!.spiritId!, d])
					)
				: null;
			return {
				answer: {
					response: { actionId: res.attempt.parsedId, reason: res.reason },
					attempts,
					repaired: attempt === 2,
					fallback: false,
					fallbackReason: undefined as string | undefined
				},
				desire: bySpirit,
				desireError,
				desireRaw
			};
		}
		if (res.fatal) break;
		if (res.attempt.providerError) continue;
		messages.push({ role: 'assistant', content: res.attempt.raw || '(empty)' });
		messages.push({ role: 'user', content: repairMessage(res.attempt.error ?? 'invalid answer', request) });
	}
	return {
		answer: {
			response: { actionId: '', reason: '' },
			attempts,
			repaired: false,
			fallback: true,
			fallbackReason: attempts.map((a) => a.error).filter(Boolean).join(' | ') || 'no valid answer'
		},
		desire: null,
		desireError,
		desireRaw
	};
}

// ─── summaries ──────────────────────────────────────────────────────────────

/** The latest result per key (an error retried later is replaced). */
function loadResults(name: string): TestResult[] {
	const all = readJsonl<TestResult>(join(OUT, 'runs', name, 'results.jsonl'));
	const byKey = new Map<string, TestResult>();
	for (const r of all) {
		const old = byKey.get(r.key);
		if (!old || old.status === 'error' || r.status !== 'error') byKey.set(r.key, r);
	}
	return [...byKey.values()];
}

function runCatalog(name: string): PlayCatalog {
	const config = JSON.parse(readFileSync(join(OUT, 'runs', name, 'config.json'), 'utf8')) as RunConfig;
	return loadLocalDesignCatalog(config.data, REPO);
}

interface SpiritRate extends SpiritInfo {
	offered: number;
	picked: number;
	/** Reasons of the tests where it was offered and not picked. */
	skipReasons: string[];
}

function spiritRates(results: TestResult[], catalog: PlayCatalog): Map<string, SpiritRate> {
	const spirits = new Map(catalog.spirits.map((s) => [s.id, s]));
	const out = new Map<string, SpiritRate>();
	for (const r of results) {
		if (r.status !== 'ok') continue;
		for (const id of new Set(r.offered)) {
			const s = spirits.get(id);
			let row = out.get(id);
			if (!row) {
				row = {
					...(s ? spiritInfo(s) : { id, name: id, classes: '?', origin: '?', cost: 0, group: 'Other' as Group }),
					offered: 0,
					picked: 0,
					skipReasons: []
				};
				out.set(id, row);
			}
			row.offered += 1;
			if (r.pick === 'spirit' && r.pickedSpiritId === id) row.picked += 1;
			else if (r.reason) row.skipReasons.push(r.reason);
		}
	}
	return out;
}

function writeSummary(name: string): void {
	const results = loadResults(name);
	const catalog = runCatalog(name);
	const rates = [...spiritRates(results, catalog).values()].sort(
		(a, b) => a.picked / a.offered - b.picked / b.offered
	);
	const ok = results.filter((r) => r.status === 'ok');
	const flags: Record<string, number> = {};
	for (const r of results)
		for (const f of r.flags) flags[f.replace(/:\d+$/, '')] = (flags[f.replace(/:\d+$/, '')] ?? 0) + 1;
	const picks: Record<string, number> = {};
	for (const r of ok) picks[r.pick ?? '?'] = (picks[r.pick ?? '?'] ?? 0) + 1;
	const quotas = readJsonl<unknown>(join(OUT, 'runs', name, 'quota.jsonl'));
	const summary = {
		name,
		at: new Date().toISOString(),
		tests: results.length,
		ok: ok.length,
		skipped: results.filter((r) => r.status === 'skip').length,
		errors: results.filter((r) => r.status === 'error').length,
		repaired: ok.filter((r) => r.repaired).length,
		flags,
		picks,
		agreementWithOriginal: agreement(ok),
		promptTokens: ok.reduce((n, r) => n + (r.promptTokens ?? 0), 0),
		cachedPromptTokens: ok.reduce((n, r) => n + (r.cachedPromptTokens ?? 0), 0),
		completionTokens: ok.reduce((n, r) => n + (r.completionTokens ?? 0), 0),
		quota: quotas,
		spirits: rates.map(({ skipReasons: _s, ...r }) => ({
			...r,
			rate: r.picked / r.offered,
			ci95: wilson(r.picked, r.offered)
		}))
	};
	writeJson(join(OUT, 'runs', name, 'summary.json'), summary);
	console.log(
		`summary: ${summary.ok} answered, ${summary.skipped} skipped, ${summary.errors} errors; agreement with original ${JSON.stringify(summary.agreementWithOriginal.all)}`
	);
}

const samePick = (r: TestResult) =>
	r.pick === r.original.pick && (r.pick !== 'spirit' || r.pickedSpiritId === r.original.spiritId);

function agreement(ok: TestResult[]) {
	const part = (rs: TestResult[]) => {
		const k = rs.filter(samePick).length;
		const chance = rs.reduce((n, r) => n + 1 / Math.max(1, r.options?.length ?? 1), 0);
		return { n: rs.length, same: k, rate: rs.length ? k / rs.length : 0, chance: rs.length ? chance / rs.length : 0 };
	};
	const clean = ok.filter((r) => r.sameAsRecorded && !r.flags.includes('harness-drift'));
	const fam = (r: TestResult) => (r.originalModel.includes('anthropic') ? 'opus' : 'gpt');
	return {
		all: part(ok),
		samePromptNoDrift: part(clean),
		originalOpus: part(clean.filter((r) => fam(r) === 'opus')),
		originalGpt: part(clean.filter((r) => fam(r) === 'gpt'))
	};
}

// ─── compare ────────────────────────────────────────────────────────────────

function reasonBlock(reasons: string[], name = ''): string {
	if (!reasons.length) return '';
	// Prefer quotes that name the spirit (a reason usually explains the spirit that WAS picked).
	const word = name.split(/[ ,]/)[0].toLowerCase();
	const named = word ? reasons.filter((r) => r.toLowerCase().includes(word)) : [];
	const counts = new Map<string, string[]>();
	for (const r of reasons) for (const g of reasonGroups(r)) counts.set(g, [...(counts.get(g) ?? []), r]);
	const top = [...counts.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
	const quotes = [...named, ...top[0][1].filter((r) => !named.includes(r))]
		.slice(0, 2)
		.map((q) => `"${shortQuote(q, 140)}"`);
	return `${top.map(([g, rs]) => `${groupLabel(g)} ${rs.length}`).join('; ')}${named.length ? `; names it in ${named.length}` : ''}. e.g. ${quotes.join(' / ')}`;
}

/** How many of the decisions asked in both runs got the same answer. */
function pairedLine(ra: TestResult[], rb: TestResult[]): string {
	const okB = new Map(rb.filter((r) => r.status === 'ok').map((r) => [r.key, r]));
	const pairs = ra.filter((r) => r.status === 'ok' && okB.has(r.key));
	const same = pairs.filter((r) => {
		const o = okB.get(r.key)!;
		return o.pick === r.pick && o.pickedSpiritId === r.pickedSpiritId;
	}).length;
	return pairs.length
		? `- The same decision asked in both runs: ${pairs.length}; same answer ${same} (${pct(same / pairs.length)}). For reference, the same questions asked twice gave the same answer 88% of the time (noise test, baseline.md).`
		: '- No decision was asked in both runs (unpaired comparison).';
}

const FIT_TEXT =
	'the board already has 2+ spirits of one of its origins, or 1+ of one of its classes when that class still has a higher breakpoint to reach or scales per spirit (a second copy of a one-breakpoint class such as Sharpshooter does not count), or its awaken condition needs Fallen and the player is Fallen (board = the seat\'s spirits, face-up or down).';
const num = (x?: number) => (x === undefined || Number.isNaN(x) ? '-' : x.toFixed(1));
const pctOr = (x?: number) => (x === undefined || Number.isNaN(x) ? '-' : pct(x));
function fitCell(s: DesireStats | undefined, fit: boolean): string {
	if (!s) return '-';
	const n = fit ? s.fitOffers : s.noFitOffers;
	if (!n) return 'n=0';
	return `n=${n}: ${pctOr(fit ? s.fitPickRate : s.noFitPickRate)}, ${num(fit ? s.fitDesire : s.noFitDesire)}`;
}

/** Every offer of every spirit in a run's answered desire tests. */
function offersOf(results: TestResult[], catalog: PlayCatalog): Map<string, Offer[]> {
	const spirits = new Map(catalog.spirits.map((s) => [s.id, s]));
	const out = new Map<string, Offer[]>();
	for (const r of results) {
		if (r.status !== 'ok' || r.desire === undefined) continue;
		for (const id of new Set(r.offered)) {
			const s = spirits.get(id);
			const d = r.desire?.[id];
			out.set(id, [
				...(out.get(id) ?? []),
				{
					spiritId: id,
					group: s ? groupOf(s) : 'Other',
					picked: r.pick === 'spirit' && r.pickedSpiritId === id,
					score: d ? d.score : null,
					why: d?.why ?? '',
					fits: !!r.fit?.[id]?.fits
				}
			]);
		}
	}
	return out;
}

/** Per-spirit desire numbers and classes of a run (the group pick rate is the run's own). */
function desireBySpirit(results: TestResult[], catalog: PlayCatalog) {
	const offers = offersOf(results, catalog);
	const stats = new Map([...offers].map(([id, os]) => [id, desireStats(os)]));
	const groupRate = new Map<string, number>();
	const all = [...offers.values()].flat();
	for (const g of new Set(all.map((o) => o.group))) {
		const os = all.filter((o) => o.group === g);
		groupRate.set(g, os.filter((o) => o.picked).length / os.length);
	}
	const classes = new Map<string, SpiritClass>(
		[...stats].map(([id, s]) => [id, classify(s, groupRate.get(offers.get(id)![0].group) ?? 0)])
	);
	return { offers, stats, classes, groupRate };
}

function compare(a: string, b: string): string {
	const ra = loadResults(a);
	const rb = loadResults(b);
	const ca = runCatalog(a);
	const cb = runCatalog(b);
	const A = spiritRates(ra, ca);
	const B = spiritRates(rb, cb);
	const ids = [...new Set([...A.keys(), ...B.keys()])];
	const rows = ids
		.map((id) => ({ id, a: A.get(id), b: B.get(id) }))
		.sort((x, y) => {
			const d = (r?: SpiritRate) => (r && r.offered ? r.picked / r.offered : 0);
			return d(y.b) - d(y.a) - (d(x.b) - d(x.a));
		});
	const count = (rs: TestResult[], s: TestResult['status']) => rs.filter((r) => r.status === s).length;
	const lines = [
		`# Pick test: ${a} vs ${b}`,
		'',
		`- ${a}: ${count(ra, 'ok')} answered, ${count(ra, 'skip')} skipped (data no longer fits), ${count(ra, 'error')} errors`,
		`- ${b}: ${count(rb, 'ok')} answered, ${count(rb, 'skip')} skipped (data no longer fits), ${count(rb, 'error')} errors`,
		pairedLine(ra, rb),
		'- Rates are "picked when offered"; [lo-hi] is a 95% interval. Changes where the intervals do not overlap are marked **.',
		'',
		`| Spirit | Cost | Classes | ${a} | ${b} | Change | Why ${b} skipped it |`,
		'|---|---|---|---|---|---|---|'
	];
	for (const { id, a: x, b: y } of rows) {
		const info = y ?? x!;
		const ra2 = x ? x.picked / x.offered : null;
		const rb2 = y ? y.picked / y.offered : null;
		const ia = x ? wilson(x.picked, x.offered) : null;
		const ib = y ? wilson(y.picked, y.offered) : null;
		const sig = ia && ib && (ia[1] < ib[0] || ib[1] < ia[0]) ? '**' : '';
		const change = ra2 !== null && rb2 !== null ? `${sig}${rb2 >= ra2 ? '+' : ''}${Math.round((rb2 - ra2) * 100)} pts${sig}` : '-';
		const costA = x && y && x.cost !== y.cost ? `${x.cost}→${y.cost}` : String(info.cost);
		lines.push(
			`| ${info.name} | ${costA} | ${info.classes} | ${x ? rateText(x.picked, x.offered) : '-'} | ${y ? rateText(y.picked, y.offered) : '-'} | ${change} | ${y ? reasonBlock(y.skipReasons, info.name).replace(/\|/g, '/') : ''} |`
		);
	}
	if (ra.some((r) => r.desire) || rb.some((r) => r.desire)) {
		const da = desireBySpirit(ra, ca);
		const db = desireBySpirit(rb, cb);
		const promptOf = (rs: TestResult[]) => rs.find((r) => r.status === 'ok')?.prompt ?? 'plain';
		lines.push(
			'',
			'## Desire and fit',
			'',
			promptOf(ra) !== promptOf(rb)
				? `WARNING: the runs used different prompts (${promptOf(ra)} vs ${promptOf(rb)}); compare only runs made with the same prompt.`
				: `Both runs used prompt ${promptOf(ra)}.`,
			`Desire = the model's 0-10 score for the spirit when offered. Fits = ${FIT_TEXT} Instant = share of fitting offers scored >= ${DESIRE_SCALE_HIGH} AND picked.`,
			'',
			`| Spirit | Class ${a} → ${b} | Desire ${a} → ${b} | When it fits: pick, desire (${a} → ${b}) | When not: pick, desire (${a} → ${b}) | Instant ${a} → ${b} |`,
			'|---|---|---|---|---|---|'
		);
		const ids2 = [...new Set([...da.stats.keys(), ...db.stats.keys()])].sort(
			(x, y) => (db.stats.get(y)?.desire ?? 0) - (da.stats.get(y)?.desire ?? 0) - ((db.stats.get(x)?.desire ?? 0) - (da.stats.get(x)?.desire ?? 0))
		);
		for (const id of ids2) {
			const x = da.stats.get(id);
			const y = db.stats.get(id);
			const name = (cb.spirits.find((s) => s.id === id) ?? ca.spirits.find((s) => s.id === id))?.name ?? id;
			lines.push(
				`| ${name} | ${da.classes.get(id) ?? '-'} → ${db.classes.get(id) ?? '-'} | ${num(x?.desire)} → ${num(y?.desire)} | ${fitCell(x, true)} → ${fitCell(y, true)} | ${fitCell(x, false)} → ${fitCell(y, false)} | ${pctOr(x?.instantRate)} → ${pctOr(y?.instantRate)} |`
			);
		}
	}
	const skipped = rb.filter((r) => r.status === 'skip');
	if (skipped.length) {
		const byFlag = new Map<string, number>();
		for (const r of skipped) byFlag.set(r.flags[0], (byFlag.get(r.flags[0]) ?? 0) + 1);
		lines.push('', `## Skipped tests in ${b}`, '', ...[...byFlag].map(([f, n]) => `- ${f}: ${n}`));
		for (const r of skipped.slice(0, 5)) lines.push(`  - ${r.key}: ${r.detail}`);
	}
	const text = lines.join('\n');
	writeFileSync(join(OUT, 'runs', b, `compare-${a}.md`), `${text}\n`);
	return text;
}

// ─── report (baseline) ──────────────────────────────────────────────────────

function report(name: string, noise: string | null): string {
	const results = loadResults(name);
	const catalog = runCatalog(name);
	const rates = spiritRates(results, catalog);
	const historic = new Map(
		(JSON.parse(readFileSync(join(OUT, 'historic.json'), 'utf8')) as HistoricRow[]).map((h) => [h.id, h])
	);
	const extractSummary = JSON.parse(readFileSync(join(OUT, 'extract-summary.json'), 'utf8')) as {
		games: number;
		decisions: number;
		bySource: Record<string, number>;
	};
	const ok = results.filter((r) => r.status === 'ok');
	const summary = JSON.parse(readFileSync(join(OUT, 'runs', name, 'summary.json'), 'utf8')) as {
		agreementWithOriginal: ReturnType<typeof agreement>;
		picks: Record<string, number>;
		quota: { before: string; after: string; asked: number }[];
		skipped: number;
		errors: number;
		flags: Record<string, number>;
	};
	const rate = (k: number, n: number) => (n ? k / n : NaN);
	const label = (k: number, n: number) => {
		if (n < 4) return 'few tests';
		if (k === 0) return 'NEVER';
		if (k / n < 0.15) return 'RARELY';
		return '';
	};
	const all = catalog.spirits.map((s) => {
		const r = rates.get(s.id);
		const h = historic.get(s.id);
		return { info: spiritInfo(s), r, h };
	});
	all.sort((x, y) => {
		const rx = x.r ? rate(x.r.picked, x.r.offered) : 2;
		const ry = y.r ? rate(y.r.picked, y.r.offered) : 2;
		return rx - ry || (x.h ? rate(x.h.picked, x.h.offered) : 2) - (y.h ? rate(y.h.picked, y.h.offered) : 2);
	});
	const L: string[] = [];
	const ag = summary.agreementWithOriginal;
	const flagged = all.filter((x) => x.r && ['NEVER', 'RARELY'].includes(label(x.r.picked, x.r.offered)));
	const histFlagged = all.filter((x) => x.h && x.h.offered >= 4 && x.h.picked / x.h.offered < 0.15);
	L.push(
		'# Pick test baseline: current data, Claude Opus 5.5',
		'',
		`Data: ${JSON.parse(readFileSync(join(OUT, 'runs', name, 'config.json'), 'utf8')).data} (unchanged). Recorded games: ${extractSummary.games} finished games, ${extractSummary.decisions} summon decisions where a spirit could be summoned (${Object.entries(extractSummary.bySource).map(([k, v]) => `${k} ${v}`).join(', ')}).`,
		`Re-asked: ${ok.length} decisions answered by Opus (fresh question: rules + the decision, no strategy, no notebook, no plan note); ${summary.skipped} skipped, ${summary.errors} errors.`,
		'',
		'"Pick rate" = how often the spirit was summoned when it was one of the options. A decision usually offers 2-4 spirits plus "none" (and sometimes a redraw), so even a good spirit is often passed over for a better one in the same hand.',
		'"Historic" = what the original AI players (GPT and Opus seats of the league, benchmark and tournament) chose in those games; "Re-asked" = Opus asked again at the same moment.',
		''
	);
	L.push(
		'## Result',
		'',
		`- Rarely or never picked when re-asked (under 15%, at least 4 tests): ${flagged.length} of ${all.filter((x) => x.r).length} spirits tested: ${flagged.map((x) => `${x.info.name} (${x.r!.picked}/${x.r!.offered})`).join(', ') || 'none'}.`,
		`- Rarely or never picked in the original games (under 15%, offered at least 4 times): ${histFlagged.length}: ${histFlagged.map((x) => `${x.info.name} (${x.h!.picked}/${x.h!.offered})`).join(', ') || 'none'}.`,
		`- Never offered in the records (not testable here): ${all.filter((x) => !x.h).map((x) => x.info.name).join(', ') || 'none'}.`,
		`- What Opus chose overall: ${Object.entries(summary.picks).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
		''
	);
	L.push(
		'## How reliable the test is',
		'',
		`- Agreement with the original player (same choice): ${pct(ag.all.rate)} of ${ag.all.n} (chance alone would give about ${pct(ag.all.chance)}).`,
		`  - where the original player was Opus too: ${pct(ag.originalOpus.rate)} of ${ag.originalOpus.n}; where it was a GPT model: ${pct(ag.originalGpt.rate)} of ${ag.originalGpt.n}.`,
		`  - The rebuilt question was word for word the recorded one in ${ok.filter((r) => r.sameAsRecorded).length} of ${ok.length} tests (the rest differ only because the current harness changed since the game: ${summary.flags['harness-drift'] ?? 0} tests have a different action list, e.g. reward hexes now offered).`
	);
	const sameAnswers = (x: TestResult[], y: TestResult[]) => {
		const m = new Map(y.filter((r) => r.status === 'ok').map((r) => [r.key, r]));
		const pairs = x.filter((r) => r.status === 'ok' && m.has(r.key));
		const same = pairs.filter((r) => {
			const o = m.get(r.key)!;
			return o.pick === r.pick && o.pickedSpiritId === r.pickedSpiritId;
		}).length;
		return { n: pairs.length, same };
	};
	if (noise) {
		// "a,b": two runs that sent the SAME stored questions (--same-questions-as).
		const [na, nb] = noise.split(',');
		const n1 = sameAnswers(loadResults(na), loadResults(nb));
		L.push(
			`- Noise of the test itself: the same ${n1.n} questions, sent twice byte for byte, got the same answer ${n1.same} times (${pct(rate(n1.same, n1.n))}). So roughly 1 answer in ${Math.max(1, Math.round(n1.n / Math.max(1, n1.n - n1.same)))} flips on a re-ask; with ~12 tests per spirit the 95% interval of a pick rate is about ±25 points, so only big differences between spirits (or before/after) are real.`
		);
		const n2 = sameAnswers(ok, loadResults(na));
		L.push(
			`- The same ${n2.n} decisions in this run and in ${na} (asked minutes later, after another agent changed the harness's prompt wording, e.g. "Spirits (4/7 slots at your status)" became "Spirits (4/7 slots)"): same answer ${n2.same} times (${pct(rate(n2.same, n2.n))}). Small wording changes move answers too: compare runs made with the same code.`
		);
	}
	const both = all.filter((x) => x.r && x.h && x.r.offered >= 4);
	const xs = both.map((x) => x.h!.picked / x.h!.offered);
	const ys = both.map((x) => x.r!.picked / x.r!.offered);
	L.push(
		`- Per spirit, the re-asked pick rates follow the historic ones: correlation ${pearson(xs, ys).toFixed(2)} over ${both.length} spirits (1 = same order, 0 = unrelated).`
	);
	const q = summary.quota;
	if (q.length)
		L.push(
			`- Claude quota (${q.reduce((n, x) => n + x.asked, 0)} questions in this run): before ${q[0].before}; after ${q.at(-1)!.after}.`
		);
	L.push('');
	L.push(
		'## All spirits, by re-asked pick rate (lowest first)',
		'',
		'| Spirit | Group | Cost | Origin | Classes | Re-asked (Opus) | Historic | Flag | Why Opus passed on it (keyword groups; examples) |',
		'|---|---|---|---|---|---|---|---|---|'
	);
	for (const { info, r, h } of all) {
		const flag = r ? label(r.picked, r.offered) : 'not tested';
		const hflag = h && h.offered >= 4 && h.picked / h.offered < 0.15 ? (h.picked ? 'rarely (hist.)' : 'never (hist.)') : '';
		L.push(
			`| ${info.name} | ${info.group} | ${info.cost} | ${info.origin} | ${info.classes} | ${r ? rateText(r.picked, r.offered) : '-'} | ${h ? rateText(h.picked, h.offered) : 'never offered'} | ${[flag, hflag].filter(Boolean).join(', ')} | ${r && ['NEVER', 'RARELY'].includes(flag) ? reasonBlock(r.skipReasons, info.name).replace(/\|/g, '/') : ''} |`
		);
	}
	// Roll-ups: by class and by group (one entry per offered spirit).
	const roll = (keyOf: (s: SpiritInfo) => string[]) => {
		const m = new Map<string, { k: number; n: number; hk: number; hn: number; spirits: Set<string> }>();
		for (const { info, r, h } of all)
			for (const key of keyOf(info)) {
				const e = m.get(key) ?? { k: 0, n: 0, hk: 0, hn: 0, spirits: new Set<string>() };
				e.spirits.add(info.name);
				if (r) {
					e.k += r.picked;
					e.n += r.offered;
				}
				if (h) {
					e.hk += h.picked;
					e.hn += h.offered;
				}
				m.set(key, e);
			}
		return [...m.entries()].sort((a, b) => rate(a[1].k, a[1].n) - rate(b[1].k, b[1].n));
	};
	L.push(
		'',
		'## By group',
		'',
		'| Group | Spirits | Re-asked | Historic |',
		'|---|---|---|---|',
		...roll((s) => [s.group]).map(([g, e]) => `| ${g} | ${e.spirits.size} | ${rateText(e.k, e.n)} | ${rateText(e.hk, e.hn)} |`)
	);
	L.push(
		'',
		'## By class (a spirit with two classes counts in both)',
		'',
		'| Class | Spirits | Re-asked | Historic | Flag |',
		'|---|---|---|---|---|',
		...roll((s) => s.classes.split(' / ').filter(Boolean)).map(
			([c, e]) =>
				`| ${c} | ${[...e.spirits].join(', ')} | ${rateText(e.k, e.n)} | ${rateText(e.hk, e.hn)} | ${e.n >= 4 ? label(e.k, e.n) : ''} |`
		)
	);
	L.push(
		'',
		'## What a pick test cannot show',
		'',
		'- It measures whether a spirit LOOKS worth taking to a strong model at the moment of choice, not whether taking it wins games. A spirit can be picked often and still be weak (a trap), or skipped and still be strong once built around.',
		'- One model, one decision, no memory: the model has no strategy and no notes, so it judges each offer cold. Players with a plan (the league agents) value build-around spirits differently.',
		'- The game state comes from the recorded game. After a data change the history before the decision is the OLD game (the table spirits are updated to the new text, but earlier choices, dice, barrier and VP are not).',
		'- Spirits offered rarely in the records get few tests and wide intervals; spirits never drawn cannot be tested at all.',
		'- The pick rate depends on the competition in the same hand: a spirit drawn next to strong ones looks worse.',
		''
	);
	const text = L.join('\n');
	return text;
}

function pearson(xs: number[], ys: number[]): number {
	const n = xs.length;
	if (n < 3) return NaN;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxy / Math.sqrt(sxx * syy);
}

/**
 * Recompute the fit marks of a run's answered tests with the current fit rule (desire.ts), by
 * replaying their states on the run's data. results.jsonl is rewritten (the answers are kept).
 */
function refit(name: string): void {
	const dir = join(OUT, 'runs', name);
	const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as RunConfig;
	const changed = loadLocalDesignCatalog(config.data, REPO);
	if (catalogHash(changed) !== config.dataHash)
		throw new Error(`${config.data} no longer has the run's data (${config.dataHash.slice(0, 12)})`);
	const all = readJsonl<TestResult>(join(dir, 'results.jsonl'));
	const pointByKey = new Map(loadPoints().map((p) => [p.key, p]));
	const byFile = new Map<string, SummonPoint[]>();
	for (const r of all) {
		if (r.status !== 'ok') continue;
		const p = pointByKey.get(r.key);
		if (!p) throw new Error(`${r.key} not in decisions.jsonl`);
		if (!(byFile.get(p.file) ?? []).includes(p)) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
	}
	const fits = new Map<string, Record<string, Fit>>();
	for (const [file, points] of byFile) {
		const original = gameCatalog(points[0].catalogHash);
		const snaps = snapshotsAt(readTranscript(file), original, new Set(points.map((p) => p.line)));
		for (const point of points) {
			const snap = snaps.get(point.line)!;
			const prepared = prepareTest({ point, state: snap.state, record: snap.record, original, changed, testId: 'refit' });
			if (prepared.status !== 'ok') continue;
			fits.set(point.key, Object.fromEntries(prepared.offered.map((id) => [id, fitOf(snap.state, point.seat, id, changed)])));
		}
	}
	const out = all.map((r) => (fits.has(r.key) ? { ...r, fit: fits.get(r.key) } : r));
	writeFileSync(join(dir, 'results.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
	console.log(`${name}: fit recomputed for ${fits.size} tests`);
}

// ─── desire report ──────────────────────────────────────────────────────────

const CLASS_ORDER: SpiritClass[] = ['Generalist', 'Build-around', 'Situational', 'Unclear', 'Dead'];

function desireReport(names: string[], mixed: boolean): string {
	const name = names[0];
	const results = names.flatMap((n) => loadResults(n));
	const mixNotes: string[] = [];
	for (const n of names.slice(1)) {
		const c = JSON.parse(readFileSync(join(OUT, 'runs', n, 'config.json'), 'utf8')) as RunConfig;
		const c0 = JSON.parse(readFileSync(join(OUT, 'runs', name, 'config.json'), 'utf8')) as RunConfig;
		if (c.prompt !== c0.prompt || c.model !== c0.model)
			throw new Error(`run ${n} has another prompt or model than ${name}`);
		if (c.dataHash !== c0.dataHash) {
			if (!mixed) throw new Error(`run ${n} has other data than ${name} (pass --mixed to merge anyway)`);
			mixNotes.push(`${n} used data ${c.dataHash.slice(0, 12)} (${c.data}), ${name} used ${c0.dataHash.slice(0, 12)} (${c0.data})`);
		}
	}
	const catalog = runCatalog(name);
	const config = JSON.parse(readFileSync(join(OUT, 'runs', name, 'config.json'), 'utf8')) as RunConfig;
	const { offers, stats, classes, groupRate } = desireBySpirit(results, catalog);
	const ok = results.filter((r) => r.status === 'ok');
	const noScores = ok.filter((r) => !r.desire).length;
	const spirits = new Map(catalog.spirits.map((s) => [s.id, s]));
	const rows = [...stats.entries()]
		.map(([id, s]) => ({ id, s, info: spiritInfo(spirits.get(id)!), cls: classes.get(id)! }))
		.sort((x, y) => CLASS_ORDER.indexOf(x.cls) - CLASS_ORDER.indexOf(y.cls) || y.s.desire - x.s.desire);
	const count = (c: SpiritClass) => rows.filter((r) => r.cls === c);
	const quota = names.flatMap((n) =>
		readJsonl<{ before: string; after: string; asked: number }>(join(OUT, 'runs', n, 'quota.jsonl'))
	);
	const xs = rows.map((r) => r.s.pickRate);
	const ys = rows.map((r) => r.s.desire);
	const R = CLASS_RULES;
	const L: string[] = [
		'# Desire baseline: current data, Claude Opus 5.5',
		'',
		`Data: ${config.data} (unchanged). Runs: ${names.join(' + ')}. Prompt ${config.prompt}: recorded summon decisions (${ok.length} answered, ${results.length - ok.length} not), and in the same answer Opus scored EVERY offered spirit 0-10 for "how much do you want this spirit for your board right now" with a few words why (${noScores} answers had no usable scores). This prompt differs from the plain pick test, so compare only runs made with it.`,
		...(mixNotes.length ? ['', `NOTE: runs on different data were merged (--mixed): ${mixNotes.join('; ')}.`] : []),
		'',
		'## Terms',
		'',
		'- Pick rate: share of offers where the spirit was summoned.',
		'- Desire: the average 0-10 score when offered. ">= 8" = share of offers scored 8 or more.',
		`- Fits: ${FIT_TEXT}`,
		`- Instant pick: share of FITTING offers where it scored >= ${DESIRE_SCALE_HIGH} and was picked.`,
		`- Group pick rate (fair share; an Abyss draw offers 3 and summons 1, a Spirit World draw offers 4 and summons up to 2): ${[...groupRate].map(([g, r]) => `${g} ${pct(r)}`).join(', ')}.`,
		'',
		'Classes (checked in this order):',
		`- Generalist: pick rate at or above its group's pick rate AND desire >= ${R.generalistDesire}.`,
		`- Build-around: otherwise, with >= ${R.minFit} fitting offers, desire when it fits >= ${R.buildDesire} OR instant-pick rate >= ${pct(R.buildInstant)}.`,
		`- Dead: otherwise, with >= ${R.minFit} fitting offers, desire when it fits below ${R.deadDesire}.`,
		`- Unclear: low overall desire (below ${R.deadDesire}) but fewer than ${R.minFit} fitting offers, so "dead" and "build-around for a rare board" cannot be told apart.`,
		'- Situational: everything else (wanted sometimes, neither plain good nor dead).',
		'',
		'## Result',
		'',
		...CLASS_ORDER.map((c) => `- ${c}: ${count(c).length}: ${count(c).map((r) => r.info.name).join(', ') || 'none'}.`),
		`- Pick rate and desire go together but not fully: correlation ${pearson(xs, ys).toFixed(2)} over ${rows.length} spirits.`,
		...(quota.length ? [`- Claude quota: before ${quota[0].before}; after ${quota.at(-1)!.after} (${quota.reduce((n, q) => n + q.asked, 0)} questions).`] : []),
		'',
		'## Dead spirits: what Opus said about them',
		''
	];
	for (const r of count('Dead')) {
		const os = offers.get(r.id)!.filter((o) => o.score !== null).sort((a, b) => a.score! - b.score!);
		const groups = new Map<string, number>();
		for (const o of os) for (const g of reasonGroups(o.why)) groups.set(g, (groups.get(g) ?? 0) + 1);
		const top = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 3);
		const quotes = [...new Set(os.map((o) => o.why).filter(Boolean))].slice(0, 3);
		L.push(
			`- ${r.info.name} (${r.info.group}, cost ${r.info.cost}, ${r.info.classes}): desire ${num(r.s.desire)} (when it fits ${num(r.s.fitDesire)}, n=${r.s.fitOffers}), picked ${r.s.picked}/${r.s.offers}. ${top.map(([g, n]) => `${groupLabel(g)} ${n}`).join('; ')}. e.g. ${quotes.map((q) => `"${q}"`).join(', ')}`
		);
	}
	L.push(
		'',
		'## All spirits, by class, then desire',
		'',
		'| Spirit | Group | Cost | Classes | Class | Pick rate | Desire | >= 8 | When it fits: n, pick, desire | When not: n, pick, desire | Instant pick |',
		'|---|---|---|---|---|---|---|---|---|---|---|'
	);
	for (const r of rows)
		L.push(
			`| ${r.info.name} | ${r.info.group} | ${r.info.cost} | ${r.info.classes} | ${r.cls} | ${rateText(r.s.picked, r.s.offers)} | ${num(r.s.desire)} | ${pctOr(r.s.highShare)} | ${fitCell(r.s, true)} | ${fitCell(r.s, false)} | ${pctOr(r.s.instantRate)} |`
		);
	L.push(
		'',
		'## Limits',
		'',
		'- Desire is what Opus SAYS it wants, scored in the same answer as its pick; it is one cold question with no strategy, so build-around spirits may be underrated by a model without a plan.',
		'- "Fits" is a simple board test (origins, classes, Fallen); it does not know about runes held, slot room or the player\'s plan.',
		`- About 12-20 offers per spirit; fitting offers are fewer (see n). Classes near a threshold can change on a re-run: the noise test showed 88% of picks repeat on an identical question.`,
		''
	);
	return L.join('\n');
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case 'extract':
			return extract();
		case 'run':
			return run(rest);
		case 'summary':
			return writeSummary(rest[0]);
		case 'compare': {
			if (rest.length < 2) throw new Error('compare <runA> <runB>');
			console.log(compare(rest[0], rest[1]));
			return;
		}
		case 'refit':
			for (const n of rest) refit(n);
			return;
		case 'desire-report': {
			const { values, positionals } = parseArgs({
				args: rest,
				allowPositionals: true,
				options: { out: { type: 'string' }, mixed: { type: 'boolean', default: false } }
			});
			const out = values.out ? expand(values.out) : join(OUT, 'runs', positionals[0], 'desire-report.md');
			writeFileSync(out, `${desireReport(positionals, values.mixed!)}\n`);
			console.log(`wrote ${out}`);
			return;
		}
		case 'report': {
			const { values, positionals } = parseArgs({
				args: rest,
				allowPositionals: true,
				options: { noise: { type: 'string' }, out: { type: 'string' } }
			});
			const text = report(positionals[0], values.noise ?? null);
			const out = values.out ? expand(values.out) : join(OUT, 'runs', positionals[0], 'report.md');
			writeFileSync(out, `${text}\n`);
			console.log(`wrote ${out}`);
			return;
		}
		default:
			console.log('usage: picktest.ts extract | run --name <n> [--data dir] [--model id] [--n N] [--spirit name]... [--seed s] [--dry-run] | summary <run> | compare <runA> <runB> | report <run> [--noise <run>] [--out file]');
	}
}

main().catch((err) => {
	console.error(`error: ${(err as Error).stack ?? err}`);
	process.exit(1);
});
