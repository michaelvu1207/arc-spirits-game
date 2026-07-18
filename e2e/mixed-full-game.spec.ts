import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	apiPost,
	ensureGuestIdentity,
	getRoomView
} from './helpers';

type Coord = {
	stage?: string;
	ok?: boolean;
	error?: string;
	revision?: number;
	stateHash?: string;
	trace?: Array<{ command?: { type?: string }; revision?: number; stateHash?: string }>;
	rejections?: unknown[];
};

type TraceStep = {
	actor: 'web';
	action: string;
	phase: string;
	round: number;
	revision: number;
	stateHash: string;
};

const GODOT_REPO = process.env.ARC_GODOT_REPO;
const GODOT_BIN = process.env.ARC_GODOT_BIN ?? '/Applications/Godot.app/Contents/MacOS/Godot';
const RESULT_FILE = process.env.ARC_MIXED_RESULT;

function readCoord(path: string): Coord | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as Coord;
	} catch {
		return null;
	}
}

async function waitForCoord(path: string, predicate: (value: Coord) => boolean, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = readCoord(path);
		if (value && predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Godot coordination timed out; last=${JSON.stringify(readCoord(path))}`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<number> {
	if (child.exitCode != null) return child.exitCode;
	return await Promise.race([
		new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1))),
		new Promise<number>((_, reject) =>
			setTimeout(() => reject(new Error('Godot player did not exit')), timeoutMs)
		)
	]);
}

async function waitForRevision(page: Page, before: number): Promise<ReturnType<typeof getRoomView>> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const view = await getRoomView(page);
		if (Number(view.projection.revision) > before) return view;
		await page.waitForTimeout(50);
	}
	throw new Error(`web control did not advance revision ${before}`);
}

async function driveWebToPostgame(page: Page, coord: string): Promise<TraceStep[]> {
	const trace: TraceStep[] = [];
	const deadline = Date.now() + 420_000;
	while (Date.now() < deadline) {
		const native = readCoord(coord);
		if (native?.stage === 'finished' && !native.ok) {
			throw new Error(`Godot player stopped before postgame: ${native.error ?? 'unknown failure'}`);
		}
		const before = await getRoomView(page);
		const projection = before.projection as typeof before.projection & {
			status?: string;
			stateHash?: string;
		};
		if (projection.status === 'finished') return trace;

		const unexpected = [
			'draw-tray', 'monster-reward-menu', 'decision-cards', 'manual-prompt',
			'awaken-claim', 'augment-placement', 'cleanup-rune-discard',
			'corruption-discard'
		];
		for (const testId of unexpected) {
			if (await page.getByTestId(testId).isVisible().catch(() => false)) {
				throw new Error(`seed-free pass transcript exposed an unexpected obligation: ${testId}`);
			}
		}

		let action = '';
		if (projection.phase === 'navigation') {
			const target = page.getByTestId('location-Floral Patch');
			if (await target.isVisible().catch(() => false) && await target.isEnabled().catch(() => false)) {
				action = 'lockNavigation:Floral Patch';
				await target.dispatchEvent('click');
			}
		} else {
			const pass = page.getByTestId('pass-turn');
			if (await pass.isVisible().catch(() => false) && await pass.isEnabled().catch(() => false)) {
				action = `pass:${projection.phase}`;
				await pass.click({ force: true });
			}
		}

		if (action !== '') {
			const after = await waitForRevision(page, projection.revision);
			const p = after.projection as typeof after.projection & { stateHash?: string };
			trace.push({
				actor: 'web', action, phase: projection.phase,
				round: projection.round, revision: p.revision,
				stateHash: String(p.stateHash ?? '')
			});
		} else {
			await page.waitForTimeout(75);
		}
	}
	throw new Error('web player did not reach postgame before the complete-game timeout');
}

async function runOneMixedGame(page: Page, gameIndex: number) {
	if (!GODOT_REPO) throw new Error('ARC_GODOT_REPO is required');
	await page.goto('/play?e2e=1');
	await ensureGuestIdentity(page, `Web Gate ${gameIndex}`);
	const created = await apiPost(page, '/api/play/sessions', { displayName: `Web Gate ${gameIndex}` });
	const code = created.projection.roomCode;
	const pool = created.projection.guardianPool;
	await apiPost(page, `/api/play/sessions/${code}/claim-seat`, { seatColor: 'Red' });
	await apiPost(page, `/api/play/sessions/${code}/commands`, {
		command: { type: 'selectGuardian', guardianName: pool[0] }
	});

	const dir = mkdtempSync(join(tmpdir(), `arc-mixed-${gameIndex}-`));
	const coord = join(dir, 'coord.json');
	writeFileSync(coord, JSON.stringify({ stage: 'starting' }));
	const godot = spawn(GODOT_BIN, [
		'--headless', '--path', GODOT_REPO,
		'res://scenes/mixed_ui_player.tscn', '--',
		`--base=http://localhost:4173`, `--room=${code}`, `--coord=${coord}`,
		'--ephemeral-session', '--no-restore'
	], { cwd: GODOT_REPO, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
	let godotLog = '';
	for (const stream of [godot.stdout, godot.stderr]) {
		stream.on('data', (chunk) => { godotLog = (godotLog + String(chunk)).slice(-12_000); });
	}

	try {
		await waitForCoord(coord, (value) => value.stage === 'ready' || value.stage === 'finished', 60_000);
		const ready = readCoord(coord);
		if (ready?.stage === 'finished') throw new Error(`Godot setup failed: ${ready.error ?? godotLog}`);
		// Attach the browser to this room before using the room-scoped view helper.
		// This is still lobby setup; the complete-game action trace starts only after /start.
		await page.goto(`/play/${code}?e2e=1`);
		// `ready` is written only after Godot receives durable acknowledgements for
		// join, Blue-seat claim, and Guardian selection. Read the room once as the
		// browser principal as an additional authority/reachability check.
		await getRoomView(page);
		await apiPost(page, `/api/play/sessions/${code}/commands`, {
			command: { type: 'setNavigationTimer', durationMs: null }
		});
		await apiPost(page, `/api/play/sessions/${code}/start`);
		await page.goto(`/play/${code}?e2e=1`);
		await expect(page.getByTestId('phase-bar').or(page.getByTestId('main-stage')).first())
			.toBeVisible({ timeout: 30_000 });

		const webTrace = await driveWebToPostgame(page, coord);
		await expect(page.getByTestId('postgame')).toBeVisible({ timeout: 30_000 });
		const native = await waitForCoord(coord, (value) => value.stage === 'finished', 30_000);
		const exitCode = await waitForExit(godot);
		if (exitCode !== 0 || !native.ok) {
			throw new Error(`Godot complete-game failure: ${native.error ?? 'exit ' + exitCode}\n${godotLog}`);
		}
		const final = await getRoomView(page);
		const projection = final.projection as typeof final.projection & {
			status?: string; stateHash?: string;
		};
		expect(projection.status).toBe('finished');
		expect(native.rejections ?? []).toEqual([]);
		expect(native.revision).toBe(projection.revision);
		expect(native.stateHash).toBe(projection.stateHash);
		expect(webTrace.length).toBeGreaterThanOrEqual(25);
		expect(native.trace?.length ?? 0).toBeGreaterThanOrEqual(25);
		for (const step of native.trace ?? []) {
			expect(step.command?.type).not.toBe('forceAdvancePhase');
			expect(step.stateHash).toBeTruthy();
		}
		return {
			game: gameIndex, room: code, finalRevision: projection.revision,
			finalStateHash: projection.stateHash, webActions: webTrace.length,
			godotActions: native.trace?.length ?? 0, webTrace, godotTrace: native.trace
		};
	} finally {
		if (godot.exitCode == null) godot.kill('SIGTERM');
		rmSync(dir, { recursive: true, force: true });
	}
}

test('three complete mixed web/Godot games converge without hidden automation', async ({ page }) => {
	test.setTimeout(1_500_000);
	await page.addInitScript(() => {
		localStorage.setItem('asp:splat-quality', '"off"::v1');
	});
	const games = [];
	for (let i = 1; i <= 3; i += 1) games.push(await runOneMixedGame(page, i));
	if (RESULT_FILE) writeFileSync(RESULT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), games }, null, 2) + '\n');
});
