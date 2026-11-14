/**
 * The league's files per data version:
 *
 *   versions.json                       the versions in the order seen (id, hash, first seen, last active)
 *   versions/<id>/games/g00012.jsonl    a game's transcript (header … result, then the statements)
 *   versions/<id>/games/g00012.abandoned-<time>.jsonl   cut off (data change, stop): played again later
 *   versions/<id>/games/g00012.failed-<time>.jsonl      ended by provider errors: played again (twice at most)
 *   versions/<id>/traces/g00012.json    the finished game (strategyReport.ts trace); the game is done
 *   versions/<id>/report.{json,md}      this version's report
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './notebookStore';
import type { TraceFile } from './report';

export interface VersionEntry {
	id: string;
	hash: string;
	firstSeen: string;
	lastActive: string;
}

export const MAX_FAILURES = 2;
const pad = (i: number) => String(i).padStart(5, '0');

export class VersionStore {
	readonly dir: string;
	readonly #traces = new Map<string, Map<number, TraceFile>>();
	/** Done game numbers per version: finished, or skipped after failures. */
	readonly #done = new Map<string, Set<number>>();

	constructor(leagueDir: string) {
		this.dir = leagueDir;
	}

	gamesDir = (id: string) => join(this.dir, 'versions', id, 'games');
	tracesDir = (id: string) => join(this.dir, 'versions', id, 'traces');
	transcriptPath = (id: string, index: number) => join(this.gamesDir(id), `g${pad(index)}.jsonl`);
	tracePath = (id: string, index: number) => join(this.tracesDir(id), `g${pad(index)}.json`);

	entries(): VersionEntry[] {
		const path = join(this.dir, 'versions.json');
		return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as VersionEntry[]) : [];
	}

	/** Mark a version active now (added when new). */
	activate(id: string, hash: string): void {
		const now = new Date().toISOString();
		const list = this.entries();
		const entry = list.find((e) => e.id === id);
		if (entry) entry.lastActive = now;
		else list.push({ id, hash, firstSeen: now, lastActive: now });
		mkdirSync(this.gamesDir(id), { recursive: true });
		mkdirSync(this.tracesDir(id), { recursive: true });
		writeAtomic(join(this.dir, 'versions.json'), `${JSON.stringify(list, null, 2)}\n`);
	}

	/** The version that was active before `id` (null: none). */
	previous(id: string): VersionEntry | null {
		return (
			this.entries()
				.filter((e) => e.id !== id)
				.sort((a, b) => b.lastActive.localeCompare(a.lastActive))[0] ?? null
		);
	}

	/** Finished games of a version (read once, then kept up to date in memory). */
	traces(id: string): Map<number, TraceFile> {
		let map = this.#traces.get(id);
		if (!map) {
			map = new Map();
			const done = new Set<number>();
			const dir = this.tracesDir(id);
			if (existsSync(dir))
				for (const f of readdirSync(dir).filter((n) => /^g\d+\.json$/.test(n))) {
					const file = JSON.parse(readFileSync(join(dir, f), 'utf8')) as
						| TraceFile
						| { skipped: true; index: number };
					done.add(file.index);
					if ('trace' in file) map.set(file.index, file);
				}
			this.#traces.set(id, map);
			this.#done.set(id, done);
		}
		return map;
	}

	/** A game is done when its trace file exists (a finished game, or one skipped after failures). */
	done(id: string, index: number): boolean {
		this.traces(id);
		return this.#done.get(id)!.has(index);
	}

	saveTrace(id: string, file: TraceFile): void {
		writeAtomic(this.tracePath(id, file.index), JSON.stringify(file));
		this.traces(id).set(file.index, file);
		this.#done.get(id)!.add(file.index);
	}

	/** Move a transcript aside (`abandoned` or `failed`) so the game can be played again. */
	setAside(id: string, index: number, kind: 'abandoned' | 'failed'): void {
		const path = this.transcriptPath(id, index);
		if (!existsSync(path)) return;
		renameSync(path, path.replace(/\.jsonl$/, `.${kind}-${Date.now()}.jsonl`));
		if (kind === 'failed' && this.count(id, 'failed', index) >= MAX_FAILURES) {
			this.traces(id);
			writeFileSync(
				this.tracePath(id, index),
				JSON.stringify({ skipped: true, index, reason: `${MAX_FAILURES} failed tries` })
			);
			this.#done.get(id)!.add(index);
		}
	}

	/** Transcripts set aside (`abandoned` / `failed`), of one game or of the whole version. */
	count(id: string, kind: 'abandoned' | 'failed', index?: number): number {
		const dir = this.gamesDir(id);
		if (!existsSync(dir)) return 0;
		const prefix = index === undefined ? 'g' : `g${pad(index)}.`;
		return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.includes(`.${kind}-`)).length;
	}

	/** Transcripts with no trace (cut off by a crash or a kill): set aside as abandoned. */
	setAsideCutOff(id: string, running: Set<number>): number {
		const dir = this.gamesDir(id);
		if (!existsSync(dir)) return 0;
		let n = 0;
		for (const f of readdirSync(dir)) {
			const m = /^g(\d+)\.jsonl$/.exec(f);
			if (!m || running.has(Number(m[1])) || this.done(id, Number(m[1]))) continue;
			this.setAside(id, Number(m[1]), 'abandoned');
			n += 1;
		}
		return n;
	}
}
