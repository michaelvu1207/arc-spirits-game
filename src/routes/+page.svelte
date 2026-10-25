<script lang="ts">
	import PlayPage from './play/+page.svelte';
	import SplatBackground from '$lib/components/play2d/SplatBackground.svelte';
	import { getGraphicsSettings } from '$lib/stores/graphicsSettings.svelte';

	const graphics = getGraphicsSettings();
	const SPLAT_SRC = '/splats/abyssal-portal.spz';
</script>

<svelte:head>
	<title>Arc Spirits</title>
</svelte:head>

<div class="play-bg" aria-hidden="true">
	{#if graphics.splatEnabled}
		<SplatBackground src={SPLAT_SRC} blur={0} push={0} />
	{/if}
</div>

<PlayPage />

<style>
	.play-bg {
		position: fixed;
		inset: 0;
		z-index: 0;
		background: var(--color-void, #050310);
	}
</style>
