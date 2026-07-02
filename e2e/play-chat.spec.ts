import { test, expect, type Page } from '@playwright/test';
import { setupTwoPlayerGame } from './helpers';

async function dismissStartCutsceneIfPresent(page: Page) {
	const cutscene = page.getByTestId('game-start-cutscene');
	if (await cutscene.isVisible().catch(() => false)) {
		await cutscene.click({ force: true });
	}
}

test.describe('2D play chat', () => {
	test('players can send, receive, and clear unread chat in a live room', async ({ browser }) => {
		const hostContext = await browser.newContext();
		const guestContext = await browser.newContext();
		const host = await hostContext.newPage();
		const guest = await guestContext.newPage();

		await setupTwoPlayerGame(host, guest);
		await Promise.all([dismissStartCutsceneIfPresent(host), dismissStartCutsceneIfPresent(guest)]);

		await host.getByTestId('toggle-chat').click();
		await expect(host.getByTestId('game-chat')).toBeVisible();
		await host.getByTestId('chat-input').fill('Opening the abyss gate.');
		await host.getByTestId('chat-send').click();
		await expect(host.getByTestId('chat-message').filter({ hasText: 'Opening the abyss gate.' })).toBeVisible();
		await host.getByTestId('chat-close').click();

		await expect(guest.getByTestId('chat-unread')).toHaveText('1', { timeout: 10_000 });
		await guest.getByTestId('toggle-chat').click();
		await expect(guest.getByTestId('chat-message').filter({ hasText: 'Opening the abyss gate.' })).toBeVisible();
		await expect(guest.getByTestId('chat-unread')).toBeHidden();

		await guest.getByTestId('chat-input').fill('Blue is ready.');
		await guest.getByTestId('chat-send').click();
		await expect(guest.getByTestId('chat-message').filter({ hasText: 'Blue is ready.' })).toBeVisible();
		await guest.getByTestId('chat-close').click();

		await expect(host.getByTestId('chat-unread')).toHaveText('1', { timeout: 10_000 });
		await host.getByTestId('toggle-chat').click();
		await expect(host.getByTestId('chat-message').filter({ hasText: 'Blue is ready.' })).toBeVisible();

		await hostContext.close();
		await guestContext.close();
	});
});
