/**
 * RoomHost — the per-room actor. One in-memory PublicGameState per room used as a
 * LATENCY CACHE over the single durable authority: the `play_game_sessions` row,
 * fenced by the revision compare-and-set in src/lib/play/server/commit.ts (the SAME
 * commit protocol the HTTP path uses). Every mutation — player command, deadline
 * enforcement, bot move — commits durably BEFORE it is acknowledged or broadcast, so:
 *
 *   - an ack means the state (and its ledger row) survived a process kill;
 *   - two instances (or the WS server + serverless HTTP) can never fork the room:
 *     the CAS admits exactly one writer per revision, the loser reloads and retries;
 *   - a crash/restart is a plain reload of the durable row (`RoomHost.load`) — there
 *     is no dirty in-memory delta to lose or to clobber newer state with.
 *
 * Commands are serialized through a single per-room queue so concurrent submits on
 * one instance never interleave; the CAS extends that serialization across instances.
 * The tick loop (deadline enforcement + bot moves) batches its whole step into ONE
 * durable commit, and starts by converging on the durable revision so mutations
 * committed by the HTTP path (or another instance) reach WS clients within a tick.
 */

import {
	applyGameCommand,
	applyDeadlineAdvance,
	resolvePassedDeadline,
	cloneState,
	ensureStateShape
} from '../src/lib/play/runtime';
import type {
	CommandResult,
	GameActor,
	GameCommand,
	PlayCatalog,
	PublicGameState
} from '../src/lib/play/types';
import { SEAT_COLORS } from '../src/lib/play/types';
import {
	commandFingerprint,
	commitRoomMutation,
	CommitNotReadyError,
	findCommittedCmd,
	type CommitEvent,
	type CommitOutcome,
	type PlayDbClient
} from '../src/lib/play/server/commit';
import {
	computeRequiredEffects,
	drainEffectsOutbox,
	effectsOutboxEvent
} from '../src/lib/play/server/effectsOutbox';
import {
	getPlayAdmin,
	getSessionByRoomCode,
	getSessionRevision,
	loadBotMembers,
	takeOverRankedDisconnects,
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

/** Bounded reload-and-reapply attempts when the durable CAS reports another writer. */
const MAX_COMMIT_ATTEMPTS = 4;

/** Per-room memory of recently committed cmdIds → their result, so an instant retry
 *  (same socket, ack lost in flight) is answered without a DB round-trip. The durable
 *  ledger (commit.ts) remains the cross-instance / cross-restart boundary. */
const RECENT_CMD_CAP = 512;

const HISTORY_SCHEMA = 'arc_spirits_game';

export type ApplyOutcome =
	| {
			ok: true;
			/** The CURRENT durable revision at answer time. For a fresh commit this is the
			 *  committed revision; for a duplicate it is the head AFTER convergence, so the
			 *  ack's revision always matches the view sent with it. */
			revision: number;
			duplicate?: boolean;
			/** For duplicates: the ORIGINAL revision this cmdId committed at. */
			duplicateOfRevision?: number;
	  }
	| { ok: false; error: { code: string; message: string } };

/** Injected persistence/catalog surface so the authority protocol is unit-testable
 *  against an in-memory fake (see server/roomHostAuthority.test.ts). */
export interface RoomHostDeps {
	db(): PlayDbClient;
	/** History-schema client for round snapshots; null disables that side effect. */
	historyDb(): PlayDbClient | null;
	getSessionByRoomCode(roomCode: string): Promise<PlaySessionRow | null>;
	getSessionRevision(sessionId: string): Promise<{ revision: number; status: string } | null>;
	loadBotMembers(sessionId: string): Promise<Map<string, string | null>>;
	/** Optional only for pre-migration unit fakes. Live/default hosts always supply
	 * the fail-closed ranked disconnect RPC. */
	takeOverRankedDisconnects?(sessionId: string): Promise<number>;
	loadCatalog(): Promise<PlayCatalog>;
	/** Explicit opt-in for the pre-migration non-atomic commit (local/test only);
	 *  undefined defers to ARC_ALLOW_NONATOMIC_COMMIT. Production stays fail-closed. */
	allowNonAtomicCommit?: boolean;
}

export function defaultRoomHostDeps(): RoomHostDeps {
	return {
		db: () => getPlayAdmin(),
		historyDb: () => getPlayAdmin(HISTORY_SCHEMA),
		getSessionByRoomCode,
		getSessionRevision,
		loadBotMembers,
		takeOverRankedDisconnects,
		loadCatalog
	};
}

export class RoomHost {
	readonly roomCode: string;
	readonly sessionId: string;
	private readonly deps: RoomHostDeps;
	private state: PublicGameState;
	private mode: PlaySessionRow['mode'];
	private visibility: 'public' | 'private';
	private started_at: string | null;
	private ended_at: string | null;
	private catalog: PlayCatalog;
	private botMembers: Map<string, string | null>;
	private tuning: BotTuning = botTuningFromEnv();

	private queue: Promise<unknown> = Promise.resolve();
	private lastActivityAt = Date.now();
	/** Bench mode: pure in-memory, no durable commits (never the live path). */
	private persistDisabled = false;

	private timer: NodeJS.Timeout | null = null;
	private stopped = false;
	private neuralPromise: Promise<NeuralPolicy | null> | null = null;

	/** cmdId → the committed identity fingerprint + original revision. The answer is
	 *  rebuilt at hit time (current head + duplicateOfRevision) so a late retry never
	 *  pairs a stale revision with a fresh view; a fingerprint mismatch is an
	 *  idempotency conflict, exactly like the durable ledger check. */
	private recentCmds = new Map<string, { fingerprint: string; originalRevision: number }>();

	/** Set by the registry so the host can request a broadcast after a server-driven
	 *  revision advance (deadline enforcement / bot tick / durable-truth refresh). */
	onServerAdvance: (() => void) | null = null;

	private constructor(params: {
		session: Pick<PlaySessionRow, 'id' | 'room_code' | 'mode' | 'started_at' | 'ended_at'> & {
			visibility?: string | null;
		};
		state: PublicGameState;
		catalog: PlayCatalog;
		botMembers: Map<string, string | null>;
		deps: RoomHostDeps;
	}) {
		this.roomCode = params.session.room_code;
		this.sessionId = params.session.id;
		this.mode = params.session.mode ?? 'casual';
		this.visibility = normalizeVisibility(params.session);
		this.state = params.state;
		this.started_at = params.session.started_at;
		this.ended_at = params.session.ended_at;
		this.catalog = params.catalog;
		this.botMembers = params.botMembers;
		this.deps = params.deps;
	}

	/** Load a room's durable row into a fresh in-memory host. Null when the room is
	 *  absent. This is also the crash-recovery path — restart, reload, resume: because
	 *  every ack is durable-first, the reloaded state IS the acknowledged truth. */
	static async load(roomCode: string, deps: RoomHostDeps = defaultRoomHostDeps()): Promise<RoomHost | null> {
		const session = await deps.getSessionByRoomCode(roomCode);
		if (!session) return null;
		const [catalog, botMembers] = await Promise.all([
			deps.loadCatalog(),
			deps.loadBotMembers(session.id)
		]);
		const host = new RoomHost({ session, state: parseState(session), catalog, botMembers, deps });
		// Recovery drain: a previous process may have been killed AFTER a commit but
		// BEFORE its required side effects (mirrors / match finalize / round history)
		// completed — the effects outbox committed with the state says what is owed.
		await host.drainOutbox();
		return host;
	}

	/** In-memory host with persistence disabled — for the bot-game bench (no Supabase).
	 *  NOT the live path: live rooms always commit durably before acking. */
	static forBench(
		state: PublicGameState,
		catalog: PlayCatalog,
		botMembers: Map<string, string | null>
	): RoomHost {
		const host = new RoomHost({
			session: {
				id: 'bench',
				room_code: state.roomCode,
				mode: 'casual',
				started_at: null,
				ended_at: null
			},
			state,
			catalog,
			botMembers,
			deps: defaultRoomHostDeps()
		});
		host.persistDisabled = true;
		return host;
	}

	getState(): PublicGameState {
		return this.state;
	}
	getMode(): PlaySessionRow['mode'] {
		return this.mode;
	}
	/** Central admission flag — 'private' rooms exist only for their members. */
	getVisibility(): 'public' | 'private' {
		return this.visibility;
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

	/** Refresh the bot-member map (a seat was filled/removed via the HTTP path). */
	async refreshBotMembers(): Promise<void> {
		this.botMembers = await this.deps.loadBotMembers(this.sessionId);
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
	 * Apply a command against the durable authority. Serialized behind the per-room
	 * queue; committed under the revision CAS BEFORE resolving, so the caller's ack
	 * always means "this survived a crash". On a CAS miss (the HTTP path or another
	 * instance committed first) the host reloads the durable truth and re-applies —
	 * bounded — so simultaneous mixed-transport commands linearize on one history.
	 *
	 * SEAT AUTHORITY: the caller's `actor.seatColor` is advisory only. The seat is
	 * re-derived from the CURRENT state on EVERY attempt — including after a CAS-miss
	 * reload — so a concurrent release/takeover can never leave a stale seat identity
	 * authorized against newer state (the member's role from its row is preserved).
	 *
	 * A duplicate `cmdId` (an honest retry after a lost ack, even one that originally
	 * landed via HTTP) answers the CURRENT durable revision/view plus the original
	 * committed revision as `duplicateOfRevision`, without re-applying. The same cmdId
	 * with a different actor/type/payload is rejected as `idempotency_conflict`.
	 */
	applyCommand(actor: GameActor, command: GameCommand, cmdId?: string | null): Promise<ApplyOutcome> {
		return this.enqueue(() => this.applyCommandLocked(actor, command, cmdId ?? null));
	}

	/** The command actor derived from the AUTHORITATIVE state: the state's seats map is
	 *  the sole seat authority (no member-row fallback), the role rides from the member. */
	private actorFromState(base: GameActor): GameActor {
		const seatColor = base.memberId
			? (SEAT_COLORS.find((seat) => this.state.seats[seat]?.memberId === base.memberId) ?? null)
			: null;
		return { memberId: base.memberId, displayName: base.displayName, role: base.role, seatColor };
	}

	private async applyCommandLocked(
		requested: GameActor,
		command: GameCommand,
		cmdId: string | null
	): Promise<ApplyOutcome> {
		this.lastActivityAt = Date.now();

		const fingerprint = commandFingerprint(
			requested.memberId ?? null,
			command.type,
			command as unknown as Record<string, unknown>
		);
		if (cmdId) {
			const remembered = this.recentCmds.get(cmdId);
			if (remembered) {
				if (remembered.fingerprint !== fingerprint) {
					return {
						ok: false,
						error: {
							code: 'idempotency_conflict',
							message: 'This cmdId was already used by a different actor or command.'
						}
					};
				}
				return {
					ok: true,
					revision: this.state.revision,
					duplicate: true,
					duplicateOfRevision: remembered.originalRevision
				};
			}
		}

		for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
			if (this.state.status === 'closed') {
				return { ok: false, error: { code: 'room_closed', message: 'This room has closed.' } };
			}

			// Fresh identity per attempt: after a reload the state may seat this member
			// differently (or not at all) — the stale seat must never be reused.
			const actor = this.actorFromState(requested);

			// applyGameCommand deep-clones by default — this.state is NEVER mutated in
			// place, so a failed commit leaves the cache exactly on the durable truth.
			const result: CommandResult = applyGameCommand(this.state, actor, command, this.catalog);
			if (!result.ok) {
				// Before rejecting, honor the durable idempotency contract: a retry of an
				// ALREADY-COMMITTED command may be illegal against the moved-on state (e.g.
				// the phase advanced) — it must still answer as a duplicate, not a fresh
				// rejection. Only consulted on the miss path, so the hot path stays cheap.
				if (cmdId && !this.persistDisabled) {
					const committed = await findCommittedCmd(this.deps.db(), this.sessionId, cmdId).catch(
						() => null
					);
					if (committed) {
						const stored = commandFingerprint(
							committed.actorMemberId,
							committed.commandType,
							committed.payload
						);
						if (stored !== fingerprint) {
							return {
								ok: false,
								error: {
									code: 'idempotency_conflict',
									message: 'This cmdId was already used by a different actor or command.'
								}
							};
						}
						await this.reloadFromDb();
						await this.drainOutbox();
						this.rememberCmd(cmdId, fingerprint, committed.revision);
						return {
							ok: true,
							revision: this.state.revision,
							duplicate: true,
							duplicateOfRevision: committed.revision
						};
					}
				}
				return { ok: false, error: { code: 'illegal_command', message: result.error.message } };
			}
			const prev = this.state;
			const next = result.state;
			stampPhaseDeadline(next);
			applyNavLockDeadline(next);

			if (this.persistDisabled) {
				this.state = next;
				return { ok: true, revision: next.revision };
			}

			const events: CommitEvent[] = [
				{
					commandType: command.type,
					payload: command,
					actorMemberId: actor.memberId,
					revision: next.revision,
					cmdId
				}
			];
			// Required side effects ride the SAME atomic commit as an outbox event, so a
			// kill between the commit and the effects can never lose them (recovery drains).
			const outbox = effectsOutboxEvent(
				next.revision,
				computeRequiredEffects({
					prev,
					next,
					command,
					session: this.finalizeSessionRef(next),
					timestamp: new Date().toISOString()
				})
			);
			if (outbox) events.push(outbox);

			let outcome: CommitOutcome;
			try {
				outcome = await commitRoomMutation(
					this.deps.db(),
					{
						session: {
							id: this.sessionId,
							revision: prev.revision,
							started_at: this.started_at,
							ended_at: this.ended_at
						},
						nextState: next,
						events
					},
					{ allowNonAtomicFallback: this.deps.allowNonAtomicCommit }
				);
			} catch (err) {
				// Durability unavailable ⇒ NO ack and NO in-memory advance: the client may
				// retry (same cmdId) once the store is reachable again. A missing atomic RPC
				// is a READINESS failure (fail closed) — never a silent downgrade.
				return {
					ok: false,
					error: {
						code: err instanceof CommitNotReadyError ? err.code : 'persist_failed',
						message: err instanceof Error ? err.message : 'Failed to persist the command.'
					}
				};
			}

			if (outcome.outcome === 'idempotency_conflict') {
				await this.reloadFromDb();
				return {
					ok: false,
					error: {
						code: 'idempotency_conflict',
						message: 'This cmdId was already used by a different actor or command.'
					}
				};
			}
			if (outcome.outcome === 'duplicate') {
				// Already committed once (possibly by the HTTP path / another instance).
				// Converge on the durable truth, finish any effects the original writer
				// left owing, and answer coherently: CURRENT revision + duplicate-of.
				await this.reloadFromDb();
				await this.drainOutbox();
				if (cmdId) this.rememberCmd(cmdId, fingerprint, outcome.revision);
				return {
					ok: true,
					revision: this.state.revision,
					duplicate: true,
					duplicateOfRevision: outcome.revision
				};
			}
			if (outcome.outcome === 'cas_miss') {
				await this.reloadFromDb();
				continue; // re-apply against the fresh durable truth (fresh actor too).
			}

			// Committed. Advance the cache, then attempt the required side effects (all
			// idempotent; the outbox row is already durable, so a failure here is
			// recovered later) BEFORE acking.
			this.state = next;
			this.adoptRowStamps(outcome.row);
			await this.drainOutbox();
			if (cmdId) this.rememberCmd(cmdId, fingerprint, next.revision);
			return { ok: true, revision: next.revision };
		}

		return {
			ok: false,
			error: {
				code: 'conflict',
				message: 'This room is being updated by other players — please retry.'
			}
		};
	}

	private rememberCmd(cmdId: string, fingerprint: string, originalRevision: number): void {
		this.recentCmds.set(cmdId, { fingerprint, originalRevision });
		if (this.recentCmds.size > RECENT_CMD_CAP) {
			const oldest = this.recentCmds.keys().next().value;
			if (oldest !== undefined) this.recentCmds.delete(oldest);
		}
	}

	/** The finalize-session shape effects carry (durably) and drains replay from. */
	private finalizeSessionRef(state: PublicGameState): {
		id: string;
		game_id: string | null;
		mode: PlaySessionRow['mode'];
		started_at: string | null;
		ended_at: string | null;
	} {
		return {
			id: this.sessionId,
			game_id: state.gameId,
			mode: this.mode,
			started_at: this.started_at,
			ended_at: this.ended_at
		};
	}

	/** Run every pending outbox effect for this session against the CURRENT state.
	 *  Never throws into the command flow — an incomplete drain stays durably owed. */
	private async drainOutbox(): Promise<void> {
		if (this.persistDisabled) return;
		try {
			await drainEffectsOutbox(this.deps.db(), this.deps.historyDb(), this.sessionId, this.state, {
				allowNonAtomicFallback: this.deps.allowNonAtomicCommit
			});
		} catch (err) {
			console.error(`[room ${this.roomCode}] effects outbox drain failed:`, (err as Error).message);
		}
	}

	private adoptRowStamps(row: Record<string, unknown>): void {
		if (typeof row.started_at === 'string') this.started_at = row.started_at;
		if (typeof row.ended_at === 'string') this.ended_at = row.ended_at;
	}

	/** Replace the cache with the durable truth (CAS miss / duplicate / stale tick). */
	private async reloadFromDb(): Promise<void> {
		const session = await this.deps.getSessionByRoomCode(this.roomCode);
		if (!session) return; // row gone (deleted) — keep serving the last known state.
		this.state = ensureStateShape(parseState(session));
		this.mode = session.mode ?? this.mode;
		this.visibility = normalizeVisibility(session);
		this.started_at = session.started_at;
		this.ended_at = session.ended_at;
		this.botMembers = await this.deps.loadBotMembers(this.sessionId);
	}

	/**
	 * Converge the cache on the durable revision if another writer (HTTP path, other
	 * instance, room close) advanced it. Cheap no-op when already fresh (single-column
	 * SELECT). Public + queued so joins/resyncs can guarantee "durable truth or newer".
	 */
	ensureFresh(): Promise<boolean> {
		return this.enqueue(() => this.refreshIfStaleLocked());
	}

	private async refreshIfStaleLocked(): Promise<boolean> {
		if (this.persistDisabled) return false;
		const head = await this.deps.getSessionRevision(this.sessionId);
		if (!head) return false;
		if (head.revision === this.state.revision && head.status === this.state.status) return false;
		await this.reloadFromDb();
		return true;
	}

	// ── Live tick loop (deadline enforcement + bots) ─────────────────────────────────

	/** Start the in-process tick timer (idempotent). Drives durable-truth freshness,
	 *  deadline enforcement + bot moves at BOT_TICK_MS and requests a broadcast on every
	 *  revision advance. Self-scheduling (setTimeout) so a slow tick never overlaps. */
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
	 * One tick of server authority, ALL of it committed as ONE durable CAS batch:
	 * (1) converge on the durable revision (pick up HTTP/other-instance commits);
	 * (2) enforce a passed wall-clock deadline (extension-aware, fires with zero
	 * connected sockets); (3) advance every seated bot through the current phase via
	 * the same engine policy the HTTP path uses; (4) bot-blocked fast-forward when a
	 * non-navigation phase is held up ONLY by stuck bots. A CAS miss simply reloads —
	 * whoever won already produced the same enforcement (single winner, never two
	 * histories). Returns whether the visible revision advanced. Public so the bench
	 * and tests can drive it directly.
	 */
	async runTick(): Promise<boolean> {
		const startRev = this.state.revision;
		await this.enqueue(async () => {
			await this.refreshIfStaleLocked();
			if (this.stopped || this.state.status !== 'active') return;
			if (this.mode === 'ranked' && this.deps.takeOverRankedDisconnects) {
				const takenOver = await this.deps.takeOverRankedDisconnects(this.sessionId);
				if (takenOver > 0) await this.reloadFromDb();
				if (this.stopped || this.state.status !== 'active') return;
			}

			const prev = this.state;
			let work = cloneState(prev);
			const events: CommitEvent[] = [];
			const preCommitRoundStates: PublicGameState[] = [];

			// 1. Wall-clock deadline enforcement — extension-aware: a present human still
			//    mid-obligation extends instead of being force-advanced; bots are excluded
			//    so bot games never stall; the extension budget bounds a vanished human.
			if (deadlinePassed(work)) {
				const botSeats = seatedBotSeats(work, this.botMembers);
				const outcome = resolvePassedDeadline(work, this.catalog, Date.now(), botSeats);
				if (outcome === 'advanced') stampPhaseDeadline(work);
				if (work.revision !== prev.revision) {
					events.push({
						commandType: 'enforceDeadline',
						payload: { type: 'enforceDeadline' },
						actorMemberId: null,
						revision: work.revision
					});
				}
			}

			// 2. Bot moves, planned/applied against the working copy (no per-command DB
			//    write — the whole tick commits once).
			if (work.status === 'active' && hasBotSeats(work, this.botMembers)) {
				const neuralPolicy = await this.getNeural();
				await stepBotSeats({
					getState: () => work,
					applyBotCommand: (actor, command) => {
						const result = applyGameCommand(work, actor, command, this.catalog);
						if (!result.ok) return Promise.resolve({ ok: false });
						if (command.type === 'commitRound') preCommitRoundStates.push(work);
						work = result.state;
						stampPhaseDeadline(work);
						applyNavLockDeadline(work);
						events.push({
							commandType: command.type,
							payload: command,
							actorMemberId: actor.memberId,
							revision: work.revision
						});
						return Promise.resolve({ ok: true });
					},
					catalog: this.catalog,
					botMembers: this.botMembers,
					neuralPolicy,
					tuning: this.tuning
				});
			}

			// 3. Bot-blocked fast-forward: a NON-navigation phase whose holdouts are all
			//    bots that made no progress this tick is pure dead time — advance now.
			if (
				work.status === 'active' &&
				events.length === 0 &&
				work.phase !== 'navigation' &&
				work.phaseDeadline != null
			) {
				const holdouts = phaseHoldoutSeats(work);
				if (
					holdouts.length > 0 &&
					!holdouts.some((seat) => !seatIsBot(work, seat, this.botMembers))
				) {
					applyDeadlineAdvance(work, this.catalog);
					stampPhaseDeadline(work);
					events.push({
						commandType: 'enforceDeadline',
						payload: { type: 'enforceDeadline', fastForward: true },
						actorMemberId: null,
						revision: work.revision
					});
				}
			}

			if (work.revision === prev.revision) return; // nothing to commit.

			if (this.persistDisabled) {
				this.state = work;
				return;
			}

			// Required side effects ride the same atomic commit (crash-recoverable).
			const outbox = effectsOutboxEvent(
				work.revision,
				computeRequiredEffects({
					prev,
					next: work,
					command: null,
					session: this.finalizeSessionRef(work),
					roundStates: preCommitRoundStates,
					timestamp: new Date().toISOString()
				})
			);
			if (outbox) events.push(outbox);

			let outcome: CommitOutcome;
			try {
				outcome = await commitRoomMutation(
					this.deps.db(),
					{
						session: {
							id: this.sessionId,
							revision: prev.revision,
							started_at: this.started_at,
							ended_at: this.ended_at
						},
						nextState: work,
						events
					},
					{ allowNonAtomicFallback: this.deps.allowNonAtomicCommit }
				);
			} catch (err) {
				console.error(`[room ${this.roomCode}] tick commit failed:`, (err as Error).message);
				return; // durable truth unchanged; next tick retries.
			}

			if (outcome.outcome === 'committed') {
				this.state = work;
				this.adoptRowStamps(outcome.row);
				await this.drainOutbox();
			} else {
				// CAS miss (or a ledger duplicate): another writer advanced the room —
				// their history wins, ours is discarded. Converge and broadcast theirs.
				await this.reloadFromDb();
			}
		});
		return this.state.revision !== startRev;
	}

	touchActivity(): void {
		this.lastActivityAt = Date.now();
	}

	/** Wall-clock of the last command/join, for idle eviction. */
	idleSince(): number {
		return this.lastActivityAt;
	}
}

/** Mirror of roomAdmission.roomVisibility: absent column ⇒ ranked private, casual public. */
function normalizeVisibility(row: { visibility?: string | null; mode?: string | null }): 'public' | 'private' {
	if (row.visibility === 'private' || row.visibility === 'public') return row.visibility;
	return row.mode === 'ranked' ? 'private' : 'public';
}

function parseState(session: PlaySessionRow): PublicGameState {
	const raw = session.public_state;
	if (raw == null) {
		throw new Error(`Session ${session.room_code} has no public_state snapshot to load.`);
	}
	if (typeof raw === 'string') return JSON.parse(raw) as PublicGameState;
	return raw;
}
