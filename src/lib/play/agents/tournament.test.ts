import { describe, expect, it } from 'vitest';
import {
	addToHistory,
	batchSchedule,
	computeStandings,
	emptyHistory,
	fitPlackettLuce,
	parseEntrant,
	placements,
	scheduleStats,
	stopDecision,
	tieGroups,
	type GameResult,
	type StandingRow
} from './tournament';

const MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna'];
const EFFORTS = ['low', 'medium', 'high'];
const FIELD = MODELS.flatMap((m) => EFFORTS.map((e) => `gw:${m}@${e}`));

describe('tournament schedule', () => {
	it('parses entrants into model and effort', () => {
		expect(parseEntrant('gw:gpt-6-luna@low')).toEqual({
			id: 'gw:gpt-6-luna@low',
			model: 'gpt-6-luna',
			effort: 'low'
		});
		expect(parseEntrant('gw:openai-codex/gpt-6.1-sol@high').model).toBe('gpt-6.1-sol');
	});

	it('12 entrants: 18 four-seat games, 6 each, no uniform table, positions even, all opponents met', () => {
		const games = batchSchedule(FIELD, { batch: 1, baseSeed: 500 });
		expect(games).toHaveLength(18);
		const stats = scheduleStats(FIELD, games);
		expect(stats.gamesPer.every((n) => n === 6)).toBe(true);
		expect(stats.duplicateSeats).toBe(0);
		expect(stats.uniformTables).toBe(0);
		expect(Math.min(...stats.opponents)).toBe(11);
		expect(stats.maxPairMeetings).toBeLessThanOrEqual(3);
		for (const p of stats.positions) expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1);
		// The first round (3 games) seats every entrant once.
		expect(new Set(games.slice(0, 3).flatMap((g) => g.seats)).size).toBe(12);
		// Deterministic: same seed and batch, same schedule; seeds fixed by batch and index.
		expect(batchSchedule(FIELD, { batch: 1, baseSeed: 500 })).toEqual(games);
		expect(games.map((g) => g.seed)).toEqual(games.map((_, i) => 500 + 1000 + i));
	});

	it('a later batch evens out positions and meetings over both batches', () => {
		const b1 = batchSchedule(FIELD, { batch: 1, baseSeed: 9 });
		const b2 = batchSchedule(FIELD, {
			batch: 2,
			baseSeed: 9,
			history: addToHistory(emptyHistory(), b1)
		});
		expect(b2).not.toEqual(b1);
		const both = scheduleStats(FIELD, [...b1, ...b2]);
		for (const p of both.positions) expect(p.every((n) => n === 3)).toBe(true);
		expect(both.uniformTables).toBe(0);
		expect(both.maxPairMeetings).toBeLessThanOrEqual(5);
	});
});

describe('placements and ratings', () => {
	it('winner first, then VP; equal VP share the average place', () => {
		expect(
			placements([
				{ finalVp: 28, winner: false },
				{ finalVp: 30, winner: true },
				{ finalVp: 12, winner: false },
				{ finalVp: 12, winner: false }
			])
		).toEqual([2, 1, 3.5, 3.5]);
		// Round cap: the winner can have equal VP; the flag still puts it first.
		expect(
			placements([
				{ finalVp: 20, winner: false },
				{ finalVp: 20, winner: true }
			])
		).toEqual([2, 1]);
	});

	it('Plackett-Luce orders a strict hierarchy and stays finite for an unbeaten player', () => {
		const games = Array.from({ length: 20 }, (_, i) => ({
			players: i % 2 ? ['A', 'B', 'C', 'D'] : ['D', 'C', 'B', 'A'],
			places: i % 2 ? [1, 2, 3, 4] : [4, 3, 2, 1]
		}));
		const fit = fitPlackettLuce(games, ['A', 'B', 'C', 'D']);
		expect(fit.A).toBeGreaterThan(fit.B);
		expect(fit.B).toBeGreaterThan(fit.C);
		expect(fit.C).toBeGreaterThan(fit.D);
		expect(Number.isFinite(fit.A)).toBe(true);
		expect(Math.abs(fit.A + fit.B + fit.C + fit.D)).toBeLessThan(1e-9);
	});

	it('standings: entrant, model and effort rows with intervals; the stop rule', () => {
		const strength = (e: string) =>
			(e.includes('sol') ? 3 : 0) + (e.endsWith('high') ? 2 : e.endsWith('medium') ? 1 : 0);
		const results: GameResult[] = [];
		let history = emptyHistory();
		for (let b = 1; b <= 3; b++) {
			const games = batchSchedule(FIELD, { batch: b, baseSeed: 3, history, steps: 5000 });
			history = addToHistory(history, games);
			for (const g of games) {
				const vps = g.seats.map((e, i) => strength(e) * 5 + i);
				const top = Math.max(...vps);
				const seats = g.seats.map((entrant, i) => ({ finalVp: vps[i], winner: vps[i] === top }));
				const places = placements(seats);
				results.push({
					batch: b,
					index: g.index,
					seed: g.seed,
					rounds: 30,
					stopReason: 'finished',
					durationMs: 1,
					seats: g.seats.map((entrant, i) => ({
						entrant,
						seat: String(i),
						finalVp: vps[i],
						winner: seats[i].winner,
						place: places[i],
						kills: 1,
						corruptions: 0,
						pvp: 0,
						agentDecisions: 10,
						invalidAnswers: 0,
						providerCalls: 10,
						latencyMsTotal: 50_000,
						promptTokens: 100,
						cachedPromptTokens: 80,
						completionTokens: 10,
						reasoningTokens: 5
					}))
				});
			}
		}
		const s = computeStandings(results, FIELD, { samples: 200 });
		expect(s.entrants[0].key).toBe('gw:gpt-6.1-sol@high');
		expect(s.models[0].key).toBe('gpt-6.1-sol');
		expect(s.efforts.map((r) => r.key)).toEqual(['high', 'medium', 'low']);
		for (const r of s.entrants) {
			expect(r.rating.lo).toBeLessThanOrEqual(r.rating.value);
			expect(r.rating.hi).toBeGreaterThanOrEqual(r.rating.value);
			expect(r.games).toBe(18);
		}
		expect(s.entrants[0].secondsPerCall).toBe(5);
		const order = s.entrants.map((r) => r.key);
		expect(stopDecision(3, s.entrants, order).sameOrderAsLastBatch).toBe(true);
		expect(stopDecision(2, s.entrants, null).stop).toBe(false);
	});

	it('tie groups join neighbours whose intervals overlap; batch 6 stops with ties', () => {
		const row = (key: string, value: number, lo: number, hi: number) =>
			({ key, rating: { value, lo, hi } }) as StandingRow;
		const rows = [
			row('a', 1700, 1650, 1750),
			row('b', 1600, 1560, 1660),
			row('c', 1400, 1350, 1450)
		];
		expect(tieGroups(rows)).toEqual([['a', 'b'], ['c']]);
		expect(stopDecision(4, rows, ['a', 'b', 'c']).stop).toBe(false);
		const six = stopDecision(6, rows, ['b', 'a', 'c']);
		expect(six.stop).toBe(true);
		expect(six.reason).toMatch(/ties/);
		const clear = [
			row('a', 1700, 1650, 1750),
			row('b', 1500, 1450, 1600),
			row('c', 1300, 1250, 1400)
		];
		expect(stopDecision(2, clear, ['a', 'b', 'c']).stop).toBe(true);
	});
});
