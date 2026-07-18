import type { PageServerLoad } from './$types';
import { previewSocialInvite } from '$lib/play/server/social';

export const load: PageServerLoad = async ({ params }) => ({
	token: params.token,
	invite: await previewSocialInvite(params.token)
});
