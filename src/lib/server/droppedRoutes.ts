/**
 * Routes of features that were DROPPED when the site moved to the minimal Supabase project
 * (accounts, casual rooms, finished-game records and replays only). Their tables, views and
 * RPCs (ranked seasons, ratings, matchmaking queue, friends/parties/invites/presence,
 * cosmetics/progression/achievements, composition tagging, the old admin stats pages and the
 * arc_spirits_assets design tables) do not exist there, so every page and API under these
 * paths answers 404 instead of failing against a missing table. The files stay in the repo
 * so the cut is reversible: delete an entry here to bring a route back.
 *
 * The local game (scripts/local-game, PUBLIC_ARC_LOCAL_EXPLORER=1) runs its own emulated
 * database and its explorer frames the old admin pages, so the guard is off there.
 */

/** Path prefixes: a request matches when its path equals the prefix or continues with `/`. */
export const DROPPED_ROUTE_PREFIXES = [
	'/play/ranked',
	'/play/champions',
	'/play/builder',
	'/invite',
	'/admin',
	'/frame-editor',
	'/api/play/matchmaking',
	'/api/play/ranked',
	'/api/play/progression',
	'/api/play/social',
	'/api/notes',
	'/api/compositions',
	'/api/composition-targets',
	'/api/composition-analysis',
	'/api/player-compositions'
] as const;

/** Ranked-only room endpoints (the room itself is kept). */
const DROPPED_ROOM_ENDPOINT = /^\/api\/play\/sessions\/[^/]+\/concede\/?$/;

export function isDroppedRoute(pathname: string): boolean {
	if (DROPPED_ROOM_ENDPOINT.test(pathname)) return true;
	return DROPPED_ROUTE_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}
