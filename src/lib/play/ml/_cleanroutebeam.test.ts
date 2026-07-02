/**
 * Clean-route legal beam prover.
 *
 * This is an oracle diagnostic, not a bot policy. It starts from normal legal
 * games, advances non-target seats with existing bot profiles, and branches the
 * target seat over the real reducer-legal action set under Pure/no-PvP
 * constraints. The question is: can any bounded legal planner find a clean
 * monster/economy route to 30 from normal starts?
 *
 * Opt in:
 *
 *   ROUTEORACLE=1 npx vitest run src/lib/play/ml/_cleanroutebeam.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import { expectedAttack } from '../combat';
import { awakenedClassCounts } from '../effects/apply';
import { buildMonsterRewards } from '../monsterRewards';
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
import { legalActionsWithNext, type LegalAction } from './actions';
import { evaluateFarmValue } from './farmValue';
import { loadOrSnapshotCatalog, mlPath } from './nodeIo';

const RUN = process.env.ROUTEORACLE === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;

interface Config {
	games: number;
	seatsN: number;
	maxRounds: number;
	beamSize: number;
	actionBeam: number;
	maxTargetDecisions: number;
	profiles: string[];
	plannerProfile: string;
	forbidTypes?: Set<GameCommand['type']>;
	maxStatusLevel?: number;
	out: string;
	summaryOut: string;
	progressEvery: number;
	seedBase: number;
	traceLimit: number;
}

interface RouteStats {
	monsterKills: number;
	combats: number;
	rewardVp: number;
	abyssNavs: number;
	targetPvpEvents: number;
	actionCounts: Record<string, number>;
}

interface BeamNode {
	state: PublicGameState;
	score: number;
	seed: number;
	decisions: number;
	stats: RouteStats;
	trace: string[];
	terminalReason?: string;
}

interface GameRow {
	game: number;
	seat: SeatColor;
	bestVp: number;
	bestStatus: number;
	bestRound: number;
	bestExpectedAttack: number;
	bestBarrier: number;
	bestMaxBarrier: number;
	bestAttackDice: number;
	bestSpiritAnimal: number;
	bestCultivator: number;
	monsterHp: number;
	monsterDamage: number;
	monsterLives: number;
	cleanKillProb: number;
	firepowerKillProb: number;
	reach30: boolean;
	monsterKills: number;
	combats: number;
	rewardVp: number;
	abyssNavs: number;
	targetPvpEvents: number;
	decisions: number;
	terminalReason?: string;
	frontier: FrontierDiagnosis;
	actionCounts: Record<string, number>;
	trace: string[];
}

interface BuildSnapshot {
	expectedAttack: number;
	barrier: number;
	maxBarrier: number;
	attackDice: number;
	spiritAnimal: number;
	cultivator: number;
	monsterHp: number;
	monsterDamage: number;
	monsterLives: number;
	cleanKillProb: number;
	firepowerKillProb: number;
}

interface FrontierDiagnosis extends BuildSnapshot {
	vp: number;
	round: number;
	phase: string;
	navigationDestination: string | null;
	rewardVp: number;
	finishPotentialVp: number;
	survivalTarget: number;
	damageDeficit: number;
	barrierDeficit: number;
	maxBarrierDeficit: number;
	farmable: boolean;
	finishReachable: boolean;
	immediateStartCombatLegal: boolean;
	immediateResolveRewardLegal: boolean;
	reasons: string[];
	legalActionTypes: Record<string, number>;
	topActions: Array<{
		cmd: string;
		nextVp: number;
		nextStatus: number;
		nextRound: number;
		nextPhase: string;
		nextCleanKillProb: number;
		nextFirepowerKillProb: number;
	}>;
}

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed >>> 0 || 1);
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

function cloneState(state: PublicGameState): PublicGameState {
	return JSON.parse(JSON.stringify(state)) as PublicGameState;
}

function cloneStats(stats: RouteStats): RouteStats {
	return {
		monsterKills: stats.monsterKills,
		combats: stats.combats,
		rewardVp: stats.rewardVp,
		abyssNavs: stats.abyssNavs,
		targetPvpEvents: stats.targetPvpEvents,
		actionCounts: { ...stats.actionCounts }
	};
}

function addCount(counts: Record<string, number>, key: string, amount = 1): void {
	counts[key] = (counts[key] ?? 0) + amount;
}

function setupGame(catalog: PlayCatalog, seed: number, seatsN: number): { state: PublicGameState; seats: SeatColor[] } {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'ORACLE', guardianNames });
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

function commandLabel(cmd: GameCommand): string {
	if (cmd.type === 'lockNavigation') return `lockNavigation:${cmd.destination}`;
	if (cmd.type === 'resolveLocationInteraction') return `resolveLocationInteraction:${cmd.rowIndex}:${cmd.choices?.[0] ?? 0}`;
	if (cmd.type === 'resolveDecision') return `resolveDecision:${cmd.decisionId}:${cmd.optionId}`;
	if (cmd.type === 'resolveMonsterReward') return `resolveMonsterReward:${cmd.picks.join('+')}`;
	return cmd.type;
}

function pendingRewardVpPotential(state: PublicGameState, seat: SeatColor): number {
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return 0;
	const options = buildMonsterRewards(pending.rewardTrack)
		.map((opt) => opt.effect.type === 'vp' ? opt.effect.amount : 0)
		.sort((a, b) => b - a);
	return options.slice(0, pending.chooseAmount).reduce((sum, vp) => sum + vp, 0);
}

function rewardVpForAction(before: PublicGameState, after: PublicGameState, seat: SeatColor, cmd: GameCommand): number {
	if (cmd.type !== 'resolveMonsterReward') return 0;
	return Math.max(0, (after.players[seat]?.victoryPoints ?? 0) - (before.players[seat]?.victoryPoints ?? 0));
}

function monsterKillForSeat(after: PublicGameState, seat: SeatColor): boolean {
	return after.combats.some((combat) => combat.kind === 'monster' && combat.sides[0]?.seat === seat && combat.killed);
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

function applyStats(stats: RouteStats, before: PublicGameState, after: PublicGameState, seat: SeatColor, cmd: GameCommand): void {
	addCount(stats.actionCounts, cmd.type);
	if (cmd.type === 'lockNavigation' && cmd.destination === 'Arcane Abyss') stats.abyssNavs++;
	if (cmd.type === 'startCombat') {
		stats.combats++;
		if (monsterKillForSeat(after, seat)) stats.monsterKills++;
	}
	stats.rewardVp += rewardVpForAction(before, after, seat, cmd);
	stats.targetPvpEvents += pvpEventsAgainstTarget(before, after, seat);
}

function actionAllowed(action: LegalAction, seat: SeatColor, cfg: Config): boolean {
	if (cfg.forbidTypes?.has(action.cmd.type)) return false;
	if (cfg.maxStatusLevel !== undefined && (action.next.players[seat]?.statusLevel ?? 0) > cfg.maxStatusLevel) return false;
	return true;
}

function buildScore(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, stats: RouteStats): number {
	const player = state.players[seat];
	if (!player) return -1_000_000_000;
	const vp = player.victoryPoints ?? 0;
	const status = player.statusLevel ?? 0;
	const attack = expectedAttack(player);
	const counts = awakenedClassCounts(player);
	const monster = state.monster;
	const monsterHp = monster?.maxHp ?? monster?.hp ?? 0;
	const monsterDamage = monster?.damage ?? 0;
	const survivalTarget = monsterDamage + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const cleanProb = monster ? computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) : 0;
	const firepowerProb = monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
	const pendingVp = pendingRewardVpPotential(state, seat);
	const spiritAnimal = counts['Spirit Animal'] ?? 0;
	const cultivator = counts.Cultivator ?? 0;
	const attackDice = player.attackDice?.length ?? 0;
	const finishReachable = farm.valid && farm.rewardVp > 0 && vp + farm.rewardVp * Math.max(1, farm.livesRemaining) >= VP_TO_WIN;
	const survivalGap = survivalTarget > 0 ? Math.max(0, survivalTarget - barrier) : 0;
	const maxBarrierGap = survivalTarget > 0 ? Math.max(0, survivalTarget - maxBarrier) : 0;
	const damageGap = monsterHp > 0 ? Math.max(0, monsterHp - attack) : 0;

	return (
		vp * 10_000 +
		stats.rewardVp * 1_250 +
		stats.monsterKills * 850 +
		stats.abyssNavs * 80 +
		pendingVp * 900 +
		(farm.valid ? farm.opportunityVp * 420 + farm.rewardVp * 220 + farm.livesRemaining * 45 : 0) +
		(finishReachable ? 2_500 : 0) +
		cleanProb * 420 +
		firepowerProb * 260 +
		attack * 95 +
		attackDice * 140 +
		spiritAnimal * 160 +
		cultivator * 120 +
		maxBarrier * 75 +
		barrier * 55 -
		damageGap * 180 -
		survivalGap * 220 -
		maxBarrierGap * 260 -
		status * 100_000 -
		stats.targetPvpEvents * 1_500 -
		state.round * 15
	);
}

function stateKey(state: PublicGameState, seat: SeatColor): string {
	const player = state.players[seat];
	const counts = player ? awakenedClassCounts(player) : {};
	return [
		state.round,
		state.phase,
		player?.navigationDestination ?? '',
		player?.victoryPoints ?? 0,
		player?.statusLevel ?? 0,
		player?.barrier ?? 0,
		player?.maxBarrier ?? 0,
		player?.attackDice?.length ?? 0,
		counts['Spirit Animal'] ?? 0,
		counts.Cultivator ?? 0,
		state.monster?.maxHp ?? state.monster?.hp ?? 0,
		state.monster?.livesRemaining ?? 0,
		!!player?.pendingReward
	].join('|');
}

function buildSnapshot(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): BuildSnapshot {
	const player = state.players[seat];
	const counts = player ? awakenedClassCounts(player) : {};
	const monster = state.monster;
	return {
		expectedAttack: player ? +expectedAttack(player).toFixed(2) : 0,
		barrier: player?.barrier ?? 0,
		maxBarrier: player?.maxBarrier ?? 0,
		attackDice: player?.attackDice?.length ?? 0,
		spiritAnimal: counts['Spirit Animal'] ?? 0,
		cultivator: counts.Cultivator ?? 0,
		monsterHp: monster?.maxHp ?? monster?.hp ?? 0,
		monsterDamage: monster?.damage ?? 0,
		monsterLives: monster?.livesRemaining ?? 0,
		cleanKillProb: monster ? +computeKillProbability(state, seat, catalog, { allowCorruptKill: false }).toFixed(3) : 0,
		firepowerKillProb: monster ? +firepowerKillProbability(state, seat, catalog).toFixed(3) : 0
	};
}

function actionTypeCounts(actions: LegalAction[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const action of actions) addCount(counts, action.cmd.type);
	return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function diagnoseFrontier(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): FrontierDiagnosis {
	const player = state.players[seat];
	const build = buildSnapshot(state, seat, catalog);
	const vp = player?.victoryPoints ?? 0;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
	const rewardVp = farm.valid ? farm.rewardVp : 0;
	const finishPotentialVp = vp + rewardVp * Math.max(1, farm.valid ? farm.livesRemaining : build.monsterLives);
	const survivalTarget = build.monsterDamage + 1;
	const damageDeficit = build.monsterHp > 0 ? Math.max(0, build.monsterHp + 0.5 - build.expectedAttack) : 0;
	const barrierDeficit = survivalTarget > 0 ? Math.max(0, survivalTarget - build.barrier) : 0;
	const maxBarrierDeficit = survivalTarget > 0 ? Math.max(0, survivalTarget - build.maxBarrier) : 0;
	const legal = legalActionsWithNext(state, seat, catalog).filter((action) => actionAllowed(action, seat, cfg));
	const immediateStartCombatLegal = legal.some((action) => action.cmd.type === 'startCombat');
	const immediateResolveRewardLegal = legal.some((action) => action.cmd.type === 'resolveMonsterReward');
	const reasons: string[] = [];
	if (vp >= VP_TO_WIN) reasons.push('reached-30');
	if (state.round > cfg.maxRounds) reasons.push('round-limit');
	if ((player?.statusLevel ?? 0) > (cfg.maxStatusLevel ?? Number.POSITIVE_INFINITY)) reasons.push('status-cap');
	if (finishPotentialVp < VP_TO_WIN) reasons.push('insufficient-remaining-reward-vp');
	if (build.monsterLives <= 0) reasons.push('no-current-monster-lives');
	if (damageDeficit > 0) reasons.push('damage-deficit');
	if (maxBarrierDeficit > 0) reasons.push('max-barrier-deficit');
	else if (barrierDeficit > 0) reasons.push('current-barrier-deficit');
	if (farm.valid && farm.farmable && farm.opportunityVp > 0) reasons.push('farmable-now');
	if (build.firepowerKillProb >= 0.5 && build.cleanKillProb < 0.5) reasons.push('firepower-ready-but-not-clean');
	if (!immediateStartCombatLegal && state.phase !== 'location') reasons.push('not-at-location-combat-step');
	if (immediateResolveRewardLegal) reasons.push('pending-reward-unresolved');
	if (!reasons.length) reasons.push('unclassified-frontier');
	const topActions = topN(legal, 8, (action) => {
		const stats: RouteStats = { monsterKills: 0, combats: 0, rewardVp: 0, abyssNavs: 0, targetPvpEvents: 0, actionCounts: {} };
		applyStats(stats, state, action.next, seat, action.cmd);
		return buildScore(action.next, seat, catalog, stats) + routeActionBonus(state, action.next, seat, catalog, action.cmd);
	}).map((action) => ({
		cmd: commandLabel(action.cmd),
		nextVp: action.next.players[seat]?.victoryPoints ?? 0,
		nextStatus: action.next.players[seat]?.statusLevel ?? 0,
		nextRound: action.next.round,
		nextPhase: action.next.phase,
		nextCleanKillProb: action.next.monster ? +computeKillProbability(action.next, seat, catalog, { allowCorruptKill: false }).toFixed(3) : 0,
		nextFirepowerKillProb: action.next.monster ? +firepowerKillProbability(action.next, seat, catalog).toFixed(3) : 0
	}));
	return {
		...build,
		vp,
		round: state.round,
		phase: state.phase,
		navigationDestination: player?.navigationDestination ?? null,
		rewardVp,
		finishPotentialVp,
		survivalTarget,
		damageDeficit: +damageDeficit.toFixed(2),
		barrierDeficit,
		maxBarrierDeficit,
		farmable: farm.valid && farm.farmable && farm.opportunityVp > 0,
		finishReachable: finishPotentialVp >= VP_TO_WIN,
		immediateStartCombatLegal,
		immediateResolveRewardLegal,
		reasons,
		legalActionTypes: actionTypeCounts(legal),
		topActions
	};
}

function topN<T>(items: T[], n: number, score: (item: T) => number): T[] {
	return [...items].sort((a, b) => score(b) - score(a)).slice(0, n);
}

function pruneBeam(nodes: BeamNode[], cfg: Config, seat: SeatColor): BeamNode[] {
	const seen = new Set<string>();
	const out: BeamNode[] = [];
	for (const node of [...nodes].sort((a, b) => b.score - a.score || (b.state.players[seat]?.victoryPoints ?? 0) - (a.state.players[seat]?.victoryPoints ?? 0))) {
		const key = stateKey(node.state, seat);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(node);
		if (out.length >= cfg.beamSize) break;
	}
	return out;
}

function isTerminal(state: PublicGameState, seat: SeatColor, cfg: Config): string | null {
	if (state.status !== 'active') return 'game-ended';
	if (state.round > cfg.maxRounds) return 'max-rounds';
	if ((state.players[seat]?.victoryPoints ?? 0) >= VP_TO_WIN) return 'reach30';
	if (cfg.maxStatusLevel !== undefined && (state.players[seat]?.statusLevel ?? 0) > cfg.maxStatusLevel) return 'status-cap';
	return null;
}

function opponentRng(node: BeamNode, state: PublicGameState, seat: SeatColor, tick: number): BotRandom {
	const seatIndex = SEAT_COLORS.indexOf(seat);
	const phaseHash = Array.from(state.phase).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
	return seededBotRandom((node.seed + state.round * 997 + phaseHash * 37 + seatIndex * 131 + tick * 17 + node.decisions * 8191) >>> 0);
}

function filterOpponentPlan(
	state: PublicGameState,
	activeSeat: SeatColor,
	catalog: PlayCatalog,
	plan: GameCommand[]
): GameCommand[] {
	const out: GameCommand[] = [];
	let probeState = state;
	for (const cmd of plan) {
		const probe = applyGameCommand(probeState, botActorFor(probeState, activeSeat), cmd, catalog);
		if (!probe.ok) continue;
		out.push(cmd);
		probeState = probe.state;
	}
	return out;
}

function advanceToTargetDecision(
	node: BeamNode,
	seat: SeatColor,
	catalog: PlayCatalog,
	profileBySeat: Record<string, BotProfile>,
	cfg: Config
): BeamNode {
	let state = node.state;
	let ticks = 0;
	const actionCounter = new Map<string, number>();
	while (state.status === 'active' && state.round <= cfg.maxRounds && ticks++ < MAX_TICKS) {
		if (botSeatNeedsToAct(state, seat)) break;
		let progressed = false;
		for (const activeSeat of state.activeSeats) {
			if (activeSeat === seat || !botSeatNeedsToAct(state, activeSeat)) continue;
			const key = `${activeSeat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			const rng = opponentRng(node, state, activeSeat, ticks);
			const plan = filterOpponentPlan(
				state,
				activeSeat,
				catalog,
				planBotPhaseActions(state, activeSeat, catalog, rng, profileBySeat[activeSeat])
			);
			for (const cmd of plan) {
				const before = state;
				const r = applyGameCommand(state, botActorFor(state, activeSeat), cmd, catalog, { mutate: true });
				if (!r.ok) break;
				state = r.state;
				node.stats.targetPvpEvents += pvpEventsAgainstTarget(before, state, seat);
				progressed = true;
				actionCounter.set(key, used + 1);
				if (state.status !== 'active' || state.round > cfg.maxRounds || botSeatNeedsToAct(state, seat)) break;
			}
			if (state.status !== 'active' || state.round > cfg.maxRounds || botSeatNeedsToAct(state, seat)) break;
		}
		if (state.status !== 'active' || state.round > cfg.maxRounds || botSeatNeedsToAct(state, seat)) break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === sig) break;
		}
	}
	node.state = state;
	const terminal = isTerminal(state, seat, cfg);
	if (terminal) node.terminalReason = terminal;
	return node;
}

function expandNode(
	node: BeamNode,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): BeamNode[] {
	const terminal = isTerminal(node.state, seat, cfg);
	if (terminal) {
		node.terminalReason = terminal;
		node.score = buildScore(node.state, seat, catalog, node.stats);
		return [node];
	}
	if (!botSeatNeedsToAct(node.state, seat)) return [node];
	const legal = legalActionsWithNext(node.state, seat, catalog).filter((action) => actionAllowed(action, seat, cfg));
	if (!legal.length) {
		return [{ ...node, terminalReason: 'no-legal-target-action', score: buildScore(node.state, seat, catalog, node.stats) - 50_000 }];
	}
	const actionScore = (action: LegalAction): number => {
		const stats = cloneStats(node.stats);
		applyStats(stats, node.state, action.next, seat, action.cmd);
		return buildScore(action.next, seat, catalog, stats) + routeActionBonus(node.state, action.next, seat, catalog, action.cmd) - node.decisions * 80;
	};
	const ranked = topN(legal, cfg.actionBeam, actionScore);
	return ranked.map((action, index) => {
		const stats = cloneStats(node.stats);
		applyStats(stats, node.state, action.next, seat, action.cmd);
		const trace = [...node.trace, `${action.next.round}:${action.next.phase}:${commandLabel(action.cmd)}->vp${action.next.players[seat]?.victoryPoints ?? 0}`];
		const child: BeamNode = {
			state: action.next,
			score: actionScore(action),
			seed: (node.seed * 1664525 + 1013904223 + index * 97) >>> 0,
			decisions: node.decisions + 1,
			stats,
			trace: trace.slice(-80)
		};
		const terminalReason = isTerminal(child.state, seat, cfg);
		if (terminalReason) child.terminalReason = terminalReason;
		return child;
	});
}

function routeActionBonus(
	before: PublicGameState,
	after: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cmd: GameCommand
): number {
	const beforePlayer = before.players[seat];
	const afterPlayer = after.players[seat];
	if (!beforePlayer || !afterPlayer) return -10_000;
	const vpDelta = (afterPlayer.victoryPoints ?? 0) - (beforePlayer.victoryPoints ?? 0);
	const beforeCounts = awakenedClassCounts(beforePlayer);
	const afterCounts = awakenedClassCounts(afterPlayer);
	const attackDelta = expectedAttack(afterPlayer) - expectedAttack(beforePlayer);
	const maxBarrierDelta = (afterPlayer.maxBarrier ?? 0) - (beforePlayer.maxBarrier ?? 0);
	const barrierDelta = (afterPlayer.barrier ?? 0) - (beforePlayer.barrier ?? 0);
	const spiritCountDelta = (afterPlayer.spirits?.length ?? 0) - (beforePlayer.spirits?.length ?? 0);
	const handDrawDelta = (afterPlayer.handDraws?.length ?? 0) - (beforePlayer.handDraws?.length ?? 0);
	const matDelta = (afterPlayer.mats?.length ?? 0) - (beforePlayer.mats?.length ?? 0);
	const augmentDelta = (afterPlayer.unplacedAugments?.length ?? 0) - (beforePlayer.unplacedAugments?.length ?? 0);
	const attackDiceDelta = (afterPlayer.attackDice?.length ?? 0) - (beforePlayer.attackDice?.length ?? 0);
	const spiritAnimalDelta = (afterCounts['Spirit Animal'] ?? 0) - (beforeCounts['Spirit Animal'] ?? 0);
	const cultivatorDelta = (afterCounts.Cultivator ?? 0) - (beforeCounts.Cultivator ?? 0);
	const firepowerDelta = firepowerKillProbability(after, seat, catalog) - firepowerKillProbability(before, seat, catalog);
	const monster = before.monster;
	const monsterHp = monster?.maxHp ?? monster?.hp ?? 0;
	const survivalTarget = (monster?.damage ?? 0) + 1;
	const cleanProb = monster ? computeKillProbability(before, seat, catalog, { allowCorruptKill: false }) : 0;
	const firepowerProb = monster ? firepowerKillProbability(before, seat, catalog) : 0;
	const restoreDeficit = survivalTarget > 0 && (beforePlayer.maxBarrier ?? 0) >= survivalTarget && (beforePlayer.barrier ?? 0) < survivalTarget;
	const maxBarrierDeficit = survivalTarget > 0 && (beforePlayer.maxBarrier ?? 0) < survivalTarget;
	const damageDeficit = monsterHp > 0 && (expectedAttack(beforePlayer) < monsterHp + 0.5 || firepowerProb < 0.5);
	let score = vpDelta * 7_500;

	switch (cmd.type) {
		case 'resolveMonsterReward':
			score += 5_000;
			break;
		case 'startCombat':
			score += monsterKillForSeat(after, seat) ? 6_000 : -2_000;
			break;
		case 'lockNavigation': {
			if (cmd.destination === 'Arcane Abyss') {
				const farm = evaluateFarmValue(before, seat, catalog, { threshold: 0.5 });
				if (farm.valid && farm.farmable && farm.opportunityVp > 0) score += 8_000 + farm.opportunityVp * 900;
				else if (cleanProb >= 0.5 || firepowerProb >= 0.5) score += 2_500;
				else score -= 2_500;
			} else if (cmd.destination === 'Lantern Canyon') {
				score += (restoreDeficit ? 6_000 : 1_500) + (maxBarrierDeficit ? 2_500 : 0);
			} else if (cmd.destination === 'Tidal Cove' || cmd.destination === 'Cyber City') {
				score += (damageDeficit ? (cmd.destination === 'Tidal Cove' ? 4_800 : 3_800) : 1_200) +
					Math.max(0, attackDelta) * 900 +
					Math.max(0, firepowerDelta) * 1_200;
			} else if (cmd.destination === 'Floral Patch') {
				score += (restoreDeficit ? 2_500 : 900) + (maxBarrierDeficit ? 2_800 : 0) + Math.max(0, maxBarrierDelta) * 800;
			}
			break;
		}
		case 'resolveLocationInteraction':
			score += 700 +
				Math.max(0, attackDelta) * 1_200 +
				Math.max(0, maxBarrierDelta) * 900 +
				Math.max(0, barrierDelta) * 450 +
				Math.max(0, handDrawDelta) * 900 +
				Math.max(0, spiritCountDelta) * 1_400 +
				Math.max(0, matDelta) * 900 +
				Math.max(0, augmentDelta) * 1_200 +
				Math.max(0, attackDiceDelta) * 1_200 +
				Math.max(0, spiritAnimalDelta) * 1_000 +
				Math.max(0, cultivatorDelta) * 850 +
				Math.max(0, firepowerDelta) * 1_600;
			if (
				vpDelta <= 0 &&
				attackDelta <= 0 &&
				maxBarrierDelta <= 0 &&
				barrierDelta <= 0 &&
				handDrawDelta <= 0 &&
				spiritCountDelta <= 0 &&
				matDelta <= 0 &&
				augmentDelta <= 0 &&
				attackDiceDelta <= 0 &&
				spiritAnimalDelta <= 0 &&
				cultivatorDelta <= 0
			) {
				score -= 900;
			}
			break;
		case 'takeSpirit':
		case 'replaceSpirit': {
			const buildGain =
				Math.max(0, spiritCountDelta) * 2_200 +
				Math.max(0, attackDelta) * 1_000 +
				Math.max(0, spiritAnimalDelta) * 1_100 +
				Math.max(0, cultivatorDelta) * 900 +
				Math.max(0, firepowerDelta) * 1_500;
			score += buildGain > 0 ? buildGain : -1_200;
			break;
		}
		case 'spawnHandSpirit':
		case 'awakenSpirit':
		case 'manualAwaken':
		case 'resolveDecision':
		case 'placeAugmentOnSpirit':
			score += 900 +
				Math.max(0, spiritCountDelta) * 2_000 +
				Math.max(0, attackDelta) * 1_100 +
				Math.max(0, spiritAnimalDelta) * 1_100 +
				Math.max(0, cultivatorDelta) * 900 +
				Math.max(0, maxBarrierDelta) * 700 +
				Math.max(0, attackDiceDelta) * 1_200;
			break;
		case 'endLocationActions':
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
		case 'passEncounter':
			score += beforePlayer.pendingReward ? -4_000 : 2_200;
			break;
		case 'refillMarket':
			score -= 7_500;
			break;
		case 'discardSpirit':
		case 'discardRune':
		case 'absorbSpirit':
		case 'detachRuneFromSpirit':
			score -= 2_000;
			break;
		default:
			score -= 250;
			break;
	}

	return score;
}

function betterNode(a: BeamNode, b: BeamNode | null, seat: SeatColor, catalog: PlayCatalog): BeamNode {
	if (!b) return a;
	const avp = a.state.players[seat]?.victoryPoints ?? 0;
	const bvp = b.state.players[seat]?.victoryPoints ?? 0;
	if (avp !== bvp) return avp > bvp ? a : b;
	if (a.stats.monsterKills !== b.stats.monsterKills) return a.stats.monsterKills > b.stats.monsterKills ? a : b;
	const ascore = buildScore(a.state, seat, catalog, a.stats);
	const bscore = buildScore(b.state, seat, catalog, b.stats);
	return ascore >= bscore ? a : b;
}

function runBeamGame(catalog: PlayCatalog, cfg: Config, game: number): GameRow {
	const setup = setupGame(catalog, cfg.seedBase + game, cfg.seatsN);
	const seats = setup.seats;
	const targetSeat = seats[game % seats.length];
	const profiles = seats.map((seat, i) => seat === targetSeat
		? profileFor(cfg.plannerProfile)
		: profileFor(cfg.profiles[(game + i) % cfg.profiles.length]));
	const profileBySeat = Object.fromEntries(seats.map((seat, i) => [seat, profiles[i]])) as Record<string, BotProfile>;
	const initialStats: RouteStats = { monsterKills: 0, combats: 0, rewardVp: 0, abyssNavs: 0, targetPvpEvents: 0, actionCounts: {} };
	let beam: BeamNode[] = [{
		state: cloneState(setup.state),
		score: 0,
		seed: (cfg.seedBase + game * 97) >>> 0,
		decisions: 0,
		stats: initialStats,
		trace: []
	}];
	let best: BeamNode | null = null;
	for (let step = 0; step < cfg.maxTargetDecisions && beam.length > 0; step++) {
		const expanded: BeamNode[] = [];
		for (const raw of beam) {
			const advanced = advanceToTargetDecision({ ...raw, stats: cloneStats(raw.stats), trace: [...raw.trace] }, targetSeat, catalog, profileBySeat, cfg);
			advanced.score = buildScore(advanced.state, targetSeat, catalog, advanced.stats);
			best = betterNode(advanced, best, targetSeat, catalog);
			if (advanced.terminalReason === 'reach30') {
				expanded.push(advanced);
				continue;
			}
			expanded.push(...expandNode(advanced, targetSeat, catalog, cfg));
		}
		for (const node of expanded) best = betterNode(node, best, targetSeat, catalog);
		if (best && (best.state.players[targetSeat]?.victoryPoints ?? 0) >= VP_TO_WIN) break;
		beam = pruneBeam(expanded.filter((node) => node.terminalReason !== 'reach30'), cfg, targetSeat);
	}
	if (best && !best.terminalReason) best.terminalReason = 'decision-budget';
	best ??= beam[0] ?? {
		state: setup.state,
		score: 0,
		seed: cfg.seedBase + game,
		decisions: 0,
		stats: initialStats,
		trace: [],
		terminalReason: 'empty-beam'
	};
	const player = best.state.players[targetSeat];
	const build = buildSnapshot(best.state, targetSeat, catalog);
	const frontier = diagnoseFrontier(best.state, targetSeat, catalog, cfg);
	return {
		game,
		seat: targetSeat,
		bestVp: player?.victoryPoints ?? 0,
		bestStatus: player?.statusLevel ?? 0,
		bestRound: best.state.round,
		bestExpectedAttack: build.expectedAttack,
		bestBarrier: build.barrier,
		bestMaxBarrier: build.maxBarrier,
		bestAttackDice: build.attackDice,
		bestSpiritAnimal: build.spiritAnimal,
		bestCultivator: build.cultivator,
		monsterHp: build.monsterHp,
		monsterDamage: build.monsterDamage,
		monsterLives: build.monsterLives,
		cleanKillProb: build.cleanKillProb,
		firepowerKillProb: build.firepowerKillProb,
		reach30: (player?.victoryPoints ?? 0) >= VP_TO_WIN,
		monsterKills: best.stats.monsterKills,
		combats: best.stats.combats,
		rewardVp: best.stats.rewardVp,
		abyssNavs: best.stats.abyssNavs,
		targetPvpEvents: best.stats.targetPvpEvents,
		decisions: best.decisions,
		terminalReason: best.terminalReason,
		frontier,
		actionCounts: best.stats.actionCounts,
		trace: best.trace.slice(-cfg.traceLimit)
	};
}

function avg(values: number[]): number {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function topCounts(rows: GameRow[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) for (const [key, value] of Object.entries(row.actionCounts)) counts[key] = (counts[key] ?? 0) + value;
	return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20));
}

function frontierReasonCounts(rows: GameRow[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) for (const reason of row.frontier.reasons) addCount(counts, reason);
	return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

describe('clean-route legal beam prover', () => {
	(RUN ? it : it.skip)(
		'searches legal Pure/no-PvP target actions from normal starts',
		async () => {
			const cfg: Config = {
				games: parseInt(process.env.ROUTEORACLE_GAMES ?? '2', 10),
				seatsN: parseInt(process.env.ROUTEORACLE_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.ROUTEORACLE_MAXROUNDS ?? '30', 10),
				beamSize: parseInt(process.env.ROUTEORACLE_BEAM ?? '16', 10),
				actionBeam: parseInt(process.env.ROUTEORACLE_ACTION_BEAM ?? '12', 10),
				maxTargetDecisions: parseInt(process.env.ROUTEORACLE_MAX_TARGET_DECISIONS ?? '160', 10),
				profiles: (process.env.ROUTEORACLE_PROFILES ?? 'medium,cultivator,survivor,hard')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
				plannerProfile: process.env.ROUTEORACLE_PLANNER_PROFILE ?? 'cultivator',
				forbidTypes: parseForbidTypes(process.env.ROUTEORACLE_FORBID_TYPES ?? 'initiatePvp'),
				maxStatusLevel: process.env.ROUTEORACLE_MAX_STATUS_LEVEL ? parseInt(process.env.ROUTEORACLE_MAX_STATUS_LEVEL, 10) : 0,
				out: process.env.ROUTEORACLE_OUT ?? mlPath('clean_route_beam.json'),
				summaryOut: process.env.ROUTEORACLE_SUMMARY ?? mlPath('clean_route_beam_summary.json'),
				progressEvery: parseInt(process.env.ROUTEORACLE_PROGRESS_EVERY ?? '0', 10),
				seedBase: parseInt(process.env.ROUTEORACLE_SEED_BASE ?? '7600000', 10),
				traceLimit: parseInt(process.env.ROUTEORACLE_TRACE_LIMIT ?? '80', 10)
			};
			const catalog = await loadOrSnapshotCatalog();
			const rows: GameRow[] = [];
			for (let game = 0; game < cfg.games; game++) {
				if (cfg.progressEvery > 0 && game % cfg.progressEvery === 0) {
					/* eslint-disable-next-line no-console */
					console.log(`[route-oracle] progress ${game}/${cfg.games}`);
				}
				rows.push(runBeamGame(catalog, cfg, game));
			}
			const bestRows = [...rows].sort((a, b) => b.bestVp - a.bestVp || b.monsterKills - a.monsterKills).slice(0, 8);
			const summary = {
				mode: 'clean-route-legal-beam-prover',
				generatedAt: new Date().toISOString(),
				config: {
					games: cfg.games,
					seats: Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length),
					maxRounds: cfg.maxRounds,
					beamSize: cfg.beamSize,
					actionBeam: cfg.actionBeam,
					maxTargetDecisions: cfg.maxTargetDecisions,
					profiles: cfg.profiles,
					plannerProfile: cfg.plannerProfile,
					forbidTypes: cfg.forbidTypes ? [...cfg.forbidTypes] : undefined,
					maxStatusLevel: cfg.maxStatusLevel
				},
				games: rows.length,
				reach30: rows.filter((row) => row.reach30).length,
				reach30Pct: +((100 * rows.filter((row) => row.reach30).length) / Math.max(1, rows.length)).toFixed(1),
				avgBestVp: +avg(rows.map((row) => row.bestVp)).toFixed(2),
				maxBestVp: Math.max(0, ...rows.map((row) => row.bestVp)),
				avgStatus: +avg(rows.map((row) => row.bestStatus)).toFixed(2),
				maxStatus: Math.max(0, ...rows.map((row) => row.bestStatus)),
				avgMonsterKills: +avg(rows.map((row) => row.monsterKills)).toFixed(2),
				avgRewardVp: +avg(rows.map((row) => row.rewardVp)).toFixed(2),
				avgAbyssNavs: +avg(rows.map((row) => row.abyssNavs)).toFixed(2),
				avgExpectedAttack: +avg(rows.map((row) => row.bestExpectedAttack)).toFixed(2),
				avgBarrier: +avg(rows.map((row) => row.bestBarrier)).toFixed(2),
				avgMaxBarrier: +avg(rows.map((row) => row.bestMaxBarrier)).toFixed(2),
				avgCleanKillProb: +avg(rows.map((row) => row.cleanKillProb)).toFixed(3),
				avgFirepowerKillProb: +avg(rows.map((row) => row.firepowerKillProb)).toFixed(3),
				avgFinishPotentialVp: +avg(rows.map((row) => row.frontier.finishPotentialVp)).toFixed(2),
				frontierReasonCounts: frontierReasonCounts(rows),
				targetPvpEvents: rows.reduce((sum, row) => sum + row.targetPvpEvents, 0),
				actionCounts: topCounts(rows),
				bestRows
			};
			mkdirSync(dirname(cfg.out), { recursive: true });
			mkdirSync(dirname(cfg.summaryOut), { recursive: true });
			writeFileSync(cfg.out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
			writeFileSync(cfg.summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
			/* eslint-disable no-console */
			console.log(`[route-oracle] games=${rows.length} avgBestVp=${summary.avgBestVp} maxBestVp=${summary.maxBestVp} reach30=${summary.reach30Pct}% avgKills=${summary.avgMonsterKills}`);
			console.log(`[route-oracle] DONE -> ${cfg.summaryOut}`);
			/* eslint-enable no-console */
		},
		2 * 60 * 60 * 1000
	);
});
