/**
 * ARCHIVED HAND-CRAFTED STRATEGY GATES — per BOT_TAKEOVER_PLAN.md these must NEVER be wired into
 * the trained agent's decision path; they exist only as benchmark opponents and exploiter seeds.
 *
 * Extracted verbatim from selfplay.ts: the goodBuilder / pvpPivot oracle families, the
 * discipline action-filter guards, overlay predicates, and the env-tunable thresholds they read.
 */

import { applyGameCommand } from '../../runtime';
import {
	botActorFor,
	computeKillProbability,
	firepowerKillProbability,
	legalDestinations
} from '../../server/botPolicy';
import { expectedAttack } from '../../combat';
import { awakenedClassCounts } from '../../effects/apply';
import {
	buildLocationInteractions,
	type GainEffect,
	type LocationInteraction
} from '../../locationInteractions';
import {
	VP_TO_WIN,
	isEvilAlignment,
	type GameCommand,
	type NavigationDestination,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../../types';
import { buildMonsterRewards } from '../../monsterRewards';
import { encodeObs } from '../encode';
import type { NeuralPolicy } from '../net';
import type { LegalAction } from '../actions';
import { evaluateFarmValue } from '../farmValue';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = parseInt(raw, 10);
	return Number.isFinite(value) ? value : fallback;
}

const GOOD_TARGET_HARD_FARM_PIVOT_VP = envNumber('ARC_GOOD_TARGET_HARD_FARM_PIVOT_VP', 21);
const GOOD_TARGET_DAMAGE_REBUILD_MIN_HP = envNumber(
	'ARC_GOOD_TARGET_DAMAGE_REBUILD_MIN_HP',
	Number.POSITIVE_INFINITY
);
const GOOD_TARGET_CONTROLLED_CORRUPT_FARM =
	(process.env.ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM ?? '0') === '1';
const GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP = envNumber(
	'ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP',
	Number.POSITIVE_INFINITY
);
const GOOD_TARGET_EXPOSE_AFTER_VP = envNumber(
	'ARC_GOOD_TARGET_EXPOSE_AFTER_VP',
	Number.POSITIVE_INFINITY
);
const GOOD_TARGET_EXPOSURE_GATE_MIN_VP = envNumber('ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_VP', 12);
const GOOD_TARGET_EXPOSURE_GATE_MAX_VP = envNumber('ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_VP', 28);
const GOOD_TARGET_EXPOSURE_GATE_MIN_ROUND = envNumber('ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_ROUND', 6);
const GOOD_TARGET_EXPOSURE_GATE_MIN_MONSTER_HP = envNumber('ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_MONSTER_HP', 4);
const GOOD_TARGET_EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP = envNumber(
	'ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP',
	Number.POSITIVE_INFINITY
);
const GOOD_TARGET_EXPOSURE_GATE_MAX_REMAINING_FARM_VP = envNumber(
	'ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_REMAINING_FARM_VP',
	Number.POSITIVE_INFINITY
);
const GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP = envNumber(
	'ARC_GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP',
	Number.POSITIVE_INFINITY
);
const GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP = envNumber(
	'ARC_GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP',
	30
);
const PVP_GOOD_TARGET_PIVOT_MIN_MONSTER_HP = envNumber('ARC_PVP_GOOD_TARGET_PIVOT_MIN_MONSTER_HP', 4);
const PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP = envNumber('ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP', 12);
const PVP_FORCE_HIGH_VALUE_TARGET_VP = envNumber('ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP', 18);
const PVP_REBUILD_SKIP_TARGET_VP = envNumber('ARC_PVP_REBUILD_SKIP_TARGET_VP', 12);
const PVP_REBUILD_MIN_ROUND = envNumber('ARC_PVP_REBUILD_MIN_ROUND', 14);
const PVP_STATUS2_DESCEND_MIN_TARGET_VP = envNumber('ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP', 9);
const PVP_LOW_TAIL_HUNT_MAX_VP = envNumber('ARC_PVP_LOW_TAIL_HUNT_MAX_VP', -1);
const PVP_LOW_TAIL_HUNT_MIN_ROUND = envNumber('ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND', 10);
const PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP = envNumber('ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP', 4);
const PVP_LOW_TAIL_HUNT_MIN_TARGET_VP = envNumber('ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP', 0);
export type PvpPivotOracle =
	| 'off'
	| 'fallen-hunt'
	| 'late-descend-hunt'
	| 'fallen-predictive-hunt'
	| 'late-descend-predictive-hunt'
	| 'status2-conversion-descend'
	| 'status2-target-descend';
export type MicroPolicyGate =
	| 'all'
	| 'abyss-round'
	| 'abyss-farm-actions'
	| 'abyss-reward-actions'
	| 'abyss-farm-overlay'
	| 'good-builder-oracle'
	| 'good-builder-farmer-oracle'
	| 'good-builder-support-oracle'
	| 'good-builder-hp4-oracle'
	| 'good-builder-hp4-pick-oracle'
	| 'good-builder-hp4-conversion-overlay'
	| 'good-builder-hp4-conversion-oracle'
	| 'good-builder-hp4-scorefloor-oracle'
	| 'good-builder-score-pick-oracle'
	| 'good-builder-score-conversion-oracle'
	| 'location-interactions'
	| 'route-closer-full'
	| 'route-closer-oracle'
	| 'route-finish-oracle'
	| 'pvp-pivot'
	| 'pvp-pivot-encounter-force'
	| 'pvp-high-value-encounter-force';
export type NavigationPolicyGate =
	| 'all'
	| 'unsafe-firepower'
	| 'unsafe-firepower-build-option'
	| 'midroute-scaling'
	| 'route-option-scaling'
	| 'clean-farm-q'
	| 'pure-farm-build'
	| 'good-nonfallen-farm-build'
	| 'good-nonfallen-farm-target-pivot'
	| 'good-nonfallen-farm-target-evade'
	| 'good-target-exposure'
	| 'good-target-rendezvous-exposure'
	| 'good-nonfallen-score-floor'
	| 'good-builder-oracle'
	| 'good-builder-farmer-oracle'
	| 'good-builder-support-oracle'
	| 'good-builder-noncontest-support-oracle'
	| 'hp2-survival-deficit'
	| 'hp4-first-wall'
	| 'route-closer'
	| 'route-finish-loop'
	| 'survival-rebuild'
	| 'pvp-pivot'
	| 'pvp-predictive-pivot'
	| 'pvp-predictive-mode-pivot'
	| 'pvp-predictive-mode-hunt-fallback-pivot'
	| 'pvp-predictive-mode-hunt-fallback-rebuild-pivot'
	| 'pvp-predictive-flex-pivot'
	| 'pvp-predictive-value-pivot'
	| 'pvp-predictive-finish-pivot'
	| 'pvp-good-target-value-pivot';
type FarmNavigationOracle = 'off' | 'force';
const FARM_ACTION_TYPES = new Set<GameCommand['type']>([
	'startCombat',
	'resolveMonsterReward',
	'spawnHandSpirit',
	'discardHandDraws',
	'redrawHandDraws'
]);
const REWARD_ACTION_TYPES = new Set<GameCommand['type']>([
	'resolveMonsterReward',
	'spawnHandSpirit',
	'discardHandDraws',
	'redrawHandDraws'
]);
const GOOD_BUILDER_HP4_PICK_ACTION_TYPES = new Set<GameCommand['type']>([
	'resolveLocationInteraction',
	'spawnHandSpirit',
	'takeSpirit',
	'replaceSpirit',
	'awakenSpirit',
	'manualAwaken',
	'resolveAwakenReward',
	'resolveDecision',
	'attachRuneToSpirit',
	'placeAugmentOnSpirit',
	'redrawHandDraws',
	'discardHandDraws'
]);
const GOOD_BUILDER_SCORE_PICK_ACTION_TYPES = GOOD_BUILDER_HP4_PICK_ACTION_TYPES;
const GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES = new Set<GameCommand['type']>([
	...GOOD_BUILDER_HP4_PICK_ACTION_TYPES,
	'startCombat',
	'resolveMonsterReward'
]);
const GOOD_BUILDER_HP4_SCOREFLOOR_ACTION_TYPES = GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES;
const GOOD_BUILDER_SCORE_CONVERSION_ACTION_TYPES = GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES;
const GOOD_BUILDER_HP4_CONVERSION_OVERLAY_MIN_VP = envNumber(
	'ARC_GOOD_BUILDER_HP4_CONVERSION_OVERLAY_MIN_VP',
	8
);
const GOOD_BUILDER_HP4_CONVERSION_OVERLAY_MIN_ROUND = envInt(
	'ARC_GOOD_BUILDER_HP4_CONVERSION_OVERLAY_MIN_ROUND',
	5
);
const GOOD_BUILDER_HP4_CONVERSION_OVERLAY_DESTINATIONS = new Set<NavigationDestination>([
	'Arcane Abyss',
	'Lantern Canyon',
	'Floral Patch'
]);


function routeHandDrawBuildScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): number {
	const player = state.players[seat];
	if (!player) return 0;
	const counts = awakenedClassCounts(player);
	const monster = state.monster;
	const monsterDamage = monster?.damage ?? 0;
	const survivalTarget = monsterDamage + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const survivalReady = survivalTarget <= 0 ? 1 : clamp01(barrier / survivalTarget);
	const maxSurvivalReady = survivalTarget <= 0 ? 1 : clamp01(maxBarrier / survivalTarget);
	const cleanProb = monster ? computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) : 0;
	const firepowerProb = monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const attack = expectedAttack(player);
	const attackTarget = Math.max(1, (monster?.maxHp ?? monster?.hp ?? 0) + 0.5);
	const attackReady = clamp01(attack / attackTarget);
	const nearFirepower = firepowerProb >= threshold ? 1 : firepowerProb;
	return (
		attackReady * 3 +
		nearFirepower * 3 +
		cleanProb * 4 +
		survivalReady * 1.25 +
		maxSurvivalReady * 1.25 +
		(counts['Spirit Animal'] ?? 0) * 0.5 +
		(counts.Cultivator ?? 0) * 0.6 +
		(player.attackDice?.length ?? 0) * 0.35
	);
}

function isCommittedCleanMonsterRoute(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	if (!player || !state.monster || isEvilAlignment(player.statusLevel ?? 0)) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
	if (vp >= 9 || monsterHp >= 4 || player.navigationDestination === 'Arcane Abyss') return true;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	return farm.valid && (farm.farmable || farm.opportunityVp > 0);
}

function preservesRouteHandDrawOpportunity(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction,
	withNext: LegalAction[],
	threshold: number
): boolean {
	if (action.cmd.type !== 'discardHandDraws') return true;
	const player = state.players[seat];
	if (!player || (player.handDraws?.length ?? 0) === 0) return true;
	if (!isCommittedCleanMonsterRoute(state, seat, catalog, threshold)) return true;
	const spawnAlternatives = withNext.filter((candidate) => candidate.cmd.type === 'spawnHandSpirit');
	if (spawnAlternatives.length === 0) return true;
	const currentScore = routeHandDrawBuildScore(state, seat, catalog, threshold);
	const discardScore = routeHandDrawBuildScore(action.next, seat, catalog, threshold);
	const bestSpawnScore = Math.max(
		...spawnAlternatives.map((candidate) => routeHandDrawBuildScore(candidate.next, seat, catalog, threshold))
	);
	return bestSpawnScore <= Math.max(currentScore, discardScore) + 0.05;
}

function preservesRouteFirepower(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction,
	threshold: number
): boolean {
	if (action.cmd.type === 'startCombat' || action.cmd.type === 'resolveMonsterReward') return true;
	if (!state.monster || !state.players[seat] || !action.next.players[seat]) return true;
	const currentFirepower = firepowerKillProbability(state, seat, catalog);
	if (currentFirepower < threshold) return true;
	const nextFirepower = firepowerKillProbability(action.next, seat, catalog);
	if (nextFirepower >= threshold) return true;
	const currentAttack = expectedAttack(state.players[seat]!);
	const nextAttack = expectedAttack(action.next.players[seat]!);
	return nextAttack >= currentAttack - 0.01;
}

const ROUTE_PROGRESS_ACTION_TYPES = new Set<GameCommand['type']>([
	'commitBenefits',
	'commitAwakening',
	'commitCleanup',
	'endLocationActions',
	'resolveDecision'
]);

const ROUTE_OPTIONAL_BUILD_SPEND_TYPES = new Set<GameCommand['type']>([
	'discardSpirit',
	'replaceSpirit',
	'resolveLocationInteraction'
]);

