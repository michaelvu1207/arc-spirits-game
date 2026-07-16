import { describe, expect, it } from 'vitest';
import { LOW_POLY_LANGUAGE, guardianSeed, momentConfig, qualityConfig } from './lowPolyLanguage';

describe('shared low-poly visual language', () => {
	it('keeps every required memorable moment and accessibility fallback explicit', () => {
		expect(LOW_POLY_LANGUAGE.version).toBe(1);
		expect(Object.keys(LOW_POLY_LANGUAGE.moments)).toEqual([
			'guardian', 'matchmaking', 'summon', 'corruption', 'reward', 'victory', 'profile', 'replay'
		]);
		expect(qualityConfig('off')).toMatchObject({ fps: 0, pixelRatio: 0, glow: false });
		expect(qualityConfig('battery').fps).toBeLessThan(qualityConfig('balanced').fps);
		expect(qualityConfig('balanced').fps).toBeLessThan(qualityConfig('high').fps);
		expect(momentConfig('victory').shards).toBeGreaterThan(momentConfig('profile').shards);
	});

	it('derives stable guardian silhouettes without identity data', () => {
		expect(guardianSeed('Embers')).toBe(guardianSeed(' Embers '));
		expect(guardianSeed('Embers')).not.toBe(guardianSeed('Tidecaller'));
	});
});
