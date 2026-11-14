/**
 * Notebooks on disk: `<agent>/notebook.md` and `<agent>/notebook.history.jsonl`.
 *
 * - Updates of one agent run one at a time ({@link NotebookStore.withLock}): several games of the
 *   same agent can end together, and the later update must start from the earlier result, so
 *   the read → model call → save sequence runs inside the lock.
 * - A save is atomic (temp file + rename) and appends one history line: time, game, data version
 *   hash, the old and new text hashes, and the old text, so a bad update can be seen and undone.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTEBOOK_FILE } from './agents';

export const HISTORY_FILE = 'notebook.history.jsonl';

export interface NotebookHistoryLine {
	at: string;
	gameId: string;
	/** The data version the game played (full catalog hash). */
	dataHash: string;
	oldHash: string;
	newHash: string;
	/** The text before the update (to undo it). */
	old: string;
}

export const textHash = (text: string) =>
	createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Write a file so that a reader sees the old or the new content, never a part. */
export function writeAtomic(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

export class NotebookStore {
	readonly #locks = new Map<string, Promise<unknown>>();

	/** Run `fn` when no other update of this agent runs (in call order). */
	withLock<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
		const before = this.#locks.get(agentDir) ?? Promise.resolve();
		const run = before.then(fn, fn);
		const tail = run.catch(() => {});
		this.#locks.set(agentDir, tail);
		void tail.then(() => {
			if (this.#locks.get(agentDir) === tail) this.#locks.delete(agentDir);
		});
		return run;
	}

	read(agentDir: string): string {
		const path = join(agentDir, NOTEBOOK_FILE);
		return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
	}

	history(agentDir: string): NotebookHistoryLine[] {
		const path = join(agentDir, HISTORY_FILE);
		if (!existsSync(path)) return [];
		return readFileSync(path, 'utf8')
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as NotebookHistoryLine);
	}

	/** The data version of the last update (null: never updated). */
	lastDataHash(agentDir: string): string | null {
		return this.history(agentDir).at(-1)?.dataHash ?? null;
	}

	/** Save a new notebook (call inside {@link withLock}). */
	save(agentDir: string, text: string, gameId: string, dataHash: string): NotebookHistoryLine {
		const old = this.read(agentDir);
		const line: NotebookHistoryLine = {
			at: new Date().toISOString(),
			gameId,
			dataHash,
			oldHash: textHash(old),
			newHash: textHash(text.trim()),
			old
		};
		writeAtomic(join(agentDir, NOTEBOOK_FILE), text.trim() ? `${text.trim()}\n` : '');
		appendFileSync(join(agentDir, HISTORY_FILE), `${JSON.stringify(line)}\n`);
		return line;
	}
}
