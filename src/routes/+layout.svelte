<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { browser, dev } from '$app/environment';
	import { page } from '$app/stores';
	import { invalidate } from '$app/navigation';
	import TopBar from '$lib/components/TopBar.svelte';
	import { stopMenu } from '$lib/stores/menuAudio.svelte';
	import { auth } from '$lib/auth/auth.svelte';
	import { capacitorOAuthDeps, isNativeShell, resumeColdStartOAuth } from '$lib/auth/nativeOAuth';
	import { resetPlayIdentityState } from '$lib/stores/playStore.svelte';
	import { isE2eHarness } from '$lib/play/e2eHarness';
	import { getAccessibilitySettings } from '$lib/stores/accessibilitySettings.svelte';

	let { data, children } = $props();
	const accessibility = getAccessibilitySettings();
	const playSurface = $derived(
		$page.url.pathname === '/' || $page.url.pathname.startsWith('/play')
	);

	// NATIVE COLD START ONLY: if iOS killed the app while the OAuth browser sheet
	// was up, the callback deep link arrives as this process's LAUNCH URL instead of
	// a warm appUrlOpen event. Resume the PKCE exchange exactly once (nativeOAuth's
	// shared consumed-code ledger dedupes against any warm duplicate) and refresh
	// auth-derived state iff a session materialized. Web builds never enter this.
	onMount(() => {
		if (!isNativeShell()) return;
		resumeColdStartOAuth(data.supabase.auth, {
			...capacitorOAuthDeps(),
			// A wrong-identity session the resume cannot provably sign out escalates
			// to the store's fail-closed quarantine (blocks all authenticated
			// activity until the cleanup verifiably lands).
			onQuarantineUnclean: () => auth.enterAuthQuarantine()
		})
			.then((established) => (established ? invalidate('supabase:auth') : undefined))
			.catch((err: unknown) => {
				// Non-secret by construction — nativeOAuth never embeds codes/tokens.
				console.warn(
					'OAuth cold-start resume failed:',
					err instanceof Error ? err.message : String(err)
				);
			});
	});

	// DEV/E2E-ONLY test hook: Playwright suites establish the same anonymous guest
	// identity a real player gets (auth.resolvePlayIdentity) before driving the play
	// API from their browser context. The `?e2e` gate exists because the journey's
	// deterministic lane runs the BUILT preview bundle (dev=false); the hook is
	// READ-ONLY introspection of the viewer's own auth state — no secrets, no
	// overrides (see $lib/play/e2eHarness.ts).
	if (browser && (dev || isE2eHarness())) {
		(window as unknown as { __arcAuth?: typeof auth }).__arcAuth = auth;
	}

	// Push the freshest SSR→CSR auth state into the shared auth store (reactive on
	// every layout re-load, i.e. every `invalidate('supabase:auth')`), and reset all
	// account-specific play state the moment the durable identity CHANGES (sign-out,
	// account switch, deletion). ORDER MATTERS: the auth store is synchronized FIRST,
	// so the reset's fenced re-entry (and any request it issues) already speaks for
	// the NEW identity — cookie and Bearer alike; the reset then bumps the identity
	// generation and tears the live room transport/timers down synchronously, so a
	// cached socket/member or a held in-flight response can never keep acting (or
	// repopulate state) as the previous account.
	let lastUserId: string | null | undefined = undefined;
	$effect(() => {
		const nextUserId = data.user?.id ?? null;
		const identityChanged = browser && lastUserId !== undefined && lastUserId !== nextUserId;
		lastUserId = nextUserId;
		auth.sync(data.supabase, data.session, data.user, data.profile);
		if (identityChanged) {
			resetPlayIdentityState();
		}
	});

	// Re-validate when the session changes anywhere (token refresh, sign in/out, a
	// second tab) so all tabs converge. This runs on EVERY build target — the
	// Capacitor shell must observe its in-app sign-ins too, or auth.session stays
	// null and cross-origin requests never carry their Bearer token.
	$effect(() => {
		const { data: sub } = data.supabase.auth.onAuthStateChange((event, newSession) => {
			// Re-sync on a token change (refresh) OR an explicit identity event from any
			// tab (sign in/out elsewhere, email/name change → USER_UPDATED). INITIAL_SESSION
			// (fired on every re-subscribe) is intentionally excluded to avoid a loop.
			if (
				event === 'SIGNED_IN' ||
				event === 'SIGNED_OUT' ||
				event === 'USER_UPDATED' ||
				newSession?.expires_at !== data.session?.expires_at
			) {
				invalidate('supabase:auth');
			}
		});
		return () => sub.subscription.unsubscribe();
	});

	// Audio lives ONLY in the immersive /play experience. The menu theme is a
	// module-scoped <audio> that keeps playing across client-side navigation, so
	// silence it whenever we're on a main-website (non-/play) route. The main site
	// has no music of its own (the site soundtrack was removed).
	$effect(() => {
		if (!playSurface) {
			stopMenu();
		}
	});

	// One document-level contract keeps browser zoom, scalable type, contrast and
	// pseudo-localization consistent across every route (including portals/dialogs).
	$effect(() => {
		if (!browser) return;
		const root = document.documentElement;
		root.lang = accessibility.locale;
		root.dataset.textScale = accessibility.textScale;
		root.dataset.highContrast = accessibility.highContrast ? 'true' : 'false';
		root.dataset.locale = accessibility.locale;
	});

	// ── Social embeds (Open Graph + Twitter/X cards) ─────────────────────────────
	// Shown when the site is shared on Discord, X, Slack, iMessage, etc. Absolute URLs
	// are derived from the live request origin, so the embeds keep working unchanged on
	// any domain (the current *.vercel.app, a preview deploy, or a future custom domain).
	const SITE_NAME = 'Arc Spirits';
	const SITE_TITLE = 'Arc Spirits — Spirit-Summoning Strategy';
	const SITE_DESC =
		'Summon spirits, awaken their classes, and outwit the Arcane Abyss in a competitive spirit-summoning strategy game.';
	const canonicalUrl = $derived(`${$page.url.origin}${$page.url.pathname}`);
	const ogImageUrl = $derived(`${$page.url.origin}/og-image.png`);
