import { describe, expect, it } from 'vitest';
import { fire, makePlayer, makeState, spirit, ctxFor } from './testHelpers';
import { decisions } from './firekeeper';
import { rollAttack, useSentinelDiscard } from '../../combat';
import { decisionPickerSpec, validateDecisionSelection } from '../../decisionPicker';
import type { AttackDie } from '../../types';

// Sentinel — "Before you roll in combat, you may discard attack dice. For each dice that you
// discard, deal 2 more damage." The owner chooses the dice on an Awakening Phase card; the
// next combat discards them just before the roll.
const dice = (...tiers: AttackDie['tier'][]): AttackDie[] =>
	tiers.map((tier, i) => ({ instanceId: `d${i}`, tier }));

describe('Sentinel — choose attack dice to discard before the next combat roll', () => {
	it('offers a free-size dice picker in the Awakening Phase (no even-value rule any more)', () => {
		const { player } = fire({ Sentinel: 1 }, 'awakeningPhase', {
			player: { attackDice: dice('basic', 'basic', 'arcane') }
		});
		const card = player.pendingDecisions.find((d) => d.kind === 'sentinelDiscard')!;
		expect(card.options.map((o) => o.id)).toEqual(['yes', 'no']);
		const spec = decisionPickerSpec(card, player)!;
		expect(spec).toMatchObject({ count: 3, minCount: 1 });
		expect(validateDecisionSelection(spec, ['d0'])).toBeNull();
		expect(validateDecisionSelection(spec, ['d0', 'd1', 'd2'])).toBeNull();
		expect(validateDecisionSelection(spec, [])).toBe('invalid_selection');
		expect(validateDecisionSelection(spec, ['x'])).toBe('invalid_selection');
		// No in-combat flag is armed: the old "+3 on an even combat value" is gone.
		const inCombat = fire({ Sentinel: 1 }, 'inCombat').player;
		expect(inCombat.discardDamageBonus ?? 0).toBe(0);
	});

	it('no card without attack dice, or while the Sentinel spirit is face-down', () => {
		expect(fire({ Sentinel: 1 }, 'awakeningPhase').player.pendingDecisions).toHaveLength(0);
		const faceDown = fire({ Sentinel: 1 }, 'awakeningPhase', {
			player: { attackDice: dice('basic'), spirits: [spirit(1, { Sentinel: 1 }, { faceDown: true })] }
		});
		expect(faceDown.player.pendingDecisions).toHaveLength(0);
	});

	it('the choice is stored; "Discard nothing" clears it; unknown ids are ignored', () => {
		const player = makePlayer({ spirits: [spirit(1, { Sentinel: 1 })], attackDice: dice('basic', 'enchanted') });
		decisions.sentinelDiscard(ctxFor(player), 'yes', ['d0', 'zz']);
		expect(player.sentinelDiscardIds).toEqual(['d0']);
		decisions.sentinelDiscard(ctxFor(player), 'no');
		expect(player.sentinelDiscardIds).toEqual([]);
		decisions.sentinelDiscard(ctxFor(player), 'yes'); // no pick (bots) → nothing
		expect(player.sentinelDiscardIds).toEqual([]);
	});

	it('before the roll: the chosen dice are discarded for good and deal 2 damage each', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Sentinel: 1 })],
			attackDice: dice('basic', 'basic', 'arcane'),
			sentinelDiscardIds: ['d0', 'd1']
		});
		const log: string[] = [];
		useSentinelDiscard(player, log);
		expect(player.attackDice.map((d) => d.instanceId)).toEqual(['d2']);
		expect(player.discardDamageBonus).toBe(4);
		expect(player.sentinelDiscardIds).toEqual([]);
		expect(log.some((l) => l.includes('discarded 2 attack dice'))).toBe(true);
		// The bonus is flat damage on top of the roll; it is not part of the combat value.
		const noDice = makePlayer({ discardDamageBonus: 4, combatDamageBonus: 1 });
		expect(rollAttack(makeState(noDice), noDice)).toBe(5);
		expect(noDice.combatValueThisFight).toBe(1);
	});

	it('does nothing while the Sentinel is face-down at combat time (and drops the choice)', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Sentinel: 1 }, { faceDown: true })],
			attackDice: dice('basic'),
			sentinelDiscardIds: ['d0']
		});
		useSentinelDiscard(player, []);
		expect(player.attackDice).toHaveLength(1);
		expect(player.discardDamageBonus ?? 0).toBe(0);
		expect(player.sentinelDiscardIds).toEqual([]);
	});
});
