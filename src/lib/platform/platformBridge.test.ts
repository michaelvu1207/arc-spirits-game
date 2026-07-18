import { describe, expect, test } from 'vitest';
import { platformBridge } from './platformBridge';

describe('unsigned platform bridge', () => {
	test('is outbound-only and unavailable without signing', async () => {
		const bridge = platformBridge();
		expect(bridge).toMatchObject({ provider: 'none', available: false });
		await expect(bridge.mirrorAchievement('first-ranked-match', 100)).resolves.toBe('unavailable');
		await expect(bridge.mirrorLeaderboard('season-zero-2026', 1234)).resolves.toBe('unavailable');
	});
});
