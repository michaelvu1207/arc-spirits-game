<script lang="ts">
	/**
	 * W2d — Infiltrator dice swap as a stage takeover (plans/ux-overhaul.md §4.2):
	 * dice are physical tier-colored gem tokens in two facing rows per opponent,
	 * an animated swap arrow lights between the chosen pair, and the commit bar
	 * stages everything until Confirm.
	 */
	import type { AttackDie, SeatColor } from '$lib/play/types';
	import TakeoverStage from './takeover/TakeoverStage.svelte';
	import SourcePanel from './takeover/SourcePanel.svelte';
	import CommitBar from './takeover/CommitBar.svelte';
	import DieGem, { TIER_LABEL } from './takeover/DieGem.svelte';
	import type { MeterSlot } from './takeover/types';

	interface SwapTarget {
		seat: SeatColor;
		name: string;
		accent: string;
		dice: AttackDie[];
	}

	interface Props {
		targets: SwapTarget[];
		myDice: AttackDie[];
		classIcon?: string | null;
		busy?: boolean;
		onConfirm: (
			swaps: { targetSeat: SeatColor; myInstanceId: string; theirInstanceId: string }[]
		) => void;
		onCancel: () => void;
	}

	let { targets, myDice, classIcon = null, busy = false, onConfirm, onCancel }: Props = $props();

	let pick = $state<Record<string, { mine?: string; theirs?: string }>>({});

	function mineUsedElsewhere(seat: SeatColor, instanceId: string): boolean {
		return Object.entries(pick).some(([s, p]) => s !== seat && p.mine === instanceId);
	}
	function setMine(seat: SeatColor, instanceId: string) {
		const cur = pick[seat] ?? {};
		pick = { ...pick, [seat]: { ...cur, mine: cur.mine === instanceId ? undefined : instanceId } };
	}
	function setTheirs(seat: SeatColor, instanceId: string) {
		const cur = pick[seat] ?? {};
		pick = {
			...pick,
			[seat]: { ...cur, theirs: cur.theirs === instanceId ? undefined : instanceId }
		};
	}

	const swaps = $derived(
		targets
			.map((t) => ({
				targetSeat: t.seat,
				myInstanceId: pick[t.seat]?.mine,
				theirInstanceId: pick[t.seat]?.theirs
			}))
			.filter((s): s is { targetSeat: SeatColor; myInstanceId: string; theirInstanceId: string } =>
				Boolean(s.myInstanceId && s.theirInstanceId)
			)
	);

	function tierOf(dice: AttackDie[], instanceId: string | undefined): string {
		const die = dice.find((d) => d.instanceId === instanceId);
		return die ? TIER_LABEL[die.tier] : '?';
	}
	// One meter slot per opponent: it fills when that pair is fully chosen. The
	// label stays compact (tier⇄tier) so the slot's ellipsis never eats it.
	const meter = $derived<MeterSlot[]>(
		targets.map((t) => {
			const p = pick[t.seat];
			const complete = !!(p?.mine && p?.theirs);
			return {
				need: t.name,
				needIcon: null,
				filled: complete
					? { label: `${tierOf(t.dice, p!.theirs)}⇄${tierOf(myDice, p!.mine)}`, icon: null }
					: null
			};
		})
	);

	function confirm() {
		if (busy || swaps.length === 0) return;
		onConfirm(swaps);
		pick = {};
	}
	function cancel() {
		pick = {};
		onCancel();
	}
</script>

<TakeoverStage
	accent="var(--brand-violet, #5a2bff)"
	testid="infiltrator-swap"
	onEscape={busy ? null : cancel}
