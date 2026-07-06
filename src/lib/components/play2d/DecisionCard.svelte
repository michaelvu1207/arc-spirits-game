<script lang="ts">
	/**
	 * W2b — a class decision as an ability card (plans/ux-overhaul.md §4.2): art
	 * header, prompt headline, options as full-width choice rows. Decisions that
	 * embed a picker (Arc Mage's 4 attack dice) use the engine `pickerSpec`
	 * (§5.4) to light ONLY eligible dice — the same helper the reducer validates
	 * against, so UI-eligibility and acceptance cannot drift. Without a spec the
	 * card is a plain option choice (an omitted selection keeps reducer auto-pick).
	 */
	import type { AttackDie, PendingDecision } from '$lib/play/types';
	import type { DecisionPickerSpec } from '$lib/play/decisionPicker';
	import DieGem from './takeover/DieGem.svelte';

	interface Props {
		decision: PendingDecision;
		/** Engine picker requirement for this decision (matched by decisionId), if any. */
		pickerSpec?: DecisionPickerSpec | null;
		attackDice: AttackDie[];
		/** Class art for the header (resolved by the parent from the decision kind). */
		classIcon?: string | null;
		/** Header eyebrow ("Arc Mage"); falls back to a generic label. */
		sourceLabel?: string | null;
		busy?: boolean;
		/** Preserves per-surface testids: `${testidPrefix}-${id}-${optionId}`. */
		testidPrefix?: string;
		testid?: string;
		onResolve: (decisionId: string, optionId: string, selectedInstanceIds?: string[]) => void;
	}

	let {
		decision,
		pickerSpec = null,
		attackDice,
		classIcon = null,
		sourceLabel = null,
		busy = false,
		testidPrefix = 'decision',
		testid,
		onResolve
	}: Props = $props();

	const eligibleIds = $derived(new Set(pickerSpec?.eligibleInstanceIds ?? []));
	const needed = $derived(pickerSpec?.count ?? 0);

	let pick = $state<string[]>([]);
	function toggleDie(instanceId: string) {
		if (pick.includes(instanceId)) pick = pick.filter((id) => id !== instanceId);
		else if (pick.length < needed) pick = [...pick, instanceId];
	}
	// Drop stale picks if the dice change out from under the decision.
	$effect(() => {
		const owned = new Set(attackDice.map((d) => d.instanceId));
		if (pick.some((id) => !owned.has(id) || !eligibleIds.has(id)))
			pick = pick.filter((id) => owned.has(id) && eligibleIds.has(id));
	});

	// With a picker, the affirmative option submits the picked ids; every other
	// option resolves plainly (decline clears the staged picks).
	const yesOption = $derived(
		pickerSpec ? (decision.options.find((o) => o.id !== 'no') ?? null) : null
	);
	const otherOptions = $derived(
		pickerSpec ? decision.options.filter((o) => o.id !== yesOption?.id) : decision.options
	);
	function resolve(optionId: string, withPicks: boolean) {
		if (busy) return;
		if (withPicks && pick.length !== needed) return;
		onResolve(decision.id, optionId, withPicks ? [...pick] : undefined);
		pick = [];
	}
</script>

