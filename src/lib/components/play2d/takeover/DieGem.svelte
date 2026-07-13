<script lang="ts" module>
	import type { DiceTier } from '$lib/play/types';

	/** Single source for attack-die visuals — every surface that shows a die
	 *  (Arc Mage convert, Infiltrator swap, tainted split) uses the same gem. */
	export const TIER_COLOR: Record<DiceTier, string> = {
		basic: '#8d8aa1',
		enchanted: '#4d8bf0',
		exalted: '#b06bff',
		arcane: '#ff2bc7'
	};
	export const TIER_LABEL: Record<DiceTier, string> = {
		basic: 'Basic',
		enchanted: 'Enchanted',
		exalted: 'Exalted',
		arcane: 'Arcane'
	};
</script>

<script lang="ts">
	interface Props {
		tier: DiceTier;
		image?: string | null;
		selected?: boolean;
		disabled?: boolean;
		/** Ineligible (engine verdict): visible, dimmed + locked; tap reveals `reason`. */
		locked?: boolean;
		reason?: string | null;
		size?: 'md' | 'lg';
		testid?: string;
		onClick?: () => void;
	}

	let {
		tier,
		image = null,
		selected = false,
		disabled = false,
		locked = false,
		reason = null,
		size = 'md',
		testid,
		onClick
	}: Props = $props();

	let revealed = $state(false);
	let revealTimer: ReturnType<typeof setTimeout> | null = null;
	function tap() {
		if (disabled) return;
		if (locked) {
			if (!reason) return;
			revealed = true;
			if (revealTimer) clearTimeout(revealTimer);
			revealTimer = setTimeout(() => (revealed = false), 2200);
			return;
		}
		onClick?.();
	}
</script>

<button
	type="button"
	class="die {size}"
	class:selected
	class:locked
	class:reveal={revealed}
	style="--tier: {TIER_COLOR[tier]}"
	disabled={disabled && !locked}
	aria-pressed={selected}
	aria-disabled={locked}
	title={locked ? (reason ?? TIER_LABEL[tier]) : `${TIER_LABEL[tier]} Attack die`}
	data-testid={testid}
	onclick={tap}
