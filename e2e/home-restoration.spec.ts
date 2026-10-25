import { test, expect } from '@playwright/test';
import { getRoomView } from './helpers';

for (const viewport of [
	{ width: 1280, height: 800 },
	{ width: 844, height: 390 }
]) {
	test(`restored homepage at ${viewport.width}x${viewport.height} keeps solo human-only`, async ({
		page
	}, testInfo) => {
		await page.setViewportSize(viewport);
		await page.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '"off"::v1');
			localStorage.setItem('asp:visual-quality', '"off"::v1');
		});
		for (const path of ['/?e2e=1&ws=off', '/play?e2e=1&ws=off']) {
			await page.goto(path);
			await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');
			await expect(page.locator('.menu-col .menu')).toBeVisible();
			await expect(page.getByTestId('solo-play')).toHaveText('Solo Play →');
			await expect(page.getByTestId('heads-up')).toHaveCount(0);
			await expect(page.locator('body')).not.toContainText(/vs 3 bots|champion bot/);
			await expect(page.locator('.left-showcase')).toHaveCount(0);
			const home = page.getByTestId('play-home');
			const fits = await home.evaluate(
				(el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1
			);
			expect(fits).toBe(true);
		}
		await page.screenshot({ path: testInfo.outputPath('restored-home.png'), fullPage: true });
		await page.getByTestId('solo-play').click();
		await page.waitForURL(/\/play\/[A-Z0-9]+/);
		await expect(page.getByTestId('navigation-power-draft')).toBeVisible();
		const view: any = await getRoomView(page);
		expect(view.projection.activeSeats).toHaveLength(1);
	});
}
