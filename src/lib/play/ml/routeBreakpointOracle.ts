import { expectedAttack } from '../combat';
import { awakenedClassCounts } from '../effects/apply';
import { computeKillProbability, firepowerKillProbability } from '../server/botPolicy';
import { type PlayCatalog, type PublicGameState, type SeatColor } from '../types';
import { policyPreviewState, type LegalAction } from './actions';
import { combatActionExpectation } from './encode';

export interface RouteBreakpointOracleOptions {
	cleanThreshold?: number;
	firepowerThreshold?: number;
}

function monsterHp(state: PublicGameState): number {
	return state.monster?.maxHp ?? state.monster?.hp ?? 0;
}

function routeBreakpointStateScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	opts: RouteBreakpointOracleOptions
): number {
	const player = state.players[seat];
	if (!player) return -1_000_000;
	const cleanThreshold = opts.cleanThreshold ?? 0.5;
	const firepowerThreshold = opts.firepowerThreshold ?? cleanThreshold;
	const counts = awakenedClassCounts(player);
	const attack = expectedAttack(player);
	const attackDice = player.attackDice?.length ?? 0;
	const spiritAnimal = counts['Spirit Animal'] ?? 0;
	const cultivator = counts.Cultivator ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const currentBarrier = player.barrier ?? 0;
	const status = player.statusLevel ?? 0;
	const vp = player.victoryPoints ?? 0;
	const hp = monsterHp(state);
	const damage = state.monster?.damage ?? 0;
	const cleanProb = state.monster
		? computeKillProbability(state, seat, catalog, { allowCorruptKill: false })
		: 0;
	const firepowerProb = state.monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const survivalTarget = damage + 1;
	const damageGap = hp > 0 ? Math.max(0, hp + 0.5 - attack) : 0;
	const maxBarrierGap = survivalTarget > 0 ? Math.max(0, survivalTarget - maxBarrier) : 0;
	const currentBarrierGap = survivalTarget > 0 ? Math.max(0, survivalTarget - currentBarrier) : 0;
	const damageReady = firepowerProb >= firepowerThreshold || (hp > 0 && attack >= hp - 0.01);
	const cleanReady = cleanProb >= cleanThreshold;
	const currentSurvivalReady = survivalTarget <= 0 || currentBarrier >= survivalTarget;
	const maxSurvivalReady = survivalTarget <= 0 || maxBarrier >= survivalTarget;

	return (
		vp * 120 +
		cleanProb * 45 +
		firepowerProb * 28 +
		(cleanReady ? 80 : 0) +
		(damageReady ? 32 : 0) +
		(damageReady && maxSurvivalReady ? 28 : 0) +
		(damageReady && currentSurvivalReady ? 40 : 0) +
		attack * 7 +
		attackDice * 9 +
		spiritAnimal * 6 +
		cultivator * 4 +
		maxBarrier * 2.5 +
		currentBarrier * 1.2 -
		status * 300 -
		damageGap * 18 -
		maxBarrierGap * 14 -
		currentBarrierGap * 8
	);
}

function commandProgressBonus(
	state: PublicGameState,
	seat: SeatColor,
	action: LegalAction,
	catalog: PlayCatalog,
	opts: RouteBreakpointOracleOptions
): number {
	const before = state.players[seat];
	const preview = policyPreviewState(action);
	const after = preview.players[seat];
	const vpDelta = (after?.victoryPoints ?? 0) - (before?.victoryPoints ?? 0);
	let score = vpDelta * 180;
	switch (action.cmd.type) {
		case 'startCombat': {
			const expected = combatActionExpectation(state, seat, catalog);
			score += expected.killProbability * 190 - 30 + expected.expectedRewardVp * 20;
			break;
		}
		case 'resolveMonsterReward':
			score += 140;
			break;
		case 'lockNavigation': {
			const hp = monsterHp(state);
			const cleanProb = state.monster
				? computeKillProbability(state, seat, catalog, { allowCorruptKill: false })
				: 0;
			const firepowerProb = state.monster ? firepowerKillProbability(state, seat, catalog) : 0;
			const player = state.players[seat];
			const attack = player ? expectedAttack(player) : 0;
			const needsDamage =
				hp > 0 && (firepowerProb < (opts.firepowerThreshold ?? 0.5) || attack < hp + 0.5);
			const needsRestore =
				!!player &&
				!!state.monster &&
				((player.barrier ?? 0) <
					Math.min(player.maxBarrier ?? 0, (state.monster.damage ?? 0) + 1) ||
					(player.maxBarrier ?? 0) < (state.monster.damage ?? 0) + 1);
			const destination = action.cmd.destination;
			if (
				destination === 'Arcane Abyss' &&
				(cleanProb >= (opts.cleanThreshold ?? 0.5) ||
					firepowerProb >= (opts.firepowerThreshold ?? 0.5))
			)
				score += 70;
			if (needsDamage && (destination === 'Cyber City' || destination === 'Tidal Cove'))
				score += 35;
			if (needsRestore && (destination === 'Lantern Canyon' || destination === 'Floral Patch'))
				score += 35;
			if (!needsDamage && !needsRestore && destination === 'Arcane Abyss') score += 20;
			break;
		}
		case 'resolveLocationInteraction':
			score += 24;
			break;
		case 'spawnHandSpirit':
			score += 18;
			break;
		case 'commitAwakening':
		case 'commitBenefits':
		case 'commitCleanup':
		case 'resolveDecision':
		case 'endLocationActions':
			score += 8;
			break;
		default:
			score += 1;
			break;
	}
	return score;
}

