<script lang="ts">
	import { untrack } from 'svelte';
	import { playSfx } from '$lib/stores/gameAudio.svelte';
	import { mergeCombatLog } from '$lib/play/combatLog';
	import type { CombatState, SeatColor } from '$lib/play/types';
	import { displayName } from './helpers';
	import LowPolySpiritStage from '$lib/components/LowPolySpiritStage.svelte';
	import { pulseHaptic } from '$lib/stores/accessibilitySettings.svelte';

	interface Props {
		combats: CombatState[];
		mySeat: SeatColor | null;
	}

	let { combats, mySeat }: Props = $props();

	// Match a combat I'm part of. Monster fights have a single side (me); group
	// Encounter (PvP) fights list every participant, so check all sides — not just [0].
	const myCombat = $derived(
		mySeat ? (combats.find((c) => c.sides.some((s) => s.seat === mySeat)) ?? null) : null
	);
	const combatId = $derived(myCombat?.id ?? null);
	// Collapse consecutive same-source buff lines into one summed sentence (cosmetic).
	const lines = $derived(mergeCombatLog(myCombat?.log ?? []));
	const corruptionMoment = $derived(lines.some((line) => /corrupt/i.test(line)));

	type LineKind = 'upgrade' | 'ward' | 'gain' | 'strike' | 'harm' | 'cost' | 'neutral';

	/**
	 * Classify a combat-log line into one of seven flavours so each reads (and
	 * sounds) distinct. Order matters — the most specific cues are tested first:
	 *  • ward     — protection / immunity / damage you avoided ("cannot be stunned")
	 *  • upgrade  — your power grows (dice upgraded, +combat damage, potential…)
	 *  • harm     — damage taken, corruption, losses
	 *  • strike   — you deal damage / a monster falls
	 *  • gain     — resources, VP, healing, loot
	 *  • cost     — discards / payments / sacrifices
	 *  • neutral  — system prompts and no-ops
	 */
	function lineKind(line: string): LineKind {
		const l = line.toLowerCase();
		if (/(cannot be stunned|deflect|reduced incoming damage|damage is halved|protected you from corruption)/.test(l))
			return 'ward';
		if (/(upgraded|combat damage|gained \d+ potential|gained \+|initiative|extra .* action|augment|are doubled|redraw|gained [^.]*attack dice)/.test(l))
			return 'upgrade';
		if (/(attacks for|were corrupted|cannot strike back|flipped [^.]*arcane blood|barrier lost|^corrupted)/.test(l))
			return 'harm';
		if (/(you roll [^.]*damage|defeated|horde is exhausted)/.test(l)) return 'strike';
		if (/(gained|restored|purified|cultivated|\brested\b|victory point|\bvp\b|claim)/.test(l)) return 'gain';
		if (/(discarded|\bpaid\b|you are evil)/.test(l)) return 'cost';
		return 'neutral';
	}

	/** The one-shot SFX to fire as a line begins revealing (null = silent). */
	function sfxForLine(line: string): string | null {
		const l = line.toLowerCase();
		switch (lineKind(line)) {
			case 'upgrade':
				return 'combat-upgrade';
			case 'ward':
				return 'combat-ward';
			case 'strike':
				return /defeated/.test(l) ? 'combat-defeat' : 'combat-strike';
			case 'harm':
				return /corrupt/.test(l) ? 'combat-corrupt' : 'combat-attack';
			case 'gain':
				return 'combat-gain';
			case 'cost':
				return 'combat-cost';
			default:
				return null;
		}
	}

	// ── Typewriter reveal (line by line, character by character) ───────────────
	let lineIdx = $state(0); // line currently typing
	let charIdx = $state(0); // characters revealed in that line

	function reducedMotion(): boolean {
		return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	}

	$effect(() => {
		const id = combatId; // sole tracked dependency → restart only on a NEW combat
		if (!id) return;
		pulseHaptic('impact');
		// Walk the SAME merged lines the template renders, so the reveal stays aligned.
		const log = untrack(() => mergeCombatLog(myCombat?.log ?? []));
		lineIdx = 0;
		charIdx = 0;
		if (typeof window === 'undefined' || reducedMotion()) {
			lineIdx = log.length; // show everything at once
			return;
		}
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		// Crawl pace — the attack log reveals at 3× the previous speed.
		const CHAR_MS = 24;
		const LINE_PAUSE_MS = 420;
		function step() {
			if (cancelled || lineIdx >= log.length) return;
			const cur = log[lineIdx] ?? '';
			// Fire this line's impact sound the instant it begins revealing.
			if (charIdx === 0 && cur) {
				const sfx = sfxForLine(cur);
				if (sfx) playSfx(sfx);
			}
			if (charIdx < cur.length) {
				charIdx += 1;
				timer = setTimeout(step, CHAR_MS);
			} else {
				lineIdx += 1;
				charIdx = 0;
				if (lineIdx < log.length) timer = setTimeout(step, LINE_PAUSE_MS);
			}
		}
		timer = setTimeout(step, 260); // a short beat before the crawl begins
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});
</script>

