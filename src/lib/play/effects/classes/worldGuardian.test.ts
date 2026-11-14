import { describe, expect, it } from 'vitest';
import { makePlayer, makeState, spirit } from './testHelpers';
import { takeDamage, resetCombatFlags } from '../../combat';
import { enterBenefits } from '../../phases';
import { applyTrigger } from '../apply';
import { buildEffectContext } from '../context';
import { DECISION_RESOLVERS } from '../decisions';
import type { AwakenGrant, RelicGuardMode } from '../../types';

/**
 * Relic Sentinel — "When you Take Damage, you may choose to take 0 damage if you discard a
 * relic." The onTakeDamage handler arms the guard; takeDamage spends ONE held relic to take
 * 0 damage when the hit would corrupt (empty the barrier). The old "+6 VP at 24 VP" claim is
 * not in the November 2026 text.
 */

function holder(barrier: number, relics: number, relicGuardMode?: RelicGuardMode) {
	const player = makePlayer({
		barrier,
		maxBarrier: 6,
		relics,
		relicGuardMode,
		spirits: [spirit(1, { 'Relic Sentinel': 1 })],
		mats: Array.from({ length: relics }, (_, i) => ({
			slotIndex: i + 1,
			hasRune: true,
			id: `relic-${i}`,
			name: `Relic ${i}`,
			type: 'relic'
		}))
	});
	resetCombatFlags(player);
	return { player, state: makeState(player) };
}

describe('Relic Sentinel — discard a relic to take 0 damage', () => {
	it('a hit that would corrupt costs one relic and deals 0 damage', () => {
		const { player, state } = holder(3, 2);
		const log: string[] = [];
		const result = takeDamage(player, 5, { state, seat: 'Red' }, log);
		expect(result.corrupted).toBe(false);
		expect(player.barrier).toBe(3);
		expect(player.mats.filter((m) => m.hasRune)).toHaveLength(1);
		expect(player.relics).toBe(1);
		expect(log.some((l) => l.includes('Relic Sentinel: discarded'))).toBe(true);
	});

	it('a hit that would not corrupt keeps the relic and deals its damage', () => {
		const { player, state } = holder(5, 1);
		takeDamage(player, 2, { state, seat: 'Red' }, []);
		expect(player.barrier).toBe(3);
		expect(player.mats[0].hasRune).toBe(true);
	});

	it('with no relic the hit lands (and corrupts)', () => {
		const { player, state } = holder(2, 0);
		const result = takeDamage(player, 4, { state, seat: 'Red' }, []);
		expect(result.corrupted).toBe(true);
	});

	it('grants no Benefits claim any more (the old +6 VP win-con is gone)', () => {
		const player = makePlayer({ victoryPoints: 25, spirits: [spirit(1, { 'Relic Sentinel': 1 })] });
		const state = makeState(player);
		state.phase = 'location';
		state.status = 'active';
		enterBenefits(state);
		const grants: AwakenGrant[] = player.pendingAwakenReward?.grants ?? [];
		expect(grants.some((g) => g.source === 'Relic Sentinel')).toBe(false);
	});

	it("rule 'everyHit': a hit that would not corrupt also costs a relic and deals 0", () => {
		const { player, state } = holder(5, 1, 'everyHit');
		const result = takeDamage(player, 2, { state, seat: 'Red' }, []);
		expect(result.barrierLost).toBe(0);
		expect(player.barrier).toBe(5);
		expect(player.mats[0].hasRune).toBe(false);
	});

	it("rule 'never': the relic is kept and the hit corrupts", () => {
		const { player, state } = holder(2, 1, 'never');
		const result = takeDamage(player, 4, { state, seat: 'Red' }, []);
		expect(result.corrupted).toBe(true);
		expect(player.mats[0].hasRune).toBe(true);
	});

	it('spends a relic without a tool text before a relic tool', () => {
		const { player, state } = holder(2, 2);
		player.mats[0].relicTool = true;
		takeDamage(player, 4, { state, seat: 'Red' }, []);
		expect(player.mats[0].hasRune).toBe(true);
		expect(player.mats[1].hasRune).toBe(false);
	});
});

describe('Relic Sentinel — the owner chooses the guard rule', () => {
	const offer = (relicGuardMode?: RelicGuardMode, relics = 1) => {
		const player = makePlayer({
			relicGuardMode,
			spirits: [spirit(1, { 'Relic Sentinel': 1 })],
			mats: Array.from({ length: relics }, (_, i) => ({
				slotIndex: i + 1,
				hasRune: true,
				id: `relic-${i}`,
				name: `Relic ${i}`,
				type: 'relic' as const
			}))
		});
		const state = makeState(player);
		applyTrigger(state, 'Red', 'awakeningPhase', []);
		return { player, state };
	};

	it('offers one card in the Awakening Phase, the current rule first', () => {
		const { player } = offer();
		const cards = player.pendingDecisions.filter((d) => d.kind === 'relicSentinelGuard');
		expect(cards).toHaveLength(1);
		expect(cards[0].options.map((o) => o.id)).toEqual(['lethal', 'everyHit', 'never']);
		const again = offer('never');
		expect(again.player.pendingDecisions[0].options[0].id).toBe('never');
	});

	it('offers no card without a held relic', () => {
		const { player } = offer(undefined, 0);
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('the chosen rule persists on the player', () => {
		const { player, state } = offer();
		const card = player.pendingDecisions[0];
		const ctx = buildEffectContext({ state, seat: 'Red', player, trigger: 'awakeningPhase', log: [], traitCount: 0 });
		DECISION_RESOLVERS[card.kind](ctx, 'everyHit');
		expect(player.relicGuardMode).toBe('everyHit');
	});
});

