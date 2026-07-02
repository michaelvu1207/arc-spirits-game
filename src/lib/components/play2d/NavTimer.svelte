<script lang="ts">
	import { NAVIGATION_SECONDS } from '$lib/play/types';

	interface Props {
		/** Epoch ms when the navigation countdown expires, or null when inactive. */
		deadline: number | null;
		/** Fired once when the countdown reaches zero. */
		onExpire?: () => void;
	}

	let { deadline, onExpire }: Props = $props();

	let now = $state(Date.now());
	let fired = $state(false);

	$effect(() => {
		// Reset the one-shot guard whenever a new deadline begins.
		void deadline;
		fired = false;
		if (deadline == null) return;
		const tick = () => {
			now = Date.now();
		};
		// Background tabs throttle setInterval, so the clock is stale on resume —
		// snap it to real time immediately when the tab becomes visible again.
		const onVisible = () => {
			if (document.visibilityState === 'visible') tick();
		};
		const id = setInterval(tick, 200);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(id);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	const remainingMs = $derived(deadline == null ? 0 : Math.max(0, deadline - now));
	const seconds = $derived(Math.ceil(remainingMs / 1000));
	const clock = $derived(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
	const pct = $derived(
		deadline == null
			? 0
			: Math.max(0, Math.min(100, (remainingMs / (NAVIGATION_SECONDS * 1000)) * 100))
	);

	$effect(() => {
		if (deadline != null && remainingMs <= 0 && !fired) {
			fired = true;
			onExpire?.();
		}
	});
</script>

{#if deadline != null}
	<div class="nav-timer" data-testid="nav-timer" class:urgent={seconds <= 10}>
		<span class="label">Time remaining</span>
		<div class="bar"><div class="fill" style="width: {pct}%"></div></div>
		<span class="secs" data-testid="nav-timer-secs">{clock}</span>
	</div>
{/if}

<style>
	.nav-timer {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		min-width: 0;
	}
	.label {
		flex-shrink: 0;
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.5);
	}
	/* Time remaining = a depleting white hairline, not a chunky cyan bar. */
	.bar {
		flex: 1;
		min-width: 0;
		height: 1.5px;
		background: rgba(255, 255, 255, 0.14);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: rgba(255, 255, 255, 0.85);
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.5);
		transition: width 200ms linear;
	}
	.urgent .fill {
		background: var(--color-blood, #ff4d6d);
		box-shadow: 0 0 7px rgba(255, 77, 109, 0.7);
	}
	.secs {
		flex-shrink: 0;
		font-family: var(--font-display);
		font-size: 1.05rem;
		line-height: 1;
		letter-spacing: 0.06em;
		color: rgba(255, 255, 255, 0.72);
		font-variant-numeric: tabular-nums;
		min-width: 3.2rem;
		text-align: right;
	}
	.urgent .secs {
		color: #ff8a8a;
	}
</style>
