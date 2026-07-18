/**
 * Transport-agnostic core of the finished-game side effect: record the final
 * standings (match_results + match_result_players) and, for ranked games, update
 * OpenSkill ratings. Shared by BOTH the SvelteKit HTTP path and the standalone
 * WebSocket room server via the durable effects outbox (effectsOutbox.ts).
 *
 * EXACTLY-ONCE, CROSS-PROCESS: all terminal writes go through ONE database
 * transaction — the `finalize_match` RPC (supabase/migrations/20260710_ranked_finalize.sql):
 *   - the match_results UNIQUE(session_id) anchor is the finalize claim: a prior
 *     attempt answers `already_finalized` (repairing missing player rows only,
 *     never re-touching ratings);
 *   - every rated user is serialized by a transaction-scoped ADVISORY LOCK taken
 *     before the rating bases are checked — this fences users with NO
 *     player_ratings row yet (FOR UPDATE cannot lock an absent row, so two
 *     first-ever matches sharing an unrated user would otherwise both validate the
 *     absent base and the later upsert would silently overwrite the earlier one) —
 *     and the existing rows are additionally locked (FOR UPDATE) and verified
 *     inside the transaction: a concurrent finalizer or an interleaved
 *     other-session rating raises `stale_ratings`, rolls everything back, and this
 *     caller re-reads + recomputes (bounded retries);
 *   - a crash at ANY point is a full rollback: there is no partially-finalized
 *     state, so recovery workers / concurrent outbox drains / duplicate-retry
 *     handlers on other instances can never double-apply games_played, rating
 *     deltas, events, result or player rows.
 *
 * FAIL CLOSED: without the RPC (migration not applied) the effect refuses to run —
 * it logs store_not_ready and reports "not durable" so the effects-outbox row is
 * retained and retried; game flow is untouched (this effect never throws into it).
 * The legacy NON-ATOMIC sequence survives ONLY behind the explicit local/test
 * opt-in ARC_ALLOW_NONATOMIC_COMMIT=1 (same switch as commit.ts; production and
 * any non-dev/test tier refuse it UNCONDITIONALLY, even with an explicit in-code
 * opt-in), hardened with
 * partial-attempt markers (existing rating events, player_ratings.last_session_id)
 * so a crash-and-retry cannot double-apply — but it cannot exclude a concurrent
 * INDEPENDENT finalizer without the migration's constraints, which is why it is
 * never allowed to engage silently.
 *
 * Returns `true` when the durable record exists (created now, already there, or
 * structurally nothing to record) — the effects-outbox "done" signal — and `false`
 * when it could not be guaranteed (the outbox will retry later).
 *
 * No `$env` / SvelteKit imports allowed here — the client is injected.
 */
import { rate, rating } from 'openskill';
import type { SeatColor } from '../types';
import { nonAtomicFallbackPermitted, type PlayDbClient } from './commit';
import { RANKED_FORBIDDEN_LEDGER_TYPES } from './commandPolicy';
import { reconcileRankedSeasonWith } from './rankedSeasonCore';

const TABLES = {
	MEMBERS: 'play_session_members',
	EVENTS: 'play_game_session_events',
	MATCH_RESULTS: 'match_results',
	MATCH_RESULT_PLAYERS: 'match_result_players',
	PLAYER_RATINGS: 'player_ratings',
	PLAYER_RATING_EVENTS: 'player_rating_events'
} as const;

export const FINALIZE_RPC = 'finalize_match';

/** Bounded re-read/recompute attempts when the RPC reports our rating bases went
 *  stale (a concurrent finalizer / another session rating the same user won). */
const MAX_FINALIZE_ATTEMPTS = 4;

/** Rating algorithm version recorded on every ratings/event row (bump on model changes). */
const RATING_VERSION = 1;

/** The minimal session shape finalize needs (a PlaySessionRow). */
export interface FinalizeMatchSession {
	id: string;
	game_id: string | null;
	mode: 'casual' | 'ranked';
	started_at: string | null;
	ended_at: string | null;
	ranked_season_id?: string | null;
}

