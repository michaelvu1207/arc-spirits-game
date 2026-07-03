/**
 * League-manager scaffold tests.
 *
 *   - PFSP math + lane rules (always runs; pure).
 *   - Roster seeding + atomic state round-trip (always runs; tmpdir).
 *   - v2-lane wiring: laneModel stamping, opponent-playability rules, buildMatchup
 *     socket/obsVersion config (always runs; pure).
 *   - SMOKE=1: one end-to-end v1 micro-generation — PFSP → actor pool →
 *     ml/train.py (awr, 1 epoch) → quick eval → history line + new ckpt.
 *   - SMOKE_V2=1: one end-to-end v2 micro-generation — heuristic bootstrap at
 *     obsVersion 2 → train.py --model v2 (fresh tiny transformer, .pt) → manager
 *     spawns ml/infer_server.py → eval through the socket → distill → history.
 *
 *   SMOKE=1    npx vitest run src/lib/play/ml/league/_league_scaffold.test.ts --disable-console-intercept
 *   SMOKE_V2=1 npx vitest run src/lib/play/ml/league/_league_scaffold.test.ts --disable-console-intercept
 */
import { OBS_DIM } from '../encode';
import { describe, expect, it } from 'vitest';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	PFSP_WEIGHT_FLOOR,
	isPlayable,
	opponentPool,
	opponentWeights,
	pfspWeight,
	recordPairwise,
	sampleOpponents,
	winrateVs
} from './pfsp';
import {
	buildMatchup,
	initLeague,
	laneModelOf,
	leaguePaths,
	loadLeague,
	mintRandomInitCkpt,
	promotionBar,
	readGauntletBaselines,
	runGeneration,
	saveStateAtomic,
	seedRoster,
	stampBaselineElos,
	stopInferServers,
	defaultConfig
} from './manager';
import { loadPolicyWeights } from '../net';
import type { HistoryLine, LeagueConfig, LeagueMember } from './types';

const SMOKE = process.env.SMOKE === '1';
const SMOKE_V2 = process.env.SMOKE_V2 === '1';
const LIVE_WEIGHTS = resolve(process.cwd(), 'src/lib/play/ml/policy-weights.json');
/** Random-init tests spawn the python util — skip cleanly where the venv is absent. */
const HAVE_VENV = existsSync(resolve(process.cwd(), 'ml/.venv/bin/python'));

function member(id: string, kind: LeagueMember['kind'], extra: Partial<LeagueMember> = {}): LeagueMember {
	return { id, kind, createdGen: 0, matchStats: {}, ...extra };
}

/** Deterministic uniform stream for sampling tests. */
function randFrom(seq: number[]): () => number {
	let i = 0;
	return () => seq[i++ % seq.length];
}

