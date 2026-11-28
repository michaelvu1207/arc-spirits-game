/**
 * Master (Michael, 2026-11-14): "On Cultivate, gain 2 Max Barrier or restore 2 Barrier".
 */
import { describe, expect, it } from 'vitest';
import { applyTrigger } from './effects/apply';
import { enterCleanup } from './phases';
import { ctxFor, makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { decisions, MASTER_CULTIVATE_KIND } from './effects/classes/master';
import { loadFrozenCatalog } from './agents/catalog';
import type { PlayCatalog } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();

const cultivate = (catalog: PlayCatalog, barrier: number, maxBarrier: number) => {
	const p = makePlayer({ barrier, maxBarrier, brokenBarrier: maxBarrier - barrier, spirits: [spirit(1, { Master: 1 })] });
	const state = makeState(p);
	const log: string[] = [];
	applyTrigger(state, 'Red', 'onCultivate', log, { catalog });
	return { p, state, log, card: (p.pendingDecisions ?? []).find((d) => d.kind === MASTER_CULTIVATE_KIND) };
};

describe('Master on Cultivate', () => {
	it('some Barrier broken and Max Barrier below the cap: a card with both options', () => {
		const { p, card } = cultivate(frozen, 3, 5);
		expect(card?.options.map((o) => o.id)).toEqual(['maxBarrier', 'restore']);
		expect([p.barrier, p.maxBarrier]).toEqual([3, 5]);
	});
	it('"restore" restores 2 Barrier and leaves Max Barrier', () => {
		const { p } = cultivate(frozen, 3, 5);
		decisions[MASTER_CULTIVATE_KIND]({ ...ctxFor(p), catalog: frozen }, 'restore');
		expect([p.barrier, p.maxBarrier]).toEqual([5, 5]);
	});
	it('"maxBarrier" gives 2 Max Barrier, which arrive intact', () => {
		const { p } = cultivate(frozen, 3, 5);
		decisions[MASTER_CULTIVATE_KIND]({ ...ctxFor(p), catalog: frozen }, 'maxBarrier');
		expect([p.barrier, p.maxBarrier]).toEqual([5, 7]);
	});
	it('Barrier full: Max Barrier at once, no card', () => {
		const { p, card } = cultivate(frozen, 5, 5);
		expect(card).toBeUndefined();
		expect([p.barrier, p.maxBarrier]).toEqual([7, 7]);
	});
	it('Max Barrier at the cap: restore at once, no card', () => {
		const { p, card } = cultivate(frozen, 6, 10);
		expect(card).toBeUndefined();
		expect([p.barrier, p.maxBarrier]).toEqual([8, 10]);
	});
	it('Max Barrier 9: the card is still a choice (1 Max Barrier or 2 Barrier)', () => {
		const { p, card } = cultivate(frozen, 5, 9);
		expect(card).toBeDefined();
		decisions[MASTER_CULTIVATE_KIND]({ ...ctxFor(p), catalog: frozen }, 'restore');
		expect([p.barrier, p.maxBarrier]).toEqual([7, 9]);
	});
	it('an unanswered card gives Max Barrier at Cleanup', () => {
		const { p, state } = cultivate(frozen, 3, 5);
		enterCleanup(state, frozen);
		expect((p.pendingDecisions ?? []).some((d) => d.kind === MASTER_CULTIVATE_KIND)).toBe(false);
		expect([p.barrier, p.maxBarrier]).toEqual([5, 7]);
	});
	it('a face-down Master gives nothing', () => {
		const p = makePlayer({ barrier: 3, maxBarrier: 5, spirits: [spirit(1, { Master: 1 }, { faceDown: true })] });
		applyTrigger(makeState(p), 'Red', 'onCultivate', [], { catalog: frozen });
		expect([p.barrier, p.maxBarrier, (p.pendingDecisions ?? []).length]).toEqual([3, 5, 0]);
	});
});
