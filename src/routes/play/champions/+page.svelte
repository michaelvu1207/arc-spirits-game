<script lang="ts">
	import { onMount } from 'svelte';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import Champions2DScreen from '$lib/components/play2d/screens/Champions2DScreen.svelte';
	import { loadAssets } from '$lib/stores/assetStore.svelte';

	onMount(() => {
		// Match the play menu's immersive full-screen (hides global chrome, locks scroll).
		document.documentElement.classList.add('immersive-play');
		document.body.classList.add('immersive-play');
		void loadAssets();
		return () => {
			document.documentElement.classList.remove('immersive-play');
			document.body.classList.remove('immersive-play');
		};
	});
</script>

<svelte:head>
	<title>Hall of Champions | Arc Spirits</title>
</svelte:head>

<MenuShell>
	<Champions2DScreen />
</MenuShell>