/**
 * The EXACT final-state inputs finalize consumes: standings (per active seat:
 * member, name, victory points), winner and round. A full PublicGameState is
 * structurally assignable; {@link frozenFinalizeState} extracts just these fields
 * so the effects outbox can freeze them into its payload AT the finished
 * transition — delayed recovery then finalizes from the terminal state that
 * actually finished the game, never from whatever the current state has become.
 */
export interface FinalizeStateInputs {
	winnerSeat: SeatColor | null;
	round: number;
	activeSeats: SeatColor[];
	seats: Partial<Record<SeatColor, { memberId: string | null; displayName: string | null }>>;
	players: Partial<Record<SeatColor, { victoryPoints: number }>>;
}

/** Extract (deep-copy) the {@link FinalizeStateInputs} of a terminal state, for
 *  durable embedding in the effects-outbox payload (jsonb-safe, minimal). */
export function frozenFinalizeState(state: FinalizeStateInputs): FinalizeStateInputs {
	const seats: FinalizeStateInputs['seats'] = {};
	const players: FinalizeStateInputs['players'] = {};
	for (const seat of state.activeSeats) {
		seats[seat] = {
			memberId: state.seats[seat]?.memberId ?? null,
			displayName: state.seats[seat]?.displayName ?? null
		};
		players[seat] = { victoryPoints: state.players[seat]?.victoryPoints ?? 0 };
	}
	return {
		winnerSeat: state.winnerSeat,
		round: state.round,
		activeSeats: [...state.activeSeats],
		seats,
		players
	};
}

export interface FinalizeMatchOpts {
	/** Explicit opt-in for the legacy non-atomic sequence when the finalize_match RPC
	 *  is missing (local/test only); undefined defers to ARC_ALLOW_NONATOMIC_COMMIT. */
	allowNonAtomicFallback?: boolean;
}

interface MemberInfo {
	id: string;
	user_id: string | null;
	display_name: string | null;
	is_bot: boolean | null;
}

interface SeatStanding {
	seatColor: SeatColor;
	memberId: string;
	userId: string | null;
	displayName: string | null;
	isBot: boolean;
	victoryPoints: number;
	placement: number;
	ratedPlacement: number;
	abandoned: boolean;
}

interface RatingBase {
	mu: number;
	sigma: number;
	games_played: number;
}

/** One entry of the RPC's p_ratings payload: the computed update PLUS the base it
 *  was computed from, so the transaction can verify the base is still current. */
interface RatingPayloadRow {
	user_id: string;
	display_name: string | null;
	placement: number;
	mu_before: number;
	sigma_before: number;
	mu_after: number;
	sigma_after: number;
	/** The base row the update was computed from; nulls ⇒ the caller saw NO row. */
	expected_mu: number | null;
	expected_sigma: number | null;
	expected_games: number | null;
	last_game_at: string;
	rating_version: number;
}

/**
 * Dense-rank the standings by placement. The winner (if any) is always placement 1;
 * the remaining seats are dense-ranked by victory points descending (ties share a
 * placement), offset so they start after the winner. With no winner, everyone is
 * dense-ranked purely by VP.
 */
function assignPlacements(standings: SeatStanding[], winnerSeat: SeatColor | null): void {
	const winner = winnerSeat ? (standings.find((s) => s.seatColor === winnerSeat) ?? null) : null;
	const rest = standings.filter((s) => s !== winner);

	// VP desc; deterministic tiebreak on seat color so a re-run is stable.
	rest.sort((a, b) => b.victoryPoints - a.victoryPoints || a.seatColor.localeCompare(b.seatColor));

	if (winner) winner.placement = 1;

	// Dense ranks for the rest, offset past the winner (so 1 winner ⇒ rest start at 2).
	const offset = winner ? 1 : 0;
	let placement = offset;
	let lastVp: number | null = null;
	for (const s of rest) {
		if (lastVp === null || s.victoryPoints !== lastVp) {
			placement += 1;
			lastVp = s.victoryPoints;
		}
		s.placement = placement;
	}
	// Rated placement never lets an abandoned human inherit a bot-controlled win.
	// Non-abandoners keep board order; abandoners are ordered last deterministically.
	const ratedOrder = [...standings].sort((a, b) =>
		Number(a.abandoned) - Number(b.abandoned) || a.placement - b.placement || a.seatColor.localeCompare(b.seatColor));
	for (let index = 0; index < ratedOrder.length; index += 1) ratedOrder[index].ratedPlacement = index + 1;
}

