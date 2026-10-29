import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ back: null as string | null }));
vi.mock('$lib/supabase', () => ({ STORAGE_BASE_URL: 'https://assets.example/game_assets' }));
vi.mock('$lib/stores/assetStore.svelte', () => ({
	getAssetState: () => ({ spiritAssets: new Map([['spirit-id', { back_side_export: state.back }]]) })
}));

import { spiritBackImageUrl } from './helpers';

describe('active spirit back artwork', () => {
	it('uses the selected versioned back instead of the old fixed filename', () => {
		state.back = 'hex_spirits/spirit-id/game-fit-v2/back.png';
		expect(spiritBackImageUrl('spirit-id')).toBe('https://assets.example/game_assets/hex_spirits/spirit-id/game-fit-v2/back.png');
	});
	it('preserves absolute asset URLs', () => {
		state.back = 'https://cdn.example/selected-back.png';
		expect(spiritBackImageUrl('spirit-id')).toBe(state.back);
	});
	it('supports older catalogs without a back-side field', () => {
		state.back = null;
		expect(spiritBackImageUrl('spirit-id')).toBe('https://assets.example/game_assets/hex_spirits/spirit-id/rework-2026-10-29-card-icons-v2/game-fit-v2/back.png');
	});
});
