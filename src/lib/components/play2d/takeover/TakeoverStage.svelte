<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		accent?: string;
		testid?: string;
		/** The pinned "why" (SourcePanel). Optional — some takeovers are rack-only. */
		source?: Snippet;
		/** The candidate area (rack + any choice rows). */
		children: Snippet;
		/** The commit bar (per-takeover, pinned to the bottom row). */
		bar: Snippet;
		/** Escape backs out (same as the bar's Cancel). */
		onEscape?: (() => void) | null;
	}

	let { accent = 'var(--brand-magenta, #ff2bc7)', testid, source, children, bar, onEscape = null }: Props =
		$props();

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && onEscape) {
			e.stopPropagation();
			onEscape();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="takeover" class:with-source={!!source} style="--accent: {accent}" data-testid={testid}>
	<div class="veil" aria-hidden="true"></div>
	{#if source}
		<div class="source-col">{@render source()}</div>
	{/if}
	<div class="rack-col">{@render children()}</div>
	<div class="bar-row">{@render bar()}</div>
</div>

<style>
	/* The stage BECOMES the picker: full view-body area, board behind pushed back
	   by the veil, content scaled in. Source pins left, rack takes the rest, the
	   commit bar owns the bottom row. */
	.takeover {
		position: relative;
		box-sizing: border-box;
		width: min(1120px, 100%);
		height: 100%;
		min-height: 0;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'rack' 'bar';
		gap: clamp(0.5rem, 1.6vh, 1rem);
		padding: clamp(0.25rem, 1.2vh, 0.75rem) clamp(0.25rem, 1.6vw, 1rem)
			clamp(0.35rem, 1.4vh, 0.9rem);
		animation: takeover-in 300ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.takeover.with-source {
		grid-template-columns: clamp(10rem, 24%, 15rem) minmax(0, 1fr);
		grid-template-areas: 'source rack' 'bar bar';
	}
	/* Push the world back while the decision is on stage. */
	.veil {
		position: fixed;
		inset: 0;
		z-index: -1;
		pointer-events: none;
		background: radial-gradient(
			ellipse 70% 62% at 50% 50%,
			rgba(6, 4, 12, 0.55) 0%,
			rgba(6, 4, 12, 0.28) 60%,
			transparent 100%
		);
		animation: veil-in 300ms ease;
	}
	.source-col {
		grid-area: source;
		display: grid;
		place-items: center;
		min-height: 0;
		min-width: 0;
	}
	.rack-col {
		grid-area: rack;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: clamp(0.6rem, 1.8vh, 1.1rem);
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}
	/* Center when short WITHOUT justify-content:center — that combination makes
	   overflowing content unreachable above the scroll origin. :global() because
	   the children arrive via {@render} and sit outside this component's scope. */
	.rack-col > :global(:first-child) {
		margin-top: auto;
	}
	.rack-col > :global(:last-child) {
		margin-bottom: auto;
	}
	.bar-row {
		grid-area: bar;
	}
	@keyframes takeover-in {
		from {
			opacity: 0;
			transform: scale(0.965);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}
	@keyframes veil-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.takeover,
		.veil {
			animation: none;
		}
	}
	@media (max-width: 600px) {
		.takeover.with-source {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr) auto;
			grid-template-areas: 'source' 'rack' 'bar';
		}
		.source-col {
			justify-items: start;
		}
	}
	/* Landscape phones (the board's mobile orientation): compress the chrome so
	   the rack keeps most of the ~390px of height. */
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.takeover {
			gap: 0.35rem;
			padding: 0.15rem 0.3rem 0.3rem;
		}
		.takeover.with-source {
			grid-template-columns: clamp(7.5rem, 20%, 10.5rem) minmax(0, 1fr);
		}
		.rack-col {
			gap: 0.4rem;
		}
	}
</style>
