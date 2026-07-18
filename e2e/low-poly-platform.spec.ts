import { test, expect } from '@playwright/test';

test('shared low-poly showcase uses WebGL when available and preserves its static fallback', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(() => localStorage.setItem('asp:splat-quality', '"off"::v1'));
	await page.goto('/play');
	await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');
	const stage = page.getByTestId('low-poly-spirit-stage').first();
	await expect(stage).toBeVisible();
	await expect(stage.locator('.fallback')).toHaveCount(1);
	const canvas = stage.locator('canvas');
	await expect
		.poll(
			async () =>
				(await canvas.evaluate((node) => node.classList.contains('ready'))) ||
				(await stage.evaluate((node) => node.classList.contains('static-only'))),
			{ timeout: 30_000 }
		)
		.toBe(true);
	if (await canvas.evaluate((node) => node.classList.contains('ready'))) {
		const context = await canvas.evaluate((node) =>
			Boolean((node as HTMLCanvasElement).getContext('webgl2') || (node as HTMLCanvasElement).getContext('webgl'))
		);
		expect(context).toBe(true);
	} else {
		await expect(stage).toHaveClass(/static-only/);
		await expect(stage.locator('.fallback')).toBeVisible();
	}
	expect(errors.filter((message) => !/AudioContext|autoplay/i.test(message))).toEqual([]);
});
