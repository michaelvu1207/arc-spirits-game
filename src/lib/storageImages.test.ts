import { describe, expect, it } from 'vitest';
import { STORAGE_BASE_URL } from '$lib/supabase';
import { gameImageUrl, originalImageUrl } from './storageImages';

describe('gameImageUrl', () => {
	it('serves raster art through the resize endpoint, sized by art type', () => {
		const spirit = gameImageUrl('hex_spirits/a/front.png')!;
		expect(spirit).toContain('/storage/v1/render/image/public/game_assets/hex_spirits/a/front.png?');
		expect(spirit).toContain('width=1024&height=1024&resize=contain');
		expect(gameImageUrl('game_locations/x.png')).toContain('width=1600');
		expect(gameImageUrl('card_images/monsters_v2/v/a.png')).toContain('width=1024');
		expect(gameImageUrl('icons/uploaded/a.png')).toContain('width=512');
	});

	it('rewrites absolute bucket URLs and leaves other URLs and non-raster files alone', () => {
		expect(gameImageUrl(`${STORAGE_BASE_URL}/hex_spirits/a/front.png`)).toBe(
			gameImageUrl('hex_spirits/a/front.png')
		);
		expect(gameImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
		expect(gameImageUrl('class_icons/a/icon.svg+xml')).toBe(`${STORAGE_BASE_URL}/class_icons/a/icon.svg+xml`);
		expect(gameImageUrl(null)).toBeNull();
	});

	it('maps a display URL back to its original for the error fallback', () => {
		expect(originalImageUrl(gameImageUrl('hex_spirits/a/front.png')!)).toBe(
			`${STORAGE_BASE_URL}/hex_spirits/a/front.png`
		);
		expect(originalImageUrl(`${STORAGE_BASE_URL}/x.png`)).toBeNull();
	});
});
