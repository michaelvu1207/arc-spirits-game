// Vite config for `npm run local` (scripts/local-game/start.mjs). It is the normal
// vite.config.ts plus:
// - a dev-server proxy: the Supabase paths go to the local backend, so the browser talks to
//   "Supabase" on the app's own origin (start.mjs sets PUBLIC_SUPABASE_SAME_ORIGIN=1, and the
//   CSP ('self') allows it with no change to svelte.config.js);
// - Tailscale: `tailscale serve --https=<port> http://127.0.0.1:<port>` reaches this server as
//   https://<machine>.<tailnet>.ts.net:<port>. Vite only answers known host names, so *.ts.net is
//   allowed. Tailscale ends TLS and forwards plain HTTP with `x-forwarded-proto: https`, so the
//   app sees its own origin as http://<host> while the browser sends `Origin: https://<host>`;
//   the play API's Origin check would refuse every POST. For those requests the Origin is set to
//   the http form of the same host (the host must still match exactly).
import { mergeConfig } from 'vite';
import base from '../../vite.config.ts';

const backendPort = Number(process.env.ARC_LOCAL_BACKEND_PORT);
if (!backendPort) throw new Error('ARC_LOCAL_BACKEND_PORT is not set: start the local game with `npm run local`.');
const target = `http://127.0.0.1:${backendPort}`;

/** @type {import('vite').Plugin} */
const httpsProxyOrigin = {
	name: 'arc-local-https-proxy-origin',
	configureServer(server) {
		server.middlewares.use((req, _res, next) => {
			const host = req.headers.host;
			if (req.headers['x-forwarded-proto'] === 'https' && host && req.headers.origin === `https://${host}`) {
				req.headers.origin = `http://${host}`;
			}
			next();
		});
	}
};

// start.mjs gives each local game its own SvelteKit folder (ARC_SVELTEKIT_OUT_DIR); Vite's cache
// goes there too. The SvelteKit folders of other dev servers in this checkout (.svelte-kit,
// .svelte-kit-local-<other port>) are not watched: their rewrites would reload the open pages.
const ownOutDir = process.env.ARC_SVELTEKIT_OUT_DIR ?? '.svelte-kit';
const otherSvelteKitDir = (path) => {
	const m = path.match(/[\\/](\.svelte-kit[^\\/]*)([\\/]|$)/);
	return !!m && m[1] !== ownOutDir;
};

export default mergeConfig(base, {
	plugins: [httpsProxyOrigin],
	cacheDir: `${ownOutDir}/vite`,
	server: {
		allowedHosts: ['.ts.net'],
		watch: { ignored: [otherSvelteKitDir] },
		proxy: {
			'/rest/v1': { target },
			'/auth/v1': { target },
			'/storage/v1': { target },
			'/realtime/v1': { target, ws: true },
			'/__local': { target }
		}
	}
});
