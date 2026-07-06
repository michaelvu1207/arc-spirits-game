import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupTwoPlayerGame, getRoomView, runRoomCommand } from './helpers';

/**
 * Parity-harness fixture + golden capture for the Arc Spirits Godot port.
 *
 * For each canonical game screen this drives the real SvelteKit play client (via the
 * debug-room + command API used by the other e2e specs), then writes TWO artifacts into
 * the SIBLING Godot repo:
 *   fixtures/<nn>-<name>.json  — a {_meta, view} object: the `_meta` header (name,
 *                                capturedAt, revision, seatPerspective, howReached) wrapping
 *                                the exact /view API response the web client renders from.
 *   goldens/web/<nn>-<name>.png — the web client at 1280×720 (deviceScaleFactor 1, no mobile
 *                                emulation), the pixel reference the Godot render diffs against.
 *
 * The Godot port renders each screen from the fixture JSON and diffs it against the golden
 * at a <=1.5% pixel budget, so these are the ground truth for the whole parity harness.
 *
 * Determinism: reduced-motion + an injected animation-kill stylesheet + a fonts-ready wait
 * settle every capture; the acting seat is always the one holding the pending work. Board
 * ART is intentionally the ?e2e=1 placeholder set (deterministic; the port supplies its own
 * art anyway) — see fixtures/README.md. Per-fixture nondeterminism is noted there too.
 *
 * This spec is READ-ONLY against app code: it only creates its own artifacts. It never
 * commits. Run: `npx playwright test e2e/capture-fixtures.spec.ts` from the spectate repo.
 */

const GODOT_ROOT = resolve(
	'/Users/maikyon/Documents/Programming/ArcSpirits/arc-spirits-godot'
);
const FIXTURES_DIR = resolve(GODOT_ROOT, 'fixtures');
const GOLDENS_DIR = resolve(GODOT_ROOT, 'goldens', 'web');
const VIEWPORT = { width: 1280, height: 720 };
const BASE = 'http://localhost:4173';

mkdirSync(FIXTURES_DIR, { recursive: true });
mkdirSync(GOLDENS_DIR, { recursive: true });

