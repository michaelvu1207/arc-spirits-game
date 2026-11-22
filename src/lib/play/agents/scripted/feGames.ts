/**
 * Offline games for the scripted Fighter + Elementalist player: one table, one seed, no model
 * calls. Used by scripts/agent-harness/scripted/run-fe.ts and the tests.
 */

import { awakenedClassCounts } from '../../effects/apply';
import { diceTierFaces } from '../../combat';
import type { DiceTier, PlayCatalog, PrivatePlayerState, SeatColor } from '../../types';
import { BudgetGuard } from '../budget';
import type { ControllerAnswer, DecideContext, DecisionRequest, SeatController } from '../contract';
import { LlmSeatController } from '../llmSeat';
import { MockProvider, type MockPolicy } from '../providers/mock';
import { buildRulesBrief } from '../rulesBrief';
import { runAgentGame, type GameSummary } from '../runner';
import { seatsFor } from '../setup';
import type { FeParams } from './fePolicy';
import { ScriptedSeatController } from './scriptedSeat';

export interface RoundSnapshot {
	round: number;
	vp: number;
	dice: Record<DiceTier, number>;
	/** Expected damage of one roll of all dice. */
	attack: number;
	fighter: number;
	elementalist: number;
	maxBarrier: number;
}

export interface ScriptedSeatStats {
	/** Last snapshot the seat saw in each round (its end-of-round state). */
	byRound: RoundSnapshot[];
	kills: { lurker: number; d1: number; d2: number; d3: number };
	/** Kills whose rewards were exchanged for Arcane Blood. */
	bloodTaken: number;
	fightsStarted: number;
	roundFighter5: number | null;
	roundElementalist5: number | null;
	round10Exalted: number | null;
}

export interface SeatResult {
	seat: SeatColor;
	spec: string;
	finalVp: number;
	vpByRound: number[];
	corruptions: number;
	monsterKills: number;
	monsterFights: number;
	finalStatus: string;
	scripted?: ScriptedSeatStats;
}

export interface TableGameResult {
	seed: number;
	finished: boolean;
	stopReason: string;
	endRound: number;
	winner: SeatColor | null;
	seats: SeatResult[];
	fallbacks: number;
	durationMs: number;
}

const TIERS: DiceTier[] = ['basic', 'enchanted', 'exalted', 'arcane'];

/** Wraps the scripted seat to record what it had at the end of every round. */
class RecordingSeat implements SeatController {
	readonly label: string;
	readonly modelId: string;
	readonly strategy = null;
	readonly stats: ScriptedSeatStats = {
		byRound: [],
		kills: { lurker: 0, d1: 0, d2: 0, d3: 0 },
		bloodTaken: 0,
		fightsStarted: 0,
		roundFighter5: null,
		roundElementalist5: null,
		round10Exalted: null
	};
	readonly #inner: SeatController;
	readonly #catalog: PlayCatalog;
	readonly #means: Record<DiceTier, number>;

	constructor(inner: SeatController, catalog: PlayCatalog) {
		this.#inner = inner;
		this.label = inner.label;
		this.modelId = inner.modelId;
		this.#catalog = catalog;
		const faces = diceTierFaces(catalog);
		this.#means = Object.fromEntries(
			TIERS.map((t) => [t, (faces[t] ?? [0]).reduce((a, b) => a + b, 0) / (faces[t]?.length || 1)])
		) as Record<DiceTier, number>;
	}

	async decide(request: DecisionRequest, ctx: DecideContext): Promise<ControllerAnswer> {
		const answer = await this.#inner.decide(request, ctx);
		const view = ctx.view;
		const me = view?.players[request.seat] as PrivatePlayerState | undefined;
		if (view && me) {
			this.#snapshot(view.round, me);
			const chosen = request.actions.find((a) => a.id === answer.response.actionId)?.command;
			if (chosen?.type === 'startCombat') this.stats.fightsStarted += 1;
			if (chosen?.type === 'resolveMonsterReward' && me.pendingReward) {
				const card = this.#catalog.monsters?.find((m) => m.id === me.pendingReward!.monsterId);
				const key = card?.permanent ? 'lurker' : (`d${card?.stage ?? 1}` as 'd1' | 'd2' | 'd3');
				if (key in this.stats.kills) this.stats.kills[key] += 1;
				if (chosen.arcaneBlood) this.stats.bloodTaken += 1;
			}
		}
		return answer;
	}

	#snapshot(round: number, me: PrivatePlayerState) {
		const dice = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<DiceTier, number>;
		for (const d of me.attackDice ?? []) dice[d.tier] += 1;
		const counts = awakenedClassCounts(me);
		const snap: RoundSnapshot = {
			round,
			vp: me.victoryPoints,
			dice,
			attack: TIERS.reduce((n, t) => n + dice[t] * this.#means[t], 0),
			fighter: counts.Fighter ?? 0,
			elementalist: counts.Elementalist ?? 0,
			maxBarrier: me.maxBarrier
		};
		const last = this.stats.byRound[this.stats.byRound.length - 1];
		if (last?.round === round) this.stats.byRound[this.stats.byRound.length - 1] = snap;
		else this.stats.byRound.push(snap);
		if (snap.fighter >= 5) this.stats.roundFighter5 ??= round;
		if (snap.elementalist >= 5) this.stats.roundElementalist5 ??= round;
		if (dice.exalted >= 10) this.stats.round10Exalted ??= round;
	}
}

