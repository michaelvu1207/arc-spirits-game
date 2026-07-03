/**
 * Clean-farm counterfactual diagnostic.
 *
 * This is the route-proof data layer recommended before more pure/economy
 * fine-tuning. It starts from legal normal games, finds clean-farmable
 * navigation windows, then branches the reducer state:
 *
 *   A. lockNavigation: Arcane Abyss
 *   B. heuristic non-Abyss navigation
 *   C. rollout-best non-Abyss navigation
 *
 * Each branch is rolled forward with the same deterministic profile field and
 * compared at 3/6/10/15-round horizons. The label is counterfactual: farm now
 * only wins if the Abyss branch beats the best non-Abyss branch after rollout.
 *
 * Opt in:
 *
 *   FARMQ=1 FARMQ_GAMES=2 \
 *     npx vitest run src/lib/play/ml/_farmcounterfactual.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	computeKillProbability,
	firepowerKillProbability,
	planBotPhaseActions,
	profileFor,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import {
	SEAT_COLORS,
	VP_TO_WIN,
	type GameActor,
	type GameCommand,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { sampleAuxTargets } from './auxTargets';
import { legalActionsWithNext, commandMatches, type LegalAction } from './actions';
import type { Sample } from './driver';
import { ACT_DIM, encodeAction, encodeObs, OBS_DIM } from './encode';
import { evaluateFarmValue, type FarmValueSignal } from './farmValue';
import { appendSamples, loadOrSnapshotCatalog, mlPath } from './nodeIo';
import { BALANCED_SHAPING, buildPotential, vpOf } from './shaping';

const RUN = process.env.FARMQ === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;

interface Config {
	games: number;
	seatsN: number;
	maxRounds: number;
	maxWindows: number;
	minRound: number;
	maxRound?: number;
	killThreshold: number;
	qualifyMaxStatusLevel: number;
	allowFirepowerFarm: boolean;
	allowCorruptFarm: boolean;
	minMonsterHp: number;
	maxMonsterHp?: number;
	minOpportunityVp: number;
	selectHorizon: number;
	horizons: number[];
	labelHorizon: number;
	labelVpThreshold: number;
	labelStatusTolerance: number;
	valueScaleVp: number;
	samplePolicyWeight?: number;
	dataOut?: string;
	profiles: string[];
	out: string;
	summaryOut: string;
	forbidTypes?: Set<GameCommand['type']>;
	maxStatusLevel?: number;
}

interface BranchMetrics {
	action: string;
	destination: string;
	finalVp: number;
	finalBestOpponentVp: number;
	finalStatus: number;
	rewardVp: number;
	pvpVp: number;
	pvpEvents: number;
	pvpEventsAgainstTarget: number;
	kills: number;
	combats: number;
	reach30: boolean;
	rounds: number;
	requestedHorizon: number;
	rolloutEndRound: number;
	cappedByMaxRounds: boolean;
	snapshots: Record<string, {
		vp: number;
		bestOpponentVp: number;
		status: number;
		rewardVp: number;
		pvpVp: number;
		pvpEvents: number;
		pvpEventsAgainstTarget: number;
		kills: number;
		combats: number;
		reach30: boolean;
		round: number;
	}>;
}

interface WindowRow {
	id: string;
	game: number;
	seat: SeatColor;
	round: number;
	playerVp: number;
	bestOpponentVp: number;
	monsterHp: number;
	monsterLives: number;
	farm: FarmValueSignal;
	cleanKillProb: number;
	firepowerKillProb: number;
	corruptKillProb: number;
	effectiveKillProb: number;
	effectiveOpportunityVp: number;
	abyss: BranchMetrics;
	heuristicNonAbyss: BranchMetrics;
	bestNonAbyss: BranchMetrics;
	farmQDeltaVp: number;
	farmQDeltaStatus: number;
	farmQDeltaRewardVp: number;
	farmQDeltaPvpVp: number;
	farmQDeltaKills: number;
	farmQDeltaMonsterLivesConsumed: number;
	farmQDeltaRaceMargin: number;
	farmQDeltaReach30: number;
	farmQDeltaPvpExposure: number;
	farmNowCorrect: boolean;
	bestNonAbyssDestination: string;
	heuristicNonAbyssDestination: string;
}

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed);
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

function parseForbidTypes(raw: string | undefined): Set<GameCommand['type']> | undefined {
	if (!raw?.trim()) return undefined;
	const types = raw.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][];
	return types.length ? new Set(types) : undefined;
}

function parseHorizons(raw: string | undefined): number[] {
	const values = (raw ?? '3,6,10,15')
		.split(',')
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n) && n > 0);
	return [...new Set(values)].sort((a, b) => a - b);
}

function commandLabel(cmd: GameCommand): string {
	if (cmd.type === 'lockNavigation') return `lockNavigation:${cmd.destination}`;
	return cmd.type;
}

function destinationOf(cmd: GameCommand): string {
	return cmd.type === 'lockNavigation' ? cmd.destination : '<none>';
}

function rewardVpForCommand(before: PublicGameState, after: PublicGameState, seat: SeatColor, cmd: GameCommand): number {
	if (cmd.type !== 'resolveMonsterReward') return 0;
	return Math.max(0, (after.players[seat]?.victoryPoints ?? 0) - (before.players[seat]?.victoryPoints ?? 0));
}

function pvpEventsAgainstTarget(before: PublicGameState, after: PublicGameState, seat: SeatColor): number {
	const beforeIds = new Set(before.combats.filter((c) => c.kind === 'pvp').map((c) => c.id));
	let events = 0;
	for (const combat of after.combats) {
		if (combat.kind !== 'pvp' || beforeIds.has(combat.id)) continue;
		if (combat.sides.some((side) => side.seat === seat)) events++;
	}
	return events;
}

function setupGame(catalog: PlayCatalog, seed: number, seatsN: number): { state: PublicGameState; seats: SeatColor[] } {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'FARMQ', guardianNames });
	const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		const memberId = `bot-${seat}`;
		expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: null },
				{ type: 'claimSeat', seatColor: seat },
				catalog
			),
			`claimSeat ${seat}`
		);
		expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: seat },
				{ type: 'selectGuardian', guardianName: guardianNames[i] },
				catalog
			),
			`selectGuardian ${seat}`
		);
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed }, catalog), 'startGame');
	return { state, seats };
}

function filterTargetPlan(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	plan: GameCommand[],
	cfg: Config
): GameCommand[] {
	const out: GameCommand[] = [];
	for (const cmd of plan) {
		if (cfg.forbidTypes?.has(cmd.type)) continue;
		if (cfg.maxStatusLevel !== undefined) {
			const probe = applyGameCommand(state, botActorFor(state, seat), cmd, catalog);
			if (probe.ok && (probe.state.players[seat]?.statusLevel ?? 0) > cfg.maxStatusLevel) continue;
		}
		out.push(cmd);
	}
	return out.length ? out : plan;
}

function snapshot(metrics: BranchMetrics, state: PublicGameState, seat: SeatColor, key: number): void {
	const vp = state.players[seat]?.victoryPoints ?? 0;
	metrics.snapshots[String(key)] = {
		vp,
		bestOpponentVp: bestOpponentVp(state, seat),
		status: state.players[seat]?.statusLevel ?? 0,
		rewardVp: metrics.rewardVp,
		pvpVp: metrics.pvpVp,
		pvpEvents: metrics.pvpEvents,
		pvpEventsAgainstTarget: metrics.pvpEventsAgainstTarget,
		kills: metrics.kills,
		combats: metrics.combats,
		reach30: vp >= VP_TO_WIN,
		round: state.round
	};
}

function rolloutBranch(
	initial: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profileBySeat: Record<string, BotProfile>,
	cfg: Config,
	seed: number,
	action: GameCommand,
	startRound: number,
	horizons: number[]
): BranchMetrics {
	let state = initial;
	const maxHorizon = Math.max(...horizons);
	const rolloutEndRound = Math.min(cfg.maxRounds, startRound + maxHorizon);
	const rng = seededBotRandom(seed);
	const metrics: BranchMetrics = {
		action: commandLabel(action),
		destination: destinationOf(action),
		finalVp: state.players[seat]?.victoryPoints ?? 0,
		finalBestOpponentVp: bestOpponentVp(state, seat),
		finalStatus: state.players[seat]?.statusLevel ?? 0,
		rewardVp: 0,
		pvpVp: 0,
		pvpEvents: 0,
		pvpEventsAgainstTarget: 0,
		kills: 0,
		combats: 0,
		reach30: (state.players[seat]?.victoryPoints ?? 0) >= VP_TO_WIN,
		rounds: state.round - startRound,
		requestedHorizon: maxHorizon,
		rolloutEndRound,
		cappedByMaxRounds: rolloutEndRound < startRound + maxHorizon,
		snapshots: {}
	};
	for (const h of horizons) {
		if (h <= 0) snapshot(metrics, state, seat, h);
	}
	const actionCounter = new Map<string, number>();
	let ticks = 0;
	while (state.status === 'active' && state.round < rolloutEndRound && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const activeSeat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, activeSeat)) continue;
			const key = `${activeSeat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			let plan = planBotPhaseActions(state, activeSeat, catalog, rng, profileBySeat[activeSeat]);
			if (activeSeat === seat) plan = filterTargetPlan(state, activeSeat, catalog, plan, cfg);
			for (const cmd of plan) {
				const before = state;
				const beforeVp = before.players[seat]?.victoryPoints ?? 0;
				const r = applyGameCommand(state, botActorFor(state, activeSeat), cmd, catalog, { mutate: true });
				if (!r.ok) break;
				state = r.state;
				progressed = true;
				actionCounter.set(key, used + 1);
				const pvpAgainstTarget = pvpEventsAgainstTarget(before, state, seat);
				if (pvpAgainstTarget > 0) {
					metrics.pvpEvents += pvpAgainstTarget;
					metrics.pvpEventsAgainstTarget += pvpAgainstTarget;
				}
				if (activeSeat === seat) {
					if (cmd.type === 'startCombat') {
						metrics.combats++;
						const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
						if (combat?.killed) metrics.kills++;
					}
					if (cmd.type === 'resolveMonsterReward') {
						metrics.rewardVp += rewardVpForCommand(before, state, seat, cmd);
					}
					if (cmd.type === 'initiatePvp') {
						metrics.pvpVp += Math.max(0, (state.players[seat]?.victoryPoints ?? 0) - beforeVp);
					}
				}
				for (const h of horizons) {
					if (state.round >= startRound + h && metrics.snapshots[String(h)] === undefined) {
						snapshot(metrics, state, seat, h);
					}
				}
				if (state.status !== 'active' || state.round >= rolloutEndRound) break;
			}
			if (state.status !== 'active' || state.round >= rolloutEndRound) break;
		}
		if (state.status !== 'active' || state.round >= rolloutEndRound) break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === sig) break;
		}
	}
	for (const h of horizons) {
		if (metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
	}
	metrics.finalVp = state.players[seat]?.victoryPoints ?? 0;
	metrics.finalBestOpponentVp = bestOpponentVp(state, seat);
	metrics.finalStatus = state.players[seat]?.statusLevel ?? 0;
	metrics.reach30 = metrics.finalVp >= VP_TO_WIN;
	metrics.rounds = state.round - startRound;
	return metrics;
}

function branchFromAction(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, action: LegalAction): PublicGameState | null {
	const result = applyGameCommand(state, botActorFor(state, seat), action.cmd, catalog);
	return result.ok ? result.state : null;
}

function legalNavBranches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): LegalAction[] {
	return legalActionsWithNext(state, seat, catalog).filter((x) => x.cmd.type === 'lockNavigation');
}

function bestNonAbyssByRollout(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profileBySeat: Record<string, BotProfile>,
	cfg: Config,
	gameIndex: number,
	windowIndex: number,
	branches: LegalAction[]
): LegalAction {
	let best = branches[0];
	let bestScore = -Infinity;
	for (let i = 0; i < branches.length; i++) {
		const branchState = branchFromAction(state, seat, catalog, branches[i]);
		if (!branchState) continue;
		const metrics = rolloutBranch(
			branchState,
			seat,
			catalog,
			profileBySeat,
			cfg,
			8_800_000 + gameIndex * 10_000 + windowIndex * 100 + i,
			branches[i].cmd,
			state.round,
			[cfg.selectHorizon]
		);
		const snap = metrics.snapshots[String(cfg.selectHorizon)];
		const score = (snap?.vp ?? metrics.finalVp) - 0.5 * (snap?.status ?? metrics.finalStatus);
		if (score > bestScore) {
			best = branches[i];
			bestScore = score;
		}
	}
	return best;
}

function heuristicNonAbyssBranch(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	rng: BotRandom,
	profile: BotProfile,
	branches: LegalAction[]
): LegalAction {
	const plan = planBotPhaseActions(state, seat, catalog, rng, profile);
	const nav = plan.find((cmd) => cmd.type === 'lockNavigation' && cmd.destination !== 'Arcane Abyss');
	if (nav) {
		const match = branches.find((x) => commandMatches(x.cmd, nav));
		if (match) return match;
	}
	return branches[0];
}

function monsterHp(state: PublicGameState): number {
	const monster = state.monster;
	return monster ? (monster.maxHp ?? monster.hp ?? 0) : 0;
}

function effectiveFarmSignal(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	signal: FarmValueSignal,
	cfg: Config
): {
	qualified: boolean;
	cleanKillProb: number;
	firepowerKillProb: number;
	corruptKillProb: number;
	effectiveKillProb: number;
	effectiveOpportunityVp: number;
	monsterHp: number;
} {
	const hp = monsterHp(state);
	const cleanKillProb = signal.cleanKillProb;
	const firepowerKillProb = cfg.allowFirepowerFarm ? firepowerKillProbability(state, seat, catalog) : 0;
	const corruptKillProb = cfg.allowCorruptFarm ? computeKillProbability(state, seat, catalog, { allowCorruptKill: true }) : 0;
	const effectiveKillProb = Math.max(cleanKillProb, firepowerKillProb, corruptKillProb);
	const effectiveOpportunityVp = effectiveKillProb * signal.rewardVp;
	return {
		qualified:
			signal.valid &&
			signal.statusLevel <= cfg.qualifyMaxStatusLevel &&
			state.round >= cfg.minRound &&
			(cfg.maxRound === undefined || state.round <= cfg.maxRound) &&
			hp >= cfg.minMonsterHp &&
			(cfg.maxMonsterHp === undefined || hp <= cfg.maxMonsterHp) &&
			effectiveKillProb >= cfg.killThreshold &&
			effectiveOpportunityVp >= cfg.minOpportunityVp,
		cleanKillProb,
		firepowerKillProb,
		corruptKillProb,
		effectiveKillProb,
		effectiveOpportunityVp,
		monsterHp: hp
	};
}

function isQualified(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, signal: FarmValueSignal, cfg: Config): boolean {
	return effectiveFarmSignal(state, seat, catalog, signal, cfg).qualified;
}

function bestOpponentVp(state: PublicGameState, seat: SeatColor): number {
	let best = 0;
	for (const [otherSeat, player] of Object.entries(state.players)) {
		if (otherSeat === seat) continue;
		best = Math.max(best, player?.victoryPoints ?? 0);
	}
	return best;
}

function compareAt(
	a: BranchMetrics,
	b: BranchMetrics,
	horizon: number
): {
	vpDelta: number;
	statusDelta: number;
	rewardVpDelta: number;
	pvpVpDelta: number;
	killsDelta: number;
	monsterLivesConsumedDelta: number;
	raceMarginDelta: number;
	reach30Delta: number;
	pvpExposureDelta: number;
} {
	const as = a.snapshots[String(horizon)] ?? {
		vp: a.finalVp,
		bestOpponentVp: a.finalBestOpponentVp,
		status: a.finalStatus,
		rewardVp: a.rewardVp,
		pvpVp: a.pvpVp,
		kills: a.kills,
		reach30: a.reach30,
		pvpEventsAgainstTarget: a.pvpEventsAgainstTarget
	};
	const bs = b.snapshots[String(horizon)] ?? {
		vp: b.finalVp,
		bestOpponentVp: b.finalBestOpponentVp,
		status: b.finalStatus,
		rewardVp: b.rewardVp,
		pvpVp: b.pvpVp,
		kills: b.kills,
		reach30: b.reach30,
		pvpEventsAgainstTarget: b.pvpEventsAgainstTarget
	};
	return {
		vpDelta: as.vp - bs.vp,
		statusDelta: as.status - bs.status,
		rewardVpDelta: (as.rewardVp ?? 0) - (bs.rewardVp ?? 0),
		pvpVpDelta: (as.pvpVp ?? 0) - (bs.pvpVp ?? 0),
		killsDelta: (as.kills ?? 0) - (bs.kills ?? 0),
		monsterLivesConsumedDelta: (as.kills ?? 0) - (bs.kills ?? 0),
		raceMarginDelta: (as.vp - (as.bestOpponentVp ?? 0)) - (bs.vp - (bs.bestOpponentVp ?? 0)),
		reach30Delta: (as.reach30 ? 1 : 0) - (bs.reach30 ? 1 : 0),
		pvpExposureDelta: (as.pvpEventsAgainstTarget ?? 0) - (bs.pvpEventsAgainstTarget ?? 0)
	};
}

function recordNavigationSample(
	samples: Sample[],
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	chosenIdx: number,
	chosenMetrics: BranchMetrics,
	labelHorizon: number,
	farmValueTarget?: number,
	policyWeight?: number
): void {
	if (withNext.length <= 1 || chosenIdx < 0) return;
	const chosenSnap = chosenMetrics.snapshots[String(labelHorizon)] ?? {
		vp: chosenMetrics.finalVp
	};
	const aux = sampleAuxTargets(state, seat, catalog, withNext);
	samples.push({
		obs: encodeObs(state, seat, catalog),
		cands: withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
		chosen: chosenIdx,
		pi: withNext.map((_, i) => (i === chosenIdx ? 1 : 0)),
		ret: Math.max(0, Math.min(1, Math.max(vpOf(state.players[seat]), chosenSnap.vp) / VP_TO_WIN)),
		seat,
		vp: vpOf(state.players[seat]),
		phi: buildPotential(state.players[seat], BALANCED_SHAPING),
		kill: 0,
		...aux,
		...(typeof farmValueTarget === 'number' ? { farmValue: Math.max(0, Math.min(1, farmValueTarget)) } : {}),
		...(typeof policyWeight === 'number' ? { policyWeight } : {})
	});
}

describe('farm counterfactual diagnostics', () => {
	(RUN ? it : it.skip)(
		'branches clean-farmable navigation windows into Abyss vs non-Abyss rollouts',
		async () => {
			const horizons = parseHorizons(process.env.FARMQ_HORIZONS);
			const cfg: Config = {
				games: parseInt(process.env.FARMQ_GAMES ?? '4', 10),
				seatsN: parseInt(process.env.FARMQ_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.FARMQ_MAXROUNDS ?? '30', 10),
				maxWindows: parseInt(process.env.FARMQ_MAX_WINDOWS ?? '80', 10),
				minRound: parseInt(process.env.FARMQ_MIN_ROUND ?? '0', 10),
				maxRound: process.env.FARMQ_MAX_ROUND ? parseInt(process.env.FARMQ_MAX_ROUND, 10) : undefined,
				killThreshold: parseFloat(process.env.FARMQ_KILL_THRESHOLD ?? '0.5'),
				qualifyMaxStatusLevel: parseInt(process.env.FARMQ_QUALIFY_MAX_STATUS_LEVEL ?? '0', 10),
				allowFirepowerFarm: process.env.FARMQ_ALLOW_FIREPOWER_FARM === '1',
				allowCorruptFarm: process.env.FARMQ_ALLOW_CORRUPT_FARM === '1',
				minMonsterHp: parseFloat(process.env.FARMQ_MIN_MONSTER_HP ?? '0'),
				maxMonsterHp: process.env.FARMQ_MAX_MONSTER_HP ? parseFloat(process.env.FARMQ_MAX_MONSTER_HP) : undefined,
				minOpportunityVp: parseFloat(process.env.FARMQ_MIN_OPPORTUNITY_VP ?? '1'),
				selectHorizon: parseInt(process.env.FARMQ_SELECT_HORIZON ?? '6', 10),
				horizons,
				labelHorizon: parseInt(process.env.FARMQ_LABEL_HORIZON ?? String(horizons.includes(10) ? 10 : horizons[horizons.length - 1]), 10),
				labelVpThreshold: parseFloat(process.env.FARMQ_LABEL_VP_THRESHOLD ?? '0.5'),
				labelStatusTolerance: parseFloat(process.env.FARMQ_LABEL_STATUS_TOLERANCE ?? '0'),
				valueScaleVp: parseFloat(process.env.FARMQ_VALUE_SCALE_VP ?? '3'),
				samplePolicyWeight: process.env.FARMQ_POLICY_WEIGHT ? parseFloat(process.env.FARMQ_POLICY_WEIGHT) : undefined,
				dataOut: process.env.FARMQ_DATA_OUT,
				profiles: (process.env.FARMQ_PROFILES ?? 'paragon,farmer,farmer2,hard')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
				out: process.env.FARMQ_OUT ?? mlPath('farmq_counterfactual.json'),
				summaryOut: process.env.FARMQ_SUMMARY ?? mlPath('farmq_counterfactual_summary.json'),
				forbidTypes: parseForbidTypes(process.env.FARMQ_FORBID_TYPES),
				maxStatusLevel: process.env.FARMQ_MAX_STATUS_LEVEL ? parseInt(process.env.FARMQ_MAX_STATUS_LEVEL, 10) : undefined
			};
			const catalog = await loadOrSnapshotCatalog();
			if (cfg.dataOut) {
				mkdirSync(dirname(cfg.dataOut), { recursive: true });
				writeFileSync(cfg.dataOut, '');
			}
			const rows: WindowRow[] = [];
			const samples: Sample[] = [];
			let scannedFarmable = 0;
			let skippedNoAbyss = 0;
			let skippedNoNonAbyss = 0;

			for (let g = 0; g < cfg.games && rows.length < cfg.maxWindows; g++) {
				const setup = setupGame(catalog, 53_000_000 + g, cfg.seatsN);
				let state = setup.state;
				const seats = setup.seats;
				const profileBySeat: Record<string, BotProfile> = Object.fromEntries(
					seats.map((seat, i) => [seat, profileFor(cfg.profiles[i % cfg.profiles.length])])
				);
				const rng = seededBotRandom(53_000_000 + g);
				let ticks = 0;
				while (state.status === 'active' && state.round <= cfg.maxRounds && rows.length < cfg.maxWindows) {
					if (++ticks > MAX_TICKS) break;
					let progressed = false;
					for (const seat of state.activeSeats) {
						if (!botSeatNeedsToAct(state, seat)) continue;
						if (state.phase === 'navigation') {
							const signal = evaluateFarmValue(state, seat, catalog, { threshold: cfg.killThreshold });
							const effectiveSignal = effectiveFarmSignal(state, seat, catalog, signal, cfg);
							if (isQualified(state, seat, catalog, signal, cfg)) {
								scannedFarmable++;
								const branches = legalNavBranches(state, seat, catalog);
								const abyss = branches.find((x) => commandMatches(x.cmd, { type: 'lockNavigation', destination: 'Arcane Abyss' }));
								if (!abyss) {
									skippedNoAbyss++;
								} else {
									const nonAbyss = branches.filter((x) => x.cmd.type === 'lockNavigation' && x.cmd.destination !== 'Arcane Abyss');
									if (nonAbyss.length === 0) {
										skippedNoNonAbyss++;
									} else {
										const windowIndex = rows.length;
										const heuristic = heuristicNonAbyssBranch(state, seat, catalog, rng, profileBySeat[seat], nonAbyss);
										const best = bestNonAbyssByRollout(state, seat, catalog, profileBySeat, cfg, g, windowIndex, nonAbyss);
										const abyssState = branchFromAction(state, seat, catalog, abyss);
										const heuristicState = branchFromAction(state, seat, catalog, heuristic);
										const bestState = branchFromAction(state, seat, catalog, best);
										if (abyssState && heuristicState && bestState) {
											const abyssMetrics = rolloutBranch(
												abyssState,
												seat,
												catalog,
												profileBySeat,
												cfg,
												9_100_000 + g * 10_000 + windowIndex,
												abyss.cmd,
												state.round,
												cfg.horizons
											);
											const heuristicMetrics = rolloutBranch(
												heuristicState,
												seat,
												catalog,
												profileBySeat,
												cfg,
												9_100_000 + g * 10_000 + windowIndex,
												heuristic.cmd,
												state.round,
												cfg.horizons
											);
											const bestMetrics = rolloutBranch(
												bestState,
												seat,
												catalog,
												profileBySeat,
												cfg,
												9_100_000 + g * 10_000 + windowIndex,
												best.cmd,
												state.round,
												cfg.horizons
											);
											const delta = compareAt(abyssMetrics, bestMetrics, cfg.labelHorizon);
											const farmNowCorrect =
												delta.vpDelta >= cfg.labelVpThreshold &&
												delta.statusDelta <= cfg.labelStatusTolerance &&
												abyssMetrics.finalStatus <= (cfg.maxStatusLevel ?? Number.POSITIVE_INFINITY);
											rows.push({
												id: `g${g}-${seat}-r${state.round}-${windowIndex}`,
												game: g,
												seat,
												round: state.round,
												playerVp: state.players[seat]?.victoryPoints ?? 0,
												bestOpponentVp: bestOpponentVp(state, seat),
												monsterHp: effectiveSignal.monsterHp,
												monsterLives: state.monster?.livesRemaining ?? 0,
												farm: signal,
												cleanKillProb: +effectiveSignal.cleanKillProb.toFixed(3),
												firepowerKillProb: +effectiveSignal.firepowerKillProb.toFixed(3),
												corruptKillProb: +effectiveSignal.corruptKillProb.toFixed(3),
												effectiveKillProb: +effectiveSignal.effectiveKillProb.toFixed(3),
												effectiveOpportunityVp: +effectiveSignal.effectiveOpportunityVp.toFixed(2),
												abyss: abyssMetrics,
												heuristicNonAbyss: heuristicMetrics,
												bestNonAbyss: bestMetrics,
												farmQDeltaVp: +delta.vpDelta.toFixed(2),
												farmQDeltaStatus: +delta.statusDelta.toFixed(2),
												farmQDeltaRewardVp: +delta.rewardVpDelta.toFixed(2),
												farmQDeltaPvpVp: +delta.pvpVpDelta.toFixed(2),
												farmQDeltaKills: +delta.killsDelta.toFixed(2),
												farmQDeltaMonsterLivesConsumed: +delta.monsterLivesConsumedDelta.toFixed(2),
												farmQDeltaRaceMargin: +delta.raceMarginDelta.toFixed(2),
												farmQDeltaReach30: +delta.reach30Delta.toFixed(2),
												farmQDeltaPvpExposure: +delta.pvpExposureDelta.toFixed(2),
												farmNowCorrect,
												bestNonAbyssDestination: destinationOf(best.cmd),
												heuristicNonAbyssDestination: destinationOf(heuristic.cmd)
											});
											if (cfg.dataOut) {
												const chosenAction = farmNowCorrect ? abyss : best;
												const chosenIdx = branches.findIndex((x) => commandMatches(x.cmd, chosenAction.cmd));
												const farmValueTarget = farmNowCorrect
													? Math.max(0, Math.min(1, delta.vpDelta / Math.max(0.001, cfg.valueScaleVp)))
													: 0;
												recordNavigationSample(
													samples,
													state,
													seat,
													catalog,
													branches,
													chosenIdx,
													farmNowCorrect ? abyssMetrics : bestMetrics,
													cfg.labelHorizon,
													farmValueTarget,
													cfg.samplePolicyWeight
												);
											}
										}
									}
								}
							}
						}

						const plan = planBotPhaseActions(state, seat, catalog, rng, profileBySeat[seat]);
						for (const cmd of plan) {
							const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
							if (!r.ok) break;
							state = r.state;
							progressed = true;
							if (state.status !== 'active') break;
						}
						if (state.status !== 'active' || rows.length >= cfg.maxWindows) break;
					}
					if (state.status !== 'active' || rows.length >= cfg.maxWindows) break;
					if (!progressed) {
						const sig = `${state.phase}:${state.round}`;
						applyDeadlineAdvance(state, catalog);
						if (`${state.phase}:${state.round}` === sig) break;
					}
				}
			}

			const byHorizon = Object.fromEntries(cfg.horizons.map((h) => {
				const deltas = rows.map((r) => compareAt(r.abyss, r.bestNonAbyss, h).vpDelta);
				const positive = deltas.filter((d) => d >= cfg.labelVpThreshold).length;
				const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
				return [String(h), {
					avgFarmQDeltaVp: +avg.toFixed(2),
					farmNowPct: +((100 * positive) / Math.max(1, deltas.length)).toFixed(1)
				}];
			}));
			const positives = rows.filter((r) => r.farmNowCorrect).length;
			const summary = {
				mode: 'farm-counterfactual',
				config: {
					games: cfg.games,
					seats: Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length),
					maxRounds: cfg.maxRounds,
					branchRolloutsCapAtMaxRounds: true,
					maxWindows: cfg.maxWindows,
					minRound: cfg.minRound,
					maxRound: cfg.maxRound,
					killThreshold: cfg.killThreshold,
					qualifyMaxStatusLevel: cfg.qualifyMaxStatusLevel,
					allowFirepowerFarm: cfg.allowFirepowerFarm,
					allowCorruptFarm: cfg.allowCorruptFarm,
					minMonsterHp: cfg.minMonsterHp,
					maxMonsterHp: cfg.maxMonsterHp,
					minOpportunityVp: cfg.minOpportunityVp,
					selectHorizon: cfg.selectHorizon,
					horizons: cfg.horizons,
					labelHorizon: cfg.labelHorizon,
					labelVpThreshold: cfg.labelVpThreshold,
					labelStatusTolerance: cfg.labelStatusTolerance,
					valueScaleVp: cfg.valueScaleVp,
					samplePolicyWeight: cfg.samplePolicyWeight,
					dataOut: cfg.dataOut,
					profiles: cfg.profiles,
					forbidTypes: [...(cfg.forbidTypes ?? [])],
					maxStatusLevel: cfg.maxStatusLevel
				},
				scannedFarmable,
				windows: rows.length,
				skippedNoAbyss,
				skippedNoNonAbyss,
				roundCappedBranches: rows.reduce((sum, r) => {
					const branches = [r.abyss, r.heuristicNonAbyss, r.bestNonAbyss];
					return sum + branches.filter((b) => b.cappedByMaxRounds).length;
				}, 0),
				roundCappedWindows: rows.filter((r) => [r.abyss, r.heuristicNonAbyss, r.bestNonAbyss].some((b) => b.cappedByMaxRounds)).length,
				labelRoundCappedWindows: rows.filter((r) => {
					const labelRound = r.round + cfg.labelHorizon;
					return [r.abyss, r.heuristicNonAbyss, r.bestNonAbyss].some(
						(b) => b.cappedByMaxRounds && (b.snapshots[String(cfg.labelHorizon)]?.round ?? b.rolloutEndRound) < labelRound
					);
				}).length,
				farmNowCorrect: positives,
				farmNowPct: +((100 * positives) / Math.max(1, rows.length)).toFixed(1),
				avgFarmQDeltaVp: +(rows.reduce((sum, r) => sum + r.farmQDeltaVp, 0) / Math.max(1, rows.length)).toFixed(2),
				avgFarmQDeltaStatus: +(rows.reduce((sum, r) => sum + r.farmQDeltaStatus, 0) / Math.max(1, rows.length)).toFixed(2),
				avgFarmQDeltaRewardVp: +(rows.reduce((sum, r) => sum + r.farmQDeltaRewardVp, 0) / Math.max(1, rows.length)).toFixed(2),
				avgFarmQDeltaPvpVp: +(rows.reduce((sum, r) => sum + r.farmQDeltaPvpVp, 0) / Math.max(1, rows.length)).toFixed(2),
				avgFarmQDeltaMonsterLivesConsumed: +(rows.reduce((sum, r) => sum + r.farmQDeltaMonsterLivesConsumed, 0) / Math.max(1, rows.length)).toFixed(2),
				avgFarmQDeltaRaceMargin: +(rows.reduce((sum, r) => sum + r.farmQDeltaRaceMargin, 0) / Math.max(1, rows.length)).toFixed(2),
				avgFarmQDeltaReach30: +(rows.reduce((sum, r) => sum + r.farmQDeltaReach30, 0) / Math.max(1, rows.length)).toFixed(2),
				avgFarmQDeltaPvpExposure: +(rows.reduce((sum, r) => sum + r.farmQDeltaPvpExposure, 0) / Math.max(1, rows.length)).toFixed(2),
				byHorizon,
				bestNonAbyssDestinations: rows.reduce<Record<string, number>>((acc, r) => {
					acc[r.bestNonAbyssDestination] = (acc[r.bestNonAbyssDestination] ?? 0) + 1;
					return acc;
				}, {})
			};
			mkdirSync(dirname(cfg.out), { recursive: true });
			mkdirSync(dirname(cfg.summaryOut), { recursive: true });
			writeFileSync(cfg.out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
			writeFileSync(cfg.summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
			if (cfg.dataOut) {
				appendSamples(cfg.dataOut, samples, 0);
				writeFileSync(
					`${dirname(cfg.dataOut)}/meta.json`,
					`${JSON.stringify({
						obs_dim: OBS_DIM,
						act_dim: ACT_DIM,
						samples: samples.length,
						games: cfg.games,
						mode: 'farm-counterfactual',
						label_horizon: cfg.labelHorizon,
						label_vp_threshold: cfg.labelVpThreshold,
						value_scale_vp: cfg.valueScaleVp,
						policy_weight: cfg.samplePolicyWeight
					}, null, 2)}\n`
				);
			}
			/* eslint-disable no-console */
			console.log(
				`\n[farmq] windows=${rows.length}/${scannedFarmable} farmNow=${summary.farmNowPct}% avgDelta=${summary.avgFarmQDeltaVp} labelH=${cfg.labelHorizon}`
			);
			console.log(`[farmq] byHorizon=${JSON.stringify(byHorizon)}`);
			console.log(`[farmq] DONE -> ${cfg.out}`);
			if (cfg.dataOut) console.log(`[farmq] samples=${samples.length} -> ${cfg.dataOut}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
