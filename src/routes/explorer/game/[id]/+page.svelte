<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import RuleChanges from '$lib/components/explorer/RuleChanges.svelte';
	import { fetchBalance, type BalanceData } from '$lib/explorerBalance';
	import Game from '../../../admin/game/[id]/+page.svelte';

	// The viewer as a visitor sees it: no admin tag editor.
	const data = $derived({
		gameId: $page.params.id ?? '',
		isAdmin: false,
		taggingConfigError: null,
		compositionTagsByColor: {},
		tagOptions: []
	});

	// A test game was played under rules that differ from the live game, and the viewer's cards
	// are the live game's. Its run (from the balance data) gives the rules for the "Rules" tab.
	let balance = $state<BalanceData | null>(null);
	onMount(() => {
		void fetchBalance().then((b) => (balance = b)).catch(() => {});
	});
	const run = $derived.by(() => {
		const game = balance?.run_games?.find((g) => g.game_id === data.gameId);
		return (game && balance?.runs?.find((r) => r.id === game.run)) ?? null;
	});
</script>

{#snippet rules()}
	{#if run?.changes}
		<h2>Rules this game was played under</h2>
		<p class="lead">{run.setup}. First to {run.changes.win_points} points. The cards and pictures in this viewer show the live game; the abilities, awakening conditions and monster numbers below are the ones the players had.</p>
		<RuleChanges changes={run.changes} />
	{/if}
{/snippet}

{#key data.gameId}
	<Game {data} explorer rules={run?.changes ? rules : undefined} />
{/key}

<style>
	.lead { margin: 4px 0 14px; color: var(--dim); max-width: 110ch; }
</style>