export interface TableOptions {
	catalog: PlayCatalog;
	catalogInfo: { source: string; path: string; hash: string };
	seed: number;
	/** Seat specs in seat order: `script:fe`, `mock:greedy`, `mock:random`, `mock:first`;
	 *  `script:fe#<name>` plays with the parameter overrides `variants[name]` (A/B tests). */
	seats: string[];
	params?: Partial<FeParams>;
	variants?: Record<string, Partial<FeParams>>;
	maxDecisions?: number;
	rulesBrief?: string;
}

export function controllerForSpec(
	spec: string,
	index: number,
	seed: number,
	catalog: PlayCatalog,
	budget: BudgetGuard,
	params?: Partial<FeParams>,
	variants: Record<string, Partial<FeParams>> = {}
): SeatController {
	const [kind, arg = ''] = spec.split(':');
	if (kind === 'script') {
		const [policy, variant] = arg.split('#');
		if (policy !== 'fe') throw new Error(`unknown scripted policy "${policy}" (fe)`);
		if (variant !== undefined && !variants[variant])
			throw new Error(`no parameters for variant "${variant}"`);
		return new ScriptedSeatController({
			catalog,
			policy: 'fe',
			params: { ...(params ?? {}), ...(variant !== undefined ? variants[variant] : {}) },
			label: spec
		});
	}
	if (kind === 'mock') {
		const policy = (arg || 'random') as MockPolicy;
		if (!['random', 'greedy', 'first'].includes(policy))
			throw new Error(`unknown mock policy "${policy}" (random | greedy | first)`);
		// Same seeding as run.ts.
		return new LlmSeatController({
			provider: new MockProvider({ policy, seed: seed * 31 + index }),
			model: policy,
			budget,
			label: `mock:${policy}`
		});
	}
	throw new Error(
		`unknown seat spec "${spec}" (script:fe | mock:greedy | mock:random | mock:first)`
	);
}

/** Play one game at one table. Deterministic for a given seed, seats and params. */
export async function playTable(opts: TableOptions): Promise<TableGameResult> {
	const budget = new BudgetGuard({ maxSpendUsd: 0, maxTokens: Infinity, maxCalls: Infinity });
	const controllers = opts.seats.map((spec, i) => {
		const c = controllerForSpec(
			spec,
			i,
			opts.seed,
			opts.catalog,
			budget,
			opts.params,
			opts.variants
		);
		return spec.startsWith('script:') ? new RecordingSeat(c, opts.catalog) : c;
	});
	const summary: GameSummary = await runAgentGame({
		catalog: opts.catalog,
		catalogInfo: opts.catalogInfo,
		seed: opts.seed,
		controllers,
		rulesBrief: opts.rulesBrief ?? buildRulesBrief(opts.catalog),
		budget,
		runId: `fe-${opts.seed}`,
		maxDecisions: opts.maxDecisions ?? 6000,
		parallel: false,
		skipFacts: true
	});
	const colors = seatsFor(opts.seats.length);
	return {
		seed: opts.seed,
		finished: summary.finished,
		stopReason: summary.stopReason,
		endRound: summary.rounds,
		winner: summary.winner,
		fallbacks: summary.seats.reduce((n, s) => n + s.fallbacks, 0),
		durationMs: summary.durationMs,
		seats: summary.seats.map((s, i) => {
			const c = controllers[i];
			return {
				seat: colors[i],
				spec: opts.seats[i],
				finalVp: s.finalVp,
				vpByRound: s.vpByRound,
				corruptions: s.corruptions,
				monsterKills: s.monsterKills,
				monsterFights: s.monsterFights,
				finalStatus: s.finalStatus,
				...(c instanceof RecordingSeat ? { scripted: c.stats } : {})
			};
		})
	};
}
