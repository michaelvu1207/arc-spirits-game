/**
 * Recording self-play driver for the ML pipeline.
 *
 * One function plays a full game (lobby → finished/capped) and emits training samples.
 * Seats are driven either by the existing heuristic (`planBotPhaseActions`) or by a
 * NeuralPolicy choosing among `legalActions`. Every meaningful decision (a covered
 * candidate set with >1 option) is recorded as {obs, cands, chosen}; terminal
 * placement returns are stamped on afterward.
 *
 *   - Heuristic seats  → BC data: we record which legal candidate the heuristic's plan
 *     matched. This is the cold-start dataset (imitate the winners of heuristic games).
 *   - Neural seats     → on-policy data: we record what the net chose (optionally sampled
 *     for exploration). This is the AWR/iteration dataset.
 *
 * Mirrors sim/selfPlay.ts for setup + the no-progress deadline-advance, so it stays
 * faithful to how real games actually run.
 */

import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt, type RngState } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	MEDIUM_DEFAULTS,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import { SEAT_COLORS, type GameActor, type GameCommand, type PlayCatalog, type PublicGameState, type SeatColor } from '../types';
import { encodeAction, encodeObs } from './encode';
import { encodeEntityObsV2, flattenObsV2 } from './encodeV2';
import { legalActionsWithNext, commandMatches, type LegalAction } from './actions';
import { sampleAuxTargets } from './auxTargets';
import { valueGuidedIndex, hybridIndex, policyIndexWithProgressGuard } from './neuralBot';
import { buildPotential, vpOf, vpReturnsToGo, BALANCED_SHAPING, type ShapingWeights } from './shaping';
import type { NeuralPolicy } from './net';

/** One recorded decision. `vp`/`phi` (VP and build-potential at decision time) are used to
 *  compute `ret` (VP-maximizing return-to-go) once the game's VP trajectory is known. */
export interface Sample {
	obs: number[];
	/** Paired v2 observation (arc-obs-v2 flat array), present when recorded at obsVersion 2.
	 *  `obs` stays the v1 62-float vector on EVERY row — the pinned paired-row contract
	 *  (docs/encoder-v2.md): v1 consumers read obs, v2 trainers read obsV2, and
	 *  distillation reads both views of the same decision. */
	obsV2?: number[];
	cands: number[][];
	chosen: number;
	ret: number;
	seat: SeatColor;
	vp: number;
	phi: number;
	kill: number; // 1 if this decision claims a monster-kill reward (drives the optional monster-kill bonus)
	/** Auxiliary target for a state-level farm-value head. Optional for backwards-compatible data. */
	farmValue?: number;
	/** Auxiliary soft target over candidates for monster reward-pick decisions. */
	rewardPi?: number[];
	/** AlphaZero policy target: the MCTS visit distribution over `cands` (search-improved). Present
	 *  only for planner/search decisions; absent for plain heuristic/neural-greedy records. */
	pi?: number[];
	/** Optional multiplier for policy loss. Use 0 for value-only regression/failure rows. */
	policyWeight?: number;
	/** Optional state-level route-mode target for Fallen PvP navigation. 1=hunt Good player, 0=return Abyss. */
	routeMode?: number;
	/** Optional curriculum/source label used by lane scripts to filter narrow training slices. */
	teacherKind?: string;
	/**
	 * PPO trajectory fields (consumed by ml/ppo.py via train.py --mode ppo). The episode key
	 * is per (game, seat) — ml/ppo.py groups rows by gameId alone, so two seats sharing one
	 * id would interleave into a single bogus episode. Heuristic-teacher and custom-chooser
	 * rows carry the trajectory stamps but omit logpOld/vPred (no softmax behavior
	 * distribution exists for them); the PPO loader skips such rows by design while
	 * AWR/AlphaZero modes keep training on them unchanged.
	 */
	gameId?: string;
	stepIdx?: number;
	/** Per-step shaping reward (default 0; see RecordGameOptions.stepRewards). */
	rStep?: number;
	/** True on the seat's last decision of a FINISHED game. Capped/stalled games leave the
	 *  episode truncated, so the PPO trainer bootstraps GAE from the last vPred. */
	done?: boolean;
	/** Behavior log-prob of the chosen candidate under the acting policy's temp-1 softmax. */
	logpOld?: number;
	/** Value-head output at decision time. */
	vPred?: number;
	/** Final placement 1..seats (ties share the better place), on rows of finished games. */
	placement?: number;
}

