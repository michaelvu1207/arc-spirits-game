<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import GameBoard2D from '$lib/components/play2d/GameBoard2D.svelte';
	import AssetLoadingScreen from '$lib/components/play2d/AssetLoadingScreen.svelte';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import GuardianPicker from '$lib/components/play2d/GuardianPicker.svelte';
	import GameChat from '$lib/components/play2d/GameChat.svelte';
	import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
	import { seatAccent } from '$lib/components/play2d/helpers';
	import { requestWakeLock, releaseWakeLock } from '$lib/play/wakeLock';
	import {
		getAssetState,
		preloadAssetImages,
		loadAssetDataSkipImages,
		getGuardianAsset
	} from '$lib/stores/assetStore.svelte';
	import { stopMenu, playMenuSfx, primeMenuSfx } from '$lib/stores/menuAudio.svelte';
	import {
		claimSeat,
		getPlayState,
		hydratePlayRoom,
		loadPlayRoom,
		postPlayJson,
		sendPlayCommand,
		startPlayGame
	} from '$lib/stores/playStore.svelte';
	import type { RoomView } from '$lib/play/server/service';
	import type { SeatColor } from '$lib/play/types';
	import { SEAT_COLORS, NAVIGATION_TIMER_OPTIONS } from '$lib/play/types';

	interface Props {
		data: { initialView?: RoomView | null };
	}
	let { data }: Props = $props();

	const playState = getPlayState();
	const assetState = getAssetState();

	let pendingAction = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let routeError = $state<string | null>(null);

	const room = $derived(playState.room ?? data.initialView?.projection ?? null);
	const member = $derived(playState.member ?? data.initialView?.member ?? null);
	const isLobby = $derived(room?.status === 'lobby');
	// Terminal state: the room was reaped server-side — a lobby that aged out
	// (≥30 min unstarted) or was abandoned, or a live game everyone left. Show a
	// closed card and bounce back to the browser.
	const isClosed = $derived(room?.status === 'closed');
	const isHost = $derived(member?.role === 'host');

	$effect(() => {
		if (!isLobby) stopMenu();
	});

	// Once the room reports `closed`, stop the live connection and return the player
	// to the server browser after a short beat so they can read the message.
	$effect(() => {
		if (!isClosed) return;
		playState.disconnect();
		const timer = setTimeout(() => void goto('/play'), 4000);
		return () => clearTimeout(timer);
	});

	// Keep the screen awake during an active match so the device doesn't sleep
	// mid-turn (and silently drop the player). Released when the game ends/unmounts.
	$effect(() => {
		if (room?.status === 'active') {
			requestWakeLock();
			return () => void releaseWakeLock();
		}
	});

	// Legacy bots carried this display-name prefix. New live bots are identified by
	// the server-projected seat.isBot flag so human-looking bot names still get host controls.
	const BOT_PREFIX = '🤖 ';
	const isLegacyBotName = (name?: string | null) => !!name && name.startsWith(BOT_PREFIX);
	const isBotSeat = (seat: { displayName: string | null; isBot?: boolean }) =>
		seat.isBot === true || isLegacyBotName(seat.displayName);
	const botLabel = (name: string) =>
		name.startsWith(BOT_PREFIX) ? name.replace(BOT_PREFIX, '').trim() : name;

	// ── Party derivations ────────────────────────────────────────────────────
	const mySeat = $derived(
		room && member ? (SEAT_COLORS.find((s) => room.seats[s]?.memberId === member.id) ?? null) : null
	);
	const occupiedSeats = $derived(room ? SEAT_COLORS.filter((s) => room.seats[s]?.memberId) : []);
	const openSeats = $derived(room ? SEAT_COLORS.filter((s) => !room.seats[s]?.memberId) : []);
	const canStart = $derived(occupiedSeats.length > 0);

	function guardianArt(name: string): string | null {
		const g = getGuardianAsset(name);
		// Show the character icon (fall back to chibi/mat only if it's missing).
		return g?.iconUrl ?? g?.chibiUrl ?? g?.matUrl ?? null;
	}
	function takenByOthers(exceptSeat: SeatColor | null): Set<string> {
		const set = new Set<string>();
		if (!room) return set;
		for (const s of SEAT_COLORS) {
			if (s === exceptSeat) continue;
			const g = room.seats[s]?.selectedGuardian;
			if (g) set.add(g);
		}
		return set;
	}

	// ── Character picker ─────────────────────────────────────────────────────
	let pickerSeat = $state<SeatColor | null>(null);
	let pickerIsBot = $state(false);
	$effect(() => {
		if (!browser) return;
		document.body.classList.toggle('guardian-picker-open', pickerSeat !== null);
		return () => document.body.classList.remove('guardian-picker-open');
	});
	function openMyPicker() {
		if (mySeat) {
			pickerSeat = mySeat;
			pickerIsBot = false;
		}
	}
	function openBotPicker(seat: SeatColor) {
		pickerSeat = seat;
		pickerIsBot = true;
	}
	async function handlePick(name: string) {
		const seat = pickerSeat;
		const bot = pickerIsBot;
		pickerSeat = null;
		if (!seat) return;
		if (bot)
			await runAction('botguardian', () => postBots('guardian', { seat, guardianName: name }));
		else
			await runAction('guardian', () =>
				sendPlayCommand({ type: 'selectGuardian', guardianName: name })
			);
	}

	// ── Invite ───────────────────────────────────────────────────────────────
	let inviteOpen = $state(false);
	let copied = $state(false);
	const inviteUrl = $derived(
		room
			? browser
				? `${location.origin}/play/${room.roomCode}`
				: `/play/${room.roomCode}`
			: ''
	);
	async function copyInvite() {
		try {
			await navigator.clipboard.writeText(inviteUrl);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			/* clipboard blocked — the field is selectable as a fallback */
		}
	}

	const IMMERSIVE_SCROLL_ISLAND_SELECTOR = [
		'.trait-host .traits',
		'.players-col',
		'.int-scroll',
		'.legend-body',
		'.tip.touch',
		'.panel',
		'.grid',
		'.body'
	].join(',');

	function installImmersiveInputGuard() {
		let lastTouchY = 0;
		const isImmersive = () => document.documentElement.classList.contains('immersive-play');
		const isEditable = (target: EventTarget | null) => {
			if (!(target instanceof HTMLElement)) return false;
			return !!target.closest('input, textarea, select, [contenteditable="true"]');
		};
		const scrollIslandFor = (target: EventTarget | null): HTMLElement | null => {
			let el = target instanceof Element ? target : null;
			while (el && el !== document.documentElement) {
				if (el instanceof HTMLElement && el.matches(IMMERSIVE_SCROLL_ISLAND_SELECTOR)) {
					if (el.scrollHeight > el.clientHeight + 1) return el;
				}
				el = el.parentElement;
			}
			return null;
		};
		const canScrollY = (el: HTMLElement, fingerDeltaY: number) => {
			if (Math.abs(fingerDeltaY) < 0.5) return true;
			if (fingerDeltaY > 0) return el.scrollTop > 0;
			return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
		};
		const prevent = (event: Event) => {
			if (isImmersive()) event.preventDefault();
		};
		const onTouchStart = (event: TouchEvent) => {
			if (!isImmersive()) return;
			if (event.touches.length > 1) {
				event.preventDefault();
				return;
			}
			lastTouchY = event.touches[0]?.clientY ?? 0;
		};
		const onTouchMove = (event: TouchEvent) => {
			if (!isImmersive()) return;
			if (event.touches.length > 1) {
				event.preventDefault();
				return;
			}
			if (isEditable(event.target)) return;
			const currentY = event.touches[0]?.clientY ?? lastTouchY;
			const deltaY = currentY - lastTouchY;
			lastTouchY = currentY;
			const island = scrollIslandFor(event.target);
			if (island && canScrollY(island, deltaY)) return;
			event.preventDefault();
		};
		const onWheel = (event: WheelEvent) => {
			if (isImmersive() && event.ctrlKey) event.preventDefault();
		};

		document.addEventListener('touchstart', onTouchStart, { passive: false });
		document.addEventListener('touchmove', onTouchMove, { passive: false });
		document.addEventListener('gesturestart', prevent, { passive: false });
		document.addEventListener('gesturechange', prevent, { passive: false });
		document.addEventListener('gestureend', prevent, { passive: false });
		window.addEventListener('wheel', onWheel, { passive: false });

		return () => {
			document.removeEventListener('touchstart', onTouchStart);
			document.removeEventListener('touchmove', onTouchMove);
			document.removeEventListener('gesturestart', prevent);
			document.removeEventListener('gesturechange', prevent);
			document.removeEventListener('gestureend', prevent);
			window.removeEventListener('wheel', onWheel);
		};
	}

	onMount(() => {
		const isE2E = new URLSearchParams(location.search).has('e2e');

		const initialView = data.initialView;
		if (initialView) {
			hydratePlayRoom(initialView);
		} else {
			const roomCode = String(page.params.roomCode ?? '').trim().toUpperCase();
			if (!roomCode) {
				routeError = 'Missing room code.';
			} else {
				void loadPlayRoom(roomCode).catch((err) => {
					routeError = err instanceof Error ? err.message : 'Failed to load room.';
				});
			}
		}

		const preloadAbort = new AbortController();
		// E2E: `?e2e` skips the ~240-image board-art preload (which otherwise saturates
		// the network and gates the board) and renders with placeholder art instead.
		if (isE2E) {
			void loadAssetDataSkipImages();
		} else {
			void preloadAssetImages(preloadAbort.signal);
		}

		let botTimer: ReturnType<typeof setInterval> | null = null;
		let backupBotTimer: ReturnType<typeof setInterval> | null = null;
		let removeImmersiveInputGuard: (() => void) | null = null;
		if (browser) {
			document.documentElement.classList.add('immersive-play');
			document.body.classList.add('immersive-play');
			window.scrollTo(0, 0);
			removeImmersiveInputGuard = installImmersiveInputGuard();
			const tickBots = () => {
				const roomCode = room?.roomCode;
				if (!roomCode) return;
				void postPlayJson(`/api/play/sessions/${encodeURIComponent(roomCode)}/bots/tick`, {}).catch(
					() => {}
				);
			};
			botTimer = setInterval(() => {
				// Drive any bot seats while we host an active game. We DON'T gate on a
				// name check: ranked matchmaking backfills human-named bots (no 🤖), so a
				// name-based `hasBots` misses them and they'd freeze. The server's tickBots
				// is authoritative and a cheap no-op when the session has no bot members.
				if (!isHost || room?.status !== 'active') return;
				tickBots();
			}, 1300);

			// Backup tick: if the host (a human) drops mid-game in a multi-human match, the
			// primary tick above stops and bots would freeze. Non-host seated humans fire a
			// slower redundant tick so the game stays alive. Redundant ticks are safe — the
			// server's tickBots uses CAS + botSeatNeedsToAct, so a bot that already acted is
			// a no-op. We keep this cadence slow to minimize wasted requests. A bit of
			// per-client jitter spreads the load when several non-hosts remain.
			// Note: a SOLO human leaving a vs-bots game is fine — the room is then abandoned
			// by presence rules; this backup only matters when other humans remain.
			const backupPeriod = 4000 + Math.floor(Math.random() * 1000); // 4–5s with jitter
			backupBotTimer = setInterval(() => {
				if (isHost || mySeat === null || room?.status !== 'active') return;
				tickBots();
			}, backupPeriod);
		}

		return () => {
			preloadAbort.abort();
			playState.disconnect();
			if (botTimer) clearInterval(botTimer);
			if (backupBotTimer) clearInterval(backupBotTimer);
			if (browser) {
				removeImmersiveInputGuard?.();
				document.documentElement.classList.remove('immersive-play');
				document.body.classList.remove('immersive-play');
			}
		};
	});

	onDestroy(() => {
		if (!browser) playState.disconnect();
	});

	async function runAction(label: string, work: () => Promise<unknown>): Promise<boolean> {
		pendingAction = label;
		actionError = null;
		try {
			await work();
			return true;
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Action failed.';
			return false;
		} finally {
			pendingAction = null;
		}
	}

	async function postBots(path: string, body?: unknown) {
		if (!room) throw new Error('No room is loaded.');
		await postPlayJson(`/api/play/sessions/${encodeURIComponent(room.roomCode)}/bots/${path}`, {
			...((body && typeof body === 'object' ? body : {}) as Record<string, unknown>)
		});
	}

	async function takeSeat() {
		const seat = openSeats[0];
		if (!seat) return;
		const seated = await runAction('claim', () => claimSeat(seat));
		if (!seated) return;
		// Seated — open the character picker straight away.
		pickerSeat = seat;
		pickerIsBot = false;
	}
	// Live bots use the shared arc-bot-v1 contract. The only public policy key is the
	// trained ML policy; old heuristic difficulty names normalize to this server-side.
	let botDifficulty = $state('neural');
	const BOT_DIFFICULTIES: { value: string; label: string }[] = [
		{ value: 'neural', label: 'ML policy' }
	];
	const addBotAction = () =>
		runAction('add-bot', () => postBots('add', { difficulty: botDifficulty }));
	// Navigation timer (host-only, lobby-only). The <select> works in strings, so "none"
	// is the sentinel for the no-limit (null) preset.
	const navTimerDuration = $derived(room?.navigationDurationMs ?? null);
	const navTimerValue = $derived(
		navTimerDuration == null ? 'none' : String(navTimerDuration)
	);
	const navTimerLabel = $derived(
		NAVIGATION_TIMER_OPTIONS.find((o) => o.ms === navTimerDuration)?.label ?? 'Custom'
	);
	const setNavTimer = (value: string) =>
		runAction('nav-timer', () =>
			sendPlayCommand({
				type: 'setNavigationTimer',
				durationMs: value === 'none' ? null : Number(value)
			})
		);
	const removeBotAction = (seat: SeatColor) =>
		runAction(`remove-${seat}`, () => postBots('remove', { seat }));
	const releaseMySeat = () => runAction('release', () => sendPlayCommand({ type: 'releaseSeat' }));
	const startGame = () => {
		playMenuSfx('game-start', { volume: 0.85 });
		return runAction('start', () => startPlayGame());
	};

	// Lobby UI sounds via a delegated action: every button/link plays a hover +
	// click one-shot (Start Game gets its own launch sound, fired in startGame).
	// Using use: keeps the handlers off the element as inline attributes, so the
	// container <div> stays a clean non-interactive node (no a11y warnings).
	function lobbySfx(node: HTMLElement) {
		let last: Element | null = null;
		const over = (e: Event) => {
			const btn = (e.target as Element)?.closest?.('button, a');
			if (!btn || (btn as HTMLButtonElement).disabled) {
				last = null;
				return;
			}
			if (btn === last) return;
			last = btn;
			playMenuSfx('ui-hover', { volume: 0.4 });
		};
		const click = (e: Event) => {
			const btn = (e.target as Element)?.closest?.('button, a');
			if (!btn || (btn as HTMLButtonElement).disabled) return;
			if (btn.getAttribute('data-testid') === 'start-game') return; // launch sound instead
			playMenuSfx('ui-click');
		};
		node.addEventListener('pointerover', over);
		node.addEventListener('click', click);
		return {
			destroy() {
				node.removeEventListener('pointerover', over);
				node.removeEventListener('click', click);
			}
		};
	}

	async function leaveRoom() {
		// Give up my seat (if I hold one) so it frees up, then exit to the play home.
		if (member?.seatColor) {
			try {
				await sendPlayCommand({ type: 'releaseSeat' });
			} catch {
				/* leave regardless */
			}
		}
		await goto('/play');
	}
