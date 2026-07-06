<script lang="ts">
	import type { RackCandidate } from './types';

	interface Props {
		candidates: RackCandidate[];
		/** Tap a card — the flow owns what happens (fill a meter slot / toggle). */
		onTap: (key: string) => void;
		disabled?: boolean;
		accent?: string;
		/** data-testid prefix per card: `${testidPrefix}-${index}`. */
		testidPrefix?: string;
		testid?: string;
		/** 'lg' for payment takeovers (few cards), 'md' for dense racks (relic rows). */
		size?: 'md' | 'lg';
		ariaLabel?: string;
	}

	let {
		candidates,
		onTap,
		disabled = false,
		accent = 'var(--brand-magenta, #ff2bc7)',
		testidPrefix = 'candidate',
		testid,
		size = 'lg',
		ariaLabel = 'Choose'
	}: Props = $props();

	// Tapping a locked card reveals its reason chip briefly (hover shows it too).
	let revealedKey = $state<string | null>(null);
	let revealTimer: ReturnType<typeof setTimeout> | null = null;
	function tap(c: RackCandidate) {
		if (disabled) return;
		if (!c.eligible) {
			revealedKey = c.key;
			if (revealTimer) clearTimeout(revealTimer);
			revealTimer = setTimeout(() => (revealedKey = null), 2200);
			return;
		}
		if (c.auto) return;
		onTap(c.key);
	}
</script>

<div
	class="rack {size}"
	style="--accent: {accent}"
	role="group"
	aria-label={ariaLabel}
	data-testid={testid}
