<script lang="ts">
	// Game explorer: a small "i" after a class name. Hover, focus or tap shows what the class
	// does: its description and the effect at each count, from the card data.
	import InfoText from '$lib/components/InfoText.svelte';
	import { gameImageUrl } from '$lib/storageImages';
	import { getAssetState } from '$lib/stores/assetStore.svelte';

	let { name }: { name: string } = $props();

	const assets = getAssetState();
	const cls = $derived([...assets.classTraits.values()].find((c) => c.name === name) ?? null);
</script>

<InfoText {name} icon={cls?.icon_png ? gameImageUrl(cls.icon_png) : null}>
	{#if cls?.description}<span class="line">{cls.description}</span>{/if}
	{#each cls?.effect_schema ?? [] as bp, i (i)}
		<span class="line"><b>{bp.count}</b> {(bp.effects ?? []).map((e) => e.description).filter(Boolean).join(' ') || bp.description || ''}</span>
	{/each}
	{#if cls?.footer}<span class="line dim">{cls.footer}</span>{/if}
	{#if !cls}<span class="line dim">No text for this class.</span>{/if}
</InfoText>