/** In-flight fires per session: serializes a same-process double-call so the two
 *  attempts don't waste stale-retry round-trips racing each other. CROSS-process
 *  exactly-once does NOT depend on this — it is anchored in the finalize_match
 *  transaction (anchor unique key + locked, verified rating bases). */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Record the final result of a finished 2D match and, for ranked games, update
 * OpenSkill ratings, using the INJECTED play-schema service-role client.
 * Idempotent + best-effort: safe to call any number of times from any number of
 * processes, and never throws. Resolves `true` when the durable match record exists
 * (the effects-outbox "done" signal) and `false` when it could not be guaranteed
 * (the outbox will retry later).
 */
export function finalizeMatchWith(
	admin: PlayDbClient | null,
	session: FinalizeMatchSession,
	finalState: FinalizeStateInputs,
	opts?: FinalizeMatchOpts
): Promise<boolean> {
	const previous = inFlight.get(session.id) ?? Promise.resolve(true);
	const run = previous
		.then(() => finalizeMatchUnserialized(admin, session, finalState, opts))
		.catch(() => false);
	inFlight.set(session.id, run);
	void run.finally(() => {
		if (inFlight.get(session.id) === run) inFlight.delete(session.id);
	});
	return run;
}

/** "the RPC does not exist" (migration not applied / schema cache stale). */
function isMissingRpc(error: { code?: string; message?: string } | null): boolean {
	if (!error) return false;
	return (
		error.code === 'PGRST202' ||
		error.code === '42883' ||
		(error.message ?? '').includes('schema cache')
	);
}

/** The transaction rolled back because our inputs raced another writer: re-read and
 *  recompute (`stale_ratings`), or take the already_finalized path (`concurrent_finalize`). */
function isRetryableFinalizeError(error: { message?: string } | null): boolean {
	const message = error?.message ?? '';
	return message.includes('stale_ratings') || message.includes('concurrent_finalize');
}

/**
 * One un-serialized finalize attempt — the exact code path a recovery worker or a
 * second server instance runs (no shared in-process state). Exported so adversarial
 * tests can genuinely race independent finalizers; production callers should use
 * {@link finalizeMatchWith}.
 */
