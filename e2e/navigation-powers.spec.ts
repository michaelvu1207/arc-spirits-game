import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { NAVIGATION_POWERS } from '../src/lib/play/navigationPowers';
import { setupTwoPlayerGame, getRoomView, runRoomCommand } from './helpers';

type View = {
	projection: {
		status: string;
		round: number;
		phase: string;
		players: Record<string, any>;
		winnerSeat?: string;
	};
	member: { seatColor: string };
};
const view = async (page: Page) => (await getRoomView(page)) as unknown as View;
const catalog = JSON.parse(readFileSync(new URL('../ml/catalog.json', import.meta.url), 'utf8'));
const runeId = catalog.mats.find((item: any) => item.name === 'Mountain Region')?.id;
const regularSpirit = catalog.spirits.find((spirit: any) => spirit.cost >= 2 && spirit.cost <= 5);
const arcaneSpirit = catalog.spirits.find((spirit: any) => spirit.cost >= 7);
const augmentClass = catalog.classes.find((entry: any) => entry.name === 'Fighter');

async function setupNavigationGame(host: Page, guest: Page) {
	try {
		await setupTwoPlayerGame(host, guest);
	} catch (error) {
		// SvelteKit can supersede one of the simultaneous room navigations during
		// auth hydration. Recover the same already-created room, never recreate it.
		if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error;
		const roomUrl = [host.url(), guest.url()].find((url) => /\/play\/[A-Z0-9]+/.test(url));
		if (!roomUrl) throw error;
		await host.goto(roomUrl, { waitUntil: 'domcontentloaded' });
		await guest.goto(roomUrl, { waitUntil: 'domcontentloaded' });
		await expect(host.getByTestId('navigation-power-panel')).toBeVisible();
		await expect(guest.getByTestId('navigation-power-panel')).toBeVisible();
	}
}

async function chooseDrafts(page: Page) {
	await page.bringToFront();
	for (let attempt = 0; attempt < 5; attempt++) {
		const state = await view(page);
		if (!state.projection.players[state.member.seatColor]?.pendingPowerDrafts?.length) return;
		const first = page.getByTestId('navigation-power-draft').locator('button').first();
		if (!(await first.isVisible())) await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(first).toBeVisible();
		await first.click();
		await expect
			.poll(
				async () =>
					(await view(page)).projection.players[state.member.seatColor].pendingPowerDrafts.length
			)
			.toBeLessThan(state.projection.players[state.member.seatColor].pendingPowerDrafts.length);
	}
}

async function resolveOffers(page: Page) {
	await page.bringToFront();
	for (let attempt = 0; attempt < 10; attempt++) {
		const state = await view(page);
		const offers = state.projection.players[state.member.seatColor]?.navigationPowerOffers ?? [];
		const offer = offers.find((entry: any) => entry.mandatory) ?? offers[0];
		if (!offer) return;
		const pick = offer.options.find((option: any) => option.id !== 'decline') ?? offer.options[0];
		await expect(page.getByTestId(`power-option-${pick.id}`)).toBeVisible();
		await page.getByTestId(`power-option-${pick.id}`).click();
		await expect
			.poll(
				async () =>
					(await view(page)).projection.players[
						state.member.seatColor
					]?.navigationPowerOffers?.some((entry: any) => entry.id === offer.id) ?? false
			)
			.toBe(false);
	}
	throw new Error('Power offers did not drain');
}

async function nextNavigation(host: Page, guest: Page, round: number) {
	for (let n = 0; n < 12; n++) {
		await resolveOffers(host);
		await resolveOffers(guest);
		await chooseDrafts(host);
		await chooseDrafts(guest);
		const current = await view(host);
		if (current.projection.phase === 'navigation' && current.projection.round > round) return;
		if (current.projection.status === 'finished')
			throw new Error('Game ended before all powers were exercised');
		await runRoomCommand(host, { type: 'forceAdvancePhase' });
	}
	throw new Error('Next navigation did not open');
}

