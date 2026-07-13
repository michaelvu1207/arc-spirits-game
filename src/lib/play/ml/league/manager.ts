/**
 * League manager (M3 scaffold) — the generation loop that turns the actor pool +
 * Python trainer into a population-based league (BOT_TAKEOVER_PLAN.md M3).
 *
 * One generation, per learner lane (mains, then main exploiters, then league
 * exploiters):
 *   1. PFSP-sample opponent lineups (pfsp.ts lane rules).
 *   2. Generate `gamesPerGen` games via runActorPool — one pool run per lineup,
 *      learner seat rotating across lineups; samples recorded for the learner only.
 *   3. Train: ml/train.py --mode <config.mode> on the lane's shards, warm-started
 *      from the learner's current ckpt (or its initFrom on the first generation),
 *      exporting <root>/checkpoints/<lane>-gen<g>.json.
 *   4. Quick-eval the new ckpt vs the fixed `evalOpponents` field (learner seat
 *      rotating); update matchStats and an eloFromScore estimate.
 *   5. Main lanes, every `promoteEvery` gens: full frozen gauntlet via
 *      `gauntletCmd` (scripts/nightly-gauntlet.sh); promote — freeze a snapshot
 *      into the roster — only if aggregate Elo beats the best frozen member by
 *      `promoteMarginElo`.
 *   6. Append one history.jsonl line; state.json is rewritten ATOMICALLY after
 *      every phase, so a crashed run resumes at the last completed generation.
 *
 * Crash model (scaffold): a generation is the unit of retry. A crash mid-gen
 * leaves state.gen at the previous value and a phase breadcrumb; the next run()
 * redoes the whole generation (lane data dirs are cleared at lane start). Known
 * caveat: matchStats accumulated by breadcrumb saves of a crashed generation are
 * re-counted on the redo — acceptable noise for PFSP weighting, tightened later.
 *
 * Everything resolves against process.cwd(), which must be the repo root (the
 * convention of nodeIo.mlPath / runActorPool's default catalog path); the
 * run-league.mjs CLI chdirs there first.
 *
 * Learner bootstrap: a lane with neither a ckpt nor initFrom (a fresh-net
 * exploiter) plays its first generation HEURISTIC-driven (profile-based, BC-style
 * samples for the learner seat) and trains from scratch on those; from gen 2 it
 * plays its own ckpt.
 *
 * v2 lanes (config.laneModel[id] === 'v2'): the lane trains arc-entity-scorer-v2
 * .pt checkpoints (train.py --model v2) on obsVersion-2 paired rows, and PLAYS
 * through a manager-owned ml/infer_server.py on a per-lane socket
 * (policyObsVersion 2) — see the inference-server section below for the spawn /
 * SIGHUP-hot-swap / kill lifecycle. Because the gauntlet harness and in-process
 * opponent seats are v1-JSON-only, a v2 member reaches both through its DISTILLED
 * student (ml/distill.py): "v2 gauntlet = distilled proxy", refreshed at every
 * promotion check (or every gen with config.v2.distillEveryGen). TODO: gauntlet
 * the v2 net directly through the socket and retire the proxy.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRng, nextInt } from '../../rng';
import { SEAT_COLORS, type SeatColor } from '../../types';
import { runActorPool } from '../actorPool';
import { ACT_DIM, OBS_DIM } from '../encode';
import { CHECKPOINT_ANCHORS, HEURISTIC_ANCHORS, eloFromScore } from '../gauntlet/manifest';
import type { ActorGameConfig, ContinuationCurriculumDiagnostics, GameSummary } from '../poolTypes';
import { isPlayable, recordPairwise, sampleOpponents } from './pfsp';
import type {
	HistoryLine,
	LeagueConfig,
	LeagueInferConfig,
	LeagueMember,
	LeagueState,
	MatchStats
} from './types';

export const DEFAULT_LEAGUE_ROOT = 'ml/league';

// ── Paths ────────────────────────────────────────────────────────────────────

export function leaguePaths(root: string) {
	const r = resolve(root);
	return {
		root: r,
		config: join(r, 'config.json'),
		state: join(r, 'state.json'),
		history: join(r, 'history.jsonl'),
		checkpoints: join(r, 'checkpoints'),
		laneData: (gen: number, laneId: string) => join(r, 'data', `gen${gen}`, laneId),
		laneEvalData: (gen: number, laneId: string) => join(r, 'data', `gen${gen}`, `${laneId}_eval`)
	};
}

// ── Config ───────────────────────────────────────────────────────────────────

export function defaultConfig(root = DEFAULT_LEAGUE_ROOT): LeagueConfig {
	const firstActiveCkpt = CHECKPOINT_ANCHORS.find((c) => c.status === 'active')?.path;
	return {
		version: 'league-v1',
		mode: 'awr',
		seats: 4,
		maxRounds: 120,
		gamesPerGen: 64,
		matchupGames: 8,
		evalGames: 24,
		evalOpponents: ['heur-medium', 'heur-hard', 'heur-pvphunter'],
		lanes: { main: 1, mainExploiter: 1, leagueExploiter: 1 },
		pfsp: { p: 2, variant: 'squared' },
		promoteEvery: 5,
		promoteMarginElo: 25,
		seedBase: 40_000_000,
		selection: 'hybrid',
		sample: true,
		temperature: 1.0,
		train: { epochs: 4, beta: 1.0 },
		// True gauntlet-v10 baselines for the seeded checkpoint anchors (800-game full
		// runs, 2026-07-08). Stamped via config because the shipped policy-weights.json
		// no longer byte-matches either anchor after the v13-2 promotion, so the
		// results-scan/byte-identity fallback can't provide the first promotion bar
		// (see stampBaselineElos docstring).
		baselineElos: {
			'frozen-v13-1-gen48-champion': 439,
			'frozen-ladder8c2-gen60-champion': 136
		},
		initFrom: firstActiveCkpt,
		pythonBin: 'ml/.venv/bin/python',
		gauntletCmd: ['bash', 'scripts/nightly-gauntlet.sh'],
		paths: { root }
	};
}

function mergeConfig(base: LeagueConfig, over: Partial<LeagueConfig>): LeagueConfig {
	return {
		...base,
		...over,
		lanes: { ...base.lanes, ...over.lanes },
		pfsp: { ...base.pfsp, ...over.pfsp },
		train: { ...base.train, ...over.train },
		paths: { ...base.paths, ...over.paths },
		...(base.baselineElos || over.baselineElos
			? { baselineElos: { ...base.baselineElos, ...over.baselineElos } }
			: {}),
		...(base.laneModel || over.laneModel
			? { laneModel: { ...base.laneModel, ...over.laneModel } }
			: {}),
		...(base.laneInit || over.laneInit ? { laneInit: { ...base.laneInit, ...over.laneInit } } : {}),
		...(base.v2 || over.v2 ? { v2: { ...base.v2, ...over.v2 } } : {}),
		...(base.v1Infer || over.v1Infer ? { v1Infer: { ...base.v1Infer, ...over.v1Infer } } : {})
	};
}

function hasExtraArg(args: readonly string[] | undefined, name: string): boolean {
	return !!args?.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** Fail before actor generation when a fixed-budget/curriculum experiment cannot satisfy its
 * statistical or runtime contract. Ordinary historical configs remain unaffected. */
export function validateLeagueConfig(config: LeagueConfig): void {
	const rows = config.train.ppoRowsPerEpoch;
	const fraction = config.train.ppoContinuationFraction;
	const curriculum = config.continuationCurriculum;
	const selfImitation = config.train.selfImitation;
	if (config.learnMonsterRewardChoices && config.selection !== 'hybrid') {
		throw new Error(
			"league: learnMonsterRewardChoices requires selection='hybrid' so the V24 intervention is active"
		);
	}
	if (config.learnMonsterRewardChoices && config.mode === 'ppo' && config.sample !== true) {
		throw new Error(
			'league: PPO learnMonsterRewardChoices requires sample=true for exact on-policy reward rows'
		);
	}
	if (rows !== undefined) {
		if (config.mode !== 'ppo') {
			throw new Error('league: ppoRowsPerEpoch requires mode=ppo');
		}
		if (!Number.isInteger(rows) || rows <= 0) {
			throw new Error('league: ppoRowsPerEpoch must be a positive integer');
		}
		if (hasExtraArg(config.train.extraArgs, '--target-kl')) {
			throw new Error(
				'league: fixed ppoRowsPerEpoch forbids data-dependent --target-kl early stopping'
			);
		}
	}
	if (fraction !== undefined) {
		if (rows === undefined) {
			throw new Error('league: ppoContinuationFraction requires ppoRowsPerEpoch');
		}
		if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
			throw new Error('league: ppoContinuationFraction must be in [0,1]');
		}
		if (fraction > 0 && !curriculum?.enabled) {
			throw new Error(
				'league: positive ppoContinuationFraction requires an enabled continuation curriculum'
			);
		}
	}
	if (curriculum?.enabled) {
		if (config.mode !== 'ppo' || config.seats !== 1) {
			throw new Error('league: continuation curriculum requires solo mode=ppo training');
		}
		if (config.sample !== true) {
			throw new Error('league: continuation curriculum requires sample=true');
		}
		if (config.search) {
			throw new Error('league: continuation curriculum cannot preserve opaque search state');
		}
		const rounds = curriculum.rounds ?? [12, 16, 20];
		if (
			rounds.length === 0 ||
			rounds.some(
				(round) => !Number.isInteger(round) || round < 12 || round > 20 || round > config.maxRounds
			)
		) {
			throw new Error('league: continuation rounds must be integers in 12..20 within maxRounds');
		}
	}
	if (selfImitation !== undefined) {
		if (config.mode !== 'ppo') {
			throw new Error('league: selfImitation requires mode=ppo');
		}
		if (config.sample !== true) {
			throw new Error('league: selfImitation requires sample=true exact-policy rows');
		}
		if (config.strategicDecisionScope !== 'engine-cycle') {
			throw new Error('league: selfImitation requires strategicDecisionScope=engine-cycle');
		}
		if (Object.values(config.laneModel ?? {}).some((model) => model === 'v2')) {
			throw new Error('league: selfImitation currently requires v1 reach30Pred behavior rows');
		}
		if (hasExtraArg(config.train.extraArgs, '--target-kl')) {
			throw new Error('league: selfImitation forbids data-dependent --target-kl early stopping');
		}
		const hasSoloSource =
			config.seats === 1 ||
			!!config.trainingSeatCurriculum?.some((stage) => Number(stage.weights['1'] ?? 0) > 0);
		if (!hasSoloSource) {
			throw new Error('league: selfImitation requires solo source games');
		}
		if (!Number.isFinite(selfImitation.coef) || selfImitation.coef < 0) {
			throw new Error('league: selfImitation.coef must be finite and nonnegative');
		}
		if (
			!Number.isFinite(selfImitation.replayFraction) ||
			selfImitation.replayFraction <= 0 ||
			selfImitation.replayFraction > 1
		) {
			throw new Error('league: selfImitation.replayFraction must be in (0,1]');
		}
		if (
			selfImitation.stalenessLogp !== undefined &&
			(!Number.isFinite(selfImitation.stalenessLogp) || selfImitation.stalenessLogp < 0)
		) {
			throw new Error('league: selfImitation.stalenessLogp must be finite and nonnegative');
		}
		if (
			selfImitation.maxAge !== undefined &&
			(!Number.isInteger(selfImitation.maxAge) || selfImitation.maxAge < 0)
		) {
			throw new Error('league: selfImitation.maxAge must be a nonnegative integer');
		}
		if (
			selfImitation.maxRows !== undefined &&
			(!Number.isInteger(selfImitation.maxRows) || selfImitation.maxRows <= 0)
		) {
			throw new Error('league: selfImitation.maxRows must be a positive integer');
		}
	}
}

