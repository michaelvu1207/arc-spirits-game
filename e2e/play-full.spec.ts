import { chromium, test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	setupTwoPlayerGame,
	lockDestination,
	expectPhase,
	expectRound,
	claimMonsterRewardIfPresent,
	currentPhase,
	currentRound,
	getRoomView
} from './helpers';

type CatalogLocation = {
	name: string;
	originId: string | null;
	rewardRows: unknown[];
};

/** The local PostgREST emulator intentionally starts empty. Seed only its
 * static location records from the same canonical catalog used by the room
 * server, before either browser loads the asset store. Never write a live URL. */
async function seedLocalLocationAssets(): Promise<void> {
	const origin = process.env.PUBLIC_SUPABASE_URL ?? '';
	if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
		throw new Error('play-full requires the gate-owned local asset/store emulator');
	}
	const catalog = JSON.parse(readFileSync(join(process.cwd(), 'ml/catalog.json'), 'utf8')) as {
		locations: CatalogLocation[];
	};
	const locations: Record<string, unknown>[] = [];
	const rows: Record<string, unknown>[] = [];
	const assignments: Record<string, unknown>[] = [];
	for (const [locationIndex, location] of catalog.locations.entries()) {
		const locationId = `e2e-location-${locationIndex}`;
		locations.push({
			id: locationId,
			name: location.name,
			origin_id: location.originId,
			background_image_path: null
		});
		for (const [rowIndex, config] of location.rewardRows.entries()) {
			const rowId = `${locationId}-row-${rowIndex}`;
			rows.push({ id: rowId, config });
			assignments.push({
				id: `${rowId}-assignment`,
				location_id: locationId,
				row_id: rowId,
				row_index: rowIndex
			});
		}
	}
	const headers = {
		'content-type': 'application/json',
		'content-profile': 'arc_spirits_assets',
		prefer: 'resolution=merge-duplicates'
	};
	for (const [table, body] of [
		['game_locations', locations],
		['game_location_rows', rows],
		['reward_row_assignments', assignments]
	] as const) {
		const response = await fetch(`${origin}/rest/v1/${table}?on_conflict=id`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) throw new Error(`local ${table} seed failed: ${response.status}`);
	}
}

/** Click a visible enabled control if it exists. */
async function clickIfReady(page: Page, testId: string): Promise<boolean> {
	await foreground(page);
	const control = page.getByTestId(testId).first();
	if (!(await control.isVisible().catch(() => false))) return false;
	if (!(await control.isEnabled().catch(() => false))) return false;
	await control.click();
	return true;
}

/** Resolve the summon tray by making every choice explicitly, then returning
 * any unchosen cards. No auto-discard or deadline is involved. */
async function resolveDraw(page: Page): Promise<void> {
	await foreground(page);
	const tray = page.getByTestId('draw-tray');
	if (!(await tray.isVisible().catch(() => false))) return;
	for (let i = 0; i < 8 && (await tray.isVisible().catch(() => false)); i += 1) {
		const picksText = await page.getByTestId('picks-left').textContent().catch(() => '');
		const picks = Number(picksText?.match(/(\d+) pick/)?.[1] ?? 0);
		if (picks <= 0) break;
		const card = page.locator('[data-testid="draw-card"]:not([disabled])').first();
		await expect(async () => {
			if (!(await tray.isVisible().catch(() => false))) return;
			if (await card.isVisible().catch(() => false)) return;
			throw new Error('waiting for the summon command to settle');
		}).toPass({ timeout: 15_000 });
		if (!(await tray.isVisible().catch(() => false))) break;
		await card.click();
	}
	if (await tray.isVisible().catch(() => false)) {
		await clickIfReady(page, 'draw-discard');
	}
	await expect(tray).toBeHidden({ timeout: 15_000 });
}

/** Make one human-facing resolution step. Returns true only when a real UI
 * control was activated. This intentionally has no command/API fallback. */
