/**
 * A `fetch` for the game-data ("assets") Supabase client that answers table reads from the live
 * game package instead of the network. The client code (`supabaseAssets.from('hex_spirits')
 * .select(...)`) is unchanged; only its transport is. Anything that is not a table read
 * (`/rest/v1/<table>`) goes to the real fetch.
 */
import { loadPackageTables } from './index';
import { queryRows } from './query';

const REST_PREFIX = '/rest/v1/';

export function createPackageFetch(realFetch: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
		const at = url.pathname.indexOf(REST_PREFIX);
		if (at < 0) return realFetch(input, init);
		const table = decodeURIComponent(url.pathname.slice(at + REST_PREFIX.length));
		const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
		const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json', ...extra }
			});
		if (method !== 'GET' && method !== 'HEAD')
			return json(405, { message: 'game data is read only: publish a new package to change it' });
		const tables = await loadPackageTables();
		// A table the package does not have reads as empty (like the optional tables monster_pools
		// and rules on an old package): the callers treat "no rows" as "feature off".
		const { rows, unsupported } = queryRows(tables[table] ?? [], url.searchParams);
		if (unsupported.length)
			console.warn(`[game package] unsupported filter on ${table}: ${unsupported.join(', ')} (ignored)`);
		const range = { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
		const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
		if ((headers.get('accept') ?? '').includes('vnd.pgrst.object+json')) {
			if (rows.length !== 1)
				return json(
					406,
					{
						code: 'PGRST116',
						details: `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
						hint: null,
						message: 'JSON object requested, multiple (or no) rows returned'
					},
					range
				);
			return json(200, rows[0], range);
		}
		return json(200, method === 'HEAD' ? undefined : rows, range);
	};
}
