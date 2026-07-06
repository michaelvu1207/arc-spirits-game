<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** What the player is paying FOR — never lose the "why". */
		title: string;
		/** Requirement headline ("Discard Flower ×2"). */
		subtitle?: string | null;
		image?: string | null;
		imageAlt?: string;
		accent?: string;
		/** Half-flip tease for face-down spirits about to awaken. */
		flip?: boolean;
		/** Extra content under the headline (cost→gain flow for trades). */
		children?: Snippet;
	}

	let {
		title,
		subtitle = null,
		image = null,
		imageAlt = '',
		accent = 'var(--brand-magenta, #ff2bc7)',
		flip = false,
		children
	}: Props = $props();
</script>

<aside class="source" style="--accent: {accent}" data-testid="takeover-source">
	{#if image}
		<span class="art" class:flip>
			<span class="aura" aria-hidden="true"></span>
			<img src={image} alt={imageAlt || title} />
		</span>
	{/if}
	<h3 class="title">{title}</h3>
	{#if subtitle}
		<p class="subtitle">{subtitle}</p>
	{/if}
	{#if children}
		<div class="extra">{@render children()}</div>
	{/if}
</aside>

<style>
	.source {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.55rem;
		min-width: 0;
		text-align: center;
	}
	.art {
		position: relative;
		display: grid;
		place-items: center;
		width: clamp(7.5rem, 20vh, 12rem);
		perspective: 700px;
	}
	.aura {
		position: absolute;
		inset: -18%;
		border-radius: 50%;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--accent) 30%, transparent) 0%,
			transparent 68%
		);
		filter: blur(6px);
		animation: aura-breathe 3.2s ease-in-out infinite;
	}
	.art img {
		position: relative;
		width: 100%;
		height: auto;
		object-fit: contain;
		filter: drop-shadow(0 14px 26px rgba(0, 0, 0, 0.6));
	}
	/* The tease: the card leans open, promising the front face on Confirm. */
	.art.flip img {
		transform: rotateY(14deg) rotateZ(-1.5deg);
		animation: flip-tease 3.4s ease-in-out infinite;
	}
	@keyframes flip-tease {
		0%,
		100% {
			transform: rotateY(10deg) rotateZ(-1.5deg);
		}
		50% {
			transform: rotateY(20deg) rotateZ(-0.5deg);
		}
	}
	@keyframes aura-breathe {
		0%,
		100% {
			opacity: 0.7;
			transform: scale(0.96);
		}
		50% {
			opacity: 1;
			transform: scale(1.04);
		}
	}
	.title {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(0.95rem, 1.6vw, 1.2rem);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #fff;
		line-height: 1.2;
	}
	.subtitle {
		margin: 0;
		font-size: clamp(0.78rem, 1.1vw, 0.9rem);
		line-height: 1.35;
		color: color-mix(in srgb, var(--accent) 55%, #fff 45%);
	}
	.extra {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.45rem;
		max-width: 100%;
	}
	@media (prefers-reduced-motion: reduce) {
		.aura,
		.art.flip img {
			animation: none;
		}
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.source {
			gap: 0.35rem;
		}
		.art {
			width: clamp(4.2rem, 22vh, 6rem);
		}
		.title {
			font-size: 0.78rem;
		}
		.subtitle {
			font-size: 0.68rem;
		}
	}
	@media (max-width: 600px) {
		.source {
			flex-direction: row;
			justify-content: flex-start;
			gap: 0.7rem;
			text-align: left;
		}
		.art {
			width: 3.6rem;
			flex: none;
		}
		.title {
			font-size: 0.85rem;
		}
		.subtitle {
			font-size: 0.74rem;
		}
		.source :is(.title, .subtitle) {
			text-align: left;
		}
		.extra {
			flex-basis: 100%;
		}
	}
</style>
