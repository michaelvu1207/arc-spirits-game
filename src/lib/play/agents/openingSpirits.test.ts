/**
 * `startGame.openingSpirits` (tests only; Michael, 2026-11-21): a seat's opening four include the
 * named Spirit World spirits. The other seats' hands, the bag's size and the random numbers are as
 * in the normal deal, so a test with one seeded seat compares game by game with one without.
 */
import { describe, expect, it } from 'vitest';
import { loadFrozenCatalog } from './catalog';
import { createAgentLobby, pickGuardians, seatsFor } from './setup';
import type { PublicGameState, SeatColor } from '../types';

const catalog = loadFrozenCatalog();
const SEED = 10062;
const guardians = pickGuardians(catalog, SEED, 4);
const lobby = (opening?: Partial<Record<SeatColor, string[]>>): PublicGameState =>
	createAgentLobby(
		catalog,
		SEED,
		seatsFor(4).map((seat, i) => ({ seat, guardian: guardians[i], ...(opening?.[seat] ? { openingSpirits: opening[seat] } : {}) }))
	);
const hand = (s: PublicGameState, seat: SeatColor) => s.players[seat]!.spirits.filter((x) => x.slotIndex <= 4).map((x) => x.name);
const cursed = catalog.spirits.filter((s) => s.cost <= 5 && (s.classes?.['Cursed Spirit'] ?? 0) > 0).map((s) => s.name).sort();

describe('startGame.openingSpirits', () => {
	const plain = lobby();
	it('the catalog has Spirit World spirits with Cursed Spirit', () => {
		expect(cursed.length).toBeGreaterThanOrEqual(2);
	});
	it('puts the named spirits into the seat\'s opening four and leaves the other seats as dealt', () => {
		const wanted = cursed.slice(0, 2);
		const seeded = lobby({ Green: wanted });
		for (const name of wanted) expect(hand(seeded, 'Green')).toContain(name);
		expect(hand(seeded, 'Green')).toHaveLength(4);
		for (const seat of ['Red', 'Orange', 'Blue'] as SeatColor[]) expect(hand(seeded, seat)).toEqual(hand(plain, seat));
		expect(seeded.bags.hexSpirits.contents.length).toBe(plain.bags.hexSpirits.contents.length);
		expect(seeded.rng).toEqual(plain.rng);
		// The spirits that left the hand are back in the bag: the same cards are in the game.
		const all = (s: PublicGameState) =>
			[...s.bags.hexSpirits.contents.map((e) => e.name), ...s.market.map((m) => catalog.spirits.find((c) => c.id === m.spiritId)?.name ?? ''), ...(['Red', 'Orange', 'Green', 'Blue'] as SeatColor[]).flatMap((seat) => hand(s, seat))].sort();
		expect(all(seeded)).toEqual(all(plain));
		const guids = seeded.bags.hexSpirits.contents.map((e) => e.guid);
		expect(new Set(guids).size).toBe(guids.length);
	});
	it('keeps a wanted spirit the seat was dealt, and takes two copies when a name is given twice', () => {
		const first = hand(plain, 'Red')[0];
		const same = lobby({ Red: [first] });
		expect(hand(same, 'Red')).toEqual(hand(plain, 'Red'));
		const twice = lobby({ Blue: [cursed[0], cursed[0]] });
		expect(hand(twice, 'Blue').filter((n) => n === cursed[0]).length).toBeGreaterThanOrEqual(1);
	});
	it('skips a name that is not in the Spirit World bag', () => {
		const odd = lobby({ Red: ['No Such Spirit'] });
		expect(hand(odd, 'Red')).toEqual(hand(plain, 'Red'));
	});
	it('absent: the start is unchanged', () => {
		expect(lobby({})).toEqual(plain);
	});
});
