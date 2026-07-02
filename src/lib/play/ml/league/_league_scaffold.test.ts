/**
 * League-manager scaffold tests.
 *
 *   - PFSP math + lane rules (always runs; pure).
 *   - Roster seeding + atomic state round-trip (always runs; tmpdir).
 *   - SMOKE=1: one end-to-end micro-generation on this machine — PFSP → actor
 *     pool → ml/train.py (awr, 1 epoch) → quick eval → history line + new ckpt.
 *
 *   SMOKE=1 npx vitest run src/lib/play/ml/league/_league_scaffold.test.ts --disable-console-intercept
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
	initLeague,
	leaguePaths,
	loadLeague,
	runGeneration,
	saveStateAtomic,
	seedRoster,
	defaultConfig
} from './manager';
import type { HistoryLine, LeagueMember } from './types';

const SMOKE = process.env.SMOKE === '1';
const LIVE_WEIGHTS = resolve(process.cwd(), 'src/lib/play/ml/policy-weights.json');

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
		];
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
		const learner = member('main-0', 'main', { weightsPath: 'w' });
		learner.matchStats['easy'] = { games: 10, better: 10, worse: 0 }; // ~beaten → floor weight
		learner.matchStats['nemesis'] = { games: 10, better: 0, worse: 10 }; // always lose → weight 1
		const members = [
			learner,
			member('easy', 'frozen', { weightsPath: 'e' }),
			member('nemesis', 'frozen', { weightsPath: 'n' })
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
			expect(kinds['heuristic']).toBe(8);
			expect(kinds['frozen']).toBe(2);
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
				expect(ckpt.obs_dim).toBe(62);
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
