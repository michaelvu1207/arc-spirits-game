/**
 * Shaping-potential tests, focused on the ladder5 'ascend3' preset: the engine-power
 * pivot (attackPower credit, NO status penalty). Verifies the exact Φ value on a fixture,
 * that attackPower is monotone in the dice pool, that status is inert under ascend3, and
 * that the potential telescopes correctly through vpReturnsToGo.
 */
import { describe, expect, it } from 'vitest';
import { buildPotential, expectedAttack, shapingFor, SHAPING_PRESETS, vpReturnsToGo } from './shaping';
import type { PrivatePlayerState } from '../types';

type SpiritFixture = { slotIndex: number; isFaceDown: boolean; classes?: Record<string, number> };

/** Minimal player carrying only the fields buildPotential/awakenedClassCounts read. */
function player(opts: {
	dice?: string[];
	maxBarrier?: number;
	statusLevel?: number;
	spirits?: SpiritFixture[];
}): PrivatePlayerState {
	return {
		attackDice: (opts.dice ?? []).map((tier, i) => ({ instanceId: `d${i}`, tier })),
		maxBarrier: opts.maxBarrier ?? 0,
		statusLevel: opts.statusLevel ?? 0,
		spirits: opts.spirits ?? []
	} as unknown as PrivatePlayerState;
}

// Fixture exercising every ascend3 term:
//   dice: 4 dice → 4/10 = 0.4;  maxBarrier 5 → 0.5;  attack: arcane,arcane,exalted,exalted = 6 → 6/20 = 0.3
//   awakened (face-up): 2 → 2/7;  faceDown: 3 → 3/7
//   awakened classes: World Ender + Cultivator → cultProg 1/5, vpClass 1/3;  status 2 (should be inert)
const FIX = player({
	dice: ['arcane', 'arcane', 'exalted', 'exalted'],
	maxBarrier: 5,
	statusLevel: 2,
	spirits: [
		{ slotIndex: 0, isFaceDown: false, classes: { 'World Ender': 1 } },
		{ slotIndex: 1, isFaceDown: false, classes: { Cultivator: 1 } },
		{ slotIndex: 2, isFaceDown: true, classes: { Fighter: 1 } },
		{ slotIndex: 3, isFaceDown: true, classes: { Elementalist: 1 } },
		{ slotIndex: 4, isFaceDown: true, classes: { 'World Ender': 1 } }
	]
});

describe('shaping: ascend3 engine-power preset', () => {
	it('expectedAttack sums dice-tier mean face values', () => {
		expect(expectedAttack(FIX)).toBeCloseTo(6, 10); // 2 + 2 + 1 + 1
		expect(expectedAttack(player({ dice: ['basic', 'enchanted'] }))).toBeCloseTo(1 / 3 + 2 / 3, 10);
		expect(expectedAttack(player({}))).toBe(0);
	});

	it('buildPotential(ascend3) matches the hand-computed Φ on the fixture', () => {
		const w = SHAPING_PRESETS.ascend3;
		// Φ = .05·(4/10) + .15·(5/10) + .25·(2/7) + .1·(3/7) + .3·(6/20) + 0·status + .4·(1/5 + 1/3)
		const expected =
			0.05 * 0.4 + 0.15 * 0.5 + 0.25 * (2 / 7) + 0.1 * (3 / 7) + 0.3 * 0.3 + 0.4 * (1 / 5 + 1 / 3);
		expect(buildPotential(FIX, w)).toBeCloseTo(expected, 12);
	});

	it('attackPower is monotone in the dice pool and contributes exactly w·clamp01(expectedAttack/20)', () => {
		const w = SHAPING_PRESETS.ascend3;
		const weak = player({ dice: ['basic'] }); // expectedAttack 1/3
		const strong = player({ dice: ['arcane', 'arcane', 'arcane'] }); // expectedAttack 6
		expect(buildPotential(strong, w)).toBeGreaterThan(buildPotential(weak, w));
		// Isolate the attackPower term: same player, weight 0 vs 0.3.
		const noAtk = { ...w, attackPower: 0 };
		expect(buildPotential(FIX, w) - buildPotential(FIX, noAtk)).toBeCloseTo(0.3 * (6 / 20), 12);
	});

	it('ascend3 has NO status penalty — Φ is invariant to statusLevel', () => {
		const w = SHAPING_PRESETS.ascend3;
		expect(w.status).toBe(0);
		const clean = player({ dice: ['arcane'], statusLevel: 0 });
		const fallen = player({ dice: ['arcane'], statusLevel: 3 });
		expect(buildPotential(fallen, w)).toBeCloseTo(buildPotential(clean, w), 12);
	});

	it('ablation/frozen presets are unchanged (ascend2 keeps −0.25 status, ascend has no attackPower)', () => {
		expect(SHAPING_PRESETS.ascend2.status).toBe(-0.25);
		expect(SHAPING_PRESETS.ascend2.attackPower).toBeUndefined();
		expect(SHAPING_PRESETS.ascend.attackPower).toBeUndefined();
		expect(SHAPING_PRESETS.ascend3.awakened).toBe(0.25); // lowered from ascend's 0.35 to keep Φ ~O(1)
		expect(shapingFor('ascend3')).toBe(SHAPING_PRESETS.ascend3);
	});

	it('the potential telescopes through vpReturnsToGo (ΔVP + ΔΦ, discounted)', () => {
		const w = SHAPING_PRESETS.ascend3;
		const b0 = buildPotential(player({ dice: ['basic'] }), w);
		const b1 = buildPotential(player({ dice: ['arcane', 'arcane'] }), w); // built up attack power
		const gamma = 0.9;
		const finalVp = 6; // scored 6 VP after the last recorded decision
		const finalBuild = b1;
		const g = vpReturnsToGo([0, 3], [b0, b1], finalVp, finalBuild, gamma);
		// Backwards: r1 = (6-3)/30 + (finalBuild-b1) = 0.1;  r0 = (3-0)/30 + (b1-b0) = 0.1 + (b1-b0)
		const r1 = 3 / 30 + (finalBuild - b1);
		const r0 = 3 / 30 + (b1 - b0);
		expect(g[1]).toBeCloseTo(r1, 12);
		expect(g[0]).toBeCloseTo(r0 + gamma * r1, 12);
	});
});
