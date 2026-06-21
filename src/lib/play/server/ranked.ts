/**
 * 2D match-result recording + OpenSkill rating on game finish.
 *
 * `finalizeMatch` is called best-effort from `persistSessionUpdate` exactly once,
 * on the transition into the `finished` status. It records the final standings
 * (match_results + match_result_players) and, for ranked games, updates each
 * human player's OpenSkill rating (player_ratings + player_rating_events).
 *
 * It is IDEMPOTENT (a re-fire no-ops once a match_results row exists) and NEVER
 * throws into the game flow — every failure is logged and swallowed.
 *
 * All tables live in the 2D engine schema (arc_spirits_2d).
 */
import { rate, rating } from 'openskill';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import type { PublicGameState, SeatColor } from '../types';
import { isBotDisplayName } from './botSim';

// Mirrors the play-table schema/names in service.ts; kept local so ranked.ts has
// no import cycle with service.ts (service imports this module).
const PLAY_SCHEMA = 'arc_spirits_2d';
const TABLES = {
	MEMBERS: 'play_session_members',
	MATCH_RESULTS: 'match_results',
	MATCH_RESULT_PLAYERS: 'match_result_players',
	PLAYER_RATINGS: 'player_ratings',
	PLAYER_RATING_EVENTS: 'player_rating_events'
} as const;

/** Rating algorithm version recorded on every ratings/event row (bump on model changes). */
const RATING_VERSION = 1;

/** The minimal session shape finalizeMatch needs (a PlaySessionRow). */
export interface FinalizeMatchSession {
	id: string;
	game_id: string | null;
	mode: 'casual' | 'ranked';
	started_at: string | null;
	ended_at: string | null;
}

/** A resolved session member, for member_id → user_id / display_name lookup. */
interface MemberInfo {
	id: string;
	user_id: string | null;
	display_name: string | null;
}

/** One seat's final standing, assembled before placement is computed. */
interface SeatStanding {
	seatColor: SeatColor;
	memberId: string;
	userId: string | null;
	displayName: string | null;
	isBot: boolean;
	victoryPoints: number;
	placement: number;
}

function getAdmin() {
	return getSupabaseAdmin(PLAY_SCHEMA);
}

/**
 * Dense-rank the standings by placement. The winner (if any) is always placement 1;
 * the remaining seats are dense-ranked by victory points descending (ties share a
 * placement), offset so they start after the winner. With no winner, everyone is
 * dense-ranked purely by VP.
 */
function assignPlacements(standings: SeatStanding[], winnerSeat: SeatColor | null): void {
	const winner = winnerSeat ? standings.find((s) => s.seatColor === winnerSeat) ?? null : null;
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
}

/**
 * Record the final result of a finished 2D match and, for ranked games, update
 * OpenSkill ratings. Idempotent + best-effort: safe to call more than once, and
 * never throws into the caller.
 */
