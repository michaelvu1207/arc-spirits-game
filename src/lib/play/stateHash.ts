/**
 * Content hash of the authoritative room state, used to verify that every transport
 * (HTTP view, WebSocket ack/delta, Godot, web) is serving the SAME history at the same
 * revision — a fork detector, not a security primitive.
 *
 * The hash must survive a Postgres `jsonb` round-trip, which does NOT preserve object
 * key order and drops nothing else. So the serialization here is canonical: object keys
 * sorted, `undefined` values treated exactly like JSON.stringify (dropped from objects,
 * null in arrays). 64-bit FNV-1a over the canonical string — pure JS, no `crypto`
 * import, identical result in the SvelteKit server, the standalone room server, tests,
 * and any future client-side verifier.
 */

/** Append `value` to `out` as canonical JSON (sorted object keys). */
function canonicalize(value: unknown, out: string[]): void {
	if (value === null) {
		out.push('null');
		return;
	}
	switch (typeof value) {
		case 'number':
			// JSON.stringify(NaN/Infinity) === 'null'; keep the same convention so a state
			// that already survived a JSON round-trip hashes identically to the live object.
			out.push(Number.isFinite(value) ? String(value) : 'null');
			return;
		case 'boolean':
			out.push(value ? 'true' : 'false');
			return;
		case 'string':
			out.push(JSON.stringify(value));
			return;
		case 'object':
			break;
		default:
			// undefined / function / symbol inside an array → JSON semantics: null.
			out.push('null');
			return;
	}
	if (Array.isArray(value)) {
		out.push('[');
		for (let i = 0; i < value.length; i += 1) {
			if (i > 0) out.push(',');
			canonicalize(value[i], out);
		}
		out.push(']');
		return;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((key) => obj[key] !== undefined)
		.sort();
	out.push('{');
	for (let i = 0; i < keys.length; i += 1) {
		if (i > 0) out.push(',');
		out.push(JSON.stringify(keys[i]), ':');
		canonicalize(obj[keys[i]], out);
	}
	out.push('}');
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a of a string (UTF-16 code units), as 16 hex chars. */
function fnv1a64(text: string): string {
	let hash = FNV_OFFSET;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		hash ^= BigInt(code & 0xff);
		hash = (hash * FNV_PRIME) & MASK64;
		hash ^= BigInt(code >> 8);
		hash = (hash * FNV_PRIME) & MASK64;
	}
	return hash.toString(16).padStart(16, '0');
}

/** Same-object memo: the room server rebuilds views for many sockets from ONE state
 *  object per revision; hashing it once is enough. WeakMap keys on identity, so a
 *  mutated-and-reused object across revisions never collides (the server replaces the
 *  state object on every commit; serverless parses a fresh object per request). */
const memo = new WeakMap<object, string>();

/**
 * Canonical content hash of a game state (or any JSON-safe value). Stable across
 * jsonb round-trips, key-order shuffles, and `undefined`-vs-missing differences.
 */
export function hashGameState(state: object): string {
	const cached = memo.get(state);
	if (cached) return cached;
	const out: string[] = [];
	canonicalize(state, out);
	const hash = fnv1a64(out.join(''));
	memo.set(state, hash);
	return hash;
}