describe('pfsp math', () => {
	it('winrateVs: pairwise placement score with a 0.5 prior', () => {
		const m = member('L', 'main');
		expect(winrateVs(m, 'X')).toBe(0.5); // no games yet
		m.matchStats['X'] = { games: 10, better: 7, worse: 1 }; // 2 ties
		expect(winrateVs(m, 'X')).toBeCloseTo((7 + 0.5 * 2) / 10, 12);
	});

	it('pfspWeight: squared prioritizes losses, hard peaks at 50%', () => {
		const squared = { p: 2, variant: 'squared' as const };
		expect(pfspWeight(0, squared)).toBe(1); // always lose → max weight
		expect(pfspWeight(0.5, squared)).toBeCloseTo(0.25, 12);
		expect(pfspWeight(1, squared)).toBe(PFSP_WEIGHT_FLOOR); // beaten → floor, not 0
		const hard = { p: 2, variant: 'hard' as const };
		expect(pfspWeight(0.5, hard)).toBeCloseTo(0.25, 12);
		expect(pfspWeight(0.5, hard)).toBeGreaterThan(pfspWeight(0.9, hard));
		expect(pfspWeight(0.5, hard)).toBeGreaterThan(pfspWeight(0.1, hard));
	});

	it('lane rules: main = whole league; main_exploiter = mains only; league_exploiter = frozen pool', () => {
		const members = [
			member('main-0', 'main', { weightsPath: 'w.json' }),
			member('mx-0', 'main_exploiter', { weightsPath: 'x.json' }),
			member('lx-0', 'league_exploiter'), // fresh — not yet playable
			member('frozen-a', 'frozen', { weightsPath: 'a.json' }),
			member('heur-medium', 'heuristic', { profile: 'medium' })
		]; // (all checkpoint fixtures use .json — isPlayable is v1-JSON-only for opponents)
		const ids = (ms: LeagueMember[]): string[] => ms.map((m) => m.id).sort();
		expect(ids(opponentPool(members[0], members))).toEqual(['frozen-a', 'heur-medium', 'mx-0']);
		expect(ids(opponentPool(members[1], members))).toEqual(['main-0']);
		expect(ids(opponentPool(members[2], members))).toEqual(['frozen-a', 'heur-medium']);
		expect(isPlayable(members[2])).toBe(false); // never sampled as an opponent
	});

	it('league exploiters sample uniformly (weights all 1)', () => {
		const lx = member('lx-0', 'league_exploiter');
		const pool = [member('frozen-a', 'frozen', { weightsPath: 'a' }), member('heur-h', 'heuristic', { profile: 'hard' })];
		expect(opponentWeights(lx, pool, { p: 2, variant: 'squared' })).toEqual([1, 1]);
	});

	it('sampleOpponents: deterministic given the rand stream, weighted toward losses', () => {
		const learner = member('main-0', 'main', { weightsPath: 'w.json' });
		learner.matchStats['easy'] = { games: 10, better: 10, worse: 0 }; // ~beaten → floor weight
		learner.matchStats['nemesis'] = { games: 10, better: 0, worse: 10 }; // always lose → weight 1
		const members = [
			learner,
			member('easy', 'frozen', { weightsPath: 'e.json' }),
			member('nemesis', 'frozen', { weightsPath: 'n.json' })
		];
		const cfg = { p: 2, variant: 'squared' as const };
		const a = sampleOpponents(learner, members, 6, cfg, randFrom([0.1, 0.5, 0.9, 0.2, 0.7, 0.4]));
		const b = sampleOpponents(learner, members, 6, cfg, randFrom([0.1, 0.5, 0.9, 0.2, 0.7, 0.4]));
		expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id)); // deterministic
		// With weights ~{easy: 0.001, nemesis: 1}, every draw lands on the nemesis.
		expect(a.every((m) => m.id === 'nemesis')).toBe(true);
		expect(() => sampleOpponents(member('mx', 'main_exploiter'), [member('mx', 'main_exploiter')], 1, cfg, randFrom([0.5]))).toThrow(
			/empty opponent pool/
		);
	});

	it('recordPairwise: better/worse/tie accounting', () => {
		const m = member('L', 'main');
		recordPairwise(m, 'X', 1, 3); // better
		recordPairwise(m, 'X', 2, 2); // tie
		recordPairwise(m, 'X', 4, 1); // worse
		expect(m.matchStats['X']).toEqual({ games: 3, better: 1, worse: 1 });
		expect(winrateVs(m, 'X')).toBeCloseTo(0.5, 12);
	});
});

