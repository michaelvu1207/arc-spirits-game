/**
 * Seating: who sits in which game of one data version, kept on disk so a league can be stopped,
 * started again and given a different list of agents without losing games.
 *
 * - The seats of every game are written down when the game first starts
 *   (`versions/<id>/seating.json`). A game that is continued later, or played again after a
 *   failure, keeps them.
 * - With an unchanged agent list the seats are exactly those of `LeagueSchedule` (as before).
 * - When the agent list changes (an agent folder added or removed), a new "epoch" starts:
 *   finished games stay as they are; an unfinished game stays when all its agents are still in
 *   the list (it is continued), else it gets new seats; every later game comes from a new
 *   balanced schedule of the new list that counts the meetings already played.
 * - An agent's model or effort must not change under the same id (its games would no longer be
 *   comparable): that is refused. Use a new folder name.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from './notebookStore';
import type { LeagueAgent } from './agents';
import { LeagueSchedule, type LeagueGame } from './schedule';

interface KnownAgent {
	name: string;
	model: string;
	effort: string;
	memory: LeagueAgent['memory'];
}

interface Epoch {
	agents: string[];
	/** The first game number that takes its seats from this epoch's schedule … */
	from: number;
	/** … at this position of it (the positions before went to earlier unfinished games). */
	offset: number;
	/** The tables counted for the balance when the epoch began. */
	prior: string[][];
}

interface SeatingFile {
	epochs: Epoch[];
	games: Record<string, string[]>;
	known: Record<string, KnownAgent>;
}

export class Seating {
	readonly #path: string;
	readonly #seed: number;
	readonly #size: number;
	readonly #file: SeatingFile;
	readonly #schedule: LeagueSchedule;
	/** Set when this start began a new epoch: a line for the event log. */
	readonly change: string | null = null;

	constructor(
		path: string,
		agents: LeagueAgent[],
		opts: { seed: number; tableSize: number },
		isDone: (index: number) => boolean
	) {
		this.#path = path;
		this.#seed = opts.seed;
		this.#size = opts.tableSize;
		this.#file = existsSync(path)
			? (JSON.parse(readFileSync(path, 'utf8')) as SeatingFile)
			: { epochs: [], games: {}, known: {} };
		const f = this.#file;
		const ids = agents.map((a) => a.id).sort();
		const seated = new Set(Object.values(f.games).flat());
		for (const a of agents) {
			const k = f.known[a.id];
			if (k && seated.has(a.id) && (k.model !== a.model || k.effort !== a.effort))
				throw new Error(
					`agent ${a.id} has games as ${k.model} ${k.effort} and is now ${a.model} ${a.effort}: give the changed agent a new folder name, so the two are not mixed`
				);
			f.known[a.id] = { name: a.name, model: a.model, effort: a.effort, memory: a.memory };
		}
		const last = f.epochs.at(-1);
		if (!last) f.epochs.push({ agents: ids, from: 0, offset: 0, prior: [] });
		else if (last.agents.join('\n') !== ids.join('\n')) {
			const valid = new Set(ids);
			const indices = Object.keys(f.games).map(Number);
			const from = indices.length ? Math.max(...indices) + 1 : 0;
			const holes: number[] = [];
			let kept = 0;
			for (let i = 0; i < from; i++) {
				const seats = f.games[i];
				if (seats && (isDone(i) || seats.every((id) => valid.has(id)))) {
					kept += 1;
					continue;
				}
				holes.push(i);
			}
			const prior = Object.entries(f.games)
				.filter(([i]) => !holes.includes(Number(i)))
				.map(([, seats]) => seats);
			const epoch: Epoch = { agents: ids, from, offset: holes.length, prior };
			f.epochs.push(epoch);
			const schedule = this.#scheduleOf(epoch, f.epochs.length - 1);
			holes.forEach((index, k) => {
				f.games[index] = schedule.game(k).seats;
			});
			const added = ids.filter((id) => !last.agents.includes(id));
			const removed = last.agents.filter((id) => !valid.has(id));
			this.change = `agent list changed (${[added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean).join('; ')}): ${kept} game(s) kept, ${holes.length} unfinished game(s) get new seats, new schedule from game ${from + 1}`;
		}
		this.#schedule = this.#scheduleOf(f.epochs.at(-1)!, f.epochs.length - 1);
		this.#save();
	}

	#scheduleOf(epoch: Epoch, n: number): LeagueSchedule {
		// Epoch 0 is the plain schedule, so a league whose agent list never changes plays the
		// same games as before this file existed.
		return new LeagueSchedule(epoch.agents, {
			seed: this.#seed + 7919 * n,
			tableSize: this.#size,
			prior: epoch.prior
		});
	}

	#save(): void {
		writeAtomic(this.#path, `${JSON.stringify(this.#file)}\n`);
	}

	game(index: number): LeagueGame {
		const seed = this.#seed + index;
		const fixed = this.#file.games[index];
		if (fixed) return { index, seed, seats: fixed };
		const epoch = this.#file.epochs.at(-1)!;
		return { index, seed, seats: this.#schedule.game(epoch.offset + index - epoch.from).seats };
	}

	/** Write down the seats of a game that starts (kept from then on). */
	record(game: LeagueGame): void {
		if (this.#file.games[game.index]) return;
		this.#file.games[game.index] = game.seats;
		this.#save();
	}

	/** Agents that have games here but are no longer in the list (for the reports). */
	removed(current: LeagueAgent[]): LeagueAgent[] {
		const now = new Set(current.map((a) => a.id));
		const seated = new Set(Object.values(this.#file.games).flat());
		return Object.entries(this.#file.known)
			.filter(([id]) => !now.has(id) && seated.has(id))
			.map(([id, k]) => ({
				id,
				dir: '',
				name: `${k.name} (removed)`,
				model: k.model,
				effort: k.effort,
				memory: k.memory,
				learn: false,
				strategy: { id, name: k.name, text: '' }
			}));
	}
}
