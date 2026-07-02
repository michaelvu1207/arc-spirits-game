<script lang="ts">
	import type { SpectatorProjection } from '$lib/play/types';

	interface Props {
		room: SpectatorProjection;
		spiritImages?: Map<string, string>;
		onClose?: () => void;
	}

	let { room, spiritImages = new Map(), onClose }: Props = $props();

	let tab = $state<'spiritWorld' | 'arcaneAbyss'>('spiritWorld');

	const spiritWorld = $derived(room.bagSpirits?.spiritWorld ?? []);
	const arcaneAbyss = $derived(room.bagSpirits?.arcaneAbyss ?? []);
	const entries = $derived(tab === 'spiritWorld' ? spiritWorld : arcaneAbyss);

	function total(list: { count: number }[]): number {
		return list.reduce((sum, e) => sum + e.count, 0);
	}
	const swTotal = $derived(total(spiritWorld));
	const aaTotal = $derived(total(arcaneAbyss));

	function img(id: string): string | null {
		return spiritImages.get(id) ?? null;
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose?.();
	}}
/>

<div class="overlay" data-testid="bag-viewer">
	<button type="button" class="backdrop" aria-label="Close spirit bags" onclick={() => onClose?.()}></button>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Spirit bags" tabindex="-1">
		<header class="head">
			<span class="title">Spirit Bags</span>
			<button type="button" class="close" aria-label="Close" title="Close" onclick={() => onClose?.()}>
				✕
			</button>
		</header>

		<div class="tabs" role="tablist">
			<button
				type="button"
				class="tab"
				class:active={tab === 'spiritWorld'}
				role="tab"
				aria-selected={tab === 'spiritWorld'}
				data-testid="bag-tab-spiritWorld"
				onclick={() => (tab = 'spiritWorld')}
			>
				Spirit World <span class="pill">{swTotal}</span>
			</button>
			<button
				type="button"
				class="tab"
				class:active={tab === 'arcaneAbyss'}
				role="tab"
				aria-selected={tab === 'arcaneAbyss'}
				data-testid="bag-tab-arcaneAbyss"
				onclick={() => (tab = 'arcaneAbyss')}
			>
				Arcane Abyss <span class="pill">{aaTotal}</span>
			</button>
		</div>

		<div class="body">
			{#if entries.length === 0}
				<div class="empty">This bag is empty.</div>
			{:else}
				<div class="grid">
					{#each entries as entry (entry.id)}
						<div class="card" title={`${entry.name} · cost ${entry.cost}`}>
							<div class="art">
								{#if img(entry.id)}
									<img src={img(entry.id)} alt={entry.name} loading="lazy" />
								{:else}
									<div class="ph">{entry.name}</div>
								{/if}
								{#if entry.count > 1}<span class="count">×{entry.count}</span>{/if}
							</div>
							<span class="name">{entry.name}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.overlay {
		position: absolute;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 2rem;
	}
	.backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgba(4, 2, 10, 0.72);
		backdrop-filter: blur(3px);
		cursor: pointer;
	}
	.modal {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		width: min(960px, 100%);
		max-height: min(80vh, 760px);
		max-height: min(80dvh, 760px);
		border: 1px solid var(--brand-violet, #5a2bff);
		border-radius: 12px;
		background: linear-gradient(180deg, rgba(18, 10, 38, 0.98), rgba(8, 5, 16, 0.99));
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.7);
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.9rem 1.1rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}
	.title {
		font-family: var(--font-display);
		font-size: 1.1rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #fff;
	}
	.close {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 1px solid var(--color-mist, #3a2670);
		border-radius: 6px;
		background: rgba(10, 7, 20, 0.6);
		color: var(--color-parchment, #e7e0cf);
		font-size: 0.85rem;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition: border-color 140ms ease, color 140ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.close:hover {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff7fd9);
		}
	}
	.close:focus-visible {
		border-color: var(--brand-magenta, #ff2bc7);
		color: var(--brand-magenta-soft, #ff7fd9);
		outline: 2px solid var(--brand-magenta, #ff2bc7);
		outline-offset: 2px;
	}
	.tabs {
		display: flex;
		gap: 0.5rem;
		padding: 0.8rem 1.1rem 0;
	}
	.tab {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.9rem;
		min-height: 44px;
		border: 1px solid var(--color-mist, #3a2670);
		border-bottom: none;
		border-radius: 8px 8px 0 0;
		background: rgba(10, 7, 20, 0.5);
		color: var(--color-fog, #8d8aa1);
		font-family: var(--font-display);
		font-size: 0.82rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.tab:hover {
			color: var(--color-parchment, #e7e0cf);
		}
	}
	.tab:focus-visible {
		color: var(--color-parchment, #e7e0cf);
		outline: 2px solid var(--brand-teal, #2fc7c7);
		outline-offset: -2px;
	}
	.tab.active {
		color: #fff;
		background: rgba(47, 199, 199, 0.12);
		border-color: var(--brand-teal, #2fc7c7);
	}
	.pill {
		display: inline-grid;
		place-items: center;
		min-width: 1.4rem;
		padding: 0 0.35rem;
		height: 1.4rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.4);
		color: var(--brand-cyan, #5cdfff);
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
		padding: 1rem 1.1rem 1.3rem;
		border-top: 1px solid var(--brand-teal, #2fc7c7);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
		gap: 0.7rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
	}
	.art {
		position: relative;
		width: 100%;
		aspect-ratio: 13 / 17;
		display: grid;
		place-items: center;
		border-radius: 8px;
		overflow: hidden;
		background: rgba(8, 5, 16, 0.6);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
	}
	.art img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.ph {
		padding: 0.4rem;
		text-align: center;
		font-size: 0.8rem;
		color: var(--color-fog, #8d8aa1);
	}
	.count {
		position: absolute;
		right: 4px;
		bottom: 4px;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
	}
	.name {
		max-width: 100%;
		font-size: 0.8rem;
		text-align: center;
		color: var(--color-parchment, #e7e0cf);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		display: grid;
		place-items: center;
		min-height: 8rem;
		font-family: var(--font-display);
		letter-spacing: 0.06em;
		color: var(--color-fog, #8d8aa1);
	}

	@media (max-width: 600px) {
		.overlay {
			padding: 0.75rem;
			padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
			align-items: flex-end;
		}
		.modal {
			width: 100%;
			max-height: 92vh;
			max-height: 92dvh;
			border-radius: 12px 12px 0 0;
		}
		.grid {
			grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
		}
		.name {
			font-size: 0.8rem;
		}
	}
</style>
