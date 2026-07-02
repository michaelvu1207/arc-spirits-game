<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		SpectatorProjection,
		SeatColor,
		NavigationDestination,
		MonsterState
	} from '$lib/play/types';
	import { SPIRIT_WORLD_ONLY } from '$lib/play/types';
	import { LOCATIONS, LOCATION_ACCENT } from '$lib/play/locations';
	import { decideNavMode, compassDiameter, type NavViewMode } from '$lib/play/viewMode';
	import type { GameLocationAsset, IconPoolEntry } from '$lib/types';
	import LocationCard from './LocationCard.svelte';
	import RewardArc from './RewardArc.svelte';
	import type { NavigationSceneControls } from './navigationSceneControls';

	interface Props {
		room: SpectatorProjection;
		mySeat?: SeatColor | null;
		selectable?: boolean;
		selectedDestination?: NavigationDestination | null;
		focusedDestination?: NavigationDestination | null;
		onHover?: (destination: NavigationDestination | null) => void;
		onSelect?: (destination: NavigationDestination) => void;
		onSceneControls?: (controls: NavigationSceneControls | null) => void;
		monster: MonsterState | null;
		gameLocations?: Map<string, GameLocationAsset>;
		iconPool?: Map<string, IconPoolEntry>;
	}

	let {
		room,
		mySeat = null,
		selectable = false,
		selectedDestination = null,
		focusedDestination = null,
		onHover,
		onSelect,
		onSceneControls,
		monster,
		gameLocations = new Map(),
		iconPool = new Map()
	}: Props = $props();

	const ABYSS: NavigationDestination = 'Arcane Abyss';
	const s = SPIRIT_WORLD_ONLY;
	// The four realms sit at the cardinal points of the compass around the Abyss hub.
	// The four realms fill the four corner quadrants carved out by the plus.
	const ARMS: { pos: string; name: NavigationDestination }[] = [
		{ pos: 'tl', name: s[0] },
		{ pos: 'tr', name: s[1] },
		{ pos: 'bl', name: s[2] },
		{ pos: 'br', name: s[3] }
	];

	const seatNames = $derived.by(() => {
		const names: Partial<Record<SeatColor, string>> = {};
		for (const seat of room.activeSeats) names[seat] = room.seats[seat]?.displayName ?? seat;
		return names;
	});

	function occupantsOf(destination: NavigationDestination): SeatColor[] {
		return room.locationOccupancy[destination] ?? [];
	}

	// Which 90° quadrant to light up for the focused realm (conic 0deg = up,
	// clockwise). Each wedge is bounded by the plus's vertical/horizontal arms.
	const WEDGE_BY_POS: Record<string, string> = {
		tr: '0deg',
		br: '90deg',
		bl: '180deg',
		tl: '270deg'
	};
	const focusedArm = $derived(ARMS.find((a) => a.name === focusedDestination) ?? null);
	const focusWedge = $derived(focusedArm ? WEDGE_BY_POS[focusedArm.pos] : null);
	const focusAccent = $derived(
		focusedDestination ? (LOCATION_ACCENT[focusedDestination] ?? '#ffffff') : '#ffffff'
	);

	// Compass mode: each cardinal realm is a transparent quadrant hit-target; its title
	// and reward rows are drawn as concentric arcs by RewardArc (one hub-centred overlay).
	const quadInputs = $derived(
		ARMS.map((a) => ({
			name: a.name,
			pos: a.pos as 'tl' | 'tr' | 'bl' | 'br',
			location: gameLocations.get(a.name) ?? null,
			accent: LOCATION_ACCENT[a.name] ?? '#8d8aa1',
			occupants: occupantsOf(a.name),
			selected: selectedDestination === a.name,
			focused: focusedDestination === a.name
		}))
	);

	function pickRealm(name: NavigationDestination) {
		if (selectable) onSelect?.(name);
	}

	// ── Mobile carousel ──────────────────────────────────────────────────────
	// Phones get one location at a time in a horizontal, swipe-first carousel instead
	// of the compass (which is unreadable at 360px). rAF updates scale/opacity while
	// the splat preview follows the centred card, without snapping the strip on release.
	const DESTINATIONS: NavigationDestination[] = [s[0], s[1], ABYSS, s[2], s[3]];

	let boardEl = $state<HTMLDivElement | null>(null);
	let carouselEl = $state<HTMLDivElement | null>(null);
	let currentIndex = $state(0);
	let didInitCarousel = false;
	let carouselPointerStart: { x: number; y: number; scrollLeft: number } | null = null;
	let carouselDragged = false;
	let carouselSelectBlocked = $state(false);
	let carouselSelectBlockTimer: number | null = null;
	let carouselPointerId: number | null = null;
	let carouselVelocity = 0;
	let carouselLastSample: { x: number; t: number } | null = null;
	let carouselMomentumRaf = 0;
	let carouselLastMomentumT = 0;
	let scrollRaf = 0;

	// Measure the REAL board area (not the viewport). Whether we show the round
	// compass or the one-card-at-a-time carousel is a single SPACE-BASED decision —
	// "does a full, uncropped, usable circle fit in this cell?" — centralized in
	// viewMode.ts and keyed off the SMALLER dimension only (aspect ratio never
	// matters, which is what the old width/aspect heuristic got wrong). Hysteresis
	// needs the previous mode, so track it in state and recompute on resize.
	let boardW = $state(0);
	let boardH = $state(0);
	let viewMode = $state<NavViewMode>('cards');
	$effect(() => {
		const next = decideNavMode(
			boardW,
			boardH,
			untrack(() => viewMode)
		);
		if (next !== viewMode) viewMode = next;
	});
	const useCards = $derived(viewMode === 'cards');
	// Box sized so the full ring (drawn at 122%) fits inside the cell uncropped.
	const compassSize = $derived(compassDiameter(boardW, boardH));
	// Thickness of the rim band that holds the engraved realm names.
	const ringThickness = $derived(compassSize * 0.085);

	function clampIndex(i: number) {
		return Math.max(0, Math.min(DESTINATIONS.length - 1, i));
	}

	// Coverflow depth: for each card write a signed distance --d and abs --ad (in card
	// units from the viewport centre), so the centred card renders large + solid and
	// neighbours recede subtly. The best-centred slide becomes currentIndex.
	function updateDepth() {
		const el = carouselEl;
		if (!el) return;
		const slides = el.querySelectorAll<HTMLElement>('.nav-slide');
		if (!slides.length) return;
		const reel = el.getBoundingClientRect();
		const centre = reel.left + reel.width / 2;
		let best = currentIndex;
		let bestAbs = Infinity;
		slides.forEach((node, i) => {
			const rect = node.getBoundingClientRect();
			const span = rect.width || 1;
			const d = (rect.left + rect.width / 2 - centre) / span;
			const ad = Math.abs(d);
			const clamped = Math.min(ad, 1);
			const turn = Math.max(-1.15, Math.min(1.15, d));
			const eased = clamped * clamped;
			node.style.setProperty('--d', d.toFixed(3));
			node.style.setProperty('--ad', ad.toFixed(3));
			node.style.setProperty('--rotate', `${(-turn * 28).toFixed(2)}deg`);
			node.style.setProperty('--z', `${(-eased * 260).toFixed(1)}px`);
			node.style.setProperty('--y', `${(eased * 12).toFixed(1)}px`);
			node.style.setProperty('--scale', (1 - eased * 0.08).toFixed(3));
			node.style.setProperty('--fade', (1 - eased * 0.38).toFixed(3));
			node.style.setProperty(
				'--edge-left',
				d < -0.08 ? (0.22 + clamped * 0.5).toFixed(3) : '0'
			);
			node.style.setProperty(
				'--edge-right',
				d > 0.08 ? (0.22 + clamped * 0.5).toFixed(3) : '0'
			);
			node.style.zIndex = String(100 - Math.round(ad * 10));
			if (ad < bestAbs) {
				bestAbs = ad;
				best = i;
			}
		});
		if (best !== currentIndex) currentIndex = best;
		if (selectable) onHover?.(DESTINATIONS[best]);
	}

	function scrollCarouselToIndex(i: number, smooth = true) {
		const el = carouselEl;
		if (!el) return;
		const next = clampIndex(i);
		const slide = el.querySelectorAll<HTMLElement>('.nav-slide')[next];
		if (!slide) return;
		currentIndex = next;
		if (selectable) onHover?.(DESTINATIONS[next]);
		el.scrollTo({
			left: slide.offsetLeft - (el.clientWidth - slide.clientWidth) / 2,
			behavior: smooth ? 'smooth' : 'auto'
		});
		requestAnimationFrame(updateDepth);
	}

	function cancelCarouselMomentum() {
		if (carouselMomentumRaf) {
			cancelAnimationFrame(carouselMomentumRaf);
			carouselMomentumRaf = 0;
		}
		carouselVelocity = 0;
		carouselLastMomentumT = 0;
	}

	function startCarouselMomentum() {
		const el = carouselEl;
		if (!el) return;
		const prefersReduced =
			typeof window !== 'undefined' &&
			window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		if (prefersReduced || Math.abs(carouselVelocity) < 0.08) {
			carouselVelocity = 0;
			paintCarouselDepthSoon();
			return;
		}
		const maxVelocity = 2.4; // px/ms; fast enough to cross cards, capped against wild flings.
		carouselVelocity = Math.max(-maxVelocity, Math.min(maxVelocity, carouselVelocity));
		carouselLastMomentumT = performance.now();
		const step = (t: number) => {
			const node = carouselEl;
			if (!node) {
				cancelCarouselMomentum();
				return;
			}
			const dt = Math.min(32, Math.max(0, t - carouselLastMomentumT));
			carouselLastMomentumT = t;
			const prev = node.scrollLeft;
			node.scrollLeft += carouselVelocity * dt;
			const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
			const atEdge = prev <= 0 || prev >= maxScrollLeft - 1;
			const hitEdge =
				dt > 0.5 && atEdge && node.scrollLeft === prev && Math.abs(carouselVelocity) > 0.01;
			paintCarouselDepthSoon();
			carouselVelocity *= Math.exp(-dt * 0.0065);
			if (hitEdge || Math.abs(carouselVelocity) < 0.025) {
				cancelCarouselMomentum();
				paintCarouselDepthSoon();
				return;
			}
			carouselMomentumRaf = requestAnimationFrame(step);
		};
		blockCarouselSelection(760);
		carouselMomentumRaf = requestAnimationFrame(step);
	}

	function paintCarouselDepthSoon() {
		if (scrollRaf) return;
		scrollRaf = requestAnimationFrame(() => {
			scrollRaf = 0;
			updateDepth();
		});
	}

	// Centre the locked/focused card on first layout, then paint the depth.
	$effect(() => {
		if (!useCards || !carouselEl || didInitCarousel) return;
		didInitCarousel = true;
		const target = selectedDestination ?? focusedDestination;
		const initial = target ? Math.max(0, DESTINATIONS.indexOf(target)) : 0;
		currentIndex = clampIndex(initial);
		requestAnimationFrame(() => {
			scrollCarouselToIndex(currentIndex, false);
			updateDepth();
		});
	});

	// Repaint depth when the cell resizes so the same card stays focused.
	$effect(() => {
		void boardW;
		void boardH;
		if (!useCards || !carouselEl || !didInitCarousel) return;
		untrack(() => {
			requestAnimationFrame(() => {
				scrollCarouselToIndex(currentIndex, false);
				updateDepth();
			});
		});
	});

	function onCarouselScroll() {
		if (
			carouselPointerStart &&
			carouselEl &&
			Math.abs(carouselEl.scrollLeft - carouselPointerStart.scrollLeft) > 4
		) {
			blockCarouselSelection();
		}
		paintCarouselDepthSoon();
	}

	function blockCarouselSelection(ms = 420) {
		carouselDragged = true;
		carouselSelectBlocked = true;
		if (carouselSelectBlockTimer) window.clearTimeout(carouselSelectBlockTimer);
		carouselSelectBlockTimer = window.setTimeout(() => {
			carouselDragged = false;
			carouselSelectBlocked = false;
			carouselSelectBlockTimer = null;
		}, ms);
	}

	function setCarouselDragging(active: boolean) {
		const el = carouselEl;
		if (!el) return;
		el.style.scrollBehavior = active ? 'auto' : '';
	}

	function startCarouselDragGuard(x: number, y: number) {
		if (!useCards) return;
		cancelCarouselMomentum();
		setCarouselDragging(true);
		carouselPointerStart = {
			x,
			y,
			scrollLeft: carouselEl?.scrollLeft ?? 0
		};
		carouselLastSample = { x, t: performance.now() };
		carouselVelocity = 0;
		carouselDragged = false;
	}

	function updateCarouselDragGuard(x: number, y: number) {
		if (!carouselPointerStart) return;
		const now = performance.now();
		if (carouselLastSample) {
			const dt = now - carouselLastSample.t;
			if (dt > 0) {
				const instant = -(x - carouselLastSample.x) / dt;
				carouselVelocity = carouselVelocity * 0.58 + instant * 0.42;
			}
		}
		carouselLastSample = { x, t: now };
		const dx = x - carouselPointerStart.x;
		const dy = y - carouselPointerStart.y;
		const distance = Math.hypot(dx, dy);
		const mostlyHorizontal = Math.abs(dx) >= Math.abs(dy) * 0.55;
		if (mostlyHorizontal) {
			const el = carouselEl;
			if (el) {
				el.scrollLeft = carouselPointerStart.scrollLeft - dx;
				paintCarouselDepthSoon();
			}
		}
		if (distance > 2 && mostlyHorizontal) blockCarouselSelection();
	}

	function endCarouselDragGuard(x?: number, y?: number) {
		const start = carouselPointerStart;
		let dx = 0;
		let dy = 0;
		if (carouselPointerStart && x !== undefined && y !== undefined) {
			updateCarouselDragGuard(x, y);
		}
		carouselPointerStart = null;
		carouselLastSample = null;
		setCarouselDragging(false);
		if (start && x !== undefined && y !== undefined) {
			dx = x - start.x;
			dy = y - start.y;
		}
		if (
			carouselDragged ||
			(start && Math.hypot(dx, dy) > 2 && Math.abs(dx) >= Math.abs(dy) * 0.55)
		) {
			blockCarouselSelection(760);
			paintCarouselDepthSoon();
			startCarouselMomentum();
			return;
		}
		if (carouselSelectBlockTimer) window.clearTimeout(carouselSelectBlockTimer);
		carouselSelectBlockTimer = window.setTimeout(() => {
			carouselDragged = false;
			carouselSelectBlocked = false;
			carouselSelectBlockTimer = null;
		}, 80);
	}

	function handleCarouselPointerDown(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		carouselPointerId = event.pointerId;
		try {
			(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		} catch {
			// WebKit can reject capture on detached/rebuilt targets; move/up still use the guard.
		}
		startCarouselDragGuard(event.clientX, event.clientY);
	}

	function handleCarouselPointerMove(event: PointerEvent) {
		if (carouselPointerId !== null && event.pointerId !== carouselPointerId) return;
		updateCarouselDragGuard(event.clientX, event.clientY);
		if (carouselPointerStart) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function handleCarouselPointerEnd(event: PointerEvent) {
		if (carouselPointerId !== null && event.pointerId !== carouselPointerId) return;
		endCarouselDragGuard(event.clientX, event.clientY);
		try {
			(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		} catch {
			// Matching the guarded capture path above.
		}
		carouselPointerId = null;
		if (carouselDragged || carouselSelectBlocked) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function handleCarouselTouchStart(event: TouchEvent) {
		const touch = event.touches[0];
		if (!touch) return;
		startCarouselDragGuard(touch.clientX, touch.clientY);
	}

	function handleCarouselTouchMove(event: TouchEvent) {
		const touch = event.touches[0];
		if (!touch) return;
		updateCarouselDragGuard(touch.clientX, touch.clientY);
		if (carouselPointerStart) event.preventDefault();
	}

	function handleCarouselTouchEnd(event: TouchEvent) {
		const touch = event.changedTouches[0];
		endCarouselDragGuard(touch?.clientX, touch?.clientY);
	}

	function handleCarouselTouchCancel() {
		endCarouselDragGuard();
		carouselPointerId = null;
	}

	function handleCarouselClickCapture(event: MouseEvent) {
		if (!carouselDragged && !carouselSelectBlocked) return;
		event.preventDefault();
		event.stopPropagation();
	}

	function carouselSurfaceGestures(node: HTMLElement) {
		const hasPointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;
		node.addEventListener('pointerdown', handleCarouselPointerDown);
		node.addEventListener('pointermove', handleCarouselPointerMove);
		node.addEventListener('pointerup', handleCarouselPointerEnd);
		node.addEventListener('pointercancel', handleCarouselPointerEnd);
		if (!hasPointerEvents) {
			node.addEventListener('touchstart', handleCarouselTouchStart);
			node.addEventListener('touchmove', handleCarouselTouchMove, { passive: false });
			node.addEventListener('touchend', handleCarouselTouchEnd);
			node.addEventListener('touchcancel', handleCarouselTouchCancel);
		}
		node.addEventListener('click', handleCarouselClickCapture, { capture: true });
		return {
			destroy() {
				cancelCarouselMomentum();
				node.removeEventListener('pointerdown', handleCarouselPointerDown);
				node.removeEventListener('pointermove', handleCarouselPointerMove);
				node.removeEventListener('pointerup', handleCarouselPointerEnd);
				node.removeEventListener('pointercancel', handleCarouselPointerEnd);
				if (!hasPointerEvents) {
					node.removeEventListener('touchstart', handleCarouselTouchStart);
					node.removeEventListener('touchmove', handleCarouselTouchMove);
					node.removeEventListener('touchend', handleCarouselTouchEnd);
					node.removeEventListener('touchcancel', handleCarouselTouchCancel);
				}
				node.removeEventListener('click', handleCarouselClickCapture, { capture: true });
			}
		};
	}

	$effect(() => {
		if (!useCards) {
			cancelCarouselMomentum();
			onSceneControls?.(null);
			return;
		}
		const controls: NavigationSceneControls = {
			beginDrag: startCarouselDragGuard,
			moveDrag: updateCarouselDragGuard,
			endDrag: endCarouselDragGuard
		};
		onSceneControls?.(controls);
		return () => onSceneControls?.(null);
	});

	function selectCarouselDestination(destination: NavigationDestination) {
		if (carouselDragged || carouselSelectBlocked) return;
		onSelect?.(destination);
	}
</script>

<div
	class="board"
	bind:this={boardEl}
	bind:clientWidth={boardW}
	bind:clientHeight={boardH}
	use:carouselSurfaceGestures
>
	{#if useCards}
		<!-- Mobile: one readable location at a time, with native horizontal free-drag. -->
		<div class="nav-carousel-wrap" role="group" aria-label="Location selector">
			<!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
			<div
				class="nav-carousel"
				bind:this={carouselEl}
				onscroll={onCarouselScroll}
				data-testid="nav-carousel"
			>
				{#each DESTINATIONS as dest, i (dest)}
					<div class="nav-slide" class:active={i === currentIndex}>
						<div
							class="nav-card"
							class:selected={selectedDestination === dest}
							class:focused={focusedDestination === dest}
							style="--accent: {LOCATION_ACCENT[dest] ?? '#8d8aa1'}"
						>
							<LocationCard
								config={LOCATIONS[dest]}
								location={gameLocations.get(dest) ?? null}
								{iconPool}
								occupants={occupantsOf(dest)}
								{seatNames}
								selectable={selectable && !carouselSelectBlocked}
								focused={focusedDestination === dest}
								selected={selectedDestination === dest}
								monster={dest === ABYSS ? monster : null}
								{mySeat}
								{onHover}
								onSelect={selectCarouselDestination}
							/>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{:else}
		<div
			class="compass"
			data-testid="realm-compass"
			style="width: {compassSize}px; height: {compassSize}px;"
		>
			<!-- A thick rim band; the engraved realm names ride inside it (RewardArc). -->
			<div class="ring" style="border-width: {ringThickness}px;" aria-hidden="true"></div>
			<!-- Pie-wedge highlight for the focused realm's quadrant. -->
			{#if focusWedge}
				<div
					class="quadrant"
					style="--wedge: {focusWedge}; --accent: {focusAccent}"
					aria-hidden="true"
				></div>
			{/if}
			<!-- A plus of spokes from the hub out to each cardinal realm. -->
			<svg class="spokes" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
				<line x1="50" y1="5" x2="50" y2="95" />
				<line x1="5" y1="50" x2="95" y2="50" />
			</svg>

			<div class="arm hub">
				<LocationCard
					config={LOCATIONS[ABYSS]}
					location={gameLocations.get(ABYSS) ?? null}
					{iconPool}
					occupants={occupantsOf(ABYSS)}
					{seatNames}
					{selectable}
					hub
					focused={focusedDestination === ABYSS}
					selected={selectedDestination === ABYSS}
					{monster}
					{mySeat}
					{onHover}
					{onSelect}
				/>
			</div>

			<!-- Transparent quadrant hit-targets; the reward arcs sit on top (non-interactive). -->
			{#each ARMS as arm (arm.name)}
				<button
					type="button"
					class="q-hit {arm.pos}"
					data-testid="location-{arm.name}"
					aria-label={arm.name}
					disabled={!selectable}
					onclick={() => pickRealm(arm.name)}
					onpointerenter={() => selectable && onHover?.(arm.name)}
					onpointerleave={() => selectable && onHover?.(null)}
					onfocus={() => selectable && onHover?.(arm.name)}
					onblur={() => selectable && onHover?.(null)}
				></button>
			{/each}

			<RewardArc quads={quadInputs} {iconPool} {seatNames} {mySeat} size={compassSize} />
		</div>
	{/if}
</div>

<style>
	.board {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		/* Fill the available stage area rather than shrink to the rendered content.
		   This is what makes the compass-vs-cards decision STABLE: the measured cell
		   (boardW/boardH) is the available space, identical in both modes — so picking
		   the compass can't shrink the cell and bounce the decision back to cards
		   (the flicker). Both views then center within this fixed area. */
		flex: 1 1 auto;
		height: 100%;
		min-height: 0;
		box-sizing: border-box;
		touch-action: none;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	/* ── Mobile carousel: horizontal swipe pager ───────────────────────────── */
	.nav-carousel-wrap {
		--slide-w: min(78%, 360px);
		position: relative;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		align-items: center;
		width: 100%;
		height: min(68dvh, 100%);
		max-height: 100%;
		min-height: 0;
		perspective: 560px;
		perspective-origin: 50% 45%;
	}
	.nav-carousel {
		position: relative;
		display: flex;
		grid-row: 1;
		gap: 12px;
		align-items: stretch;
		min-height: 0;
		height: 100%;
		width: 100%;
		padding-inline: calc((100% - var(--slide-w)) / 2);
		box-sizing: border-box;
		overflow-x: auto;
		overflow-y: hidden;
		scroll-padding-inline: calc((100% - var(--slide-w)) / 2);
		-webkit-overflow-scrolling: touch;
		touch-action: none;
		overscroll-behavior-x: contain;
		user-select: none;
		scrollbar-width: none;
		transform-style: preserve-3d;
	}
	.nav-carousel::-webkit-scrollbar {
		display: none;
	}
	.nav-slide {
		--d: 0;
		--ad: 0;
		--rotate: 0deg;
		--z: 0px;
		--y: 0px;
		--scale: 1;
		--fade: 1;
		--edge-left: 0;
		--edge-right: 0;
		flex: 0 0 var(--slide-w);
		min-width: 0;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4px 0;
		box-sizing: border-box;
		pointer-events: auto;
		transform-style: preserve-3d;
	}
	.nav-slide.active {
		pointer-events: auto;
	}
	/* Cards recede into perspective as they leave centre; rotation is secondary to
	   depth so the card reads as moving backward, not just being squeezed sideways. */
	.nav-card {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		overflow: visible;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px 13px;
		border-radius: 12px;
		background:
			linear-gradient(180deg, rgba(18, 13, 32, 0.78), rgba(7, 4, 15, 0.62)),
			color-mix(in srgb, var(--accent) 8%, rgba(5, 3, 14, 0.18));
		border: 1px solid color-mix(in srgb, var(--accent) 34%, rgba(255, 255, 255, 0.16));
		-webkit-backdrop-filter: blur(5px) saturate(1.08);
		backdrop-filter: blur(5px) saturate(1.08);
		transform-origin: center center;
		transform: translateX(calc(var(--d) * -8%)) translateY(var(--y)) translateZ(var(--z))
			rotateY(var(--rotate)) scale(var(--scale));
		opacity: var(--fade);
		box-shadow:
			0 18px 42px rgba(0, 0, 0, 0.42),
			inset 0 1px 0 rgba(255, 255, 255, 0.18),
			inset 0 -1px 0 rgba(0, 0, 0, 0.34);
		backface-visibility: hidden;
		will-change: transform, opacity;
		transition:
			border-color 160ms cubic-bezier(0.25, 1, 0.5, 1),
			background 160ms cubic-bezier(0.25, 1, 0.5, 1),
			box-shadow 160ms cubic-bezier(0.25, 1, 0.5, 1);
	}
	.nav-card::before,
	.nav-card::after {
		content: '';
		position: absolute;
		top: 10px;
		bottom: 10px;
		width: 12px;
		border-radius: 8px;
		background:
			linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(0, 0, 0, 0.32)),
			color-mix(in srgb, var(--accent) 22%, rgba(8, 5, 18, 0.84));
		pointer-events: none;
		transform-style: preserve-3d;
	}
	.nav-card::before {
		left: -6px;
		opacity: var(--edge-left);
		transform: rotateY(-88deg);
		transform-origin: right center;
	}
	.nav-card::after {
		right: -6px;
		opacity: var(--edge-right);
		transform: rotateY(88deg);
		transform-origin: left center;
	}
	@media (prefers-reduced-motion: reduce) {
		.nav-card {
			transform: none;
			opacity: 1;
		}
	}
	.nav-card.focused {
		border-color: color-mix(in srgb, var(--accent) 46%, rgba(255, 255, 255, 0.18));
	}
	.nav-card.selected {
		border-color: var(--accent);
	}
	.nav-card :global(.loc) {
		position: relative;
		z-index: 1;
		width: 100%;
		min-height: 0;
		height: 100%;
		justify-content: center;
		gap: 0.34rem;
		padding: 0.25rem 0.2rem;
	}
	.nav-card :global(.name) {
		font-size: clamp(1.12rem, 4.5vh, 1.56rem);
		line-height: 1;
	}
	.nav-card :global(.rows) {
		margin-top: 0.08rem;
	}
	.nav-card :global(.row) {
		gap: 7px;
		padding: 5px 6px;
	}
	.nav-card :global(.icons) {
		gap: 6px;
	}
	.nav-card :global(.ico) {
		width: 32px;
		height: 32px;
	}
	.nav-card :global(.ico img) {
		width: 100%;
		height: 100%;
	}
	.nav-card :global(.arrow) {
		font-size: 1.16rem;
		margin: 0 -6px;
	}

	.compass {
		position: relative;
		/* Portrait-safe: never let the iOS toolbar squeeze the square below the
		   available width. dvh keeps it honest as the toolbar shows/hides. */
		width: min(92vw, 92dvh, 720px);
		aspect-ratio: 1;
		margin: 0 auto;
		overflow: visible;
	}
	/* A true circle (square box + aspect-ratio) sized well beyond the reward-row
	   cluster so it never clips the rows. */
	.ring {
		position: absolute;
		left: 50%;
		top: 50%;
		/* Outer diameter 120% of the cell; border-box keeps the thick band inside that
		   edge so its INNER edge (and the reward disc it frames) scales predictably. */
		width: 120%;
		aspect-ratio: 1;
		box-sizing: border-box;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		border-style: solid;
		border-color: rgba(255, 255, 255, 0.05);
		/* Crisp hairlines on the inner and outer edges so the faint band reads as a rim. */
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.18),
			inset 0 0 0 1px rgba(255, 255, 255, 0.2);
		pointer-events: none;
	}
	/* Pie-wedge highlight: a 90° conic slice masked to a ring around the hub, so the
	   whole quadrant glows (not a rectangle around the card). */
	.quadrant {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 116%;
		aspect-ratio: 1;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		pointer-events: none;
		background: conic-gradient(
			from var(--wedge, -45deg) at 50% 50%,
			color-mix(in srgb, var(--accent) 32%, transparent) 0deg,
			color-mix(in srgb, var(--accent) 32%, transparent) 90deg,
			transparent 90deg,
			transparent 360deg
		);
		-webkit-mask: radial-gradient(
			closest-side,
			transparent 26%,
			#000 34%,
			#000 88%,
			transparent 100%
		);
		mask: radial-gradient(closest-side, transparent 26%, #000 34%, #000 88%, transparent 100%);
		animation: quad-in 150ms ease both;
	}
	@keyframes quad-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.quadrant {
			animation: none;
		}
	}
	.spokes {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	.spokes line {
		stroke: rgba(255, 255, 255, 0.22);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.arm {
		position: absolute;
		display: flex;
		justify-content: center;
	}
	.arm > :global(.loc) {
		width: 100%;
	}
	.hub {
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: 26%;
		/* Above the reward-arc overlay so the Abyss core stays clickable. */
		z-index: 3;
	}

	/* Each cardinal realm's clickable region is its quarter of the compass; the arcs
	   and title render on top via RewardArc. A big target reads well with the wedge glow. */
	.q-hit {
		position: absolute;
		width: 50%;
		height: 50%;
		padding: 0;
		margin: 0;
		border: none;
		background: none;
		cursor: default;
		z-index: 1;
	}
	.q-hit:not(:disabled) {
		cursor: pointer;
	}
	.q-hit:focus-visible {
		outline: 2px solid #fff;
		outline-offset: -6px;
		border-radius: 16px;
	}
	.q-hit.tl {
		left: 0;
		top: 0;
	}
	.q-hit.tr {
		left: 50%;
		top: 0;
	}
	.q-hit.bl {
		left: 0;
		top: 50%;
	}
	.q-hit.br {
		left: 50%;
		top: 50%;
	}
</style>
