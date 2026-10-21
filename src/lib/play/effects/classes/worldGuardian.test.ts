import { describe, expect, it } from 'vitest';
import { ability } from './worldGuardian';
import { makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { enterBenefits } from '../../phases';
import type { AwakenGrant } from '../../types';

/**
 * Relic Sentinel — DB-intended behavior:
 *   "If you have 24 or more VP, and you are Good, gain 6 VP."
 *
 * This is ENGINE-handled, not effect-system handled. The class `ability` array is
 * intentionally empty. The grant surfaces to the player as a CLEANUP CLAIM card:
 * `enterBenefits` (phases.ts) gates on `awakenedClassCounts['Relic Sentinel'] >= 1 &&
 * !evil && victoryPoints >= 24` and pushes a
 * `{ kind: 'vp', amount: 6, source: 'Relic Sentinel' }` line into
 * `player.pendingAwakenReward.grants`. `resolveAwakenReward` (runtime.ts) applies the
 * +6 VP when the player claims.
 *
 * Alignment: `isEvilAlignment` is `statusLevel >= 3`, so "Good" == `statusLevel < 3`.
 *
 * These tests assert the claim-building behavior through the real engine entry point
 * (`enterBenefits`) — the channel the player actually sees — and guard that nothing is
 * granted silently by the `awakeningPhase` effect trigger (no double-grant). The
 * resolve-side +6 VP gain is exercised by the engine suite (runtime.test.ts /
 * phases.test.ts), which can build a fully-active game state; see the skipped
 * placeholder below for the intended in-file assertion if the resolve path ever becomes
 * reachable from `testHelpers`.
 */

function grants(player: ReturnType<typeof makePlayer>): AwakenGrant[] {
	return player.pendingAwakenReward?.grants ?? [];
}

/** A state whose Red player holds one awakened Relic Sentinel at the given VP/alignment. */
function stateForGuardian(victoryPoints: number, statusLevel = 0) {
	const player = makePlayer({
		victoryPoints,
		statusLevel,
		spirits: [spirit(1, { 'Relic Sentinel': 1 })]
	});
	return { player, state: makeState(player) };
}

describe('Relic Sentinel — engine-handled Cleanup claim', () => {
	it('the class ability array is intentionally empty (engine-handled, not effect-handled)', () => {
		expect(ability).toEqual([]);
	});

	it('Good holder with ≥24 VP → a +6 VP claim line', () => {
		const { player, state } = stateForGuardian(24, 0);
		enterBenefits(state);
		expect(grants(player)).toEqual([{ kind: 'vp', amount: 6, source: 'Relic Sentinel' }]);
	});

	it('Good holder with well over 24 VP still grants the +6 VP claim line', () => {
		const { player, state } = stateForGuardian(40, 2); // statusLevel 2 is still Good
		enterBenefits(state);
		expect(grants(player)).toEqual([{ kind: 'vp', amount: 6, source: 'Relic Sentinel' }]);
	});

	it('Good holder with 23 VP (just under the threshold) → no claim', () => {
		const { player, state } = stateForGuardian(23, 0);
		enterBenefits(state);
		expect(player.pendingAwakenReward).toBeNull();
	});

	it('Evil holder with ≥24 VP → no claim (alignment gate)', () => {
		const { player, state } = stateForGuardian(30, 3); // statusLevel >= 3 is Evil
		enterBenefits(state);
		expect(player.pendingAwakenReward).toBeNull();
	});

	it('a face-down (un-awakened) Relic Sentinel grants no claim even with ≥24 VP', () => {
		const player = makePlayer({
			victoryPoints: 30,
			spirits: [spirit(1, { 'Relic Sentinel': 1 }, { faceDown: true })]
		});
		const state = makeState(player);
		enterBenefits(state);
		expect(player.pendingAwakenReward).toBeNull();
	});

	it('no Relic Sentinel held → no claim', () => {
		const player = makePlayer({ victoryPoints: 30, spirits: [] });
		const state = makeState(player);
		enterBenefits(state);
		expect(player.pendingAwakenReward).toBeNull();
	});

	// No-silent-no-op guard: the reward is a visible CLAIM, and it must NOT also be
	// auto-applied by the awakeningPhase effect trigger (that would double-grant the VP).
	it('the awakeningPhase effect trigger grants no VP (claim is the only channel)', () => {
		const player = makePlayer({
			victoryPoints: 30,
			spirits: [spirit(1, { 'Relic Sentinel': 1 })]
		});
		applyTrigger(makeState(player), 'Red', 'awakeningPhase', []);
		expect(player.victoryPoints).toBe(30);
	});

	// TODO: exercise resolveAwakenReward directly once a fully-active game state is
	// reachable from testHelpers: a Good claimant with ≥24 VP gains +6 VP and the
	// pendingAwakenReward is cleared. Covered today by runtime.test.ts / phases.test.ts.
	it.skip('resolveAwakenReward: +6 VP for a Good ≥24-VP claimant', () => {});
});
