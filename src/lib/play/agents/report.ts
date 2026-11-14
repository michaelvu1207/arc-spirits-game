/** Run-level aggregation (the seed of the benchmark table). */

import type { BudgetGuard } from './budget';
import type { GameSummary } from './runner';

export interface ModelAggregate {
	model: string;
	seatsPlayed: number;
	wins: number;
	winRate: number;
	avgFinalVp: number;
	avgFallenRound: number | null;
	monsterKills: number;
	pvpAttacks: number;
	agentDecisions: number;
	invalidAnswers: number;
	fallbacks: number;
	fallbackRate: number;
	costUsd: number;
	tokens: number;
	avgLatencyMs: number;
}

export function aggregateByModel(games: GameSummary[]): ModelAggregate[] {
	const byModel = new Map<string, ModelAggregate & { fallen: number[]; latency: number }>();
	for (const game of games) {
		for (const seat of game.seats) {
			const row =
				byModel.get(seat.model) ??
				({
					model: seat.model,
					seatsPlayed: 0,
					wins: 0,
					winRate: 0,
					avgFinalVp: 0,
					avgFallenRound: null,
					monsterKills: 0,
					pvpAttacks: 0,
					agentDecisions: 0,
					invalidAnswers: 0,
					fallbacks: 0,
					fallbackRate: 0,
					costUsd: 0,
					tokens: 0,
					avgLatencyMs: 0,
					fallen: [],
					latency: 0
				} as ModelAggregate & { fallen: number[]; latency: number });
			row.seatsPlayed += 1;
			if (game.finished && game.winner === seat.seat) row.wins += 1;
			row.avgFinalVp += seat.finalVp;
			if (seat.statusRounds.Fallen !== undefined) row.fallen.push(seat.statusRounds.Fallen);
			row.monsterKills += seat.monsterKills;
			row.pvpAttacks += seat.pvpAttacks;
			row.agentDecisions += seat.agentDecisions;
			row.invalidAnswers += seat.invalidAnswers;
			row.fallbacks += seat.fallbacks;
			row.costUsd += seat.costUsd;
			row.tokens += seat.promptTokens + seat.completionTokens;
			row.latency += seat.latencyMsTotal;
			byModel.set(seat.model, row);
		}
	}
	return [...byModel.values()].map(({ fallen, latency, ...row }) => ({
		...row,
		winRate: row.seatsPlayed ? row.wins / row.seatsPlayed : 0,
		avgFinalVp: row.seatsPlayed ? row.avgFinalVp / row.seatsPlayed : 0,
		avgFallenRound: fallen.length ? fallen.reduce((a, b) => a + b, 0) / fallen.length : null,
		fallbackRate: row.agentDecisions ? row.fallbacks / row.agentDecisions : 0,
		avgLatencyMs: row.agentDecisions ? latency / row.agentDecisions : 0
	}));
}

