import { describe, it, expect } from 'vitest';
import { ability } from './ironmane';
import { fire } from './testHelpers';

/**
 * Ironmane — DB intent: "You may initiate Monster Combat two times."
 *
 * Encoded as an `onNavigate` breakpoint granting `extraAction combat +1`. The runtime
 * reads `combatAllowance = 1 + extraActions.combat` (runtime.ts), so the Arcane-Abyss
 * monster-combat action may be taken twice per round (base 1 + the +1 grant). `phases.ts`
 * clears `extraActions` each round and re-fires `onNavigate`, so the allowance is
 * re-granted on every navigation reveal — it never accumulates beyond +1.
 *
 * UX channel: an engine action — bumps `player.extraActions.combat` AND emits a
 * "Gained 1 extra combat action(s)." log line (no silent no-op). The raised allowance
 * then surfaces in play as eligibility: the monster-combat action stays available a 2nd
 * time (runtime.ts rejects only once `combatsUsed >= combatAllowance`).
 */
describe('Ironmane (onNavigate → +1 combat allowance, initiate Monster Combat twice)', () => {
	it('raises the monster-combat allowance by exactly 1 on navigate', () => {
		const { player } = fire({ 'Monster Hunter': 1 }, 'onNavigate');
		// base 1 + this grant = 2 ⇒ "initiate Monster Combat two times".
		expect(player.extraActions.combat).toBe(1);
	});

	it('yields a total monster-combat allowance of 2 (base 1 + grant)', () => {
		const { player } = fire({ 'Monster Hunter': 1 }, 'onNavigate');
		const combatAllowance = 1 + (player.extraActions.combat ?? 0);
		expect(combatAllowance).toBe(2);
	});

	it('surfaces to the player via a log line (no silent no-op)', () => {
		const { log } = fire({ 'Monster Hunter': 1 }, 'onNavigate');
		expect(log.some((l) => /extra combat action/i.test(l))).toBe(true);
	});

	it('does not grant the allowance on an unrelated trigger', () => {
		const { player } = fire({ 'Monster Hunter': 1 }, 'onTakeDamage');
		expect(player.extraActions.combat ?? 0).toBe(0);
	});

	it('exposes a single declarative onNavigate breakpoint ability granting combat', () => {
		expect(ability).toHaveLength(1);
		expect(ability[0].on).toBe('onNavigate');
		expect(ability[0].breakpoints).toBeDefined();
		const bp = ability[0].breakpoints![0];
		expect(bp.count).toBe(1);
		expect(bp.actions).toEqual([{ kind: 'extraAction', actionKey: 'combat', amount: 1 }]);
	});
});
