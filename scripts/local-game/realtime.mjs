// A small stand-in for Supabase Realtime: broadcast channels only (Phoenix protocol, JSON
// serializer vsn 1.0.0, the one @supabase/realtime-js uses by default).
//
// The game subscribes to `room:<CODE>` and refetches its view on each `sync` broadcast. In
// Supabase a database trigger sends that broadcast when a room's revision changes; here the
// backend calls `broadcast()` after it sees the revision change (see backend.mjs).
// Client broadcasts are relayed to the other members of the topic, and
// POST /realtime/v1/api/broadcast works too, so a script can use the same channel.
import { WebSocketServer } from 'ws';

export function createRealtime({ log }) {
	const wss = new WebSocketServer({ noServer: true });
	/** socket -> joined topics */
	const members = new Map();

	const send = (ws, message) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
	};

	wss.on('connection', (ws) => {
		members.set(ws, new Set());
		ws.on('close', () => members.delete(ws));
		ws.on('error', () => members.delete(ws));
		ws.on('message', (raw) => {
			let msg;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			const { topic, event, payload, ref } = msg ?? {};
			const joinRef = msg?.join_ref ?? null;
			const reply = (status, response = {}) =>
				send(ws, { topic, event: 'phx_reply', payload: { status, response }, ref, join_ref: joinRef });
			if (topic === 'phoenix' && event === 'heartbeat') return reply('ok');
			const topics = members.get(ws);
			if (!topics) return;
			if (event === 'phx_join') {
				topics.add(topic);
				return reply('ok');
			}
			if (event === 'phx_leave') {
				topics.delete(topic);
				return reply('ok');
			}
			if (event === 'broadcast' && topics.has(topic)) {
				for (const [other, otherTopics] of members) {
					if (other !== ws && otherTopics.has(topic)) send(other, { topic, event: 'broadcast', payload, ref: null });
				}
			}
			if (ref) reply('ok');
		});
	});

	/** Send a broadcast `event` to every socket that joined `topic` (e.g. "realtime:room:ABCD"). */
	function broadcast(topic, event, payload) {
		let count = 0;
		for (const [ws, topics] of members) {
			if (!topics.has(topic)) continue;
			send(ws, { topic, event: 'broadcast', payload: { type: 'broadcast', event, payload }, ref: null });
			count++;
		}
		return count;
	}

	function handleUpgrade(req, socket, head) {
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
	}

	/** POST /realtime/v1/api/broadcast body: { messages: [{ topic, event, payload }] } */
	function handleRestBroadcast(body) {
		const messages = Array.isArray(body?.messages) ? body.messages : [];
		for (const m of messages) {
			if (typeof m?.topic !== 'string' || typeof m?.event !== 'string') continue;
			const sent = broadcast(`realtime:${m.topic}`, m.event, m.payload ?? {});
			log?.(`rest broadcast ${m.topic} ${m.event} -> ${sent}`);
		}
	}

	return {
		handleUpgrade,
		broadcast,
		handleRestBroadcast,
		connections: () => members.size,
		close: () => {
			for (const ws of members.keys()) ws.terminate();
			wss.close();
		}
	};
}
