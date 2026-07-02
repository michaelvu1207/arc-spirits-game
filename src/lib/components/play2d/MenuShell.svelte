<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import SplatQualityControl from './SplatQualityControl.svelte';
	import {
		armMenuAudio,
		toggleMenuMute,
		getMenuAudio,
		playMenuSfx,
		primeMenuSfx
	} from '$lib/stores/menuAudio.svelte';

	interface Props {
		/** The menu music. Defaults to the Arcane Abyss theme. */
		audioSrc?: string;
		/** @deprecated Shell brand chrome has been removed; kept only for old callers. */
		showBrand?: boolean;
		/** The screen's content, laid out over the abyss. */
		children?: Snippet;
	}

	let {
		audioSrc = '/music/worlds/abyssal-portal.mp3',
		children
	}: Props = $props();

	const audio = getMenuAudio();

	/** Graphics-settings popover (splat quality) open state. */
	let settingsOpen = $state(false);

	onMount(() => {
		armMenuAudio(audioSrc);
		primeMenuSfx(['ui-hover', 'ui-click', 'ui-back', 'game-start']);
	});
</script>

<div class="menu-shell">
	<!-- The living world lives in /play/+layout.svelte (mounted once for the whole
	     section) and shows through this shell's transparent background, so navigating
	     between screens never re-initialises the splat. -->
	<!-- Directional scrim so content stays legible over the splat -->
	<div class="scrim"></div>
	<!-- Slow aurora wash + fine grain for depth -->
	<div class="aurora"></div>
	<div class="grain"></div>

	<div class="menu-controls">
		<button
			class="ctrl mute"
			type="button"
			onpointerenter={() => playMenuSfx('ui-hover', { volume: 0.45 })}
			onclick={() => {
				playMenuSfx('ui-click');
				toggleMenuMute();
			}}
			aria-label={audio.muted ? 'Unmute menu music' : 'Mute menu music'}
			title={audio.muted ? 'Unmute' : 'Mute'}
		>
			{#if audio.muted}
				<svg viewBox="0 0 24 24" aria-hidden="true"
					><path
						d="M4 9v6h4l5 4V5L8 9H4zM17 9l4 4m0-4l-4 4"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			{:else}
				<svg viewBox="0 0 24 24" aria-hidden="true"
					><path
						d="M4 9v6h4l5 4V5L8 9H4zM16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			{/if}
		</button>
		<button
			class="ctrl"
			type="button"
			data-testid="menu-settings"
			aria-haspopup="menu"
			aria-expanded={settingsOpen}
			aria-label="Settings"
			title="Settings"
			onpointerenter={() => playMenuSfx('ui-hover', { volume: 0.45 })}
			onclick={() => {
				playMenuSfx('ui-click');
				settingsOpen = !settingsOpen;
			}}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true"
				><path
					d="M4 7h8M16 7h4M4 12h4M12 12h8M4 17h11M19 17h1"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
				/><circle cx="14" cy="7" r="2.1" stroke="currentColor" stroke-width="1.7" /><circle
					cx="10"
					cy="12"
					r="2.1"
					stroke="currentColor"
					stroke-width="1.7"
				/><circle cx="17" cy="17" r="2.1" stroke="currentColor" stroke-width="1.7" /></svg
			>
		</button>

		{#if settingsOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<button
				type="button"
				class="settings-backdrop"
				aria-label="Close settings"
				onclick={() => (settingsOpen = false)}
			></button>
			<div class="settings-popover" role="menu" data-testid="menu-settings-panel">
				<SplatQualityControl />
			</div>
		{/if}
	</div>

	<!-- Screen content -->
	<div class="stage">
		{@render children?.()}
	</div>
</div>

<style>
	.menu-shell {
		position: fixed;
		inset: 0;
		z-index: 60;
		overflow: hidden;
		/* Transparent so the persistent splat in /play/+layout.svelte shows through
		   (its void color is the fallback when the player turns the Background Off). */
		background: transparent;
		color: var(--color-bone, #f5f0ff);
	}

	/* Darken the left + bottom so titles/menu read; keep the right airy. */
	.scrim {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
		background:
			linear-gradient(100deg, rgba(5, 3, 16, 0.88) 0%, rgba(5, 3, 16, 0.4) 42%, transparent 70%),
			linear-gradient(0deg, rgba(5, 3, 16, 0.9) 0%, transparent 40%),
			radial-gradient(ellipse 60% 50% at 50% -10%, rgba(123, 29, 255, 0.22), transparent 70%);
	}

	.aurora {
		position: absolute;
		inset: -10%;
		z-index: 1;
		pointer-events: none;
		mix-blend-mode: screen;
		opacity: 0.5;
		background:
			radial-gradient(ellipse 40% 30% at 20% 25%, rgba(255, 43, 199, 0.22), transparent 60%),
			radial-gradient(ellipse 45% 35% at 80% 35%, rgba(36, 212, 255, 0.18), transparent 60%),
			radial-gradient(ellipse 50% 40% at 60% 80%, rgba(90, 43, 255, 0.2), transparent 65%);
		animation: aurora-pan 22s ease-in-out infinite;
	}

	.grain {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
		opacity: 0.5;
		mix-blend-mode: overlay;
		background-image:
			radial-gradient(circle at 25% 30%, rgba(255, 255, 255, 0.05) 1px, transparent 1.5px),
			radial-gradient(circle at 75% 65%, rgba(255, 43, 199, 0.05) 1px, transparent 2px),
			radial-gradient(circle at 50% 85%, rgba(36, 212, 255, 0.05) 1px, transparent 1.5px);
		background-size:
			220px 220px,
			300px 300px,
			260px 260px;
	}

	@keyframes aurora-pan {
		0%,
		100% {
			transform: translate3d(0, 0, 0) scale(1);
		}
		50% {
			transform: translate3d(2%, -2%, 0) scale(1.05);
		}
	}

	/* Control cluster — pinned top-right as the only persistent shell chrome. */
	.menu-controls {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 5;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 22px 30px;
		padding-top: calc(22px + env(safe-area-inset-top));
		padding-right: calc(30px + env(safe-area-inset-right));
	}
	:global(body.guardian-picker-open) .menu-controls {
		display: none;
	}

	@media (max-width: 600px) {
		.menu-controls {
			padding: 14px 16px;
			padding-top: calc(14px + env(safe-area-inset-top));
			padding-right: calc(16px + env(safe-area-inset-right));
		}
	}

	/* Invisible full-screen catch so an outside tap closes the popover. */
	.settings-backdrop {
		position: fixed;
		inset: 0;
		z-index: 6;
		border: 0;
		padding: 0;
		background: transparent;
		cursor: default;
	}

	.settings-popover {
		position: absolute;
		top: calc(100% + 10px);
		right: 0;
		z-index: 7;
		min-width: 220px;
		padding: 16px;
		border-radius: 14px;
		border: 1px solid var(--color-mist, #2e1d52);
		background: rgba(10, 7, 24, 0.92);
		box-shadow: 0 18px 48px -18px rgba(0, 0, 0, 0.8);
		backdrop-filter: blur(10px);
	}
	@media (hover: none) and (pointer: coarse) {
		.settings-popover {
			background: rgba(10, 7, 24, 0.97);
		}
	}

	.ctrl {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 999px;
		border: 1px solid var(--color-mist, #2e1d52);
		background: rgba(10, 7, 24, 0.5);
		color: var(--color-parchment, #d8cfee);
		cursor: pointer;
		backdrop-filter: blur(8px);
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			border-color 160ms ease,
			color 160ms ease,
			transform 160ms ease;
	}
	.ctrl svg {
		width: 20px;
		height: 20px;
	}
	@media (hover: hover) and (pointer: fine) {
		.ctrl:hover {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff5dd1);
			transform: scale(1.06);
		}
	}
	.ctrl:focus-visible {
		border-color: var(--brand-magenta, #ff2bc7);
		color: var(--brand-magenta-soft, #ff5dd1);
		outline: 2px solid var(--brand-magenta, #ff2bc7);
		outline-offset: 2px;
	}

	/* ── Stage ──────────────────────────────────────────────── */
	.stage {
		position: absolute;
		inset: 0;
		z-index: 4;
		display: flex;
		overflow: auto;
		scrollbar-width: none;
	}
	.stage::-webkit-scrollbar {
		width: 0;
		height: 0;
	}

	/* ── Mobile (≤600px): the controls are small, but keep their blur capped at a
	   cheap radius and lean on a more opaque base so they stay legible. ── */
	@media (max-width: 600px) {
		.ctrl {
			background: rgba(10, 7, 24, 0.72);
			backdrop-filter: blur(8px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.aurora {
			animation: none;
		}
		/* Drop the backdrop-filter; the opaque base keeps the icon readable. */
		.ctrl {
			backdrop-filter: none;
			background: rgba(10, 7, 24, 0.85);
		}
	}
</style>
