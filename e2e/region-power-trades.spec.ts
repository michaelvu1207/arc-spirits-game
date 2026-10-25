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
	test(`${region} map trade resolves a paid Power draft`, async ({ page }, testInfo) => {
		if (region === 'Fire Region') await page.setViewportSize({ width: 844, height: 390 });
		await page.goto('/play?e2e=1&ws=off');
		await expect(async () => {
			await ensureGuestIdentity(page, 'Region Explorer');
		}).toPass({ timeout: 30_000 });
		await page.getByTestId('solo-play').click();
		await page.waitForURL(/\/play\/[A-Z0-9]+/);
		await expect(page.getByTestId('navigation-power-draft')).toBeVisible();
		await page.getByTestId('navigation-power-draft').locator('button').first().click();
		await expect(page.getByTestId('navigation-power-draft')).toHaveCount(0);
		for (const name of regions) await expect(page.getByTestId(`location-${name}`)).toBeVisible();
		await expect(page.locator('body')).not.toContainText(
			/Floral Patch|Cyber City|Tidal Cove|Lantern Canyon/
		);
		await runRoomCommand(page, {
			type: 'debugGrant',
			grant: { kind: 'rune', runeId: '356f3ad2-4cac-4b69-a3cc-7559f8891d8e' }
		});
		const before: any = await getRoomView(page);
		const seat = before.member.seatColor;
		const oldPowers: string[] = before.projection.players[seat].powerInventory;
		const runes = before.projection.players[seat].mats.filter((m: any) => m.hasRune).length;
		await page.getByTestId(`location-${region}`).dispatchEvent('click');
		await page.getByRole('button', { name: 'No Power — lock destination' }).click();
		await expect.poll(async () => (await getRoomView(page)).projection.phase).toBe('location');
		await expect(page.getByTestId('gain-navigation-power')).toHaveText(
			region === 'Fire Region' ? 'Replace a Power' : 'Gain a Power'
		);
		const loc = catalog.locations.find((l: any) => l.name === region);
		const row = buildLocationInteractions(loc.rewardRows, region).find((i) =>
			i.gains.some((g) => g.type === 'navigationPower')
		)!;
		const trade = page.getByTestId(`interaction-${row.rowIndex}`);
		await expect(trade).toBeVisible();
		await expect(trade).toContainText(
			region === 'Fire Region' ? 'Replace a Power' : 'Gain a Power'
		);
		await trade.click();
		await expect(page.getByTestId('navigation-power-draft').locator('button')).toHaveCount(3);
		if (region === 'Fire Region') {
			await expect(page.getByTestId('power-to-replace')).toBeVisible();
			await page.getByTestId('power-to-replace').selectOption(oldPowers[0]);
		}
		await page.screenshot({ path: testInfo.outputPath('power-trade.png'), fullPage: true });
		await page.getByTestId('navigation-power-draft').locator('button').first().click();
		await expect(page.getByTestId('navigation-power-draft')).toHaveCount(0);
		const after: any = await getRoomView(page);
		const p = after.projection.players[seat];
		expect(p.mats.filter((m: any) => m.hasRune)).toHaveLength(runes - 1);
		expect(p.powerInventory).toHaveLength(oldPowers.length + (region === 'Fire Region' ? 0 : 1));
		if (region === 'Fire Region') expect(p.powerInventory).not.toContain(oldPowers[0]);
		await expect(page.getByTestId('pass-turn')).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('trade-complete.png'), fullPage: true });
		await page.getByTestId('pass-turn').click();
		await expect.poll(async () => (await getRoomView(page)).projection.round).toBe(2);
	});
}
