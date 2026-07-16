/**
 * Arc Spirits room server entrypoint. A long-lived Node process holding authoritative
 * in-memory game state per room, engine invoked in-process, transport over WebSocket
 * (protocol.ts). Plain http server for the WS upgrade + a health endpoint.
 *
 * Run: npx tsx server/index.ts   (env from .env / .env.local / server/.env)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadEnv, optionalEnv } from './env';
import { RoomRegistry } from './connections';
import { MAX_CLIENT_FRAME_BYTES, WS_UPGRADE_PATH } from './protocol';

loadEnv();

const PORT = Number(optionalEnv('PORT') ?? 8787);
// PRODUCTION HARD-DISABLES the debug surface: no environment flag can re-open the
// seed/ticket-mint endpoints (or, via connections.ts, the integrity commands) when
// NODE_ENV=production. A leftover ARC_WS_ALLOW_DEBUG_SEED=1 in a production deploy
// is ignored — loudly.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEBUG_SEED_FLAG = optionalEnv('ARC_WS_ALLOW_DEBUG_SEED') === '1';
const ALLOW_DEBUG_SEED = !IS_PRODUCTION && DEBUG_SEED_FLAG;
if (IS_PRODUCTION && DEBUG_SEED_FLAG) {
	console.error(
		'[room-server] ARC_WS_ALLOW_DEBUG_SEED=1 is set but NODE_ENV=production — debug seed and integrity commands stay DISABLED.'
	);
}
const START = Date.now();

/**
 * Browser-origin allowlist for the WS upgrade. A browser ALWAYS sends `Origin` on a
 * WebSocket handshake, so any Origin not in this list is refused before the socket
 * exists — a hostile page cannot even open the connection. Origin-LESS clients
 * (Godot, native shells, test harnesses, curl) are allowed through the handshake
 * but still authenticate with a valid one-use ticket on `join`.
 *
 * Configure with ARC_WS_ALLOWED_ORIGINS (comma-separated exact origins). Without
 * it, localhost dev origins are allowed (local stacks); PRODUCTION DEPLOYMENTS MUST
 * SET IT to the deployed site origin(s).
 */
function allowedBrowserOrigins(): Set<string> | 'localhost-only' {
	const raw = optionalEnv('ARC_WS_ALLOWED_ORIGINS');
	if (!raw) return 'localhost-only';
	return new Set(
		raw
			.split(',')
			.map((s) => s.trim().replace(/\/+$/, ''))
			.filter(Boolean)
	);
}

function originAllowed(origin: string | undefined): boolean {
	if (!origin) return true; // origin-less native/test clients — ticket still required
	const allow = allowedBrowserOrigins();
	if (allow === 'localhost-only') {
		try {
			const { hostname } = new URL(origin);
			return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
		} catch {
			return false;
		}
	}
	return allow.has(origin.replace(/\/+$/, ''));
}

const registry = new RoomRegistry();
registry.start();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
	res.end(payload);
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
	if (req.method === 'GET' && req.url === '/healthz') {
		const { rooms, connections, roomLoads } = registry.stats();
		sendJson(res, 200, {
			ok: true,
			rooms,
			connections,
			roomLoads,
			uptime: Math.floor((Date.now() - START) / 1000)
		});
		return;
	}
	// Dev-only room seeding for the smoke (never on in production).
	if (req.method === 'POST' && req.url === '/debug/seed' && ALLOW_DEBUG_SEED) {
		void (async () => {
			try {
				const { seedDebugRoom } = await import('./debugSeed');
				sendJson(res, 200, await seedDebugRoom());
			} catch (err) {
				sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		})();
		return;
	}
	// Dev-only ticket mints for the smoke/tests (production tickets come exclusively
	// from the authenticated SvelteKit endpoint).
	if (req.method === 'POST' && req.url?.startsWith('/debug/ticket') && ALLOW_DEBUG_SEED) {
		void (async () => {
			try {
				const { mintDebugTicket } = await import('./debugSeed');
				const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
				sendJson(
					res,
					200,
					await mintDebugTicket({
						memberId: params.get('memberId') ?? undefined,
						roomCode: params.get('roomCode') ?? undefined
					})
				);
			} catch (err) {
				sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		})();
		return;
	}
	if (req.method === 'POST' && req.url?.startsWith('/debug/spectator-ticket') && ALLOW_DEBUG_SEED) {
		void (async () => {
			try {
				const { mintDebugSpectatorTicket } = await import('./debugSeed');
				const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
				sendJson(res, 200, await mintDebugSpectatorTicket(String(params.get('roomCode') ?? '')));
			} catch (err) {
				sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		})();
		return;
	}
	if (req.method === 'POST' && req.url?.startsWith('/debug/seed-bots') && ALLOW_DEBUG_SEED) {
		const params = new URL(req.url, 'http://localhost').searchParams;
		const botCount = Number(params.get('botCount') ?? 3);
		const navMs = params.has('navMs') ? Number(params.get('navMs')) : undefined;
		void (async () => {
			try {
				const { seedBotRoom } = await import('./debugSeed');
				sendJson(res, 200, await seedBotRoom({ botCount, navMs }));
			} catch (err) {
				sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		})();
		return;
	}
	sendJson(res, 404, { ok: false, error: 'not found' });
});

// maxPayload closes any socket sending an oversized frame BEFORE JSON parsing.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES });

httpServer.on('upgrade', (req, socket, head) => {
	// EXACT upgrade path only — the room is chosen by the `join` frame, never the URL
	// (so no room code or credential can ever ride the URL into logs/proxies).
	const path = (req.url ?? '').split('?')[0];
	if (path !== WS_UPGRADE_PATH) {
		socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
		socket.destroy();
		return;
	}
	// Browser Origin allowlist (see originAllowed): a hostile page's handshake dies
	// here; origin-less native/test clients continue to ticket auth.
	if (!originAllowed(req.headers.origin)) {
		socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		registry.handleSocket(ws, req);
	});
});

httpServer.listen(PORT, () => {
	console.log(`[room-server] listening on :${PORT} (debugSeed=${ALLOW_DEBUG_SEED ? 'on' : 'off'})`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[room-server] ${signal} — flushing rooms…`);
	try {
		await registry.shutdown();
	} finally {
		wss.close();
		httpServer.close(() => process.exit(0));
		// Hard cap so a hung socket can't block exit.
		setTimeout(() => process.exit(0), 3000).unref();
	}
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
