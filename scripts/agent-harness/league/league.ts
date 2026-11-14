/**
 * The league: agents always play Arc Spirits in the background on the current game data, learn
 * between games and keep `<dir>/report.md` up to date (src/lib/play/agents/league/).
 *
 *   npx tsx scripts/agent-harness/league/league.ts --dir ~/arcspirits-harness/league
 *   npx tsx scripts/agent-harness/league/league.ts --dir <dir> --init   # league.json + agents, then exit
 *
 * Start it detached with start.sh, read it with status.sh, end it with stop.sh (same folder).
 * SIGHUP (a closed ssh session) is ignored. SIGTERM / SIGINT stop it cleanly: running games are
 * abandoned (kept, marked, played again later), after-game notebook calls get `stopGraceSec`,
 * every file is written atomically.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createAgentsFromStrategies } from '../../../src/lib/play/agents/league/agents';
import {
	DEFAULT_LEAGUE_CONFIG,
	loadLeagueConfig,
	resolvePath,
	type LeagueConfig
} from '../../../src/lib/play/agents/league/config';
import { League } from '../../../src/lib/play/agents/league/league';
import { loadStrategies } from '../../../src/lib/play/agents/strategy';

const HERE = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
	options: {
		dir: { type: 'string', default: join(homedir(), 'arcspirits-harness', 'league') },
		init: { type: 'boolean', default: false }
	}
});

const tokenFile = (suffix: string) =>
	`~/.local/share/arcspirits-agent-gateway${suffix}/home/.omp/auth-gateway.token`;

/** The first league.json: the three accounts of this laptop, 32 games in flight in all. */
const INITIAL: Partial<LeagueConfig> = {
	...DEFAULT_LEAGUE_CONFIG,
	maxGames: 32,
	gateways: [
		{ label: 'berkeley', url: 'http://127.0.0.1:4610/v1', tokenFile: tokenFile(''), games: 11 },
		{ label: 'gmail', url: 'http://127.0.0.1:4611/v1', tokenFile: tokenFile('-gmail'), games: 11 },
		{ label: 'simforge', url: 'http://127.0.0.1:4612/v1', tokenFile: tokenFile('-simforge'), games: 10 }
	]
};

async function main(): Promise<void> {
	const dir = resolvePath(process.cwd(), values.dir!);
	if (values.init) {
		mkdirSync(dir, { recursive: true });
		const configPath = join(dir, 'league.json');
		if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify(INITIAL, null, '\t')}\n`);
		const config = loadLeagueConfig(dir);
		const made = createAgentsFromStrategies(
			config.agentsDir,
			loadStrategies(resolve(HERE, '..', 'strategies.json'))
		);
		console.log(`league ready in ${dir}; new agents: ${made.join(', ') || 'none'}`);
		return;
	}
	const league = new League({ dir, config: loadLeagueConfig(dir) });
	for (const signal of ['SIGTERM', 'SIGINT'] as const)
		process.on(signal, () => league.stop(`stopped by ${signal}`));
	// A closed ssh session sends SIGHUP; Node resets nohup's "ignore" at start, so ignore it here.
	process.on('SIGHUP', () => console.log(`${new Date().toISOString()} SIGHUP ignored`));
	const state = await league.run();
	process.exit(state === 'error' ? 1 : 0);
}

main().catch((err) => {
	console.error(`error: ${(err as Error).message}`);
	process.exit(1);
});