function preservesRouteSurvival(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction,
	firepowerThreshold: number
): boolean {
	const player = state.players[seat];
	const nextPlayer = action.next.players[seat];
	const monster = state.monster;
	if (!player || !nextPlayer || !monster) return true;
	if (action.cmd.type === 'startCombat' || action.cmd.type === 'resolveMonsterReward') return true;
	if (ROUTE_PROGRESS_ACTION_TYPES.has(action.cmd.type)) return true;
	if (!ROUTE_OPTIONAL_BUILD_SPEND_TYPES.has(action.cmd.type)) return true;
	if (isEvilAlignment(player.statusLevel ?? 0)) return true;

	const currentVp = player.victoryPoints ?? 0;
	const nextVp = nextPlayer.victoryPoints ?? 0;
	if (nextVp > currentVp) return true;
	if (abyssFarmPayoffScore(state, seat, action) > 0) return true;

	const currentCounts = awakenedClassCounts(player);
	const nextCounts = awakenedClassCounts(nextPlayer);
	const currentAttack = expectedAttack(player);
	const nextAttack = expectedAttack(nextPlayer);
	const currentFirepower = firepowerKillProbability(state, seat, catalog);
	const nextFirepower = firepowerKillProbability(action.next, seat, catalog);
	const currentMonsterHp = monster.maxHp ?? monster.hp ?? 0;
	const currentBarrierTarget = Math.min(player.maxBarrier ?? 0, (monster.damage ?? 0) + 1);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: firepowerThreshold });
	const farmReadyDamage = farm.valid && farm.farmable && farm.opportunityVp > 0;
	const earlyFarmDamage =
		currentVp >= 3 &&
		(
			currentAttack >= 2 ||
			(currentCounts['Spirit Animal'] ?? 0) >= 2 ||
			currentFirepower >= firepowerThreshold
		);
	const committedToRoute =
		currentVp >= 6 ||
		earlyFarmDamage ||
		farmReadyDamage ||
		player.navigationDestination === 'Arcane Abyss' ||
		currentMonsterHp >= 4;
	if (!committedToRoute) return true;

	if ((nextPlayer.maxBarrier ?? 0) < (player.maxBarrier ?? 0)) return false;
	if (
		(player.maxBarrier ?? 0) < 10 &&
		(currentCounts.Cultivator ?? 0) >= 2 &&
		(nextCounts.Cultivator ?? 0) < (currentCounts.Cultivator ?? 0)
	) {
		return false;
	}
	if (
		(currentCounts['Spirit Animal'] ?? 0) > 0 &&
		(nextCounts['Spirit Animal'] ?? 0) < (currentCounts['Spirit Animal'] ?? 0) &&
		nextAttack <= currentAttack + 0.1
	) {
		return false;
	}
	if (currentAttack < currentMonsterHp + 1 && nextAttack < currentAttack - 0.01) {
		return false;
	}
	if (
		currentFirepower >= firepowerThreshold &&
		nextFirepower < currentFirepower - 0.01 &&
		nextFirepower < firepowerThreshold
	) {
		return false;
	}
	if (
		(player.barrier ?? 0) < currentBarrierTarget &&
		(nextPlayer.barrier ?? 0) < (player.barrier ?? 0) &&
		(nextPlayer.maxBarrier ?? 0) <= (player.maxBarrier ?? 0)
	) {
		return false;
	}

	return true;
}

function locationInteractionForAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction
): LocationInteraction | undefined {
	if (action.cmd.type !== 'resolveLocationInteraction') return undefined;
	const destination = state.players[seat]?.navigationDestination;
	if (!destination) return undefined;
	const rowIndex = (action.cmd as Extract<GameCommand, { type: 'resolveLocationInteraction' }>).rowIndex;
	return buildLocationInteractions((catalog.locations ?? []).find((loc) => loc.name === destination)?.rewardRows)
		.find((it) => it.rowIndex === rowIndex);
}

function interactionGrantsCursed(interaction: LocationInteraction | undefined): boolean {
	return !!interaction?.gains.some((gain) => (
		(gain.type === 'rune' && gain.rune.name === 'Cursed Spirit') ||
		(gain.type === 'chooseRune' && gain.options.some((option) => option.name === 'Cursed Spirit'))
	));
}

function interactionHasAction(interaction: LocationInteraction | undefined, action: string): boolean {
	return !!interaction?.gains.some((gain) => gain.type === 'action' && gain.action === action);
}

function runeClassName(rune: { classId?: string | null }, catalog: PlayCatalog): string | undefined {
	return rune.classId ? catalog.classes.find((entry) => entry.id === rune.classId)?.name : undefined;
}

function gainCanGrantClass(gain: GainEffect, catalog: PlayCatalog, className: string): boolean {
	if (gain.type === 'rune') return runeClassName(gain.rune, catalog) === className;
	if (gain.type === 'chooseRune') {
		return gain.options.some((option) => runeClassName(option, catalog) === className);
	}
	return false;
}

function interactionCanGrantClass(
	interaction: LocationInteraction | undefined,
	catalog: PlayCatalog,
	className: string
): boolean {
	return !!interaction?.gains.some((gain) => gainCanGrantClass(gain, catalog, className));
}

function interactionCostsRelic(interaction: LocationInteraction | undefined): boolean {
	return !!interaction?.cost.some((cost) => cost.match === 'anyRelic' || cost.match === 'specialRune');
}

function heldRelicCount(player: PublicGameState['players'][SeatColor] | undefined): number {
	return (player?.mats ?? []).filter((slot) => slot.hasRune && slot.type === 'relic').length;
}

function filterGoodTargetActionDisciplineActions(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	threshold: number
): LegalAction[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || isEvilAlignment(player.statusLevel ?? 0)) return withNext;
	const currentVp = player.victoryPoints ?? 0;
	const currentAttack = expectedAttack(player);
	const currentCounts = awakenedClassCounts(player);
	const currentFirepower = firepowerKillProbability(state, seat, catalog);
	const currentClean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const currentBarrier = player.barrier ?? 0;
	const currentMaxBarrier = player.maxBarrier ?? 0;
	const currentPendingAugments = pendingAugmentClassCounts(player, catalog);
	const currentCultivatorProgress = (currentCounts.Cultivator ?? 0) + (currentPendingAugments.Cultivator ?? 0);
	const needsSurvival =
		survivalTarget > 0 &&
		(currentMaxBarrier < survivalTarget || currentBarrier < Math.min(currentMaxBarrier, survivalTarget));
	const needsDamage =
		monsterHp > 0 &&
		currentAttack < monsterHp + 0.5 &&
		currentFirepower < threshold &&
		currentClean < threshold;
	const currentFarm = evaluateFarmValue(state, seat, catalog, { threshold });
	const committedHp4SurvivalRoute =
		currentFarm.valid &&
		currentFarm.rewardVp > 0 &&
		currentVp >= 3 &&
		monsterHp >= 4 &&
		monsterHp <= 5 &&
		needsSurvival;
	const needsCultivatorTicket = committedHp4SurvivalRoute && currentCultivatorProgress < 2;
	const filtered = withNext.filter((action) => {
		if (action.cmd.type !== 'resolveLocationInteraction') return true;
		const nextPlayer = action.next.players[seat];
		if (!nextPlayer) return true;
		const vpDelta = (nextPlayer.victoryPoints ?? 0) - currentVp;
		if (vpDelta > 0 || abyssFarmPayoffScore(state, seat, action) > 0) return true;

		const interaction = locationInteractionForAction(state, seat, catalog, action);
			if (!interaction) return true;
			if (interactionGrantsCursed(interaction)) return false;

			const nextAttack = expectedAttack(nextPlayer);
			const nextCounts = awakenedClassCounts(nextPlayer);
			const nextPendingAugments = pendingAugmentClassCounts(nextPlayer, catalog);
			const nextCultivatorProgress = (nextCounts.Cultivator ?? 0) + (nextPendingAugments.Cultivator ?? 0);
			const improvesCultivatorProgress = nextCultivatorProgress > currentCultivatorProgress;
			if (needsCultivatorTicket && interactionCostsRelic(interaction) && !improvesCultivatorProgress) {
				return false;
			}
			const nextFirepower = action.next.monster
				? firepowerKillProbability(action.next, seat, catalog)
				: currentFirepower;
		const nextClean = action.next.monster
			? computeKillProbability(action.next, seat, catalog, { allowCorruptKill: false })
			: currentClean;
		const nextFarm = action.next.monster
			? evaluateFarmValue(action.next, seat, catalog, { threshold })
			: currentFarm;
		const improvesDamage =
			nextAttack > currentAttack + 0.1 ||
			nextFirepower > currentFirepower + 0.05 ||
			nextClean > currentClean + 0.05 ||
			(nextCounts['Spirit Animal'] ?? 0) > (currentCounts['Spirit Animal'] ?? 0) ||
			(nextPlayer.attackDice?.length ?? 0) > (player.attackDice?.length ?? 0);
		const improvesSurvival =
			(nextPlayer.maxBarrier ?? 0) > currentMaxBarrier ||
			((nextPlayer.barrier ?? 0) > currentBarrier && needsSurvival);
		const improvesFarm =
			nextFarm.valid &&
			(
				(!currentFarm.valid && nextFarm.opportunityVp > 0) ||
				nextFarm.opportunityVp > (currentFarm.valid ? currentFarm.opportunityVp : 0) + 0.25 ||
				(!currentFarm.farmable && nextFarm.farmable)
			);

		if (interactionHasAction(interaction, 'rest')) {
			return improvesSurvival && needsSurvival;
		}
			if (interactionHasAction(interaction, 'cultivate')) {
				return improvesSurvival && (needsSurvival || (currentCounts.Cultivator ?? 0) >= 2);
			}
			if (needsCultivatorTicket && interactionCanGrantClass(interaction, catalog, 'Cultivator')) {
				return improvesCultivatorProgress;
			}
			if (interactionHasAction(interaction, 'spiritWorldSummon') || interactionHasAction(interaction, 'abyssSummon')) {
				return needsDamage || improvesDamage || player.spirits.length < 6 || (currentCounts['Spirit Animal'] ?? 0) < 2;
			}
		if (interactionHasAction(interaction, 'restoreBarrier')) {
			return improvesSurvival && needsSurvival;
		}
		return improvesDamage || improvesSurvival || improvesFarm;
	});
	return filtered.length > 0 ? filtered : withNext;
}

function filterAbyssRouteDisciplineActions(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	threshold: number
): LegalAction[] {
	const player = state.players[seat];
	if (!player || !state.monster || isEvilAlignment(player.statusLevel ?? 0)) return withNext;
	const inAbyss = player.navigationDestination === 'Arcane Abyss';
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });

	if (inAbyss && state.phase === 'location') {
		const payoffActions = withNext.filter((action) => abyssFarmPayoffScore(state, seat, action) > 0);
		const hasPendingReward = !!player.pendingReward;
		const cleanFarmReady =
			farm.valid &&
			farm.farmable &&
			farm.opportunityVp > 0 &&
			computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) >= threshold;
		if ((hasPendingReward || cleanFarmReady) && payoffActions.length > 0) {
			return payoffActions;
		}
	}

	if (state.phase !== 'cleanup') return withNext;
	const committedToAbyss =
		inAbyss ||
		(player.victoryPoints ?? 0) >= 6 ||
		(farm.valid && farm.opportunityVp > 0);
	if (!committedToAbyss) return withNext;
	const requiredDiscardCount = player.pendingCorruptionDiscard?.count ?? 0;
	if (requiredDiscardCount > 0) return withNext;

	const currentCounts = awakenedClassCounts(player);
	const currentAttack = expectedAttack(player);
	const currentFirepower = firepowerKillProbability(state, seat, catalog);
	const filtered = withNext.filter((action) => {
		if (action.cmd.type !== 'discardSpirit') return true;
		const nextPlayer = action.next.players[seat];
		if (!nextPlayer) return true;
		const nextCounts = awakenedClassCounts(nextPlayer);
		const nextAttack = expectedAttack(nextPlayer);
		const nextFirepower = action.next.monster
			? firepowerKillProbability(action.next, seat, catalog)
			: currentFirepower;
		if ((nextCounts['Spirit Animal'] ?? 0) < (currentCounts['Spirit Animal'] ?? 0)) return false;
		if ((nextCounts.Cultivator ?? 0) < (currentCounts.Cultivator ?? 0)) return false;
		if (nextAttack < currentAttack - 0.01) return false;
		if (currentFirepower >= threshold && nextFirepower < currentFirepower - 0.01) return false;
		if ((nextPlayer.maxBarrier ?? 0) < (player.maxBarrier ?? 0)) return false;
		if ((nextPlayer.barrier ?? 0) < (player.barrier ?? 0)) return false;
		return true;
	});
	return filtered.length > 0 ? filtered : withNext;
}

function isRouteCloserFullActionState(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (state.round < 12 || vp < 15 || vp >= 30 || monsterHp < 4) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	if (cleanProb >= threshold) return false;
	const monsterDamage = monster.damage ?? 0;
	const attack = expectedAttack(player);
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const survivalTarget = monsterDamage + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const damageDeficit = monsterHp > 0 && (
		attack < monsterHp + 0.5 ||
		firepowerProb < threshold
	);
	const maxBarrierDeficit = survivalTarget > 0 && maxBarrier < survivalTarget;
	const restoreDeficit = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
	return damageDeficit || maxBarrierDeficit || restoreDeficit;
}

function isRouteCloserRestoreFinishState(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (state.round < 16 || vp < 24 || vp >= 30 || monsterHp < 4 || monsterHp > 10) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const finishOpportunity = farm.valid &&
		farm.rewardVp > 0 &&
		vp + farm.rewardVp * Math.max(1, farm.livesRemaining) >= 30;
	if (!finishOpportunity) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const survivalTarget = (monster.damage ?? 0) + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	if (survivalTarget <= 0 || maxBarrier < survivalTarget) return false;
	const restoreDeficit = barrier < survivalTarget;
	const currentSurvivalReady = barrier >= survivalTarget;
	const enoughFirepower = cleanProb >= threshold || firepowerProb >= threshold;
	return restoreDeficit || (currentSurvivalReady && enoughFirepower);
}

function filterConstrainedPlan(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	plan: GameCommand[],
	forbidTypes?: Set<GameCommand['type']>,
	maxStatusLevel?: number
): GameCommand[] {
	if (!forbidTypes?.size && maxStatusLevel === undefined) return plan;
	const actor = botActorFor(state, seat);
	let probeState = state;
	const filtered: GameCommand[] = [];
	for (const cmd of plan) {
		if (forbidTypes?.has(cmd.type)) continue;
		const probe = applyGameCommand(probeState, actor, cmd, catalog);
		if (!probe.ok) continue;
		if (maxStatusLevel !== undefined && (probe.state.players[seat]?.statusLevel ?? 0) > maxStatusLevel) {
			continue;
		}
		filtered.push(cmd);
		probeState = probe.state;
	}
	return filtered;
}

function pendingRewardVpPotential(state: PublicGameState, seat: SeatColor): number {
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return 0;
	return buildMonsterRewards(pending.rewardTrack)
		.map((opt) => (opt.effect.type === 'vp' ? opt.effect.amount : 0))
		.sort((a, b) => b - a)
		.slice(0, pending.chooseAmount)
			.reduce((sum, vp) => sum + vp, 0);
}

