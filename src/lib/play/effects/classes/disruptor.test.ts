import { describe, it, expect } from 'vitest';
import { ability } from './disruptor';
import { fire, ctxFor, makePlayer } from './testHelpers';

// Disruptor — DB intent: "If the opponent has higher initiative, when you Take Damage,
// half it (rounding up)." Surfaces as a passive combat flag (player.halveIncoming),
// which combat.ts consumes to halve the post-mitigation hit, plus a log line.
describe('Disruptor', () => {
	it('flags halveIncoming when the opponent (pooled) has higher initiative', () => {
		const player = makePlayer({
			spirits: [{ slotIndex: 1, id: 's1', name: 'S1', cost: 2, classes: { 'Disruptor': 1 }, origins: {}, isFaceDown: false }],
			initiative: 2
		});
		const ctx = ctxFor(player, { trigger: 'onTakeDamage' });
		// Combat threads the opposing SIDE's pooled initiative for group PvP.
		ctx.combat = { dealt: 4, overkill: 0, killed: false, opponentInitiative: 5 };
		ability[0].run!(ctx);
		expect(player.halveIncoming).toBe(true);
	});

	it('surfaces to the player via a log line (no silent no-op)', () => {
		const player = makePlayer({
			spirits: [{ slotIndex: 1, id: 's1', name: 'S1', cost: 2, classes: { 'Disruptor': 1 }, origins: {}, isFaceDown: false }],
			initiative: 2
		});
		const ctx = ctxFor(player, { trigger: 'onTakeDamage' });
		ctx.combat = { dealt: 4, overkill: 0, killed: false, opponentInitiative: 5 };
		ability[0].run!(ctx);
		expect(ctx.log).toContain('Opponent has higher initiative — incoming damage is halved.');
	});

	it('reads a single opponent seat initiative when no pooled total is present', () => {
		const me = makePlayer({
			spirits: [{ slotIndex: 1, id: 's1', name: 'S1', cost: 2, classes: { 'Disruptor': 1 }, origins: {}, isFaceDown: false }],
			initiative: 1
		});
		const foe = makePlayer({ playerColor: 'Blue', initiative: 3 });
		const ctx = ctxFor(me, { trigger: 'onTakeDamage', extra: { Blue: foe } });
		ctx.opponent = 'Blue';
		ability[0].run!(ctx);
		expect(me.halveIncoming).toBe(true);
	});

	it('does NOT halve when the opponent has equal or lower initiative', () => {
		const me = makePlayer({
			spirits: [{ slotIndex: 1, id: 's1', name: 'S1', cost: 2, classes: { 'Disruptor': 1 }, origins: {}, isFaceDown: false }],
			initiative: 5
		});
		const ctx = ctxFor(me, { trigger: 'onTakeDamage' });
		ctx.combat = { dealt: 4, overkill: 0, killed: false, opponentInitiative: 5 };
		ability[0].run!(ctx);
		expect(me.halveIncoming).toBe(false);
		expect(ctx.log).toHaveLength(0);
	});

	it('does NOT halve when there is no opponent initiative to compare (e.g. monster fight)', () => {
		const me = makePlayer({
			spirits: [{ slotIndex: 1, id: 's1', name: 'S1', cost: 2, classes: { 'Disruptor': 1 }, origins: {}, isFaceDown: false }],
			initiative: 0
		});
		const ctx = ctxFor(me, { trigger: 'onTakeDamage' });
		ctx.combat = { dealt: 4, overkill: 0, killed: false };
		ability[0].run!(ctx);
		expect(me.halveIncoming).toBe(false);
	});

	it('is registered for the onTakeDamage trigger and dispatches without error', () => {
		// Through the real dispatcher: no opponent threaded, so no halve, but it must not throw.
		const { player } = fire({ 'Disruptor': 1 }, 'onTakeDamage');
		expect(player.halveIncoming).toBe(false);
		expect(ability[0].on).toBe('onTakeDamage');
	});
});
