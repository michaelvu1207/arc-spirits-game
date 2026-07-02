/**
 * League-manager types (M3 scaffold). One league = a roster of members (learners,
 * frozen snapshots, heuristic anchors) plus a generation counter, persisted as
 * JSON under a league root directory:
 *
 *   <root>/config.json     LeagueConfig (created by init; hand-editable)
 *   <root>/state.json      LeagueState  (atomically rewritten after every phase)
 *   <root>/history.jsonl   one HistoryLine per (generation, lane)
 *   <root>/checkpoints/    <lane>-gen<g>.json learner ckpts + frozen-*.json snapshots
 *   <root>/data/gen<g>/<lane>/   shard/games JSONL from the actor pool + meta.json
 *
 * See BOT_TAKEOVER_PLAN.md M3 and BOT_METHODOLOGY_DIRECTION.md (Phase C) for the
 * league design this scaffolds: main agents (PFSP over the whole league),
 * main exploiters (only ever face the current main), league exploiters (uniform
 * over the frozen historical pool), heuristic profiles seeding the initial pool.
 */

export type LeagueMemberKind =
	| 'main'
	| 'main_exploiter'
	| 'league_exploiter'
	| 'frozen'
	| 'heuristic';

/** Pairwise placement record vs one opponent: strictly-better / strictly-worse
 *  finishes out of `games` shared games (ties = games − better − worse). */
export interface MatchStats {
	games: number;
	better: number;
	worse: number;
}

export interface LeagueMember {
	id: string;
	kind: LeagueMemberKind;
	/** Model family. 'v1' (default) = TS-JSON MLP played in-process; 'v2' =
	 *  arc-entity-scorer-v2 .pt played via a manager-owned inference server. */
	model?: 'v1' | 'v2';
	/** v1 JSON checkpoint (learners: the CURRENT ckpt, rewritten each generation;
	 *  frozen: immutable snapshot). Heuristic members have `profile` instead.
	 *  v2 members leave this unset — see ptPath/distilledPath. */
	weightsPath?: string;
	/** v2 members: the CURRENT arc-entity-scorer-v2 .pt (+ sibling .manifest.json). */
	ptPath?: string;
	/** v2 members: the latest distilled v1-JSON student (ml/distill.py). This is how
	 *  a v2 member is gauntlet-scored (distilled proxy — TODO: direct socket gauntlet)
	 *  AND how it sits in other lanes' seats (opponents load in-process, v1-JSON-only). */
	distilledPath?: string;
	/** BOT_PROFILES name for heuristic members. */
	profile?: string;
	/** Learner lanes only: checkpoint to warm-start from before the first
	 *  generation trains (also plays the gen-1 games when no ckpt exists yet).
	 *  v1 lanes: a JSON; v2 lanes: a .pt. Omit for a from-scratch exploiter. */
	initFrom?: string;
	createdGen: number;
	/** Aggregate gauntlet-v1 Elo, when this member has been gauntlet-scored.
	 *  For v2 members this is the DISTILLED student's score. */
	eloVsAnchors?: number;
	/** Pairwise placement stats keyed by opponent member id (PFSP input). */
	matchStats: Record<string, MatchStats>;
}

/** Inference-server + distillation knobs for v2 lanes. */
export interface LeagueV2Config {
	/** infer_server --device (default auto). */
	device?: string;
	/** infer_server --window-ms. */
	windowMs?: number;
	/** infer_server --max-batch. */
	maxBatch?: number;
	/** Fresh-model dims (train.py --v2-d-model/-layers/-heads; ignored on warm start). */
	dModel?: number;
	layers?: number;
	heads?: number;
	/** ml/distill.py epochs for the gauntlet/opponent proxy student (default 6). */
	distillEpochs?: number;
	/** Distill after EVERY training step (default false = only at promotion checks).
	 *  Without this, a v2 learner is opponent-playable only as of its last promotion. */
	distillEveryGen?: boolean;
	/** How long to wait for the server socket + ready line (default 180000 ms). */
	serverStartTimeoutMs?: number;
}

export interface PfspConfig {
	/** Exponent for the 'squared' variant weight (1 − winrate)^p. */
	p: number;
	/** 'squared' = focus on opponents we lose to; 'hard' = f(x)=x(1−x), peak effort
	 *  on ~50% opponents (AlphaStar's hard-mode curve). */
	variant: 'squared' | 'hard';
}

export interface LeagueTrainConfig {
	epochs: number;
	beta?: number;
	batchSize?: number;
	/** Extra raw CLI args appended to the train.py invocation. */
	extraArgs?: string[];
}

