import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ensureGuestIdentity, getRoomView, runRoomCommand } from './helpers';
import { regionCatalog } from '../src/lib/play/regionRules';
import { buildLocationInteractions } from '../src/lib/play/locationInteractions';

const catalog = regionCatalog(
	JSON.parse(readFileSync(new URL('../ml/catalog.json', import.meta.url), 'utf8'))
);
const regions = ['Forest Region', 'Mountain Region', 'Water Region', 'Fire Region'];
// Seed only the isolated emulator's asset tables. Use legacy names/rows to
// exercise the same compatibility path as the production content database.
test.beforeAll(async () => {
	const raw = JSON.parse(readFileSync(new URL('../ml/catalog.json', import.meta.url), 'utf8'));
	const oldNames: Record<string, string> = {
		'Forest Region': 'Floral Patch',
		'Mountain Region': 'Cyber City',
		'Water Region': 'Tidal Cove',
		'Fire Region': 'Lantern Canyon'
	};
	const locations: any[] = [],
		rows: any[] = [],
		assignments: any[] = [];
	for (const [index, loc] of raw.locations.entries()) {
		const id = `region-test-${index}`;
		locations.push({
			id,
			name: oldNames[loc.name] ?? loc.name,
			origin_id: loc.originId,
			background_image_path: null
		});
		for (const [slot, config] of loc.rewardRows.entries()) {
			const rowId = `${id}-${slot}`;
			rows.push({ id: rowId, config });
			assignments.push({ id: `${rowId}-a`, location_id: id, row_id: rowId, row_index: slot });
		}
	}
	for (const [table, data] of [
		['game_locations', locations],
		['game_location_rows', rows],
		['reward_row_assignments', assignments]
	] as const) {
		const response = await fetch(`http://127.0.0.1:8941/rest/v1/${table}?on_conflict=id`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-profile': 'arc_spirits_assets',
				prefer: 'resolution=merge-duplicates'
			},
			body: JSON.stringify(data)
		});
		if (!response.ok) throw new Error(`Local asset seed failed: ${table}`);
	}
});

for (const region of regions) {
	test(`${region} exposes exactly two working actions`, async ({ page }, testInfo) => {
		if (region === 'Fire Region') await page.setViewportSize({ width: 844, height: 390 });
		await page.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '\"off\"::v1');
			localStorage.setItem('asp:visual-quality', '\"off\"::v1');
		});
		await page.goto('/play?e2e=1&ws=off');
		await page.getByTestId('solo-play').click();
		await page.waitForURL(/\/play\/[A-Z0-9]+/);
		await expect(page.getByTestId('navigation-power-draft')).toBeVisible();
		await page.getByTestId('navigation-power-draft').locator('button').first().click();
		await expect(page.getByTestId('navigation-power-draft')).toHaveCount(0);
		for (let n = 0; n < 3; n++)
			await runRoomCommand(page, {
				type: 'debugGrant',
				grant: { kind: 'rune', runeId: '356f3ad2-4cac-4b69-a3cc-7559f8891d8e' }
			});
		await page.getByTestId(`location-${region}`).dispatchEvent('click');
		await page.getByRole('button', { name: 'No Power — lock destination' }).click();
		await expect.poll(async () => (await getRoomView(page)).projection.phase).toBe('location');
		await expect(page.getByTestId('interaction-grid').locator('.int-card')).toHaveCount(2);
		const state = async () => {
			const v: any = await getRoomView(page);
			return v.projection.players[v.member.seatColor];
		};
		const payArmedRune = async () => {
			const rack = page.getByTestId('armed-cost-pick');
			if (await rack.isVisible()) await rack.getByRole('button').first().click();
		};

		const placeAugments = async () => {
			for (let n = 0; n < 8; n++) {
				const pending = (await state()).unplacedAugments.length;
				if (!pending) return;
				await page
					.getByRole('button', { name: /^Place augment on / })
					.first()
					.dispatchEvent('click');
				await expect
					.poll(async () => (await state()).unplacedAugments.length)
					.toBeLessThan(pending);
			}
			throw new Error('Augment placement did not finish');
		};
		await page.screenshot({ path: testInfo.outputPath('two-actions.png'), fullPage: true });

		if (region === 'Forest Region' || region === 'Fire Region') {
			await page.getByTestId('interaction-0').click();
			await expect
				.poll(
					async () =>
						(await state()).actionsUsedThisRound.filter((x: string) => x === 'row:0').length
				)
				.toBe(1);
		} else if (region === 'Water Region') {
			await page.getByTestId('interaction-0').click();
			await expect(page.getByTestId('draw-tray')).toBeVisible();
			await page.getByTestId('draw-discard').click();
			await expect(page.getByTestId('draw-tray')).toHaveCount(0);
		} else {
			await page.getByTestId('interaction-0').click();
			await expect(page.getByTestId('armed-choice-0-0')).toContainText('Elementalist');
			await page.getByTestId('armed-choice-0-0').click();
			await payArmedRune();
			await page.getByTestId('armed-confirm').click();
			await expect.poll(async () => (await state()).unplacedAugments.length).toBeGreaterThan(0);
			await placeAugments();
		}
		const before = await state();
		await page.getByTestId('interaction-1').click();
		if (region === 'Forest Region') {
			await expect
				.poll(async () => (await state()).powerInventory.length)
				.toBe(before.powerInventory.length + 1);
			await expect(page.getByTestId('navigation-power-draft')).toHaveCount(0);
			expect((await state()).pendingPowerDrafts).toEqual([]);
		} else if (region === 'Mountain Region') {
			await expect(page.getByTestId('navigation-power-draft').locator('button')).toHaveCount(3);
			await page.getByTestId('power-to-replace').selectOption(before.powerInventory[0]);
			await page.getByTestId('navigation-power-draft').locator('button').first().click();
			await expect(page.getByTestId('navigation-power-draft')).toHaveCount(0);
			expect((await state()).powerInventory).toHaveLength(before.powerInventory.length);
			expect((await state()).powerInventory).not.toContain(before.powerInventory[0]);
		} else if (region === 'Water Region') {
			await expect(page.getByTestId('armed-choice-0-0')).toContainText('Fighter');
			await expect(page.getByTestId('armed-choice-0-1')).toContainText('Cultivator');
			await expect(page.getByTestId('armed-choice-0-2')).toContainText('Spirit Animal');
			await page.getByTestId('armed-choice-0-0').click();
			await payArmedRune();
			await page.getByTestId('armed-confirm').click();
			await expect
				.poll(async () => (await state()).unplacedAugments.length)
				.toBe(before.unplacedAugments.length + 1);
			await expect(page.getByTestId('gain-navigation-power')).toHaveCount(0);
		} else {
			await expect
				.poll(
					async () =>
						(await page.getByTestId('armed-confirm').isVisible()) ||
						(await state()).unplacedAugments.length > before.unplacedAugments.length
				)
				.toBe(true);
			if (await page.getByTestId('armed-confirm').isVisible()) {
				await payArmedRune();
				await page.getByTestId('armed-confirm').click();
			}
			await expect
				.poll(async () => (await state()).unplacedAugments.length)
				.toBe(before.unplacedAugments.length + 1);
			await expect(page.getByTestId('gain-navigation-power')).toHaveCount(0);
		}
		await page.screenshot({ path: testInfo.outputPath('two-actions.png'), fullPage: true });
	});
}
