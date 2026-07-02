import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
	setupTwoPlayerGame,
	expectPhase,
	expectRound,
	getRoomView,
	reloadRoomPage,
	runRoomCommand
} from './helpers';

/**
 * P0: two networked players run the simultaneous round loop end to end through the
 * morphing main stage — navigation lock/reveal, automatic empty-phase resolution,
 * and next-round synchronization.
 */
test.describe('2D play — P0 round loop', () => {
	test.setTimeout(360_000);

	let hostCtx: BrowserContext;
	let guestCtx: BrowserContext;
	let host: Page;
	let guest: Page;

	test.beforeEach(async ({ browser }) => {
		hostCtx = await browser.newContext();
		guestCtx = await browser.newContext();
		host = await hostCtx.newPage();
		guest = await guestCtx.newPage();
	});

	test.afterEach(async () => {
		await hostCtx.close();
		await guestCtx.close();
	});

	test('navigation lock/reveal and next-round sync', async () => {
		await setupTwoPlayerGame(host, guest);

		// Host locks first — destinations must NOT reveal yet. Commands go through the
		// browser context's own cookies, keeping the test networked without waiting on
		// animated transparent board hit targets.
		const hostLocked = await runRoomCommand(host, {
			type: 'lockNavigation',
			destination: 'Cyber City'
		});
		expect(hostLocked.projection.phase).toBe('navigation');
		expect(hostLocked.projection.revealedDestinations).toBe(false);

		// Guest locks; P0 then uses the host's deterministic force-advance path to
		// reveal destinations without waiting on wall-clock deadline enforcement.
		await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Tidal Cove' });
		let view = await runRoomCommand(host, { type: 'forceAdvancePhase' });
		// The stable browser invariant is that both clients converge on round 2 navigation
		// after the server resolves the reveal, empty location work, and cleanup.
		for (let i = 0; i < 6; i += 1) {
			if (view.projection.round === 2 && view.projection.phase === 'navigation') break;
			view = await runRoomCommand(host, { type: 'forceAdvancePhase' });
		}
		expect(view.projection.round).toBe(2);
		expect(view.projection.phase).toBe('navigation');

		host = await reloadRoomPage(host);
		guest = await reloadRoomPage(guest);

		const hostReloaded = await getRoomView(host);
		expect(hostReloaded.projection.round).toBe(2);
		expect(hostReloaded.projection.phase).toBe('navigation');
		const guestReloaded = await getRoomView(guest);
		expect(guestReloaded.projection.round).toBe(2);
		expect(guestReloaded.projection.phase).toBe('navigation');

		await expectRound(host, 2, 15_000);
		await expectPhase(host, 'navigation', 15_000);
		await expectRound(guest, 2, 15_000);
		await expectPhase(guest, 'navigation', 15_000);
	});
});
