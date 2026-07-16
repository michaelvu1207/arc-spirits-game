<script lang="ts">
	import type { PageData } from './$types';
	import LowPolySpiritStage from '$lib/components/LowPolySpiritStage.svelte';
	import { buildReplayHighlightSvg } from '$lib/replay/highlight';

	let { data }: { data: PageData } = $props();
	const replay = data.replay;
	type Card = {
		playerColor: string; name: string; guardian: string; destination: string;
		victoryPoints: number; barrier: number; statusLevel: number; spirits: Record<string, unknown>[];
	};
	const rounds = $derived([...new Set([
		...replay.frames.map((row) => row.round),
		...replay.snapshots.map((row) => row.navigation_count)
	])].sort((a, b) => a - b));
	let selectedRevision = $state(replay.frames[0]?.revision ?? 0);
	let legacyRound = $state(rounds[0] ?? 0);
	let copied = $state(false);
	let highlightReady = $state(false);
	const activeFrame = $derived(replay.frames.find((row) => row.revision === selectedRevision) ?? replay.frames[0] ?? null);
	const selectedRound = $derived(activeFrame?.round ?? legacyRound);
	const frameIndex = $derived(Math.max(0, replay.frames.findIndex((row) => row.revision === selectedRevision)));
	const cards = $derived.by((): Card[] => {
		if (activeFrame) {
			const players = activeFrame.public_state.players;
			if (!players || typeof players !== 'object') return [];
			return Object.entries(players as Record<string, unknown>).flatMap(([playerColor, raw]) => {
				if (!raw || typeof raw !== 'object') return [];
				const player = raw as Record<string, unknown>;
				return [{
					playerColor,
					name: String(player.displayName ?? playerColor),
					guardian: String(player.selectedGuardian ?? 'Unknown Guardian'),
					destination: String(player.navigationDestination ?? 'Destination hidden'),
					victoryPoints: Number(player.victoryPoints ?? 0),
					barrier: Number(player.barrier ?? 0),
					statusLevel: Number(player.statusLevel ?? 0),
					spirits: Array.isArray(player.spirits) ? player.spirits as Record<string, unknown>[] : []
				}];
			});
		}
		return replay.snapshots.filter((row) => row.navigation_count === legacyRound).map((player) => ({
			playerColor: player.player_color,
			name: player.tts_username || player.player_color,
			guardian: player.selected_character || 'Unknown Guardian',
			destination: player.navigation_destination || 'Destination hidden',
			victoryPoints: player.victory_points ?? 0,
			barrier: player.barrier ?? 0,
			statusLevel: player.status_level ?? 0,
			spirits: player.spirits as Record<string, unknown>[]
		}));
	});
	const pivotal = $derived(new Set(replay.pivotalRounds.filter((p) =>
		'revision' in p ? p.revision === selectedRevision : p.round === selectedRound
	).map((p) => p.playerColor)));

	function move(delta: number) {
		if (replay.frames.length > 0) {
			selectedRevision = replay.frames[Math.max(0, Math.min(replay.frames.length - 1, frameIndex + delta))]?.revision ?? selectedRevision;
			return;
		}
		const index = Math.max(0, rounds.indexOf(legacyRound));
		legacyRound = rounds[Math.max(0, Math.min(rounds.length - 1, index + delta))] ?? legacyRound;
	}

	function jumpMoment(moment: { round: number; revision?: number }) {
		if (moment.revision != null) selectedRevision = moment.revision;
		else legacyRound = moment.round;
	}

	async function copyLink() {
		await navigator.clipboard.writeText(window.location.href);
		copied = true;
		setTimeout(() => (copied = false), 1800);
	}

	async function exportHighlight() {
		const moment = replay.pivotalRounds.find((row) =>
			'revision' in row ? row.revision === selectedRevision : row.round === selectedRound
		) ?? replay.pivotalRounds[0] ?? { playerColor: cards[0]?.playerColor ?? 'Player', round: selectedRound, gain: 0 };
		const card = cards.find((row) => row.playerColor === moment.playerColor) ?? cards[0];
		const svg = buildReplayHighlightSvg({
			title: replay.title || 'Shared Match', guardian: card?.guardian ?? 'Arc Spirit',
			playerColor: moment.playerColor, round: moment.round, gain: moment.gain,
			accent: '#66f2df'
		});
		const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
		const file = new File([blob], `arc-spirits-${replay.code}-highlight.svg`, { type: blob.type });
		if (navigator.share && navigator.canShare?.({ files: [file] })) {
			await navigator.share({ title: `${replay.title || 'Arc Spirits'} highlight`, files: [file] });
		} else {
			const href = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = href;
			anchor.download = file.name;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(href), 0);
		}
		highlightReady = true;
		setTimeout(() => (highlightReady = false), 1800);
	}
</script>

<svelte:head>
	<title>{replay.title || 'Shared Match'} · Arc Spirits</title>
	<meta name="description" content="A privacy-safe Arc Spirits match replay." />
