/**
 * RoomHost — the per-room actor. One authoritative in-memory PublicGameState, engine
 * invoked in-process, commands serialized through a single per-room queue (no CAS needed:
 * this host is the sole writer of its own state). Snapshots to Supabase on a dirty
 * interval + terminal transitions + graceful shutdown. Crash-recovery is a reload from
 * the last snapshot (stateless-restartable).
 *
 * M0e adds the live tick loop: an in-process timer drives deadline enforcement + bot
 * moves (no per-command Supabase write) and requests a broadcast whenever the revision
 * advances — the browser-timer /bots/tick POST and HTTP deadline drain, moved server-side.
 */

import {
	applyGameCommand,
	applyDeadlineAdvance,
	resolvePassedDeadline
} from '../src/lib/play/runtime';
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
import { stampPhaseDeadline, applyNavLockDeadline, deadlinePassed } from './deadline';
import {
	botTuningFromEnv,
	getNeuralPolicy,
	hasBotSeats,
	phaseHoldoutSeats,
	seatIsBot,
	seatedBotSeats,
	stepBotSeats,
	type BotTuning,
	type NeuralPolicy
} from './bots';

/** Live bot/deadline tick cadence — matches today's client `/bots/tick` timer (1300ms). */
const BOT_TICK_MS = Number(process.env.ARC_WS_BOT_TICK_MS ?? 1300);

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
	private tuning: BotTuning = botTuningFromEnv();

	private dirty = false;
	private queue: Promise<unknown> = Promise.resolve();
	private lastActivityAt = Date.now();
	private persistDisabled = false;

	private timer: NodeJS.Timeout | null = null;
	private stopped = false;
	private neuralPromise: Promise<NeuralPolicy | null> | null = null;

	/** Set by the registry so the host can request a broadcast after a server-driven
	 *  revision advance (deadline enforcement / bot tick). */
	onServerAdvance: (() => void) | null = null;

	private constructor(params: {
		session: Pick<PlaySessionRow, 'id' | 'room_code' | 'started_at' | 'ended_at'>;
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
		const [catalog, botMembers] = await Promise.all([loadCatalog(), loadBotMembers(session.id)]);
		return new RoomHost({ session, state: parseState(session), catalog, botMembers });
	}

	/** In-memory host with persistence disabled — for the bot-game bench (no Supabase). */
	static forBench(
		state: PublicGameState,
		catalog: PlayCatalog,
		botMembers: Map<string, string | null>
	): RoomHost {
		const host = new RoomHost({
			session: { id: 'bench', room_code: state.roomCode, started_at: null, ended_at: null },
			state,
			catalog,
			botMembers
		});
		host.persistDisabled = true;
		return host;
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

	private getNeural(): Promise<NeuralPolicy | null> {
		return (this.neuralPromise ??= getNeuralPolicy());
	}

	/** Chain work behind the single per-room queue so nothing interleaves with a command. */
	private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
		const run = this.queue.then(fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * Apply a command against the authoritative state. Serialized behind the per-room
	 * queue so concurrent submits (different sockets, or the bot tick) never interleave.
	 * On success the revision bumps and the snapshot is marked dirty.
	 */
	applyCommand(actor: GameActor, command: GameCommand): Promise<ApplyOutcome> {
		return this.enqueue((): ApplyOutcome => {
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
	}

	// ── Live tick loop (deadline enforcement + bots) ─────────────────────────────────

	/** Start the in-process tick timer (idempotent). Drives deadline enforcement + bot
	 *  moves at BOT_TICK_MS and requests a broadcast on every revision advance. Self-
	 *  scheduling (setTimeout) so a slow tick never overlaps the next. */
	start(): void {
		if (this.timer || this.stopped) return;
		const loop = async () => {
			this.timer = null;
			if (this.stopped) return;
			try {
				if (await this.runTick()) this.onServerAdvance?.();
			} catch (err) {
				console.error(`[room ${this.roomCode}] tick failed:`, (err as Error).message);
			}
			if (!this.stopped) {
				this.timer = setTimeout(loop, BOT_TICK_MS);
				this.timer.unref?.();
			}
		};
		this.timer = setTimeout(loop, BOT_TICK_MS);
		this.timer.unref?.();
	}

	/** Stop the tick timer (eviction / shutdown). */
	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/**
	 * One tick of server authority: (1) enforce a passed wall-clock deadline, (2) advance
	 * every seated bot through the current phase, (3) if the phase is now held up ONLY by
	 * bots (no human still choosing) and they made no progress, enforce the deadline
	 * immediately instead of idling to the wall clock — the dead-wait elimination that lets
	 * a bot game run in seconds. Returns whether the revision advanced. Public so the bench
	 * and tests can drive it directly.
	 */
	async runTick(): Promise<boolean> {
		if (this.state.status !== 'active') return false;
		const startRev = this.state.revision;

		// 1. Wall-clock deadline enforcement — fires with zero connected sockets too. A present
		//    human still holding an obligation in an extendable phase (Location reward/draw,
		//    Benefits grants, Awakening flip/decision, Cleanup sacrifice/overflow) EXTENDS instead
		//    of being force-advanced (which would silently resolve it for them); bots are excluded
		//    so bot games never stall, and the extension is bounded (backstop advance once spent).
		await this.enqueue(() => {
			if (deadlinePassed(this.state)) {
				const botSeats = seatedBotSeats(this.state, this.botMembers);
				const outcome = resolvePassedDeadline(this.state, this.catalog, Date.now(), botSeats);
				if (outcome === 'advanced') stampPhaseDeadline(this.state);
				this.dirty = true;
			}
		});

		// 2. Bot moves through the in-memory queue (no per-command DB write).
		let issued = 0;
		if (this.state.status === 'active' && hasBotSeats(this.state, this.botMembers)) {
			const neuralPolicy = await this.getNeural();
			issued = await stepBotSeats({
				getState: () => this.state,
				applyBotCommand: (actor, command) => this.applyCommand(actor, command),
				catalog: this.catalog,
				botMembers: this.botMembers,
				neuralPolicy,
				tuning: this.tuning
			});
		}

		// 3. Bot-blocked fast-forward: the phase is waiting only on stuck bots.
		if (this.state.status === 'active' && issued === 0) {
			await this.enqueue(() => this.fastForwardIfBotBlocked());
		}

		return this.state.revision !== startRev;
	}

	/**
	 * Advance immediately when a NON-navigation phase's deadline is being held up only by
	 * bots (every holdout seat is a bot — no human is still choosing) and the bots made no
	 * progress this tick. Mirrors what the wall-clock deadline would eventually do
	 * (applyDeadlineAdvance), minus the dead wait. Navigation keeps its normal deadline /
	 * back-out grace so a human's lock window is never cut short.
	 */
	private fastForwardIfBotBlocked(): void {
		const s = this.state;
		if (s.status !== 'active' || s.phase === 'navigation' || s.phaseDeadline == null) return;
		const holdouts = phaseHoldoutSeats(s);
		if (holdouts.length === 0) return;
		if (holdouts.some((seat) => !seatIsBot(s, seat, this.botMembers))) return; // a human is holding it up
		applyDeadlineAdvance(s, this.catalog);
		stampPhaseDeadline(s);
		this.dirty = true;
	}

	// ── Persistence ──────────────────────────────────────────────────────────────────

	/** Persist the snapshot when dirty (interval + terminal). */
	async snapshotIfDirty(): Promise<void> {
		if (!this.dirty || this.persistDisabled) return;
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
		if (this.persistDisabled) return;
		this.dirty = false;
		await this.persist();
	}

	private async persist(): Promise<void> {
		await persistSnapshot({
			session: { id: this.sessionId, started_at: this.started_at, ended_at: this.ended_at },
			state: this.state
		});
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

	/** Wall-clock of the last command/join, for idle eviction. */
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