>
	{#each candidates as c, i (c.key)}
		<button
			type="button"
			class="card"
			class:selected={c.selected > 0}
			class:locked={!c.eligible}
			class:auto={c.auto}
			class:reveal={revealedKey === c.key}
			disabled={disabled && c.eligible}
			aria-pressed={c.selected > 0}
			aria-disabled={!c.eligible}
			title={c.eligible ? c.label : (c.reason ?? c.label)}
			data-testid={`${testidPrefix}-${i}`}
			onclick={() => tap(c)}
		>
			{#if !c.eligible && c.reason}
				<span class="reason-chip" role="status">{c.reason}</span>
			{/if}
			<span class="art">
				{#if c.image}
					<img src={c.image} alt={c.label} loading="lazy" />
				{:else}
					<span class="art-fb" aria-hidden="true">✦</span>
				{/if}
				{#if !c.eligible}
					<span class="lock-badge" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="12" height="12">
							<path
								d="M7 10V7a5 5 0 0 1 10 0v3"
								fill="none"
								stroke="currentColor"
								stroke-width="2.4"
								stroke-linecap="round"
							/>
							<rect x="5" y="10" width="14" height="10" rx="2" fill="currentColor" />
						</svg>
					</span>
				{/if}
				{#if c.selected > 0}
					<span class="sel-badge" aria-hidden="true">
						{#if c.count > 1}{c.selected}{:else}✓{/if}
					</span>
				{/if}
			</span>
			<span class="label">{c.label}</span>
			{#if c.count > 1}
				<span class="count" class:partial={c.selected > 0 && c.selected < c.count}>×{c.count}</span>
			{/if}
			{#if c.auto}
				<span class="auto-chip">auto-paid</span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.rack {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: center;
		gap: clamp(0.5rem, 1.6vw, 1rem);
		width: 100%;
		min-width: 0;
	}
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		padding: 0.55rem 0.45rem 0.5rem;
		border: 1px solid transparent;
		border-radius: 14px;
		background: transparent;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
			filter 160ms ease,
			opacity 160ms ease,
			background 160ms ease;
	}
	.art {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--cand-size, clamp(5rem, 10.5vw, 7.5rem));
		height: var(--cand-size, clamp(5rem, 10.5vw, 7.5rem));
	}
	.rack.md .card {
		--cand-size: clamp(3.4rem, 7vw, 4.6rem);
	}
	.art img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.55));
		transition:
			transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
			filter 160ms ease;
	}
	.art-fb {
		font-size: 1.6rem;
		color: var(--color-fog, #8d8aa1);
	}
	@media (hover: hover) and (pointer: fine) {
		.card:not(.locked):not(.auto):not(:disabled):hover {
			transform: translateY(-4px);
		}
		.card:not(.locked):not(.auto):not(:disabled):hover .art img {
			transform: scale(1.05);
			filter: drop-shadow(0 12px 22px rgba(0, 0, 0, 0.6))
				drop-shadow(0 0 14px color-mix(in srgb, var(--accent) 42%, transparent));
		}
	}
	.card:focus-visible {
		outline: none;
		border-color: color-mix(in srgb, var(--accent) 70%, #fff 20%);
	}
	.card.selected {
		transform: translateY(-4px);
	}
	.card.selected .art img {
		filter: drop-shadow(0 10px 20px rgba(0, 0, 0, 0.55))
			drop-shadow(0 0 16px color-mix(in srgb, var(--accent) 60%, transparent));
	}
	/* Dim-and-lock beats hiding: the excluded object teaches the rule. */
	.card.locked {
		cursor: not-allowed;
		opacity: 0.4;
	}
	.card.locked .art img {
		filter: grayscale(0.85) saturate(0.5) drop-shadow(0 6px 12px rgba(0, 0, 0, 0.5));
	}
	.card.auto {
		cursor: default;
	}
	.lock-badge {
		position: absolute;
		right: 2%;
		bottom: 2%;
		width: 1.35rem;
		height: 1.35rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: rgba(10, 6, 20, 0.92);
		color: var(--color-fog, #b9b4cc);
		box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.22);
	}
	.sel-badge {
		position: absolute;
		top: -0.4rem;
		right: 4%;
		min-width: 1.3rem;
		height: 1.3rem;
		padding-inline: 0.2rem;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.74rem;
		box-shadow:
			0 0 0 2px rgba(12, 7, 24, 0.85),
			0 0 12px color-mix(in srgb, var(--accent) 55%, transparent);
	}
	/* The reason chip sits ON the locked art (not above the card, where it would
	   clip under the stage hint) — the lock explains itself in place. */
	.reason-chip {
		position: absolute;
		top: 34%;
		left: 50%;
		transform: translate(-50%, -50%) scale(0.92);
		z-index: 4;
		width: max-content;
		max-width: calc(100% + 2.2rem);
		padding: 0.32rem 0.6rem;
		border-radius: 8px;
		background: rgba(10, 6, 20, 0.95);
		border: 1px solid color-mix(in srgb, var(--brand-coral, #ff704d) 55%, transparent);
		color: var(--brand-coral, #ff9a80);
		font-size: 0.7rem;
		line-height: 1.25;
		text-align: center;
		white-space: normal;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 140ms ease,
			transform 140ms ease;
	}
	.card.reveal .reason-chip {
		opacity: 1;
		transform: translate(-50%, -50%) scale(1);
	}
	@media (hover: hover) and (pointer: fine) {
		.card.locked:hover .reason-chip {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1);
		}
	}
	.label {
		max-width: calc(var(--cand-size, 6.5rem) + 1.4rem);
		font-family: var(--font-display);
		font-size: clamp(0.58rem, 0.9vw, 0.68rem);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-parchment, #d8cfee);
		text-align: center;
		line-height: 1.25;
	}
	.card.locked .label {
		color: var(--color-fog, #8d8aa1);
	}
	.count {
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-fog, #a49fc0);
	}
	.count.partial,
	.card.selected .count {
		color: color-mix(in srgb, var(--accent) 70%, #fff 30%);
	}
	.auto-chip {
		font-family: var(--font-display);
		font-size: 0.54rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		padding: 0.14rem 0.42rem;
		border-radius: 999px;
		color: var(--brand-teal, #20e0c1);
		border: 1px solid color-mix(in srgb, var(--brand-teal, #20e0c1) 45%, transparent);
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.rack {
			gap: 0.35rem;
		}
		.card {
			--cand-size: clamp(3.2rem, 16vh, 4.2rem);
			padding: 0.3rem 0.3rem 0.28rem;
			gap: 0.18rem;
		}
		.rack.md .card {
			--cand-size: clamp(2.6rem, 13vh, 3.4rem);
		}
		.label {
			font-size: 0.52rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.card,
		.art img,
		.reason-chip {
			transition: none;
		}
	}
</style>
