/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

// `self` is the ServiceWorkerGlobalScope in this context.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `arc-spirits-shell-${version}`;

// Heavy media must NEVER be precached or cached: iOS PWA storage is ~50MB and
// would be evicted, and these stream fine from the network on demand. The printed
// monster cards (~7 MB, 108 files) load one card at a time when a card is dealt.
const HEAVY = /^\/(music|splats|sfx|monster-cards\/cards)\//;

// App shell: hashed build chunks + small static files (icons, fonts, favicon…),
// excluding the heavy media folders above.
const SHELL = [...build, ...files.filter((path) => !HEAVY.test(path))];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	// Drop caches from previous versions.
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => sw.clients.claim())
	);
});

const PRECACHED = new Set(SHELL);

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Only handle same-origin requests; let the API (realtime/view polling) and the
	// heavy media (and any cross-origin asset) go straight to the network untouched.
	if (url.origin !== location.origin) return;
	if (url.pathname.startsWith('/api/')) return;
	if (HEAVY.test(url.pathname)) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);

			// Content-hashed shell assets are immutable → cache-first.
			if (PRECACHED.has(url.pathname)) {
				const cached = await cache.match(url.pathname);
				if (cached) return cached;
			}

			// Everything else (HTML navigations, dynamic requests) → network-first,
			// falling back to cache when offline.
			try {
				const response = await fetch(request);
				// Only cache successful, same-origin (basic) responses.
				if (response.ok && response.type === 'basic') {
					cache.put(request, response.clone());
				}
				return response;
			} catch (err) {
				const cached = await cache.match(request);
				if (cached) return cached;
				throw err;
			}
		})()
	);
});