</svelte:head>

<main class="replay-shell" data-testid="replay-viewer">
	<header>
		<div>
			<span class="eyebrow">Deterministic public replay</span>
			<h1>{replay.title || 'Shared Match'}</h1>
			<p>{replay.mode === 'command-revision' ? 'Every authoritative public command boundary' : 'Legacy round-by-round public board state'}. Hands, draw order, scenario secrets, and private prompts are never included.</p>
		</div>
		<div class="replay-spirit"><LowPolySpiritStage moment="replay" guardianName={cards[0]?.guardian ?? 'Replay Spirit'} accent="#66f2df" compact /></div>
		<div class="share-actions"><button type="button" onclick={copyLink} data-testid="replay-copy">{copied ? 'Link copied' : 'Copy replay link'}</button><button type="button" onclick={exportHighlight} data-testid="replay-highlight-export">{highlightReady ? 'Highlight ready' : 'Share animated highlight'}</button></div>
	</header>

	<nav class="timeline" aria-label="Replay timeline">
		<button type="button" onclick={() => move(-1)} disabled={replay.frames.length ? frameIndex === 0 : selectedRound === rounds[0]} aria-label="Previous replay step">←</button>
		{#if replay.frames.length > 0}
			<label class="scrubber">
				<span>Revision {selectedRevision} · {activeFrame?.phase} · step {frameIndex + 1} of {replay.frames.length}</span>
				<input type="range" min="0" max={Math.max(0, replay.frames.length - 1)} value={frameIndex}
					oninput={(event) => (selectedRevision = replay.frames[Number(event.currentTarget.value)]?.revision ?? selectedRevision)}
					data-testid="replay-revision-scrubber" aria-label="Replay command revision" />
			</label>
		{:else}
			<div class="ticks">
				{#each rounds as round}
					<button type="button" class:active={round === selectedRound} class:pivot={replay.pivotalRounds.some((p) => p.round === round)}
						onclick={() => (legacyRound = round)} aria-current={round === selectedRound ? 'step' : undefined}
						data-testid={`replay-round-${round}`}>{round}</button>
				{/each}
			</div>
		{/if}
		<button type="button" onclick={() => move(1)} disabled={replay.frames.length ? frameIndex === replay.frames.length - 1 : selectedRound === rounds.at(-1)} aria-label="Next replay step">→</button>
	</nav>

	<section class="round-head" aria-live="polite">
		<div><span>Round</span><strong>{selectedRound}</strong></div>
		<div class="pivots">
			{#each replay.pivotalRounds as moment}
				<button type="button" onclick={() => jumpMoment(moment)}>
					{moment.playerColor} pivotal round {moment.round}{'revision' in moment ? ` · revision ${moment.revision}` : ''} · +{moment.gain} VP
				</button>
			{/each}
		</div>
	</section>

	<section class="players" aria-label={`Round ${selectedRound} board state`}>
		{#each cards as player (player.playerColor)}
			<article class:pivotal={pivotal.has(player.playerColor)} style={`--seat:${player.playerColor}`}>
				<div class="spirit-core" aria-hidden="true"><i></i><i></i><i></i></div>
				<div class="identity">
					<span>{player.playerColor}</span>
					<h2>{player.name}</h2>
					<p>{player.guardian} · {player.destination}</p>
				</div>
				<div class="stats">
					<strong>{player.victoryPoints}<small>VP</small></strong>
					<strong>{player.barrier}<small>Barrier</small></strong>
					<strong>{player.statusLevel}<small>Status</small></strong>
				</div>
				<div class="spirits" aria-label="Spirit board">
					{#each player.spirits as spirit, index}
						<span class:down={spirit?.isFaceDown === true} title={spirit?.isFaceDown === true ? 'Face-down spirit' : String(spirit?.name ?? 'Spirit')}>
							{spirit?.isFaceDown === true ? '◆' : String(spirit?.name ?? index + 1).slice(0, 2)}
						</span>
					{/each}
				</div>
				{#if pivotal.has(player.playerColor)}<b class="moment">Pivotal public VP gain</b>{/if}
			</article>
		{/each}
	</section>

	<footer>
		<span>Replay {replay.code}</span>
		<a href="/play">Play Arc Spirits</a>
	</footer>
</main>

<style>
	:global(body) { margin: 0; background: #070411; color: #fff; }
	.replay-shell { min-height: 100vh; box-sizing: border-box; padding: clamp(1rem, 4vw, 3rem); font-family: system-ui, sans-serif; background: radial-gradient(circle at 15% 0%, #26104a 0, transparent 42%), radial-gradient(circle at 90% 10%, #0f4b54 0, transparent 35%), #070411; }
	header { display: flex; justify-content: space-between; align-items: start; gap: 1.5rem; max-width: 1180px; margin: 0 auto 1.5rem; }
	header div { max-width: 760px; }
	.replay-spirit { width:190px; height:120px; flex:0 0 190px; overflow:hidden; }
	.eyebrow { color: #66f2df; letter-spacing: .2em; text-transform: uppercase; font-size: .72rem; font-weight: 800; }
	h1 { margin: .35rem 0; font-size: clamp(2rem, 6vw, 4.8rem); line-height: .92; text-transform: uppercase; }
	header p { color: #c8bed8; line-height: 1.5; }
	.share-actions { display:grid; gap:.5rem; min-width:220px; }
	button, a { min-height: 44px; border-radius: 999px; border: 1px solid #7656a8; background: #1b1031; color: #fff; padding: .65rem 1rem; font-weight: 750; cursor: pointer; }
	button:focus-visible, a:focus-visible { outline: 3px solid #66f2df; outline-offset: 2px; }
	button:disabled { opacity: .38; cursor: default; }
	.timeline { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: auto 1fr auto; gap: .7rem; align-items: center; }
	.ticks { display: flex; gap: .35rem; overflow-x: auto; padding: .4rem 0; }
	.ticks button { min-width: 44px; padding: .45rem; }
	.ticks button.active { background: #8050e8; border-color: #c8a8ff; transform: translateY(-2px); }
	.ticks button.pivot::after { content: ''; display: block; width: 6px; height: 6px; margin: 3px auto -2px; border-radius: 50%; background: #66f2df; }
	.scrubber { display: grid; gap: .45rem; color: #c8bed8; font-size: .78rem; }
	.scrubber input { width: 100%; accent-color: #66f2df; min-height: 44px; }
	.round-head { max-width: 1180px; margin: 1.2rem auto; display: flex; align-items: center; gap: 1rem; justify-content: space-between; }
	.round-head > div:first-child { display: flex; align-items: baseline; gap: .5rem; text-transform: uppercase; letter-spacing: .12em; color: #b9abc8; }
	.round-head strong { font-size: 2.5rem; color: #fff; }
	.pivots { display: flex; gap: .5rem; overflow-x: auto; }
	.pivots button { white-space: nowrap; border-color: #2e8c86; color: #9ff8eb; }
	.players { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
	article { position: relative; overflow: hidden; min-height: 240px; box-sizing: border-box; padding: 1.2rem; border: 1px solid #4a3767; border-radius: 22px; background: linear-gradient(145deg, rgba(37,22,59,.96), rgba(12,8,24,.98)); }
	article.pivotal { border-color: #66f2df; box-shadow: 0 0 32px rgba(102,242,223,.18); }
	.identity { position: relative; padding-right: 86px; }
	.identity span { color: #b8a7cb; text-transform: uppercase; letter-spacing: .16em; font-size: .7rem; }
	.identity h2 { margin: .25rem 0; font-size: 1.5rem; }
	.identity p { margin: 0; color: #b8adc5; }
	.stats { display: flex; gap: .7rem; margin: 1.1rem 0; }
	.stats strong { display: grid; min-width: 64px; padding: .6rem; border-radius: 12px; background: rgba(255,255,255,.06); font-size: 1.35rem; }
	.stats small { color: #9f92b0; font-size: .62rem; letter-spacing: .08em; text-transform: uppercase; }
	.spirits { display: flex; gap: .45rem; flex-wrap: wrap; }
	.spirits span { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; background: #4d2c75; border: 1px solid #956dcc; font-size: .7rem; }
	.spirits span.down { background: #151122; color: #66f2df; }
	.moment { display: inline-block; margin-top: .9rem; color: #66f2df; font-size: .72rem; text-transform: uppercase; letter-spacing: .1em; }
	.spirit-core { position: absolute; right: 1rem; top: 1rem; width: 66px; height: 66px; transform: rotate(45deg); animation: core 4s ease-in-out infinite; }
	.spirit-core i { position: absolute; inset: 10%; clip-path: polygon(50% 0, 100% 44%, 76% 100%, 20% 88%, 0 38%); background: linear-gradient(135deg, #b77bff, #43e5d4); opacity: .75; }
	.spirit-core i:nth-child(2) { transform: rotate(60deg) scale(.72); opacity: .5; }
	.spirit-core i:nth-child(3) { transform: rotate(125deg) scale(.46); background: #fff; opacity: .65; }
	footer { max-width: 1180px; margin: 1.5rem auto 0; display: flex; justify-content: space-between; align-items: center; color: #9286a1; }
	footer a { display: inline-grid; place-items: center; text-decoration: none; }
	@keyframes core { 0%,100% { transform: rotate(45deg) scale(.92); } 50% { transform: rotate(70deg) scale(1.05); } }
	@media (max-width: 760px) { header, .round-head { align-items: stretch; flex-direction: column; } .players { grid-template-columns: 1fr; } .pivots { max-width: 100%; } .replay-spirit{align-self:center} }
	@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; } .ticks button.active { transform: none; } }
</style>
