<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth/auth.svelte';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import MatchHistoryOverlay from '$lib/components/play2d/MatchHistoryOverlay.svelte';
	import DetailOverlay from '$lib/components/play2d/screens/DetailOverlay.svelte';
	import StateMessage from '$lib/components/play2d/screens/StateMessage.svelte';

	// Game Records now shows the player's own finished games (match_results +
	// match_result_players) with a replay link per game. The old all-games list
	// (RecordsScreen) read the game_summaries view over round snapshots, which the
	// minimal database does not have and new games never write.

	let ready = $state(false);
	const userId = $derived(auth.user?.id ?? null);

	onMount(() => {
		// Match the play menu's immersive full-screen (hides global chrome, locks scroll).
		document.documentElement.classList.add('immersive-play');
		document.body.classList.add('immersive-play');
		void auth.whenInitialized().then(() => (ready = true));
		return () => {
			document.documentElement.classList.remove('immersive-play');
			document.body.classList.remove('immersive-play');
		};
	});

	const back = () => goto('/play');
</script>

<svelte:head>
	<title>Game Records | Arc Spirits</title>
</svelte:head>

<MenuShell>
	{#if userId}
		<MatchHistoryOverlay {userId} displayName={auth.displayName} onClose={back} />
	{:else}
		<DetailOverlay eyebrow="Your Chronicle" title="Past Games" onClose={back}>
			{#if !ready}
				<StateMessage loading compact message="Summoning your games from the abyss…" />
			{:else}
				<StateMessage
					compact
					title="No conjurings recorded"
					message="Sign in or play a game as a guest — your finished games and their replays appear here."
				/>
			{/if}
		</DetailOverlay>
	{/if}
</MenuShell>
