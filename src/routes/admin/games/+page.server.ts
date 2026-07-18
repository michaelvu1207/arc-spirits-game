import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import { env as publicEnv } from '$env/dynamic/public';

type GameSummaryRow = {
	game_id: string;
	verified: boolean;
	verified_at: string | null;
	verified_by: string | null;
	started_at: string | null;
	ended_at: string | null;
	navigation_count: number;
	player_count: number;
	avg_navigation_ms: number | null;
	winner_guardian: string | null;
	winner_vp: number;
	display_name: string | null;
};

// The 2D engine session tables live in their own schema (arc_spirits_2d);
// everything else stays in the default game/history schema (arc_spirits_game).
const PLAY_SCHEMA = 'arc_spirits_2d';

// Per-game tables to wipe on a hard delete. Views (game_summaries,
// *_verified) regenerate automatically; only base tables are listed.
// NOTE: play_game_sessions lives in PLAY_SCHEMA and is deleted separately
// (see the delete action) — it is intentionally NOT in this default-schema list.
const GAME_TABLES_TO_DELETE = [
	'game_state_snapshots',
	'game_notes',
	'player_composition_tags',
	'player_feedback',
	'player_rating_events',
	'replay_codes',
	'verified_games',
	'verified_match_players',
	'verified_matches',
	'game_metadata'
] as const;

async function recomputeVerifiedStats(supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdmin>>): Promise<void> {
	const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
	const supabaseAnonKey = publicEnv.PUBLIC_SUPABASE_ANON_KEY;
	if (!supabaseUrl || !supabaseAnonKey) {
		throw error(500, 'Missing public Supabase configuration');
	}
	const { data, error: tokenError } = await supabaseAdmin
		.from('internal_tokens')
		.select('value')
		.eq('key', 'recompute_stats_token')
		.limit(1)
		.maybeSingle();

	if (tokenError) {
		throw error(500, `Failed to load recompute token: ${tokenError.message}`);
	}

	const token = data?.value;
	if (!token) {
		throw error(500, 'Missing recompute token in internal_tokens');
	}

	const res = await fetch(`${supabaseUrl}/functions/v1/recompute-stats`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-recompute-token': token,
			Authorization: `Bearer ${supabaseAnonKey}`,
			apikey: supabaseAnonKey
		},
		body: JSON.stringify({ minTurns: 10, minVictoryPoints: 0 })
	});

	if (res.ok) return;

	let detail = '';
	try {
		detail = await res.text();
	} catch {
		// ignore
	}
	throw error(500, `Failed to recompute stats: ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`);
}

export const load: PageServerLoad = async () => {
	const MIN_TURNS_TO_SHOW = 10;
	const supabaseAdmin = getSupabaseAdmin();
	if (!supabaseAdmin) {
		return {
			games: [],
			configError:
				'Missing SUPABASE_SERVICE_ROLE_KEY on the server. Add it to `.env` to enable admin game verification.'
		};
	}

	const [{ data: summaries, error: fetchError }, { data: metaRows, error: metaError }] =
		await Promise.all([
			supabaseAdmin
				.from('game_summaries')
				.select(
					'game_id, verified, verified_at, verified_by, started_at, ended_at, navigation_count, player_count, avg_navigation_ms, winner_guardian, winner_vp'
				)
				.gt('navigation_count', MIN_TURNS_TO_SHOW)
				.order('ended_at', { ascending: false }),
			supabaseAdmin.from('game_metadata').select('game_id, display_name')
		]);

	if (fetchError) {
		throw error(500, `Failed to load games: ${fetchError.message}`);
	}
	if (metaError) {
		throw error(500, `Failed to load game metadata: ${metaError.message}`);
	}

	const displayNames = new Map<string, string | null>(
		((metaRows as Array<{ game_id: string; display_name: string | null }> | null) ?? []).map(
			(r) => [r.game_id, r.display_name]
		)
	);

	const games: GameSummaryRow[] = (summaries as Omit<GameSummaryRow, 'display_name'>[] | null ?? []).map(
		(g) => ({ ...g, display_name: displayNames.get(g.game_id) ?? null })
	);

	return {
		games,
		configError: null
	};
};