export interface RecordGameOptions {
	seed: number;
	/** One profile per seat; seat count = profiles.length. Used for heuristic seats and as
	 *  the unstick fallback for neural seats. */
	profiles: BotProfile[];
	maxRounds?: number;
	/** If set, these seats are driven by `policy`; the rest stay heuristic. Default: all
	 *  seats are neural when a policy is supplied, else all heuristic. */
	policy?: NeuralPolicy;
	neuralSeats?: SeatColor[];
	/** Sample from the softmax (exploration) instead of greedy argmax. */
	sample?: boolean;
	temperature?: number;
	/** How neural seats choose actions: 'hybrid' (default) = learned policy for positioning +
	 *  always grab immediate VP; 'policy' = imitation head only; 'value' = 1-ply value-lookahead. */
	selection?: 'hybrid' | 'value' | 'policy';
	/** Which seats to record decisions for. Default: neural seats (or all, heuristic mode). */
	recordSeats?: SeatColor[];
	/**
	 * Custom decision function. When supplied, the "neural" seats are driven by this instead of
	 * `policy.pick` — given the legal candidates, return the index to take. Lets you drop in a
	 * hand-written or alternative bot without changing the engine.
	 */
	chooser?: (obs: number[], candFeatures: number[][], cands: GameCommand[], seat: SeatColor, state: PublicGameState) => number;
	/**
	 * League play: per-seat opponent policies. A seat listed here is driven by ITS OWN policy
	 * (a sampled past checkpoint / exploiter), instead of `opts.policy` or a heuristic — so the
	 * learner trains against a diverse, strong, self-generated field rather than one weak bot.
	 * Opponent seats always play greedily (no recording). The learner seat(s) still use
	 * `opts.policy` + `recordSeats`.
	 */
	opponentPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Reward-shaping weights for the progress potential Φ (default BALANCED). Drives the
	 *  per-decision return-to-go; vary across a population for diverse playstyles. */
	shaping?: ShapingWeights;
	/** Discount for return-to-go (default 0.99). */
	gamma?: number;
	/**
	 * Which guardians (by name) sit in each seat. Default = the first N catalog guardians in
	 * fixed order — which means every game has the SAME starting identities. Pass a per-game
	 * shuffle/permutation here to expose the bots to a VARIETY of starting spirits/origins
	 * ("a variety of spots"); unknown names are dropped and back-filled from the catalog.
	 */
	guardianNames?: string[];
	/**
	 * Command types whose candidate actions are REMOVED from the legal set for neural seats —
	 * a hard behavioral constraint. E.g. forbidding the corruption interaction forces a
	 * guaranteed never-corrupt (Good) line, the cleanest test of whether a non-corrupt line wins.
	 */
	forbidTypes?: Set<GameCommand['type']>;
	/**
	 * Maximum allowed status level after a candidate action. Used for Pure-only curriculum/eval
	 * lanes; if every neural action violates the cap, the unfiltered candidate set is retained so
	 * a bad state cannot softlock.
	 */
	maxStatusLevel?: number;
	/**
	 * Per-step PPO shaping rewards (Sample.rStep): given one seat's recorded decisions in play
	 * order, return a reward per decision. Default: all 0 — the terminal placement reward is
	 * added trainer-side (ml/ppo.py), so sparse works. This is the hook where potential-based
	 * shaping (e.g. ΔΦ from shaping.ts) plugs in later without touching the recording path.
	 */
	stepRewards?: (seatSamples: Sample[], seat: SeatColor, finalVP: Record<string, number>) => number[];
	/**
	 * Observation schema recorded on samples (default 1). At 2, every recorded Sample
	 * ADDITIONALLY carries obsV2 = flattenObsV2 (3,419 floats for the frozen catalog);
	 * Sample.obs remains the v1 62-float vector on every row and Sample.cands stay v1
	 * encodeAction rows — the pinned paired-row contract (docs/encoder-v2.md), which is
	 * exactly what v1<-v2 distillation needs (both views of the same decision). The
	 * ACTING policy runs on v1 obs regardless: selection, logpOld and vPred come from
	 * the v1 in-process net (there is no TS v2 net), so obsV2 is behavior-off-policy
	 * input — fine for BC / off-policy warm start of the Python v2 model.
	 */
	obsVersion?: 1 | 2;
}

