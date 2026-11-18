import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestHandler } from './$types';

/**
 * The balance data the explorer shows (local game only, see $lib/explorer.ts): one JSON file
 * written by the balance tools from the finished AI test games. It is read on every request,
 * so a new file shows without a restart. `ARC_BALANCE_FILE` names the file; the default is
 * `../balance/dashboard.json` beside this repo.
 */
export const GET: RequestHandler = async () => {
	if (publicEnv.PUBLIC_ARC_LOCAL_EXPLORER !== '1') throw error(404, 'Not found');
	const file = env.ARC_BALANCE_FILE || path.resolve(process.cwd(), '..', 'balance', 'dashboard.json');
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(await readFile(file, 'utf8'));
	} catch {
		throw error(404, 'No balance data yet');
	}
	// The file also carries the script that made it (for the dashboard's source panel).
	delete data.meta;
	delete data.rows;
	return new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
};
