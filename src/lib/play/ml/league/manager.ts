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
 */

import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRng, nextInt } from '../../rng';
import { SEAT_COLORS, type SeatColor } from '../../types';
import { runActorPool } from '../actorPool';
import { ACT_DIM, OBS_DIM } from '../encode';
import { CHECKPOINT_ANCHORS, HEURISTIC_ANCHORS, eloFromScore } from '../gauntlet/manifest';
import type { ActorGameConfig, GameSummary } from '../poolTypes';
import { isPlayable, recordPairwise, sampleOpponents } from './pfsp';
import type {
	HistoryLine,
	LeagueConfig,
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
		paths: { ...base.paths, ...over.paths }
	};
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
	const state = JSON.parse(readFileSync(p.state, 'utf8')) as LeagueState;
	return { config, state };
}

// ── Init: seed the roster ────────────────────────────────────────────────────

/**
 * Seed roster: the 8 gauntlet heuristic anchors + every active frozen checkpoint
 * anchor, plus the configured learner lanes. Main lanes warm-start from
 * config.initFrom; exploiter lanes start fresh (see bootstrap note in header).
 */
export function seedRoster(config: LeagueConfig): LeagueMember[] {
	const members: LeagueMember[] = [];
	for (const name of HEURISTIC_ANCHORS) {
		members.push({ id: `heur-${name}`, kind: 'heuristic', profile: name, createdGen: 0, matchStats: {} });
	}
	for (const c of CHECKPOINT_ANCHORS) {
		if (c.status !== 'active') continue;
		members.push({ id: `frozen-${c.name}`, kind: 'frozen', weightsPath: c.path, createdGen: 0, matchStats: {} });
	}
	for (let i = 0; i < config.lanes.main; i++) {
		members.push({ id: `main-${i}`, kind: 'main', initFrom: config.initFrom, createdGen: 0, matchStats: {} });
	}
	for (let i = 0; i < config.lanes.mainExploiter; i++) {
		members.push({ id: `main_exploiter-${i}`, kind: 'main_exploiter', createdGen: 0, matchStats: {} });
	}
	for (let i = 0; i < config.lanes.leagueExploiter; i++) {
		members.push({ id: `league_exploiter-${i}`, kind: 'league_exploiter', createdGen: 0, matchStats: {} });
	}
	return members;
}

/**
 * Initialize a league root: write config.json (defaults merged with `overrides`)
 * and a seeded state.json. Idempotent: an already-initialized root is loaded and
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
	const config = mergeConfig(defaultConfig(root), overrides);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.checkpoints, { recursive: true });
	if (!existsSync(p.config)) writeFileSync(p.config, JSON.stringify(config, null, '\t'));
	const state: LeagueState = {
		version: 'league-v1',
		gen: 0,
		members: seedRoster(config),
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

/** The weights an opponent member plays with (frozen path, or a learner's current ckpt). */
function playWeights(m: LeagueMember): string | undefined {
	return m.weightsPath ?? m.initFrom;
}

interface MatchupPlan {
	learnerSeat: SeatColor;
	/** Opponent member per non-learner seat, in seat order. */
	oppBySeat: [SeatColor, LeagueMember][];
	config: ActorGameConfig;
}

/** Build the ActorGameConfig for one lineup, learner in seat `learnerSeatIdx`. */
export function buildMatchup(
	config: LeagueConfig,
	learner: LeagueMember,
	opponents: LeagueMember[],
	learnerSeatIdx: number,
	iter: number
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
	const learnerWeights = playWeights(learner);
	return {
		learnerSeat,
		oppBySeat,
		config: {
			seats: config.seats,
			maxRounds: config.maxRounds,
			profiles,
			weightsPath: learnerWeights ? resolve(learnerWeights) : undefined,
			selection: config.selection,
			sample: config.sample,
			temperature: config.temperature,
			neuralSeats: learnerWeights ? [learnerSeat] : undefined,
			recordSeats: [learnerSeat],
			opponentWeights: Object.keys(opponentWeights).length ? opponentWeights : undefined,
			gamma: config.gamma,
			iter
		}
	};
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
			scoreSum += mine.placement < theirs.placement ? 1 : mine.placement === theirs.placement ? 0.5 : 0;
			encounters += 1;
		}
	}
	return { scoreSum, encounters, wins };
}

function runTrainer(
	config: LeagueConfig,
	dataDir: string,
	outCkpt: string,
	initFrom: string | undefined
): number {
	const args = [
		'ml/train.py',
		'--data', dataDir,
		'--out', outCkpt,
		'--mode', config.mode,
		'--epochs', String(config.train.epochs)
	];
	if (config.train.beta !== undefined) args.push('--beta', String(config.train.beta));
	if (config.train.batchSize !== undefined) args.push('--batch-size', String(config.train.batchSize));
	if (initFrom) args.push('--init-from', resolve(initFrom));
	if (config.train.extraArgs?.length) args.push(...config.train.extraArgs);
	const t0 = performance.now();
	const r = spawnSync(config.pythonBin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) {
		const tail = (r.stderr || r.stdout || '').split('\n').slice(-25).join('\n');
		throw new Error(`league: train.py failed (status ${r.status}):\n${tail}`);
	}
	return performance.now() - t0;
}

/** Last line of ml/gauntlet_results/history.jsonl (the nightly-gauntlet append). */
function lastGauntletElo(): number | undefined {
	const file = resolve('ml/gauntlet_results/history.jsonl');
	if (!existsSync(file)) return undefined;
	const lines = readFileSync(file, 'utf8').trim().split('\n');
	if (lines.length === 0) return undefined;
	const last = JSON.parse(lines[lines.length - 1]) as { elo?: number };
	return typeof last.elo === 'number' ? last.elo : undefined;
}

