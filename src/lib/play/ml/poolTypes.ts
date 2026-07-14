/**
 * Shared types for the multi-core self-play actor pool (actorPool.ts + actorWorker.ts).
 *
 * Everything here must survive a structuredClone through `workerData`, so the game
 * config is plain JSON: policies are referenced by weights FILE PATH (each worker
 * loads its own copy), heuristics by profile NAME (see `profileFor`).
 */
import type { SeatColor } from '../types';
import type { PotentialShapingMode } from './shaping';

export type StrategicDecisionScope = 'navigation' | 'engine-cycle';

/** Optional late-game suffix generation. Presence alone does not enable it: callers must set
 * `enabled: true`, which keeps every historical/default actor config bit-for-bit unchanged. */
export interface ContinuationCurriculumConfig {
	enabled?: boolean;
	/** Clean navigation rounds to capture. Default [12, 16, 20]. */
	rounds?: number[];
	/** Base deterministic selection probability per eligible source game. Default 1. */
	sourceProbability?: number;
	/** Probability multiplier when the source full game misses 30 VP. Default 1. */
	capFailureWeight?: number;
	/** Probability multiplier when the source full game reaches 30 VP. Default 0.25. */
	successWeight?: number;
}

export interface ContinuationCurriculumDiagnostics {
	eligibleSourceGames: number;
	selectedSourceGames: number;
	episodes: number;
	rows: number;
	/** Wall time spent only in continuation suffix rollouts on this worker/pool. */
	wallMs: number;
	sourceCapFailures: number;
	sourceSuccesses: number;
	forkSuccesses: number;
	forkFailures: number;
	recoveries: number;
	skippedNoSnapshot: number;
	sourceRoundCounts: Record<string, number>;
	forkRoundCounts: Record<string, number>;
}

/** Per-game configuration shared by every game in a pool run. */
export interface ActorGameConfig {
	/** Seat count (profiles are cycled to fill it). */
	seats: number;
	maxRounds: number;
	/**
	 * Heuristic profile names (cycled across seats). In neural mode these are the
	 * unstick fallback profiles; in heuristic mode (no weightsPath) they play the game.
	 */
	profiles: string[];
	/** Deterministically shuffle catalog guardians per seed instead of always using the first seats. */
	shuffleGuardians?: boolean;
	/** Evaluation-only absolute-seed schedule. Unlike a seeded shuffle, this assigns each guardian
	 * exactly once per contiguous guardianCount-sized seed block and is invariant to sharding. */
	guardianSchedule?: 'absolute-balanced';
	/** Learner policy weights file. Omit for heuristic-only (BC/cold-start) generation. */
	weightsPath?: string;
	/**
	 * Unix socket of a running ml/infer_server.py. When set, the learner policy is a
	 * RemotePolicy over this socket (weightsPath is then ignored for the learner; opponent
	 * weights still load in-process). See inferenceClient.ts for the fp-precision
	 * determinism caveat when comparing against in-process runs.
	 */
	inferSocket?: string;
	selection?: 'hybrid' | 'value' | 'policy';
	/** Opt-in V24 hybrid mode: policy-select ambiguous monster rewards except immediate wins. */
	learnMonsterRewardChoices?: boolean;
	sample?: boolean;
	temperature?: number;
	/** Seats driven by the learner policy (driver default: all seats when weightsPath set). */
	neuralSeats?: SeatColor[];
	/** Seats whose decisions are recorded as samples (driver default applies when omitted). */
	recordSeats?: SeatColor[];
	/** League play: per-seat opponent checkpoint weight files (seat plays its own policy, greedy, unrecorded). */
	opponentWeights?: Partial<Record<SeatColor, string>>;
	/** Sampling temperature for opponentWeights seats (default 0 = greedy, historical/bit-parity).
	 *  > 0 makes opponents sample — breaks argmax-clone collision when several opponent seats share
	 *  one checkpoint (mirror/self-play/exploiter), so measurements/training aren't dominated by
	 *  clones self-sabotaging. Deployment temp is 0.65. */
	opponentTemperature?: number;
	/**
	 * Expert-iteration Gumbel search during generation. Searched decisions (nav +
	 * encounter, learner seats) play the search result and record `pi` — the
	 * alphazero-mode policy target. `frac` < 1 = playout-cap randomization: only
	 * that fraction of eligible decisions gets the (expensive) search + pi.
	 */
	search?: {
		sims: number;
		/** Search leaf semantics. `solo-reach30` is valid only for one-player games. */
		objective?: 'multiplayer' | 'solo-reach30';
		navTemperature?: number;
		/** Leaf rollouts: 'policy' = self-model hybridIndex (slow, unbiased); 'heuristic' = medium profile. */
		rollout?: 'policy' | 'heuristic';
		frac?: number;
		horizonRounds?: number;
		valueWeight?: number;
	};
	/** Dense PPO reward: normalized ΔVP plus configured build-potential shaping. */
	denseVpReward?: boolean;
	/** Shaping preset name (shaping.ts shapingFor: 'balanced' | 'banker' | 'ascend' ...). */
	shapingPreset?: string;
	/** Correct discounted shaping with zero terminal potential; legacy is the default. */
	potentialShapingMode?: PotentialShapingMode;
	/** Which decision surfaces receive optional long-horizon PPO credit. Default navigation. */
	strategicDecisionScope?: StrategicDecisionScope;
	/** Command types stripped from neural seats' legal sets (hard behavioral constraint). */
	forbidTypes?: string[];
	maxStatusLevel?: number;
	gamma?: number;
	/** Training iteration stamped on every sample row (appendSamples `iter`). */
	iter?: number;
	/**
	 * Observation schema on recorded samples (driver obsVersion, default 1). At 2 every
	 * row gains a PAIRED obsV2 flat array next to the v1 obs (pinned contract in
	 * docs/encoder-v2.md), and the pool's meta.json gains obs_version + an "obs_v2" block
	 * (obsV2Meta(catalog)) that ml/obs_v2.py ObsV2Spec.from_meta validates against.
	 */
	obsVersion?: 1 | 2;
	/**
	 * Observation schema fed to the ACTING learner policy (driver policyObsVersion,
	 * default 1). At 2 the learner plays on flattenObsV2 — legal only with inferSocket
	 * (the server must hold an arc-entity-scorer-v2 checkpoint; the handshake obs_dim is
	 * verified) and selection 'hybrid'/'policy'. logpOld/vPred become the v2 net's.
	 */
	policyObsVersion?: 1 | 2;
	/** Train-only, solo late-state suffix generation. Default/off when absent or enabled=false. */
	continuationCurriculum?: ContinuationCurriculumConfig;
}

