<script lang="ts">
	import type { NavigationDestination } from '$lib/play/types';
	import type { GameLocationAsset, IconPoolEntry } from '$lib/types';
	import { splatFor } from '$lib/play/locations';
	import { decideNavMode, compassDiameter, RING_OVERHANG } from '$lib/play/viewMode';
	import SplatBackground from './SplatBackground.svelte';
	import ConfirmedDestinationPanel from './ConfirmedDestinationPanel.svelte';

	interface Props {
		/** The locked world — titles the circle and selects the splat. */
		destination: NavigationDestination;
		/** Circle BOX diameter is derived internally from the measured cell via
		 *  compassDiameter — see `size` below. */
		accent?: string;
		location?: GameLocationAsset | null;
		iconPool?: Map<string, IconPoolEntry>;
		/** Splat for the chosen world; defaults to splatFor(destination). */
		splatSrc?: string;
		/** Whether "Change selection" is allowed (navigation still open). */
		canExit?: boolean;
		onExit: () => void;
	}

	let {
		destination,
		accent = '#8d8aa1',
		location = null,
		iconPool = new Map(),
		splatSrc,
		canExit = true,
		onExit
	}: Props = $props();

	// Measure the REAL board cell exactly like SpiritWorldBoard so the circle is sized
	// by the SAME purely space-based rule (viewMode.ts) — keyed off the smaller dimension
	// only, so aspect ratio never matters. When a usable circle doesn't fit we fall back
	// to the plain confirmed panel (the small-screen layout).
	let boardW = $state(0);
	let boardH = $state(0);
	// decideNavMode needs the previous mode for hysteresis; track it like the board does.
	let mode = $state<'compass' | 'cards'>('cards');
	$effect(() => {
		const next = decideNavMode(boardW, boardH, mode);
		if (next !== mode) mode = next;
	});
	const useCircle = $derived(mode === 'compass');
	// Box sized so the full ring (drawn at RING_OVERHANG×) fits the cell uncropped.
	const size = $derived(compassDiameter(boardW, boardH));
	const src = $derived(splatSrc ?? splatFor(destination));
</script>

<div class="board" bind:clientWidth={boardW} bind:clientHeight={boardH} data-testid="confirm-circle">
	{#if useCircle}
		<div class="frame" style="width: {size}px; height: {size}px;">
			<!-- A compass-rhyming ring, drawn at RING_OVERHANG× of the box so it floats
			     outside the disc just like SpiritWorldBoard's ring — and stays uncropped
			     because the box was sized down by the same factor. -->
			<div
				class="ring"
				style="--accent: {accent}; --overhang: {RING_OVERHANG};"
				aria-hidden="true"
			></div>
			<!-- The circular MASK: a disc clipping its own mini splat + the going-to view. -->
			<div class="disc" style="--accent: {accent}">
				<!-- SECOND, separate renderer: the chosen world's splat, masked into the
				     circle. push stays 0 — this is a static preview, NOT the background that
				     dollies in on enter. -->
				<SplatBackground {src} blur={2} push={0} contained={true} />
				<div class="scrim" aria-hidden="true"></div>
				<div class="content">
					<span class="going">Going to</span>
					<!-- Reuse the confirmed panel for the world name + reward summary + the
					     "Change selection" back-out (it already renders all of it). -->
					<div class="panel-host">
						<ConfirmedDestinationPanel
							{destination}
							{location}
							{iconPool}
							{accent}
							{canExit}
							{onExit}
						/>
					</div>
				</div>
			</div>
		</div>
	{:else}
		<!-- Too small for a circle → the plain confirmed panel (small-screen fallback). -->
		<ConfirmedDestinationPanel {destination} {location} {iconPool} {accent} {canExit} {onExit} />
	{/if}
</div>

<style>
	/* Fill the available stage cell so the measured size matches the compass exactly —
	   identical flow to SpiritWorldBoard's .board (so the space-based decision is stable). */
	.board {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		flex: 1 1 auto;
		height: 100%;
		min-height: 0;
	}
	.frame {
		position: relative;
		display: grid;
		place-items: center;
		/* Let the ring overhang the box without being clipped by the cell — the box was
		   sized down by RING_OVERHANG so this stays inside the measured cell. */
		overflow: visible;
		animation: circle-in 360ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}
	/* The compass-rhyming ring: floats outside the disc at RING_OVERHANG× the box. */
	.ring {
		position: absolute;
		left: 50%;
		top: 50%;
		/* RING_OVERHANG (1.22) — kept in sync with SpiritWorldBoard's .ring via viewMode.ts. */
		width: calc(100% * var(--overhang, 1.22));
		aspect-ratio: 1;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--accent) 45%, rgba(255, 255, 255, 0.16));
		box-shadow:
			0 0 60px -10px color-mix(in srgb, var(--accent) 40%, transparent),
			inset 0 0 80px -30px color-mix(in srgb, var(--accent) 30%, transparent);
		pointer-events: none;
	}
	/* The masked disc: clips the mini splat + the going-to view into a true circle. */
	.disc {
		position: relative;
		width: 100%;
		height: 100%;
		border-radius: 50%;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
		box-shadow: 0 24px 70px -24px rgba(0, 0, 0, 0.85);
	}
	/* Soft radial scrim over the splat so the white content stays legible (the heavy
	   full-screen vignette is suppressed in contained mode). */
	.scrim {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: radial-gradient(
			ellipse 80% 80% at 50% 48%,
			rgba(6, 4, 14, 0.5) 0%,
			rgba(6, 4, 14, 0.42) 42%,
			rgba(6, 4, 14, 0.72) 78%,
			rgba(6, 4, 14, 0.92) 100%
		);
	}
	.content {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		/* Keep content inside the circular safe area so the disc edge never clips it. */
		padding: 14%;
		box-sizing: border-box;
		text-align: center;
	}
	.going {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.42em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
		text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 70%, transparent);
	}
	/* The embedded panel runs its own glass + animation; strip the box-only chrome so
	   it reads as the circle's content rather than a card floating inside the disc. */
	.panel-host {
		width: 100%;
		display: flex;
		justify-content: center;
		min-height: 0;
		overflow: hidden;
	}
	.panel-host :global(.confirmed) {
		background: none;
		border: none;
		box-shadow: none;
		backdrop-filter: none;
		padding: 0;
		max-width: 100%;
	}
	/* The panel's own eyebrow is redundant inside the circle (we show "Going to" above). */
	.panel-host :global(.eyebrow) {
		display: none;
	}
	@keyframes circle-in {
		from {
			opacity: 0;
			transform: scale(0.94);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.frame {
			animation: none;
		}
	}
</style>
