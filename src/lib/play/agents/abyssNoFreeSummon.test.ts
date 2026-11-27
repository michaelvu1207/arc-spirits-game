/**
 * The Arcane Abyss has no free Abyss Summon (Michael, 2026-11-20: "remove the mechanic entirely, you
 * can only get aa summons by killing monsters"). The working tables say so with an empty
 * `reward_rows` on the Arcane Abyss; tables written before that have no such field and keep the
 * frozen catalog's row, so finished test games replay as they were played.
 *
 *   npx vitest run src/lib/play/agents/abyssNoFreeSummon.test.ts
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMonsterRewards } from '../monsterRewards';
import { loadLocalDesignCatalog } from './catalog';
import { interactionsAt } from './labels';
import { buildRulesBrief } from './rulesBrief';

const summons = (catalog: ReturnType<typeof loadLocalDesignCatalog>) =>
	interactionsAt(catalog, 'Arcane Abyss').filter((i) => i.gains.some((g) => g.type === 'action' && g.action === 'abyssSummon'));

describe('Arcane Abyss without the free Abyss Summon', () => {
	const now = loadLocalDesignCatalog('data');

	// Michael brought the action back on 2026-11-27, as a choice: a fight OR the summon (rule `abyssFightOrSummon`,
	// see abyssFightOrSummon.test.ts). An empty `reward_rows` still means "no action", as in the tables of 20 to 26 November.
	it('the working tables give the Arcane Abyss its summon action again', () => {
		expect(summons(now)).toHaveLength(1);
		expect(buildRulesBrief(now)).not.toContain('An Arcane Abyss Summon is ONLY a monster reward');
	});

	it('tables with an empty reward_rows on the Arcane Abyss have no location action there', () => {
		const dir = mkdtempSync(join(tmpdir(), 'arc-empty-rows-'));
		for (const f of readdirSync('data')) if (f.endsWith('.json') && !f.includes('.bak')) cpSync(join('data', f), join(dir, f));
		const rows = JSON.parse(readFileSync(join(dir, 'game_locations.json'), 'utf8')) as Record<string, unknown>[];
		for (const row of rows) if (row.name === 'Arcane Abyss') row.reward_rows = [];
		writeFileSync(join(dir, 'game_locations.json'), JSON.stringify(rows));
		const empty = loadLocalDesignCatalog(dir);
		expect(interactionsAt(empty, 'Arcane Abyss')).toEqual([]);
		expect(buildRulesBrief(empty)).toContain('- Arcane Abyss: no location actions; draw/keep/fight monster cards');
		expect(buildRulesBrief(empty)).toContain('An Arcane Abyss Summon is ONLY a monster reward');
	});

	it('monster cards still pay Abyss Summons', () => {
		const paying = (now.monsters ?? []).filter((m) =>
			buildMonsterRewards(m.rewardTrack).some((o) => o.effect.type === 'action' && o.effect.action === 'abyssSummon')
		);
		// 16 Difficulty 1 cards and the permanent monster since the four-level rework (Michael, 2026-11-21).
		expect(paying.length).toBeGreaterThan(10);
	});

	it('tables without their own reward_rows keep the old free summon', () => {
		const dir = mkdtempSync(join(tmpdir(), 'arc-old-tables-'));
		for (const f of readdirSync('data')) if (f.endsWith('.json') && !f.includes('.bak')) cpSync(join('data', f), join(dir, f));
		const rows = JSON.parse(readFileSync(join(dir, 'game_locations.json'), 'utf8')) as Record<string, unknown>[];
		for (const row of rows) delete row.reward_rows;
		writeFileSync(join(dir, 'game_locations.json'), JSON.stringify(rows));
		const old = loadLocalDesignCatalog(dir);
		expect(summons(old)).toHaveLength(1);
		expect(buildRulesBrief(old)).not.toContain('ONLY a monster reward');
	});
});