export async function finalizeMatchUnserialized(
	admin: PlayDbClient | null,
	session: FinalizeMatchSession,
	finalState: FinalizeStateInputs,
	opts?: FinalizeMatchOpts
): Promise<boolean> {
	try {
		if (!admin) return true; // No service-role key configured ⇒ effect disabled.

		// Cheap idempotency pre-read (the RPC re-checks authoritatively inside its
		// transaction): a fully recorded session makes re-drains a no-op.
		const recorded = await recordedStatus(admin, session.id);
		if (!recorded) return false;
		if (recorded.anchor && recorded.players) {
			if (!session.ranked_season_id) return true;
			const standings = await loadStandings(admin, session, finalState);
			if (!standings) return false;
			assignPlacements(standings, finalState.winnerSeat);
			return reconcileRankedSeasonWith(admin, session.id, session.ranked_season_id,
				standings.map((row) => ({ user_id: row.userId, display_name: row.displayName,
					is_bot: row.isBot, placement: row.ratedPlacement })));
		}

		const standings = await loadStandings(admin, session, finalState);
		if (!standings) return false;
		if (standings.length === 0) return true; // nothing to record.

		assignPlacements(standings, finalState.winnerSeat);

		const ranked = session.mode === 'ranked';
		const nowIso = new Date().toISOString();
		// The outbox freezes ended_at at the finished transition (effectsOutbox.ts), so
		// this wall-clock fallback only engages for legacy pre-freeze outbox rows.
		const endedAt = session.ended_at ?? nowIso;

		// TRANSCRIPT INTEGRITY (defense in depth behind the wire admission policy):
		// a rated transcript that somehow contains a forbidden integrity/host command
		// is QUARANTINED — the match is recorded for the players, but no rating ever
		// moves because of it. A ledger read failure retries via the outbox rather
		// than guessing.
		let quarantined = false;
		if (ranked && !recorded.anchor) {
			const verdict = await transcriptQuarantined(admin, session.id);
			if (verdict == null) return false;
			quarantined = verdict;
			if (quarantined) {
				console.error(
					`[ranked] session ${session.id} transcript contains forbidden integrity commands — ` +
						`quarantined: match recorded UNRATED, ratings untouched.`
				);
			}
		}

		const resultRow = {
			game_id: session.game_id,
			mode: session.mode,
			ranked,
			quarantined,
			winner_seat: finalState.winnerSeat,
			player_count: standings.length,
			navigation_count: finalState.round,
			started_at: session.started_at,
			ended_at: endedAt,
			rating_version: RATING_VERSION
		};
		const playerRows = standings.map((s) => ({
			session_id: session.id,
			seat_color: s.seatColor,
			member_id: s.memberId,
			user_id: s.userId,
			display_name: s.displayName,
			is_bot: s.isBot,
			victory_points: s.victoryPoints,
			placement: s.placement,
			rated_placement: s.ratedPlacement,
			abandoned: s.abandoned
		}));

		// A "rated" player has a non-null user_id (guests excluded; matchmaking bot
		// accounts carry real user_ids and are rated deliberately). An existing anchor
		// means only player rows are owed — ratings are never recomputed. A quarantined
		// transcript rates NOBODY.
		const ratedStandings =
			ranked && !recorded.anchor && !quarantined ? standings.filter((s) => s.userId != null) : [];

		// ── Production path: ONE finalize_match transaction ─────────────────────
		if (typeof admin.rpc === 'function') {
			let rpcMissing = false;
			for (let attempt = 0; attempt < MAX_FINALIZE_ATTEMPTS; attempt += 1) {
				let ratings: RatingPayloadRow[] = [];
				if (ratedStandings.length >= 2) {
					const computed = await computeRatingPayload(admin, ratedStandings, endedAt);
					if (!computed) return false; // rating base read failed — retry via outbox.
					ratings = computed;
				}
				const res = await admin.rpc(FINALIZE_RPC, {
					p_session_id: session.id,
					p_result: resultRow,
					p_players: playerRows,
					p_ratings: ratings
				});
				if (!res.error) {
					if (!session.ranked_season_id) return true;
					return reconcileRankedSeasonWith(admin, session.id, session.ranked_season_id,
						standings.map((row) => ({ user_id: row.userId, display_name: row.displayName,
							is_bot: row.isBot, placement: row.ratedPlacement })));
				}
				if (isRetryableFinalizeError(res.error)) continue; // re-read bases, recompute.
				if (isMissingRpc(res.error)) {
					rpcMissing = true; // → fail closed / explicit opt-in below.
					break;
				}
				console.error('[ranked] finalize_match failed:', res.error.message);
				return false;
			}
			if (!rpcMissing) {
				// Retries exhausted (pathological rating contention): leave the outbox
				// row for a later drain rather than guess.
				console.error(
					`[ranked] finalize_match retries exhausted for session ${session.id}; will retry on the next drain.`
				);
				return false;
			}
		}

		// Production (and any non-dev/test tier) fails closed even when the caller
		// passed an explicit opt-in — the shared gate in commit.ts decides.
		const allowFallback = nonAtomicFallbackPermitted(opts?.allowNonAtomicFallback);
		if (!allowFallback) {
			console.error(
				`[ranked] finalize_match store not ready for session ${session.id}: the atomic ` +
					`${FINALIZE_RPC} RPC is not installed. Apply supabase/migrations/` +
					`20260710_ranked_finalize.sql — the terminal match/rating record is retained ` +
					`in the effects outbox and will be retried (or set ARC_ALLOW_NONATOMIC_COMMIT=1 ` +
					`for local/test use only — the non-atomic fallback cannot guarantee exactly-once).`
			);
			return false;
		}
		return await finalizeNonAtomic(admin, session, {
			recorded,
			ratedStandings,
			resultRow,
			playerRows,
			endedAt,
			nowIso
		});
	} catch (err) {
		// finalizeMatch must NEVER throw into the game flow.
		console.error('[ranked] finalizeMatch unexpected error:', err);
		return false;
	}
}