export function renderSummaryMarkdown(
	runId: string,
	games: GameSummary[],
	byModel: ModelAggregate[],
	budget: ReturnType<BudgetGuard['snapshot']>
): string {
	const lines = [
		`# Agent run ${runId}`,
		'',
		`Spend $${budget.spentUsd.toFixed(4)} of $${budget.limits.maxSpendUsd}; ${budget.tokens} tokens; ${budget.calls} provider calls.`,
		'',
		'## Games',
		'',
		'| game | seed | stop | winner | rounds | decisions | VP (seat=model) | invalid % |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const g of games) {
		const vp = g.seats.map((s) => `${s.seat} ${s.finalVp} (${s.model})`).join('; ');
		lines.push(
			`| ${g.gameId} | ${g.seed} | ${g.stopReason} | ${g.winner ?? '-'} | ${g.rounds} | ${g.decisions} | ${vp} | ${(g.invalidAnswerRate * 100).toFixed(1)} |`
		);
	}
	lines.push(
		'',
		'## By model',
		'',
		'| model | seats | wins | avg VP | avg Fallen round | kills | PvP | invalid | fallbacks | cost $ | avg latency ms |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	);
	for (const m of byModel) {
		lines.push(
			`| ${m.model} | ${m.seatsPlayed} | ${m.wins} | ${m.avgFinalVp.toFixed(1)} | ${m.avgFallenRound?.toFixed(1) ?? '-'} | ${m.monsterKills} | ${m.pvpAttacks} | ${m.invalidAnswers} | ${m.fallbacks} | ${m.costUsd.toFixed(4)} | ${m.avgLatencyMs.toFixed(0)} |`
		);
	}
	return `${lines.join('\n')}\n`;
}

// ── Tournament ──────────────────────────────────────────────────────────────

export interface TournamentRow {
	model: string;
	games: number;
	wins: number;
	winRate: number;
	avgVp: number;
	/** Average round of the games this model won (null: no win). */
	avgWinRound: number | null;
	kills: number;
	corruptions: number;
	pvp: number;
	illegalAnswerRate: number;
	secondsPerCall: number;
	perGame: { input: number; cached: number; output: number; reasoning: number };
}

export interface Tournament {
	rows: TournamentRow[];
	/** matrix[a][b] = games model a won against model b. */
	matrix: Record<string, Record<string, number>>;
	games: number;
}

export function tournamentTable(games: GameSummary[]): Tournament {
	const rows = new Map<
		string,
		TournamentRow & {
			winRounds: number[];
			vp: number;
			calls: number;
			latency: number;
			illegal: number;
			decisions: number;
		}
	>();
	const matrix: Record<string, Record<string, number>> = {};
	for (const game of games) {
		for (const seat of game.seats) {
			const r =
				rows.get(seat.model) ??
				({
					model: seat.model,
					games: 0,
					wins: 0,
					winRate: 0,
					avgVp: 0,
					avgWinRound: null,
					kills: 0,
					corruptions: 0,
					pvp: 0,
					illegalAnswerRate: 0,
					secondsPerCall: 0,
					perGame: { input: 0, cached: 0, output: 0, reasoning: 0 },
					winRounds: [],
					vp: 0,
					calls: 0,
					latency: 0,
					illegal: 0,
					decisions: 0
				} as TournamentRow & {
					winRounds: number[];
					vp: number;
					calls: number;
					latency: number;
					illegal: number;
					decisions: number;
				});
			r.games += 1;
			r.vp += seat.finalVp;
			r.kills += seat.monsterKills;
			r.corruptions += seat.corruptions;
			r.pvp += seat.pvpAttacks;
			r.calls += seat.providerCalls;
			r.latency += seat.latencyMsTotal;
			r.illegal += seat.invalidAnswers;
			r.decisions += seat.agentDecisions;
			r.perGame.input += seat.promptTokens;
			r.perGame.cached += seat.cachedPromptTokens ?? 0;
			r.perGame.output += seat.completionTokens;
			r.perGame.reasoning += seat.reasoningTokens ?? 0;
			if (game.winner === seat.seat) {
				r.wins += 1;
				r.winRounds.push(game.rounds);
			}
			rows.set(seat.model, r);
		}
		const winner = game.seats.find((s) => s.seat === game.winner);
		if (winner)
			for (const loser of game.seats)
				if (loser !== winner) {
					matrix[winner.model] ??= {};
					matrix[winner.model][loser.model] = (matrix[winner.model][loser.model] ?? 0) + 1;
				}
	}
	const out: TournamentRow[] = [...rows.values()].map((r) => ({
		model: r.model,
		games: r.games,
		wins: r.wins,
		winRate: r.games ? r.wins / r.games : 0,
		avgVp: r.games ? r.vp / r.games : 0,
		avgWinRound: r.winRounds.length
			? r.winRounds.reduce((a, b) => a + b, 0) / r.winRounds.length
			: null,
		kills: r.kills,
		corruptions: r.corruptions,
		pvp: r.pvp,
		illegalAnswerRate: r.decisions ? r.illegal / r.decisions : 0,
		secondsPerCall: r.calls ? r.latency / r.calls / 1000 : 0,
		perGame: {
			input: Math.round(r.perGame.input / r.games),
			cached: Math.round(r.perGame.cached / r.games),
			output: Math.round(r.perGame.output / r.games),
			reasoning: Math.round(r.perGame.reasoning / r.games)
		}
	}));
	out.sort((a, b) => b.wins - a.wins || b.avgVp - a.avgVp);
	return { rows: out, matrix, games: games.length };
}

export function renderTournamentMarkdown(t: Tournament): string {
	const short = (m: string) => m.replace(/^gw:openai-codex\//, '').replace(/^codex:/, '');
	const lines = [
		`# Tournament (${t.games} games)`,
		'',
		'| model | games | wins | win rate | avg VP | avg win round | kills | corruptions | PvP | illegal answers | s/call | input/game | cached/game | output/game | reasoning/game |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const r of t.rows)
		lines.push(
			`| ${short(r.model)} | ${r.games} | ${r.wins} | ${(r.winRate * 100).toFixed(0)}% | ${r.avgVp.toFixed(1)} | ${r.avgWinRound?.toFixed(1) ?? '-'} | ${r.kills} | ${r.corruptions} | ${r.pvp} | ${(r.illegalAnswerRate * 100).toFixed(1)}% | ${r.secondsPerCall.toFixed(1)} | ${r.perGame.input} | ${r.perGame.cached} | ${r.perGame.output} | ${r.perGame.reasoning} |`
		);
	const models = t.rows.map((r) => r.model);
	lines.push('', '## Pair matrix (row model wins against column model)', '');
	lines.push(
		`| | ${models.map(short).join(' | ')} |`,
		`| --- |${models.map(() => ' --- |').join('')}`
	);
	for (const a of models)
		lines.push(
			`| ${short(a)} | ${models.map((b) => (a === b ? '-' : String(t.matrix[a]?.[b] ?? 0))).join(' | ')} |`
		);
	return `${lines.join('\n')}\n`;
}
