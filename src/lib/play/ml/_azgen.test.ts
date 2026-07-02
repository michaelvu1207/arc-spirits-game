/**
 * AlphaZero self-play DATA GENERATION. Planner seats choose navigation by neural ISMCTS and record
 * the search visit-distribution `pi` (policy target) + game outcome (value target). Opt-in via AZ=1.
 *
 *   AZ=1 AZ_GAMES=200 AZ_ITERS=48 AZ_VALUEW=0.5 AZ_SAMPLE=1 \
 *     npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept
 *
 * Env: AZ_GAMES, AZ_ITERS, AZ_HORIZON, AZ_VALUEW (0=heuristic-playout leaf … 1=pure value net),
 *      AZ_SEATS, AZ_SAMPLE (1=sample moves ∝ visits), AZ_TEMP, AZ_PLANNER_SEATS (one|all),
 *      AZ_CONTROL (navigation|full), AZ_FULL_SELECTION (value|policy|hybrid|lookahead),
 *      AZ_FULL_LOOKAHEAD_DEPTH, AZ_FULL_LOOKAHEAD_BEAM, AZ_FULL_LOOKAHEAD_ROOT_BEAM,
 *      AZ_FULL_TARGET_TEMP,
 *      AZ_POLICY_POOL (comma-separated frozen opponent checkpoints),
 *      AZ_POLICY_POOL_MIX (0..1 share of games using the pool), AZ_PROFILES
 *      (heuristic opponents only when AZ_PLANNER_SEATS=one and no pool game),
 *      AZ_ITER (data tag), AZ_OUT (jsonl path), AZ_WEIGHTS (net to guide search),
 *      AZ_NAV_WEIGHTS (optional root-navigation-prior scorer),
 *      AZ_MICRO_WEIGHTS (optional non-navigation full-control scorer),
 *      AZ_MICRO_GATE=all|abyss-round|abyss-farm-actions|abyss-reward-actions|abyss-farm-overlay,
 *      AZ_FARM_NAV_ORACLE=off|force, AZ_FARM_NAV_THRESHOLD.
 */
import { describe, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type SeatColor } from '../types';
import { playPlannerSelfPlayGame, type MicroPolicyGate, type NavigationPolicyGate } from './selfplay';
import { appendSamples, loadOrRandomPolicy, loadOrSnapshotCatalog, loadWeightsIfPresent, mlPath, writeMeta } from './nodeIo';
import type { NeuralPolicy } from './net';

const RUN = process.env.AZ === '1';

function parseForbidTypes(): Set<GameCommand['type']> | undefined {
	const raw = process.env.AZ_FORBID_TYPES ?? process.env.AZ_FORBID;
	if (!raw) return undefined;
	const types = raw.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][];
	return types.length > 0 ? new Set(types) : undefined;
}

