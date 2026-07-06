<script lang="ts">
	/**
	 * W2a — the loot moment (plans/ux-overhaul.md §4.2). The reward track becomes
	 * large medallion cards fanned across the stage; picks stage into the commit
	 * bar's meter and nothing is claimed until Confirm. `chooseRune` rewards expand
	 * rune sub-chips inside the selected card and demand an explicit pick — no
	 * silent option-0 default.
	 *
	 * Data: the engine's RESOLVED reward options (§5.3, `SeatAffordances.pendingReward`)
	 * — labelled, claimable, server-computed. The client never re-runs
	 * `buildMonsterRewards` on raw icon ids (that call died with this takeover).
	 */
	import type { PendingRewardState } from '$lib/play/types';
	import type { ResolvedPendingReward } from '$lib/play/viewV2';
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import { displayName, storageUrl } from './helpers';
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
		return storageUrl(assets.iconPool.get(id)?.file_path ?? null);
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
	const max = $derived(Math.min(resolved?.chooseAmount ?? reward.chooseAmount, cards.length));

	const monsterArt = $derived.by(() => {
		const byId = assets.monsterAssets.get(reward.monsterId);
		const found =
			byId ??
			Array.from(assets.monsterAssets.values()).find(
				(m) => m.name?.toLowerCase() === reward.monsterName.toLowerCase()
			);
		return storageUrl(found?.card_image_path ?? null);
	});

	/** Picks in tap order (drives the meter fill left-to-right). */
	let picked = $state<number[]>([]);
	/** Explicit rune pick per chooseRune card — no default (S6 honesty). */
	let runeChoice = $state<Record<number, number>>({});
	const atMax = $derived(picked.length >= max);

	function isPicked(index: number): boolean {
		return picked.includes(index);
	}
	function toggle(card: RewardCard) {
		if (busy) return;
		if (isPicked(card.index)) {
			picked = picked.filter((i) => i !== card.index);
		} else if (!atMax) {
			picked = [...picked, card.index];
		}
	}
	function chooseRune(card: RewardCard, oi: number) {
		if (busy) return;
		runeChoice = { ...runeChoice, [card.index]: oi };
		if (!isPicked(card.index) && !atMax) picked = [...picked, card.index];
	}

	const byIndex = $derived(new Map(cards.map((c) => [c.index, c])));
	const missingChoice = $derived(
		picked.some((i) => byIndex.get(i)?.isChoice && runeChoice[i] === undefined)
	);
	const meter = $derived<MeterSlot[]>(
		Array.from({ length: max }, (_, i) => {
			const card = picked[i] !== undefined ? byIndex.get(picked[i]) : null;
			return {
				need: 'Reward',
				needIcon: null,
				filled: card ? { label: card.label, icon: card.icon } : null
			};
		})
	);
	function confirm() {
		if (busy || picked.length !== max || missingChoice) return;
		const choices: number[] = [];
		for (const idx of picked) {
			const card = byIndex.get(idx);
			if (card?.isChoice) choices.push(runeChoice[idx] ?? 0);
		}
		onClaim([...picked], choices);
	}

	// Drop stale picks if the pool changes out from under the selection.
	$effect(() => {
		const valid = new Set(cards.map((c) => c.index));
		if (picked.some((i) => !valid.has(i))) picked = picked.filter((i) => valid.has(i));
	});
</script>

<TakeoverStage {accent} testid="monster-reward-menu">
	{#snippet source()}
		<SourcePanel
			title={displayName(reward.monsterName)}
			subtitle={`Defeated — claim ${max} reward${max === 1 ? '' : 's'}`}
			image={monsterArt}
			imageAlt={displayName(reward.monsterName)}
			{accent}
		>
			<span class="victory-chip">Victory</span>
		</SourcePanel>
	{/snippet}

	<p class="pick-hint" data-testid="reward-pick-count">
		Choose {max} — {picked.length} picked
	</p>
	<div class="fan" data-testid="reward-grid">
		{#each cards as card, i (card.index)}
			{@const chosen = isPicked(card.index)}
			{@const limit = atMax && !chosen}
			<div
				class="medallion"
				class:selected={chosen}
				class:limit
				style="--i: {i}; --n: {cards.length};"
				role="button"
				tabindex={busy || limit ? -1 : 0}
				aria-pressed={chosen}
				data-testid={`reward-${card.index}`}
				onclick={() => !limit && toggle(card)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						if (!limit) toggle(card);
					}
				}}
			>
				<span class="check" aria-hidden="true">✓</span>
				{#if limit}<span class="limit-chip">Pick limit</span>{/if}
				<span class="coin">
					{#if card.icon}
						<img src={card.icon} alt="" loading="lazy" />
					{:else}
						<span class="coin-fb" aria-hidden="true">✦</span>
					{/if}
				</span>
				<span class="medal-label">{card.label}</span>
				{#if card.isChoice && (chosen || !limit)}
					<div class="rune-chips" class:open={chosen} role="group" aria-label="Choose a rune">
						{#each card.chooseOptions as opt, oi (opt.runeId + oi)}
							<button
								type="button"
								class="rune-chip"
								class:active={chosen && runeChoice[card.index] === oi}
								disabled={busy || limit}
								onclick={(e) => {
									e.stopPropagation();
									chooseRune(card, oi);
								}}
							>
								{#if opt.icon}<img src={opt.icon} alt="" />{/if}
								<span>{opt.name}</span>
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
			warning={missingChoice ? 'Pick a rune for your reward' : null}
			confirmLabel={`Claim ${picked.length}/${max} reward${max === 1 ? '' : 's'}`}
			confirmDisabled={picked.length !== max || missingChoice}
			confirmTestid="reward-claim"
			onConfirm={confirm}
			{busy}
			{accent}
		/>
	{/snippet}
</TakeoverStage>

<style>
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
		cursor: pointer;
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
		.medallion:not(.limit):hover {
			transform: rotate(var(--lean)) translateY(-5px);
			filter: drop-shadow(0 0 16px color-mix(in srgb, var(--accent) 45%, transparent));
		}
	}
	.medallion.selected {
		transform: rotate(0deg) translateY(-6px) scale(1.04);
		filter: drop-shadow(0 0 20px color-mix(in srgb, var(--accent) 60%, transparent));
	}
	.medallion.limit {
		cursor: not-allowed;
		opacity: 0.38;
	}
	.medallion:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 12px;
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
	.limit-chip {
		position: absolute;
		top: 38%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 3;
		padding: 0.26rem 0.55rem;
		border-radius: 8px;
		background: rgba(10, 6, 20, 0.95);
		border: 1px solid rgba(255, 255, 255, 0.25);
		color: var(--color-fog, #b9b4cc);
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		white-space: nowrap;
	}
	/* Rune sub-chips live inside the card; they light up once the card is chosen. */
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
		font-size: 0.6rem;
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
			width: clamp(3rem, 18vh, 4.4rem);
			height: clamp(3rem, 18vh, 4.4rem);
		}
		.medal-label {
			font-size: 0.62rem;
		}
		.rune-chip {
			min-height: 28px;
			font-size: 0.54rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.medallion {
			animation: none;
			transition: none;
		}
	}
</style>
