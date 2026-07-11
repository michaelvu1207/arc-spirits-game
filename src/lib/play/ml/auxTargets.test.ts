import { describe, expect, it } from 'vitest';
import type { PublicGameState } from '../types';
import type { LegalAction } from './actions';
import { fallenRouteModeTarget } from './auxTargets';

function stateAtStatus(statusLevel: number): PublicGameState {
	return { players: { Red: { statusLevel } } } as unknown as PublicGameState;
}

function navigation(destination: string): LegalAction {
	return {
		cmd: { type: 'lockNavigation', destination },
		next: {},
		policyNext: {},
		hasHiddenOutcome: false
	} as unknown as LegalAction;
}

describe('live auxiliary targets', () => {
	it('labels actual Fallen navigation as hunt versus return-to-Abyss', () => {
		const fallen = stateAtStatus(3);
		expect(fallenRouteModeTarget(fallen, 'Red', navigation('Arcane Abyss'))).toBe(0);
		expect(fallenRouteModeTarget(fallen, 'Red', navigation('Floral Patch'))).toBe(1);
	});

	it('does not invent route labels for non-Fallen or non-navigation decisions', () => {
		expect(
			fallenRouteModeTarget(stateAtStatus(2), 'Red', navigation('Floral Patch'))
		).toBeUndefined();
		expect(
			fallenRouteModeTarget(stateAtStatus(3), 'Red', {
				cmd: { type: 'passEncounter' }
			} as unknown as LegalAction)
		).toBeUndefined();
	});
});