>
	{#if locked && reason}
		<span class="reason-chip" role="status">{reason}</span>
	{/if}
	<span class="gem" class:has-image={!!image} aria-hidden="true">
		{#if image}<img class="die-art" src={image} alt="" />{:else}<span class="facet"></span>{/if}
		{#if locked}
			<span class="lock-badge">
				<svg viewBox="0 0 24 24" width="9" height="9">
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
	</span>
	{#if selected}<span class="tick" aria-hidden="true">✓</span>{/if}
	<span class="tier-label">{TIER_LABEL[tier]}</span>
</button>

<style>
	.die {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 0.32rem;
		padding: 0.45rem 0.4rem 0.3rem;
		border: 0;
		background: transparent;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			transform 150ms cubic-bezier(0.22, 1, 0.36, 1),
			filter 150ms ease,
			opacity 150ms ease;
	}
	.gem {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--gem, 1.9rem);
		height: var(--gem, 1.9rem);
	}
	.gem.has-image {
		width: var(--gem, 2.35rem);
		height: var(--gem, 2.35rem);
	}
	.die-art {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 0 8px color-mix(in srgb, var(--tier) 55%, transparent));
		transition:
			transform 150ms ease,
			filter 150ms ease;
	}
	.die.lg {
		--gem: 2.4rem;
	}
	/* The physical token: a rotated gem with a lit facet, colored by tier. */
	.facet {
		width: 74%;
		height: 74%;
		border-radius: 22%;
		transform: rotate(45deg);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--tier) 45%, #fff) 0%,
			var(--tier) 52%,
			color-mix(in srgb, var(--tier) 55%, #000) 100%
		);
		box-shadow:
			0 0 10px color-mix(in srgb, var(--tier) 55%, transparent),
			inset 0 1px 1px rgba(255, 255, 255, 0.55),
			inset 0 -1px 2px rgba(0, 0, 0, 0.4);
		transition:
			box-shadow 150ms ease,
			transform 150ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.die:not(.locked):not(:disabled):hover {
			transform: translateY(-3px);
		}
		.die:not(.locked):not(:disabled):hover .facet {
			box-shadow:
				0 0 16px color-mix(in srgb, var(--tier) 80%, transparent),
				inset 0 1px 1px rgba(255, 255, 255, 0.6),
				inset 0 -1px 2px rgba(0, 0, 0, 0.4);
		}
	}
	.die.selected {
		transform: translateY(-3px);
	}
	.die.selected .facet {
		transform: rotate(45deg) scale(1.08);
		box-shadow:
			0 0 18px color-mix(in srgb, var(--tier) 90%, transparent),
			0 0 0 2px color-mix(in srgb, var(--tier) 70%, #fff 30%),
			inset 0 1px 1px rgba(255, 255, 255, 0.65);
	}
	.die.selected .die-art {
		transform: scale(1.1);
		filter: drop-shadow(0 0 14px color-mix(in srgb, var(--tier) 85%, transparent));
	}
	.die:disabled:not(.locked) {
		opacity: 0.32;
		cursor: not-allowed;
	}
	.die.locked {
		cursor: not-allowed;
		opacity: 0.38;
	}
	.die.locked .facet {
		filter: grayscale(0.8) saturate(0.4);
	}
	.die.locked .die-art {
		filter: grayscale(0.85) saturate(0.35);
	}
	.die:focus-visible {
		outline: none;
	}
	.die:focus-visible .facet {
		box-shadow:
			0 0 0 2px color-mix(in srgb, var(--tier) 80%, #fff 20%),
			0 0 14px color-mix(in srgb, var(--tier) 60%, transparent);
	}
	.tick {
		position: absolute;
		top: -0.15rem;
		left: 50%;
		transform: translateX(-50%);
		width: 1.05rem;
		height: 1.05rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: var(--tier);
		color: #fff;
		font-size: 0.66rem;
		box-shadow: 0 0 0 2px rgba(8, 5, 16, 0.82);
	}
	.lock-badge {
		position: absolute;
		right: -8%;
		bottom: -8%;
		width: 1rem;
		height: 1rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: rgba(10, 6, 20, 0.92);
		color: var(--color-fog, #b9b4cc);
		box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.22);
	}
	.tier-label {
		font-family: var(--font-display);
		font-size: 0.52rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.68);
	}
	.die.selected .tier-label {
		color: #fff;
	}
	.reason-chip {
		position: absolute;
		bottom: calc(100% - 0.2rem);
		left: 50%;
		transform: translateX(-50%) scale(0.92);
		z-index: 4;
		width: max-content;
		max-width: 9rem;
		padding: 0.28rem 0.5rem;
		border-radius: 8px;
		background: rgba(10, 6, 20, 0.95);
		border: 1px solid color-mix(in srgb, var(--brand-coral, #ff704d) 55%, transparent);
		color: var(--brand-coral, #ff9a80);
		font-size: 0.64rem;
		line-height: 1.25;
		text-align: center;
		white-space: normal;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 140ms ease,
			transform 140ms ease;
	}
	.die.reveal .reason-chip {
		opacity: 1;
		transform: translateX(-50%) scale(1);
	}
	@media (hover: hover) and (pointer: fine) {
		.die.locked:hover .reason-chip {
			opacity: 1;
			transform: translateX(-50%) scale(1);
		}
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.die {
			padding: 0.3rem 0.28rem 0.2rem;
			gap: 0.2rem;
		}
		.gem {
			--gem: 1.5rem;
		}
		.die.lg {
			--gem: 1.85rem;
		}
		.tier-label {
			font-size: 0.46rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.die,
		.facet,
		.reason-chip {
			transition: none;
		}
	}
</style>