test('all 22 consumables can be selected, resolved, and followed by a completed game', async ({
	browser
}, testInfo) => {
	const hostContext = await browser.newContext({ reducedMotion: 'reduce' });
	const guestContext = await browser.newContext({ reducedMotion: 'reduce' });
	for (const context of [hostContext, guestContext])
		await context.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '"off"::v1');
			localStorage.setItem('asp:visual-quality', '"off"::v1');
		});
	const host = await hostContext.newPage();
	const guest = await guestContext.newPage();
	try {
		await setupNavigationGame(host, guest);
		await expect(host.getByTestId('navigation-power-draft')).toBeVisible();
		await host.screenshot({ path: testInfo.outputPath('power-draft.png'), fullPage: true });
		await chooseDrafts(host);
		await chooseDrafts(guest);
		const problems: string[] = [];
		for (const power of NAVIGATION_POWERS) {
			console.log(`Navigation Power E2E: ${power.id}`);
			const round = (await view(host)).projection.round;
			await runRoomCommand(host, {
				type: 'debugGrant',
				grant: { kind: 'navigationPower', powerId: power.id }
			});
			await runRoomCommand(host, { type: 'debugGrant', grant: { kind: 'maxBarrier', amount: 10 } });
			await runRoomCommand(host, { type: 'debugGrant', grant: { kind: 'fullHeal' } });
			await runRoomCommand(guest, { type: 'debugGrant', grant: { kind: 'fullHeal' } });
			await runRoomCommand(guest, { type: 'debugGrant', grant: { kind: 'status', level: 3 } });
			await runRoomCommand(host, { type: 'debugGrant', grant: { kind: 'status', level: 0 } });
			if (runeId) {
				await runRoomCommand(host, { type: 'debugGrant', grant: { kind: 'rune', runeId } });
				await runRoomCommand(guest, { type: 'debugGrant', grant: { kind: 'rune', runeId } });
			}
			if (power.id === 'cinder-awakening' && regularSpirit)
				await runRoomCommand(host, {
					type: 'debugGrant',
					grant: { kind: 'spirit', spiritId: regularSpirit.id, faceDown: true }
				});
			if (power.id === 'abyssal-reckoning' && arcaneSpirit)
				await runRoomCommand(host, {
					type: 'debugGrant',
					grant: { kind: 'spirit', spiritId: arcaneSpirit.id, faceDown: false }
				});
			if (power.id === 'augment-relay' && augmentClass && regularSpirit) {
				await runRoomCommand(guest, {
					type: 'debugGrant',
					grant: { kind: 'spirit', spiritId: regularSpirit.id, faceDown: false }
				});
				await runRoomCommand(guest, {
					type: 'debugGrant',
					grant: { kind: 'augment', classId: augmentClass.id, amount: 1 }
				});
				const player = (await view(guest)).projection.players.Blue;
				const augment = player.unplacedAugments.at(-1);
				await runRoomCommand(guest, {
					type: 'placeAugmentOnSpirit',
					augmentIndex: player.unplacedAugments.length - 1,
					augmentRuneId: augment.runeId,
					spiritSlotIndex: player.spirits.at(-1).slotIndex,
					className: augmentClass.name
				});
			}
			const destination = ['cinder-awakening', 'fires-rhythm'].includes(power.id)
				? 'Fire Region'
				: ['forest-bounty', 'forests-rhythm'].includes(power.id)
					? 'Forest Region'
					: power.id === 'tidal-arsenal'
						? 'Water Region'
						: [
									'abyssal-execution',
									'battle-fury',
									'battle-guard',
									'unbroken-assault',
									'duelists-prize'
							  ].includes(power.id)
							? 'Arcane Abyss'
							: 'Mountain Region';
			await host.reload();
			await expect(host.getByTestId(`location-${destination}`)).toBeVisible();
			await host.getByTestId(`location-${destination}`).dispatchEvent('click');
			await expect(host.getByTestId(`play-power-${power.id}`).first()).toBeVisible();
			await host.getByTestId(`play-power-${power.id}`).first().click();
			await expect
				.poll(async () => (await view(host)).projection.players.Red.pendingNavigationPower)
				.toBe(power.id);
			await runRoomCommand(guest, { type: 'lockNavigation', destination });
			await runRoomCommand(host, { type: 'forceAdvancePhase' });
			await resolveOffers(host);
			await resolveOffers(guest);
			if ((await view(host)).projection.phase === 'encounter' && power.id !== 'battle-reward') {
				await runRoomCommand(guest, { type: 'passEncounter' });
			}
			const after = await view(host);
			expect(after.projection.players.Red.navigationPower).toBe(power.id);
			if (
				['battle-fury', 'battle-guard', 'unbroken-assault', 'duelists-prize'].includes(power.id)
			) {
				await runRoomCommand(host, { type: 'startCombat' });
				await resolveOffers(host);
			}
			if (power.id === 'battle-reward') {
				await runRoomCommand(guest, { type: 'initiatePvp' });
				await resolveOffers(host);
			}
			if (power.id === 'shared-current') {
				await expect(host.getByTestId('navigation-power-trade')).toBeVisible();
				expect((await view(guest)).projection.players.Blue.phaseReady).toBe(false);
				await host.getByTestId('navigation-power-trade').click();
				const give = host.locator('.trade-grid fieldset').first().locator('input');
				if (await give.count()) {
					await give.first().check();
					await host.getByTestId('navigation-trade-propose').click();
					await expect(guest.getByTestId('navigation-trade-accept')).toBeVisible();
					await guest.getByTestId('navigation-trade-accept').click();
				} else {
					problems.push('Trade fixture had no available asset');
				}
			}
			if (power.id === 'ember-charge')
				await host.screenshot({ path: testInfo.outputPath('power-in-play.png'), fullPage: true });
			await nextNavigation(host, guest, round);
		}
		expect(problems).toEqual([]);
		// The same UI also acquires powers through the real one-Rune purchase.
		await runRoomCommand(host, { type: 'lockNavigation', destination: 'Mountain Region' });
		await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Water Region' });
		await runRoomCommand(host, { type: 'forceAdvancePhase' });
		await host.reload();
		const inventoryBeforePurchase = (await view(host)).projection.players.Red.powerInventory.length;
		await expect(host.getByTestId('gain-navigation-power')).toBeVisible();
		await host.getByTestId('gain-navigation-power').click();
		await host.locator('[data-testid^="power-pay-rune-"]').first().click();
		await expect(host.getByTestId('navigation-power-draft').locator('button')).toHaveCount(3);
		await chooseDrafts(host);
		expect((await view(host)).projection.players.Red.powerInventory).toHaveLength(
			inventoryBeforePurchase + 1
		);
		await runRoomCommand(host, { type: 'debugGrant', grant: { kind: 'vp', amount: 30 } });
		for (let n = 0; n < 12; n++) {
			const state = await view(host);
			if (state.projection.status === 'finished') break;
			await resolveOffers(host);
			await resolveOffers(guest);
			await runRoomCommand(host, { type: 'forceAdvancePhase' });
		}
		expect((await view(host)).projection.status).toBe('finished');
		await host.reload();
		await expect(host.getByText(/rematch/i).first()).toBeVisible();
		await host.screenshot({
			path: testInfo.outputPath('powers-game-finished.png'),
			fullPage: true
		});
	} finally {
		await hostContext.close();
		await guestContext.close();
	}
});

