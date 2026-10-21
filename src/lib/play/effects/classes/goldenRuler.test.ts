import { describe, expect, it } from 'vitest';
import { ability } from './goldenRuler';
import { makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { enterBenefits } from '../../phases';
import type { AwakenGrant } from '../../types';

/**
 * Dawn Sovereign — DB-intended behavior:
 *   "In the Awakening Phase, gain 1 VP. If you are evil, you must discard this spirit."
 *
 * This is ENGINE-handled, not effect-system handled. The class `ability` array is
 * intentionally empty. The grant surfaces to the player as a CLEANUP CLAIM card:
 * `enterBenefits` (phases.ts) pushes a `{ kind: 'vp', amount: 1, source: 'Golden Ruler' }`
 * line into `player.pendingAwakenReward.grants` whenever the player holds ≥1 awakened
 * Dawn Sovereign — and, when the player is Evil, it tags the line with a note warning that
 * claiming also discards a Dawn Sovereign spirit. `resolveAwakenReward` (runtime.ts) then
 * applies the +1 VP and, for Evil claimants, discards one awakened Dawn Sovereign spirit.
 *
 * These tests assert the claim-building behavior through the real engine entry point
 * (`enterBenefits`) — the channel the player actually sees — and guard that nothing is
 * granted silently by the `awakeningPhase` effect trigger (no double-grant). The
 * resolve-side VP gain + Evil self-discard is exercised by the engine suite
 * (runtime.test.ts / phases.test.ts), which can build a fully-active game state; see the
 * skipped placeholder below for the intended in-file assertion if the resolve path ever
 * becomes reachable from `testHelpers`.
 */

function grants(player: ReturnType<typeof makePlayer>): AwakenGrant[] {
	return player.pendingAwakenReward?.grants ?? [];
}

/** A state whose Red player holds one awakened Dawn Sovereign at the given statusLevel. */
function stateForRuler(statusLevel = 0) {
	const player = makePlayer({
		statusLevel,
		spirits: [spirit(1, { 'Golden Ruler': 1 })]
	});
	return { player, state: makeState(player) };
}

describe('Dawn Sovereign — engine-handled Cleanup claim', () => {
	it('the class ability array is intentionally empty (engine-handled, not effect-handled)', () => {
		expect(ability).toEqual([]);
	});

	it('holding an awakened Dawn Sovereign → a +1 VP claim line (Good: no note)', () => {
		const { player, state } = stateForRuler(0);
		enterBenefits(state);
		expect(grants(player)).toEqual([{ kind: 'vp', amount: 1, source: 'Golden Ruler' }]);
	});

	it('Evil holder → the +1 VP claim line carries the self-discard warning note', () => {
		const { player, state } = stateForRuler(3); // statusLevel >= 3 is Evil
		enterBenefits(state);
		const lines = grants(player);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ kind: 'vp', amount: 1, source: 'Golden Ruler' });
		expect((lines[0] as { note?: string }).note).toMatch(/evil/i);
		expect((lines[0] as { note?: string }).note).toMatch(/discard/i);
	});

	it('a face-down (un-awakened) Dawn Sovereign grants no claim', () => {
		const player = makePlayer({
			spirits: [spirit(1, { 'Golden Ruler': 1 }, { faceDown: true })]
		});
		const state = makeState(player);
		enterBenefits(state);
		expect(player.pendingAwakenReward).toBeNull();
	});

	it('no Dawn Sovereign held → no claim', () => {
		const player = makePlayer({ spirits: [] });
		const state = makeState(player);
		enterBenefits(state);
		expect(player.pendingAwakenReward).toBeNull();
	});

	// No-silent-no-op guard: the reward is a visible CLAIM, and it must NOT also be
	// auto-applied by the awakeningPhase effect trigger (that would double-grant the VP).
	it('the awakeningPhase effect trigger grants no VP (claim is the only channel)', () => {
		const player = makePlayer({
			victoryPoints: 5,
			spirits: [spirit(1, { 'Golden Ruler': 1 })]
		});
		applyTrigger(makeState(player), 'Red', 'awakeningPhase', []);
		expect(player.victoryPoints).toBe(5);
		// And the awakened spirit is not silently discarded by the effect trigger.
		expect(player.spirits).toHaveLength(1);
	});

	// TODO: exercise resolveAwakenReward directly once a fully-active game state is
	// reachable from testHelpers: a Good claimant gains +1 VP and keeps the spirit; an
	// Evil claimant gains +1 VP AND loses one awakened Dawn Sovereign spirit, and the
	// pendingAwakenReward is cleared. Covered today by runtime.test.ts / phases.test.ts.
	it.skip('resolveAwakenReward: +1 VP for Good; +1 VP and self-discard for Evil', () => {});
});
