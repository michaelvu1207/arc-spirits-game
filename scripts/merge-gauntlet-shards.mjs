#!/usr/bin/env node
/**
 * Merge sharded gauntlet results (GAUNTLET_SHARD runs of _gauntlet.test.ts)
 * into the standard single result JSON.
 *
 *   node scripts/merge-gauntlet-shards.mjs --out ml/gauntlet_results/<slug>.json shard-*.json
 *
 * Verifies: same gauntletVersion + candidate ref across shards, no missing or
 * duplicate shard indices, and total games == 800 (else the merged file keeps
 * smoke: true). The math is identical to the serial runner's: Elo from summed
 * Laplace-smoothed pairwise scores (manifest.ts eloFromScore inlined — keep in
 * sync with any manifest change, which would bump the gauntlet version anyway).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
if (outIdx === -1 || args.length < outIdx + 2) {
	console.error('usage: merge-gauntlet-shards.mjs --out <merged.json> <shard.json...>');
	process.exit(1);
}
const outPath = args[outIdx + 1];
const shardPaths = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);
if (shardPaths.length === 0) {
	console.error('merge-gauntlet-shards: no shard files given');
	process.exit(1);
}

// Same closed-form logistic Elo as manifest.ts (Laplace-smoothed).
const eloFromScore = (scoreSum, games) => {
	const s = (scoreSum + 0.5) / (games + 1);
	return Math.round(-400 * Math.log10(1 / s - 1));
};

const shards = shardPaths.map((p) => ({ path: p, d: JSON.parse(readFileSync(p, 'utf8')) }));
const first = shards[0].d;
const seen = new Set();
let shardN = null;
for (const { path, d } of shards) {
	if (!d.raw) throw new Error(`${path}: no raw tally block (old runner?)`);
	if (d.gauntletVersion !== first.gauntletVersion)
		throw new Error(`${path}: gauntletVersion mismatch`);
	if (d.candidate.ref !== first.candidate.ref) throw new Error(`${path}: candidate mismatch`);
	if (d.shard) {
		const [k, n] = d.shard.split('/').map(Number);
		shardN = shardN ?? n;
		if (n !== shardN) throw new Error(`${path}: shard divisor mismatch`);
		if (seen.has(k)) throw new Error(`${path}: duplicate shard ${k}`);
		seen.add(k);
	}
}
if (shardN !== null && seen.size !== shardN) {
	throw new Error(`missing shards: have ${[...seen].sort((a, b) => a - b)}, expected 0..${shardN - 1}`);
}

const sum = (f) => shards.reduce((a, { d }) => a + f(d), 0);
const n = sum((d) => d.games);
const raw = {
	wins: sum((d) => d.raw.wins),
	sumPlace: sum((d) => d.raw.sumPlace),
	sumVP: sum((d) => d.raw.sumVP),
	sumRounds: sum((d) => d.raw.sumRounds),
	finished: sum((d) => d.raw.finished),
	agg: {
		games: sum((d) => d.raw.agg.games),
		scoreSum: sum((d) => d.raw.agg.scoreSum)
	},
	perAnchor: {}
};
for (const { d } of shards) {
	for (const [name, t] of Object.entries(d.raw.perAnchor)) {
		const cur = (raw.perAnchor[name] ??= { games: 0, scoreSum: 0 });
		cur.games += t.games;
		cur.scoreSum += t.scoreSum;
	}
}

const perAnchorOut = {};
for (const name of Object.keys(raw.perAnchor).sort()) {
	const t = raw.perAnchor[name];
	perAnchorOut[name] = {
		games: t.games,
		score: t.scoreSum / t.games,
		elo: eloFromScore(t.scoreSum, t.games)
	};
}
const wallClockMs = Math.max(...shards.map(({ d }) => d.wallClockMs)); // parallel: slowest shard
const result = {
	gauntletVersion: first.gauntletVersion,
	candidate: first.candidate,
	via: first.via,
	policyObsVersion: first.policyObsVersion,
	games: n,
	smoke: n < 800,
	mergedFromShards: shards.length,
	raw,
	eloVsAnchors: {
		aggregate: {
			games: raw.agg.games,
			score: raw.agg.scoreSum / raw.agg.games,
			elo: eloFromScore(raw.agg.scoreSum, raw.agg.games)
		},
		perAnchor: perAnchorOut
	},
	meanPlacement: raw.sumPlace / n,
	winRate: raw.wins / n,
	meanVP: raw.sumVP / n,
	meanRounds: raw.sumRounds / n,
	finishedRate: raw.finished / n,
	wallClockMs,
	msPerGame: wallClockMs / n,
	timestamp: new Date().toISOString()
};
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(
	`[merge-gauntlet] ${first.candidate.ref}: elo=${result.eloVsAnchors.aggregate.elo} ` +
		`place=${result.meanPlacement.toFixed(2)} win=${(100 * result.winRate).toFixed(1)}% ` +
		`vp=${result.meanVP.toFixed(1)} games=${n} shards=${shards.length}${result.smoke ? ' (SMOKE)' : ''}`
);
console.log(`[merge-gauntlet] DONE → ${outPath}`);
