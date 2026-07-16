import type { PageServerLoad } from './$types';
import {
	rankedArchive,
	rankedHistory,
	rankedLeaderboard,
	rankedSnapshot
} from '$lib/play/server/rankedSeasons';

export const load: PageServerLoad = async (event) => {
	const { user } = await event.locals.safeGetSession();
	let leaderboard: Awaited<ReturnType<typeof rankedLeaderboard>>;
	try {
		leaderboard = await rankedLeaderboard(50);
	} catch (error) {
		// A season is optional product state, not a page-level failure. Keep the
		// destination navigable before the first season and during service outages.
		console.warn('Ranked season unavailable; serving preseason state.', error);
		return {
			available: false,
			notice:
				'No ranked season is active right now. Practice in Quick Play while the next season is prepared.',
			leaderboard: { seasonId: 'preseason', seasonName: 'Ranked Preseason', entries: [] },
			snapshot: null,
			history: { events: [], seasons: [] },
			archive: { seasons: [] },
			signedIn: !!user
		};
	}

	const [snapshotResult, historyResult, archiveResult] = await Promise.allSettled([
		user ? rankedSnapshot(user.id) : Promise.resolve(null),
		user ? rankedHistory(user.id) : Promise.resolve({ events: [], seasons: [] }),
		rankedArchive(8)
	]);
	const degraded = [snapshotResult, historyResult, archiveResult].some(
		(result) => result.status === 'rejected'
	);
	if (degraded) console.warn('Some optional ranked season details are unavailable.');

	return {
		available: true,
		notice: degraded
			? 'Some season details are still syncing. Current standings remain available.'
			: null,
		leaderboard,
		snapshot: snapshotResult.status === 'fulfilled' ? snapshotResult.value : null,
		history:
			historyResult.status === 'fulfilled' ? historyResult.value : { events: [], seasons: [] },
		archive: archiveResult.status === 'fulfilled' ? archiveResult.value : { seasons: [] },
		signedIn: !!user
	};
};
