import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * OAuth / PKCE callback. Providers (and password-reset links) redirect here with a
 * `?code=`; we exchange it for a session (written to cookies by the SSR client) and
 * bounce to `next`. Safe-listed to same-origin paths only.
 */
export const GET: RequestHandler = async ({ url, locals: { supabase } }) => {
	const code = url.searchParams.get('code');
	const next = url.searchParams.get('next') ?? '/game';
	const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/game';

	if (code) {
		const { error } = await supabase.auth.exchangeCodeForSession(code);
		if (!error) throw redirect(303, safeNext);
	}

	throw redirect(303, `/account?error=auth_callback_failed`);
};