export interface SeatSummary {
	seat: SeatColor;
	finalVP: number;
	/** 1 + number of seats with strictly higher VP (ties share a placement). */
	placement: number;
	/** Final corruption status level (0 = pure). */
	finalStatus: number;
	/**
	 * What drove this seat: 'neural' = ANY net (the learner OR a league-opponent
	 * checkpoint — use GameSummary.neuralSeats to tell them apart), 'heuristic' = a
	 * BOT_PROFILES plan. 'uniform' is reserved for live-bot parity (a null-policy
	 * random fallback); the pool never emits it. Optional: absent on old rows.
	 */
	policy?: 'neural' | 'heuristic' | 'uniform';
	/** Evaluation-only build-convert-finish diagnostics; absent on historical rows. */
	cycle?: SeatCycleSummary;
}

export interface SeatCycleSummary {
	vpAfterRound: Record<string, number>;
	first15Round: number | null;
	first30Round: number | null;
	decisions: number;
	productiveDecisions: number;
	optionalYieldDecisions: number;
	locationInteractions: number;
	summons: number;
	awakens: number;
	combats: number;
	rewards: number;
	pvpAttacks: number;
	finalAttackDice: number;
	finalSpirits: number;
	finalMaxBarrier: number;
	post15VpPerRound: number;
}

/** One line of games-<workerIndex>.jsonl — the league-manager / balance-dashboard feed. */
export interface GameSummary {
	seed: number;
	seats: number;
	/** Per-seat learner/opponent checkpoint or heuristic profile. Historical rows may use one label. */
	weightsOrProfiles: string | string[];
	rounds: number;
	winnerSeat: SeatColor | null;
	finished: boolean;
	stalled: boolean;
	samples: number;
	/**
	 * Seats the LEARNER policy (weightsPath / inferSocket) drove in this game —
	 * league-opponent checkpoint seats are excluded. The per-seat attribution that
	 * makes "did the learner itself corrupt?" answerable from summaries alone
	 * (ml/dashboard.py learner corruption column). Empty on heuristic-only games;
	 * absent on rows written before this field existed.
	 */
	neuralSeats?: SeatColor[];
	/** Inference-server handshake provenance for remotely served learner policies. */
	inference?: {
		format: string;
		obsDim: number;
		actDim: number;
		weightsPath: string;
		weightsSha256: string;
		wire: 'binary' | 'json';
	};
	perSeat: SeatSummary[];
	/** Exact per-root-search timing, emitted only when ActorGameConfig.search is enabled. */
	search?: {
		decisions: number;
		simulations: number;
		wallMs: number;
		decisionWallMs: number[];
		byPhase: { navigation: number; encounter: number };
	};
	wallMs: number;
}

/** workerData payload for one spawned actor worker. */
export interface ActorWorkerData {
	workerIndex: number;
	/**
	 * Seeds for the synchronous runActorGames API. Dynamic pool workers receive an
	 * empty list here, then accept one ActorWorkerCommand.run job at a time.
	 */
	seeds: number[];
	config: ActorGameConfig;
	/** Directory receiving shard-<i>.jsonl (samples) and games-<i>.jsonl (summaries). */
	outDir: string;
	/** Frozen catalog JSON file (ml/catalog.json) — workers never touch the network. */
	catalogPath: string;
}

/** A single pool job. jobIndex preserves input order and disambiguates duplicate seeds. */
export interface ActorSeedJob {
	jobIndex: number;
	seed: number;
	/** True when this seed appears more than once in the same pool. Duplicate sources need a
	 * job-qualified episode ID or PPO would splice their trajectories together. */
	duplicateSeed?: boolean;
}

/** Commands sent to a persistent actor worker after it has loaded its catalog/policies. */
export type ActorWorkerCommand = ({ type: 'run' } & ActorSeedJob) | { type: 'stop' };

export type ActorWorkerMessage =
	| { type: 'ready'; workerIndex: number }
	| { type: 'game'; workerIndex: number; jobIndex: number; summary: GameSummary }
	| {
			type: 'done';
			workerIndex: number;
			games: number;
			samples: number;
			wallMs: number;
			curriculum: ContinuationCurriculumDiagnostics;
	  }
	| { type: 'error'; workerIndex: number; message: string };
