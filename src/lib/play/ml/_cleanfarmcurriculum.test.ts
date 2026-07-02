/**
 * Reachable clean-farm curriculum DATA GENERATION.
 *
 * Unlike `_abysscurriculum.test.ts`, this does not inject mature builds. It
 * starts legal games from round 1, lets named heuristic profiles build a real
 * prefix, and only records teacher samples when the shared farm-value metric
 * says a clean Arcane Abyss farm is available.
 *
 * Opt in:
 *
 *   CLEANFARMCURRICULUM=1 CLEANFARMCURRICULUM_GAMES=2 \
 *     npx vitest run src/lib/play/ml/_cleanfarmcurriculum.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	profileFor,
	type BotRandom
} from '../server/botPolicy';
import { buildMonsterRewards } from '../monsterRewards';
import {
	SEAT_COLORS,
	VP_TO_WIN,
	type GameActor,
	type GameCommand,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { legalActionsWithNext, commandMatches, type LegalAction } from './actions';
import { sampleAuxTargets } from './auxTargets';
import type { Sample } from './driver';
import { encodeAction, encodeObs, OBS_DIM, ACT_DIM } from './encode';
import { evaluateFarmValue, type FarmValueSignal } from './farmValue';
import { scoresToPolicyTarget } from './neuralBot';
import { appendSamples, loadOrSnapshotCatalog, mlPath } from './nodeIo';
import { BALANCED_SHAPING, buildPotential, vpOf } from './shaping';

const RUN = process.env.CLEANFARMCURRICULUM === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;

type TeacherKind = 'farm-nav' | 'farm-combat' | 'reward-pick' | 'route-pass';

interface CurriculumConfig {
	games: number;
	seatsN: number;
	maxRounds: number;
	killThreshold: number;
	minScore: number;
	minOpportunityVp: number;
	maxStatusLevel: number;
	targetTemperature: number;
	dataDir: string;
	outFile: string;
	summaryFile: string;
	profiles: string[];
}

interface TeacherDecision {
	idx: number;
	kind: TeacherKind;
	record: boolean;
	signal?: FarmValueSignal;
}

interface CurriculumStats {
	games: number;
	seatGames: number;
	samples: number;
	navSamples: number;
	combatSamples: number;
	rewardSamples: number;
	routePasses: number;
	rewardPiSamples: number;
	farmableNavs: number;
	heuristicMissedFarmableNavs: number;
	farmOpportunityVp: number;
	coveredFarmOpportunityVp: number;
	combats: number;
	kills: number;
	rewards: number;
	rewardVp: number;
	sumVP: number;
	sumStatus: number;
	sumRounds: number;
	firstFarmableRounds: number[];
	decisionTypes: Record<string, number>;
}

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed);
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

function parseProfiles(raw: string | undefined): string[] {
	return (raw ?? 'paragon,farmer,farmer2,hard')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function initStats(): CurriculumStats {
	return {
		games: 0,
		seatGames: 0,
		samples: 0,
		navSamples: 0,
		combatSamples: 0,
		rewardSamples: 0,
		routePasses: 0,
		rewardPiSamples: 0,
		farmableNavs: 0,
		heuristicMissedFarmableNavs: 0,
		farmOpportunityVp: 0,
		coveredFarmOpportunityVp: 0,
		combats: 0,
		kills: 0,
		rewards: 0,
		rewardVp: 0,
		sumVP: 0,
		sumStatus: 0,
		sumRounds: 0,
		firstFarmableRounds: [],
		decisionTypes: {}
	};
}

function addStats(total: CurriculumStats, part: CurriculumStats): void {
	total.games += part.games;
	total.seatGames += part.seatGames;
	total.samples += part.samples;
	total.navSamples += part.navSamples;
	total.combatSamples += part.combatSamples;
	total.rewardSamples += part.rewardSamples;
	total.routePasses += part.routePasses;
	total.rewardPiSamples += part.rewardPiSamples;
	total.farmableNavs += part.farmableNavs;
	total.heuristicMissedFarmableNavs += part.heuristicMissedFarmableNavs;
	total.farmOpportunityVp += part.farmOpportunityVp;
	total.coveredFarmOpportunityVp += part.coveredFarmOpportunityVp;
	total.combats += part.combats;
	total.kills += part.kills;
	total.rewards += part.rewards;
	total.rewardVp += part.rewardVp;
	total.sumVP += part.sumVP;
	total.sumStatus += part.sumStatus;
	total.sumRounds += part.sumRounds;
	total.firstFarmableRounds.push(...part.firstFarmableRounds);
	for (const [k, v] of Object.entries(part.decisionTypes)) {
		total.decisionTypes[k] = (total.decisionTypes[k] ?? 0) + v;
	}
}

function countDecision(stats: CurriculumStats, kind: TeacherKind, cmd: GameCommand): void {
	stats.decisionTypes[`${kind}:${cmd.type}`] = (stats.decisionTypes[`${kind}:${cmd.type}`] ?? 0) + 1;
}

function rewardVpForCommand(state: PublicGameState, seat: SeatColor, cmd: GameCommand): number {
	if (cmd.type !== 'resolveMonsterReward') return 0;
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return 0;
	const options = buildMonsterRewards(pending.rewardTrack);
	let total = 0;
	for (const pick of cmd.picks ?? []) {
		const opt = options.find((x) => x.index === pick);
		if (opt?.effect.type === 'vp') total += opt.effect.amount;
	}
	return total;
}

function chooseRewardIndex(state: PublicGameState, seat: SeatColor, withNext: LegalAction[]): number {
	let best = -1;
	let bestVp = -1;
	let bestPickCount = Infinity;
	for (let i = 0; i < withNext.length; i++) {
		const cmd = withNext[i].cmd;
		if (cmd.type !== 'resolveMonsterReward') continue;
		const vp = rewardVpForCommand(state, seat, cmd);
		const pickCount = cmd.picks?.length ?? 0;
		if (vp > bestVp || (vp === bestVp && pickCount < bestPickCount)) {
			best = i;
			bestVp = vp;
			bestPickCount = pickCount;
		}
	}
	return best;
}

function atArcaneAbyss(state: PublicGameState, seat: SeatColor): boolean {
	return state.players[seat]?.navigationDestination === 'Arcane Abyss';
}

function qualifies(signal: FarmValueSignal, cfg: CurriculumConfig): boolean {
	return (
		signal.valid &&
		signal.statusLevel <= cfg.maxStatusLevel &&
		signal.farmable &&
		signal.cleanKillProb >= cfg.killThreshold &&
		signal.opportunityVp >= cfg.minOpportunityVp &&
		signal.score >= cfg.minScore
	);
}

function firstCommandIndex(withNext: LegalAction[], command: GameCommand): number {
	return withNext.findIndex((x) => commandMatches(x.cmd, command));
}

function chooseTeacherDecision(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	cfg: CurriculumConfig
): TeacherDecision | null {
	const player = state.players[seat];
	if (!player) return null;

	if (state.phase === 'navigation') {
		const signal = evaluateFarmValue(state, seat, catalog, { threshold: cfg.killThreshold });
		if (!qualifies(signal, cfg)) return null;
		const idx = firstCommandIndex(withNext, { type: 'lockNavigation', destination: 'Arcane Abyss' });
		return idx >= 0 ? { idx, kind: 'farm-nav', record: true, signal } : null;
	}

	if (state.phase === 'encounter' && atArcaneAbyss(state, seat)) {
		const idx = firstCommandIndex(withNext, { type: 'passEncounter' });
		return idx >= 0 ? { idx, kind: 'route-pass', record: false } : null;
	}

	if (state.phase === 'location' && atArcaneAbyss(state, seat)) {
		if (player.pendingReward) {
			const idx = chooseRewardIndex(state, seat, withNext);
			return idx >= 0 ? { idx, kind: 'reward-pick', record: true } : null;
		}
		const signal = evaluateFarmValue(state, seat, catalog, { threshold: cfg.killThreshold });
		if (!qualifies(signal, cfg)) return null;
		const idx = firstCommandIndex(withNext, { type: 'startCombat' });
		return idx >= 0 ? { idx, kind: 'farm-combat', record: true, signal } : null;
	}

	return null;
}

function policyTarget(withNext: LegalAction[], idx: number, kind: TeacherKind, cfg: CurriculumConfig): number[] {
	const scores = withNext.map(() => 0);
	const focus = kind === 'farm-nav' ? 1 : kind === 'farm-combat' ? 1.25 : 1.5;
	scores[idx] = focus;
	return scoresToPolicyTarget(scores, cfg.targetTemperature);
}

function localReturnTarget(
	state: PublicGameState,
	seat: SeatColor,
	chosen: LegalAction,
	decision: TeacherDecision
): number {
	const beforeVp = state.players[seat]?.victoryPoints ?? 0;
	const afterVp = chosen.next.players[seat]?.victoryPoints ?? beforeVp;
	const opportunity = decision.signal?.remainingOpportunityVp ?? decision.signal?.opportunityVp ?? 0;
	return clamp01((Math.max(beforeVp, afterVp) + opportunity) / VP_TO_WIN);
}

function recordSample(
	samples: Sample[],
	stats: CurriculumStats,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	decision: TeacherDecision,
	cfg: CurriculumConfig
): void {
	if (!decision.record || withNext.length <= 1) return;
	const chosen = withNext[decision.idx];
	const aux = sampleAuxTargets(state, seat, catalog, withNext);
	samples.push({
		obs: encodeObs(state, seat),
		cands: withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
		chosen: decision.idx,
		pi: policyTarget(withNext, decision.idx, decision.kind, cfg),
		ret: localReturnTarget(state, seat, chosen, decision),
		seat,
		vp: vpOf(state.players[seat]),
		phi: buildPotential(state.players[seat], BALANCED_SHAPING),
		kill: chosen.cmd.type === 'resolveMonsterReward' ? 1 : 0,
		...aux
	});
	stats.samples++;
	if (decision.kind === 'farm-nav') stats.navSamples++;
	if (decision.kind === 'farm-combat') stats.combatSamples++;
	if (decision.kind === 'reward-pick') stats.rewardSamples++;
	if (aux.rewardPi) stats.rewardPiSamples++;
}

function setupGame(
	catalog: PlayCatalog,
	seed: number,
	seatsN: number
): {
	state: PublicGameState;
	seats: SeatColor[];
} {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'CLFC', guardianNames });
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

function runCurriculumGame(catalog: PlayCatalog, seed: number, cfg: CurriculumConfig) {
	const setup = setupGame(catalog, seed, cfg.seatsN);
	let state = setup.state;
	const seats = setup.seats;
	const stats = initStats();
	stats.games = 1;
	const samples: Sample[] = [];
	const profiles = Object.fromEntries(seats.map((seat, i) => [seat, profileFor(cfg.profiles[i % cfg.profiles.length])]));
	const rng = seededBotRandom(seed ^ 0x51f15e);
	const actionCounter = new Map<string, number>();
	const firstFarmableRound: Record<string, number | null> = Object.fromEntries(seats.map((seat) => [seat, null]));

	let ticks = 0;
	while (state.status === 'active' && state.round <= cfg.maxRounds && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const key = `${seat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			const withNext = legalActionsWithNext(state, seat, catalog);
			if (withNext.length === 0) continue;

			if (state.phase === 'navigation') {
				const signal = evaluateFarmValue(state, seat, catalog, { threshold: cfg.killThreshold });
				if (qualifies(signal, cfg)) {
					stats.farmableNavs++;
					stats.farmOpportunityVp += signal.remainingOpportunityVp;
					if (firstFarmableRound[seat] === null) firstFarmableRound[seat] = state.round;
					const heuristicPlan = planBotPhaseActions(state, seat, catalog, rng, profiles[seat]);
					const heuristicGoesAbyss = heuristicPlan.some(
						(cmd) => cmd.type === 'lockNavigation' && cmd.destination === 'Arcane Abyss'
					);
					if (!heuristicGoesAbyss) stats.heuristicMissedFarmableNavs++;
				}
			}

			const teacher = chooseTeacherDecision(state, seat, catalog, withNext, cfg);
			if (teacher) {
				const chosen = withNext[teacher.idx];
				recordSample(samples, stats, state, seat, catalog, withNext, teacher, cfg);
				countDecision(stats, teacher.kind, chosen.cmd);
				if (teacher.kind === 'farm-nav' && teacher.signal) {
					stats.coveredFarmOpportunityVp += teacher.signal.remainingOpportunityVp;
				}
				if (teacher.kind === 'route-pass') stats.routePasses++;
				if (chosen.cmd.type === 'startCombat') {
					stats.combats++;
					const combat = chosen.next.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
					if (combat?.killed) stats.kills++;
				}
				if (chosen.cmd.type === 'resolveMonsterReward') {
					stats.rewards++;
					stats.rewardVp += rewardVpForCommand(state, seat, chosen.cmd);
				}
				state = chosen.next;
				actionCounter.set(key, used + 1);
				progressed = true;
				if (state.status !== 'active') break;
				continue;
			}

			const plan = planBotPhaseActions(state, seat, catalog, rng, profiles[seat]);
			for (const cmd of plan) {
				const res = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
				if (!res.ok) break;
				state = res.state;
				progressed = true;
				if (state.status !== 'active') break;
			}
			if (state.status !== 'active') break;
		}
		if (state.status !== 'active') break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === sig) break;
		}
	}

	const finalVP: Record<string, number> = {};
	for (const seat of seats) {
		const player = state.players[seat];
		if (!player) continue;
		finalVP[seat] = player.victoryPoints ?? 0;
		stats.seatGames++;
		stats.sumVP += player.victoryPoints ?? 0;
		stats.sumStatus += player.statusLevel ?? 0;
		stats.sumRounds += state.round;
		const first = firstFarmableRound[seat];
		if (first !== null) stats.firstFarmableRounds.push(first);
	}
	for (const sample of samples) {
		sample.ret = Math.max(sample.ret, clamp01((finalVP[sample.seat] ?? 0) / VP_TO_WIN));
	}
	return { state, seats, stats, samples };
}

function rowFromStats(stats: CurriculumStats): Record<string, unknown> {
	const avg = (xs: number[]): number | null =>
		xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null;
	return {
		games: stats.games,
		seatGames: stats.seatGames,
		samples: stats.samples,
		samplesPerSeatGame: +(stats.samples / Math.max(1, stats.seatGames)).toFixed(2),
		navSamples: stats.navSamples,
		combatSamples: stats.combatSamples,
		rewardSamples: stats.rewardSamples,
		routePasses: stats.routePasses,
		rewardPiSamples: stats.rewardPiSamples,
		avgVP: +(stats.sumVP / Math.max(1, stats.seatGames)).toFixed(2),
		avgStatus: +(stats.sumStatus / Math.max(1, stats.seatGames)).toFixed(2),
		avgRounds: +(stats.sumRounds / Math.max(1, stats.seatGames)).toFixed(1),
		farmableNavsPerSeatGame: +(stats.farmableNavs / Math.max(1, stats.seatGames)).toFixed(2),
		heuristicMissedFarmableNavPct: +(
			(100 * stats.heuristicMissedFarmableNavs) /
			Math.max(1, stats.farmableNavs)
		).toFixed(1),
		farmOpportunityVpPerSeatGame: +(stats.farmOpportunityVp / Math.max(1, stats.seatGames)).toFixed(2),
		coveredFarmOpportunityVpPerSeatGame: +(stats.coveredFarmOpportunityVp / Math.max(1, stats.seatGames)).toFixed(2),
		coveredFarmOpportunityVpPct: +(
			(100 * stats.coveredFarmOpportunityVp) /
			Math.max(1, stats.farmOpportunityVp)
		).toFixed(1),
		combatsPerSeatGame: +(stats.combats / Math.max(1, stats.seatGames)).toFixed(2),
		killsPerSeatGame: +(stats.kills / Math.max(1, stats.seatGames)).toFixed(2),
		rewardsPerSeatGame: +(stats.rewards / Math.max(1, stats.seatGames)).toFixed(2),
		rewardVpPerSeatGame: +(stats.rewardVp / Math.max(1, stats.seatGames)).toFixed(2),
		avgFirstFarmableRound: avg(stats.firstFarmableRounds),
		decisionTypes: Object.fromEntries(
			Object.entries(stats.decisionTypes).sort((a, b) => b[1] - a[1]).slice(0, 20)
		)
	};
}

describe('reachable clean farm curriculum data', () => {
	(RUN ? it : it.skip)(
		'writes legal-prefix teacher samples for clean Arcane Abyss farming',
		async () => {
			const dataDir = process.env.CLEANFARMCURRICULUM_DATA_DIR ?? mlPath('data_cleanfarm_curriculum');
			const cfg: CurriculumConfig = {
				games: parseInt(process.env.CLEANFARMCURRICULUM_GAMES ?? '2', 10),
				seatsN: parseInt(process.env.CLEANFARMCURRICULUM_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.CLEANFARMCURRICULUM_MAXROUNDS ?? '30', 10),
				killThreshold: parseFloat(process.env.CLEANFARMCURRICULUM_KILL_THRESHOLD ?? '0.5'),
				minScore: parseFloat(process.env.CLEANFARMCURRICULUM_MIN_SCORE ?? '0.03'),
				minOpportunityVp: parseFloat(process.env.CLEANFARMCURRICULUM_MIN_OPPORTUNITY_VP ?? '1'),
				maxStatusLevel: parseInt(process.env.CLEANFARMCURRICULUM_MAX_STATUS ?? '0', 10),
				targetTemperature: parseFloat(process.env.CLEANFARMCURRICULUM_TARGET_TEMP ?? '0.25'),
				dataDir,
				outFile: process.env.CLEANFARMCURRICULUM_OUT ?? `${dataDir}/cleanfarm_curriculum.jsonl`,
				summaryFile: process.env.CLEANFARMCURRICULUM_SUMMARY ?? `${dataDir}/summary.json`,
				profiles: parseProfiles(process.env.CLEANFARMCURRICULUM_PROFILES)
			};
			rmSync(cfg.dataDir, { recursive: true, force: true });
			mkdirSync(dirname(cfg.outFile), { recursive: true });
			const catalog = await loadOrSnapshotCatalog();
			const total = initStats();

			for (let g = 0; g < cfg.games; g++) {
				const seed = 41_000_000 + g;
				const result = runCurriculumGame(catalog, seed, cfg);
				appendSamples(cfg.outFile, result.samples, g + 1);
				addStats(total, result.stats);
			}

			const row = rowFromStats(total);
			mkdirSync(dirname(cfg.summaryFile), { recursive: true });
			writeFileSync(
				`${cfg.dataDir}/meta.json`,
				JSON.stringify(
					{
						obs_dim: OBS_DIM,
						act_dim: ACT_DIM,
						samples: total.samples,
						games: total.games,
						seatGames: total.seatGames,
						mode: 'reachable-cleanfarm-curriculum',
						config: {
							profiles: cfg.profiles,
							maxRounds: cfg.maxRounds,
							killThreshold: cfg.killThreshold,
							minScore: cfg.minScore,
							minOpportunityVp: cfg.minOpportunityVp,
							maxStatusLevel: cfg.maxStatusLevel,
							targetTemperature: cfg.targetTemperature
						},
						row
					},
					null,
					2
				)
			);
			writeFileSync(
				cfg.summaryFile,
				JSON.stringify(
					{
						mode: 'reachable-cleanfarm-curriculum',
						obs_dim: OBS_DIM,
						act_dim: ACT_DIM,
						outFile: cfg.outFile,
						config: {
							games: cfg.games,
							seatsN: cfg.seatsN,
							profiles: cfg.profiles,
							maxRounds: cfg.maxRounds,
							killThreshold: cfg.killThreshold,
							minScore: cfg.minScore,
							minOpportunityVp: cfg.minOpportunityVp,
							maxStatusLevel: cfg.maxStatusLevel,
							targetTemperature: cfg.targetTemperature
						},
						totalSamples: total.samples,
						totalSeatGames: total.seatGames,
						row
					},
					null,
					2
				)
			);
			/* eslint-disable no-console */
			console.log(
				`\n[cleanfarmcurriculum] games=${cfg.games} seats=${Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length)} profiles=${cfg.profiles.join(',')} samples=${total.samples}`
			);
			console.log(
				`[cleanfarmcurriculum] nav=${total.navSamples} combat=${total.combatSamples} reward=${total.rewardSamples} rewardPi=${total.rewardPiSamples} VP=${String(row.avgVP)} kills/g=${String(row.killsPerSeatGame)} covered=${String(row.coveredFarmOpportunityVpPct)}%`
			);
			console.log(`[cleanfarmcurriculum] DONE -> ${cfg.outFile}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
