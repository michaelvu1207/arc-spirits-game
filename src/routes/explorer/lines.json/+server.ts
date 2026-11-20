import { error } from '@sveltejs/kit';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { explorerJson } from '$lib/server/explorerJson';
import type { RequestHandler } from './$types';

/**
 * Round-by-round lines of the AI test games, for the data editor's Game explorer (local game only,
 * see $lib/explorer.ts): each seat's points at the end of every round with its board then. The
 * balance tools write one file per tested setup plus `index.json` into `../balance/lines` beside
 * this repo (`ARC_BALANCE_LINES` names another folder). `?setup=<id>` picks the file; without it
 * the index is returned. Compressed and tagged ($lib/server/explorerJson.ts); a new file shows
 * without a restart.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	if (publicEnv.PUBLIC_ARC_LOCAL_EXPLORER !== '1') throw error(404, 'Not found');
	const setup = url.searchParams.get('setup') ?? 'index';
	if (!/^[a-z0-9_-]{1,40}$/i.test(setup)) throw error(400, 'Bad setup id');
	const dir = env.ARC_BALANCE_LINES || path.resolve(process.cwd(), '..', 'balance', 'lines');
	const answer = await explorerJson(request, path.join(dir, `${setup}.json`));
	if (!answer) throw error(404, 'No lines for this setup yet');
	return answer;
};
