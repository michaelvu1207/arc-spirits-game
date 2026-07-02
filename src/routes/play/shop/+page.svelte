<script lang="ts">
	import { onMount } from 'svelte';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import ShopScreen from '$lib/components/play2d/screens/ShopScreen.svelte';

	onMount(() => {
		document.documentElement.classList.add('immersive-play');
		document.body.classList.add('immersive-play');
		return () => {
			document.documentElement.classList.remove('immersive-play');
			document.body.classList.remove('immersive-play');
		};
	});
</script>

<svelte:head>
	<title>Abyss Market | Arc Spirits</title>
</svelte:head>

<MenuShell>
	<ShopScreen />
</MenuShell>
