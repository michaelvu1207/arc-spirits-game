import { describe, it, expect } from 'vitest';
import { fire, makePlayer, ctxFor } from './testHelpers';
import { decisions } from './arcaneAdvisor';
import type { DiceTier } from '../../types';

// Arcane Ascendant — DB intent: "In the Awakening phase, you may upgrade 1 Exalted
// Attack to an Arcane Attack."
//
// CHANGED from an onRest auto-upgrade to an Awakening-phase opt-in: a bespoke `run`
// handler on `awakeningPhase` offers an opt-in DECISION card (kind
// `arcaneAdvisorUpgrade`) ONLY when the player holds an Exalted attack die. The
// colocated resolver upgrades exactly one Exalted die to Arcane on "yes".

/** Build attack dice of the given tiers (instanceIds are irrelevant to the logic). */
function dice(tiers: DiceTier[]) {
	return tiers.map((tier, i) => ({ instanceId: `d${i}`, tier }));
}

describe('Arcane Ascendant (awakeningPhase opt-in)', () => {
	it('offers the upgrade decision when the player holds an Exalted die', () => {
		const { player } = fire({ 'Arcane Ascendant': 1 }, 'awakeningPhase', {
			player: { attackDice: dice(['basic', 'exalted']) }
		});
		const decision = player.pendingDecisions.find((d) => d.kind === 'arcaneAdvisorUpgrade');
		expect(decision).toBeDefined();
		expect(decision?.options.map((o) => o.id)).toEqual(['yes', 'no']);
	});

	it('surfaces the decision via the log (no silent no-op)', () => {
		const { log } = fire({ 'Arcane Ascendant': 1 }, 'awakeningPhase', {
			player: { attackDice: dice(['exalted']) }
		});
		expect(log.some((line) => line.includes('Decision:'))).toBe(true);
	});

	it('is gated on holding an Exalted die — no decision when none held', () => {
		const { player, log } = fire({ 'Arcane Ascendant': 1 }, 'awakeningPhase', {
			player: { attackDice: dice(['basic', 'enchanted', 'arcane']) }
		});
		expect(
			player.pendingDecisions.find((d) => d.kind === 'arcaneAdvisorUpgrade')
		).toBeUndefined();
		// No-silent-no-op: the gate is still observable in the log.
		expect(log.some((line) => line.includes('no Exalted attack die'))).toBe(true);
	});

	it('offers nothing when the player holds no dice at all', () => {
		const { player } = fire({ 'Arcane Ascendant': 1 }, 'awakeningPhase', {
			player: { attackDice: [] }
		});
		expect(
			player.pendingDecisions.find((d) => d.kind === 'arcaneAdvisorUpgrade')
		).toBeUndefined();
	});

	it('does not fire on unrelated triggers (no longer onRest)', () => {
		const { player } = fire({ 'Arcane Ascendant': 1 }, 'onRest', {
			player: { attackDice: dice(['exalted']) }
		});
		expect(
			player.pendingDecisions.find((d) => d.kind === 'arcaneAdvisorUpgrade')
		).toBeUndefined();
		// And the old auto-upgrade no longer happens on rest — the Exalted die stays.
		expect(player.attackDice.map((d) => d.tier)).toEqual(['exalted']);
	});

	describe('arcaneAdvisorUpgrade resolver', () => {
		it('upgrades exactly one Exalted die to Arcane on "yes"', () => {
			const player = makePlayer({ attackDice: dice(['exalted', 'exalted', 'basic']) });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.arcaneAdvisorUpgrade(ctx, 'yes');
			const tiers = player.attackDice.map((d) => d.tier).sort();
			// One exalted became arcane; the rest are untouched.
			expect(tiers).toEqual(['arcane', 'basic', 'exalted']);
			expect(ctx.log.some((line) => line.includes('exalted attack dice to arcane'))).toBe(true);
		});

		it('does nothing on "no"', () => {
			const player = makePlayer({ attackDice: dice(['exalted']) });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.arcaneAdvisorUpgrade(ctx, 'no');
			expect(player.attackDice.map((d) => d.tier)).toEqual(['exalted']);
		});

		it('is a no-op when there is no Exalted die to upgrade', () => {
			const player = makePlayer({ attackDice: dice(['basic', 'enchanted']) });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.arcaneAdvisorUpgrade(ctx, 'yes');
			expect(player.attackDice.map((d) => d.tier)).toEqual(['basic', 'enchanted']);
		});
	});
});
