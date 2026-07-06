/**
 * In-process 4-bot game wall-clock bench — the M0e headline number. Mirrors
 * bench/bot-game.mjs (which drives the SAME game over HTTP via /bots/tick) but runs the
 * real RoomHost tick loop entirely in memory: no per-command Supabase write, no network.
 * Reuses bench/bot-game.mjs's completion criteria (run until status !== 'active';
 * VP_TO_WIN=30 / MAX_ROUNDS=30) so the two numbers are comparable.
 *
 * Run: npx tsx server/botGameBench.ts [--nav=2000] [--seconds=180]
 * Baseline (bench/results/2026-07-06-bot-game.json, prod HTTP): 695.2s full game.
 */

import { createLobbyState, applyGameCommand } from '../src/lib/play/runtime';
import { SEAT_COLORS } from '../src/lib/play/types';
import type { GameActor, GameCommand, PublicGameState, SeatColor } from '../src/lib/play/types';
import { loadEnv } from './env';
import { loadCatalog } from './catalog';
import { stampPhaseDeadline } from './deadline';
import { getNeuralPolicy } from './bots';
import { RoomHost } from './roomHost';

loadEnv();

const argv = process.argv.slice(2);
const argNum = (name: string, dflt: number): number => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? Number(hit.split('=')[1]) : dflt;
};
const NAV_MS = argNum('nav', 2000);
const CAP_SECONDS = argNum('seconds', 180);
const BASELINE_SECONDS = 695.2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const catalog = await loadCatalog();
	const guardianNames = catalog.guardians.map((g) => g.name);

	// Build a 4-bot ACTIVE game in memory (seat 0 hosts, all four are bots).
	let state: PublicGameState = createLobbyState({ roomCode: 'BENCH', guardianNames });
	const seats = SEAT_COLORS.slice(0, 4);
	const botMembers = new Map<string, string | null>();
	seats.forEach((_, i) => botMembers.set(`bot-${i}`, 'neural'));

	for (let i = 0; i < seats.length; i += 1) {
		const actor: GameActor = {
			memberId: `bot-${i}`,
			displayName: 'Nameless Spirit',
			role: i === 0 ? 'host' : 'player',
			seatColor: null
		};
		for (const command of [
			{ type: 'claimSeat', seatColor: seats[i] },
			{ type: 'selectGuardian', guardianName: guardianNames[i] }
		] as GameCommand[]) {
			const r = applyGameCommand(state, actor, command, catalog);
			if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
			state = r.state;
		}
	}
	state.navigationDurationMs = NAV_MS;
	{
		const host: GameActor = {
			memberId: 'bot-0',
			displayName: 'Nameless Spirit',
			role: 'host',
			seatColor: null
		};
		const r = applyGameCommand(state, host, { type: 'startGame' }, catalog);
		if (!r.ok) throw new Error(`startGame: ${r.error.message}`);
		state = r.state;
	}
	stampPhaseDeadline(state);

	const policy = await getNeuralPolicy();
	console.log(
		`[bot-game:in-process] 4 bots, navMs=${NAV_MS}, policy=${policy ? 'neural' : 'uniform-fallback'} — running to completion (cap ${CAP_SECONDS}s)`
	);

	const host = RoomHost.forBench(state, catalog, botMembers);
	const t0 = performance.now();
	const cap = t0 + CAP_SECONDS * 1000;
	let ticks = 0;
	let tickComputeMs = 0;
	let maxRound = host.getState().round;

	// Drive the REAL tick loop back-to-back (interval=0, like the baseline). A tick that
	// advances nothing means we're idling on navigation's wall-clock deadline — yield briefly
	// so real time passes without a busy-spin.
	while (host.getStatus() === 'active' && performance.now() < cap) {
		const tc = performance.now();
		const advanced = await host.runTick();
		tickComputeMs += performance.now() - tc;
		ticks += 1;
		maxRound = Math.max(maxRound, host.getState().round);
		if (ticks % 100 === 0) {
			console.log(`  tick ${ticks}: round=${maxRound} phase=${host.getState().phase}`);
		}
		if (!advanced) await sleep(4);
	}

	const elapsed = (performance.now() - t0) / 1000;
	const finished = host.getStatus() === 'finished';
	const speedup = finished ? BASELINE_SECONDS / elapsed : null;

	console.log('\n── in-process 4-bot game ──');
	console.log(`status=${host.getStatus()} round=${maxRound} ticks=${ticks}`);
	console.log(
		`per-tick compute (deadline+bots): mean=${(tickComputeMs / ticks).toFixed(2)}ms  (HTTP baseline p50=1557ms)`
	);
	console.log(`wall-clock=${elapsed.toFixed(1)}s   (HTTP baseline ${BASELINE_SECONDS}s)`);
	if (speedup != null) console.log(`SPEEDUP=${speedup.toFixed(1)}x  (target >=5x)`);
	else console.log(`did NOT finish within ${CAP_SECONDS}s cap`);

	process.exit(finished ? 0 : 1);
}

main().catch((err) => {
	console.error('bench error:', err);
	process.exit(1);
});