</script>

<svelte:head>
	<!-- No <title> here on purpose: each route sets its own (browsers would otherwise
	     favour this generic one over the page-specific title). Embeds read og:title below. -->
	<meta name="description" content={SITE_DESC} />
	<link rel="canonical" href={canonicalUrl} />
	<link rel="icon" href="/favicon.png" type="image/png" />
	<meta name="theme-color" content="#050310" />

	<!-- Open Graph: Discord, Facebook, Slack, iMessage, LinkedIn… -->
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:title" content={SITE_TITLE} />
	<meta property="og:description" content={SITE_DESC} />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:image" content={ogImageUrl} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="Arc Spirits — Fight for the Arcane Abyss" />

	<!-- Twitter / X card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={SITE_TITLE} />
	<meta name="twitter:description" content={SITE_DESC} />
	<meta name="twitter:image" content={ogImageUrl} />
	<meta name="twitter:image:alt" content="Arc Spirits — Fight for the Arcane Abyss" />
</svelte:head>

<div class="app haunted-bg">
	{#if !playSurface}
		<TopBar />
	{/if}
	<div class="flex-1">
		{@render children()}
	</div>
</div>

<!-- Soft edge-blur vignette: a masked full-screen backdrop blur that only
     affects the page's outer rim (transparent through the centre). -->
<div class="edge-blur" aria-hidden="true"></div>

<style>
	.app {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		position: relative;
		z-index: 1;
	}

	/* Very subtle edge blur framing the whole viewport. The radial mask leaves the
	   centre crisp (transparent → no backdrop-filter) and eases the blur in only
	   toward the outer rim. Non-interactive; sits above everything. */
	.edge-blur {
		position: fixed;
		inset: 0;
		z-index: 9000;
		pointer-events: none;
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		-webkit-mask: radial-gradient(
			ellipse 82% 82% at 50% 50%,
			transparent 60%,
			rgba(0, 0, 0, 0.85) 100%
		);
		mask: radial-gradient(ellipse 82% 82% at 50% 50%, transparent 60%, rgba(0, 0, 0, 0.85) 100%);
	}

	/* Pure decoration. A full-viewport backdrop blur is the single worst case on
	   mobile GPUs, so drop it entirely on phones and any coarse-pointer device. */
	@media (max-width: 600px), (pointer: coarse) {
		.edge-blur {
			display: none;
		}
	}
</style>
