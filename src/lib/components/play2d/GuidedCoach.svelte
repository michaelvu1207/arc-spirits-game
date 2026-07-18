<script lang="ts">
	import { onMount } from 'svelte';
	import type { GamePhase } from '$lib/play/types';

	interface Props {
		phase: GamePhase;
		mode?: 'casual' | 'ranked';
		pendingKind?: string | null;
		lockedDestination?: string | null;
	}

	let { phase, mode = 'casual', pendingKind = null, lockedDestination = null }: Props = $props();
	const KEY = 'arc-spirits-guided-journey-v1';
	const PHASES: GamePhase[] = ['navigation', 'encounter', 'location', 'benefits', 'awakening', 'cleanup'];
	let mounted = $state(false);
	let completed = $state(false);
	let seen = $state<string[]>([]);
	let previous = $state<GamePhase | null>(null);

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { completed?: boolean; seen?: string[] };
			completed = saved.completed === true;
			seen = Array.isArray(saved.seen) ? saved.seen.filter((value) => PHASES.includes(value as GamePhase)) : [];
		} catch { /* a blocked storage area keeps guidance session-local */ }
		mounted = true;
	});

	function save(done = completed) {
		completed = done;
		try { localStorage.setItem(KEY, JSON.stringify({ version: 1, completed, seen })); } catch { /* optional */ }
	}

	$effect(() => {
		if (!mounted || completed || !PHASES.includes(phase)) return;
		if (previous && previous !== phase && !seen.includes(previous)) {
			seen = [...seen, previous];
			save();
		}
		previous = phase;
	});

	const visible = $derived(mounted && !completed && PHASES.includes(phase) && !seen.includes(phase));
	const rankedRulesOnly = $derived(mode === 'ranked');
	const copy = $derived.by(() => {
		if (rankedRulesOnly) {
			return {
				title: 'Rules & legality',
				recommendation: 'Use the highlighted legal controls; strategic recommendations are disabled in ranked play.',
				why: 'Ranked guidance explains only rules, legality, and deterministic consequences.',
				certain: `Certain: the server will validate the ${phase} command before it changes the room.`,
				uncertain: 'Uncertain: other players’ future choices and random draws.'
			};
		}
		if (pendingKind === 'draw') return {
			title: 'Resolve your summon', recommendation: 'Inspect the drawn spirits, stage only the summons you want, then explicitly return the rest.',
			why: 'The open draw is a real obligation; ending the Location phase stays blocked until every card is resolved.',
			certain: 'Certain: staged summons show their listed cost; Return Unchosen sends the rest back without summoning them.',
			uncertain: 'Uncertain: what a redraw or later bag draw will reveal.'
		};
		if (pendingKind === 'reward') return {
			title: 'Claim the recorded reward', recommendation: 'Stage every required reward and rune sub-choice, inspect the summary, then claim.',
			why: 'The server will not choose a required reward for you.',
			certain: 'Certain: the claim preview lists the exact selected reward indexes.',
			uncertain: 'Uncertain: downstream draws or future opponents’ choices.'
		};
		switch (phase) {
			case 'navigation': return {
				title: 'Choose your path', recommendation: lockedDestination ? `Inspect ${lockedDestination}; unlock it if you want another destination.` : 'Inspect the visible reward rows, then lock one destination.',
				why: 'Your destination determines the Location actions available after the table reveals.',
				certain: lockedDestination ? `Certain: ${lockedDestination} is staged for this round and remains undoable until reveal.` : 'Certain: a lock records the chosen destination and exposes an Unlock control.',
				uncertain: 'Uncertain: which destination another player will lock before reveal.'
			};
			case 'encounter': return {
				title: 'Read the table', recommendation: 'Inspect legal targets and allies before choosing Attack or Hold.',
				why: 'The group encounter resolves from the recorded votes and legal target set.',
				certain: 'Certain: the button label states the vote you are committing.',
				uncertain: 'Uncertain: unresolved dice and other players’ votes.'
			};
			case 'location': return {
				title: 'Use the location', recommendation: 'Inspect an affordable visible action; staged trades can be cancelled before confirmation.',
				why: 'Location actions are the main way to build spirits, resources, and scoring opportunities.',
				certain: 'Certain: costs and immediate gains shown in the confirmation are deterministic.',
				uncertain: 'Uncertain: bag draws, dice, and later choices.'
			};
			case 'benefits': return {
				title: 'Claim class benefits', recommendation: 'Review every grant and fill each required row before confirming.',
				why: 'Choice benefits stay staged so you can undo them before the authoritative claim.',
				certain: 'Certain: the staged summary is the payload the server will validate.',
				uncertain: 'Uncertain: future draws and opponents’ builds.'
			};
			case 'awakening': return {
				title: 'Awaken deliberately', recommendation: 'Inspect the requirement, stage payment, preview the exact discard references, then confirm or cancel.',
				why: 'Awakening reveals class expression but spends recorded resources.',
				certain: 'Certain: the payment preview names every resource that will be spent.',
				uncertain: 'Uncertain: how the awakened build will interact with future choices.'
			};
			default: return {
				title: 'Clean up explicitly', recommendation: 'Resolve overflow and corruption choices, then end the round.',
				why: 'Cleanup finalizes the round’s board and score history.',
				certain: 'Certain: every staged discard can be untoggled before confirmation.',
				uncertain: 'Uncertain: the next round’s public options and draws.'
			};
		}
	});

	function retireCurrent() {
		if (!seen.includes(phase)) seen = [...seen, phase];
		save(seen.length >= PHASES.length);
	}
