/**
 * FORCED-STUBBORN-CHILD regression for the journey gate's process ownership
 * (scripts/procOwn.mjs) — the happy path is not evidence:
 *
 *   1. A child that IGNORES SIGTERM must still be stopped: stopOwned escalates
 *      to SIGKILL, AWAITS the real exit (never trusting `.killed`), and reports
 *      `forced: true`.
 *   2. A graceful child exits on SIGTERM alone (`forced: false`) — the ladder
 *      does not KILL first.
 *   3. GRANDCHILDREN die with the group: a parent that spawns its own child
 *      (the journey's playwright → room-server shape) leaves NO orphan after
 *      stopOwned — the grandchild would otherwise reparent to launchd exactly
 *      like the leaked room servers this fixes.
 *   4. reapPids kills detected orphans (TERM → KILL) and reports what it found.
 */
import { describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS helper shared with the .mjs gates (not in svelte-check scope)
import { pidsWithCwdUnder, processAlive, processCwd, reapPids, spawnOwned, stopOwned } from './procOwn.mjs';

const NODE = process.execPath;

function waitForOutput(child: { ownedLog: string }, pattern: RegExp, ms = 5000): Promise<string> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + ms;
		const poll = () => {
			const match = child.ownedLog.match(pattern);
			if (match) return resolve(match[1] ?? match[0]);
			if (Date.now() > deadline) {
				return reject(new Error(`child never printed ${pattern}\n${child.ownedLog}`));
			}
			setTimeout(poll, 50);
		};
		poll();
	});
}

describe('procOwn process ownership (journey-gate teardown contract)', () => {
	test('a STUBBORN child that traps SIGTERM is KILLed, its real exit awaited, and reported forced', async () => {
		const child = spawnOwned(
			NODE,
			['-e', `process.on('SIGTERM', () => console.log('ignoring TERM')); console.log('up'); setInterval(() => {}, 1000);`],
			{ label: 'stubborn' }
		);
		await waitForOutput(child, /up/);
		const { forced } = await stopOwned(child, { termTimeoutMs: 500 });
		expect(forced).toBe(true);
		// The exit was truly awaited — the process is gone NOW, not "signalled".
		expect(child.exitCode != null || child.signalCode != null).toBe(true);
		expect(child.signalCode).toBe('SIGKILL');
		expect(processAlive(child.pid)).toBe(false);
	}, 15_000);

	test('a GRACEFUL child exits on SIGTERM alone (no forced KILL)', async () => {
		const child = spawnOwned(
			NODE,
			['-e', `console.log('up'); setInterval(() => {}, 1000);`],
			{ label: 'graceful' }
		);
		await waitForOutput(child, /up/);
		const { forced } = await stopOwned(child, { termTimeoutMs: 5000 });
		expect(forced).toBe(false);
		expect(processAlive(child.pid)).toBe(false);
	}, 15_000);

	test('GRANDCHILDREN die with the group — a stubborn runner cannot leak its room-server grandchild', async () => {
		// Parent (ignores TERM, like a wedged runner) spawns a grandchild (also
		// TERM-deaf, like a wedged room server) WITHOUT detaching it.
		const parentScript = `
			process.on('SIGTERM', () => {});
			const { spawn } = require('node:child_process');
			const grandchild = spawn(process.execPath, ['-e',
				"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
			], { stdio: 'ignore' });
			console.log('GRANDCHILD=' + grandchild.pid);
			setInterval(() => {}, 1000);
		`;
		const child = spawnOwned(NODE, ['-e', parentScript], { label: 'runner' });
		const grandchildPid = Number(await waitForOutput(child, /GRANDCHILD=(\d+)/));
		expect(processAlive(grandchildPid)).toBe(true);

		await stopOwned(child, { termTimeoutMs: 500 });
		// The whole GROUP is dead — no orphan reparented to launchd.
		const deadline = Date.now() + 3000;
		while (processAlive(grandchildPid) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(processAlive(grandchildPid)).toBe(false);
	}, 15_000);

	test('reapPids terminates detected orphans (TERM then KILL) and reports them', async () => {
		const orphan = spawnOwned(
			NODE,
			['-e', `process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000);`],
			{ label: 'orphan' }
		);
		await waitForOutput(orphan, /up/);
		const found = await reapPids([orphan.pid], { termTimeoutMs: 300 });
		expect(found).toEqual([orphan.pid]);
		expect(processAlive(orphan.pid)).toBe(false);
		// Idempotent: nothing left to find.
		expect(await reapPids([orphan.pid])).toEqual([]);
	}, 15_000);

	test('ORPHAN SCANS ARE REPO-SCOPED: pidsWithCwdUnder keeps only processes whose cwd is inside the repo — a look-alike from another workspace is never counted (or reaped)', async () => {
		// Two identical-looking long-lived processes: one working IN this repo (the
		// journey spec's room-server shape), one in a foreign workspace (tmpdir).
		// A command-line pgrep matches both; the cwd filter must keep only ours.
		const repoRoot = process.cwd();
		const script = `console.log('up'); setInterval(() => {}, 1000);`;
		const ours = spawn(NODE, ['-e', script], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
		const foreign = spawn(NODE, ['-e', script], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
		try {
			// Wait until both are alive and inspectable.
			const deadline = Date.now() + 5000;
			while (
				(processCwd(ours.pid!) == null || processCwd(foreign.pid!) == null) &&
				Date.now() < deadline
			) {
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(processCwd(ours.pid!)).toBe(repoRoot);
			expect(processCwd(foreign.pid!)).not.toBe(repoRoot);

			const scoped = pidsWithCwdUnder([ours.pid!, foreign.pid!], repoRoot);
			expect(scoped).toEqual([String(ours.pid)]);

			// A dead/unreadable pid fails toward "not ours" — never toward reaping.
			expect(pidsWithCwdUnder([999999999], repoRoot)).toEqual([]);
		} finally {
			ours.kill('SIGKILL');
			foreign.kill('SIGKILL');
		}
	}, 15_000);
});
