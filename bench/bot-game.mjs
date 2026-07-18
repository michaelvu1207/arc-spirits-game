// bench 4 — full 4-bot game via today's path.
//
// A bot game is driven by the HOST CLIENT: the web page runs a setInterval that POSTs
// /bots/tick every 1300ms (src/routes/play/[roomCode]/+page.svelte). Each tick advances
// every bot seat that "needs to act" by one phase-step, server-side. There is no browser
// requirement for the tick ITSELF — it's a plain authenticated POST — so we drive it
// headlessly here with the host's member id.
//
// A full 4-bot game CAN be measured headlessly. Phases auto-advance as soon as every
// bot has acted (autoAdvanceResolution + the all-locked navigation grace), so it does NOT
// wait out the per-phase wall-clock deadlines — the game progresses at roughly a round per
// few ticks and runs to a natural finish (VP_TO_WIN=30 or MAX_ROUNDS=30, src/lib/play/types.ts).
//
// BASELINE FINDING — the full-game wall-clock is dominated by SERVER PER-TICK PROCESSING,
// not by the network. Each /bots/tick loads state, runs the neural policy for up to 4 bot
// seats, and writes EACH resulting command as its own sequential Supabase CAS round-trip
// (many commands per tick). That makes a single tick cost multiple seconds server-side, so
// a whole game is minutes of compute — the bot-driving cost the host client pays today, and
// a natural target for the in-process WS server (bots tick in-memory, no per-command DB write).
//
// The transport-relevant number is `perTickMs`. `run.fullGameSeconds` (when the game
// finishes within the cap) is the end-to-end wall-clock. The browser's 1300ms tick cadence
// is irrelevant to the floor here (a tick already takes seconds); pass --interval=0 to drive
// as fast as the server allows.
//
// Usage: node bench/bot-game.mjs [--base=https://arcspirits.com] [--seconds=900] [--interval=0] [--navMs=2000]

import {
	parseArgs,
	createRoom,
	sendCommand,
	fillBots,
	startGame,
	tickBots,
	getView,
	summarize,
	writeResults,
	printTable,
	sleep
} from './lib.mjs';

const args = parseArgs();
const isProd = /arcspirits\.com/.test(args.base);
const CAP_SECONDS = Number.isFinite(Number(args.seconds)) ? Number(args.seconds) : 900;
const INTERVAL_MS = Number.isFinite(Number(args.interval)) ? Number(args.interval) : 0;
const NAV_MS = Number.isFinite(Number(args.navMs)) ? Number(args.navMs) : 2000;

// Fixed per-phase server deadlines (src/lib/play/types.ts). Only navigation is settable.
const PHASE_SECONDS = {
	navigation: NAV_MS / 1000,
	encounter: 90,
	location: 120,
	benefits: 45,
	awakening: 60,
	cleanup: 45
};

async function main() {
	console.log(`[bot-game] target=${args.base} cap=${CAP_SECONDS}s interval=${INTERVAL_MS}ms navMs=${NAV_MS}`);
	const { code, token } = await createRoom(args.base, 'BenchBotGame');

	// Shrink the navigation timer (the one deadline we can set) before starting.
	await sendCommand(args.base, code, token, { type: 'setNavigationTimer', durationMs: NAV_MS });
	await fillBots(args.base, code, token, 4, 'neural');
	const started = await startGame(args.base, code, token);
	console.log(`[bot-game] room ${code} active: round ${started.projection.round} / ${started.projection.phase}`);

	const tickMs = [];
	const phasesSeen = new Set();
	let ticks = 0;
	let commandsIssued = 0;
	let maxRound = started.projection.round ?? 1;
	let finalStatus = started.projection.status;
	let finalPhase = started.projection.phase;

	const t0 = performance.now();
	const deadline = t0 + CAP_SECONDS * 1000;
	while (performance.now() < deadline) {
		const r = await tickBots(args.base, code, token);
		ticks += 1;
		if (r.ok) {
			tickMs.push(r.ms);
			commandsIssued += r.json.commandsIssued ?? 0;
			const p = r.json.projection;
			if (p) {
				phasesSeen.add(p.phase);
				maxRound = Math.max(maxRound, p.round ?? 0);
				finalStatus = p.status;
				finalPhase = p.phase;
				if (p.status !== 'active') {
					console.log(`[bot-game] game ${p.status} at round ${p.round} after ${ticks} ticks`);
					break;
				}
			}
		}
		if ((ticks % 10) === 0) {
			console.log(`  tick ${ticks}: round=${maxRound} phase=${finalPhase} cmds=${commandsIssued}`);
		}
		await sleep(INTERVAL_MS);
	}
	const elapsedS = (performance.now() - t0) / 1000;

	// Final state read (owner view) for good measure.
	const finalView = (await getView(args.base, code, token)).json;
	finalStatus = finalView?.projection?.status ?? finalStatus;
	finalPhase = finalView?.projection?.phase ?? finalPhase;
	maxRound = Math.max(maxRound, finalView?.projection?.round ?? 0);

	const tickStats = summarize(tickMs);
	const finished = finalStatus === 'finished';

	const result = {
		metric: 'bot-game',
		description:
			'server-side per-tick processing for a 4-neural-bot game driven headlessly via /bots/tick',
		target: isProd ? 'prod-http' : 'http',
		base: args.base,
		fullGameMeasuredHeadlessly: finished,
		finding:
			'Full 4-bot game IS drivable headlessly (phases auto-advance when all bots act; no per-phase ' +
			'deadline wait). Wall-clock is dominated by SERVER PER-TICK PROCESSING — each tick runs the ' +
			'neural policy for up to 4 seats and writes each command as its own sequential Supabase CAS ' +
			'round-trip — not by the network. perTickMs is the transport-relevant figure.',
		perTickMs: tickStats,
		unit: 'ms',
		// Top-level convenience mirrors of the per-tick distribution.
		...tickStats,
		run: {
			capSeconds: CAP_SECONDS,
			intervalMs: INTERVAL_MS,
			navMs: NAV_MS,
			elapsedSeconds: Math.round(elapsedS * 10) / 10,
			fullGameSeconds: finished ? Math.round(elapsedS * 10) / 10 : null,
			ticks,
			commandsIssued,
			maxRoundReached: maxRound,
			phasesSeen: [...phasesSeen],
			finalStatus,
			finalPhase,
			finished
		},
		phaseDeadlineSeconds: PHASE_SECONDS,
		notes: [
			isProd ? 'Captured against production.' : 'NON-PROD base — labelled for clarity.',
			`Ticks driven back-to-back (interval=${INTERVAL_MS}ms); the browser host cadence is 1300ms.`,
			'perTickMs is the transport-relevant figure: server bot-compute + command writes per tick.'
		].join(' '),
		capturedAt: new Date().toISOString()
	};

	const file = writeResults('bot-game', result);
	printTable('bot-game — per-tick processing (ms)', [
		['p50', tickStats.p50],
		['p95', tickStats.p95],
		['min', tickStats.min],
		['max', tickStats.max],
		['ticks', ticks],
		['commandsIssued', commandsIssued],
		['maxRound', maxRound],
		['finalStatus', finalStatus],
		['finished', finished]
	]);
	console.log(`wrote ${file}`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
