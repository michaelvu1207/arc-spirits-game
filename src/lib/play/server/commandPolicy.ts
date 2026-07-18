/**
 * Deny-by-default, transport-neutral command admission — the ONE policy gate every
 * externally-submitted command passes BEFORE the reducer, on BOTH transports (the
 * SvelteKit HTTP routes and the standalone WebSocket room server import this same
 * module). A rejection here writes nothing: revision, state hash, ledger, outbox and
 * ratings are untouched, and the caller gets a stable structured error.
 *
 * Tiers (explicit allowlists — an unknown or new command type is DENIED until it is
 * deliberately classified here):
 *
 *  - PLAYER_COMMANDS  — real rules-driven play commands any seated member (human or
 *    server-driven bot) may submit in their mode. The reducer still enforces seat/
 *    phase/turn legality; this gate only decides whether the TYPE is submittable at all.
 *  - LOBBY_COMMANDS   — casual lobby assembly. Ranked lobbies are assembled entirely
 *    server-side by the matchmaker, so NONE of these are wire-admissible in ranked.
 *  - HOST_TOOLS       — the host's manual rescue lever (forceAdvancePhase). Casual
 *    only: ranked rejects every host/admin/freeform rescue path — the server's own
 *    deadline enforcement is the only phase authority in a rated game.
 *  - INTEGRITY_TOOLS  — internal/manual instruments (free counters, spirit flips,
 *    dice/mat spawning, market shortcuts, commitRound, debugGrant, …). NEVER
 *    admissible from production external callers on any transport; available only
 *    behind an explicit dev/test opt-in, and never in ranked even then.
 *
 * No wire field can confer trust: the context (mode, role, seat, bot-ness) is derived
 * server-side from the authoritative session/state, never from the request.
 */

import type { GameCommand } from '../types';

/** Play-mode subset the policy needs (mirrors service.ts PlayMode). */
export type PolicyPlayMode = 'casual' | 'ranked';

export interface CommandAdmissionContext {
	mode: PolicyPlayMode;
	/** The caller's authoritative role from their member row. */
	role: 'host' | 'player' | 'spectator';
	/** Whether the caller currently holds a seat in the AUTHORITATIVE state. */
	seated: boolean;
	/** True when the acting member row is a disclosed bot. Bots act exclusively
	 *  through the server's own driver — a bot identity arriving over the wire is
	 *  always an impersonation attempt and is refused. */
	isBot: boolean;
	/**
	 * Explicit dev/test opt-in for the integrity tools (SvelteKit `dev`, or the room
	 * server's ARC_WS_ALLOW_DEBUG_SEED test mode). Production wire boundaries MUST
	 * pass false. Never unlocks anything in ranked.
	 */
	allowIntegrityTools: boolean;
}

export interface CommandRejection {
	ok: false;
	code:
		| 'forbidden_command'
		| 'unknown_command'
		| 'spectators_cannot_command'
		| 'bot_identity_forbidden'
		| 'host_only'
		| 'ranked_forbids_host_tools'
		| 'malformed_command';
	message: string;
}

export type CommandAdmission = { ok: true } | CommandRejection;

/** Rules-driven play commands (casual + ranked, seated members). */
export const PLAYER_COMMANDS: ReadonlySet<string> = new Set([
	'selectNavigationDestination',
	'lockNavigation',
	'unlockNavigation',
	'passEncounter',
	'startCombat',
	'initiatePvp',
	'resolveMonsterReward',
	'resolveLocationInteraction',
	'endLocationActions',
	'resolveDecision',
	'commitBenefits',
	'commitAwakening',
	'commitCleanup',
	'resolveAwakenReward',
	'awakenSpirit',
	'manualAwaken',
	'dismissManualPrompt',
	'spawnHandSpirit',
	'discardHandDraws',
	'redrawHandDraws',
	'discardSpirit',
	'discardRune',
	'infiltratorSwap',
	'placeAugmentOnSpirit',
	'discardUnplacedAugments'
]);

/** Casual lobby assembly. Ranked lobbies are server-assembled: none of these admit. */
export const LOBBY_COMMANDS: ReadonlySet<string> = new Set([
	'claimSeat',
	'releaseSeat',
	'selectGuardian',
	'setNavigationTimer',
	'startGame'
]);

/** Host-only manual rescue. Casual only — ranked rejects it unconditionally. */
export const HOST_TOOLS: ReadonlySet<string> = new Set(['forceAdvancePhase']);

/** Host-only members of LOBBY_COMMANDS (defense-in-depth on top of the reducer). */
const HOST_ONLY_LOBBY: ReadonlySet<string> = new Set(['startGame', 'setNavigationTimer']);

/**
 * Internal/manual instruments: arbitrary counter/status/resource changes, free spirit
 * flips, dice/mat spawning-moving-clearing, market shortcuts, the round-commit
 * bypass, and god-mode grants. Production external callers can never submit these;
 * dev/test opt-in only, and never in ranked.
 */
export const INTEGRITY_TOOLS: ReadonlySet<string> = new Set([
	'adjustVictoryPoints',
	'adjustBarrier',
	'adjustBrokenBarrier',
	'adjustMaxBarrier',
	'adjustStatus',
	'flipSpirit',
	'absorbSpirit',
	'takeSpirit',
	'replaceSpirit',
	'refillMarket',
	'moveRuneToSlot',
	'attachRuneToSpirit',
	'detachRuneFromSpirit',
	'spawnDiceBatch',
	'rollSpawnedDice',
	'clearSpawnedDice',
	'spawnMatItem',
	'clearSpawnedItems',
	'moveMatObject',
	'commitRound',
	'debugGrant'
]);

