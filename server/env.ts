/**
 * Minimal .env loader for the standalone room server. SvelteKit's `$env/*` virtual
 * modules do not exist outside a Vite build, so `npx tsx server/index.ts` reads the
 * repo's dotenv files directly. No dependency on `dotenv` — a tiny KEY=VALUE parser
 * covers the handful of vars we need.
 *
 * Precedence (later wins): repo-root `.env` → repo-root `.env.local` → `server/.env`.
 * A value already present in `process.env` (a real shell export) is NEVER overwritten,
 * so container/CI secrets take priority over any committed file.
 *
 * SECURITY: this only ever writes into `process.env`; it never logs a value.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		// Strip a single layer of matching quotes.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) out[key] = value;
	}
	return out;
}

function applyFile(path: string): void {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return; // absent file is fine
	}
	for (const [key, value] of Object.entries(parseDotenv(text))) {
		// A real shell export always wins over a committed file.
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

let loaded = false;

/** Load dotenv files into `process.env` exactly once. Idempotent. */
export function loadEnv(): void {
	if (loaded) return;
	loaded = true;
	applyFile(join(REPO_ROOT, '.env'));
	applyFile(join(REPO_ROOT, '.env.local'));
	applyFile(join(HERE, '.env'));
}

/** Read a required env var, throwing a clear (secret-free) error when missing. */
export function requireEnv(name: string): string {
	loadEnv();
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`Missing required env var ${name}. Set it in the shell or in .env / .env.local / server/.env.`
		);
	}
	return value;
}

/** Read an optional env var. */
export function optionalEnv(name: string): string | undefined {
	loadEnv();
	return process.env[name] || undefined;
}