</script>

{#if visible}
	<aside class="coach" aria-live="polite" data-testid="guided-coach">
		<div class="coach-head"><span>First journey · {seen.length + 1}/{PHASES.length}</span><button type="button" onclick={() => save(true)}>End guide</button></div>
		<h2>{copy.title}</h2>
		<p class="recommend">{copy.recommendation}</p>
		<details>
			<summary>Why this?</summary>
			<p>{copy.why}</p>
			<p class="certain">{copy.certain}</p>
			<p class="uncertain">{copy.uncertain}</p>
		</details>
		<button type="button" class="got-it" onclick={retireCurrent}>Got it</button>
	</aside>
{/if}

<style>
	.coach { position: absolute; left: max(16px, env(safe-area-inset-left)); bottom: max(92px, calc(env(safe-area-inset-bottom) + 76px)); z-index: 46; width: min(390px, calc(100vw - 32px)); box-sizing: border-box; padding: 14px; border-radius: 16px; color: #f5f0ff; background: rgba(9, 4, 25, .96); border: 1px solid rgba(123,29,255,.8); box-shadow: 0 16px 44px rgba(0,0,0,.5); pointer-events: auto; }
	.coach-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; color: #65f3e1; font: 700 .66rem/1 var(--font-display); letter-spacing: .13em; text-transform: uppercase; }
	.coach-head button, .got-it { min-height: 44px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14); color: white; background: rgba(255,255,255,.06); padding: 0 12px; }
	h2 { margin: .55rem 0 .35rem; font: 400 1.15rem/1.1 var(--font-display); text-transform: uppercase; }
	p { margin: .35rem 0; font-size: .78rem; line-height: 1.42; color: #d8cfee; }
	.recommend { color: #fff; }
	details { margin-top: .45rem; }
	summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: #ffcb70; font-size: .75rem; }
	.certain { color: #8df2c4; } .uncertain { color: #c8bfd8; }
	.got-it { width: 100%; margin-top: .6rem; background: linear-gradient(90deg, #6d22d4, #a620b8); font-family: var(--font-display); text-transform: uppercase; }
	@media (prefers-reduced-motion: reduce) { .coach { transition: none; } }
</style>
