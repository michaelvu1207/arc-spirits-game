<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import { createSoloPlayRoom, setActiveMemberId } from '$lib/stores/playStore.svelte';
	import { auth } from '$lib/auth/auth.svelte';
	import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import ProfileDock from '$lib/components/play2d/ProfileDock.svelte';

	const hover = () => playMenuSfx('ui-hover', { volume: 0.45 });

	// Shared with the server browser's "Playing as" field so a returning player
	// keeps their name; Quick Play stays one-tap by falling back to a default.
	const NAME_KEY = 'arc-player-name';

	// ── Ranked matchmaking ───────────────────────────────────────────────────────
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
		playMenuSfx('ui-click');
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

	/** First letter of a display name for the queue avatar chips. */
	function initial(name: string): string {
		return (name.trim()[0] ?? '?').toUpperCase();
	}

	onMount(() => {
		mounted = true;
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
		<div class="logo reveal" style="--d: 0.04s">
			<span class="kicker"><span class="kn">01</span><span class="kl"></span> Beta preview</span>
			<span class="l l1 brand-flame-text">Arc</span>
			<span class="l l2 brand-flame-text">Spirits</span>
			<span class="tag">Fight for the Arcane Abyss</span>
		</div>

		<div class="menu-col reveal" style="--d: 0.12s">
			{#if view === 'menu'}
				<nav class="menu" aria-label="Main menu">
					<button
						data-testid="solo-play"
						class="row primary"
						type="button"
						onclick={startSolo}
						onpointerenter={hover}
						disabled={soloStarting}
						aria-busy={soloStarting}
					>
						<span class="gem"></span>
						<span class="lbl">{soloStarting ? 'Starting…' : 'Solo Play'}</span>
						<span class="go" aria-hidden="true">→</span>
					</button>

					<button
						data-testid="quick-play"
						class="row link"
						type="button"
						onclick={startRanked}
						onpointerenter={hover}
					>
						<span class="gem"></span>
						<span class="lbl">Quick Play</span>
						<span class="go" aria-hidden="true">→</span>
					</button>

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
						href="/play/shop"
						onpointerenter={hover}
						onclick={() => playMenuSfx('ui-click')}
					>
						<span class="gem"></span><span class="lbl">Abyss Market</span><span class="go">→</span>
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
