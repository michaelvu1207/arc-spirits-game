/**
 * Server-side driver for live room bots. A human hosts a live game; bots take
 * the remaining seats and, each phase, choose legal actions through the shared
 * bot contract. The trained ML policy is the normal path; uniform legal action
 * selection is only a no-weights safety fallback.
 *
 * EPHEMERAL by design: this module never calls `commitRound` and never writes
 * history snapshots — it only drives the in-memory phase machine via the normal
 * `runRoomCommand` path. Bots are identified WITHOUT a DB migration by a
 * recognizable display-name prefix (see {@link BOT_NAME_PREFIX}).
 *
 * All mutation goes through the server-authoritative `runRoomCommand`, which
 * loads fresh state, applies one command, and CAS-persists. We issue bot
 * commands SEQUENTIALLY (await each) to avoid compare-and-set churn.
 */

import {
	enforceRoomDeadlines,
	getSessionIdByRoomCode,
	getSessionModeByRoomCode,
	joinRoom,
	loadBotMembers,
	loadRawRoomState,
	loadRoomView,
	runRoomCommand,
	type RoomView
} from './service';
import { botSeatNeedsToAct } from './botPolicy';
import { loadPlayCatalog } from './catalog';
import { SEAT_COLORS, type SeatColor, type PublicGameState, type GameCommand } from '../types';
import { BOT_NAME_PREFIX } from '../roomLifecycle';
import {
	DEFAULT_BOT_PROFILE_KEY,
	EXPERT_BOT_PROFILE_KEY,
	ML_BOT_PROFILE_KEY,
	normalizeBotProfileKey
} from '../bots/contract';
import {
	getNeuralPolicy,
	planNeuralPhaseActions,
	planUniformLegalPhaseActions
} from '../ml/neuralBot';

/** Backward-compatible export for older callers/tests. New code should import
 *  ML_BOT_PROFILE_KEY from bots/contract. */
export const NEURAL_PROFILE_KEY = ML_BOT_PROFILE_KEY;

/** Display-name prefix that marks a session member as a bot. Single source of truth
 *  lives in the pure room-lifecycle policy (it excludes bots from room presence);
 *  re-exported here for existing callers. */
export { BOT_NAME_PREFIX };

/** Number of seats a "full table" targets. */
export const TARGET_SEAT_COUNT = 4;

/** True if a display name belongs to a bot member. */
export function isBotDisplayName(displayName: string | null | undefined): boolean {
	return typeof displayName === 'string' && displayName.startsWith(BOT_NAME_PREFIX);
}

/**
 * Bot display name — every bot presents as an anonymous "Nameless Spirit" so a human
 * can't tell them apart by name. Identity + strategy come from the DB (`is_bot` /
 * `bot_profile`), never the display name, so this is purely cosmetic. `seat`/`difficulty`
 * are kept in the signature for callers but no longer affect the name.
 */
export function botDisplayNameFor(
	_seat: SeatColor,
	_difficulty: string = DEFAULT_BOT_PROFILE_KEY
): string {
	return 'Nameless Spirit';
}

/** Coerce a legacy difficulty string to the live bot contract key. */
function normalizeDifficulty(difficulty: string | null | undefined): string {
	return normalizeBotProfileKey(difficulty);
}

/**
 * Parse the difficulty/strategy word out of a bot's display name (the word
 * between the "🤖 " prefix and the seat color), normalized to a known
 * live bot contract key. Legacy heuristic names are intentionally normalized to
 * the ML policy so old display names cannot re-enable strategic heuristics.
 */
export function difficultyFromBotName(displayName: string | null | undefined): string {
	if (!isBotDisplayName(displayName)) return DEFAULT_BOT_PROFILE_KEY;
	const rest = (displayName as string).slice(BOT_NAME_PREFIX.length).trim();
	const parts = rest.split(/\s+/);
	// "Blue" -> no word; "Medium Blue" -> legacy word. Both normalize to neural.
	if (parts.length < 2) return DEFAULT_BOT_PROFILE_KEY;
	return normalizeDifficulty(parts[0]);
}

/**
 * Is the member seated at `seat` a bot? Authoritative source is the `botMembers` map
 * (member ids loaded from the `is_bot` column — the ONLY way to detect a human-named
 * matchmaking bot), with the legacy 🤖-display-name as a fallback so a seat whose member
 * predates the column is still recognized. `botMembers` omitted ⇒ name-only (legacy).
 */
