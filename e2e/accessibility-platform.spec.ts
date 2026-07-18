import { test, expect, devices } from '@playwright/test';

test.describe('platform accessibility contract', () => {
	test('mobile controls stay 44px, zoom remains enabled, and preferences survive reload', async ({ browser, browserName }) => {
		const pixel = devices['Pixel 5'];
		// Playwright's Firefox backend intentionally rejects Chromium/WebKit's
		// `isMobile` emulation flag. The portable pieces still exercise the same
		// viewport, density, touch input and UA without weakening the assertion.
		const mobileContext = browserName === 'firefox'
			? {
				viewport: pixel.viewport,
				deviceScaleFactor: pixel.deviceScaleFactor,
				hasTouch: pixel.hasTouch,
				userAgent: pixel.userAgent
			}
			: pixel;
		const context = await browser.newContext({
			...mobileContext,
			reducedMotion: 'reduce'
		});
		await context.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '"off"::v1');
			localStorage.setItem('asp:visual-quality', '"off"::v1');
		});
		const page = await context.newPage();
		await page.goto('/play');
		await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');

		const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
		expect(viewport).not.toContain('user-scalable=no');
		expect(viewport).not.toContain('maximum-scale=1');

		await page.getByTestId('menu-settings').click({ force: true });
		const panel = page.getByTestId('menu-settings-panel');
		await expect(panel).toBeVisible();
		const undersized = await panel.locator('button:visible, input:visible, [role="radio"]:visible').evaluateAll((nodes) =>
			nodes
				.map((node) => {
					const box = node.getBoundingClientRect();
					return { tag: node.tagName, testId: node.getAttribute('data-testid'), width: box.width, height: box.height };
				})
				.filter((box) => box.width < 44 || box.height < 44)
		);
		expect(undersized).toEqual([]);

		await page.getByTestId('text-scale-130').click();
		await page.getByTestId('locale-en-XA').click();
		await panel.locator('label').filter({ hasText: 'High contrast' }).locator('input').check();
		await expect(page.locator('html')).toHaveAttribute('data-text-scale', '130');
		await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
		expect(await panel.evaluate((el) => el.scrollHeight >= el.clientHeight)).toBe(true);

		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-text-scale', '130');
		await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
		await context.close();
	});

	test('primary journey is keyboard operable', async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '"off"::v1');
			localStorage.setItem('asp:visual-quality', '"off"::v1');
		});
		await page.goto('/play');
		await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');
		const quick = page.getByTestId('quick-play');
		await quick.focus();
		await expect(quick).toBeFocused();
		await quick.press('Enter');
		await expect(page.getByTestId('ranked-view')).toBeVisible({ timeout: 30_000 });
	});
});
