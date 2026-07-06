<script lang="ts">
	import type { MeterSlot } from './types';

	interface Props {
		/** Cost meter — one slot per required item; empty array hides the meter. */
		slots?: MeterSlot[];
		/** Free-text summary shown instead of (or beside) the meter (benefits claim). */
		summary?: string | null;
		/** Amber advisory ("No effect right now — barriers already full"). */
		warning?: string | null;
		confirmLabel: string;
		confirmDisabled?: boolean;
		confirmTestid?: string;
		onConfirm: () => void;
		/** Omit to hide Cancel (mandatory claims). */
		onCancel?: (() => void) | null;
		cancelLabel?: string;
		cancelTestid?: string;
		busy?: boolean;
		accent?: string;
	}

	let {
		slots = [],
		summary = null,
		warning = null,
		confirmLabel,
		confirmDisabled = false,
		confirmTestid,
		onConfirm,
		onCancel = null,
		cancelLabel = 'Cancel',
		cancelTestid = undefined,
		busy = false,
		accent = 'var(--brand-magenta, #ff2bc7)'
	}: Props = $props();
</script>

<div class="commit-bar" style="--accent: {accent}" data-testid="commit-bar">
	<div class="meter" class:empty={slots.length === 0 && !summary}>
		{#each slots as slot, i (i)}
			<span class="meter-slot" class:filled={!!slot.filled} title={slot.filled?.label ?? slot.need}>
				<span class="slot-frame">
					{#if slot.filled?.icon}
						<img class="pick" src={slot.filled.icon} alt={slot.filled.label} />
					{:else if slot.needIcon}
						<img class="need" src={slot.needIcon} alt="" />
					{:else}
						<span class="need-glyph" aria-hidden="true">◇</span>
					{/if}
					{#if slot.filled}<span class="tick" aria-hidden="true"></span>{/if}
				</span>
				<span class="slot-need">{slot.filled?.label ?? slot.need}</span>
			</span>
		{/each}
		{#if summary}<span class="summary">{summary}</span>{/if}
		{#if warning}<span class="warning" data-testid="commit-warning">⚠ {warning}</span>{/if}
	</div>
	<div class="actions">
		<button
			type="button"
			class="confirm"
			data-testid={confirmTestid}
			disabled={busy || confirmDisabled}
			onclick={onConfirm}
		>
			{confirmLabel}
		</button>
		{#if onCancel}
			<button type="button" class="cancel" data-testid={cancelTestid} disabled={busy} onclick={onCancel}
				>{cancelLabel}</button
			>
		{/if}
	</div>
</div>

<style>
	/* The one home for every staged decision: meter left, CTA right, pinned to the
	   bottom of its takeover (per-takeover, NOT a global footer). */
	.commit-bar {
		box-sizing: border-box;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.9rem;
		padding: 0.55rem 0.9rem;
		border-radius: 14px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(12, 7, 24, 0.78);
		-webkit-backdrop-filter: blur(18px);
		backdrop-filter: blur(18px);
		box-shadow:
			0 14px 38px rgba(0, 0, 0, 0.5),
			inset 0 1px 0 rgba(255, 255, 255, 0.12);
	}
	.meter {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.55rem 0.7rem;
		min-width: 0;
	}
	.meter.empty {
		display: none;
	}
	.meter-slot {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
		min-width: 3.1rem;
	}
	.slot-frame {
		position: relative;
		width: 2.9rem;
		height: 2.9rem;
		display: grid;
		place-items: center;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.05);
		box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.16);
		transition:
			box-shadow 180ms ease,
			background 180ms ease;
	}
	.meter-slot.filled .slot-frame {
		background: color-mix(in srgb, var(--accent) 14%, rgba(255, 255, 255, 0.04));
		box-shadow:
			inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 75%, #fff 10%),
			0 0 14px color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.slot-frame img {
		width: 82%;
		height: 82%;
		object-fit: contain;
	}
	.slot-frame img.need {
		opacity: 0.32;
		filter: grayscale(0.5);
	}
	.slot-frame img.pick {
		filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.55));
		animation: slot-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.need-glyph {
		font-size: 1.2rem;
		color: rgba(255, 255, 255, 0.3);
	}
	.tick {
		position: absolute;
		top: -0.35rem;
		right: -0.35rem;
		width: 1.05rem;
		height: 1.05rem;
		border-radius: 50%;
		background: var(--accent)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 13l4 4L19 7' fill='none' stroke='white' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
			center / 62% no-repeat;
		box-shadow: 0 0 0 2px rgba(12, 7, 24, 0.9);
	}
	@keyframes slot-pop {
		from {
			transform: scale(0.4);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}
	.slot-need {
		max-width: 5.4rem;
		font-family: var(--font-display);
		font-size: 0.56rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.62);
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.meter-slot.filled .slot-need {
		color: #fff;
	}
	.summary {
		font-size: clamp(0.8rem, 1.2vw, 0.92rem);
		color: var(--color-parchment, #d8cfee);
	}
	.warning {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.28rem 0.6rem;
		border-radius: 999px;
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--brand-amber-soft, #ffd56a);
		background: color-mix(in srgb, var(--brand-amber, #ffba3d) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--brand-amber, #ffba3d) 45%, transparent);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex: none;
	}
	.confirm {
		min-height: 44px;
		padding: 0.6rem 1.35rem;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		border: none;
		border-radius: 10px;
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 140ms ease,
			transform 140ms ease,
			opacity 140ms ease;
	}
	.confirm:not(:disabled):hover {
		background: var(--brand-magenta-soft, #ff7fd9);
		transform: translateY(-1px);
	}
	.confirm:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}
	.cancel {
		min-height: 44px;
		padding: 0.55rem 1rem;
		font: inherit;
		font-size: 0.88rem;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.cancel:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 600px) {
		.commit-bar {
			flex-direction: column;
			align-items: stretch;
			gap: 0.55rem;
			padding: 0.55rem 0.65rem;
		}
		.meter {
			justify-content: center;
		}
		.actions {
			justify-content: center;
		}
		.confirm {
			flex: 1 1 auto;
		}
		.slot-frame {
			width: 2.5rem;
			height: 2.5rem;
		}
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.commit-bar {
			padding: 0.35rem 0.6rem;
			border-radius: 10px;
			gap: 0.6rem;
		}
		.slot-frame {
			width: 2.2rem;
			height: 2.2rem;
			border-radius: 9px;
		}
		.slot-need {
			font-size: 0.5rem;
		}
		.confirm {
			min-height: 38px;
			padding: 0.45rem 0.95rem;
			font-size: 0.68rem;
		}
		.cancel {
			min-height: 38px;
			padding: 0.4rem 0.75rem;
			font-size: 0.78rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.slot-frame img.pick {
			animation: none;
		}
	}
</style>