</script>

<svelte:head>
	<title>{room?.roomCode ?? 'Room'} | Arc Spirits Play</title>
</svelte:head>

<div class:immersive-route={!!room && !isLobby && !isClosed} class="play-room">
	{#if routeError}
		<MenuShell>
			<div class="closed">
				<span class="kicker"><span class="kn">RM</span><span class="kl"></span> Error</span>
				<h1 class="closed-title brand-flame-text">Room unavailable</h1>
				<p class="closed-sub">{routeError}</p>
				<button type="button" class="closed-btn" onclick={() => goto('/play')}>
					<span class="arrow" aria-hidden="true">←</span> Back to Servers
				</button>
			</div>
		</MenuShell>
	{:else if !room || !member}
		<MenuShell>
			<div class="closed">
				<span class="kicker"><span class="kn">RM</span><span class="kl"></span> Loading</span>
				<h1 class="closed-title brand-flame-text">Opening room</h1>
				<p class="closed-sub">Loading the live room state.</p>
			</div>
		</MenuShell>
	{:else if isClosed}
		<MenuShell>
			<div class="closed">
				<span class="kicker"
					><span class="kn">RM</span><span class="kl"></span> {room.roomCode}</span
				>
				<h1 class="closed-title brand-flame-text">Room closed</h1>
				<p class="closed-sub">
					This room was closed because everyone left, or it stayed open too long without a game
					finishing.
				</p>
				<button type="button" class="closed-btn" onclick={() => goto('/play')}>
					<span class="arrow" aria-hidden="true">←</span> Back to Servers
				</button>
				<span class="closed-hint">Returning you to the server browser…</span>
			</div>
		</MenuShell>
	{:else if isLobby}
		<MenuShell>
			<div class="lobby" use:lobbySfx>
				<button
					type="button"
					class="leave-btn"
					data-testid="leave-room"
					title="Leave this room"
					onclick={leaveRoom}
				>
					<span class="arrow" aria-hidden="true">←</span> Leave
				</button>
				<header class="lhead reveal" style="--d: 0.04s">
					<div>
						<span class="kicker">
							<span class="kn">RM</span><span class="kl"></span> Live Room · {occupiedSeats.length}/{SEAT_COLORS.length}
						</span>
						<h1 class="code brand-flame-text">{room.roomCode}</h1>
					</div>
					<span class="pill" class:off={!playState.isConnected}>
						{playState.isConnected
							? '● Live'
							: playState.isReconnecting
								? '○ Reconnecting'
								: '○ Offline'}
					</span>
				</header>

				{#if actionError}
					<div class="error reveal" role="alert">{actionError}</div>
				{/if}

				<ul class="party reveal" style="--d: 0.12s">
					{#each occupiedSeats as seat (seat)}
						{@const s = room.seats[seat]}
						{@const bot = isBotSeat(s)}
						{@const mine = s.memberId === member.id}
						{@const art = s.selectedGuardian ? guardianArt(s.selectedGuardian) : null}
						<li class="row" class:mine style="--seat: {seatAccent(seat)}">
							<span class="seatdot"></span>
							<div class="ava" class:empty={!art}>
								{#if art}
									<img src={art} alt={s.selectedGuardian} loading="lazy" />
								{:else}
									<span>{(s.selectedGuardian ?? s.displayName ?? '?').slice(0, 1)}</span>
								{/if}
							</div>
							<div class="info">
								<span class="nm">
									{bot ? botLabel(s.displayName ?? '') : (s.displayName ?? 'Player')}
									{#if mine}<b class="tag you">You</b>{/if}
									{#if bot}<b class="tag bot">Bot</b>{/if}
								</span>
								<span class="ch" class:none={!s.selectedGuardian}>
									{s.selectedGuardian ?? 'No character'}
								</span>
							</div>
							<div class="rowacts">
								{#if mine}
									<button class="mini" onclick={openMyPicker} disabled={pendingAction !== null}>
										{s.selectedGuardian ? 'Change' : 'Choose'}
									</button>
									<button
										class="mini ghosted"
										onclick={releaseMySeat}
										disabled={pendingAction !== null}
									>
										Leave
									</button>
								{:else if isHost && bot}
									<button
										class="mini"
										onclick={() => openBotPicker(seat)}
										disabled={pendingAction !== null}
									>
										{s.selectedGuardian ? 'Change' : 'Choose'}
									</button>
									<button
										class="mini danger"
										data-testid="remove-bot-{seat}"
										onclick={() => removeBotAction(seat)}
										disabled={pendingAction !== null}
									>
										Remove
									</button>
								{/if}
							</div>
						</li>
					{/each}

					{#each openSeats as seat (seat)}
						<li class="row open" style="--seat: {seatAccent(seat)}">
							<span class="seatdot"></span>
							<div class="ava empty">＋</div>
							<div class="info">
								<span class="nm none">Open seat</span>
								<span class="ch none">{seat}</span>
							</div>
						</li>
					{/each}
				</ul>

				<div class="bar reveal" style="--d: 0.2s">
					{#if isHost}
						<label class="setting" data-testid="nav-timer-field">
							<span class="setting-label">Nav timer</span>
							<select
								class="botdiff"
								data-testid="nav-timer"
								value={navTimerValue}
								onchange={(e) => setNavTimer((e.currentTarget as HTMLSelectElement).value)}
								disabled={pendingAction !== null}
								aria-label="Navigation timer per round"
							>
								{#each NAVIGATION_TIMER_OPTIONS as opt (opt.label)}
									<option value={opt.ms == null ? 'none' : String(opt.ms)}>{opt.label}</option>
								{/each}
							</select>
						</label>
					{:else}
						<span class="setting-chip" data-testid="nav-timer-readonly"
							>Nav timer · {navTimerLabel}</span
						>
					{/if}
					{#if !mySeat && openSeats.length}
						<button
							class="primary"
							data-testid="take-seat"
							onclick={takeSeat}
							disabled={pendingAction !== null}
						>
							{pendingAction === 'claim' ? 'Seating…' : 'Take a seat'}
						</button>
					{/if}
					{#if isHost}
						<select
							class="botdiff"
							data-testid="bot-difficulty"
							bind:value={botDifficulty}
							disabled={pendingAction !== null || openSeats.length === 0}
							aria-label="Bot difficulty"
						>
							{#each BOT_DIFFICULTIES as opt (opt.value)}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
						<button
							class="ghost"
							data-testid="add-bot"
							onclick={addBotAction}
							disabled={pendingAction !== null || openSeats.length === 0}
						>
							{pendingAction === 'add-bot' ? 'Summoning…' : '+ Add bot'}
						</button>
					{/if}
					<button class="ghost" onclick={() => (inviteOpen = !inviteOpen)}>
						{inviteOpen ? 'Hide invite' : 'Invite player'}
					</button>
					{#if isHost}
						<button
							class="start"
							data-testid="start-game"
							onclick={startGame}
							disabled={pendingAction !== null || !canStart}
						>
							<span>{pendingAction === 'start' ? 'Opening gate…' : 'Start Game'}</span>
							<svg viewBox="0 0 24 24" aria-hidden="true"
								><path
									d="M5 12h14M13 6l6 6-6 6"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/></svg
							>
						</button>
					{/if}
				</div>

				{#if inviteOpen}
					<div class="invite reveal">
						<span class="ieyebrow">Share this link</span>
						<div class="irow">
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<input
								readonly
								value={inviteUrl}
								onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
							/>
							<button class="ghost" onclick={copyInvite}>{copied ? 'Copied ✓' : 'Copy'}</button>
						</div>
					</div>
				{/if}

				<div class="reveal" style="--d: 0.26s">
					<GameChat variant="panel" />
				</div>
			</div>

			<GuardianPicker
				open={pickerSeat !== null}
				title={pickerIsBot ? `Set ${pickerSeat} bot's Guardian` : 'Choose your Guardian'}
				subtitle={pickerIsBot
					? 'As host, you pick the bot’s champion.'
					: 'Bind a champion to your seat.'}
				guardians={room.guardianPool ?? []}
				taken={takenByOthers(pickerSeat)}
				current={pickerSeat ? (room.seats[pickerSeat]?.selectedGuardian ?? null) : null}
				accent={pickerSeat ? seatAccent(pickerSeat) : '#ff2bc7'}
				onPick={handlePick}
				onClose={() => (pickerSeat = null)}
			/>
		</MenuShell>
	{:else}
		<div class="game-viewport">
			{#if !assetState.isLoaded}
				<AssetLoadingScreen progress={assetState.imageProgress} dataReady={assetState.isLoaded} />
			{:else}
				<GameBoard2D {room} {member} assets={assetState} />
			{/if}
		</div>
	{/if}

	<ConnectionStatus
		isConnected={playState.isConnected}
		isReconnecting={playState.isReconnecting}
		onReconnect={() => playState.connect()}
	/>
</div>

<style>
	:global(html.immersive-play),
	:global(body.immersive-play) {
		height: 100%;
		overflow: hidden;
		overscroll-behavior: none;
	}
	:global(body.immersive-play) {
		position: fixed;
		inset: 0;
		width: 100%;
		max-width: 100%;
		height: 100vh;
		height: 100dvh;
		margin: 0;
		touch-action: none;
	}
	:global(body.immersive-play .topbar) {
		display: none !important;
	}
	:global(body.immersive-play .app),
	:global(body.immersive-play .app > .flex-1) {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100vh; /* fallback */
		height: 100dvh;
		min-height: 0;
		overflow: hidden;
		overscroll-behavior: none;
		touch-action: none;
	}

	.play-room {
		max-width: 1320px;
		margin: 0 auto;
		padding: 32px 24px 80px;
	}
	.play-room.immersive-route {
		position: fixed;
		inset: 0;
		max-width: none;
		width: 100vw;
		height: 100vh; /* fallback */
		height: 100dvh;
		margin: 0;
		padding: 0;
		overflow: hidden;
		overscroll-behavior: none;
		touch-action: none;
	}
	.game-viewport {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		overscroll-behavior: none;
		touch-action: none;
		background: var(--color-void);
	}

	/* ── Lobby (minimal list over the abyss) ──────────────────── */
	.lobby {
		position: relative;
		width: 100%;
		min-height: 100%;
		max-width: 680px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 104px 24px 64px;
	}

	/* Top-left "leave room" — sits in the lobby's top padding band. */
	.leave-btn {
		position: absolute;
		top: 30px;
		left: 24px;
		z-index: 3;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-parchment, #e7e0cf);
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-radius: 999px;
		cursor: pointer;
		-webkit-backdrop-filter: blur(8px);
		backdrop-filter: blur(8px);
		transition:
			background 140ms ease,
			border-color 140ms ease,
			transform 140ms ease,
			color 140ms ease;
	}
	.leave-btn:hover {
		background: rgba(255, 255, 255, 0.1);
		border-color: var(--brand-magenta, #ff2bc7);
		color: #fff;
		transform: translateX(-2px);
	}
	.leave-btn .arrow {
		font-size: 0.95rem;
		line-height: 1;
	}

	.lhead {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
	}
	.kicker {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-display);
		font-size: 0.64rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: var(--color-fog, #9a8fb8);
	}
	.kicker .kn {
		font-family: var(--font-mono);
		color: var(--brand-cyan, #24d4ff);
	}
	.kicker .kl {
		width: 20px;
		height: 1px;
		background: currentColor;
		opacity: 0.5;
	}
	.code {
		margin: 6px 0 0;
		font-family: var(--font-display);
		font-size: clamp(2.4rem, 5vw, 3.8rem);
		line-height: 0.9;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-variant-numeric: tabular-nums;
		filter: drop-shadow(0 6px 22px rgba(123, 29, 255, 0.45));
	}
	.pill {
		flex: 0 0 auto;
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid var(--brand-teal, #20e0c1);
		color: var(--brand-teal, #20e0c1);
		font-family: var(--font-display);
		font-size: 0.64rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		background: rgba(5, 3, 16, 0.4);
		backdrop-filter: blur(6px);
	}
	.pill.off {
		border-color: var(--color-blood, #ff4d6d);
		color: var(--color-blood, #ff4d6d);
	}

	.error {
		padding: 11px 16px;
		border-left: 3px solid var(--color-blood, #ff4d6d);
		background: rgba(196, 26, 61, 0.3);
		color: var(--color-bone, #f5f0ff);
		border-radius: 2px;
		backdrop-filter: blur(6px);
	}

	/* ── Party list ───────────────────────────────────────────── */
	.party {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		border-radius: 14px;
		overflow: hidden;
		border: 1px solid rgba(123, 29, 255, 0.22);
		background: linear-gradient(180deg, rgba(20, 12, 38, 0.55), rgba(8, 5, 18, 0.66));
		backdrop-filter: blur(14px);
	}
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 16px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		transition: background 160ms ease;
	}
	.row:last-child {
		border-bottom: none;
	}
	.row:hover {
		background: rgba(255, 255, 255, 0.03);
	}
	.row.mine {
		background: color-mix(in srgb, var(--seat) 9%, transparent);
	}
	.row.open {
		opacity: 0.5;
	}
	.seatdot {
		flex: 0 0 auto;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--seat);
		box-shadow: 0 0 10px var(--seat);
	}
	.ava {
		flex: 0 0 auto;
		width: 46px;
		height: 46px;
		border-radius: 12px;
		overflow: hidden;
		display: grid;
		place-items: center;
		background: rgba(0, 0, 0, 0.4);
		box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--seat) 60%, transparent);
	}
	.ava img {
		width: 100%;
		height: 100%;
		/* Character icon — show it whole (vs. cropping the wide player mat). */
		object-fit: contain;
		padding: 10%;
	}
	.ava.empty {
		color: var(--seat);
		font-family: var(--font-display);
		font-size: 1.3rem;
	}
	.info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.nm {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-display);
		font-size: 1.02rem;
		letter-spacing: 0.04em;
		color: var(--color-bone, #f5f0ff);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tag {
		font-size: 0.56rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		padding: 2px 7px;
		border-radius: 999px;
	}
	.tag.you {
		color: var(--brand-cyan, #24d4ff);
		border: 1px solid rgba(36, 212, 255, 0.4);
	}
	.tag.bot {
		color: var(--brand-amber, #ffba3d);
		border: 1px solid rgba(255, 186, 61, 0.4);
	}
	.ch {
		font-size: 0.8rem;
		color: var(--color-parchment, #d8cfee);
	}
	.ch.none,
	.nm.none {
		color: var(--color-whisper, #6a5d8a);
	}

	.rowacts {
		display: flex;
		gap: 6px;
		flex: 0 0 auto;
	}
	.mini {
		padding: 7px 13px;
		border-radius: 8px;
		border: 1px solid var(--color-aether, #3a2670);
		background: transparent;
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.64rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 150ms ease,
			color 150ms ease,
			background 150ms ease;
	}
	.mini:hover:not(:disabled) {
		border-color: var(--brand-magenta, #ff2bc7);
		color: var(--brand-magenta-soft, #ff5dd1);
		background: rgba(255, 43, 199, 0.07);
	}
	.mini.ghosted {
		opacity: 0.7;
	}
	.mini.danger:hover:not(:disabled) {
		border-color: var(--color-blood, #ff4d6d);
		color: var(--color-blood, #ff4d6d);
		background: rgba(255, 77, 109, 0.08);
	}
	.mini:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* ── Action bar ───────────────────────────────────────────── */
	.bar {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 4px;
	}
	/* Lobby game-setting control (host select) + read-only chip (everyone else). */
	.setting {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.setting-label {
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-fog, #9a93b0);
	}
	.setting-chip {
		padding: 9px 14px;
		border-radius: 9px;
		border: 1px solid color-mix(in srgb, var(--brand-violet, #7b1dff) 45%, transparent);
		background: rgba(123, 29, 255, 0.06);
		color: var(--color-parchment, #d8d2e8);
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.ghost {
		padding: 11px 18px;
		border-radius: 9px;
		border: 1px solid var(--brand-violet, #7b1dff);
		background: transparent;
		color: var(--brand-violet-soft, #9d4dff);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: all 150ms ease;
	}
	.ghost:hover:not(:disabled) {
		color: var(--brand-magenta-soft, #ff5dd1);
		border-color: var(--brand-magenta, #ff2bc7);
		background: rgba(255, 43, 199, 0.07);
	}
	.ghost:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.botdiff {
		padding: 11px 14px;
		border-radius: 9px;
		border: 1px solid var(--brand-violet, #7b1dff);
		background: transparent;
		color: var(--brand-violet-soft, #9d4dff);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: all 150ms ease;
	}
	.botdiff:hover:not(:disabled) {
		color: var(--brand-magenta-soft, #ff5dd1);
		border-color: var(--brand-magenta, #ff2bc7);
		background: rgba(255, 43, 199, 0.07);
	}
	.botdiff:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.botdiff option {
		background: #1a0b2e;
		color: var(--brand-violet-soft, #9d4dff);
	}
	.primary {
		padding: 11px 20px;
		border-radius: 9px;
		border: 1px solid var(--brand-cyan, #24d4ff);
		background: rgba(36, 212, 255, 0.1);
		color: var(--brand-cyan-soft, #6be3ff);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: all 150ms ease;
	}
	.primary:hover:not(:disabled) {
		background: rgba(36, 212, 255, 0.18);
	}
	.start {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 12px 24px;
		border: none;
		border-radius: 10px;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff, #5a2bff));
		background-size: 180% 180%;
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.92rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		cursor: pointer;
		box-shadow: 0 12px 32px -14px rgba(255, 43, 199, 0.7);
		transition:
			transform 160ms ease,
			background-position 500ms ease,
			box-shadow 160ms ease;
	}
	.start svg {
		width: 19px;
		height: 19px;
		transition: transform 160ms ease;
	}
	.start:hover:not(:disabled) {
		transform: translateY(-2px);
		background-position: 100% 0;
	}
	.start:hover:not(:disabled) svg {
		transform: translateX(4px);
	}
	.start:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ── Invite reveal ────────────────────────────────────────── */
	.invite {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px 16px;
		border-radius: 12px;
		border: 1px solid var(--color-mist, #2e1d52);
		background: rgba(8, 5, 18, 0.7);
		backdrop-filter: blur(10px);
	}
	.ieyebrow {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.24em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.irow {
		display: flex;
		gap: 10px;
	}
	.irow input {
		flex: 1;
		min-width: 0;
		padding: 10px 12px;
		border-radius: 8px;
		border: 1px solid var(--color-aether, #3a2670);
		background: rgba(5, 3, 16, 0.7);
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-mono);
		font-size: 0.84rem;
	}
	.irow input:focus {
		outline: none;
		border-color: var(--brand-magenta, #ff2bc7);
	}

	/* ── Reveal ───────────────────────────────────────────────── */
	.reveal {
		opacity: 0;
		transform: translateY(14px);
		animation: reveal-up 560ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
		animation-delay: var(--d, 0s);
	}
	@keyframes reveal-up {
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* ── Closed room ──────────────────────────────────────────── */
	.closed {
		position: relative;
		width: 100%;
		min-height: 100%;
		max-width: 560px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 14px;
		padding: 120px 24px 64px;
	}
	.closed-title {
		margin: 4px 0 0;
		font-family: var(--font-display);
		font-size: clamp(2rem, 5vw, 3rem);
		line-height: 0.95;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		filter: drop-shadow(0 6px 22px rgba(123, 29, 255, 0.45));
	}
	.closed-sub {
		margin: 0;
		max-width: 42ch;
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-body);
		font-size: 0.95rem;
		line-height: 1.5;
	}
	.closed-btn {
		margin-top: 10px;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 12px 22px;
		border-radius: 10px;
		border: 1px solid var(--brand-magenta, #ff2bc7);
		background: rgba(255, 43, 199, 0.08);
		color: var(--color-bone, #f5f0ff);
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			background 150ms ease,
			transform 150ms ease;
	}
	.closed-btn:hover {
		background: rgba(255, 43, 199, 0.16);
		transform: translateY(-1px);
	}
	.closed-btn .arrow {
		font-size: 0.95rem;
		line-height: 1;
	}
	.closed-hint {
		margin-top: 4px;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		color: var(--color-fog, #9a8fb8);
	}

	@media (max-width: 540px) {
		.lobby {
			padding: 92px 16px 48px;
		}
		.start {
			margin-left: 0;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) {
		.play-room {
			max-width: none;
			padding: 0;
		}
		.lobby {
			box-sizing: border-box;
			height: 100%;
			max-width: none;
			display: grid;
			grid-template-columns: minmax(210px, 0.68fr) minmax(360px, 1fr);
			grid-template-rows: auto 1fr auto;
			align-items: stretch;
			gap: 12px 18px;
			padding:
				calc(72px + env(safe-area-inset-top))
				max(86px, calc(28px + env(safe-area-inset-right)))
				calc(24px + env(safe-area-inset-bottom))
				max(54px, calc(28px + env(safe-area-inset-left)));
		}
		.leave-btn {
			top: calc(24px + env(safe-area-inset-top));
			left: max(54px, calc(28px + env(safe-area-inset-left)));
			min-height: 36px;
			padding: 7px 13px;
			font-size: 0.66rem;
		}
		.lhead {
			grid-column: 1;
			grid-row: 1;
			min-width: 0;
			display: block;
		}
		.kicker {
			gap: 8px;
			font-size: 0.56rem;
			letter-spacing: 0.22em;
		}
		.kicker .kl {
			width: 14px;
		}
		.code {
			margin-top: 5px;
			font-size: clamp(2rem, 14vh, 3rem);
			letter-spacing: 0.07em;
		}
		.pill {
			position: absolute;
			top: calc(72px + env(safe-area-inset-top));
			right: max(86px, calc(28px + env(safe-area-inset-right)));
			padding: 5px 10px;
			font-size: 0.58rem;
		}
		.error {
			grid-column: 1 / -1;
			padding: 9px 12px;
			font-size: 0.78rem;
		}
		.party {
			grid-column: 2;
			grid-row: 1 / span 2;
			align-self: stretch;
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			align-content: start;
			border-radius: 12px;
			overflow: auto;
			min-height: 0;
		}
		.row {
			min-width: 0;
			gap: 9px;
			padding: 9px 10px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		}
		.row:nth-child(odd) {
			border-right: 1px solid rgba(255, 255, 255, 0.05);
		}
		.row:last-child {
			border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		}
		.seatdot {
			width: 7px;
			height: 7px;
		}
		.ava {
			width: 34px;
			height: 34px;
			border-radius: 9px;
		}
		.nm {
			font-size: 0.82rem;
			gap: 6px;
		}
		.ch {
			font-size: 0.68rem;
		}
		.rowacts {
			gap: 5px;
		}
		.mini {
			min-height: 34px;
			padding: 6px 9px;
			font-size: 0.56rem;
			letter-spacing: 0.09em;
			border-radius: 7px;
		}
		.bar {
			grid-column: 1 / -1;
			grid-row: 3;
			display: grid;
			grid-template-columns: repeat(4, minmax(100px, 1fr)) minmax(138px, 0.9fr);
			align-items: stretch;
			gap: 9px;
			margin-top: 0;
		}
		.setting {
			min-width: 0;
			display: grid;
			grid-template-columns: auto minmax(74px, 1fr);
			align-items: center;
			gap: 7px;
		}
		.setting-label {
			font-size: 0.56rem;
			letter-spacing: 0.1em;
		}
		.setting-chip,
		.ghost,
		.botdiff,
		.primary,
		.start {
			min-height: 44px;
			box-sizing: border-box;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 9px 12px;
			font-size: 0.64rem;
			letter-spacing: 0.1em;
			border-radius: 8px;
			white-space: nowrap;
		}
		.start {
			margin-left: 0;
			gap: 8px;
			padding-inline: 14px;
		}
		.start svg {
			width: 16px;
			height: 16px;
		}
		.invite {
			grid-column: 1 / -1;
			grid-row: 2;
			align-self: end;
			padding: 10px 12px;
			border-radius: 10px;
		}
		.ieyebrow {
			font-size: 0.54rem;
		}
		.irow input {
			min-height: 40px;
			padding: 8px 10px;
			font-size: 0.72rem;
		}
		.closed {
			max-width: none;
			min-height: 100%;
			padding:
				calc(62px + env(safe-area-inset-top))
				max(78px, calc(24px + env(safe-area-inset-right)))
				calc(28px + env(safe-area-inset-bottom))
				max(48px, calc(24px + env(safe-area-inset-left)));
		}
		.closed-title {
			font-size: clamp(1.8rem, 12vh, 2.7rem);
		}
		.closed-sub {
			font-size: 0.86rem;
			line-height: 1.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.reveal {
			animation: none;
			opacity: 1;
			transform: none;
		}
	}
</style>