<section class="ability-card" data-testid={testid ?? `${testidPrefix}-${decision.id}`}>
	<header class="head">
		<span class="head-art">
			{#if classIcon}
				<img src={classIcon} alt="" />
			{:else}
				<span class="head-fb" aria-hidden="true">✦</span>
			{/if}
		</span>
		<span class="head-text">
			<span class="eyebrow">{sourceLabel ?? 'Class ability'}</span>
			<p class="prompt">{decision.prompt}</p>
		</span>
	</header>

	{#if pickerSpec}
		<div class="picker" data-testid={`arc-convert-${decision.id}`}>
			<div class="dice-row" class:hasPick={pick.length > 0}>
				{#if attackDice.length === 0}
					<span class="none-note">No attack dice</span>
				{/if}
				{#each attackDice as die (die.instanceId)}
					<DieGem
						tier={die.tier}
						selected={pick.includes(die.instanceId)}
						locked={!eligibleIds.has(die.instanceId)}
						reason="Not eligible"
						disabled={busy}
						testid={`arc-die-${die.instanceId}`}
						onClick={() => toggleDie(die.instanceId)}
					/>
				{/each}
			</div>
			<div class="opts" role="group" aria-label="Resolve">
				{#if yesOption}
					<button
						type="button"
						class="opt-row"
						data-testid={`${testidPrefix}-${decision.id}-${yesOption.id}`}
						disabled={busy || pick.length !== needed}
						onclick={() => resolve(yesOption.id, true)}
					>
						<span class="opt-label">{yesOption.label} ({pick.length}/{needed})</span>
						<span class="opt-go" aria-hidden="true">→</span>
					</button>
				{/if}
				{#each otherOptions as option (option.id)}
					<button
						type="button"
						class="opt-row decline"
						data-testid={`${testidPrefix}-${decision.id}-${option.id}`}
						disabled={busy}
						onclick={() => resolve(option.id, false)}
					>
						<span class="opt-label">{option.label}</span>
					</button>
				{/each}
			</div>
		</div>
	{:else}
		<div class="opts" role="group" aria-label="Choose an option">
			{#each decision.options as option (option.id)}
				<button
					type="button"
					class="opt-row"
					class:decline={option.id === 'no'}
					data-testid={`${testidPrefix}-${decision.id}-${option.id}`}
					disabled={busy}
					onclick={() => resolve(option.id, false)}
				>
					<span class="opt-label">{option.label}</span>
					{#if option.id !== 'no'}<span class="opt-go" aria-hidden="true">→</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</section>

<style>
	/* An ability card: frosted panel, class art pinned to the header, options as
	   tappable rows — the same visual family as the location interaction cards. */
	.ability-card {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: clamp(0.7rem, 1.8vh, 1rem);
		width: min(34rem, 100%);
		padding: clamp(0.85rem, 2vh, 1.2rem) clamp(0.9rem, 2.2vw, 1.35rem);
		border-radius: 18px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(15, 10, 28, 0.32);
		-webkit-backdrop-filter: blur(28px) saturate(1.3);
		backdrop-filter: blur(28px) saturate(1.3);
		box-shadow:
			0 16px 44px rgba(0, 0, 0, 0.45),
			inset 0 1px 0 rgba(255, 255, 255, 0.16);
		text-align: left;
		animation: card-in 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	@keyframes card-in {
		from {
			opacity: 0;
			transform: translateY(10px) scale(0.97);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: clamp(0.7rem, 1.8vw, 1rem);
	}
	.head-art {
		flex: none;
		width: clamp(2.9rem, 6vh, 3.8rem);
		height: clamp(2.9rem, 6vh, 3.8rem);
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
		font-size: 1.4rem;
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
		font-size: 0.66rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
	.prompt {
		margin: 0;
		font-size: clamp(0.92rem, 1.4vw, 1.08rem);
		line-height: 1.4;
		color: var(--color-bone, #efeaf7);
		text-wrap: balance;
	}
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.dice-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.35rem;
	}
	.dice-row.hasPick :global(.die:not(.selected):not(.locked)) {
		opacity: 0.55;
	}
	.none-note {
		font-size: 0.82rem;
		color: var(--brand-amber-soft, #ffd56a);
	}
	.opts {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.opt-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		width: 100%;
		min-height: 46px;
		padding: 0.55rem 0.95rem;
		border-radius: 10px;
		border: 1px solid color-mix(in srgb, var(--brand-cyan, #24d4ff) 60%, transparent);
		background: rgba(0, 0, 0, 0.28);
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		text-align: left;
		cursor: pointer;
		transition:
			background 140ms ease,
			color 140ms ease,
			transform 140ms ease,
			border-color 140ms ease,
			opacity 140ms ease;
	}
	.opt-row:not(:disabled):hover {
		background: color-mix(in srgb, var(--brand-cyan, #24d4ff) 22%, transparent);
		color: #fff;
		transform: translateY(-1px);
	}
	.opt-row:not(:disabled):hover .opt-go {
		transform: translateX(3px);
	}
	.opt-go {
		flex: none;
		font-size: 0.95rem;
		transition: transform 140ms ease;
	}
	.opt-row.decline {
		border-color: rgba(255, 255, 255, 0.22);
		color: var(--color-fog, #9a8fb8);
	}
	.opt-row.decline:not(:disabled):hover {
		background: rgba(255, 255, 255, 0.07);
		color: var(--color-parchment, #d8cfee);
	}
	.opt-row:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.ability-card {
			gap: 0.5rem;
			padding: 0.6rem 0.75rem;
			border-radius: 12px;
			background: rgba(15, 10, 28, 0.7);
			-webkit-backdrop-filter: blur(10px);
			backdrop-filter: blur(10px);
		}
		.head-art {
			width: 2.2rem;
			height: 2.2rem;
		}
		.prompt {
			font-size: 0.8rem;
			line-height: 1.3;
		}
		.opt-row {
			min-height: 38px;
			padding: 0.4rem 0.7rem;
			font-size: 0.66rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ability-card {
			animation: none;
		}
	}
</style>
