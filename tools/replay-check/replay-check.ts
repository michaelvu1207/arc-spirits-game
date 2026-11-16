// Replays recorded games with the CURRENT engine and compares the final state with the recorded
// one. It proves an engine change leaves the old rules, and so old records, untouched: every new
// rule must be a switch that is off by default (src/lib/play/rules.ts).
//
//   npm run replay-check
//
// games/ holds 48 finished games of 2026-11 (only what a replay needs: seed, seats and the
// chosen action of every decision). catalogs/ holds the two game catalogs they were played on.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogHash } from '../../src/lib/play/agents/catalog';
import { replayTranscript } from '../../src/lib/play/agents/transcript';
import type { PlayCatalog } from '../../src/lib/play/types';

const here = dirname(fileURLToPath(import.meta.url));
const catalogs = new Map<string, PlayCatalog>();
for (const dir of readdirSync(join(here, 'catalogs'))) {
	const catalog = JSON.parse(readFileSync(join(here, 'catalogs', dir, 'play-catalog.json'), 'utf8')) as PlayCatalog;
	catalogs.set(catalogHash(catalog), catalog);
}
let ok = 0;
let bad = 0;
for (const file of readdirSync(join(here, 'games')).sort()) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const records: any[] = readFileSync(join(here, 'games', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const catalog = catalogs.get(records[0].catalog.hash);
	try {
		if (!catalog) throw new Error(`catalog ${records[0].catalog.hash.slice(0, 12)} is not in catalogs/`);
		const out = replayTranscript(records, catalog);
		if (out.matches) ok++;
		else {
			bad++;
			console.log('MISMATCH', file, out.finalStateHash, 'recorded', out.recordedHash);
		}
	} catch (e) {
		bad++;
		console.log('ERROR', file, String((e as Error)?.message ?? e).slice(0, 200));
	}
}
console.log(JSON.stringify({ ok, bad }));
process.exit(bad ? 1 : 0);