function parsePolicyPool(): { files: string[]; policies: NeuralPolicy[] } {
	const files = (process.env.AZ_POLICY_POOL ?? process.env.AZ_OPPONENT_WEIGHTS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const policies = files.map((file) => {
		const policy = loadWeightsIfPresent(file);
		if (!policy) throw new Error(`missing or incompatible AZ_POLICY_POOL checkpoint: ${file}`);
		return policy;
	});
	return { files, policies };
}

function parseNavigationPolicyGate(raw: string | undefined, fallback: NavigationPolicyGate): NavigationPolicyGate {
	if (
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
	) {
		return raw;
	}
	return fallback;
}

function parseMicroPolicyGate(raw: string | undefined, fallback: MicroPolicyGate): MicroPolicyGate {
	if (
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
	) {
		return raw;
	}
	return fallback;
}

describe('AlphaZero self-play generation', () => {
	(RUN ? it : it.skip)(
		'generate planner self-play data (pi + outcome targets)',
		async () => {
			const games = parseInt(process.env.AZ_GAMES ?? '120', 10);
			const iterations = parseInt(process.env.AZ_ITERS ?? '48', 10);
			const horizon = parseInt(process.env.AZ_HORIZON ?? '30', 10);
			const valueWeight = parseFloat(process.env.AZ_VALUEW ?? '0.5');
			const seatsN = parseInt(process.env.AZ_SEATS ?? '4', 10);
			const progressEvery = Math.max(0, parseInt(process.env.AZ_PROGRESS_EVERY ?? '20', 10));
			const seed0 = parseInt(process.env.AZ_SEED0 ?? '4000000', 10);
			const sampleMoves = process.env.AZ_SAMPLE === '1';
			const temperature = parseFloat(process.env.AZ_TEMP ?? '1');
			const iter = parseInt(process.env.AZ_ITER ?? '0', 10);
			const out = process.env.AZ_OUT ?? mlPath('data', 'az.jsonl');
			const plannerSeatMode = (process.env.AZ_PLANNER_SEATS ?? process.env.AZ_MODE ?? 'one').toLowerCase();
			const allPlannerSeats = plannerSeatMode === 'all' || plannerSeatMode === 'self';
			const control = process.env.AZ_CONTROL === 'full' ? 'full' : 'navigation';
			const fullSelection = process.env.AZ_FULL_SELECTION === 'policy' || process.env.AZ_FULL_SELECTION === 'hybrid' || process.env.AZ_FULL_SELECTION === 'lookahead'
				? process.env.AZ_FULL_SELECTION
				: 'value';
			const fullLookaheadDepth = parseInt(process.env.AZ_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_LOOKAHEAD_DEPTH ?? '2', 10);
			const fullLookaheadBeam = parseInt(process.env.AZ_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_LOOKAHEAD_BEAM ?? '8', 10);
			const fullLookaheadRootBeam = parseInt(process.env.AZ_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_LOOKAHEAD_ROOT_BEAM ?? '24', 10);
			const fullTargetTemperature = parseFloat(process.env.AZ_FULL_TARGET_TEMP ?? process.env.AZ_TARGET_TEMP ?? '0.25');
			const farmNavigationOracle = process.env.AZ_FARM_NAV_ORACLE === 'force' ? 'force' : 'off';
			const farmNavigationThreshold = parseFloat(process.env.AZ_FARM_NAV_THRESHOLD ?? '0.5');
			const farmValueBonus = parseFloat(process.env.AZ_FARM_VALUE_BONUS ?? '0');
			const farmValueThreshold = parseFloat(process.env.AZ_FARM_VALUE_THRESHOLD ?? '0');
			const forbidTypes = parseForbidTypes();
			const maxStatusLevel = process.env.AZ_MAX_STATUS_LEVEL ? parseInt(process.env.AZ_MAX_STATUS_LEVEL, 10) : undefined;
			const hardConstraints = (process.env.AZ_HARD_CONSTRAINTS ?? (maxStatusLevel !== undefined ? '1' : '0')) === '1';
			const navigationPolicyGate = parseNavigationPolicyGate(process.env.AZ_NAV_GATE, 'all');
			const preserveRouteFirepower = (process.env.AZ_PRESERVE_ROUTE_FIREPOWER ?? '0') === '1';
			const preserveRouteSurvival = (process.env.AZ_PRESERVE_ROUTE_SURVIVAL ?? '0') === '1';
			const abyssRouteDiscipline = (process.env.AZ_ABYSS_ROUTE_DISCIPLINE ?? '0') === '1';
			const goodTargetActionDiscipline = (process.env.AZ_GOOD_TARGET_ACTION_DISCIPLINE ?? '0') === '1';
			// Within-round execution is still the current engine bot executor; navigation is where AZ
			// search supplies the policy target. AZ_CONTROL=full lets planner seats own non-navigation
			// decisions too, using the candidate policy/value head instead of the heuristic executor.
			const plannerProfile = process.env.AZ_PLANNER_PROFILE ?? 'random';
			const field = (process.env.AZ_PROFILES ?? 'pvphunter,medium,cultivator,survivor')
				.split(',').map((s) => s.trim()).filter(Boolean);
			const policyPool = parsePolicyPool();
			const mixedPolicyLeague = policyPool.policies.length > 0;
			const policyPoolMix = Math.max(0, Math.min(1, parseFloat(process.env.AZ_POLICY_POOL_MIX ?? '1')));

			const catalog = await loadOrSnapshotCatalog();
			const policy = loadOrRandomPolicy(process.env.AZ_WEIGHTS ?? mlPath('weights', 'policy.json'), 1234);
			const navWeights = process.env.AZ_NAV_WEIGHTS;
			let navigationPolicy: NeuralPolicy | undefined;
			if (navWeights) {
				navigationPolicy = loadWeightsIfPresent(navWeights) ?? undefined;
				if (!navigationPolicy) throw new Error(`missing or incompatible AZ_NAV_WEIGHTS checkpoint: ${navWeights}`);
			}
			const microWeights = process.env.AZ_MICRO_WEIGHTS;
			let microPolicy: NeuralPolicy | undefined;
			if (microWeights) {
				microPolicy = loadWeightsIfPresent(microWeights) ?? undefined;
				if (!microPolicy) throw new Error(`missing or incompatible AZ_MICRO_WEIGHTS checkpoint: ${microWeights}`);
			}
			const microPolicyGate = parseMicroPolicyGate(process.env.AZ_MICRO_GATE, 'all');
			const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];

			if (existsSync(out)) rmSync(out);
			let totalSamples = 0;
			let sumVP = 0, wins = 0, sumStatus = 0, sumRounds = 0, plannerSeatGames = 0;
			let policyPoolGames = 0;
			let farmableNavs = 0, missedFarmableNavs = 0, bossFarmableNavs = 0, missedBossFarmableNavs = 0;
			let farmOpportunityVp = 0, missedFarmOpportunityVp = 0, maxFarmOpportunityVp = 0;
			const decisionTypes: Record<string, number> = {};

			for (let g = 0; g < games; g++) {
				const plannerSeat = seatList[g % n]; // rotate the planner seat for coverage
				const usePolicyPool =
					mixedPolicyLeague &&
					(policyPoolMix >= 1 || (policyPoolMix > 0 && ((g * 9973 + 17) % 10_000) < policyPoolMix * 10_000));
				if (usePolicyPool) policyPoolGames++;
				const plannerSeats = usePolicyPool || allPlannerSeats ? seatList : [plannerSeat];
				const recordSeats = usePolicyPool ? [plannerSeat] : plannerSeats;
				const plannerSet = new Set<SeatColor>(plannerSeats);
				const recordSet = new Set<SeatColor>(recordSeats);
				const profiles = seatList.map((s, i) =>
					plannerSet.has(s) ? profileFor(plannerProfile) : profileFor(field[(g + i) % field.length])
				);
				const seatPolicies: Partial<Record<SeatColor, NeuralPolicy>> = {};
				if (usePolicyPool) {
					for (let i = 0; i < seatList.length; i++) {
						const s = seatList[i];
						if (recordSet.has(s)) continue;
						seatPolicies[s] = policyPool.policies[(g + i) % policyPool.policies.length];
					}
				}
				const r = playPlannerSelfPlayGame(catalog, {
					seed: seed0 + g,
					profiles,
					policy,
					navigationPolicy,
					navigationPolicyGate,
					microPolicy,
					microPolicyGate,
					seatPolicies,
					plannerSeats,
					recordSeats,
					planner: { iterations, horizon, valueWeight, c: 1.5, farmValueBonus, farmValueThreshold },
					maxRounds: 30,
					sampleMoves,
					temperature,
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
					preserveRouteFirepower,
					preserveRouteSurvival,
					abyssRouteDiscipline,
					goodTargetActionDiscipline
				});
				appendSamples(out, r.samples, iter);
				totalSamples += r.samples.length;
				for (const [type, count] of Object.entries(r.decisionTypes)) {
					decisionTypes[type] = (decisionTypes[type] ?? 0) + count;
				}
				for (const ps of recordSeats) {
					const fp = r.finalState.players[ps];
					sumVP += r.finalVP[ps] ?? 0;
					sumStatus += fp?.statusLevel ?? 0;
					if (r.winnerSeat === ps) wins++;
					const stat = r.plannerStats[ps];
					if (stat) {
						farmableNavs += stat.farmableNavs;
						missedFarmableNavs += stat.missedFarmableNavs;
						bossFarmableNavs += stat.bossFarmableNavs;
						missedBossFarmableNavs += stat.missedBossFarmableNavs;
						farmOpportunityVp += stat.farmOpportunityVp;
						missedFarmOpportunityVp += stat.missedFarmOpportunityVp;
						maxFarmOpportunityVp = Math.max(maxFarmOpportunityVp, stat.maxFarmOpportunityVp);
					}
				}
				plannerSeatGames += recordSeats.length;
				sumRounds += r.rounds;
				if ((progressEvery > 0 && (g + 1) % progressEvery === 0) || g === games - 1) {
					/* eslint-disable no-console */
					console.log(
						`[azgen] g=${g + 1}/${games} mode=${mixedPolicyLeague ? `policy-pool:${policyPoolMix}` : allPlannerSeats ? 'all' : 'one'} poolGames=${policyPoolGames} samples=${totalSamples} learnerVP_avg=${(sumVP / Math.max(1, plannerSeatGames)).toFixed(2)} win_share%=${((100 * wins) / Math.max(1, plannerSeatGames)).toFixed(0)} rounds=${(sumRounds / (g + 1)).toFixed(1)}`
					);
					/* eslint-enable no-console */
				}
			}

			writeMeta(totalSamples, games, {
				mode: 'alphazero',
				iter,
				iterations,
				progressEvery,
				seed0,
				valueWeight,
				plannerSeatMode: mixedPolicyLeague ? 'policy-pool' : allPlannerSeats ? 'all' : 'one',
				recordSeatMode: mixedPolicyLeague
					? policyPoolMix >= 1
						? 'one-learner'
						: 'mixed-self-and-learner'
					: allPlannerSeats ? 'all' : 'one',
				policyPool: policyPool.files,
				policyPoolMix,
				policyPoolGames,
				navWeights,
				navigationPolicyGate,
				microWeights,
				microPolicyGate,
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
				forbidTypes: [...(forbidTypes ?? [])],
				maxStatusLevel,
				hardConstraints,
				preserveRouteFirepower,
				preserveRouteSurvival,
				abyssRouteDiscipline,
				goodTargetActionDiscipline,
				decisionTypes,
				plannerSeatGames,
				farmableNavs,
				missedFarmableNavs,
				missedFarmableNavPct: (100 * missedFarmableNavs) / Math.max(1, farmableNavs),
				farmOpportunityVp,
				missedFarmOpportunityVp,
				missedFarmOpportunityVpPct: (100 * missedFarmOpportunityVp) / Math.max(1e-9, farmOpportunityVp),
				maxFarmOpportunityVp,
				bossFarmableNavs,
				missedBossFarmableNavs,
				missedBossFarmableNavPct: (100 * missedBossFarmableNavs) / Math.max(1, bossFarmableNavs),
				plannerVP_avg: sumVP / Math.max(1, plannerSeatGames),
				planner_status_avg: sumStatus / Math.max(1, plannerSeatGames),
				planner_win_share_pct: (100 * wins) / Math.max(1, plannerSeatGames)
			});
			/* eslint-disable no-console */
			console.log(`[azgen] DONE → ${out} (${totalSamples} samples, ${games} games)`);
			/* eslint-enable no-console */
		},
		2 * 60 * 60 * 1000
	);
});