async function resolveOneUiStep(page: Page): Promise<boolean> {
	await foreground(page);
	if (await page.getByTestId('draw-tray').isVisible().catch(() => false)) {
		await resolveDraw(page);
		return true;
	}
	if (await clickIfReady(page, 'result-continue')) return true;
	if (await clickIfReady(page, 'combat-continue')) {
		await claimMonsterRewardIfPresent(page);
		return true;
	}
	if (await page.getByTestId('monster-reward-menu').isVisible().catch(() => false)) {
		await claimMonsterRewardIfPresent(page);
		return true;
	}
	if (await clickIfReady(page, 'manual-dismiss')) return true;

	const decisions = page.getByTestId('decision-cards');
	if (await decisions.isVisible().catch(() => false)) {
		const option = decisions.locator('button:not([disabled])').first();
		if (await option.isVisible().catch(() => false)) {
			await option.click();
			return true;
		}
	}

	const claim = page.getByTestId('awaken-claim');
	if (await claim.isVisible().catch(() => false)) {
		// Relic benefits require an explicit choice for each row before commit.
		for (const row of await claim.locator('[data-testid^="claim-relic-"]').all()) {
			if (await row.isEnabled().catch(() => false)) await row.click();
		}
		if (await clickIfReady(page, 'awaken-claim-btn')) return true;
	}

	const augment = page.getByTestId('augment-placement');
	if (await augment.isVisible().catch(() => false)) {
		// Explicitly forfeit if this seeded transcript creates an augment. The
		// production UI requires a second confirmation when a legal target exists.
		if (await clickIfReady(page, 'augment-done')) {
			await clickIfReady(page, 'augment-done');
			return true;
		}
	}

	return clickIfReady(page, 'pass-turn');
}

async function finishRoundThroughUi(pages: Page[], targetRound: number): Promise<void> {
	for (let step = 0; step < 120; step += 1) {
		const rounds = await Promise.all(pages.map((page) => currentRound(page)));
		const phases = await Promise.all(pages.map((page) => currentPhase(page)));
		if (rounds.every((round) => round >= targetRound) && phases.every((phase) => phase === 'navigation')) {
			return;
		}

		let progressed = false;
		for (const page of pages) {
			progressed = (await resolveOneUiStep(page)) || progressed;
		}
		if (!progressed) await pages[0].waitForTimeout(250);
	}
	throw new Error(`real UI did not reach round ${targetRound} navigation`);
}

async function chooseInteraction(page: Page, label: RegExp): Promise<void> {
	await foreground(page);
	// Drive the human-facing action name. This remains stable when a Guardian grants
	// duplicate uses (which intentionally changes the internal row test ids).
	const interaction = page.getByRole('button', { name: label }).first();
	await expect(interaction).toBeVisible({ timeout: 15_000 });
	// The authoritative poll replaces the card subtree when a revision lands;
	// Playwright's pointer action can chase that detached node indefinitely even
	// though the rendered control is present. Dispatch the control's real handler.
	await interaction.dispatchEvent('click');
}

/** Model switching between two foreground devices. Chromium keeps both custom
 * contexts "visible" while throttling one renderer, so it does not naturally
 * emit the lifecycle event that a real app/browser foreground transition does. */
async function foreground(page: Page): Promise<void> {
	const authority = await getRoomView(page);
	await page.bringToFront();
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await page.waitForFunction(
		(expected) => {
			const diag = (window as unknown as { __arcPlayDiag?: () => Record<string, unknown> })
				.__arcPlayDiag?.();
			return Number(diag?.revision ?? -1) >= expected;
		},
		Number(authority.projection.revision),
		{ timeout: 15_000 }
	);
}

/**
 * Human-operated full-loop coverage. Setup uses authenticated public APIs to
 * seat the two players; every in-game action below is a rendered UI click.
 * The destinations select catalog-defined free actions deterministically:
 * Tidal row 0 = Spirit World Summon, Floral row 2 = Rest, Lantern row 1 =
 * Cultivate, and Arcane Abyss exposes the monster-combat control.
 */
