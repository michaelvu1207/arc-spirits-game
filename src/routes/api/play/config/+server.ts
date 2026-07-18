import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';

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
	const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
	const supabaseAnonKey = publicEnv.PUBLIC_SUPABASE_ANON_KEY;
	if (!supabaseUrl || !supabaseAnonKey) {
		throw error(503, 'Native authentication is not configured');
	}
	return json(
		{
			supabaseUrl,
			supabaseAnonKey,
			wsUrl: publicEnv.PUBLIC_WS_SERVER_URL ?? ''
		},
		{ headers: { 'cache-control': 'public, max-age=300' } }
	);
};
