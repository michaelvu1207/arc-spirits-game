/**
 * RoomHost — the per-room actor. One authoritative in-memory PublicGameState, engine
 * invoked in-process, commands serialized through a single per-room queue (no CAS needed:
 * this host is the sole writer of its own state). Snapshots to Supabase on a dirty
 * interval + terminal transitions + graceful shutdown. Crash-recovery is a reload from
 * the last snapshot (stateless-restartable).
 */

import { applyGameCommand, applyDeadlineAdvance } from '../src/lib/play/runtime';
import { SEAT_COLORS, phaseDurationMs } from '../src/lib/play/types';
import type {
	CommandResult,
	GameActor,
	GameCommand,
	PlayCatalog,
	PublicGameState
} from '../src/lib/play/types';
import {
	getSessionByRoomCode,
	loadBotMembers,
	persistSnapshot,
	type PlaySessionRow
} from './supabase';
import { loadCatalog } from './catalog';

const NAV_GRACE_MS = 5000;

/**
 * Stamp the wall-clock deadline for the CURRENT phase if unset. Ported verbatim from
 * service.stampPhaseDeadline — the pure reducer nulls phaseDeadline on every phase entry,
 * so the server re-stamps it against the SERVER clock after a command resolves.
 */
function stampPhaseDeadline(state: PublicGameState): void {
	if (state.status !== 'active') {
		state.phaseDeadline = null;
		return;
	}
	if (state.phase === 'navigation' && !state.revealedDestinations) {
		const dur = state.navigationDurationMs;
		if (dur == null) {
			state.phaseDeadline = null;
			state.navigationDeadline = null;
			state.navigationFullDeadline = null;
			return;
		}
		if (state.phaseDeadline == null) state.phaseDeadline = Date.now() + dur;
		state.navigationDeadline ??= state.phaseDeadline;
		state.navigationFullDeadline ??= state.navigationDeadline;
		return;
	}
	if (state.phaseDeadline == null) {
		state.phaseDeadline = Date.now() + phaseDurationMs(state.phase);
	}
}

/** Collapse the navigation deadline to a short grace once every seat is locked. Ported
 *  verbatim from service.applyNavLockDeadline. */
function applyNavLockDeadline(state: PublicGameState): void {
	if (state.status !== 'active' || state.phase !== 'navigation' || state.revealedDestinations)
		return;
	const seats = state.activeSeats;
	const allLocked = seats.length > 0 && seats.every((s) => state.navigation[s]?.locked === true);
	const full = state.navigationFullDeadline;
	if (allLocked) {
		const grace = Date.now() + NAV_GRACE_MS;
		const target = full == null ? grace : Math.min(full, grace);
		state.navigationDeadline = target;
		state.phaseDeadline = target;
	} else {
		state.navigationDeadline = full;
		state.phaseDeadline = full;
	}
}

export type ApplyOutcome =
	| { ok: true; revision: number }
	| { ok: false; error: { code: string; message: string } };

export class RoomHost {
	readonly roomCode: string;
	readonly sessionId: string;
	private state: PublicGameState;
	private started_at: string | null;
	private ended_at: string | null;
	private catalog: PlayCatalog;
	private botMembers: Map<string, string | null>;

	private dirty = false;
	private queue: Promise<unknown> = Promise.resolve();
	private lastActivityAt = Date.now();

	/** Set by the registry so the host can request a broadcast after a server-driven
	 *  revision advance (deadline enforcement / bot tick in M0e). */
	onServerAdvance: (() => void) | null = null;

	private constructor(params: {
		session: PlaySessionRow;
		state: PublicGameState;
		catalog: PlayCatalog;
		botMembers: Map<string, string | null>;
	}) {
		this.roomCode = params.session.room_code;
		this.sessionId = params.session.id;
		this.state = params.state;
		this.started_at = params.session.started_at;
		this.ended_at = params.session.ended_at;
		this.catalog = params.catalog;
		this.botMembers = params.botMembers;
	}

