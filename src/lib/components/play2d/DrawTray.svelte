<script lang="ts">
	import { STORAGE_BASE_URL } from '$lib/supabase';
	import type { PlayerProjection } from '$lib/play/types';
	import { launchSummonFx } from '$lib/stores/summonFx.svelte';
	import { playSfx } from '$lib/stores/gameAudio.svelte';
	import { getSpiritAsset } from '$lib/stores/assetStore.svelte';
	import { spiritBackImageUrl } from './helpers';

	// Heroes are the Human Enclave faction (origin always active — see captain.ts).
	function isHero(id: string): boolean {
		return !!getSpiritAsset(id)?.traits.origins.some((o) => o.name === 'Human Enclave');
	}

	interface Props {
		player: PlayerProjection | null;
		spiritImages?: Map<string, string>;
		disabled?: boolean;
		onSummon?: (guid: string) => void;
		onDiscard?: () => void;
		onRedraw?: () => void;
	}

	let {
		player,
		spiritImages = new Map(),
		disabled = false,
		onSummon,
		onDiscard,
		onRedraw
	}: Props = $props();

	const draws = $derived(player?.handDraws ?? []);
	const pending = $derived(player?.pendingDraw ?? null);
	const picksLeft = $derived(
		pending ? Math.max(0, pending.summonLimit - pending.summonedCount) : 0
	);
	// Soul Weaver: while a redraw is armed, offer to put these back and draw again.
	const canRedraw = $derived(!!player?.redrawAvailable && draws.length > 0);

	// Cards materialising into the tray → one-shot summon shimmer.
	let summonAnnounced = false;
	$effect(() => {
		if (draws.length > 0 && pending) {
			if (!summonAnnounced) {
				summonAnnounced = true;
				playSfx('summon-draw');
			}
		} else {
			summonAnnounced = false;
		}
	});

	function preview(draw: { id?: string; sourceBag?: string }): string | null {
		if (!draw.id) return null;
		// Arcane Abyss spirits enter unawakened (face-down) — show their back face.
		// Hero (Human Enclave) spirits are likewise drawn face-down — show their back.
		if (draw.sourceBag === 'Arcane Abyss Bag' || isHero(draw.id)) {
			return spiritBackImageUrl(draw.id);
		}
		return spiritImages.get(draw.id) ?? `${STORAGE_BASE_URL}/hex_spirits/${draw.id}_game_print.png`;
	}

	// Guids mid-flight — the original card hides instantly so the flying clone (owned
	// by the persistent <SummonFxLayer/>) takes over the motion.
	let flyingGuids = $state<Set<string>>(new Set());

	// Stable "fun spin" flag — roughly 1 in 3 spirits barrel-roll as they fly in.
	function spins(guid: string): boolean {
		let h = 0;
		for (let k = 0; k < guid.length; k++) h = (h + guid.charCodeAt(k)) % 100;
		return h < 34;
	}

	function prefersReducedMotion(): boolean {
		return (
			typeof window !== 'undefined' &&
			!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
		);
	}
	function tableauRect(): DOMRect | null {
		if (typeof document === 'undefined') return null;
		return (
			document.querySelector('[data-testid="spirit-hex-card"]')?.getBoundingClientRect() ?? null
		);
	}

	function summon(
		draw: { guid: string; id?: string; name?: string; sourceBag?: string },
		event: MouseEvent
	) {
		if (disabled || picksLeft <= 0) return;

		if (!prefersReducedMotion() && typeof window !== 'undefined') {
			const src = (event.currentTarget as HTMLElement).getBoundingClientRect();
			// Fire the burst + flyer in the persistent overlay so it finishes even after
			// this tray unmounts (which happens the instant the last pick resolves).
			launchSummonFx(src, tableauRect(), preview(draw), draw.name ?? 'Spirit');
			// Hide the original instantly; restore after the flight in case the summon is
			// rejected and the card lingers (normally it leaves `draws` first).
			const guid = draw.guid;
			flyingGuids = new Set(flyingGuids).add(guid);
			window.setTimeout(() => {
				const next = new Set(flyingGuids);
				next.delete(guid);
				flyingGuids = next;
			}, 1000);
		}

		onSummon?.(draw.guid);
	}

	// Cursor-parallax tilt: rotate the spirit toward the pointer for a 3D feel.
	// Disabled on coarse (touch) pointers — the tilt would freeze on lift.
	const isFinePointer =
		typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;

	function tilt(event: PointerEvent) {
		if (!isFinePointer) return;
		const card = event.currentTarget as HTMLElement;
		const inner = card.querySelector('.tiltable') as HTMLElement | null;
		if (!inner) return;
		const r = card.getBoundingClientRect();
		const px = (event.clientX - r.left) / r.width - 0.5; // -0.5 … 0.5
		const py = (event.clientY - r.top) / r.height - 0.5;
		inner.style.transform = `rotateY(${px * 26}deg) rotateX(${-py * 26}deg) scale(1.06)`;
	}
	function untilt(event: PointerEvent) {
		if (!isFinePointer) return;
		const inner = (event.currentTarget as HTMLElement).querySelector(
			'.tiltable'
		) as HTMLElement | null;
		if (inner) inner.style.transform = '';
	}
