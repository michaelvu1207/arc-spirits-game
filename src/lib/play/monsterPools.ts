/**
 * monster_pools.json → PlayCatalog.monsterPools. One row per (players, difficulty):
 *   { "players": 4, "difficulty": 1, "size": 9 }
 * Rows that are not whole numbers in range are dropped. An empty result means "no limit"
 * (callers then leave `monsterPools` off the catalog, so its hash is unchanged).
 */
import type { MonsterPoolRow } from './types';

export function normalizeMonsterPools(rows: unknown): MonsterPoolRow[] {
	if (!Array.isArray(rows)) return [];
	const out: MonsterPoolRow[] = [];
	for (const row of rows as Record<string, unknown>[]) {
		const players = Number(row?.players);
		const difficulty = Number(row?.difficulty);
		const size = Number(row?.size);
		if (!Number.isInteger(players) || players < 1) continue;
		if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) continue;
		if (!Number.isInteger(size) || size < 0) continue;
		out.push({ players, difficulty, size });
	}
	return out.sort((a, b) => a.players - b.players || a.difficulty - b.difficulty);
}
