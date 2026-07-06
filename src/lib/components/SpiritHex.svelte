<script lang="ts">
	import type { SpiritHexType } from '$lib/hex/gridConfig';

	interface Spirit {
		slotIndex: number;
		id: string;
		name: string;
		cost: number;
	}

	interface AugmentBadge {
		runeId: string;
		name: string;
		icon: string | null;
	}

	interface Props {
		hex: SpiritHexType;
		spirit?: Spirit | null;
		imageUrl?: string | null;
		slotIndex: number;
		externalImage?: boolean;
		/** Discard mode: this occupied hex is clickable to discard its spirit. */
		discardable?: boolean;
		onDiscard?: (slotIndex: number) => void;
		/** Staged for discard (W2c): the red mark persists until a commit bar
		 *  confirms; clicking again un-stages. */
		staged?: boolean;
		/** Ineligible for the active mode (engine verdict): content dims + locks. */
		dimmed?: boolean;
		/** Why this hex is locked — revealed as a chip on hover/tap while dimmed. */
		lockedReason?: string | null;
		/** Spirit augments attached to this hex (rendered in the bottom-right corner). */
		augments?: AugmentBadge[];
		/** Augment-placement mode: this occupied hex accepts a dragged augment. */
		augmentDroppable?: boolean;
		onDropAugment?: (slotIndex: number) => void;
		/** Inspect mode: clicking this occupied hex opens its detail card. */
		selectable?: boolean;
		/** This hex's spirit is the one currently shown in the detail card. */
		selected?: boolean;
		onSelect?: (slotIndex: number) => void;
	}

	let {
		hex,
		spirit = null,
		imageUrl = null,
		slotIndex,
		externalImage = false,
		discardable = false,
		onDiscard,
		staged = false,
		dimmed = false,
		lockedReason = null,
		augments = [],
		augmentDroppable = false,
		onDropAugment,
		selectable = false,
		selected = false,
		onSelect
	}: Props = $props();

	// Generate unique IDs for this hex's elements
	const clipId = $derived(`hex-clip-${slotIndex}`);
	const gradientId = $derived(`hex-gradient-${slotIndex}`);
	const shadowId = $derived(`hex-shadow-${slotIndex}`);

	// Convert corners to SVG polygon points string
	const polygonPoints = $derived(hex.corners.map((c) => `${c.x},${c.y}`).join(' '));

	// Calculate center of the hex for positioning elements
	const center = $derived({
		x: hex.corners.reduce((sum, c) => sum + c.x, 0) / hex.corners.length,
		y: hex.corners.reduce((sum, c) => sum + c.y, 0) / hex.corners.length
	});

	// Calculate bounding box for the image
	const bounds = $derived({
		minX: Math.min(...hex.corners.map((c) => c.x)),
		minY: Math.min(...hex.corners.map((c) => c.y)),
		maxX: Math.max(...hex.corners.map((c) => c.x)),
		maxY: Math.max(...hex.corners.map((c) => c.y))
	});

	const hexWidth = $derived(bounds.maxX - bounds.minX);
	const hexHeight = $derived(bounds.maxY - bounds.minY);

	// Augment badge geometry: a small disc tucked into the hex's bottom-right, pulled
	// in from the bounding box so it stays inside the hex's tapering lower edge.
	const augR = $derived(Math.min(hexWidth, hexHeight) * 0.19);
	const augX = $derived(bounds.minX + hexWidth * 0.68);
	const augY = $derived(bounds.minY + hexHeight * 0.7);
	const augmentNames = $derived(augments.map((a) => a.name).join(', '));

	// Tap reveals the locked-reason chip (hover shows it too, see CSS).
	let reasonRevealed = $state(false);
	let reasonTimer: ReturnType<typeof setTimeout> | null = null;
	function revealReason() {
		if (!lockedReason) return;
		reasonRevealed = true;
		if (reasonTimer) clearTimeout(reasonTimer);
		reasonTimer = setTimeout(() => (reasonRevealed = false), 2200);
	}
	// Approximate chip metrics — SVG text doesn't self-size a background rect.
	const reasonW = $derived((lockedReason?.length ?? 0) * 6.4 + 18);
</script>