function seatIsBot(
	state: PublicGameState,
	seat: SeatColor,
	botMembers?: Map<string, string | null>
): boolean {
	const memberId = state.seats[seat]?.memberId;
	if (memberId == null) return false;
	if (botMembers?.has(memberId)) return true;
	return isBotDisplayName(state.seats[seat]?.displayName);
}

/** Seats currently occupied by a bot member, in seat order. Pass the session's bot-member
 *  map (memberId → profile) so human-named bots are detected; omit for legacy name-only. */
export function seatedBotSeats(
	state: PublicGameState,
	botMembers?: Map<string, string | null>
): SeatColor[] {
	return SEAT_COLORS.filter((seat) => seatIsBot(state, seat, botMembers));
}

/** The bot member id seated at `seat`, or null. */
function botMemberIdAt(
	state: PublicGameState,
	seat: SeatColor,
	botMembers?: Map<string, string | null>
): string | null {
	if (!seatIsBot(state, seat, botMembers)) return null;
	return state.seats[seat]?.memberId ?? null;
}

/** Guardian names already taken by any seat, lobby-wide. */
function takenGuardians(state: PublicGameState): Set<string> {
	const taken = new Set<string>();
	for (const seat of SEAT_COLORS) {
		const guardian = state.seats[seat]?.selectedGuardian;
		if (guardian) taken.add(guardian);
	}
	return taken;
}

export interface FillBotsOptions {
	/** How many occupied seats to target (default 4). Clamped to [1, 6]. */
	targetSeats?: number;
	/** Bot policy key for the bots minted (default 'neural'). */
	difficulty?: string;
	/** Shuffle the guardian pool before assigning bot guardians. */
	shuffleGuardians?: boolean;
}

function shuffled<T>(items: T[]): T[] {
	const next = [...items];
	for (let i = next.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[next[i], next[j]] = [next[j], next[i]];
	}
	return next;
}

/**
 * Host-only: fill empty seats with bots until the room has `targetSeats`
 * occupied seats (default 4). The room MUST still be in the lobby. For each
 * needed seat we mint a spectator via `joinRoom`, then claim the seat and select
 * a distinct unused guardian — all as that bot member. Does NOT auto-start the
 * game; the human host starts it via the existing button.
 *
 * Returns the host's updated {@link RoomView}.
 */
export async function fillBots(
	roomCode: string,
	hostMemberId: string,
	opts: FillBotsOptions = {}
): Promise<RoomView> {
	const hostView = await loadRoomView(roomCode, hostMemberId);
	if (hostView.member.role !== 'host') {
		throw new Error('Only the host can add bots.');
	}
	if ((await getSessionModeByRoomCode(roomCode)) === 'ranked') {
		throw new Error('Bots are not allowed in ranked games.');
	}

	const target = Math.max(1, Math.min(SEAT_COLORS.length, opts.targetSeats ?? TARGET_SEAT_COUNT));
	const difficulty = opts.difficulty ?? DEFAULT_BOT_PROFILE_KEY;

	let state = await loadRawRoomState(roomCode);
	if (state.status !== 'lobby') {
		throw new Error('Bots can only be added while the room is in the lobby.');
	}

	const guardianPool = opts.shuffleGuardians ? shuffled(state.guardianPool) : [...state.guardianPool];

	for (const seat of SEAT_COLORS) {
		const occupied = SEAT_COLORS.filter(
			(candidate) => state.seats[candidate]?.memberId != null
		).length;
		if (occupied >= target) break;
		if (state.seats[seat]?.memberId != null) continue;

		// 1) Mint a spectator member for this bot (no cookie — server holds the id). The
		//    is_bot flag + bot_profile drive detection/strategy off the DB, not the 🤖 name.
		const { memberId: botMemberId } = await joinRoom(
			roomCode,
			botDisplayNameFor(seat, difficulty),
			null,
			{
				isBot: true,
				botProfile: normalizeDifficulty(difficulty)
			}
		);

		// 2) Claim the seat as the bot.
		await runRoomCommand({
			roomCode,
			memberId: botMemberId,
			expectedRevision: null,
			command: { type: 'claimSeat', seatColor: seat }
		});

		// 3) Select a distinct, unused guardian from the pool.
		state = await loadRawRoomState(roomCode);
		const used = takenGuardians(state);
		const guardian = guardianPool.find((name) => !used.has(name));
		if (guardian) {
			await runRoomCommand({
				roomCode,
				memberId: botMemberId,
				expectedRevision: null,
				command: { type: 'selectGuardian', guardianName: guardian }
			});
		}

		state = await loadRawRoomState(roomCode);
	}

	return loadRoomView(roomCode, hostMemberId);
}

