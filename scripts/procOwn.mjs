/**
 * PROCESS OWNERSHIP for release gates and specs — spawn children in their OWN
 * process group and stop them with a verified TERM → bounded wait → KILL ladder
 * that AWAITS the actual exit (never trusts `ChildProcess.killed`, which only
 * means "a signal was sent").
 *
 * Why the group matters: the journey stack is a process TREE (gate → playwright
 * → workers → `tsx server/index.ts` room servers). Killing only the direct child
 * reparents the grandchildren to launchd/init and leaves orphan room servers
 * listening on random ports — the exact leak the journey gate exists to prevent.
 * `detached: true` gives each owned child its own group; signalling `-pid`
 * reaches every descendant.
 *
 * Exports are used by scripts/session-journey-gate.mjs, e2e/session-journey.spec.ts
 * and the forced-stubborn-child regression (scripts/procOwn.test.ts).
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readlinkSync } from 'node:fs';

/**
 * Spawn a child in its OWN process group with captured output.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, label?: string,
 *           stdout?: 'pipe' | 'inherit' }} [opts]
 * @returns {import('node:child_process').ChildProcess & { ownedLog: string, ownedLabel: string }}
 */
export function spawnOwned(cmd, args, opts = {}) {
	const child = spawn(cmd, args, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: ['ignore', opts.stdout ?? 'pipe', 'pipe'],
		detached: true // own process group → group signals reach grandchildren
	});
	const owned = /** @type {import('node:child_process').ChildProcess & { ownedLog: string, ownedLabel: string }} */ (
		child
	);
	owned.ownedLabel = opts.label ?? cmd;
	owned.ownedLog = '';
	child.stdout?.on('data', (d) => (owned.ownedLog += d));
	child.stderr?.on('data', (d) => (owned.ownedLog += d));
	return owned;
}

/** True while `pid` still exists (signal 0 probe). */
export function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Signal a child's WHOLE process group, falling back to the single process. */
function signalGroup(child, signal) {
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// already gone
		}
	}
}

/**
 * Stop an owned child: SIGTERM its group, AWAIT the real exit for up to
 * `termTimeoutMs`, then SIGKILL the group and await the exit unconditionally.
 * Resolves `{ forced }` — true when the child ignored TERM and needed KILL.
 * Safe to call on an already-exited child (resolves immediately).
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ termTimeoutMs?: number }} [opts]
 * @returns {Promise<{ forced: boolean }>}
 */
export async function stopOwned(child, opts = {}) {
	const termTimeoutMs = opts.termTimeoutMs ?? 5000;
	if (child.exitCode != null || child.signalCode != null) {
		// Already exited — still sweep the group in case grandchildren outlived it.
		signalGroup(child, 'SIGKILL');
		return { forced: false };
	}
	const exited = once(child, 'exit');
	signalGroup(child, 'SIGTERM');
	const graceful = await Promise.race([
		exited.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), termTimeoutMs))
	]);
	if (graceful) {
		// The direct child exited on TERM; sweep the group for stragglers anyway.
		signalGroup(child, 'SIGKILL');
		return { forced: false };
	}
	signalGroup(child, 'SIGKILL');
	await exited; // KILL cannot be ignored — this always resolves
	return { forced: true };
}

/**
 * Terminate loose PIDs this process does NOT own (orphan cleanup): TERM each,
 * bounded wait for death, then KILL survivors and wait again. Returns the pids
 * that were still alive when cleanup started (the "found orphans" evidence).
 * @param {Iterable<number | string>} pids
 * @param {{ termTimeoutMs?: number, killTimeoutMs?: number }} [opts]
 * @returns {Promise<number[]>}
 */
export async function reapPids(pids, opts = {}) {
	const termTimeoutMs = opts.termTimeoutMs ?? 3000;
	const killTimeoutMs = opts.killTimeoutMs ?? 3000;
	const alive = [...pids].map(Number).filter((pid) => Number.isFinite(pid) && processAlive(pid));
	if (alive.length === 0) return [];
	for (const pid of alive) {
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			/* raced its own death */
		}
	}
	await waitForDeath(alive, termTimeoutMs);
	const stubborn = alive.filter(processAlive);
	for (const pid of stubborn) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* raced */
		}
	}
	await waitForDeath(stubborn, killTimeoutMs);
	return alive;
}

async function waitForDeath(pids, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && pids.some(processAlive)) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * The CURRENT WORKING DIRECTORY of a live process, or null when it cannot be
 * determined (process gone, permission denied). Used to SCOPE orphan scans to
 * THIS repository: a broad `pgrep -f server/index.ts` matches any workspace's
 * concurrently-running server on the machine, and a gate must never count — let
 * alone reap — a process that belongs to a different checkout. Linux reads
 * /proc/<pid>/cwd; macOS falls back to `lsof -a -p <pid> -d cwd`.
 * @param {number | string} pid
 * @returns {string | null}
 */
export function processCwd(pid) {
	const n = Number(pid);
	if (!Number.isFinite(n) || n <= 0) return null;
	try {
		return readlinkSync(`/proc/${n}/cwd`);
	} catch {
		// Not Linux (or the proc entry vanished) — try lsof (macOS/BSD).
	}
	try {
		const res = spawnSync('lsof', ['-a', '-p', String(n), '-d', 'cwd', '-Fn'], {
			encoding: 'utf8'
		});
		const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('n'));
		return line ? line.slice(1) : null;
	} catch {
		return null;
	}
}

/**
 * Filter a pid list down to processes whose cwd is INSIDE `root` (the repo).
 * A pid whose cwd cannot be read is EXCLUDED — an orphan scan must fail toward
 * "not ours" rather than reaping a stranger.
 * @param {Iterable<number | string>} pids
 * @param {string} root
 * @returns {string[]}
 */
export function pidsWithCwdUnder(pids, root) {
	const normalizedRoot = root.replace(/\/+$/, '');
	return [...pids]
		.map(String)
		.filter((pid) => {
			const cwd = processCwd(pid);
			if (!cwd) return false;
			return cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`);
		});
}