export interface LeagueConfig {
	version: 'league-v1';
	/** train.py --mode. Default awr until the PPO recording fields land (task #8). */
	mode: 'awr' | 'alphazero' | 'ppo';
	seats: number;
	maxRounds: number;
	/** Learner games generated per lane per generation. */
	gamesPerGen: number;
	/** Games per sampled opponent lineup (one actor-pool run per lineup). */
	matchupGames: number;
	/** Quick-eval games for the freshly trained ckpt (vs `evalOpponents`). */
	evalGames: number;
	/** Fixed member ids for the quick-eval field (first seats−1 are used). */
	evalOpponents: string[];
	/** Learner lane counts. */
	lanes: { main: number; mainExploiter: number; leagueExploiter: number };
	pfsp: PfspConfig;
	/** Gauntlet promotion check every N generations (main lanes only). */
	promoteEvery: number;
	/** Promote only if gauntlet Elo > best frozen member's Elo + this margin. */
	promoteMarginElo: number;
	/** Base for the deterministic per-generation seed ranges. */
	seedBase: number;
	/** Actor-pool worker threads (default: cpus−1). */
	workers?: number;
	selection: 'hybrid' | 'value' | 'policy';
	/** Sample from the softmax during generation (exploration). */
	sample: boolean;
	temperature?: number;
	gamma?: number;
	train: LeagueTrainConfig;
	/** Default init checkpoint for learner lanes (main; exploiters start fresh). */
	initFrom?: string;
	/**
	 * Baseline gauntlet-v1 Elos stamped on seeded FROZEN members at init, keyed by
	 * member id or weights path. Takes precedence over the ml/gauntlet_results scan;
	 * without either source the first promotion check has no bar (bestFrozen −Inf).
	 */
	baselineElos?: Record<string, number>;
	/**
	 * Model family per learner lane, keyed by member id (e.g. {"main-0": "v2"}).
	 * Unlisted lanes default to v1. v2 lanes train .pt checkpoints (--model v2),
	 * generate at obsVersion 2 (paired rows), and PLAY through a manager-owned
	 * ml/infer_server.py on a per-lane socket (policyObsVersion 2).
	 */
	laneModel?: Record<string, 'v1' | 'v2'>;
	/** v2-lane knobs (server device/batching, fresh dims, distillation). */
	v2?: LeagueV2Config;
	pythonBin: string;
	/** Promotion command; the candidate ckpt path is appended. Overridable in tests. */
	gauntletCmd: string[];
	paths: { root: string };
}

export interface LeagueState {
	version: 'league-v1';
	/** Last COMPLETED generation (0 = freshly initialized). */
	gen: number;
	members: LeagueMember[];
	/** Breadcrumb for crash forensics: 'idle' or 'gen<g>:<lane>:<step>'. A crash
	 *  mid-generation leaves this set; the next run() redoes that generation from
	 *  scratch (per-lane data dirs are cleared at lane start, so this is safe). */
	phase: string;
	updatedAt: string;
}

/** One JSONL line appended to <root>/history.jsonl per (generation, lane). */
export interface HistoryLine {
	ts: string;
	gen: number;
	lane: string;
	kind: LeagueMemberKind;
	games: number;
	samples: number;
	/** Opponent member id → games faced this generation. */
	opponents: Record<string, number>;
	poolWallMs: number;
	trainMs: number;
	/** v2 lanes: wall time of the ml/distill.py student run, when one happened. */
	distillMs?: number;
	evalMs: number;
	evalGames: number;
	/** Placement-1 share of the eval games. */
	evalWinRate: number;
	/** Mean pairwise placement score (win 1 / tie 0.5 / loss 0) over eval games. */
	evalPairwiseScore: number;
	/** eloFromScore over the eval pairwise encounters (quick estimate, NOT gauntlet). */
	eloEstimate: number;
	ckpt: string;
	/** Lane model family ('v1' when absent — pre-v2 lines). */
	model?: 'v1' | 'v2';
	/** v2 lanes: the distilled v1-JSON student produced this gen, when any. */
	distilledCkpt?: string;
	/** null = no promotion check this gen; otherwise the gauntlet verdict.
	 *  v2 lanes are gauntlet-scored via their DISTILLED student (proxy — the
	 *  gauntlet harness is v1-JSON-only; TODO: direct socket gauntlet). */
	promoted: boolean | null;
	gauntletElo?: number;
}