<g class="spirit-hex" class:dimmed-hex={dimmed} data-slot={slotIndex}>
	<!-- Define clipPath and gradients -->
	<defs>
		<clipPath id={clipId}>
			<polygon points={polygonPoints} />
		</clipPath>
		<!-- Empty slot fill — crisp brand violet -->
		<radialGradient id={gradientId} cx="50%" cy="50%" r="70%">
			<stop offset="0%" stop-color="rgb(58, 38, 112)" stop-opacity="0.55" />
			<stop offset="100%" stop-color="rgb(26, 15, 46)" stop-opacity="0.9" />
		</radialGradient>
		<!-- Drop shadow filter -->
		<filter id={shadowId} x="-20%" y="-20%" width="140%" height="140%">
			<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.5)" />
		</filter>
	</defs>

	<!-- Hex background/border -->
	<polygon
		points={polygonPoints}
		class="hex-border"
		fill={spirit
			? externalImage
				? 'rgba(0, 0, 0, 0.06)'
				: 'rgba(17, 9, 31, 0.95)'
			: `url(#${gradientId})`}
		stroke={spirit ? 'transparent' : 'var(--color-aether)'}
		stroke-width={spirit ? '0' : '1.5'}
	/>

	<!-- Spirit image with hexagonal clip — `meet` keeps the entire image
	     visible (letter-boxed inside the hex) instead of `slice` cropping
	     the corners. -->
	{#if spirit && imageUrl}
		<image
			href={imageUrl}
			x={bounds.minX}
			y={bounds.minY}
			width={hexWidth}
			height={hexHeight}
			preserveAspectRatio="xMidYMid meet"
			clip-path="url(#{clipId})"
			class="spirit-image"
		/>
	{:else if spirit && externalImage}
		<!-- Image rendered externally by parent -->
	{:else if !spirit}
		<!-- Empty slot - just subtle hex outline, no numbers -->
	{:else}
		<!-- Spirit without image - show name with brand styling -->
		<rect
			x={center.x - 40}
			y={center.y - 12}
			width="80"
			height="24"
			rx="3"
			fill="rgba(26, 15, 46, 0.92)"
		/>
		<text
			x={center.x}
			y={center.y}
			text-anchor="middle"
			dominant-baseline="middle"
			fill="#f5f0ff"
			font-size="12"
			font-weight="400"
			font-family="'Bebas Neue', 'Opsilon', ui-serif, serif"
			letter-spacing="0.06em"
		>
			{spirit.name.length > 10 ? spirit.name.slice(0, 10) + '...' : spirit.name}
		</text>
	{/if}

	{#if selectable && spirit}
		<!-- Inspect: clicking an occupied hex opens its detail card. Rendered before the
		     discard/augment overlays so those intercept clicks when their mode is active. -->
		<g
			class="select-hit"
			role="button"
			tabindex="0"
			aria-label={`Inspect ${spirit?.name ?? 'spirit'}`}
			aria-pressed={selected}
			onclick={() => onSelect?.(slotIndex)}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onSelect?.(slotIndex);
				}
			}}
		>
			<polygon points={polygonPoints} class="select-tint" class:selected />
		</g>
	{/if}

	{#if discardable}
		<g
			class="discard-hit"
			class:staged
			role="button"
			tabindex="0"
			aria-label={staged
				? `Keep ${spirit?.name ?? 'spirit'}`
				: `Discard ${spirit?.name ?? 'spirit'}`}
			aria-pressed={staged}
			onclick={() => onDiscard?.(slotIndex)}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onDiscard?.(slotIndex);
				}
			}}
		>
			<polygon points={polygonPoints} class="discard-tint" />
			<text
				x={center.x}
				y={center.y}
				text-anchor="middle"
				dominant-baseline="middle"
				class="discard-glyph">{staged ? '✕' : '🗑'}</text>
		</g>
	{/if}

	{#if dimmed && spirit}
		<!-- Locked for the active mode: the hex stays visible (dim-and-lock beats
		     hiding) and tapping reveals the engine's reason. -->
		<g
			class="locked-hit"
			role="button"
			tabindex="0"
			aria-disabled="true"
			aria-label={lockedReason ?? 'Not eligible'}
			onclick={revealReason}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					revealReason();
				}
			}}
		>
			<title>{lockedReason ?? 'Not eligible'}</title>
			<polygon points={polygonPoints} class="locked-tint" />
			<g
				class="lock-badge-g"
				transform={`translate(${bounds.minX + hexWidth * 0.72} ${bounds.minY + hexHeight * 0.74})`}
			>
				<circle r="10" class="lock-bg" />
				<path d="M-3 -1 v-2.2 a3 3 0 0 1 6 0 v2.2" class="lock-arc" />
				<rect x="-4.5" y="-1" width="9" height="7" rx="1.6" class="lock-body" />
			</g>
			{#if lockedReason}
				<g
					class="reason-g"
					class:revealed={reasonRevealed}
					transform={`translate(${center.x} ${center.y})`}
				>
					<rect x={-reasonW / 2} y="-11" width={reasonW} height="22" rx="6" class="reason-bg" />
					<text x="0" y="0.5" text-anchor="middle" dominant-baseline="central" class="reason-text"
						>{lockedReason}</text
					>
				</g>
			{/if}
		</g>
	{/if}

	{#if augments.length > 0}
		<g class="augment-badge" transform={`translate(${augX} ${augY})`}>
			<title>{augmentNames}</title>
			{#if augments[0].icon}
				<defs>
					<!-- A black outline tracing the augment hexagon's OWN shape: dilate the token's
					     alpha, flood it black, then lay the token back on top. No disc, no ring. -->
					<filter id={`aug-outline-${slotIndex}`} x="-30%" y="-30%" width="160%" height="160%">
						<feMorphology in="SourceAlpha" operator="dilate" radius={Math.max(0.4, augR * 0.05)} result="dil" />
						<feFlood flood-color="#3a3a3a" flood-opacity="0.95" result="blk" />
						<feComposite in="blk" in2="dil" operator="in" result="outline" />
						<feMerge>
							<feMergeNode in="outline" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
				</defs>
				<image
					href={augments[0].icon}
					x={-augR}
					y={-augR}
					width={augR * 2}
					height={augR * 2}
					preserveAspectRatio="xMidYMid meet"
					filter={`url(#aug-outline-${slotIndex})`}
				/>
			{:else}
				<circle cx="0" cy="0" r={augR} class="aug-bg" />
				<text x="0" y="0" text-anchor="middle" dominant-baseline="central" class="aug-initial"
					>{augments[0].name.slice(0, 1)}</text
				>
			{/if}
			{#if augments.length > 1}
				<circle cx={augR * 0.85} cy={-augR * 0.85} r={augR * 0.62} class="aug-count-bg" />
				<text
					x={augR * 0.85}
					y={-augR * 0.85}
					text-anchor="middle"
					dominant-baseline="central"
					class="aug-count">+{augments.length - 1}</text
				>
			{/if}
		</g>
	{/if}

	{#if augmentDroppable}
		<g
			class="augment-drop"
			role="button"
			tabindex="0"
			aria-label={`Place augment on ${spirit?.name ?? 'spirit'}`}
			data-augment-drop={slotIndex}
			ondragover={(e) => e.preventDefault()}
			ondrop={(e) => {
				e.preventDefault();
				onDropAugment?.(slotIndex);
			}}
			onclick={() => onDropAugment?.(slotIndex)}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onDropAugment?.(slotIndex);
				}
			}}
		>
			<!-- The polygon carries the data attribute so elementFromPoint hits work on touch. -->
			<polygon points={polygonPoints} class="augment-drop-tint" data-augment-drop={slotIndex} />
		</g>
	{/if}
</g>

<style>
	.spirit-hex {
		cursor: pointer;
	}

	.spirit-hex .hex-border {
		transition:
			stroke 0.2s ease,
			stroke-width 0.2s ease,
			filter 0.2s ease;
	}

	/* Gate glow on hover behind fine-pointer query so it doesn't stick on touch. */
	@media (hover: hover) and (pointer: fine) {
		.spirit-hex:hover .hex-border {
			filter: drop-shadow(0 0 8px rgba(255, 43, 199, 0.4));
		}

		.spirit-hex:hover .spirit-image {
			opacity: 0.9;
		}
	}

	.spirit-hex .spirit-image {
		transition: opacity 0.2s ease;
	}

	/* Inspect mode: a clickable hex that opens the spirit detail card. The tint is
	   invisible until hover/focus, and stays lit (cyan) while this spirit is selected. */
	.select-hit {
		cursor: pointer;
	}
	.select-hit:focus {
		outline: none;
	}
	.select-tint {
		fill: transparent;
		pointer-events: all;
		stroke: var(--brand-cyan, #5cdfff);
		stroke-width: 2.5;
		stroke-opacity: 0;
		transition: stroke-opacity 0.15s ease, fill 0.15s ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.select-hit:hover .select-tint {
			stroke-opacity: 0.6;
		}
	}
	.select-hit:focus-visible .select-tint {
		stroke-opacity: 1;
	}
	.select-tint.selected {
		stroke-opacity: 1;
		fill: rgba(92, 223, 255, 0.12);
		filter: drop-shadow(0 0 8px rgba(92, 223, 255, 0.5));
	}

	/* Discard mode: a clickable red overlay on occupied hexes. */
	.discard-hit {
		cursor: pointer;
	}
	.discard-hit:focus {
		outline: none;
	}
	.discard-tint {
		fill: rgba(180, 20, 30, 0);
		stroke: var(--color-blood, #e05858);
		stroke-width: 2.5;
		stroke-opacity: 0.65;
		transition:
			fill 0.15s ease,
			stroke-opacity 0.15s ease;
	}
	/* Show tint+glyph on hover (desktop) and on focus (keyboard/touch). */
	@media (hover: hover) and (pointer: fine) {
		.discard-hit:hover .discard-tint {
			fill: rgba(180, 20, 30, 0.45);
			stroke-opacity: 1;
		}
		.discard-hit:hover .discard-glyph {
			opacity: 1;
		}
	}
	.discard-hit:focus-visible .discard-tint {
		fill: rgba(180, 20, 30, 0.45);
		stroke-opacity: 1;
	}
	.discard-glyph {
		font-size: 22px;
		/* On touch, always show glyph so the tap target is obvious. */
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
	}
	/* Always reveal the discard glyph on touch (coarse pointer) so users know
	   the hex is tappable — hover is unavailable on touch screens. */
	@media (pointer: coarse) {
		.discard-glyph {
			opacity: 0.7;
		}
		.discard-tint {
			stroke-opacity: 0.85;
		}
	}
	.discard-hit:focus-visible .discard-glyph {
		opacity: 1;
	}
	/* Staged for discard: the mark holds without hover — this hex WILL be lost
	   when the commit bar confirms. Clicking again un-stages. */
	.discard-hit.staged .discard-tint {
		fill: rgba(180, 20, 30, 0.5);
		stroke-opacity: 1;
	}
	.discard-hit.staged .discard-glyph {
		opacity: 1;
		font-size: 26px;
		fill: #fff;
	}

	/* Locked for the active mode: dim the art, keep the object on stage. */
	.spirit-hex.dimmed-hex .spirit-image {
		opacity: 0.38;
		filter: grayscale(0.85) saturate(0.5);
	}
	.locked-hit {
		cursor: not-allowed;
	}
	.locked-hit:focus {
		outline: none;
	}
	.locked-tint {
		fill: rgba(8, 5, 16, 0.25);
		pointer-events: all;
	}
	.lock-bg {
		fill: rgba(10, 6, 20, 0.92);
		stroke: rgba(255, 255, 255, 0.22);
		stroke-width: 1.5;
	}
	.lock-arc {
		fill: none;
		stroke: #b9b4cc;
		stroke-width: 1.8;
		stroke-linecap: round;
	}
	.lock-body {
		fill: #b9b4cc;
	}
	.reason-g {
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
	}
	.reason-g.revealed {
		opacity: 1;
	}
	@media (hover: hover) and (pointer: fine) {
		.locked-hit:hover .reason-g {
			opacity: 1;
		}
	}
	.reason-bg {
		fill: rgba(10, 6, 20, 0.95);
		stroke: rgba(255, 112, 77, 0.55);
		stroke-width: 1;
	}
	.reason-text {
		fill: #ff9a80;
		font-size: 11px;
		font-family: inherit;
	}

	/* Spirit augment badge (bottom-right of the hex) — purely decorative, so it never
	   absorbs a click meant for the inspect/select hit-layer beneath it. */
	.augment-badge {
		pointer-events: none;
	}
	.aug-bg {
		fill: #140a24;
	}
	.aug-initial {
		fill: #ffe8a3;
		font-size: 16px;
		font-family: var(--font-display, 'Bebas Neue', serif);
	}
	.aug-count-bg {
		fill: #d6b24a;
	}
	.aug-count {
		fill: #140a24;
		font-size: 11px;
		font-weight: 700;
	}

	/* Augment drop target (active only while an augment is armed/dragged).
	   On touch the polygon also carries data-augment-drop for elementFromPoint. */
	.augment-drop {
		cursor: copy;
	}
	.augment-drop-tint {
		fill: rgba(157, 77, 255, 0.14);
		stroke: #9d4dff;
		stroke-width: 2.5;
		stroke-opacity: 0.7;
		transition: fill 0.12s ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.augment-drop:hover .augment-drop-tint {
			fill: rgba(157, 77, 255, 0.32);
			stroke-opacity: 1;
		}
	}
	/* On touch, keep the drop tint slightly brighter so armed target is clear. */
	@media (pointer: coarse) {
		.augment-drop-tint {
			fill: rgba(157, 77, 255, 0.22);
			stroke-opacity: 0.9;
		}
	}
</style>
