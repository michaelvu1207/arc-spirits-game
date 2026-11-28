<script lang="ts">
	/**
	 * W2a — the loot moment (plans/ux-overhaul.md §4.2). A kill grants EVERY reward on
	 * the card (owner rule, 2026-11-03), so the reward track fans out as earned
	 * medallions and Confirm claims them all. A `chooseRune` reward shows rune chips
	 * and demands an explicit pick — no silent option-0 default.
	 *
	 * A kill that gives ONE reward of the card (`chooseOne`: the permanent monster) shows the same medallions as a choice: tap one, claim it.
	 *
	 * Data: the engine's RESOLVED reward options (§5.3, `SeatAffordances.pendingReward`)
	 * — labelled, claimable, server-computed. The client never re-runs
	 * `buildMonsterRewards` on raw icon ids (that call died with this takeover).
	 */
	import type { PendingRewardState } from '$lib/play/types';
	import type { ResolvedPendingReward } from '$lib/play/viewV2';
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import { displayName, rewardTokenIconUrl, storageUrl } from './helpers';
	import { monsterCardFace } from './monsterCardFace';
	import TakeoverStage from './takeover/TakeoverStage.svelte';
	import SourcePanel from './takeover/SourcePanel.svelte';
	import CommitBar from './takeover/CommitBar.svelte';
	import type { MeterSlot } from './takeover/types';

	interface RewardCard {
		index: number;
		label: string;
		icon: string | null;
		isChoice: boolean;
		chooseOptions: { runeId: string; name: string; icon: string | null }[];
	}

	interface Props {
		/** The raw obligation (projection) — monster identity for the source panel. */
		reward: PendingRewardState;
		/** The engine-resolved option set (affordances §5.3). */
		resolved: ResolvedPendingReward | null;
		assets: ReturnType<typeof getAssetState>;
		accent?: string;
		busy?: boolean;
		onClaim: (picks: number[], choices: number[]) => void;
	}

	let { reward, resolved, assets, accent = '#ff704d', busy = false, onClaim }: Props = $props();

	function tokenIcon(id: string): string | null {
		return rewardTokenIconUrl(assets, id);
	}
	function runeIcon(runeId: string): string | null {
		return storageUrl(assets.matAssets.get(runeId)?.icon_path ?? null);
	}

	const cards = $derived<RewardCard[]>(
		(resolved?.options ?? []).map((o) => ({
			index: o.index,
			label: o.label,
			icon: tokenIcon(o.iconToken),
			isChoice: o.effect === 'chooseRune',
			chooseOptions: (o.chooseOptions ?? []).map((c) => ({ ...c, icon: runeIcon(c.runeId) }))
		}))
	);
	const count = $derived(cards.length);
	/** The kill gives one reward of the card, the player's choice (not every reward). */
	const chooseOne = $derived(!!(resolved?.chooseOne ?? reward.chooseOne) && cards.length > 1);
	/** The reward picked under `chooseOne` (its index on the card), or null. */
	let picked = $state<number | null>(null);
	function pick(card: RewardCard) {
		if (busy || !chooseOne) return;
		picked = card.index;
	}
	const pickedCard = $derived(chooseOne ? (cards.find((c) => c.index === picked) ?? null) : null);

	/** The defeated card's printed face (null: no image, the panel shows the title only). Its
	 *  printed rewards must be the ones listed here; Barrier/Damage are checked when the
	 *  catalog row is loaded. */
	const monsterArt = $derived.by(() => {
		const row = assets.monsterAssets.get(reward.monsterId);
		const face = monsterCardFace(
			{
				id: reward.monsterId,
				barrier: row?.barrier ?? null,
				damage: row?.damage ?? null,
				rewardTrack: reward.rewardTrack
			},
			row?.card_image_path
		);
		return face?.url ?? null;
	});

	/** Explicit rune pick per chooseRune reward — no default (S6 honesty). */
	let runeChoice = $state<Record<number, number>>({});

	function chooseRune(card: RewardCard, oi: number) {
		if (busy) return;
		runeChoice = { ...runeChoice, [card.index]: oi };
	}

	// Under `chooseOne` only the picked reward counts (and only its rune needs choosing).
	const earned = $derived(chooseOne ? (pickedCard ? [pickedCard] : []) : cards);
	const runeCards = $derived(earned.filter((c) => c.isChoice));
	const missingChoice = $derived(
		(chooseOne && !pickedCard) || runeCards.some((c) => runeChoice[c.index] === undefined)
	);
	/** The commit-bar slot is narrow: "2 VP", "Summon", "Fire". */
	function meterLabel(label: string): string {
		return label
			.replace(/Victory Points?/, 'VP')
			.replace(/^Arcane Abyss Summon$/, 'Summon')
			.replace(/ Rune$/, '');
	}
	const meter = $derived<MeterSlot[]>(
		(chooseOne && !pickedCard
			? [{ need: 'Choose one', needIcon: null, filled: null } as MeterSlot]
			: []
		).concat(
		earned.map((card) => ({
			need: card.isChoice ? 'Pick rune' : 'Reward',
			needIcon: null,
			filled:
				card.isChoice && runeChoice[card.index] === undefined
					? null
					: {
							label: meterLabel(
								card.isChoice
									? (card.chooseOptions[runeChoice[card.index]]?.name ?? card.label)
									: card.label
							),
							icon: card.icon
						}
		}))
		)
	);
	function confirm() {
		if (busy || count === 0 || missingChoice) return;
		// The engine grants every reward (or the one picked under `chooseOne`: `picks[0]`);
		// `choices` follow the earned rune rewards in card order.
		onClaim(
			earned.map((c) => c.index),
			runeCards.map((c) => runeChoice[c.index] ?? 0)
		);
	}