describe('promotion bar + baseline elos', () => {
	it('reads full-gauntlet baselines from committed ml/gauntlet_results (path-matched)', () => {
		// vitest runs from the repo root, where the committed result files live.
		const scanned = readGauntletBaselines();
		expect(scanned['src/lib/play/ml/policy-weights.json']).toBe(221);
		expect(
			scanned['ml/meta_runs/routeexecq-shared-allseat-candidate-20260701Ttrain/best_policy.json']
		).toBe(192);
	});

	it('initLeague stamps frozen anchors so the first promotion check has a real bar', () => {
		const root = mkdtempSync(join(tmpdir(), 'league-baseline-'));
		try {
			const { state } = initLeague(root);
			const frozen = state.members.filter((m) => m.kind === 'frozen');
			// gauntlet-v5 (obs v1.1, OBS_DIM 62→77): EVERY 62-dim checkpoint anchor went
			// dim-incompatible, so initLeague seeds no frozen checkpoint members at all.
			// The first promotion bar comes from extraFrozen/baselineElos (test below) —
			// exactly the -Infinity-bar gotcha documented in the Phase 2 league runs.
			expect(frozen).toHaveLength(0);
			// Heuristic anchors do NOT participate in the promotion bar and stay unstamped.
			expect(state.members.find((m) => m.id === 'heur-pvphunter')!.eloVsAnchors).toBeUndefined();
			expect(promotionBar(state.members)).toBe(-Infinity);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('byte-identity fallback: a byte-copy of a scored file inherits its Elo (synthetic)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'league-identity-'));
		try {
			const scoredPath = join(dir, 'scored.json');
			const copyPath = join(dir, 'copy-under-another-name.json');
			writeFileSync(scoredPath, JSON.stringify({ format: 'arc-cand-scorer-v1', w: [1, 2, 3] }));
			copyFileSync(scoredPath, copyPath);
			const resultsDir = join(dir, 'results');
			mkdirSync(resultsDir);
			writeFileSync(
				join(resultsDir, 'scored.json'),
				JSON.stringify({
					gauntletVersion: 'gauntlet-v1',
					smoke: false,
					candidate: { kind: 'weights', ref: scoredPath },
					timestamp: '2026-07-01T00:00:00Z',
					eloVsAnchors: { aggregate: { elo: 314 } }
				})
			);
			const members = [member('frozen-x', 'frozen', { weightsPath: copyPath })];
			stampBaselineElos(members, defaultConfig('unused'), resultsDir);
			expect(members[0].eloVsAnchors).toBe(314);
			// Smoke results never stamp.
			writeFileSync(
				join(resultsDir, 'scored.json'),
				JSON.stringify({
					gauntletVersion: 'gauntlet-v1',
					smoke: true,
					candidate: { kind: 'weights', ref: scoredPath },
					eloVsAnchors: { aggregate: { elo: 999 } }
				})
			);
			const fresh = [member('frozen-y', 'frozen', { weightsPath: copyPath })];
			stampBaselineElos(fresh, defaultConfig('unused'), resultsDir);
			expect(fresh[0].eloVsAnchors).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('config.baselineElos overrides the scan and can stamp by id or path', () => {
		const root = mkdtempSync(join(tmpdir(), 'league-baseline-map-'));
		try {
			const { state } = initLeague(root, {
				// v5 pool has no checkpoint anchors; frozen peers enter via extraFrozen and
				// are stamped through baselineElos exactly as before (by id or by path).
				extraFrozen: [
					{ id: 'frozen-traceq-damage-nearmiss', weightsPath: 'ml/meta_runs/traceq-damage-nearmiss-vp28-29-20260630T053132Z/best_policy.json' },
					{ id: 'frozen-routeexecq-shared-allseat', weightsPath: 'ml/meta_runs/routeexecq-shared-allseat-candidate-20260701Ttrain/best_policy.json' }
				],
				baselineElos: {
					'frozen-traceq-damage-nearmiss': 221, // by member id
					'ml/meta_runs/routeexecq-shared-allseat-candidate-20260701Ttrain/best_policy.json': 500 // by path, overrides scan
				}
			});
			expect(state.members.find((m) => m.id === 'frozen-traceq-damage-nearmiss')!.eloVsAnchors).toBe(221);
			expect(state.members.find((m) => m.id === 'frozen-routeexecq-shared-allseat')!.eloVsAnchors).toBe(500);
			expect(promotionBar(state.members)).toBe(500);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('promotionBar: max over scored frozen members only; -Infinity when none', () => {
		expect(promotionBar([])).toBe(-Infinity);
		const members = [
			member('heur-pvphunter', 'heuristic', { profile: 'pvphunter', eloVsAnchors: 999 }),
			member('main-0', 'main', { eloVsAnchors: 998 }),
			member('frozen-a', 'frozen', { weightsPath: 'a.json' }) // unscored
		];
		expect(promotionBar(members)).toBe(-Infinity); // heuristics/learners never count
		members.push(member('frozen-b', 'frozen', { weightsPath: 'b.json', eloVsAnchors: 192 }));
		members.push(member('frozen-c', 'frozen', { weightsPath: 'c.json', eloVsAnchors: 221 }));
		expect(promotionBar(members)).toBe(221);
	});

	it('extraFrozen: seeded as frozen, PFSP-eligible for main, raises the promotion bar', () => {
		const root = mkdtempSync(join(tmpdir(), 'league-extrafrozen-'));
		try {
			const { state } = initLeague(root, {
				extraFrozen: [
					{ id: 'frozen-champion-run1', weightsPath: 'ml/champions/league-run1-main0-gen8-elo268.json', elo: 268 },
					{ id: 'frozen-unscored', weightsPath: 'ml/champions/nonexistent-for-scan.json' } // no elo, fake path
				]
			});
			const champ = state.members.find((m) => m.id === 'frozen-champion-run1')!;
			expect(champ.kind).toBe('frozen');
			expect(champ.weightsPath).toBe('ml/champions/league-run1-main0-gen8-elo268.json');
			expect(champ.eloVsAnchors).toBe(268); // explicit elo stamps directly

			// PFSP-eligible: the main lane's opponent pool contains the champion…
			const main = state.members.find((m) => m.id === 'main-0')!;
			const pool = opponentPool(main, state.members);
			expect(pool.map((m) => m.id)).toContain('frozen-champion-run1');
			// …and a league exploiter's frozen pool does too.
			const lx = state.members.find((m) => m.id === 'league_exploiter-0')!;
			expect(opponentPool(lx, state.members).map((m) => m.id)).toContain('frozen-champion-run1');

			// Promotion bar rises to the champion's stamped elo (268 > routeexecq's 192).
			expect(promotionBar(state.members)).toBe(268);

			// No explicit elo + nothing matching in the scan ⇒ stays unscored (no bar
			// contribution) but remains a playable .json opponent.
			const unscored = state.members.find((m) => m.id === 'frozen-unscored')!;
			expect(unscored.eloVsAnchors).toBeUndefined();
			expect(isPlayable(unscored)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('league init + state round-trip', () => {
	it('seeds the documented roster and survives an atomic save/load round-trip', () => {
		const root = mkdtempSync(join(tmpdir(), 'league-init-'));
		try {
			const { config, state, created } = initLeague(root, {
				lanes: { main: 1, mainExploiter: 1, leagueExploiter: 1 }
			});
			expect(created).toBe(true);
			const kinds = state.members.reduce<Record<string, number>>((acc, m) => {
				acc[m.kind] = (acc[m.kind] ?? 0) + 1;
				return acc;
			}, {});
			// 8 gauntlet heuristic anchors + the active frozen checkpoint anchors + 3 lanes.
			// (0 frozen since gauntlet-v5: obs v1.1 made every 62-dim checkpoint anchor
			// dim-incompatible; frozen PFSP peers now come from extraFrozen.)
			expect(kinds['heuristic']).toBe(8);
			expect(kinds['frozen']).toBeUndefined();
			expect(kinds['main']).toBe(1);
			expect(kinds['main_exploiter']).toBe(1);
			expect(kinds['league_exploiter']).toBe(1);
			// Main warm-starts from the configured init checkpoint; exploiters are fresh.
			const main = state.members.find((m) => m.id === 'main-0')!;
			expect(main.initFrom).toBe(config.initFrom);
			expect(state.members.find((m) => m.id === 'main_exploiter-0')!.initFrom).toBeUndefined();

			// Round-trip: mutate, save, reload — identical; no .tmp litter (atomic rename).
			main.matchStats['heur-medium'] = { games: 2, better: 1, worse: 0 };
			state.gen = 3;
			saveStateAtomic(root, state);
			const reloaded = loadLeague(root);
			expect(reloaded.state).toEqual(state);
			expect(readdirSync(root).some((f) => f.endsWith('.tmp'))).toBe(false);

			// Re-init is idempotent: never reseeds an existing league.
			const again = initLeague(root);
			expect(again.created).toBe(false);
			expect(again.state.gen).toBe(3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('seedRoster honors lane counts', () => {
		const cfg = defaultConfig('unused');
		cfg.lanes = { main: 2, mainExploiter: 0, leagueExploiter: 1 };
		const roster = seedRoster(cfg);
		expect(roster.filter((m) => m.kind === 'main').map((m) => m.id)).toEqual(['main-0', 'main-1']);
		expect(roster.some((m) => m.kind === 'main_exploiter')).toBe(false);
	});
});

describe('league smoke generation (SMOKE=1)', () => {
	(SMOKE ? it : it.skip)(
		'runs one end-to-end micro-generation: pool → train.py → eval → ckpt + history line',
		async () => {
			expect(existsSync(LIVE_WEIGHTS)).toBe(true);
			const root = mkdtempSync(join(tmpdir(), 'league-smoke-'));
			try {
				initLeague(root, {
					gamesPerGen: 8,
					matchupGames: 4,
					evalGames: 4,
					seats: 4,
					maxRounds: 20,
					lanes: { main: 1, mainExploiter: 0, leagueExploiter: 0 },
					train: { epochs: 1, beta: 1.0 },
					initFrom: LIVE_WEIGHTS,
					promoteEvery: 0, // no gauntlet in the smoke
					sample: true,
					workers: 2
				});
				const report = await runGeneration(root);
				expect(report.gen).toBe(1);
				expect(report.lanes).toHaveLength(1);
				const line = report.lanes[0];
				expect(line.lane).toBe('main-0');
				expect(line.games).toBe(8);
				expect(line.samples).toBeGreaterThan(0);
				expect(line.evalGames).toBe(4);
				expect(line.promoted).toBeNull();
				expect(Object.keys(line.opponents).length).toBeGreaterThan(0);

				// The trained checkpoint exists and matches the 62/52 contract.
				expect(existsSync(line.ckpt)).toBe(true);
				const ckpt = JSON.parse(readFileSync(line.ckpt, 'utf8')) as { obs_dim: number; act_dim: number };
				expect(ckpt.obs_dim).toBe(OBS_DIM);
				expect(ckpt.act_dim).toBe(52);

				// State advanced + learner now plays its new ckpt; history has the line.
				const { state } = loadLeague(root);
				expect(state.gen).toBe(1);
				expect(state.phase).toBe('idle');
				expect(state.members.find((m) => m.id === 'main-0')!.weightsPath).toBe(line.ckpt);
				const p = leaguePaths(root);
				const hist = readFileSync(p.history, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as HistoryLine);
				expect(hist).toHaveLength(1);
				expect(hist[0].gen).toBe(1);

				// eslint-disable-next-line no-console
				console.log(
					`[league-smoke] games=${line.games} samples=${line.samples} ` +
						`pool=${(line.poolWallMs / 1000).toFixed(1)}s train=${(line.trainMs / 1000).toFixed(1)}s ` +
						`eval=${(line.evalMs / 1000).toFixed(1)}s evalWin=${(100 * line.evalWinRate).toFixed(0)}% ` +
						`eloEst=${line.eloEstimate}`
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		15 * 60 * 1000
	);
});

describe('v2 lanes (unit)', () => {
	it('laneModel stamps members at init; config wins over the member field', () => {
		const root = mkdtempSync(join(tmpdir(), 'league-v2-init-'));
		try {
			const { config, state } = initLeague(root, { laneModel: { 'main-0': 'v2' } });
			const main = state.members.find((m) => m.id === 'main-0')!;
			expect(main.model).toBe('v2');
			expect(laneModelOf(config, main)).toBe('v2');
			expect(laneModelOf(config, state.members.find((m) => m.id === 'main_exploiter-0')!)).toBe('v1');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('opponent playability: a v2 .pt is learner-side only; the distilled JSON qualifies', () => {
		const v2Learner = member('main-0', 'main', { model: 'v2', ptPath: 'ckpt/main-0-gen3.pt' });
		expect(isPlayable(v2Learner)).toBe(false); // .pt cannot sit in an in-process opponent seat
		v2Learner.distilledPath = 'ckpt/main-0-gen3-distilled.json';
		expect(isPlayable(v2Learner)).toBe(true);
		// A v2 lane's initFrom .pt must never leak into opponent seats either.
		expect(isPlayable(member('x', 'main_exploiter', { model: 'v2', initFrom: 'w/init.pt' }))).toBe(false);
		expect(isPlayable(member('y', 'main_exploiter', { initFrom: 'w/init.json' }))).toBe(true);
	});

	it('buildMatchup v2: socket play → inferSocket + policyObsVersion 2 + obsVersion 2', () => {
		const config = defaultConfig('unused');
		const learner = member('main-0', 'main', { model: 'v2', ptPath: 'ckpt/x.pt' });
		const opps = [
			member('heur-medium', 'heuristic', { profile: 'medium' }),
			member('heur-hard', 'heuristic', { profile: 'hard' }),
			member('frozen-a', 'frozen', { weightsPath: 'a.json' })
		];
		const plan = buildMatchup(config, learner, opps, 1, 7, { socket: '/tmp/s.sock' });
		expect(plan.config.inferSocket).toBe('/tmp/s.sock');
		expect(plan.config.policyObsVersion).toBe(2);
		expect(plan.config.obsVersion).toBe(2);
		expect(plan.config.weightsPath).toBeUndefined(); // learner never loads in-process
		expect(plan.config.neuralSeats).toEqual([plan.learnerSeat]);
		expect(plan.config.recordSeats).toEqual([plan.learnerSeat]);
		// Opponents still load in-process (frozen JSON) / by profile.
		expect(Object.values(plan.config.opponentWeights ?? {})).toHaveLength(1);

		// Bootstrap (no socket): heuristic learner, but rows still record at obsVersion 2.
		const fresh = member('main_exploiter-0', 'main_exploiter', { model: 'v2' });
		const boot = buildMatchup(config, fresh, opps, 0, 1, {});
		expect(boot.config.obsVersion).toBe(2);
		expect(boot.config.inferSocket).toBeUndefined();
		expect(boot.config.policyObsVersion).toBeUndefined();
		expect(boot.config.weightsPath).toBeUndefined();
		expect(boot.config.neuralSeats).toBeUndefined();

		// v1 lanes are untouched: no obsVersion/policyObsVersion/inferSocket keys.
		const v1 = buildMatchup(config, member('m', 'main', { weightsPath: 'w.json' }), opps, 0, 1);
		expect(v1.config.obsVersion).toBeUndefined();
		expect(v1.config.policyObsVersion).toBeUndefined();
		expect(v1.config.inferSocket).toBeUndefined();
		expect(v1.config.weightsPath).toBe(resolve('w.json'));
	});

	it('buildMatchup v2 clamps value-selection to hybrid (policyObsVersion 2 constraint)', () => {
		const config = { ...defaultConfig('unused'), selection: 'value' as const };
		const learner = member('main-0', 'main', { model: 'v2', ptPath: 'x.pt' });
		const opps = [
			member('heur-medium', 'heuristic', { profile: 'medium' }),
			member('heur-hard', 'heuristic', { profile: 'hard' }),
			member('heur-insane', 'heuristic', { profile: 'insane' })
		];
		expect(buildMatchup(config, learner, opps, 0, 1, { socket: '/tmp/s' }).config.selection).toBe('hybrid');
		expect(buildMatchup(config, learner, opps, 0, 1).config.selection).toBe('value'); // v1 path untouched
	});
});

describe('random-init lanes (from-scratch rediscovery)', () => {
	(HAVE_VENV ? it : it.skip)(
		'random_init_v1.py mints a deterministic ckpt that net.ts loadPolicyWeights accepts',
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'league-randinit-'));
			try {
				const cfg = defaultConfig('unused');
				const a = join(dir, 'a.json');
				const b = join(dir, 'b.json');
				mintRandomInitCkpt(cfg, a, 123);
				mintRandomInitCkpt(cfg, b, 123);
				expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8')); // seed-deterministic
				const policy = loadPolicyWeights(JSON.parse(readFileSync(a, 'utf8')), {
					expectedObsDim: OBS_DIM,
					expectedActDim: 52
				});
				expect(typeof policy.probs).toBe('function');
				// A different seed mints a different net.
				const c = join(dir, 'c.json');
				mintRandomInitCkpt(cfg, c, 124);
				expect(readFileSync(c, 'utf8')).not.toBe(readFileSync(a, 'utf8'));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		120_000
	);

	(HAVE_VENV ? it : it.skip)(
		'CLI init honors a PRE-PLACED config.json (the template workflow)',
		() => {
			// Regression: `cp configs/rediscovery.json <root>/config.json` + CLI init used
			// to seed state.json from pure defaults (13-member roster, main warm-started
			// from traceq, no minted random init) because initLeague never READ the file
			// it was refusing to overwrite. This goes through the real CLI.
			const root = mkdtempSync(join(tmpdir(), 'league-cli-init-'));
			try {
				copyFileSync(
					resolve(process.cwd(), 'ml/league/configs/rediscovery.json'),
					join(root, 'config.json')
				);
				execFileSync('node', ['scripts/run-league.mjs', 'init', '--root', root], {
					cwd: process.cwd(),
					encoding: 'utf8'
				});
				const { state } = loadLeague(root);
				const kinds = state.members.reduce<Record<string, number>>((acc, m) => {
					acc[m.kind] = (acc[m.kind] ?? 0) + 1;
					return acc;
				}, {});
				expect(kinds).toEqual({ heuristic: 8, main: 1 }); // no frozen anchors, no exploiters
				const main = state.members.find((m) => m.id === 'main-0')!;
				expect(main.initFrom).toBe(join(leaguePaths(root).checkpoints, 'main-0-random-init.json'));
				expect(existsSync(main.initFrom!)).toBe(true); // laneInit 'random' minted on the CLI path
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		180_000
	);

	(HAVE_VENV ? it : it.skip)(
		'rediscovery template: heuristic-only roster, minted random init, PPO-driven from gen 1',
		() => {
			const template = JSON.parse(
				readFileSync(resolve(process.cwd(), 'ml/league/configs/rediscovery.json'), 'utf8')
			) as Partial<LeagueConfig>;
			expect(template.laneInit).toEqual({ 'main-0': 'random' });
			expect(template.seedCheckpointAnchors).toBe(false);
			expect(template.mode).toBe('ppo');

			const rootA = mkdtempSync(join(tmpdir(), 'league-rediscover-a-'));
			const rootB = mkdtempSync(join(tmpdir(), 'league-rediscover-b-'));
			try {
				const { config, state } = initLeague(rootA, template);
				// No corruption-knowing checkpoints anywhere: heuristics + the learner only.
				expect(state.members.filter((m) => m.kind === 'frozen')).toHaveLength(0);
				expect(state.members.filter((m) => m.kind === 'heuristic')).toHaveLength(8);
				expect(state.members.map((m) => m.kind)).toContain('main');

				// The 'random' sentinel resolved to a minted, loadable checkpoint.
				const main = state.members.find((m) => m.id === 'main-0')!;
				expect(main.initFrom).toBe(join(leaguePaths(rootA).checkpoints, 'main-0-random-init.json'));
				expect(existsSync(main.initFrom!)).toBe(true);
				loadPolicyWeights(JSON.parse(readFileSync(main.initFrom!, 'utf8')), {
					expectedObsDim: OBS_DIM,
					expectedActDim: 52
				});

				// PPO from gen 1: the random-init lane is POLICY-driven in its first games
				// (weightsPath + neuralSeats set ⇒ driver records logpOld/vPred)…
				const heur = state.members.filter((m) => m.kind === 'heuristic').slice(0, 3);
				const plan = buildMatchup(config, main, heur, 0, 1);
				expect(plan.config.weightsPath).toBe(resolve(main.initFrom!));
				expect(plan.config.neuralSeats).toEqual([plan.learnerSeat]);
				// …unlike the no-init fallback, whose gen-1 games are heuristic-played
				// BC rows (the bootstrap pollution the random init exists to avoid).
				const fresh = member('main_exploiter-9', 'main_exploiter');
				const boot = buildMatchup(config, fresh, heur, 0, 1);
				expect(boot.config.weightsPath).toBeUndefined();
				expect(boot.config.neuralSeats).toBeUndefined();

				// Same config elsewhere reproduces the SAME zero-knowledge net.
				const b = initLeague(rootB, template);
				expect(readFileSync(b.state.members.find((m) => m.id === 'main-0')!.initFrom!, 'utf8')).toBe(
					readFileSync(main.initFrom!, 'utf8')
				);
			} finally {
				rmSync(rootA, { recursive: true, force: true });
				rmSync(rootB, { recursive: true, force: true });
			}
		},
		120_000
	);
});

describe('league v2 smoke generation (SMOKE_V2=1)', () => {
	(SMOKE_V2 ? it : it.skip)(
		'v2 micro-generation: bootstrap → train --model v2 → server spawn → socket eval → distill',
		async () => {
			const root = mkdtempSync(join(tmpdir(), 'league-v2smoke-'));
			try {
				initLeague(root, {
					mode: 'awr', // fresh v2 net: no logpOld until it plays, so awr for the smoke
					gamesPerGen: 4,
					matchupGames: 2,
					evalGames: 2,
					seats: 4,
					maxRounds: 15,
					lanes: { main: 1, mainExploiter: 0, leagueExploiter: 0 },
					laneModel: { 'main-0': 'v2' },
					v2: { dModel: 32, layers: 1, heads: 2, device: 'cpu', distillEpochs: 1, distillEveryGen: true },
					train: { epochs: 1 },
					initFrom: undefined, // fresh net — gen 1 bootstraps heuristically
					promoteEvery: 0,
					sample: true,
					workers: 2
				});
				const report = await runGeneration(root);
				const line = report.lanes[0];
				expect(line.model).toBe('v2');
				expect(line.games).toBe(4);
				expect(line.samples).toBeGreaterThan(0);
				expect(line.evalGames).toBe(2);

				// .pt + sibling manifest checkpoint; distilled v1 student on the 62/52 contract.
				expect(line.ckpt.endsWith('.pt')).toBe(true);
				expect(existsSync(line.ckpt)).toBe(true);
				expect(existsSync(line.ckpt.replace(/\.pt$/, '.manifest.json'))).toBe(true);
				expect(line.distilledCkpt).toBeDefined();
				const student = JSON.parse(readFileSync(line.distilledCkpt!, 'utf8')) as {
					obs_dim: number;
					act_dim: number;
				};
				expect(student.obs_dim).toBe(OBS_DIM);
				expect(student.act_dim).toBe(52);

				// Paired-row training data: meta kept the pool's obs_v2 block after the merge.
				const meta = JSON.parse(
					readFileSync(join(leaguePaths(root).laneData(1, 'main-0'), 'meta.json'), 'utf8')
				) as { obs_version?: number; obs_v2?: unknown; lane?: string };
				expect(meta.obs_version).toBe(2);
				expect(meta.obs_v2).toBeDefined();
				expect(meta.lane).toBe('main-0');

				// Server lifecycle: it started, served, and the log survives in the league root.
				const serverLog = join(leaguePaths(root).root, 'infer-main-0.log');
				expect(existsSync(serverLog)).toBe(true);
				expect(readFileSync(serverLog, 'utf8')).toContain('[infer] serving');

				// State: v2 learner advanced on ptPath (+ distilled), never weightsPath.
				const { state } = loadLeague(root);
				const main = state.members.find((m) => m.id === 'main-0')!;
				expect(main.ptPath).toBe(line.ckpt);
				expect(main.distilledPath).toBe(line.distilledCkpt);
				expect(main.weightsPath).toBeUndefined();
				expect(isPlayable(main)).toBe(true); // opponent-playable via the distilled student

				// eslint-disable-next-line no-console
				console.log(
					`[league-v2-smoke] games=${line.games} samples=${line.samples} ` +
						`pool=${(line.poolWallMs / 1000).toFixed(1)}s train=${(line.trainMs / 1000).toFixed(1)}s ` +
						`distill=${((line.distillMs ?? 0) / 1000).toFixed(1)}s eval=${(line.evalMs / 1000).toFixed(1)}s`
				);
			} finally {
				stopInferServers();
				rmSync(root, { recursive: true, force: true });
			}
		},
		20 * 60 * 1000
	);
});
