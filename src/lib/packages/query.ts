/**
 * The small part of the PostgREST query language the game-data reads use, answered from the rows
 * of a package table (see ./index.ts). Flat selects only: `select`, `order`, `limit`, `offset` and
 * the filters eq / neq / in / cs / is.null / not.is.null — the same set the local game's file
 * backend supports (scripts/local-game/backend.mjs), which already runs the whole site.
 */
export type Row = Record<string, unknown>;

const listOf = (raw: string, prefix: string): string[] =>
	raw
		.slice(prefix.length, -1)
		.split(',')
		.map((v) => v.replace(/^"|"$/g, ''));

function filterFor(key: string, raw: string): ((row: Row) => boolean) | null {
	if (raw.startsWith('eq.')) return (r) => String(r[key]) === raw.slice(3);
	if (raw.startsWith('neq.')) return (r) => String(r[key]) !== raw.slice(4);
	if (raw.startsWith('in.(')) {
		const values = listOf(raw, 'in.(');
		return (r) => values.includes(String(r[key]));
	}
	if (raw.startsWith('cs.{')) {
		const values = listOf(raw, 'cs.{');
		return (r) => Array.isArray(r[key]) && values.every((v) => (r[key] as unknown[]).includes(v));
	}
	if (raw === 'is.null') return (r) => r[key] == null;
	if (raw === 'not.is.null') return (r) => r[key] != null;
	return null;
}

function compare(a: unknown, b: unknown): number {
	if (a == null && b == null) return 0;
	if (a == null) return 1; // nulls last, as PostgREST does for ascending order
	if (b == null) return -1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Apply a PostgREST query string to `rows`. Unknown filters are reported in `unsupported`. */
export function queryRows(
	rows: readonly Row[],
	params: URLSearchParams
): { rows: Row[]; unsupported: string[] } {
	const unsupported: string[] = [];
	let found = [...rows];
	for (const [key, raw] of params.entries()) {
		if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
		const filter = filterFor(key, raw);
		if (filter) found = found.filter(filter);
		else unsupported.push(`${key}=${raw}`);
	}
	const order = params.get('order');
	if (order) {
		const keys = order.split(',').map((part) => {
			const [column, ...mods] = part.trim().split('.');
			return { column, desc: mods.includes('desc') };
		});
		found.sort((x, y) => {
			for (const { column, desc } of keys) {
				const c = compare(x[column], y[column]);
				if (c !== 0) return desc ? -c : c;
			}
			return 0;
		});
	}
	const offset = Number(params.get('offset') ?? 0);
	if (offset > 0) found = found.slice(offset);
	const limit = Number(params.get('limit'));
	if (limit > 0) found = found.slice(0, limit);
	const select = params.get('select');
	if (select && select !== '*' && !/[()]/.test(select)) {
		const columns = select
			.split(',')
			.map((c) => c.trim())
			.filter(Boolean);
		found = found.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
	}
	return { rows: found, unsupported };
}
