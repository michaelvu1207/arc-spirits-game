/**
 * Shared types for the multi-core self-play actor pool (actorPool.ts + actorWorker.ts).
 *
 * Everything here must survive a structuredClone through `workerData`, so the game
 * config is plain JSON: policies are referenced by weights FILE PATH (each worker
 * loads its own copy), heuristics by profile NAME (see `profileFor`).
 */
import type { SeatColor } from '../types';

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
	sample?: boolean;
	temperature?: number;
	/** Seats driven by the learner policy (driver default: all seats when weightsPath set). */
	neuralSeats?: SeatColor[];
	/** Seats whose decisions are recorded as samples (driver default applies when omitted). */
	recordSeats?: SeatColor[];
	/** League play: per-seat opponent checkpoint weight files (seat plays its own policy, greedy, unrecorded). */
	opponentWeights?: Partial<Record<SeatColor, string>>;
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
}

/** One line of games-<workerIndex>.jsonl — the league-manager / balance-dashboard feed. */
export interface GameSummary {
	seed: number;
	seats: number;
	/** weightsPath when neural, else the profile-name list — identifies who generated the game. */
	weightsOrProfiles: string;
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
	perSeat: SeatSummary[];
	wallMs: number;
}

/** workerData payload for one spawned actor worker. */
export interface ActorWorkerData {
	workerIndex: number;
	/** This worker's slice of the pool's seed set. */
	seeds: number[];
	config: ActorGameConfig;
	/** Directory receiving shard-<i>.jsonl (samples) and games-<i>.jsonl (summaries). */
	outDir: string;
	/** Frozen catalog JSON file (ml/catalog.json) — workers never touch the network. */
	catalogPath: string;
}

export type ActorWorkerMessage =
	| { type: 'game'; workerIndex: number; summary: GameSummary }
	| { type: 'done'; workerIndex: number; games: number; samples: number; wallMs: number }
	| { type: 'error'; workerIndex: number; message: string };
