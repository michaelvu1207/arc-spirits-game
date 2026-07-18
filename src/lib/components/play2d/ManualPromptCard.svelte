<script lang="ts">
	/**
	 * W2b — a hand-resolved (manual) awaken effect as an ability card: same visual
	 * family as DecisionCard, but the only action is acknowledging it was done.
	 */
	import type { ManualPrompt } from '$lib/play/types';

	interface Props {
		prompt: ManualPrompt;
		classIcon?: string | null;
		busy?: boolean;
		testid?: string;
		onDismiss: (id: string) => void;
		/** Confirm an awaken-sourced prompt: sends manualAwaken (flip + clear). */
		onConfirmAwaken?: (slotIndex: number) => void;
	}

	let {
		prompt,
		classIcon = null,
		busy = false,
		testid,
		onDismiss,
		onConfirmAwaken
	}: Props = $props();

	// An awaken-sourced prompt is a blocked FLIP, not dead text: confirming it must
	// send manualAwaken{slotIndex} (the server flips the spirit and clears the
	// prompt). Dismiss stays available as the deliberate "leave it face-down" out.
	const isAwaken = $derived(
		prompt.source === 'awaken' && prompt.slotIndex != null && onConfirmAwaken != null
	);
</script>

<section class="manual-card" data-testid={testid ?? `ability-manual-${prompt.id}`}>
	<header class="head">
		<span class="head-art">
			{#if classIcon}
				<img src={classIcon} alt="" />
			{:else}
				<span class="head-fb" aria-hidden="true">✦</span>
			{/if}
		</span>
		<span class="head-text">
			<span class="eyebrow">{prompt.source} · Resolve by hand</span>
			<p class="text">{prompt.text}</p>
		</span>
	</header>
	{#if isAwaken}
		<div class="actions">
			<button
				type="button"
				class="done ghost"
				disabled={busy}
				data-testid="manual-dismiss"
				onclick={() => onDismiss(prompt.id)}
			>
				Not yet
			</button>
			<button
				type="button"
				class="done confirm"
				disabled={busy}
				data-testid="manual-awaken"
				onclick={() => onConfirmAwaken?.(prompt.slotIndex!)}
			>
				Resolved — Awaken
			</button>
		</div>
	{:else}
		<button type="button" class="done" disabled={busy} onclick={() => onDismiss(prompt.id)}>
			Done
		</button>
	{/if}
</section>

<style>
	.manual-card {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		width: min(34rem, 100%);
		padding: clamp(0.8rem, 1.8vh, 1.1rem) clamp(0.9rem, 2.2vw, 1.3rem);
		border-radius: 18px;
		border: 1px solid color-mix(in srgb, var(--brand-amber, #ffba3d) 30%, rgba(255, 255, 255, 0.1));
		background: rgba(15, 10, 28, 0.32);
		-webkit-backdrop-filter: blur(28px) saturate(1.3);
		backdrop-filter: blur(28px) saturate(1.3);
		box-shadow:
			0 16px 44px rgba(0, 0, 0, 0.45),
			inset 0 1px 0 rgba(255, 255, 255, 0.16);
		text-align: left;
	}
	.head {
		display: flex;
		align-items: center;
		gap: clamp(0.7rem, 1.8vw, 1rem);
	}
	.head-art {
		flex: none;
		width: clamp(2.6rem, 5vh, 3.4rem);
		height: clamp(2.6rem, 5vh, 3.4rem);
		display: grid;
		place-items: center;
	}
	.head-art img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.55));
	}
	.head-fb {
		font-size: 1.3rem;
		color: var(--color-fog, #8d8aa1);
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
		min-width: 0;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.64rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--brand-amber-soft, #ffd56a);
	}
	.text {
		margin: 0;
		font-size: clamp(0.9rem, 1.3vw, 1.02rem);
		line-height: 1.4;
		color: var(--color-bone, #efeaf7);
	}
	.actions {
		display: flex;
		align-self: flex-end;
		gap: 0.5rem;
	}
	.done.confirm {
		border-color: color-mix(in srgb, var(--brand-amber, #ffba3d) 55%, rgba(255, 255, 255, 0.2));
		background: color-mix(in srgb, var(--brand-amber, #ffba3d) 18%, transparent);
	}
	.done.ghost {
		opacity: 0.85;
	}
	.done {
		align-self: flex-end;
		min-height: 40px;
		padding: 0.45rem 1.2rem;
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: transparent;
		color: inherit;
		cursor: pointer;
		transition:
			background 140ms ease,
			transform 140ms ease;
	}
	.done:not(:disabled):hover {
		background: rgba(255, 255, 255, 0.08);
		transform: translateY(-1px);
	}
	.done:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.manual-card {
			gap: 0.45rem;
			padding: 0.6rem 0.75rem;
			border-radius: 12px;
			background: rgba(15, 10, 28, 0.7);
			-webkit-backdrop-filter: blur(10px);
			backdrop-filter: blur(10px);
		}
		.head-art {
			width: 2rem;
			height: 2rem;
		}
		.text {
			font-size: 0.78rem;
			line-height: 1.3;
		}
		.done {
			min-height: 34px;
			padding: 0.35rem 0.9rem;
			font-size: 0.64rem;
		}
	}
</style>
