<script lang="ts">
	// Game explorer: a small "i" after a spirit's name. Hover, focus or tap shows the spirit's
	// front and back side by side. The images load only when it opens. The pictures are the live
	// game's cards: where the tested rules awaken the spirit another way, a line under them says so.
	import { spiritBackImageUrl } from '$lib/components/play2d/helpers';
	import { testRules } from '$lib/explorerBalance';
	import { usableImage } from '$lib/explorerImages.svelte';
	import { gameImageUrl } from '$lib/storageImages';
	import { getAssetState } from '$lib/stores/assetStore.svelte';

	let { id, name }: { id: string; name: string } = $props();

	const assets = getAssetState();
	const SIZE = 190; // one image
	const WIDTH = SIZE * 2 + 30;
	let open = $state(false);
	let pos = $state({ left: 0, top: 0 });
	let button: HTMLButtonElement;
	// What the tested rules change on this card: its awakening, and the ability of a class it has
	// (the back of a card prints the class text).
	const testedAwaken = $derived($testRules?.spirits.find((s) => s.name === name) ?? null);
	const testedClasses = $derived.by(() => {
		const names = (assets.spiritAssets.get(id)?.traits?.class_ids ?? []).map((c) => assets.classTraits.get(c)?.name);
		return ($testRules?.classes ?? []).filter((c) => names.includes(c.name));
	});
	const tested = $derived(testedAwaken != null || testedClasses.length > 0);

	function show() {
		const r = button.getBoundingClientRect();
		// To the right of the icon and below it; flipped where the window ends.
		const left = r.right + 8 + WIDTH > window.innerWidth ? Math.max(8, r.left - 8 - WIDTH) : r.right + 8;
		const top = Math.min(Math.max(8, r.top - 20), window.innerHeight - SIZE - 28 - (tested ? 70 + 50 * ((testedAwaken ? 1 : 0) + testedClasses.length) : 0));
		pos = { left, top };
		open = true;
	}
	const sides = $derived.by(() => {
		if (!open) return [];
		const asset = assets.spiritAssets.get(id);
		const front = usableImage(gameImageUrl(asset?.game_print_image_path || asset?.art_raw_image_path || null));
		// Only a spirit that must be awakened has a back side.
		return asset?.awaken_condition ? [front, usableImage(spiritBackImageUrl(id))] : [front];
	});
</script>

<button
	bind:this={button}
	type="button"
	class="info"
	aria-label={`Show ${name}`}
	onmouseenter={show}
	onmouseleave={() => (open = false)}
	onfocus={show}
	onblur={() => (open = false)}
	onclick={(e) => {
		e.preventDefault();
		e.stopPropagation();
		if (open) open = false;
		else show();
	}}>i</button
>
{#if open}
	<span class="pop" style={`left:${pos.left}px; top:${pos.top}px`}>
		<span class="sides">
			{#each sides as url, i (i)}
				{#if url}
					<img src={url} alt="" width={SIZE} height={SIZE} />
				{:else}
					<span class="none" style={`width:${SIZE}px; height:${SIZE}px`}>{name}</span>
				{/if}
			{/each}
		</span>
		{#if tested}
			<span class="note" style={`width:${Math.max(sides.length, 1) * SIZE + (Math.max(sides.length, 1) - 1) * 10}px`}>
				<span class="tag">In the tested rules</span>
				{#if testedAwaken}<span><b>To awaken:</b> {testedAwaken.test}</span>{/if}
				{#each testedClasses as c (c.name)}
					<span><b>{c.name}:</b> {c.test.map((b) => (c.test.length > 1 ? `${b.count}: ${b.text}` : b.text)).join(' ')}</span>
				{/each}
				<span class="dim">The card shows the live game.</span>
			</span>
		{/if}
	</span>
{/if}

<style>
	.info {
		display: inline-grid;
		place-items: center;
		width: 15px;
		height: 15px;
		margin-left: 6px;
		padding: 0;
		border: 1px solid #30343f;
		border-radius: 99px;
		background: none;
		color: #9a9eab;
		font-size: 10px;
		line-height: 1;
		font-weight: 600;
		cursor: default;
		vertical-align: middle;
	}
	.info:hover,
	.info:focus-visible {
		color: #e6e7eb;
		border-color: #9a9eab;
		outline: none;
	}
	.pop {
		position: fixed;
		z-index: 50;
		display: grid;
		gap: 8px;
		padding: 10px;
		background: #171a21;
		border: 1px solid #30343f;
		border-radius: 10px;
		pointer-events: none;
	}
	.sides {
		display: flex;
		gap: 10px;
	}
	.pop img {
		object-fit: contain;
	}
	.note {
		display: grid;
		gap: 3px;
		color: #e6e7eb;
		font-weight: 400;
		white-space: normal;
		text-align: left;
	}
	.note .tag {
		font-size: 12px;
		color: #e2b23c;
	}
	.note .dim {
		color: #9a9eab;
	}
	.none {
		display: grid;
		place-items: center;
		text-align: center;
		color: #9a9eab;
		background: #12141a;
		clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
	}
</style>
