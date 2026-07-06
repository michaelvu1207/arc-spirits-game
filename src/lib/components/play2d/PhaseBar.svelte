<script lang="ts">
	import type { GamePhase } from '$lib/play/types';
	import { GAME_PHASES } from '$lib/play/types';
	import { PHASE_LABELS } from '$lib/play/viewV2';
	import NavTimer from './NavTimer.svelte';

	interface Props {
		phase: GamePhase;
		round: number;
		revealedDestinations: boolean;
		/** Epoch ms the navigation countdown expires (null outside navigation). */
		navigationDeadline?: number | null;
		/** Fired once when the navigation countdown hits zero. */
		onNavExpire?: () => void;
	}

	let {
		phase,
		round,
		revealedDestinations,
		navigationDeadline = null,
		onNavExpire
	}: Props = $props();

	const showTimer = $derived(
		phase === 'navigation' && !revealedDestinations && navigationDeadline != null
	);

	// One node per engine phase — all six, so the lit node is always the REAL phase
	// (Benefits/Awakening no longer hide under a collapsed "Cleanup" group). MainStage
	// owns the per-phase instruction and action content.
	const currentIndex = $derived(GAME_PHASES.indexOf(phase));

	// Small status shown in the second row of the bar. MainStage owns instruction copy;
	// this bar stays as phase/timer chrome so it never competes with the scene prompt.
	const PHASE_STATUS: Record<GamePhase, string> = {
		navigation: 'Navigation open',
		encounter: 'Encounter step',
		location: 'Location step',
		benefits: 'Benefits step',
		awakening: 'Awakening step',
		cleanup: 'Cleanup step'
	};
	const phaseStatus = $derived(PHASE_STATUS[phase] ?? '');
</script>

<div class="phase-bar" data-testid="phase-bar" data-phase={phase} data-round={round}>
	<div class="round">
		<span class="round-eyebrow">Round</span>
		<span class="round-num" data-testid="round-num">{round}</span>
	</div>
	<span class="divider"></span>
	<div class="middle">
		<ol class="steps">
			{#each GAME_PHASES as p, i (p)}
				<li class:active={p === phase} class:done={currentIndex > i}>
					<span class="node"></span>
					<span class="step-label">{PHASE_LABELS[p]}</span>
				</li>
			{/each}
		</ol>
		<!-- Status row — always present so the bar keeps one consistent layout:
		     the live countdown during navigation, a static status otherwise. -->
		<div class="instruction-row">
			{#if showTimer}
				<NavTimer deadline={navigationDeadline} onExpire={onNavExpire} />
			{:else}
				<span class="instruction" data-testid="phase-instruction">{phaseStatus}</span>
			{/if}
		</div>
	</div>
</div>

<style>
	/* A light glass strip fused to the top edge, outlined by a single white
	   hairline — the same ethereal treatment as the mobile RoundBanner and the
	   leaderboard/menu chrome. No violet border, no chunky fills. */
	.phase-bar {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		padding: 0.5rem 1.4rem 0.6rem;
		background: linear-gradient(180deg, rgba(10, 7, 20, 0.64), rgba(8, 5, 16, 0.44));
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-top: 0;
		border-radius: 0 0 14px 14px;
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}
	.round {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		line-height: 1;
		flex-shrink: 0;
	}
	.round-eyebrow {
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.5);
	}
	.round-num {
		font-family: var(--font-display);
		font-size: 1.5rem;
		line-height: 0.9;
		color: #fff;
		font-variant-numeric: tabular-nums;
	}
	/* Thin vertical hairline between segments — dividers, not boxes. */
	.divider {
		width: 1px;
		align-self: stretch;
		margin: 0.15rem 0;
		flex-shrink: 0;
		background: rgba(255, 255, 255, 0.18);
	}
	.middle {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		flex: 1;
		min-width: 0;
		justify-content: center;
	}
	/* Always-present second row — reserves the NavTimer's height so the bar's
	   layout stays identical whether or not the countdown is showing. */
	.instruction-row {
		display: flex;
		align-items: center;
		min-height: 1.05rem;
		min-width: 0;
	}
	/* Static per-phase status — matches the NavTimer's label treatment. */
	.instruction {
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.5);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Six steps on ONE row, always — the type is sized so all six labels fit the
	   desktop bar; narrower screens collapse inactive labels instead of wrapping. */
	.steps {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		list-style: none;
		margin: 0;
		padding: 0;
		min-width: 0;
		flex-wrap: nowrap;
	}
	.steps li {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-family: var(--font-display);
		font-size: 0.88rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		white-space: nowrap;
		color: rgba(255, 255, 255, 0.38);
		transition:
			color 200ms ease,
			opacity 200ms ease;
	}
	/* Thin hairline connector trailing each step (except the last). */
	.steps li:not(:last-child)::after {
		content: '';
		width: 10px;
		height: 1px;
		background: rgba(255, 255, 255, 0.16);
	}
	/* Completed phases read slightly brighter than the pending ones. */
	.steps li.done {
		color: rgba(255, 255, 255, 0.6);
	}
	/* Small diamond node — hollow hairline by default. */
	.node {
		width: 7px;
		height: 7px;
		transform: rotate(45deg);
		border: 1px solid rgba(255, 255, 255, 0.4);
		background: transparent;
		transition:
			background 200ms ease,
			border-color 200ms ease,
			box-shadow 200ms ease;
	}
	/* Active phase: bright white, filled glowing node — ethereal, not a chip. */
	.steps li.active {
		color: #fff;
	}
	.steps li.active .node {
		background: #fff;
		border-color: transparent;
		box-shadow: 0 0 10px rgba(255, 255, 255, 0.75);
	}
	/* ── Mid widths (tablet / phone-landscape, where the full bar still shows):
	   six labelled steps don't fit, so inactive steps collapse to their nodes and
	   only the CURRENT phase keeps its label — same language, denser. ── */
	@media (max-width: 1149px) {
		.steps {
			gap: 0.55rem;
		}
		.steps li:not(.active) .step-label {
			display: none;
		}
		.steps li:not(:last-child)::after {
			width: 8px;
		}
	}

	/* ── Mobile (≤600px): trim the backdrop blur and lean on a more opaque base
	   so the bar stays legible without the GPU cost of a wide blur. ── */
	@media (max-width: 600px) {
		.phase-bar {
			background: linear-gradient(180deg, rgba(10, 7, 20, 0.86), rgba(8, 5, 16, 0.74));
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
		}
	}

	/* Reduced-motion / coarse-pointer: drop the backdrop-filter outright. */
	@media (prefers-reduced-motion: reduce) {
		.phase-bar {
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
			background: linear-gradient(180deg, rgba(10, 7, 20, 0.95), rgba(8, 5, 16, 0.9));
		}
	}
</style>
