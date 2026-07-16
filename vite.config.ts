import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

// E2E STORE PROXY (deterministic journey lane): when set, `vite preview` proxies
// the Supabase wire paths to the gate-owned local store emulator. The journey's
// production-preview build bakes PUBLIC_SUPABASE_URL as its OWN origin
// (http://localhost:4173), so the browser talks to the store SAME-ORIGIN — which
// lets the lane run the REAL release CSP posture (production connect-src admits
// no loopback origin) instead of weakening the policy for tests. A plain
// preview without this env var proxies nothing. Never consulted by dev/build.
const e2eStoreProxy = process.env.ARC_E2E_STORE_PROXY;
const previewProxy = e2eStoreProxy
	? Object.fromEntries(
			['/rest', '/auth', '/storage'].map((path) => [path, { target: e2eStoreProxy }])
		)
	: undefined;

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	preview: {
		proxy: previewProxy
	},
	server: {
		// The play client statically imports wire-protocol constants from `server/protocol.ts`
		// (via src/lib/play/wsProtocol.ts). That path lives OUTSIDE src/, so dev Vite refuses to
		// serve it to the browser ("outside of Vite serving allow list") and the play room UI
		// crashes on hydration. Allow the repo root so the sibling `server/` dir is servable in dev.
		fs: { allow: [searchForWorkspaceRoot(process.cwd()), '.'] }
	},
	build: {
		rollupOptions: {
			output: {
				// Group the 3-D engine into its own lazy chunk so it is never included
				// in the initial bundle. SplatBackground.svelte imports both libraries
				// dynamically (await import(...) inside onMount), so Rollup will only
				// fetch this chunk when the splat renderer actually initialises.
				manualChunks(id) {
					if (id.includes('three') || id.includes('@sparkjsdev/spark')) {
						return 'spark';
					}
				}
			}
		}
	},
	test: {
		// server/**: the standalone WS room server's authority/recovery suites (they
		// import the engine via relative paths, so the same vitest run covers them).
		// scripts/**/*.test: gate-infrastructure regressions (process ownership) —
		// `.test` only, NOT `.spec`: scripts/csp-artifact.spec.ts is a Playwright
		// spec driven by its own config and must never run under vitest.
		include: [
			'src/**/*.{test,spec}.{ts,js}',
			'server/**/*.{test,spec}.{ts,js}',
			'scripts/**/*.test.{ts,js}'
		]
	}
});
