<script lang="ts">
	import { getGuardianAsset } from '$lib/stores/assetStore.svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';

	interface Props {
		open: boolean;
		title?: string;
		subtitle?: string;
		/** Guardian names to choose from (room.guardianPool). */
		guardians: string[];
		/** Names already taken by OTHER seats — shown disabled. */
		taken?: Set<string>;
		/** Currently selected guardian for this seat. */
		current?: string | null;
		/** Seat accent colour. */
		accent?: string;
		onPick: (name: string) => void;
		onClose: () => void;
	}

	let {
		open,
		title = 'Choose your Guardian',
		subtitle = '',
		guardians,
		taken = new Set<string>(),
		current = null,
		accent = '#ff2bc7',
		onPick,
		onClose
	}: Props = $props();

	function art(name: string): string | null {
		const g = getGuardianAsset(name);
		// Use the character icon (fall back to chibi/mat only if it's missing).
		return g?.iconUrl ?? g?.chibiUrl ?? g?.matUrl ?? null;
	}
	function originColor(name: string): string {
		return getGuardianAsset(name)?.origin?.color ?? accent;
	}

	function onKey(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			playMenuSfx('ui-back');
			onClose();
		}
	}

	function pick(name: string) {
		playMenuSfx('ui-click');
		onPick(name);
	}
	function close() {
		playMenuSfx('ui-back');
		onClose();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<div class="picker" style="--accent: {accent}">
		<button type="button" class="backdrop" aria-label="Close" onclick={close}></button>

		<div
			class="panel"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			data-testid="guardian-picker"
		>
			<header class="phead">
				<div>
					<div class="peyebrow">Character Select</div>
					<h2>{title}</h2>
					{#if subtitle}<p>{subtitle}</p>{/if}
				</div>
				<button
					class="close"
					type="button"
					onpointerenter={() => playMenuSfx('ui-hover', { volume: 0.4 })}
					onclick={close}
					aria-label="Close">✕</button
				>
			</header>

			<div class="grid">
				{#each guardians as name (name)}
					{@const src = art(name)}
					{@const isTaken = taken.has(name) && name !== current}
					{@const isCurrent = name === current}
					<button
						type="button"
						class="tile"
						class:taken={isTaken}
						class:current={isCurrent}
						style="--oc: {originColor(name)}"
						data-testid="guardian-tile"
						disabled={isTaken}
						onpointerenter={() => !isTaken && playMenuSfx('ui-hover', { volume: 0.38 })}
						onclick={() => pick(name)}
					>
						<div class="art">
							{#if src}
								<img {src} alt={name} loading="lazy" />
							{:else}
								<span class="glyph">{name.slice(0, 1)}</span>
							{/if}
							<div class="art-fade"></div>
						</div>
						<div class="meta">
							<span class="gname">{name}</span>
							{#if isTaken}<span class="state">In use</span>
							{:else if isCurrent}<span class="state on">Selected</span>{/if}
						</div>
						{#if isCurrent}<div class="tick">✓</div>{/if}
					</button>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.picker {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: 4vh 4vw;
	}
	.backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgba(4, 2, 12, 0.72);
		backdrop-filter: blur(8px);
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		animation: fade 200ms ease;
	}
	.panel {
		position: relative;
		width: min(1080px, 96vw);
		max-height: 92vh;
		max-height: 92dvh;
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 26px 28px;
		overflow: hidden;
		border-radius: 20px;
		border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--color-mist, #2e1d52));
		background: linear-gradient(180deg, rgba(26, 15, 46, 0.96), rgba(8, 5, 18, 0.98));
		box-shadow:
			0 40px 120px -30px rgba(0, 0, 0, 0.85),
			0 0 60px -30px var(--accent);
		animation: rise 260ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}

	.phead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	.peyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.32em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.phead h2 {
		margin: 6px 0 0;
		font-family: var(--font-display);
		font-size: clamp(1.6rem, 3vw, 2.4rem);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
	}
	.phead p {
		margin: 4px 0 0;
		color: var(--color-fog, #9a8fb8);
		font-size: 0.85rem;
	}
	.close {
		flex: 0 0 auto;
		width: 44px;
		height: 44px;
		border-radius: 999px;
		border: 1px solid var(--color-mist, #2e1d52);
		background: transparent;
		color: var(--color-parchment, #d8cfee);
		font-size: 1rem;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.close:hover {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff5dd1);
		}
	}
	.close:focus-visible {
		border-color: var(--brand-magenta, #ff2bc7);
		color: var(--brand-magenta-soft, #ff5dd1);
		outline: 2px solid var(--brand-magenta, #ff2bc7);
		outline-offset: 2px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 14px;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
		padding: 2px;
		scrollbar-width: thin;
	}

	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		padding: 0;
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 14px;
		background: rgba(10, 7, 22, 0.6);
		overflow: hidden;
		cursor: pointer;
		text-align: left;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			transform 180ms cubic-bezier(0.2, 0.7, 0.2, 1),
			border-color 180ms ease,
			box-shadow 180ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.tile:hover:not(:disabled) {
			transform: translateY(-4px);
			border-color: var(--oc);
			box-shadow: 0 18px 40px -18px var(--oc);
		}
	}
	.tile:focus-visible:not(:disabled) {
		border-color: var(--oc);
		box-shadow: 0 0 0 2px var(--oc);
		outline: none;
	}
	.tile.current {
		border-color: var(--oc);
		box-shadow:
			0 0 0 1px var(--oc),
			0 16px 40px -18px var(--oc);
	}
	.tile.taken {
		cursor: not-allowed;
		opacity: 0.45;
		filter: grayscale(0.6);
	}

	.art {
		position: relative;
		aspect-ratio: 1 / 1;
		display: grid;
		place-items: center;
		background:
			radial-gradient(
				ellipse at 50% 30%,
				color-mix(in srgb, var(--oc) 30%, transparent),
				transparent 70%
			),
			rgba(0, 0, 0, 0.35);
	}
	.art img {
		width: 100%;
		height: 100%;
		/* Character icon — show it whole on the radial-glow backdrop (vs. the mat). */
		object-fit: contain;
		padding: 8%;
		filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.55));
	}
	.glyph {
		font-family: var(--font-display);
		font-size: 3rem;
		color: var(--oc);
	}
	.art-fade {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, transparent 55%, rgba(8, 5, 18, 0.92) 100%);
		pointer-events: none;
	}

	.meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px 12px;
	}
	.gname {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #fff;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.state {
		flex: 0 0 auto;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-fog, #9a8fb8);
	}
	.state.on {
		color: var(--brand-teal, #20e0c1);
	}
	.tick {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: var(--oc);
		color: #07040f;
		font-size: 0.8rem;
		box-shadow: 0 0 14px var(--oc);
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(18px) scale(0.98);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.panel,
		.backdrop {
			animation: none;
		}
	}

	@media (max-width: 600px) {
		.picker {
			padding: 0;
			align-items: flex-end;
		}
		.panel {
			width: 100%;
			max-height: 94vh;
			max-height: 94dvh;
			border-radius: 20px 20px 0 0;
			padding: 20px 16px 16px;
			padding-bottom: calc(16px + env(safe-area-inset-bottom));
			gap: 14px;
		}
		.grid {
			grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
			gap: 10px;
		}
		.phead h2 {
			font-size: clamp(1.3rem, 6vw, 1.8rem);
		}
		.gname {
			font-size: 0.82rem;
		}
	}

	@media (max-width: 430px) {
		.grid {
			grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
			gap: 8px;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) {
		.picker {
			place-items: stretch;
			padding:
				calc(12px + env(safe-area-inset-top))
				max(72px, calc(18px + env(safe-area-inset-right)))
				calc(12px + env(safe-area-inset-bottom))
				max(44px, calc(18px + env(safe-area-inset-left)));
		}
		.backdrop {
			background: rgba(4, 2, 12, 0.64);
			backdrop-filter: blur(10px);
		}
		.panel {
			width: 100%;
			height: 100%;
			max-height: none;
			box-sizing: border-box;
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
			gap: 12px;
			padding: 18px 20px 16px;
			border-radius: 18px;
			background: linear-gradient(180deg, rgba(18, 10, 36, 0.82), rgba(6, 4, 16, 0.88));
			-webkit-backdrop-filter: blur(18px);
			backdrop-filter: blur(18px);
		}
		.phead {
			align-items: center;
			gap: 14px;
		}
		.peyebrow {
			font-size: 0.62rem;
			letter-spacing: 0.26em;
		}
		.phead h2 {
			margin-top: 3px;
			font-size: clamp(1.25rem, 7vh, 1.8rem);
			line-height: 0.95;
		}
		.phead p {
			margin-top: 3px;
			font-size: 0.78rem;
			line-height: 1.25;
		}
		.close {
			width: 42px;
			height: 42px;
			background: rgba(255, 255, 255, 0.05);
		}
		.grid {
			grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
			grid-auto-rows: minmax(104px, 1fr);
			gap: 10px;
			overflow-y: auto;
			padding: 1px 3px 3px 1px;
		}
		.tile {
			min-height: 104px;
			display: grid;
			grid-template-rows: minmax(62px, 1fr) auto;
			border-radius: 12px;
			background: rgba(10, 7, 22, 0.58);
		}
		.art {
			aspect-ratio: auto;
			min-height: 0;
		}
		.art img {
			padding: 7%;
		}
		.meta {
			min-height: 34px;
			padding: 7px 9px 8px;
			align-items: center;
		}
		.gname {
			font-size: 0.72rem;
			letter-spacing: 0.04em;
		}
		.state {
			font-size: 0.6rem;
			letter-spacing: 0.1em;
		}
		.tick {
			top: 6px;
			right: 6px;
			width: 22px;
			height: 22px;
		}
	}
</style>
