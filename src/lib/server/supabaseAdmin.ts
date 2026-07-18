import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env as publicEnv } from '$env/dynamic/public';
import { env } from '$env/dynamic/private';

const DEFAULT_SCHEMA = 'arc_spirits_game';

const cached = new Map<string, SupabaseClient<any, any, any>>();

export function getSupabaseAdmin(schema = DEFAULT_SCHEMA): SupabaseClient<any, any, any> | null {
	const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
	const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
	if (!serviceRoleKey || !supabaseUrl) return null;
	const existing = cached.get(schema);
	if (existing) return existing;
	const client = createClient(supabaseUrl, serviceRoleKey, {
		db: { schema },
		auth: { persistSession: false }
	});
	cached.set(schema, client);
	return client;
}