test.describe('2D play — human-operated full game loop', () => {
	test.setTimeout(300_000);
	let hostCtx: BrowserContext;
	let guestCtx: BrowserContext;
	let guestBrowser: Browser;
	let host: Page;
	let guest: Page;

	test.beforeEach(async ({ browser }) => {
		const options = { reducedMotion: 'reduce' as const, viewport: { width: 1100, height: 760 } };
		hostCtx = await browser.newContext(options);
		// Two players are two foreground devices. A second browser process avoids
		// Chromium background-renderer throttling that can stretch a 30 ms command
		// into an 80 s UI delay when both pages share one process.
		guestBrowser = await chromium.launch({
			headless: true,
			args: [
				'--disable-gpu',
				'--disable-webgl',
				'--disable-webgl2',
				'--disable-accelerated-2d-canvas',
				'--disable-background-timer-throttling',
				'--disable-backgrounding-occluded-windows',
				'--disable-renderer-backgrounding'
			]
		});
		guestCtx = await guestBrowser.newContext({ ...options, baseURL: 'http://localhost:4173' });
		// Two concurrent 3D splat loops can starve Chromium's event loop for
		// 20–30 seconds on the deterministic CI lane. This test validates human
		// controls and authoritative outcomes, not art; the visual/performance
		// lanes exercise the real assets separately.
		for (const context of [hostCtx, guestCtx]) {
			await context.addInitScript(() => {
				// Persisted graphics setting format from persistedState.svelte.ts. Set
				// before app modules evaluate so the WebGL component never mounts.
				localStorage.setItem('asp:splat-quality', '"off"::v1');
				const install = () => {
					const style = document.createElement('style');
					style.dataset.e2eHumanLoop = 'true';
					style.textContent = `
						*, *::before, *::after {
							animation: none !important;
							transition: none !important;
							filter: none !important;
							backdrop-filter: none !important;
						}
						canvas, video { display: none !important; }
					`;
					(document.head || document.documentElement).appendChild(style);
				};
				if (document.readyState === 'loading') {
					document.addEventListener('DOMContentLoaded', install, { once: true });
				} else install();
			});
			await context.route('**/*', (route) => {
				const type = route.request().resourceType();
				const url = route.request().url();
				if (type === 'image' || type === 'media' || type === 'font') return route.abort();
				if (type === 'script' && /spark|three/i.test(url)) return route.abort();
				if (/\.(splat|ply|ktx2|basis|drc|mp3|ogg|wav|png|jpe?g|webp|woff2?)(\?|$)/i.test(url)) {
					return route.abort();
				}
				return route.continue();
			});
		}
		host = await hostCtx.newPage();
		guest = await guestCtx.newPage();
	});

	test.afterEach(async () => {
		await hostCtx.close();
		await guestCtx.close();
		await guestBrowser.close();
	});

	test('summon, rest, cultivate, combat, and resolution phases through real UI', async () => {
		await seedLocalLocationAssets();
		await setupTwoPlayerGame(host, guest);

		// Round 1: Spirit World Summon + Rest.
		await lockDestination(host, 'Tidal Cove');
		await lockDestination(guest, 'Floral Patch');
		await expectPhase(host, 'location');
		await chooseInteraction(host, /Spirit World Summon/i);
		await resolveDraw(host);
		await chooseInteraction(guest, /\bRest\b/i);
		await clickIfReady(guest, 'result-continue');
		await finishRoundThroughUi([host, guest], 2);

		// Round 2: Cultivate.
		await lockDestination(host, 'Lantern Canyon');
		await lockDestination(guest, 'Cyber City');
		await expectPhase(host, 'location');
		await chooseInteraction(host, /\bCultivate\b/i);
		await clickIfReady(host, 'result-continue');
		await finishRoundThroughUi([host, guest], 3);

		// Round 3: Arcane Abyss combat, including explicit reward choice when won.
		await lockDestination(host, 'Arcane Abyss');
		await lockDestination(guest, 'Tidal Cove');
		await expectPhase(host, 'location');
		await foreground(host);
		await host.getByTestId('action-monsterCombat').click();
		await expect(host.getByTestId('combat-overlay')).toBeVisible();
		await host.getByTestId('combat-continue').click();
		await claimMonsterRewardIfPresent(host);
		await finishRoundThroughUi([host, guest], 4);

		await expectRound(host, 4);
		await expectRound(guest, 4);
		await expectPhase(host, 'navigation');
		await expectPhase(guest, 'navigation');
	});
});
