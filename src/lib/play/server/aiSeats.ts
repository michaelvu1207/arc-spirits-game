/**
 * The two operations of the laptop AI worker (scripts/ai-worker): list the AI-seat decisions
 * that are due now, and apply one answer. The decision text is the agent harness's own
 * (agents/decision.ts buildDecision → prompt.ts renderDecisionMessage, rulesBrief.ts for the
 * system text, answer format {"action": "<id>", "reason": "..."}): one prompt format for harness
 * seats and live AI seats. The answer is applied through runRoomCommand as the seat's bot
 * member — the same commit path tickBots uses — fenced to the exact revision it was asked at.
 */
import { buildDecision, type BuiltDecision } from '../agents/decision';
import { renderDecisionMessage } from '../agents/prompt';
import { buildRulesBrief } from '../agents/rulesBrief';
import { seatsToAct } from '../agents/seats';
import { SEAT_COLORS, type PlayCatalog, type PublicGameState, type SeatColor } from '../types';
import { MAX_AI_ROOMS_PER_POLL } from './aiPlayers';
import { loadPlayCatalog } from './catalog';
import {
	StaleRevisionError,
	lastCommitAt,
	listActiveAiRooms,
	loadAiRoom,
	runRoomCommand
} from './service';

/** Seats that must act now (the harness rule: a pending Navigation Power prompt blocks the
 *  others — the same botSeatNeedsToAct predicate tickBots uses), restricted to `aiSeats`. */
export function aiSeatsThatMustAct(state: PublicGameState, aiSeats: SeatColor[]): SeatColor[] {
	if (state.status !== 'active') return [];
	return seatsToAct(state).filter((seat) => aiSeats.includes(seat));
}

const briefs = new WeakMap<PlayCatalog, string>();

/** The harness rules brief for this catalog (the AI seat's system text), cached per catalog. */
export function aiSystemText(catalog: PlayCatalog): string {
	let brief = briefs.get(catalog);
	if (!brief) {
		brief = buildRulesBrief(catalog);
		briefs.set(catalog, brief);
	}
	return brief;
}

export interface AiDecision {
	built: BuiltDecision;
	/** The harness decision message (view, engine facts, numbered legal actions, answer line). */
	prompt: string;
}

/**
 * The decision an AI seat is asked, built as the harness runner's `prepare` step builds it.
 * Deterministic for a given (state, seat, catalog): /api/ai/act rebuilds it to map the answered
 * id ("a3") back to its command. A live room keeps no per-seat event log, so the "recent
 * events" section is empty and the per-phase decision counter is not tracked (always #1).
 */
export function buildAiDecision(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	roomCode: string
): AiDecision {
	const built = buildDecision({
		state,
		seat,
		catalog,
		gameId: state.gameId ?? roomCode,
		requestId: `${roomCode}-r${state.revision}-${seat}`,
		events: [],
		phaseDecisionIndex: 0
	});
	return { built, prompt: renderDecisionMessage(built.request) };
}

/** Idempotency key of an AI seat's answer for one revision (a repeated POST is a no-op). */
export function aiCmdId(sessionId: string, revision: number, seat: SeatColor): string {
	return `ai:${sessionId}:${revision}:${seat}`;
}

export interface AiPendingItem {
	roomCode: string;
	seat: SeatColor;
	revision: number;
	system: string;
	prompt: string;
	actions: { id: string; label: string }[];
	/** Milliseconds since the room's last committed change. */
	waitingMs: number;
}

/**
 * Every AI seat that must act NOW in an ACTIVE room, at most {@link MAX_AI_ROOMS_PER_POLL}
 * rooms per call (the newest active rooms with AI seats). Read-only.
 */
