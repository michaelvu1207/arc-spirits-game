/**
 * Checks a game-data folder before it becomes a package: the engine catalog builds, and random
 * players (no AI model) finish full games on it without an engine error or a stall.
 *
 *   npx tsx scripts/package/validate.ts <data dir> [games]
 *
 * Prints one JSON line: { rulesHash, games, finished, errors, stalls, problems }.
 */
import { loadLocalDesignCatalog } from '../../src/lib/play/agents/catalog';
import { rulesHash } from '../../src/lib/packages/rulesHash';
import { createAgentLobby } from '../../src/lib/play/agents/setup';
import { agentLegalCommands } from '../../src/lib/play/agents/actionSurface';
import { applyDeadlineAdvance, applyGameCommand } from '../../src/lib/play/runtime';
import { botActorFor, botSeatNeedsToAct } from '../../src/lib/play/server/botPolicy';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../../src/lib/play/types';

const [dir, gamesArg] = process.argv.slice(2);
const games = Number(gamesArg ?? 12);
const catalog: PlayCatalog = loadLocalDesignCatalog(dir);
const SEATS: SeatColor[] = ['Red', 'Blue', 'Orange', 'Green'];
let seed = 20261114;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const problems: string[] = [];
let finished = 0;
let errors = 0;
let stalls = 0;

for (let g = 0; g < games; g++) {
	const guardians = catalog.guardians.map((x) => x.name);
	let state: PublicGameState = createAgentLobby(
		catalog,
		7000 + g,
		SEATS.map((seat, i) => ({ seat, guardian: guardians[i] }))
	);
	let decisions = 0;
	let idle = 0;
	try {
		while (state.status === 'active' && decisions < 4000) {
			const needing = SEATS.filter((s) => botSeatNeedsToAct(state, s));
			const prompted = needing.filter((s) => (state.players[s]?.navigationPowerOffers?.length ?? 0) > 0);
			const seat = (prompted.length ? prompted : needing)[0];
			let acted = false;
			if (seat) {
				const { commands } = agentLegalCommands(state, seat, catalog);
				const active = commands.filter((c: GameCommand) => !/Phase$/.test(c.type));
				const pool = active.length && rand() < 0.75 ? active : commands;
				if (pool.length) {
					const result = applyGameCommand(state, botActorFor(state, seat), pick(pool), catalog);
					if (result.ok) {
						state = result.state;
						acted = true;
						decisions++;
					}
				}
			}
			if (!acted) {
				const key = `${state.round}:${state.phase}`;
				applyDeadlineAdvance(state, catalog);
				idle = `${state.round}:${state.phase}` === key ? idle + 1 : 0;
				if (idle >= 3) {
					stalls++;
					problems.push(`game ${g}: stalled in ${key}`);
					break;
				}
			}
		}
		if (state.status !== 'active') finished++;
	} catch (e) {
		errors++;
		problems.push(`game ${g}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
	}
}
console.log(JSON.stringify({ rulesHash: rulesHash(catalog), games, finished, errors, stalls, problems }));
