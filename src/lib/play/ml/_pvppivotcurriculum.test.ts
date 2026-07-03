/**
 * PvP-pivot curriculum DATA GENERATION.
 *
 * This is intentionally narrower than broad `pvphunter` behavior cloning. It
 * records only route-critical decisions that create the player-attack line:
 *
 * - acquire Cursed Spirit / Sharpshooter pieces;
 * - intentionally navigate to Arcane Abyss to descend before the game is over;
 * - preserve cheap multi-life monster farm before the pivot;
 * - route to build locations while underpowered instead of over-triggering Abyss;
 * - take monster fights that continue the descent;
 * - once Fallen, leave Abyss for a Spirit World hunt location;
 * - when legal, initiate PvP instead of passing encounter.
 *
 * Opt in:
 *
 *   PVPPIVOTCURRICULUM=1 PVPPIVOTCURRICULUM_GAMES=8 \
 *     npx vitest run src/lib/play/ml/_pvppivotcurriculum.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { expectedAttack } from '../combat';
import {
	SEAT_COLORS,
	VP_TO_WIN,
	isEvilAlignment,
	type GameActor,
	type GameCommand,
	type NavigationDestination,
	type PlayCatalog,
	type PrivatePlayerState,
	type PublicGameState,
	type SeatColor
} from '../types';
import { legalActionsWithNext, commandMatches, type LegalAction } from './actions';
import { sampleAuxTargets } from './auxTargets';
import type { Sample } from './driver';
import { encodeAction, encodeObs, OBS_DIM, ACT_DIM } from './encode';
import { evaluateFarmValue } from './farmValue';
import { scoresToPolicyTarget } from './neuralBot';
import { appendSamples, loadOrSnapshotCatalog, mlPath } from './nodeIo';
import { BALANCED_SHAPING, buildPotential, vpOf } from './shaping';

const RUN = process.env.PVPPIVOTCURRICULUM === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;
const TARGET_CLASSES = ['Cursed Spirit', 'Sharpshooter'] as const;
const HUNT_DESTINATIONS: NavigationDestination[] = ['Floral Patch', 'Cyber City', 'Tidal Cove', 'Lantern Canyon'];

type TeacherKind =
	| 'pvp-class'
	| 'pvp-cheap-farm-nav'
	| 'pvp-build-nav'
	| 'pvp-descend-nav'
	| 'pvp-descend-combat'
	| 'pvp-farm-return-nav'
	| 'pvp-hunt-nav'
	| 'pvp-predictive-hunt-nav'
	| 'pvp-attack';

interface Config {
	games: number;
	seatsN: number;
	maxRounds: number;
	minDescendRound: number;
	pivotMinRound: number;
	pivotMinVp: number;
	pivotMonsterHp: number;
	preserveFarmVp: number;
	farmThreshold: number;
	predictiveHunt: boolean;
	contrastFarmReturn: boolean;
	cursedTarget: number;
	sharpshooterTarget: number;
	targetTemperature: number;
	policyWeight: number;
	dataDir: string;
	outFile: string;
	summaryFile: string;
	profiles: string[];
	recordProfile: string;
}

interface TeacherDecision {
	idx: number;
	kind: TeacherKind;
	score: number;
	record: boolean;
}

interface Stats {
	games: number;
	seatGames: number;
	samples: number;
	classSamples: number;
	cheapFarmNavSamples: number;
	buildNavSamples: number;
	descendNavSamples: number;
	descendCombatSamples: number;
	farmReturnNavSamples: number;
	huntNavSamples: number;
	predictiveHuntNavSamples: number;
	pvpAttackSamples: number;
	teacherActions: number;
	legalPvpWindows: number;
	pvpAttacks: number;
	pvpVp: number;
	sumVP: number;
	sumStatus: number;
	sumRounds: number;
	maxStatus: number;
	firstFallenRounds: number[];
	firstPvpRounds: number[];
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
	return (raw ?? 'pvphunter,medium,cultivator,survivor')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function initStats(): Stats {
	return {
		games: 0,
		seatGames: 0,
		samples: 0,
		classSamples: 0,
		cheapFarmNavSamples: 0,
		buildNavSamples: 0,
		descendNavSamples: 0,
		descendCombatSamples: 0,
		farmReturnNavSamples: 0,
		huntNavSamples: 0,
		predictiveHuntNavSamples: 0,
		pvpAttackSamples: 0,
		teacherActions: 0,
		legalPvpWindows: 0,
		pvpAttacks: 0,
		pvpVp: 0,
		sumVP: 0,
		sumStatus: 0,
		sumRounds: 0,
		maxStatus: 0,
		firstFallenRounds: [],
		firstPvpRounds: [],
		decisionTypes: {}
	};
}

function addStats(total: Stats, part: Stats): void {
	total.games += part.games;
	total.seatGames += part.seatGames;
	total.samples += part.samples;
	total.classSamples += part.classSamples;
	total.cheapFarmNavSamples += part.cheapFarmNavSamples;
	total.buildNavSamples += part.buildNavSamples;
	total.descendNavSamples += part.descendNavSamples;
	total.descendCombatSamples += part.descendCombatSamples;
	total.farmReturnNavSamples += part.farmReturnNavSamples;
	total.huntNavSamples += part.huntNavSamples;
	total.predictiveHuntNavSamples += part.predictiveHuntNavSamples;
	total.pvpAttackSamples += part.pvpAttackSamples;
	total.teacherActions += part.teacherActions;
	total.legalPvpWindows += part.legalPvpWindows;
	total.pvpAttacks += part.pvpAttacks;
	total.pvpVp += part.pvpVp;
	total.sumVP += part.sumVP;
	total.sumStatus += part.sumStatus;
	total.sumRounds += part.sumRounds;
	total.maxStatus = Math.max(total.maxStatus, part.maxStatus);
	total.firstFallenRounds.push(...part.firstFallenRounds);
	total.firstPvpRounds.push(...part.firstPvpRounds);
	for (const [k, v] of Object.entries(part.decisionTypes)) {
		total.decisionTypes[k] = (total.decisionTypes[k] ?? 0) + v;
	}
}

function countDecision(stats: Stats, kind: TeacherKind, cmd: GameCommand): void {
	stats.decisionTypes[`${kind}:${cmd.type}`] = (stats.decisionTypes[`${kind}:${cmd.type}`] ?? 0) + 1;
}

function classCounts(player: PrivatePlayerState | undefined): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const spirit of player?.spirits ?? []) {
		for (const [name, amount] of Object.entries(spirit.classes ?? {})) {
			counts[name] = (counts[name] ?? 0) + amount;
		}
	}
	return counts;
}

function targetNeedScore(counts: Record<string, number>, cfg: Config): number {
	const cursedNeed = Math.max(0, cfg.cursedTarget - (counts['Cursed Spirit'] ?? 0));
	const sharpshooterNeed = Math.max(0, cfg.sharpshooterTarget - (counts.Sharpshooter ?? 0));
	return cursedNeed * 1.2 + sharpshooterNeed;
}

function classGainScore(before: PrivatePlayerState | undefined, after: PrivatePlayerState | undefined, cfg: Config): number {
	const beforeCounts = classCounts(before);
	const afterCounts = classCounts(after);
	let score = 0;
	for (const name of TARGET_CLASSES) {
		const target = name === 'Cursed Spirit' ? cfg.cursedTarget : cfg.sharpshooterTarget;
		const b = beforeCounts[name] ?? 0;
		const a = afterCounts[name] ?? 0;
		if (b >= target || a <= b) continue;
		score += Math.min(target, a) - b;
	}
	return score;
}

function legalIndex(withNext: LegalAction[], cmd: GameCommand): number {
	return withNext.findIndex((x) => commandMatches(x.cmd, cmd));
}

function isAtAbyss(state: PublicGameState, seat: SeatColor): boolean {
	return state.players[seat]?.navigationDestination === 'Arcane Abyss';
}

function monsterHp(state: PublicGameState): number {
	return state.monster ? state.monster.maxHp ?? state.monster.hp ?? 0 : 0;
}

function farmStillGood(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.farmThreshold });
	return farm.valid && farm.farmable && farm.opportunityVp >= cfg.preserveFarmVp;
}

function hasPvpCoreSeed(player: PrivatePlayerState | undefined, cfg: Config): boolean {
	if (!player) return false;
	const counts = classCounts(player);
	const cursed = counts['Cursed Spirit'] ?? 0;
	const sharp = counts.Sharpshooter ?? 0;
	return cursed >= 1 || sharp >= 1 || player.spirits.length >= Math.min(5, cfg.cursedTarget + cfg.sharpshooterTarget + 1);
}

function damageReadyForMonsterPivot(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): boolean {
	const player = state.players[seat];
	const hp = monsterHp(state);
	if (!player || hp <= 0) return false;
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	return firepowerProb >= cfg.farmThreshold || expectedAttack(player) >= Math.max(1, hp - 0.5);
}

function readyToDescend(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): boolean {
	const player = state.players[seat];
	if (!player || (player.statusLevel ?? 0) >= 3 || state.round < cfg.minDescendRound) return false;
	const counts = classCounts(player);
	const hasCore = hasPvpCoreSeed(player, cfg);
	const stillNeedsPvp = targetNeedScore(counts, cfg) > 0;
	const vp = player.victoryPoints ?? 0;
	if (!hasCore || vp >= VP_TO_WIN) return false;
	if (farmStillGood(state, seat, catalog, cfg) && vp < cfg.pivotMinVp) return false;
	const monsterIsHard = monsterHp(state) >= cfg.pivotMonsterHp;
	const routeIsLate = state.round >= cfg.pivotMinRound || vp >= cfg.pivotMinVp || monsterIsHard;
	return routeIsLate && (state.round >= 10 || !stillNeedsPvp || damageReadyForMonsterPivot(state, seat, catalog, cfg));
}

function chooseClassGain(state: PublicGameState, seat: SeatColor, withNext: LegalAction[], cfg: Config): TeacherDecision | null {
	const before = state.players[seat];
	if (!before || (before.statusLevel ?? 0) >= 3) return null;
	if (targetNeedScore(classCounts(before), cfg) <= 0) return null;

	let bestIdx = -1;
	let bestScore = 0;
	for (let i = 0; i < withNext.length; i++) {
		const cmdType = withNext[i].cmd.type;
		if (
			cmdType !== 'takeSpirit' &&
			cmdType !== 'replaceSpirit' &&
			cmdType !== 'spawnHandSpirit' &&
			cmdType !== 'resolveLocationInteraction'
		) {
			continue;
		}
		const score = classGainScore(before, withNext[i].next.players[seat], cfg);
		if (score > bestScore) {
			bestIdx = i;
			bestScore = score;
		}
	}
	return bestIdx >= 0 ? { idx: bestIdx, kind: 'pvp-class', score: bestScore, record: true } : null;
}

function chooseNavDestination(withNext: LegalAction[], destinations: NavigationDestination[]): number {
	for (const destination of destinations) {
		const idx = legalIndex(withNext, { type: 'lockNavigation', destination });
		if (idx >= 0) return idx;
	}
	return -1;
}

function visibleHuntDestinations(state: PublicGameState, seat: SeatColor): NavigationDestination[] {
	const scored = state.activeSeats
		.filter((s) => s !== seat)
		.map((s) => state.players[s])
		.filter(
			(player): player is PrivatePlayerState =>
				!!player &&
				!!player.navigationDestination &&
				HUNT_DESTINATIONS.includes(player.navigationDestination as NavigationDestination) &&
				!isEvilAlignment(player.statusLevel ?? 0)
		)
		.map((player) => ({
			destination: player.navigationDestination as NavigationDestination,
			vp: player.victoryPoints ?? 0
		}))
		.sort((a, b) => b.vp - a.vp || HUNT_DESTINATIONS.indexOf(a.destination) - HUNT_DESTINATIONS.indexOf(b.destination));
	const destinations: NavigationDestination[] = [];
	for (const target of scored) {
		if (!destinations.includes(target.destination)) destinations.push(target.destination);
	}
	return destinations;
}

function predictedHuntDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): NavigationDestination[] {
	const scored = state.activeSeats
		.filter((s) => s !== seat)
		.map((targetSeat) => {
			const target = state.players[targetSeat];
			if (!target || isEvilAlignment(target.statusLevel ?? 0)) return null;
			const farm = evaluateFarmValue(state, targetSeat, catalog, { threshold: cfg.farmThreshold });
			if (farm.valid && farm.farmable && farm.opportunityVp >= cfg.preserveFarmVp && (target.victoryPoints ?? 0) < 28) {
				return null;
			}
			const destinations: NavigationDestination[] = [];
			const hp = monsterHp(state);
			const targetAttack = expectedAttack(target);
			const counts = classCounts(target);
			const survivalTarget = state.monster ? (state.monster.damage ?? 0) + 1 : 0;
			const barrier = target.barrier ?? 0;
			const maxBarrier = target.maxBarrier ?? 0;
			const attackDice = target.attackDice?.length ?? 0;

			if (survivalTarget > 0 && barrier < Math.min(maxBarrier, survivalTarget)) destinations.push('Floral Patch');
			if (barrier < maxBarrier - 1) destinations.push('Floral Patch');
			if (survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2) destinations.push('Lantern Canyon');
			if (attackDice < 2 || target.spirits.length < 5 || (hp > 0 && targetAttack < hp)) destinations.push('Tidal Cove');
			if ((target.mats ?? []).some((r) => r.hasRune && r.type === 'relic')) destinations.push('Cyber City');
			if (destinations.length === 0 && (target.victoryPoints ?? 0) >= cfg.pivotMinVp) destinations.push('Floral Patch');
			if (destinations.length === 0) return null;
			return {
				vp: target.victoryPoints ?? 0,
				destinations
			};
		})
		.filter((x): x is { vp: number; destinations: NavigationDestination[] } => !!x)
		.sort((a, b) => b.vp - a.vp);
	const destinations: NavigationDestination[] = [];
	for (const target of scored) {
		for (const destination of target.destinations) {
			if (!destinations.includes(destination)) destinations.push(destination);
		}
	}
	return destinations;
}

function shouldPredictiveHunt(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): boolean {
	const player = state.players[seat];
	if (!cfg.predictiveHunt || !player || (player.statusLevel ?? 0) < 3 || state.round < cfg.pivotMinRound) return false;
	const vp = player.victoryPoints ?? 0;
	if (vp >= VP_TO_WIN) return false;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.farmThreshold });
	const finishNeeded = Math.max(0, VP_TO_WIN - vp);
	const monsterCanFinish =
		farm.valid &&
		farm.rewardVp > 0 &&
		(clean >= cfg.farmThreshold || firepower >= cfg.farmThreshold) &&
		farm.rewardVp * Math.max(1, farm.livesRemaining) >= finishNeeded;
	if (monsterCanFinish) return false;
	if (vp < 24) return clean < 0.25 && firepower < 0.25 && monsterHp(state) >= cfg.pivotMonsterHp;
	if (vp < 27 && (clean >= cfg.farmThreshold * 0.7 || firepower >= cfg.farmThreshold * 0.7)) return false;
	return true;
}

function choosePvpFarmReturnNav(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	cfg: Config
): TeacherDecision | null {
	const player = state.players[seat];
	if (!cfg.contrastFarmReturn || !player || (player.statusLevel ?? 0) < 3 || state.round < cfg.pivotMinRound) {
		return null;
	}
	const vp = player.victoryPoints ?? 0;
	const finishNeeded = Math.max(0, VP_TO_WIN - vp);
	if (vp >= VP_TO_WIN || finishNeeded <= 3) return null;
	const hasHuntOption =
		visibleHuntDestinations(state, seat).length > 0 ||
		(cfg.predictiveHunt && predictedHuntDestinations(state, seat, catalog, cfg).length > 0);
	if (!hasHuntOption) return null;

	const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.farmThreshold });
	if (!farm.valid || farm.rewardVp <= 0 || farm.livesRemaining <= 0) return null;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const killProb = Math.max(clean, firepower * 0.85);
	const nextFarmEv = farm.rewardVp * killProb;
	const reliableFarm = clean >= cfg.farmThreshold || firepower >= cfg.farmThreshold;
	const lowRungBank =
		farm.rewardVp >= cfg.preserveFarmVp &&
		farm.livesRemaining >= 2 &&
		monsterHp(state) <= Math.max(cfg.pivotMonsterHp, 4) &&
		killProb >= 0.35;
	const usefulImmediateFarm = reliableFarm && nextFarmEv >= Math.max(1.1, cfg.preserveFarmVp * 0.55);
	const usefulFarmBank =
		farm.rewardVp * Math.max(1, farm.livesRemaining) >= Math.min(finishNeeded, 4) &&
		monsterHp(state) <= Math.max(cfg.pivotMonsterHp + 1, 5) &&
		killProb >= 0.25;
	const finishableByMonster =
		reliableFarm &&
		farm.rewardVp * Math.max(1, farm.livesRemaining) >= finishNeeded &&
		nextFarmEv >= 1.5;
	if (!lowRungBank && !usefulImmediateFarm && !usefulFarmBank && !finishableByMonster) return null;

	const idx = legalIndex(withNext, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	return idx >= 0 ? { idx, kind: 'pvp-farm-return-nav', score: 2.75, record: true } : null;
}

function chooseCheapFarmNav(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	cfg: Config
): TeacherDecision | null {
	const player = state.players[seat];
	if (!player || (player.statusLevel ?? 0) >= 3 || (player.victoryPoints ?? 0) >= cfg.pivotMinVp) return null;
	if (!farmStillGood(state, seat, catalog, cfg)) return null;
	const idx = legalIndex(withNext, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	return idx >= 0 ? { idx, kind: 'pvp-cheap-farm-nav', score: 3, record: true } : null;
}

function chooseBuildNav(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	cfg: Config
): TeacherDecision | null {
	const player = state.players[seat];
	if (!player || (player.statusLevel ?? 0) >= 3 || (player.victoryPoints ?? 0) >= VP_TO_WIN) return null;
	if (farmStillGood(state, seat, catalog, cfg) && (player.victoryPoints ?? 0) < cfg.pivotMinVp) return null;
	if (readyToDescend(state, seat, catalog, cfg)) return null;

	const hp = monsterHp(state);
	const damageReady = damageReadyForMonsterPivot(state, seat, catalog, cfg);
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const needsBarrier = !!state.monster && player.barrier <= state.monster.damage && player.maxBarrier > state.monster.damage;
	const needsCore = !hasPvpCoreSeed(player, cfg) || targetNeedScore(classCounts(player), cfg) > 0;
	const needsDamage = hp > 0 && !damageReady;
	const needsSafeFarm = hp > 0 && cleanProb < cfg.farmThreshold && player.maxBarrier <= (state.monster?.damage ?? 0);

	if (!needsBarrier && !needsCore && !needsDamage && !needsSafeFarm && state.round < cfg.pivotMinRound) return null;

	const priorities: NavigationDestination[] = [];
	if (needsBarrier || needsSafeFarm) priorities.push('Floral Patch', 'Lantern Canyon');
	if (needsCore) priorities.push('Tidal Cove', 'Lantern Canyon', 'Cyber City');
	if (needsDamage) priorities.push('Cyber City', 'Tidal Cove', 'Lantern Canyon');
	priorities.push('Lantern Canyon', 'Tidal Cove', 'Cyber City', 'Floral Patch');

	const deduped = priorities.filter((destination, index) => priorities.indexOf(destination) === index);
	const idx = chooseNavDestination(withNext, deduped);
	return idx >= 0 ? { idx, kind: 'pvp-build-nav', score: 2, record: true } : null;
}

function chooseTeacherDecision(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	catalog: PlayCatalog,
	cfg: Config
): TeacherDecision | null {
	const player = state.players[seat];
	if (!player) return null;

	if (state.phase === 'encounter') {
		const idx = legalIndex(withNext, { type: 'initiatePvp' });
		if (idx >= 0) return { idx, kind: 'pvp-attack', score: 3, record: true };
	}

	if (state.phase === 'navigation') {
		if ((player.statusLevel ?? 0) >= 3) {
			const farmReturn = choosePvpFarmReturnNav(state, seat, catalog, withNext, cfg);
			if (farmReturn) return farmReturn;
			for (const destination of visibleHuntDestinations(state, seat)) {
				const idx = legalIndex(withNext, { type: 'lockNavigation', destination });
				if (idx >= 0) return { idx, kind: 'pvp-hunt-nav', score: 3, record: true };
			}
			if (shouldPredictiveHunt(state, seat, catalog, cfg)) {
				const idx = chooseNavDestination(withNext, predictedHuntDestinations(state, seat, catalog, cfg));
				if (idx >= 0) return { idx, kind: 'pvp-predictive-hunt-nav', score: 2.5, record: true };
			}
		}
		const cheapFarm = chooseCheapFarmNav(state, seat, catalog, withNext, cfg);
		if (cheapFarm) return cheapFarm;
		if (readyToDescend(state, seat, catalog, cfg)) {
			const idx = legalIndex(withNext, { type: 'lockNavigation', destination: 'Arcane Abyss' });
			if (idx >= 0) return { idx, kind: 'pvp-descend-nav', score: 2, record: true };
		}
		const buildNav = chooseBuildNav(state, seat, catalog, withNext, cfg);
		if (buildNav) return buildNav;
	}

	const classGain = chooseClassGain(state, seat, withNext, cfg);
	if (classGain) return classGain;

	if (state.phase === 'location' && isAtAbyss(state, seat) && (player.statusLevel ?? 0) < 3) {
		const idx = legalIndex(withNext, { type: 'startCombat' });
		if (idx >= 0 && readyToDescend(state, seat, catalog, cfg)) {
			return { idx, kind: 'pvp-descend-combat', score: 2, record: true };
		}
	}

	return null;
}

function policyTarget(withNext: LegalAction[], decision: TeacherDecision, cfg: Config): number[] {
	const scores = withNext.map(() => 0);
	scores[decision.idx] = decision.score;
	return scoresToPolicyTarget(scores, cfg.targetTemperature);
}

function localReturnTarget(state: PublicGameState, seat: SeatColor, chosen: LegalAction, decision: TeacherDecision): number {
	const beforeVp = state.players[seat]?.victoryPoints ?? 0;
	const afterVp = chosen.next.players[seat]?.victoryPoints ?? beforeVp;
	const bonus =
		decision.kind === 'pvp-attack' ? 6 :
		decision.kind === 'pvp-hunt-nav' ? 4 :
		decision.kind === 'pvp-predictive-hunt-nav' ? 3 :
		decision.kind === 'pvp-farm-return-nav' ? 3 :
		decision.kind === 'pvp-cheap-farm-nav' ? 3 :
		decision.kind === 'pvp-descend-nav' || decision.kind === 'pvp-descend-combat' ? 2 :
		decision.kind === 'pvp-build-nav' ? 2 :
		1;
	return clamp01((Math.max(beforeVp, afterVp) + bonus) / VP_TO_WIN);
}

function routeModeTarget(decision: TeacherDecision): number | undefined {
	if (decision.kind === 'pvp-hunt-nav' || decision.kind === 'pvp-predictive-hunt-nav') return 1;
	if (decision.kind === 'pvp-farm-return-nav') return 0;
	return undefined;
}

function recordSample(
	samples: Sample[],
	stats: Stats,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	decision: TeacherDecision,
	cfg: Config
): void {
	if (!decision.record || withNext.length <= 1) return;
	const chosen = withNext[decision.idx];
	const routeMode = routeModeTarget(decision);
	samples.push({
		obs: encodeObs(state, seat, catalog),
		cands: withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
		chosen: decision.idx,
		pi: policyTarget(withNext, decision, cfg),
		ret: localReturnTarget(state, seat, chosen, decision),
		seat,
		vp: vpOf(state.players[seat]),
		phi: buildPotential(state.players[seat], BALANCED_SHAPING),
			kill: chosen.cmd.type === 'resolveMonsterReward' ? 1 : 0,
			policyWeight: cfg.policyWeight,
			teacherKind: decision.kind,
			...(typeof routeMode === 'number' ? { routeMode } : {}),
			...sampleAuxTargets(state, seat, catalog, withNext)
		});
	stats.samples++;
	if (decision.kind === 'pvp-class') stats.classSamples++;
	if (decision.kind === 'pvp-cheap-farm-nav') stats.cheapFarmNavSamples++;
	if (decision.kind === 'pvp-build-nav') stats.buildNavSamples++;
	if (decision.kind === 'pvp-descend-nav') stats.descendNavSamples++;
	if (decision.kind === 'pvp-descend-combat') stats.descendCombatSamples++;
	if (decision.kind === 'pvp-farm-return-nav') stats.farmReturnNavSamples++;
	if (decision.kind === 'pvp-hunt-nav') stats.huntNavSamples++;
	if (decision.kind === 'pvp-predictive-hunt-nav') stats.predictiveHuntNavSamples++;
	if (decision.kind === 'pvp-attack') stats.pvpAttackSamples++;
}

function setupGame(catalog: PlayCatalog, seed: number, cfg: Config): { state: PublicGameState; seats: SeatColor[] } {
	const n = Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'PVPC', guardianNames });
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

function runCurriculumGame(catalog: PlayCatalog, seed: number, cfg: Config): { stats: Stats; samples: Sample[] } {
	const setup = setupGame(catalog, seed, cfg);
	let state = setup.state;
	const seats = setup.seats;
	const stats = initStats();
	stats.games = 1;
	const samples: Sample[] = [];
	const rng = seededBotRandom(seed ^ 0x7057c0de);
	const profileNames = Object.fromEntries(seats.map((seat, i) => [seat, cfg.profiles[i % cfg.profiles.length]]));
	const profiles: Record<string, BotProfile> = Object.fromEntries(
		seats.map((seat) => [seat, profileFor(profileNames[seat])])
	);
	const recordSeats = new Set(seats.filter((seat) => profileNames[seat] === cfg.recordProfile));
	const actionCounter = new Map<string, number>();
	const firstFallenRound: Record<string, number | null> = Object.fromEntries(seats.map((seat) => [seat, null]));
	const firstPvpRound: Record<string, number | null> = Object.fromEntries(seats.map((seat) => [seat, null]));

	let ticks = 0;
	while (state.status === 'active' && state.round <= cfg.maxRounds && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const beforeVp = state.players[seat]?.victoryPoints ?? 0;
			const key = `${seat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			const withNext = legalActionsWithNext(state, seat, catalog);
			if (withNext.length === 0) continue;
			if (recordSeats.has(seat) && state.phase === 'encounter' && legalIndex(withNext, { type: 'initiatePvp' }) >= 0) {
				stats.legalPvpWindows++;
			}

			const teacher = recordSeats.has(seat) ? chooseTeacherDecision(state, seat, withNext, catalog, cfg) : null;
			if (teacher) {
				const chosen = withNext[teacher.idx];
				recordSample(samples, stats, state, seat, catalog, withNext, teacher, cfg);
				countDecision(stats, teacher.kind, chosen.cmd);
				stats.teacherActions++;
				state = chosen.next;
				if (chosen.cmd.type === 'initiatePvp') {
					stats.pvpAttacks++;
					stats.pvpVp += Math.max(0, (state.players[seat]?.victoryPoints ?? 0) - beforeVp);
					if (firstPvpRound[seat] === null) firstPvpRound[seat] = state.round;
				}
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
		for (const seat of seats) {
			const p = state.players[seat];
			if (p && p.statusLevel >= 3 && firstFallenRound[seat] === null) firstFallenRound[seat] = state.round;
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
		stats.maxStatus = Math.max(stats.maxStatus, player.statusLevel ?? 0);
		const fallenRound = firstFallenRound[seat];
		if (fallenRound !== null) stats.firstFallenRounds.push(fallenRound);
		const pvpRound = firstPvpRound[seat];
		if (pvpRound !== null) stats.firstPvpRounds.push(pvpRound);
	}
	for (const sample of samples) {
		sample.ret = Math.max(sample.ret, clamp01((finalVP[sample.seat] ?? 0) / VP_TO_WIN));
	}
	return { stats, samples };
}

function rowFromStats(stats: Stats): Record<string, unknown> {
	const avg = (xs: number[]): number | null =>
		xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null;
	return {
		games: stats.games,
		seatGames: stats.seatGames,
		samples: stats.samples,
		samplesPerSeatGame: +(stats.samples / Math.max(1, stats.seatGames)).toFixed(2),
		classSamples: stats.classSamples,
		cheapFarmNavSamples: stats.cheapFarmNavSamples,
		buildNavSamples: stats.buildNavSamples,
		descendNavSamples: stats.descendNavSamples,
		descendCombatSamples: stats.descendCombatSamples,
		farmReturnNavSamples: stats.farmReturnNavSamples,
		huntNavSamples: stats.huntNavSamples,
		predictiveHuntNavSamples: stats.predictiveHuntNavSamples,
		pvpAttackSamples: stats.pvpAttackSamples,
		teacherActionsPerSeatGame: +(stats.teacherActions / Math.max(1, stats.seatGames)).toFixed(2),
		legalPvpWindowsPerSeatGame: +(stats.legalPvpWindows / Math.max(1, stats.seatGames)).toFixed(2),
		pvpAttacksPerSeatGame: +(stats.pvpAttacks / Math.max(1, stats.seatGames)).toFixed(2),
		pvpVpPerSeatGame: +(stats.pvpVp / Math.max(1, stats.seatGames)).toFixed(2),
		avgVP: +(stats.sumVP / Math.max(1, stats.seatGames)).toFixed(2),
		avgStatus: +(stats.sumStatus / Math.max(1, stats.seatGames)).toFixed(2),
		maxStatus: stats.maxStatus,
		avgRounds: +(stats.sumRounds / Math.max(1, stats.seatGames)).toFixed(1),
		avgFirstFallenRound: avg(stats.firstFallenRounds),
		avgFirstPvpRound: avg(stats.firstPvpRounds),
		decisionTypes: Object.fromEntries(
			Object.entries(stats.decisionTypes).sort((a, b) => b[1] - a[1]).slice(0, 24)
		)
	};
}

describe('pvp pivot curriculum data', () => {
	(RUN ? it : it.skip)(
		'writes focused teacher samples for early PvP setup and hunt conversion',
		async () => {
			const dataDir = process.env.PVPPIVOTCURRICULUM_DATA_DIR ?? mlPath('data_pvp_pivot_curriculum');
			const cfg: Config = {
				games: parseInt(process.env.PVPPIVOTCURRICULUM_GAMES ?? '4', 10),
				seatsN: parseInt(process.env.PVPPIVOTCURRICULUM_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.PVPPIVOTCURRICULUM_MAXROUNDS ?? '30', 10),
				minDescendRound: parseInt(process.env.PVPPIVOTCURRICULUM_MIN_DESCEND_ROUND ?? '6', 10),
				pivotMinRound: parseInt(process.env.PVPPIVOTCURRICULUM_PIVOT_MIN_ROUND ?? '10', 10),
				pivotMinVp: parseInt(process.env.PVPPIVOTCURRICULUM_PIVOT_MIN_VP ?? '18', 10),
				pivotMonsterHp: parseInt(process.env.PVPPIVOTCURRICULUM_PIVOT_MONSTER_HP ?? '4', 10),
				preserveFarmVp: parseFloat(process.env.PVPPIVOTCURRICULUM_PRESERVE_FARM_VP ?? '2'),
				farmThreshold: parseFloat(process.env.PVPPIVOTCURRICULUM_FARM_THRESHOLD ?? '0.5'),
				predictiveHunt: (process.env.PVPPIVOTCURRICULUM_PREDICTIVE_HUNT ?? '0') === '1',
				contrastFarmReturn: (process.env.PVPPIVOTCURRICULUM_CONTRAST_FARM_RETURN ?? '0') === '1',
				cursedTarget: parseInt(process.env.PVPPIVOTCURRICULUM_CURSED_TARGET ?? '2', 10),
				sharpshooterTarget: parseInt(process.env.PVPPIVOTCURRICULUM_SHARPSHOOTER_TARGET ?? '2', 10),
				targetTemperature: parseFloat(process.env.PVPPIVOTCURRICULUM_TARGET_TEMP ?? '0.25'),
				policyWeight: parseFloat(process.env.PVPPIVOTCURRICULUM_POLICY_WEIGHT ?? '4'),
				dataDir,
				outFile: process.env.PVPPIVOTCURRICULUM_OUT ?? `${dataDir}/pvp_pivot_curriculum.jsonl`,
				summaryFile: process.env.PVPPIVOTCURRICULUM_SUMMARY ?? `${dataDir}/summary.json`,
				profiles: parseProfiles(process.env.PVPPIVOTCURRICULUM_PROFILES),
				recordProfile: process.env.PVPPIVOTCURRICULUM_RECORD_PROFILE ?? 'pvphunter'
			};
			rmSync(cfg.dataDir, { recursive: true, force: true });
			mkdirSync(dirname(cfg.outFile), { recursive: true });
			const catalog = await loadOrSnapshotCatalog();
			const total = initStats();

			for (let g = 0; g < cfg.games; g++) {
				const result = runCurriculumGame(catalog, 71_000_000 + g, cfg);
				appendSamples(cfg.outFile, result.samples, g + 1);
				addStats(total, result.stats);
			}

			const row = rowFromStats(total);
			const meta = {
				obs_dim: OBS_DIM,
				act_dim: ACT_DIM,
				samples: total.samples,
				games: total.games,
				seatGames: total.seatGames,
				mode: 'pvp-pivot-curriculum',
				config: {
					profiles: cfg.profiles,
					recordProfile: cfg.recordProfile,
					maxRounds: cfg.maxRounds,
					minDescendRound: cfg.minDescendRound,
					pivotMinRound: cfg.pivotMinRound,
					pivotMinVp: cfg.pivotMinVp,
					pivotMonsterHp: cfg.pivotMonsterHp,
					preserveFarmVp: cfg.preserveFarmVp,
					farmThreshold: cfg.farmThreshold,
					predictiveHunt: cfg.predictiveHunt,
					contrastFarmReturn: cfg.contrastFarmReturn,
					cursedTarget: cfg.cursedTarget,
					sharpshooterTarget: cfg.sharpshooterTarget,
					targetTemperature: cfg.targetTemperature,
					policyWeight: cfg.policyWeight
				},
				row
			};
			mkdirSync(dirname(cfg.summaryFile), { recursive: true });
			writeFileSync(`${cfg.dataDir}/meta.json`, JSON.stringify(meta, null, 2));
			writeFileSync(
				cfg.summaryFile,
				JSON.stringify(
					{
						mode: 'pvp-pivot-curriculum',
						obs_dim: OBS_DIM,
						act_dim: ACT_DIM,
						outFile: cfg.outFile,
						config: meta.config,
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
				`\n[pvppivotcurriculum] games=${cfg.games} profiles=${cfg.profiles.join(',')} ` +
					`samples=${total.samples} class=${total.classSamples} farmNav=${total.cheapFarmNavSamples} ` +
					`buildNav=${total.buildNavSamples} descendNav=${total.descendNavSamples} ` +
					`descendCombat=${total.descendCombatSamples} farmReturn=${total.farmReturnNavSamples} hunt=${total.huntNavSamples} ` +
					`predictiveHunt=${total.predictiveHuntNavSamples} pvp=${total.pvpAttackSamples}`
			);
			console.log(
				`[pvppivotcurriculum] VP=${String(row.avgVP)} status=${String(row.avgStatus)} ` +
					`legalPvp/g=${String(row.legalPvpWindowsPerSeatGame)} pvpVp/g=${String(row.pvpVpPerSeatGame)}`
			);
			console.log(`[pvppivotcurriculum] DONE -> ${cfg.outFile}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
