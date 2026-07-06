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

loadEnv();

const PORT = Number(optionalEnv('PORT') ?? 8787);
const ALLOW_DEBUG_SEED = optionalEnv('ARC_WS_ALLOW_DEBUG_SEED') === '1';
const START = Date.now();

const registry = new RoomRegistry();
registry.start();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
	res.end(payload);
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
	if (req.method === 'GET' && req.url === '/healthz') {
		const { rooms, connections } = registry.stats();
		sendJson(res, 200, { ok: true, rooms, connections, uptime: Math.floor((Date.now() - START) / 1000) });
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

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
	// Single WS entrypoint; the room is chosen by the `join` frame, not the URL path.
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