export const actions: Actions = {
	recompute: async () => {
		const supabaseAdmin = getSupabaseAdmin();
		if (!supabaseAdmin) throw error(500, 'Missing SUPABASE_SERVICE_ROLE_KEY on the server');

		await recomputeVerifiedStats(supabaseAdmin);
		throw redirect(303, '/admin/games');
	},
	verify: async ({ request }) => {
		const supabaseAdmin = getSupabaseAdmin();
		if (!supabaseAdmin) throw error(500, 'Missing SUPABASE_SERVICE_ROLE_KEY on the server');

		const form = await request.formData();
		const gameId = String(form.get('gameId') ?? '').trim();
		if (!gameId) throw error(400, 'Missing gameId');

		const { error: upsertError } = await supabaseAdmin.from('verified_games').upsert({
			game_id: gameId,
			verified_by: 'admin'
		});

		if (upsertError) {
			throw error(500, `Failed to verify game: ${upsertError.message}`);
		}

		await recomputeVerifiedStats(supabaseAdmin);
		throw redirect(303, '/admin/games');
	},
	unverify: async ({ request }) => {
		const supabaseAdmin = getSupabaseAdmin();
		if (!supabaseAdmin) throw error(500, 'Missing SUPABASE_SERVICE_ROLE_KEY on the server');

		const form = await request.formData();
		const gameId = String(form.get('gameId') ?? '').trim();
		if (!gameId) throw error(400, 'Missing gameId');

		const { error: deleteError } = await supabaseAdmin
			.from('verified_games')
			.delete()
			.eq('game_id', gameId);

		if (deleteError) {
			throw error(500, `Failed to unverify game: ${deleteError.message}`);
		}

		await recomputeVerifiedStats(supabaseAdmin);
		throw redirect(303, '/admin/games');
	},
	rename: async ({ request }) => {
		const supabaseAdmin = getSupabaseAdmin();
		if (!supabaseAdmin) throw error(500, 'Missing SUPABASE_SERVICE_ROLE_KEY on the server');

		const form = await request.formData();
		const gameId = String(form.get('gameId') ?? '').trim();
		const rawName = String(form.get('displayName') ?? '');
		const trimmed = rawName.trim();
		if (!gameId) throw error(400, 'Missing gameId');
		if (trimmed.length > 120) throw error(400, 'displayName must be ≤ 120 chars');

		// Empty string clears the display name (back to the raw game_id).
		if (trimmed === '') {
			const { error: delErr } = await supabaseAdmin
				.from('game_metadata')
				.delete()
				.eq('game_id', gameId);
			if (delErr) throw error(500, `Failed to clear name: ${delErr.message}`);
		} else {
			const { error: upsertErr } = await supabaseAdmin.from('game_metadata').upsert({
				game_id: gameId,
				display_name: trimmed,
				updated_at: new Date().toISOString()
			});
			if (upsertErr) throw error(500, `Failed to rename game: ${upsertErr.message}`);
		}

		throw redirect(303, '/admin/games');
	},
	delete: async ({ request }) => {
		const supabaseAdmin = getSupabaseAdmin();
		if (!supabaseAdmin) throw error(500, 'Missing SUPABASE_SERVICE_ROLE_KEY on the server');

		const form = await request.formData();
		const gameId = String(form.get('gameId') ?? '').trim();
		const confirm = String(form.get('confirm') ?? '');
		if (!gameId) throw error(400, 'Missing gameId');
		// Required typed-confirmation guard so a misclick can't wipe a game.
		if (confirm !== gameId) {
			throw error(400, 'Delete confirmation must match the game id exactly');
		}

		// Delete from every base table that holds rows for this game. Order
		// doesn't strictly matter (no enforced FKs), but doing snapshots last
		// keeps the row visible if an earlier delete fails.
		for (const table of GAME_TABLES_TO_DELETE) {
			if (table === 'game_state_snapshots') continue;
			const { error: delErr } = await supabaseAdmin.from(table).delete().eq('game_id', gameId);
			if (delErr) {
				throw error(500, `Failed to delete from ${table}: ${delErr.message}`);
			}
		}
		const { error: snapErr } = await supabaseAdmin
			.from('game_state_snapshots')
			.delete()
			.eq('game_id', gameId);
		if (snapErr) throw error(500, `Failed to delete snapshots: ${snapErr.message}`);

		// play_game_sessions lives in the 2D engine schema, so it needs its own
		// schema-bound client (the default supabaseAdmin is bound to arc_spirits_game).
		const playAdmin = getSupabaseAdmin(PLAY_SCHEMA);
		if (playAdmin) {
			const { error: sessErr } = await playAdmin
				.from('play_game_sessions')
				.delete()
				.eq('game_id', gameId);
			if (sessErr) throw error(500, `Failed to delete play sessions: ${sessErr.message}`);
		}

		// Don't await recompute — it can take a while and we want the redirect
		// snappy. The next admin action will pick up fresh stats.
		recomputeVerifiedStats(supabaseAdmin).catch(() => {
			// best-effort; if it fails the admin can hit Recompute Stats manually
		});

		throw redirect(303, '/admin/games');
	}
};
