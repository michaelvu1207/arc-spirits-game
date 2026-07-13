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

/** Shared ml/infer_server.py knobs (both v1-socket and v2 lanes spawn one). */
export interface LeagueInferConfig {
	/** infer_server --device (default auto). */
	device?: string;
	/** infer_server --window-ms (default 2). */
	windowMs?: number;
	/** infer_server --max-batch (default 512). */
	maxBatch?: number;
	/** How long to wait for the server socket + ready line (default 180000 ms). */
	serverStartTimeoutMs?: number;
}

/** Inference-server + distillation knobs for v2 lanes. */
export interface LeagueV2Config extends LeagueInferConfig {
	/** Fresh-model dims (train.py --v2-d-model/-layers/-heads; ignored on warm start). */
	dModel?: number;
	layers?: number;
	heads?: number;
	/** ml/distill.py epochs for the gauntlet/opponent proxy student (default 6). */
	distillEpochs?: number;
	/** Distill after EVERY training step (default false = only at promotion checks).
	 *  Without this, a v2 learner is opponent-playable only as of its last promotion. */
	distillEveryGen?: boolean;
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
	/** v1 CandidateScorer trunk widths, forwarded to train.py --hidden (scratch sweeps). */
	hidden?: number[];
	/** v1 value/aux-head widths, forwarded to train.py --value-hidden. */
	valueHidden?: number[];
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
	/**
	 * Matchup pools run concurrently during data generation (each into its own
	 * m-<i>/ shard subdir; trainers rglob recursively). Default:
	 * floor(workers / matchupGames) — the whole worker budget in flight without
	 * oversubscribing cores.
	 */
	matchupConcurrency?: number;
	/**
	 * Expert-iteration search during data generation (learner seats, v1 lanes):
	 * passed through to ActorGameConfig.search. Pair with mode 'alphazero' so the
	 * trainer consumes the recorded pi targets.
	 */
	search?: {
		sims: number;
		navTemperature?: number;
		rollout?: 'policy' | 'heuristic';
		frac?: number;
		horizonRounds?: number;
		valueWeight?: number;
	};
	/** Dense PPO reward (ΔVP + ΔΦ per decision) — REQUIRED for "reach 30" training. */
	denseVpReward?: boolean;
	/**
	 * Mirror-contention fraction (0..1, default 0 = off). This fraction of a
	 * generation's matchups replaces the PFSP lineup with a PURE MIRROR: all
	 * seats−1 opponents play the learner's CURRENT checkpoint, so the learner
	 * races equal-strength copies of itself on the shared ladder (the contention
	 * capability the mostly-heuristic PFSP field under-trains). Only the learner
	 * seat is recorded (as always). Mirror slots are chosen deterministically and
	 * evenly spread; the remaining (1−fraction) stay ordinary PFSP. A lane with no
	 * playable checkpoint yet (fresh-net bootstrap gen) silently falls back to PFSP.
	 */
	selfPlayFraction?: number;
	/**
	 * Strong-scripted-opponent contention fraction (0..1, default 0 = off). This fraction of a
	 * generation's matchups seats the learner against a PURE HEURISTIC FIELD — every opponent seat
	 * plays a scripted profile from `heuristicOpponentProfiles` (default ['paragon','insane'])
	 * instead of a PFSP-sampled checkpoint. Unlike the occasional heuristic anchor a PFSP draw
	 * yields, this GUARANTEES the learner regularly faces the strongest scripted play, so a weak
	 * engine actually loses and building one becomes VP-optimal (the ladder6 field lever). Slots are
	 * disjoint from mirror slots and spread deterministically across the non-mirror slots; the
	 * remaining (1 − selfPlayFraction − heuristicOpponentFraction) stay ordinary PFSP. Only the
	 * learner seat records (as always), so reward/placement semantics are unchanged — the heuristic
	 * seats are environment, exactly like a PFSP-drawn heuristic anchor.
	 */
	heuristicOpponentFraction?: number;
	/** BOT_PROFILES names cycled across the opponent seats of a heuristic-field matchup
	 *  (default ['paragon','insane']). Only used when heuristicOpponentFraction > 0. */
	heuristicOpponentProfiles?: string[];
	/** Deterministically shuffle guardian identities per game seed (default false for old-run parity). */
	shuffleGuardians?: boolean;
	/** Sampling temperature for checkpoint opponent seats (mirror/PFSP/exploiter fields), default
	 *  0 = greedy (historical, bit-parity). > 0 (e.g. 0.65) makes them sample, which breaks the
	 *  argmax-clone-collision artifact where several opponent seats sharing one checkpoint make
	 *  identical greedy moves and self-sabotage — so the learner's "contention" is real contested
	 *  play, not clones colliding. Heuristic-profile opponents are unaffected (they RNG already). */
	opponentTemperature?: number;
	/**
	 * TERMINATION BLOCKER (default undefined = off): a BOT_PROFILES name (e.g. 'paragon') seated in
	 * matchup slots selected by terminationBlockerFraction — mirror, heuristic, and PFSP alike —
	 * replacing one opponent slot. A non-corrupting
	 * profile that never Falls makes the all-Fallen early-termination (phases.ts tryAdvanceFromCleanup)
	 * unreachable in training, so games must run to the real VP target or the round cap. This removes the
	 * degenerate all-bot collapse (every seat racing to Fallen ends the game at ~round 8 / ~12 VP) that
	 * poisons the reach-30 signal — matching deployment, where a human opponent never Falls. It is NOT
	 * the heuristicOpponentFraction field lever (paragon as a punisher); it is paragon as a structural
	 * termination blocker. Whether the profile truly never Falls
	 * (forced corruption via damage overflow) is verified empirically, not assumed.
	 */
	terminationBlocker?: string;
	/** Fraction of matchup slots that receive terminationBlocker (default 1 for old blocker configs). */
	terminationBlockerFraction?: number;
	/** Shaping preset name for Φ_build (shaping.ts): 'balanced' | 'banker' | 'ascend'. */
	shapingPreset?: string;
	selection: 'hybrid' | 'value' | 'policy';
	/** Sample from the softmax during generation (exploration). */
	sample: boolean;
	temperature?: number;
	/**
	 * Linear per-generation temperature schedule (overrides the flat `temperature`
	 * when set). The sampling temperature anneals from `from` at generation 1 to `to`
	 * at generation `overGens`, then holds `to` for every later generation. Use this to
	 * end training AT the deployment temperature: a champion sampled at temp 0.65 live
	 * should have been trained toward that same sharpness, not left at the exploration
	 * temp 1.0 it warmed up under. gen 1 keeps `from` so the warm-start eval gate is
	 * unaffected. Both generation and quick-eval matchups anneal together.
	 */
	temperatureAnneal?: { from: number; to: number; overGens: number };
	gamma?: number;
	train: LeagueTrainConfig;
	/** Default init checkpoint for learner MAIN lanes (exploiters start fresh).
	 *  The literal 'random' mints a deterministic random-init v1 checkpoint at
	 *  init (ml/random_init_v1.py) — the honest zero-knowledge PPO start. */
	initFrom?: string;
	/**
	 * Per-lane init override keyed by member id — a checkpoint path, or 'random'
	 * to mint a fresh random-init v1 JSON for that lane. Beats `initFrom`.
	 * A random-init lane is policy-driven (real logpOld) from game 1, so mode
	 * ppo works from gen 1 with NO heuristic-bootstrap pollution — unlike a
	 * no-init lane, whose gen-1 games are heuristic-played BC rows.
	 */
	laneInit?: Record<string, string>;
	/**
	 * Seed the roster with the frozen checkpoint anchors (default true). Set
	 * false for from-scratch rediscovery runs: the league then contains ONLY
	 * heuristic anchors + learners — no corruption-knowing checkpoints anywhere.
	 */
	seedCheckpointAnchors?: boolean;
	/**
	 * Additional frozen members seeded at init — e.g. a promoted champion the
	 * main lane must keep facing so PFSP always has a peer-level target (a main
	 * warm-started ABOVE the whole field has nothing to push against and drifts).
	 * `elo` stamps eloVsAnchors directly (raising the promotion bar); omit it to
	 * let the gauntlet-results scan / byte-identity stamping try instead.
	 * Arrays REPLACE on config merge (they don't concatenate).
	 */
	extraFrozen?: { id: string; weightsPath: string; elo?: number }[];
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
	/**
	 * Route v1 (JSON MLP) learner lanes through a manager-owned ml/infer_server.py:
	 * the learner plays a batched-GPU RemotePolicy (policyObsVersion 1) instead of
	 * the in-process TS net, while opponents keep their in-process weights. Presence
	 * enables it (`{}` = defaults); fields tune the shared server. A lane's server
	 * serves its LIVE JSON checkpoint (<lane>-live.json), hot-swapped + SIGHUP'd each
	 * generation exactly like the v2 lane. Skipped for lanes running expert-iteration
	 * `search` (the Gumbel searcher needs the local net for rollouts) and for the
	 * heuristic bootstrap generation (no checkpoint to serve yet).
	 */
	v1Infer?: LeagueInferConfig;
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
	/** How many of this generation's matchups were pure mirror (selfPlayFraction); absent when 0. */
	mirrorMatchups?: number;
	/** How many of this generation's matchups were the pure heuristic field (heuristicOpponentFraction); absent when 0. */
	heuristicMatchups?: number;
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
