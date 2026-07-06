<script lang="ts">
	import { browser } from '$app/environment';
	import { goto, replaceState } from '$app/navigation';
	import { onMount } from 'svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import { createSoloPlayRoom, setActiveMemberId } from '$lib/stores/playStore.svelte';
	import { auth } from '$lib/auth/auth.svelte';
	import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
	import {
		getAssetState,
		getGuardianAsset,
		loadAssetDataSkipImages
	} from '$lib/stores/assetStore.svelte';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import ProfileDock from '$lib/components/play2d/ProfileDock.svelte';

	const hover = () => playMenuSfx('ui-hover', { volume: 0.45 });

	// Shared with the server browser's "Playing as" field so a returning player
	// keeps their name; Quick Play stays one-tap by falling back to a default.
	const NAME_KEY = 'arc-player-name';

	// ── Key art ──────────────────────────────────────────────────────────────
	// Guardian portraits dress the title screen (showcase fan) and the searching
	// scene (summon circle). Data-only load — no board-image preload.
	const assetState = getAssetState();
	const showcase = $derived.by(() => {
		const cards: { name: string; src: string; color: string }[] = [];
		for (const name of assetState.guardianAssets.keys()) {
			const g = getGuardianAsset(name);
			const src = g?.iconUrl ?? g?.chibiUrl;
			if (!src) continue;
			cards.push({ name, src, color: g?.origin?.color ?? '#7b1dff' });
			if (cards.length === 3) break;
		}
		return cards;
	});
	const queueArt = $derived(showcase[1] ?? showcase[0] ?? null);

	// ── Ranked matchmaking ───────────────────────────────────────────────────
	type QueuedPlayer = { userId: string; displayName: string; you: boolean };
	type QueueResult = {
		status: 'searching' | 'matched';
		roomCode?: string;
		memberId?: string;
		queued: number;
		needed: number;
		players?: QueuedPlayer[];
	};
	const RANKED_POLL_MS = 2500;

	// The main menu swaps to a dedicated full-screen ranked view (hiding the nav) while
	// the player is in/around the matchmaking queue. 'menu' shows the normal menu.
	let view = $state<'menu' | 'ranked'>('menu');
	let ranked = $state<'idle' | 'searching'>('idle');
	let rankedError = $state<string | null>(null);
	let rankedNeedsAuth = $state(false);
	let queued = $state(0);
	let needed = $state(0);
	let players = $state<QueuedPlayer[]>([]);
	let searchStartedAt = $state(0);
	let elapsed = $state(0);
	let rankedPollTimer: ReturnType<typeof setTimeout> | null = null;
	let rankedTickTimer: ReturnType<typeof setInterval> | null = null;
	let mounted = $state(false);
	let soloStarting = $state(false);
	let soloError = $state<string | null>(null);

	/** POST a matchmaking endpoint, forwarding the Bearer token cross-origin (Capacitor). */
	async function postMatchmaking(path: string): Promise<QueueResult> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (isCrossOrigin) {
			const token = auth.session?.access_token;
			if (token) headers['Authorization'] = `Bearer ${token}`;
		}
		const res = await fetch(apiUrl(path), {
			method: 'POST',
			headers,
			credentials: isCrossOrigin ? 'include' : 'same-origin',
			body: JSON.stringify({})
		});
		const payload = (await res.json().catch(() => null)) as
			| QueueResult
			| { message?: string }
			| null;
		if (!res.ok) {
			if (res.status === 401) {
				rankedNeedsAuth = true;
				throw new Error('Sign in to play ranked.');
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
		return payload as QueueResult;
	}

	function stopRankedTimers() {
		if (rankedPollTimer) clearTimeout(rankedPollTimer);
		if (rankedTickTimer) clearInterval(rankedTickTimer);
		rankedPollTimer = null;
		rankedTickTimer = null;
	}

	async function pollRanked() {
		if (ranked !== 'searching') return;
		try {
			const result = await postMatchmaking('/api/play/matchmaking/queue');
			queued = result.queued;
			needed = result.needed;
			players = result.players ?? [];
			if (result.status === 'matched' && result.roomCode) {
				stopRankedTimers();
				ranked = 'idle';
				// Seed our server-created membership id so the room page identifies us
				// (cross-origin sends ?member=/X-Play-Member; same-origin also has the
				// cookie the queue endpoint set + the user_id fallback).
				if (result.memberId) setActiveMemberId(result.memberId, result.roomCode);
				playMenuSfx('game-start', { volume: 0.8 });
				await goto(`/play/${encodeURIComponent(result.roomCode)}`);
				return;
			}
			if (ranked === 'searching') rankedPollTimer = setTimeout(pollRanked, RANKED_POLL_MS);
		} catch (e) {
			stopRankedTimers();
			ranked = 'idle';
			rankedError = e instanceof Error ? e.message : 'Matchmaking failed — try again.';
		}
	}

	/** Open the dedicated ranked view (hides the menu) and begin searching. */
	async function startRanked() {
		if (ranked === 'searching') return;
		rankedError = null;
		rankedNeedsAuth = false;
		players = [];
		view = 'ranked';
		playMenuSfx('ui-click');
		try {
			// Ensure an account/identity first (captures user_id), same as Quick Play.
			const typed = (browser ? localStorage.getItem(NAME_KEY) : null) ?? '';
			await auth.resolvePlayIdentity(typed);

			ranked = 'searching';
			searchStartedAt = Date.now();
			elapsed = 0;
			queued = 0;
			needed = 0;
			rankedTickTimer = setInterval(() => {
				elapsed = Math.floor((Date.now() - searchStartedAt) / 1000);
			}, 1000);
			await pollRanked();
		} catch (e) {
			stopRankedTimers();
			ranked = 'idle';
			if (!rankedNeedsAuth) {
				rankedError = e instanceof Error ? e.message : 'Could not start ranked search.';
			}
		}
	}

	async function startSolo() {
		if (soloStarting) return;
		soloStarting = true;
		soloError = null;
		playMenuSfx('ui-click');
		try {
			const typed = (browser ? localStorage.getItem(NAME_KEY) : null) ?? '';
			const displayName = await auth.resolvePlayIdentity(typed);
			const view = await createSoloPlayRoom(displayName);
			playMenuSfx('game-start', { volume: 0.8 });
			await goto(`/play/${encodeURIComponent(view.projection.roomCode)}`);
		} catch (e) {
			soloError = e instanceof Error ? e.message : 'Could not start solo play.';
		} finally {
			soloStarting = false;
		}
	}

	/** Leave the queue (best-effort) and stop searching, staying on the ranked view. */
	async function leaveQueue() {
		stopRankedTimers();
		ranked = 'idle';
		try {
			await postMatchmaking('/api/play/matchmaking/leave');
		} catch {
			// Best-effort: the row ages out server-side even if leave fails.
		}
	}

	/** Cancel: leave the queue and return to the main menu. */
	async function cancelRanked() {
		playMenuSfx('ui-back');
		view = 'menu';
		players = [];
		rankedError = null;
		rankedNeedsAuth = false;
		await leaveQueue();
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
		// Guardian art for the title screen / queue scene — data only, no preload.
		void loadAssetDataSkipImages().catch(() => {});
		// Immersive full-screen: hide global chrome + lock scroll while on the menu.
		document.documentElement.classList.add('immersive-play');
		document.body.classList.add('immersive-play');
		return () => {
			document.documentElement.classList.remove('immersive-play');
			document.body.classList.remove('immersive-play');
			// Leave the queue + stop polling if the player navigates away mid-search.
			if (ranked === 'searching') {
				stopRankedTimers();
				void postMatchmaking('/api/play/matchmaking/leave').catch(() => {});
			}
		};
	});
