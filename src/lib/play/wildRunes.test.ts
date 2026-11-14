import { describe, expect, it } from 'vitest';
import type { MatSlotSnapshot } from '$lib/types';
import type { AwakenMatRequirement } from './types';
import { WILDCARD_MAT_IDS } from './awakenConditions';
import { matchMatCost, spendableMats } from './effects/matMatch';
import {
	autoPickCostSlots,
	matchRewardCost,
	slotSatisfies,
	type CostRequirement
} from './locationInteractions';
import { isNavigationPowerRune } from './navigationPowers';

const wild: MatSlotSnapshot = {
	slotIndex: 1,
	hasRune: true,
	id: WILDCARD_MAT_IDS.anyRune,
	name: 'Any Rune',
	type: 'rune'
};
const forest: MatSlotSnapshot = {
	slotIndex: 2,
	hasRune: true,
	id: 'forest-rune',
	name: 'Forest Rune',
	type: 'rune',
	originId: 'forest'
};
const requirement = (
	runeId: string,
	kind: 'rune' | 'relic',
	wildcard = false
): AwakenMatRequirement => ({
	runeId,
	kind,
	wildcard,
	count: 1,
	name: runeId
});
const forestCost: CostRequirement = {
	match: 'origin',
	originId: 'forest',
	originName: 'Forest',
	label: 'Forest Rune'
};
const tidalCost: CostRequirement = {
	match: 'origin',
	originId: 'tidal',
	originName: 'Tidal',
	label: 'Tidal Rune'
};

describe('held wild runes', () => {
	it('pays named and any-rune awakening costs, but never relic costs', () => {
		const held = spendableMats([wild]);
		for (const cost of [
			requirement('tidal-rune', 'rune'),
			requirement(WILDCARD_MAT_IDS.anyRune, 'rune', true)
		]) {
			expect(matchMatCost([cost], held)).toEqual({ ok: true, consumedIndices: [0] });
		}
		for (const cost of [
			requirement('fairy', 'relic'),
			requirement(WILDCARD_MAT_IDS.anyRelic, 'relic', true)
		]) {
			expect(matchMatCost([cost], held).ok).toBe(false);
		}
	});

	it('keeps a wild rune for an unmatched origin and consumes each copy only once', () => {
		const costs = [requirement('forest-rune', 'rune'), requirement('tidal-rune', 'rune')];
		const held = spendableMats([wild, forest]);
		expect(matchMatCost(costs, held)).toEqual({ ok: true, consumedIndices: [1, 0] });
		expect(matchMatCost(costs, held, ['1', '2'], { strict: true }).ok).toBe(true);
		expect(matchMatCost(costs, spendableMats([wild])).ok).toBe(false);
	});

	it('pays origin and any-basic location costs while preserving relic requirements', () => {
		expect(slotSatisfies(wild, tidalCost)).toBe(true);
		expect(slotSatisfies(wild, { match: 'anyBasic', label: 'Any Rune' })).toBe(true);
		expect(slotSatisfies(wild, { match: 'anyRelic', label: 'Any Relic' })).toBe(false);
		expect(matchRewardCost([forestCost, tidalCost], [wild, forest])).toEqual({
			ok: true,
			consumedArrayIndexes: [1, 0]
		});
		expect(autoPickCostSlots([forestCost, tidalCost], [wild, forest])).toEqual([1, 0]);
		expect(matchRewardCost([forestCost, tidalCost], [wild]).ok).toBe(false);
	});

	it('can be spent for rune powers, while empty slots and relics cannot', () => {
		expect(isNavigationPowerRune(wild)).toBe(true);
		expect(isNavigationPowerRune({ ...wild, hasRune: false })).toBe(false);
		expect(isNavigationPowerRune({ ...wild, id: WILDCARD_MAT_IDS.anyRelic })).toBe(false);
	});
});
