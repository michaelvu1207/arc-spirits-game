/** Deterministic evaluation schedules that remain identical under arbitrary sharding. */

export function guardianIndexForSeed(seed: number, guardianCount: number): number {
	if (!Number.isSafeInteger(seed) || seed < 0) {
		throw new Error('evalSchedule: seed must be a non-negative safe integer');
	}
	if (!Number.isSafeInteger(guardianCount) || guardianCount <= 0) {
		throw new Error('evalSchedule: guardianCount must be a positive safe integer');
	}
	return seed % guardianCount;
}
