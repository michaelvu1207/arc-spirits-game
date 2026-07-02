<script lang="ts">
	import type { ActionResult } from '$lib/play/types';

	interface Props {
		result: ActionResult | null;
		onContinue?: () => void;
	}

	let { result, onContinue }: Props = $props();

	const lines = $derived(result?.log ?? []);
</script>

<section class="result" data-testid="action-result">
	<span class="eyebrow">{result?.label ?? 'Action'} complete</span>
	<ul class="log">
		{#if lines.length > 0}
			{#each lines as line, i (i)}
				<li>{line}</li>
			{/each}
		{:else}
			<li class="muted">Done.</li>
		{/if}
	</ul>
	<button type="button" class="continue" data-testid="result-continue" onclick={() => onContinue?.()}>
		Continue
	</button>
</section>

<style>
	.result {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: clamp(0.75rem, 2vh, 1.05rem);
		width: min(42rem, 100%);
		max-width: 100%;
		padding: clamp(0.35rem, 1.5vh, 1rem);
		text-align: center;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--brand-amber, #ffba3d);
		text-shadow:
			0 0 14px color-mix(in srgb, var(--brand-amber, #ffba3d) 46%, transparent),
			0 2px 12px rgba(0, 0, 0, 0.55);
	}
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		text-align: center;
	}
	.log li {
		font-size: clamp(0.98rem, 1.7vw, 1.25rem);
		line-height: 1.35;
		color: #fff;
		text-wrap: balance;
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.58);
	}
	.log li.muted {
		color: var(--color-fog, #8d8aa1);
	}
	.continue {
		margin-top: 0.25rem;
		padding: 10px 22px;
		font-family: var(--font-display);
		font-size: 0.82rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		border: none;
		border-radius: 3px;
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		cursor: pointer;
		transition: background 140ms ease;
	}
	.continue:hover {
		background: var(--brand-magenta-soft, #ff7fd9);
	}
</style>
