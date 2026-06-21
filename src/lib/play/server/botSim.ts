/**
 * Server-side driver for the dev "fill the empty seats with random-action bots"
 * feature. A human hosts a live game; bots take the remaining seats and, each
 * phase, take RANDOM LEGAL actions and become ready so the round loop advances.
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
	getSessionModeByRoomCode,
	joinRoom,
	loadRawRoomState,
	loadRoomView,
	runRoomCommand,
	type RoomView
} from './service';
import { planBotPhaseActions, botSeatNeedsToAct, profileFor, BOT_PROFILES } from './botPolicy';
import { loadPlayCatalog } from './catalog';
import { SEAT_COLORS, type SeatColor, type PublicGameState } from '../types';
import { BOT_NAME_PREFIX } from '../roomLifecycle';

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
 * Conventional bot display name for a seat, e.g. "🤖 Blue" (random) or
 * "🤖 Medium Blue" (strategic). The difficulty word rides BETWEEN the emoji
 * prefix and the seat color so it survives a DB round-trip with no migration;
 * 'random' (retired as a selectable option) emits no word — the legacy "🤖 Blue" form; the
 * designed tiers emit their name, e.g. "🤖 Medium Blue". Default is now 'medium'.
 */
export function botDisplayNameFor(seat: SeatColor, difficulty: string = 'medium'): string {
	const key = normalizeDifficulty(difficulty);
	if (key === 'random') return `${BOT_NAME_PREFIX}${seat}`;
	// Title-case the key for display, e.g. "medium" → "Medium".
	const word = key.charAt(0).toUpperCase() + key.slice(1);
	return `${BOT_NAME_PREFIX}${word} ${seat}`;
}

/** Coerce a difficulty string to a known {@link BOT_PROFILES} key, defaulting to the designed-
 *  ladder baseline 'medium' (the legacy random-legal bot is no longer offered as an option). */
function normalizeDifficulty(difficulty: string | null | undefined): string {
	if (typeof difficulty !== 'string') return 'medium';
	const key = difficulty.toLowerCase();
	return key in BOT_PROFILES ? key : 'medium';
}

/**
 * Parse the difficulty/strategy word out of a bot's display name (the word
 * between the "🤖 " prefix and the seat color), normalized to a known
 * {@link BOT_PROFILES} key. Defaults to the designed baseline 'medium' when absent/unknown
 * (a word-less "🤖 Blue" plays as Medium, never the retired dumb random-legal bot).
 */
export function difficultyFromBotName(displayName: string | null | undefined): string {
	if (!isBotDisplayName(displayName)) return 'medium';
	const rest = (displayName as string).slice(BOT_NAME_PREFIX.length).trim();
	const parts = rest.split(/\s+/);
	// "Blue" → no word → Medium baseline; "Medium Blue" → "Medium".
	if (parts.length < 2) return 'medium';
	return normalizeDifficulty(parts[0]);
}

/** Seats currently occupied by a bot member, in seat order. */
export function seatedBotSeats(state: PublicGameState): SeatColor[] {
	return SEAT_COLORS.filter(
		(seat) =>
			state.seats[seat]?.memberId != null && isBotDisplayName(state.seats[seat]?.displayName)
	);
}

/** The bot member id seated at `seat`, or null. */
function botMemberIdAt(state: PublicGameState, seat: SeatColor): string | null {
	if (!isBotDisplayName(state.seats[seat]?.displayName)) return null;
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
	/** Strategy/difficulty for the bots minted, e.g. 'medium' (default 'medium'). */
	difficulty?: string;
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
	const difficulty = opts.difficulty ?? 'medium';

	let state = await loadRawRoomState(roomCode);
	if (state.status !== 'lobby') {
		throw new Error('Bots can only be added while the room is in the lobby.');
	}

	const guardianPool = [...state.guardianPool];

	for (const seat of SEAT_COLORS) {
		const occupied = SEAT_COLORS.filter(
			(candidate) => state.seats[candidate]?.memberId != null
		).length;
		if (occupied >= target) break;
		if (state.seats[seat]?.memberId != null) continue;

		// 1) Mint a spectator member for this bot (no cookie — server holds the id).
		const { memberId: botMemberId } = await joinRoom(roomCode, botDisplayNameFor(seat, difficulty));

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

/** Seat a single bot at `seat`, optionally with a preferred (unused) guardian. */
async function seatOneBot(
	roomCode: string,
	seat: SeatColor,
	guardianName?: string,
	difficulty: string = 'medium'
): Promise<void> {
	const { memberId: botMemberId } = await joinRoom(roomCode, botDisplayNameFor(seat, difficulty));
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

	await seatOneBot(roomCode, seat, opts.guardianName, opts.difficulty ?? 'medium');
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
	const botMemberId = botMemberIdAt(state, seat);
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
	const botMemberId = botMemberIdAt(state, seat);
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

	let commandsIssued = 0;

	for (const seat of seatedBotSeats(state)) {
		const botMemberId = botMemberIdAt(state, seat);
		if (!botMemberId) continue;
		if (!botSeatNeedsToAct(state, seat)) continue;

		// The bot's strategy rides in its display name (e.g. "🤖 Medium Blue");
		// parse it back to a profile. Random bots ("🤖 Blue") stay random.
		const difficulty = difficultyFromBotName(state.seats[seat]?.displayName);
		const commands = planBotPhaseActions(state, seat, catalog, undefined, profileFor(difficulty));
		for (const command of commands) {
			await runRoomCommand({
				roomCode,
				memberId: botMemberId,
				expectedRevision: null,
				command
			});
			commandsIssued += 1;
		}

		// Re-load so the next bot sees the freshest state (phase may have advanced).
		state = await loadRawRoomState(roomCode);
		if (state.status !== 'active') break;
	}

	const view = await loadRoomView(roomCode, hostMemberId ?? null);
	return { view, commandsIssued };
}
