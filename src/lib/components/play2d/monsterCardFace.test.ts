import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gameImageUrl } from '$lib/storageImages';
import faces from './monsterCardFaces.json';
import {
	monsterCardFace,
	printedCardMatches,
	type MonsterCardFaceManifest,
	type PrintedMonsterCard
} from './monsterCardFace';

const VP = '70792514-aa43-4526-a7a4-0f1e4ca55d71'; // victory_point (1 VP)
const SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e'; // abyss_sealed_summon
const VP4 = '8254dc80-329c-4fc8-872b-b0b765c7b888'; // 4vp: 4 Victory Points
const UNKNOWN = 'not-a-reward-token'; // no engine meaning: a kill grants nothing for it

const ID = 'monster-1';
const PRINTED: PrintedMonsterCard = {
	v: 'abc',
	name: 'Ash Puff',
	barrier: 3,
	damage: 2,
	stage: 1,
	rewards: [VP, SUMMON]
};
const MANIFEST: MonsterCardFaceManifest = {
	width: 825,
	height: 1425,
	storageFolder: 'card_images/monsters_v2/test',
	cards: { [ID]: PRINTED }
};
const live = (
	over: Partial<{ barrier: number | null; damage: number | null; rewardTrack: string[] }> = {}
) => ({
	id: ID,
	barrier: 3,
	damage: 2,
	rewardTrack: [VP, SUMMON],
	...over
});

describe('printedCardMatches', () => {
	it('accepts the same Barrier, Damage and rewards in any order', () => {
		expect(printedCardMatches(PRINTED, live({ rewardTrack: [SUMMON, VP] }))).toBe(true);
	});

	it('ignores a token the engine cannot grant when the card does not print it', () => {
		expect(printedCardMatches(PRINTED, live({ rewardTrack: [VP, SUMMON, UNKNOWN] }))).toBe(true);
	});

	it('skips an unknown Barrier or Damage (the reward screen without a catalog row)', () => {
		expect(printedCardMatches(PRINTED, live({ barrier: null, damage: null }))).toBe(true);
		expect(printedCardMatches(PRINTED, live({ barrier: null, damage: null, rewardTrack: [VP] }))).toBe(false);
	});

	it('rejects other values or rewards', () => {
		expect(printedCardMatches(PRINTED, live({ barrier: 4 }))).toBe(false);
		expect(printedCardMatches(PRINTED, live({ damage: 3 }))).toBe(false);
		expect(printedCardMatches(PRINTED, live({ rewardTrack: [VP] }))).toBe(false);
		expect(printedCardMatches(PRINTED, live({ rewardTrack: [VP, SUMMON, SUMMON] }))).toBe(false);
		// The card prints an icon that a kill does not grant.
		expect(printedCardMatches({ ...PRINTED, rewards: [UNKNOWN, SUMMON] }, live({ rewardTrack: [UNKNOWN, SUMMON] }))).toBe(false);
		// The engine grants 4 VP where the card prints 1.
		expect(printedCardMatches(PRINTED, live({ rewardTrack: [VP4, SUMMON] }))).toBe(false);
	});
});

describe('monsterCardFace', () => {
	it('uses the bundled web copy while the printed card matches', () => {
		expect(monsterCardFace(live(), null, MANIFEST)).toEqual({
			url: `/monster-cards/cards/${ID}.webp?v=abc`,
			printed: PRINTED
		});
	});

	it('uses the bundle also when the row points at the uploaded copy of the same export', () => {
		const uploaded = `${MANIFEST.storageFolder}/${ID}.png`;
		expect(monsterCardFace(live(), uploaded, MANIFEST)?.url).toBe(`/monster-cards/cards/${ID}.webp?v=abc`);
		expect(monsterCardFace(live({ barrier: 5 }), uploaded, MANIFEST)).toBeNull();
	});

	it('draws the card when the printed card no longer matches', () => {
		expect(monsterCardFace(live({ damage: 9 }), null, MANIFEST)).toBeNull();
	});

	it('trusts another card image on the row, served resized', () => {
		const other = 'card_images/monsters_v2/en_generated/monster-1.png';
		expect(monsterCardFace(live({ damage: 9 }), other, MANIFEST)).toEqual({
			url: gameImageUrl(other),
			printed: null
		});
	});

	it('returns null for a monster without a printed card or a path', () => {
		expect(monsterCardFace({ ...live(), id: 'other' }, null, MANIFEST)).toBeNull();
	});
});

describe('the bundled manifest', () => {
	const manifest = faces as MonsterCardFaceManifest;
	it('has a web copy and printed values for every card', () => {
		const ids = Object.keys(manifest.cards);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			const card = manifest.cards[id];
			expect(card.v).toMatch(/^[0-9a-f]{10}$/);
			expect(card.name.length).toBeGreaterThan(0);
			expect(Number.isInteger(card.barrier) && Number.isInteger(card.damage)).toBe(true);
			expect(existsSync(new URL(`../../../../static/monster-cards/cards/${id}.webp`, import.meta.url))).toBe(true);
		}
	});
});
