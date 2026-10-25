import { defineConfig } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import base from './playwright.navigation.config';
import { normalizeAwaken } from './src/lib/play/awakenConditions';
const fixture = JSON.parse(
	readFileSync('src/lib/play/__fixtures__/relic-awakening-audit.json', 'utf8')
);
const catalog = JSON.parse(readFileSync('ml/catalog.json', 'utf8'));
const lookup = new Map<string, any>(
	fixture.mats.map((m: any) => [m.id, { name: m.name, kind: m.origin_id ? 'rune' : 'relic' }])
);
catalog.spirits = fixture.spirits.map((s: any) => ({
	id: s.id,
	name: s.name,
	cost: s.cost,
	classes: {},
	origins: {},
	awaken: normalizeAwaken(s.awaken_condition, lookup)
}));
const file = join(mkdtempSync(join(tmpdir(), 'arc-relic-ui-')), 'catalog.json');
writeFileSync(file, JSON.stringify(catalog));
export default defineConfig({
	...base,
	testMatch: 'relic-awakenings.spec.ts',
	timeout: 120_000,
	webServer: {
		...base.webServer,
		command: `ARC_PLATFORM_CATALOG_FILE=${file} ARC_PLATFORM_STORE_PORT=8941 ARC_PLATFORM_APP_PORT=4181 node scripts/platform-stack.mjs`
	}
});
