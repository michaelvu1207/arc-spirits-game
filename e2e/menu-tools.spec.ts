import { expect, test } from '@playwright/test';

test.describe('menu tools remain useful without live season data', () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.addInitScript(() => localStorage.setItem('asp:splat-quality', '"off"::v1'));
	});

	test('menu destinations use distinct icons and render recoverable states', async ({ page }) => {
		// The shared E2E project disables WebGL; keep the persistent splat unmounted
		// so this menu test exercises application hydration and controls.
		await page.goto('/play');

		for (const testId of ['hall-of-guardians', 'composition-builder', 'ranked-season']) {
			const destination = page.getByTestId(testId);
			await expect(destination).toBeVisible();
			await expect(destination.locator('svg')).toHaveCount(1);
		}

		const rankedResponse = await page.goto('/play/ranked');
		expect(rankedResponse?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: /Ranked/ }).first()).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();

		await page.goto('/play/builder');
		await expect(page.getByTestId('builder-root')).toHaveAttribute('data-restored', 'true');
		await expect(page.getByTestId('builder-bundled-roster')).toBeVisible();
		await expect(page.getByTestId('builder-catalog')).toBeVisible();
		await page.getByTitle('Hero Captain').press('Enter');
		await expect(page.getByTestId('builder-team-count')).toHaveText('1/7');

		await page.goto('/play/champions');
		await expect(page.getByRole('heading', { name: 'Ranked Ladder' })).toBeVisible();
		const hallState = page
			.getByTestId('hall-unavailable-state')
			.or(page.getByText('No ranked games yet'))
			.or(page.getByRole('heading', { name: 'Standings' }));
		await expect(hallState.first()).toBeVisible();
	});

	test('outside-game surfaces use flat clipped shapes instead of cards', async ({
		page
	}, testInfo) => {
		const expectFlatShape = async (selector: string) => {
			const style = await page
				.locator(selector)
				.first()
				.evaluate((element) => {
					const computed = getComputedStyle(element);
					return {
						borderRadius: computed.borderRadius,
						backgroundImage: computed.backgroundImage,
						clipPath: computed.clipPath
					};
				});
			expect(style.borderRadius).toBe('0px');
			expect(style.backgroundImage).toBe('none');
			expect(style.clipPath).not.toBe('none');
		};

		await page.goto('/play');
		await expect(page.getByRole('link', { name: /Solo Play/ })).toBeVisible();
		const identityBox = await page.getByTestId('profile-dock').boundingBox();
		expect(identityBox).not.toBeNull();
		expect(identityBox!.x).toBeGreaterThan(1000);

		const modeStyle = await page.getByRole('link', { name: /Solo Play/ }).evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				borderRadius: style.borderRadius,
				backgroundImage: style.backgroundImage,
				clipPath: style.clipPath
			};
		});
		expect(modeStyle.borderRadius).toBe('0px');
		expect(modeStyle.backgroundImage).toBe('none');
		expect(modeStyle.clipPath).not.toBe('none');

		const iconTreatment = await page
			.locator('.m-gem')
			.first()
			.evaluate((element) => {
				const wrapper = getComputedStyle(element);
				const icon = element.querySelector('svg');
				return {
					borderWidth: wrapper.borderWidth,
					backgroundImage: wrapper.backgroundImage,
					backgroundColor: wrapper.backgroundColor,
					clipPath: wrapper.clipPath,
					iconWidth: icon?.getBoundingClientRect().width ?? 0
				};
			});
		expect(iconTreatment.borderWidth).toBe('0px');
		expect(iconTreatment.backgroundImage).toBe('none');
		expect(iconTreatment.backgroundColor).toBe('rgba(0, 0, 0, 0)');
		expect(iconTreatment.clipPath).toBe('none');
		expect(iconTreatment.iconWidth).toBeGreaterThanOrEqual(34);

		await expect
			.poll(() => page.locator('.modes').evaluate((element) => getComputedStyle(element).opacity))
			.toBe('1');
		await page.screenshot({ path: testInfo.outputPath('bold-graphic-menu.png'), fullPage: true });

		await page.getByTestId('profile-dock').click();
		const profile = page.getByRole('dialog', { name: 'Your profile' });
		await expect(profile).toBeVisible();
		await expect
			.poll(() => profile.evaluate((element) => getComputedStyle(element).borderRadius))
			.toBe('0px');

		await page.goto('/account');
		const accountSurface = page.locator('.card').first();
		await expect(accountSurface).toBeVisible();
		const accountTitle = page.getByRole('heading', { name: 'Account' });
		await expect(accountTitle).toBeVisible();
		expect(await accountTitle.evaluate((element) => getComputedStyle(element).textShadow)).toBe(
			'none'
		);
		const accountShellBox = await page.locator('.shell').boundingBox();
		const accountBackBox = await page.locator('.back').boundingBox();
		expect(accountShellBox).not.toBeNull();
		expect(accountBackBox).not.toBeNull();
		expect(accountShellBox!.width).toBeLessThanOrEqual(560);
		expect(accountBackBox!.width).toBeLessThan(160);
		expect(accountBackBox!.y).toBeLessThan(70);
		const accountStyle = await accountSurface.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				borderRadius: style.borderRadius,
				backgroundImage: style.backgroundImage,
				clipPath: style.clipPath
			};
		});
		expect(accountStyle.borderRadius).toBe('0px');
		expect(accountStyle.backgroundImage).toBe('none');
		expect(accountStyle.clipPath).not.toBe('none');
		await page.screenshot({ path: testInfo.outputPath('account-flat-title.png'), fullPage: true });

		await page.goto('/play/browse');
		await expect(page.locator('.create-btn')).toBeVisible();
		await expectFlatShape('.create-btn');

		await page.goto('/play/builder');
		await expect(page.getByTestId('builder-root')).toHaveAttribute('data-restored', 'true');
		await expectFlatShape('.panel');

		await page.goto('/play/ranked');
		await expect(page.locator('.card').first()).toBeVisible();
		await expectFlatShape('.card');

		const manifest = await (await page.request.get('/manifest.json')).json();
		expect(manifest.orientation).toBe('landscape');
	});

	test('organized home composition fits a landscape phone', async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 852, height: 393 });
		await page.goto('/play');
		await expect(page.getByRole('link', { name: /Solo Play/ })).toBeVisible();
		await expect(page.getByTestId('profile-dock')).toBeVisible();

		const identityBox = await page.getByTestId('profile-dock').boundingBox();
		const soloBox = await page.getByRole('link', { name: /Solo Play/ }).boundingBox();
		const quickBox = await page.getByRole('link', { name: /Quick Play/ }).boundingBox();
		const lobbyBox = await page.getByRole('link', { name: /Custom Lobby/ }).boundingBox();
		const logoBox = await page.locator('.logo').boundingBox();
		expect(identityBox).not.toBeNull();
		expect(soloBox).not.toBeNull();
		expect(quickBox).not.toBeNull();
		expect(lobbyBox).not.toBeNull();
		expect(logoBox).not.toBeNull();
		expect(identityBox!.x).toBeGreaterThan(560);
		expect(identityBox!.x).toBeGreaterThan(soloBox!.x + soloBox!.width);
		expect(logoBox!.y + logoBox!.height).toBeLessThanOrEqual(soloBox!.y);
		expect(quickBox!.x).toBeCloseTo(soloBox!.x, 0);
		expect(lobbyBox!.x).toBeCloseTo(soloBox!.x, 0);
		expect(quickBox!.width).toBeCloseTo(soloBox!.width, 0);
		expect(lobbyBox!.width).toBeCloseTo(soloBox!.width, 0);

		await expect
			.poll(() => page.locator('.modes').evaluate((element) => getComputedStyle(element).opacity))
			.toBe('1');
		await page.screenshot({ path: testInfo.outputPath('organized-phone-landscape.png') });
	});
});
