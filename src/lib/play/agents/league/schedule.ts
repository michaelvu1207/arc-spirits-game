/**
 * The league's endless, seeded, balanced schedule. Game `i` always has the same seed
 * (`seed + i`) and the same seats for the same agent list, so every data version plays the same
 * games and versions compare pair by pair.
 *
 * Blocks of n games (n agents, tables of k): game j of a block seats position p with agent
 * `order[(j + offset[p]) mod n]`, with k distinct offsets. So in each block every agent plays k
 * games, once in each seat position. The order and offsets are found by a seeded search (a few
 * random starts, each improved by swapping agents) that spreads the meetings most evenly,
 * counting the earlier blocks.
 */

import { hashString } from '../../rng';
import { seededRandom, shuffle } from '../tournament';

export interface LeagueGame {
	index: number;
	seed: number;
	/** Agent ids in seat order. */
	seats: string[];
}

const CANDIDATES = 8;
const SWAPS = 200;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class LeagueSchedule {
	readonly agents: string[];
	readonly #seed: number;
	readonly #size: number;
	readonly #blocks: string[][][] = [];
	readonly #pairs = new Map<string, number>();

	constructor(agents: string[], opts: { seed: number; tableSize: number }) {
		if (new Set(agents).size !== agents.length) throw new Error('agent ids must be distinct');
		if (agents.length < opts.tableSize)
			throw new Error(`${agents.length} agents cannot fill a table of ${opts.tableSize}`);
		this.agents = [...agents].sort();
		this.#seed = opts.seed;
		this.#size = opts.tableSize;
	}

	game(index: number): LeagueGame {
		const n = this.agents.length;
		const block = Math.floor(index / n);
		while (this.#blocks.length <= block) this.#addBlock();
		return { index, seed: this.#seed + index, seats: this.#blocks[block][index % n] };
	}

	#addBlock(): void {
		const n = this.agents.length;
		const random = seededRandom(hashString(`league:${this.#seed}:${this.#blocks.length}`));
		const gamesOf = (order: string[], offsets: number[]) =>
			range(0, n).map((j) => offsets.map((o) => order[(j + o) % n]));
		// The growth of Σ meetings² over all pairs (earlier blocks counted).
		const cost = (games: string[][]) => {
			const added = new Map<string, number>();
			for (const g of games) for (const key of pairsOf(g)) added.set(key, (added.get(key) ?? 0) + 1);
			let c = 0;
			for (const [key, m] of added) c += m * (2 * (this.#pairs.get(key) ?? 0) + m);
			return c;
		};
		let best: { games: string[][]; cost: number } | null = null;
		for (let c = 0; c < CANDIDATES; c++) {
			let order = shuffle(this.agents, random);
			const offsets = [0, ...shuffle(range(1, n), random).slice(0, this.#size - 1)];
			let current = cost(gamesOf(order, offsets));
			// Hill climbing on the order: swap two agents, keep the swap when it is not worse.
			for (let s = 0; s < SWAPS; s++) {
				const next = [...order];
				const i = Math.floor(random() * n);
				const j = Math.floor(random() * n);
				[next[i], next[j]] = [next[j], next[i]];
				const c2 = cost(gamesOf(next, offsets));
				if (c2 <= current) {
					order = next;
					current = c2;
				}
			}
			if (!best || current < best.cost) best = { games: gamesOf(order, offsets), cost: current };
		}
		for (const g of best!.games)
			for (const key of pairsOf(g)) this.#pairs.set(key, (this.#pairs.get(key) ?? 0) + 1);
		this.#blocks.push(best!.games);
	}
}

/**
 * The lowest game number in [from, to) that is open and fits the free slots (`fit` gives its
 * slots, or null), with those slots. The games themselves (seeds, seats) do not depend on it.
 */
export function firstFit<T>(
	schedule: LeagueSchedule,
	from: number,
	to: number,
	open: (index: number) => boolean,
	fit: (game: LeagueGame) => T | null
): { game: LeagueGame; slots: T } | null {
	for (let i = from; i < to; i++) {
		if (!open(i)) continue;
		const game = schedule.game(i);
		const slots = fit(game);
		if (slots) return { game, slots };
	}
	return null;
}

function pairsOf(seats: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < seats.length; i++)
		for (let j = i + 1; j < seats.length; j++) out.push(pairKey(seats[i], seats[j]));
	return out;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
