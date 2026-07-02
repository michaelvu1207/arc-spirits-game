<script lang="ts">
	import type { Snippet } from 'svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';

	interface Props {
		eyebrow: string;
		title: string;
		subtitle?: string;
		/** When set, renders a pulsing "Synced HH:MM:SS" badge. */
		syncedAt?: Date | null;
		backHref?: string;
		backLabel?: string;
		/** Header-right controls (search, refresh, filter chips). */
		actions?: Snippet;
		children: Snippet;
	}

	let {
		eyebrow,
		title,
		subtitle,
		syncedAt = null,
		backHref = '/play',
		backLabel = 'Menu',
		actions,
		children
	}: Props = $props();
</script>

<section class="screen">
	<div class="inner">
		<a
			class="back"
			href={backHref}
			onpointerenter={() => playMenuSfx('ui-hover', { volume: 0.4 })}
			onclick={() => playMenuSfx('ui-back')}
		>
			<span class="back-arrow">←</span>
			<span class="back-lbl">{backLabel}</span>
		</a>

		<header class="head">
			<div class="head-text">
				<div class="eyebrow">{eyebrow}</div>
				<h1 class="title brand-flame-text">{title}</h1>
				{#if subtitle}
					<p class="subtitle">
						{subtitle}
						{#if syncedAt}
							<span class="synced"><span class="dot"></span>Synced {syncedAt.toLocaleTimeString()}</span>
						{/if}
					</p>
				{:else if syncedAt}
					<p class="subtitle">
						<span class="synced"><span class="dot"></span>Synced {syncedAt.toLocaleTimeString()}</span>
					</p>
				{/if}
			</div>
			{#if actions}
				<div class="actions">{@render actions()}</div>
			{/if}
		</header>

		<div class="content">
			{@render children()}
		</div>
	</div>
</section>

<style>
	.screen {
		flex: 1;
		width: 100%;
		min-height: 100%;
		display: flex;
		justify-content: center;
	}
	.inner {
		width: 100%;
		max-width: 1120px;
		display: flex;
		flex-direction: column;
		padding: clamp(64px, 9vh, 104px) clamp(20px, 5vw, 56px) clamp(40px, 8vh, 88px);
	}

	/* ── Back ─────────────────────────────────────────────── */
	.back {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		align-self: flex-start;
		padding: 6px 2px;
		text-decoration: none;
		color: var(--color-fog);
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.24em;
		text-transform: uppercase;
		transition:
			color 180ms ease,
			transform 180ms ease;
	}
	.back-arrow {
		font-size: 1rem;
		color: var(--brand-magenta-soft);
	}
	.back:hover,
	.back:focus-visible {
		color: var(--color-bone);
		transform: translateX(-3px);
		outline: none;
	}

	/* ── Header ───────────────────────────────────────────── */
	.head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 28px;
		flex-wrap: wrap;
		margin-top: 18px;
		padding-bottom: 22px;
		border-bottom: 1px solid var(--color-mist);
	}
	.head-text {
		min-width: 0;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.36em;
		text-transform: uppercase;
		color: var(--brand-cyan);
		margin-bottom: 8px;
	}
	.title {
		font-family: var(--font-display);
		font-size: clamp(3rem, 8vmin, 5.4rem);
		line-height: 0.86;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		margin: 0;
		filter: drop-shadow(0 6px 30px rgba(123, 29, 255, 0.45));
	}
	.subtitle {
		margin: 16px 0 0;
		max-width: 64ch;
		color: var(--color-fog);
		font-family: var(--font-body);
		font-size: 0.86rem;
		line-height: 1.55;
	}
	.synced {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: 10px;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-fog);
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--brand-teal);
		box-shadow: 0 0 6px var(--brand-teal);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.content {
		margin-top: clamp(28px, 5vh, 48px);
	}

	@media (max-width: 720px) {
		.head {
			align-items: stretch;
			flex-direction: column;
			gap: 18px;
		}
		.actions {
			width: 100%;
		}
	}

	@media (orientation: landscape) and (max-height: 520px) {
		.inner {
			max-width: none;
			padding:
				calc(42px + env(safe-area-inset-top))
				max(74px, calc(28px + env(safe-area-inset-right)))
				calc(28px + env(safe-area-inset-bottom))
				max(48px, calc(28px + env(safe-area-inset-left)));
		}
		.back {
			font-size: 0.68rem;
			letter-spacing: 0.18em;
			padding: 4px 0;
		}
		.head {
			align-items: flex-end;
			flex-direction: row;
			gap: 18px;
			margin-top: 8px;
			padding-bottom: 14px;
		}
		.eyebrow {
			font-size: 0.66rem;
			letter-spacing: 0.3em;
			margin-bottom: 5px;
		}
		.title {
			font-size: clamp(2.1rem, 10vh, 3rem);
		}
		.subtitle {
			margin-top: 9px;
			max-width: 58ch;
			font-size: 0.8rem;
			line-height: 1.35;
		}
		.synced {
			margin-left: 8px;
			font-size: 0.72rem;
		}
		.actions {
			justify-content: flex-end;
			max-width: 36%;
		}
		.content {
			margin-top: 16px;
		}
	}
</style>
