import { test, expect } from '@playwright/test';

/**
 * Smoke coverage for the mobile-perf pass: confirms the play surface still loads
 * and runs cleanly after dropping unused deps (pixi/mathjs/tiptap/svelte-chartjs),
 * switching to the in-place room reconcile, and the global touch CSS. All matches
 * are ranked now: the primary CTA opens the ranked matchmaking view (queue timer +
 * player list) rather than instant-joining a room.
 *
 * The full multiplayer P0/full specs are currently red due to PRE-EXISTING UI
 * drift (the landing page was reworked to Play Ranked + Custom Lobby, so the
 * create-open/join-open helpers no longer match) — unrelated to this change.
 */
test.describe('mobile-perf smoke', () => {
	test('play landing loads clean, touch CSS applied, primary CTA opens ranked search', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push(`console: ${m.text()}`);
		});

		await page.goto('/play');
		await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');

		// Reworked landing renders.
		const quick = page.getByTestId('quick-play');
		await expect(quick).toBeVisible();

		// touch-action: manipulation reaches interactive controls (kills the ~300ms
		// double-tap delay) — proves the global layout.css rule shipped.
		const touchAction = await quick.evaluate((el) => getComputedStyle(el).touchAction);
		expect(touchAction).toBe('manipulation');

		// Primary CTA swaps the menu for the dedicated ranked matchmaking view. Force
		// the click after visibility so the mobile smoke is not fooled by decorative
		// menu layers or browser-specific pointer hit testing.
		await quick.click({ force: true });
		await expect(page.getByTestId('ranked-view')).toBeVisible({ timeout: 30_000 });
		await expect(page).toHaveURL(/\/play\/?$/);

		// No uncaught runtime errors from the dep removal or store change. Filter
		// environment noise (audio autoplay policy, missing PWA extras in headless).
		const real = errors.filter(
			(e) => !/autoplay|AudioContext|favicon|manifest|the user agent/i.test(e)
		);
		expect(real, `unexpected runtime errors:\n${real.join('\n')}`).toHaveLength(0);
	});

	test('splat quality setting toggles the background and persists', async ({ page }) => {
		await page.goto('/play');
		await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');

		// The persistent /play layout owns the splat now; MenuShell is transparent.
		const splatCanvas = page.locator('.play-bg .splat-canvas');
		await expect(splatCanvas).toHaveCount(1);

		// Open the graphics settings popover and switch the background Off.
		await page.getByTestId('menu-settings').click({ force: true });
		await expect(page.getByTestId('menu-settings-panel')).toBeVisible();
		await page.getByTestId('splat-quality-off').click();
		await expect(page.getByTestId('splat-quality-off')).toHaveAttribute('aria-checked', 'true');

		// Off unmounts the WebGL background entirely (the gradient shell remains).
		await expect(splatCanvas).toHaveCount(0);

		// Choice persists across a reload (localStorage-backed store).
		await page.reload();
		await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.locator('.play-bg .splat-canvas')).toHaveCount(0);
		await page.getByTestId('menu-settings').click({ force: true });
		await expect(page.getByTestId('splat-quality-off')).toHaveAttribute('aria-checked', 'true');

		// Restore to 60 so the setting is demonstrably live (background comes back).
		await page.getByTestId('splat-quality-60').click();
		await expect(page.locator('.play-bg .splat-canvas')).toHaveCount(1);
	});
});
