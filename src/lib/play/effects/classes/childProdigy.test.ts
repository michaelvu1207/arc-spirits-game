import { describe, it, expect } from 'vitest';
import { ability } from './childProdigy';
import { fire } from './testHelpers';

/**
 * Wayfarer — DB intent: "You may do ALL location interactions up to two times."
 *
 * Encoded exactly like Ironmane's combat-allowance: an `onNavigate` breakpoint grants
 * `extraAction locationInteraction +1`. The runtime reads
 * `rowAllowance = 1 + extraActions.locationInteraction`, so every reward row may resolve
 * twice per round (base 1 + the +1 grant). `phases.ts` clears `extraActions` each round
 * and re-fires `onNavigate`, so the allowance is re-granted on every navigation reveal.
 *
 * UX channel: an engine action — bumps `player.extraActions.locationInteraction` AND emits
 * a "Gained 1 extra locationInteraction action(s)." log line (no silent no-op). The raised
 * allowance then surfaces in play as eligibility: each location row stays selectable a 2nd time.
 */
describe('Wayfarer (onNavigate → +1 locationInteraction allowance, all rows twice)', () => {
	it('raises the per-row location-interaction allowance by exactly 1 on navigate', () => {
		const { player } = fire({ 'Wayfarer': 1 }, 'onNavigate');
		// base 1 + this grant = 2 ⇒ "do ALL location interactions up to two times".
		expect(player.extraActions.locationInteraction).toBe(1);
	});

	it('surfaces to the player via a log line (no silent no-op)', () => {
		const { log } = fire({ 'Wayfarer': 1 }, 'onNavigate');
		expect(log.some((l) => /extra locationInteraction action/i.test(l))).toBe(true);
	});

	it('grants +1 (not stacking arbitrarily) — a single onNavigate yields allowance of 2 total', () => {
		const { player } = fire({ 'Wayfarer': 1 }, 'onNavigate');
		const rowAllowance = 1 + (player.extraActions.locationInteraction ?? 0);
		expect(rowAllowance).toBe(2);
	});

	it('does not grant the allowance on an unrelated trigger', () => {
		const { player } = fire({ 'Wayfarer': 1 }, 'onTakeDamage');
		expect(player.extraActions.locationInteraction ?? 0).toBe(0);
	});

	it('exposes a single declarative onNavigate breakpoint ability granting locationInteraction', () => {
		expect(ability).toHaveLength(1);
		expect(ability[0].on).toBe('onNavigate');
		expect(ability[0].breakpoints).toBeDefined();
		const bp = ability[0].breakpoints![0];
		expect(bp.count).toBe(1);
		expect(bp.actions).toEqual([
			{ kind: 'extraAction', actionKey: 'locationInteraction', amount: 1 }
		]);
	});
});
