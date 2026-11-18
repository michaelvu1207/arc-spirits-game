<script lang="ts">
	import { page } from '$app/stores';
	import './plain.css';

	let { children } = $props();

	const path = $derived($page.url.pathname);
	// The round-by-round game viewer has its own bar. It is not one of the tabs: the game's
	// "full replay" link opens it (GameDetailPanel).
	const inGame = $derived(path.startsWith('/explorer/game/'));
	const tabs = [
		{ href: '/explorer', label: 'Balance', on: (p: string) => p === '/explorer' || p === '/explorer/' },
		{ href: '/explorer/spirits/world', label: 'Spirit World', on: (p: string) => p.startsWith('/explorer/spirits/world') },
		{ href: '/explorer/spirits/arcane', label: 'Arcane Abyss', on: (p: string) => p.startsWith('/explorer/spirits/arcane') },
		{ href: '/explorer/spirits/heroes', label: 'Heroes', on: (p: string) => p.startsWith('/explorer/spirits/heroes') }
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
