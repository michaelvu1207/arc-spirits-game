import { test, expect } from '@playwright/test';
import { getRoomView, runRoomCommand } from './helpers';
const FIRE = '480cd5f7-adea-481d-8ea9-aad776599d7b',
	WATER = '5eba8681-16b8-4563-b017-22c80a84b35b',
	FOREST = '34b2a963-f8c6-4fc0-8272-ddc50b0036a8';
for (const sample of [
	{
		name: 'Ashveil, the Rekindled Blade',
		id: '25848694-6c69-408c-9b78-94948c6df3a6',
		runes: [FIRE, FIRE],
		text: 'Fire Rune',
		picks: []
	},
	{
		name: 'Aureate Runeweaver',
		id: 'ed612933-fd19-4b68-993e-6e61b52eb4ce',
		runes: [FIRE, WATER, FOREST],
		text: 'Any Rune',
		picks: ['Fire Rune', 'Water Rune']
	},
	{
		name: 'The Solar Reliquarian',
		id: '5dc44c85-8224-4c49-89ff-90a37aa10040',
		runes: [FIRE, WATER],
		text: 'different types',
		picks: ['Fire Rune', 'Water Rune']
	}
])
	test(`${sample.name} awakens with base Runes`, async ({ page }, testInfo) => {
		if (sample.name === 'The Solar Reliquarian')
			await page.setViewportSize({ width: 844, height: 390 });
		await page.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '"off"::v1');
			localStorage.setItem('asp:visual-quality', '"off"::v1');
		});
		await page.goto('/play?e2e=1&ws=off');
		await page.getByTestId('solo-play').click();
		await page.waitForURL(/\/play\/[A-Z0-9]+/);
		await expect(page.getByTestId('navigation-power-draft')).toBeVisible();
		await page.getByTestId('navigation-power-draft').locator('button').first().click();
		await expect(page.getByTestId('navigation-power-draft')).toHaveCount(0);
		await runRoomCommand(page, {
			type: 'debugGrant',
			grant: { kind: 'spirit', spiritId: sample.id, faceDown: true }
		});
		for (const runeId of sample.runes)
			await runRoomCommand(page, { type: 'debugGrant', grant: { kind: 'rune', runeId } });
		const state = async () => {
			const v: any = await getRoomView(page);
			return v;
		};
		let view = await state();
		const seat = view.member.seatColor;
		const slot = view.projection.players[seat].spirits.find(
			(s: any) => s.id === sample.id
		).slotIndex;
		await runRoomCommand(page, { type: 'lockNavigation', destination: 'Forest Region' });
		for (let n = 0; n < 7; n++) {
			view = await state();
			if (view.projection.phase === 'awakening') break;
			await runRoomCommand(page, { type: 'forceAdvancePhase' });
		}
		expect((await state()).projection.phase).toBe('awakening');
		const offer = page.getByTestId(`awaken-${slot}`);
		await expect(offer).toBeVisible();
		await expect(offer).toContainText(sample.text);
		await page.screenshot({ path: testInfo.outputPath('rune-awakening.png'), fullPage: true });
		await offer.click();
		if (sample.picks.length) {
			await expect(page.getByTestId('awaken-discard-pick')).toBeVisible();
			for (const name of sample.picks)
				await page.getByRole('button', { name: new RegExp(name) }).click();
			await page.getByTestId('awaken-discard-confirm').click();
		}
		await expect
			.poll(
				async () =>
					(await state()).projection.players[seat].spirits.find((s: any) => s.id === sample.id)
						.isFaceDown
			)
			.toBe(false);
		const after = (await state()).projection.players[seat];
		expect(after.mats.filter((m: any) => m.hasRune && m.type === 'rune')).toHaveLength(
			sample.runes.length - 2
		);
		expect(after.mats.filter((m: any) => m.hasRune && m.name === 'Fairy Relic')).toHaveLength(2);
	});
