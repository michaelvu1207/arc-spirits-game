<script lang="ts">
	import type { PlaySpirit } from '$lib/play/types';

	interface Props {
		spirits: PlaySpirit[];
		/** Map of spirit id → game-print image URL. */
		spiritImages: Map<string, string>;
		guardianName?: string | null;
		guardianIcon?: string | null;
		accent?: string;
		/** How long the cutscene holds before auto-dismissing. */
		durationMs?: number;
		onDone: () => void;
	}

	let {
		spirits,
		spiritImages,
		accent = '#ff2bc7',
		durationMs = 5000,
		onDone
	}: Props = $props();

	let leaving = $state(false);

	function finish() {
		if (leaving) return;
		leaving = true;
		// Let the fade-out play before unmounting.
		setTimeout(onDone, 380);
	}

	$effect(() => {
		const t = setTimeout(finish, durationMs);
		return () => clearTimeout(t);
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish();
	}
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
	class="cut"
	class:leaving
	role="dialog"
	aria-label="Your starting spirits"
	tabindex="-1"
	data-testid="game-start-cutscene"
	style="--accent: {accent}"
	onclick={finish}
>
	<div class="aura" aria-hidden="true"></div>
	<div class="content">
		<div class="spirits" data-testid="start-spirits" style="--n: {Math.max(spirits.length, 1)}">
			{#each spirits as s, i (s.id + ':' + i)}
				{@const url = spiritImages.get(s.id)}
				<div class="spirit" style="--i: {i}">
					{#if url}
						<img src={url} alt={s.name} draggable="false" />
					{:else}
						<span class="ph">{s.name}</span>
					{/if}
				</div>
			{/each}
		</div>

		<h1 class="goodluck" data-testid="start-title">Starting Spirits</h1>
		<span class="hint" data-testid="start-hint">tap to continue</span>
	</div>
</div>

<style>
	.cut {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 4vh 4vw;
		background: radial-gradient(ellipse 80% 70% at 50% 45%, rgba(8, 5, 18, 0.86), rgba(4, 2, 12, 0.97));
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		cursor: pointer;
		animation: cut-in 320ms ease-out both;
	}
	.cut.leaving {
		animation: cut-out 360ms ease-in both;
		pointer-events: none;
	}
	.aura {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: radial-gradient(
			ellipse 60% 45% at 50% 42%,
			color-mix(in srgb, var(--accent) 28%, transparent),
			transparent 70%
		);
		mix-blend-mode: screen;
		opacity: 0.7;
		animation: aura-pulse 4s ease-in-out infinite;
	}
	.content {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: clamp(14px, 3vh, 28px);
		max-width: 100%;
	}
	.spirits {
		display: flex;
		justify-content: center;
		align-items: flex-end;
		gap: clamp(14px, 2vw, 28px);
		max-width: min(94vw, 980px);
		padding: 1rem 0 0.75rem;
	}
	.spirit {
		/* No frame — the print art is already a full card; show it whole + large. */
		width: clamp(145px, calc(23.5vw - 21px), 360px);
		/* Fan the hand: rotate around the centre index. */
		--rot: calc((var(--i) - (var(--n) - 1) / 2) * 4deg);
		transform: rotate(var(--rot));
		transform-origin: bottom center;
		filter: drop-shadow(0 18px 34px rgba(0, 0, 0, 0.7));
		animation: deal 620ms cubic-bezier(0.2, 0.9, 0.25, 1) both;
		animation-delay: calc(160ms + var(--i) * 110ms);
	}
	.spirit img {
		width: 100%;
		height: auto;
		display: block;
		/* Never crop — show the full spirit print at its natural aspect ratio. */
		object-fit: contain;
	}
	.spirit .ph {
		display: grid;
		place-items: center;
		width: 100%;
		min-height: 150px;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.4);
		font-family: var(--font-display);
		font-size: 0.8rem;
		text-align: center;
		padding: 6px;
		color: var(--color-fog, #9a93b0);
	}
	.goodluck {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(2.4rem, 8vmin, 5rem);
		line-height: 1;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
		text-shadow: 0 0 30px color-mix(in srgb, var(--accent) 70%, transparent);
		animation: rise 700ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
		animation-delay: calc(160ms + var(--n) * 110ms + 120ms);
	}
	.hint {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.26em;
		text-transform: uppercase;
		color: var(--color-whisper, #6a5d8a);
		animation: rise 700ms ease both;
		animation-delay: 1.2s;
	}

	@keyframes cut-in {
		from {
			opacity: 0;
		}
	}
	@keyframes cut-out {
		to {
			opacity: 0;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(14px);
		}
	}
	@keyframes deal {
		from {
			opacity: 0;
			transform: rotate(0deg) translateY(60px) scale(0.9);
		}
	}
	@keyframes aura-pulse {
		0%,
		100% {
			opacity: 0.5;
		}
		50% {
			opacity: 0.85;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cut,
		.spirit,
		.goodluck,
		.hint,
		.aura {
			animation: none;
		}
		.spirit {
			transform: rotate(var(--rot));
		}
	}
</style>
