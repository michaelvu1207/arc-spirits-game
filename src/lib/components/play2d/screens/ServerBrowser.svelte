<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		fetchOpenRooms,
		createPlayRoom,
		joinPlayRoom,
		createDebugPlayRoom,
		sendPlayCommand,
		postPlayJson
	} from '$lib/stores/playStore.svelte';
	import type { RoomSummary } from '$lib/play/types';
	import { NAVIGATION_TIMER_OPTIONS, DEFAULT_NAVIGATION_DURATION_MS } from '$lib/play/types';
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

	// ── Create sheet (room configured at creation, not via lobby chips) ──────
	let sheetOpen = $state(false);
	let sheetTimerMs = $state<number | null>(DEFAULT_NAVIGATION_DURATION_MS);
	let sheetBots = $state(0);
	let sheetInvite = $state(false);
	let sheetNameInput = $state<HTMLInputElement | null>(null);
	const MAX_SHEET_BOTS = 5;

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

	const shownName = $derived(accountName ?? (name.trim() || null));

	/** Trimmed name to play under, or null (opening the sheet's field) when empty.
	 *  Signed-in users always resolve to their account name. */
	function requireName(): string | null {
		if (accountName) return accountName;
		const trimmed = name.trim();
		if (!trimmed) {
			nameError = true;
			sheetOpen = true;
			setTimeout(() => sheetNameInput?.focus(), 60);
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

	function openSheet() {
		playMenuSfx('ui-click');
		nameError = false;
		sheetOpen = true;
	}
	function closeSheet() {
		playMenuSfx('ui-back');
		sheetOpen = false;
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
			const code = view.projection.roomCode;
			// Apply the sheet's config as host commands before entering the lobby.
			// Best-effort: a hiccup here still lands us in a working room.
			try {
				if (sheetTimerMs !== DEFAULT_NAVIGATION_DURATION_MS) {
					await sendPlayCommand({ type: 'setNavigationTimer', durationMs: sheetTimerMs });
				}
				for (let i = 0; i < sheetBots; i++) {
					await postPlayJson(`/api/play/sessions/${encodeURIComponent(code)}/bots/add`, {
						difficulty: 'neural'
					});
				}
			} catch (configErr) {
				console.warn('Room created; applying lobby config failed:', configErr);
			}
			await goto(`/play/${encodeURIComponent(code)}${sheetInvite ? '?invite=1' : ''}`);
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
		if (room.occupiedSeats >= room.totalSeats) return;
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

	function onKey(e: KeyboardEvent) {
		if (sheetOpen && e.key === 'Escape') closeSheet();
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

	// The shell's top-right controls yield while the create sheet is up (they'd
	// otherwise paint over the sheet on short viewports).
	$effect(() => {
		if (!browser) return;
		document.body.classList.toggle('pregame-overlay-open', sheetOpen);
		return () => document.body.classList.remove('pregame-overlay-open');
	});
</script>

<svelte:window onkeydown={onKey} />

<ScreenScaffold
	eyebrow="Custom Lobby"
	title="Rooms"
	subtitle="Join an open lobby, spectate a live game, or forge your own."
	syncedAt={lastRefresh}
	{backHref}
	{backLabel}
>
	{#snippet actions()}
		<span class="playing-chip" data-testid="playing-as">
			Playing as <b>{shownName ?? 'Nameless Spirit'}</b>
			{#if accountName}
				<a class="playing-edit" href="/account" title="Change your account name">change</a>
			{:else}
				<button class="playing-edit" type="button" onclick={openSheet}>change</button>
			{/if}
		</span>
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
		<StateMessage
			title="No open worlds"
			message="The abyss is quiet. Forge the first room below."
		/>
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
							class:full
							data-testid={`room-${room.roomCode}`}
							onclick={() => join(room)}
							onpointerenter={() => !full && hover()}
							disabled={busy !== null || full}
						>
							<span class="host-medallion" aria-hidden="true">
								{(room.hostName.trim()[0] ?? '?').toUpperCase()}
							</span>
							<div class="room-main">
								<div class="room-top">
									<span class="room-host">{room.hostName}'s room</span>
									<span class="room-code">{room.roomCode}</span>
								</div>
								<div class="room-meta">
									<span class="room-world">{room.scenarioName ?? 'Arcane Abyss'}</span>
									<span class="dot" aria-hidden="true">·</span>
									<span class="room-age">{formatRelative(room.createdAt)}</span>
								</div>
								<div class="room-foot">
									<span class="seat-pips" aria-label="{room.occupiedSeats} of {room.totalSeats} seats taken">
										{#each Array(room.totalSeats) as _, i (i)}
											<span class="pip" class:filled={i < room.occupiedSeats}></span>
										{/each}
										<span class="pips-n">{room.occupiedSeats}/{room.totalSeats}</span>
									</span>
									{#if full}
										<span class="full-chip">Full</span>
									{:else}
										<span class="room-cta">
											{busy === room.roomCode ? 'Joining…' : 'Join'}
											<span class="cta-arrow" aria-hidden="true">→</span>
										</span>
									{/if}
								</div>
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
				<span class="group-count live">{liveGames.length}</span>
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
							<span class="host-medallion live" aria-hidden="true">
								{(room.hostName.trim()[0] ?? '?').toUpperCase()}
							</span>
							<div class="room-main">
								<div class="room-top">
									<span class="room-host">{room.hostName}'s game</span>
									<span class="room-code">{room.roomCode}</span>
								</div>
								<div class="room-meta">
									<span class="live-dot" aria-hidden="true"></span>
									<span class="room-world">Round {room.round}</span>
									<span class="dot" aria-hidden="true">·</span>
									<span class="room-age">{formatRelative(room.startedAt ?? room.createdAt)}</span>
								</div>
								<div class="room-foot">
									<span class="seats"><b>{room.occupiedSeats}</b> playing</span>
									<span class="room-cta watch">
										{busy === room.roomCode ? 'Opening…' : 'Watch'}
										<span class="cta-arrow" aria-hidden="true">→</span>
									</span>
								</div>
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

	<!-- Spacer so the bottom-anchored Create never covers the last cards. -->
	<div class="fab-spacer" aria-hidden="true"></div>
</ScreenScaffold>

<!-- ── Bottom-anchored primary action ─────────────────────────── -->
<div class="create-dock">
	<button
		class="create-btn"
		type="button"
		data-testid="create-room"
		onclick={openSheet}
		onpointerenter={hover}
		disabled={busy !== null}
	>
		<span class="gem" aria-hidden="true"></span>
		{busy === 'create' ? 'Creating…' : 'Create Room'}
	</button>
</div>

<!-- ── Create sheet: the room is configured AT creation ───────── -->
{#if sheetOpen}
	<div class="sheet-layer">
		<button
			type="button"
			class="sheet-backdrop"
			aria-label="Close create room"
			onclick={closeSheet}
		></button>
		<div class="sheet" role="dialog" aria-modal="true" aria-label="Create a room" data-testid="create-sheet">
			<header class="sheet-head">
				<div>
					<span class="sheet-eyebrow">New room</span>
					<h2 class="sheet-title">Forge your lobby</h2>
				</div>
				<button class="sheet-close" type="button" onclick={closeSheet} aria-label="Close">✕</button>
			</header>

			<label class="field" class:invalid={nameError}>
				<span class="field-lbl">Playing as</span>
				<input
					bind:this={sheetNameInput}
					class="field-input"
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
					<span class="field-hint" data-testid="player-name-locked"
						>From your account · <a href="/account">change</a></span
					>
				{:else if nameError}
					<span class="field-hint error" role="alert">Enter a name to play</span>
				{/if}
			</label>

			<div class="field">
				<span class="field-lbl">Navigation timer</span>
				<div class="seg-row" role="radiogroup" aria-label="Navigation timer per round">
					{#each NAVIGATION_TIMER_OPTIONS as opt (opt.label)}
						<button
							type="button"
							class="seg"
							class:on={sheetTimerMs === opt.ms}
							role="radio"
							aria-checked={sheetTimerMs === opt.ms}
							onclick={() => {
								playMenuSfx('ui-click');
								sheetTimerMs = opt.ms;
							}}
						>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="field">
				<span class="field-lbl">Bots <small class="field-sub">· ML policy</small></span>
				<div class="stepper">
					<button
						type="button"
						class="step"
						aria-label="Fewer bots"
						disabled={sheetBots === 0}
						onclick={() => {
							playMenuSfx('ui-click');
							sheetBots = Math.max(0, sheetBots - 1);
						}}>−</button
					>
					<span class="step-n" data-testid="sheet-bots">{sheetBots}</span>
					<button
						type="button"
						class="step"
						aria-label="More bots"
						disabled={sheetBots >= MAX_SHEET_BOTS}
						onclick={() => {
							playMenuSfx('ui-click');
							sheetBots = Math.min(MAX_SHEET_BOTS, sheetBots + 1);
						}}>+</button
					>
					<span class="step-hint"
						>{sheetBots === 0 ? 'Humans only' : `You + ${sheetBots} bot${sheetBots === 1 ? '' : 's'}`}</span
					>
				</div>
			</div>

			<label class="toggle-row">
				<input type="checkbox" bind:checked={sheetInvite} />
				<span class="toggle-ui" aria-hidden="true"></span>
				<span class="toggle-lbl">Show the invite link when the room opens</span>
			</label>

			<div class="sheet-foot">
				<button class="sheet-cancel" type="button" onclick={closeSheet}>Cancel</button>
				<button
					class="sheet-create"
					type="button"
					data-testid="create-room-confirm"
					onclick={create}
					disabled={busy !== null}
				>
					<span class="gem" aria-hidden="true"></span>
					{busy === 'create' ? 'Creating…' : 'Create Room'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* ── Header identity chip ─────────────────────────────── */
	.playing-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 38px;
		padding: 7px 14px;
		border-radius: 999px;
		border: 1px solid var(--color-mist);
		background: rgba(10, 7, 24, 0.5);
		color: var(--color-fog);
		font-family: var(--font-body);
		font-size: 0.8rem;
		white-space: nowrap;
	}
	.playing-chip b {
		color: var(--color-bone);
		font-weight: 600;
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.playing-edit {
		border: none;
		background: none;
		padding: 0;
		margin-left: 2px;
		color: var(--brand-magenta-soft, #ff5dd1);
		font-family: var(--font-body);
		font-size: 0.74rem;
		text-decoration: underline;
		cursor: pointer;
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
	.group-count.live {
		background: var(--brand-teal);
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
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 14px;
	}
	.room-card {
		position: relative;
		display: flex;
		align-items: stretch;
		gap: 16px;
		width: 100%;
		min-height: 108px;
		padding: 16px 18px;
		text-align: left;
		cursor: pointer;
		color: inherit;
		background: linear-gradient(180deg, rgba(20, 12, 36, 0.74), rgba(10, 6, 20, 0.74));
		border: 1px solid var(--color-mist);
		border-radius: 16px;
		overflow: hidden;
		transition:
			border-color 240ms ease,
			background 240ms ease,
			box-shadow 240ms ease;
	}
	.room-card::after {
		content: '';
		position: absolute;
		left: 14px;
		right: 14px;
		bottom: 0;
		height: 1px;
		background: var(--gradient-spectrum);
		transform: scaleX(0);
		transform-origin: left;
		opacity: 0.85;
		transition: transform 240ms ease;
	}
	.room-card:hover:not(:disabled),
	.room-card:focus-visible {
		border-color: var(--brand-magenta);
		background: linear-gradient(180deg, rgba(40, 16, 52, 0.8), rgba(16, 8, 28, 0.8));
		box-shadow: 0 18px 44px -22px rgba(255, 43, 199, 0.55);
		outline: none;
	}
	.room-card:hover:not(:disabled)::after,
	.room-card:focus-visible::after {
		transform: scaleX(1);
	}
	.room-card.live:hover:not(:disabled),
	.room-card.live:focus-visible {
		border-color: var(--brand-teal);
		box-shadow: 0 18px 44px -22px rgba(32, 224, 193, 0.45);
	}
	.room-card:disabled {
		cursor: progress;
	}
	.room-card.busy {
		opacity: 0.7;
	}
	.room-card:disabled:not(.busy):not(.full) {
		opacity: 0.5;
	}
	/* Full rooms stay visible but read as closed. */
	.room-card.full {
		cursor: not-allowed;
		opacity: 0.65;
	}

	.host-medallion {
		flex: 0 0 auto;
		align-self: center;
		width: 58px;
		height: 58px;
		display: grid;
		place-items: center;
		border-radius: 16px;
		background: var(--gradient-flame);
		color: #fff;
		font-family: var(--font-display);
		font-size: 1.5rem;
		box-shadow: 0 0 22px -6px rgba(255, 43, 199, 0.7);
	}
	.host-medallion.live {
		background: linear-gradient(135deg, var(--brand-teal), var(--brand-cyan));
		box-shadow: 0 0 22px -6px rgba(32, 224, 193, 0.7);
	}
	.room-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.room-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
	}
	.room-host {
		font-family: var(--font-display);
		font-size: 1.3rem;
		line-height: 1;
		letter-spacing: 0.01em;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.room-code {
		flex: none;
		font-family: var(--font-mono);
		font-size: 0.82rem;
		letter-spacing: 0.16em;
		color: var(--color-fog);
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
	.live-dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--brand-teal);
		box-shadow: 0 0 8px var(--brand-teal);
		animation: pulse 1.8s ease-in-out infinite;
	}

	.room-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: auto;
		padding-top: 10px;
		border-top: 1px solid var(--color-mist);
	}
	.seat-pips {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.pip {
		width: 9px;
		height: 9px;
		border-radius: 3px;
		transform: rotate(45deg);
		border: 1px solid var(--color-aether);
		background: transparent;
	}
	.pip.filled {
		border-color: transparent;
		background: var(--gradient-flame);
		box-shadow: 0 0 8px rgba(255, 43, 199, 0.5);
	}
	.pips-n {
		margin-left: 6px;
		font-family: var(--font-display);
		font-size: 0.86rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.seats {
		font-size: 0.8rem;
		color: var(--color-fog);
		letter-spacing: 0.04em;
	}
	.seats b {
		font-family: var(--font-display);
		font-size: 1rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
		margin-right: 2px;
	}
	.full-chip {
		padding: 4px 12px;
		border-radius: 999px;
		border: 1px solid rgba(255, 186, 61, 0.5);
		color: var(--brand-amber);
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	.room-cta {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-display);
		font-size: 0.84rem;
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
	.fab-spacer {
		height: 92px;
	}

	/* ── Bottom-anchored Create ───────────────────────────── */
	.create-dock {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 65;
		display: flex;
		justify-content: center;
		padding: 26px 18px calc(18px + env(safe-area-inset-bottom));
		background: linear-gradient(180deg, transparent, rgba(5, 3, 16, 0.88) 55%);
		pointer-events: none;
	}
	.create-btn {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		min-height: 56px;
		min-width: min(340px, 86vw);
		padding: 13px 30px;
		border: none;
		border-radius: 15px;
		background: var(--gradient-flame);
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		box-shadow: 0 16px 40px -14px rgba(255, 43, 199, 0.75);
		transition: filter 150ms ease;
	}
	.create-btn:hover:not(:disabled) {
		filter: brightness(1.1);
	}
	.create-btn:disabled {
		opacity: 0.55;
		cursor: progress;
	}
	.gem {
		width: 9px;
		height: 9px;
		flex: none;
		transform: rotate(45deg);
		background: rgba(255, 255, 255, 0.92);
		box-shadow: 0 0 10px rgba(255, 255, 255, 0.6);
	}

	/* ── Create sheet ─────────────────────────────────────── */
	.sheet-layer {
		position: fixed;
		inset: 0;
		z-index: 75;
		display: grid;
		place-items: center;
		padding: 18px;
	}
	.sheet-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		background: rgba(4, 2, 12, 0.7);
		backdrop-filter: blur(8px);
		cursor: pointer;
	}
	.sheet {
		position: relative;
		width: min(520px, 100%);
		max-height: calc(100dvh - 32px);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 24px 26px;
		border-radius: 20px;
		border: 1px solid color-mix(in srgb, var(--brand-magenta) 30%, var(--color-mist));
		background: linear-gradient(180deg, rgba(26, 15, 46, 0.97), rgba(8, 5, 18, 0.98));
		box-shadow:
			0 40px 120px -30px rgba(0, 0, 0, 0.85),
			0 0 60px -34px var(--brand-magenta);
		animation: sheet-rise 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
		scrollbar-width: thin;
	}
	.sheet-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 14px;
	}
	.sheet-eyebrow {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: var(--brand-cyan);
	}
	.sheet-title {
		margin: 5px 0 0;
		font-family: var(--font-display);
		font-size: clamp(1.4rem, 4vh, 1.9rem);
		line-height: 1;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
	}
	.sheet-close {
		flex: 0 0 auto;
		width: 40px;
		height: 40px;
		border-radius: 999px;
		border: 1px solid var(--color-mist);
		background: transparent;
		color: var(--color-parchment);
		cursor: pointer;
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.sheet-close:hover {
		border-color: var(--brand-magenta);
		color: var(--brand-magenta-soft);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.field-lbl {
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
	}
	.field-sub {
		font-size: 0.62rem;
		letter-spacing: 0.1em;
		color: var(--color-whisper, #6a5d8a);
	}
	.field-input {
		min-height: 48px;
		padding: 10px 14px;
		border-radius: 12px;
		border: 1px solid var(--color-aether);
		background: rgba(5, 3, 16, 0.7);
		color: var(--color-bone);
		font-family: var(--font-body);
		font-size: 1rem;
	}
	.field-input:focus {
		outline: none;
		border-color: var(--brand-magenta);
	}
	.field.invalid .field-input {
		border-color: var(--color-blood);
	}
	.field-hint {
		font-family: var(--font-mono);
		font-size: 0.74rem;
		color: var(--color-fog);
	}
	.field-hint.error {
		color: var(--color-blood);
	}
	.field-hint a {
		color: var(--brand-magenta-soft);
	}

	.seg-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.seg {
		min-height: 44px;
		padding: 9px 15px;
		border-radius: 11px;
		border: 1px solid var(--color-aether);
		background: transparent;
		color: var(--color-parchment);
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition:
			border-color 140ms ease,
			background 140ms ease,
			color 140ms ease;
	}
	.seg:hover {
		border-color: var(--brand-magenta);
	}
	.seg.on {
		border-color: transparent;
		background: var(--gradient-flame);
		color: #fff;
		box-shadow: 0 8px 22px -10px rgba(255, 43, 199, 0.7);
	}

	.stepper {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.step {
		width: 46px;
		height: 46px;
		border-radius: 12px;
		border: 1px solid var(--color-aether);
		background: transparent;
		color: var(--color-bone);
		font-size: 1.25rem;
		line-height: 1;
		cursor: pointer;
		transition:
			border-color 140ms ease,
			background 140ms ease;
	}
	.step:hover:not(:disabled) {
		border-color: var(--brand-magenta);
		background: rgba(255, 43, 199, 0.08);
	}
	.step:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.step-n {
		min-width: 34px;
		text-align: center;
		font-family: var(--font-display);
		font-size: 1.5rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.step-hint {
		font-family: var(--font-body);
		font-size: 0.8rem;
		color: var(--color-fog);
	}

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 12px;
		cursor: pointer;
		user-select: none;
	}
	.toggle-row input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.toggle-ui {
		flex: 0 0 auto;
		width: 46px;
		height: 26px;
		border-radius: 999px;
		border: 1px solid var(--color-aether);
		background: rgba(5, 3, 16, 0.7);
		position: relative;
		transition:
			background 160ms ease,
			border-color 160ms ease;
	}
	.toggle-ui::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 3px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--color-fog);
		transform: translateY(-50%);
		transition:
			left 160ms ease,
			background 160ms ease;
	}
	.toggle-row input:checked + .toggle-ui {
		border-color: transparent;
		background: var(--gradient-flame);
	}
	.toggle-row input:checked + .toggle-ui::after {
		left: 24px;
		background: #fff;
	}
	.toggle-row input:focus-visible + .toggle-ui {
		outline: 2px solid var(--brand-magenta);
		outline-offset: 2px;
	}
	.toggle-lbl {
		font-family: var(--font-body);
		font-size: 0.86rem;
		color: var(--color-parchment);
	}

	.sheet-foot {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		margin-top: 4px;
		/* The sheet body scrolls on short viewports; the action row stays pinned
		   so Create is never below the fold. Opaque backing hides scrolled fields. */
		position: sticky;
		bottom: 0;
		margin-bottom: -8px;
		padding: 10px 0 8px;
		background: linear-gradient(180deg, transparent, rgba(10, 6, 20, 0.96) 26%);
	}
	.sheet-cancel {
		min-height: 50px;
		padding: 12px 20px;
		border-radius: 12px;
		border: 1px solid var(--color-aether);
		background: transparent;
		color: var(--color-parchment);
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.sheet-cancel:hover {
		border-color: var(--brand-magenta);
		color: #fff;
	}
	.sheet-create {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		min-height: 50px;
		padding: 12px 26px;
		border: none;
		border-radius: 12px;
		background: var(--gradient-flame);
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.86rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		box-shadow: 0 14px 34px -14px rgba(255, 43, 199, 0.75);
		transition: filter 150ms ease;
	}
	.sheet-create:hover:not(:disabled) {
		filter: brightness(1.1);
	}
	.sheet-create:disabled {
		opacity: 0.55;
		cursor: progress;
	}

	@keyframes sheet-rise {
		from {
			opacity: 0;
			transform: translateY(22px) scale(0.98);
		}
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
	@media (max-width: 640px) {
		.room-grid {
			grid-template-columns: 1fr;
		}
		.playing-chip b {
			max-width: 110px;
		}
		.create-btn {
			width: 100%;
		}
		/* Bottom sheet on phones. */
		.sheet-layer {
			place-items: end center;
			padding: 0;
		}
		.sheet {
			width: 100%;
			max-height: 92dvh;
			border-radius: 22px 22px 0 0;
			padding: 20px 18px calc(18px + env(safe-area-inset-bottom));
			animation: sheet-up 260ms cubic-bezier(0.2, 0.7, 0.2, 1);
		}
		.sheet-foot {
			flex-direction: column-reverse;
		}
		.sheet-cancel,
		.sheet-create {
			width: 100%;
			justify-content: center;
		}
	}
	@keyframes sheet-up {
		from {
			transform: translateY(40px);
			opacity: 0;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) {
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
			grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
			gap: 10px;
		}
		.room-card {
			min-height: 96px;
			gap: 12px;
			padding: 12px 14px;
			border-radius: 13px;
		}
		.host-medallion {
			width: 46px;
			height: 46px;
			border-radius: 13px;
			font-size: 1.2rem;
		}
		.room-host {
			font-size: 1.06rem;
		}
		.room-code {
			font-size: 0.72rem;
			letter-spacing: 0.12em;
		}
		.room-meta,
		.seats {
			font-size: 0.72rem;
		}
		.room-foot {
			padding-top: 8px;
		}
		.room-cta {
			font-size: 0.72rem;
			letter-spacing: 0.1em;
		}
		.browser-foot {
			margin-top: 16px;
		}
		.fab-spacer {
			height: 76px;
		}
		.create-dock {
			justify-content: flex-end;
			padding: 18px max(18px, env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom));
		}
		.create-btn {
			min-height: 48px;
			min-width: 0;
		}
		.sheet {
			max-height: calc(100dvh - 20px);
			gap: 10px;
			padding: 14px 20px 10px;
		}
		.sheet-title {
			font-size: 1.2rem;
		}
		.sheet-close {
			width: 34px;
			height: 34px;
		}
		.sheet-foot {
			margin-top: 0;
			margin-bottom: -12px;
			padding: 8px 0;
		}
		/* Tighten fields so name + timer + bots + actions fit a 390-high sheet
		   with little or no scrolling. */
		.sheet-eyebrow {
			display: none;
		}
		.field {
			gap: 5px;
		}
		.field-input {
			min-height: 42px;
			padding: 8px 14px;
		}
		.seg {
			min-height: 40px;
		}
		.step {
			width: 42px;
			height: 42px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.room-card,
		.room-card::after,
		.cta-arrow,
		.create-btn {
			transition: none;
		}
		.live-dot,
		.spin {
			animation: none;
		}
		.sheet {
			animation: none;
		}
	}
</style>
