<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { isNativeShell } from '$lib/auth/nativeOAuth';
	import AngelsidePoster from '$lib/components/studio/AngelsidePoster.svelte';

	// ANGELSIDE Studios homepage. The game itself lives at /game.
	onMount(() => {
		// The native app bundles this same client; it must open on the game menu.
		if (isNativeShell()) void goto('/game', { replaceState: true });
	});
</script>

<svelte:head>
	<title>Angelside Studios</title>
</svelte:head>

<AngelsidePoster />
