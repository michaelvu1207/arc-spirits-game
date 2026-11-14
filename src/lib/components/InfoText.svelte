<script lang="ts">
	// Game explorer: a small "i" after a name. Hover, focus or tap shows a short text box: a title
	// (with an optional icon) and its lines. The box stays inside the window.
	import type { Snippet } from 'svelte';

	let { name, icon = null, children }: { name: string; icon?: string | null; children: Snippet } = $props();

	const WIDTH = 340;
	let open = $state(false);
	let pos = $state({ left: 0, top: 0 });
	let button: HTMLButtonElement;
	let pop = $state<HTMLElement | null>(null);

	function show() {
		const r = button.getBoundingClientRect();
		const left = r.right + 8 + WIDTH > window.innerWidth ? Math.max(8, r.left - 8 - WIDTH) : r.right + 8;
		pos = { left, top: Math.max(8, r.top - 12) };
		open = true;
	}
	// Once its height is known, keep it inside the window.
	$effect(() => {
		if (!pop) return;
		const over = pop.getBoundingClientRect().bottom - (window.innerHeight - 8);
		if (over > 0) pos = { left: pos.left, top: Math.max(8, pos.top - over) };
	});
</script>

<button
	bind:this={button}
	type="button"
	class="info"
	aria-label={`About ${name}`}
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
	<span class="pop" bind:this={pop} style={`left:${pos.left}px; top:${pos.top}px; width:${WIDTH}px`}>
		<span class="head">
			{#if icon}<img src={icon} alt="" width="28" height="28" />{/if}
			<b>{name}</b>
		</span>
		{@render children()}
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
		gap: 6px;
		padding: 10px 12px;
		background: #171a21;
		border: 1px solid #30343f;
		border-radius: 10px;
		pointer-events: none;
		color: #e6e7eb;
		font-weight: 400;
		white-space: normal;
		text-align: left;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.head img {
		object-fit: contain;
	}
	.pop :global(.line b) {
		margin-right: 6px;
	}
	.pop :global(.dim) {
		color: #9a9eab;
	}
</style>