</script>

<svelte:head>
	<title>Play Arc Spirits | Fight for the Arcane Abyss</title>
</svelte:head>

<MenuShell>
	<div class="home" data-testid="play-home" data-hydrated={mounted ? 'true' : 'false'}>
		{#if view === 'menu'}
			<!-- ── Title screen ─────────────────────────────────────────────── -->
			{#if showcase.length > 0}
				<div class="showcase" aria-hidden="true">
					{#each showcase as card, i (card.name)}
						<div class="sc-card" style="--i: {i}; --oc: {card.color}">
							<img src={card.src} alt="" loading="lazy" draggable="false" />
							<span class="sc-fade"></span>
						</div>
					{/each}
				</div>
			{/if}

			<div class="logo reveal" style="--d: 0.04s">
				<span class="kicker"><span class="kn">01</span><span class="kl"></span> Beta preview</span>
				<span class="l l1 brand-flame-text">Arc</span>
				<span class="l l2 brand-flame-text">Spirits</span>
				<span class="tag">Fight for the Arcane Abyss</span>
			</div>

			<!-- Entry animation is OPACITY-ONLY on anything clickable: a transform here
			     moves the buttons mid-press and the browser cancels the click (the
			     "Quick Play does nothing on desktop" bug). -->
			<nav class="modes reveal-fade" style="--d: 0.14s" aria-label="Main menu">
				<!-- Solo/Quick Play are anchors (not buttons) so a pre-hydration click
				     falls back to native navigation (?action= handled in onMount)
				     instead of being dropped — the second half of the "Quick Play
				     does nothing on desktop" bug. -->
				<a
					data-testid="solo-play"
					class="mode primary"
					class:busy={soloStarting}
					style="--mc: var(--brand-magenta, #ff2bc7)"
					href="/play?action=solo"
					onclick={(e) => {
						e.preventDefault();
						void startSolo();
					}}
					onpointerenter={hover}
					aria-busy={soloStarting}
				>
					<span class="m-gem" aria-hidden="true"><span class="m-diamond"></span></span>
					<span class="m-text">
						<span class="m-title">{soloStarting ? 'Starting…' : 'Solo Play'}</span>
						<span class="m-sub">Jump in now · you vs ML bots</span>
					</span>
					<span class="m-go" aria-hidden="true">→</span>
				</a>

				<a
					data-testid="quick-play"
					class="mode"
					style="--mc: var(--brand-cyan, #24d4ff)"
					href="/play?action=ranked"
					onclick={(e) => {
						e.preventDefault();
						void startRanked();
					}}
					onpointerenter={hover}
				>
					<span class="m-gem" aria-hidden="true"><span class="m-diamond"></span></span>
					<span class="m-text">
						<span class="m-title">Quick Play</span>
						<span class="m-sub">Ranked matchmaking · 4 players</span>
					</span>
					<span class="m-go" aria-hidden="true">→</span>
				</a>

				<a
					data-testid="play-open"
					class="mode"
					style="--mc: var(--brand-violet-soft, #9d4dff)"
					href="/play/browse"
					onpointerenter={hover}
					onclick={() => playMenuSfx('ui-click')}
				>
					<span class="m-gem" aria-hidden="true"><span class="m-diamond"></span></span>
					<span class="m-text">
						<span class="m-title">Custom Lobby</span>
						<span class="m-sub">Create a room · play with friends</span>
					</span>
					<span class="m-go" aria-hidden="true">→</span>
				</a>

				{#if soloError}
					<p class="menu-error" data-testid="solo-play-error">{soloError}</p>
				{/if}

				<div class="minor">
					<a
						class="minor-link"
						href="/play/champions"
						onpointerenter={hover}
						onclick={() => playMenuSfx('ui-click')}
					>
						<span class="mgem" aria-hidden="true"></span>Hall of Guardians
					</a>
					<a
						class="minor-link"
						href="/play/builder"
						onpointerenter={hover}
						onclick={() => playMenuSfx('ui-click')}
					>
						<span class="mgem" aria-hidden="true"></span>Builder
					</a>
				</div>
			</nav>
		{:else}
			<!-- ── Searching scene (full-screen takeover) ───────────────────── -->
			<section class="queue" aria-live="polite" data-testid="ranked-view">
				<header class="q-top">
					<button class="q-back" type="button" onclick={cancelRanked} onpointerenter={hover}>
						<span aria-hidden="true">←</span> Back
					</button>
					<span class="q-playing">
						Playing as <b>{auth.displayName ?? 'Nameless Spirit'}</b>
					</span>
				</header>

				<div class="q-scene">
					{#if rankedNeedsAuth}
						<span class="q-eyebrow">Ranked Matchmaking</span>
						<h2 class="q-title">Sign in to play ranked</h2>
						<p class="q-sub">Ranked is account-only so your rating can be tracked.</p>
						<a class="q-primary" href="/account" onclick={() => playMenuSfx('ui-click')}>
							Sign in →
						</a>
					{:else if ranked === 'searching'}
						<span class="q-eyebrow">Ranked Matchmaking</span>

						<div class="q-circle" style="--oc: {queueArt?.color ?? '#7b1dff'}">
							<span class="q-ring r1" aria-hidden="true"></span>
							<span class="q-ring r2" aria-hidden="true"></span>
							<span class="q-disc" aria-hidden="true">
								{#if queueArt}
									<img src={queueArt.src} alt="" draggable="false" />
								{:else}
									<span class="q-sigil"></span>
								{/if}
							</span>
						</div>

						<h2 class="q-title">Searching for a match…</h2>
						<div class="q-timer" aria-label="Time waiting">{formatElapsed(elapsed)}</div>

						<div class="q-meter">
							<div class="q-pips" aria-hidden="true">
								{#each Array(needed || 4) as _, i (i)}
									<span class="q-pip" class:filled={i < queued}></span>
								{/each}
							</div>
							<p class="q-count"><b>{queued}</b> / {needed || '—'} players in queue</p>
						</div>

						<ul class="q-roster">
							{#each players as p (p.userId)}
								<li class="q-chip" class:you={p.you}>
									<span class="q-ava">{initial(p.displayName)}</span>
									<span class="q-name">{p.displayName}</span>
									<span class="q-state">{p.you ? 'You' : 'In queue'}</span>
								</li>
							{/each}
							{#each Array(Math.max(0, (needed || 4) - players.length)) as _, i (i)}
								<li class="q-chip empty">
									<span class="q-ava empty" aria-hidden="true"></span>
									<span class="q-name">Waiting…</span>
								</li>
							{/each}
						</ul>
					{:else}
						<span class="q-eyebrow">Ranked Matchmaking</span>
						{#if rankedError}
							<p class="q-sub error">{rankedError}</p>
						{/if}
						<button class="q-primary" type="button" onclick={startRanked} onpointerenter={hover}>
							Search again
						</button>
					{/if}
				</div>

				<div class="q-foot">
					{#if ranked === 'searching'}
						<button class="q-cancel" type="button" onclick={cancelRanked} onpointerenter={hover}>
							Cancel search
						</button>
					{:else if !rankedNeedsAuth}
						<button class="q-cancel" type="button" onclick={cancelRanked} onpointerenter={hover}>
							Back to menu
						</button>
					{/if}
				</div>
			</section>
		{/if}
	</div>

	<!-- Identity hub: signed-in name, profile, past games, log in/out. Hidden during
	     the dedicated ranked-search view so it doesn't crowd the queue scene. -->
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
		justify-content: flex-end;
		gap: clamp(18px, 4vh, 44px);
		padding: clamp(76px, 11vh, 110px) 7vw clamp(26px, 5vh, 54px);
		/* Never scroll — the layout adapts to fit portrait AND landscape. */
		overflow: hidden;
	}

	/* ── Guardian showcase (key art, right side) ───────────────── */
	.showcase {
		position: absolute;
		right: clamp(24px, 7vw, 120px);
		top: 50%;
		transform: translateY(-52%);
		display: flex;
		gap: clamp(12px, 1.6vw, 22px);
		pointer-events: none;
		z-index: 0;
	}
	.sc-card {
		position: relative;
		width: clamp(130px, 15vw, 210px);
		aspect-ratio: 10 / 14;
		border-radius: 18px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--oc) 45%, transparent);
		background:
			radial-gradient(
				ellipse at 50% 30%,
				color-mix(in srgb, var(--oc) 26%, transparent),
				transparent 72%
			),
			rgba(8, 5, 18, 0.55);
		box-shadow: 0 30px 70px -30px color-mix(in srgb, var(--oc) 70%, transparent);
		transform: rotate(calc((var(--i) - 1) * 5deg)) translateY(calc((var(--i) - 1) * (var(--i) - 1) * 12px));
		animation: sc-float 7s ease-in-out infinite;
		animation-delay: calc(var(--i) * -2.2s);
	}
	.sc-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: 50% 20%;
	}
	.sc-fade {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, transparent 55%, rgba(5, 3, 16, 0.85) 100%);
	}
	@keyframes sc-float {
		0%,
		100% {
			margin-top: 0;
		}
		50% {
			margin-top: -12px;
		}
	}

	/* ── Logo lockup ──────────────────────────────────────────── */
	.logo {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		margin-bottom: auto;
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
		font-size: clamp(2.8rem, 9.5vmin, 7.2rem);
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

	/* ── Mode cards ───────────────────────────────────────────── */
	.modes {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: min(440px, 100%);
	}
	.mode {
		display: flex;
		align-items: center;
		gap: 16px;
		min-height: 64px;
		padding: 12px 18px 12px 14px;
		border-radius: 16px;
		border: 1px solid var(--color-aether, #3a2670);
		background: linear-gradient(100deg, rgba(20, 12, 38, 0.72), rgba(8, 5, 18, 0.6));
		color: var(--color-parchment, #d8cfee);
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
		/* No transform on hover/entry: a moving hit target drops fast clicks. */
		transition:
			border-color 180ms ease,
			background 180ms ease,
			box-shadow 180ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.mode:hover {
			border-color: var(--mc);
			background: linear-gradient(100deg, rgba(30, 18, 52, 0.82), rgba(12, 7, 26, 0.7));
			box-shadow: 0 16px 42px -20px var(--mc);
		}
		.mode:hover .m-diamond {
			background: var(--mc);
			box-shadow: 0 0 14px var(--mc);
		}
		.mode:hover .m-go {
			opacity: 1;
			transform: translateX(0);
		}
		.mode:hover .m-title {
			color: #fff;
		}
	}
	.mode:focus-visible {
		outline: none;
		border-color: var(--mc);
		box-shadow: 0 0 0 2px var(--mc);
	}
	.mode:disabled,
	.mode.busy {
		opacity: 0.6;
		cursor: progress;
		pointer-events: none;
	}
	.m-gem {
		flex: 0 0 auto;
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--mc) 40%, transparent);
		background: color-mix(in srgb, var(--mc) 9%, transparent);
	}
	.m-diamond {
		width: 11px;
		height: 11px;
		transform: rotate(45deg);
		border: 1px solid var(--mc);
		background: color-mix(in srgb, var(--mc) 35%, transparent);
		transition:
			background 180ms ease,
			box-shadow 180ms ease;
	}
	.m-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.m-title {
		font-family: var(--font-display);
		font-size: 1.28rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		line-height: 1;
		color: var(--color-bone, #f5f0ff);
		transition: color 180ms ease;
	}
	.m-sub {
		font-family: var(--font-body);
		font-size: 0.76rem;
		color: var(--color-fog, #9a8fb8);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.m-go {
		flex: 0 0 auto;
		font-family: var(--font-display);
		font-size: 1.1rem;
		color: var(--mc);
		opacity: 0;
		transform: translateX(-6px);
		transition:
			opacity 200ms ease,
			transform 200ms ease;
	}
	.mode:focus-visible .m-go {
		opacity: 1;
		transform: translateX(0);
	}

	.mode.primary {
		min-height: 76px;
		border-color: color-mix(in srgb, var(--mc) 55%, var(--color-aether, #3a2670));
		background:
			linear-gradient(100deg, color-mix(in srgb, var(--mc) 14%, transparent), transparent 60%),
			linear-gradient(100deg, rgba(24, 14, 44, 0.8), rgba(8, 5, 18, 0.66));
		box-shadow: 0 18px 46px -22px color-mix(in srgb, var(--mc) 80%, transparent);
	}
	.mode.primary .m-title {
		font-size: 1.62rem;
	}
	.mode.primary .m-diamond {
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		border-color: transparent;
		box-shadow: 0 0 14px rgba(255, 43, 199, 0.65);
		animation: gem-pulse 2.8s ease-in-out infinite;
	}
	.mode.primary .m-go {
		opacity: 0.85;
		transform: none;
	}

	.menu-error {
		margin: 2px 4px;
		padding: 8px 12px;
		border-left: 3px solid var(--color-blood, #c41a3d);
		background: rgba(196, 26, 61, 0.16);
		color: var(--color-bone, #e9e2f5);
		font-family: var(--font-body);
		font-size: 0.82rem;
		line-height: 1.35;
	}

	/* Secondary destinations: quiet chip row under the cards. */
	.minor {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		padding: 6px 4px 0;
	}
	.minor-link {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-fog, #9a8fb8);
		text-decoration: none;
		transition: color 160ms ease;
	}
	.minor-link .mgem {
		width: 7px;
		height: 7px;
		transform: rotate(45deg);
		border: 1px solid var(--color-aether, #3a2670);
		transition:
			background 160ms ease,
			border-color 160ms ease;
	}
	.minor-link:hover,
	.minor-link:focus-visible {
		color: #fff;
		outline: none;
	}
	.minor-link:hover .mgem,
	.minor-link:focus-visible .mgem {
		background: var(--brand-magenta, #ff2bc7);
		border-color: transparent;
	}

	/* ── Searching scene ──────────────────────────────────────── */
	.queue {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		padding:
			calc(clamp(14px, 3vh, 24px) + env(safe-area-inset-top))
			clamp(16px, 4vw, 44px)
			calc(clamp(12px, 2.5vh, 22px) + env(safe-area-inset-bottom));
	}
	.q-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		/* Clear MenuShell's top-right sound/settings cluster. */
		padding-right: 118px;
	}
	.q-back {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 42px;
		padding: 8px 16px;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: rgba(255, 255, 255, 0.05);
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		backdrop-filter: blur(8px);
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.q-back:hover {
		border-color: var(--brand-magenta, #ff2bc7);
		color: #fff;
	}
	.q-playing {
		font-family: var(--font-body);
		font-size: 0.8rem;
		color: var(--color-fog, #9a8fb8);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.q-playing b {
		color: var(--color-bone, #f5f0ff);
		font-weight: 600;
	}

	.q-scene {
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: clamp(6px, 1.6vh, 14px);
	}
	.q-eyebrow {
		font-family: var(--font-display);
		font-size: 0.64rem;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.q-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(1.15rem, 4vh, 1.7rem);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-bone, #e9e2f5);
	}
	.q-sub {
		margin: 0;
		max-width: 44ch;
		font-family: var(--font-body);
		font-size: 0.88rem;
		color: var(--color-fog, #9a8fb8);
	}
	.q-sub.error {
		color: var(--color-bone, #e9e2f5);
		border-left: 3px solid var(--color-blood, #c41a3d);
		background: rgba(196, 26, 61, 0.18);
		padding: 9px 14px;
		border-radius: 2px;
	}

	/* Summon circle + radar pulse. */
	.q-circle {
		position: relative;
		width: clamp(88px, 24vh, 190px);
		aspect-ratio: 1;
		display: grid;
		place-items: center;
		margin-bottom: clamp(2px, 1vh, 8px);
	}
	.q-disc {
		position: relative;
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		border-radius: 50%;
		overflow: hidden;
		border: 1.5px solid color-mix(in srgb, var(--oc) 65%, transparent);
		background:
			radial-gradient(
				ellipse at 50% 32%,
				color-mix(in srgb, var(--oc) 30%, transparent),
				transparent 74%
			),
			rgba(8, 5, 18, 0.6);
		box-shadow: 0 0 42px -8px color-mix(in srgb, var(--oc) 65%, transparent);
	}
	.q-disc img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: 50% 18%;
	}
	.q-sigil {
		width: 34%;
		aspect-ratio: 1;
		transform: rotate(45deg);
		border: 1.5px solid color-mix(in srgb, var(--oc) 75%, transparent);
		background: color-mix(in srgb, var(--oc) 16%, transparent);
		box-shadow: 0 0 22px -2px var(--oc);
	}
	.q-ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1.5px solid color-mix(in srgb, var(--oc) 55%, transparent);
		animation: q-radar 2.6s cubic-bezier(0.2, 0.6, 0.35, 1) infinite;
		pointer-events: none;
	}
	.q-ring.r2 {
		animation-delay: 1.3s;
	}
	@keyframes q-radar {
		0% {
			transform: scale(1);
			opacity: 0.9;
		}
		100% {
			transform: scale(1.75);
			opacity: 0;
		}
	}

	.q-timer {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: clamp(1.9rem, 7vh, 3.2rem);
		line-height: 1;
		color: var(--brand-cyan, #24d4ff);
		text-shadow: 0 0 24px rgba(36, 212, 255, 0.4);
	}
	.q-meter {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		width: min(340px, 78vw);
	}
	.q-pips {
		display: flex;
		gap: 8px;
		width: 100%;
	}
	.q-pip {
		flex: 1 1 0;
		height: 5px;
		border-radius: 3px;
		background: rgba(154, 143, 184, 0.25);
		transition:
			background 240ms ease,
			box-shadow 240ms ease;
	}
	.q-pip.filled {
		background: var(--gradient-spectrum, linear-gradient(90deg, #ff2bc7, #7b1dff, #24d4ff));
		box-shadow: 0 0 10px rgba(255, 43, 199, 0.5);
	}
	.q-count {
		margin: 0;
		font-family: var(--font-body);
		font-size: 0.8rem;
		color: var(--color-fog, #9a8fb8);
	}
	.q-count b {
		color: var(--color-bone, #e9e2f5);
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	/* Portrait chips flip in as players join; empties are silhouettes. */
	.q-roster {
		list-style: none;
		margin: clamp(2px, 1vh, 10px) 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: clamp(10px, 2vw, 18px);
	}
	.q-chip {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 5px;
		width: 84px;
		animation: chip-in 320ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.q-ava {
		width: clamp(40px, 7vh, 54px);
		aspect-ratio: 1;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		color: #fff;
		font-family: var(--font-display);
		font-size: 1.05rem;
	}
	.q-chip.you .q-ava {
		box-shadow:
			0 0 0 2px var(--color-void, #050310),
			0 0 0 4px var(--brand-cyan, #24d4ff),
			0 0 18px rgba(36, 212, 255, 0.5);
	}
	.q-ava.empty {
		background: rgba(154, 143, 184, 0.12);
		border: 1.5px dashed var(--color-aether, #3a2670);
	}
	.q-name {
		max-width: 100%;
		font-family: var(--font-body);
		font-size: 0.72rem;
		color: var(--color-bone, #e9e2f5);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.q-chip.empty .q-name {
		color: var(--color-whisper, #6a5d8a);
		font-style: italic;
	}
	.q-state {
		font-family: var(--font-mono);
		font-size: 0.56rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	@keyframes chip-in {
		from {
			opacity: 0;
			transform: scale(0.8);
		}
	}

	.q-primary {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		margin-top: 6px;
		padding: 12px 26px;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		border: none;
		border-radius: 12px;
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.88rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		text-decoration: none;
		cursor: pointer;
		box-shadow: 0 14px 34px -14px rgba(255, 43, 199, 0.7);
	}

	/* Single bottom-anchored action — never below the fold. */
	.q-foot {
		display: flex;
		justify-content: center;
	}
	.q-cancel {
		min-height: 50px;
		width: min(360px, 100%);
		padding: 12px 24px;
		background: rgba(10, 7, 24, 0.55);
		border: 1px solid var(--color-aether, #3a2670);
		border-radius: 13px;
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		backdrop-filter: blur(8px);
		transition:
			border-color 180ms ease,
			color 180ms ease;
	}
	.q-cancel:hover {
		border-color: var(--brand-magenta, #ff2bc7);
		color: #fff;
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

	/* ── Staggered load. `.reveal` (with motion) is for NON-interactive elements
	   only; interactive surfaces use `.reveal-fade` so they never move mid-click. ── */
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
	.reveal-fade {
		opacity: 0;
		animation: reveal-fade 520ms ease forwards;
		animation-delay: var(--d, 0s);
	}
	@keyframes reveal-fade {
		to {
			opacity: 1;
		}
	}

	/* ── Short landscape: compact the searching scene so the roster and the
	   bottom Cancel never collide at 390-height. ── */
	@media (orientation: landscape) and (max-height: 520px) {
		.q-scene {
			gap: 4px;
			overflow: hidden;
		}
		.q-circle {
			width: clamp(64px, 19vh, 96px);
			margin-bottom: 0;
		}
		.q-title {
			font-size: clamp(0.95rem, 4.5vh, 1.2rem);
		}
		.q-timer {
			font-size: clamp(1.4rem, 7.5vh, 2rem);
		}
		.q-meter {
			gap: 3px;
		}
		.q-count {
			font-size: 0.7rem;
		}
		.q-roster {
			flex-wrap: nowrap;
			margin-top: 2px;
		}
		.q-chip {
			width: 76px;
			gap: 3px;
		}
		.q-ava {
			width: clamp(30px, 9.5vh, 40px);
		}
		.q-name {
			font-size: 0.64rem;
		}
		.q-state {
			display: none;
		}
		.q-foot {
			padding-top: 4px;
		}
		.q-cancel {
			min-height: 44px;
			padding: 9px 20px;
			width: min(300px, 100%);
		}
	}

	/* ── Landscape (short height): logo left, cards right, showcase center-right ── */
	@media (orientation: landscape) and (max-height: 640px) {
		.home {
			flex-direction: row;
			align-items: center;
			justify-content: space-between;
			gap: 5vw;
			padding: clamp(52px, 13vh, 72px) 6vw clamp(18px, 6vh, 40px);
		}
		.logo {
			flex: 0 1 auto;
			min-width: 0;
			margin-bottom: 0;
		}
		.l {
			font-size: clamp(2rem, 13vh, 4.6rem);
		}
		.tag {
			margin-top: clamp(4px, 1.2vh, 12px);
			font-size: clamp(0.6rem, 2.4vh, 0.95rem);
		}
		.kicker {
			margin-bottom: clamp(4px, 1.2vh, 12px);
		}
		/* No room between the logo and the cards on phone-width landscape —
		   the splat + aurora carry the backdrop instead. */
		.showcase {
			display: none;
		}
		.modes {
			flex: 0 0 auto;
			width: min(400px, 46vw);
			gap: clamp(6px, 1.6vh, 10px);
		}
		.mode {
			min-height: clamp(46px, 13vh, 58px);
			padding: 8px 14px 8px 10px;
			border-radius: 13px;
		}
		.mode.primary {
			min-height: clamp(54px, 15vh, 68px);
		}
		.m-gem {
			width: 32px;
			height: 32px;
			border-radius: 9px;
		}
		.m-title {
			font-size: clamp(0.95rem, 4.4vh, 1.2rem);
		}
		.mode.primary .m-title {
			font-size: clamp(1.1rem, 5.4vh, 1.45rem);
		}
		.m-sub {
			font-size: clamp(0.62rem, 2.6vh, 0.72rem);
		}
		.minor {
			padding-top: 2px;
		}
		.minor-link {
			min-height: 32px;
			font-size: 0.66rem;
		}
	}

	/* ── Portrait: logo top, showcase fan in the middle (in flow — it can never
	   collide with the wordmark or the cards), cards bottom-anchored. ── */
	@media (orientation: portrait) {
		.home {
			justify-content: flex-end;
			padding: clamp(84px, 12vh, 120px) 6vw clamp(20px, 4vh, 40px);
		}
		.logo {
			order: -1;
			align-items: center;
			text-align: center;
			margin-bottom: 0;
			align-self: center;
		}
		.showcase {
			position: static;
			transform: none;
			order: 0;
			align-self: center;
			align-items: center;
			margin: auto 0;
			padding: 18px 0;
		}
		.sc-card {
			width: clamp(92px, 23vw, 150px);
		}
		.modes {
			order: 1;
			width: 100%;
			max-width: 480px;
			align-self: center;
		}
	}
	@media (max-width: 480px) and (orientation: portrait) {
		.home {
			gap: clamp(14px, 2.4vh, 20px);
		}
		.l {
			font-size: clamp(2.6rem, 15vw, 3.6rem);
		}
		.sc-card {
			width: clamp(96px, 26vw, 130px);
		}
		.m-title {
			font-size: 1.14rem;
		}
		.mode.primary .m-title {
			font-size: 1.4rem;
		}
		.q-top {
			padding-right: 108px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.reveal,
		.reveal-fade {
			animation: none;
			opacity: 1;
			transform: none;
		}
		.mode.primary .m-diamond,
		.sc-card,
		.q-ring,
		.q-chip {
			animation: none;
		}
		.q-ring {
			opacity: 0.35;
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
