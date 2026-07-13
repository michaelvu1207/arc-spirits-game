#!/usr/bin/env node
/**
 * League-manager CLI (src/lib/play/ml/league/manager.ts).
 *
 *   node scripts/run-league.mjs init   [--root ml/league]
 *   node scripts/run-league.mjs status [--root ml/league]
 *   node scripts/run-league.mjs state  [--root ml/league]     # raw state.json dump
 *   node scripts/run-league.mjs run    [--root ml/league] [--gens 1]
 *
 * init writes <root>/config.json (edit it by hand — lanes, gamesPerGen, PFSP,
 * promotion cadence) and a seeded state.json (8 heuristic anchors + the active
 * frozen checkpoint anchors + the configured learner lanes). run executes N
 * generations, resuming from persisted state; every phase is crash-safe.
 *
 * Runs under plain node: the TS manager is loaded via jiti (no tsx in this repo),
 * mirroring scripts/run-actor-pool.mjs.
 */
import { createJiti } from 'jiti';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root); // manager + trainer + gauntlet all resolve against the repo root

const { values: args, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		root: { type: 'string', default: 'ml/league' },
		gens: { type: 'string', default: '1' },
		help: { type: 'boolean', default: false }
	}
});

const cmd = positionals[0];
if (args.help || !cmd || !['init', 'status', 'state', 'run'].includes(cmd)) {
	console.log(
		'usage: node scripts/run-league.mjs <init|status|state|run> [--root ml/league] [--gens N]'
	);
	process.exit(cmd || args.help ? 0 : 1);
}

const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const manager = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'league', 'manager.ts')
);

const leagueRoot = args.root;

if (cmd === 'init') {
	const { config, state, created } = manager.initLeague(leagueRoot);
	console.log(
		created
			? `initialized league at ${leagueRoot}: ${state.members.length} members, ` +
					`lanes main=${config.lanes.main} mainExploiter=${config.lanes.mainExploiter} ` +
					`leagueExploiter=${config.lanes.leagueExploiter}`
			: `league already initialized at ${leagueRoot} (gen ${state.gen}) — left untouched`
	);
} else if (cmd === 'status') {
	const s = manager.leagueStatus(leagueRoot);
	console.log(`gen ${s.gen}  phase ${s.phase}`);
	for (const m of s.members) {
		const elo = m.eloVsAnchors !== undefined ? `  elo=${m.eloVsAnchors}` : '';
		const ckpt = m.ckpt ? `  ${m.ckpt}` : '';
		const model = m.model === 'v2' ? '  [v2]' : '';
		console.log(`  ${m.kind.padEnd(16)} ${m.id.padEnd(28)} games=${m.games}${model}${elo}${ckpt}`);
	}
	for (const l of s.lastLines) {
		const reach30 =
			l.evalReach30Rate === undefined
				? ''
				: ` reach30=${(100 * l.evalReach30Rate).toFixed(0)}% meanVP=${(l.evalMeanVP ?? 0).toFixed(1)}`;
		console.log(
			`  [gen ${l.gen}] ${l.lane}: games=${l.games} samples=${l.samples} ` +
				`evalWin=${(100 * l.evalWinRate).toFixed(0)}% eloEst=${l.eloEstimate} ` +
				`pool=${(l.poolWallMs / 1000).toFixed(1)}s train=${(l.trainMs / 1000).toFixed(1)}s ` +
				`promoted=${l.promoted}${reach30}`
		);
	}
} else if (cmd === 'state') {
	console.log(readFileSync(path.join(leagueRoot, 'state.json'), 'utf8'));
} else if (cmd === 'run') {
	const n = parseInt(args.gens, 10);
	const reports = await manager.runGenerations(leagueRoot, n);
	for (const rep of reports) {
		for (const l of rep.lanes) {
			const reach30 =
				l.evalReach30Rate === undefined
					? ''
					: ` reach30=${(100 * l.evalReach30Rate).toFixed(0)}% meanVP=${(l.evalMeanVP ?? 0).toFixed(1)}`;
			console.log(
				`[gen ${rep.gen}] ${l.lane}: games=${l.games} samples=${l.samples} ` +
					`evalWin=${(100 * l.evalWinRate).toFixed(0)}% eloEst=${l.eloEstimate} ` +
					`pool=${(l.poolWallMs / 1000).toFixed(1)}s train=${(l.trainMs / 1000).toFixed(1)}s ` +
					`eval=${(l.evalMs / 1000).toFixed(1)}s promoted=${l.promoted}` +
					(l.gauntletElo !== undefined ? ` gauntletElo=${l.gauntletElo}` : '') +
					reach30
			);
		}
	}
}