function isGoodBuilderHp4ConversionOverlayState(state: PublicGameState, seat: SeatColor): boolean {
	const player = state.players[seat];
	const monsterHp = state.monster?.maxHp ?? state.monster?.hp ?? 0;
	return (
		!!player &&
		!isEvilAlignment(player.statusLevel ?? 0) &&
		monsterHp >= 4 &&
		(player.victoryPoints ?? 0) >= GOOD_BUILDER_HP4_CONVERSION_OVERLAY_MIN_VP &&
		state.round >= GOOD_BUILDER_HP4_CONVERSION_OVERLAY_MIN_ROUND
	);
}

function isGoodBuilderHp4ConversionOverlayAction(
	state: PublicGameState,
	seat: SeatColor,
	action: LegalAction
): boolean {
	if (action.cmd.type === 'lockNavigation') {
		return GOOD_BUILDER_HP4_CONVERSION_OVERLAY_DESTINATIONS.has(action.cmd.destination);
	}
	if (action.cmd.type === 'startCombat' || action.cmd.type === 'resolveMonsterReward') return true;
	if (action.cmd.type !== 'resolveLocationInteraction') return false;

	const before = state.players[seat];
	const after = action.next.players[seat];
	if (!before || !after) return false;
	return (
		(after.victoryPoints ?? 0) > (before.victoryPoints ?? 0) ||
		(after.barrier ?? 0) > (before.barrier ?? 0) ||
		(after.maxBarrier ?? 0) > (before.maxBarrier ?? 0) ||
		(after.attackDice?.length ?? 0) > (before.attackDice?.length ?? 0) ||
		pendingRewardVpPotential(action.next, seat) > pendingRewardVpPotential(state, seat)
	);
}

function abyssFarmPayoffScore(state: PublicGameState, seat: SeatColor, action: LegalAction): number {
	if (state.players[seat]?.navigationDestination !== 'Arcane Abyss') return 0;
	const currentVp = state.players[seat]?.victoryPoints ?? 0;
	const nextVp = action.next.players[seat]?.victoryPoints ?? 0;
	const immediateVp = Math.max(0, nextVp - currentVp);

	if (action.cmd.type === 'resolveMonsterReward') {
		const claimableVp = pendingRewardVpPotential(state, seat);
		return immediateVp > 0 || claimableVp > 0 ? 100 + immediateVp + claimableVp : 0;
	}

	if (action.cmd.type === 'startCombat') {
		const currentPendingVp = pendingRewardVpPotential(state, seat);
		const nextPendingVp = pendingRewardVpPotential(action.next, seat);
		const pendingGain = Math.max(0, nextPendingVp - currentPendingVp);
		const killed = action.next.combats.some((combat) => (
			combat.kind === 'monster' &&
			combat.sides[0]?.seat === seat &&
			combat.killed
		));
		return pendingGain > 0 || killed ? 50 + pendingGain + (killed ? 1 : 0) : 0;
	}

	return 0;
}

function allClassCounts(player: PublicGameState['players'][SeatColor] | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	for (const spirit of player?.spirits ?? []) {
		for (const [name, count] of Object.entries(spirit.classes ?? {})) {
			out[name] = (out[name] ?? 0) + count;
		}
	}
	for (const aug of player?.spiritAugmentAttachments ?? []) {
		const className = (aug as { className?: string }).className;
		if (className) out[className] = (out[className] ?? 0) + 1;
	}
	return out;
}

function pendingAugmentClassCounts(
	player: PublicGameState['players'][SeatColor] | undefined,
	catalog: PlayCatalog
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const augment of player?.unplacedAugments ?? []) {
		const className = augment.classId
			? catalog.classes.find((entry) => entry.id === augment.classId)?.name
			: undefined;
		if (className) out[className] = (out[className] ?? 0) + 1;
	}
	return out;
}

function goodBuilderClassScore(counts: Record<string, number>, raw: Record<string, number>, vp: number): number {
	const awakened =
		(counts['World Ender'] ?? 0) * 70 +
		(counts['World Guardian'] ?? 0) * (vp >= 20 ? 90 : 45) +
		(counts.Healer ?? 0) * 38 +
		(counts['Spirit Animal'] ?? 0) * 24 +
		(counts.Fighter ?? 0) * 9 +
		(counts.Elementalist ?? 0) * 12 +
		(counts.Cultivator ?? 0) * 13 +
		(counts['Soul Weaver'] ?? 0) * 8;
	const potential =
		Math.max(0, (raw['World Ender'] ?? 0) - (counts['World Ender'] ?? 0)) * 30 +
		Math.max(0, (raw['World Guardian'] ?? 0) - (counts['World Guardian'] ?? 0)) * 26 +
		Math.max(0, (raw.Healer ?? 0) - (counts.Healer ?? 0)) * 14 +
		Math.max(0, (raw['Spirit Animal'] ?? 0) - (counts['Spirit Animal'] ?? 0)) * 10 +
		Math.max(0, (raw.Fighter ?? 0) - (counts.Fighter ?? 0)) * 5 +
		Math.max(0, (raw.Elementalist ?? 0) - (counts.Elementalist ?? 0)) * 5 +
		Math.max(0, (raw.Cultivator ?? 0) - (counts.Cultivator ?? 0)) * 6;
	const corruptionPull = (raw['Cursed Spirit'] ?? 0) * 80;
	return awakened + potential - corruptionPull;
}

function goodBuilderSpiritScore(spirit: { classes?: Record<string, number>; cost?: number } | undefined): number {
	if (!spirit) return 0;
	const cls = spirit.classes ?? {};
	let score = 0;
	score += (cls['World Ender'] ?? 0) * 40;
	score += (cls['World Guardian'] ?? 0) * 34;
	score += (cls.Healer ?? 0) * 24;
	score += (cls['Spirit Animal'] ?? 0) * 18;
	score += (cls.Cultivator ?? 0) * 13;
	score += (cls.Elementalist ?? 0) * 12;
	score += (cls.Fighter ?? 0) * 10;
	score += (cls['Soul Weaver'] ?? 0) * 8;
	score += (cls.Sharpshooter ?? 0) * 3;
	score -= (cls['Cursed Spirit'] ?? 0) * 25;
	score -= Math.max(0, (spirit.cost ?? 1) - 5) * 2;
	return score;
}

function goodBuilderHandDrawScore(player: PublicGameState['players'][SeatColor] | undefined): number {
	return (player?.handDraws ?? []).reduce((sum, spirit) => sum + Math.max(0, goodBuilderSpiritScore(spirit)), 0);
}

function goodBuilderStateScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): number {
	const player = state.players[seat];
	if (!player) return -1_000_000;
	const status = player.statusLevel ?? 0;
	const vp = player.victoryPoints ?? 0;
	const counts = awakenedClassCounts(player);
	const raw = allClassCounts(player);
	const monster = state.monster;
	const cleanProb = monster ? computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) : 0;
	const firepowerProb = monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const attack = expectedAttack(player);
	const monsterHp = monster ? monster.maxHp ?? monster.hp ?? 0 : 0;
	const survivalTarget = monster ? (monster.damage ?? 0) + 1 : 0;
	const canSurvive = survivalTarget <= 0 || (player.barrier ?? 0) >= survivalTarget;
	const nearKill = monsterHp > 0 ? clamp01(attack / Math.max(1, monsterHp)) : 0;
	const worldGuardianFinish = (counts['World Guardian'] ?? 0) > 0 && vp >= 24 ? 500 : 0;
	const healerRestEngine = (counts.Healer ?? 0) > 0 && (player.maxBarrier ?? 0) >= 10 ? 80 : 0;
	return (
		vp * 130 +
		(vp >= VP_TO_WIN ? 10_000 : 0) -
		status * 4_000 +
		goodBuilderClassScore(counts, raw, vp) +
		goodBuilderHandDrawScore(player) * 2 +
		pendingRewardVpPotential(state, seat) * 90 +
		(player.attackDice?.length ?? 0) * 10 +
		attack * 18 +
		(player.maxBarrier ?? 0) * 9 +
		(player.barrier ?? 0) * 4 +
		Math.min(1, cleanProb) * 80 +
		Math.min(1, firepowerProb) * 40 +
		nearKill * 35 +
		(canSurvive ? 18 : -35) +
		worldGuardianFinish +
		healerRestEngine +
		(farm.valid && farm.farmable ? farm.opportunityVp * 100 : 0)
	);
}

function goodBuilderActionScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction,
	threshold: number
): number {
	const before = state.players[seat];
	const after = action.next.players[seat];
	if (!before || !after) return -1_000_000;
	const beforeScore = goodBuilderStateScore(state, seat, catalog, threshold);
	const afterScore = goodBuilderStateScore(action.next, seat, catalog, threshold);
	const vpDelta = (after.victoryPoints ?? 0) - (before.victoryPoints ?? 0);
	const statusDelta = (after.statusLevel ?? 0) - (before.statusLevel ?? 0);
	let score = afterScore - beforeScore + vpDelta * 600 - Math.max(0, statusDelta) * 10_000;

	if (action.cmd.type === 'startCombat') {
		const killed = action.next.combats.some((combat) => (
			combat.kind === 'monster' &&
			combat.sides[0]?.seat === seat &&
			combat.killed
		));
		score += killed ? 550 + pendingRewardVpPotential(action.next, seat) * 180 : -120;
	}
	if (action.cmd.type === 'resolveMonsterReward') score += 500 + vpDelta * 500;
	if (action.cmd.type === 'resolveAwakenReward') score += 400 + vpDelta * 500;
	if (action.cmd.type === 'resolveDecision') score += vpDelta > 0 ? 350 + vpDelta * 500 : 35;
	if (action.cmd.type === 'resolveLocationInteraction') {
		const player = state.players[seat];
		const destination = player?.navigationDestination;
		const rowIndex = (action.cmd as Extract<GameCommand, { type: 'resolveLocationInteraction' }>).rowIndex;
		const interaction = destination
			? buildLocationInteractions((catalog.locations ?? []).find((loc) => loc.name === destination)?.rewardRows)
				.find((it) => it.rowIndex === rowIndex)
			: undefined;
		const grantsCursed = interaction?.gains.some((gain) => (
			(gain.type === 'rune' && gain.rune.name === 'Cursed Spirit') ||
			(gain.type === 'chooseRune' && gain.options.some((option) => option.name === 'Cursed Spirit'))
		));
		if (grantsCursed) score -= 2_000;
		if (interaction?.gains.some((gain) => gain.type === 'action' && gain.action === 'spiritWorldSummon')) score += 160;
		if (interaction?.gains.some((gain) => gain.type === 'action' && gain.action === 'rest')) score += 120;
		if (interaction?.gains.some((gain) => gain.type === 'action' && gain.action === 'cultivate')) score += 70;
		if (destination === 'Tidal Cove') score += 85;
		if (destination === 'Floral Patch') score += 55;
		if (destination === 'Lantern Canyon') score += 45;
		if (destination === 'Cyber City') score += 45;
	}
	if (action.cmd.type === 'spawnHandSpirit') {
		const guid = (action.cmd as Extract<GameCommand, { type: 'spawnHandSpirit' }>).guid;
		const currentDraw = (before.handDraws ?? []).find((spirit) => spirit.guid === guid);
		const spiritScore = goodBuilderSpiritScore(currentDraw);
		score += spiritScore > 0 ? 80 + spiritScore * 8 : -300;
	}
	if (action.cmd.type === 'takeSpirit' || action.cmd.type === 'replaceSpirit') {
		const boardDelta = afterScore - beforeScore;
		score += boardDelta > 20 ? 80 + boardDelta : -350;
	}
	if (action.cmd.type === 'awakenSpirit' || action.cmd.type === 'manualAwaken') score += 120;
	if (action.cmd.type === 'placeAugmentOnSpirit') score += 70;
	if (action.cmd.type === 'attachRuneToSpirit') score += 45;
	if (action.cmd.type === 'discardHandDraws') score -= goodBuilderHandDrawScore(before) * 12;
	if (action.cmd.type === 'redrawHandDraws') score += goodBuilderHandDrawScore(before) <= 10 ? 40 : -60;
	if (
		action.cmd.type === 'commitBenefits' ||
		action.cmd.type === 'commitAwakening' ||
		action.cmd.type === 'commitCleanup' ||
		action.cmd.type === 'endLocationActions' ||
		action.cmd.type === 'passEncounter'
	) {
		score += 10;
	}
	return score;
}

function chooseGoodBuilderOracleAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	threshold: number
): LegalAction | null {
	let best: LegalAction | null = null;
	let bestScore = -Infinity;
	for (const action of withNext) {
		const score = goodBuilderActionScore(state, seat, catalog, action, threshold);
		if (score > bestScore) {
			bestScore = score;
			best = action;
		}
	}
	return best;
}

function classCountScoreForHp4Floor(counts: Record<string, number>, hp: number, survivalShort: boolean): number {
	const spiritAnimal = counts['Spirit Animal'] ?? 0;
	const cultivator = counts.Cultivator ?? 0;
	const healer = counts.Healer ?? 0;
	const fighter = counts.Fighter ?? 0;
	const elementalist = counts.Elementalist ?? 0;
	const worldGuardian = counts['World Guardian'] ?? 0;
	const worldEnder = counts['World Ender'] ?? 0;
	return (
		Math.min(spiritAnimal, Math.max(4, hp + 1)) * 260 +
		(cultivator >= 2 ? 900 : cultivator * (survivalShort ? 420 : 180)) +
		Math.min(Math.max(0, cultivator - 2), 2) * 220 +
		healer * 90 +
		fighter * 65 +
		elementalist * 55 +
		worldGuardian * 180 +
		worldEnder * 220
	);
}