const ANIM_KILL = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;}`;

// ── low-level setup helpers (mirrors e2e/helpers.ts; those internals aren't exported) ──

async function apiPost(page: Page, path: string, body: Record<string, unknown> = {}): Promise<any> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const res = await page.context().request.post(path, { data: body });
		const text = await res.text();
		if (res.ok()) return JSON.parse(text);
		if (res.status() >= 500 && attempt < 4) {
			await page.waitForTimeout(500 * (attempt + 1));
			continue;
		}
		throw new Error(`POST ${path} -> ${res.status()}: ${text.slice(0, 300)}`);
	}
	throw new Error(`POST ${path} failed after retries.`);
}

async function seedCookie(page: Page, code: string, memberId: string | null): Promise<void> {
	if (!memberId) throw new Error(`Missing member id for ${code}`);
	await page.context().addCookies([
		{
			name: `arc_spirits_play_member_${code.toUpperCase()}`,
			value: memberId,
			url: BASE,
			httpOnly: true,
			sameSite: 'Lax',
			secure: false
		}
	]);
}

function roomCodeOf(page: Page): string {
	const parts = new URL(page.url()).pathname.split('/').filter(Boolean);
	const code = parts.at(-1);
	if (!code || code === 'play') throw new Error(`No room code in ${page.url()}`);
	return code;
}

async function newDesktop(browser: Browser): Promise<BrowserContext> {
	return browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor: 1,
		isMobile: false,
		hasTouch: false,
		reducedMotion: 'reduce'
	});
}

// ── phase-driving helpers (re-implemented here; mobile-layout.spec.ts keeps its own local) ──

async function refreshRoomPage(page: Page): Promise<void> {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(async () => {
		await getRoomView(page);
		const stage = await page
			.getByTestId('main-stage')
			.first()
			.isVisible()
			.catch(() => false);
		if (!stage) throw new Error('main-stage not visible yet');
	}).toPass({ timeout: 30_000 });
}

async function forceUntilPhase(page: Page, phase: string, max = 4): Promise<void> {
	for (let i = 0; i < max; i += 1) {
		const view = await getRoomView(page);
		if (view.projection.phase === phase) return;
		await runRoomCommand(page, { type: 'forceAdvancePhase' });
		await refreshRoomPage(page);
	}
	const view = await getRoomView(page);
	if (view.projection.phase !== phase) throw new Error(`Never reached phase ${phase}`);
}

async function enterLocationPhase(
	host: Page,
	guest: Page,
	hostDest: string,
	guestDest = hostDest
): Promise<void> {
	await runRoomCommand(host, { type: 'lockNavigation', destination: hostDest });
	await runRoomCommand(guest, { type: 'lockNavigation', destination: guestDest });
	await refreshRoomPage(host);
	await forceUntilPhase(host, 'location');
}

async function drainResolutionPhases(pages: Page[]): Promise<void> {
	const commitFor: Record<string, string> = {
		benefits: 'commitBenefits',
		awakening: 'commitAwakening',
		cleanup: 'commitCleanup'
	};
	for (let i = 0; i < 20; i += 1) {
		let progressed = false;
		for (const page of pages) {
			const view = await getRoomView(page);
			const phase = view.projection.phase as string;
			if (view.projection.status !== 'active' || !(phase in commitFor)) return;
			try {
				await runRoomCommand(page, { type: commitFor[phase] });
				progressed = true;
			} catch {
				/* phase moved under us — loop re-reads */
			}
		}
		if (!progressed) break;
	}
}

/** Spawn a dev debug room parked in Awakening with a face-down spirit of `className`. */
async function createDebugRoom(page: Page, className: string, spiritId?: string): Promise<string> {
	await page.goto('/play');
	const res = await page.context().request.post('/api/play/debug', {
		data: { displayName: 'Fixture Debug', className, spiritId }
	});
	const text = await res.text();
	expect(res.ok(), `debug room (${className}) failed: ${text.slice(0, 300)}`).toBe(true);
	const view = JSON.parse(text) as { projection: { roomCode: string } };
	const code = view.projection.roomCode;
	await page.goto(`/play/${code}?e2e=1`);
	await expect(page.getByTestId('main-stage')).toBeVisible({ timeout: 30_000 });
	return code;
}

/**
 * Discover a live catalog spirit id carrying `className` by spinning up a debug room for
 * that class and reading the seeded (face-down) test spirit out of its owner projection.
 * Returns null when the catalog carries no such spirit (caller then skips that fixture).
 */
async function discoverSpiritIdByClass(page: Page, className: string): Promise<string | null> {
	await page.goto('/play');
	const res = await page.context().request.post('/api/play/debug', {
		data: { displayName: 'Catalog Probe', className }
	});
	if (!res.ok()) return null;
	const view = (await res.json()) as {
		projection: { players?: Record<string, { spirits?: any[] }> };
	};
	const players = view.projection.players ?? {};
	for (const seat of Object.keys(players)) {
		const spirits = players[seat]?.spirits ?? [];
		const faceDown = spirits.find((s) => s.isFaceDown && s.classes?.[className]);
		if (faceDown?.id) return faceDown.id as string;
		const any = spirits.find((s) => s.classes?.[className]);
		if (any?.id) return any.id as string;
	}
	return null;
}

// ── capture core ──

type Meta = {
	name: string;
	capturedAt: string;
	revision: number;
	seatPerspective: string;
	howReached: string[];
};

async function settle(page: Page): Promise<void> {
	await page.addStyleTag({ content: ANIM_KILL }).catch(() => {});
	// NOT networkidle: the play client polls/realtime-subscribes continuously, so it never
	// goes idle and the wait would hang forever. A bounded 'load' + fonts-ready + a fixed
	// delay (with reduced-motion already killing animation) is enough to stabilize a shot.
	await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
	await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
	await page.waitForTimeout(900);
}

async function capture(
	page: Page,
	seq: string,
	name: string,
	seatPerspective: string,
	howReached: string[]
): Promise<void> {
	await settle(page);

	const code = roomCodeOf(page);
	const res = await page.context().request.get(`/api/play/sessions/${code}/view`);
	const text = await res.text();
	expect(res.ok(), `view fetch for ${name}: ${text.slice(0, 200)}`).toBe(true);
	const view = JSON.parse(text);
	const revision = view?.projection?.revision;
	expect(typeof revision, `${name}: revision present`).toBe('number');

	const meta: Meta = {
		name,
		capturedAt: new Date().toISOString(),
		revision,
		seatPerspective,
		howReached
	};
	const fixturePath = resolve(FIXTURES_DIR, `${seq}-${name}.json`);
	writeFileSync(fixturePath, JSON.stringify({ _meta: meta, view }, null, 2) + '\n');

	const goldenPath = resolve(GOLDENS_DIR, `${seq}-${name}.png`);
	await page.screenshot({ path: goldenPath });

	// Sanity: PNG exists, is non-empty, and its IHDR reports exactly 1280x720.
	const st = statSync(goldenPath);
	expect(st.size, `${name}: golden non-empty`).toBeGreaterThan(1000);
	const buf = readFileSync(goldenPath);
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	expect(`${w}x${h}`, `${name}: golden dimensions`).toBe('1280x720');
}

// ─────────────────────────────────────────────────────────────────────────────
// One test per target screen. Each owns its contexts so a single failure does not
// block the rest (retries:0), maximizing captured coverage.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('capture parity fixtures + web goldens', () => {
	test.describe.configure({ timeout: 300_000 });

	test('01 lobby (2 seats claimed, pre-start)', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await host.goto('/play');
			await guest.goto('/play');
			const created = await apiPost(host, '/api/play/sessions', { displayName: 'Host' });
			const code = created.projection.roomCode;
			const pool = created.projection.guardianPool as string[];
			const joined = await apiPost(guest, `/api/play/sessions/${code}/join`, {
				displayName: 'Guest'
			});
			await seedCookie(host, code, created.member.id);
			await seedCookie(guest, code, joined.member.id);
			await apiPost(host, `/api/play/sessions/${code}/claim-seat`, { seatColor: 'Red' });
			await apiPost(host, `/api/play/sessions/${code}/commands`, {
				command: { type: 'selectGuardian', guardianName: pool[0] }
			});
			await apiPost(guest, `/api/play/sessions/${code}/claim-seat`, { seatColor: 'Blue' });
			await apiPost(guest, `/api/play/sessions/${code}/commands`, {
				command: { type: 'selectGuardian', guardianName: pool[1] }
			});
			await host.goto(`/play/${code}?e2e=1`, { waitUntil: 'domcontentloaded' });
			await expect(host.getByTestId('start-game')).toBeVisible({ timeout: 30_000 });
			await capture(host, '01', 'lobby', 'Red', [
				'POST /sessions (host)',
				'POST /join (guest)',
				'claim-seat Red + selectGuardian',
				'claim-seat Blue + selectGuardian',
				'goto /play/<code> (lobby, not started)'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('02 navigation open', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await setupTwoPlayerGame(host, guest);
			await refreshRoomPage(host);
			// At 1280×720 the navigator renders as the COMPASS (realm-compass); the cards-reel
			// (nav-carousel) only appears in a small board cell. Accept whichever is present.
			await expect(
				host.locator('[data-testid="realm-compass"], [data-testid="nav-carousel"]').first()
			).toBeVisible({ timeout: 30_000 });
			await capture(host, '02', 'navigation-open', 'Red', [
				'setupTwoPlayerGame (start → navigation)',
				'refresh host (compass navigator at 1280×720)'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('03 navigation locked (acting seat locked, pre-advance)', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await setupTwoPlayerGame(host, guest);
			await runRoomCommand(host, { type: 'lockNavigation', destination: 'Floral Patch' });
			await refreshRoomPage(host);
			await expect(host.getByTestId('confirm-circle')).toBeVisible({ timeout: 30_000 });
			await capture(host, '03', 'navigation-locked', 'Red', [
				'setupTwoPlayerGame',
				'host lockNavigation Floral Patch (guest not locked)',
				'refresh host → confirm-circle'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('04 destination reveal', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			const { code } = await setupTwoPlayerGame(host, guest);
			await runRoomCommand(host, { type: 'lockNavigation', destination: 'Floral Patch' });
			await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Cyber City' });
			await runRoomCommand(host, { type: 'forceAdvancePhase' });
			await host.goto(`/play/${code}?e2e=1&showDestinationReveal=1`, {
				waitUntil: 'domcontentloaded'
			});
			await expect(host.getByTestId('destination-reveal')).toBeVisible({ timeout: 30_000 });
			await capture(host, '04', 'destination-reveal', 'Red', [
				'setupTwoPlayerGame',
				'both seats lockNavigation (Floral Patch / Cyber City)',
				'forceAdvancePhase',
				'goto ?showDestinationReveal=1 (client reveal overlay)'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('05 location interaction menu', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await setupTwoPlayerGame(host, guest);
			await enterLocationPhase(host, guest, 'Floral Patch', 'Cyber City');
			await expect(host.getByTestId('interaction-grid')).toBeVisible({ timeout: 30_000 });
			await capture(host, '05', 'location-interaction', 'Red', [
				'setupTwoPlayerGame',
				'both lockNavigation (Floral Patch / Cyber City)',
				'advance to location phase → interaction-grid'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('06+07 combat overlay + reward claim', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await setupTwoPlayerGame(host, guest);
			await refreshRoomPage(host);
			await runRoomCommand(host, {
				type: 'debugGrant',
				grant: { kind: 'attackDice', tier: 'arcane', amount: 8 }
			});
			await runRoomCommand(host, { type: 'lockNavigation', destination: 'Arcane Abyss' });
			await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Arcane Abyss' });
			await runRoomCommand(host, { type: 'forceAdvancePhase' });
			await refreshRoomPage(host);
			await host.getByTestId('action-monsterCombat').click({ force: true });
			await expect(host.getByTestId('combat-overlay')).toBeVisible({ timeout: 30_000 });
			await capture(host, '06', 'combat-overlay', 'Red', [
				'setupTwoPlayerGame',
				'debugGrant 8 arcane attack dice',
				'both lockNavigation Arcane Abyss → location',
				'click action-monsterCombat → combat-overlay'
			]);

			// Advance combat to its reward: continue past the dice resolution, then capture the
			// monster-reward menu if the monster was defeated (8 arcane dice make a kill likely).
			await host.getByTestId('combat-continue').click({ force: true });
			const rewardVisible = await host
				.getByTestId('monster-reward-menu')
				.isVisible({ timeout: 20_000 })
				.catch(() => false);
			if (rewardVisible) {
				await capture(host, '07', 'reward-claim', 'Red', [
					'…continue from 06 combat-overlay',
					'click combat-continue → monster-reward-menu (monster defeated)'
				]);
			} else {
				test.info().annotations.push({
					type: 'skip-note',
					description: '07 reward-claim: monster survived the dice roll (no reward menu).'
				});
				throw new Error('07 reward-claim not reached: no monster-reward-menu (monster survived).');
			}
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('08 awaken offers', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			await createDebugRoom(host, 'Infiltrator');
			const view = await getRoomView(host);
			expect(view.projection.phase).toBe('awakening');
			await expect(host.getByTestId('awaken-offers')).toBeVisible({ timeout: 30_000 });
			await capture(host, '08', 'awaken-offers', 'Red', [
				'POST /api/play/debug {className:Infiltrator} (parks in awakening)',
				'goto /play/<code> → awaken-offers'
			]);
		} finally {
			await hostCtx.close();
		}
	});

	test('09 benefits claim pending', async ({ browser }) => {
		const probeCtx = await newDesktop(browser);
		let goldenRulerId: string | null = null;
		try {
			const probe = await probeCtx.newPage();
			goldenRulerId = await discoverSpiritIdByClass(probe, 'Golden Ruler');
		} finally {
			await probeCtx.close();
		}
		if (!goldenRulerId) {
			throw new Error('09 benefits-claim: no Golden Ruler spirit in catalog to seed the grant.');
		}

		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await setupTwoPlayerGame(host, guest);
			await refreshRoomPage(host);
			// Face-up Golden Ruler counts as awakened → its unconditional +1 VP Benefits grant
			// becomes a pending claim the moment we enter the Benefits step.
			await runRoomCommand(host, {
				type: 'debugGrant',
				grant: { kind: 'spirit', spiritId: goldenRulerId, faceDown: false }
			});
			await enterLocationPhase(host, guest, 'Floral Patch', 'Cyber City');
			await runRoomCommand(host, { type: 'endLocationActions' });
			await runRoomCommand(guest, { type: 'endLocationActions' });
			await expect
				.poll(async () => (await getRoomView(host)).projection.phase, {
					timeout: 25_000,
					message: 'Expected Benefits step to hold on the Golden Ruler claim'
				})
				.toBe('benefits');
			await refreshRoomPage(host);
			await expect(host.getByTestId('awaken-claim')).toBeVisible({ timeout: 30_000 });
			await capture(host, '09', 'benefits-claim', 'Red', [
				'discover Golden Ruler spirit id via debug room',
				'setupTwoPlayerGame',
				'debugGrant face-up Golden Ruler spirit (awakened)',
				'both lockNavigation → location → endLocationActions',
				'Benefits step holds on pending claim → awaken-claim'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('10 cleanup rune discard (over carry limit)', async ({ browser }) => {
		const TEAPOT_RUNE_ID = 'a6111d01-2c55-4b1f-854a-32887d92b8e1';
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await setupTwoPlayerGame(host, guest);
			await enterLocationPhase(host, guest, 'Floral Patch', 'Cyber City');
			for (let i = 0; i < 6; i += 1) {
				await runRoomCommand(host, {
					type: 'debugGrant',
					grant: { kind: 'rune', runeId: TEAPOT_RUNE_ID }
				});
			}
			await runRoomCommand(host, { type: 'endLocationActions' });
			await runRoomCommand(guest, { type: 'endLocationActions' });
			// Walk benefits/awakening forward; the rune overflow pins Cleanup open.
			for (let i = 0; i < 10; i += 1) {
				const phase = (await getRoomView(host)).projection.phase as string;
				if (phase !== 'benefits' && phase !== 'awakening') break;
				const cmd = phase === 'benefits' ? 'commitBenefits' : 'commitAwakening';
				for (const page of [host, guest]) {
					const fresh = (await getRoomView(page)).projection.phase;
					if (fresh !== phase) break;
					try {
						await runRoomCommand(page, { type: cmd });
					} catch {
						/* raced — outer loop re-reads */
					}
				}
			}
			await expect
				.poll(async () => (await getRoomView(host)).projection.phase, {
					timeout: 25_000,
					message: 'Expected Cleanup to hold on the host rune overflow'
				})
				.toBe('cleanup');
			await refreshRoomPage(host);
			await expect(host.getByTestId('rune-discard')).toBeVisible({ timeout: 30_000 });
			await capture(host, '10', 'cleanup-rune-discard', 'Red', [
				'setupTwoPlayerGame → location',
				'debugGrant 6 runes (overflow carry limit)',
				'endLocationActions → walk benefits/awakening',
				'Cleanup holds on overflow → rune-discard'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('11 corruption discard pending', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			await setupTwoPlayerGame(host, guest);
			await enterLocationPhase(host, guest, 'Floral Patch');
			await runRoomCommand(host, { type: 'adjustStatus', amount: 1 });
			await refreshRoomPage(host);
			await expect(host.getByTestId('corruption-discard')).toBeVisible({ timeout: 30_000 });
			await capture(host, '11', 'corruption-discard', 'Red', [
				'setupTwoPlayerGame → location (Floral Patch)',
				'adjustStatus +1 (raise corruption)',
				'refresh host → corruption-discard'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});

	test('12 postgame final scoring', async ({ browser }) => {
		const hostCtx = await newDesktop(browser);
		const guestCtx = await newDesktop(browser);
		try {
			const host = await hostCtx.newPage();
			const guest = await guestCtx.newPage();
			const { code } = await setupTwoPlayerGame(host, guest);
			await enterLocationPhase(host, guest, 'Floral Patch', 'Cyber City');
			await runRoomCommand(host, { type: 'debugGrant', grant: { kind: 'vp', amount: 30 } });
			await runRoomCommand(host, { type: 'endLocationActions' });
			await runRoomCommand(guest, { type: 'endLocationActions' });
			await drainResolutionPhases([host, guest]);
			await expect
				.poll(async () => (await getRoomView(host)).projection.status, {
					timeout: 25_000,
					message: 'Expected the game to finish once cleanup closed with 30 VP'
				})
				.toBe('finished');
			await host.goto(`/play/${code}?e2e=1`, { waitUntil: 'domcontentloaded' });
			await expect(host.getByTestId('postgame')).toBeVisible({ timeout: 30_000 });
			await capture(host, '12', 'postgame', 'Red', [
				'setupTwoPlayerGame → location',
				'debugGrant +30 VP (winning score)',
				'endLocationActions → drain benefits/awakening/cleanup → finished',
				'reload → postgame'
			]);
		} finally {
			await hostCtx.close();
			await guestCtx.close();
		}
	});
});
