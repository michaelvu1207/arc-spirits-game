import { error } from '@sveltejs/kit';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { explorerJson } from '$lib/server/explorerJson';
import type { RequestHandler } from './$types';

/**
 * The balance data the explorer shows (local game only, see $lib/explorer.ts): one JSON file
 * written by the balance tools from the finished AI test games. Compressed and tagged
 * ($lib/server/explorerJson.ts); a new file shows without a restart. `ARC_BALANCE_FILE` names the file; the default is
 * `../balance/dashboard.json` beside this repo.
 */
/** The file also carries the script that made it (for the dashboard's source panel); that part is not served. */
const withoutSource = (text: string) => {
	const data: Record<string, unknown> = JSON.parse(text);
	delete data.meta;
	delete data.rows;
	return JSON.stringify(data);
};

export const GET: RequestHandler = async ({ request }) => {
	if (publicEnv.PUBLIC_ARC_LOCAL_EXPLORER !== '1') throw error(404, 'Not found');
	const file = env.ARC_BALANCE_FILE || path.resolve(process.cwd(), '..', 'balance', 'dashboard.json');
	const answer = await explorerJson(request, file, withoutSource);
	if (!answer) throw error(404, 'No balance data yet');
	return answer;
};