/**
 * THE production integrity gate, shared verbatim by both transports so neither can
 * drift: NODE_ENV=production refuses the integrity tools UNCONDITIONALLY — no
 * environment flag (ARC_WS_ALLOW_DEBUG_SEED / ARC_ALLOW_INTEGRITY_COMMANDS
 * included) can re-open them on a deployed stack.
 *
 *  - HTTP boundary (service.ts): every non-production stack qualifies via NODE_ENV
 *    alone (SvelteKit dev/e2e/bench).
 *  - WS boundary (server/connections.ts): additionally requires the explicit
 *    local-test opt-in flags, because the standalone room server has no dev-mode
 *    notion of its own.
 */
export function httpIntegrityToolsAllowed(env: Record<string, string | undefined> = process.env): boolean {
	return env.NODE_ENV !== 'production';
}

export function wsIntegrityToolsAllowed(env: Record<string, string | undefined> = process.env): boolean {
	if (env.NODE_ENV === 'production') return false;
	return env.ARC_WS_ALLOW_DEBUG_SEED === '1' || env.ARC_ALLOW_INTEGRITY_COMMANDS === '1';
}

/** Bounded client idempotency key: 1–128 printable non-whitespace ASCII chars. The
 *  SAME validation on both transports — HTTP routes and WS frames. */
const CMD_ID_PATTERN = /^[!-~]{1,128}$/;

export function isValidCmdId(value: unknown): value is string {
	return typeof value === 'string' && CMD_ID_PATTERN.test(value);
}

/** Upper bound on a single serialized command payload (wire-schema sanity, not a
 *  rules check — legitimate commands are tiny). */
export const MAX_COMMAND_JSON_BYTES = 16_384;

/**
 * Wire-shape validation shared by both transports: a command must be a plain JSON
 * object with a bounded string `type`, of bounded total size. Deep per-field legality
 * stays with the reducer.
 */
export function validateCommandShape(command: unknown): command is GameCommand {
	if (command == null || typeof command !== 'object' || Array.isArray(command)) return false;
	const type = (command as { type?: unknown }).type;
	if (typeof type !== 'string' || type.length === 0 || type.length > 64) return false;
	try {
		if (JSON.stringify(command).length > MAX_COMMAND_JSON_BYTES) return false;
	} catch {
		return false; // circular / non-serializable — never a legitimate wire command
	}
	return true;
}

function reject(code: CommandRejection['code'], message: string): CommandRejection {
	return { ok: false, code, message };
}

/**
 * The admission decision for one externally-submitted command. Call at the wire
 * boundary AFTER authenticating the actor and deriving `ctx` from authoritative
 * server state, BEFORE the reducer. Deny-by-default.
 */
export function admitCommand(ctx: CommandAdmissionContext, command: unknown): CommandAdmission {
	if (!validateCommandShape(command)) {
		return reject('malformed_command', 'Malformed command payload.');
	}
	const type = (command as { type: string }).type;

	if (ctx.isBot) {
		return reject(
			'bot_identity_forbidden',
			'Bot members are driven exclusively by the server — a bot identity cannot submit wire commands.'
		);
	}

	if (INTEGRITY_TOOLS.has(type)) {
		// Never in ranked, never in production. Dev/test opt-in only (and even there,
		// only for casual rooms — a rated transcript must stay clean).
		if (ctx.mode !== 'casual' || !ctx.allowIntegrityTools) {
			return reject('forbidden_command', `The "${type}" command is not available.`);
		}
		if (ctx.role === 'spectator' && !ctx.seated) {
			return reject('spectators_cannot_command', 'Spectators cannot submit commands.');
		}
		return { ok: true };
	}

	if (HOST_TOOLS.has(type)) {
		if (ctx.mode === 'ranked') {
			return reject(
				'ranked_forbids_host_tools',
				'Ranked games have no manual rescue: phase timing is enforced by the server.'
			);
		}
		if (ctx.role !== 'host') {
			return reject('host_only', `Only the host can use "${type}".`);
		}
		return { ok: true };
	}

	if (LOBBY_COMMANDS.has(type)) {
		if (ctx.mode === 'ranked') {
			return reject(
				'ranked_forbids_host_tools',
				'Ranked lobbies are assembled by the matchmaker; lobby commands are not accepted.'
			);
		}
		if (HOST_ONLY_LOBBY.has(type) && ctx.role !== 'host') {
			return reject('host_only', `Only the host can use "${type}".`);
		}
		return { ok: true };
	}

	if (PLAYER_COMMANDS.has(type)) {
		// A member must hold a seat (or be the host running their own seat) to play.
		// Spectators can watch, chat and (in casual) claim a seat — never act on one.
		if (!ctx.seated) {
			return reject('spectators_cannot_command', 'Take a seat before submitting play commands.');
		}
		return { ok: true };
	}

	return reject('unknown_command', `Unknown command type "${type}".`);
}

/**
 * Command types that must never appear in a rated transcript. Used by ranked
 * finalization to QUARANTINE a transcript that somehow contains one (a defense in
 * depth behind the wire gate above): the match is recorded but never rated.
 */
export const RANKED_FORBIDDEN_LEDGER_TYPES: ReadonlySet<string> = new Set([
	...INTEGRITY_TOOLS,
	...HOST_TOOLS
]);
