// bench 3 — payload size on the wire per revision.
//
// Today, on every revision bump, each client refetches the WHOLE `/view` projection
// (playStore.refresh → GET /view). So the bytes that cross the wire per update are
// the size of that JSON. We capture it at two lifecycle points — an empty lobby and
// a live game (4 bots, round 1, board + seats + per-seat private state populated) —
// and record raw + gzip byte size. The live-game figure is the meaningful "per
// update" cost; a delta-based WS protocol should send a fraction of it.
//
// Usage: node bench/payload-size.mjs [--base=https://arcspirits.com]

import { gzipSync } from 'node:zlib';
import {
	parseArgs,
	createRoom,
	fillBots,
	startGame,
	tickBots,
	getView,
	writeResults,
	printTable,
	sleep
} from './lib.mjs';

const args = parseArgs();
const isProd = /arcspirits\.com/.test(args.base);

function measure(json) {
	const raw = Buffer.byteLength(JSON.stringify(json), 'utf8');
	const gzip = gzipSync(Buffer.from(JSON.stringify(json), 'utf8')).length;
	return { rawBytes: raw, gzipBytes: gzip };
}

async function main() {
	console.log(`[payload-size] target=${args.base}`);
	const { code, token } = await createRoom(args.base, 'BenchPayload');

	// Point 1: empty lobby.
	const lobbyView = (await getView(args.base, code, token)).json;
	const lobby = measure(lobbyView);
	console.log(`[payload-size] lobby: ${lobby.rawBytes}B raw / ${lobby.gzipBytes}B gzip`);

	// Point 2: live game. Fill 4 bots, start, and tick a couple of times so the board,
	// occupancy, and per-seat private state are all populated (a representative mid-play
	// projection, which is what clients refetch every revision during a game).
	await fillBots(args.base, code, token, 4, 'neural');
	await startGame(args.base, code, token);
	for (let i = 0; i < 3; i += 1) {
		await tickBots(args.base, code, token);
		await sleep(500);
	}
	const gameView = (await getView(args.base, code, token)).json;
	const game = measure(gameView);
	console.log(`[payload-size] active round ${gameView?.projection?.round}: ${game.rawBytes}B raw / ${game.gzipBytes}B gzip`);

	const result = {
		metric: 'payload-size',
		description: 'bytes of the full /view projection refetched by each client per revision',
		target: isProd ? 'prod-http' : 'http',
		base: args.base,
		unit: 'bytes',
		samples: 2,
		measurements: {
			lobby: { ...lobby, revision: lobbyView?.projection?.revision ?? null },
			activeGame: {
				...game,
				revision: gameView?.projection?.revision ?? null,
				round: gameView?.projection?.round ?? null,
				phase: gameView?.projection?.phase ?? null
			}
		},
		// Convenience top-level fields (the live-game raw size is the headline).
		p50: game.rawBytes,
		p95: game.rawBytes,
		min: lobby.rawBytes,
		max: game.rawBytes,
		notes: [
			isProd ? 'Captured against production.' : 'NON-PROD base — labelled for clarity.',
			'This is the OWNER (member-header) view — includes private per-seat detail, which is what the real client refetches.',
			'Every revision today re-sends this entire JSON; a delta WS protocol is the win.'
		].join(' '),
		capturedAt: new Date().toISOString()
	};

	const file = writeResults('payload-size', result);
	printTable('payload-size (bytes)', [
		['lobby raw', lobby.rawBytes],
		['lobby gzip', lobby.gzipBytes],
		['game raw', game.rawBytes],
		['game gzip', game.gzipBytes]
	]);
	console.log(`wrote ${file}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
