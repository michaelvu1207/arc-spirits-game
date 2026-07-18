<script lang="ts">
	import { onDestroy } from 'svelte';
	import { browser, dev } from '$app/environment';
	import { sendPlayCommand, applyOptimistic, getPlayState, postPlayJson } from '$lib/stores/playStore.svelte';
	import { getAssetState } from '$lib/stores/assetStore.svelte';
	import type {
		AwakenDiscardRef,
		GameCommand,
		MemberRole,
		NavigationDestination,
		SeatColor,
		SpectatorProjection
	} from '$lib/play/types';
	import { GAME_PHASES, RUNE_CARRY_LIMIT, isEvilAlignment } from '$lib/play/types';
	import { PHASE_LABELS } from '$lib/play/viewV2';
	import { buildLocationInteractions } from '$lib/play/locationInteractions';
	import { buildMonsterRewards } from '$lib/play/monsterRewards';
	import {
		LOCATION_ACCENT,
		getLocationConfig,
		splatFor,
		worldMusicFor,
		combatMusicFor,
		NAVIGATION_MUSIC,
		CLEANUP_MUSIC
	} from '$lib/play/locations';
	import { spiritImageMap, seatAccent, storageUrl } from './helpers';
	import RoundBanner from './RoundBanner.svelte';
	import PhaseBar from './PhaseBar.svelte';
	import InfoLegend from './InfoLegend.svelte';
	import type { InfoContextKey } from './InfoLegend.svelte';
	import Leaderboard from './Leaderboard.svelte';
	import TraitTracker from './TraitTracker.svelte';
	import MatSlots from './MatSlots.svelte';
	import type { NavigationSceneControls } from './navigationSceneControls';
	import MainStage, { type ActiveAction } from './MainStage.svelte';
	import CompositionStage from './CompositionStage.svelte';
	import DestinationReveal from './DestinationReveal.svelte';
	import GameStartCutscene from './GameStartCutscene.svelte';
	import SplatBackground from './SplatBackground.svelte';
	import SplatQualityControl from './SplatQualityControl.svelte';
	import { prefersReducedData } from '$lib/play/dataSaver';
	import { getGraphicsSettings } from '$lib/stores/graphicsSettings.svelte';
	import { pulseHaptic } from '$lib/stores/accessibilitySettings.svelte';
	import BagViewer from './BagViewer.svelte';
	import DebugPanel from './DebugPanel.svelte';
	import SummonFxLayer from './SummonFxLayer.svelte';
	import PostGameView from './PostGameView.svelte';
	import GuidedCoach from './GuidedCoach.svelte';
	import GameChat from './GameChat.svelte';
	import {
		setMusic,
		stopMusic,
		playSfx,
		toggleAudioMuted,
		getGameAudio
	} from '$lib/stores/gameAudio.svelte';

	const audioState = getGameAudio();
	const playState = getPlayState();

	interface Member {
		id: string | null;
		role: MemberRole;
		seatColor: SeatColor | null;
		displayName: string | null;
	}

	interface Props {
		room: SpectatorProjection;
		member: Member;
		assets: ReturnType<typeof getAssetState>;
	}

	let { room, member, assets }: Props = $props();
	const e2eMode = browser && new URLSearchParams(window.location.search).has('e2e');
	const forceStartCutscene =
		browser && new URLSearchParams(window.location.search).has('showStartCutscene');
	const forceDestinationReveal =
		browser && new URLSearchParams(window.location.search).has('showDestinationReveal');

	let pendingAction = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let settingsOpen = $state(false);
	let infoOpen = $state(false);
	let chatOpen = $state(false);
	let bagOpen = $state(false);
	let concedeArmed = $state(false);
	/** Which action sub-view the central stage is showing (null = the action grid). */
	let activeAction = $state<ActiveAction>(null);
	/** Last group-Encounter (PvP) combat id this client has shown + dismissed, so the
	 *  auto-surfaced overlay doesn't keep re-opening for the rest of the round. */
	let seenPvpCombatId = $state<string | null>(null);

	const mySeat = $derived(member.seatColor);
	const isHost = $derived(member.role === 'host');
	const myPlayer = $derived(mySeat ? (room.players[mySeat] ?? null) : null);
	const busy = $derived(pendingAction !== null);
	// This seat's engine-computed action surface (RoomView v2 affordances, threaded
	// over both the WS and HTTP transports). Null until the server ships it.
	const myAffordances = $derived(mySeat ? (playState.affordances[mySeat] ?? null) : null);
	const guidePendingKind = $derived(myAffordances?.pendingWork?.[0]?.kind ?? null);
	// A stage takeover (awaken payment / armed trade) is staging a decision — park
	// the pass control so "I'm done" can't race a half-built selection.
	let stageTakeoverOpen = $state(false);

	const spiritImages = $derived(spiritImageMap(assets.spiritAssets));

	async function concedeRankedSeat() {
		if (!concedeArmed) {
			concedeArmed = true;
			return;
		}
		pendingAction = 'concede';
		try {
			await postPlayJson(`/api/play/sessions/${encodeURIComponent(room.roomCode)}/concede`, {});
			actionError = 'Seat conceded. A disclosed server bot now completes the live match; you may spectate.';
			settingsOpen = false;
		} catch (cause) {
			actionError = cause instanceof Error ? cause.message : 'Could not concede this ranked seat.';
		} finally {
			pendingAction = null;
			concedeArmed = false;
		}
	}

	// ── Composition view: replace the MainStage content with a player's 7-hex board ──
	// viewedSeat = null → normal stage; a seat → that player's composition fills the
	// main stage. Opened (and hidden) by clicking that player in the leaderboard — there
	// is no back button. The pending action state lives here and MainStage is stateless,
	// so the stage is restored exactly when viewedSeat clears.
	let viewedSeat = $state<SeatColor | null>(null);
	const viewingProfile = $derived(viewedSeat !== null);
	// While viewing, the LEFT trait list reflects the viewed player; otherwise it's mine.
	const traitPlayer = $derived(viewedSeat ? (room.players[viewedSeat] ?? null) : myPlayer);
	function scoutSeat(seat: SeatColor) {
		viewedSeat = viewedSeat === seat ? null : seat;
		// On mobile the three columns are full-width swipe pages; the composition fills
		// the Stage page (the middle one). Tapping a player on the Leaderboard page
		// auto-swipes to the Stage so their board is actually visible.
		if (viewedSeat) goToPage(STAGE_PAGE);
	}

	// Drop back to the action grid whenever we leave the Location phase.
	$effect(() => {
		if (room.phase !== 'location') activeAction = null;
	});

	// A group Encounter (PvP) combat resolves as the phase flips to 'location' (it's
	// driven by the unanimous vote, not a "start" click), so surface its CombatOverlay
	// the same way monster fights do: flag activeAction='combat' the first time a fresh
	// pvp combat involving my seat appears. continueAction() marks it seen so the
	// lingering combat doesn't re-open for the rest of the round.
	const myPvpCombat = $derived(
		mySeat
			? (room.combats.find((c) => c.kind === 'pvp' && c.sides.some((s) => s.seat === mySeat)) ??
					null)
			: null
	);
	$effect(() => {
		if (
			myPvpCombat &&
			myPvpCombat.id !== seenPvpCombatId &&
			room.phase === 'location' &&
			activeAction === null &&
			!myPlayer?.pendingDraw &&
			!myPlayer?.pendingReward
		) {
			activeAction = 'combat';
		}
	});

	const navOpen = $derived(room.phase === 'navigation' && !room.revealedDestinations);

	// Defensive: a seated player must never be stranded on the composition view while
	// they owe a turn-blocking action. The destination picker, draw tray, reward menu
	// and combat overlay all live in MainStage, which the inline view unmounts — and
	// there is no back button, so snap back to the main stage the instant an obligation
	// appears. Spectators (no seat) may keep browsing freely.
	$effect(() => {
		if (!mySeat) return;
		if (
			navOpen ||
			myPlayer?.pendingDraw ||
			myPlayer?.pendingReward ||
			(room.phase === 'cleanup' && myPlayer?.pendingCorruptionDiscard) ||
			activeAction !== null
		) {
			viewedSeat = null;
		}
	});

	// Forced corruption discard + Spirit Augment placement render IN-STAGE (inside
	// MainStage's view), prioritized there ahead of the phase content — no floating
	// overlay here. The auto-pass / scout-view gates below still key off the raw
	// pendingCorruptionDiscard / unplacedAugments state.

	// Navigation is interactive whenever it's open — clicking a card locks it in,
	// clicking the locked card unlocks, clicking another switches the choice.
	const canPickDestination = $derived(navOpen && !!mySeat);
	const lockedDestination = $derived(myPlayer?.pendingDestination ?? null);
	// The local player has locked a destination (navigation still open) → show the
	// full-screen "confirmed" zoom panel instead of the carousel, with a back-out.
	const myConfirmedDestination = $derived(
		navOpen && mySeat && lockedDestination && room.navigation[mySeat]?.locked
			? lockedDestination
			: null
	);

	// ── Splat background ───────────────────────────────────────────────────
	const graphics = getGraphicsSettings();
	// Skip the WebGL splat when the player disabled it (Settings → Background → Off)
	// OR on metered/slow/Data-Saver connections — the board is fully playable with
	// just the radial-gradient base background. prefersReducedData() returns false
	// conservatively where the Network Information API is unavailable (Safari/Firefox).
	// Reactive so toggling the in-game setting starts/stops the renderer live.
	const showSplat = $derived(!e2eMode && graphics.splatEnabled && !prefersReducedData());

	// Each destination maps to a Gaussian-splat world (static .spz under /splats);
	// the map + defaults are the single source of truth in locations.ts (splatFor).
	// Before a destination is picked, the default (sunset valley) shows.
	// Follow the local player's pick the moment they lock it in (pendingDestination),
	// then the committed destination keeps it steady through every later phase.
	const activeDestination = $derived(
		(myPlayer?.pendingDestination ??
			myPlayer?.navigationDestination ??
			null) as NavigationDestination | null
	);
	// Browsing the carousel, the world under the cursor previews as a live "portal";
	// null clears the preview back to the locked / committed pick.
	let hoveredDestination = $state<NavigationDestination | null>(null);
	// The carousel unmounts on commit, and a disabled card never fires mouseleave, so
	// clear the hover whenever the pick UI closes — otherwise a stale hover bleeds a
	// phantom "Live" portal into the next navigation round.
	$effect(() => {
		if (!canPickDestination) hoveredDestination = null;
	});
	// The local player has stepped *into* the realm once the round leaves navigation
	// with a committed destination — the splat stops being wallpaper and becomes the
	// stage (sharp + dollied in). Spectators always stay in the browsing view.
	const inRealm = $derived(
		!!mySeat &&
			(room.phase === 'location' ||
				room.phase === 'encounter' ||
				room.phase === 'benefits' ||
				room.phase === 'awakening' ||
				room.phase === 'cleanup')
	);
	// Spectators can't hover or lock a pick, so frame the busiest realm for them — one
	// card always reads as the live window and the splat shows a real world.
	const spectatorFocus = $derived.by<NavigationDestination | null>(() => {
		if (mySeat) return null;
		let best: NavigationDestination | null = null;
		let most = 0;
		for (const [dest, occ] of Object.entries(room.locationOccupancy ?? {})) {
			const n = (occ as SeatColor[]).length;
			if (n > most) {
				most = n;
				best = dest as NavigationDestination;
			}
		}
		return best;
	});
	// One shared "browse focus" so the open portal card and the splat always agree on
	// which world is live: hover → locked pick → committed → (spectator) busiest realm.
	const browseFocus = $derived(
		hoveredDestination ?? lockedDestination ?? activeDestination ?? spectatorFocus
	);
	// Browse → the shared focus; inside the realm → lock onto the committed destination.
	// Drives per-scene music (navigation music ignores the destination, so hovering the
	// carousel never changes the soundtrack — only the realm phases do).
	const focusDestination = $derived(inRealm ? activeDestination : browseFocus);
	// ── Navigation → realm presentation choreography (client-only) ─────────────
	// The engine reveals destinations and steps into the location phase in a single
	// atomic transition. We replay it as an ordered beat for the local view so the
	// player reads it as: confirmation panel → "who went where" reveal → realm-enter
	// flourish (the splat finally dollies in) → location interaction.
	//   'idle'   — normal play (carousel / confirmed panel / location UI)
	//   'reveal' — the "Destinations Revealed" overlay (rendered from a frozen snapshot)
	//   'enter'  — the iris + "Entering {Realm}" flourish while the splat zooms in
	let revealSeq = $state<'idle' | 'reveal' | 'enter'>('idle');
	// Occupancy frozen at the instant of reveal so the overlay can never blank out if the
	// room advances underneath it.
	let revealOccupancy = $state<SpectatorProjection['locationOccupancy']>({});
	let enteredRealm = $state<string | null>(null);
	let enterTimer: ReturnType<typeof setTimeout> | null = null;
	// ── Portal-dive geometry ───────────────────────────────────────────────────
	// The realm-enter dive grows a world-filled circle from the navigator's centre (where
	// the "Going to" circle sits) out past the screen edges, so the picked world engulfs
	// the view — "jumping into the hole". Captured the instant the enter beat begins (the
	// stage cell is still mounted under the reveal overlay) so the portal opens from the
	// right spot with no first-frame jump from a stale origin.
	let stageCellEl = $state<HTMLDivElement | null>(null);
	let portal = $state({ cx: 0, cy: 0, hole0: 0, coverR: 0 });
	function measurePortal() {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// Fall back to the viewport centre if the stage cell isn't measurable yet, so the
		// dive always blooms from a sane origin instead of a zero-radius (all-dark) window.
		const r = stageCellEl?.getBoundingClientRect();
		const cx = r ? r.left + r.width / 2 : vw / 2;
		const cy = r ? r.top + r.height / 2 : vh / 2;
		// Start ≈ the confirm circle's disc; grow until the circle clears the farthest
		// viewport corner (so it fully covers the screen before handing off to the realm).
		const span = r ? Math.min(r.width, r.height) : Math.min(vw, vh);
		const hole0 = Math.max(70, span * 0.28);
		const coverR = Math.hypot(Math.max(cx, vw - cx), Math.max(cy, vh - cy)) + 12;
		portal = { cx, cy, hole0, coverR };
	}

	// ── Backdrop world continuity ─────────────────────────────────────────────
	// The full-screen splat follows the MUSIC-continuity rule (see lastVisitedWorldMusic):
	// it shows the world the local player is engaged with and only CHANGES when they lock a
	// NEW destination. So it never snaps back to the neutral wallpaper when the navigation
	// phase re-opens between rounds, and backing out of a pick ("Change selection") leaves
	// the backdrop untouched. Swiping the carousel never swaps it — only a deliberate lock
	// does (which fires the splat's own world-switch warp). Before anyone has committed
	// (round 1) it's the default wallpaper. Through browse/confirm it stays a blurred
	// wallpaper; it sharpens and dollies in only on the realm-enter dive. The confirm
	// CIRCLE keeps its OWN sharp mini splat as the focal preview (two separate renderers).
	let navSplatDestination = $state<NavigationDestination | null>(null);
	$effect(() => {
		if (room.status !== 'active') {
			navSplatDestination = null; // fresh game → reset to the default wallpaper
			return;
		}
		// Inside the realm the backdrop IS the committed world — record it so it carries
		// through cleanup and into the next navigation phase. A fresh lock during
		// navigation moves the backdrop to that world at once; unlock leaves it put.
		if (inRealm && activeDestination) navSplatDestination = activeDestination;
		else if (lockedDestination) navSplatDestination = lockedDestination;
	});
	// In the realm the committed destination is authoritative (no one-frame latch lag);
	// during navigation the sticky backdrop drives it; spectators frame the busiest realm.
	const splatFocus = $derived(
		inRealm ? activeDestination : mySeat ? navSplatDestination : spectatorFocus
	);
	const splatSrc = $derived(splatFor(splatFocus as NavigationDestination | null));
	// Zoom (dolly-in) + full sharpness happen only during the 'enter' flourish and once
	// settled inside the realm — NOT while merely confirmed or during the reveal overlay,
	// so the "zoom into the new world" beat lands AFTER the destinations are revealed.
	const splatZoomed = $derived(revealSeq === 'enter' || (revealSeq === 'idle' && inRealm));
	const splatPush = $derived(splatZoomed ? 1 : 0);
	// Wallpaper blur while browsing/confirming (the confirm circle owns the chosen-world
	// preview now); sharp once zoomed in.
	const splatBlur = $derived(splatZoomed ? 0 : mySeat ? 13 : 8);

	// ── navView: a single derived presentation state, computed PURELY from existing
	// flags (no new server state). First match wins (priority order matters). This is the
	// canonical mapping for which navigator-area view the local player sees.
	//   'reveal' — DestinationReveal overlay beat (frozen "who went where" snapshot)
	//   'enter'  — iris + dolly flourish (main splat push→1)
	//   'realm'  — committed, inside location/encounter/cleanup (splat sharp + dollied)
	//   'confirm'— locked a pick, navigation still open (the confirm circle)
	//   'browse' — carousel / compass (or spectator wallpaper)
	const navView = $derived<'browse' | 'confirm' | 'reveal' | 'enter' | 'realm'>(
		revealSeq === 'reveal'
			? 'reveal'
			: revealSeq === 'enter'
				? 'enter'
				: inRealm
					? 'realm'
					: myConfirmedDestination
						? 'confirm'
						: 'browse'
	);

	// ── Scene music ────────────────────────────────────────────────────────
	// Per-location ambience (location/interaction phase) and combat themes
	// (encounter phase, or a monster fight inside the location phase). The track
	// maps are the single source of truth in locations.ts (worldMusicFor /
	// combatMusicFor).
	//
	// Music continuity: a world's ambient theme keeps playing once you've VISITED
	// that location — across the following cleanup and back through the navigation
	// phase — until you step into your NEXT location. (Visit Cyber City and its
	// music plays until you next commit to a world.) Before any location is visited
	// (round 1) we fall back to the navigation / cleanup scene themes.
	let lastVisitedWorldMusic = $state<string | null>(null);
	$effect(() => {
		if (inRealm && activeDestination) {
			// Recorded the moment the local player is inside their committed realm.
			lastVisitedWorldMusic = worldMusicFor(activeDestination);
		} else if (room.status !== 'active') {
			lastVisitedWorldMusic = null; // reset on game end / leave
		}
	});
	const sceneMusic = $derived.by<string | null>(() => {
		if (room.status !== 'active') return null;
		const dest = focusDestination as NavigationDestination | null;
		if (room.phase === 'navigation') return lastVisitedWorldMusic ?? NAVIGATION_MUSIC;
		if (room.phase === 'benefits' || room.phase === 'awakening' || room.phase === 'cleanup')
			return lastVisitedWorldMusic ?? CLEANUP_MUSIC;
		if (room.phase === 'encounter') return combatMusicFor(dest);
		if (room.phase === 'location')
			return activeAction === 'combat' ? combatMusicFor(dest) : worldMusicFor(dest);
		return null;
	});
	$effect(() => {
		setMusic(sceneMusic);
	});

	// ── State-change sound effects ───────────────────────────────────────────
	// Guards seed sentinels (no top-level reactive read) and prime on the first
	// active frame so nothing fires spuriously on mount.
	// ── Game-start cutscene ──────────────────────────────────────────────────
	// A one-shot "here are your spirits — good luck" overlay shown once per game,
	// to seated players, the first time navigation opens (round 1). Gated on gameId
	// so SSE polls / reconnects within the same game don't re-trigger it.
	let showStartCutscene = $state(false);
	let cutsceneShownFor = $state<string | null>(null);
	const myGuardianName = $derived(mySeat ? (room.seats[mySeat]?.selectedGuardian ?? null) : null);
	const myGuardianIcon = $derived(
		myGuardianName
			? storageUrl(assets.guardianAssets.get(myGuardianName)?.icon_image_path ?? null)
			: null
	);
	$effect(() => {
		if (!mySeat || room.status !== 'active') return;
		const gid = room.gameId;
		if (!gid || (cutsceneShownFor === gid && !forceStartCutscene)) return;
		if (
			(!e2eMode || forceStartCutscene) &&
			room.round === 1 &&
			room.phase === 'navigation' &&
			!room.revealedDestinations &&
			(myPlayer?.spirits?.length ?? 0) > 0
		) {
			cutsceneShownFor = gid;
			showStartCutscene = true;
		}
	});

	let prevPhase = '';
	let prevRound = -1;
	let prevReveal = false;
	let prevVp = -1;
	let prevError: string | null = null;
	$effect(() => {
		if (room.status !== 'active') return;
		if (prevRound < 0) {
			prevRound = room.round;
			prevPhase = room.phase;
			prevReveal = room.revealedDestinations;
			prevVp = myPlayer?.victoryPoints ?? 0;
			return;
		}
		if (room.round !== prevRound) {
			prevRound = room.round;
			prevPhase = room.phase;
			playSfx('round-start');
		} else if (room.phase !== prevPhase) {
			prevPhase = room.phase;
			playSfx('phase-advance');
		}
		if (room.revealedDestinations && !prevReveal) {
			playSfx('nav-reveal');
			// Freeze occupancy at the reveal instant, then start the reveal → enter beat.
			// JSON clone, not structuredClone: `room` is a Svelte reactive proxy and
			// structuredClone throws DataCloneError on it. locationOccupancy is plain
			// JSON-safe data (seat→destination map), so a JSON round-trip is a safe freeze.
			revealOccupancy = JSON.parse(JSON.stringify(room.locationOccupancy ?? {}));
			revealSeq = e2eMode ? 'idle' : 'reveal';
		}
		prevReveal = room.revealedDestinations;
		const vp = myPlayer?.victoryPoints ?? 0;
		if (vp > prevVp) playSfx('vp-gain');
		prevVp = vp;
	});
	$effect(() => {
		if (actionError && actionError !== prevError) playSfx('error');
		prevError = actionError;
	});
	let prevStatus = -1;
	let prevBarrier = -1;
	let announcedWin = false;
	$effect(() => {
		if (room.status === 'finished') {
			if (!announcedWin) {
				announcedWin = true;
				playSfx('victory');
			}
			return;
		}
		announcedWin = false;
		if (room.status !== 'active') return;
		const st = myPlayer?.statusLevel ?? 0;
		const bar = myPlayer?.barrier ?? 0;
		if (prevStatus < 0) {
			prevStatus = st;
			prevBarrier = bar;
			return;
		}
		if (st !== prevStatus) {
			prevStatus = st;
			playSfx('status-change');
		}
		if (bar !== prevBarrier) {
			prevBarrier = bar;
			playSfx('potential-change');
		}
	});

	// ── "Entering the realm" flourish (stage 'enter' of the choreography) ───────
	// A one-shot iris + title beat that masks the reveal→HUD swap behind the dolly-in.
	// It runs only after the reveal overlay is dismissed, so the order reads
	// reveal → zoom-in → location, never all at once. enteredRealm/enterTimer are
	// declared up top with revealSeq; onDestroy clears the timer on teardown.
	// Arm the enter stage: the actual enter→idle transition now fires from the MAIN
	// splat's onZoomSettled (when the dolly reaches the world — the GOAL-B beat "you zoom
	// into that splat and it becomes the background splat"), NOT a fixed timer. A generous
	// fallback timeout still GUARANTEES the transition so a missing callback (reduced-motion
	// edge, lost WebGL context) can never strand the stage in 'enter' — which would freeze
	// the location auto-pass gate (shouldAutoPassLocation is keyed on revealSeq==='idle').
	function beginEnterStage() {
		enteredRealm = activeDestination;
		measurePortal(); // capture the dive origin before the overlay renders
		revealSeq = 'enter';
		playSfx('realm-enter');
		if (enterTimer) clearTimeout(enterTimer);
		enterTimer = setTimeout(() => finishEnterStage(), 2000);
	}
	// Idempotent: the onZoomSettled callback and the fallback timeout can race, and a fresh
	// navigation phase can already have snapped us out of 'enter' — only act once, while
	// still in 'enter'.
	function finishEnterStage() {
		if (revealSeq !== 'enter') return;
		revealSeq = 'idle';
		if (enterTimer) {
			clearTimeout(enterTimer);
			enterTimer = null;
		}
	}
	// Reveal overlay dismissed (auto-timer or tap): seated players dive into the realm
	// with the zoom flourish; spectators just return to their framed wallpaper.
	function closeReveal() {
		if (mySeat && activeDestination) beginEnterStage();
		else revealSeq = 'idle';
	}
	$effect(() => {
		// Snap the choreography back to idle whenever a fresh navigation phase opens
		// (next round) or the game ends, so a stranded timer can't keep the stage
		// hidden. Same-value $state writes are no-ops, so this never loops.
		if (room.status !== 'active' || (room.phase === 'navigation' && !room.revealedDestinations)) {
			revealSeq = 'idle';
			if (enterTimer) {
				clearTimeout(enterTimer);
				enterTimer = null;
			}
		}
	});
	onDestroy(() => {
		if (enterTimer) clearTimeout(enterTimer);
		stopMusic();
	});
	// Authoring aid: press ` (backtick) to toggle a WASD + mouse fly camera over the
	// splat to find a good starting pose (press P in-mode to log it to the console).
	let flyMode = $state(false);
	function onSplatFlyKey(e: KeyboardEvent) {
		if (e.code !== 'Backquote') return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		flyMode = !flyMode;
	}

	// ── Full-screen scene input ──────────────────────────────────────────────
	// Empty gameplay space now manipulates the navigation carousel. HUD controls sit
	// above this surface and keep normal pointer behavior, while transparent HUD gaps
	// fall through to this shared input layer.
	let navSceneControls = $state<NavigationSceneControls | null>(null);
	let scenePointerId: number | null = null;
	const sceneInputActive = $derived(
		navView === 'browse' &&
			navOpen &&
			!!navSceneControls &&
			!flyMode &&
			!settingsOpen &&
			!infoOpen &&
			!bagOpen &&
			!showStartCutscene
	);

	function resetScenePointer() {
		scenePointerId = null;
	}

	function beginScenePointer(event: PointerEvent) {
		if (!sceneInputActive || !navSceneControls) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		scenePointerId = event.pointerId;
		try {
			(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		} catch {
			// Some WebKit paths reject capture from an ancestor; move/up still arrive via capture listeners.
		}
		navSceneControls.beginDrag(event.clientX, event.clientY);
		event.preventDefault();
		event.stopPropagation();
	}

	function moveScenePointer(event: PointerEvent) {
		if (scenePointerId !== event.pointerId || !navSceneControls) return;
		navSceneControls.moveDrag(event.clientX, event.clientY);
		event.preventDefault();
		event.stopPropagation();
	}

	function endScenePointer(event: PointerEvent) {
		if (scenePointerId !== event.pointerId) return;
		navSceneControls?.endDrag(event.clientX, event.clientY);
		try {
			(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		} catch {
			// Matching the guarded capture path above.
		}
		resetScenePointer();
		event.preventDefault();
		event.stopPropagation();
	}

	function cancelScenePointer(event: PointerEvent) {
		if (scenePointerId !== event.pointerId) return;
		navSceneControls?.endDrag();
		try {
			(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		} catch {
			// Matching the guarded capture path above.
		}
		resetScenePointer();
		event.preventDefault();
		event.stopPropagation();
	}

	function sceneInputSurface(node: HTMLElement) {
		node.addEventListener('pointerdown', beginScenePointer);
		node.addEventListener('pointermove', moveScenePointer);
		node.addEventListener('pointerup', endScenePointer);
		node.addEventListener('pointercancel', cancelScenePointer);
		return {
			destroy() {
				node.removeEventListener('pointerdown', beginScenePointer);
				node.removeEventListener('pointermove', moveScenePointer);
				node.removeEventListener('pointerup', endScenePointer);
				node.removeEventListener('pointercancel', cancelScenePointer);
			}
		};
	}

	// ── Mobile pager ──────────────────────────────────────────────────────────
	// On a vertical phone the three columns (trait list · stage · leaderboard)
	// become full-width horizontal swipe pages under the pinned nav bar. Desktop
	// renders them as a 3-track grid and ignores all of this. The pattern mirrors
	// the proven nav carousel in SpiritWorldBoard: definite sizing, min-width:0,
	// scroll-snap, and a rAF-throttled scroll handler tracking the active page.
	const TRAITS_PAGE = 0;
	const STAGE_PAGE = 1;
	const LEADER_PAGE = 2;
	let isMobile = $state(false);
	let pagerEl = $state<HTMLDivElement | null>(null);
	let activePage = $state(STAGE_PAGE);
	let didInitPager = false;
	let pagerRaf = 0;

	$effect(() => {
		if (!browser) return;
		const mql = window.matchMedia('(max-width: 600px)');
		const sync = () => (isMobile = mql.matches);
		sync();
		mql.addEventListener('change', sync);
		return () => mql.removeEventListener('change', sync);
	});

	// Default page = STAGE (the middle). Jump there the first time the pager lays
	// out on mobile so the board — not the trait list — is shown first.
	$effect(() => {
		if (!isMobile || !pagerEl || didInitPager) return;
		didInitPager = true;
		activePage = STAGE_PAGE;
		pagerEl.scrollLeft = STAGE_PAGE * pagerEl.clientWidth;
	});

	function onPagerScroll() {
		if (pagerRaf || !pagerEl) return;
		pagerRaf = requestAnimationFrame(() => {
			pagerRaf = 0;
			const el = pagerEl;
			if (!el) return;
			const idx = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
			if (idx !== activePage && idx >= 0 && idx <= LEADER_PAGE) activePage = idx;
		});
	}

	function goToPage(i: number) {
		if (!isMobile || !pagerEl) return;
		pagerEl.scrollTo({ left: i * pagerEl.clientWidth, behavior: 'smooth' });
	}

	async function runAction(label: string, work: () => Promise<unknown>) {
		pendingAction = label;
		actionError = null;
		pulseHaptic('commit');
		try {
			await work();
		} catch (err) {
			pulseHaptic('error');
			actionError = err instanceof Error ? err.message : 'Action failed.';
		} finally {
			pendingAction = null;
		}
	}

	function send(label: string, command: GameCommand) {
		return runAction(label, () => sendPlayCommand(command));
	}

	// ── Navigation ─────────────────────────────────────────────────────────
	function handleSelectDestination(destination: NavigationDestination) {
		if (!canPickDestination) return;
		const seat = mySeat;
		// Clicking a location locks it in immediately; clicking the locked one unlocks.
		// Reflect the lock LOCALLY before the round-trip so the tap feels instant; the
		// authoritative /view reconciles over it and self-corrects on any divergence.
		if (lockedDestination === destination) {
			playSfx('nav-unlock');
			applyOptimistic((r) => {
				const p = seat ? r.players[seat] : null;
				if (p) p.pendingDestination = null;
				if (seat && r.navigation[seat]) r.navigation[seat].locked = false;
			});
			send('unlock', { type: 'unlockNavigation' });
		} else {
			playSfx('nav-lock');
			applyOptimistic((r) => {
				const p = seat ? r.players[seat] : null;
				if (p) p.pendingDestination = destination;
				if (seat && r.navigation[seat]) r.navigation[seat].locked = true;
			});
			send('lock', { type: 'lockNavigation', destination });
		}
	}

	// Navigation timeout is enforced SERVER-side (the SSE poll's deadline enforcement
	// reveals + advances exactly once). The client must NOT also send forceAdvancePhase
	// here: enforcement runs at the top of runRoomCommand, so a client force would land
	// on the already-advanced phase and skip a phase (it ate the whole location step).

	// ── Location actions ───────────────────────────────────────────────────
	// A location's interactions ARE its DB reward rows. Resolving one may grant a
	// summon (which drives its own DrawTray view via pendingDraw — that branch
	// takes UI precedence) or runes/potential/cultivate/rest (shown on the result
	// card). We set `reward` either way; the pendingDraw branch wins when present.
	async function resolveInteraction(
		rowIndex: number,
		choices: number[],
		costChoices: number[] = []
	) {
		if (busy) return;
		// The interaction card flips IN PLACE to show its result (no full-stage result
		// card) — we stay on the action grid to reduce friction. A summon row still
		// flows into the DrawTray (driven by pendingDraw, which takes view precedence).
		pendingAction = `row:${rowIndex}`;
		actionError = null;
		try {
			playSfx('ui-click');
			pulseHaptic('commit');
			await sendPlayCommand({ type: 'resolveLocationInteraction', rowIndex, choices, costChoices });
			activeAction = null;
		} catch (err) {
			pulseHaptic('error');
			actionError = err instanceof Error ? err.message : 'Action failed.';
		} finally {
			pendingAction = null;
		}
	}

	async function startCombat() {
		if (busy) return;
		pendingAction = 'combat';
		actionError = null;
		try {
			playSfx('combat-start');
			pulseHaptic('impact');
			await sendPlayCommand({ type: 'startCombat' });
			activeAction = 'combat';
		} catch (err) {
			pulseHaptic('error');
			actionError = err instanceof Error ? err.message : 'Action failed.';
		} finally {
			pendingAction = null;
		}
	}

	// Claim monster-kill rewards (Arcane Abyss). A picked summon flows into the
	// DrawTray (pendingDraw takes UI precedence); everything else shows the result
	// card. Mirrors resolveInteraction's draw-vs-result handling.
	async function claimReward(picks: number[], choices: number[]) {
		if (busy) return;
		const byIndex = new Map(
			buildMonsterRewards(myPlayer?.pendingReward?.rewardTrack ?? []).map((o) => [o.index, o])
		);
		const triggersDraw = picks.some((i) => {
			const e = byIndex.get(i)?.effect;
			return (
				e?.type === 'action' && (e.action === 'spiritWorldSummon' || e.action === 'abyssSummon')
			);
		});
		pendingAction = 'claim-reward';
		actionError = null;
		try {
			playSfx('reward-pick');
			pulseHaptic('success');
			await sendPlayCommand({ type: 'resolveMonsterReward', picks, choices });
			activeAction = triggersDraw ? null : 'reward';
		} catch (err) {
			pulseHaptic('error');
			actionError = err instanceof Error ? err.message : 'Action failed.';
		} finally {
			pendingAction = null;
		}
	}

	function continueAction() {
		// Dismissing a group-Encounter combat: remember it so the auto-surface effect
		// doesn't immediately re-open it (it lingers in room.combats all round).
		if (activeAction === 'combat' && myPvpCombat) seenPvpCombatId = myPvpCombat.id;
		activeAction = null;
	}

	function summonDraw(guid: string) {
		playSfx('summon-pick');
		send('summon', { type: 'spawnHandSpirit', guid });
	}
	function discardDraws() {
		playSfx('summon-discard');
		send('discard', { type: 'discardHandDraws' });
	}
	function redrawDraws() {
		playSfx('summon-draw');
		send('redraw', { type: 'redrawHandDraws' });
	}
	function awakenSpirit(slotIndex: number, discardRefs?: AwakenDiscardRef[]) {
		playSfx('awaken');
		send('awaken', { type: 'awakenSpirit', slotIndex, discardRefs });
	}
	function infiltratorSwap(
		swaps: { targetSeat: SeatColor; myInstanceId: string; theirInstanceId: string }[]
	) {
		send('infiltrator-swap', { type: 'infiltratorSwap', swaps });
	}
	// Scout-inspector discard (CompositionStage) — single, immediate.
	function discardSpirit(slotIndex: number) {
		send('discard-spirit', { type: 'discardSpirit', slotIndex });
	}
	// W2c staged batches: the commit bar confirms N discards at once. Sent
	// SEQUENTIALLY (each awaited) so the reducer sees them in pick order and the
	// obligation count decrements deterministically.
	function discardSpirits(slotIndexes: number[]) {
		return runAction('discard-spirits', async () => {
			for (const slotIndex of slotIndexes) {
				await sendPlayCommand({ type: 'discardSpirit', slotIndex });
			}
		});
	}
	function discardRunes(slotIndexes: number[]) {
		return runAction('discard-runes', async () => {
			for (const slotIndex of slotIndexes) {
				await sendPlayCommand({ type: 'discardRune', slotIndex });
			}
		});
	}
	function resolveDecision(decisionId: string, optionId: string, selectedInstanceIds?: string[]) {
		send('resolve-decision', {
			type: 'resolveDecision',
			decisionId,
			optionId,
			...(selectedInstanceIds ? { selectedInstanceIds } : {})
		});
	}
	function dismissManual(id: string) {
		send('dismiss-manual', { type: 'dismissManualPrompt', id });
	}
	// Awaken-sourced manual prompt confirmed: the server contract is manualAwaken
	// (flip the spirit face-up AND clear the prompt) — dismissManualPrompt alone
	// would clear the reminder while leaving the spirit face-down.
	function confirmManualAwaken(slotIndex: number) {
		send('manual-awaken', { type: 'manualAwaken', slotIndex });
	}
	function grantDebug(
		grant: import('$lib/play/types').DebugGrant,
		seatColor?: import('$lib/play/types').SeatColor
	) {
		send('debug', { type: 'debugGrant', grant, ...(seatColor ? { seatColor } : {}) });
	}
	function placeAugment(
		augmentIndex: number,
		augmentRuneId: string,
		spiritSlotIndex: number,
		className?: string
	) {
		send('place-augment', {
			type: 'placeAugmentOnSpirit',
			augmentIndex,
			augmentRuneId,
			spiritSlotIndex,
			className
		});
	}
	// Finish placing — forfeit any augments that can't (or won't) be placed so the
	// optional placement step never blocks the turn.
	function discardAugments() {
		playSfx('ui-click');
		send('discard-augments', { type: 'discardUnplacedAugments' });
	}
	// Cast this Evil player's vote to attack the Good players sharing the location.
	// The group strike fires once every co-located Evil player has agreed (engine-side).
	function attackGroup() {
		playSfx('pvp-initiate');
		send('pvp', { type: 'initiatePvp' });
	}
	// Hold / decline the encounter (an Evil decline cancels the group attack here).
	function holdEncounter() {
		playSfx('ui-click');
		send('pass', { type: 'passEncounter' });
	}
	// Claim the Cursed Spirit Awakening-Phase rewards (Cleanup). `taintedMaxBarrier` =
	// units of the Tainted line taken as potential (the rest become Enchanted Attack).
	function claimAwakenReward(taintedMaxBarrier: number, relicPicks: number[]) {
		playSfx('reward-pick');
		send('awaken-reward', { type: 'resolveAwakenReward', taintedMaxBarrier, relicPicks });
	}

	// Held runes/relics over the carry limit must be discarded before cleanup can end.
	const runeOverflow = $derived(
		(myPlayer?.mats ?? []).filter((r) => r.hasRune).length > RUNE_CARRY_LIMIT
	);

	const infoContext = $derived.by<InfoContextKey>(() => {
		if (room.status === 'finished') return 'postgame';
		if (bagOpen) return 'bags';
		if (settingsOpen) return 'settings';
		if (isMobile && activePage === TRAITS_PAGE) return 'traits';
		if (isMobile && activePage === LEADER_PAGE) return 'players';
		if (!mySeat) return 'spectator';
		if (viewedSeat) return 'composition';
		if (navView === 'reveal') return 'destinationReveal';
		if (navView === 'enter') return 'realmEntry';
		if (navOpen) return myConfirmedDestination ? 'destinationLocked' : 'navigation';

		const pendingCorruptionDiscard = (myPlayer?.pendingCorruptionDiscard?.count ?? 0) > 0;
		const pendingAugments = (myPlayer?.unplacedAugments?.length ?? 0) > 0;
		const pendingDecisions = (myPlayer?.pendingDecisions?.length ?? 0) > 0;
		if (activeAction !== 'combat' && pendingCorruptionDiscard) return 'corruptionDiscard';
		if (activeAction !== 'combat' && pendingAugments) return 'augmentPlacement';
		if (
			activeAction !== 'combat' &&
			(room.phase === 'location' || room.phase === 'encounter') &&
			pendingDecisions
		) {
			return 'abilityDecision';
		}

		if (room.phase === 'encounter') return myPlayer?.phaseReady ? 'waiting' : 'encounter';
		if (room.phase === 'location') {
			if (myPlayer?.pendingDraw) return 'draw';
			if (activeAction === 'combat') return myPlayer?.pendingReward ? 'reward' : 'combat';
			if (myPlayer?.pendingReward) return 'reward';
			if (activeAction === 'rest' || activeAction === 'cultivate' || activeAction === 'reward') {
				return 'actionResult';
			}
			if (myPlayer?.phaseReady) return 'waiting';
			if (myPlayer?.navigationDestination === 'Arcane Abyss') return 'abyssActions';
			return 'locationActions';
		}
		if (room.phase === 'benefits') return myPlayer?.phaseReady ? 'waiting' : 'benefits';
		if (room.phase === 'awakening') return myPlayer?.phaseReady ? 'waiting' : 'awakening';
		if (room.phase === 'cleanup') {
			if (runeOverflow) return 'runeCleanup';
			return myPlayer?.phaseReady ? 'waiting' : 'cleanup';
		}
		return 'overview';
	});

	// ── "Pass turn" — the single per-phase "I'm done" control ───────────────
	// An Evil player being offered the encounter Attack/Hold decision (co-located Good
	// targets, not yet voted). They decline via MainStage's "Hold", so we suppress the
	// generic footer "Pass turn" for them — otherwise two different controls both
	// decline the group attack, which is ambiguous and accident-prone.
	const amUndecidedAggressor = $derived(
		!!mySeat &&
			room.phase === 'encounter' &&
			!myPlayer?.phaseReady &&
			isEvilAlignment(myPlayer?.statusLevel ?? 0) &&
			myPlayer?.navigationDestination != null &&
			myPlayer?.navigationDestination !== 'Arcane Abyss' &&
			room.activeSeats.some(
				(s) =>
					s !== mySeat &&
					room.players[s]?.navigationDestination === myPlayer?.navigationDestination &&
					!isEvilAlignment(room.players[s]?.statusLevel ?? 0)
			)
	);
	// View-state gates the engine can't know about (profile browsing, an open result
	// card, the encounter Attack/Hold fork, a staging takeover).
	const passViewGates = $derived(
		!!mySeat &&
			!viewingProfile &&
			room.status === 'active' &&
			!myPlayer?.phaseReady &&
			!myPlayer?.pendingDraw &&
			!myPlayer?.pendingReward &&
			!myPlayer?.pendingAwakenReward &&
			activeAction === null &&
			!amUndecidedAggressor &&
			!(room.phase === 'cleanup' && runeOverflow) &&
			// Corruption is a cleanup-only ritual: it blocks ending the round (cleanup)
			// until resolved, but a corrupted player can still finish location/encounter
			// at low health and REACH cleanup (no location/encounter deadlock).
			!(room.phase === 'cleanup' && myPlayer?.pendingCorruptionDiscard) &&
			(room.phase === 'location' ||
				room.phase === 'benefits' ||
				room.phase === 'awakening' ||
				room.phase === 'cleanup' ||
				room.phase === 'encounter')
	);
	// The RULES verdict comes from the engine when available (F3: the client no
	// longer re-derives phase legality and misses cases like a location-phase
	// corruption discard). Without affordances, keep the legacy client guess.
	const canPassTurn = $derived(
		passViewGates && !stageTakeoverOpen && (myAffordances ? myAffordances.canPass : true)
	);
	// Why the pass control is parked (spec §5.4 passBlockedReason once the engine
	// ships it; the takeover reason is client view-state).
	const passBlockedReason = $derived.by(() => {
		if (!passViewGates) return null;
		if (stageTakeoverOpen) return 'Finish or cancel the current action';
		if (myAffordances && !myAffordances.canPass) {
			return myAffordances.passBlockedReason ?? myAffordances.pendingWork[0]?.label ?? null;
		}
		return null;
	});
	function passTurn() {
		playSfx('ui-click');
		if (room.phase === 'location') send('end', { type: 'endLocationActions' });
		else if (room.phase === 'benefits') send('benefits', { type: 'commitBenefits' });
		else if (room.phase === 'awakening') send('awakening', { type: 'commitAwakening' });
		else if (room.phase === 'cleanup') send('cleanup', { type: 'commitCleanup' });
		else if (room.phase === 'encounter') send('pass', { type: 'passEncounter' });
	}
	// All six REAL engine phases — one rail node each, so the lit node/label is the
	// true phase (Benefits/Awakening no longer read as "Cleanup"). Matches PhaseBar.
	const PHASE_RAIL_STEPS = GAME_PHASES.map((p) => ({ key: p, label: PHASE_LABELS[p] }));
	const railPhaseIndex = $derived(Math.max(0, GAME_PHASES.indexOf(room.phase)));
	const railPhaseLabel = $derived(PHASE_RAIL_STEPS[railPhaseIndex]?.label ?? 'Navigation');
	const railProgressPct = $derived(
		PHASE_RAIL_STEPS.length <= 1 ? 100 : (railPhaseIndex / (PHASE_RAIL_STEPS.length - 1)) * 100
	);
	// Phase-aware label for the single "I'm done" footer control.
	const passLabel = $derived(
		room.phase === 'benefits'
			? 'Continue →'
			: room.phase === 'awakening'
				? 'Done awakening →'
				: room.phase === 'cleanup'
					? 'Pass turn'
					: 'Pass turn'
	);
	function forceAdvance() {
		send('force', { type: 'forceAdvancePhase' });
	}

	// ── Resolution sequence (benefits → awakening → cleanup) ───────────────────
	// The ENGINE now auto-readies any seat with nothing to do in these steps and
	// collapses the whole sequence server-side when that's everyone (phases.ts
	// seatHasResolutionWork / autoAdvanceResolution). The client never needs to
	// rubber-stamp empty steps: a player with no resolution work arrives already
	// phaseReady and simply idles on the stable "Waiting for Players." view until
	// the round rolls over; a player WITH work still gets that step's UI.

	// ── Location auto-pass ───────────────────────────────────────────────────
	// Combat is once per round (plus any extra-action credits).
	const myCombatUsed = $derived.by(() => {
		const used = (myPlayer?.actionsUsedThisRound ?? []).filter((a) => a === 'combat').length;
		return used >= 1 + (myPlayer?.extraActions?.combat ?? 0);
	});
	// True while the player's location still has SOMETHING to show — any unused, non-text
	// interaction row (affordable or NOT), a pending draw/reward, or an unfought monster.
	// Auto-pass keys off the ABSENCE of this, so we never silently skip a location while
	// the player could still see/consider an interaction. Affordability is intentionally
	// NOT a factor: the menu renders an unaffordable trade as a greyed "Can't afford" card,
	// and hiding the whole location (so the player "couldn't do anything") was the bug.
	const hasLocationContent = $derived.by(() => {
		const dest = myPlayer?.navigationDestination ?? null;
		if (room.phase !== 'location' || !myPlayer || !dest) return false;
		if (myPlayer.pendingDraw || myPlayer.pendingReward) return true; // must resolve these
		if (getLocationConfig(dest)?.combatOnly) return !myCombatUsed; // can still fight
		const loc = assets.gameLocations.get(dest) ?? null;
		return buildLocationInteractions(loc?.reward_rows).some(
			(it) => !(myPlayer.actionsUsedThisRound ?? []).includes(`row:${it.rowIndex}`)
		);
	});
	const hasManualPrompts = $derived(
		(myPlayer?.manualPrompts?.length ?? 0) > 0 || (myPlayer?.pendingDecisions?.length ?? 0) > 0
	);
	// A single STABLE boolean: true once there's nothing left to do at the location.
	// The auto-pass effect depends ONLY on this, so realtime polls (which hand us a
	// fresh room/myPlayer object every tick) don't re-run the effect and cancel its
	// timer — it re-runs only when readiness actually flips.
	// Gated on revealSeq==='idle' so a no-action location is NOT silently auto-passed
	// while the reveal → realm-enter choreography is still playing over the hidden stage
	// (otherwise the player never sees their location — the original "skipped" symptom).
	const shouldAutoPassLocation = $derived(
		revealSeq === 'idle' &&
			room.phase === 'location' &&
			canPassTurn &&
			!busy &&
			!hasLocationContent &&
			!hasManualPrompts
	);
	// Pass for the player after a short beat (so a just-flipped result card is read).
	let locationPassTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const ready = shouldAutoPassLocation;
		if (locationPassTimer !== null) {
			clearTimeout(locationPassTimer);
			locationPassTimer = null;
		}
		if (!ready) return;
		locationPassTimer = setTimeout(() => {
			locationPassTimer = null;
			passTurn(); // → endLocationActions
		}, 1300);
		return () => {
			if (locationPassTimer !== null) {
				clearTimeout(locationPassTimer);
				locationPassTimer = null;
			}
		};
	});
</script>

<svelte:window onkeydown={onSplatFlyKey} />

<div class="tft" class:scene-capture={sceneInputActive}>
	<!-- ── Splat world: blurred, vignetted live background behind everything ── -->
	<!-- Skipped on metered/slow/Data-Saver connections; board remains fully playable
	     with the radial-gradient base background defined on .tft in this file. -->
	{#if showSplat}
		<div
			class="splat-layer"
			class:fly={flyMode}
			class:in-realm={inRealm}
			class:diving={revealSeq === 'enter'}
		>
			<SplatBackground
				src={splatSrc}
				blur={splatBlur}
				push={splatPush}
				controls={flyMode}
				onZoomSettled={() => {
					// The dolly reaches push≈1 both on the 'enter' beat and when entering
					// 'realm' directly; only the 'enter' beat consumes it (then hands off to
					// idle → the location stage un-gates).
					if (revealSeq === 'enter') finishEnterStage();
				}}
			/>
		</div>
	{/if}

	<div
		class="scene-input"
		class:active={sceneInputActive}
		aria-hidden="true"
		data-testid="scene-input"
		use:sceneInputSurface
	></div>

	<!-- ── Floating HUD stack: the splat owns the full viewport, while traits, stage,
	     leaderboard, controls and the phase rail float above it. Transparent HUD gaps
	     fall through to the full-screen scene input during navigation. ── -->
	<div class="shell">
		<!-- ── Nav bar: round/phase/timer (centered) + game controls (right) ── -->
		<header class="nav-bar">
			<div class="nav-center">
				<!-- Two versions of the top bar: the full phase tracker (round + all four
				     phases with the current one lit + the navigation timer) on desktop/large
				     screens; the compact banner on narrow/phone screens. -->
				<div class="nav-full">
					<PhaseBar
						phase={room.phase}
						round={room.round}
						revealedDestinations={room.revealedDestinations}
						navigationDeadline={room.navigationDeadline}
					/>
				</div>
				<div class="nav-mini">
					<RoundBanner
						phase={room.phase}
						round={room.round}
						revealedDestinations={room.revealedDestinations}
						navigationDeadline={room.navigationDeadline}
					/>
				</div>
			</div>
			<div class="nav-controls">
				<button
					type="button"
					class="ghost-btn icon-btn"
					data-testid="toggle-info"
					aria-label="Icon guide"
					title="Icon guide — what the icons mean"
					onclick={() => (infoOpen = true)}
				>
					<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7" />
						<circle cx="12" cy="8" r="1.15" fill="currentColor" />
						<path
							d="M12 11.2v5.2"
							stroke="currentColor"
							stroke-width="1.9"
							stroke-linecap="round"
						/>
					</svg>
				</button>
				<button
					type="button"
					class="ghost-btn icon-btn chat-toggle"
					data-testid="toggle-chat"
					aria-label="Room chat"
					title="Room chat"
					onclick={() => (chatOpen = true)}
				>
					<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<path
							d="M5 6.5h14v8H9l-4 3.5V6.5z"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linejoin="round"
						/>
						<path
							d="M8 10h8M8 12.8h5"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
						/>
					</svg>
					{#if playState.chatUnread > 0}
						<span class="chat-badge" data-testid="chat-unread">{Math.min(playState.chatUnread, 9)}</span>
					{/if}
				</button>
				<div class="settings-wrap">
					<button
						type="button"
						class="ghost-btn icon-btn"
						data-testid="toggle-settings"
						aria-haspopup="menu"
						aria-expanded={settingsOpen}
						aria-label="Settings"
						title="Settings"
						onclick={() => (settingsOpen = !settingsOpen)}
					>
						<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<path
								d="M4 7h8M16 7h4M4 12h4M12 12h8M4 17h11M19 17h1"
								stroke="currentColor"
								stroke-width="1.7"
								stroke-linecap="round"
							/>
							<circle cx="14" cy="7" r="2.1" stroke="currentColor" stroke-width="1.7" />
							<circle cx="10" cy="12" r="2.1" stroke="currentColor" stroke-width="1.7" />
							<circle cx="17" cy="17" r="2.1" stroke="currentColor" stroke-width="1.7" />
						</svg>
					</button>

					{#if settingsOpen}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<button
							type="button"
							class="settings-backdrop"
							aria-label="Close settings"
							onclick={() => (settingsOpen = false)}
						></button>
						<div class="settings-panel" role="menu" data-testid="settings-panel">
							<span class="settings-title">Settings</span>
							<button
								type="button"
								class="settings-item"
								role="menuitem"
								data-testid="toggle-bags"
								onclick={() => {
									settingsOpen = false;
									bagOpen = true;
								}}
							>
								Spirit bags
							</button>
							<button
								type="button"
								class="settings-item"
								role="menuitem"
								onclick={() => toggleAudioMuted()}
							>
								{audioState.muted ? 'Unmute audio' : 'Mute audio'}
							</button>
							<div class="settings-control">
								<SplatQualityControl />
							</div>
							{#if isHost && room.status === 'active'}
								<button
									type="button"
									class="settings-item"
									role="menuitem"
									data-testid="force-phase"
									disabled={busy}
									onclick={() => {
										settingsOpen = false;
										forceAdvance();
									}}
								>
									Force phase ▶
								</button>
							{/if}
							{#if room.mode === 'ranked' && room.status === 'active' && mySeat}
								<button type="button" class="settings-item danger" role="menuitem"
									data-testid="concede-ranked" disabled={busy} onclick={concedeRankedSeat}>
									{concedeArmed ? 'Confirm concede — irreversible' : 'Concede ranked seat'}
								</button>
							{/if}
							<a class="settings-item" href="/play" role="menuitem" data-testid="exit-game"
								>Exit Game</a
							>
						</div>
					{/if}
				</div>
			</div>
		</header>

		<GameChat variant="drawer" open={chatOpen} onClose={() => (chatOpen = false)} />

		<div class="phase-rail" aria-label="Round {room.round}, {railPhaseLabel}">
			<div class="phase-rail-inner">
				<span class="rail-round">Round {room.round}</span>
				<div class="rail-track" aria-hidden="true">
					<span class="rail-fill" style="height: {railProgressPct}%"></span>
					{#each PHASE_RAIL_STEPS as step, i (step.key)}
						<span class="rail-node" class:active={i === railPhaseIndex}></span>
					{/each}
				</div>
				<span class="rail-phase">{railPhaseLabel}</span>
			</div>
		</div>

		<!-- Icon guide — a full-screen reference of the game's icons and action types. -->
		{#if infoOpen}
			<InfoLegend {assets} context={infoContext} onClose={() => (infoOpen = false)} />
		{/if}

		<!-- ── Pager: trait list · stage · players. Grid on desktop, swipe on phone. ── -->
		<div class="pager" bind:this={pagerEl} onscroll={onPagerScroll}>
			<!-- LEFT — trait list (reflects the scouted player while scouting). The
			     rune/relic carry slots sit as a row directly above it. -->
			<div class="trait-col">
				<div class="trait-center">
					{#if traitPlayer}
						<div class="rune-row">
							<MatSlots player={traitPlayer} {assets} orientation="row" />
						</div>
					{/if}
					<div class="trait-host"><TraitTracker player={traitPlayer} {assets} /></div>
				</div>
			</div>

			<!-- CENTER — the main stage (or a player's 7-hex composition), strictly
			     clipped so it can never spill outside this cell. Pass-turn lives in the
			     stage footer below it. -->
			<div class="stage-cell" bind:this={stageCellEl}>
				<div class="stage-main">
					{#if viewedSeat}
						<CompositionStage
							{room}
							{viewedSeat}
							{mySeat}
							{assets}
							{spiritImages}
							{busy}
							onDiscardSpirit={discardSpirit}
							onPlaceAugment={placeAugment}
						/>
					{:else}
						<MainStage
							{room}
							{mySeat}
							{myPlayer}
							{assets}
							{spiritImages}
							{activeAction}
							canPick={canPickDestination}
							{lockedDestination}
							confirmedDestination={myConfirmedDestination}
							onExitConfirmed={() => send('unlock', { type: 'unlockNavigation' })}
							{inRealm}
							holdRealmEntry={navView === 'reveal' || navView === 'enter'}
							focusedDestination={browseFocus}
							onHoverDestination={(d) => {
								if (d && d !== hoveredDestination) playSfx('nav-hover', { volume: 0.4 });
								hoveredDestination = d;
							}}
							onSelectDestination={handleSelectDestination}
							onResolveInteraction={resolveInteraction}
							onStartCombat={startCombat}
							onClaimReward={claimReward}
							onSummon={summonDraw}
							onDiscard={discardDraws}
							onRedraw={redrawDraws}
							onContinue={continueAction}
							onAwaken={awakenSpirit}
							onDiscardRunes={discardRunes}
							onInfiltratorSwap={infiltratorSwap}
							onAttackGroup={attackGroup}
							onPass={holdEncounter}
							onClaimAwakenReward={claimAwakenReward}
							onResolveDecision={resolveDecision}
							onDismissManual={dismissManual}
							onConfirmManualAwaken={confirmManualAwaken}
							onPlaceAugment={placeAugment}
							onDiscardAugments={discardAugments}
							onDiscardSpirits={discardSpirits}
							onSceneControls={(controls) => (navSceneControls = controls)}
							{busy}
							seatAffordances={myAffordances}
							onTakeoverOpenChange={(open) => (stageTakeoverOpen = open)}
						/>
					{/if}
				</div>
				<!-- Pass-turn: the single per-phase "I'm done" control, in the stage footer.
				     When the engine says passing is illegal (or a takeover is staging), the
				     button parks disabled WITH the reason instead of inviting a rejection. -->
				<div class="stage-foot">
					{#if canPassTurn}
						<button
							type="button"
							class="pass-btn"
							data-testid="pass-turn"
							disabled={busy}
							onclick={passTurn}
						>
							{passLabel}
						</button>
					{:else if passBlockedReason}
						<span class="pass-blocked" data-testid="pass-blocked">
							<button type="button" class="pass-btn" disabled title={passBlockedReason}>
								{passLabel}
							</button>
							<span class="pass-blocked-reason">{passBlockedReason}</span>
						</span>
					{:else if !viewingProfile && mySeat && room.status === 'active' && myPlayer?.phaseReady && room.phase !== 'navigation'}
						<span class="pass-waiting" data-testid="pass-waiting">Ready ✓ — waiting…</span>
					{/if}
				</div>
			</div>

			<!-- RIGHT — player list (leaderboard). -->
			<div class="players-col">
				<Leaderboard {room} {mySeat} {assets} activeSeat={viewedSeat} onSelectSeat={scoutSeat} />
			</div>
		</div>

		<!-- ── Page dots (mobile only): Traits · Stage · Leaderboard. ── -->
		<div class="page-dots" role="tablist" aria-label="Pages">
			<button
				type="button"
				class="page-dot"
				class:active={activePage === TRAITS_PAGE}
				role="tab"
				aria-selected={activePage === TRAITS_PAGE}
				aria-label="Traits"
				onclick={() => goToPage(TRAITS_PAGE)}
			>
				<span class="dot-mark"></span>
			</button>
			<button
				type="button"
				class="page-dot"
				class:active={activePage === STAGE_PAGE}
				role="tab"
				aria-selected={activePage === STAGE_PAGE}
				aria-label="Stage"
				onclick={() => goToPage(STAGE_PAGE)}
			>
				<span class="dot-mark"></span>
			</button>
			<button
				type="button"
				class="page-dot"
				class:active={activePage === LEADER_PAGE}
				role="tab"
				aria-selected={activePage === LEADER_PAGE}
				aria-label="Leaderboard"
				onclick={() => goToPage(LEADER_PAGE)}
			>
				<span class="dot-mark"></span>
			</button>
		</div>
	</div>

	<!-- ── Overlays: transient modals / FX above the frame ─────────────────── -->

	<!-- ── "Entering the realm" flourish: iris sweep + title over the dolly-in ──
	     Stage 'enter' of the choreography — runs only after the reveal is dismissed. -->
	{#if revealSeq === 'enter' && enteredRealm}
		{@const enterAccent = LOCATION_ACCENT[enteredRealm as NavigationDestination] ?? '#8d8aa1'}
		<!-- Portal dive: a world-filled circle blooms from the navigator's centre out to
		     fill the screen — "jumping into the hole" of the world you locked in. A dark
		     veil retracts through a growing circular window onto the splat (which sharpens
		     and dollies in beneath it), so the picked world engulfs the view. When the dive
		     completes it hands off to the realm (HUD rises); the fallback timer +
		     onZoomSettled still guarantee the handoff if the animation event is missed. -->
		<div
			class="portal-dive"
			style="--accent: {enterAccent}; --cx: {portal.cx}px; --cy: {portal.cy}px; --hole0: {portal.hole0}px; --coverR: {portal.coverR}px;"
			aria-hidden="true"
		>
			<div class="portal-veil" onanimationend={() => finishEnterStage()}></div>
		</div>
		<!-- "Entering {Realm}" title rides above the dive. -->
		<div class="realm-enter" style="--accent: {enterAccent}" aria-hidden="true">
			<div class="realm-enter-label">
				<span class="realm-enter-eyebrow">Entering</span>
				<span class="realm-enter-name">{enteredRealm}</span>
			</div>
		</div>
	{/if}

	<!-- ── Destination reveal: who went where. Its own beat, right after the
	     confirmation panel; rendered from a frozen occupancy snapshot so it can't
	     blank, and on close it hands off to the realm-enter zoom. ── -->
	{#if revealSeq === 'reveal' || forceDestinationReveal}
		<DestinationReveal
			{room}
			{assets}
			occupancy={forceDestinationReveal ? room.locationOccupancy : revealOccupancy}
			autoCloseMs={forceDestinationReveal ? 0 : 4500}
			onClose={closeReveal}
		/>
	{/if}

	{#if showStartCutscene && myPlayer}
		<GameStartCutscene
			spirits={myPlayer.spirits}
			{spiritImages}
			guardianName={myGuardianName}
			guardianIcon={myGuardianIcon}
			accent={mySeat ? seatAccent(mySeat) : '#ff2bc7'}
			durationMs={forceStartCutscene ? 60_000 : undefined}
			onDone={() => (showStartCutscene = false)}
		/>
	{/if}

	{#if bagOpen}
		<BagViewer {room} {spiritImages} onClose={() => (bagOpen = false)} />
	{/if}
	{#if !e2eMode && room.status === 'active' && mySeat}
		<GuidedCoach
			phase={room.phase}
			mode={room.mode ?? 'casual'}
			pendingKind={guidePendingKind}
			{lockedDestination}
		/>
	{/if}

	{#if actionError}<div class="error">{actionError}</div>{/if}
	{#if room.status === 'finished'}
		<PostGameView {room} {mySeat} {assets} {spiritImages} />
	{/if}

	<!-- Spirit/ability interactions (decision cards, corruption discard, Spirit Augment
	     placement) are NOT floating overlays — they render IN-STAGE inside MainStage's
	     view (replacing the stage content), like the Spirit Summon tray. See MainStage. -->

	<!-- Persistent summon FX (sparkle bursts + spirits flying into the tableau).
	     Lives here so the flight finishes even after the draw tray unmounts. -->
	<SummonFxLayer />

	<!-- Dev-only god-mode panel: give yourself any spirit/rune/augment/dice/etc.
	     The debugGrant command is server-gated to dev builds; this never ships. -->
	{#if dev && mySeat}
		<DebugPanel {room} {mySeat} {assets} {busy} onGrant={grantDebug} />
	{/if}
</div>

<style>
	.tft {
		position: absolute;
		inset: 0;
		overflow: hidden;
		overscroll-behavior: none;
		background: radial-gradient(circle at 50% 0%, #160a2e 0%, var(--color-void, #0c0518) 70%);

		--hud-safe-l: env(safe-area-inset-left, 0px);
		--hud-safe-r: env(safe-area-inset-right, 0px);
		--hud-safe-t: env(safe-area-inset-top, 0px);
		--hud-safe-b: env(safe-area-inset-bottom, 0px);
		--hud-pad-x: clamp(8px, 1.4vw, 14px);
		--hud-pad-y: clamp(6px, 1.2vh, 10px);
		--hud-gap: clamp(6px, 1.2vw, 12px);
		--hud-left-w: max-content;
		--hud-right-w: 179px;
		--hud-rail-content-w: 44px;
		--left-w: var(--hud-left-w);
		--right-w: var(--hud-right-w);
	}

	/* ── Floating HUD frame ─────────────────────────────────────────────────
	   The splat scene owns the viewport; this shell is only the overlaid HUD stack. */
	.shell {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: block;
		pointer-events: none;
		overscroll-behavior: none;
	}

	/* Splat background sits behind the frame (and the live world reads through). */
	.splat-layer {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}
	.scene-input {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
		touch-action: none;
		-webkit-tap-highlight-color: transparent;
	}
	.scene-input.active {
		pointer-events: auto;
		cursor: grab;
	}
	.scene-input.active:active {
		cursor: grabbing;
	}
	/* Fly mode (authoring): bring the splat above the frame and make it
	   interactive so it can capture the pointer for mouse-look. */
	.splat-layer.fly {
		z-index: 100;
		pointer-events: auto;
	}
	/* Realm-enter dive: lift the world ABOVE the frame so the portal veil's growing
	   window reveals ONLY the splat — otherwise the transparent hole would expose the
	   trait list / leaderboard / nav bar (z 1) that sit between the splat and the veil.
	   Dropped back to z 0 on handoff to the realm, where the HUD must sit over the world
	   again. Still below the veil (z 14) and title (z 15). */
	.splat-layer.diving {
		z-index: 13;
	}

	/* ── Realm-enter dive ("jumping into the hole") ───────────────────────────
	   A dark veil over the whole frame with a circular window punched at the
	   navigator's centre; the window grows from the "Going to" circle's size out
	   past the screen, revealing the splat world (which sharpens + dollies in
	   beneath). Above it the title rises, holds and lifts away — together they
	   cover the carousel→HUD swap. pointer-events:none so nothing eats clicks. */

	/* Registered so the gradient's hole radius can be ANIMATED (a plain custom
	   property can't tween). Modern-browser feature; matches the WebGL splat baseline. */
	@property --hole {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}
	.portal-dive {
		position: absolute;
		inset: 0;
		z-index: 14;
		pointer-events: none;
		overflow: hidden;
	}
	/* Dark void with a transparent circular window at (--cx,--cy). A bright accent rim
	   rides the window edge (the portal mouth). The window radius (--hole) tweens from
	   the confirm circle's size out to --coverR, then the veil fades so the now-sharp
	   realm shows through cleanly. */
	.portal-veil {
		position: absolute;
		inset: 0;
		--hole: var(--hole0);
		background: radial-gradient(
			circle at var(--cx) var(--cy),
			transparent 0 var(--hole),
			color-mix(in srgb, var(--accent) 60%, transparent) var(--hole),
			color-mix(in srgb, var(--accent) 18%, rgba(6, 4, 15, 0.97)) calc(var(--hole) + 4px),
			rgba(6, 4, 15, 0.97) calc(var(--hole) + 26px)
		);
		animation: portal-dive 1100ms cubic-bezier(0.5, 0, 0.75, 0.3) forwards;
	}
	@keyframes portal-dive {
		0% {
			--hole: var(--hole0);
			opacity: 1;
		}
		68% {
			opacity: 1;
		}
		100% {
			--hole: var(--coverR);
			opacity: 0;
		}
	}
	.realm-enter {
		position: absolute;
		inset: 0;
		z-index: 15;
		display: grid;
		place-items: center;
		pointer-events: none;
		overflow: hidden;
	}
	.realm-enter-label {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		text-align: center;
		animation: realm-title 1100ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
	}
	.realm-enter-eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.42em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 75%, #fff);
		text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 70%, transparent);
	}
	.realm-enter-name {
		font-family: var(--font-display);
		font-size: clamp(2.4rem, 6vw, 4.6rem);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		line-height: 1;
		color: #fff;
		text-shadow:
			0 0 30px color-mix(in srgb, var(--accent) 80%, transparent),
			0 4px 24px rgba(0, 0, 0, 0.6);
	}
	@keyframes realm-title {
		0% {
			opacity: 0;
			transform: translateY(26px) scale(0.94);
			filter: blur(8px);
		}
		28% {
			opacity: 1;
			transform: translateY(0) scale(1);
			filter: blur(0);
		}
		74% {
			opacity: 1;
			transform: translateY(0) scale(1);
			filter: blur(0);
		}
		100% {
			opacity: 0;
			transform: translateY(-22px) scale(1.04);
			filter: blur(6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.portal-veil {
			animation: none;
			opacity: 0;
		}
		.realm-enter-label {
			animation-duration: 1ms;
		}
	}

	/* ── Nav bar: slim bounded bar across the top. RoundBanner centered, game
	   controls (bags + settings) to the right. ── */
	.nav-bar {
		position: absolute;
		inset: 0 0 auto;
		z-index: 20;
		display: flex;
		/* Top-align so the banner pill hangs flush from the very top edge (no gap). */
		align-items: flex-start;
		gap: 0.75rem;
		min-height: 52px;
		padding: 0 0.75rem 0.45rem;
		pointer-events: none;
		/* Ethereal: only the faintest top-edge wash so the bar fades into the board
		   rather than sitting on a heavy dark slab. */
		background: linear-gradient(180deg, rgba(10, 7, 20, 0.28), transparent);
	}
	/* The RoundBanner self-positions absolute by default (it's normally a free
	   floating element); inside the bar we host it inline, centered. */
	.nav-center {
		flex: 1 1 auto;
		display: flex;
		justify-content: center;
		min-width: 0;
	}
	/* Two top-bar versions. Phone/narrow shows the compact banner; desktop (the grid
	   layout, ≥601px) shows the full phase tracker instead. Both mount; only one shows. */
	.nav-full {
		display: none;
	}
	.nav-mini {
		display: flex;
		flex: 1;
		min-width: 0;
		justify-content: center;
	}
	@media (min-width: 601px) {
		.nav-full {
			display: flex;
			flex: 1;
			min-width: 0;
			justify-content: center;
		}
		.nav-mini {
			display: none;
		}
	}
	.nav-center :global(.banner) {
		position: static;
		transform: none;
		left: auto;
	}
	/* Re-anchor the banner's drop-in animation now that it isn't absolutely
	   centered (the keyframes translate -50%/-100% for the old anchor). */
	.nav-center :global(.banner),
	.nav-center :global(.banner.urgent) {
		animation: nav-banner-drop 520ms cubic-bezier(0.22, 1.2, 0.36, 1) both;
	}
	@keyframes nav-banner-drop {
		from {
			transform: translateY(-100%);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.nav-center :global(.banner),
		.nav-center :global(.banner.urgent) {
			animation: none;
		}
	}
	/* Controls float at the right edge, OUT of flow, so they never shrink the
	   centring region of the banner (which would shove it off-centre). */
	.nav-controls {
		position: absolute;
		top: 0;
		bottom: 0;
		right: 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		z-index: 21;
		pointer-events: auto;
	}
	.shell :global(.legend-backdrop) {
		pointer-events: auto;
	}

	/* ── HUD body: floating trait list · stage · players over the full scene. ── */
	.pager {
		position: absolute;
		inset: 0;
		z-index: 2;
		min-height: 0;
		display: grid;
		grid-template-columns: var(--left-w, 336px) minmax(0, 1fr) var(--right-w, 280px);
		gap: 12px;
		/* Extra horizontal inset gives the columns' glow/aura bleed somewhere to land before
		   the frame's overflow:hidden clips it. */
		padding: 60px 18px 8px;
		align-items: stretch;
		box-sizing: border-box;
		overflow: hidden;
		overscroll-behavior: none;
		pointer-events: none;
	}
	/* Right HUD scrolls vertically over the live world (no panel chrome). The trait
	   column does NOT scroll as a whole: its rune/relic row stays pinned and only the
	   TraitTracker beneath it owns vertical scrolling. */
	.players-col {
		min-height: 0;
		overflow-y: auto;
		overflow-x: clip;
		overflow-clip-margin: 22px;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
		scrollbar-width: none;
		pointer-events: none;
	}
	.players-col::-webkit-scrollbar {
		width: 0;
		height: 0;
	}
	.trait-col {
		min-height: 0;
		display: flex;
		flex-direction: column;
		/* Hug the content to the left so the trait list (and slot row) size to their own
		   width instead of stretching across the column. */
		align-items: flex-start;
		overflow: visible;
		pointer-events: none;
	}
	/* Rune slots + trait list, centred vertically on the left as one group.
	   margin-block:auto centres them when there's spare height yet collapses to 0
	   so the trait list scrolls from the top if the group outgrows the viewport. */
	.trait-center {
		margin-block: auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
		max-height: 100%;
		overflow: hidden;
	}
	/* Rune/relic carry slots as a row directly above the trait list. */
	.rune-row {
		flex: 0 0 auto;
		pointer-events: auto;
	}
	/* Trait list sizes to its content (so the group can centre), but this host is
	   the scroll boundary for the list. The rune/relic row above it never moves. */
	.trait-host {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		overflow: hidden;
		pointer-events: none;
		overscroll-behavior: contain;
	}
	.trait-host :global(.traits) {
		/* Only as wide as the longest trait row; rows then stretch to that shared width. */
		width: max-content;
		max-width: 100%;
		pointer-events: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
	}

	/* Leaderboard: vertically centred on the right side of the board. The column is
	   a flex track; margin-block:auto on the single child centres it when there's
	   spare height, yet collapses to 0 so the column still scrolls from the top if
	   the roster ever outgrows the viewport. */
	.players-col {
		display: flex;
		flex-direction: column;
	}
	.players-col > :global(.leaderboard) {
		margin-block: auto;
		pointer-events: auto;
	}

	/* ── Stage cell: the center region. Strictly clips so its content can NEVER
	   spill outside the frame (the grid max-content blowout trap). ── */
	.stage-cell {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		overscroll-behavior: none;
		touch-action: none;
		display: flex;
		flex-direction: column;
		pointer-events: none;
	}
	.stage-main {
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		overscroll-behavior: none;
		touch-action: none;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}
	.stage-main :global(.board) {
		width: 100%;
		pointer-events: auto;
	}
	.stage-main :global(button),
	.stage-main :global(a),
	.stage-main :global(input),
	.stage-main :global(select),
	.stage-main :global(textarea),
	.stage-main :global([role='button']),
	.stage-main :global([role='tab']),
	.stage-main :global(.stage-card) {
		pointer-events: auto;
	}
	/* Pass-turn footer — never stretches; sits centered under the stage. */
	.stage-foot {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 0;
		padding-top: 6px;
		pointer-events: none;
	}
	.stage-foot > * {
		pointer-events: auto;
	}

	/* ── Page dots (mobile only). Desktop hides them. ── */
	.page-dots {
		display: none;
	}
	.phase-rail {
		display: none;
	}
	/* Ghost button — white hairline outline over faint glass, matching the
	   RoundBanner / leaderboard treatment (no brand-magenta chrome). */
	.ghost-btn {
		flex: 0 0 auto;
		padding: 7px 13px;
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: rgba(10, 7, 20, 0.4);
		color: rgba(255, 255, 255, 0.62);
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		text-decoration: none;
		cursor: pointer;
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.ghost-btn:hover {
		border-color: rgba(255, 255, 255, 0.4);
		color: #fff;
	}

	/* Settings menu (gear → dropdown holding Exit). */
	.settings-wrap {
		position: relative;
		flex: 0 0 auto;
	}
	.icon-btn {
		display: grid;
		place-items: center;
		width: 36px;
		height: 32px;
		padding: 0;
	}
	.chat-toggle {
		position: relative;
	}
	.chat-badge {
		position: absolute;
		top: -5px;
		right: -5px;
		display: grid;
		place-items: center;
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: 999px;
		border: 1px solid rgba(5, 3, 16, 0.9);
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.62rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		box-shadow: 0 0 14px rgba(255, 43, 199, 0.5);
	}
	.icon-btn svg {
		width: 18px;
		height: 18px;
	}
	.settings-backdrop {
		position: fixed;
		inset: 0;
		z-index: 30;
		border: 0;
		padding: 0;
		margin: 0;
		background: transparent;
		cursor: default;
	}
	/* Settings dropdown — frosted glass card with a single white hairline,
	   echoing the RoundBanner strip. */
	.settings-panel {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 31;
		min-width: 184px;
		max-width: min(420px, calc(100vw - 24px));
		max-height: calc(100dvh - 88px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
		overflow-y: auto;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 10px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: linear-gradient(180deg, rgba(10, 7, 20, 0.92), rgba(8, 5, 16, 0.88));
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		box-shadow: 0 18px 50px -20px rgba(0, 0, 0, 0.7);
	}
	.settings-title {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.5);
		padding: 2px 4px;
	}
	.settings-item {
		display: block;
		padding: 8px 10px;
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: transparent;
		color: rgba(255, 255, 255, 0.72);
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		text-decoration: none;
		text-align: center;
		cursor: pointer;
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.settings-item:hover {
		border-color: rgba(255, 255, 255, 0.4);
		color: #fff;
	}
	.settings-control {
		padding: 4px 2px 2px;
	}

	/* Pass-turn — a pill in the stage footer (never stretches; bounded by .stage-foot). */
	.pass-btn {
		padding: 8px 26px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		border: none;
		border-radius: 12px;
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		cursor: pointer;
		box-shadow: 0 12px 26px -8px rgba(255, 43, 199, 0.55);
		animation: pass-drop 360ms cubic-bezier(0.22, 1.2, 0.36, 1) both;
		transition:
			background 140ms ease,
			transform 140ms ease;
	}
	.pass-btn:hover:not(:disabled) {
		background: var(--brand-magenta-soft, #ff7fd9);
		transform: translateY(2px);
	}
	.pass-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	@keyframes pass-drop {
		from {
			transform: translateY(8px);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}
	.pass-waiting {
		padding: 7px 22px 9px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
		background: linear-gradient(180deg, rgba(10, 7, 20, 0.6), rgba(8, 5, 16, 0.4));
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 12px;
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}
	.pass-blocked {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
	}
	/* The parked button must READ parked: kill the entry animation (its fill-mode
	   would pin opacity at 1 and beat the :disabled dim). */
	.pass-blocked .pass-btn {
		animation: none;
		opacity: 0.4;
		filter: saturate(0.55);
		box-shadow: none;
	}
	.pass-blocked-reason {
		font-size: 0.74rem;
		color: var(--brand-amber-soft, #ffd56a);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.error {
		position: absolute;
		top: 56px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 35;
		padding: 0.5rem 0.9rem;
		border-left: 3px solid var(--color-blood, #e05858);
		background: rgba(110, 18, 35, 0.65);
		color: var(--color-parchment, #e7e0cf);
		border-radius: 2px;
	}

	/* ──────────────────────────────────────────────────────────────────────────
	   PHONE LAYOUT (≤600px). The desktop 3-track grid becomes a horizontal swipe
	   pager of three full-width pages — Traits · Stage · Leaderboard — under the
	   pinned nav bar. Page dots track / drive the active page. Mirrors the proven
	   nav carousel in SpiritWorldBoard (definite sizing, min-width:0, scroll-snap).
	   ────────────────────────────────────────────────────────────────────────── */
	@media (max-width: 600px) {
		/* The pager turns into a snap-scrolling row of three full-width pages. */
		.pager {
			display: flex;
			gap: 0;
			padding: 0;
			overflow-x: auto;
			overflow-y: hidden;
			scroll-snap-type: x mandatory;
			-webkit-overflow-scrolling: touch;
			overscroll-behavior-x: contain;
			scrollbar-width: none;
		}
		.pager::-webkit-scrollbar {
			display: none;
		}
		/* Each column is one full-width page; the stage clips, the others scroll. */
		.trait-col,
		.stage-cell,
		.players-col {
			flex: 0 0 100%;
			min-width: 0;
			min-height: 0;
			scroll-snap-align: start;
			scroll-snap-stop: always;
			box-sizing: border-box;
		}
		.trait-col,
		.players-col {
			-webkit-overflow-scrolling: touch;
			padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
		}
		.players-col {
			overflow-y: auto;
		}
		.trait-col {
			overflow: visible;
		}
		/* On a phone the trait page is full-width — keep the cards full-width too rather
		   than shrink-wrapped (the desktop behaviour). */
		.trait-col {
			align-items: stretch;
		}
		.trait-host :global(.traits) {
			width: 100%;
			max-width: none;
		}
		/* Stage page keeps clipping; its main scrolls internally if needed. */
		.stage-cell {
			overflow-y: hidden;
			padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
		}
		.stage-main {
			overflow-y: auto;
			-webkit-overflow-scrolling: touch;
		}

		/* Page dots, pinned just under the pager. ≥44px tap targets. */
		.page-dots {
			flex: 0 0 auto;
			display: flex;
			gap: 4px;
			justify-content: center;
			align-items: center;
			padding-bottom: env(safe-area-inset-bottom);
		}
		.page-dot {
			display: grid;
			place-items: center;
			width: 44px;
			height: 44px;
			padding: 0;
			border: none;
			background: none;
			cursor: pointer;
			touch-action: manipulation;
			-webkit-tap-highlight-color: transparent;
		}
		.page-dot:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
			border-radius: 10px;
		}
		.dot-mark {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: rgba(255, 255, 255, 0.28);
			transition:
				background 160ms ease,
				transform 160ms ease;
		}
		.page-dot.active .dot-mark {
			background: var(--brand-magenta, #ff2bc7);
			transform: scale(1.6);
		}

		/* Notch clearance for the nav bar; bump its icon buttons to ≥44px taps. */
		.nav-bar {
			padding-top: env(safe-area-inset-top);
			padding-left: calc(0.75rem + env(safe-area-inset-left));
			padding-right: calc(0.75rem + env(safe-area-inset-right));
		}
		.icon-btn {
			width: 44px;
			height: 44px;
		}
		.ghost-btn,
		.icon-btn,
		.settings-item,
		.pass-btn,
		.page-dot {
			touch-action: manipulation;
			user-select: none;
			-webkit-tap-highlight-color: transparent;
		}
		.settings-item {
			padding: 12px 14px;
			min-height: 44px;
		}
		/* Active gameplay no longer pages between traits/stage/leaderboard; portrait
		   remains rotate-gated, and landscape keeps all HUD regions visible. */
		.pager {
			display: grid;
			grid-template-columns: var(--left-w, 336px) minmax(0, 1fr) var(--right-w, 280px);
			gap: var(--hud-gap, 8px);
			padding: 60px 12px calc(8px + env(safe-area-inset-bottom));
			overflow: hidden;
			scroll-snap-type: none;
		}
		.trait-col,
		.stage-cell,
		.players-col {
			flex: initial;
			scroll-snap-align: none;
			scroll-snap-stop: normal;
		}
		.trait-col {
			align-items: flex-start;
		}
		.trait-host :global(.traits) {
			width: max-content;
			max-width: 100%;
		}
		.page-dots {
			display: none;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.tft {
			--hud-pad-x: 7.5px;
			--hud-pad-y: 4.5px;
			--hud-gap: 4.5px;
			--hud-left-w: clamp(142px, 20vw, 180px);
			--hud-right-w: clamp(112px, 16vw, 148px);
			--hud-rail-content-w: 42px;
			--rune-row-slot-size: 1.75rem;
			--rune-gap: 0.22rem;
			--trait-icon: 34px;
			--trait-count-size: 17px;
			--trait-count-font: 0.72rem;
			--trait-row-pad: 6px 7px;
			--trait-gap: 0.5rem;
			--trait-name-size: 0.88rem;
			--trait-state-size: 0.86rem;
			--trait-pip-size: 16px;
			--trait-pip-font: 0.68rem;
			--trait-section-gap: 0.5rem;
			--lb-gap: 18px;
			--lb-row-min-h: 34px;
			--lb-avatar: 32px;
			--lb-me-avatar: 38px;
			--lb-boss-avatar: 38px;
			--lb-name-size: 0.68rem;
			--lb-name-w: 4.9rem;
			--lb-pts-size: 0.82rem;
			--lb-me-pts-size: 0.96rem;
			--lb-chip-size: 0.68rem;
			--lb-pip-size: 9px;
			--lb-potential-w: 5rem;
			--lb-bounty-size: 15px;
			--stage-view-gap: 0.55rem;
			--stage-title-size: clamp(1.35rem, 4.4vh, 1.85rem);
			--stage-instruction-height: calc(var(--rune-row-slot-size) + 2px);
			--stage-instruction-top: calc(
				(var(--hud-pad-y) * 0.5) + (var(--rune-row-slot-size) * 0.75) +
					(var(--trait-section-gap) * 0.5) + 0.5rem
			);
			--stage-card-gap: 0.5rem;
			--stage-card-max: 11rem;
			--stage-card-width: clamp(7.8rem, 21vw, 10.8rem);
			--stage-card-min-h: 8.2rem;
			--stage-card-pad: 0.75rem 0.65rem;
			--stage-card-inner-gap: 0.32rem;
			--stage-card-glyph: 1.65rem;
			--stage-card-title: 0.8rem;
			--stage-card-subtitle: 0.68rem;
			--int-grid-gap: 0.55rem;
			--int-card-max: 12.25rem;
			--int-card-radius: 12px;
		}
		.shell {
			box-sizing: border-box;
			padding: 0;
		}
		.nav-bar {
			position: absolute;
			inset: 0 0 0 auto;
			width: calc(var(--hud-safe-r) + var(--hud-rail-content-w));
			min-height: 0;
			padding: 0;
			background: none;
			pointer-events: none;
			z-index: 24;
		}
		.nav-center {
			display: none;
		}
		.nav-controls {
			position: absolute;
			top: var(--hud-pad-y);
			left: auto;
			right: calc(var(--hud-safe-r) + var(--hud-rail-content-w) + var(--hud-gap));
			bottom: auto;
			transform: none;
			flex-direction: row;
			gap: 0.3rem;
			pointer-events: auto;
			z-index: 26;
		}
		.icon-btn {
			width: 30px;
			height: 30px;
			border-radius: 8px;
			background: rgba(10, 7, 20, 0.3);
		}
		.phase-rail {
			position: absolute;
			top: 0;
			right: 0;
			bottom: 0;
			z-index: 23;
			width: calc(var(--hud-safe-r) + var(--hud-rail-content-w));
			display: block;
			box-sizing: border-box;
			border-left: 1px solid rgba(255, 255, 255, 0.14);
			background: linear-gradient(180deg, rgba(10, 7, 20, 0.72), rgba(8, 5, 16, 0.42));
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
			box-shadow: -16px 0 42px -30px rgba(0, 0, 0, 0.78);
			pointer-events: none;
		}
		.phase-rail-inner {
			width: var(--hud-rail-content-w);
			height: 100%;
			display: grid;
			grid-template-rows: minmax(54px, 0.8fr) minmax(74px, 1.6fr) minmax(64px, 0.9fr);
			justify-items: center;
			align-items: center;
			box-sizing: border-box;
			padding-block: max(6px, var(--hud-safe-t)) max(6px, var(--hud-safe-b));
		}
		.rail-round,
		.rail-phase {
			font-family: var(--font-display);
			font-size: 0.62rem;
			letter-spacing: 0.16em;
			text-transform: uppercase;
			color: rgba(255, 255, 255, 0.72);
			writing-mode: vertical-rl;
			text-orientation: mixed;
			line-height: 1;
			white-space: nowrap;
			text-shadow: 0 0 12px rgba(255, 255, 255, 0.12);
		}
		.rail-round {
			color: rgba(255, 255, 255, 0.85);
		}
		.rail-track {
			position: relative;
			width: 2px;
			height: 100%;
			min-height: 82px;
			border-radius: 999px;
			background: rgba(255, 255, 255, 0.14);
			overflow: visible;
		}
		.rail-fill {
			position: absolute;
			left: 0;
			top: 0;
			width: 100%;
			min-height: 8px;
			border-radius: inherit;
			background: linear-gradient(180deg, #fff, var(--brand-cyan, #5cdfff));
			box-shadow: 0 0 12px rgba(92, 223, 255, 0.55);
		}
		.rail-node {
			position: absolute;
			left: 50%;
			width: 7px;
			height: 7px;
			border: 1px solid rgba(255, 255, 255, 0.42);
			background: rgba(8, 5, 16, 0.86);
			transform: translate(-50%, -50%) rotate(45deg);
		}
		.rail-node:nth-child(2) {
			top: 0%;
		}
		.rail-node:nth-child(3) {
			top: 33.333%;
		}
		.rail-node:nth-child(4) {
			top: 66.667%;
		}
		.rail-node:nth-child(5) {
			top: 100%;
		}
		.rail-node.active {
			background: #fff;
			border-color: transparent;
			box-shadow: 0 0 12px rgba(255, 255, 255, 0.75);
		}
		.pager {
			grid-template-columns: var(--left-w) minmax(0, 1fr) var(--right-w);
			gap: var(--hud-gap);
			padding: var(--hud-pad-y) calc(var(--hud-safe-r) + var(--hud-rail-content-w) + var(--hud-gap))
				calc(var(--hud-pad-y) + var(--hud-safe-b)) var(--hud-pad-x);
			overflow: hidden;
		}
		.stage-cell {
			padding: 0;
		}
		.stage-main {
			overflow: hidden;
			overscroll-behavior: none;
			touch-action: none;
		}
		.trait-col {
			min-width: 0;
			overflow-clip-margin: 0 22px 22px 0;
		}
		.trait-host :global(.traits) {
			padding: 0.375rem 0.5rem 0.5rem 0;
		}
		.trait-host :global(.state-label) {
			padding-left: 4px;
		}
		.players-col {
			min-width: 0;
			padding-right: 2px;
		}
		.stage-foot {
			padding-top: 2px;
		}
		.pass-btn {
			min-height: 34px;
			padding: 5px 20px;
			border-radius: 10px;
			font-size: 0.74rem;
			animation: none;
		}
		.error {
			top: 50px;
			max-width: min(
				680px,
				calc(100vw - 48px - env(safe-area-inset-left) - env(safe-area-inset-right))
			);
		}
	}
</style>
