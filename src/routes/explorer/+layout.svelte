<script lang="ts">
	import { page } from '$app/stores';
	import './plain.css';

	let { children } = $props();

	const path = $derived($page.url.pathname);
	// The game viewer has its own bar (with the way back to the records).
	const inGame = $derived(path.startsWith('/explorer/game/'));
	const tabs = [
		{ href: '/explorer', label: 'Trends', on: (p: string) => p === '/explorer' || p === '/explorer/' },
		{ href: '/explorer/games', label: 'Games', on: (p: string) => p.startsWith('/explorer/games') },
		{ href: '/explorer/leaderboard', label: 'Leaderboard', on: (p: string) => p.startsWith('/explorer/leaderboard') },
		{ href: '/explorer/players', label: 'Players', on: (p: string) => p.startsWith('/explorer/players') }
	];
</script>

<svelte:head>
	<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap" rel="stylesheet" />
</svelte:head>

<div class="explorer">
	{#if !inGame}
		<nav class="tabs-underline explorer-nav">
			{#each tabs as tab (tab.href)}
				<a href={tab.href} class="tab-btn" class:active={tab.on(path)}>{tab.label}</a>
			{/each}
		</nav>
	{/if}
	<div class="explorer-page">
		{@render children()}
	</div>
</div>

<style>
	/* One screen, like the game: the page never scrolls, lists scroll inside their panel. */
	.explorer {
		--app-topbar-height: 0px;
		height: 100vh;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.explorer-nav {
		flex: none;
		padding: 10px 32px 0;
	}
	.explorer-nav a {
		text-decoration: none;
	}
	.explorer-page {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
</style>
