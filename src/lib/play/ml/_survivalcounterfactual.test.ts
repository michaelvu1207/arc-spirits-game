/**
 * Survivability/build counterfactual diagnostic.
 *
 * Finds normal-start navigation windows where a Pure player has enough firepower
 * to kill the current Abyss monster, but cannot do it cleanly because the monster
 * hit would corrupt first. It then branches legal navigation:
 *
 *   A. lockNavigation: Arcane Abyss now
 *   B. heuristic non-Abyss navigation
 *   C. rollout-best non-Abyss navigation
 *
 * The label is counterfactual: build/rest now only wins if the best non-Abyss
 * branch creates more future clean fight windows or VP than Abyss-now.
 *
 * Opt in:
 *
 *   SURVIVALQ=1 SURVIVALQ_GAMES=2 \
 *     npx vitest run src/lib/play/ml/_survivalcounterfactual.test.ts --disable-console-intercept
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
import { claimableMonsterRewardVp } from './farmValue';
import { commandMatches, legalActionsWithNext, type LegalAction } from './actions';
import type { Sample } from './driver';
import { encodeAction, encodeObs } from './encode';
import { appendSamples, loadOrSnapshotCatalog, mlPath } from './nodeIo';
import { BALANCED_SHAPING, buildPotential, vpOf } from './shaping';

const RUN = process.env.SURVIVALQ === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;

interface Config {
	games: number;
	seatsN: number;
	maxRounds: number;
	maxWindows: number;
	firepowerThreshold: number;
	cleanThreshold: number;
	selectHorizon: number;
	horizons: number[];
	labelHorizon: number;
	labelVpThreshold: number;
	labelCleanOpportunityGain: number;
	dataOut?: string;
	profiles: string[];
	out: string;
	summaryOut: string;
	forbidTypes?: Set<GameCommand['type']>;
	maxStatusLevel?: number;
}

interface BranchSnapshot {
	vp: number;
	status: number;
	rewardVp: number;
	pvpVp: number;
	kills: number;
	combats: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	maxBarrier: number;
	maxCurrentBarrier: number;
	maxCleanKillProb: number;
	maxFirepowerKillProb: number;
	round: number;
}

interface BranchMetrics {
	action: string;
	destination: string;
	finalVp: number;
	finalStatus: number;
	rewardVp: number;
	pvpVp: number;
	kills: number;
	combats: number;
	combatOpportunities: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	corruptOnlyCombatOpportunities: number;
	maxBarrier: number;
	maxCurrentBarrier: number;
	maxCleanKillProb: number;
	maxFirepowerKillProb: number;
	rounds: number;
	snapshots: Record<string, BranchSnapshot>;
}

interface WindowRow {
	id: string;
	game: number;
	seat: SeatColor;
	round: number;
	playerVp: number;
	bestOpponentVp: number;
	monster: {
		name: string;
		damage: number;
		hp: number;
		livesRemaining: number;
		rewardVp: number;
	};
	player: {
		status: number;
		barrier: number;
		maxBarrier: number;
		survivalDeficit: number;
		maxBarrierDeficit: number;
	};
	cleanKillProb: number;
	firepowerKillProb: number;
	abyssNow: BranchMetrics;
	heuristicBuild: BranchMetrics;
	bestBuild: BranchMetrics;
	buildQDeltaVp: number;
	buildQDeltaStatus: number;
	buildQDeltaCleanCombatOpportunities: number;
	buildQDeltaFirepowerCombatOpportunities: number;
	buildNowCorrect: boolean;
	bestBuildDestination: string;
	heuristicBuildDestination: string;
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

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function commandLabel(cmd: GameCommand): string {
	if (cmd.type === 'lockNavigation') return `lockNavigation:${cmd.destination}`;
	return cmd.type;
}

function destinationOf(cmd: GameCommand): string {
	return cmd.type === 'lockNavigation' ? cmd.destination : '<none>';
}

function setupGame(catalog: PlayCatalog, seed: number, seatsN: number): { state: PublicGameState; seats: SeatColor[] } {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'SURV', guardianNames });
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
	if (!cfg.forbidTypes?.size && cfg.maxStatusLevel === undefined) return plan;
	const out: GameCommand[] = [];
	let probeState = state;
	for (const cmd of plan) {
		if (cfg.forbidTypes?.has(cmd.type)) continue;
		const probe = applyGameCommand(probeState, botActorFor(probeState, seat), cmd, catalog);
		if (!probe.ok) continue;
		if (cfg.maxStatusLevel !== undefined && (probe.state.players[seat]?.statusLevel ?? 0) > cfg.maxStatusLevel) {
			continue;
		}
		out.push(cmd);
		probeState = probe.state;
	}
	return out;
}

function newBranchMetrics(action: GameCommand, state: PublicGameState, seat: SeatColor, startRound: number): BranchMetrics {
	const player = state.players[seat];
	return {
		action: commandLabel(action),
		destination: destinationOf(action),
		finalVp: player?.victoryPoints ?? 0,
		finalStatus: player?.statusLevel ?? 0,
		rewardVp: 0,
		pvpVp: 0,
		kills: 0,
		combats: 0,
		combatOpportunities: 0,
		cleanCombatOpportunities: 0,
		firepowerCombatOpportunities: 0,
		corruptOnlyCombatOpportunities: 0,
		maxBarrier: player?.maxBarrier ?? 0,
		maxCurrentBarrier: player?.barrier ?? 0,
		maxCleanKillProb: 0,
		maxFirepowerKillProb: 0,
		rounds: state.round - startRound,
		snapshots: {}
	};
}

function snapshot(metrics: BranchMetrics, state: PublicGameState, seat: SeatColor, key: number): void {
	const player = state.players[seat];
	metrics.snapshots[String(key)] = {
		vp: player?.victoryPoints ?? 0,
		status: player?.statusLevel ?? 0,
		rewardVp: metrics.rewardVp,
		pvpVp: metrics.pvpVp,
		kills: metrics.kills,
		combats: metrics.combats,
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		maxBarrier: metrics.maxBarrier,
		maxCurrentBarrier: metrics.maxCurrentBarrier,
		maxCleanKillProb: metrics.maxCleanKillProb,
		maxFirepowerKillProb: metrics.maxFirepowerKillProb,
		round: state.round
	};
}

function recordBuild(metrics: BranchMetrics, state: PublicGameState, seat: SeatColor): void {
	const player = state.players[seat];
	if (!player) return;
	metrics.maxBarrier = Math.max(metrics.maxBarrier, player.maxBarrier ?? 0);
	metrics.maxCurrentBarrier = Math.max(metrics.maxCurrentBarrier, player.barrier ?? 0);
}

function recordCombatOpportunity(
	metrics: BranchMetrics,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): void {
	const legalCombat = legalActionsWithNext(state, seat, catalog).some((x) => x.cmd.type === 'startCombat');
	if (!legalCombat) return;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const corruptProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: true });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	metrics.combatOpportunities++;
	metrics.maxCleanKillProb = Math.max(metrics.maxCleanKillProb, cleanProb);
	metrics.maxFirepowerKillProb = Math.max(metrics.maxFirepowerKillProb, firepowerProb);
	if (cleanProb >= cfg.cleanThreshold) metrics.cleanCombatOpportunities++;
	if (firepowerProb >= cfg.firepowerThreshold) metrics.firepowerCombatOpportunities++;
	if (cleanProb < cfg.cleanThreshold && corruptProb >= cfg.firepowerThreshold) metrics.corruptOnlyCombatOpportunities++;
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
	const rng = seededBotRandom(seed);
	const metrics = newBranchMetrics(action, state, seat, startRound);
	recordBuild(metrics, state, seat);
	const actionCounter = new Map<string, number>();
	let ticks = 0;
	while (state.status === 'active' && state.round < startRound + maxHorizon && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const activeSeat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, activeSeat)) continue;
			const key = `${activeSeat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			if (activeSeat === seat) recordCombatOpportunity(metrics, state, seat, catalog, cfg);
			let plan = planBotPhaseActions(state, activeSeat, catalog, rng, profileBySeat[activeSeat]);
			if (activeSeat === seat) plan = filterTargetPlan(state, activeSeat, catalog, plan, cfg);
			for (const cmd of plan) {
				const beforeVp = state.players[seat]?.victoryPoints ?? 0;
				const r = applyGameCommand(state, botActorFor(state, activeSeat), cmd, catalog, { mutate: true });
				if (!r.ok) break;
				state = r.state;
				progressed = true;
				actionCounter.set(key, used + 1);
				if (activeSeat === seat) {
					recordBuild(metrics, state, seat);
					if (cmd.type === 'startCombat') {
						metrics.combats++;
						const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
						if (combat?.killed) metrics.kills++;
					}
					if (cmd.type === 'resolveMonsterReward') {
						metrics.rewardVp += Math.max(0, (state.players[seat]?.victoryPoints ?? 0) - beforeVp);
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
				if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
			}
			if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
		}
		if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			recordBuild(metrics, state, seat);
			if (`${state.phase}:${state.round}` === sig) break;
		}
	}
	for (const h of horizons) {
		if (metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
	}
	metrics.finalVp = state.players[seat]?.victoryPoints ?? 0;
	metrics.finalStatus = state.players[seat]?.statusLevel ?? 0;
	metrics.rounds = state.round - startRound;
	return metrics;
}

function legalNavBranches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): LegalAction[] {
	return legalActionsWithNext(state, seat, catalog).filter((x) => x.cmd.type === 'lockNavigation');
}

function branchFromAction(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, action: LegalAction): PublicGameState | null {
	const result = applyGameCommand(state, botActorFor(state, seat), action.cmd, catalog);
	return result.ok ? result.state : null;
}

function snapAt(metrics: BranchMetrics, horizon: number): BranchSnapshot {
	return metrics.snapshots[String(horizon)] ?? {
		vp: metrics.finalVp,
		status: metrics.finalStatus,
		rewardVp: metrics.rewardVp,
		pvpVp: metrics.pvpVp,
		kills: metrics.kills,
		combats: metrics.combats,
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		maxBarrier: metrics.maxBarrier,
		maxCurrentBarrier: metrics.maxCurrentBarrier,
		maxCleanKillProb: metrics.maxCleanKillProb,
		maxFirepowerKillProb: metrics.maxFirepowerKillProb,
		round: 0
	};
}

function branchScore(metrics: BranchMetrics, horizon: number): number {
	const snap = snapAt(metrics, horizon);
	return (
		snap.vp +
		snap.cleanCombatOpportunities * 2 +
		snap.firepowerCombatOpportunities * 0.25 +
		snap.maxBarrier * 0.2 +
		snap.maxCleanKillProb * 2 -
		snap.status * 2
	);
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
			12_800_000 + gameIndex * 10_000 + windowIndex * 100 + i,
			branches[i].cmd,
			state.round,
			[cfg.selectHorizon]
		);
		const score = branchScore(metrics, cfg.selectHorizon);
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

function bestOpponentVp(state: PublicGameState, seat: SeatColor): number {
	let best = 0;
	for (const [otherSeat, player] of Object.entries(state.players)) {
		if (otherSeat === seat) continue;
		best = Math.max(best, player?.victoryPoints ?? 0);
	}
	return best;
}

function isUnsafeFirepowerWindow(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): { ok: boolean; cleanProb: number; firepowerProb: number; rewardVp: number } {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || monster.livesRemaining <= 0) {
		return { ok: false, cleanProb: 0, firepowerProb: 0, rewardVp: 0 };
	}
	if ((player.statusLevel ?? 0) !== 0) return { ok: false, cleanProb: 0, firepowerProb: 0, rewardVp: 0 };
	const rewardVp = claimableMonsterRewardVp(monster.rewardTrack, monster.chooseAmount);
	if (rewardVp <= 0) return { ok: false, cleanProb: 0, firepowerProb: 0, rewardVp: 0 };
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	return {
		ok: firepowerProb >= cfg.firepowerThreshold && cleanProb < cfg.cleanThreshold,
		cleanProb,
		firepowerProb,
		rewardVp
	};
}

function compareBuild(bestBuild: BranchMetrics, abyssNow: BranchMetrics, horizon: number): {
	vpDelta: number;
	statusDelta: number;
	cleanDelta: number;
	firepowerDelta: number;
} {
	const build = snapAt(bestBuild, horizon);
	const abyss = snapAt(abyssNow, horizon);
	return {
		vpDelta: build.vp - abyss.vp,
		statusDelta: build.status - abyss.status,
		cleanDelta: build.cleanCombatOpportunities - abyss.cleanCombatOpportunities,
		firepowerDelta: build.firepowerCombatOpportunities - abyss.firepowerCombatOpportunities
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
	labelHorizon: number
): void {
	if (withNext.length <= 1 || chosenIdx < 0) return;
	const chosenSnap = snapAt(chosenMetrics, labelHorizon);
	samples.push({
		obs: encodeObs(state, seat),
		cands: withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
		chosen: chosenIdx,
		pi: withNext.map((_, i) => (i === chosenIdx ? 1 : 0)),
		ret: clamp01(Math.max(vpOf(state.players[seat]), chosenSnap.vp) / VP_TO_WIN),
		seat,
		vp: vpOf(state.players[seat]),
		phi: buildPotential(state.players[seat], BALANCED_SHAPING),
		kill: 0,
		...sampleAuxTargets(state, seat, catalog, withNext)
	});
}

describe('survivability counterfactual diagnostics', () => {
	(RUN ? it : it.skip)(
		'branches unsafe-but-firepower-capable windows into Abyss-now vs build/rest rollouts',
		async () => {
			const horizons = parseHorizons(process.env.SURVIVALQ_HORIZONS);
			const cfg: Config = {
				games: parseInt(process.env.SURVIVALQ_GAMES ?? '4', 10),
				seatsN: parseInt(process.env.SURVIVALQ_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.SURVIVALQ_MAXROUNDS ?? '30', 10),
				maxWindows: parseInt(process.env.SURVIVALQ_MAX_WINDOWS ?? '80', 10),
				firepowerThreshold: parseFloat(process.env.SURVIVALQ_FIREPOWER_THRESHOLD ?? '0.5'),
				cleanThreshold: parseFloat(process.env.SURVIVALQ_CLEAN_THRESHOLD ?? '0.5'),
				selectHorizon: parseInt(process.env.SURVIVALQ_SELECT_HORIZON ?? '6', 10),
				horizons,
				labelHorizon: parseInt(process.env.SURVIVALQ_LABEL_HORIZON ?? String(horizons.includes(10) ? 10 : horizons[horizons.length - 1]), 10),
				labelVpThreshold: parseFloat(process.env.SURVIVALQ_LABEL_VP_THRESHOLD ?? '0.5'),
				labelCleanOpportunityGain: parseFloat(process.env.SURVIVALQ_LABEL_CLEAN_GAIN ?? '1'),
				dataOut: process.env.SURVIVALQ_DATA_OUT,
				profiles: (process.env.SURVIVALQ_PROFILES ?? 'paragon,farmer,farmer2,hard')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
				out: process.env.SURVIVALQ_OUT ?? mlPath('survivalq_counterfactual.json'),
				summaryOut: process.env.SURVIVALQ_SUMMARY ?? mlPath('survivalq_counterfactual_summary.json'),
				forbidTypes: parseForbidTypes(process.env.SURVIVALQ_FORBID_TYPES ?? 'initiatePvp'),
				maxStatusLevel: process.env.SURVIVALQ_MAX_STATUS_LEVEL
					? parseInt(process.env.SURVIVALQ_MAX_STATUS_LEVEL, 10)
					: 0
			};
			const catalog = await loadOrSnapshotCatalog();
			if (cfg.dataOut) {
				mkdirSync(dirname(cfg.dataOut), { recursive: true });
				writeFileSync(cfg.dataOut, '');
			}
			const rows: WindowRow[] = [];
			let scannedUnsafeFirepower = 0;
			let skippedNoAbyss = 0;
			let skippedNoNonAbyss = 0;
			const samples: Sample[] = [];

			for (let g = 0; g < cfg.games && rows.length < cfg.maxWindows; g++) {
				const setup = setupGame(catalog, 63_000_000 + g, cfg.seatsN);
				let state = setup.state;
				const seats = setup.seats;
				const profileBySeat: Record<string, BotProfile> = Object.fromEntries(
					seats.map((seat, i) => [seat, profileFor(cfg.profiles[i % cfg.profiles.length])])
				);
				const rng = seededBotRandom(63_000_000 + g);
				let ticks = 0;
				while (state.status === 'active' && state.round <= cfg.maxRounds && rows.length < cfg.maxWindows) {
					if (++ticks > MAX_TICKS) break;
					let progressed = false;
					for (const seat of state.activeSeats) {
						if (!botSeatNeedsToAct(state, seat)) continue;
						if (state.phase === 'navigation') {
							const signal = isUnsafeFirepowerWindow(state, seat, catalog, cfg);
							if (signal.ok) {
								scannedUnsafeFirepower++;
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
												13_100_000 + g * 10_000 + windowIndex,
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
												13_200_000 + g * 10_000 + windowIndex,
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
												13_300_000 + g * 10_000 + windowIndex,
												best.cmd,
												state.round,
												cfg.horizons
											);
											const delta = compareBuild(bestMetrics, abyssMetrics, cfg.labelHorizon);
											const player = state.players[seat]!;
											const monster = state.monster!;
											const buildNowCorrect =
												delta.statusDelta <= 0 &&
												(
													delta.cleanDelta >= cfg.labelCleanOpportunityGain ||
													delta.vpDelta >= cfg.labelVpThreshold
												);
											rows.push({
												id: `g${g}-${seat}-r${state.round}-${windowIndex}`,
												game: g,
												seat,
												round: state.round,
												playerVp: player.victoryPoints ?? 0,
												bestOpponentVp: bestOpponentVp(state, seat),
												monster: {
													name: monster.name,
													damage: monster.damage,
													hp: monster.maxHp,
													livesRemaining: monster.livesRemaining,
													rewardVp: signal.rewardVp
												},
												player: {
													status: player.statusLevel ?? 0,
													barrier: player.barrier ?? 0,
													maxBarrier: player.maxBarrier ?? 0,
													survivalDeficit: Math.max(0, monster.damage + 1 - (player.barrier ?? 0)),
													maxBarrierDeficit: Math.max(0, monster.damage + 1 - (player.maxBarrier ?? 0))
												},
												cleanKillProb: +signal.cleanProb.toFixed(3),
												firepowerKillProb: +signal.firepowerProb.toFixed(3),
												abyssNow: abyssMetrics,
												heuristicBuild: heuristicMetrics,
												bestBuild: bestMetrics,
												buildQDeltaVp: +delta.vpDelta.toFixed(2),
												buildQDeltaStatus: +delta.statusDelta.toFixed(2),
												buildQDeltaCleanCombatOpportunities: +delta.cleanDelta.toFixed(2),
												buildQDeltaFirepowerCombatOpportunities: +delta.firepowerDelta.toFixed(2),
												buildNowCorrect,
												bestBuildDestination: destinationOf(best.cmd),
												heuristicBuildDestination: destinationOf(heuristic.cmd)
											});
											if (cfg.dataOut) {
												const chosenAction = buildNowCorrect ? best : abyss;
												const chosenIdx = branches.findIndex((x) => commandMatches(x.cmd, chosenAction.cmd));
												recordNavigationSample(
													samples,
													state,
													seat,
													catalog,
													branches,
													chosenIdx,
													buildNowCorrect ? bestMetrics : abyssMetrics,
													cfg.labelHorizon
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
				const deltas = rows.map((r) => compareBuild(r.bestBuild, r.abyssNow, h));
				const correct = deltas.filter((d) => (
					d.statusDelta <= 0 &&
					(d.cleanDelta >= cfg.labelCleanOpportunityGain || d.vpDelta >= cfg.labelVpThreshold)
				)).length;
				const avgVp = deltas.reduce((sum, d) => sum + d.vpDelta, 0) / Math.max(1, deltas.length);
				const avgClean = deltas.reduce((sum, d) => sum + d.cleanDelta, 0) / Math.max(1, deltas.length);
				return [String(h), {
					avgBuildQDeltaVp: +avgVp.toFixed(2),
					avgBuildQDeltaCleanCombatOpportunities: +avgClean.toFixed(2),
					buildNowPct: +((100 * correct) / Math.max(1, deltas.length)).toFixed(1)
				}];
			}));
			const positives = rows.filter((r) => r.buildNowCorrect).length;
			const summary = {
				mode: 'survival-counterfactual',
				config: {
					games: cfg.games,
					seats: Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length),
					maxRounds: cfg.maxRounds,
					maxWindows: cfg.maxWindows,
					firepowerThreshold: cfg.firepowerThreshold,
					cleanThreshold: cfg.cleanThreshold,
					selectHorizon: cfg.selectHorizon,
					horizons: cfg.horizons,
					labelHorizon: cfg.labelHorizon,
					labelVpThreshold: cfg.labelVpThreshold,
					labelCleanOpportunityGain: cfg.labelCleanOpportunityGain,
					dataOut: cfg.dataOut,
					profiles: cfg.profiles,
					forbidTypes: [...(cfg.forbidTypes ?? [])],
					maxStatusLevel: cfg.maxStatusLevel
				},
				scannedUnsafeFirepower,
				windows: rows.length,
				skippedNoAbyss,
				skippedNoNonAbyss,
				buildNowCorrect: positives,
				buildNowPct: +((100 * positives) / Math.max(1, rows.length)).toFixed(1),
				avgBuildQDeltaVp: +(rows.reduce((sum, r) => sum + r.buildQDeltaVp, 0) / Math.max(1, rows.length)).toFixed(2),
				avgBuildQDeltaStatus: +(rows.reduce((sum, r) => sum + r.buildQDeltaStatus, 0) / Math.max(1, rows.length)).toFixed(2),
				avgBuildQDeltaCleanCombatOpportunities: +(rows.reduce((sum, r) => sum + r.buildQDeltaCleanCombatOpportunities, 0) / Math.max(1, rows.length)).toFixed(2),
				avgSurvivalDeficit: +(rows.reduce((sum, r) => sum + r.player.survivalDeficit, 0) / Math.max(1, rows.length)).toFixed(2),
				avgMaxBarrierDeficit: +(rows.reduce((sum, r) => sum + r.player.maxBarrierDeficit, 0) / Math.max(1, rows.length)).toFixed(2),
				byHorizon,
				bestBuildDestinations: rows.reduce<Record<string, number>>((acc, r) => {
					acc[r.bestBuildDestination] = (acc[r.bestBuildDestination] ?? 0) + 1;
					return acc;
				}, {}),
				heuristicBuildDestinations: rows.reduce<Record<string, number>>((acc, r) => {
					acc[r.heuristicBuildDestination] = (acc[r.heuristicBuildDestination] ?? 0) + 1;
					return acc;
				}, {})
			};
			mkdirSync(dirname(cfg.out), { recursive: true });
			mkdirSync(dirname(cfg.summaryOut), { recursive: true });
			writeFileSync(cfg.out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
			writeFileSync(cfg.summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
			if (cfg.dataOut) appendSamples(cfg.dataOut, samples, 0);
			/* eslint-disable no-console */
			console.log(
				`\n[survivalq] windows=${rows.length}/${scannedUnsafeFirepower} buildNow=${summary.buildNowPct}% ` +
				`avgCleanDelta=${summary.avgBuildQDeltaCleanCombatOpportunities} avgVpDelta=${summary.avgBuildQDeltaVp}`
			);
			console.log(`[survivalq] byHorizon=${JSON.stringify(byHorizon)}`);
			console.log(`[survivalq] bestBuildDest=${JSON.stringify(summary.bestBuildDestinations)}`);
			if (cfg.dataOut) console.log(`[survivalq] samples=${samples.length} -> ${cfg.dataOut}`);
			console.log(`[survivalq] DONE -> ${cfg.out}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
