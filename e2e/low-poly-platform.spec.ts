import { test, expect } from '@playwright/test';

test('shared low-poly showcase uses real WebGL with a static fallback kept underneath', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(() => localStorage.setItem('asp:splat-quality', '"off"::v1'));
	await page.goto('/play');
	await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true');
	const stage = page.getByTestId('low-poly-spirit-stage').first();
	await expect(stage).toBeVisible();
	await expect(stage.locator('.fallback')).toHaveCount(1);
	const canvas = stage.locator('canvas');
	await expect(canvas).toHaveClass(/ready/, { timeout: 30_000 });
	const context = await canvas.evaluate((node) =>
		Boolean((node as HTMLCanvasElement).getContext('webgl2') || (node as HTMLCanvasElement).getContext('webgl'))
	);
	expect(context).toBe(true);
	expect(errors.filter((message) => !/AudioContext|autoplay/i.test(message))).toEqual([]);
});