</script>

{#if draws.length > 0 && pending}
	<section class="tray" data-testid="draw-tray">
		<header class="head">
			<span class="title">{pending.sourceBag}</span>
			<span class="sub" data-testid="picks-left"
				>Choose a spirit — {picksLeft} pick{picksLeft === 1 ? '' : 's'} left</span
			>
		</header>
		<div class="cards">
			{#each draws as draw, i (draw.guid)}
				<button
					data-testid="draw-card"
					type="button"
					class="card"
					class:flying={flyingGuids.has(draw.guid)}
					class:spin={spins(draw.guid)}
					style="--i: {i}; --art: {preview(draw) ? `url('${preview(draw)}')` : 'none'};"
					disabled={disabled || picksLeft <= 0}
					onclick={(e) => summon(draw, e)}
					onpointermove={tilt}
					onpointerleave={untilt}
				>
					<span class="floater">
						<span class="tiltable">
							<span class="aura" aria-hidden="true"></span>
							{#if preview(draw)}
								<img src={preview(draw)} alt={draw.name ?? 'Spirit'} loading="lazy" />
							{:else}
								<span class="card-fallback">{draw.name ?? 'Spirit'}</span>
							{/if}
							<span class="sheen" aria-hidden="true"></span>
						</span>
					</span>
				</button>
			{/each}
		</div>
		<div class="tray-actions">
			{#if canRedraw}
				<button
					type="button"
					class="redraw"
					data-testid="draw-redraw"
					{disabled}
					onclick={() => onRedraw?.()}
				>
					↻ Redraw <span class="redraw-src">Soul Weaver</span>
				</button>
			{/if}
			<button
				type="button"
				class="discard"
				data-testid="draw-discard"
				{disabled}
				onclick={() => onDiscard?.()}
			>
				Return unchosen
			</button>
		</div>
	</section>
{/if}

<style>
	.tray {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.1rem;
		width: 100%;
		max-height: 100%;
		min-height: 0;
		box-sizing: border-box;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}
	.head {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
	}
	.title {
		font-family: var(--font-display);
		font-size: clamp(1.8rem, 3.2vw, 2.8rem);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #fff;
		text-align: center;
		line-height: 1.1;
		text-shadow: 0 0 24px color-mix(in srgb, var(--brand-violet, #5a2bff) 70%, transparent);
	}
	.sub {
		font-family: var(--font-display);
		font-size: 1rem;
		letter-spacing: 0.06em;
		color: var(--brand-cyan, #5cdfff);
	}

	/* 3D scene: the cards live in a shared perspective so they read as volumetric. */
	.cards {
		display: flex;
		gap: 1.4rem;
		flex-wrap: nowrap;
		justify-content: center;
		align-items: center;
		width: 100%;
		max-width: min(1100px, 100%);
		margin: 0 auto;
		padding: 2.5rem 0;
		perspective: 1200px;
		perspective-origin: 50% 40%;
	}
	.card {
		display: block;
		flex: 1 1 0;
		min-width: 0;
		max-width: 17rem;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		color: inherit;
		font: inherit;
		transform-style: preserve-3d;
	}
	.card:disabled {
		cursor: not-allowed;
	}
	.card:disabled .floater {
		opacity: 0.5;
		animation-play-state: paused;
	}
	/* The clicked card vanishes instantly; its flying clone carries the motion. */
	.card.flying {
		opacity: 0;
		transform: scale(0.7);
		pointer-events: none;
		transition:
			opacity 0.16s ease,
			transform 0.16s ease;
	}

	/* Layer 1 — emerges from the bag, then bobs/sways in 3D forever. */
	.floater {
		display: block;
		transform-style: preserve-3d;
		animation:
			summon-in 0.95s cubic-bezier(0.18, 0.7, 0.2, 1) calc(var(--i) * 0.1s) both,
			float3d calc(5.5s + var(--i) * 0.5s) ease-in-out calc(var(--i) * 0.1s + 0.95s) infinite;
	}
	/* ~1 in 3 spirits get a fun full 360° barrel-roll as they fly in. */
	.card.spin .floater {
		animation:
			summon-in-spin 1.05s cubic-bezier(0.18, 0.7, 0.2, 1) calc(var(--i) * 0.1s) both,
			float3d calc(5.5s + var(--i) * 0.5s) ease-in-out calc(var(--i) * 0.1s + 1.05s) infinite;
	}
	/* Layer 2 — tilts toward the cursor (transform set inline by JS). */
	.tiltable {
		position: relative;
		display: block;
		transform-style: preserve-3d;
		transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.card img,
	.card-fallback {
		display: block;
		width: 100%;
		height: auto;
		object-fit: contain;
		border-radius: 10px;
		position: relative;
		z-index: 1;
		backface-visibility: hidden;
	}
	.card img {
		filter: drop-shadow(0 14px 26px rgba(0, 0, 0, 0.55));
		transition: filter 200ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.card:hover img {
			filter: drop-shadow(0 18px 34px rgba(0, 0, 0, 0.6))
				drop-shadow(0 0 22px color-mix(in srgb, var(--brand-magenta, #ff2bc7) 60%, transparent));
		}
	}
	.card-fallback {
		display: grid;
		place-items: center;
		aspect-ratio: 13 / 17;
		border: 1px dashed rgba(255, 255, 255, 0.18);
		font-size: 0.8rem;
		color: var(--color-fog, #8d8aa1);
		background: rgba(8, 5, 16, 0.6);
	}
	/* A breathing aura behind the spirit (sits closer to the viewer in 3D). */
	.aura {
		position: absolute;
		inset: -14%;
		z-index: 0;
		border-radius: 50%;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--brand-violet, #5a2bff) 55%, transparent) 0%,
			color-mix(in srgb, var(--brand-magenta, #ff2bc7) 28%, transparent) 45%,
			transparent 70%
		);
		filter: blur(10px);
		opacity: 0.55;
		animation: aura-pulse 3.6s ease-in-out infinite;
		transform: translateZ(-40px);
	}
	@media (hover: hover) and (pointer: fine) {
		.card:hover .aura {
			opacity: 0.9;
		}
	}
	/* A moving holographic sheen across the art. */
	.sheen {
		position: absolute;
		inset: 0;
		z-index: 2;
		background: linear-gradient(
			115deg,
			transparent 30%,
			rgba(255, 255, 255, 0.34) 47%,
			rgba(180, 230, 255, 0.2) 53%,
			transparent 70%
		);
		background-size: 280% 280%;
		mix-blend-mode: screen;
		opacity: 0;
		pointer-events: none;
		transition: opacity 200ms ease;
		/* Clip the shine to the spirit's real silhouette (its art's alpha), not the
		   card rectangle — so it never reads as a square overlay. */
		-webkit-mask-image: var(--art, none);
		mask-image: var(--art, none);
		-webkit-mask-size: contain;
		mask-size: contain;
		-webkit-mask-repeat: no-repeat;
		mask-repeat: no-repeat;
		-webkit-mask-position: center;
		mask-position: center;
	}
	@media (hover: hover) and (pointer: fine) {
		.card:hover .sheen {
			opacity: 1;
			animation: sheen-sweep 1.1s ease-in-out;
		}
	}

	@keyframes summon-in {
		0% {
			opacity: 0;
			transform: translateY(190px) translateZ(-420px) rotateX(38deg) rotateZ(-10deg) scale(0.16);
			filter: blur(8px) brightness(2.6);
		}
		45% {
			opacity: 1;
			filter: blur(0) brightness(1.45);
		}
		72% {
			/* overshoot a touch past full size for the satisfying "pop" */
			transform: translateY(-10px) translateZ(0) rotateX(0) rotateZ(2deg) scale(1.09);
			filter: brightness(1.12);
		}
		100% {
			opacity: 1;
			transform: translateY(0) translateZ(0) rotateX(0) rotateZ(0) scale(1);
			filter: blur(0) brightness(1);
		}
	}
	/* Same fly-in arc, but spun a full turn for a fun flourish. */
	@keyframes summon-in-spin {
		0% {
			opacity: 0;
			transform: translateY(190px) translateZ(-420px) rotateY(-360deg) scale(0.16);
			filter: blur(8px) brightness(2.6);
		}
		45% {
			opacity: 1;
			filter: blur(0) brightness(1.45);
		}
		72% {
			transform: translateY(-10px) translateZ(0) rotateY(0deg) scale(1.09);
			filter: brightness(1.12);
		}
		100% {
			opacity: 1;
			transform: translateY(0) translateZ(0) rotateY(0deg) scale(1);
			filter: blur(0) brightness(1);
		}
	}
	@keyframes float3d {
		0% {
			transform: translate3d(0, 0, 0) rotateZ(0deg) rotateY(-7deg) rotateX(3deg);
		}
		25% {
			transform: translate3d(7px, -11px, 0) rotateZ(1.6deg) rotateY(6deg) rotateX(-2deg);
		}
		50% {
			transform: translate3d(0, -17px, 0) rotateZ(0deg) rotateY(9deg) rotateX(-3deg);
		}
		75% {
			transform: translate3d(-7px, -9px, 0) rotateZ(-1.6deg) rotateY(2deg) rotateX(2deg);
		}
		100% {
			transform: translate3d(0, 0, 0) rotateZ(0deg) rotateY(-7deg) rotateX(3deg);
		}
	}
	@keyframes aura-pulse {
		0%,
		100% {
			opacity: 0.45;
			transform: translateZ(-40px) scale(0.94);
		}
		50% {
			opacity: 0.75;
			transform: translateZ(-40px) scale(1.06);
		}
	}
	@keyframes sheen-sweep {
		0% {
			background-position: 150% 0;
		}
		100% {
			background-position: -150% 0;
		}
	}

	.tray-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
		justify-content: center;
	}
	.discard,
	.redraw {
		padding: 9px 18px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		border: 1px solid var(--color-mist, #3a2670);
		background: transparent;
		color: var(--color-parchment, #e7e0cf);
		border-radius: 3px;
		cursor: pointer;
		transition:
			border-color 140ms ease,
			color 140ms ease,
			box-shadow 140ms ease;
	}
	/* The redraw is the Soul Weaver's signature affordance — give it the brand cyan
	   glow so it reads as a class power, not a plain secondary action. */
	.redraw {
		border-color: color-mix(in srgb, var(--brand-cyan, #5cdfff) 65%, transparent);
		color: var(--brand-cyan, #5cdfff);
		box-shadow: 0 0 14px color-mix(in srgb, var(--brand-cyan, #5cdfff) 30%, transparent);
	}
	.redraw-src {
		opacity: 0.7;
		font-size: 0.68rem;
		letter-spacing: 0.08em;
	}
	@media (hover: hover) and (pointer: fine) {
		.redraw:hover:not(:disabled) {
			border-color: var(--brand-cyan, #5cdfff);
			box-shadow: 0 0 22px color-mix(in srgb, var(--brand-cyan, #5cdfff) 50%, transparent);
		}
	}
	.redraw:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	@media (hover: hover) and (pointer: fine) {
		.discard:hover:not(:disabled) {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff7fd9);
		}
	}
	.discard:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ── Mobile layout (phones ≤600px) ─────────────────────────────────────── */
	@media (max-width: 600px) {
		.cards {
			flex-wrap: wrap;
			max-width: 100%;
			gap: 1rem;
			padding: 1.5rem 0.75rem;
		}
		/* ~2 cards per row */
		.card {
			flex: 0 1 calc(50% - 0.5rem);
			max-width: calc(50% - 0.5rem);
			touch-action: manipulation;
			-webkit-tap-highlight-color: transparent;
			user-select: none;
		}
		.discard {
			min-height: 44px;
			padding: 10px 22px;
			touch-action: manipulation;
			user-select: none;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.tray {
			gap: 0.45rem;
			padding-bottom: 0.25rem;
		}
		.head {
			gap: 0.08rem;
		}
		.title {
			font-size: 1rem;
			line-height: 1;
		}
		.sub {
			font-size: 0.68rem;
			line-height: 1.05;
		}
		.cards {
			flex-wrap: nowrap;
			gap: 0.65rem;
			padding: 0.75rem 0.25rem;
		}
		.card {
			flex: 1 1 0;
			max-width: 9.75rem;
		}
		.tray-actions {
			gap: 0.45rem;
		}
		.discard,
		.redraw {
			min-height: 34px;
			padding: 7px 16px;
			font-size: 0.68rem;
			letter-spacing: 0.09em;
		}
		.redraw-src {
			font-size: 0.58rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.floater,
		.aura {
			animation: none;
		}
	}
</style>
