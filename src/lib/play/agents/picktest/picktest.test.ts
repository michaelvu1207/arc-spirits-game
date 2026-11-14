/**
 * Pick test (offline): a mock game is recorded, its summon decisions are extracted, re-derived by
 * replay and rebuilt as questions on the same and on changed data.
 *
 *   npx vitest run src/lib/play/agents/picktest
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { hashGameState } from '../../stateHash';
import type { PlayCatalog } from '../../types';
import { BudgetGuard } from '../budget';
import { loadFrozenCatalog } from '../catalog';
import { LlmSeatController } from '../llmSeat';
import { MockProvider } from '../providers/mock';
import { buildRulesBrief } from '../rulesBrief';
import { runAgentGame } from '../runner';
import { MemorySink, type TranscriptRecord } from '../transcript';
import { extractSummonPoints, snapshotsAt, type SummonPoint } from './extract';
import { prepareTest, recordedEvents, recordedPhaseIndex } from './request';
import { stratifiedSample, wilson } from './stats';
import { classify, desireStats, fitOf, parseDesire, type Offer } from './desire';

const catalog: PlayCatalog = loadFrozenCatalog();

let records: TranscriptRecord[] = [];
let points: SummonPoint[] = [];

beforeAll(async () => {
	const budget = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
	const sink = new MemorySink();
	const seat = (seed: number) =>
		new LlmSeatController({
			provider: new MockProvider({ policy: 'random', seed }),
			model: 'random',
			budget,
			label: 'mock:random'
		});
	await runAgentGame({
		catalog,
		catalogInfo: { source: 'frozen', path: 'ml/catalog.json', hash: 'test' },
		seed: 5,
		controllers: [seat(1), seat(2)],
		rulesBrief: buildRulesBrief(catalog),
		budget,
		runId: 'picktest',
		sink
	});
	records = sink.records;
	points = extractSummonPoints(records, catalog, { source: 'test', file: '/x/game.jsonl' }).points;
}, 60_000);

const prepare = (point: SummonPoint, changed: PlayCatalog) => {
	const snap = snapshotsAt(records, catalog, new Set([point.line])).get(point.line)!;
	return prepareTest({
		point,
		state: snap.state,
		record: snap.record,
		original: catalog,
		changed,
		testId: 't'
	});
};

describe('pick test', () => {
	it('extracts summon decisions with offered spirits and the recorded choice', () => {
		expect(points.length).toBeGreaterThan(0);
		for (const p of points) {
			expect(p.offered.length).toBeGreaterThan(0);
			expect(p.offered.every((id) => p.hand.some((h) => h.spiritId === id))).toBe(true);
			if (p.pick === 'spirit') expect(p.offered).toContain(p.pickedSpiritId);
		}
	});

	it('re-derives the exact state by replay', () => {
		const p = points[0];
		const snap = snapshotsAt(records, catalog, new Set([p.line])).get(p.line)!;
		expect(hashGameState(snap.state)).toBe(p.stateHash);
		expect(snap.record.n).toBe(p.n);
	});

	it('rebuilds the recorded question word for word on the same data', () => {
		const t = prepare(points[0], catalog);
		expect(t.status).toBe('ok');
		if (t.status !== 'ok') return;
		expect(t.sameAsRecorded).toBe(true);
		expect([...t.offered].sort()).toEqual([...points[0].offered].sort());
	});

	it('shows changed spirit text and skips a removed or re-bagged spirit', () => {
		const p = points[0];
		const id = p.offered[0];
		const renamed = structuredClone(catalog);
		renamed.spirits.find((s) => s.id === id)!.name = 'Testname Spirit';
		const t = prepare(p, renamed);
		expect(t.status).toBe('ok');
		if (t.status === 'ok')
			expect(t.request.actions.some((a) => a.label.includes('Testname Spirit'))).toBe(true);

		const removed = structuredClone(catalog);
		removed.spirits = removed.spirits.filter((s) => s.id !== id);
		expect(prepare(p, removed)).toMatchObject({ status: 'skip', flags: ['spirit-removed'] });

		const rebagged = structuredClone(catalog);
		const s = rebagged.spirits.find((x) => x.id === id)!;
		s.cost = s.cost <= 5 ? 8 : 2;
		expect(prepare(p, rebagged)).toMatchObject({ status: 'skip', flags: ['bag-changed'] });
	});

	it('reads events and the phase index from a recorded message', () => {
		const msg =
			'Round 1, location phase. You are Red. This is your decision #3 in this phase.\n\nRECENT EVENTS (since your last decision):\n  one\n  two\n\nDECISION: x';
		expect(recordedEvents(msg)).toEqual(['one', 'two']);
		expect(recordedPhaseIndex(msg)).toBe(2);
		expect(recordedEvents('RECENT EVENTS (since your last decision):\n  (nothing new)\n')).toEqual([]);
	});

	it('samples every spirit and computes intervals', () => {
		const pts = [
			{ k: 1, o: ['a', 'b'] },
			{ k: 2, o: ['a'] },
			{ k: 3, o: ['c'] },
			{ k: 4, o: ['a', 'c'] }
		];
		const s = stratifiedSample(pts, (p) => p.o, { perSpirit: 1, max: 10, seed: 1 });
		for (const id of ['a', 'b', 'c']) expect(s.some((p) => p.o.includes(id))).toBe(true);
		const [lo, hi] = wilson(5, 10);
		expect(lo).toBeLessThan(0.5);
		expect(hi).toBeGreaterThan(0.5);
		expect(wilson(0, 0)).toEqual([0, 0]);
	});

	it('reads desire scores and refuses incomplete ones', () => {
		const ok = parseDesire('{"action": "a2", "reason": "x", "desire": {"a1": [3, "meh"], "a2": {"score": 9, "why": "great"}}}', ['a1', 'a2']);
		expect(ok.scores).toEqual({ a1: { score: 3, why: 'meh' }, a2: { score: 9, why: 'great' } });
		expect(parseDesire('{"action": "a1", "desire": {"a1": [3, ""]}}', ['a1', 'a2']).scores).toBeNull();
		expect(parseDesire('{"action": "a1", "desire": {"a1": [11, ""]}}', ['a1']).error).toMatch(/0-10/);
		expect(parseDesire('{"action": "a1"}', ['a1']).error).toMatch(/desire/);
	});

	it('marks fit by shared class or origin on the board', () => {
		const p = points[0];
		const snap = snapshotsAt(records, catalog, new Set([p.line])).get(p.line)!;
		const board = snap.state.players[p.seat]!.spirits;
		const id = p.offered[0];
		const spirit = catalog.spirits.find((s) => s.id === id)!;
		const cls = Object.keys(spirit.classes)[0];
		const state = structuredClone(snap.state);
		state.players[p.seat]!.spirits = [];
		if (!cls) return;
		expect(fitOf(state, p.seat, id, catalog).why.some((w) => w.startsWith('class:'))).toBe(false);
		state.players[p.seat]!.spirits = [{ ...(board[0] ?? { slotIndex: 1, id: 'x', name: 'x', cost: 1, origins: {}, isFaceDown: false }), classes: { [cls]: 1 } }];
		expect(fitOf(state, p.seat, id, catalog)).toMatchObject({ fits: true });
	});

	it('classifies spirits by pick rate and desire', () => {
		const offers = (n: number, picked: number, score: number, fits: boolean): Offer[] =>
			Array.from({ length: n }, (_, i) => ({ spiritId: 's', group: 'Arcane', picked: i < picked, score, why: '', fits }));
		expect(classify(desireStats(offers(10, 5, 7, true)), 0.25)).toBe('Generalist');
		expect(classify(desireStats([...offers(4, 2, 9, true), ...offers(10, 0, 2, false)]), 0.25)).toBe('Build-around');
		expect(classify(desireStats(offers(10, 0, 2, true)), 0.25)).toBe('Dead');
		expect(classify(desireStats(offers(10, 1, 5, true)), 0.25)).toBe('Situational');
		expect(classify(desireStats(offers(10, 0, 2, false)), 0.25)).toBe('Unclear');
		expect(parseDesire('{"action": "a1", "reason": "x"}\n{"desire": {"a1": [4, "ok"]}}', ['a1']).scores).toEqual({ a1: { score: 4, why: 'ok' } });
	});
});
