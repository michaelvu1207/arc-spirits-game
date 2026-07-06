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
	import RotateGate from '$lib/components/play2d/RotateGate.svelte';
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
		setRoomChatOpen,
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

	// Server-computed start gate (§5.5 in plans/ux-overhaul.md, fixes S4): present only
	// for the HOST viewer of a lobby-status room, engine-computed from the same rule the
	// startGame reducer enforces. Falls back to the legacy any-seat-occupied rule when
	// absent (older server snapshots) so nothing regresses.
	const serverCanStart = $derived(room?.canStart ?? null);
	const canStart = $derived(serverCanStart ? serverCanStart.ok : occupiedSeats.length > 0);
	const startBlockedReason = $derived(
		!canStart ? (serverCanStart?.reason ?? 'Waiting for players to sit…') : null
	);

	function guardianArt(name: string): string | null {
		const g = getGuardianAsset(name);
		// Show the character icon (fall back to chibi/mat only if it's missing).
		return g?.iconUrl ?? g?.chibiUrl ?? g?.matUrl ?? null;
	}
	/** Guardians claimed by OTHER seats → the claiming seat, for the picker's chips. */
	function takenByOthers(exceptSeat: SeatColor | null): Map<string, SeatColor> {
		const map = new Map<string, SeatColor>();
		if (!room) return map;
		for (const s of SEAT_COLORS) {
			if (s === exceptSeat) continue;
			const g = room.seats[s]?.selectedGuardian;
			if (g) map.set(g, s);
		}
		return map;
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
	const canShare = $derived(browser && typeof navigator.share === 'function');
	async function copyInvite() {
		try {
			await navigator.clipboard.writeText(inviteUrl);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			/* clipboard blocked — the field is selectable as a fallback */
		}
	}
	async function shareInvite() {
		try {
			await navigator.share({ title: 'Arc Spirits', text: 'Join my room!', url: inviteUrl });
		} catch {
			/* user dismissed the share sheet */
		}
	}

	// ── Chat drawer ──────────────────────────────────────────────────────────
	let chatOpen = $state(false);
	function setChat(open: boolean) {
		chatOpen = open;
		// Pause unread counting while the drawer is up.
		setRoomChatOpen(open);
	}
	// The shell's top-right controls yield while a lobby overlay is up (they'd
	// otherwise paint over the overlay's own close button).
	$effect(() => {
		if (!browser) return;
		document.body.classList.toggle('pregame-overlay-open', chatOpen || inviteOpen);
		return () => document.body.classList.remove('pregame-overlay-open');
	});

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
		const params = new URLSearchParams(location.search);
		const isE2E = params.has('e2e');
		// The create sheet's "open invite panel" toggle rides in on ?invite=1.
		if (params.has('invite')) inviteOpen = true;

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

	/** Claim a specific seat slot (tapping an open frame), then pick a guardian. */
	async function takeSeat(seat?: SeatColor) {
		const target = seat ?? openSeats[0];
		if (!target) return;
		const seated = await runAction('claim', () => claimSeat(target));
		if (!seated) return;
		// Seated — open the character picker straight away.
		pickerSeat = target;
		pickerIsBot = false;
	}
	// Live bots use the shared arc-bot-v1 contract. The only public policy key is the
	// trained ML policy (badged "ML Bot" on the seat frame); old heuristic difficulty
	// names normalize to this server-side.
	const addBotAction = () => runAction('add-bot', () => postBots('add', { difficulty: 'neural' }));
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
			<div class="lobby" data-testid="lobby" use:lobbySfx>
				<header class="ltop reveal" style="--d: 0.04s">
					<button
						type="button"
						class="leave-btn"
						data-testid="leave-room"
						title="Leave this room"
						onclick={leaveRoom}
					>
						<span class="arrow" aria-hidden="true">←</span> Leave
					</button>

					<div class="lcode">
						<span class="kicker">
							<span class="kn">RM</span><span class="kl"></span>
							Party · {occupiedSeats.length}/{SEAT_COLORS.length}
							<span class="pill" class:off={!playState.isConnected}>
								{playState.isConnected
									? '● Live'
									: playState.isReconnecting
										? '○ Reconnecting'
										: '○ Offline'}
							</span>
						</span>
						<div class="code-row">
							<h1 class="code brand-flame-text">{room.roomCode}</h1>
							<button
								type="button"
								class="chip copy-chip"
								class:done={copied}
								onclick={copyInvite}
								title="Copy the invite link"
							>
								{copied ? '✓ Copied' : 'Copy link'}
							</button>
							{#if canShare}
								<button
									type="button"
									class="chip"
									onclick={shareInvite}
									title="Share the invite link">Share</button
								>
							{/if}
						</div>
					</div>
				</header>

				{#if actionError}
					<div class="error reveal" role="alert">{actionError}</div>
				{/if}

				<!-- The party is the hero: one large portrait frame per seat, always on
				     screen (the grid sizes to the viewport — no below-the-fold seats). -->
				<ul class="seats reveal" style="--d: 0.1s">
					{#each SEAT_COLORS as seat (seat)}
						{@const s = room.seats[seat]}
						{@const filled = !!s?.memberId}
						{@const bot = filled && isBotSeat(s)}
						{@const mine = filled && s.memberId === member.id}
						{@const gname = filled ? s.selectedGuardian : null}
						{@const art = gname ? guardianArt(gname) : null}
						{@const actable = mine || (isHost && bot)}
						<li class="seat" class:mine style="--seat: {seatAccent(seat)}">
							{#if filled}
								<div class="frame filled" class:actable>
									<button
										type="button"
										class="frame-hit"
										disabled={!actable || pendingAction !== null}
										onclick={() => (mine ? openMyPicker() : openBotPicker(seat))}
										aria-label={actable
											? `${gname ? 'Change' : 'Choose'} ${mine ? 'your' : `the ${seat} bot's`} guardian`
											: `${s.displayName ?? 'Player'} — ${gname ?? 'no guardian yet'}`}
									>
										{#if art}
											<img class="art" src={art} alt={gname} loading="lazy" />
										{:else}
											<span class="sigil" aria-hidden="true">
												<span class="sigil-gem"></span>
												<span class="sigil-ch">{(s.displayName ?? '?').slice(0, 1)}</span>
											</span>
										{/if}
										<span class="shade" aria-hidden="true"></span>
										<span class="badges">
											{#if mine}<b class="badge you">You</b>{/if}
											{#if bot}<b class="badge bot">ML Bot</b>{/if}
										</span>
										<span class="plate">
											<span class="pname"
												>{bot ? botLabel(s.displayName ?? '') : (s.displayName ?? 'Player')}</span
											>
											<span class="pguardian" class:none={!gname}>{gname ?? 'No guardian yet'}</span>
											{#if actable}
												<span class="change-hint">{gname ? 'Change' : 'Choose guardian'}</span>
											{/if}
										</span>
									</button>
									{#if mine}
										<button
											type="button"
											class="seat-x"
											title="Leave your seat"
											aria-label="Leave your seat"
											onclick={releaseMySeat}
											disabled={pendingAction !== null}>✕</button
										>
									{:else if isHost && bot}
										<button
											type="button"
											class="seat-x danger"
											data-testid="remove-bot-{seat}"
											title="Remove bot"
											aria-label="Remove the {seat} bot"
											onclick={() => removeBotAction(seat)}
											disabled={pendingAction !== null}>✕</button
										>
									{/if}
								</div>
							{:else}
								<button
									type="button"
									class="frame vacant"
									data-testid={!mySeat && seat === openSeats[0] ? 'take-seat' : undefined}
									onclick={() => (!mySeat ? takeSeat(seat) : (inviteOpen = true))}
									disabled={pendingAction !== null}
									aria-label={!mySeat ? `Sit at the ${seat} seat` : 'Invite a player'}
								>
									<span class="vac-plus" aria-hidden="true">＋</span>
									<span class="vac-label">
										{!mySeat
											? pendingAction === 'claim'
												? 'Seating…'
												: 'Tap to sit'
											: 'Invite'}
									</span>
									<span class="vac-seat">{seat}</span>
								</button>
							{/if}
						</li>
					{/each}
				</ul>

				<div class="lbar reveal" style="--d: 0.16s">
					<button
						type="button"
						class="chat-tab"
						data-testid="lobby-chat-tab"
						onclick={() => setChat(true)}
						aria-label="Open room chat"
					>
						<svg viewBox="0 0 24 24" aria-hidden="true"
							><path
								d="M4 6a3 3 0 013-3h10a3 3 0 013 3v7a3 3 0 01-3 3H9l-4.2 3.6c-.5.4-.8.2-.8-.4V6z"
								fill="none"
								stroke="currentColor"
								stroke-width="1.7"
								stroke-linejoin="round"
							/></svg
						>
						<span>Chat</span>
						{#if playState.chatUnread > 0}
							<span class="chat-badge" data-testid="chat-unread"
								>{Math.min(playState.chatUnread, 9)}</span
							>
						{/if}
					</button>

					<div class="settings">
						{#if isHost}
							<label class="setting" data-testid="nav-timer-field">
								<span class="setting-label">Nav timer</span>
								<select
									class="ctl"
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
							<button
								class="ctl btn"
								data-testid="add-bot"
								onclick={addBotAction}
								disabled={pendingAction !== null || openSeats.length === 0}
							>
								{pendingAction === 'add-bot' ? 'Summoning…' : '+ Add bot'}
							</button>
						{:else}
							<span class="setting-chip" data-testid="nav-timer-readonly"
								>Nav timer · {navTimerLabel}</span
							>
						{/if}
					</div>

					{#if isHost}
						<div class="start-wrap">
							{#if startBlockedReason}
								<span class="start-reason" data-testid="start-blocked-reason"
									>{startBlockedReason}</span
								>
							{/if}
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
						</div>
					{:else}
						<span class="wait-chip">Waiting for the host…</span>
					{/if}
				</div>
			</div>

			{#if inviteOpen}
				<div class="invite-layer">
					<button
						type="button"
						class="invite-backdrop"
						aria-label="Close invite"
						onclick={() => (inviteOpen = false)}
					></button>
					<div class="invite-sheet reveal" role="dialog" aria-label="Invite players">
						<span class="ieyebrow">Invite players</span>
						<p class="ihint">Anyone with this link lands straight in this room.</p>
						<div class="irow">
							<input
								readonly
								value={inviteUrl}
								onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
							/>
							<button class="chip" onclick={copyInvite}>{copied ? '✓ Copied' : 'Copy'}</button>
							{#if canShare}
								<button class="chip" onclick={shareInvite}>Share</button>
							{/if}
						</div>
						<button class="chip idone" onclick={() => (inviteOpen = false)}>Done</button>
					</div>
				</div>
			{/if}

			<GameChat variant="drawer" open={chatOpen} onClose={() => setChat(false)} />

			<GuardianPicker
				open={pickerSeat !== null}
				title={pickerIsBot ? `Set ${pickerSeat} bot's Guardian` : 'Choose your Guardian'}
				subtitle={pickerIsBot
					? 'As host, you pick the bot’s champion.'
					: 'Bind a champion to your seat.'}
				guardians={room.guardianPool ?? []}
				takenBy={takenByOthers(pickerSeat)}
				current={pickerSeat ? (room.seats[pickerSeat]?.selectedGuardian ?? null) : null}
				accent={pickerSeat ? seatAccent(pickerSeat) : '#ff2bc7'}
				onPick={handlePick}
				onClose={() => (pickerSeat = null)}
			/>
		</MenuShell>
	{:else}
		<div class="game-viewport">
			{#if !assetState.imagesReady}
				<AssetLoadingScreen progress={assetState.imageProgress} dataReady={assetState.isLoaded} />
			{:else}
				<GameBoard2D {room} {member} assets={assetState} />
			{/if}
		</div>
		<!-- The board is landscape-only; pre-game screens are portrait-capable. -->
		<RotateGate />
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

	/* ── Lobby = party screen. The seat frames are the hero; the layout is a
	   fixed-height grid (header / seats / action bar) so every seat is ALWAYS
	   in the viewport — at 1280×720 included. ─────────────────── */
	.lobby {
		position: relative;
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		max-width: 1320px;
		margin: 0 auto;
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr) auto;
		gap: clamp(10px, 2vh, 22px);
		padding:
			calc(18px + env(safe-area-inset-top))
			clamp(18px, 4vw, 44px)
			calc(16px + env(safe-area-inset-bottom));
	}
	/* Row 2 (the error strip) collapses when empty. */
	.lobby > .error {
		grid-row: 2;
	}
	.ltop {
		grid-row: 1;
	}
	.seats {
		grid-row: 3;
	}
	.lbar {
		grid-row: 4;
	}

	/* ── Header: leave · room code + copy · live pill ─────────── */
	.ltop {
		display: flex;
		align-items: flex-start;
		gap: 16px;
		/* Clear MenuShell's top-right sound/settings cluster. */
		padding-right: 132px;
	}
	.leave-btn {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
		padding: 10px 16px;
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
			color 140ms ease;
	}
	.leave-btn:hover {
		background: rgba(255, 255, 255, 0.1);
		border-color: var(--brand-magenta, #ff2bc7);
		color: #fff;
	}
	.leave-btn .arrow {
		font-size: 0.95rem;
		line-height: 1;
	}
	.lcode {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.kicker {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
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
	.code-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 14px;
	}
	.code {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(2.2rem, 6vh, 3.4rem);
		line-height: 1;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-variant-numeric: tabular-nums;
		filter: drop-shadow(0 6px 22px rgba(123, 29, 255, 0.45));
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 7px 14px;
		border-radius: 999px;
		border: 1px solid var(--color-aether, #3a2670);
		background: rgba(10, 7, 24, 0.55);
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		-webkit-backdrop-filter: blur(8px);
		backdrop-filter: blur(8px);
		transition:
			border-color 150ms ease,
			color 150ms ease,
			background 150ms ease;
	}
	.chip:hover:not(:disabled) {
		border-color: var(--brand-magenta, #ff2bc7);
		color: #fff;
		background: rgba(255, 43, 199, 0.08);
	}
	.chip.done {
		border-color: var(--brand-teal, #20e0c1);
		color: var(--brand-teal, #20e0c1);
	}
	.pill {
		flex: 0 0 auto;
		padding: 4px 10px;
		border-radius: 999px;
		border: 1px solid var(--brand-teal, #20e0c1);
		color: var(--brand-teal, #20e0c1);
		font-size: 0.6rem;
		letter-spacing: 0.16em;
		background: rgba(5, 3, 16, 0.4);
		backdrop-filter: blur(6px);
	}
	.pill.off {
		border-color: var(--color-blood, #ff4d6d);
		color: var(--color-blood, #ff4d6d);
	}

	.error {
		padding: 10px 16px;
		border-left: 3px solid var(--color-blood, #ff4d6d);
		background: rgba(196, 26, 61, 0.3);
		color: var(--color-bone, #f5f0ff);
		border-radius: 2px;
		backdrop-filter: blur(6px);
	}

	/* ── Seat frames (the hero) ───────────────────────────────── */
	.seats {
		list-style: none;
		margin: 0;
		padding: 0;
		align-self: center;
		width: 100%;
		min-height: 0;
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: clamp(8px, 1.4vw, 16px);
	}
	.seat {
		min-width: 0;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.frame {
		position: relative;
		box-sizing: border-box;
		width: 100%;
		max-width: 240px;
		aspect-ratio: 10 / 13.5;
		max-height: 100%;
		border-radius: 18px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--seat) 45%, var(--color-mist, #2e1d52));
		background:
			radial-gradient(
				ellipse at 50% 28%,
				color-mix(in srgb, var(--seat) 22%, transparent),
				transparent 72%
			),
			linear-gradient(180deg, rgba(20, 12, 38, 0.6), rgba(8, 5, 18, 0.78));
		box-shadow:
			inset 0 0 0 1.5px color-mix(in srgb, var(--seat) 28%, transparent),
			0 18px 44px -22px color-mix(in srgb, var(--seat) 55%, transparent);
		backdrop-filter: blur(10px);
	}
	.seat.mine .frame.filled {
		box-shadow:
			inset 0 0 0 2px var(--seat),
			0 0 26px -6px color-mix(in srgb, var(--seat) 75%, transparent),
			0 18px 44px -20px color-mix(in srgb, var(--seat) 70%, transparent);
	}
	.frame-hit {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: none;
		background: none;
		color: inherit;
		text-align: left;
		cursor: default;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
	}
	.frame.actable .frame-hit {
		cursor: pointer;
	}
	@media (hover: hover) and (pointer: fine) {
		.frame.actable:has(.frame-hit:hover:not(:disabled)) {
			border-color: var(--seat);
		}
		.frame.actable .frame-hit:hover:not(:disabled) .art {
			transform: scale(1.045);
		}
		.frame.actable .frame-hit:hover:not(:disabled) .change-hint {
			color: #fff;
			border-color: var(--seat);
			background: color-mix(in srgb, var(--seat) 30%, transparent);
		}
	}
	.frame-hit:focus-visible {
		outline: 2px solid var(--seat);
		outline-offset: -2px;
		border-radius: 18px;
	}
	.art {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: 50% 18%;
		transition: transform 260ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	/* No guardian yet → a designed sigil, not a bare letter. */
	.sigil {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
	}
	.sigil-gem {
		position: absolute;
		width: 34%;
		aspect-ratio: 1;
		transform: rotate(45deg);
		border: 1.5px solid color-mix(in srgb, var(--seat) 70%, transparent);
		background: color-mix(in srgb, var(--seat) 14%, transparent);
		box-shadow: 0 0 24px -4px color-mix(in srgb, var(--seat) 60%, transparent);
	}
	.sigil-ch {
		position: relative;
		font-family: var(--font-display);
		font-size: clamp(1.4rem, 4vh, 2.2rem);
		color: var(--color-bone, #f5f0ff);
		text-transform: uppercase;
	}
	.shade {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgba(5, 3, 16, 0.16) 0%, transparent 30% 52%, rgba(5, 3, 16, 0.94) 100%);
		pointer-events: none;
	}
	.badges {
		position: absolute;
		top: 8px;
		left: 8px;
		right: 8px;
		display: flex;
		gap: 6px;
		pointer-events: none;
	}
	.badge {
		padding: 3px 8px;
		border-radius: 999px;
		font-family: var(--font-display);
		font-weight: normal;
		font-size: 0.56rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		backdrop-filter: blur(6px);
	}
	.badge.you {
		color: #04121a;
		background: var(--brand-cyan, #24d4ff);
		box-shadow: 0 0 12px rgba(36, 212, 255, 0.55);
	}
	.badge.bot {
		color: var(--brand-amber, #ffba3d);
		border: 1px solid rgba(255, 186, 61, 0.5);
		background: rgba(5, 3, 16, 0.55);
	}
	.plate {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px 11px;
		pointer-events: none;
	}
	.pname {
		font-family: var(--font-display);
		font-size: clamp(0.82rem, 1.8vh, 1.05rem);
		letter-spacing: 0.05em;
		color: var(--color-bone, #f5f0ff);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pguardian {
		font-family: var(--font-body);
		font-size: clamp(0.66rem, 1.5vh, 0.78rem);
		color: color-mix(in srgb, var(--seat) 75%, #fff);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pguardian.none {
		color: var(--color-fog, #9a8fb8);
		font-style: italic;
	}
	.change-hint {
		align-self: flex-start;
		margin-top: 5px;
		padding: 4px 10px;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.22);
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.56rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		transition:
			color 150ms ease,
			border-color 150ms ease,
			background 150ms ease;
	}
	/* Corner remove/leave — a real hit target floating over the frame. */
	.seat-x {
		position: absolute;
		top: 6px;
		right: 6px;
		z-index: 2;
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(5, 3, 16, 0.6);
		color: var(--color-parchment, #d8cfee);
		font-size: 0.72rem;
		cursor: pointer;
		backdrop-filter: blur(6px);
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.seat-x:hover:not(:disabled) {
		border-color: var(--color-blood, #ff4d6d);
		color: var(--color-blood, #ff4d6d);
	}
	.seat-x:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Open seat → invite / sit tile. */
	.frame.vacant {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-style: dashed;
		border-color: color-mix(in srgb, var(--seat) 40%, transparent);
		background: color-mix(in srgb, var(--seat) 5%, rgba(8, 5, 18, 0.5));
		cursor: pointer;
		color: inherit;
		padding: 0;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition:
			border-color 160ms ease,
			background 160ms ease;
	}
	.frame.vacant:hover:not(:disabled),
	.frame.vacant:focus-visible {
		border-color: var(--seat);
		background: color-mix(in srgb, var(--seat) 11%, rgba(8, 5, 18, 0.5));
		outline: none;
	}
	.frame.vacant:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.vac-plus {
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		border-radius: 14px;
		border: 1.5px solid color-mix(in srgb, var(--seat) 65%, transparent);
		color: var(--seat);
		font-size: 1.3rem;
		line-height: 1;
	}
	.vac-label {
		font-family: var(--font-display);
		font-size: clamp(0.68rem, 1.6vh, 0.82rem);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-parchment, #d8cfee);
	}
	.vac-seat {
		font-family: var(--font-mono);
		font-size: 0.62rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--seat) 80%, #fff);
		opacity: 0.85;
	}

	/* ── Action bar: chat tab · settings · Start ──────────────── */
	.lbar {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
	}
	.chat-tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 48px;
		padding: 10px 18px;
		border-radius: 12px;
		border: 1px solid var(--color-aether, #3a2670);
		background: rgba(10, 7, 24, 0.55);
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		backdrop-filter: blur(8px);
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.chat-tab svg {
		width: 18px;
		height: 18px;
	}
	.chat-tab:hover {
		border-color: var(--brand-cyan, #24d4ff);
		color: #fff;
	}
	.chat-badge {
		position: absolute;
		top: -6px;
		right: -6px;
		min-width: 19px;
		height: 19px;
		display: grid;
		place-items: center;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		font-family: var(--font-mono);
		font-size: 0.62rem;
		box-shadow: 0 0 10px rgba(255, 43, 199, 0.6);
	}
	.settings {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		min-width: 0;
	}
	.setting {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.setting-label {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-fog, #9a93b0);
	}
	.setting-chip,
	.wait-chip {
		padding: 10px 14px;
		border-radius: 10px;
		border: 1px solid color-mix(in srgb, var(--brand-violet, #7b1dff) 45%, transparent);
		background: rgba(123, 29, 255, 0.06);
		color: var(--color-parchment, #d8d2e8);
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		white-space: nowrap;
	}
	.wait-chip {
		margin-left: auto;
	}
	.ctl {
		min-height: 48px;
		box-sizing: border-box;
		padding: 10px 14px;
		border-radius: 12px;
		border: 1px solid var(--brand-violet, #7b1dff);
		background: rgba(123, 29, 255, 0.05);
		color: var(--brand-violet-soft, #9d4dff);
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			color 150ms ease,
			border-color 150ms ease,
			background 150ms ease;
	}
	.ctl:hover:not(:disabled) {
		color: var(--brand-magenta-soft, #ff5dd1);
		border-color: var(--brand-magenta, #ff2bc7);
		background: rgba(255, 43, 199, 0.07);
	}
	.ctl:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	select.ctl option {
		background: #1a0b2e;
		color: var(--brand-violet-soft, #9d4dff);
	}

	/* Start = the dominant CTA, bottom-right. */
	.start-wrap {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}
	.start-reason {
		font-family: var(--font-body);
		font-size: 0.78rem;
		color: var(--color-fog, #9a8fb8);
		font-style: italic;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.start {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		min-height: 56px;
		padding: 14px 30px;
		border: none;
		border-radius: 14px;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff, #5a2bff));
		background-size: 180% 180%;
		color: #fff;
		font-family: var(--font-display);
		font-size: 1rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		cursor: pointer;
		box-shadow: 0 14px 36px -14px rgba(255, 43, 199, 0.75);
		transition:
			background-position 500ms ease,
			box-shadow 160ms ease,
			filter 160ms ease;
	}
	.start svg {
		width: 20px;
		height: 20px;
		transition: transform 160ms ease;
	}
	.start:hover:not(:disabled) {
		background-position: 100% 0;
		filter: brightness(1.08);
	}
	.start:hover:not(:disabled) svg {
		transform: translateX(4px);
	}
	.start:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ── Invite sheet ─────────────────────────────────────────── */
	.invite-layer {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 20px;
	}
	.invite-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		background: rgba(4, 2, 12, 0.66);
		backdrop-filter: blur(6px);
		cursor: pointer;
	}
	.invite-sheet {
		position: relative;
		width: min(520px, 100%);
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 22px 24px;
		border-radius: 18px;
		border: 1px solid var(--color-mist, #2e1d52);
		background: linear-gradient(180deg, rgba(26, 15, 46, 0.97), rgba(8, 5, 18, 0.98));
		box-shadow: 0 40px 120px -30px rgba(0, 0, 0, 0.85);
	}
	.ieyebrow {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.24em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.ihint {
		margin: 0;
		font-family: var(--font-body);
		font-size: 0.84rem;
		color: var(--color-fog, #9a8fb8);
	}
	.irow {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.irow input {
		flex: 1;
		min-width: 160px;
		padding: 10px 12px;
		border-radius: 10px;
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
	.idone {
		align-self: flex-end;
		margin-top: 4px;
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

	/* ── Tablet-ish portrait / narrow windows: 3×2 party grid ─── */
	@media (max-width: 980px) and (orientation: portrait) {
		.seats {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	/* ── Phone portrait: 2×3 grid, stacked header, sticky bottom bar. The page
	   may scroll on very short phones; the Start bar stays pinned. ── */
	@media (max-width: 640px) and (orientation: portrait) {
		.lobby {
			height: auto;
			min-height: 100%;
			grid-template-rows: auto auto 1fr auto;
			gap: 12px;
			padding: calc(12px + env(safe-area-inset-top)) 14px 0;
		}
		.ltop {
			flex-direction: column;
			align-items: stretch;
			gap: 10px;
			padding-right: 0;
		}
		.leave-btn {
			align-self: flex-start;
			margin-top: 0;
			min-height: 40px;
		}
		/* In the stacked header the code block must NOT flex (flex-basis 0 in a
		   column collapses it and the seats grid paints over the code). */
		.lcode {
			flex: none;
		}
		.code {
			font-size: clamp(2rem, 9vw, 2.6rem);
		}
		.seats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px;
		}
		.frame {
			aspect-ratio: 1 / 1;
			max-width: none;
		}
		.lbar {
			position: sticky;
			bottom: 0;
			z-index: 5;
			flex-wrap: wrap;
			gap: 10px;
			margin: 0 -14px;
			padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
			background: linear-gradient(180deg, transparent, rgba(5, 3, 16, 0.9) 26%);
			-webkit-backdrop-filter: blur(10px);
			backdrop-filter: blur(10px);
		}
		.settings {
			order: 1;
			flex: 1;
			justify-content: flex-end;
		}
		.chat-tab {
			order: 0;
		}
		.start-wrap {
			order: 2;
			margin-left: 0;
			width: 100%;
			flex-direction: column-reverse;
			align-items: stretch;
			gap: 6px;
		}
		.start-reason {
			text-align: center;
			white-space: normal;
		}
		.start {
			justify-content: center;
			width: 100%;
		}
		.wait-chip {
			order: 2;
			margin-left: 0;
			width: 100%;
			box-sizing: border-box;
			text-align: center;
			white-space: normal;
		}
	}

	/* ── Phone landscape (short height): everything compacts, still one screen. ── */
	@media (orientation: landscape) and (max-height: 520px) {
		.lobby {
			gap: 8px;
			padding:
				calc(10px + env(safe-area-inset-top))
				max(16px, calc(12px + env(safe-area-inset-right)))
				calc(10px + env(safe-area-inset-bottom))
				max(16px, calc(12px + env(safe-area-inset-left)));
		}
		.ltop {
			align-items: center;
			padding-right: 120px;
		}
		.leave-btn {
			margin-top: 0;
			min-height: 38px;
			padding: 7px 13px;
			font-size: 0.64rem;
		}
		.lcode {
			flex-direction: row;
			align-items: center;
			gap: 14px;
		}
		.kicker {
			font-size: 0.54rem;
			letter-spacing: 0.2em;
		}
		.kicker .kl {
			width: 12px;
		}
		.code-row {
			gap: 10px;
		}
		.code {
			font-size: clamp(1.5rem, 9vh, 2.1rem);
			letter-spacing: 0.08em;
		}
		.chip {
			min-height: 32px;
			padding: 5px 11px;
			font-size: 0.6rem;
		}
		.error {
			padding: 7px 12px;
			font-size: 0.76rem;
		}
		.seats {
			gap: 8px;
		}
		.frame {
			border-radius: 13px;
			aspect-ratio: 10 / 13;
		}
		.badges {
			top: 5px;
			left: 5px;
			right: 5px;
		}
		.badge {
			padding: 2px 6px;
			font-size: 0.5rem;
		}
		.plate {
			padding: 6px 8px 7px;
		}
		.change-hint {
			margin-top: 3px;
			padding: 3px 8px;
			font-size: 0.5rem;
		}
		.seat-x {
			width: 26px;
			height: 26px;
			font-size: 0.62rem;
		}
		.vac-plus {
			width: 32px;
			height: 32px;
			border-radius: 10px;
			font-size: 1rem;
		}
		.lbar {
			gap: 8px;
			min-height: 44px;
		}
		.chat-tab,
		.ctl {
			min-height: 44px;
			padding: 8px 12px;
			font-size: 0.62rem;
			border-radius: 10px;
		}
		.setting-chip,
		.wait-chip {
			padding: 8px 11px;
			font-size: 0.6rem;
		}
		.start-reason {
			font-size: 0.7rem;
		}
		.start {
			min-height: 44px;
			padding: 9px 18px;
			font-size: 0.78rem;
			border-radius: 11px;
		}
		.start svg {
			width: 16px;
			height: 16px;
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