/**
 * True when the session's committed ledger contains a command type that must never
 * appear in a rated transcript (integrity tools / host rescue — see commandPolicy).
 *
 * FAIL CLOSED: null on ANY read failure — including a missing ledger relation
 * (42P01 / "does not exist", e.g. the command-ledger migration lagging this code on
 * a store) — so the caller DEFERS (the effects-outbox row is retained and retried)
 * and no rating ever moves on a transcript whose integrity could not be PROVEN.
 * Treating an absent ledger as a clean transcript was the pre-fix defect: a
 * migration-order gap silently rated unverifiable games.
 */
async function transcriptQuarantined(
	admin: PlayDbClient,
	sessionId: string
): Promise<boolean | null> {
	const res = await admin
		.from(TABLES.EVENTS)
		.select('command_type')
		.eq('session_id', sessionId)
		.in('command_type', [...RANKED_FORBIDDEN_LEDGER_TYPES])
		.limit(1);
	if (res.error) {
		console.error(
			'[ranked] transcript integrity could not be verified — deferring finalize (ratings untouched):',
			res.error.message ?? res.error.code ?? 'unknown error'
		);
		return null;
	}
	return ((res.data as { command_type: string }[] | null) ?? []).length > 0;
}

async function recordedStatus(
	admin: PlayDbClient,
	sessionId: string
): Promise<{ anchor: boolean; players: boolean } | null> {
	const existing = await admin
		.from(TABLES.MATCH_RESULTS)
		.select('session_id')
		.eq('session_id', sessionId)
		.maybeSingle();
	if (existing.error) {
		console.error('[ranked] finalizeMatch idempotency check failed:', existing.error.message);
		return null;
	}
	if (!existing.data) return { anchor: false, players: false };
	const playersRes = await admin
		.from(TABLES.MATCH_RESULT_PLAYERS)
		.select('session_id')
		.eq('session_id', sessionId)
		.limit(1)
		.maybeSingle();
	if (playersRes.error) {
		console.error('[ranked] finalizeMatch player check failed:', playersRes.error.message);
		return null;
	}
	return { anchor: true, players: playersRes.data != null };
}

/** Resolve session members and build one standing per claimed active seat.
 *  Null on a store read failure (retry via outbox). */
async function loadStandings(
	admin: PlayDbClient,
	session: FinalizeMatchSession,
	finalState: FinalizeStateInputs
): Promise<SeatStanding[] | null> {
	const membersRes = await admin
		.from(TABLES.MEMBERS)
		.select('id, user_id, display_name, is_bot')
		.eq('session_id', session.id);
	if (membersRes.error) {
		console.error('[ranked] finalizeMatch member load failed:', membersRes.error.message);
		return null;
	}
	const membersById = new Map<string, MemberInfo>(
		((membersRes.data as MemberInfo[] | null) ?? []).map((m) => [m.id, m])
	);
	const abandonedMembers = new Set<string>();
	if (session.mode === 'ranked' && session.ranked_season_id) {
		const participation = await admin.from('ranked_participation').select('member_id,abandoned')
			.eq('session_id', session.id).eq('abandoned', true);
		if (participation.error) {
			console.error('[ranked] participation load failed:', participation.error.message);
			return null;
		}
		for (const row of (participation.data as Array<{ member_id: string; abandoned: boolean }> | null) ?? [])
			abandonedMembers.add(row.member_id);
	}

	const standings: SeatStanding[] = [];
	for (const seatColor of finalState.activeSeats) {
		const memberId = finalState.seats[seatColor]?.memberId;
		if (!memberId) continue;
		const member = membersById.get(memberId) ?? null;
		const displayName = member?.display_name ?? finalState.seats[seatColor]?.displayName ?? null;
		standings.push({
			seatColor,
			memberId,
			userId: member?.user_id ?? null,
			// Bots are marked by the explicit `is_bot` column (a matchmaking bot now
			// carries a real user_id + human name, so the old name/null-user heuristic
			// is wrong). A missing user_id is still treated as a bot as a safety net for
			// guest/unattributable seats.
			isBot: member?.is_bot === true || member?.user_id == null,
			displayName,
			victoryPoints: finalState.players[seatColor]?.victoryPoints ?? 0,
			placement: 0,
			ratedPlacement: 0,
			abandoned: abandonedMembers.has(memberId)
		});
	}
	return standings;
}

