/**
 * Reasoning check for gateway seats: does each decision of a long seat conversation reason at
 * its effort? Plays real harness games (one `gw:` seat against a `mock:greedy` seat, same seed for
 * every combination) and stops each game after the gw seat's N-th call. Records reasoning tokens,
 * latency and cached input per call, for every model × effort × history mode.
 *
 *   npx tsx scripts/agent-harness/reasoning-check.ts \
 *     --models gpt-6.1-sol,gpt-6-luna --efforts low,medium,high --history messages,reasoning,single
 *
 * Output: <out>/<run-id>/calls.jsonl (one line per call) and report.md (turns 1, 2, 5, N).
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BudgetGuard } from '../../src/lib/play/agents/budget';
import { CallGate } from '../../src/lib/play/agents/callGate';
import { loadCatalogSpec } from '../../src/lib/play/agents/catalog';
import type {
	ControllerAnswer,
	DecideContext,
	DecisionRequest,
	SeatController
} from '../../src/lib/play/agents/contract';
import { LlmSeatController } from '../../src/lib/play/agents/llmSeat';
import {
	assertGatewayModel,
	GATEWAY_HISTORIES,
	GatewayProvider,
	type GatewayHistory
} from '../../src/lib/play/agents/providers/gateway';
import { MockProvider } from '../../src/lib/play/agents/providers/mock';
import { buildRulesBrief } from '../../src/lib/play/agents/rulesBrief';
import { runAgentGame } from '../../src/lib/play/agents/runner';

const { values } = parseArgs({
	options: {
		models: { type: 'string', default: 'gpt-6.1-sol,gpt-6.1-terra,gpt-6-astra,gpt-6-luna' },
		efforts: { type: 'string', default: 'low,medium,high' },
		history: { type: 'string', default: 'messages,reasoning,single' },
		turns: { type: 'string', default: '20' },
		'report-turns': { type: 'string', default: '1,2,5' },
		seed: { type: 'string', default: '7' },
		catalog: { type: 'string', default: 'local' },
		out: { type: 'string', default: 'output/agent-harness' },
		'run-id': { type: 'string' },
		'gw-urls': { type: 'string' },
		'gw-token-file': { type: 'string' },
		'gw-api': { type: 'string', default: 'responses' },
		'max-concurrent-calls': { type: 'string', default: '12' },
		/** Text added to the system instructions (a think-first rule) — a test option. */
		'system-suffix': { type: 'string' },
		'reasoning-summary': { type: 'string' }
	}
});

const list = (s: string | undefined) =>
	(s ?? '')
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);

interface CallRow {
	history: GatewayHistory;
	model: string;
	effort: string;
	turn: number;
	reasoningTokens: number;
	completionTokens: number;
	promptTokens: number;
	cachedPromptTokens: number;
	latencyMs: number;
	valid: boolean;
	kind: string;
}

/** Wraps the gw seat: records each call, and stops the game after `turns` decisions. */
class CountingSeat implements SeatController {
	readonly label: string;
	readonly modelId: string;
	turn = 0;
	constructor(
		readonly inner: SeatController,
		readonly turns: number,
		readonly stop: AbortController,
		readonly onCall: (row: Omit<CallRow, 'history' | 'model' | 'effort'>) => void,
		readonly onError: (message: string) => void
	) {
		this.label = inner.label;
		this.modelId = inner.modelId;
	}
	async decide(request: DecisionRequest, ctx: DecideContext): Promise<ControllerAnswer> {
		const answer = await this.inner.decide(request, ctx);
		for (const a of answer.attempts) {
			if (a.providerError) {
				this.onError(`${a.error ?? 'provider error'} (${a.latencyMs} ms)`);
				continue;
			}
			this.turn += 1;
			this.onCall({
				turn: this.turn,
				reasoningTokens: a.reasoningTokens ?? 0,
				completionTokens: a.completionTokens,
				promptTokens: a.promptTokens,
				cachedPromptTokens: a.cachedPromptTokens ?? 0,
				latencyMs: a.latencyMs,
				valid: a.parsedId !== null,
				kind: request.kind
			});
		}
		if (this.turn >= this.turns) this.stop.abort();
		return answer;
	}
}

