<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import SplatBackground from '$lib/components/play2d/SplatBackground.svelte';
	import { getGraphicsSettings } from '$lib/stores/graphicsSettings.svelte';
	import { heavyBackgroundHeld } from '$lib/stores/backgroundGate.svelte';

	let { children }: { children: Snippet } = $props();

	const graphics = getGraphicsSettings();

	// The Arcane Abyss world that sits behind every /play screen.
	const SPLAT_SRC = '/splats/abyssal-portal.spz';

	// ── Heavy-init scheduling ────────────────────────────────────────────────
	// Splat INITIALIZATION is a real multi-second native main-thread stall
	// (WASM compile + first GPU upload of ~1M gaussians). It must never land on
	// the critical first paint or inside a latency-sensitive flow (Quick Play's
	// poll timers, a held matched-room navigation — those take a HOLD via
	// $lib/stores/backgroundGate). So the FIRST mount waits for idle + no holds;
	// once mounted the splat stays (a persistent layout — see below), because
	// re-initializing would repeat the very stall this defers.
	let idleReady = $state(false);
	let splatEverShown = $state(false);
	onMount(() => {
		const arm = () => (idleReady = true);
		if (typeof requestIdleCallback === 'function') {
			requestIdleCallback(arm, { timeout: 2500 });
		} else {
			setTimeout(arm, 800);
		}
	});
	$effect(() => {
		if (graphics.splatEnabled && idleReady && !heavyBackgroundHeld()) splatEverShown = true;
	});
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
	{#if graphics.splatEnabled && splatEverShown}
		<SplatBackground src={SPLAT_SRC} blur={0} push={0} />
	{/if}
</div>

{@render children()}

<!--
	NOTE: the "rotate your device" landscape gate used to live here, gating EVERY
	/play surface (menus included). Pre-game screens are now portrait-capable, so
	the gate moved to game entry only — see RotateGate.svelte, mounted next to the
	game board in routes/play/[roomCode]/+page.svelte.
-->

<style>
	.play-bg {
		position: fixed;
		inset: 0;
		z-index: 0;
		background: var(--color-void, #050310);
	}
</style>
