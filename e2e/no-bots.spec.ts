import { test, expect } from '@playwright/test';
import { ensureGuestIdentity, getRoomView, runRoomCommand } from './helpers';

test('Solo Play has one human, no bot controls, and advances through a round', async ({ page }) => {
	const botRequests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/bots/')) botRequests.push(request.url());
	});
	await page.goto('/play?e2e=1&ws=off');
	await ensureGuestIdentity(page, 'Solo Explorer');
	await expect(page.getByTestId('heads-up')).toHaveCount(0);
	await expect(page.getByTestId('solo-play')).toContainText('Solo Play');
	await page.getByTestId('solo-play').click();
	await page.waitForURL(/\/play\/[A-Z0-9]+/);
	let view: any = await getRoomView(page);
	expect(Object.values(view.projection.seats).filter((seat: any) => seat.memberId)).toHaveLength(1);
	expect(Object.values(view.projection.seats).some((seat: any) => seat.isBot)).toBe(false);
	await expect(page.getByTestId('add-bot')).toHaveCount(0);
	const roomCode = new URL(page.url()).pathname.split('/').pop();
	await expect(page.getByTestId('navigation-power-draft')).toBeVisible();
	await page.getByTestId('navigation-power-draft').locator('button').first().click();
	await expect(page.getByTestId('navigation-power-draft')).toHaveCount(0);
	await runRoomCommand(page, { type: 'lockNavigation', destination: 'Water Region' });
	await expect.poll(async () => (await getRoomView(page)).projection.phase).not.toBe('navigation');
	for (let step = 0; step < 10; step++) {
		view = await getRoomView(page);
		if (view.projection.round > 1) break;
		const command = {
			encounter: 'passEncounter',
			location: 'endLocationActions',
			benefits: 'commitBenefits',
			awakening: 'commitAwakening',
			cleanup: 'commitCleanup'
		}[view.projection.phase as string];
		if (!command) throw new Error(`Unexpected solo phase: ${view.projection.phase}`);
		await runRoomCommand(page, { type: command });
	}
	expect((await getRoomView(page)).projection.round).toBe(2);
	await page.screenshot({ path: 'test-results/no-bots-solo.png', fullPage: true });
	const before = botRequests.length;
	// Calling the server directly cannot bypass the disabled controls.
	const response = await page.request.post(`/api/play/sessions/${roomCode}/bots/add`, { data: {} });
	expect(response.ok()).toBe(false);
	expect(await response.text()).toContain('temporarily unavailable');
	const tick = await page.request.post(`/api/play/sessions/${roomCode}/bots/tick`, { data: {} });
	expect(tick.ok()).toBe(true);
	expect((await tick.json()).commandsIssued).toBe(0);
	expect(before).toBe(0);
});

test('a custom lobby has no bot controls and rejects bot fills', async ({ page }) => {
	await page.goto('/play?e2e=1&ws=off');
	await ensureGuestIdentity(page, 'Human Host');
	const created = await page.request.post('/api/play/sessions', {
		data: { displayName: 'Human Host' }
	});
	expect(created.ok()).toBe(true);
	const code = (await created.json()).projection.roomCode;
	await page.goto(`/play/${code}?e2e=1&ws=off`);
	await expect(page.getByTestId('add-bot')).toHaveCount(0);
	const fill = await page.request.post(`/api/play/sessions/${code}/bots/fill`, {
		data: { targetSeats: 4 }
	});
	expect(fill.status()).toBe(403);
	expect(await fill.text()).toContain('temporarily unavailable');
	const view: any = await getRoomView(page);
	expect(Object.values(view.projection.seats).some((seat: any) => seat.isBot)).toBe(false);
});
