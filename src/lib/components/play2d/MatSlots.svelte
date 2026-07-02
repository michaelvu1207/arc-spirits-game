<script lang="ts">
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import type { PlayerProjection } from '$lib/play/types';
	import { RUNE_CARRY_LIMIT } from '$lib/play/types';
	import { runeIconUrl } from './helpers';

	interface Props {
		player: PlayerProjection | null;
		assets: ReturnType<typeof getAssetState>;
		/** 'column' (the original bottom-right column) or 'row' (a horizontal strip). */
		orientation?: 'row' | 'column';
	}

	let { player, assets, orientation = 'column' }: Props = $props();

	// Only runes/relics actually carried (spent slots are dropped from the view).
	const held = $derived(
		[...(player?.mats ?? [])].filter((r) => r.hasRune).sort((a, b) => a.slotIndex - b.slotIndex)
	);
	const overLimit = $derived(held.length > RUNE_CARRY_LIMIT);
	// Up to the carry limit, show that many padded slots; past it, show the overflow.
	const display = $derived(
		overLimit
			? held
			: Array.from({ length: RUNE_CARRY_LIMIT }, (_, i) => held[i] ?? null)
	);
</script>

<div class="rune-col" class:row={orientation === 'row'} data-testid="rune-slots" class:over={overLimit}>
	{#each display as rune, i (i)}
		<span
			class="slot"
			class:filled={!!rune?.hasRune}
			class:overflow={overLimit && i >= RUNE_CARRY_LIMIT}
			title={rune?.name ?? 'Empty rune slot'}
		>
			{#if rune?.hasRune}
				{@const url = runeIconUrl(assets, rune)}
				{#if url}<img src={url} alt={rune.name ?? 'Rune'} loading="lazy" />{/if}
			{/if}
		</span>
	{/each}
</div>

<style>
	.rune-col {
		/* ~1/3 the width of the 7-hex card to the right; full height (matches it). */
		width: var(--rune-col-width, 4.3rem);
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: var(--rune-gap, 0.4rem);
	}
	/* Row layout: a horizontal strip of fixed-size square slots (used above the trait list). */
	.rune-col.row {
		flex-direction: row;
		justify-content: center;
		align-items: center;
		width: 100%;
		height: auto;
	}
	.rune-col.row .slot {
		flex: 0 0 auto;
		width: var(--rune-row-slot-size, 3rem);
		height: var(--rune-row-slot-size, 3rem);
	}
	.slot {
		flex: 1 1 0;
		min-height: 0;
		display: grid;
		place-items: center;
		border-radius: 8px;
		background: rgba(8, 5, 16, 0.7);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
		backdrop-filter: blur(6px);
	}
	.slot.filled {
		background: rgba(47, 199, 199, 0.12);
		box-shadow: inset 0 0 0 1px var(--brand-teal, #2fc7c7);
	}
	/* Slots past the carry limit must be discarded at cleanup — flag them in amber. */
	.slot.overflow {
		background: rgba(255, 112, 77, 0.16);
		box-shadow: inset 0 0 0 1px var(--brand-coral, #ff704d), 0 0 10px rgba(255, 112, 77, 0.4);
		animation: overflow-pulse 1.8s ease-in-out infinite;
	}
	.slot img {
		display: block;
		width: 80%;
		height: 80%;
		margin: auto;
		object-fit: contain;
		object-position: center;
	}
	@keyframes overflow-pulse {
		0%, 100% { box-shadow: inset 0 0 0 1px var(--brand-coral, #ff704d), 0 0 8px rgba(255, 112, 77, 0.35); }
		50% { box-shadow: inset 0 0 0 1px var(--brand-coral, #ff704d), 0 0 16px rgba(255, 112, 77, 0.6); }
	}
	@media (prefers-reduced-motion: reduce) {
		.slot.overflow {
			animation: none;
		}
	}

	@media (max-width: 600px) {
		.rune-col {
			width: var(--rune-col-width, 3.2rem);
			gap: var(--rune-gap, 0.3rem);
		}
		.rune-col.row {
			width: 100%;
		}
		.rune-col.row .slot {
			width: var(--rune-row-slot-size, 2.5rem);
			height: var(--rune-row-slot-size, 2.5rem);
		}
		.slot {
			border-radius: 6px;
		}
	}
</style>