/** Read the CURRENT rating rows and compute the OpenSkill updates from them; the
 *  bases ride along so the finalize transaction can verify they are still current.
 *  Null on a read failure. */
async function computeRatingPayload(
	admin: PlayDbClient,
	ratedStandings: SeatStanding[],
	endedAt: string
): Promise<RatingPayloadRow[] | null> {
	const userIds = ratedStandings.map((s) => s.userId as string);
	const currentRes = await admin
		.from(TABLES.PLAYER_RATINGS)
		.select('user_id, mu, sigma, games_played')
		.in('user_id', userIds);
	if (currentRes.error) {
		console.error('[ranked] player_ratings load failed:', currentRes.error.message);
		return null;
	}
	const currentByUser = new Map<string, RatingBase>(
		((currentRes.data as ({ user_id: string } & RatingBase)[] | null) ?? []).map((r) => [
			r.user_id,
			{ mu: r.mu, sigma: r.sigma, games_played: r.games_played }
		])
	);

	// Each player is their own team; rank = placement (ties allowed).
	const before = ratedStandings.map((s) => {
		const cur = currentByUser.get(s.userId as string);
		return cur ? rating({ mu: cur.mu, sigma: cur.sigma }) : rating();
	});
	const teams = before.map((r) => [r]);
	const ranks = ratedStandings.map((s) => s.ratedPlacement);
	const updated = rate(teams, { rank: ranks });

	return ratedStandings.map((s, i) => {
		const base = currentByUser.get(s.userId as string) ?? null;
		return {
			user_id: s.userId as string,
			display_name: s.displayName,
			placement: s.ratedPlacement,
			mu_before: before[i].mu,
			sigma_before: before[i].sigma,
			mu_after: updated[i][0].mu,
			sigma_after: updated[i][0].sigma,
			expected_mu: base?.mu ?? null,
			expected_sigma: base?.sigma ?? null,
			expected_games: base?.games_played ?? null,
			last_game_at: endedAt,
			rating_version: RATING_VERSION
		};
	});
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
	if (!error) return false;
	return error.code === '23505' || (error.message ?? '').includes('duplicate key');
}

/**
 * LEGACY NON-ATOMIC sequence (explicit local/test opt-in only — see the module doc).
 * Hardened against crash-and-retry double-application via the partial-attempt
 * markers (existing rating events for the session; player_ratings.last_session_id),
 * but two truly concurrent independent finalizers can still both pass the
 * check-then-act guards on a store without the migration's unique constraints —
 * the documented residual the finalize_match transaction closes.
 */
