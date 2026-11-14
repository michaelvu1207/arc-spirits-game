import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { aiPlayersEnabled } from '$lib/play/server/aiPlayers';

/**
 * Public client bootstrap config for cookieless native clients (Godot).
 *
 * Everything returned here is ALREADY public: the Supabase URL + anon key ship in
 * every web bundle (`$env/dynamic/public`), and the WS origin is in `.env.example`.
 * Serving them from the API means the Godot client needs exactly ONE configured
 * origin (`--base`) instead of a per-export copy of the Supabase project config —
 * the same "one public origin, everything else derived" convention the Capacitor
 * shell uses. No secrets: the service-role key and host/admin secrets are never
 * exposed on any code path here.
 */
export const GET: RequestHandler = async () => {
	const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL?.trim();
	const supabaseAnonKey = publicEnv.PUBLIC_SUPABASE_ANON_KEY?.trim();
	if (!supabaseUrl || !supabaseAnonKey) {
		throw error(503, 'Native authentication is not configured');
	}
	return json(
		{
			supabaseUrl,
			supabaseAnonKey,
			wsUrl: publicEnv.PUBLIC_WS_SERVER_URL ?? '',
			// The room lobby offers "+ Add AI" only when the AI worker key is configured.
			aiPlayers: aiPlayersEnabled()
		},
		{ headers: { 'cache-control': 'public, max-age=300' } }
	);
};