export async function finalizeMatch(
	session: FinalizeMatchSession,
	finalState: PublicGameState
): Promise<void> {
	try {
		const admin = getAdmin();
		if (!admin) return; // No service-role key configured ⇒ skip silently.

		// Idempotency guard: if a result already exists for this session, no-op.
		const existing = await admin
			.from(TABLES.MATCH_RESULTS)
			.select('session_id')
			.eq('session_id', session.id)
			.maybeSingle();
		if (existing.error) {
			console.error('[ranked] finalizeMatch idempotency check failed:', existing.error.message);
			return;
		}
		if (existing.data) return; // already recorded.

		// Resolve session members so we can map memberId → user_id / display_name.
		const membersRes = await admin
			.from(TABLES.MEMBERS)
			.select('id, user_id, display_name')
			.eq('session_id', session.id);
		if (membersRes.error) {
			console.error('[ranked] finalizeMatch member load failed:', membersRes.error.message);
			return;
		}
		const membersById = new Map<string, MemberInfo>(
			((membersRes.data as MemberInfo[] | null) ?? []).map((m) => [m.id, m])
		);

		// Build one standing per active seat that has a claimed member.
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
				displayName,
				// Bots are marked by their 🤖 display-name convention (botSim). As a
				// fallback, a missing user_id is the practical "not a real human" signal.
				isBot: isBotDisplayName(displayName) || member?.user_id == null,
				victoryPoints: finalState.players[seatColor]?.victoryPoints ?? 0,
				placement: 0
			});
		}

		if (standings.length === 0) return; // nothing to record.

		assignPlacements(standings, finalState.winnerSeat);

		const ranked = session.mode === 'ranked';
		const nowIso = new Date().toISOString();
		const endedAt = session.ended_at ?? nowIso;

		// ── Ratings (ranked only, humans only) ─────────────────────────────────
		// A "rated" player has a non-null user_id (bots/guests excluded).
		const ratedStandings = ranked ? standings.filter((s) => s.userId != null) : [];
		let rated = false;

		if (ratedStandings.length >= 2) {
			const userIds = ratedStandings.map((s) => s.userId as string);
			const currentRes = await admin
				.from(TABLES.PLAYER_RATINGS)
				.select('user_id, mu, sigma, games_played')
				.in('user_id', userIds);
			if (currentRes.error) {
				console.error('[ranked] player_ratings load failed:', currentRes.error.message);
			} else {
				const currentByUser = new Map<string, { mu: number; sigma: number; games_played: number }>(
					((currentRes.data as { user_id: string; mu: number; sigma: number; games_played: number }[] | null) ?? []).map(
						(r) => [r.user_id, { mu: r.mu, sigma: r.sigma, games_played: r.games_played }]
					)
				);

				// Each player is their own team; rank = placement (ties allowed).
				const before = ratedStandings.map((s) => {
					const cur = currentByUser.get(s.userId as string);
					return cur ? rating({ mu: cur.mu, sigma: cur.sigma }) : rating();
				});
				const teams = before.map((r) => [r]);
				const ranks = ratedStandings.map((s) => s.placement);
				const updated = rate(teams, { rank: ranks });

				const ratingRows = ratedStandings.map((s, i) => {
					const prevGames = currentByUser.get(s.userId as string)?.games_played ?? 0;
					return {
						user_id: s.userId,
						display_name: s.displayName,
						mu: updated[i][0].mu,
						sigma: updated[i][0].sigma,
						games_played: prevGames + 1,
						last_session_id: session.id,
						last_game_at: endedAt,
						rating_version: RATING_VERSION,
						updated_at: nowIso
					};
				});
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
				} else {
					const eventsInsert = await admin.from(TABLES.PLAYER_RATING_EVENTS).insert(eventRows);
					if (eventsInsert.error) {
						console.error('[ranked] player_rating_events insert failed:', eventsInsert.error.message);
					} else {
						rated = true;
					}
				}
			}
		}

		// ── Match result rows ───────────────────────────────────────────────────
		const resultInsert = await admin.from(TABLES.MATCH_RESULTS).insert({
			session_id: session.id,
			game_id: session.game_id,
			mode: session.mode,
			ranked,
			rated,
			winner_seat: finalState.winnerSeat,
			player_count: standings.length,
			navigation_count: finalState.round,
			started_at: session.started_at,
			ended_at: endedAt,
			rating_version: RATING_VERSION
		});
		if (resultInsert.error) {
			console.error('[ranked] match_results insert failed:', resultInsert.error.message);
			return;
		}

		const playerRows = standings.map((s) => ({
			session_id: session.id,
			seat_color: s.seatColor,
			member_id: s.memberId,
			user_id: s.userId,
			display_name: s.displayName,
			is_bot: s.isBot,
			victory_points: s.victoryPoints,
			placement: s.placement
		}));
		const playersInsert = await admin.from(TABLES.MATCH_RESULT_PLAYERS).insert(playerRows);
		if (playersInsert.error) {
			console.error('[ranked] match_result_players insert failed:', playersInsert.error.message);
		}
	} catch (err) {
		// finalizeMatch must NEVER throw into the game flow.
		console.error('[ranked] finalizeMatch unexpected error:', err);
	}
}