async function finalizeNonAtomic(
	admin: PlayDbClient,
	session: FinalizeMatchSession,
	ctx: {
		recorded: { anchor: boolean; players: boolean };
		ratedStandings: SeatStanding[];
		resultRow: Record<string, unknown>;
		playerRows: Record<string, unknown>[];
		endedAt: string;
		nowIso: string;
	}
): Promise<boolean> {
	const { recorded, ratedStandings, resultRow, playerRows, endedAt, nowIso } = ctx;
	let rated = false;

	// ── Ratings (ranked only; never on the anchor-exists repair path) ─────────
	if (ratedStandings.length >= 2 && !recorded.anchor) {
		const userIds = ratedStandings.map((s) => s.userId as string);
		const currentRes = await admin
			.from(TABLES.PLAYER_RATINGS)
			.select('user_id, mu, sigma, games_played, last_session_id')
			.in('user_id', userIds);
		if (currentRes.error) {
			console.error('[ranked] player_ratings load failed:', currentRes.error.message);
			return false; // retry via outbox rather than durably record an unrated anchor.
		}
		const rows =
			(currentRes.data as
				| ({ user_id: string; last_session_id: string | null } & RatingBase)[]
				| null) ?? [];

		// Partial-attempt marker A: a prior attempt's ratings upsert landed (it stamps
		// last_session_id in one atomic multi-row statement) — never re-apply.
		const alreadyApplied = rows.some((r) => r.last_session_id === session.id);
		// Partial-attempt marker B: event rows exist ⇒ ratings + events both landed.
		let eventsExist = false;
		if (!alreadyApplied) {
			const eventsRes = await admin
				.from(TABLES.PLAYER_RATING_EVENTS)
				.select('session_id')
				.eq('session_id', session.id)
				.limit(1)
				.maybeSingle();
			if (eventsRes.error) {
				console.error('[ranked] rating-event check failed:', eventsRes.error.message);
				return false;
			}
			eventsExist = eventsRes.data != null;
		}

		if (alreadyApplied || eventsExist) {
			rated = true; // converged by the prior attempt (its lost event rows, if any,
			// are unrecoverable — mu_before is gone — and stay missing rather than faked).
		} else {
			const currentByUser = new Map<string, RatingBase>(
				rows.map((r) => [r.user_id, { mu: r.mu, sigma: r.sigma, games_played: r.games_played }])
			);
			const before = ratedStandings.map((s) => {
				const cur = currentByUser.get(s.userId as string);
				return cur ? rating({ mu: cur.mu, sigma: cur.sigma }) : rating();
			});
			const updated = rate(
				before.map((r) => [r]),
				{ rank: ratedStandings.map((s) => s.placement) }
			);
			const ratingRows = ratedStandings.map((s, i) => ({
				user_id: s.userId,
				display_name: s.displayName,
				mu: updated[i][0].mu,
				sigma: updated[i][0].sigma,
				games_played: (currentByUser.get(s.userId as string)?.games_played ?? 0) + 1,
				last_session_id: session.id,
				last_game_at: endedAt,
				rating_version: RATING_VERSION,
				updated_at: nowIso
			}));
			const eventRows = ratedStandings.map((s, i) => ({
				session_id: session.id,
				user_id: s.userId,
				placement: s.placement,
				mu_before: before[i].mu,
				sigma_before: before[i].sigma,
				mu_after: updated[i][0].mu,
				sigma_after: updated[i][0].sigma,
				rating_version: RATING_VERSION
			}));

			const ratingsUpsert = await admin
				.from(TABLES.PLAYER_RATINGS)
				.upsert(ratingRows, { onConflict: 'user_id' });
			if (ratingsUpsert.error) {
				console.error('[ranked] player_ratings upsert failed:', ratingsUpsert.error.message);
				return false; // nothing applied yet — a clean retry recomputes.
			}
			const eventsInsert = await admin.from(TABLES.PLAYER_RATING_EVENTS).insert(eventRows);
			if (eventsInsert.error && !isUniqueViolation(eventsInsert.error)) {
				// Ratings ARE applied (marker A now set); the retry path above skips
				// re-application, so log the lost-events residual and keep going.
				console.error(
					'[ranked] player_rating_events insert failed (ratings applied; events lost):',
					eventsInsert.error.message
				);
			}
			rated = true;
		}
	}

	// ── Match result rows ───────────────────────────────────────────────────
	if (!recorded.anchor) {
		const resultInsert = await admin
			.from(TABLES.MATCH_RESULTS)
			.insert({ session_id: session.id, rated, ...resultRow });
		if (resultInsert.error && !isUniqueViolation(resultInsert.error)) {
			console.error('[ranked] match_results insert failed:', resultInsert.error.message);
			return false;
		}
	}

	const playersInsert = await admin.from(TABLES.MATCH_RESULT_PLAYERS).insert(playerRows);
	if (playersInsert.error && !isUniqueViolation(playersInsert.error)) {
		console.error('[ranked] match_result_players insert failed:', playersInsert.error.message);
		// The anchor row exists; the next fire takes the anchor-exists repair path and
		// completes the interrupted attempt (players only, exactly once).
		return false;
	}
	return true;
}
