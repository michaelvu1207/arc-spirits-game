<script lang="ts">
	import type { Snippet } from 'svelte';
	import SplatBackground from '$lib/components/play2d/SplatBackground.svelte';
	import { getGraphicsSettings } from '$lib/stores/graphicsSettings.svelte';

	let { children }: { children: Snippet } = $props();

	const graphics = getGraphicsSettings();

	// The Arcane Abyss world that sits behind every /play screen.
	const SPLAT_SRC = '/splats/abyssal-portal.spz';
</script>

<!--
	Persistent world. Mounted ONCE for the entire /play section: because this layout
	is shared by every /play/* route, SvelteKit keeps it alive across client-side
	navigation and only swaps the page below. The splat therefore never tears down
	and re-initialises (no WebGL rebuild, no .spz re-fetch, no black flash + fade-in) —
	the foreground UI just transitions over a continuous background.

	MenuShell is transparent so this shows through; the void color here is the
	fallback when the player turns the splat Background Off.
-->
<div class="play-bg" aria-hidden="true">
	{#if graphics.splatEnabled}
		<SplatBackground src={SPLAT_SRC} blur={0} push={0} />
	{/if}
</div>

{@render children()}

<!--
	Landscape gate. Arc Spirits is a landscape-only experience: phone-sized viewports
	in portrait get this full-screen prompt instead of the game. It's driven purely by
	a media query (no JS), so it also appears in the responsive-preview iframes and
	hides the instant the device is turned sideways. Tablets/desktop (>600px) are never
	gated.
-->
<div class="rotate-gate" role="alertdialog" aria-label="Rotate your device to play">
	<div class="rg-inner">
		<div class="rg-phone" aria-hidden="true">
			<span class="rg-phone-body"></span>
		</div>
		<p class="rg-title">Rotate your device</p>
		<p class="rg-sub">Arc Spirits plays in landscape.<br />Turn your phone sideways to continue.</p>
	</div>
</div>

<style>
	.play-bg {
		position: fixed;
		inset: 0;
		z-index: 0;
		background: var(--color-void, #050310);
	}

	/* ── Landscape gate ───────────────────────────────────────── */
	.rotate-gate {
		/* Hidden by default; only phone-portrait turns it on (see media query). */
		display: none;
		position: fixed;
		inset: 0;
		z-index: 10000; /* above every play surface incl. the profile dock (9500) */
		align-items: center;
		justify-content: center;
		padding: 32px;
		text-align: center;
		background:
			radial-gradient(ellipse 80% 60% at 50% 30%, rgba(123, 29, 255, 0.18), transparent 70%),
			var(--color-void, #050310);
		color: var(--color-bone, #f5f0ff);
	}
	.rg-inner {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 18px;
		max-width: 320px;
	}
	.rg-title {
		margin: 4px 0 0;
		font-family: var(--font-display, sans-serif);
		font-size: 1.5rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.rg-sub {
		margin: 0;
		font-family: var(--font-body, sans-serif);
		font-size: 0.95rem;
		line-height: 1.55;
		color: var(--color-fog, #9a8fb8);
	}

	/* A little phone that tips from portrait to landscape, on a loop. */
	.rg-phone {
		width: 64px;
		height: 64px;
		display: grid;
		place-items: center;
	}
	.rg-phone-body {
		display: block;
		width: 34px;
		height: 58px;
		border: 3px solid var(--brand-magenta, #ff2bc7);
		border-radius: 8px;
		box-shadow: 0 0 22px rgba(255, 43, 199, 0.5);
		transform-origin: center;
		animation: rg-tip 2.4s ease-in-out infinite;
	}
	@keyframes rg-tip {
		0%,
		18% {
			transform: rotate(0deg);
		}
		42%,
		72% {
			transform: rotate(-90deg);
		}
		95%,
		100% {
			transform: rotate(0deg);
		}
	}

	/* The gate: phone-sized AND portrait. ≤600px excludes tablets (iPad portrait is
	   820px) and desktop; orientation:portrait means it vanishes the moment the phone
	   is turned sideways. */
	@media (max-width: 600px) and (orientation: portrait) {
		.rotate-gate {
			display: flex;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.rg-phone-body {
			animation: none;
			transform: rotate(-90deg);
		}
	}
</style>
