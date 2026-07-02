<script lang="ts">
	import { playSfx } from '$lib/stores/gameAudio.svelte';

	interface Props {
		title: string;
		subtitle?: string;
		glyph?: string;
		accent?: string;
		disabled?: boolean;
		selected?: boolean;
		testid?: string;
		onClick?: () => void;
	}

	let {
		title,
		subtitle = '',
		glyph = '',
		accent = 'var(--brand-violet, #5a2bff)',
		disabled = false,
		selected = false,
		testid,
		onClick
	}: Props = $props();
</script>

<button
	type="button"
	class="stage-card"
	class:selected
	data-testid={testid}
	style="--accent: {accent}"
	{disabled}
	onpointerenter={() => !disabled && playSfx('ui-hover', { volume: 0.5 })}
	onclick={() => {
		playSfx('ui-click');
		onClick?.();
	}}
>
	{#if glyph}<span class="glyph">{glyph}</span>{/if}
	<span class="title">{title}</span>
	{#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
</button>

<style>
	.stage-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--stage-card-inner-gap, 0.5rem);
		width: var(--stage-card-width, clamp(12rem, 16vw, 15rem));
		min-height: var(--stage-card-min-h, 14rem);
		padding: var(--stage-card-pad, 1.3rem 1.2rem);
		text-align: center;
		border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
		border-top: 3px solid var(--accent);
		border-radius: 8px;
		background: linear-gradient(180deg, rgba(18, 10, 38, 0.7), rgba(8, 5, 16, 0.92));
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition:
			transform 140ms ease,
			box-shadow 140ms ease,
			border-color 140ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.stage-card:hover:not(:disabled) {
			transform: translateY(-4px);
			border-color: var(--accent);
			box-shadow:
				0 12px 30px rgba(0, 0, 0, 0.45),
				0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent);
		}
	}
	.stage-card.selected {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent);
	}
	.stage-card:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.glyph {
		font-size: var(--stage-card-glyph, 2.5rem);
		line-height: 1;
		color: var(--accent);
	}
	.title {
		font-family: var(--font-display);
		font-size: var(--stage-card-title, 1.05rem);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
	}
	.subtitle {
		font-size: var(--stage-card-subtitle, 0.85rem);
		line-height: 1.3;
		color: var(--color-fog, #8d8aa1);
	}

	/* ── Touch hardening ────────────────────────────────────────────────────── */
	.stage-card {
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
	}

	/* ── Mobile: ensure minimum tap height and prevent overflow at 360px ────── */
	@media (max-width: 600px) {
		.stage-card {
			--stage-card-width: clamp(9rem, 42vw, 15rem);
			--stage-card-min-h: 44px;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.stage-card {
			--stage-card-width: clamp(8rem, 22vw, 11.5rem);
			--stage-card-min-h: clamp(6.75rem, 33vh, 8.5rem);
			--stage-card-inner-gap: 0.34rem;
			--stage-card-pad: 0.8rem 0.7rem;
		}
		.glyph {
			font-size: var(--stage-card-glyph, clamp(1.35rem, 6vh, 1.75rem));
		}
		.title {
			font-size: var(--stage-card-title, 0.82rem);
		}
		.subtitle {
			font-size: var(--stage-card-subtitle, 0.7rem);
			line-height: 1.22;
		}
	}
</style>
