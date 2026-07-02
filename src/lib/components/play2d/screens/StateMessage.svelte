<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** Show the spinning ring (loading state). */
		loading?: boolean;
		/** Heading (display font, uppercase). */
		title?: string;
		/** Supporting line. */
		message?: string;
		/** 'error' tints the heading blood-red. */
		tone?: 'default' | 'error';
		/** Tighter padding for use inside a DetailOverlay body. */
		compact?: boolean;
		/** Optional actions (e.g. a "Try Again" button) rendered under the message. */
		actions?: Snippet;
	}

	let {
		loading = false,
		title,
		message,
		tone = 'default',
		compact = false,
		actions
	}: Props = $props();
</script>

<div class="state" class:compact class:error={tone === 'error'}>
	{#if loading}
		<div class="spin-ring" aria-hidden="true"></div>
	{/if}
	{#if title}<h3>{title}</h3>{/if}
	{#if message}<p>{message}</p>{/if}
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: clamp(48px, 9vh, 80px) 24px;
		text-align: center;
		color: var(--color-fog);
	}
	.state.compact {
		padding: clamp(28px, 5vh, 44px) 16px;
	}
	h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.6rem;
		line-height: 1;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--color-bone);
	}
	.state.error h3 {
		color: var(--color-blood);
	}
	p {
		margin: 0;
		max-width: 50ch;
		font-family: var(--font-body);
		font-size: 0.86rem;
		line-height: 1.5;
	}
	.actions {
		margin-top: 6px;
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: center;
	}
	.spin-ring {
		width: 30px;
		height: 30px;
		border: 2px solid var(--color-mist);
		border-top-color: var(--brand-magenta);
		border-radius: 50%;
		animation: spin 1s linear infinite;
		margin-bottom: 4px;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin-ring {
			animation: none;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) {
		.state {
			gap: 8px;
			padding: clamp(18px, 6vh, 28px) 18px;
		}
		.state.compact {
			padding: 16px 12px;
		}
		.spin-ring {
			width: 26px;
			height: 26px;
			margin-bottom: 0;
		}
		h3 {
			font-size: 1.25rem;
		}
		p {
			font-size: 0.78rem;
			line-height: 1.35;
		}
	}
</style>