test('mobile Power draft fits the viewport and remains keyboard accessible', async ({
	browser
}, testInfo) => {
	const hostContext = await browser.newContext({
		viewport: { width: 844, height: 390 },
		reducedMotion: 'reduce'
	});
	const guestContext = await browser.newContext({
		viewport: { width: 844, height: 390 },
		reducedMotion: 'reduce'
	});
	for (const context of [hostContext, guestContext])
		await context.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '"off"::v1');
			localStorage.setItem('asp:visual-quality', '"off"::v1');
		});
	const host = await hostContext.newPage();
	const guest = await guestContext.newPage();
	try {
		await setupNavigationGame(host, guest);
		await host.bringToFront();
		const panel = host.getByTestId('navigation-power-panel');
		await expect(panel).toBeVisible();
		const box = await panel.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.width).toBeLessThanOrEqual(844);
		expect(box!.height).toBeLessThanOrEqual(390);
		await expect(panel.locator('button')).toHaveCount(3);
		await panel.locator('button').first().focus();
		await host.keyboard.press('Shift+Tab');
		await expect(panel.locator('button').last()).toBeFocused();
		await host.screenshot({
			path: testInfo.outputPath('navigation-powers-mobile.png'),
			fullPage: true
		});
		await panel.locator('button').first().click();
		await expect(panel).toBeHidden();
	} finally {
		await hostContext.close();
		await guestContext.close();
	}
});
