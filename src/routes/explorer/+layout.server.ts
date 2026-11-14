import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import type { LayoutServerLoad } from './$types';

// The explorer exists only on the local game (see $lib/explorer.ts).
export const load: LayoutServerLoad = () => {
	if (env.PUBLIC_ARC_LOCAL_EXPLORER !== '1') throw error(404, 'Not found');
	return {};
};
