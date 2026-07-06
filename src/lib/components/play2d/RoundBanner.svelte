<script lang="ts">
	import type { GamePhase } from '$lib/play/types';
	import { GAME_PHASES, NAVIGATION_SECONDS } from '$lib/play/types';
	import { PHASE_LABELS } from '$lib/play/viewV2';

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

	// All six REAL engine phases, matching the desktop PhaseBar — the banner shows
	// only the CURRENT phase and the one that follows it (wrapping cleanup → next
	// round's navigation) so it never runs off a narrow screen, but the label is
	// always the true phase (Benefits/Awakening no longer read as "Cleanup").
	const visibleSteps = $derived.by(() => {
		const idx = Math.max(0, GAME_PHASES.indexOf(phase));
		const next = (idx + 1) % GAME_PHASES.length;
		return [
			{ key: GAME_PHASES[idx], label: PHASE_LABELS[GAME_PHASES[idx]], active: true },
			{ key: GAME_PHASES[next], label: PHASE_LABELS[GAME_PHASES[next]], active: false }
		];
	});

	// ── Countdown ────────────────────────────────────────────────────────────
	let now = $state(Date.now());
	let fired = $state(false);

	$effect(() => {
		void navigationDeadline; // re-arm whenever a fresh deadline begins
		fired = false;
		if (navigationDeadline == null) return;
		const id = setInterval(() => (now = Date.now()), 200);
		return () => clearInterval(id);
	});

	const remainingMs = $derived(
		navigationDeadline == null ? 0 : Math.max(0, navigationDeadline - now)
	);
	const seconds = $derived(Math.ceil(remainingMs / 1000));
	const pct = $derived(
		navigationDeadline == null
			? 0
			: Math.max(0, Math.min(100, (remainingMs / (NAVIGATION_SECONDS * 1000)) * 100))
	);
	const showTimer = $derived(
		phase === 'navigation' && !revealedDestinations && navigationDeadline != null
	);
	const urgent = $derived(showTimer && seconds <= 10);

	$effect(() => {
		if (navigationDeadline != null && remainingMs <= 0 && !fired) {
			fired = true;
			onNavExpire?.();
		}
	});
</script>

<div
	class="banner"
	data-testid="round-banner"
	data-phase={phase}
	data-round={round}
	class:urgent
	class:timing={showTimer}
