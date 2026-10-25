import { describe, expect, test } from 'vitest';
import { mergeCombatLog } from './combatLog';

describe('mergeCombatLog', () => {
	test('collapses consecutive same-source grants, summing each effect', () => {
		const raw = [
			'Spirit Animal: Gained +1 combat damage.',
			'Spirit Animal: Gained 1 initiative.',
			'Spirit Animal: Gained +2 combat damage.',
			'Spirit Animal: Gained 2 initiative.'
		];
		expect(mergeCombatLog(raw)).toEqual([
			'Spirit Animal: Gained +3 combat damage and 3 initiative.'
		]);
	});

	test('preserves the "+" only for effects that use it', () => {
		expect(
			mergeCombatLog(['X: Gained +1 combat damage.', 'X: Gained +2 combat damage.'])
		).toEqual(['X: Gained +3 combat damage.']);
		expect(mergeCombatLog(['X: Gained 1 initiative.', 'X: Gained 2 initiative.'])).toEqual([
			'X: Gained 3 initiative.'
		]);
	});

	test('leaves a single grant line untouched (original wording)', () => {
		expect(mergeCombatLog(['Spirit Animal: Gained +1 combat damage.'])).toEqual([
			'Spirit Animal: Gained +1 combat damage.'
		]);
	});

	test('does not merge across different sources, and keeps non-grant lines verbatim', () => {
		const raw = [
			'Spirit Animal: Gained +1 combat damage.',
			'Spirit Animal: Gained +2 combat damage.',
			'Good is faster (initiative 3 vs 0) and strikes first.',
			'Aegis Weaver: Gained +1 combat damage.',
			'Red is stunned and cannot strike back.'
		];
		expect(mergeCombatLog(raw)).toEqual([
			'Spirit Animal: Gained +3 combat damage.',
			'Good is faster (initiative 3 vs 0) and strikes first.',
			'Aegis Weaver: Gained +1 combat damage.',
			'Red is stunned and cannot strike back.'
		]);
	});

	test('a non-numeric grant (loot) breaks the run and is left alone', () => {
		const raw = [
			'Cultivator: Gained 1 max barrier.',
			'Cultivator: Gained Forest Region Rune.',
			'Cultivator: Gained 1 max barrier.'
		];
		// The middle (non-numeric) line interrupts, so the two numeric lines do not merge.
		expect(mergeCombatLog(raw)).toEqual(raw);
	});

	test('empty log → empty', () => {
		expect(mergeCombatLog([])).toEqual([]);
	});
});