function goodBuilderHp4ScoreFloorStateScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): number {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player) return -1_000_000;
	const vp = player.victoryPoints ?? 0;
	const status = player.statusLevel ?? 0;
	const hp = monster ? monster.maxHp ?? monster.hp ?? 0 : 0;
	const damage = monster?.damage ?? 0;
	const survivalTarget = damage + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const attack = expectedAttack(player);
	const counts = awakenedClassCounts(player);
	const pendingAugments = pendingAugmentClassCounts(player, catalog);
	const clean = monster ? computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) : 0;
	const firepower = monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const survivalShort = survivalTarget > 0 && (maxBarrier < survivalTarget || barrier < Math.min(maxBarrier, survivalTarget));
	const maxSurvivalReady = survivalTarget <= 0 || maxBarrier >= survivalTarget;
	const currentSurvivalReady = survivalTarget <= 0 || barrier >= survivalTarget;
	const damageReady = hp <= 0 || clean >= threshold || firepower >= threshold || attack >= hp - 0.01;
	const nearDamage = hp <= 0 || clean >= threshold * 0.5 || firepower >= threshold * 0.5 || attack >= hp - 0.75;
	const maxBarrierDeficit = survivalTarget > 0 ? Math.max(0, survivalTarget - maxBarrier) : 0;
	const currentBarrierDeficit = survivalTarget > 0 ? Math.max(0, Math.min(maxBarrier, survivalTarget) - barrier) : 0;
	const hp4SurvivalWall =
		farm.valid &&
		farm.rewardVp > 0 &&
		vp >= 6 &&
		hp >= 4 &&
		hp <= 5 &&
		nearDamage &&
		!currentSurvivalReady;
	const attackTarget = Math.max(1, Math.min(Math.max(4, hp + 0.5), 7));
	const attackReadiness = clamp01(attack / attackTarget);
	const maxBarrierReadiness = survivalTarget <= 0 ? 1 : clamp01(maxBarrier / survivalTarget);
	const barrierReadiness = survivalTarget <= 0 ? 1 : clamp01(barrier / survivalTarget);
	return (
		vp * 520 +
		(vp >= VP_TO_WIN ? 80_000 : 0) -
		status * 12_000 +
		pendingRewardVpPotential(state, seat) * 2_200 +
		(farm.valid ? farm.rewardVp * Math.max(1, farm.livesRemaining ?? 1) * 260 : 0) +
		(farm.valid ? farm.opportunityVp * 450 : 0) +
		(farm.valid && farm.farmable ? 1_200 : 0) +
		clean * 1_250 +
		firepower * 850 +
		(damageReady ? 2_400 : 0) +
		(nearDamage ? 900 : 0) +
		(maxSurvivalReady ? 1_400 : 0) +
		(currentSurvivalReady ? 2_200 : 0) +
		(damageReady && currentSurvivalReady ? 3_200 : 0) +
		attackReadiness * 1_300 +
		attack * 120 +
		(player.attackDice?.length ?? 0) * 110 +
			maxBarrierReadiness * 950 +
			barrierReadiness * 1_150 +
			maxBarrier * 70 +
			barrier * 85 +
			classCountScoreForHp4Floor(counts, hp, survivalShort) +
			(pendingAugments.Cultivator ?? 0) * (hp4SurvivalWall ? 900 : 140) +
			(hp4SurvivalWall && maxBarrierDeficit > 0 && (counts.Cultivator ?? 0) >= 2 ? 1_600 : 0) -
			(hp4SurvivalWall ? maxBarrierDeficit * 1_300 + currentBarrierDeficit * 450 : 0) +
			goodBuilderHandDrawScore(player) * 26
	);
}

function goodBuilderHp4ScoreFloorActionScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction,
	threshold: number
): number {
	const before = state.players[seat];
	const after = action.next.players[seat];
	const monster = state.monster;
	if (!before || !after || isEvilAlignment(before.statusLevel ?? 0)) return -1_000_000;
	const beforeScore = goodBuilderHp4ScoreFloorStateScore(state, seat, catalog, threshold);
	const afterScore = goodBuilderHp4ScoreFloorStateScore(action.next, seat, catalog, threshold);
	const beforeCounts = awakenedClassCounts(before);
	const afterCounts = awakenedClassCounts(after);
	const beforePendingAugments = pendingAugmentClassCounts(before, catalog);
	const afterPendingAugments = pendingAugmentClassCounts(after, catalog);
	const beforeRelics = heldRelicCount(before);
	const afterRelics = heldRelicCount(after);
	const vpDelta = (after.victoryPoints ?? 0) - (before.victoryPoints ?? 0);
	const statusDelta = (after.statusLevel ?? 0) - (before.statusLevel ?? 0);
	const hp = monster ? monster.maxHp ?? monster.hp ?? 0 : 0;
	const survivalTarget = monster ? (monster.damage ?? 0) + 1 : 0;
	const beforeClean = monster ? computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) : 0;
	const beforeFirepower = monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const beforeAttack = expectedAttack(before);
	const beforeDamageReady = hp <= 0 || beforeClean >= threshold || beforeFirepower >= threshold || beforeAttack >= hp - 0.01;
	const beforeNearDamage = hp <= 0 || beforeClean >= threshold * 0.5 || beforeFirepower >= threshold * 0.5 || beforeAttack >= hp - 0.75;
	const damageFloorMissing =
		hp > 0 &&
		!beforeNearDamage &&
		(beforeAttack < Math.min(5, hp + 0.5) || beforeFirepower < threshold * 0.5);
	const beforeSurvivalReady = survivalTarget <= 0 || (before.barrier ?? 0) >= survivalTarget;
	const beforeMaxSurvivalReady = survivalTarget <= 0 || (before.maxBarrier ?? 0) >= survivalTarget;
	const afterClean = action.next.monster ? computeKillProbability(action.next, seat, catalog, { allowCorruptKill: false }) : beforeClean;
	const afterFirepower = action.next.monster ? firepowerKillProbability(action.next, seat, catalog) : beforeFirepower;
	const afterAttack = expectedAttack(after);
	const afterDamageReady = hp <= 0 || afterClean >= threshold || afterFirepower >= threshold || afterAttack >= hp - 0.01;
	const afterSurvivalReady = survivalTarget <= 0 || (after.barrier ?? 0) >= survivalTarget;
	const afterMaxSurvivalReady = survivalTarget <= 0 || (after.maxBarrier ?? 0) >= survivalTarget;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const committedMonsterRoute = farm.valid && farm.rewardVp > 0 && (before.victoryPoints ?? 0) >= 3;
	const hp4SurvivalWall =
		farm.valid &&
		farm.rewardVp > 0 &&
		(before.victoryPoints ?? 0) >= 6 &&
		hp >= 4 &&
		hp <= 5 &&
		beforeNearDamage &&
		!beforeSurvivalReady;
	const beforeCultivatorProgress = (beforeCounts.Cultivator ?? 0) + (beforePendingAugments.Cultivator ?? 0);
	const afterCultivatorProgress = (afterCounts.Cultivator ?? 0) + (afterPendingAugments.Cultivator ?? 0);
	const cultivatorProgressDelta = Math.max(0, afterCultivatorProgress - beforeCultivatorProgress);
	const needsCultivatorTicket =
		committedMonsterRoute &&
		hp >= 4 &&
		hp <= 5 &&
		survivalTarget > 0 &&
		(before.maxBarrier ?? 0) < survivalTarget &&
		beforeCultivatorProgress < 2;
	let score = afterScore - beforeScore + vpDelta * 5_500 - Math.max(0, statusDelta) * 40_000;

	if ((afterCounts['Spirit Animal'] ?? 0) > (beforeCounts['Spirit Animal'] ?? 0)) score += 1_600;
	if (cultivatorProgressDelta > 0) score += cultivatorProgressDelta * (hp4SurvivalWall ? 2_800 : 900);
	if ((afterCounts.Fighter ?? 0) > (beforeCounts.Fighter ?? 0)) score += damageFloorMissing ? 1_600 : 650;
	if ((afterCounts.Elementalist ?? 0) > (beforeCounts.Elementalist ?? 0)) score += damageFloorMissing ? 1_450 : 600;
	if ((afterCounts.Cultivator ?? 0) >= 2 && (beforeCounts.Cultivator ?? 0) < 2) score += hp4SurvivalWall ? 5_200 : 2_400;
	if ((afterCounts.Cultivator ?? 0) > (beforeCounts.Cultivator ?? 0) && (after.maxBarrier ?? 0) < Math.max(6, survivalTarget)) {
		score += hp4SurvivalWall ? 2_600 : 900;
	}
	if (!beforeDamageReady && afterDamageReady) score += 2_800;
	if (!beforeMaxSurvivalReady && afterMaxSurvivalReady) score += hp4SurvivalWall ? 4_200 : 1_800;
	if (!beforeSurvivalReady && afterSurvivalReady) score += 3_200;
	if (afterDamageReady && afterSurvivalReady) score += 2_200;
	if (!afterMaxSurvivalReady && hp >= 4) score -= 900;

	switch (action.cmd.type) {
		case 'resolveMonsterReward':
			score += 12_000 + Math.max(0, vpDelta) * 12_000;
			break;
			case 'startCombat': {
				const killed = action.next.combats.some((combat) => (
					combat.kind === 'monster' &&
					combat.sides[0]?.seat === seat &&
					combat.killed
				));
				if (hp4SurvivalWall && !beforeSurvivalReady) score -= 20_000;
				score += killed ? 14_000 + pendingRewardVpPotential(action.next, seat) * 4_000 : -5_000;
				break;
			}
			case 'resolveLocationInteraction': {
				const interaction = locationInteractionForAction(state, seat, catalog, action);
				if (interactionGrantsCursed(interaction)) score -= 15_000;
				if (interactionCostsRelic(interaction) && beforeRelics > afterRelics && needsCultivatorTicket && cultivatorProgressDelta <= 0) {
					score -= 18_000;
				}
				if (cultivatorProgressDelta > 0 && interactionCanGrantClass(interaction, catalog, 'Cultivator')) {
					score += hp4SurvivalWall || needsCultivatorTicket ? 9_000 : 3_000;
				}
				if (interactionHasAction(interaction, 'spiritWorldSummon') || interactionHasAction(interaction, 'abyssSummon')) {
					score += hp4SurvivalWall && beforeCultivatorProgress < 2 ? 1_450 : 850;
				}
				if (interactionHasAction(interaction, 'cultivate')) {
					score += (beforeCounts.Cultivator ?? 0) >= 2
						? hp4SurvivalWall ? 5_000 : 1_800
						: hp4SurvivalWall ? 250 : -1_100;
				}
				if (interactionHasAction(interaction, 'restoreBarrier')) {
					score += afterSurvivalReady ? 1_600 : hp4SurvivalWall && beforeMaxSurvivalReady ? 1_100 : 250;
				}
				if (interactionHasAction(interaction, 'rest')) {
					score += afterSurvivalReady ? 1_200 : -450;
				}
				break;
		}
		case 'spawnHandSpirit': {
			score +=
				Math.max(0, (afterCounts['Spirit Animal'] ?? 0) - (beforeCounts['Spirit Animal'] ?? 0)) * 1_600 +
				Math.max(0, (afterCounts.Cultivator ?? 0) - (beforeCounts.Cultivator ?? 0)) * 1_200 +
				Math.max(0, (afterCounts.Fighter ?? 0) - (beforeCounts.Fighter ?? 0)) * (damageFloorMissing ? 1_400 : 650) +
				Math.max(0, (afterCounts.Elementalist ?? 0) - (beforeCounts.Elementalist ?? 0)) * (damageFloorMissing ? 1_300 : 600) +
				Math.max(0, (afterCounts.Healer ?? 0) - (beforeCounts.Healer ?? 0)) * 450;
			break;
		}
		case 'takeSpirit':
		case 'replaceSpirit':
			score +=
				(afterAttack - beforeAttack) * 950 +
				Math.max(0, (afterCounts['Spirit Animal'] ?? 0) - (beforeCounts['Spirit Animal'] ?? 0)) * 1_450 +
				Math.max(0, (afterCounts.Cultivator ?? 0) - (beforeCounts.Cultivator ?? 0)) * (hp4SurvivalWall ? 3_800 : 1_350) +
				Math.max(0, (afterCounts.Fighter ?? 0) - (beforeCounts.Fighter ?? 0)) * (damageFloorMissing ? 1_700 : 750) +
				Math.max(0, (afterCounts.Elementalist ?? 0) - (beforeCounts.Elementalist ?? 0)) * (damageFloorMissing ? 1_550 : 700) +
				Math.max(0, (afterCounts.Healer ?? 0) - (beforeCounts.Healer ?? 0)) * 550;
			break;
			case 'awakenSpirit':
			case 'manualAwaken':
			case 'resolveDecision':
			case 'resolveAwakenReward':
			case 'placeAugmentOnSpirit':
			case 'attachRuneToSpirit':
				score += 500;
				if (cultivatorProgressDelta > 0) score += cultivatorProgressDelta * (hp4SurvivalWall ? 3_400 : 1_100);
				break;
		case 'discardHandDraws':
			score -= goodBuilderHandDrawScore(before) * 42;
			break;
		case 'redrawHandDraws':
			score += goodBuilderHandDrawScore(before) <= 10 ? 120 : -350;
			break;
		case 'endLocationActions':
			if (beforeDamageReady && beforeSurvivalReady && (before.pendingReward || (before.navigationDestination === 'Arcane Abyss' && hp >= 4))) {
				score -= 2_000;
			}
			score += 80;
			break;
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
			score += 120;
			break;
		default:
			break;
	}
	return score;
}

function chooseGoodBuilderHp4ScoreFloorOracleAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	threshold: number
): LegalAction | null {
	let best: LegalAction | null = null;
	let bestScore = -Infinity;
	for (const action of withNext) {
		const score = goodBuilderHp4ScoreFloorActionScore(state, seat, catalog, action, threshold);
		if (score > bestScore) {
			bestScore = score;
			best = action;
		}
	}
	return best;
}