async function main(): Promise<void> {
	const models = list(values.models).map((m) => (m.includes('/') ? m : `openai-codex/${m}`));
	models.forEach(assertGatewayModel);
	const efforts = list(values.efforts);
	const histories = list(values.history) as GatewayHistory[];
	for (const h of histories)
		if (!GATEWAY_HISTORIES.includes(h)) throw new Error(`unknown history mode "${h}"`);
	const turns = Number(values.turns);
	const reportTurns = [...new Set([...list(values['report-turns']).map(Number), turns])];
	const seed = Number(values.seed);
	const loaded = loadCatalogSpec(values.catalog ?? 'local');
	const rulesBrief = buildRulesBrief(loaded.catalog);
	const runId = values['run-id'] ?? `reasoning-check-${Date.now()}`;
	const outDir = resolve(values.out ?? 'output/agent-harness', runId);
	if (existsSync(outDir)) throw new Error(`${outDir} already exists`);
	mkdirSync(outDir, { recursive: true });
	const callsPath = join(outDir, 'calls.jsonl');
	const gate = new CallGate({ maxConcurrent: Number(values['max-concurrent-calls']) });
	const budget = new BudgetGuard({ maxSpendUsd: 1, maxTokens: Infinity, maxCalls: Infinity });
	const api = values['gw-api'] === 'chat' ? 'chat' : 'responses';
	const providers = new Map<string, GatewayProvider>();
	const provider = (history: GatewayHistory, effort: string) => {
		const key = `${history}@${effort}`;
		let p = providers.get(key);
		if (!p) {
			p = new GatewayProvider({
				baseUrls: values['gw-urls']?.split(','),
				tokenFile: values['gw-token-file'],
				api,
				history,
				effort,
				systemSuffix: values['system-suffix'],
				reasoningSummary: values['reasoning-summary'] as 'auto' | undefined
			});
			providers.set(key, p);
		}
		return p;
	};
	await provider(histories[0], efforts[0]).check();
	const rows: CallRow[] = [];
	let errors = 0;
	const combos = histories.flatMap((history) =>
		models.flatMap((model) => efforts.map((effort) => ({ history, model, effort })))
	);
	console.log(
		`${runId}: ${combos.length} combinations × ${turns} calls, seed ${seed}, api ${api}, catalog ${loaded.hash.slice(0, 12)}, call cap ${gate.maxConcurrent}`
	);
	const started = Date.now();
	await Promise.all(
		combos.map(async ({ history, model, effort }, i) => {
			const stop = new AbortController();
			const gw = new LlmSeatController({
				provider: provider(history, effort),
				model,
				budget,
				maxTokens: 400,
				gate,
				label: `gw:${model}@${effort}`
			});
			const seat = new CountingSeat(
				gw,
				turns,
				stop,
				(r) => {
					const row = { history, model, effort, ...r };
					rows.push(row);
					appendFileSync(callsPath, `${JSON.stringify(row)}\n`);
				},
				(message) => {
					errors += 1;
					appendFileSync(join(outDir, 'errors.log'), `${history} ${model} ${effort}: ${message}\n`);
				}
			);
			const mock = new LlmSeatController({
				provider: new MockProvider({ policy: 'greedy', seed: seed * 31 + 1 }),
				model: 'greedy',
				budget,
				maxTokens: 400,
				gate,
				label: 'mock:greedy'
			});
			try {
				await runAgentGame({
					catalog: loaded.catalog,
					catalogInfo: { source: loaded.source, path: loaded.path, hash: loaded.hash },
					seed,
					controllers: [seat, mock],
					rulesBrief,
					budget,
					runId,
					gameIndex: i,
					signal: stop.signal
				});
			} catch (err) {
				console.error(`${history} ${model} ${effort}: ${(err as Error).message}`);
			}
			console.log(
				`done ${history} ${model.slice(13)}@${effort}: ${seat.turn} calls (${((Date.now() - started) / 1000).toFixed(0)} s)`
			);
		})
	);

	const at = (h: string, m: string, e: string, t: number) =>
		rows.find((r) => r.history === h && r.model === m && r.effort === e && r.turn === t);
	const late = (h: string, m: string, e: string) =>
		rows.filter((r) => r.history === h && r.model === m && r.effort === e && r.turn >= 2);
	const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
	const lines = [
		`# Reasoning check ${runId}`,
		'',
		`${values['system-suffix'] ? `System suffix: "${values['system-suffix']}". ` : ''}Seed ${seed}, api ${api}, ${turns} calls per seat conversation (gw seat vs mock:greedy). Reasoning tokens at turns ${reportTurns.join(', ')}; "late" = mean of turns 2–${turns}; s = seconds per call; cached = share of input from cache at the last turn.`,
		'',
		`| history | model | effort | ${reportTurns.map((t) => `r@${t}`).join(' | ')} | late r mean | late calls with r>0 | s@1 | late s mean | input@${turns} | cached@${turns} | invalid |`,
		`|---|---|---|${reportTurns.map(() => '---:').join('|')}|---:|---:|---:|---:|---:|---:|---:|`
	];
	for (const { history, model, effort } of combos) {
		const lateRows = late(history, model, effort);
		const last = at(history, model, effort, turns);
		const all = rows.filter(
			(r) => r.history === history && r.model === model && r.effort === effort
		);
		lines.push(
			`| ${history} | ${model.slice(13)} | ${effort} | ${reportTurns.map((t) => at(history, model, effort, t)?.reasoningTokens ?? '-').join(' | ')} | ${mean(lateRows.map((r) => r.reasoningTokens)).toFixed(0)} | ${lateRows.filter((r) => r.reasoningTokens > 0).length}/${lateRows.length} | ${((at(history, model, effort, 1)?.latencyMs ?? NaN) / 1000).toFixed(1)} | ${(mean(lateRows.map((r) => r.latencyMs)) / 1000).toFixed(1)} | ${last?.promptTokens ?? '-'} | ${last ? `${Math.round((100 * last.cachedPromptTokens) / Math.max(1, last.promptTokens))}%` : '-'} | ${all.filter((r) => !r.valid).length} |`
		);
	}
	const report = lines.join('\n') + '\n';
	writeFileSync(join(outDir, 'report.md'), report);
	console.log(report);
	console.log(
		`calls → ${callsPath}; provider errors ${errors}; gate: ${JSON.stringify(gate.stats)}`
	);
}

main().catch((err) => {
	console.error(`error: ${(err as Error).message}`);
	process.exitCode = 1;
});