	/** Load a room's snapshot into a fresh in-memory host. Null when the room is absent.
	 *  This is also the crash-recovery path — restart, reload, resume. */
	static async load(roomCode: string): Promise<RoomHost | null> {
		const session = await getSessionByRoomCode(roomCode);
		if (!session) return null;
		const [catalog, botMembers] = await Promise.all([
			loadCatalog(),
			loadBotMembers(session.id)
		]);
		const state = parseState(session);
		return new RoomHost({ session, state, catalog, botMembers });
	}

	getState(): PublicGameState {
		return this.state;
	}
	getRevision(): number {
		return this.state.revision;
	}
	getStatus(): PublicGameState['status'] {
		return this.state.status;
	}
	getBotMembers(): Map<string, string | null> {
		return this.botMembers;
	}
	getCatalog(): PlayCatalog {
		return this.catalog;
	}
	isTerminal(): boolean {
		return this.state.status === 'finished' || this.state.status === 'closed';
	}

	/** Refresh the bot-member map (a seat was filled/removed via the legacy HTTP path). */
	async refreshBotMembers(): Promise<void> {
		this.botMembers = await loadBotMembers(this.sessionId);
	}

	/**
	 * Apply a command against the authoritative state. Serialized behind the per-room
	 * queue so concurrent submits from different sockets never interleave. On success the
	 * revision bumps and the snapshot is marked dirty; the caller broadcasts the delta.
	 */
	applyCommand(actor: GameActor, command: GameCommand): Promise<ApplyOutcome> {
		const run = this.queue.then((): ApplyOutcome => {
			this.lastActivityAt = Date.now();
			if (this.state.status === 'closed') {
				return { ok: false, error: { code: 'room_closed', message: 'This room has closed.' } };
			}
			const result: CommandResult = applyGameCommand(this.state, actor, command, this.catalog);
			if (!result.ok) {
				return { ok: false, error: { code: 'illegal_command', message: result.error.message } };
			}
			const next = result.state;
			stampPhaseDeadline(next);
			applyNavLockDeadline(next);
			this.state = next;
			this.dirty = true;
			return { ok: true, revision: next.revision };
		});
		// Keep the queue alive even if this step throws, so one bad command can't wedge the room.
		this.queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * Per-room timer hook. M0e will fill this in with deadline enforcement
	 * (applyDeadlineAdvance past a passed phaseDeadline) + bot ticking, calling
	 * onServerAdvance() to broadcast. For M0 it is intentionally inert: commands stamp
	 * their own deadlines (above), and no seat is auto-advanced yet.
	 *
	 * `applyDeadlineAdvance` is imported here so the M0e seam has its dependency ready.
	 */
	tick(): void {
		void applyDeadlineAdvance; // referenced so the M0e seam keeps the import wired
		// M0e: if (this.state.status === 'active' && this.state.phaseDeadline != null &&
		//   Date.now() > this.state.phaseDeadline) { advance one phase; broadcast. }
	}

	/** Persist the snapshot when dirty (interval + terminal). Clears the dirty flag first
	 *  so a concurrent mutation re-dirties rather than being lost. */
	async snapshotIfDirty(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		try {
			await this.persist();
		} catch (err) {
			this.dirty = true; // retry next tick
			throw err;
		}
	}

	/** Force a snapshot regardless of the dirty flag (graceful shutdown). */
	async flush(): Promise<void> {
		this.dirty = false;
		await this.persist();
	}

	private async persist(): Promise<void> {
		await persistSnapshot({
			session: { id: this.sessionId, started_at: this.started_at, ended_at: this.ended_at },
			state: this.state
		});
		// Mirror the column stamps we just wrote so a later persist doesn't re-stamp.
		if (this.started_at == null && this.state.status === 'active') {
			this.started_at = new Date().toISOString();
		}
		if (this.ended_at == null && this.isTerminal()) {
			this.ended_at = new Date().toISOString();
		}
	}

	touchActivity(): void {
		this.lastActivityAt = Date.now();
	}

	/** Idle since `lastActivityAt` older than `idleMs` (used with a zero-socket check). */
	idleSince(): number {
		return this.lastActivityAt;
	}
}

function parseState(session: PlaySessionRow): PublicGameState {
	const raw = session.public_state;
	if (raw == null) {
		throw new Error(`Session ${session.room_code} has no public_state snapshot to load.`);
	}
	if (typeof raw === 'string') return JSON.parse(raw) as PublicGameState;
	return raw;
}