function cleanFarmableFlags(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): { farmable: boolean; bossFarmable: boolean; farmOpportunityVp: number } {
	const signal = evaluateFarmValue(state, seat, catalog, { threshold });
	if (!signal.valid || signal.statusLevel !== 0) {
		return { farmable: false, bossFarmable: false, farmOpportunityVp: 0 };
	}
	return {
		farmable: signal.farmable,
		bossFarmable: signal.bossFarmable,
		farmOpportunityVp: signal.opportunityVp
	};
}

function combatReadyButNeedsRestore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	if (cleanProb >= threshold) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const damageReady = firepowerProb >= threshold || (monsterHp > 0 && attack >= monsterHp - 0.01);
	if (!damageReady) return false;
	const survivalTarget = (monster.damage ?? 0) + 1;
	if (survivalTarget <= 0) return false;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const currentBarrierDeficit = maxBarrier >= survivalTarget && barrier < survivalTarget;
	const counts = awakenedClassCounts(player);
	const maxBarrierDeficitWithEngine = maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;
	return currentBarrierDeficit || maxBarrierDeficitWithEngine;
}

function firstLegalNavigationDestination(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	destinations: NavigationDestination[]
): NavigationDestination | null {
	const legal = legalDestinations(state, seat, catalog);
	for (const destination of destinations) {
		if (legal.includes(destination)) return destination;
	}
	return null;
}

function goodBuilderOracleDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player) return ['Tidal Cove', 'Floral Patch', 'Lantern Canyon', 'Cyber City'];
	const destinations: NavigationDestination[] = [];
	const append = (destination: NavigationDestination): void => appendUniqueDestination(destinations, destination);
	const vp = player.victoryPoints ?? 0;
	const counts = awakenedClassCounts(player);
	const raw = allClassCounts(player);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const clean = monster ? computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) : 0;
	const firepower = monster ? firepowerKillProbability(state, seat, catalog) : 0;
	const attack = expectedAttack(player);
	const monsterHp = monster ? monster.maxHp ?? monster.hp ?? 0 : 0;
	const survivalTarget = monster ? (monster.damage ?? 0) + 1 : 0;
	const needsRestore = survivalTarget > 0 && (player.maxBarrier ?? 0) >= survivalTarget && (player.barrier ?? 0) < survivalTarget;
	const needsMaxBarrier = survivalTarget > 0 && (player.maxBarrier ?? 0) < survivalTarget && (counts.Cultivator ?? 0) >= 2;
	const damageShort = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < threshold;
	const wantsPassiveScorer =
		(raw['World Ender'] ?? 0) <= 0 ||
		((raw['World Guardian'] ?? 0) <= 0 && vp >= 15) ||
		((counts.Healer ?? 0) <= 0 && (player.maxBarrier ?? 0) >= 8);
	const wantsTeam = player.spirits.length < 6 || wantsPassiveScorer || (counts['Spirit Animal'] ?? 0) < 2;
	const hasRelic = (player.mats ?? []).some((r) => r.hasRune && r.type === 'relic');
	const hasWorldGuardianFinish = (counts['World Guardian'] ?? 0) > 0 && vp >= 24;
	const hasHealerRestVp = (counts.Healer ?? 0) > 0 && (player.maxBarrier ?? 0) >= 10;
	const cleanFarmReady =
		farm.valid &&
		farm.opportunityVp > 0 &&
		(survivalTarget <= 0 || (player.barrier ?? 0) >= survivalTarget) &&
		(monsterHp <= 0 || attack >= monsterHp - 0.25 || firepower >= 0.25 || clean >= 0.25);

	if (farm.valid && farm.farmable && farm.opportunityVp >= (vp < 18 ? 2 : 1)) return ['Arcane Abyss'];
	if (cleanFarmReady && (vp < 24 || farm.livesRemaining >= 1)) return ['Arcane Abyss'];
	if (hasWorldGuardianFinish || hasHealerRestVp) return ['Floral Patch'];
	if (needsRestore) return ['Floral Patch', 'Lantern Canyon'];
	if (wantsTeam || damageShort || (player.attackDice?.length ?? 0) < 2) {
		append('Tidal Cove');
		if (hasRelic && state.round >= 4) append('Cyber City');
		return destinations;
	}
	if (needsMaxBarrier || ((player.maxBarrier ?? 0) < 7 && (counts.Cultivator ?? 0) >= 3)) return ['Lantern Canyon'];
	if (farm.valid && farm.opportunityVp > 0) return ['Arcane Abyss'];
	if (hasRelic && vp >= 12) append('Cyber City');
	append('Tidal Cove');
	append('Floral Patch');
	append('Cyber City');
	append('Lantern Canyon');
	return destinations;
}

function goodBuilderFarmerOracleDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return goodBuilderOracleDestinations(state, seat, catalog, threshold);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const canRestore = maxBarrier >= survivalTarget;
	const needsRestore = survivalTarget > 0 && canRestore && barrier < survivalTarget;
	const nearDamage = monsterHp <= 0 || attack >= monsterHp - 1.25 || firepower >= 0.2 || clean >= 0.2;
	if (farm.valid && farm.opportunityVp > 0 && nearDamage) {
		if (needsRestore && state.round < 29) return ['Floral Patch', 'Lantern Canyon'];
		return ['Arcane Abyss'];
	}
	if (needsRestore) return ['Floral Patch', 'Lantern Canyon'];
	const counts = awakenedClassCounts(player);
	if (survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2) {
		return ['Lantern Canyon', 'Floral Patch'];
	}
	const needsDamage = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < threshold;
	if (needsDamage || (player.attackDice?.length ?? 0) < 2 || (counts['Spirit Animal'] ?? 0) < 3) {
		return ['Tidal Cove', 'Cyber City'];
	}
	return goodBuilderOracleDestinations(state, seat, catalog, threshold);
}

function goodBuilderSupportOracleDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player) return ['Tidal Cove', 'Floral Patch', 'Cyber City', 'Lantern Canyon'];
	const destinations: NavigationDestination[] = [];
	const append = (destination: NavigationDestination): void => appendUniqueDestination(destinations, destination);
	const vp = player.victoryPoints ?? 0;
	const counts = awakenedClassCounts(player);
	const raw = allClassCounts(player);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const survivalTarget = monster ? (monster.damage ?? 0) + 1 : 0;
	const needsRestore = survivalTarget > 0 && (player.maxBarrier ?? 0) >= survivalTarget && (player.barrier ?? 0) < survivalTarget;
	const hasRelic = (player.mats ?? []).some((r) => r.hasRune && r.type === 'relic');
	const hasWorldGuardianFinish = (counts['World Guardian'] ?? 0) > 0 && vp >= 24;
	const hasHealerRestVp = (counts.Healer ?? 0) > 0 && (player.maxBarrier ?? 0) >= 10;
	const wantsScorer = (raw['World Ender'] ?? 0) <= 0 || ((raw['World Guardian'] ?? 0) <= 0 && vp >= 12);
	if (hasWorldGuardianFinish || hasHealerRestVp || needsRestore) return ['Floral Patch', 'Lantern Canyon'];
	if (farm.valid && farm.farmable && farm.opportunityVp > 0) {
		const monsterHp = monster?.maxHp ?? monster?.hp ?? 99;
		if (vp < 18 || farm.opportunityVp >= 2 || monsterHp <= 4) return ['Arcane Abyss'];
	}
	if (player.spirits.length < 7 || wantsScorer || (counts['Spirit Animal'] ?? 0) < 2) append('Tidal Cove');
	if (hasRelic && (state.round >= 4 || player.spirits.length >= 5)) append('Cyber City');
	if ((player.maxBarrier ?? 0) < 8 && (counts.Cultivator ?? 0) >= 2) append('Lantern Canyon');
	append('Floral Patch');
	append('Tidal Cove');
	append('Cyber City');
	append('Lantern Canyon');
	return destinations;
}

function goodBuilderNoncontestSupportDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return ['Tidal Cove', 'Cyber City', 'Floral Patch', 'Lantern Canyon'];
	const destinations: NavigationDestination[] = [];
	const append = (destination: NavigationDestination): void => appendUniqueDestination(destinations, destination);
	const counts = awakenedClassCounts(player);
	const raw = allClassCounts(player);
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const needsDamage = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < threshold && clean < threshold;
	const needsRestore = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
	const needsMaxBarrier = survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;
	const hasRelic = (player.mats ?? []).some((r) => r.hasRune && r.type === 'relic');
	const wantsPassiveScorer =
		(raw['World Ender'] ?? 0) <= 0 ||
		((raw['World Guardian'] ?? 0) <= 0 && vp >= 12) ||
		((counts.Healer ?? 0) > 0 && maxBarrier >= 8);

	if (needsRestore) {
		append('Floral Patch');
		append('Lantern Canyon');
	}
	if (needsMaxBarrier) append('Lantern Canyon');
	if (needsDamage || player.spirits.length < 7 || (counts['Spirit Animal'] ?? 0) < 2) {
		append('Tidal Cove');
		if (hasRelic || state.round >= 4) append('Cyber City');
	}
	if (hasRelic) append('Cyber City');
	if (wantsPassiveScorer || vp >= 18) append('Floral Patch');
	append('Tidal Cove');
	append('Cyber City');
	append('Floral Patch');
	append('Lantern Canyon');
	return destinations;
}

function goodNonfallenFarmBuildDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return ['Tidal Cove', 'Cyber City', 'Lantern Canyon'];
	const status = player.statusLevel ?? 0;
	if (isEvilAlignment(status)) return ['Floral Patch', 'Tidal Cove', 'Cyber City', 'Lantern Canyon'];
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const corrupt = computeKillProbability(state, seat, catalog, { allowCorruptKill: true });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const counts = awakenedClassCounts(player);
	const cleanFarm =
		farm.valid &&
		farm.farmable &&
		farm.opportunityVp >= (player.victoryPoints < 18 ? 2 : 1);
	if (cleanFarm) return ['Arcane Abyss'];

	const hasNonfallenCorruptionBudget = status < 2;
	const corruptFarmReady =
		hasNonfallenCorruptionBudget &&
		farm.valid &&
		farm.rewardVp > 0 &&
		monsterHp <= 5 &&
		(corrupt >= threshold || firepower >= threshold || attack >= monsterHp - 0.01);
	if (corruptFarmReady && (player.victoryPoints >= 6 || state.round >= 6 || monsterHp <= 2)) {
		return ['Arcane Abyss'];
	}

	const survivalTarget = (monster.damage ?? 0) + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const needsDamage = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < threshold;
	const canRestoreWithLantern = (counts.Cultivator ?? 0) >= 2 || maxBarrier < survivalTarget;
	const hasRelic = (player.mats ?? []).some((r) => r.hasRune && r.type === 'relic');
	if (needsDamage) return ['Tidal Cove', 'Cyber City'];
	if (barrier < Math.min(maxBarrier, survivalTarget) && hasRelic) return ['Floral Patch', 'Lantern Canyon'];
	if (barrier < Math.min(maxBarrier, survivalTarget) || canRestoreWithLantern) return ['Lantern Canyon', 'Tidal Cove'];
	if (farm.valid && farm.rewardVp > 0) return ['Arcane Abyss'];
	return ['Tidal Cove', 'Cyber City', 'Lantern Canyon', 'Floral Patch'];
}

function shouldGoodTargetContinueAbyssFarm(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	const status = player?.statusLevel ?? 0;
	if (!player || !monster || isEvilAlignment(status)) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	if (!farm.valid || farm.rewardVp <= 0) return false;
	if (!GOOD_TARGET_CONTROLLED_CORRUPT_FARM && !farm.farmable) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const vp = player.victoryPoints ?? 0;
	if (vp >= GOOD_TARGET_EXPOSE_AFTER_VP) return false;
	const lives = Math.max(1, farm.livesRemaining ?? monster.livesRemaining ?? 1);
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const corrupt = computeKillProbability(state, seat, catalog, { allowCorruptKill: true });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const canSpendCorruptionAndRemainGood =
		GOOD_TARGET_CONTROLLED_CORRUPT_FARM &&
		status < 2 &&
		vp < GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP;
	const controlledKillProbability = Math.max(
		clean,
		canSpendCorruptionAndRemainGood ? corrupt : 0,
		canSpendCorruptionAndRemainGood ? firepower : 0,
		canSpendCorruptionAndRemainGood && attack >= monsterHp - 0.01 ? 1 : 0
	);
	const controlledOpportunityVp = controlledKillProbability * farm.rewardVp;
	const damageReady =
		clean >= threshold ||
		(
			canSpendCorruptionAndRemainGood &&
			(corrupt >= threshold || firepower >= threshold || attack >= monsterHp - 0.01)
		);
	const nearDamage =
		clean >= threshold * 0.65 ||
		(
			canSpendCorruptionAndRemainGood &&
			(corrupt >= threshold * 0.65 || firepower >= threshold * 0.65 || attack >= monsterHp - 0.75)
		);
	const cheapLowRung =
		farm.rewardVp >= 3 &&
		controlledOpportunityVp >= 2 &&
		lives >= 2 &&
		monsterHp <= 2 &&
		nearDamage;
	if (cheapLowRung && vp < 24) return true;

	const efficientHp4Farm =
		controlledOpportunityVp >= 2 &&
		monsterHp <= 4 &&
		(vp < 18 || farm.rewardVp >= 3 || lives >= 2) &&
		nearDamage;
	if (efficientHp4Farm && vp < 24) return true;

	const reliablePrePivotHardFarm =
		vp < GOOD_TARGET_HARD_FARM_PIVOT_VP &&
		farm.rewardVp > 0 &&
		monsterHp <= 5 &&
		(damageReady || nearDamage);
	if (reliablePrePivotHardFarm) return true;

	const monsterFinishPossible =
		vp + farm.rewardVp * lives >= VP_TO_WIN &&
		(damageReady || nearDamage);
	return monsterFinishPossible;
}