/**
 * Seat a single bot at `seat` and pick it a distinct guardian. Always marks the new
 * member as a bot (is_bot=true) carrying `difficulty` as its bot_profile, so detection +
 * strategy are flag-driven regardless of the display name.
 *
 * `opts.userId` attaches a REAL account to the bot (the matchmaking path — the bot then
 * appears on the leaderboard + affects ratings). `opts.displayName` overrides the default
 * 🤖 name with a human-looking one. Casual host bots pass neither (null user, 🤖 name).
 *
 * Returns the new bot member id. This is the single reusable bot-seating primitive; it is
 * intentionally NOT gated by the ranked guard (that guard lives on the host-facing
 * fillBots/addBot entry points), so Phase 2 matchmaking can backfill ranked seats with it.
 */
async function seatOneBot(
	roomCode: string,
	seat: SeatColor,
	guardianName?: string,
	difficulty: string = DEFAULT_BOT_PROFILE_KEY,
	opts?: { userId?: string | null; displayName?: string }
): Promise<string> {
	const profile = normalizeDifficulty(difficulty);
	const displayName = opts?.displayName ?? botDisplayNameFor(seat, difficulty);
	const { memberId: botMemberId } = await joinRoom(roomCode, displayName, opts?.userId ?? null, {
		isBot: true,
		botProfile: profile
	});
	await runRoomCommand({
		roomCode,
		memberId: botMemberId,
		expectedRevision: null,
		command: { type: 'claimSeat', seatColor: seat }
	});
	const state = await loadRawRoomState(roomCode);
	const used = takenGuardians(state);
	const guardian =
		guardianName && !used.has(guardianName)
			? guardianName
			: state.guardianPool.find((name) => !used.has(name));
	if (guardian) {
		await runRoomCommand({
			roomCode,
			memberId: botMemberId,
			expectedRevision: null,
			command: { type: 'selectGuardian', guardianName: guardian }
		});
	}
	return botMemberId;
}

/**
 * Seat a bot carrying a REAL account into a session — the ranked-backfill primitive
 * Phase 2's matchmaker calls to fill an under-full ranked lobby with persistent bot
 * players. Unlike the host-facing fillBots/addBot, this is NOT blocked by the
 * "no bots in ranked" guard: these bots are rated, leaderboard-visible accounts that
 * the matchmaker (not a host) introduces. Returns the new bot member id.
 *
 * NOT wired into matchmaking in Phase 1 — exported for Phase 2.
 */
export async function seatBotPlayer(
	roomCode: string,
	seat: SeatColor,
	args: { userId: string; displayName: string; botProfile?: string; guardianName?: string }
): Promise<string> {
	return seatOneBot(roomCode, seat, args.guardianName, args.botProfile ?? DEFAULT_BOT_PROFILE_KEY, {
		userId: args.userId,
		displayName: args.displayName
	});
}

/** Host-only: add ONE bot to the first open seat (or `opts.seat` if it's open). */
export async function addBot(
	roomCode: string,
	hostMemberId: string,
	opts: { seat?: SeatColor; guardianName?: string; difficulty?: string } = {}
): Promise<RoomView> {
	const hostView = await loadRoomView(roomCode, hostMemberId);
	if (hostView.member.role !== 'host') throw new Error('Only the host can add bots.');
	if ((await getSessionModeByRoomCode(roomCode)) === 'ranked') {
		throw new Error('Bots are not allowed in ranked games.');
	}

	const state = await loadRawRoomState(roomCode);
	if (state.status !== 'lobby') {
		throw new Error('Bots can only be added while the room is in the lobby.');
	}
	const open = SEAT_COLORS.filter((s) => state.seats[s]?.memberId == null);
	if (open.length === 0) throw new Error('Every seat is already filled.');
	const seat = opts.seat && open.includes(opts.seat) ? opts.seat : open[0];

	await seatOneBot(roomCode, seat, opts.guardianName, opts.difficulty ?? DEFAULT_BOT_PROFILE_KEY);
	return loadRoomView(roomCode, hostMemberId);
}

