<script lang="ts">
	import { browser } from '$app/environment';
	import { beforeNavigate, goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import {
		createSoloPlayRoom,
		restoreActiveMember,
		setActiveMember
	} from '$lib/stores/playStore.svelte';
	import { auth } from '$lib/auth/auth.svelte';
	import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
	import {
		QuickPlaySearch,
		QuickPlayAuthRequired,
		type QuickPlayPlayer,
		type QuickPlayQueueResult,
		type QuickPlayMatchInfo
	} from '$lib/play/quickPlaySearch';
	import { MatchedRoomNavigator, matchedRoomUrl } from '$lib/play/matchedRoomNav';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import ProfileDock from '$lib/components/play2d/ProfileDock.svelte';
	import GameIcon from '$lib/components/GameIcon.svelte';

	const hover = () => playMenuSfx('ui-hover', { volume: 0.45 });

	// Shared with the server browser's "Playing as" field so a returning player
	// keeps their name; Quick Play stays one-tap by falling back to a default.
	const NAME_KEY = 'arc-player-name';

	// ── Quick Play matchmaking (ranked only for verified accounts) ─────────────
	// The queue lifecycle lives in the framework-free QuickPlaySearch controller,
	// which owns its OWN canonical-identity + search-generation fence: cancel,
	// unmount, a newer search, or a durable UID change silences every prior poll,
	// timer, error and navigation, while a same-UID token refresh never interrupts
	// a valid search. This component only adapts its snapshots into $state.
	type QueuedPlayer = QuickPlayPlayer;

	// The main menu swaps to a dedicated full-screen ranked view (hiding the nav) while
	// the player is in/around the matchmaking queue. 'menu' shows the normal menu.
	let view = $state<'menu' | 'ranked'>('menu');
	let ranked = $state<'idle' | 'searching'>('idle');
	let rankedError = $state<string | null>(null);
	let rankedNeedsAuth = $state(false);
	let queued = $state(0);
	let needed = $state(0);
	let players = $state<QueuedPlayer[]>([]);
	/** SERVER-TRUTH metadata of the formed match (mode/rated as the server actually
	 *  formed it — a verified player whose party includes a guest plays CASUAL).
	 *  Shown while the navigation into the room is in flight. */
	let matchFound = $state<QuickPlayMatchInfo | null>(null);
	let searchStartedAt = $state(0);
	let elapsed = $state(0);
	let rankedTickTimer: ReturnType<typeof setInterval> | null = null;
	let mounted = $state(false);
	let soloStarting = $state(false);
	let soloError = $state<string | null>(null);

	/** Whether THIS player's Quick Play would actually be RANKED: only a verified
	 *  (permanent) account plays rated — a guest plays a casual, unrated match. The
	 *  queue/searching UI labels itself from this, never claiming "ranked" for a
	 *  guest. */
	const rankedEligible = $derived(auth.isPermanent);

	/** POST a matchmaking endpoint, forwarding the Bearer token cross-origin
	 *  (Capacitor). The token is read at CALL time, so a same-UID refresh simply
	 *  rides along on the next poll. */
	async function postMatchmaking(
		path: string,
		body: Record<string, unknown> = {}
	): Promise<QuickPlayQueueResult> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (isCrossOrigin) {
			const token = auth.session?.access_token;
			if (token) headers['Authorization'] = `Bearer ${token}`;
		}
		const res = await fetch(apiUrl(path), {
			method: 'POST',
			headers,
			credentials: isCrossOrigin ? 'include' : 'same-origin',
			body: JSON.stringify(body)
		});
		const payload = (await res.json().catch(() => null)) as
			| QuickPlayQueueResult
			| { message?: string }
			| null;
		if (!res.ok) {
			if (res.status === 401) {
				// An honest 401 split: with NO local identity the guest sign-in itself
				// failed (a transport/auth-service problem — Quick Play never requires a
				// permanent account); with one, the server no longer accepts our session.
				if (!auth.isSignedIn) {
					throw new Error(
						'Could not establish your guest identity — you appear to be offline or the sign-in service is unavailable. Check your connection and try again.'
					);
				}
				throw new QuickPlayAuthRequired();
			}
			const message =
				payload &&
				typeof payload === 'object' &&
				'message' in payload &&
				typeof payload.message === 'string'
					? payload.message
					: `Request failed with status ${res.status}`;
			throw new Error(message);
		}
		return payload as QuickPlayQueueResult;
	}

	function stopTickTimer() {
		if (rankedTickTimer) clearInterval(rankedTickTimer);
		rankedTickTimer = null;
	}

	function startTickTimer() {
		stopTickTimer();
		searchStartedAt = Date.now();
		elapsed = 0;
		rankedTickTimer = setInterval(() => {
			elapsed = Math.floor((Date.now() - searchStartedAt) / 1000);
		}, 1000);
	}

	// ── Matched-room navigation fence ────────────────────────────────────────
	// The queue controller retires the SEARCH before navigating; this navigator
	// owns the NAVIGATION itself, so a room `goto` held for seconds by a slow
	// route load can never commit over Back/Main Menu, a sign-out/account
	// change, unmount, or a newer attempt — and the room URL carries the
	// harness/dev query modes (e2e, ws) instead of silently dropping them.
	const roomNav = new MatchedRoomNavigator({
		goto: (url, opts) => goto(url, opts),
		currentLocation: () => ({
			pathname: window.location.pathname,
			search: window.location.search
		}),
		seedMember: (memberId) => setActiveMember(memberId),
		restoreMember: (prior, expected) =>
			restoreActiveMember(prior as ReturnType<typeof setActiveMember>, expected)
	});
	/** The uid the held matched navigation was started for — a durable identity
	 *  change while it is in flight fences it (see the $effect below). */
	let heldNavUid: string | null = null;

	/** Fence a held matched-room navigation and settle the page UI with it. */
	function fenceHeldRoomNav(opts: { supersede?: boolean } = {}) {
		if (roomNav.fence(opts)) {
			matchFound = null;
		}
	}

	// Identity fence: a durable account change (sign-out, account switch) while a
	// matched navigation is held must cancel it — the room was matched FOR the
	// previous identity.
	$effect(() => {
		const uid = auth.user?.id ?? null;
		if (roomNav.held && uid !== heldNavUid) fenceHeldRoomNav();
	});

	// Unmount/own-navigation fence: when ANOTHER navigation takes the router while
	// a matched-room goto is held, the held goto is already losing — silence it and
	// roll the member seed back WITHOUT issuing a superseding navigation (that
	// would hijack the user's own). Our own held goto (destination = the matched
	// room) passes through untouched.
	beforeNavigate((nav) => {
		const held = roomNav.held;
		if (!held) return;
		if (nav.to?.url.pathname === `/play/${encodeURIComponent(held.roomCode)}`) return;
		fenceHeldRoomNav({ supersede: false });
	});

	const search = new QuickPlaySearch({
		async resolveIdentity() {
			// The pre-hydration `?action=` reload path can reach here from onMount
			// BEFORE the layout effect initializes the auth store — wait for it
			// instead of racing into a spurious "still initializing" failure.
			if (!(await auth.whenInitialized())) {
				throw new Error('Sign-in could not initialize — check your connection and try again.');
			}
			// Ensure an account/identity first (captures user_id), same as Quick Play.
			const typed = (browser ? localStorage.getItem(NAME_KEY) : null) ?? '';
			await auth.resolvePlayIdentity(typed);
			const uid = auth.user?.id;
			if (!uid) {
				throw new Error(
					'Could not establish your guest identity — check your connection and try again.'
				);
			}
			return uid;
		},
		currentUid: () => auth.user?.id ?? null,
		// Every poll carries THIS search's client-minted attempt token, so the
		// server binds the row's cancel handle to it before any response exists —
		// the generation-safe cancellation contract.
		queue: (attemptId) => postMatchmaking('/api/play/matchmaking/queue', { attemptId }),
		leave: async (searchId) => {
			// ALWAYS token-bound: retires exactly the initiating attempt's row (and
			// tombstones it) server-side — including after sign-out or a durable
			// account transition, and never a NEWER search by the same account.
			await postMatchmaking('/api/play/matchmaking/leave', { searchId }).catch(() => {});
		},
		async navigate(roomCode, memberId, match) {
			// Seed our server-created membership so the room page identifies us:
			// the public memberId labels the seat; the validated account (which this
			// endpoint required) is what authorizes every room request. `match` is
			// the server-truth mode/rated verdict — the transition labels itself
			// from it (never from the client's own "ranked eligible" assumption).
			// The navigator owns seeding/rollback, the harness-param carry, and the
			// cancellation fence: Back, an identity change, unmount, or a newer
			// attempt silences a HELD goto instead of being overwritten by it.
			matchFound = match;
			heldNavUid = auth.user?.id ?? null;
			playMenuSfx('game-start', { volume: 0.8 });
			try {
				await roomNav.navigate(roomCode, memberId);
			} catch (navErr) {
				// UNFENCED navigation failure (the fence path is silent): the member
				// seed is already rolled back by the navigator — surface a recovery
				// path with the room code, so the match can still be joined by hand.
				matchFound = null;
				rankedError =
					`Match found (room ${roomCode}), but opening it failed — ` +
					`use Join Room with that code, or search again. (${
						navErr instanceof Error ? navErr.message : 'navigation failed'
					})`;
				return;
			}
		},
		onChange(state) {
			const wasSearching = ranked === 'searching';
			ranked = state.phase;
			rankedError = state.error;
			rankedNeedsAuth = state.needsAuth;
			queued = state.queued;
			needed = state.needed;
			players = state.players;
			matchFound = state.match;
			if (state.phase === 'searching' && !wasSearching) startTickTimer();
			if (state.phase !== 'searching') stopTickTimer();
		}
	});

	/** Open the dedicated ranked view (hides the menu) and begin searching. */
	async function startRanked() {
		if (ranked === 'searching') return;
		// A NEWER attempt fences any held matched-room navigation from a previous
		// one — the old goto must not commit under the fresh search.
		fenceHeldRoomNav();
		view = 'ranked';
		playMenuSfx('ui-click');
		await search.start();
	}

	// Unmount cancellation for the solo lane: a solo-create resolving after the
	// player already left this page must neither install/connect the new room in
	// the store nor let the dead handler goto it or write error/loading state.
	const unmountSolo = new AbortController();

	async function startSolo() {
		if (soloStarting) return;
		soloStarting = true;
		soloError = null;
		playMenuSfx('ui-click');
		try {
			// Same pre-hydration `?action=solo` race as startRanked: wait for auth.
			if (!(await auth.whenInitialized())) {
				throw new Error('Sign-in could not initialize — check your connection and try again.');
			}
			const typed = (browser ? localStorage.getItem(NAME_KEY) : null) ?? '';
			const displayName = await auth.resolvePlayIdentity(typed);
			if (unmountSolo.signal.aborted) return;
			const view = await createSoloPlayRoom(displayName, { signal: unmountSolo.signal });
			if (unmountSolo.signal.aborted) return;
			playMenuSfx('game-start', { volume: 0.8 });
			// Same harness-param carry as the matched navigation: solo room entry
			// must not drop the e2e/ws posture either.
			await goto(matchedRoomUrl(view.projection.roomCode, window.location.search));
		} catch (e) {
			if (unmountSolo.signal.aborted) return; // cancelled — no error to a dead page
			soloError = e instanceof Error ? e.message : 'Could not start solo play.';
		} finally {
			soloStarting = false;
		}
	}

	/** Cancel: leave the queue (best-effort, inside the controller's fence) and
	 *  return to the main menu. Every in-flight poll/timer of the cancelled search
	 *  is silenced by the search-generation bump. */
	function cancelRanked() {
		playMenuSfx('ui-back');
		view = 'menu';
		rankedError = null;
		rankedNeedsAuth = false;
		players = [];
		matchFound = null;
		search.cancel();
		// Back/Main Menu also fences a HELD matched-room navigation: the router
		// aborts the in-flight room load instead of letting it commit over the
		// player's choice seconds later.
		fenceHeldRoomNav();
	}

	function formatElapsed(secs: number): string {
		const m = Math.floor(secs / 60);
		const s = secs % 60;
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	/** First letter of a display name for the queue portrait chips. */
	function initial(name: string): string {
		return (name.trim()[0] ?? '?').toUpperCase();
	}

	/** Progressive-enhancement anchor target for Solo/Quick Play: the native
	 *  (pre-hydration) fallback reload must PRESERVE the harness/dev query modes
	 *  (e2e, ws) alongside ?action= — a cold click used to reload to a bare
	 *  `/play?action=…`, silently dropping the e2e posture for the whole session. */
	function actionHref(action: string): string {
		const params = new URLSearchParams();
		for (const key of ['e2e', 'ws']) {
			const value = page.url.searchParams.get(key);
			if (value !== null) params.set(key, value);
		}
		params.set('action', action);
		return `/play?${params.toString()}`;
	}
	const soloHref = $derived(actionHref('solo'));
	const rankedHref = $derived(actionHref('ranked'));

	onMount(() => {
		mounted = true;
		// Progressive enhancement for Solo/Quick Play: those cards are ANCHORS to
		// /play?action=…, so a click that lands before hydration (when no handler
		// exists yet) does a native navigation instead of dying silently — the
		// reloaded page picks the action up here and runs it. Hydrated clicks
		// preventDefault and never hit this path.
		const params = new URLSearchParams(window.location.search);
		const action = params.get('action');
		if (action) {
			if (action === 'ranked') void startRanked();
			else if (action === 'solo') void startSolo();
			// Strip ?action so refresh/back doesn't re-trigger it. On the initial
			// (post-reload) mount SvelteKit's router isn't initialized yet and its
			// replaceState throws — fall back to the native call, preserving
			// history.state so the router's own entry survives.
			params.delete('action');
			const qs = params.toString();
			const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
			try {
				replaceState(url, {});
			} catch {
				window.history.replaceState(window.history.state, '', url);
			}
		}
		// Immersive full-screen: hide global chrome + lock scroll while on the menu.
		document.documentElement.classList.add('immersive-play');
		document.body.classList.add('immersive-play');
		return () => {
			document.documentElement.classList.remove('immersive-play');
			document.body.classList.remove('immersive-play');
			// Unmount teardown: the controller leaves the queue (best-effort) and
			// permanently fences every outstanding poll/timer/navigation, and the
			// solo lane's in-flight create (if any) is aborted the same way.
			unmountSolo.abort();
			search.destroy();
			// Unmount: another navigation owns the router — silence a held matched
			// goto and roll its member seed back without issuing a superseding one.
			fenceHeldRoomNav({ supersede: false });
			stopTickTimer();
		};
	});
</script>

<svelte:head>
	<title>Play Arc Spirits | Fight for the Arcane Abyss</title>
</svelte:head>

<MenuShell>
	<div class="home" data-testid="play-home" data-hydrated={mounted ? 'true' : 'false'}>
		<div class="logo reveal" style="--d: 0.04s">
			<span class="kicker"><span class="kn">01</span><span class="kl"></span> Beta preview</span>
			<span class="l l1 brand-flame-text">Arc</span>
			<span class="l l2 brand-flame-text">Spirits</span>
			<span class="tag">Fight for the Arcane Abyss</span>
		</div>

		<div class="menu-col reveal" style="--d: 0.12s">
			{#if view === 'menu'}
				<nav class="menu" aria-label="Main menu">
					<a
						data-testid="solo-play"
						class="row primary"
						href={soloHref}
						onclick={(event) => {
							event.preventDefault();
							void startSolo();
						}}
						onpointerenter={hover}
						aria-disabled={soloStarting}
						aria-busy={soloStarting}
					>
						<span class="gem"></span>
						<span class="lbl">{soloStarting ? 'Starting…' : 'Solo Play'}</span>
						<span class="go" aria-hidden="true">→</span>
					</a>

					<a
						data-testid="quick-play"
						class="row link"
						href={rankedHref}
						onclick={(event) => {
							event.preventDefault();
							void startRanked();
						}}
						onpointerenter={hover}
					>
						<span class="gem"></span>
						<span class="lbl">Quick Play</span>
						<span class="go" aria-hidden="true">→</span>
					</a>

					{#if soloError}
						<p class="menu-error" data-testid="solo-play-error">{soloError}</p>
					{/if}

					<a
						data-testid="play-open"
						class="row link"
						href="/play/browse"
						onpointerenter={hover}
						onclick={() => playMenuSfx('ui-click')}
					>
						<span class="gem"></span>
						<span class="lbl">Custom Lobby</span>
						<span class="go">→</span>
					</a>

					<a
						class="row link"
						href="/play/champions"
						onpointerenter={hover}
						onclick={() => playMenuSfx('ui-click')}
					>
						<span class="gem"></span><span class="lbl">Hall of Guardians</span><span class="go"
							>→</span
						>
					</a>
					<a
						class="row link"
						href="/play/builder"
						onpointerenter={hover}
						onclick={() => playMenuSfx('ui-click')}
					>
						<span class="gem"></span><span class="lbl">Builder</span><span class="go">→</span>
					</a>
				</nav>
			{:else}
				<section class="ranked-view reveal" aria-live="polite" data-testid="ranked-view">
					<button
						class="rv-back"
						type="button"
						onclick={cancelRanked}
						onpointerenter={hover}
						aria-label="Back to menu"
					>
						← Back
					</button>

					<span class="rv-kicker">Ranked Matchmaking</span>

					{#if rankedNeedsAuth}
						<p class="rv-title">Sign in to play ranked</p>
						<p class="rv-sub">Ranked is account-only so your rating can be tracked.</p>
						<a class="rv-primary" href="/account" onclick={() => playMenuSfx('ui-click')}>
							Sign in →
						</a>
					{:else if ranked === 'searching'}
						<div class="rv-head">
							<span class="rs-spinner" aria-hidden="true"></span>
							<p class="rv-title">Searching for a match…</p>
						</div>

						<div class="rv-timer" aria-label="Time waiting">{formatElapsed(elapsed)}</div>

						<div class="rv-pips" aria-hidden="true">
							{#each Array(needed || 4) as _, i (i)}
								<span class="rv-pip" class:filled={i < queued}></span>
							{/each}
						</div>
						<p class="rv-count"><b>{queued}</b> / {needed || '—'} players in queue</p>

						<ul class="rv-players">
							{#each players as p (p.userId)}
								<li class="rv-player" class:you={p.you}>
									<span class="rv-avatar">{initial(p.displayName)}</span>
									<span class="rv-name">{p.displayName}{p.you ? ' (you)' : ''}</span>
									<span class="rv-state">In queue</span>
								</li>
							{/each}
							{#each Array(Math.max(0, (needed || 4) - players.length)) as _, i (i)}
								<li class="rv-player empty">
									<span class="rv-avatar empty" aria-hidden="true"></span>
									<span class="rv-name">Waiting for player…</span>
								</li>
							{/each}
						</ul>

						<button class="rv-cancel" type="button" onclick={cancelRanked} onpointerenter={hover}>
							Cancel search
						</button>
					{:else}
						{#if rankedError}
							<p class="rv-sub error">{rankedError}</p>
						{/if}
						<button class="rv-primary" type="button" onclick={startRanked} onpointerenter={hover}>
							Search again
						</button>
						<button class="rv-cancel" type="button" onclick={cancelRanked} onpointerenter={hover}>
							Back to menu
						</button>
					{/if}
				</section>
			{/if}
		</div>
	</div>

	<!-- Identity hub: signed-in name, profile, past games, log in/out. Hidden during
	     the dedicated ranked-search view so it doesn't crowd the queue UI. -->
	{#if view === 'menu'}
		<ProfileDock />
	{/if}
</MenuShell>

<style>
	.home {
		position: relative;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: clamp(16px, 3vh, 34px);
		padding: clamp(58px, 9vh, 96px) 8vw clamp(28px, 5vh, 56px);
		/* Never scroll — the layout adapts to fit portrait AND landscape. */
		overflow: hidden;
	}

	/* ── Logo lockup (stacked so it never clips) ──────────────── */
	.logo {
		display: flex;
		flex-direction: column;
	}
	.kicker {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: var(--color-fog, #9a8fb8);
		margin-bottom: clamp(6px, 1.4vh, 12px);
	}
	.kicker .kn {
		font-family: var(--font-mono);
		color: var(--brand-cyan, #24d4ff);
	}
	.kicker .kl {
		width: 26px;
		height: 1px;
		background: currentColor;
		opacity: 0.5;
	}
	.l {
		font-family: var(--font-display);
		/* vmin so the wordmark shrinks with the SHORT side — keeps landscape tidy. */
		font-size: clamp(2.6rem, 8vmin, 6.5rem);
		line-height: 0.82;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		filter: drop-shadow(0 6px 30px rgba(123, 29, 255, 0.5));
	}
	.l2 {
		margin-left: 0.06em;
	}
	.tag {
		margin-top: clamp(8px, 1.6vh, 16px);
		font-family: var(--font-display);
		font-size: clamp(0.7rem, 1.7vmin, 1.1rem);
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: var(--color-parchment, #d8cfee);
	}

	/* ── Menu column ──────────────────────────────────────────── */
	.menu-col {
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-width: 460px;
		min-width: 0;
	}
	.menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 16px;
		width: 100%;
		padding: 14px 8px;
		background: none;
		border: none;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		color: var(--color-parchment, #d8cfee);
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			transform 200ms cubic-bezier(0.2, 0.7, 0.2, 1),
			color 200ms ease;
	}
	.row::after {
		content: '';
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: 6px;
		height: 1px;
		background: var(--gradient-spectrum, linear-gradient(90deg, #ff2bc7, #7b1dff, #24d4ff));
		transform: scaleX(0);
		transform-origin: left;
		opacity: 0.7;
		transition: transform 240ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.row:hover {
			color: #fff;
			transform: translateX(8px);
			outline: none;
		}
		.row:hover::after {
			transform: scaleX(1);
		}
		.row:hover .gem {
			background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
			border-color: transparent;
			box-shadow: 0 0 12px rgba(255, 43, 199, 0.7);
		}
		.row:hover .go {
			opacity: 1;
			transform: translateX(0);
		}
		.row.link:hover .lbl {
			color: #fff;
		}
	}
	.row:focus-visible {
		color: #fff;
		transform: translateX(8px);
		outline: none;
	}
	.row:focus-visible::after {
		transform: scaleX(1);
	}

	.gem {
		flex: 0 0 auto;
		width: 11px;
		height: 11px;
		transform: rotate(45deg);
		border: 1px solid var(--color-aether, #3a2670);
		background: transparent;
		transition:
			background 200ms ease,
			border-color 200ms ease,
			box-shadow 200ms ease;
	}
	.row:focus-visible .gem {
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		border-color: transparent;
		box-shadow: 0 0 12px rgba(255, 43, 199, 0.7);
	}

	.sub-label {
		font-family: var(--font-body);
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		color: var(--color-fog, #9a8fb8);
	}

	.lbl {
		flex: 1;
		font-family: var(--font-display);
		font-size: 1.5rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		line-height: 1;
	}

	.go {
		flex: 0 0 auto;
		font-family: var(--font-display);
		font-size: 1.1rem;
		color: var(--brand-magenta-soft, #ff5dd1);
		opacity: 0;
		transform: translateX(-6px);
		transition:
			opacity 200ms ease,
			transform 200ms ease;
	}
	.row:focus-visible .go {
		opacity: 1;
		transform: translateX(0);
	}

	.row.primary .lbl {
		font-size: 1.95rem;
	}
	.row.primary .gem {
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		border-color: transparent;
		box-shadow: 0 0 14px rgba(255, 43, 199, 0.65);
		animation: gem-pulse 2.8s ease-in-out infinite;
	}
	.row.primary .go {
		opacity: 0.85;
		transform: none;
		color: var(--brand-magenta, #ff2bc7);
	}
	.row.link .lbl {
		font-size: 1.05rem;
		color: var(--color-fog, #9a8fb8);
		letter-spacing: 0.16em;
	}
	.row:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.menu-error {
		margin: 4px 8px 6px 38px;
		padding: 8px 10px;
		border-left: 3px solid var(--color-blood, #c41a3d);
		background: rgba(196, 26, 61, 0.16);
		color: var(--color-bone, #e9e2f5);
		font-family: var(--font-body);
		font-size: 0.82rem;
		line-height: 1.35;
	}

	/* ── Ranked matchmaking view (replaces the menu) ──────────── */
	.rs-spinner {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		border: 2px solid rgba(255, 43, 199, 0.3);
		border-top-color: var(--brand-magenta, #ff2bc7);
		border-radius: 50%;
		animation: rs-spin 0.9s linear infinite;
	}
	.ranked-view {
		display: flex;
		flex-direction: column;
		gap: 14px;
		max-width: 460px;
		padding: 20px 22px 22px;
		background: linear-gradient(180deg, rgba(40, 16, 52, 0.55), rgba(16, 8, 28, 0.55));
		border: 1px solid var(--color-aether, #3a2670);
		border-left: 3px solid var(--brand-magenta, #ff2bc7);
		border-radius: 6px;
		backdrop-filter: blur(4px);
	}
	.rv-back {
		align-self: flex-start;
		padding: 4px 2px;
		background: none;
		border: none;
		color: var(--color-fog, #9a8fb8);
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color 160ms ease;
	}
	.rv-back:hover {
		color: #fff;
	}
	.rv-kicker {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.rv-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.rv-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.25rem;
		letter-spacing: 0.04em;
		color: var(--color-bone, #e9e2f5);
	}
	.rv-sub {
		margin: 0;
		font-family: var(--font-body);
		font-size: 0.86rem;
		color: var(--color-fog, #9a8fb8);
	}
	.rv-sub.error {
		color: var(--color-bone, #e9e2f5);
		border-left: 3px solid var(--color-blood, #c41a3d);
		background: rgba(196, 26, 61, 0.18);
		padding: 9px 14px;
		border-radius: 2px;
	}
	.rv-timer {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 2.8rem;
		line-height: 1;
		color: var(--brand-cyan, #24d4ff);
		text-shadow: 0 0 24px rgba(36, 212, 255, 0.4);
	}
	.rv-pips {
		display: flex;
		gap: 8px;
	}
	.rv-pip {
		flex: 1 1 0;
		height: 5px;
		border-radius: 3px;
		background: rgba(154, 143, 184, 0.25);
		transition:
			background 240ms ease,
			box-shadow 240ms ease;
	}
	.rv-pip.filled {
		background: var(--gradient-spectrum, linear-gradient(90deg, #ff2bc7, #7b1dff, #24d4ff));
		box-shadow: 0 0 10px rgba(255, 43, 199, 0.5);
	}
	.rv-count {
		margin: 0;
		font-family: var(--font-body);
		font-size: 0.82rem;
		color: var(--color-fog, #9a8fb8);
	}
	.rv-count b {
		color: var(--color-bone, #e9e2f5);
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
	}
	.rv-players {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rv-player {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 10px;
		border: 1px solid var(--color-aether, #3a2670);
		border-radius: 4px;
		background: rgba(16, 8, 28, 0.4);
	}
	.rv-player.you {
		border-color: var(--brand-magenta, #ff2bc7);
		box-shadow: inset 0 0 0 1px rgba(255, 43, 199, 0.3);
	}
	.rv-player.empty {
		border-style: dashed;
		opacity: 0.55;
	}
	.rv-avatar {
		flex: 0 0 auto;
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.9rem;
	}
	.rv-avatar.empty {
		background: rgba(154, 143, 184, 0.15);
		border: 1px dashed var(--color-aether, #3a2670);
	}
	.rv-name {
		flex: 1;
		min-width: 0;
		font-family: var(--font-body);
		font-size: 0.9rem;
		color: var(--color-bone, #e9e2f5);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.rv-player.empty .rv-name {
		color: var(--color-fog, #9a8fb8);
		font-style: italic;
	}
	.rv-state {
		flex: 0 0 auto;
		font-family: var(--font-mono);
		font-size: 0.64rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.rv-primary {
		align-self: flex-start;
		padding: 10px 22px;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		border: none;
		border-radius: 3px;
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.88rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		text-decoration: none;
		cursor: pointer;
	}
	.rv-cancel {
		align-self: flex-start;
		padding: 8px 20px;
		background: transparent;
		border: 1px solid var(--color-aether, #3a2670);
		border-radius: 3px;
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.82rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 180ms ease,
			color 180ms ease;
	}
	.rv-cancel:hover {
		border-color: var(--brand-magenta, #ff2bc7);
		color: #fff;
	}
	@keyframes rs-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.rs-spinner {
			animation: none;
		}
	}

	@keyframes gem-pulse {
		0%,
		100% {
			box-shadow: 0 0 10px rgba(255, 43, 199, 0.5);
		}
		50% {
			box-shadow:
				0 0 20px rgba(255, 43, 199, 0.85),
				0 0 36px rgba(123, 29, 255, 0.4);
		}
	}

	/* ── Staggered load ───────────────────────────────────────── */
	.reveal {
		opacity: 0;
		transform: translateY(16px);
		animation: reveal-up 620ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
		animation-delay: var(--d, 0s);
	}
	@keyframes reveal-up {
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* ── Landscape (short height): logo left, menu right so nothing scrolls ── */
	@media (orientation: landscape) and (max-height: 640px) {
		.home {
			flex-direction: row;
			align-items: center;
			justify-content: space-between;
			gap: 5vw;
			padding: clamp(46px, 13vh, 64px) 6vw clamp(18px, 8vh, 40px);
		}
		.logo {
			flex: 0 1 auto;
			min-width: 0;
		}
		.l {
			font-size: clamp(2rem, 12vh, 4.6rem);
		}
		.tag {
			margin-top: clamp(4px, 1.2vh, 12px);
			font-size: clamp(0.6rem, 2.4vh, 0.95rem);
		}
		.kicker {
			margin-bottom: clamp(4px, 1.2vh, 12px);
		}
		.menu-col {
			flex: 0 0 auto;
			max-width: 46vw;
		}
		.row {
			padding: clamp(5px, 1.5vh, 14px) 8px;
		}
		.row::after {
			bottom: 3px;
		}
		.sub-label {
			font-family: var(--font-body);
			font-size: 0.72rem;
			letter-spacing: 0.08em;
			color: var(--color-fog, #9a8fb8);
		}

		.lbl {
			font-size: clamp(1rem, 4.6vh, 1.5rem);
		}
		.row.primary .lbl {
			font-size: clamp(1.2rem, 5.8vh, 1.95rem);
		}
		.row.link .lbl {
			font-size: clamp(0.8rem, 3.4vh, 1.05rem);
		}
		/* Keep the ranked view inside the viewport — scroll the list if it's tall. */
		.ranked-view {
			max-height: 84vh;
			overflow-y: auto;
			gap: 9px;
			padding: 12px 16px 14px;
		}
		.rv-timer {
			font-size: clamp(1.6rem, 7vh, 2.4rem);
		}
	}

	/* ── Portrait phones ──────────────────────────────────────── */
	@media (max-width: 620px) and (orientation: portrait) {
		.home {
			padding: clamp(56px, 10vh, 84px) 7vw clamp(28px, 6vh, 48px);
		}
	}
	@media (max-width: 480px) and (orientation: portrait) {
		.home {
			gap: clamp(14px, 2.4vh, 20px);
		}
		.menu-col {
			max-width: 100%;
		}
		.sub-label {
			font-family: var(--font-body);
			font-size: 0.72rem;
			letter-spacing: 0.08em;
			color: var(--color-fog, #9a8fb8);
		}

		.lbl {
			font-size: 1.25rem;
		}
		.row.primary .lbl {
			font-size: 1.55rem;
		}
		.row.link .lbl {
			font-size: 0.92rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.reveal {
			animation: none;
			opacity: 1;
			transform: none;
		}
		.row.primary .gem {
			animation: none;
		}
	}

	/* Immersive full-screen: hide global chrome + lock scroll while on the menu. */
	:global(html.immersive-play),
	:global(body.immersive-play) {
		height: 100%;
		overflow: hidden;
	}
	:global(body.immersive-play .topbar) {
		display: none !important;
	}
	:global(body.immersive-play .app),
	:global(body.immersive-play .app > .flex-1) {
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
	}
</style>