function isGoodTargetExposureNavigationState(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || isEvilAlignment(player.statusLevel ?? 0)) return false;
	if ((player.statusLevel ?? 0) > 2) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (
		state.round < GOOD_TARGET_EXPOSURE_GATE_MIN_ROUND ||
		vp < GOOD_TARGET_EXPOSURE_GATE_MIN_VP ||
		vp > GOOD_TARGET_EXPOSURE_GATE_MAX_VP ||
		monsterHp < GOOD_TARGET_EXPOSURE_GATE_MIN_MONSTER_HP
	) {
		return false;
	}

	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const cheapFarmStillBest =
		farm.valid &&
		farm.farmable &&
		farm.opportunityVp >= 2 &&
		monsterHp <= 2 &&
		vp < 24;
	if (cheapFarmStillBest) return false;
	if (
		farm.valid &&
		farm.farmable &&
		farm.rewardVp >= GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP &&
		vp < GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP
	) {
		return false;
	}
	if (farm.valid && farm.opportunityVp > GOOD_TARGET_EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP) return false;
	if (farm.valid && farm.remainingOpportunityVp > GOOD_TARGET_EXPOSURE_GATE_MAX_REMAINING_FARM_VP) return false;
	return true;
}

function goodTargetExposureDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): NavigationDestination[] {
	const legal = legalDestinations(state, seat, catalog);
	const preferred: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch', 'Tidal Cove', 'Cyber City', 'Arcane Abyss'];
	return preferred.filter((destination) => legal.includes(destination));
}

function goodTargetRendezvousExposureDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const legal = legalDestinations(state, seat, catalog);
	const destinations: NavigationDestination[] = [];
	const append = (destination: NavigationDestination): void => {
		if (destination !== 'Arcane Abyss' && legal.includes(destination)) appendUniqueDestination(destinations, destination);
	};
	for (const destination of predictedDestinationsForGoodTarget(state, seat, catalog, threshold)) append(destination);
	for (const destination of PVP_HUNT_DESTINATIONS) append(destination);
	if (destinations.length === 0 && legal.includes('Arcane Abyss')) destinations.push('Arcane Abyss');
	return destinations;
}

function goodNonfallenFarmTargetPivotDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return ['Tidal Cove', 'Cyber City', 'Lantern Canyon', 'Floral Patch'];
	if (isEvilAlignment(player.statusLevel ?? 0)) return ['Floral Patch', 'Tidal Cove', 'Cyber City', 'Lantern Canyon'];
	if (shouldGoodTargetContinueAbyssFarm(state, seat, catalog, threshold)) return ['Arcane Abyss'];

	const destinations: NavigationDestination[] = [];
	const append = (destination: NavigationDestination): void => appendUniqueDestination(destinations, destination);
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const counts = awakenedClassCounts(player);
	const raw = allClassCounts(player);
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const hasRelic = (player.mats ?? []).some((r) => r.hasRune && r.type === 'relic');
	const wantsScorer =
		vp >= 18 ||
		(raw['World Ender'] ?? 0) <= 0 ||
		((raw['World Guardian'] ?? 0) <= 0 && vp >= 12) ||
		((counts.Healer ?? 0) > 0 && maxBarrier >= 8);
	const needsDamage = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < threshold && clean < threshold;
	const needsRestore = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
	const needsMaxBarrier = survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;

	if (needsDamage && monsterHp >= GOOD_TARGET_DAMAGE_REBUILD_MIN_HP) {
		if (needsMaxBarrier) return ['Lantern Canyon', 'Tidal Cove', 'Cyber City'];
		if (needsRestore) return ['Lantern Canyon', 'Floral Patch'];
		return ['Tidal Cove', 'Cyber City'];
	}

	if (vp >= 24 || wantsScorer) append('Floral Patch');
	if (needsRestore) {
		append('Floral Patch');
		append('Lantern Canyon');
	}
	if (needsMaxBarrier) append('Lantern Canyon');
	if (needsDamage || (player.attackDice?.length ?? 0) < 2 || player.spirits.length < 6 || (counts['Spirit Animal'] ?? 0) < 2) {
		append('Tidal Cove');
		if (hasRelic || state.round >= 4) append('Cyber City');
	}
	if (hasRelic) append('Cyber City');
	append('Floral Patch');
	append('Tidal Cove');
	append('Cyber City');
	append('Lantern Canyon');
	return destinations;
}

function evilPressureCount(state: PublicGameState, seat: SeatColor): number {
	return state.activeSeats.filter((s) => (
		s !== seat &&
		isEvilAlignment(state.players[s]?.statusLevel ?? 0)
	)).length;
}

function appendExistingDestination(
	out: NavigationDestination[],
	base: NavigationDestination[],
	destination: NavigationDestination
): void {
	if (base.includes(destination)) appendUniqueDestination(out, destination);
}

function goodNonfallenFarmTargetEvadeDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const base = goodNonfallenFarmTargetPivotDestinations(state, seat, catalog, threshold);
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || base[0] === 'Arcane Abyss') return base;
	const hunterCount = evilPressureCount(state, seat);
	const vp = player.victoryPoints ?? 0;
	if (hunterCount <= 0 || vp < 6) return base;

	const counts = awakenedClassCounts(player);
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const hasRelic = (player.mats ?? []).some((r) => r.hasRune && r.type === 'relic');
	const needsRestore = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
	const needsMaxBarrier = survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;
	const needsDamage = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < threshold && clean < threshold;
	const evasion: NavigationDestination[] = [];

	if (needsRestore || needsMaxBarrier || base[0] === 'Floral Patch') {
		appendExistingDestination(evasion, base, 'Lantern Canyon');
		if (hunterCount >= 2 && vp >= 12) appendUniqueDestination(evasion, 'Arcane Abyss');
		appendExistingDestination(evasion, base, 'Floral Patch');
	}
	if (needsDamage || base[0] === 'Tidal Cove' || base[0] === 'Cyber City') {
		if (hasRelic || state.round >= 4) appendExistingDestination(evasion, base, 'Cyber City');
		appendExistingDestination(evasion, base, 'Tidal Cove');
	}
	if (vp >= 18 && hunterCount >= 2) {
		appendUniqueDestination(evasion, 'Arcane Abyss');
		appendExistingDestination(evasion, base, 'Lantern Canyon');
		appendExistingDestination(evasion, base, 'Cyber City');
	}
	for (const destination of base) appendUniqueDestination(evasion, destination);
	return evasion.length > 0 ? evasion : base;
}

function goodNonfallenScoreFloorDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return ['Tidal Cove', 'Cyber City', 'Lantern Canyon', 'Floral Patch'];
	if (isEvilAlignment(player.statusLevel ?? 0)) return ['Floral Patch', 'Tidal Cove', 'Cyber City', 'Lantern Canyon'];
	if (shouldGoodTargetContinueAbyssFarm(state, seat, catalog, threshold)) return ['Arcane Abyss'];

	const destinations: NavigationDestination[] = [];
	const append = (destination: NavigationDestination): void => appendUniqueDestination(destinations, destination);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const counts = awakenedClassCounts(player);
	const pendingAugments = pendingAugmentClassCounts(player, catalog);
	const raw = allClassCounts(player);
	const spiritAnimal = counts['Spirit Animal'] ?? 0;
	const cultivatorProgress = (counts.Cultivator ?? 0) + (pendingAugments.Cultivator ?? 0);
	const hasRelic = (player.mats ?? []).some((r) => r.hasRune && r.type === 'relic');
	const canSurviveNow = survivalTarget <= 0 || barrier >= survivalTarget;
	const canRestore = survivalTarget <= 0 || maxBarrier >= survivalTarget;
	const damageReady = monsterHp <= 0 || clean >= threshold || firepower >= threshold || attack >= monsterHp - 0.01;
	const nearDamage = monsterHp <= 0 || clean >= threshold * 0.5 || firepower >= threshold * 0.5 || attack >= monsterHp - 0.75;
	const farmHasVp = farm.valid && farm.rewardVp > 0;
	const farmStillValuable =
		farmHasVp &&
		(farm.opportunityVp >= (vp < 18 ? 1.5 : 1) || monsterHp <= 4 || farm.rewardVp >= 2);
	const restoreNeeded = survivalTarget > 0 && canRestore && barrier < survivalTarget;
	const maxBarrierNeeded = survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;
	const hp4SurvivalWall =
		farmStillValuable &&
		vp >= 6 &&
		monsterHp >= 4 &&
		monsterHp <= 5 &&
		nearDamage &&
		!canSurviveNow;
	const scoreFloorReady =
		vp >= 12 ||
		attack >= 4 ||
		firepower >= threshold * 0.65 ||
		spiritAnimal >= 2 ||
		(farm.valid && farm.opportunityVp >= 3);
	const damageFloorMissing =
		monsterHp > 0 &&
		!nearDamage &&
		(attack < Math.min(5, monsterHp + 0.5) || firepower < threshold * 0.5);

	if (farmStillValuable && damageReady && canSurviveNow) return ['Arcane Abyss'];
	if (farmStillValuable && nearDamage && canSurviveNow && (vp < 24 || monsterHp <= 4)) return ['Arcane Abyss'];
	if (farmStillValuable && nearDamage && restoreNeeded) return ['Lantern Canyon', 'Floral Patch'];
	if (hp4SurvivalWall && !canRestore) {
		if (cultivatorProgress >= 2) return ['Lantern Canyon', 'Floral Patch', 'Arcane Abyss', 'Tidal Cove', 'Cyber City'];
		return hasRelic ? ['Tidal Cove'] : ['Tidal Cove', 'Cyber City'];
	}
	if (farmHasVp && monsterHp >= 4 && maxBarrierNeeded && vp >= 6) {
		return ['Lantern Canyon', 'Tidal Cove', 'Cyber City'];
	}
	if (farmStillValuable && nearDamage && !canSurviveNow && !canRestore) {
		return (counts.Cultivator ?? 0) >= 2
			? ['Lantern Canyon', 'Tidal Cove', 'Cyber City']
			: ['Tidal Cove', 'Cyber City'];
	}
	if (maxBarrierNeeded && nearDamage) return ['Lantern Canyon', 'Tidal Cove', 'Cyber City'];

	if (damageFloorMissing || (!scoreFloorReady && attack < 4 && firepower < threshold * 0.65)) {
		append('Tidal Cove');
		append('Cyber City');
		if (restoreNeeded && nearDamage) append('Lantern Canyon');
		return destinations;
	}

	if (farmStillValuable && canSurviveNow) append('Arcane Abyss');
	if (restoreNeeded) {
		append('Lantern Canyon');
		append('Floral Patch');
		if (farmHasVp && nearDamage && !canSurviveNow) return destinations;
	}
	if (maxBarrierNeeded) append('Lantern Canyon');

	const wantsPassiveScorer =
		vp >= 18 ||
		(vp >= 12 && (raw['World Ender'] ?? 0) <= 0) ||
		(vp >= 15 && (raw['World Guardian'] ?? 0) <= 0) ||
		((counts.Healer ?? 0) > 0 && maxBarrier >= 8);
	if (wantsPassiveScorer) append('Floral Patch');
	if (hasRelic || state.round >= 6) append('Cyber City');
	append('Tidal Cove');
	append('Cyber City');
	append('Lantern Canyon');
	append('Floral Patch');
	append('Arcane Abyss');
	return destinations;
}

function nearFinishNavigationOracleDestination(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number,
	maxRounds: number
): NavigationDestination | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return null;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (state.round < 16 || vp < 24 || vp >= VP_TO_WIN || monsterHp < 4 || monsterHp > 5) return null;

	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const livesRemaining = Math.max(1, farm.livesRemaining ?? monster.livesRemaining ?? 1);
	const rewardFinishPossible =
		farm.valid &&
		farm.rewardVp > 0 &&
		vp + farm.rewardVp * livesRemaining >= VP_TO_WIN;
	const lateNearMiss = vp >= 25 && state.round >= 20;
	if (!rewardFinishPossible && !lateNearMiss) return null;

	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const damageReady = cleanProb >= threshold || firepowerProb >= threshold || attack >= monsterHp - 0.01;
	if (!damageReady) return null;

	const survivalTarget = (monster.damage ?? 0) + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const currentBarrier = player.barrier ?? 0;
	if (survivalTarget <= 0) return firstLegalNavigationDestination(state, seat, catalog, ['Arcane Abyss']);

	const canSurviveNow = currentBarrier >= survivalTarget;
	const canRestore = maxBarrier >= survivalTarget;
	const needsBuffer = currentBarrier < Math.min(maxBarrier, survivalTarget + 3);
	const abyss = firstLegalNavigationDestination(state, seat, catalog, ['Arcane Abyss']);
	if (canSurviveNow && (!needsBuffer || state.round >= maxRounds - 1)) return abyss;
	if (!canRestore) return firstLegalNavigationDestination(state, seat, catalog, ['Floral Patch', 'Lantern Canyon']);

	const largeDeficit = survivalTarget - currentBarrier >= 3;
	const deepBufferDeficit = lateNearMiss && currentBarrier < Math.min(maxBarrier, survivalTarget + 3);
	if ((largeDeficit || deepBufferDeficit) && state.round <= maxRounds - 2) {
		return firstLegalNavigationDestination(state, seat, catalog, ['Floral Patch', 'Lantern Canyon']) ?? abyss;
	}
	return firstLegalNavigationDestination(state, seat, catalog, ['Lantern Canyon', 'Floral Patch']) ?? abyss;
}

const PVP_HUNT_DESTINATIONS: NavigationDestination[] = [
	'Floral Patch',
	'Cyber City',
	'Tidal Cove',
	'Lantern Canyon'
];

function pvpHuntDestinations(
	state: PublicGameState,
	seat: SeatColor
): NavigationDestination[] {
	const visible = visiblePvpHuntDestinations(state, seat);
	const destinations: NavigationDestination[] = [...visible];
	for (const fallback of PVP_HUNT_DESTINATIONS) {
		if (!destinations.includes(fallback)) destinations.push(fallback);
	}
	return destinations;
}

