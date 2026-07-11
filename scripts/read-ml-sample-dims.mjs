#!/usr/bin/env node
/** Print "<obs_dim> <act_dim>" from the first valid sample row in a file/directory. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const input = path.resolve(process.argv[2] ?? 'ml/data');
const files = statSync(input).isDirectory()
	? readdirSync(input)
			.filter((name) => name.endsWith('.jsonl') && !name.startsWith('games-'))
			.sort()
			.map((name) => path.join(input, name))
	: [input];

for (const file of files) {
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const obsDim = Array.isArray(row?.obs) ? row.obs.length : 0;
		const actDim = Array.isArray(row?.cands?.[0]) ? row.cands[0].length : 0;
		if (obsDim > 0 && actDim > 0) {
			process.stdout.write(`${obsDim} ${actDim}\n`);
			process.exit(0);
		}
	}
}

throw new Error(`No valid ML sample rows found under ${input}`);