>
	<div class="head">
		<span class="eyebrow">Round</span>
		<span class="num" data-testid="round-num">{round}</span>
	</div>

	<span class="divider"></span>

	<!-- Phase stepper: current → next only (keeps the banner on-screen) -->
	<ol class="steps">
		{#each visibleSteps as step (step.key)}
			<li class:active={step.active}>
				<span class="node"></span>
				<span class="label">{step.label}</span>
			</li>
		{/each}
	</ol>

	{#if showTimer}
		<span class="divider"></span>
		<span class="secs" data-testid="nav-timer-secs">{seconds}s</span>
		<!-- Time remaining = a depleting white hairline along the base. -->
		<div class="timeline" data-testid="nav-timer"><i style="width: {pct}%"></i></div>
	{/if}
</div>

<style>
	/* A light glass strip fused to the top edge, outlined by a single white
	   hairline. Minimal — no glow, no chrome — but wide enough to read as a
	   primary HUD element. */
	.banner {
		position: absolute;
		top: 0;
		left: 50%;
		transform: translateX(-50%);
		z-index: 22;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		width: max-content;
		max-width: min(520px, 94vw);
		min-height: 44px;
		padding: 6px 14px 8px;
		pointer-events: none;
		background: linear-gradient(180deg, rgba(10, 7, 20, 0.64), rgba(8, 5, 16, 0.44));
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-top: 0;
		border-radius: 0 0 14px 14px;
		box-shadow: 0 14px 34px -16px rgba(0, 0, 0, 0.7);
		animation: drop 520ms cubic-bezier(0.22, 1.2, 0.36, 1) both;
	}

	/* ── Round ─────────────────────────────────────────────────────────────── */
	.head {
		display: flex;
		align-items: baseline;
		gap: 9px;
		flex-shrink: 0;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.5);
	}
	.num {
		font-family: var(--font-display);
		font-size: 1.05rem;
		line-height: 1;
		color: #fff;
		font-variant-numeric: tabular-nums;
	}

	.divider {
		width: 1px;
		height: 16px;
		flex-shrink: 0;
		background: rgba(255, 255, 255, 0.18);
	}

	/* ── Phase stepper (white thin-line) ─────────────────────────────────────── */
	.steps {
		display: flex;
		align-items: center;
		gap: 7px;
		list-style: none;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.steps li {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.38);
		transition:
			color 200ms ease,
			opacity 200ms ease;
	}
	/* Thin hairline connector between steps. */
	.steps li:not(:last-child)::after {
		content: '';
		width: 10px;
		height: 1px;
		background: rgba(255, 255, 255, 0.16);
	}
	.node {
		width: 6px;
		height: 6px;
		transform: rotate(45deg);
		border: 1px solid rgba(255, 255, 255, 0.4);
		background: transparent;
		transition:
			background 200ms ease,
			border-color 200ms ease,
			box-shadow 200ms ease;
	}
	/* Active phase: bright white, filled glowing node. */
	.steps li.active {
		color: #fff;
	}
	.steps li.active .node {
		background: #fff;
		border-color: transparent;
		box-shadow: 0 0 10px rgba(255, 255, 255, 0.75);
	}

	/* ── Countdown ───────────────────────────────────────────────────────────── */
	.secs {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.04em;
		color: rgba(255, 255, 255, 0.72);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.banner.urgent .secs {
		color: #ff8a8a;
	}
	.timeline {
		position: absolute;
		left: 50%;
		bottom: 2px;
		transform: translateX(-50%);
		width: 240px;
		max-width: 70%;
		height: 1.5px;
		display: flex;
		justify-content: center;
	}
	.timeline i {
		height: 100%;
		border-radius: 2px;
		background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.9), transparent);
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.6);
		transition: width 200ms linear;
	}
	.banner.urgent .timeline i {
		background: linear-gradient(90deg, transparent, var(--color-blood, #ff4d6d), transparent);
		box-shadow: 0 0 7px rgba(255, 77, 109, 0.7);
	}
	.banner.urgent {
		border-color: rgba(255, 77, 109, 0.4);
		animation:
			drop 520ms cubic-bezier(0.22, 1.2, 0.36, 1) both,
			throb 0.9s ease-in-out infinite;
	}

	@keyframes drop {
		from {
			transform: translate(-50%, -100%);
			opacity: 0;
		}
		to {
			transform: translate(-50%, 0);
			opacity: 1;
		}
	}
	@keyframes throb {
		0%,
		100% {
			border-color: rgba(255, 77, 109, 0.3);
		}
		50% {
			border-color: rgba(255, 77, 109, 0.65);
		}
	}

	/* ── Mobile (≤600px): shrink the backdrop blur to a cheap radius and raise the
	   solid base opacity so the HUD strip reads without the GPU cost. ── */
	@media (max-width: 600px) {
		.banner {
			background: linear-gradient(180deg, rgba(10, 7, 20, 0.86), rgba(8, 5, 16, 0.74));
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
			box-shadow: 0 8px 20px -12px rgba(0, 0, 0, 0.7);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.banner,
		.banner.urgent {
			animation: none;
		}
		.timeline i {
			transition: none;
		}
		/* This banner spans most of the viewport width; dropping its backdrop-filter
		   removes the most expensive composite on low-end devices. */
		.banner {
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
			background: linear-gradient(180deg, rgba(10, 7, 20, 0.95), rgba(8, 5, 16, 0.9));
		}
	}
</style>