>
	{#snippet source()}
		<SourcePanel
			title="Infiltrator"
			subtitle="Swap one attack die with each player here — take one of theirs, give one of yours."
			image={classIcon}
			imageAlt="Infiltrator"
			accent="var(--brand-violet, #5a2bff)"
		/>
	{/snippet}

	<div class="swap-lanes">
		{#each targets as t (t.seat)}
			{@const p = pick[t.seat] ?? {}}
			{@const paired = !!(p.mine && p.theirs)}
			<section class="lane" style="--seat: {t.accent}" data-testid={`infil-lane-${t.seat}`}>
				<header class="lane-head">
					<span class="seat-dot" aria-hidden="true"></span>
					<span class="lane-name">{t.name}</span>
					{#if paired}<span class="lane-state done">Pair chosen</span>{:else}
						<span class="lane-state">Pick a pair</span>{/if}
				</header>
				<div class="lane-rows">
					<div class="dice-line">
						<span class="line-tag">Take</span>
						<div class="dice" class:hasPick={!!p.theirs}>
							{#each t.dice as die (die.instanceId)}
								<DieGem
									tier={die.tier}
									selected={p.theirs === die.instanceId}
									disabled={busy}
									testid={`infil-theirs-${t.seat}-${die.instanceId}`}
									onClick={() => setTheirs(t.seat, die.instanceId)}
								/>
							{/each}
						</div>
					</div>
					<div class="swap-mark" class:live={paired} aria-hidden="true">
						<svg viewBox="0 0 24 24" width="18" height="18">
							<path
								d="M7 4 L7 16 M3.5 12.5 L7 16.5 L10.5 12.5 M17 20 L17 8 M13.5 11.5 L17 7.5 L20.5 11.5"
								fill="none"
								stroke="currentColor"
								stroke-width="2.2"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</div>
					<div class="dice-line">
						<span class="line-tag">Give</span>
						<div class="dice" class:hasPick={!!p.mine}>
							{#if myDice.length === 0}
								<span class="none-note">No attack dice</span>
							{/if}
							{#each myDice as die (die.instanceId)}
								<DieGem
									tier={die.tier}
									selected={p.mine === die.instanceId}
									disabled={busy}
									locked={mineUsedElsewhere(t.seat, die.instanceId)}
									reason="Given to another player"
									testid={`infil-mine-${t.seat}-${die.instanceId}`}
									onClick={() => setMine(t.seat, die.instanceId)}
								/>
							{/each}
						</div>
					</div>
				</div>
			</section>
		{/each}
	</div>

	{#snippet bar()}
		<CommitBar
			slots={meter}
			confirmLabel={`Swap ${swaps.length} ${swaps.length === 1 ? 'die' : 'dice'}`}
			confirmDisabled={swaps.length === 0}
			confirmTestid="infil-confirm"
			onConfirm={confirm}
			onCancel={cancel}
			{busy}
			accent="var(--brand-violet, #5a2bff)"
		/>
	{/snippet}
</TakeoverStage>

<style>
	.swap-lanes {
		display: flex;
		flex-direction: column;
		gap: clamp(0.5rem, 1.6vh, 0.9rem);
		width: min(760px, 100%);
	}
	.lane {
		box-sizing: border-box;
		width: 100%;
		padding: clamp(0.55rem, 1.4vh, 0.85rem) clamp(0.7rem, 1.8vw, 1rem);
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--seat) 40%, rgba(255, 255, 255, 0.08));
		background: color-mix(in srgb, var(--seat) 6%, rgba(15, 10, 28, 0.45));
	}
	.lane-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.45rem;
	}
	.seat-dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
		background: var(--seat);
		box-shadow: 0 0 8px color-mix(in srgb, var(--seat) 70%, transparent);
	}
	.lane-name {
		font-family: var(--font-display);
		font-size: clamp(0.78rem, 1.3vw, 0.95rem);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--seat);
	}
	.lane-state {
		margin-left: auto;
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-fog, #a49fc0);
	}
	.lane-state.done {
		color: var(--brand-teal, #20e0c1);
	}
	/* Two facing rows with the swap glyph between: theirs above, mine below. */
	.lane-rows {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: 'take mark' 'give mark';
		align-items: center;
		column-gap: 0.6rem;
		row-gap: 0.15rem;
	}
	.dice-line {
		display: grid;
		grid-template-columns: 2.9rem minmax(0, 1fr);
		align-items: center;
		gap: 0.5rem;
	}
	.dice-line:first-child {
		grid-area: take;
	}
	.dice-line:last-child {
		grid-area: give;
	}
	.line-tag {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.68);
		text-align: right;
	}
	.dice {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.15rem;
	}
	.dice.hasPick :global(.die:not(.selected):not(.locked)) {
		opacity: 0.5;
	}
	.none-note {
		font-size: 0.78rem;
		color: var(--brand-amber-soft, #ffd56a);
	}
	.swap-mark {
		grid-area: mark;
		display: grid;
		place-items: center;
		width: 2.1rem;
		height: 2.1rem;
		border-radius: 50%;
		color: rgba(255, 255, 255, 0.28);
		box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.14);
		transition:
			color 180ms ease,
			box-shadow 180ms ease;
	}
	.swap-mark.live {
		color: var(--brand-teal, #20e0c1);
		box-shadow:
			inset 0 0 0 1.5px color-mix(in srgb, var(--brand-teal, #20e0c1) 70%, transparent),
			0 0 14px color-mix(in srgb, var(--brand-teal, #20e0c1) 35%, transparent);
	}
	.swap-mark.live svg {
		animation: swap-bob 1.4s ease-in-out infinite;
	}
	@keyframes swap-bob {
		0%,
		100% {
			transform: translateY(-1px);
		}
		50% {
			transform: translateY(2px);
		}
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.lane {
			padding: 0.4rem 0.55rem;
			border-radius: 10px;
		}
		.lane-head {
			margin-bottom: 0.2rem;
		}
		.dice-line {
			grid-template-columns: 2.1rem minmax(0, 1fr);
			gap: 0.35rem;
		}
		.swap-mark {
			width: 1.6rem;
			height: 1.6rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.swap-mark.live svg {
			animation: none;
		}
	}
</style>
