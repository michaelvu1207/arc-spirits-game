import { describe, it, expect } from 'vitest';
import { loadOrSnapshotCatalog } from './nodeIo';

/**
 * Harness, not a test: re-freezes ml/catalog.json from the live Supabase catalog.
 * Run explicitly with SNAPCAT=1 — the ghost-replay of a recorded live game needs the
 * catalog AS OF that game, and a stale frozen snapshot diverges the replay.
 */
describe.runIf(process.env.SNAPCAT === '1')('_snapcat', () => {
	it('re-freezes ml/catalog.json from live', async () => {
		const catalog = await loadOrSnapshotCatalog(true);
		expect(catalog.guardians.length).toBeGreaterThan(0);
	}, 120_000);
});
