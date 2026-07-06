import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
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
		include: ['src/**/*.{test,spec}.{ts,js}']
	}
});
