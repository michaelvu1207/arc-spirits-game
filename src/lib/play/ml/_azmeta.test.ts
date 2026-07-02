/**
 * AlphaZero META DISCOVERY. Runs all-planner-seat games with the current weights and writes a
 * compact strategy fingerprint: VP pace, corruption, combat/monster farming, barrier economy, and
 * awakened class composition. Opt-in via AZMETA=1.
 *
 *   AZMETA=1 AZMETA_GAMES=24 AZMETA_ITERS=160 AZMETA_WEIGHTS=ml/weights/policy.json \
 *     npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { awakenedClassCounts } from '../effects/apply';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type PrivatePlayerState, type SeatColor } from '../types';
import { loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import {
	playPlannerSelfPlayGame,
	type MicroPolicyGate,
	type NavigationPolicyGate,
	type PvpPivotOracle
} from './selfplay';

const RUN = process.env.AZMETA === '1';

function parseForbidTypes(): Set<GameCommand['type']> | undefined {
	const raw = process.env.AZMETA_FORBID_TYPES ?? process.env.AZ_FORBID_TYPES ?? process.env.AZ_FORBID;
	if (!raw) return undefined;
	const types = raw.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][];
	return types.length > 0 ? new Set(types) : undefined;
}

function parseNavigationPolicyGate(raw: string | undefined, fallback: NavigationPolicyGate): NavigationPolicyGate {
	if (
		raw === 'all' ||
		raw === 'unsafe-firepower' ||
		raw === 'unsafe-firepower-build-option' ||
		raw === 'midroute-scaling' ||
		raw === 'route-option-scaling' ||
		raw === 'clean-farm-q' ||
		raw === 'pure-farm-build' ||
			raw === 'good-nonfallen-farm-build' ||
			raw === 'good-nonfallen-farm-target-pivot' ||
			raw === 'good-nonfallen-farm-target-evade' ||
			raw === 'good-nonfallen-score-floor' ||
			raw === 'good-builder-oracle' ||
			raw === 'good-builder-farmer-oracle' ||
			raw === 'good-builder-support-oracle' ||
			raw === 'good-builder-noncontest-support-oracle' ||
			raw === 'hp2-survival-deficit' ||
		raw === 'hp4-first-wall' ||
		raw === 'route-closer' ||
		raw === 'route-finish-loop' ||
		raw === 'survival-rebuild' ||
		raw === 'pvp-pivot' ||
		raw === 'pvp-predictive-pivot' ||
		raw === 'pvp-predictive-mode-pivot' ||
		raw === 'pvp-predictive-mode-hunt-fallback-pivot' ||
		raw === 'pvp-predictive-mode-hunt-fallback-rebuild-pivot' ||
		raw === 'pvp-predictive-flex-pivot' ||
		raw === 'pvp-predictive-value-pivot' ||
		raw === 'pvp-predictive-finish-pivot' ||
		raw === 'pvp-good-target-value-pivot'
	) return raw;
	return fallback;
}

function parseMicroPolicyGate(raw: string | undefined, fallback: MicroPolicyGate): MicroPolicyGate {
	if (
		raw === 'all' ||
		raw === 'abyss-round' ||
		raw === 'abyss-farm-actions' ||
		raw === 'abyss-reward-actions' ||
		raw === 'abyss-farm-overlay' ||
		raw === 'good-builder-oracle' ||
		raw === 'good-builder-farmer-oracle' ||
		raw === 'good-builder-support-oracle' ||
		raw === 'good-builder-hp4-oracle' ||
		raw === 'good-builder-hp4-pick-oracle' ||
		raw === 'good-builder-hp4-conversion-overlay' ||
		raw === 'good-builder-hp4-conversion-oracle' ||
		raw === 'good-builder-hp4-scorefloor-oracle' ||
		raw === 'good-builder-score-pick-oracle' ||
		raw === 'good-builder-score-conversion-oracle' ||
		raw === 'location-interactions' ||
		raw === 'route-closer-full' ||
		raw === 'route-closer-oracle' ||
		raw === 'route-finish-oracle' ||
		raw === 'pvp-pivot' ||
		raw === 'pvp-pivot-encounter-force' ||
		raw === 'pvp-high-value-encounter-force'
	) return raw;
	return fallback;
}

function parsePvpPivotOracle(raw: string | undefined): PvpPivotOracle {
	if (
		raw === 'fallen-hunt' ||
		raw === 'late-descend-hunt' ||
		raw === 'fallen-predictive-hunt' ||
		raw === 'late-descend-predictive-hunt' ||
		raw === 'status2-conversion-descend' ||
		raw === 'status2-target-descend'
	) return raw;
	return 'off';
}

function topN(counts: Record<string, number>, n: number): Record<string, number> {
	return Object.fromEntries(
		Object.entries(counts)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
	);
}

function addClassCounts(dst: Record<string, number>, player: PrivatePlayerState): void {
	const counts = awakenedClassCounts(player);
	for (const [name, count] of Object.entries(counts)) dst[name] = (dst[name] ?? 0) + count;
}

function inferStrategy(row: {
	avg_status: number;
	monster_kills_per_seat_game: number;
	monster_combats_per_seat_game: number;
	abyss_navs_per_seat_game: number;
	avg_max_barrier: number;
	avg_attack_dice: number;
	top_classes: Record<string, number>;
}): string {
	if (row.avg_status >= 2.5) return 'fallen-corruption';
	if ((row.top_classes['Cursed Spirit'] ?? 0) > (row.top_classes.Cultivator ?? 0) && row.avg_status >= 1.5) {
		return 'cursed-spirit-corruption';
	}
	if (row.monster_kills_per_seat_game >= 1 || row.monster_combats_per_seat_game >= 3) return 'abyss-monster-farm';
	if ((row.top_classes.Cultivator ?? 0) >= 2 || row.avg_max_barrier >= 9) return 'cultivator-barrier-economy';
	if ((row.top_classes['Golden Ruler'] ?? 0) + (row.top_classes['World Ender'] ?? 0) >= 2) return 'passive-vp-engine';
	if (row.avg_attack_dice >= 4) return 'combat-dice-scaling';
	if (row.abyss_navs_per_seat_game >= 2) return 'abyss-probing';
	return 'mixed-or-unresolved';
}

describe('AlphaZero meta discovery', () => {
	(RUN ? it : it.skip)(
		'fingerprint all-planner self-play meta',
		async () => {
			const games = parseInt(process.env.AZMETA_GAMES ?? '24', 10);
			const iterations = parseInt(process.env.AZMETA_ITERS ?? '160', 10);
			const horizon = parseInt(process.env.AZMETA_HORIZON ?? '30', 10);
			const valueWeight = parseFloat(process.env.AZMETA_VALUEW ?? '1');
			const seatsN = parseInt(process.env.AZMETA_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.AZMETA_MAXROUNDS ?? '30', 10);
				const sampleMoves = process.env.AZMETA_SAMPLE === '1';
				const temperature = parseFloat(process.env.AZMETA_TEMP ?? '0.25');
				const microProfile = process.env.AZMETA_PROFILE ?? process.env.AZ_PLANNER_PROFILE ?? 'random';
				const forceDest = process.env.AZMETA_FORCE_DEST || process.env.AZ_FORCE_DEST || undefined;
				const control = process.env.AZMETA_CONTROL === 'full' || process.env.AZ_CONTROL === 'full' ? 'full' : 'navigation';
			const fullSelection = process.env.AZMETA_FULL_SELECTION === 'policy' || process.env.AZMETA_FULL_SELECTION === 'hybrid' || process.env.AZMETA_FULL_SELECTION === 'lookahead'
				? process.env.AZMETA_FULL_SELECTION
				: process.env.AZ_FULL_SELECTION === 'policy' || process.env.AZ_FULL_SELECTION === 'hybrid' || process.env.AZ_FULL_SELECTION === 'lookahead'
					? process.env.AZ_FULL_SELECTION
					: 'value';
			const fullLookaheadDepth = parseInt(process.env.AZMETA_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_LOOKAHEAD_DEPTH ?? '2', 10);
			const fullLookaheadBeam = parseInt(process.env.AZMETA_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_LOOKAHEAD_BEAM ?? '8', 10);
			const fullLookaheadRootBeam = parseInt(process.env.AZMETA_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_LOOKAHEAD_ROOT_BEAM ?? '24', 10);
			const fullTargetTemperature = parseFloat(process.env.AZMETA_FULL_TARGET_TEMP ?? process.env.AZ_FULL_TARGET_TEMP ?? process.env.AZ_TARGET_TEMP ?? '0.25');
			const farmNavigationOracle = (process.env.AZMETA_FARM_NAV_ORACLE ?? process.env.AZ_FARM_NAV_ORACLE) === 'force' ? 'force' : 'off';
			const farmNavigationThreshold = parseFloat(process.env.AZMETA_FARM_NAV_THRESHOLD ?? process.env.AZ_FARM_NAV_THRESHOLD ?? '0.5');
			const farmValueBonus = parseFloat(process.env.AZMETA_FARM_VALUE_BONUS ?? process.env.AZ_FARM_VALUE_BONUS ?? '0');
			const farmValueThreshold = parseFloat(process.env.AZMETA_FARM_VALUE_THRESHOLD ?? process.env.AZ_FARM_VALUE_THRESHOLD ?? '0');
			const forbidTypes = parseForbidTypes();
			const maxStatusLevel = process.env.AZMETA_MAX_STATUS_LEVEL
				? parseInt(process.env.AZMETA_MAX_STATUS_LEVEL, 10)
				: process.env.AZ_MAX_STATUS_LEVEL
					? parseInt(process.env.AZ_MAX_STATUS_LEVEL, 10)
					: undefined;
			const hardConstraints =
				(process.env.AZMETA_HARD_CONSTRAINTS ?? process.env.AZ_HARD_CONSTRAINTS ?? (maxStatusLevel !== undefined ? '1' : '0')) === '1';
			const out = process.env.AZMETA_OUT ?? mlPath('meta_result.json');

			const catalog = await loadOrSnapshotCatalog();
			const policy = loadPolicyForEval(process.env.AZMETA_WEIGHTS ?? mlPath('weights', 'policy.json'));
			const navWeights = process.env.AZMETA_NAV_WEIGHTS ?? process.env.AZ_NAV_WEIGHTS;
			const navigationPolicy = navWeights ? loadPolicyForEval(navWeights) : undefined;
			const patchNavWeights = process.env.AZMETA_PATCH_NAV_WEIGHTS ?? process.env.AZ_PATCH_NAV_WEIGHTS;
			const patchNavigationPolicy = patchNavWeights ? loadPolicyForEval(patchNavWeights) : undefined;
			const patchNavigationPolicyGate = parseNavigationPolicyGate(
				process.env.AZMETA_PATCH_NAV_GATE ?? process.env.AZ_PATCH_NAV_GATE,
				'all'
			);
			const patch2NavWeights = process.env.AZMETA_PATCH2_NAV_WEIGHTS ?? process.env.AZ_PATCH2_NAV_WEIGHTS;
			const patch2NavigationPolicy = patch2NavWeights ? loadPolicyForEval(patch2NavWeights) : undefined;
			const patch2NavigationPolicyGate = parseNavigationPolicyGate(
				process.env.AZMETA_PATCH2_NAV_GATE ?? process.env.AZ_PATCH2_NAV_GATE,
				'all'
			);
			const microWeights = process.env.AZMETA_MICRO_WEIGHTS ?? process.env.AZ_MICRO_WEIGHTS;
			const microPolicy = microWeights ? loadPolicyForEval(microWeights) : undefined;
			const routeCloserMicroWeights = process.env.AZMETA_ROUTE_CLOSER_MICRO_WEIGHTS ?? process.env.AZ_ROUTE_CLOSER_MICRO_WEIGHTS;
			const routeCloserMicroPolicy = routeCloserMicroWeights ? loadPolicyForEval(routeCloserMicroWeights) : undefined;
			const microPolicyGate = parseMicroPolicyGate(
				process.env.AZMETA_MICRO_GATE ?? process.env.AZ_MICRO_GATE,
				'all'
			);
			const pvpPivotOracle = parsePvpPivotOracle(
				process.env.AZMETA_PVP_PIVOT_ORACLE ?? process.env.AZ_PVP_PIVOT_ORACLE
			);
			const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
			const profiles = seatList.map(() => profileFor(microProfile));

			let seatGames = 0;
			let totalVP = 0, totalStatus = 0, totalBarrier = 0, totalMaxBarrier = 0, totalDice = 0;
			let totalRounds = 0, finished = 0, reach30 = 0;
			let abyss = 0, combats = 0, kills = 0;
			let farmableNavs = 0, missedFarmableNavs = 0, bossFarmableNavs = 0, missedBossFarmableNavs = 0;
			let farmOpportunityVp = 0, missedFarmOpportunityVp = 0, maxFarmOpportunityVp = 0;
			const winsBySeat: Record<string, number> = {};
			const classes: Record<string, number> = {};
			const vpHistogram: Record<string, number> = {};
			const sampleCounts: number[] = [];
			const decisionTypes: Record<string, number> = {};

			for (let g = 0; g < games; g++) {
				const r = playPlannerSelfPlayGame(catalog, {
					seed: 8_100_000 + g,
					profiles,
					policy,
					navigationPolicy,
					patchNavigationPolicy,
					patchNavigationPolicyGate,
					patch2NavigationPolicy,
					patch2NavigationPolicyGate,
					microPolicy,
					microPolicyGate,
					routeCloserMicroPolicy,
					plannerSeats: seatList,
					planner: { iterations, horizon, valueWeight, c: 1.5, farmValueBonus, farmValueThreshold },
						maxRounds,
						sampleMoves,
						temperature,
						forceDest,
						control,
					fullSelection,
					fullLookaheadDepth,
					fullLookaheadBeam,
					fullLookaheadRootBeam,
					fullTargetTemperature,
					farmNavigationOracle,
					farmNavigationThreshold,
					forbidTypes,
					maxStatusLevel,
					hardConstraints,
					pvpPivotOracle
				});
				totalRounds += r.rounds;
				if (r.finished) finished++;
				if (r.winnerSeat) winsBySeat[r.winnerSeat] = (winsBySeat[r.winnerSeat] ?? 0) + 1;
				sampleCounts.push(r.samples.length);
				for (const [type, count] of Object.entries(r.decisionTypes)) {
					decisionTypes[type] = (decisionTypes[type] ?? 0) + count;
				}

				for (const seat of seatList) {
					const player = r.finalState.players[seat];
					if (!player) continue;
					const vp = r.finalVP[seat] ?? 0;
					const bucket = `${Math.floor(vp / 5) * 5}-${Math.floor(vp / 5) * 5 + 4}`;
					vpHistogram[bucket] = (vpHistogram[bucket] ?? 0) + 1;
					totalVP += vp;
					totalStatus += player.statusLevel ?? 0;
					totalBarrier += player.barrier ?? 0;
					totalMaxBarrier += player.maxBarrier ?? 0;
					totalDice += player.attackDice?.length ?? 0;
					if (vp >= 30) reach30++;
					addClassCounts(classes, player);
					const ps = r.plannerStats[seat];
					if (ps) {
						abyss += ps.abyss;
						combats += ps.combat;
						kills += ps.kills;
						farmableNavs += ps.farmableNavs;
						missedFarmableNavs += ps.missedFarmableNavs;
						bossFarmableNavs += ps.bossFarmableNavs;
						missedBossFarmableNavs += ps.missedBossFarmableNavs;
						farmOpportunityVp += ps.farmOpportunityVp;
						missedFarmOpportunityVp += ps.missedFarmOpportunityVp;
						maxFarmOpportunityVp = Math.max(maxFarmOpportunityVp, ps.maxFarmOpportunityVp);
					}
					seatGames++;
				}

				if ((g + 1) % 10 === 0 || g === games - 1) {
					/* eslint-disable no-console */
					console.log(`[azmeta] g=${g + 1}/${games} avgVP=${(totalVP / Math.max(1, seatGames)).toFixed(2)} reach30%=${((100 * reach30) / Math.max(1, seatGames)).toFixed(0)}`);
					/* eslint-enable no-console */
				}
			}

			const row = {
				games,
				seats: n,
				seat_games: seatGames,
				iterations,
				horizon,
				valueWeight,
				maxRounds,
				sampleMoves,
				temperature,
					microProfile,
					forceDest,
					control,
				fullSelection,
				fullLookaheadDepth,
				fullLookaheadBeam,
				fullLookaheadRootBeam,
				fullTargetTemperature,
				farmNavigationOracle,
				farmNavigationThreshold,
				farmValueBonus,
				farmValueThreshold,
				weights: process.env.AZMETA_WEIGHTS ?? mlPath('weights', 'policy.json'),
				navWeights,
				patchNavWeights,
				patchNavigationPolicyGate,
				patch2NavWeights,
				patch2NavigationPolicyGate,
				microWeights,
				microPolicyGate,
				routeCloserMicroWeights,
				pvpPivotOracle,
				forbidTypes: [...(forbidTypes ?? [])],
				maxStatusLevel,
				hardConstraints,
				avg_vp: +(totalVP / Math.max(1, seatGames)).toFixed(2),
				reach30_pct: +((100 * reach30) / Math.max(1, seatGames)).toFixed(1),
				finished_pct: +((100 * finished) / Math.max(1, games)).toFixed(1),
				avg_rounds: +(totalRounds / Math.max(1, games)).toFixed(1),
				avg_status: +(totalStatus / Math.max(1, seatGames)).toFixed(2),
				avg_barrier: +(totalBarrier / Math.max(1, seatGames)).toFixed(2),
				avg_max_barrier: +(totalMaxBarrier / Math.max(1, seatGames)).toFixed(2),
				avg_attack_dice: +(totalDice / Math.max(1, seatGames)).toFixed(2),
				abyss_navs_per_seat_game: +(abyss / Math.max(1, seatGames)).toFixed(2),
				monster_combats_per_seat_game: +(combats / Math.max(1, seatGames)).toFixed(2),
				monster_kills_per_seat_game: +(kills / Math.max(1, seatGames)).toFixed(2),
				farmable_navs_per_seat_game: +(farmableNavs / Math.max(1, seatGames)).toFixed(2),
				missed_farmable_navs_per_seat_game: +(missedFarmableNavs / Math.max(1, seatGames)).toFixed(2),
				missed_farmable_nav_pct: +((100 * missedFarmableNavs) / Math.max(1, farmableNavs)).toFixed(1),
				farm_opportunity_vp_per_seat_game: +(farmOpportunityVp / Math.max(1, seatGames)).toFixed(2),
				missed_farm_opportunity_vp_per_seat_game: +(missedFarmOpportunityVp / Math.max(1, seatGames)).toFixed(2),
				missed_farm_opportunity_vp_pct: +((100 * missedFarmOpportunityVp) / Math.max(1e-9, farmOpportunityVp)).toFixed(1),
				max_farm_opportunity_vp: +maxFarmOpportunityVp.toFixed(2),
				boss_farmable_navs_per_seat_game: +(bossFarmableNavs / Math.max(1, seatGames)).toFixed(2),
				missed_boss_farmable_navs_per_seat_game: +(missedBossFarmableNavs / Math.max(1, seatGames)).toFixed(2),
				missed_boss_farmable_nav_pct: +((100 * missedBossFarmableNavs) / Math.max(1, bossFarmableNavs)).toFixed(1),
				samples_avg: +(sampleCounts.reduce((a, b) => a + b, 0) / Math.max(1, sampleCounts.length)).toFixed(1),
				wins_by_seat: winsBySeat,
				vp_histogram: vpHistogram,
				decision_types: topN(decisionTypes, 20),
				top_classes: topN(classes, 12)
			};
			const payload = {
				...row,
				inferred_strategy: inferStrategy(row),
				meta_score: +(row.avg_vp + row.reach30_pct / 5 + row.finished_pct / 20).toFixed(3)
			};
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, JSON.stringify(payload, null, 2));
			/* eslint-disable no-console */
			console.log(`[azmeta] strategy=${payload.inferred_strategy} score=${payload.meta_score} avgVP=${payload.avg_vp} reach30%=${payload.reach30_pct} status=${payload.avg_status}`);
			console.log(`[azmeta] DONE → ${out}`);
			/* eslint-enable no-console */
		},
		2 * 60 * 60 * 1000
	);
});
