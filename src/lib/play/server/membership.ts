/**
 * Canonical room membership — validated Supabase identity is the SOLE durable human
 * principal.
 *
 *  - A HUMAN membership always carries the validated `user_id` (permanent account or
 *    an automatically-created anonymous account). There is exactly ONE human
 *    membership per (session, user): duplicate/concurrent create, join, matchmaking,
 *    recovery and rematch calls all converge idempotently on the same row (enforced
 *    by the partial unique index in the 20260710_identity_trust migration and by the
 *    lost-race re-read below).
 *  - The PUBLIC member UUID (`play_session_members.id`) is a display label only. It
 *    never authorizes anything, on any transport.
 *  - BOTS are explicitly disclosed server-only actors (`is_bot = true`); they are
 *    exempt from the uniqueness rule and can never be created or exercised from the
 *    wire.
 *  - Sign-out / account transition drops room authority IMMEDIATELY: every request
 *    re-resolves membership from the CURRENT validated user; nothing durable in the
 *    browser can hand one user's membership to another.
 *
 * Framework-free (injected client) so the SvelteKit service, the room server, and
 * the in-memory test fakes all share one implementation.
 */

import type { PlayDbClient } from './commit';

export const MEMBERS_TABLE = 'play_session_members';

export interface EnsureMembershipParams {
	sessionId: string;
	/** Validated Supabase user id. REQUIRED for humans; null only for bots. */
	userId: string | null;
	displayName: string;
	role?: 'host' | 'player' | 'spectator';
	isBot?: boolean;
	botProfile?: string | null;
	/** The client-minted ENTRY-OP id this membership is being created FOR (see
	 *  20260712_entry_op_compensation.sql). Stamped only when this call actually
	 *  CREATES the row — an idempotent reuse keeps the original stamp, so an
	 *  abandoned op can never resolve (and remove) a pre-existing membership. */
	originOp?: string | null;
}

export interface EnsuredMembership {
	memberId: string;
	/** False when an existing membership for (session, user) was reused. */
	created: boolean;
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
	return error?.code === '23505' || /duplicate key/i.test(error?.message ?? '');
}

/**
 * Create-or-reuse the caller's membership in a session. Idempotent per
 * (session, user) for humans; bots always insert a fresh disclosed bot row.
 * Concurrency-safe: a lost insert race (unique violation) re-reads the winner.
 */
export async function ensureRoomMembership(
	db: PlayDbClient,
	params: EnsureMembershipParams
): Promise<EnsuredMembership> {
	const isBot = params.isBot ?? false;
	if (!isBot && !params.userId) {
		throw new Error('A human membership requires a validated user identity.');
	}

	if (!isBot && params.userId) {
		const existing = await findHumanMembership(db, params.sessionId, params.userId);
		if (existing) return { memberId: existing, created: false };
	}

	const insert = await db
		.from(MEMBERS_TABLE)
		.insert({
			session_id: params.sessionId,
			display_name: params.displayName,
			role: params.role ?? 'spectator',
			private_state: {},
			user_id: params.userId,
			is_bot: isBot,
			bot_profile: isBot ? (params.botProfile ?? null) : null,
			origin_op: isBot ? null : (params.originOp ?? null)
		})
		.select('id')
		.single();

	if (insert.error) {
		// Unique (session_id, user_id) race: a concurrent join won — adopt its row.
		if (!isBot && params.userId && isUniqueViolation(insert.error)) {
			const winner = await findHumanMembership(db, params.sessionId, params.userId);
			if (winner) return { memberId: winner, created: false };
		}
		throw new Error(`Failed to create membership: ${insert.error.message}`);
	}
	return { memberId: (insert.data as { id: string }).id, created: true };
}

async function findHumanMembership(
	db: PlayDbClient,
	sessionId: string,
	userId: string
): Promise<string | null> {
	const { data, error } = await db
		.from(MEMBERS_TABLE)
		.select('id')
		.eq('session_id', sessionId)
		.eq('user_id', userId)
		.eq('is_bot', false)
		.limit(1);
	if (error) throw new Error(`Failed to resolve membership: ${error.message}`);
	const rows = (data as { id: string }[] | null) ?? [];
	return rows[0]?.id ?? null;
}
