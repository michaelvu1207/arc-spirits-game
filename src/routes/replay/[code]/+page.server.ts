import type { PageServerLoad } from './$types';
import { loadSharedReplay } from '$lib/play/server/replaySharing';

export const load: PageServerLoad = async ({ params }) => ({
	replay: await loadSharedReplay(params.code)
});