/** Host-only: set the guardian for the bot seated at `seat`. */
export async function setBotGuardian(
	roomCode: string,
	hostMemberId: string,
	seat: SeatColor,
	guardianName: string
): Promise<RoomView> {
	const hostView = await loadRoomView(roomCode, hostMemberId);
	if (hostView.member.role !== 'host') throw new Error('Only the host can set a bot guardian.');

	const state = await loadRawRoomState(roomCode);
	if (state.status !== 'lobby') throw new Error('Guardians can only be set in the lobby.');
	const sessionId = await getSessionIdByRoomCode(roomCode);
	const botMembers = sessionId ? await loadBotMembers(sessionId) : undefined;
	const botMemberId = botMemberIdAt(state, seat, botMembers);
	if (!botMemberId) throw new Error('That seat is not a bot.');

	await runRoomCommand({
		roomCode,
		memberId: botMemberId,
		expectedRevision: null,
		command: { type: 'selectGuardian', guardianName }
	});
	return loadRoomView(roomCode, hostMemberId);
}

/** Host-only: remove the bot seated at `seat` (frees the seat). */
export async function removeBot(
	roomCode: string,
	hostMemberId: string,
	seat: SeatColor
): Promise<RoomView> {
	const hostView = await loadRoomView(roomCode, hostMemberId);
	if (hostView.member.role !== 'host') throw new Error('Only the host can remove bots.');

	const state = await loadRawRoomState(roomCode);
	if (state.status !== 'lobby') throw new Error('Bots can only be removed in the lobby.');
	const sessionId = await getSessionIdByRoomCode(roomCode);
	const botMembers = sessionId ? await loadBotMembers(sessionId) : undefined;
	const botMemberId = botMemberIdAt(state, seat, botMembers);
	if (!botMemberId) throw new Error('That seat is not a bot.');

	await runRoomCommand({
		roomCode,
		memberId: botMemberId,
		expectedRevision: null,
		command: { type: 'releaseSeat', seatColor: seat }
	});
	return loadRoomView(roomCode, hostMemberId);
}

export interface TickBotsResult {
	view: RoomView;
	/** Total commands issued across all bot seats this tick. */
	commandsIssued: number;
}

/**
 * Advance every seated bot through the CURRENT phase ONCE. Loads fresh state; if
 * the game is not active (lobby/finished), it is a no-op. For each bot seat that
 * still needs to act this phase, computes its random-legal command list via the
 * bot policy and issues each command sequentially as that bot member.
 *
 * Does NOT loop to completion — the client calls this repeatedly while a human
 * plays, so a single tick just nudges the bots past the current phase gate.
 * Never commits a round or writes history.
 *
 * Returns the host's updated {@link RoomView} plus a count of commands issued.
 */