export interface GenerationReport {
	gen: number;
	lanes: HistoryLine[];
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
		const laneDir = p.laneData(gen, learner.id);
		mkdirSync(laneDir, { recursive: true });
		state.phase = `gen${gen}:${learner.id}:games`;
		saveStateAtomic(root, state);

		// Deterministic PFSP draw for this (gen, lane).
		const rng = createRng(config.seedBase + gen * 1009 + laneIdx * 101);
		const rand = (): number => nextInt(rng, 1_000_000_000) / 1_000_000_000;

		// ── 1+2: PFSP lineups → actor-pool game generation ──────────────────
		const matchups = Math.ceil(config.gamesPerGen / config.matchupGames);
		const opponentsFaced: Record<string, number> = {};
		let poolWallMs = 0;
		let games = 0;
		let samples = 0;
		for (let m = 0; m < matchups; m++) {
			const opps = sampleOpponents(learner, state.members, config.seats - 1, config.pfsp, rand);
			const plan = buildMatchup(config, learner, opps, m, gen);
			const count = Math.min(config.matchupGames, config.gamesPerGen - m * config.matchupGames);
			const seed0 = config.seedBase + gen * 1_000_000 + laneIdx * 100_000 + m * config.matchupGames;
			const seeds = Array.from({ length: count }, (_, i) => seed0 + i);
			const res = await runActorPool({
				seeds,
				outDir: laneDir,
				config: plan.config,
				workers: config.workers,
				append: m > 0
			});
			poolWallMs += res.wallMs;
			games += res.games;
			samples += res.samples;
			foldSummaries(learner, plan, res.summaries, opponentsFaced);
		}
		// train.py infers dims from meta.json; without it the fallback reads the
		// FIRST sorted *.jsonl — games-0.jsonl, which has no obs — and crashes.
		writeFileSync(
			join(laneDir, 'meta.json'),
			JSON.stringify({ obs_dim: OBS_DIM, act_dim: ACT_DIM, gen, lane: learner.id, games, samples })
		);

		// ── 3: train ─────────────────────────────────────────────────────────
		state.phase = `gen${gen}:${learner.id}:train`;
		saveStateAtomic(root, state);
		const ckpt = join(p.checkpoints, `${learner.id}-gen${gen}.json`);
		const trainMs = runTrainer(config, laneDir, ckpt, playWeights(learner));

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
		const trained: LeagueMember = { ...learner, weightsPath: ckpt };
		for (let r = 0; r < config.seats && evalGames < config.evalGames; r++) {
			const count = Math.min(
				Math.ceil(config.evalGames / config.seats),
				config.evalGames - evalGames
			);
			const plan = buildMatchup(config, trained, evalField, r, gen);
			plan.config.recordSeats = [];
			plan.config.sample = false;
			const seed0 =
				config.seedBase + 500_000_000 + gen * 1_000_000 + laneIdx * 100_000 + r * 1000;
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
			evalGames += res.games;
		}
		const evalMs = performance.now() - tEval;

		// ── 5: accept + (main lanes) gauntlet promotion check ────────────────
		learner.weightsPath = ckpt;
		let promoted: boolean | null = null;
		let gauntletElo: number | undefined;
		if (learner.kind === 'main' && config.promoteEvery > 0 && gen % config.promoteEvery === 0) {
			state.phase = `gen${gen}:${learner.id}:gauntlet`;
			saveStateAtomic(root, state);
			const [cmd, ...cmdArgs] = config.gauntletCmd;
			const g = spawnSync(cmd, [...cmdArgs, ckpt], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
			if (g.status !== 0) {
				throw new Error(`league: gauntlet failed (status ${g.status}): ${(g.stderr || '').slice(-2000)}`);
			}
			gauntletElo = lastGauntletElo();
			const bestFrozen = Math.max(
				...state.members
					.filter((m) => m.kind === 'frozen' && typeof m.eloVsAnchors === 'number')
					.map((m) => m.eloVsAnchors as number),
				-Infinity
			);
			promoted =
				gauntletElo !== undefined && gauntletElo > bestFrozen + config.promoteMarginElo;
			if (promoted) {
				const frozenPath = join(p.checkpoints, `frozen-${learner.id}-gen${gen}.json`);
				copyFileSync(ckpt, frozenPath);
				state.members.push({
					id: `frozen-${learner.id}-gen${gen}`,
					kind: 'frozen',
					weightsPath: frozenPath,
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
			poolWallMs: Math.round(poolWallMs),
			trainMs: Math.round(trainMs),
			evalMs: Math.round(evalMs),
			evalGames,
			evalWinRate: evalGames > 0 ? evalWins / evalGames : 0,
			evalPairwiseScore: evalEncounters > 0 ? evalScore / evalEncounters : 0,
			eloEstimate: eloFromScore(evalScore, evalEncounters),
			ckpt,
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

/** Run `n` generations back-to-back (each resumes from persisted state). */
export async function runGenerations(root: string, n: number): Promise<GenerationReport[]> {
	const out: GenerationReport[] = [];
	for (let i = 0; i < n; i++) out.push(await runGeneration(root));
	return out;
}

/** Compact status view for the CLI. */
export function leagueStatus(root: string): {
	gen: number;
	phase: string;
	members: { id: string; kind: string; ckpt?: string; eloVsAnchors?: number; games: number }[];
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
			ckpt: m.weightsPath,
			eloVsAnchors: m.eloVsAnchors,
			games: totalGames(m.matchStats)
		})),
		lastLines
	};
}