</script>

<TakeoverStage {accent} testid="monster-reward-menu">
	{#snippet source()}
		<SourcePanel
			title={displayName(reward.monsterName)}
			subtitle={chooseOne
				? `Defeated — choose 1 of its ${count} rewards`
				: `Defeated — you earn all ${count} reward${count === 1 ? '' : 's'}`}
			image={monsterArt}
			imageAlt={displayName(reward.monsterName)}
			{accent}
		>
			<span class="victory-chip">Victory</span>
		</SourcePanel>
	{/snippet}

	<p class="pick-hint" data-testid="reward-pick-count">
		{#if chooseOne}
			This kill gives one reward. Tap the one you want, then claim it.
		{:else if runeCards.length > 0}
			You earn every reward below. Pick {runeCards.length === 1 ? 'your rune' : 'a rune for each rune reward'}, then claim.
		{:else}
			You earn every reward below.
		{/if}
	</p>
	<div class="fan" data-testid="reward-grid">
		{#each cards as card, i (card.index)}
			<!-- A rune reward is earned too, but shows its check only once the rune is picked. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="medallion"
				class:choice={card.isChoice}
				class:pickable={chooseOne}
				class:selected={chooseOne
					? picked === card.index && (!card.isChoice || runeChoice[card.index] !== undefined)
					: !card.isChoice || runeChoice[card.index] !== undefined}
				class:awaiting={chooseOne
					? picked !== card.index || (card.isChoice && runeChoice[card.index] === undefined)
					: card.isChoice && runeChoice[card.index] === undefined}
				style="--i: {i}; --n: {cards.length};"
				data-testid={`reward-${card.index}`}
				role={chooseOne ? 'button' : undefined}
				tabindex={chooseOne ? 0 : undefined}
				aria-pressed={chooseOne ? picked === card.index : undefined}
				onclick={() => pick(card)}
				onkeydown={(event) => {
					if (chooseOne && (event.key === 'Enter' || event.key === ' ')) {
						event.preventDefault();
						pick(card);
					}
				}}
			>
				<span class="check" aria-hidden="true">✓</span>
				<span class="coin">
					{#if card.icon}
						<img src={card.icon} alt="" loading="lazy" />
					{:else}
						<span class="coin-fb" aria-hidden="true">✦</span>
					{/if}
				</span>
				<span class="medal-label">{card.label}</span>
				{#if card.isChoice && (!chooseOne || picked === card.index)}
					<div class="rune-chips open" role="group" aria-label="Choose a rune">
						{#each card.chooseOptions as opt, oi (opt.runeId + oi)}
							<button
								type="button"
								class="rune-chip"
								class:active={runeChoice[card.index] === oi}
								aria-pressed={runeChoice[card.index] === oi}
								disabled={busy}
								aria-label={opt.name}
								title={opt.name}
								onclick={() => chooseRune(card, oi)}
							>
								{#if opt.icon}<img src={opt.icon} alt="" />{/if}
								<!-- The medallion already says "rune": "Mountain", not "Mountain Rune". -->
								<span>{opt.name.replace(/ Rune$/, '')}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>

	{#snippet bar()}
		<CommitBar
			slots={meter}
			confirmLabel={count === 1 || chooseOne ? 'Claim reward' : `Claim all ${count} rewards`}
			confirmDisabled={count === 0 || missingChoice}
			confirmTestid="reward-claim"
			onConfirm={confirm}
			{busy}
			{accent}
		/>
	{/snippet}
</TakeoverStage>

<style>
	.medallion.pickable {
		cursor: pointer;
	}
	.medallion.pickable:focus-visible {
		outline: 2px solid var(--brand-cyan, #5cdfff);
		outline-offset: 4px;
		border-radius: 10px;
	}
	.victory-chip {
		padding: 0.22rem 0.7rem;
		border-radius: 999px;
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--brand-amber-soft, #ffd56a);
		border: 1px solid color-mix(in srgb, var(--brand-amber, #ffba3d) 55%, transparent);
		background: color-mix(in srgb, var(--brand-amber, #ffba3d) 12%, transparent);
		box-shadow: 0 0 14px color-mix(in srgb, var(--brand-amber, #ffba3d) 25%, transparent);
	}
	.pick-hint {
		margin: 0;
		font-size: clamp(0.78rem, 1.2vw, 0.92rem);
		color: var(--color-parchment, #d8cfee);
		text-align: center;
	}
	/* The loot fan: each medallion leans out from center and floats in staggered. */
	.fan {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: center;
		gap: clamp(0.4rem, 1.4vw, 0.9rem);
		width: 100%;
		min-width: 0;
	}
	.medallion {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.45rem;
		max-width: 11rem;
		padding: 0.9rem 0.5rem 0.5rem;
		border: 0;
		background: transparent;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		text-align: center;
		--lean: calc((var(--i) - (var(--n) - 1) / 2) * 2.2deg);
		transform: rotate(var(--lean));
		animation: medal-in 480ms cubic-bezier(0.22, 1, 0.36, 1) calc(var(--i) * 70ms) both;
		transition:
			transform 170ms cubic-bezier(0.22, 1, 0.36, 1),
			filter 170ms ease,
			opacity 170ms ease;
	}
	@keyframes medal-in {
		from {
			opacity: 0;
			transform: rotate(var(--lean)) translateY(26px) scale(0.82);
		}
		to {
			opacity: 1;
			transform: rotate(var(--lean)) translateY(0) scale(1);
		}
	}
	@media (hover: hover) and (pointer: fine) {
		.medallion:hover {
			transform: rotate(var(--lean)) translateY(-5px);
			filter: drop-shadow(0 0 16px color-mix(in srgb, var(--accent) 45%, transparent));
		}
	}
	.medallion.selected {
		transform: rotate(0deg) translateY(-6px) scale(1.04);
		filter: drop-shadow(0 0 20px color-mix(in srgb, var(--accent) 60%, transparent));
	}
	/* A rune reward waiting for its pick: earned, but the outline pulses until chosen. */
	.medallion.awaiting .coin {
		border-radius: 50%;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
		animation: await-pulse 1.6s ease-in-out infinite;
	}
	@keyframes await-pulse {
		50% {
			box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
		}
	}
	.coin {
		position: relative;
		width: clamp(4.6rem, 12vh, 7.5rem);
		height: clamp(4.6rem, 12vh, 7.5rem);
		display: grid;
		place-items: center;
	}
	.coin img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 12px 22px rgba(0, 0, 0, 0.55));
		transition: filter 170ms ease;
	}
	.medallion.selected .coin img {
		filter: drop-shadow(0 12px 22px rgba(0, 0, 0, 0.55))
			drop-shadow(0 0 18px color-mix(in srgb, var(--accent) 55%, transparent));
	}
	.coin-fb {
		font-size: 2rem;
		color: var(--color-fog, #8d8aa1);
	}
	.medal-label {
		max-width: 10rem;
		font-family: var(--font-display);
		font-size: clamp(0.72rem, 1.1vw, 0.9rem);
		letter-spacing: 0.04em;
		color: #fff;
		line-height: 1.2;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.65);
	}
	.check {
		position: absolute;
		top: 0.1rem;
		left: 50%;
		width: 1.4rem;
		height: 1.4rem;
		display: grid;
		place-items: center;
		transform: translateX(-50%);
		border-radius: 50%;
		font-family: var(--font-display);
		font-size: 0.82rem;
		color: var(--color-void, #0c0518);
		background: var(--accent);
		opacity: 0;
		box-shadow:
			0 0 0 2px rgba(8, 5, 16, 0.78),
			0 0 14px color-mix(in srgb, var(--accent) 64%, transparent);
		transition: opacity 120ms ease;
		z-index: 2;
	}
	.medallion.selected .check {
		opacity: 1;
	}
	/* Rune sub-chips live inside a rune reward; the player must pick one. */
	.rune-chips {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.3rem;
	}
	.rune-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 34px;
		padding: 0.24rem 0.55rem;
		border-radius: 999px;
		border: 1.5px solid rgba(255, 255, 255, 0.2);
		background: rgba(15, 10, 28, 0.6);
		color: var(--color-fog, #b9b4cc);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 130ms ease,
			background 130ms ease,
			color 130ms ease;
	}
	.rune-chip img {
		width: 1.15rem;
		height: 1.15rem;
		object-fit: contain;
	}
	.rune-chip:not(:disabled):hover {
		border-color: color-mix(in srgb, var(--accent) 55%, #fff 20%);
		color: #fff;
	}
	.rune-chip.active {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 26%, rgba(15, 10, 28, 0.6));
		color: #fff;
		box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.rune-chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.medallion {
			padding: 0.6rem 0.3rem 0.3rem;
			gap: 0.25rem;
		}
		.coin {
			width: clamp(2.4rem, 11vh, 3rem);
			height: clamp(2.4rem, 11vh, 3rem);
		}
		.medal-label {
			font-size: 0.62rem;
		}
		.rune-chip {
			min-height: 30px;
			font-size: 0.66rem;
		}
		/* Phone landscape is short: put a rune reward's chips beside its coin, not under
		   it, so the picks stay on screen without scrolling. */
		/* The center column is ~340px wide here, so the medallions wrap: lead with the
		   one that needs input so its chips are never the part pushed off screen. */
		.medallion.choice {
			order: -1;
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			grid-template-areas: 'coin label' 'coin chips';
			align-items: center;
			column-gap: 0.4rem;
			max-width: 20rem;
			text-align: left;
		}
		.medallion.choice .coin {
			grid-area: coin;
		}
		.medallion.choice .medal-label {
			grid-area: label;
		}
		.medallion.choice .rune-chips {
			grid-area: chips;
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.medallion.choice .check {
			left: 1.7rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.medallion,
		.medallion.awaiting .coin {
			animation: none;
			transition: none;
		}
	}
</style>
