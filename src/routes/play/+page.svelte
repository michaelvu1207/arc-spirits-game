<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import {
		fetchOpenRooms,
		joinPlayRoom,
		createPlayRoom,
		setActiveMemberId
	} from '$lib/stores/playStore.svelte';
	import { auth } from '$lib/auth/auth.svelte';
	import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import InstallPrompt from '$lib/components/InstallPrompt.svelte';

	const hover = () => playMenuSfx('ui-hover', { volume: 0.45 });

	// Shared with the server browser's "Playing as" field so a returning player
	// keeps their name; Quick Play stays one-tap by falling back to a default.
	const NAME_KEY = 'arc-player-name';

	let busy = $state(false);
	let quickError = $state<string | null>(null);

	// ── Ranked matchmaking ───────────────────────────────────────────────────────
	type QueueResult = {
		status: 'searching' | 'matched';
		roomCode?: string;
		memberId?: string;
		queued: number;
		needed: number;
	};
	const RANKED_POLL_MS = 2500;

	let ranked = $state<'idle' | 'searching'>('idle');
	let rankedError = $state<string | null>(null);
	let rankedNeedsAuth = $state(false);
	let queued = $state(0);
	let needed = $state(0);
	let searchStartedAt = $state(0);
	let elapsed = $state(0);
	let rankedPollTimer: ReturnType<typeof setTimeout> | null = null;
	let rankedTickTimer: ReturnType<typeof setInterval> | null = null;

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
		const payload = (await res.json().catch(() => null)) as QueueResult | { message?: string } | null;
		if (!res.ok) {
			if (res.status === 401) {
				rankedNeedsAuth = true;
				throw new Error('Sign in to play ranked.');
			}
			const message =
				payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
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
			if (result.status === 'matched' && result.roomCode) {
				stopRankedTimers();
				ranked = 'idle';
				// Seed our server-created membership id so the room page identifies us
				// (cross-origin sends ?member=/X-Play-Member; same-origin also has the
				// cookie the queue endpoint set + the user_id fallback).
				if (result.memberId) setActiveMemberId(result.memberId);
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

	async function startRanked() {
		if (busy || ranked === 'searching') return;
		rankedError = null;
		rankedNeedsAuth = false;
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

	async function cancelRanked() {
		stopRankedTimers();
		ranked = 'idle';
		playMenuSfx('ui-click');
		try {
			await postMatchmaking('/api/play/matchmaking/leave');
		} catch {
			// Best-effort: the row ages out server-side even if leave fails.
		}
	}

	function formatElapsed(secs: number): string {
		const m = Math.floor(secs / 60);
		const s = secs % 60;
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	/**
	 * One-tap matchmaking: drop the player into the fullest open lobby that still has
	 * a free seat (the game closest to starting that they can actually play in), or
	 * spin up a fresh room if there's none. Tie-break the "fullest" on oldest-first so
	 * a lobby that's been waiting longest fills up first.
	 */
	async function quickPlay() {
		if (busy) return;
		busy = true;
		quickError = null;
		playMenuSfx('game-start', { volume: 0.8 });
		try {
			// Anonymous-first: a first-time guest becomes a real (owned) guest account here.
			const typed = (browser ? localStorage.getItem(NAME_KEY) : null) ?? '';
			const player = await auth.resolvePlayIdentity(typed);
			const rooms = await fetchOpenRooms();
			const target = rooms
				.filter((r) => r.status === 'lobby' && r.occupiedSeats < r.totalSeats)
				.sort(
					(a, b) =>
						b.occupiedSeats - a.occupiedSeats || Date.parse(a.createdAt) - Date.parse(b.createdAt)
				)[0];

			let roomCode: string;
			if (target) {
				await joinPlayRoom(target.roomCode, player);
				roomCode = target.roomCode;
			} else {
				const view = await createPlayRoom(player);
				roomCode = view.projection.roomCode;
			}

			await goto(`/play/${encodeURIComponent(roomCode)}`);
		} catch (e) {
			quickError = e instanceof Error ? e.message : 'Quick Play failed — try again.';
			busy = false;
		}
	}

	onMount(() => {
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

<InstallPrompt />

<MenuShell>
	<div class="home">
		<div class="logo reveal" style="--d: 0.04s">
			<span class="kicker"><span class="kn">01</span><span class="kl"></span> Live Play</span>
			<span class="l l1 brand-flame-text">Arc</span>
			<span class="l l2 brand-flame-text">Spirits</span>
			<span class="tag">Fight for the Arcane Abyss</span>
		</div>

		<div class="menu-col reveal" style="--d: 0.12s">
			<nav class="menu" aria-label="Main menu">
				<button
					data-testid="quick-play"
					class="row primary"
					type="button"
					onclick={quickPlay}
					onpointerenter={hover}
					disabled={busy || ranked === 'searching'}
				>
					<span class="gem"></span>
					<span class="lbl">{busy ? 'Finding a game…' : 'Quick Play'}</span>
					<span class="go" aria-hidden="true">→</span>
				</button>

				<button
					data-testid="ranked-play"
					class="row link"
					type="button"
					onclick={startRanked}
					onpointerenter={hover}
					disabled={busy || ranked === 'searching'}
				>
					<span class="gem"></span>
					<span class="lbl">Ranked</span>
					<span class="go" aria-hidden="true">→</span>
				</button>

				<a
					data-testid="play-open"
					class="row link"
					href="/play/browse"
					onpointerenter={hover}
					onclick={() => playMenuSfx('ui-click')}
				>
					<span class="gem"></span>
					<span class="lbl">Browse Servers</span>
					<span class="go">→</span>
				</a>

				<a
					class="row link"
					href="/play/champions"
					onpointerenter={hover}
					onclick={() => playMenuSfx('ui-click')}
				>
					<span class="gem"></span><span class="lbl">Hall of Champions</span><span class="go">→</span>
				</a>
				<a
					class="row link"
					href="/play/records"
					onpointerenter={hover}
					onclick={() => playMenuSfx('ui-click')}
				>
					<span class="gem"></span><span class="lbl">Game Records</span><span class="go">→</span>
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

			{#if quickError}
				<p class="quick-error" role="alert">{quickError}</p>
			{/if}

			{#if ranked === 'searching'}
				<div class="ranked-search" role="status" aria-live="polite">
					<div class="rs-head">
						<span class="rs-spinner" aria-hidden="true"></span>
						<span class="rs-title">Searching for a ranked match…</span>
					</div>
					<div class="rs-meta">
						<span><b>{queued}</b>/<b>{needed || '—'}</b> in queue</span>
						<span class="rs-elapsed">{formatElapsed(elapsed)}</span>
					</div>
					<button class="rs-cancel" type="button" onclick={cancelRanked} onpointerenter={hover}>
						Cancel
					</button>
				</div>
			{/if}

			{#if rankedNeedsAuth}
				<p class="quick-error" role="alert">
					Sign in to play ranked. <a class="rs-link" href="/account">Sign in →</a>
				</p>
			{:else if rankedError}
				<p class="quick-error" role="alert">{rankedError}</p>
			{/if}
		</div>
	</div>
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

	.quick-error {
		margin: 10px 8px 0;
		padding: 9px 14px;
		border-left: 3px solid var(--color-blood, #c41a3d);
		background: rgba(196, 26, 61, 0.18);
		color: var(--color-bone, #e9e2f5);
		border-radius: 2px;
		font-family: var(--font-body);
		font-size: 0.84rem;
		max-width: 460px;
	}
	.rs-link {
		color: var(--brand-cyan, #24d4ff);
		text-decoration: underline;
	}

	/* ── Ranked searching panel ───────────────────────────────── */
	.ranked-search {
		margin: 12px 8px 0;
		padding: 14px 16px;
		max-width: 460px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		background: linear-gradient(180deg, rgba(40, 16, 52, 0.6), rgba(16, 8, 28, 0.6));
		border: 1px solid var(--color-aether, #3a2670);
		border-left: 3px solid var(--brand-magenta, #ff2bc7);
		border-radius: 4px;
	}
	.rs-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.rs-spinner {
		flex: 0 0 auto;
		width: 14px;
		height: 14px;
		border: 2px solid rgba(255, 43, 199, 0.3);
		border-top-color: var(--brand-magenta, #ff2bc7);
		border-radius: 50%;
		animation: rs-spin 0.9s linear infinite;
	}
	.rs-title {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.04em;
		color: var(--color-bone, #e9e2f5);
	}
	.rs-meta {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-family: var(--font-body);
		font-size: 0.84rem;
		color: var(--color-fog, #9a8fb8);
	}
	.rs-meta b {
		color: var(--color-bone, #e9e2f5);
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
	}
	.rs-elapsed {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--brand-cyan, #24d4ff);
	}
	.rs-cancel {
		align-self: flex-start;
		padding: 7px 18px;
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
	.rs-cancel:hover {
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
		.lbl {
			font-size: clamp(1rem, 4.6vh, 1.5rem);
		}
		.row.primary .lbl {
			font-size: clamp(1.2rem, 5.8vh, 1.95rem);
		}
		.row.link .lbl {
			font-size: clamp(0.8rem, 3.4vh, 1.05rem);
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
