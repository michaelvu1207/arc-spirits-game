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
/** The data editor (port 8787 of this machine, or of its tailnet name) also reads the file, from its own pages. */
const EDITOR_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net):8787$/;

export const GET: RequestHandler = async ({ request }) => {
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
	const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' };
	const origin = request.headers.get('origin');
	if (origin && EDITOR_ORIGIN.test(origin)) headers['access-control-allow-origin'] = origin;
	return new Response(JSON.stringify(data), { headers });
};