// ── State IO (atomic) ────────────────────────────────────────────────────────

export function saveStateAtomic(root: string, state: LeagueState): void {
	const p = leaguePaths(root);
	mkdirSync(dirname(p.state), { recursive: true });
	state.updatedAt = new Date().toISOString();
	const tmp = `${p.state}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, '\t'));
	renameSync(tmp, p.state);
}

export function loadLeague(root: string): { config: LeagueConfig; state: LeagueState } {
	const p = leaguePaths(root);
	if (!existsSync(p.config) || !existsSync(p.state)) {
		throw new Error(`league: not initialized at ${p.root} (run init first)`);
	}
	const config = mergeConfig(
		defaultConfig(root),
		JSON.parse(readFileSync(p.config, 'utf8')) as Partial<LeagueConfig>
	);
	validateLeagueConfig(config);
	const state = JSON.parse(readFileSync(p.state, 'utf8')) as LeagueState;
	return { config, state };
}

// ── Init: seed the roster ────────────────────────────────────────────────────

/**
 * Seed roster: the 8 gauntlet heuristic anchors + (unless seedCheckpointAnchors
 * is false — from-scratch rediscovery leagues) every active frozen checkpoint
 * anchor, plus the configured learner lanes. Main lanes warm-start from
 * config.initFrom; config.laneInit overrides per lane; exploiter lanes default
 * fresh (see bootstrap note in header). The 'random' init sentinel is resolved
 * to a minted checkpoint by initLeague, not here (seedRoster stays fs-free).
 */
export function seedRoster(config: LeagueConfig): LeagueMember[] {
	const members: LeagueMember[] = [];
	for (const name of HEURISTIC_ANCHORS) {
		members.push({
			id: `heur-${name}`,
			kind: 'heuristic',
			profile: name,
			createdGen: 0,
			matchStats: {}
		});
	}
	if (config.seedCheckpointAnchors !== false) {
		for (const c of CHECKPOINT_ANCHORS) {
			if (c.status !== 'active') continue;
			members.push({
				id: `frozen-${c.name}`,
				kind: 'frozen',
				weightsPath: c.path,
				createdGen: 0,
				matchStats: {}
			});
		}
	}
	// Extra frozen members (e.g. a promoted champion kept in the field as the
	// main lane's peer-level PFSP target). An explicit elo stamps the promotion
	// bar directly; without one, stampBaselineElos' scan/byte-identity may still.
	for (const x of config.extraFrozen ?? []) {
		members.push({
			id: x.id,
			kind: 'frozen',
			weightsPath: x.weightsPath,
			createdGen: 0,
			...(typeof x.elo === 'number' ? { eloVsAnchors: x.elo } : {}),
			matchStats: {}
		});
	}
	for (let i = 0; i < config.lanes.main; i++) {
		members.push({
			id: `main-${i}`,
			kind: 'main',
			initFrom: config.initFrom,
			createdGen: 0,
			matchStats: {}
		});
	}
	for (let i = 0; i < config.lanes.mainExploiter; i++) {
		members.push({
			id: `main_exploiter-${i}`,
			kind: 'main_exploiter',
			createdGen: 0,
			matchStats: {}
		});
	}
	for (let i = 0; i < config.lanes.leagueExploiter; i++) {
		members.push({
			id: `league_exploiter-${i}`,
			kind: 'league_exploiter',
			createdGen: 0,
			matchStats: {}
		});
	}
	for (const m of members) {
		const model = config.laneModel?.[m.id];
		if (model) m.model = model;
		const init = config.laneInit?.[m.id];
		if (init) m.initFrom = init;
	}
	return members;
}

/** Mint a deterministic random-init v1 checkpoint (ml/random_init_v1.py). */
export function mintRandomInitCkpt(config: LeagueConfig, out: string, seed: number): void {
	const r = spawnSync(
		config.pythonBin,
		[
			'ml/random_init_v1.py',
			'--out',
			resolve(out),
			'--seed',
			String(seed),
			// Pin to the CURRENT encoder contract — the script's own defaults lag
			// encoder bumps (obs v1.1 62→77 was minted at 62 without this).
			'--obs-dim',
			String(OBS_DIM),
			'--act-dim',
			String(ACT_DIM)
		],
		{ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
	);
	if (r.status !== 0) {
		const tail = (r.stderr || r.stdout || '').split('\n').slice(-15).join('\n');
		throw new Error(`league: random_init_v1.py failed (status ${r.status}):\n${tail}`);
	}
}

/**
 * Resolve every member whose initFrom is the 'random' sentinel to a freshly
 * minted checkpoint under <root>/checkpoints/. The mint seed derives from
 * seedBase + the member's roster position, so the SAME config reproduces the
 * SAME zero-knowledge starting net anywhere. A random-init lane plays its own
 * (random) net from game 1 — policy-driven, real logpOld — which is what lets
 * mode ppo run from gen 1 with no heuristic-teacher pollution.
 */
export function resolveRandomInits(
	members: LeagueMember[],
	config: LeagueConfig,
	root: string
): void {
	const p = leaguePaths(root);
	members.forEach((m, idx) => {
		if (m.initFrom !== 'random') return;
		const out = join(p.checkpoints, `${m.id}-random-init.json`);
		mintRandomInitCkpt(config, out, config.seedBase + 7919 * (idx + 1));
		m.initFrom = out;
	});
}

/**
 * Known gauntlet-v1 baselines from committed result files: candidate weights path
 * → aggregate Elo. Only FULL (non-smoke) gauntlet-v1 runs of weights candidates
 * count; the newest result per path wins. Missing directory ⇒ empty map.
 */
export function readGauntletBaselines(
	resultsDir = resolve('ml', 'gauntlet_results')
): Record<string, number> {
	if (!existsSync(resultsDir)) return {};
	const byRef: Record<string, { elo: number; ts: string }> = {};
	for (const f of readdirSync(resultsDir)) {
		if (!f.endsWith('.json')) continue;
		let d: {
			gauntletVersion?: string;
			smoke?: boolean;
			candidate?: { kind?: string; ref?: string };
			timestamp?: string;
			eloVsAnchors?: { aggregate?: { elo?: number } };
		};
		try {
			d = JSON.parse(readFileSync(join(resultsDir, f), 'utf8'));
		} catch {
			continue; // non-result JSON (benches etc.) — ignore
		}
		const elo = d.eloVsAnchors?.aggregate?.elo;
		const ref = d.candidate?.ref;
		if (d.gauntletVersion !== 'gauntlet-v1' || d.smoke !== false) continue;
		if (d.candidate?.kind !== 'weights' || !ref || typeof elo !== 'number') continue;
		const ts = d.timestamp ?? '';
		if (!byRef[ref] || ts > byRef[ref].ts) byRef[ref] = { elo, ts };
	}
	return Object.fromEntries(Object.entries(byRef).map(([ref, v]) => [ref, v.elo]));
}

/**
 * The promotion bar: best gauntlet Elo among FROZEN members (−Infinity when none
 * is scored). Heuristic anchors deliberately do NOT participate — the bar tracks
 * the best frozen NEURAL snapshot; heuristics are opponents, not the champion line.
 */
export function promotionBar(members: LeagueMember[]): number {
	return Math.max(
		...members
			.filter((m) => m.kind === 'frozen' && typeof m.eloVsAnchors === 'number')
			.map((m) => m.eloVsAnchors as number),
		-Infinity
	);
}

/**
 * Stamp seeded frozen members with baseline Elos: config map first (by member id
 * or weights path), then the committed ml/gauntlet_results scan — matched on the
 * exact weights path, falling back to byte-identity with a scored file (anchors
 * are often byte-copies scored under another path; basenames collide across
 * meta_runs so paths alone can't map them). The identity fallback assumes scored
 * artifacts are immutable; a RE-SHIPPED path (e.g. the live policy-weights.json
 * after a promotion) simply stops matching its old score — stamp such members
 * via config.baselineElos, or re-gauntlet their immutable meta_runs path.
 */
export function stampBaselineElos(
	members: LeagueMember[],
	config: LeagueConfig,
	resultsDir?: string
): void {
	const scanned = readGauntletBaselines(resultsDir);
	const scoredBytes = new Map<string, Buffer>();
	const bytesOf = (path: string): Buffer | undefined => {
		if (!scoredBytes.has(path)) {
			scoredBytes.set(path, existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
		}
		const b = scoredBytes.get(path)!;
		return b.length > 0 ? b : undefined;
	};
	const byIdentity = (weightsPath: string): number | undefined => {
		const mine = bytesOf(resolve(weightsPath));
		if (!mine) return undefined;
		for (const [ref, elo] of Object.entries(scanned)) {
			const theirs = bytesOf(resolve(ref));
			if (theirs && theirs.length === mine.length && theirs.equals(mine)) return elo;
		}
		return undefined;
	};
	for (const m of members) {
		if (m.kind !== 'frozen' || m.eloVsAnchors !== undefined) continue;
		const elo =
			config.baselineElos?.[m.id] ??
			(m.weightsPath
				? (config.baselineElos?.[m.weightsPath] ??
					scanned[m.weightsPath] ??
					byIdentity(m.weightsPath))
				: undefined);
		if (typeof elo === 'number') m.eloVsAnchors = elo;
	}
}

/**
 * Initialize a league root: write config.json (defaults merged with `overrides`)
 * and a seeded state.json. A PRE-PLACED <root>/config.json is honored — the
 * template workflow (`cp configs/rediscovery.json <root>/config.json` then CLI
 * init) seeds the roster from that file, with `overrides` applied on top of it.
 * Precedence: defaults < config.json on disk < overrides argument.
 * Idempotent: an already-initialized root (state.json present) is loaded and
 * returned untouched (state is never reseeded over an existing league).
 */
export function initLeague(
	root = DEFAULT_LEAGUE_ROOT,
	overrides: Partial<LeagueConfig> = {}
): { config: LeagueConfig; state: LeagueState; created: boolean } {
	const p = leaguePaths(root);
	if (existsSync(p.state)) {
		return { ...loadLeague(root), created: false };
	}
	const fromDisk = existsSync(p.config)
		? (JSON.parse(readFileSync(p.config, 'utf8')) as Partial<LeagueConfig>)
		: {};
	const config = mergeConfig(mergeConfig(defaultConfig(root), fromDisk), overrides);
	validateLeagueConfig(config);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.checkpoints, { recursive: true });
	if (!existsSync(p.config)) writeFileSync(p.config, JSON.stringify(config, null, '\t'));
	const members = seedRoster(config);
	stampBaselineElos(members, config);
	resolveRandomInits(members, config, root);
	const state: LeagueState = {
		version: 'league-v1',
		gen: 0,
		members,
		phase: 'idle',
		updatedAt: new Date().toISOString()
	};
	saveStateAtomic(root, state);
	return { config, state, created: true };
}

// ── Generation loop ──────────────────────────────────────────────────────────

const LANE_ORDER: LeagueMember['kind'][] = ['main', 'main_exploiter', 'league_exploiter'];

function learnersOf(state: LeagueState): LeagueMember[] {
	return LANE_ORDER.flatMap((k) => state.members.filter((m) => m.kind === k));
}

function memberById(state: LeagueState, id: string): LeagueMember {
	const m = state.members.find((x) => x.id === id);
	if (!m) throw new Error(`league: unknown member id ${id}`);
	return m;
}

/**
 * The v1-JSON weights a member plays with when sitting in an OPPONENT seat
 * (opponents always load in-process, v1-JSON-only). v2 members are represented
 * by their distilled student; a v2 lane's .pt/initFrom .pt never qualifies.
 */
function playWeights(m: LeagueMember): string | undefined {
	return [m.distilledPath, m.weightsPath, m.initFrom].find((p) => !!p && p.endsWith('.json'));
}

/** Model family of a learner lane (config wins over the stamped member field). */
export function laneModelOf(config: LeagueConfig, m: LeagueMember): 'v1' | 'v2' {
	return config.laneModel?.[m.id] ?? m.model ?? 'v1';
}

/** The .pt a v2 learner currently plays/warm-starts from (current ckpt, else initFrom). */
function lanePt(m: LeagueMember): string | undefined {
	if (m.ptPath) return m.ptPath;
	return m.initFrom?.endsWith('.pt') ? m.initFrom : undefined;
}

// ── v2 inference servers (manager-owned child processes) ────────────────────
//
// One ml/infer_server.py per socket-served lane, serving the lane's LIVE
// checkpoint (<checkpoints>/<lane>-live.{pt,json}) on a per-lane unix socket.
// v2 lanes serve a .pt (+ sibling manifest); v1Infer lanes serve the JSON MLP.
// After each training step the new checkpoint is copied over the live path and
// the server is SIGHUP'd to hot-swap in place; the swap is CONFIRMED by watching
// the server log for its reload line before any eval runs (an eval on stale
// weights would silently corrupt matchStats). Servers persist across generations
// within one process; stopInferServers() kills them (runGenerations' finally, the
// CLI, tests) and a process-exit hook backstops crashes.

interface InferServerEntry {
	laneId: string;
	child: ChildProcess;
	socket: string;
	logPath: string;
	/** Live checkpoint the server reads (a .pt for v2 lanes, a .json for v1Infer). */
	livePt: string;
}

const inferServers = new Map<string, InferServerEntry>();

const manifestOf = (pt: string): string => pt.replace(/\.pt$/, '.manifest.json');

/**
 * Copy an inference checkpoint to a serve path. v2 .pt checkpoints carry a
 * sibling .manifest.json (the server's format probe) that must travel with them;
 * v1 .json checkpoints are a single self-describing file.
 */
function copyCheckpoint(src: string, dst: string): void {
	if (resolve(src) === resolve(dst)) return;
	copyFileSync(resolve(src), resolve(dst));
	if (resolve(src).endsWith('.pt')) {
		if (!existsSync(manifestOf(resolve(src)))) {
			throw new Error(`league: v2 checkpoint ${src} is missing its sibling ${manifestOf(src)}`);
		}
		copyFileSync(manifestOf(resolve(src)), manifestOf(resolve(dst)));
	}
}

function logTail(path: string, lines = 15): string {
	if (!existsSync(path)) return '(no log)';
	return readFileSync(path, 'utf8').trim().split('\n').slice(-lines).join('\n');
}

function countInLog(path: string, needle: string): number {
	if (!existsSync(path)) return 0;
	return readFileSync(path, 'utf8').split(needle).length - 1;
}

async function waitFor(
	cond: () => boolean,
	timeoutMs: number,
	what: string,
	diag: () => string
): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) {
			throw new Error(`league: timed out (${timeoutMs}ms) waiting for ${what}\n${diag()}`);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** Start (or reuse) the lane's inference server, serving `ckptSource` as the live
 *  checkpoint. `knobs` are the shared server flags (config.v2 for v2 lanes,
 *  config.v1Infer for v1-socket lanes); the live path's extension mirrors the
 *  source so the server format-probes correctly (.pt → v2, .json → v1). */
export async function ensureInferServer(
	config: LeagueConfig,
	root: string,
	laneIdx: number,
	laneId: string,
	ckptSource: string,
	knobs: LeagueInferConfig
): Promise<InferServerEntry> {
	const existing = inferServers.get(laneId);
	if (existing && existing.child.exitCode === null) return existing;
	inferServers.delete(laneId);

	const p = leaguePaths(root);
	const ext = ckptSource.endsWith('.pt') ? 'pt' : 'json';
	const livePt = join(p.checkpoints, `${laneId}-live.${ext}`);
	copyCheckpoint(ckptSource, livePt);
	// tmpdir keeps the socket path under the ~104-char unix limit (league roots
	// in tests live deep under /var/folders); the log stays with the league.
	const socket = join(tmpdir(), `arcl-${process.pid}-${laneIdx}.sock`);
	const logPath = join(p.root, `infer-${laneId}.log`);
	const logFd = openSync(logPath, 'a');
	const child = spawn(
		config.pythonBin,
		[
			'ml/infer_server.py',
			'--weights',
			livePt,
			'--socket',
			socket,
			'--device',
			knobs.device ?? 'auto',
			'--window-ms',
			String(knobs.windowMs ?? 2),
			'--max-batch',
			String(knobs.maxBatch ?? 512)
		],
		{ stdio: ['ignore', logFd, logFd] }
	);
	const entry: InferServerEntry = { laneId, child, socket, logPath, livePt };
	inferServers.set(laneId, entry);
	const serveMarks = countInLog(logPath, '[infer] serving');
	await waitFor(
		() => {
			if (child.exitCode !== null) {
				throw new Error(
					`league: infer server for ${laneId} exited (code ${child.exitCode}) during startup\n${logTail(logPath)}`
				);
			}
			return existsSync(socket) && countInLog(logPath, '[infer] serving') > serveMarks;
		},
		knobs.serverStartTimeoutMs ?? 180_000,
		`infer server ${laneId} (${socket})`,
		() => logTail(logPath)
	);
	return entry;
}

/** Swap the lane server onto `newPt` in place (copy over live path + SIGHUP), and
 *  WAIT for the confirmed reload line so nothing ever runs on stale weights. */
export async function hotSwapInferServer(entry: InferServerEntry, newPt: string): Promise<void> {
	const okBefore = countInLog(entry.logPath, '[infer] reloaded weights');
	const failBefore = countInLog(entry.logPath, 'reload FAILED');
	copyCheckpoint(newPt, entry.livePt);
	entry.child.kill('SIGHUP');
	await waitFor(
		() => {
			if (countInLog(entry.logPath, 'reload FAILED') > failBefore) {
				throw new Error(
					`league: infer server ${entry.laneId} FAILED to reload ${newPt}\n${logTail(entry.logPath)}`
				);
			}
			return countInLog(entry.logPath, '[infer] reloaded weights') > okBefore;
		},
		30_000,
		`infer server ${entry.laneId} reload of ${newPt}`,
		() => logTail(entry.logPath)
	);
}

/** Kill every manager-owned inference server (idempotent). */
export function stopInferServers(): void {
	for (const entry of inferServers.values()) {
		try {
			entry.child.kill('SIGTERM');
		} catch {
			// already gone
		}
		try {
			rmSync(entry.socket, { force: true });
		} catch {
			// best effort
		}
	}
	inferServers.clear();
}

process.once('exit', stopInferServers);

interface MatchupPlan {
	learnerSeat: SeatColor;
	/** Opponent member per non-learner seat, in seat order. */
	oppBySeat: [SeatColor, LeagueMember][];
	config: ActorGameConfig;
}

/**
 * Build the ActorGameConfig for one lineup, learner in seat `learnerSeatIdx`.
 * `v2` marks a v2 lane: rows record at obsVersion 2 (paired contract) and, when
 * `v2.socket` is set, the learner PLAYS through the lane's inference server
 * (policyObsVersion 2; in-process weightsPath is never used for the learner).
 * A v2 lane without a socket is the fresh-net bootstrap: heuristic-driven games,
 * still recorded at obsVersion 2 so the first .pt can train from them.
 * `v1Socket` (v1 lanes only, mutually exclusive with `v2`) routes the v1 JSON
 * learner through the lane's inference server: same policyObsVersion 1 / obsVersion 1
 * as an in-process v1 lane, but the acting net is a batched-GPU RemotePolicy and
 * weightsPath is left unset (the learner never loads in-process).
 */
/**
 * Sampling temperature for generation `gen` (1-indexed). With a `temperatureAnneal`
 * schedule the temperature moves LINEARLY from `from` at gen 1 to `to` at gen
 * `overGens`, then holds `to`; without one it is the flat `config.temperature`.
 */
export function annealedTemperature(config: LeagueConfig, gen: number): number | undefined {
	const a = config.temperatureAnneal;
	if (!a) return config.temperature;
	const span = Math.max(1, a.overGens - 1); // gen 1 → from, gen overGens → to
	const frac = Math.min(1, Math.max(0, (gen - 1) / span));
	return a.from + (a.to - a.from) * frac;
}

/** Deterministically apportion matchup pools across the configured player-count mixture. */
export function trainingSeatCountsForGeneration(
	config: LeagueConfig,
	gen: number,
	matchups: number
): number[] {
	const stages = config.trainingSeatCurriculum ?? [];
	if (stages.length === 0) return Array.from({ length: matchups }, () => config.seats);
	if (!Number.isInteger(matchups) || matchups < 0) {
		throw new Error(`league: matchup count must be a non-negative integer, got ${matchups}`);
	}
	let previousThroughGen = 0;
	for (const [index, entry] of stages.entries()) {
		if (!Number.isInteger(entry.throughGen) || entry.throughGen <= previousThroughGen) {
			throw new Error(
				`league: trainingSeatCurriculum stage ${index} throughGen must be a strictly increasing positive integer`
			);
		}
		previousThroughGen = entry.throughGen;
		const weights = Object.entries(entry.weights);
		if (weights.length === 0) {
			throw new Error(`league: trainingSeatCurriculum stage ${index} has no weights`);
		}
		for (const [key, weight] of weights) {
			const seats = Number.parseInt(key, 10);
			if (
				String(seats) !== key ||
				!Number.isInteger(seats) ||
				seats < 1 ||
				seats > config.seats ||
				!Number.isFinite(weight) ||
				weight <= 0
			) {
				throw new Error(
					`league: invalid trainingSeatCurriculum weight ${key}=${weight} at stage ${index}`
				);
			}
		}
	}
	const stage = stages.find((entry) => gen <= entry.throughGen) ?? stages[stages.length - 1];
	const weighted = Object.entries(stage.weights)
		.map(([key, weight]) => ({ seats: Number.parseInt(key, 10), weight }))
		.sort((left, right) => left.seats - right.seats);
	const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
	const assigned = new Map(weighted.map((entry) => [entry.seats, 0]));
	const result: number[] = [];
	for (let index = 0; index < matchups; index += 1) {
		let best = weighted[0];
		let bestDeficit = -Infinity;
		for (const entry of weighted) {
			const target = ((index + 1) * entry.weight) / total;
			const deficit = target - (assigned.get(entry.seats) ?? 0);
			if (deficit > bestDeficit) {
				best = entry;
				bestDeficit = deficit;
			}
		}
		result.push(best.seats);
		assigned.set(best.seats, (assigned.get(best.seats) ?? 0) + 1);
	}
	return result;
}

export function buildMatchup(
	config: LeagueConfig,
	learner: LeagueMember,
	opponents: LeagueMember[],
	learnerSeatIdx: number,
	iter: number,
	v2?: { socket?: string },
	v1Socket?: string
): MatchupPlan {
	const seatColors = SEAT_COLORS.slice(0, config.seats) as SeatColor[];
	const learnerSeat = seatColors[learnerSeatIdx % config.seats];
	const oppSeats = seatColors.filter((s) => s !== learnerSeat);
	if (opponents.length !== oppSeats.length) {
		throw new Error(`league: need ${oppSeats.length} opponents, got ${opponents.length}`);
	}
	// Heuristic fallback profile for every seat; heuristic opponents override theirs.
	const profiles = seatColors.map(() => 'medium');
	const opponentWeights: Partial<Record<SeatColor, string>> = {};
	const oppBySeat: [SeatColor, LeagueMember][] = [];
	oppSeats.forEach((seat, j) => {
		const opp = opponents[j];
		oppBySeat.push([seat, opp]);
		const w = playWeights(opp);
		if (w) opponentWeights[seat] = resolve(w);
		else if (opp.profile) profiles[seatColors.indexOf(seat)] = opp.profile;
		else throw new Error(`league: opponent ${opp.id} is not playable`);
	});
	// v1Socket routes the v1 learner through the server (no in-process weights); a v2
	// lane never uses it. Either socket mode plays the learner via the RemotePolicy.
	const viaV1Socket = !v2 && !!v1Socket;
	const viaV2Socket = !!v2?.socket;
	const viaSocket = viaV1Socket || viaV2Socket;
	const learnerWeights = v2 || viaV1Socket ? undefined : playWeights(learner);
	return {
		learnerSeat,
		oppBySeat,
		config: {
			seats: config.seats,
			maxRounds: config.maxRounds,
			profiles,
			...(config.shuffleGuardians ? { shuffleGuardians: true } : {}),
			weightsPath: learnerWeights ? resolve(learnerWeights) : undefined,
			// policyObsVersion 2 supports only hybrid/policy selection (actorWorker); the
			// v1 socket serves the same obs version as in-process, so value stays valid.
			selection: viaV2Socket && config.selection === 'value' ? 'hybrid' : config.selection,
			...(config.learnMonsterRewardChoices ? { learnMonsterRewardChoices: true } : {}),
			sample: config.sample,
			temperature: annealedTemperature(config, iter),
			// Checkpoint-opponent seats must be neural too, else the driver routes them to
			// applyHeuristic (medium) and their opponentPolicies net never plays — every
			// frozen/PFSP/mirror opponent was a medium bot before this. Heuristic-profile
			// opponents stay OUT (they play their profile via `profiles`). recordSeats keeps
			// the learner only, and willRecord already excludes oppPolicy seats, so opponents
			// are still never recorded/trained on.
			neuralSeats:
				learnerWeights || viaSocket
					? ([learnerSeat, ...(Object.keys(opponentWeights) as SeatColor[])] as SeatColor[])
					: undefined,
			recordSeats: [learnerSeat],
			opponentWeights: Object.keys(opponentWeights).length ? opponentWeights : undefined,
			...(config.opponentTemperature ? { opponentTemperature: config.opponentTemperature } : {}),
			// Expert iteration: learner-seat decisions get Gumbel search + recorded pi
			// (in-process lanes only — the searcher needs the local net for rollouts, so
			// socket lanes never carry search; the manager also skips the socket for them).
			...(config.search && learnerWeights && !viaSocket ? { search: config.search } : {}),
			...(config.denseVpReward ? { denseVpReward: true } : {}),
			...(config.shapingPreset ? { shapingPreset: config.shapingPreset } : {}),
			...(config.potentialShapingMode ? { potentialShapingMode: config.potentialShapingMode } : {}),
			...(config.strategicDecisionScope
				? { strategicDecisionScope: config.strategicDecisionScope }
				: {}),
			gamma: config.gamma,
			iter,
			...(v2 ? { obsVersion: 2 as const } : {}),
			...(viaV2Socket ? { inferSocket: v2!.socket, policyObsVersion: 2 as const } : {}),
			// v1 socket: play remotely but keep obsVersion / policyObsVersion at 1 (default).
			...(viaV1Socket ? { inferSocket: v1Socket } : {})
		}
	};
}

/**
 * Deterministic mirror-slot predicate: given `matchups` total lineups this
 * generation and a fraction `f` (0..1), returns whether matchup index `m` is a
 * mirror. Uses the Bresenham-style even spread `floor((m+1)f) > floor(m·f)`, so
 * exactly floor(matchups·f) of the m in [0, matchups) are mirrors and they are
 * spread across the generation rather than clustered at the front.
 */
export function isMirrorSlot(m: number, matchups: number, fraction: number): boolean {
	const f = Math.max(0, Math.min(1, fraction));
	if (f <= 0) return false;
	return Math.floor((m + 1) * f) > Math.floor(m * f);
}

export type MatchupKind = 'mirror' | 'heuristic' | 'pfsp';

/**
 * Deterministic three-way slot assignment for matchup `m`: 'mirror' (selfPlayFraction),
 * 'heuristic' (heuristicOpponentFraction, a pure strong-scripted field), or 'pfsp' (the rest).
 * Mirror slots are EXACTLY isMirrorSlot (so runs with heuristicOpponentFraction 0 reproduce the
 * old mirror/PFSP split byte-for-byte). Heuristic slots are error-diffused across the NON-mirror
 * slots, targeting floor(matchups·heuristicFraction) of them (capped at the non-mirror count), so
 * mirror and heuristic never collide and both stay evenly spread.
 */
export function matchupSlotKind(
	m: number,
	matchups: number,
	selfPlayFraction: number,
	heuristicFraction: number
): MatchupKind {
	const sp = Math.max(0, Math.min(1, selfPlayFraction));
	if (isMirrorSlot(m, matchups, sp)) return 'mirror';
	const hf = Math.max(0, Math.min(1, heuristicFraction));
	if (hf <= 0) return 'pfsp';
	// Distribute exactly `target` heuristic slots over the non-mirror slots via integer Bresenham
	// (no float drift). j = m's 0-based index among the non-mirror slots = m minus the mirror slots
	// before it (floor(m·sp), the isMirrorSlot count over [0, m)).
	const nonMirror = matchups - Math.floor(matchups * sp);
	if (nonMirror <= 0) return 'pfsp';
	const target = Math.min(nonMirror, Math.floor(matchups * hf));
	const j = m - Math.floor(m * sp);
	return Math.floor(((j + 1) * target) / nonMirror) > Math.floor((j * target) / nonMirror)
		? 'heuristic'
		: 'pfsp';
}

/**
 * The `count` opponents for a PURE MIRROR matchup: `count` copies of one synthetic
 * frozen member resolving to the learner's CURRENT play weights, so every opponent
 * seat plays exactly the net the learner seat plays. Returns null when the learner
 * has no playable checkpoint yet (fresh-net bootstrap generation) — the caller then
 * falls back to PFSP. The distinct `-mirror` id keeps self-play out of the real
 * opponents' PFSP matchStats.
 */
export function mirrorOpponents(learner: LeagueMember, count: number): LeagueMember[] | null {
	const w = playWeights(learner);
	if (!w) return null;
	const mirror: LeagueMember = {
		id: `${learner.id}-mirror`,
		kind: 'frozen',
		weightsPath: w,
		createdGen: learner.createdGen,
		matchStats: {}
	};
	return Array.from({ length: count }, () => mirror);
}

/** Default strong-scripted field when a heuristic-field matchup names no profiles. */
const DEFAULT_HEURISTIC_FIELD = ['paragon', 'insane'];

/**
 * The `count` opponents for a HEURISTIC-FIELD matchup: synthetic heuristic members whose
 * profiles cycle through config.heuristicOpponentProfiles (default paragon/insane). They carry a
 * `profile` and no weights, so buildMatchup seats them as scripted bots exactly like a PFSP-drawn
 * heuristic anchor. The distinct `-field` id keeps them out of the real anchors' PFSP matchStats.
 */
export function heuristicFieldOpponents(config: LeagueConfig, count: number): LeagueMember[] {
	const profiles = config.heuristicOpponentProfiles?.length
		? config.heuristicOpponentProfiles
		: DEFAULT_HEURISTIC_FIELD;
	return Array.from({ length: count }, (_, i) => {
		const profile = profiles[i % profiles.length];
		return {
			id: `heur-field-${profile}`,
			kind: 'heuristic' as const,
			profile,
			createdGen: 0,
			matchStats: {}
		};
	});
}

/**
 * Opponents for matchup `m` of a generation: a deterministic mirror lineup (selfPlayFraction), a
 * pure strong-heuristic field (heuristicOpponentFraction), or a PFSP lineup (the rest). Only PFSP
 * slots consume the PFSP rand stream, so — as before — the non-PFSP matchups do not perturb the
 * PFSP draw sequence. A learner with no playable checkpoint yet (fresh-net bootstrap) can't mirror,
 * so a would-be mirror slot falls back to PFSP.
 */
/** The fixed non-corrupting seat (config.terminationBlocker) — same shape as a heuristic-field
 *  member, so buildMatchup seats it by profile. Present in a deterministic matchup fraction. */
function blockerMember(profile: string): LeagueMember {
	return { id: `blocker-${profile}`, kind: 'heuristic', profile, createdGen: 0, matchStats: {} };
}

export function matchupOpponents(
	config: LeagueConfig,
	learner: LeagueMember,
	members: LeagueMember[],
	m: number,
	matchups: number,
	rand: () => number
): { opponents: LeagueMember[]; mirror: boolean; heuristic: boolean } {
	if (config.seats <= 1) return { opponents: [], mirror: false, heuristic: false };
	// Termination blocker: reserve one opponent slot in a deterministic fraction of matchups. This
	// creates real late-game data without letting the learner assume another seat always keeps the
	// table alive. The remaining slots use the normal mirror/heuristic/PFSP selection.
	const blockerFraction = Math.max(0, Math.min(1, config.terminationBlockerFraction ?? 1));
	const blockerSlot = Math.floor((m + 1) * blockerFraction) > Math.floor(m * blockerFraction);
	const blocker =
		config.terminationBlocker && blockerSlot ? blockerMember(config.terminationBlocker) : null;
	const count = config.seats - 1 - (blocker ? 1 : 0);
	const withBlocker = (r: { opponents: LeagueMember[]; mirror: boolean; heuristic: boolean }) =>
		blocker ? { ...r, opponents: [...r.opponents, blocker] } : r;
	const kind = matchupSlotKind(
		m,
		matchups,
		config.selfPlayFraction ?? 0,
		config.heuristicOpponentFraction ?? 0
	);
	if (kind === 'mirror') {
		const mir = mirrorOpponents(learner, count);
		if (mir) return withBlocker({ opponents: mir, mirror: true, heuristic: false });
		// Fresh-net bootstrap gen: no checkpoint to mirror yet → ordinary PFSP.
	} else if (kind === 'heuristic') {
		return withBlocker({
			opponents: heuristicFieldOpponents(config, count),
			mirror: false,
			heuristic: true
		});
	}
	return withBlocker({
		opponents: sampleOpponents(learner, members, count, config.pfsp, rand),
		mirror: false,
		heuristic: false
	});
}

/** Fold a pool run's summaries into the learner's matchStats; returns pairwise (score, n). */
function foldSummaries(
	learner: LeagueMember,
	plan: MatchupPlan,
	summaries: GameSummary[],
	opponentsFaced: Record<string, number>
): { scoreSum: number; encounters: number; wins: number } {
	let scoreSum = 0;
	let encounters = 0;
	let wins = 0;
	for (const s of summaries) {
		const mine = s.perSeat.find((x) => x.seat === plan.learnerSeat);
		if (!mine) continue;
		if (mine.placement === 1) wins += 1;
		for (const [seat, opp] of plan.oppBySeat) {
			const theirs = s.perSeat.find((x) => x.seat === seat);
			if (!theirs) continue;
			recordPairwise(learner, opp.id, mine.placement, theirs.placement);
			opponentsFaced[opp.id] = (opponentsFaced[opp.id] ?? 0) + 1;
			scoreSum +=
				mine.placement < theirs.placement ? 1 : mine.placement === theirs.placement ? 0.5 : 0;
			encounters += 1;
		}
	}
	return { scoreSum, encounters, wins };
}

interface TrainerRunResult {
	ms: number;
	optimizerStepsPerEpoch?: number;
	optimizerStepsTotal?: number;
	selfImitationLoss?: number;
	selfImitationSampled?: number;
	selfImitationAccepted?: number;
	selfImitationStale?: number;
	selfImitationPhaseCounts?: [number, number, number, number];
}

function runTrainer(
	config: LeagueConfig,
	dataDir: string,
	outCkpt: string,
	initFrom: string | undefined,
	seed: number,
	model: 'v1' | 'v2' = 'v1',
	generation = 0,
	laneId = 'learner'
): TrainerRunResult {
	const args = [
		'ml/train.py',
		'--data',
		dataDir,
		'--out',
		outCkpt,
		'--mode',
		config.mode,
		'--epochs',
		String(config.train.epochs),
		'--seed',
		String(seed)
	];
	if (model === 'v2') {
		args.push('--model', 'v2');
		if (!initFrom) {
			// Fresh-net dims (train.py ignores these on a warm start).
			if (config.v2?.dModel !== undefined) args.push('--v2-d-model', String(config.v2.dModel));
			if (config.v2?.layers !== undefined) args.push('--v2-layers', String(config.v2.layers));
			if (config.v2?.heads !== undefined) args.push('--v2-heads', String(config.v2.heads));
		}
	}
	if (config.train.beta !== undefined) args.push('--beta', String(config.train.beta));
	if (config.train.batchSize !== undefined)
		args.push('--batch-size', String(config.train.batchSize));
	if (config.train.ppoRowsPerEpoch !== undefined)
		args.push('--ppo-rows-per-epoch', String(config.train.ppoRowsPerEpoch));
	if (config.train.ppoContinuationFraction !== undefined)
		args.push('--ppo-continuation-fraction', String(config.train.ppoContinuationFraction));
	if (config.train.selfImitation) {
		const sil = config.train.selfImitation;
		args.push(
			'--self-imitation-coef',
			String(sil.coef),
			'--self-imitation-replay-fraction',
			String(sil.replayFraction),
			'--self-imitation-staleness-logp',
			String(sil.stalenessLogp ?? 1),
			'--self-imitation-generation',
			String(generation),
			'--self-imitation-max-age',
			String(sil.maxAge ?? 3),
			'--self-imitation-max-rows',
			String(sil.maxRows ?? 100_000),
			'--self-imitation-replay-path',
			join(config.paths.root, 'self-imitation', `${laneId}.pt`)
		);
	}
	if (config.train.hidden?.length) args.push('--hidden', config.train.hidden.join(','));
	if (config.train.valueHidden?.length)
		args.push('--value-hidden', config.train.valueHidden.join(','));
	if (initFrom) args.push('--init-from', resolve(initFrom));
	if (config.train.extraArgs?.length) args.push(...config.train.extraArgs);
	const t0 = performance.now();
	const r = spawnSync(config.pythonBin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const trainerOutput = [r.stdout, r.stderr].filter(Boolean).join('\n');
	// Persist the learner diagnostics per generation. The manager previously
	// swallowed successful-process stdout/stderr, which hid PPO's finite-weight
	// rollback warning and made a byte-identical no-op checkpoint look healthy.
	writeFileSync(join(dataDir, 'train.log'), trainerOutput);
	if (r.status !== 0) {
		const tail = trainerOutput.split('\n').slice(-25).join('\n');
		throw new Error(`league: train.py failed (status ${r.status}):\n${tail}`);
	}
	if (/non-finite weights after a PPO step/i.test(trainerOutput)) {
		const tail = trainerOutput.split('\n').slice(-25).join('\n');
		throw new Error(`league: trainer rolled back a non-finite PPO update:\n${tail}`);
	}
	let optimizerStepsPerEpoch: number | undefined;
	let optimizerStepsTotal: number | undefined;
	if (config.train.ppoRowsPerEpoch !== undefined) {
		const batchSize = config.train.batchSize ?? 256;
		optimizerStepsPerEpoch = Math.ceil(config.train.ppoRowsPerEpoch / batchSize);
		// Anchor to the low-level PPO line. Option-enabled runs also report a separately
		// preregistered `option_optimizer_steps` budget; it must not inflate this guard.
		const reported = [...trainerOutput.matchAll(/^PPO epoch .*optimizer_steps=(\d+)$/gm)].map(
			(match) => Number.parseInt(match[1], 10)
		);
		if (
			reported.length !== config.train.epochs ||
			reported.some((steps) => steps !== optimizerStepsPerEpoch)
		) {
			throw new Error(
				`league: fixed-update trainer reported optimizer steps ${JSON.stringify(reported)}, ` +
					`expected ${optimizerStepsPerEpoch} for each of ${config.train.epochs} epochs`
			);
		}
		optimizerStepsTotal = optimizerStepsPerEpoch * config.train.epochs;
		const extra = config.train.extraArgs ?? [];
		const optionRowsAt = extra.lastIndexOf('--option-rows-per-epoch');
		if (optionRowsAt >= 0) {
			const optionBatchAt = extra.lastIndexOf('--option-batch-size');
			const optionRows = Number.parseInt(extra[optionRowsAt + 1] ?? '', 10);
			const optionBatch = Number.parseInt(extra[optionBatchAt + 1] ?? '', 10);
			if (!(optionRows > 0) || optionBatchAt < 0 || !(optionBatch > 0)) {
				throw new Error('league: option fixed-update budget requires positive row and batch sizes');
			}
			const expectedOptionSteps = Math.ceil(optionRows / optionBatch);
			const reportedOption = [
				...trainerOutput.matchAll(
					/^Option PPO epoch [^\n]*\boption_optimizer_steps=(\d+)\b[^\n]*$/gm
				)
			].map((match) => Number.parseInt(match[1], 10));
			if (
				reportedOption.length !== config.train.epochs ||
				reportedOption.some((steps) => steps !== expectedOptionSteps)
			) {
				throw new Error(
					`league: option fixed-update trainer reported optimizer steps ${JSON.stringify(reportedOption)}, ` +
						`expected ${expectedOptionSteps} for each of ${config.train.epochs} epochs`
				);
			}
		}
	}
	let selfImitationDiagnostics: Omit<
		TrainerRunResult,
		'ms' | 'optimizerStepsPerEpoch' | 'optimizerStepsTotal'
	> = {};
	if (config.train.selfImitation) {
		const matches = [
			...trainerOutput.matchAll(
				/self_imitation_loss=([^ ]+) \(coef=[^,]+, accepted=(\d+)\/(\d+), stale=(\d+), phases\(route\/build\/convert\/yield\)=(\d+)\/(\d+)\/(\d+)\/(\d+)\)/g
			)
		];
		if (matches.length !== config.train.epochs) {
			throw new Error(
				`league: self-imitation trainer diagnostics missing epochs: ` +
					`reported ${matches.length}, expected ${config.train.epochs}`
			);
		}
		const last = matches.at(-1)!;
		selfImitationDiagnostics = {
			selfImitationLoss: Number(last[1]),
			selfImitationAccepted: Number.parseInt(last[2], 10),
			selfImitationSampled: Number.parseInt(last[3], 10),
			selfImitationStale: Number.parseInt(last[4], 10),
			selfImitationPhaseCounts: [
				Number.parseInt(last[5], 10),
				Number.parseInt(last[6], 10),
				Number.parseInt(last[7], 10),
				Number.parseInt(last[8], 10)
			]
		};
	}
	if (
		model === 'v1' &&
		initFrom &&
		existsSync(initFrom) &&
		existsSync(outCkpt) &&
		readFileSync(initFrom).equals(readFileSync(outCkpt))
	) {
		throw new Error(
			`league: trainer produced a byte-identical no-op checkpoint: ${outCkpt}; ` +
				`see ${join(dataDir, 'train.log')}`
		);
	}
	return {
		ms: performance.now() - t0,
		...(optimizerStepsPerEpoch !== undefined ? { optimizerStepsPerEpoch } : {}),
		...(optimizerStepsTotal !== undefined ? { optimizerStepsTotal } : {}),
		...selfImitationDiagnostics
	};
}

/** Distill a v2 .pt teacher into a v1-JSON student on the lane's paired data. */
function runDistiller(
	config: LeagueConfig,
	dataDir: string,
	teacherPt: string,
	outJson: string
): number {
	const args = [
		'ml/distill.py',
		'--data',
		dataDir,
		'--teacher',
		resolve(teacherPt),
		'--out',
		resolve(outJson),
		'--epochs',
		String(config.v2?.distillEpochs ?? 6)
	];
	const t0 = performance.now();
	const r = spawnSync(config.pythonBin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) {
		const tail = (r.stderr || r.stdout || '').split('\n').slice(-25).join('\n');
		throw new Error(`league: distill.py failed (status ${r.status}):\n${tail}`);
	}
	return performance.now() - t0;
}

/** Most recent matching line from the shared gauntlet history.
 *
 * Multiple league processes may finish gauntlets concurrently. Reading only the
 * final line can attribute another league's Elo to this checkpoint, so match the
 * immutable weights path and scan backward instead.
 */
export function lastGauntletElo(
	weightsPath?: string,
	file = resolve('ml/gauntlet_results/history.jsonl')
): number | undefined {
	if (!existsSync(file)) return undefined;
	const lines = readFileSync(file, 'utf8').trim().split('\n');
	const expected = weightsPath ? resolve(weightsPath) : undefined;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		if (!lines[i]) continue;
		let row: { elo?: number; weights?: string };
		try {
			row = JSON.parse(lines[i]) as { elo?: number; weights?: string };
		} catch {
			continue;
		}
		if (expected && (typeof row.weights !== 'string' || resolve(row.weights) !== expected))
			continue;
		if (typeof row.elo === 'number') return row.elo;
	}
	return undefined;
}

export interface GenerationReport {
	gen: number;
	lanes: HistoryLine[];
}

/** Stable learner RNG seed. Actor/environment seeds are already derived from
 * seedBase, but PPO formerly entropy-seeded its minibatch shuffle, which made
 * supposedly paired architecture/reward experiments incomparable. */
export function trainerSeedForGeneration(
	config: Pick<LeagueConfig, 'seedBase'>,
	gen: number,
	laneIdx: number
): number {
	const seed = config.seedBase + gen * 1_000_003 + laneIdx * 1009 + 73;
	if (!Number.isSafeInteger(seed) || seed < 0) {
		throw new Error(`league: invalid trainer seed ${seed} for gen=${gen} lane=${laneIdx}`);
	}
	return seed;
}

/** Run ONE generation across all learner lanes. Returns the appended history lines. */
export async function runGeneration(root: string): Promise<GenerationReport> {
	const { config, state } = loadLeague(root);
	const p = leaguePaths(root);
	const gen = state.gen + 1;
	const learners = learnersOf(state);
	if (learners.length === 0) throw new Error('league: no learner lanes configured');
	mkdirSync(p.checkpoints, { recursive: true });
	const lines: HistoryLine[] = [];

	for (let laneIdx = 0; laneIdx < learners.length; laneIdx++) {
		const learner = learners[laneIdx];
		const model = laneModelOf(config, learner);
		const trainerSeed = trainerSeedForGeneration(config, gen, laneIdx);
		const laneDir = p.laneData(gen, learner.id);
		mkdirSync(laneDir, { recursive: true });
		state.phase = `gen${gen}:${learner.id}:games`;
		saveStateAtomic(root, state);

		// v1 lanes opt into socket play via config.v1Infer once they have a JSON to serve
		// (the fresh-exploiter bootstrap gen plays heuristic in-process). Skipped when the
		// lane runs Gumbel search — its rollouts need the local net, not the socket.
		const v1SocketWeights =
			model === 'v1' && config.v1Infer && !config.search ? playWeights(learner) : undefined;

		// v2 lane with a checkpoint (or a v1Infer lane with a JSON): the learner plays
		// through the lane's server. Otherwise (fresh net) the bootstrap gen is heuristic.
		let laneServer =
			model === 'v2' && lanePt(learner)
				? await ensureInferServer(
						config,
						root,
						laneIdx,
						learner.id,
						lanePt(learner)!,
						config.v2 ?? {}
					)
				: v1SocketWeights
					? await ensureInferServer(
							config,
							root,
							laneIdx,
							learner.id,
							v1SocketWeights,
							config.v1Infer!
						)
					: undefined;
		const v2Arg = model === 'v2' ? { socket: laneServer?.socket } : undefined;
		const v1SocketArg = v1SocketWeights ? laneServer!.socket : undefined;

		// Deterministic PFSP draw for this (gen, lane).
		const rng = createRng(config.seedBase + gen * 1009 + laneIdx * 101);
		const rand = (): number => nextInt(rng, 1_000_000_000) / 1_000_000_000;

		// ── 1+2: PFSP lineups → actor-pool game generation ──────────────────
		// Matchup pools run CONCURRENTLY (bounded): each writes its own m-<i>/
		// subdir (trainers rglob *.jsonl recursively), because a shared laneDir in
		// append mode would race per-workerIndex shard files across pools. Plans
		// are built up-front so the PFSP RNG draw order — and therefore the lineup
		// sequence — is identical to the old sequential loop.
		const matchups = Math.ceil(config.gamesPerGen / config.matchupGames);
		const opponentsFaced: Record<string, number> = {};
		for (const f of readdirSync(laneDir)) {
			if (/^m-\d+$/.test(f)) rmSync(join(laneDir, f), { recursive: true, force: true });
		}
		let mirrorMatchups = 0;
		let heuristicMatchups = 0;
		const trainingSeatCounts = trainingSeatCountsForGeneration(config, gen, matchups);
		const trainingSeatMatchups = trainingSeatCounts.reduce<Record<string, number>>(
			(counts, seats) => {
				counts[String(seats)] = (counts[String(seats)] ?? 0) + 1;
				return counts;
			},
			{}
		);
		const plans = Array.from({ length: matchups }, (_, m) => {
			const matchupConfig: LeagueConfig = { ...config, seats: trainingSeatCounts[m] };
			const { opponents, mirror, heuristic } = matchupOpponents(
				matchupConfig,
				learner,
				state.members,
				m,
				matchups,
				rand
			);
			if (mirror) mirrorMatchups += 1;
			if (heuristic) heuristicMatchups += 1;
			const plan = buildMatchup(matchupConfig, learner, opponents, m, gen, v2Arg, v1SocketArg);
			if (matchupConfig.seats === 1) {
				plan.config.maxStatusLevel = config.soloMaxStatusLevel ?? 2;
				if (config.continuationCurriculum?.enabled) {
					plan.config.continuationCurriculum = config.continuationCurriculum;
				}
			}
			const count = Math.min(config.matchupGames, config.gamesPerGen - m * config.matchupGames);
			const seed0 = config.seedBase + gen * 1_000_000 + laneIdx * 100_000 + m * config.matchupGames;
			const seeds = Array.from({ length: count }, (_, i) => seed0 + i);
			return { m, plan, seeds };
		});
		const totalWorkers = config.workers ?? Math.max(1, cpus().length - 1);
		const concurrency = Math.max(
			1,
			Math.min(
				config.matchupConcurrency ?? Math.floor(totalWorkers / Math.max(1, config.matchupGames)),
				matchups
			)
		);
		const results: Awaited<ReturnType<typeof runActorPool>>[] = new Array(plans.length);
		const tPool = performance.now();
		let nextPlan = 0;
		await Promise.all(
			Array.from({ length: concurrency }, async () => {
				while (nextPlan < plans.length) {
					const job = plans[nextPlan++];
					// Workers per pool = the budget share of this concurrency slot (the
					// pool itself clamps to seeds.length). Deliberately NOT matchupGames:
					// with matchupGames > workers-per-pool each worker plays several
					// games, amortizing the per-worker-thread engine import (~seconds —
					// it dominates when every worker plays a single ~0.2s game).
					results[job.m] = await runActorPool({
						seeds: job.seeds,
						outDir: join(laneDir, `m-${job.m}`),
						config: job.plan.config,
						workers: Math.max(1, Math.ceil(totalWorkers / concurrency))
					});
				}
			})
		);
		const poolWallMs = performance.now() - tPool;
		let games = 0;
		let samples = 0;
		let continuationCurriculum: ContinuationCurriculumDiagnostics | undefined;
		if (config.continuationCurriculum?.enabled) {
			continuationCurriculum = {
				eligibleSourceGames: 0,
				selectedSourceGames: 0,
				episodes: 0,
				rows: 0,
				wallMs: 0,
				sourceCapFailures: 0,
				sourceSuccesses: 0,
				forkSuccesses: 0,
				forkFailures: 0,
				recoveries: 0,
				skippedNoSnapshot: 0,
				sourceRoundCounts: {},
				forkRoundCounts: {}
			};
		}
		for (const job of plans) {
			const res = results[job.m];
			games += res.games;
			samples += res.samples;
			if (continuationCurriculum) {
				for (const key of [
					'eligibleSourceGames',
					'selectedSourceGames',
					'episodes',
					'rows',
					'wallMs',
					'sourceCapFailures',
					'sourceSuccesses',
					'forkSuccesses',
					'forkFailures',
					'recoveries',
					'skippedNoSnapshot'
				] as const) {
					continuationCurriculum[key] += res.curriculum[key];
				}
				for (const key of ['sourceRoundCounts', 'forkRoundCounts'] as const) {
					for (const [round, count] of Object.entries(res.curriculum[key])) {
						continuationCurriculum[key][round] = (continuationCurriculum[key][round] ?? 0) + count;
					}
				}
			}
			foldSummaries(learner, job.plan, res.summaries, opponentsFaced);
		}
		// Each pool wrote meta.json in its OWN m-<i>/ dir (dims, obs_version, and
		// the obs_v2 block v2 training needs) — merge lane totals into a root-level
		// meta.json from the first matchup's copy (load_dims_from_meta reads the
		// data root, not the shard subdirs).
		const metaPath = join(laneDir, 'meta.json');
		const firstMeta = join(laneDir, 'm-0', 'meta.json');
		const poolMeta = existsSync(firstMeta)
			? (JSON.parse(readFileSync(firstMeta, 'utf8')) as Record<string, unknown>)
			: {};
		writeFileSync(
			metaPath,
			JSON.stringify({
				obs_dim: OBS_DIM,
				act_dim: ACT_DIM,
				...poolMeta,
				gen,
				lane: learner.id,
				trainerSeed,
				games,
				samples,
				...(continuationCurriculum ? { continuation_curriculum: continuationCurriculum } : {})
			})
		);

		// ── 3: train ─────────────────────────────────────────────────────────
		state.phase = `gen${gen}:${learner.id}:train`;
		saveStateAtomic(root, state);
		const ckpt = join(p.checkpoints, `${learner.id}-gen${gen}.${model === 'v2' ? 'pt' : 'json'}`);
		const trainInit = model === 'v2' ? lanePt(learner) : playWeights(learner);
		const trainerRun = runTrainer(
			config,
			laneDir,
			ckpt,
			trainInit,
			trainerSeed,
			model,
			gen,
			learner.id
		);
		const trainMs = trainerRun.ms;

		// Socket-served lanes (v2, or v1Infer): hot-swap the lane server onto the fresh
		// checkpoint (or first-start it for a lane that just trained its first net —
		// e.g. a v1Infer exploiter whose bootstrap gen was heuristic) BEFORE eval plays
		// through it. A v1Infer lane serves the eval on the just-trained JSON.
		const useV1SocketEval = model === 'v1' && !!config.v1Infer && !config.search;
		if (model === 'v2' || useV1SocketEval) {
			const knobs = model === 'v2' ? (config.v2 ?? {}) : config.v1Infer!;
			if (laneServer && laneServer.child.exitCode === null) {
				await hotSwapInferServer(laneServer, ckpt);
			} else {
				laneServer = await ensureInferServer(config, root, laneIdx, learner.id, ckpt, knobs);
			}
		}
		const v2Eval = model === 'v2' ? { socket: laneServer!.socket } : undefined;
		const v1EvalSocket = useV1SocketEval ? laneServer!.socket : undefined;

		// v2 → v1 distilled student: the member's gauntlet + opponent-seat proxy.
		let distilled: string | undefined;
		let distillMs = 0;
		const promotionDue =
			learner.kind === 'main' && config.promoteEvery > 0 && gen % config.promoteEvery === 0;
		if (model === 'v2' && (config.v2?.distillEveryGen || promotionDue)) {
			state.phase = `gen${gen}:${learner.id}:distill`;
			saveStateAtomic(root, state);
			distilled = join(p.checkpoints, `${learner.id}-gen${gen}-distilled.json`);
			distillMs = runDistiller(config, laneDir, ckpt, distilled);
		}

		// ── 4: quick eval vs the fixed field, learner seat rotating ──────────
		state.phase = `gen${gen}:${learner.id}:eval`;
		saveStateAtomic(root, state);
		const evalDir = p.laneEvalData(gen, learner.id);
		mkdirSync(evalDir, { recursive: true });
		const evalOpps = config.evalOpponents.map((id) => memberById(state, id)).filter(isPlayable);
		if (evalOpps.length < config.seats - 1) {
			throw new Error(`league: evalOpponents must name ≥ ${config.seats - 1} playable members`);
		}
		const evalField = evalOpps.slice(0, config.seats - 1);
		const tEval = performance.now();
		let evalScore = 0;
		let evalEncounters = 0;
		let evalWins = 0;
		let evalGames = 0;
		let evalReach30 = 0;
		let evalVpSum = 0;
		let evalFirst30RoundSum = 0;
		let evalFirst30Count = 0;
		let evalStalls = 0;
		const trained: LeagueMember =
			model === 'v2' ? { ...learner, ptPath: ckpt } : { ...learner, weightsPath: ckpt };
		for (let r = 0; r < config.seats && evalGames < config.evalGames; r++) {
			const count = Math.min(
				Math.ceil(config.evalGames / config.seats),
				config.evalGames - evalGames
			);
			const plan = buildMatchup(config, trained, evalField, r, gen, v2Eval, v1EvalSocket);
			plan.config.recordSeats = [];
			plan.config.sample = false;
			// Eval measures the RAW net (what ships/promotes) — never the searched agent.
			plan.config.search = undefined;
			const seed0 = config.seedBase + 500_000_000 + gen * 1_000_000 + laneIdx * 100_000 + r * 1000;
			const res = await runActorPool({
				seeds: Array.from({ length: count }, (_, i) => seed0 + i),
				outDir: evalDir,
				config: plan.config,
				workers: config.workers,
				append: r > 0
			});
			const fold = foldSummaries(learner, plan, res.summaries, opponentsFaced);
			evalScore += fold.scoreSum;
			evalEncounters += fold.encounters;
			evalWins += fold.wins;
			for (const summary of res.summaries) {
				const learnerSummary = summary.perSeat.find((seat) => seat.seat === plan.learnerSeat);
				if (!learnerSummary) continue;
				evalVpSum += learnerSummary.finalVP;
				if (learnerSummary.finalVP >= 30 && !summary.stalled) evalReach30 += 1;
				const first30Round = learnerSummary.cycle?.first30Round;
				if (!summary.stalled && first30Round !== null && first30Round !== undefined) {
					evalFirst30RoundSum += first30Round;
					evalFirst30Count += 1;
				}
				if (summary.stalled) evalStalls += 1;
			}
			evalGames += res.games;
		}
		const evalMs = performance.now() - tEval;

		// ── 5: accept + (main lanes) gauntlet promotion check ────────────────
		if (model === 'v2') {
			learner.ptPath = ckpt;
			if (distilled) learner.distilledPath = distilled;
		} else {
			learner.weightsPath = ckpt;
		}
		let promoted: boolean | null = null;
		let gauntletElo: number | undefined;
		if (promotionDue) {
			// v2 members are gauntlet-scored via their DISTILLED student — the gauntlet
			// harness is v1-JSON-only (TODO: direct socket gauntlet).
			const gauntletTarget = model === 'v2' ? distilled! : ckpt;
			state.phase = `gen${gen}:${learner.id}:gauntlet`;
			saveStateAtomic(root, state);
			const [cmd, ...cmdArgs] = config.gauntletCmd;
			const g = spawnSync(cmd, [...cmdArgs, gauntletTarget], {
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024
			});
			if (g.status !== 0) {
				throw new Error(
					`league: gauntlet failed (status ${g.status}): ${(g.stderr || '').slice(-2000)}`
				);
			}
			gauntletElo = lastGauntletElo(gauntletTarget);
			const bestFrozen = promotionBar(state.members);
			promoted = gauntletElo !== undefined && gauntletElo > bestFrozen + config.promoteMarginElo;
			if (promoted) {
				const frozenId = `frozen-${learner.id}-gen${gen}`;
				const frozenJson = join(p.checkpoints, `${frozenId}.json`);
				copyFileSync(gauntletTarget, frozenJson);
				let frozenPt: string | undefined;
				if (model === 'v2') {
					frozenPt = join(p.checkpoints, `${frozenId}.pt`);
					copyCheckpoint(ckpt, frozenPt);
				}
				state.members.push({
					id: frozenId,
					kind: 'frozen',
					...(model === 'v2' ? { model: 'v2' as const, ptPath: frozenPt } : {}),
					weightsPath: frozenJson,
					createdGen: gen,
					eloVsAnchors: gauntletElo,
					matchStats: {}
				});
			}
			if (gauntletElo !== undefined) learner.eloVsAnchors = gauntletElo;
		}

		// ── 6: history line + state save ─────────────────────────────────────
		const line: HistoryLine = {
			ts: new Date().toISOString(),
			gen,
			lane: learner.id,
			kind: learner.kind,
			games,
			samples,
			opponents: opponentsFaced,
			...(mirrorMatchups > 0 ? { mirrorMatchups } : {}),
			...(heuristicMatchups > 0 ? { heuristicMatchups } : {}),
			trainingSeatMatchups,
			...(continuationCurriculum ? { continuationCurriculum } : {}),
			trainerSeed,
			...(trainerRun.optimizerStepsPerEpoch !== undefined
				? { optimizerStepsPerEpoch: trainerRun.optimizerStepsPerEpoch }
				: {}),
			...(trainerRun.optimizerStepsTotal !== undefined
				? { optimizerStepsTotal: trainerRun.optimizerStepsTotal }
				: {}),
			...(trainerRun.selfImitationLoss !== undefined
				? {
						selfImitationLoss: trainerRun.selfImitationLoss,
						selfImitationSampled: trainerRun.selfImitationSampled,
						selfImitationAccepted: trainerRun.selfImitationAccepted,
						selfImitationStale: trainerRun.selfImitationStale,
						selfImitationPhaseCounts: trainerRun.selfImitationPhaseCounts
					}
				: {}),
			poolWallMs: Math.round(poolWallMs),
			trainMs: Math.round(trainMs),
			...(distillMs > 0 ? { distillMs: Math.round(distillMs) } : {}),
			evalMs: Math.round(evalMs),
			evalGames,
			evalWinRate: evalGames > 0 ? evalWins / evalGames : 0,
			evalReach30Rate: evalGames > 0 ? evalReach30 / evalGames : 0,
			evalMeanVP: evalGames > 0 ? evalVpSum / evalGames : 0,
			evalMeanFirst30Round: evalFirst30Count > 0 ? evalFirst30RoundSum / evalFirst30Count : null,
			evalStallRate: evalGames > 0 ? evalStalls / evalGames : 0,
			evalPairwiseScore: evalEncounters > 0 ? evalScore / evalEncounters : 0,
			eloEstimate: eloFromScore(evalScore, evalEncounters),
			ckpt,
			model,
			...(distilled ? { distilledCkpt: distilled } : {}),
			promoted,
			...(gauntletElo !== undefined ? { gauntletElo } : {})
		};
		appendFileSync(p.history, JSON.stringify(line) + '\n');
		lines.push(line);
		saveStateAtomic(root, state);
	}

	state.gen = gen;
	state.phase = 'idle';
	saveStateAtomic(root, state);
	return { gen, lanes: lines };
}

/** Run `n` generations back-to-back (each resumes from persisted state). v2 lane
 *  inference servers persist ACROSS generations here and are killed on the way
 *  out — success or crash. Standalone runGeneration callers own that cleanup
 *  themselves (call stopInferServers in a finally). */
export async function runGenerations(root: string, n: number): Promise<GenerationReport[]> {
	const out: GenerationReport[] = [];
	try {
		for (let i = 0; i < n; i++) out.push(await runGeneration(root));
	} finally {
		stopInferServers();
	}
	return out;
}

/** Compact status view for the CLI. */
export function leagueStatus(root: string): {
	gen: number;
	phase: string;
	members: {
		id: string;
		kind: string;
		model?: 'v1' | 'v2';
		ckpt?: string;
		eloVsAnchors?: number;
		games: number;
	}[];
	lastLines: HistoryLine[];
} {
	const { state } = loadLeague(root);
	const p = leaguePaths(root);
	const lastLines: HistoryLine[] = existsSync(p.history)
		? readFileSync(p.history, 'utf8')
				.trim()
				.split('\n')
				.slice(-6)
				.map((l) => JSON.parse(l) as HistoryLine)
		: [];
	const totalGames = (ms: Record<string, MatchStats>): number =>
		Object.values(ms).reduce((a, s) => a + s.games, 0);
	return {
		gen: state.gen,
		phase: state.phase,
		members: state.members.map((m) => ({
			id: m.id,
			kind: m.kind,
			model: m.model,
			ckpt: m.model === 'v2' ? m.ptPath : m.weightsPath,
			eloVsAnchors: m.eloVsAnchors,
			games: totalGames(m.matchStats)
		})),
		lastLines
	};
}