function visiblePvpHuntDestinations(
	state: PublicGameState,
	seat: SeatColor
): NavigationDestination[] {
	const scored = state.activeSeats
		.filter((s) => s !== seat)
		.map((s) => state.players[s])
		.filter((player) =>
			player &&
			player.navigationDestination &&
			player.navigationDestination !== 'Arcane Abyss' &&
			!isEvilAlignment(player.statusLevel ?? 0)
		)
		.map((player) => ({
			destination: player!.navigationDestination as NavigationDestination,
			vp: player!.victoryPoints ?? 0
		}))
		.sort((a, b) => b.vp - a.vp || PVP_HUNT_DESTINATIONS.indexOf(a.destination) - PVP_HUNT_DESTINATIONS.indexOf(b.destination));
	const destinations: NavigationDestination[] = [];
	for (const target of scored) {
		if (!destinations.includes(target.destination)) destinations.push(target.destination);
	}
	return destinations;
}

function predictedDestinationsForGoodTarget(
	state: PublicGameState,
	targetSeat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const target = state.players[targetSeat];
	if (!target || isEvilAlignment(target.statusLevel ?? 0)) return [];
	if (
		shouldGoodTargetContinueAbyssFarm(state, targetSeat, catalog, threshold) &&
		(target.victoryPoints ?? 0) < 28
	) {
		return [];
	}

	const targetMonster = state.monster;
	const counts = awakenedClassCounts(target);
	const destinations: NavigationDestination[] = [];
	const append = (destination: NavigationDestination): void => appendUniqueDestination(destinations, destination);
	const survivalTarget = targetMonster ? (targetMonster.damage ?? 0) + 1 : 0;
	const barrier = target.barrier ?? 0;
	const maxBarrier = target.maxBarrier ?? 0;
	const attackDice = target.attackDice?.length ?? 0;
	const targetAttack = expectedAttack(target);
	const monsterHp = targetMonster ? targetMonster.maxHp ?? targetMonster.hp ?? 0 : 0;

	if (survivalTarget > 0 && barrier < Math.min(maxBarrier, survivalTarget)) append('Floral Patch');
	if (barrier < maxBarrier - 1) append('Floral Patch');
	if (survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2) append('Lantern Canyon');
	if (attackDice < 2 || target.spirits.length < 5 || (monsterHp > 0 && targetAttack < monsterHp)) append('Tidal Cove');
	if ((target.mats ?? []).some((r) => r.hasRune && r.type === 'relic')) append('Cyber City');
	if (destinations.length === 0 && (target.victoryPoints ?? 0) >= 18) append('Floral Patch');
	return destinations;
}

function predictedGoodTargetDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const scored = state.activeSeats
		.filter((s) => s !== seat)
		.map((targetSeat) => {
			const target = state.players[targetSeat];
			const destinations = predictedDestinationsForGoodTarget(state, targetSeat, catalog, threshold);
			if (!target || destinations.length === 0) return null;

			return {
				targetSeat,
				vp: target.victoryPoints ?? 0,
				destinations
			};
		})
		.filter((x): x is { targetSeat: SeatColor; vp: number; destinations: NavigationDestination[] } => !!x && x.destinations.length > 0)
		.sort((a, b) => b.vp - a.vp);
	const destinations: NavigationDestination[] = [];
	for (const target of scored) {
		for (const destination of target.destinations) {
			if (!destinations.includes(destination)) destinations.push(destination);
		}
	}
	return destinations;
}

function pvpHuntOrAbyssDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const visible = visiblePvpHuntDestinations(state, seat);
	const hunt = visible.length > 0
		? visible
		: predictedGoodTargetDestinations(state, seat, catalog, threshold);
	const destinations: NavigationDestination[] = [...hunt];
	if (!destinations.includes('Arcane Abyss')) destinations.push('Arcane Abyss');
	return destinations;
}

function bestGoodTargetVp(state: PublicGameState, seat: SeatColor): number {
	let best = 0;
	for (const targetSeat of state.activeSeats) {
		if (targetSeat === seat) continue;
		const target = state.players[targetSeat];
		if (!target || isEvilAlignment(target.statusLevel ?? 0)) continue;
		best = Math.max(best, target.victoryPoints ?? 0);
	}
	return best;
}

function goodTargetValuePivotDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number,
	dryHuntStreak = 0,
	lastDryDestination?: NavigationDestination,
	allowBlindHunt = false
): NavigationDestination[] {
	const visible = visiblePvpHuntDestinations(state, seat);
	if (visible.length > 0) return visible;
	const predicted = predictedGoodTargetDestinations(state, seat, catalog, threshold);
	if (predicted.length > 0 && dryHuntStreak < 2) return predicted;
	const bestTargetReady = bestGoodTargetVp(state, seat) >= PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP;
	if (bestTargetReady || allowBlindHunt || predicted.length > 0) {
		const destinations: NavigationDestination[] = [];
		for (const destination of predicted) {
			if (destination !== lastDryDestination) appendUniqueDestination(destinations, destination);
		}
		for (const destination of PVP_HUNT_DESTINATIONS) {
			if (destination !== lastDryDestination) appendUniqueDestination(destinations, destination);
		}
		return destinations.length > 0 ? destinations : PVP_HUNT_DESTINATIONS;
	}
	return bestTargetReady
		? PVP_HUNT_DESTINATIONS
		: [];
}

function shouldGoodTargetLowTailHunt(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	if (PVP_LOW_TAIL_HUNT_MAX_VP < 0) return false;
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) < 3) return false;
	const vp = player.victoryPoints ?? 0;
	if (vp <= 0 || vp > PVP_LOW_TAIL_HUNT_MAX_VP || vp >= VP_TO_WIN) return false;
	if (state.round < PVP_LOW_TAIL_HUNT_MIN_ROUND) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (monsterHp < PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP) return false;
	if (bestGoodTargetVp(state, seat) < PVP_LOW_TAIL_HUNT_MIN_TARGET_VP) return false;
	const hasGoodTarget = state.activeSeats.some((targetSeat) => {
		if (targetSeat === seat) return false;
		const target = state.players[targetSeat];
		return !!target && !isEvilAlignment(target.statusLevel ?? 0);
	});
	if (!hasGoodTarget) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const cheapFarmStillBest =
		farm.valid &&
		farm.farmable &&
		farm.opportunityVp >= 2 &&
		(monsterHp <= 2 || (farm.rewardVp >= 3 && (farm.livesRemaining ?? 1) >= 2)) &&
		vp < 24;
	return !cheapFarmStillBest;
}

function shouldGoodTargetValuePivotHunt(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) < 3) return false;
	const vp = player.victoryPoints ?? 0;
	if (vp >= VP_TO_WIN || state.round < 10) return false;

	const lowTailHunt = shouldGoodTargetLowTailHunt(state, seat, catalog, threshold);
	const destinations = goodTargetValuePivotDestinations(state, seat, catalog, threshold, 0, undefined, lowTailHunt);
	const bestTargetVp = bestGoodTargetVp(state, seat);
	if (
		destinations.length === 0 ||
		(
			bestTargetVp < PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP &&
			!lowTailHunt
		)
	) return false;

	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const killProb = Math.max(clean, firepower * 0.85);
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const rewardVp = farm.valid ? Math.max(0, farm.rewardVp) : 0;
	const lives = Math.max(1, farm.valid ? farm.livesRemaining : monster.livesRemaining ?? 1);
	const monsterNextEv = rewardVp * killProb;
	const remainingMonsterEv = monsterNextEv * lives;
	const finishNeeded = Math.max(0, VP_TO_WIN - vp);
	const pvpEv = visiblePvpHuntDestinations(state, seat).length > 0 ? 3 : 2.1;

	if (finishNeeded <= 3) return true;

	const cheapFarmStillBest =
		farm.valid &&
		rewardVp >= 3 &&
		lives >= 2 &&
		monsterHp <= 2 &&
		killProb >= 0.3 &&
		vp < 24;
	if (cheapFarmStillBest) return false;

		const reliableMonsterFinish =
			farm.valid &&
			rewardVp > 0 &&
			(clean >= threshold || firepower >= threshold) &&
			rewardVp * lives >= finishNeeded &&
			monsterNextEv >= pvpEv * 0.8;
		if (reliableMonsterFinish) return false;
		if (lowTailHunt) return true;

		const highValueTarget = bestTargetVp >= 18;
	if (vp < 12 && !highValueTarget) return false;
	const targetPressure = highValueTarget ? 0.9 : 0.65;
	if (monsterHp >= PVP_GOOD_TARGET_PIVOT_MIN_MONSTER_HP && monsterNextEv < pvpEv * targetPressure) return true;
	if (vp >= 24 && remainingMonsterEv + 0.5 < finishNeeded) return true;
	if (highValueTarget && monsterHp >= PVP_GOOD_TARGET_PIVOT_MIN_MONSTER_HP && killProb < threshold * 0.8) return true;
	return false;
}

function shouldGoodTargetValuePivotDescend(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	if (!player || (player.statusLevel ?? 0) >= 3) return false;
	if (bestGoodTargetVp(state, seat) < PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP) return false;
	if (goodTargetValuePivotDestinations(state, seat, catalog, threshold).length === 0) return false;
	return isLatePvpDescendCandidate(state, seat, catalog, threshold);
}

function appendUniqueDestination(destinations: NavigationDestination[], destination: NavigationDestination | undefined): void {
	if (destination && !destinations.includes(destination)) destinations.push(destination);
}

function fallenPredictedHuntDestinationsWithFallback(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number,
	dryHuntStreak: number,
	lastDryDestination?: NavigationDestination
): NavigationDestination[] {
	const visible = visiblePvpHuntDestinations(state, seat);
	if (visible.length > 0) return visible;
	const predicted = predictedGoodTargetDestinations(state, seat, catalog, threshold);
	if (dryHuntStreak < 2) return predicted;

	const destinations: NavigationDestination[] = [];
	for (const destination of predicted) {
		if (destination !== lastDryDestination) appendUniqueDestination(destinations, destination);
	}
	for (const destination of PVP_HUNT_DESTINATIONS) {
		if (destination !== lastDryDestination) appendUniqueDestination(destinations, destination);
	}
	appendUniqueDestination(destinations, 'Arcane Abyss');
	return destinations;
}

function fallenCanContinueAbyssFarm(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	return (
		farm.valid &&
		farm.rewardVp > 0 &&
		(
			farm.farmable ||
			clean >= threshold ||
			firepower >= threshold ||
			attack >= monsterHp - 0.01
		)
	);
}

function fallenRebuildDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination[] {
	const visible = visiblePvpHuntDestinations(state, seat);
	if (visible.length > 0) return visible;
	if (fallenCanContinueAbyssFarm(state, seat, catalog, threshold)) return ['Arcane Abyss'];

	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return ['Arcane Abyss'];

	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const survivalTarget = (monster.damage ?? 0) + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const needsDamage =
		monsterHp > 0 &&
		attack < monsterHp + 0.5 &&
		firepower < threshold &&
		clean < threshold;
	const needsSurvival =
		survivalTarget > 0 &&
		(maxBarrier < survivalTarget || barrier < Math.min(maxBarrier, survivalTarget));
	const destinations: NavigationDestination[] = [];

	if (needsDamage) {
		appendUniqueDestination(destinations, 'Tidal Cove');
		appendUniqueDestination(destinations, 'Cyber City');
		appendUniqueDestination(destinations, 'Lantern Canyon');
	}
	if (needsSurvival) {
		appendUniqueDestination(destinations, 'Floral Patch');
		appendUniqueDestination(destinations, 'Lantern Canyon');
	}
	if (!needsDamage && !needsSurvival) {
		for (const destination of PVP_HUNT_DESTINATIONS) appendUniqueDestination(destinations, destination);
	}
	appendUniqueDestination(destinations, 'Arcane Abyss');
	return destinations;
}

function fallenPredictedHuntDestinationsWithFallbackAndRebuild(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number,
	dryHuntStreak: number,
	lastDryDestination?: NavigationDestination
): NavigationDestination[] {
	const visible = visiblePvpHuntDestinations(state, seat);
	if (visible.length > 0) return visible;
	if (bestGoodTargetVp(state, seat) >= PVP_REBUILD_SKIP_TARGET_VP) {
		return fallenPredictedHuntDestinationsWithFallback(
			state,
			seat,
			catalog,
			threshold,
			dryHuntStreak,
			lastDryDestination
		);
	}
	const predicted = predictedGoodTargetDestinations(state, seat, catalog, threshold);
	if (dryHuntStreak < 2 && predicted.length > 0) return predicted;
	if (!fallenCanContinueAbyssFarm(state, seat, catalog, threshold)) {
		return fallenRebuildDestinations(state, seat, catalog, threshold)
			.filter((destination) => destination !== lastDryDestination);
	}
	return fallenPredictedHuntDestinationsWithFallback(
		state,
		seat,
		catalog,
		threshold,
		dryHuntStreak,
		lastDryDestination
	);
}

function shouldFallenRebuildRoute(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	if (!player || (player.statusLevel ?? 0) < 3 || (player.victoryPoints ?? 0) >= VP_TO_WIN) return false;
	if (state.round < PVP_REBUILD_MIN_ROUND) return false;
	if (visiblePvpHuntDestinations(state, seat).length > 0) return true;
	return !fallenCanContinueAbyssFarm(state, seat, catalog, threshold);
}

function routeModeHuntProbability(
	policy: NeuralPolicy | undefined,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): number | null {
	if (!policy) return null;
	const fn = (policy as unknown as { routeMode?: (obs: number[]) => number | null }).routeMode;
	if (!fn) return null;
	const value = fn.call(policy, encodeObs(state, seat, catalog));
	return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : null;
}

