import type { CapacitorConfig } from '@capacitor/cli';

const devServerUrl = process.env.CAP_SERVER_URL;

/**
 * Capacitor native shell config. The web app stays SSR on Vercel; the native
 * app bundles a STATIC build of the client (see `npm run build:app`, which sets
 * BUILD_TARGET=capacitor → adapter-static) and talks to the Vercel-hosted API
 * over https via PUBLIC_API_BASE_URL. See CAPACITOR.md for the full setup.
 */
const config: CapacitorConfig = {
	appId: 'com.arcspirits.app',
	appName: 'Arc Spirits',
	// adapter-static (SPA fallback) writes the client bundle here.
	webDir: 'build',
	backgroundColor: '#050310',
	plugins: {
		SplashScreen: {
			backgroundColor: '#050310',
			showSpinner: false,
			launchAutoHide: true
		},
		StatusBar: {
			style: 'DARK',
			backgroundColor: '#050310'
		}
	},
	...(devServerUrl
		? {
				server: {
					url: devServerUrl,
					cleartext: devServerUrl.startsWith('http://')
				}
			}
		: {})
};

export default config;
