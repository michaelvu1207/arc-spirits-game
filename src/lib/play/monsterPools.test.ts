/** Limited Abyss monster pools (catalog.monsterPools, from monster_pools.json). */
import { describe, expect, it } from 'vitest';
import { loadFrozenCatalog } from './agents/catalog';
import { createAgentLobby, pickGuardians, seatsFor } from './agents/setup';
import { canApply } from './legality';
import { normalizeMonsterPools } from './monsterPools';
import { buildSessionProjection, monsterDifficulty } from './runtime';
import { botActorFor } from './server/botPolicy';
import type { PlayCatalog, PublicGameState } from './types';

// The frozen test catalog has 8 monsters: 2 of Difficulty 1, 3 of 2, 3 of 3.
const base: PlayCatalog = loadFrozenCatalog();

function game(catalog: PlayCatalog, seats: number, seed = 11): PublicGameState {
	const guardians = pickGuardians(catalog, seed, seats);
	return createAgentLobby(
		catalog,
		seed,
		seatsFor(seats).map((seat, i) => ({ seat, guardian: guardians[i] }))
	);
}

const byDifficulty = (state: PublicGameState) =>
	[1, 2, 3].map((d) => state.bags.monsters.contents.filter((c) => c.difficulty === d).length);

describe('monster pools', () => {
	it('without a pool table every catalog card is dealt (unchanged behaviour)', () => {
		const state = game(base, 4);
		const all = [1, 2, 3].map(
			(d) => (base.monsters ?? []).filter((m) => monsterDifficulty(m) === d).length
		);
		expect(byDifficulty(state)).toEqual(all);
		expect(state.monsterDecks!.map((d) => d.total)).toEqual(all);
	});

	it('deals the pool size per difficulty for the player count, as a seeded subset', () => {
		const monsterPools = normalizeMonsterPools([
			{ players: 2, difficulty: 1, size: 1 },
			{ players: 2, difficulty: 2, size: 2 },
			{ players: 2, difficulty: 3, size: 1 },
			{ players: 4, difficulty: 1, size: 2 },
			{ players: 4, difficulty: 2, size: 1 },
			{ players: 4, difficulty: 3, size: 2 },
			{ players: 4, difficulty: 9, size: 4 } // invalid row: dropped
		]);
		expect(monsterPools).toHaveLength(6);
		const catalog = { ...base, monsterPools };
		const two = game(catalog, 2);
		expect(byDifficulty(two)).toEqual([1, 2, 1]);
		expect(two.monsterDecks!.map((d) => d.total)).toEqual([1, 2, 1]);
		const four = game(catalog, 4);
		expect(byDifficulty(four)).toEqual([2, 1, 2]);
		// The same seed deals the same cards; the projection's "cards left" is the real count.
		expect(game(catalog, 4).bags.monsters.contents).toEqual(four.bags.monsters.contents);
		const view = buildSessionProjection(four, { role: 'spectator', seatColor: null, displayName: null });
		expect(view.monsterDecks!.map((d) => d.count)).toEqual([2, 1, 2]);
		// A player count with no rows is unlimited.
		const three = game(catalog, 3);
		expect(byDifficulty(three)).toEqual(byDifficulty(game(base, 3)));
	});

	it('an empty pool cannot be drawn from', () => {
		const catalog = {
			...base,
			monsterPools: normalizeMonsterPools([
				{ players: 2, difficulty: 1, size: 0 },
				{ players: 2, difficulty: 2, size: 1 },
				{ players: 2, difficulty: 3, size: 1 }
			])
		};
		const state = game(catalog, 2);
		state.phase = 'location';
		state.players.Red!.navigationDestination = 'Arcane Abyss';
		const actor = botActorFor(state, 'Red');
		expect(canApply(state, actor, { type: 'drawMonsterCards', difficulty: 1 }, catalog)).toBe(false);
		expect(canApply(state, actor, { type: 'drawMonsterCards', difficulty: 2 }, catalog)).toBe(true);
	});
});