export function routeBreakpointActionScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction,
	opts: RouteBreakpointOracleOptions = {}
): number {
	return (
		routeBreakpointStateScore(policyPreviewState(action), seat, catalog, opts) +
		commandProgressBonus(state, seat, action, catalog, opts)
	);
}

export function chooseRouteBreakpointOracleAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	opts: RouteBreakpointOracleOptions = {}
): LegalAction | null {
	let best: LegalAction | null = null;
	let bestScore = -Infinity;
	for (const action of withNext) {
		const score = routeBreakpointActionScore(state, seat, catalog, action, opts);
		if (score > bestScore) {
			best = action;
			bestScore = score;
		}
	}
	return best;
}

function monsterKillDelta(before: PublicGameState, after: PublicGameState): number {
	const beforeLives = before.monster?.livesRemaining ?? 0;
	const afterLives = after.monster?.livesRemaining ?? beforeLives;
	return Math.max(0, beforeLives - afterLives);
}

export function routeFinishLoopActionScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction,
	opts: RouteBreakpointOracleOptions = {}
): number {
	const before = state.players[seat];
	const preview = policyPreviewState(action);
	const after = preview.players[seat];
	if (!before || !after) return -1_000_000;
	const beforeStatus = before.statusLevel ?? 0;
	const afterStatus = after.statusLevel ?? 0;
	if (afterStatus > beforeStatus) return -250_000 - (afterStatus - beforeStatus) * 10_000;

	const cleanThreshold = opts.cleanThreshold ?? 0.5;
	const firepowerThreshold = opts.firepowerThreshold ?? cleanThreshold;
	const beforeVp = before.victoryPoints ?? 0;
	const afterVp = after.victoryPoints ?? 0;
	const vpDelta = afterVp - beforeVp;
	const hp = monsterHp(state);
	const monsterDamage = state.monster?.damage ?? 0;
	const survivalTarget = monsterDamage + 1;
	const beforeMaxBarrier = before.maxBarrier ?? 0;
	const afterMaxBarrier = after.maxBarrier ?? 0;
	const beforeAttack = expectedAttack(before);
	const afterAttack = expectedAttack(after);
	const beforeBarrier = before.barrier ?? 0;
	const afterBarrier = after.barrier ?? 0;
	const beforeClean = state.monster
		? computeKillProbability(state, seat, catalog, { allowCorruptKill: false })
		: 0;
	const beforeFirepower = state.monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const afterClean = preview.monster
		? computeKillProbability(preview, seat, catalog, { allowCorruptKill: false })
		: beforeClean;
	const afterFirepower = preview.monster
		? firepowerKillProbability(preview, seat, catalog)
		: beforeFirepower;
	const beforeSurvivalReady = survivalTarget <= 0 || beforeBarrier >= survivalTarget;
	const afterSurvivalReady = survivalTarget <= 0 || afterBarrier >= survivalTarget;
	const beforeFirepowerReady =
		beforeClean >= cleanThreshold ||
		beforeFirepower >= firepowerThreshold ||
		beforeAttack >= hp - 0.01;
	const afterFirepowerReady =
		afterClean >= cleanThreshold ||
		afterFirepower >= firepowerThreshold ||
		afterAttack >= hp - 0.01;
	const combatExpected =
		action.cmd.type === 'startCombat' ? combatActionExpectation(state, seat, catalog) : null;
	const livesDelta = combatExpected?.killProbability ?? monsterKillDelta(state, preview);
	const barrierTarget = survivalTarget > 0 ? survivalTarget : beforeMaxBarrier;

	let score = afterVp * 600 + vpDelta * 4000;
	if (afterVp >= 30) score += 60_000;
	if (beforeVp < 30 && afterVp >= 30) score += 40_000;
	score += livesDelta * 2500;
	score += Math.min(afterBarrier, Math.max(0, barrierTarget)) * 260;
	score += (afterBarrier - beforeBarrier) * 450;
	score += (afterMaxBarrier - beforeMaxBarrier) * 220;
	score += (afterAttack - beforeAttack) * 500;
	score += afterClean * 450 + afterFirepower * 320;
	if (!beforeSurvivalReady && afterSurvivalReady) score += 1800;
	if (!beforeFirepowerReady && afterFirepowerReady) score += 1200;
	if (afterSurvivalReady && afterFirepowerReady) score += 1400;

	switch (action.cmd.type) {
		case 'resolveMonsterReward':
			score += 8000 + Math.max(0, vpDelta) * 8000;
			break;
		case 'startCombat':
			score += (combatExpected?.killProbability ?? 0) * 11_500 - 2_500;
			score += (combatExpected?.expectedRewardVp ?? 0) * 2_500;
			break;
		case 'resolveLocationInteraction':
			score += 700;
			if (afterBarrier > beforeBarrier) score += 1200;
			break;
		case 'endLocationActions':
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
		case 'resolveDecision':
			score += 120;
			break;
		default:
			break;
	}

	if (
		beforeSurvivalReady &&
		beforeFirepowerReady &&
		action.cmd.type !== 'startCombat' &&
		action.cmd.type !== 'resolveMonsterReward'
	) {
		score -= 600;
	}

	return score;
}

export function chooseRouteFinishLoopOracleAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	opts: RouteBreakpointOracleOptions = {}
): LegalAction | null {
	let best: LegalAction | null = null;
	let bestScore = -Infinity;
	for (const action of withNext) {
		const score = routeFinishLoopActionScore(state, seat, catalog, action, opts);
		if (score > bestScore) {
			best = action;
			bestScore = score;
		}
	}
	return best;
}