export async function listPendingAiDecisions(now = Date.now()): Promise<AiPendingItem[]> {
	const rooms = await listActiveAiRooms(MAX_AI_ROOMS_PER_POLL);
	if (rooms.length === 0) return [];
	const catalog = await loadPlayCatalog();
	const system = aiSystemText(catalog);
	const items: AiPendingItem[] = [];
	for (const room of rooms) {
		const seats = aiSeatsThatMustAct(room.state, [...room.aiSeats.keys()]);
		if (seats.length === 0) continue;
		const since = await lastCommitAt(room.sessionId);
		const waitingMs = since == null ? 0 : Math.max(0, now - since);
		for (const seat of seats) {
			const { built, prompt } = buildAiDecision(room.state, seat, catalog, room.roomCode);
			if (built.request.actions.length === 0) continue;
			items.push({
				roomCode: room.roomCode,
				seat,
				revision: room.revision,
				system,
				prompt,
				actions: built.request.actions.map(({ id, label }) => ({ id, label })),
				waitingMs
			});
		}
	}
	return items;
}

export type AiActResult =
	| { status: 200; body: { ok: true; revision: number } }
	| { status: 400 | 404 | 409; body: { message: string; revision?: number } };

function httpStatusOf(err: unknown): number | null {
	const status = (err as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : null;
}

function httpMessageOf(err: unknown): string {
	const body = (err as { body?: { message?: unknown } } | null)?.body;
	if (typeof body?.message === 'string') return body.message;
	return err instanceof Error ? err.message : 'The command was rejected.';
}

/**
 * Apply one AI answer. The seat must be an AI seat that must act, `revision` must be the
 * room's current revision (else 409 with the current one), and `actionId` must be one of the
 * ids of the rebuilt decision (else 400 — never a guess).
 */
export async function actForAiSeat(input: unknown): Promise<AiActResult> {
	const body = (input ?? {}) as Record<string, unknown>;
	const roomCode = typeof body.roomCode === 'string' ? body.roomCode.trim().toUpperCase() : '';
	const seat = body.seat as SeatColor;
	const revision = body.revision;
	const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : '';
	if (!/^[A-Z0-9]{4,12}$/.test(roomCode))
		return { status: 400, body: { message: 'roomCode is required.' } };
	if (!SEAT_COLORS.includes(seat)) return { status: 400, body: { message: 'seat is not a seat color.' } };
	if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)
		return { status: 400, body: { message: 'revision must be a whole number.' } };
	if (!actionId) return { status: 400, body: { message: 'actionId is required.' } };

	const room = await loadAiRoom(roomCode);
	if (!room) return { status: 404, body: { message: 'Room not found.' } };
	const memberId = room.aiSeats.get(seat);
	if (!memberId) return { status: 400, body: { message: `${seat} is not an AI seat.` } };
	if (room.state.status !== 'active')
		return { status: 409, body: { message: 'The game is not active.', revision: room.revision } };
	if (revision !== room.revision)
		return {
			status: 409,
			body: { message: `Stale revision (current ${room.revision}).`, revision: room.revision }
		};
	if (aiSeatsThatMustAct(room.state, [seat]).length === 0)
		return {
			status: 409,
			body: { message: `${seat} does not need to act now.`, revision: room.revision }
		};

	const catalog = await loadPlayCatalog();
	const { built } = buildAiDecision(room.state, seat, catalog, room.roomCode);
	const chosen = built.request.actions.find((action) => action.id === actionId);
	if (!chosen)
		return {
			status: 400,
			body: { message: `"${actionId.slice(0, 40)}" is not one of the offered action ids.` }
		};

	try {
		const view = await runRoomCommand({
			roomCode: room.roomCode,
			trustedMemberId: memberId,
			expectedRevision: revision,
			command: chosen.command,
			cmdId: aiCmdId(room.sessionId, revision, seat),
			requireRevision: revision
		});
		return { status: 200, body: { ok: true, revision: view.projection.revision } };
	} catch (err) {
		if (err instanceof StaleRevisionError)
			return { status: 409, body: { message: err.message, revision: err.revision } };
		const status = httpStatusOf(err);
		if (status === 400) return { status: 400, body: { message: httpMessageOf(err) } };
		if (status === 409 || status === 410)
			return { status: 409, body: { message: httpMessageOf(err), revision: room.revision } };
		throw err;
	}
}
