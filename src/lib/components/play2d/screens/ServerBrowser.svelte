<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		fetchOpenRooms,
		createPlayRoom,
		joinPlayRoom,
		createDebugPlayRoom
	} from '$lib/stores/playStore.svelte';
	import type { RoomSummary } from '$lib/play/types';
	import { formatRelative } from '$lib/features/stats/format';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import { auth } from '$lib/auth/auth.svelte';
	import ScreenScaffold from './ScreenScaffold.svelte';
	import StateMessage from './StateMessage.svelte';

	interface Props {
		backHref?: string;
		backLabel?: string;
	}
	let { backHref = '/play', backLabel = 'Menu' }: Props = $props();

	const NAME_KEY = 'arc-player-name';
	/** How often the list silently re-polls. */
	const REFRESH_MS = 4000;

	let rooms = $state<RoomSummary[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let lastRefresh = $state<Date | null>(null);
	let name = $state('');
	/** Holds a roomCode or 'create' while that action is in flight. */
	let busy = $state<string | null>(null);
	let nameError = $state(false);
	let nameInput = $state<HTMLInputElement | null>(null);

	const openLobbies = $derived(
		rooms
			.filter((r) => r.status === 'lobby')
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
	);
	const liveGames = $derived(
		rooms
			.filter((r) => r.status === 'active')
			.sort(
				(a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt)
			)
	);

	const hover = () => playMenuSfx('ui-hover', { volume: 0.4 });

	// A PERMANENT account's name is authoritative — locked here so it can't be spoofed.
	// Guests (anonymous / not-yet-signed-in) can still type a name freely.
	const accountName = $derived(auth.isPermanent ? (auth.displayName ?? '') : null);

	// Keep the field showing the account name reactively while signed in (it updates if
	// they rename on /account, and reverts to the typed guest name on sign-out).
	$effect(() => {
		if (accountName) name = accountName;
	});

	/** Trimmed name to play under, or null (flagging the field) when empty. Signed-in
	 *  users always resolve to their account name. */
	function requireName(): string | null {
		if (accountName) return accountName;
		const trimmed = name.trim();
		if (!trimmed) {
			nameError = true;
			nameInput?.focus();
			return null;
		}
		nameError = false;
		return trimmed;
	}

	async function refresh() {
		// Only show the blocking loading state on the first load — the 4s poll must
		// not flicker the list.
		if (rooms.length === 0) loading = true;
		try {
			rooms = await fetchOpenRooms();
			error = null;
			lastRefresh = new Date();
		} catch (e) {
			console.error('Failed to load rooms:', e);
			error = e instanceof Error ? e.message : 'Failed to load rooms';
		} finally {
			loading = false;
		}
	}

	async function create() {
		if (busy) return;
		const typed = requireName();
		if (typed === null) return;
		busy = 'create';
		playMenuSfx('game-start', { volume: 0.8 });
		try {
			// Anonymous-first: a first-time guest becomes a real (owned) guest account here.
			const player = await auth.resolvePlayIdentity(typed);
			const view = await createPlayRoom(player);
			await goto(`/play/${encodeURIComponent(view.projection.roomCode)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create room.';
			busy = null;
		}
	}

	// ── Dev-only: spawn straight into the Awakening phase to test ability UX ──────
	const DEBUG_CLASSES = [
		'Purifier',
		'Infiltrator',
		'Fairy',
		'Sharpshooter',
		'Child Prodigy',
		'Ironmane',
		'Arcane Advisor',
		'Soul Weaver',
		'Abyss Summoner',
		'Mod Injector',
		'Healer',
		'Firekeeper',
		'Rune Mage',
		'Cursed Spirit',
		'Golden Ruler',
		'The Corruptor'
	];
	let debugClass = $state(DEBUG_CLASSES[0]);

	async function spawnDebug() {
		if (busy) return;
		busy = 'debug';
		playMenuSfx('game-start', { volume: 0.8 });
		try {
			const view = await createDebugPlayRoom(debugClass, name.trim() || 'Debug Player');
			await goto(`/play/${encodeURIComponent(view.projection.roomCode)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to spawn debug room.';
			busy = null;
		}
	}

	async function join(room: RoomSummary) {
		if (busy) return;
		const typed = requireName();
		if (typed === null) return;
		busy = room.roomCode;
		playMenuSfx('game-start', { volume: 0.8 });
		try {
			const player = await auth.resolvePlayIdentity(typed);
			await joinPlayRoom(room.roomCode, player);
			await goto(`/play/${encodeURIComponent(room.roomCode)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to join room.';
			busy = null;
		}
	}

	async function spectate(room: RoomSummary) {
		if (busy) return;
		// Spectating an in-progress game needs no seat claim — the room route loads it
		// read-only for any non-member. Just navigate.
		busy = room.roomCode;
		playMenuSfx('ui-click');
		try {
			await goto(`/play/${encodeURIComponent(room.roomCode)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to open game.';
			busy = null;
		}
	}

	onMount(() => {
		// Signed-in users get their account name (the $effect above sets it); guests
		// restore their last-typed name.
		if (browser && !accountName) name = localStorage.getItem(NAME_KEY) ?? '';
		void refresh();
		const timer = setInterval(() => {
			// Don't thrash the list mid-navigation.
			if (!busy) void refresh();
		}, REFRESH_MS);
		return () => clearInterval(timer);
	});

	$effect(() => {
		// Persist GUEST names only — never let an edit clobber the account name in
		// storage (the auth store owns that mirror for signed-in users).
		if (browser && !auth.isSignedIn) localStorage.setItem(NAME_KEY, name);
	});
</script>

<ScreenScaffold
	eyebrow="Play"
	title="Servers"
	subtitle="Join an open lobby, spectate a live game, or start your own."
	syncedAt={lastRefresh}
	{backHref}
	{backLabel}
>
	{#snippet actions()}
		<button
			class="btn-ghost"
			type="button"
			onclick={refresh}
			onpointerenter={hover}
			disabled={loading}
		>
			<svg
				class={loading ? 'spin' : ''}
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.4"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
				/>
			</svg>
			Refresh
		</button>
	{/snippet}

	<!-- ── Host bar ─────────────────────────────────────────── -->
	<div class="host-bar">
		<label class="name-field" class:invalid={nameError}>
			<span class="name-lbl">Playing as</span>
			<input
				bind:this={nameInput}
				class="input-bare"
				data-testid="player-name"
				bind:value={name}
				oninput={() => (nameError = false)}
				maxlength="40"
				placeholder="Nameless Spirit"
				spellcheck="false"
				aria-label="Playing as"
				aria-invalid={nameError}
				readonly={!!accountName}
				title={accountName ? 'Your account name (change it on the Account page)' : undefined}
			/>
			{#if accountName}
				<span class="name-hint account" data-testid="player-name-locked"
					>From your account · <a href="/account">change</a></span
				>
			{:else if nameError}
				<span class="name-hint" role="alert">Enter a name to play</span>
			{/if}
		</label>
		<button
			class="create-btn"
			type="button"
			data-testid="create-room"
			onclick={create}
			onpointerenter={hover}
			disabled={busy !== null}
		>
			<span class="gem" aria-hidden="true"></span>
			{busy === 'create' ? 'Creating…' : 'Create Room'}
		</button>
	</div>

	{#if dev}
		<!-- ── Debug bar (dev builds only) ──────────────────────── -->
		<div class="debug-bar" data-testid="debug-spawn">
			<span class="debug-tag">DEV</span>
			<span class="debug-lbl">Spawn into Awakening as</span>
			<select class="debug-select" bind:value={debugClass} aria-label="Debug class">
				{#each DEBUG_CLASSES as cls (cls)}
					<option value={cls}>{cls}</option>
				{/each}
			</select>
			<button
				class="debug-btn"
				type="button"
				onclick={spawnDebug}
				onpointerenter={hover}
				disabled={busy !== null}
				data-testid="debug-spawn-btn"
			>
				{busy === 'debug' ? 'Spawning…' : 'Spawn Test Game'}
			</button>
		</div>
	{/if}

	{#if error && rooms.length > 0}
		<div class="action-error" role="alert">{error}</div>
	{/if}

	{#if loading && rooms.length === 0}
		<StateMessage loading message="Scanning the abyss for open worlds…" />
	{:else if error && rooms.length === 0}
		<StateMessage tone="error" title="Could not reach the servers" message={error}>
			{#snippet actions()}
				<button class="btn-ghost" type="button" onclick={refresh}>Try Again</button>
			{/snippet}
		</StateMessage>
	{:else if rooms.length === 0}
		<StateMessage title="No open worlds" message="Be the first — create a room above." />
	{:else}
		<!-- ── Open Lobbies ─────────────────────────────────── -->
		<section class="group" aria-label="Open lobbies">
			<div class="group-head">
				<h2 class="group-title">Open Lobbies</h2>
				<span class="group-count">{openLobbies.length}</span>
				<span class="group-rule" aria-hidden="true"></span>
			</div>
			{#if openLobbies.length === 0}
				<p class="group-empty">No open lobbies right now.</p>
			{:else}
				<div class="room-grid">
					{#each openLobbies as room (room.roomCode)}
						{@const full = room.occupiedSeats >= room.totalSeats}
						<button
							type="button"
							class="room-card lobby"
							class:busy={busy === room.roomCode}
							data-testid={`room-${room.roomCode}`}
							onclick={() => join(room)}
							onpointerenter={hover}
							disabled={busy !== null}
						>
							<div class="room-top">
								<span class="status-pill lobby">Lobby</span>
								<span class="room-code">{room.roomCode}</span>
							</div>
							<div class="room-host">{room.hostName}'s game</div>
							<div class="room-meta">
								<span class="room-world">{room.scenarioName ?? 'Arcane Abyss'}</span>
								<span class="dot" aria-hidden="true">·</span>
								<span class="room-age">{formatRelative(room.createdAt)}</span>
							</div>
							<div class="room-foot">
								<span class="seats" class:full>
									<span class="seats-n">{room.occupiedSeats}/{room.totalSeats}</span> seats
								</span>
								<span class="room-cta">
									{busy === room.roomCode ? 'Joining…' : 'Join'}
									<span class="cta-arrow" aria-hidden="true">→</span>
								</span>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</section>

		<!-- ── Live Games ───────────────────────────────────── -->
		<section class="group" aria-label="Live games">
			<div class="group-head">
				<h2 class="group-title">Live Games</h2>
				<span class="group-count">{liveGames.length}</span>
				<span class="group-rule live" aria-hidden="true"></span>
			</div>
			{#if liveGames.length === 0}
				<p class="group-empty">No live games right now.</p>
			{:else}
				<div class="room-grid">
					{#each liveGames as room (room.roomCode)}
						<button
							type="button"
							class="room-card live"
							class:busy={busy === room.roomCode}
							onclick={() => spectate(room)}
							onpointerenter={hover}
							disabled={busy !== null}
						>
							<div class="room-top">
								<span class="room-code">{room.roomCode}</span>
							</div>
							<div class="room-host">{room.hostName}'s game</div>
							<div class="room-meta">
								<span class="room-world">Round {room.round}</span>
								<span class="dot" aria-hidden="true">·</span>
								<span class="room-age">{formatRelative(room.startedAt ?? room.createdAt)}</span>
							</div>
							<div class="room-foot">
								<span class="seats">
									<span class="seats-n">{room.occupiedSeats}</span> playing
								</span>
								<span class="room-cta watch">
									{busy === room.roomCode ? 'Opening…' : 'Watch'}
									<span class="cta-arrow" aria-hidden="true">→</span>
								</span>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</section>

		<div class="browser-foot">
			Showing <b>{openLobbies.length}</b> open · <b>{liveGames.length}</b> live
		</div>
	{/if}
</ScreenScaffold>

<style>
	/* ── Host bar ──────────────────────────────────────────── */
	.host-bar {
		display: flex;
		align-items: flex-end;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: clamp(28px, 5vh, 44px);
		padding-bottom: 22px;
		border-bottom: 1px solid var(--color-mist);
	}
	.name-field {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 200px;
		position: relative;
	}
	.name-lbl {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.26em;
		text-transform: uppercase;
		color: var(--color-fog);
	}
	.name-field :global(.input-bare) {
		min-width: 180px;
	}
	.name-field.invalid :global(.input-bare) {
		border-color: var(--color-blood);
	}
	.name-hint {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-blood);
		letter-spacing: 0.02em;
	}
	.name-hint.account {
		color: var(--color-fog);
	}
	.name-hint.account a {
		color: var(--brand-magenta-soft, #ff5dd1);
	}
	.create-btn {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 11px 20px;
		border: none;
		border-radius: 10px;
		background: var(--gradient-flame);
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.84rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		box-shadow: 0 12px 30px -14px rgba(255, 43, 199, 0.7);
		transition: transform 150ms ease;
	}
	.create-btn:hover:not(:disabled) {
		transform: translateY(-1px);
	}
	.create-btn:disabled {
		opacity: 0.55;
		cursor: progress;
	}
	.create-btn .gem {
		width: 9px;
		height: 9px;
		flex: none;
		transform: rotate(45deg);
		background: rgba(255, 255, 255, 0.92);
		box-shadow: 0 0 10px rgba(255, 255, 255, 0.6);
	}

	.action-error {
		margin-bottom: 18px;
		padding: 11px 16px;
		border-left: 3px solid var(--color-blood);
		background: rgba(196, 26, 61, 0.22);
		color: var(--color-bone);
		border-radius: 2px;
		font-size: 0.85rem;
	}

	/* ── Debug bar (dev only) ─────────────────────────────── */
	.debug-bar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		margin-bottom: 18px;
		padding: 10px 14px;
		border: 1px dashed color-mix(in srgb, var(--brand-cyan, #24d4ff) 55%, transparent);
		border-radius: 6px;
		background: rgba(36, 212, 255, 0.07);
	}
	.debug-tag {
		font-family: var(--font-mono, monospace);
		font-size: 0.62rem;
		letter-spacing: 0.18em;
		padding: 2px 6px;
		border-radius: 3px;
		background: var(--brand-cyan, #24d4ff);
		color: #04121a;
	}
	.debug-lbl {
		font-size: 0.8rem;
		color: var(--color-fog, #9a8fb8);
	}
	.debug-select {
		font: inherit;
		font-size: 0.82rem;
		padding: 6px 8px;
		border-radius: 4px;
		border: 1px solid var(--color-mist, #3a2670);
		background: rgba(8, 5, 16, 0.7);
		color: var(--color-parchment, #d8cfee);
	}
	.debug-btn {
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 8px 14px;
		border-radius: 4px;
		border: 1px solid var(--brand-cyan, #24d4ff);
		background: transparent;
		color: var(--brand-cyan, #24d4ff);
		cursor: pointer;
		transition:
			background 140ms ease,
			color 140ms ease;
	}
	.debug-btn:not(:disabled):hover {
		background: var(--brand-cyan, #24d4ff);
		color: #04121a;
	}
	.debug-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ── Group headings ───────────────────────────────────── */
	.group {
		margin-bottom: 36px;
	}
	.group:last-of-type {
		margin-bottom: 0;
	}
	.group-head {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}
	.group-title {
		font-family: var(--font-display);
		font-size: clamp(1.5rem, 3.4vmin, 2.1rem);
		line-height: 1;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-bone);
		margin: 0;
	}
	.group-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.6rem;
		height: 1.6rem;
		padding: 0 0.4rem;
		font-family: var(--font-display);
		font-size: 0.9rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-void);
		background: var(--brand-magenta);
		border-radius: 999px;
	}
	.group-rule {
		flex: 1;
		height: 1px;
		background: var(--gradient-flame);
		opacity: 0.5;
	}
	.group-rule.live {
		background: linear-gradient(90deg, var(--brand-teal), transparent);
		opacity: 0.6;
	}
	.group-empty {
		margin: 0;
		color: var(--color-fog);
		font-size: 0.82rem;
		font-family: var(--font-body);
	}

	/* ── Room cards ───────────────────────────────────────── */
	.room-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 14px;
	}
	.room-card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
		padding: 18px 20px;
		text-align: left;
		cursor: pointer;
		color: inherit;
		background: linear-gradient(180deg, rgba(20, 12, 36, 0.74), rgba(10, 6, 20, 0.74));
		border: 1px solid var(--color-mist);
		border-left: 4px solid var(--brand-magenta);
		border-radius: 12px;
		overflow: hidden;
		transition:
			border-color 240ms ease,
			background 240ms ease,
			transform 240ms ease;
	}
	.room-card::after {
		content: '';
		position: absolute;
		left: 12px;
		right: 12px;
		bottom: 0;
		height: 1px;
		background: var(--gradient-spectrum);
		transform: scaleX(0);
		transform-origin: left;
		opacity: 0.85;
		transition: transform 240ms ease;
	}
	.room-card.live {
		border-left-color: var(--brand-teal);
	}
	.room-card:hover:not(:disabled),
	.room-card:focus-visible {
		border-color: var(--brand-magenta);
		background: linear-gradient(180deg, rgba(40, 16, 52, 0.8), rgba(16, 8, 28, 0.8));
		transform: translateY(-2px);
		outline: none;
	}
	.room-card:hover:not(:disabled)::after,
	.room-card:focus-visible::after {
		transform: scaleX(1);
	}
	.room-card.live:hover:not(:disabled),
	.room-card.live:focus-visible {
		border-color: var(--brand-teal);
	}
	.room-card:disabled {
		cursor: progress;
	}
	.room-card.busy {
		opacity: 0.7;
	}
	.room-card:disabled:not(.busy) {
		opacity: 0.5;
	}

	.room-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.status-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 9px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		border-radius: 999px;
	}
	.status-pill.lobby {
		color: var(--brand-cyan);
		background: rgba(36, 212, 255, 0.12);
	}
	.status-pill.live {
		color: var(--brand-teal);
		background: rgba(32, 224, 193, 0.12);
	}
	.live-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--brand-teal);
		box-shadow: 0 0 6px var(--brand-teal);
		animation: pulse 1.8s ease-in-out infinite;
	}
	.room-code {
		font-family: var(--font-mono);
		font-size: 0.92rem;
		letter-spacing: 0.18em;
		color: var(--color-fog);
	}

	.room-host {
		font-family: var(--font-display);
		font-size: 1.35rem;
		line-height: 1;
		letter-spacing: 0.01em;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.room-meta {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 0.8rem;
		color: var(--color-fog);
		font-family: var(--font-body);
		min-width: 0;
	}
	.room-world {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.room-meta .dot {
		opacity: 0.6;
	}
	.room-age {
		font-family: var(--font-mono);
		flex: none;
	}

	.room-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 4px;
		padding-top: 12px;
		border-top: 1px solid var(--color-mist);
	}
	.seats {
		font-size: 0.8rem;
		color: var(--color-fog);
		letter-spacing: 0.04em;
	}
	.seats-n {
		font-family: var(--font-display);
		font-size: 1rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
		margin-right: 2px;
	}
	.seats.full .seats-n {
		color: var(--brand-amber);
	}
	.room-cta {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-display);
		font-size: 0.82rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft);
	}
	.room-cta.watch {
		color: var(--brand-teal);
	}
	.cta-arrow {
		transition: transform 200ms ease;
	}
	.room-card:hover:not(:disabled) .cta-arrow,
	.room-card:focus-visible .cta-arrow {
		transform: translateX(3px);
	}

	/* ── Footer ───────────────────────────────────────────── */
	.browser-foot {
		margin-top: 26px;
		text-align: center;
		font-size: 0.8rem;
		color: var(--color-fog);
	}
	.browser-foot b {
		color: var(--color-bone);
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	/* Refresh-icon spin (StateMessage owns the loading ring). */
	.spin {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	/* ── Responsive ───────────────────────────────────────── */
	@media (max-width: 600px) {
		.room-grid {
			grid-template-columns: 1fr;
		}
		.host-bar {
			gap: 12px;
		}
		.name-field,
		.name-field :global(.input-bare) {
			min-width: 0;
		}
		.name-field {
			flex: 1;
		}
		.create-btn {
			align-self: stretch;
			justify-content: center;
			flex: 1;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) {
		.host-bar {
			display: grid;
			grid-template-columns: minmax(170px, 260px) auto;
			align-items: end;
			gap: 12px;
			margin-bottom: 16px;
			padding-bottom: 14px;
		}
		.name-field {
			min-width: 0;
		}
		.name-lbl {
			font-size: 0.66rem;
			letter-spacing: 0.22em;
		}
		.name-field :global(.input-bare) {
			min-width: 0;
			width: 100%;
			font-size: 0.95rem;
		}
		.name-hint {
			font-size: 0.68rem;
		}
		.create-btn {
			min-height: 44px;
			padding: 10px 18px;
			border-radius: 9px;
			font-size: 0.74rem;
			justify-content: center;
		}
		.action-error {
			margin-bottom: 12px;
			padding: 9px 12px;
			font-size: 0.78rem;
		}
		.debug-bar {
			margin-bottom: 12px;
			padding: 8px 10px;
		}
		.group {
			margin-bottom: 22px;
		}
		.group-head {
			gap: 10px;
			margin-bottom: 10px;
		}
		.group-title {
			font-size: 1.25rem;
		}
		.group-count {
			min-width: 1.3rem;
			height: 1.3rem;
			font-size: 0.76rem;
		}
		.room-grid {
			grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
			gap: 10px;
		}
		.room-card {
			min-height: 108px;
			gap: 6px;
			padding: 13px 14px;
			border-radius: 10px;
		}
		.status-pill {
			padding: 3px 7px;
			font-size: 0.66rem;
			letter-spacing: 0.15em;
		}
		.room-code {
			font-size: 0.78rem;
			letter-spacing: 0.14em;
		}
		.room-host {
			font-size: 1.08rem;
		}
		.room-meta,
		.seats {
			font-size: 0.72rem;
		}
		.room-foot {
			margin-top: 2px;
			padding-top: 8px;
		}
		.room-cta {
			font-size: 0.72rem;
			letter-spacing: 0.1em;
		}
		.browser-foot {
			margin-top: 16px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.room-card,
		.room-card::after,
		.cta-arrow,
		.create-btn {
			transition: none;
		}
		.room-card:hover:not(:disabled),
		.room-card:focus-visible {
			transform: none;
		}
		.live-dot,
		.spin {
			animation: none;
		}
	}
</style>