export async function tickBots(roomCode: string, hostMemberId?: string): Promise<TickBotsResult> {
	const catalog = await loadPlayCatalog();
	let state = await loadRawRoomState(roomCode);

	if (state.status !== 'active') {
		const view = await loadRoomView(roomCode, hostMemberId ?? null);
		return { view, commandsIssued: 0 };
	}

	// Run the deadline drain up front. runRoomCommand does this too, but a bot with NO legal
	// plan issues zero commands — if the humans are also idle (waiting on that bot), nothing
	// would ever trigger the drain and the room would hang. The poll tick is the one thing
	// guaranteed to keep firing, so it must be able to unstick the room by itself.
	await enforceRoomDeadlines(roomCode);
	state = await loadRawRoomState(roomCode);
	if (state.status !== 'active') {
		const view = await loadRoomView(roomCode, hostMemberId ?? null);
		return { view, commandsIssued: 0 };
	}

	// Authoritative bot identity + strategy comes from the DB (`is_bot` / `bot_profile`),
	// not the display name — so a human-named matchmaking bot is still driven here. Loaded
	// once per tick (the seats don't change mid-tick); empty map ⇒ falls back to 🤖 names.
	const sessionId = await getSessionIdByRoomCode(roomCode);
	const botMembers = sessionId ? await loadBotMembers(sessionId) : new Map<string, string | null>();

	// Trained ML policy, loaded once per tick. Null when no weights are bundled; in that
	// case the live bot uses the same legal-action contract with uniform selection, not
	// the retired strategic heuristic profiles.
	const neuralPolicy = await getNeuralPolicy();

	let commandsIssued = 0;

	for (const seat of seatedBotSeats(state, botMembers)) {
		const botMemberId = botMemberIdAt(state, seat, botMembers);
		if (!botMemberId) continue;
		if (!botSeatNeedsToAct(state, seat)) continue;

		// Strategy comes from the member's bot_profile column; fall back to parsing the
		// legacy 🤖-display-name when a bot row predates the column (bot_profile null).
		const profileKey = normalizeDifficulty(
			botMembers.get(botMemberId) ?? difficultyFromBotName(state.seats[seat]?.displayName)
		);
		// ARC_EXPERT_BOTS=1 upgrades every neural bot to the expert (search) tier —
		// the dev-server switch for playtesting the searched bot without UI work.
		// WARNING (measured 2026-07-08, v13-2 on gauntlet-v10): search16 scores BELOW
		// the raw policy (399 vs 453 argmax; 374 vs 385 at temp 0.65) — the heuristic
		// rollout policy misevaluates rules-v1.3 positions and poisons the search
		// values. Don't enable for strength until the rollout policy is fixed.
		const expert =
			profileKey === EXPERT_BOT_PROFILE_KEY ||
			(profileKey === NEURAL_PROFILE_KEY && process.env.ARC_EXPERT_BOTS === '1');
		// Live sampling temperature (default 0.65, ARC_LIVE_BOT_TEMP overrides; 0 = argmax).
		// Multiple greedy clones in one room chase the same plan and split the shared
		// monster ladder — but that collision happens at ROUTE choice, so the temperature
		// applies to navigation picks only by default (ARC_LIVE_BOT_TEMP_SCOPE=all restores
		// all-phase sampling). Measured (v13-2, gauntlet-v10 + 4-copy mirror): nav-only 0.65
		// = Elo 432 / reach-30 43.5% vs all-phase 0.65 = 385 / 41.3% vs argmax = 453 / 19.5%.
		// See NeuralPlanOptions.temperature/temperatureScope.
		const liveTemp =
			process.env.ARC_LIVE_BOT_TEMP !== undefined
				? parseFloat(process.env.ARC_LIVE_BOT_TEMP)
				: 0.65;
		const liveTempScope: 'all' | 'navigation' =
			process.env.ARC_LIVE_BOT_TEMP_SCOPE === 'all' ? 'all' : 'navigation';
		// A planner exception must never escape: it would abort the whole tick (HTTP 500) and
		// strand this seat AND every seat after it, forever (ticks re-plan seats in order, so a
		// deterministic throw repeats every poll). Degrade to uniform-legal for the seat; if
		// even that throws, skip the seat this tick and let the deadline drain advance it.
		let commands: GameCommand[];
		try {
			commands =
				(profileKey === NEURAL_PROFILE_KEY || profileKey === EXPERT_BOT_PROFILE_KEY) && neuralPolicy
					? planNeuralPhaseActions(state, seat, catalog, neuralPolicy, {
							search: expert,
							temperature: liveTemp,
							temperatureScope: liveTempScope
						})
					: planUniformLegalPhaseActions(state, seat, catalog);
		} catch (err) {
			console.error(`[botSim] planner threw for seat ${seat}; degrading to uniform`, err);
			try {
				commands = planUniformLegalPhaseActions(state, seat, catalog);
			} catch (fallbackErr) {
				console.error(`[botSim] uniform fallback also threw for seat ${seat}; skipping`, fallbackErr);
				commands = [];
			}
		}
		for (const command of commands) {
			// Each command is its own load+CAS write. A planned command can be REJECTED at
			// execution time even though it passed the planner's trial-apply — e.g. the
			// leading enforceRoomDeadlines in runRoomCommand advances the phase between
			// planning and execution (the queued command is now wrong_phase), or a
			// concurrent human/poller write shifts the state out from under the plan. A
			// rejected command throws, so swallow it per-command: stop issuing THIS seat's
			// remaining (now-stale) commands and move on, instead of aborting the whole tick
			// and stranding every later bot seat unready until the phase deadline bails it
			// out. The next tick re-plans against fresh state and emits the right commit.
			try {
				await runRoomCommand({
					roomCode,
					memberId: botMemberId,
					expectedRevision: null,
					command
				});
				commandsIssued += 1;
			} catch {
				break;
			}
		}

		// Re-load so the next bot sees the freshest state (phase may have advanced).
		state = await loadRawRoomState(roomCode);
		if (state.status !== 'active') break;
	}

	const view = await loadRoomView(roomCode, hostMemberId ?? null);
	return { view, commandsIssued };
}
