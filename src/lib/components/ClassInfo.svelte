<script lang="ts">
	// Game explorer: a small "i" after a class name. Hover, focus or tap shows what the class
	// does: its description and the effect at each count, from the card data. Where the tested
	// rules give the class another ability, that ability is shown, with the live game's below it.
	import InfoText from '$lib/components/InfoText.svelte';
	import { testRules } from '$lib/explorerBalance';
	import { gameImageUrl } from '$lib/storageImages';
	import { getAssetState } from '$lib/stores/assetStore.svelte';

	let { name }: { name: string } = $props();

	const assets = getAssetState();
	const cls = $derived([...assets.classTraits.values()].find((c) => c.name === name) ?? null);
	const tested = $derived($testRules?.classes.find((c) => c.name === name) ?? null);
</script>

<InfoText {name} icon={cls?.icon_png ? gameImageUrl(cls.icon_png) : null}>
	{#if tested}
		<span class="line tag">In the tested rules</span>
		{#each tested.test as bp, i (i)}
			<span class="line"><b>{bp.count}</b> {bp.text}</span>
		{/each}
		<span class="line tag live">In the live game</span>
		{#each tested.live as bp, i (i)}
			<span class="line dim"><b>{bp.count}</b> {bp.text}</span>
		{/each}
	{:else}
		{#if cls?.description}<span class="line">{cls.description}</span>{/if}
		{#each cls?.effect_schema ?? [] as bp, i (i)}
			<span class="line"><b>{bp.count}</b> {(bp.effects ?? []).map((e) => e.description).filter(Boolean).join(' ') || bp.description || ''}</span>
		{/each}
	{/if}
	{#if cls?.footer}<span class="line dim">{cls.footer}</span>{/if}
	{#if !cls && !tested}<span class="line dim">No text for this class.</span>{/if}
</InfoText>