export interface RecordGameResult {
	winnerSeat: SeatColor | null;
	finished: boolean;
	rounds: number;
	stalled: boolean;
	finalVP: Record<string, number>;
	samples: Sample[];
	/** The terminal game state (for diagnostics/strategy tracing — final builds, status, etc.). */
	finalState?: PublicGameState;
}

function seededBotRandom(rng: RngState): BotRandom {
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

/** Per (seat,round,phase) action cap so a mis-trained greedy net can't loop forever. */
const MAX_ACTIONS_PER_PHASE = 30;
const MAX_TICKS = 50_000;

/**
 * Command types that represent a genuine STRATEGIC choice worth recording as a training
 * decision. Recording calls `legalActions` (≈expensive — it dry-runs many candidates,
 * each deep-cloning state), so we only do it for these high-leverage commands, not for
 * the many mechanical/forced commands a heuristic plan also emits. The net thus learns
 * the decisions that matter; everything else stays heuristic-driven during cold start.
 */
const RECORDABLE_TYPES = new Set<GameCommand['type']>([
	'lockNavigation',
	'selectNavigationDestination',
	'resolveLocationInteraction',
	'spawnHandSpirit',
	'takeSpirit',
	'replaceSpirit',
	'absorbSpirit',
	'initiatePvp',
	'passEncounter',
	'startCombat',
	'resolveMonsterReward',
	'awakenSpirit',
	'resolveDecision',
	'placeAugmentOnSpirit',
	'resolveAwakenReward',
	'discardSpirit'
]);

function filterConstrainedActions(
	withNext: LegalAction[],
	seat: SeatColor,
	forbidTypes?: Set<GameCommand['type']>,
	maxStatusLevel?: number
): LegalAction[] {
	if (!forbidTypes?.size && maxStatusLevel === undefined) return withNext;
	const filtered = withNext.filter((x) => {
		if (forbidTypes?.has(x.cmd.type)) return false;
		if (maxStatusLevel !== undefined && (x.next.players[seat]?.statusLevel ?? 0) > maxStatusLevel) {
			return false;
		}
		return true;
	});
	return filtered.length > 0 ? filtered : withNext;
}

export function playRecordingGame(catalog: PlayCatalog, opts: RecordGameOptions): RecordGameResult {
	const profiles = opts.profiles;
	const maxRounds = opts.maxRounds ?? 300;
	const n = Math.min(profiles.length, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	// Seat guardians: honor an explicit (per-game shuffled) lineup, keeping only valid catalog
	// names, de-duplicated (each seat needs a distinct guardian), then back-fill from the catalog
	// so we always have n. Default (no override) = first n catalog guardians, as before.
	const catalogNames = catalog.guardians.map((g) => g.name);
	let guardianNames: string[];
	if (opts.guardianNames && opts.guardianNames.length) {
		const seen = new Set<string>();
		guardianNames = [];
		for (const nm of opts.guardianNames) {
			if (catalogNames.includes(nm) && !seen.has(nm)) {
				guardianNames.push(nm);
				seen.add(nm);
			}
			if (guardianNames.length >= n) break;
		}
		for (const nm of catalogNames) {
			if (guardianNames.length >= n) break;
			if (!seen.has(nm)) {
				guardianNames.push(nm);
				seen.add(nm);
			}
		}
	} else {
		guardianNames = catalogNames.slice(0, n);
	}

	const hasController = !!(opts.policy || opts.chooser);
	const neuralSet = new Set<SeatColor>(
		hasController ? (opts.neuralSeats ?? seats) : []
	);
	const recordSet = new Set<SeatColor>(
		opts.recordSeats ?? (opts.policy ? Array.from(neuralSet) : seats)
	);
	const shaping = opts.shaping ?? BALANCED_SHAPING;
	const gamma = opts.gamma ?? 0.99;
	// Optional explicit monster-kill bonus (env ARC_HUNT_BONUS, default 0 = off). Added to the
	// per-step reward when a decision claims a monster reward — directly drives the monster/economy
	// line the sparse ΔVP signal struggles to discover. Policy-additive shaping; ΔVP stays the core.
	const huntBonus = process.env.ARC_HUNT_BONUS ? parseFloat(process.env.ARC_HUNT_BONUS) : 0;

	let state = createLobbyState({ roomCode: 'MLSIM', guardianNames });
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const profileBySeat: Record<string, BotProfile> = {};

	const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};

	seats.forEach((seat, i) => {
		profileBySeat[seat] = profiles[i] ?? MEDIUM_DEFAULTS;
		const memberId = `bot-${seat}`;
		expectOk(
			applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog),
			`claimSeat ${seat}`
		);
		expectOk(
			applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog),
			`selectGuardian ${seat}`
		);
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed: opts.seed }, catalog), 'startGame');

	const botRng = seededBotRandom(createRng(opts.seed));
	const pickRng = createRng(opts.seed ^ 0x9e3779b9);
	const rand = (): number => nextInt(pickRng, 1_000_000) / 1_000_000;

	const samples: Sample[] = [];
	const actionCounter = new Map<string, number>();
	let ticks = 0;
	let stalled = false;

	// v2 recording: samples gain a PAIRED obsV2 flat array next to the v1 obs (see the
	// obsVersion option docs). Reads the live `state` binding, so call it exactly where
	// encodeObs is called for the same decision.
	const recordObsV2 =
		opts.obsVersion === 2
			? (seat: SeatColor): number[] => flattenObsV2(encodeEntityObsV2(state, seat, catalog), catalog)
			: null;

	const applyHeuristic = (seat: SeatColor): boolean => {
		let progressed = false;
		const plan = planBotPhaseActions(state, seat, catalog, botRng, profileBySeat[seat]);
		for (const cmd of plan) {
			if (opts.forbidTypes?.has(cmd.type)) continue;
			if (opts.maxStatusLevel !== undefined) {
				const probe = applyGameCommand(state, botActorFor(state, seat), cmd, catalog);
				if (probe.ok && (probe.state.players[seat]?.statusLevel ?? 0) > opts.maxStatusLevel) continue;
			}
			// Record covered heuristic decisions (BC label) BEFORE applying — but only for
			// strategic command types, since recording dry-runs many candidates (expensive).
			if (recordSet.has(seat) && !neuralSet.has(seat) && RECORDABLE_TYPES.has(cmd.type)) {
				const withNextH = filterConstrainedActions(
					legalActionsWithNext(state, seat, catalog),
					seat,
					opts.forbidTypes,
					opts.maxStatusLevel
				);
				if (withNextH.length > 1) {
					const mi = withNextH.findIndex((x) => commandMatches(x.cmd, cmd));
					if (mi >= 0) {
						const obs = encodeObs(state, seat);
						samples.push({
							obs,
							...(recordObsV2 ? { obsV2: recordObsV2(seat) } : {}),
							cands: withNextH.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
							chosen: mi,
							ret: 0,
							seat,
							vp: vpOf(state.players[seat]),
							phi: buildPotential(state.players[seat], shaping),
							kill: cmd.type === 'resolveMonsterReward' ? 1 : 0,
							...sampleAuxTargets(state, seat, catalog, withNextH)
						});
					}
				}
			}
			// Commit the chosen heuristic command in place — the prior `state` is discarded each
			// step (reassigned just below), exactly like sim/selfPlay, so the defensive deep clone
			// is pure overhead here. Parity-tested fast path (sim/_parity.test.ts); the recording
			// dry-runs above (legalActions) still clone, which is what preserves the candidate states.
			const res = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
			if (!res.ok) break;
			state = res.state;
			progressed = true;
			if (state.status !== 'active') break;
		}
		return progressed;
	};

	const stepNeural = (seat: SeatColor): boolean => {
		const key = `${seat}:${state.round}:${state.phase}`;
		const used = actionCounter.get(key) ?? 0;
		if (used >= MAX_ACTIONS_PER_PHASE) return applyHeuristic(seat); // unstick → forces a yield
		const withNextRaw = legalActionsWithNext(state, seat, catalog);
		if (withNextRaw.length === 0) return applyHeuristic(seat); // uncovered phase → heuristic
		// Hard behavioral constraint: drop forbidden action types (e.g. corruption) for neural
		// seats — unless that would leave no legal move (never softlock).
		const withNext = filterConstrainedActions(
			withNextRaw,
			seat,
			opts.forbidTypes,
			opts.maxStatusLevel
		);
		const cands = withNext.map((x) => x.cmd);
		const obs = encodeObs(state, seat);
		const feats = withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog));
		// League opponents play their own checkpoint greedily (no exploration, no recording);
		// the learner seat uses the configured selection + exploration and is recorded.
		const oppPolicy = opts.opponentPolicies?.[seat];
		const seatPolicy = oppPolicy ?? opts.policy!;
		const sample = oppPolicy ? false : opts.sample;
		const idx =
			cands.length === 1
				? 0
				: opts.chooser && !oppPolicy
					? opts.chooser(obs, feats, cands, seat, state)
					: opts.selection === 'policy'
							? policyIndexWithProgressGuard(seatPolicy, state, seat, withNext, { sample, temperature: opts.temperature, rand }, catalog)
							: opts.selection === 'value'
								? valueGuidedIndex(seatPolicy, state, seat, withNext, { sample, temperature: opts.temperature, rand }, catalog)
								: hybridIndex(seatPolicy, state, seat, withNext, { sample, temperature: opts.temperature, rand }, catalog);
		if (cands.length > 1 && recordSet.has(seat) && !oppPolicy) {
			// PPO behavior stats, only when a real softmax policy made this decision (not a
			// custom chooser). logpOld is the temp-1 softmax — the distribution the trainer's
			// log_softmax reproduces — regardless of the exploration temperature used to act.
			let ppo: { logpOld: number; vPred: number } | undefined;
			if (opts.policy && !opts.chooser) {
				const p = opts.policy.probs(obs, feats);
				ppo = {
					logpOld: Math.log(Math.max(p[idx], 1e-12)),
					vPred: opts.policy.value(obs)
				};
			}
			samples.push({
				obs,
				...(recordObsV2 ? { obsV2: recordObsV2(seat) } : {}),
				cands: feats,
				chosen: idx,
				ret: 0,
				seat,
				vp: vpOf(state.players[seat]),
				phi: buildPotential(state.players[seat], shaping),
				kill: cands[idx].type === 'resolveMonsterReward' ? 1 : 0,
				...ppo,
				...sampleAuxTargets(state, seat, catalog, withNext)
			});
		}
		state = withNext[idx].next;
		actionCounter.set(key, used + 1);
		return true;
	};

	while (state.status === 'active' && state.round <= maxRounds) {
		ticks += 1;
		if (ticks > MAX_TICKS) {
			stalled = true;
			break;
		}
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const did = neuralSet.has(seat) ? stepNeural(seat) : applyHeuristic(seat);
			progressed = progressed || did;
			if (state.status !== 'active') break;
		}
		if (state.status !== 'active') break;
		if (!progressed) {
			const before = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === before) {
				stalled = true;
				break;
			}
		}
	}

	const finalVP: Record<string, number> = {};
	for (const seat of seats) finalVP[seat] = state.players[seat]?.victoryPoints ?? 0;

	// VP-maximizing return-to-go: per seat, credit each decision with its discounted future VP
	// (plus potential-based build shaping). γ<1 trades total-VP vs VP/turn — a harness knob.
	const finished = state.status === 'finished';
	for (const seat of seats) {
		const seatSamples = samples.filter((s) => s.seat === seat); // already in play order
		if (seatSamples.length === 0) continue;
		const finalBuild = buildPotential(state.players[seat], shaping);
		const g = vpReturnsToGo(
			seatSamples.map((s) => s.vp),
			seatSamples.map((s) => s.phi),
			finalVP[seat],
			finalBuild,
			gamma,
			seatSamples.map((s) => huntBonus * s.kill)
		);
		seatSamples.forEach((s, i) => (s.ret = g[i]));

		// PPO trajectory stamps (per-seat episode; see the Sample field docs).
		const gameId = `${opts.seed}-${n}p-${seat}`;
		const placement = 1 + seats.filter((o) => o !== seat && finalVP[o] > finalVP[seat]).length;
		const rSteps = opts.stepRewards?.(seatSamples, seat, finalVP);
		seatSamples.forEach((s, i) => {
			s.gameId = gameId;
			s.stepIdx = i;
			s.rStep = rSteps?.[i] ?? 0;
			s.done = finished && i === seatSamples.length - 1;
			if (finished) s.placement = placement;
		});
	}

	return {
		winnerSeat: state.winnerSeat ?? null,
		finished: state.status === 'finished',
		rounds: state.round,
		stalled,
		finalVP,
		samples,
		finalState: state
	};
}
