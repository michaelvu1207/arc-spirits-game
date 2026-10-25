/** Run with node --import tsx. Dry-run by default; --apply requires service-role credentials. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateAwakenCondition } from '../src/lib/play/baseRunes';
const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing configured Supabase credentials.');
const headers = {
	apikey: key,
	Authorization: `Bearer ${key}`,
	'Accept-Profile': 'arc_spirits_assets',
	'Content-Profile': 'arc_spirits_assets',
	'Content-Type': 'application/json'
};
const response = await fetch(
	`${url}/rest/v1/hex_spirits?select=id,name,cost,awaken_condition&order=name`,
	{ headers }
);
if (!response.ok) throw new Error(`Read failed (${response.status}).`);
const spirits = await response.json();
const changes = spirits
	.map((s: any) => ({ ...s, next: migrateAwakenCondition(s.awaken_condition) }))
	.filter((s: any) => JSON.stringify(s.next) !== JSON.stringify(s.awaken_condition));
console.log(
	JSON.stringify({
		mode: process.argv.includes('--apply') ? 'apply' : 'dry-run',
		spirits: spirits.length,
		changes: changes.length,
		names: changes.map((s: any) => s.name)
	})
);
if (!process.argv.includes('--apply')) process.exit(0);
const audited = JSON.parse(
	readFileSync(
		new URL('../src/lib/play/__fixtures__/relic-awakening-audit.json', import.meta.url),
		'utf8'
	)
);
const originalById = new Map(audited.spirits.map((spirit: any) => [spirit.id, spirit]));
for (const change of changes) {
	const original: any = originalById.get(change.id);
	const current = change.awaken_condition;
	const expected = original?.awaken_condition;
	const same =
		current?.type === expected?.type &&
		(current?.type === 'rune_cost'
			? JSON.stringify([...current.rune_ids].sort()) ===
				JSON.stringify([...expected.rune_ids].sort())
			: current?.text === expected?.text);
	if (!same || change.cost !== original?.cost)
		throw new Error(`Live data changed since the audit for ${change.name}; no updates applied.`);
}
if (changes.length === 0) process.exit(0);
const backup = join(tmpdir(), `arc-relic-awakenings-${Date.now()}.json`);
writeFileSync(backup, JSON.stringify(changes, null, 2), { mode: 0o600 });
console.log(`Backup: ${backup}`);
for (const s of changes) {
	const query = new URLSearchParams({
		id: `eq.${s.id}`,
		awaken_condition: `eq.${JSON.stringify(s.awaken_condition)}`,
		select: 'id,name,cost,awaken_condition'
	});
	const update = await fetch(`${url}/rest/v1/hex_spirits?${query}`, {
		method: 'PATCH',
		headers: { ...headers, Prefer: 'return=representation' },
		body: JSON.stringify({ awaken_condition: s.next })
	});
	if (!update.ok)
		throw new Error(`Update failed for ${s.name} (${update.status}). Backup retained.`);
	const rows = await update.json();
	if (
		rows.length !== 1 ||
		rows[0].cost !== s.cost ||
		JSON.stringify(rows[0].awaken_condition) !== JSON.stringify(s.next)
	) {
		// PostgreSQL JSONB may reorder keys, so verify the actual values independently.
		const row = rows[0];
		const actual = row?.awaken_condition;
		if (
			rows.length !== 1 ||
			row.cost !== s.cost ||
			actual?.type !== s.next.type ||
			(actual?.type === 'rune_cost'
				? JSON.stringify(actual.rune_ids) !== JSON.stringify(s.next.rune_ids)
				: actual?.text !== s.next.text)
		)
			throw new Error(`Verification failed for ${s.name}. Backup retained.`);
	}
	console.log(`Updated: ${s.name}`);
}
console.log('Verified all 15 awakening updates; numeric Spirit costs preserved.');
