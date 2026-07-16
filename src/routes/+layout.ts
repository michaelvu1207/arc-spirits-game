import { createBrowserClient, createServerClient, isBrowser } from '@supabase/ssr';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import type { LayoutLoad } from './$types';

const capacitorBuild = import.meta.env.VITE_BUILD_TARGET === 'capacitor';

export const ssr = !capacitorBuild;

type RootServerData = {
	cookies?: { name: string; value: string }[];
	profile?: { id: string; display_name: string; is_anonymous: boolean } | null;
	isAdmin?: boolean;
};

/**
 * Isomorphic Supabase auth client. On the browser it reads/writes the session
 * cookies directly (singleton-ish per load); during SSR it reuses the cookies the
 * server already parsed. `depends('supabase:auth')` lets `invalidate('supabase:auth')`
 * (fired on every auth state change) re-run this load so the session stays fresh.
 */
export const load: LayoutLoad = async ({ data, depends, fetch }) => {
	// EVERY build target re-runs this load on `invalidate('supabase:auth')` — the
	// Capacitor shell included. Skipping it there left `auth.session` null after an
	// in-app anonymous/email sign-in, so cross-origin play requests never carried
	// their Bearer token and 401'd until a full app restart.
	depends('supabase:auth');
	const serverData = data as unknown as RootServerData | undefined;

	const supabase = isBrowser()
		? createBrowserClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
				global: { fetch }
			})
		: createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
				global: { fetch },
				cookies: { getAll: () => serverData?.cookies ?? [] }
			});

	const {
		data: { session }
	} = await supabase.auth.getSession();

	const {
		data: { user }
	} = await supabase.auth.getUser();

	let profile = serverData?.profile ?? null;
	if (!profile && user) {
		const { data: profileData } = await supabase
			.from('profiles')
			.select('id, display_name, is_anonymous')
			.eq('id', user.id)
			.maybeSingle();
		profile = profileData
			? {
					id: profileData.id,
					display_name: profileData.display_name ?? 'Nameless Spirit',
					is_anonymous: profileData.is_anonymous ?? false
				}
			: null;
	}

	// Fetch the profile from the same Supabase client that restored the session.
	// This keeps the web build SSR-capable while also working in the Capacitor
	// shell, where there is no local SvelteKit server for root layout data.
	return {
		supabase,
		session,
		user,
		profile,
		isAdmin: serverData?.isAdmin ?? false
	};
};