{#if myCombat}
	<section class="combat" class:killed={myCombat.killed} data-testid="combat-overlay">
		<div class="vignette" aria-hidden="true"></div>
		{#if corruptionMoment}<div class="corruption-spirit"><LowPolySpiritStage moment="corruption" guardianName="Corrupted Spirit" accent="#ff5b6e" compact /></div>{/if}
		<header class="head">
			<span class="eyebrow">{myCombat.kind === 'pvp' ? 'Encounter' : 'Combat'}</span>
			{#if myCombat.killed}<span class="badge">Monster slain</span>{/if}
		</header>
		{#if myCombat.monster}
			<div class="verdict">
				{displayName(myCombat.monster.name)} — {myCombat.killed
					? 'Defeated!'
					: 'Not enough damage to defeat it'}
			</div>
		{/if}
		<ol class="log">
			{#each lines as line, i (i)}
				<li class={lineKind(line)} class:done={i < lineIdx} class:typing={i === lineIdx} class:pending={i > lineIdx}>
					{#if i < lineIdx}
						{line}
					{:else if i === lineIdx}
						{line.slice(0, charIdx)}<span class="cursor" aria-hidden="true"></span>
					{:else}
						<span class="ghost">{line}</span>
					{/if}
				</li>
			{/each}
		</ol>
	</section>
{/if}

<style>
	.combat {
		position: relative;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		width: 100%;
		max-width: 100vw;
		/* fallback for older browsers, then dvh so iOS Safari toolbar doesn't clip */
		max-height: 100vh;
		max-height: 100dvh;
		padding: 1.5rem 1.75rem 1.7rem;
		border-radius: 12px;
		border: 1px solid var(--brand-magenta, #ff2bc7);
		background:
			radial-gradient(120% 90% at 50% 0%, rgba(70, 8, 40, 0.7), transparent 70%),
			linear-gradient(180deg, rgba(24, 6, 18, 0.92), rgba(8, 4, 14, 0.96));
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), inset 0 0 40px rgba(255, 43, 199, 0.08);
		animation: combat-in 360ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
		box-sizing: border-box;
	}
	.combat.killed {
		border-color: var(--brand-amber, #ffba3d);
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), inset 0 0 40px rgba(255, 186, 61, 0.1);
	}
	/* A drifting vignette/scanline for the dramatic "screen" feel. */
	.vignette {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			radial-gradient(140% 120% at 50% 50%, transparent 55%, rgba(0, 0, 0, 0.55) 100%),
			repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 3px);
		mix-blend-mode: overlay;
	}
	.corruption-spirit { position:absolute; right:-28px; top:-44px; width:240px; height:220px; opacity:.32; pointer-events:none; }
	.head,.verdict,.log{position:relative;z-index:1}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.32em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft, #ff7fd9);
		text-shadow: 0 0 12px rgba(255, 43, 199, 0.6);
	}
	.badge {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-void, #0c0518);
		background: var(--brand-amber, #ffba3d);
		padding: 3px 10px;
		border-radius: 999px;
		box-shadow: 0 0 16px rgba(255, 186, 61, 0.6);
	}
	.verdict {
		font-family: var(--font-display);
		font-size: clamp(1.2rem, 2vw, 1.6rem);
		letter-spacing: 0.03em;
		color: #fff;
		text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7);
	}
	/* The log "crawls" — a subtle backward tilt sells the dramatic reveal. */
	.log {
		list-style: none;
		margin: 0.2rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		transform: perspective(1400px) rotateX(7deg);
		transform-origin: 50% 100%;
	}
	.log li {
		position: relative;
		padding-left: 1.6em; /* room for the per-kind marker; text hangs past it */
		font-size: clamp(1rem, 1.5vw, 1.2rem);
		line-height: 1.45;
		letter-spacing: 0.01em;
		color: var(--color-parchment, #e7e0cf);
		min-height: 1.45em; /* reserve height so revealing lines don't shift layout */
		transition: color 200ms ease;
	}
	.log li.pending .ghost {
		visibility: hidden;
	}
	/* Each kind carries a glyph marker hanging in the left gutter. */
	.log li::before {
		position: absolute;
		left: 0;
		top: 0.04em;
		font-size: 0.9em;
		font-weight: 700;
		opacity: 0.95;
		transition: opacity 200ms ease;
	}
	.log li.pending::before {
		opacity: 0; /* don't preview markers for lines not yet revealed */
	}

	/* Upgrade — your power grows (dice upgraded, +combat damage, potential…):
	   electric cyan, bold, with a rising pop as it lands. */
	.log li.upgrade {
		color: #7df0ff;
		font-weight: 700;
		text-shadow: 0 0 14px rgba(60, 210, 255, 0.6);
	}
	.log li.upgrade::before {
		content: '▲';
		color: #4fd6ff;
		text-shadow: 0 0 10px rgba(80, 220, 255, 0.9);
	}
	.log li.upgrade.typing,
	.log li.upgrade.done {
		animation: upgrade-pop 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
	}

	/* Ward — protection / immunity ("cannot be stunned"): calm teal, a steadily
	   pulsing sigil. Reassuring, not loud. */
	.log li.ward {
		color: #5ff0d6;
		font-weight: 600;
		text-shadow: 0 0 12px rgba(47, 224, 193, 0.55);
	}
	.log li.ward::before {
		content: '◈';
		color: #2fe0c1;
		text-shadow: 0 0 10px rgba(47, 224, 193, 0.9);
		animation: ward-pulse 2s ease-in-out infinite;
	}

	/* Gain — resources / VP / healing / loot: warm amber, a soft sparkle. */
	.log li.gain {
		color: var(--brand-amber-soft, #ffd56a);
		text-shadow: 0 0 12px rgba(255, 186, 61, 0.5);
	}
	.log li.gain::before {
		content: '✦';
		color: var(--brand-amber, #ffba3d);
		text-shadow: 0 0 10px rgba(255, 186, 61, 0.85);
	}

	/* Strike — you deal damage / a monster falls: bright gold-white, a quick flash. */
	.log li.strike {
		color: #fff7e6;
		font-weight: 700;
		letter-spacing: 0.02em;
		text-shadow: 0 0 14px rgba(255, 214, 120, 0.7);
	}
	.log li.strike::before {
		content: '➤';
		color: var(--brand-amber, #ffba3d);
	}
	.log li.strike.typing,
	.log li.strike.done {
		animation: strike-flash 0.42s ease-out both;
	}

	/* Harm — damage taken, corruption, losses: red, glowing, and shaking. */
	.log li.harm {
		color: #ff5a5a;
		font-weight: 600;
		text-shadow: 0 0 12px rgba(255, 50, 50, 0.7);
		animation: harm-shake 0.45s ease-in-out infinite;
	}
	.log li.harm::before {
		content: '✕';
		color: #ff5a5a;
	}

	/* Cost — discards / payments / sacrifices: dim, italic, receding. */
	.log li.cost {
		color: #b69ddf;
		opacity: 0.82;
		font-style: italic;
	}
	.log li.cost::before {
		content: '−';
		color: #8f78c4;
		font-style: normal;
	}

	/* Neutral — system prompts and no-ops: quiet, marker-less. */
	.log li.neutral {
		color: var(--color-fog, #b9b2cf);
		opacity: 0.9;
	}
	.log li.neutral::before {
		content: '·';
		color: var(--color-whisper, #6a5d8a);
	}
	.cursor {
		display: inline-block;
		width: 0.5em;
		height: 1.05em;
		margin-left: 2px;
		vertical-align: -0.16em;
		background: currentColor;
		box-shadow: 0 0 10px currentColor;
		animation: cursor-blink 0.7s steps(1) infinite;
	}

	@keyframes combat-in {
		from {
			opacity: 0;
			transform: translateY(14px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	@keyframes harm-shake {
		0%, 100% { transform: translate(0, 0); }
		20% { transform: translate(-1.6px, 0.6px); }
		40% { transform: translate(1.6px, -0.6px); }
		60% { transform: translate(-1.1px, 1px); }
		80% { transform: translate(1.1px, -1px); }
	}
	/* Upgrade lands with a confident lift + brighten. */
	@keyframes upgrade-pop {
		0% { transform: translateY(6px) scale(0.97); filter: brightness(0.8); }
		55% { transform: translateY(-2px) scale(1.03); filter: brightness(1.5); }
		100% { transform: translateY(0) scale(1); filter: brightness(1); }
	}
	/* Ward sigil breathes. */
	@keyframes ward-pulse {
		0%, 100% { opacity: 0.7; transform: scale(1); }
		50% { opacity: 1; transform: scale(1.18); }
	}
	/* Strike snaps in with a hot flash. */
	@keyframes strike-flash {
		0% { transform: translateX(-6px); filter: brightness(2.2); text-shadow: 0 0 22px rgba(255, 220, 140, 0.95); }
		100% { transform: translateX(0); filter: brightness(1); }
	}
	@keyframes cursor-blink {
		50% { opacity: 0; }
	}
	@media (prefers-reduced-motion: reduce) {
		.combat {
			animation: none;
		}
		.log {
			transform: none;
		}
		.log li.harm,
		.log li.upgrade,
		.log li.upgrade.typing,
		.log li.upgrade.done,
		.log li.strike,
		.log li.strike.typing,
		.log li.strike.done,
		.log li.ward::before {
			animation: none;
		}
		.cursor {
			animation: none;
		}
	}

	/* ── Mobile layout (phones ≤600px) ─────────────────────────────────────── */
	@media (max-width: 600px) {
		.combat {
			padding: 1rem 1.1rem 1.1rem;
			border-radius: 8px;
			gap: 0.5rem;
			/* Allow internal scroll if combat log is very long. */
			overflow-y: auto;
			/* Bottom safe area so content isn't behind iPhone home bar. */
			padding-bottom: calc(1.1rem + env(safe-area-inset-bottom));
		}

		.verdict {
			font-size: clamp(1rem, 4vw, 1.3rem);
		}

		.log {
			/* Flatten the perspective tilt on small screens — not enough depth to sell it. */
			transform: none;
			gap: 0.4rem;
		}

		.log li {
			font-size: clamp(0.88rem, 3.5vw, 1rem);
			padding-left: 1.4em;
		}

		.badge {
			font-size: 0.8rem;
			padding: 2px 8px;
		}
	}
</style>
