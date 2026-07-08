<script lang="ts">
	/**
	 * W2d — the Encounter (group PvP) decision as a stage takeover: co-located
	 * targets as large guardian-portrait cards, Attack/Hold in the commit bar, and
	 * the "every Evil player here must agree" state shown as per-seat vote chips.
	 */
	import type { SeatColor } from '$lib/play/types';
	import TakeoverStage from './takeover/TakeoverStage.svelte';
	import CommitBar from './takeover/CommitBar.svelte';

	interface EncounterTarget {
		seat: SeatColor;
		name: string;
		accent: string;
		art: string | null;
	}
	interface EncounterVoter {
		seat: SeatColor;
		name: string;
		accent: string;
		voted: boolean;
		isMe: boolean;
	}

	interface Props {
		targets: EncounterTarget[];
		voters: EncounterVoter[];
		myVote: 'attack' | 'decline' | null;
		busy?: boolean;
		onAttack: () => void;
		onHold: () => void;
	}

	let { targets, voters, myVote, busy = false, onAttack, onHold }: Props = $props();

	const voted = $derived(myVote === 'attack');
	const needsAllies = $derived(voters.length > 1);
</script>

<TakeoverStage accent="var(--color-blood, #e05858)" testid="encounter-stage">
	<p class="enc-sub">
		Attack the Good players here for +2 VP, +2 more per player you corrupt.
		{#if needsAllies}Every Evil player at this location must agree.{/if}
	</p>
	<div class="targets" data-testid="encounter-targets">
		{#each targets as target (target.seat)}
			<div class="target-card" style="--c: {target.accent}">
				<span class="frame">
					{#if target.art}
						<img src={target.art} alt={target.name} loading="lazy" />
					{:else}
						<span class="frame-fb" aria-hidden="true">✦</span>
					{/if}
				</span>
				<span class="t-name">{target.name}</span>
				<span class="t-tag">Good · here</span>
			</div>
		{/each}
	</div>
	{#if needsAllies || voted}
		<div class="votes" role="group" aria-label="Evil players who must agree">
			{#each voters as voter (voter.seat)}
				<span class="vote-chip" class:cast={voter.voted} style="--c: {voter.accent}">
					<span class="vote-mark" aria-hidden="true">{voter.voted ? '✓' : '·'}</span>
					{voter.isMe ? 'You' : voter.name}
					<span class="vote-state"
						>{voter.voted ? (voter.isMe ? 'attack' : 'attacks') : 'deciding…'}</span
					>
				</span>
			{/each}
		</div>
	{/if}

	{#snippet bar()}
		<CommitBar
			summary={voted
				? 'You voted to attack — waiting for your allies.'
				: `Strike ${targets.length === 1 ? 'this player' : 'these players'} together?`}
			confirmLabel="Attack together"
			confirmDisabled={voted}
			confirmTestid="encounter-attack"
			onConfirm={onAttack}
			onCancel={voted ? null : onHold}
			cancelLabel="Hold"
			cancelTestid="encounter-hold"
			{busy}
			accent="var(--color-blood, #e05858)"
		/>
	{/snippet}
</TakeoverStage>

<style>
	.enc-sub {
		margin: 0;
		font-size: clamp(0.9rem, 1.5vw, 1.1rem);
		color: var(--color-parchment, #d8d2e8);
		text-align: center;
		max-width: 34rem;
		line-height: 1.5;
	}
	.targets {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: clamp(0.7rem, 2vw, 1.2rem);
	}
	.target-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		animation: target-in 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
	}
	@keyframes target-in {
		from {
			opacity: 0;
			transform: translateY(12px) scale(0.94);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	/* Guardian portrait in a seat-colored frame — the encounter-target chip grown
	   into a real character card. */
	.frame {
		position: relative;
		width: clamp(5.4rem, 14vh, 8rem);
		height: clamp(5.4rem, 14vh, 8rem);
		display: grid;
		place-items: center;
		border-radius: 16px;
		overflow: hidden;
		background: color-mix(in srgb, var(--c) 12%, rgba(10, 7, 24, 0.6));
		box-shadow:
			inset 0 0 0 2px color-mix(in srgb, var(--c) 75%, transparent),
			0 12px 30px rgba(0, 0, 0, 0.5),
			0 0 18px color-mix(in srgb, var(--c) 25%, transparent);
	}
	.frame img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.frame-fb {
		font-size: 1.8rem;
		color: color-mix(in srgb, var(--c) 60%, #fff 30%);
	}
	.t-name {
		font-family: var(--font-display);
		font-size: clamp(0.78rem, 1.3vw, 0.95rem);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #fff;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
	}
	.t-tag {
		font-family: var(--font-display);
		font-size: 0.56rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		padding: 0.16rem 0.5rem;
		border-radius: 999px;
		color: color-mix(in srgb, var(--c) 55%, #fff 45%);
		border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
	}
	.votes {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.45rem;
	}
	.vote-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.7rem;
		border-radius: 999px;
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #fff;
		border: 1px solid color-mix(in srgb, var(--c) 55%, transparent);
		background: color-mix(in srgb, var(--c) 12%, rgba(10, 7, 24, 0.6));
	}
	.vote-mark {
		display: grid;
		place-items: center;
		width: 1.05rem;
		height: 1.05rem;
		border-radius: 50%;
		font-size: 0.66rem;
		color: var(--color-fog, #b9b4cc);
		box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.25);
	}
	.vote-chip.cast .vote-mark {
		background: var(--color-blood, #e05858);
		color: #fff;
		box-shadow: none;
	}
	.vote-state {
		color: var(--color-fog, #b9b4cc);
		letter-spacing: 0.06em;
	}
	.vote-chip.cast .vote-state {
		color: color-mix(in srgb, var(--color-blood, #e05858) 45%, #fff 55%);
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.enc-sub {
			font-size: 0.78rem;
			line-height: 1.3;
			max-width: 26rem;
		}
		.frame {
			width: clamp(3.6rem, 22vh, 5rem);
			height: clamp(3.6rem, 22vh, 5rem);
			border-radius: 12px;
		}
		.t-name {
			font-size: 0.68rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.target-card {
			animation: none;
		}
	}
</style>
