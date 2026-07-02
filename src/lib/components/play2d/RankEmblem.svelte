<script lang="ts">
	import { RANKS, type RankId } from '$lib/cosmetics/progression';

	interface Props {
		rankId: RankId;
		size?: 'sm' | 'lg';
		label?: string;
	}

	let { rankId, size = 'sm', label }: Props = $props();

	const rank = $derived(RANKS.find((entry) => entry.id === rankId) ?? RANKS[0]!);
	const x = $derived(rank.sheetColumn * 20);
	const y = $derived(size === 'sm' ? 0 : 100);
</script>

<span
	class="rank-emblem"
	class:large={size === 'lg'}
	style="--x: {x}%; --y: {y}%; --accent: {rank.accent}"
	role="img"
	aria-label={label ?? `${rank.name} rank`}
	title={label ?? `${rank.name} rank`}
></span>

<style>
	.rank-emblem {
		display: inline-block;
		width: 28px;
		height: 28px;
		flex: none;
		background-image: url('/cosmetics/rank-emblems.png');
		background-size: 600% 200%;
		background-position: var(--x) var(--y);
		background-repeat: no-repeat;
		filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 45%, transparent));
	}
	.rank-emblem.large {
		width: clamp(132px, 18vw, 220px);
		height: clamp(132px, 18vw, 220px);
		filter: drop-shadow(0 0 24px color-mix(in srgb, var(--accent) 38%, transparent));
	}
</style>