function shouldPredictivePvpHunt(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) < 3) return false;
	const vp = player.victoryPoints ?? 0;
	if (vp >= VP_TO_WIN || state.round < 10) return false;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const finishNeeded = Math.max(0, VP_TO_WIN - vp);
	const monsterCanFinish =
		farm.valid &&
		farm.rewardVp > 0 &&
		(clean >= threshold || firepower >= threshold) &&
		farm.rewardVp * Math.max(1, farm.livesRemaining) >= finishNeeded;
	if (monsterCanFinish) return false;
	if (vp < 24) return clean < 0.25 && firepower < 0.25 && (monster.maxHp ?? monster.hp ?? 0) >= 4;
	if (vp < 27 && (clean >= threshold * 0.7 || firepower >= threshold * 0.7)) return false;
	return true;
}

function shouldPredictivePvpFinishHunt(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) < 3) return false;
	const vp = player.victoryPoints ?? 0;
	if (vp >= VP_TO_WIN || state.round < 10) return false;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const finishNeeded = Math.max(0, VP_TO_WIN - vp);
	const pvpCanFinish = finishNeeded <= 3;
	const monsterCanFinish =
		farm.valid &&
		farm.rewardVp > 0 &&
		(clean >= threshold || firepower >= threshold) &&
		farm.rewardVp * Math.max(1, farm.livesRemaining) >= finishNeeded;
	if (pvpCanFinish) return true;
	if (monsterCanFinish) return false;
	if (vp < 24) return false;
	if (vp < 27) return clean < 0.2 && firepower < 0.2 && (monster.maxHp ?? monster.hp ?? 0) >= 4;
	return clean < threshold * 0.7 && firepower < threshold * 0.7;
}

function shouldPredictivePvpValueHunt(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) < 3) return false;
	const vp = player.victoryPoints ?? 0;
	if (vp >= VP_TO_WIN || state.round < 10) return false;

	const visible = visiblePvpHuntDestinations(state, seat);
	const predicted = visible.length > 0 ? [] : predictedGoodTargetDestinations(state, seat, catalog, threshold);
	if (visible.length === 0 && predicted.length === 0) return false;

	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const finishNeeded = Math.max(0, VP_TO_WIN - vp);
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const killProb = Math.max(clean, firepower * 0.85);
	const monsterNextEv = farm.valid && farm.rewardVp > 0 ? killProb * farm.rewardVp : 0;
	const remainingMonsterEv = monsterNextEv * Math.max(1, farm.livesRemaining);
	const pvpEv = visible.length > 0 ? 3 : 2.1;

	if (finishNeeded <= 3) return true;

	const cheapLowRungFarm =
		farm.valid &&
		farm.rewardVp >= 3 &&
		farm.livesRemaining >= 2 &&
		monsterHp <= 2 &&
		killProb >= 0.3;
	if (cheapLowRungFarm && vp < 24) return false;

	const reliableMonsterLine =
		farm.valid &&
		farm.rewardVp > 0 &&
		(clean >= threshold || firepower >= threshold) &&
		monsterNextEv >= pvpEv * 0.8;
	if (reliableMonsterLine && remainingMonsterEv >= finishNeeded && vp >= 24) return false;

	if (vp < 18) return false;
	if (vp < 24) return monsterHp >= 4 && monsterNextEv < pvpEv * 0.55;
	if (vp < 27) return monsterNextEv < pvpEv * 0.75 || remainingMonsterEv + 1 < finishNeeded;
	return monsterNextEv < pvpEv * 0.9 || remainingMonsterEv + 0.5 < finishNeeded || killProb < threshold * 0.7;
}

function pvpPivotOracleDestination(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number,
	predictive = false
): NavigationDestination | null {
	const player = state.players[seat];
	if (!player || (player.statusLevel ?? 0) < 3 || (player.victoryPoints ?? 0) >= VP_TO_WIN) return null;
	const visible = visiblePvpHuntDestinations(state, seat);
	if (visible.length > 0) return firstLegalNavigationDestination(state, seat, catalog, visible);
	if (!predictive || !shouldPredictivePvpHunt(state, seat, catalog, threshold)) return null;
	return firstLegalNavigationDestination(
		state,
		seat,
		catalog,
		predictedGoodTargetDestinations(state, seat, catalog, threshold)
	);
}

function isLatePvpDescendCandidate(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) >= 3) return false;
	const vp = player.victoryPoints ?? 0;
	if (vp < 18 || vp >= VP_TO_WIN || state.round < 10) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	if (farm.valid && farm.farmable && farm.opportunityVp >= 2 && vp < 24) return false;
	const cursed = pvpClassCount(state, seat, 'Cursed Spirit');
	const sharpshooter = pvpClassCount(state, seat, 'Sharpshooter');
	const hasCoreSeed = cursed >= 1 || sharpshooter >= 1 || player.spirits.length >= 5;
	if (!hasCoreSeed && (player.statusLevel ?? 0) === 0) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	return (player.statusLevel ?? 0) > 0 || monsterHp >= 4 || vp >= 24;
}

function pvpLateDescendOracleDestination(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number,
	predictive = false
): NavigationDestination | null {
	const hunt = pvpPivotOracleDestination(state, seat, catalog, threshold, predictive);
	if (hunt) return hunt;
	if (!isLatePvpDescendCandidate(state, seat, catalog, threshold)) return null;
	return firstLegalNavigationDestination(state, seat, catalog, ['Arcane Abyss']);
}

function pvpStatus2TargetDescendOracleDestination(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.victoryPoints ?? 0) >= VP_TO_WIN) return null;
	if ((player.statusLevel ?? 0) !== 2) return null;
	if (state.round < 12) return null;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (monsterHp < PVP_GOOD_TARGET_PIVOT_MIN_MONSTER_HP) return null;
	if (bestGoodTargetVp(state, seat) < PVP_STATUS2_DESCEND_MIN_TARGET_VP) return null;

	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const cheapFarmStillBest = farm.valid && farm.farmable && farm.opportunityVp >= 2 && (player.victoryPoints ?? 0) < 24;
	if (cheapFarmStillBest) return null;

	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	if (clean >= threshold || firepower >= threshold) return null;

	return firstLegalNavigationDestination(state, seat, catalog, ['Arcane Abyss']);
}

function pvpStatus2ConversionDescendOracleDestination(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): NavigationDestination | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.victoryPoints ?? 0) >= VP_TO_WIN) return null;
	if ((player.statusLevel ?? 0) !== 2) return null;
	if (state.round < 12) return null;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (monsterHp < PVP_GOOD_TARGET_PIVOT_MIN_MONSTER_HP) return null;
	const hasGoodTarget = state.activeSeats.some((targetSeat) => {
		if (targetSeat === seat) return false;
		const target = state.players[targetSeat];
		return !!target && !isEvilAlignment(target.statusLevel ?? 0);
	});
	if (!hasGoodTarget) return null;

	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const cheapFarmStillBest = farm.valid && farm.farmable && farm.opportunityVp >= 2 && (player.victoryPoints ?? 0) < 24;
	if (cheapFarmStillBest) return null;

	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	if (clean >= threshold || firepower >= threshold) return null;

	return firstLegalNavigationDestination(state, seat, catalog, ['Arcane Abyss']);
}

function pvpClassCount(state: PublicGameState, seat: SeatColor, className: string): number {
	const player = state.players[seat];
	if (!player) return 0;
	let total = 0;
	for (const spirit of player.spirits ?? []) {
		total += spirit.classes?.[className] ?? 0;
	}
	return total;
}

function isPvpPivotState(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	threshold: number
): boolean {
	const player = state.players[seat];
	if (!player || (player.victoryPoints ?? 0) >= VP_TO_WIN || state.round < 6) return false;
	if ((player.statusLevel ?? 0) >= 3) return visiblePvpHuntDestinations(state, seat).length > 0;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = state.monster ? state.monster.maxHp ?? state.monster.hp ?? 0 : 0;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const farmStillGood = farm.valid && farm.farmable && farm.opportunityVp >= 2;
	if ((player.statusLevel ?? 0) > 0) {
		if (farmStillGood && vp < 24) return false;
		return vp >= 18 || state.round >= 12 || monsterHp >= 4;
	}
	const cursed = pvpClassCount(state, seat, 'Cursed Spirit');
	const sharpshooter = pvpClassCount(state, seat, 'Sharpshooter');
	const hasCoreSeed = cursed >= 1 || sharpshooter >= 1 || player.spirits.length >= 5;
	if (!hasCoreSeed) return false;
	if (farmStillGood) return false;
	const attack = expectedAttack(player);
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const damageReady = firepowerProb >= threshold || attack >= Math.max(1, monsterHp - 0.5);
	if (!damageReady) return false;
	return state.round >= 12 && vp >= 18 && monsterHp >= 4;
}

interface CombatOpportunityFlags {
	legalCombat: boolean;
	clean: boolean;
	firepower: boolean;
	corruptOnly: boolean;
}

interface PvpOpportunityInfo {
	legal: boolean;
	targetCount: number;
	targetVp: number;
	bestTargetVp: number;
	targets: string[];
	hardMonsterWindow: boolean;
	goodTargetPivotWindow: boolean;
}

function pvpEncounterTargets(state: PublicGameState, seat: SeatColor, legal: boolean): PvpOpportunityInfo {
	const dest = state.players[seat]?.navigationDestination ?? null;
	const targets = !legal || !dest || dest === 'Arcane Abyss'
		? []
		: state.activeSeats
			.filter((s) =>
				s !== seat &&
				state.players[s]?.navigationDestination === dest &&
				!isEvilAlignment(state.players[s]?.statusLevel ?? 0)
			)
			.map((targetSeat) => {
				const target = state.players[targetSeat]!;
				return {
					seat: targetSeat,
					vp: target.victoryPoints ?? 0
				};
			})
			.sort((a, b) => b.vp - a.vp || a.seat.localeCompare(b.seat));
	const targetVp = targets.reduce((sum, target) => sum + target.vp, 0);
	const hardMonsterWindow =
		legal &&
		((state.monster?.maxHp ?? state.monster?.hp ?? 0) >= PVP_GOOD_TARGET_PIVOT_MIN_MONSTER_HP);
	return {
		legal,
		targetCount: targets.length,
		targetVp,
		bestTargetVp: targets[0]?.vp ?? 0,
		targets: targets.map((target) => `${target.seat}:${target.vp}`),
		hardMonsterWindow,
		goodTargetPivotWindow:
			hardMonsterWindow &&
			(targets[0]?.vp ?? 0) >= PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP
	};
}

function shouldForceHardMonsterPvpAttack(
	state: PublicGameState,
	seat: SeatColor,
	opportunity: PvpOpportunityInfo
): boolean {
	const player = state.players[seat];
	if (!player || !isEvilAlignment(player.statusLevel ?? 0)) return false;
	if ((player.victoryPoints ?? 0) >= VP_TO_WIN) return false;
	if (state.phase !== 'encounter') return false;
	return opportunity.legal && opportunity.hardMonsterWindow;
}


export { clamp01 };
export type { FarmNavigationOracle };
export {
	FARM_ACTION_TYPES,
	REWARD_ACTION_TYPES,
	GOOD_BUILDER_HP4_PICK_ACTION_TYPES,
	GOOD_BUILDER_SCORE_PICK_ACTION_TYPES,
	GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES,
	GOOD_BUILDER_HP4_SCOREFLOOR_ACTION_TYPES,
	GOOD_BUILDER_SCORE_CONVERSION_ACTION_TYPES,
	PVP_FORCE_HIGH_VALUE_TARGET_VP
};
export type { CombatOpportunityFlags, PvpOpportunityInfo };
export {
	preservesRouteHandDrawOpportunity,
	preservesRouteFirepower,
	preservesRouteSurvival,
	filterGoodTargetActionDisciplineActions,
	filterAbyssRouteDisciplineActions,
	isRouteCloserFullActionState,
	isRouteCloserRestoreFinishState,
	filterConstrainedPlan,
	isGoodBuilderHp4ConversionOverlayState,
	isGoodBuilderHp4ConversionOverlayAction,
	abyssFarmPayoffScore,
	chooseGoodBuilderOracleAction,
	goodBuilderHp4ScoreFloorActionScore,
	chooseGoodBuilderHp4ScoreFloorOracleAction,
	cleanFarmableFlags,
	combatReadyButNeedsRestore,
	goodBuilderOracleDestinations,
	goodBuilderFarmerOracleDestinations,
	goodBuilderSupportOracleDestinations,
	goodBuilderNoncontestSupportDestinations,
	goodNonfallenFarmBuildDestinations,
	isGoodTargetExposureNavigationState,
	goodTargetExposureDestinations,
	goodTargetRendezvousExposureDestinations,
	goodNonfallenFarmTargetPivotDestinations,
	goodNonfallenFarmTargetEvadeDestinations,
	goodNonfallenScoreFloorDestinations,
	nearFinishNavigationOracleDestination,
	visiblePvpHuntDestinations,
	predictedGoodTargetDestinations,
	pvpHuntOrAbyssDestinations,
	bestGoodTargetVp,
	goodTargetValuePivotDestinations,
	shouldGoodTargetLowTailHunt,
	shouldGoodTargetValuePivotHunt,
	shouldGoodTargetValuePivotDescend,
	fallenPredictedHuntDestinationsWithFallback,
	fallenCanContinueAbyssFarm,
	fallenRebuildDestinations,
	fallenPredictedHuntDestinationsWithFallbackAndRebuild,
	shouldFallenRebuildRoute,
	routeModeHuntProbability,
	shouldPredictivePvpHunt,
	shouldPredictivePvpFinishHunt,
	shouldPredictivePvpValueHunt,
	pvpPivotOracleDestination,
	pvpLateDescendOracleDestination,
	pvpStatus2TargetDescendOracleDestination,
	pvpStatus2ConversionDescendOracleDestination,
	isPvpPivotState,
	pvpEncounterTargets,
	shouldForceHardMonsterPvpAttack
};
