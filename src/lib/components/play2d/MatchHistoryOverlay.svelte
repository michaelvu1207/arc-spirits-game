<script lang="ts">
	import DetailOverlay from './screens/DetailOverlay.svelte';
	import StateMessage from './screens/StateMessage.svelte';
	import StatCell from './screens/StatCell.svelte';
	import { goto } from '$app/navigation';
	import { fetchMyMatchHistory, type MatchHistoryEntry } from '$lib/play/matchHistory';
	import { postPlayJson } from '$lib/stores/playStore.svelte';
	import { formatDate } from '$lib/features/stats/format';

	interface Props {
		userId: string;
		displayName?: string | null;
		onClose: () => void;
	}

	let { userId, displayName = null, onClose }: Props = $props();

	let loading = $state(true);
	let error = $state<string | null>(null);
	let matches = $state<MatchHistoryEntry[]>([]);

	$effect(() => {
		let cancelled = false;
		loading = true;
		error = null;
		fetchMyMatchHistory(userId)
			.then((rows) => {
				if (!cancelled) matches = rows;
			})
			.catch((e) => {
				if (!cancelled) error = e instanceof Error ? e.message : 'Failed to summon your games.';
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	const wins = $derived(matches.filter((m) => m.didWin).length);
	const winRate = $derived(matches.length ? Math.round((wins / matches.length) * 100) : 0);
	const best = $derived(
		matches.length ? Math.min(...matches.map((m) => m.myPlacement)) : 0
	);

	function ordinalSuffix(n: number): string {
		const v = n % 100;
		if (v >= 11 && v <= 13) return `${n}th`;
		return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
	}

	// Replays are served by share code (/replay/<code>, replay_frames): the first open of a
	// game makes the player's share link for it (idempotent per player + game), then opens it.
	let openingReplay = $state<string | null>(null);
	let replayError = $state<string | null>(null);
	async function openReplay(m: MatchHistoryEntry) {
		if (!m.gameId || openingReplay) return;
		openingReplay = m.sessionId;
		replayError = null;
		try {
			const share = await postPlayJson<{ code: string; url: string }>('/api/play/replays', {
				gameId: m.gameId
			});
			await goto(share.url);
		} catch (e) {
			replayError = e instanceof Error ? e.message : 'Could not open this replay.';
		} finally {
			openingReplay = null;
		}
	}

	function placeAccent(placement: number): string {
		if (placement === 1) return 'var(--brand-amber-soft)';
		if (placement === 2) return 'var(--brand-cyan-soft)';
		return 'var(--color-fog)';
	}
</script>

<DetailOverlay eyebrow="Your Chronicle" title="Past Games" wide {onClose}>
	{#if loading && matches.length === 0}
		<StateMessage loading compact message="Summoning your games from the abyss…" />
	{:else if error}
		<StateMessage tone="error" compact title="The lantern has guttered out" message={error} />
	{:else if matches.length === 0}
		<StateMessage
			compact
			title="No conjurings recorded"
			message="Finished games appear here. Jump into a match to begin your chronicle."
		/>
	{:else}
		<!-- ── At a Glance ──────────────────────────────────────── -->
		<div class="glance">
			<StatCell value={matches.length} label="Games" size="md" />
			<span class="g-div" aria-hidden="true"></span>
			<StatCell value={wins} label="Wins" size="md" accent="var(--brand-magenta-soft)" />
			<span class="g-div" aria-hidden="true"></span>
			<StatCell value={`${winRate}%`} label="Win Rate" size="md" accent="var(--brand-teal)" />
			<span class="g-div" aria-hidden="true"></span>
			<StatCell value={ordinalSuffix(best)} label="Best Finish" size="md" accent="var(--brand-amber-soft)" />
		</div>

		<!-- ── Archive ──────────────────────────────────────────── -->
		<div class="archive" role="table" aria-label="Your past games">
			<div class="row head" role="row">
				<div class="c-place" role="columnheader">Result</div>
				<div class="c-mode" role="columnheader">Mode</div>
				<div class="c-vp" role="columnheader">VP</div>
				<div class="c-opps" role="columnheader">Opponents</div>
				<div class="c-sr" role="columnheader">Replay</div>
				<div class="c-when" role="columnheader">Played</div>
			</div>

			{#each matches as m (m.sessionId)}
				<div class="row data" class:win={m.didWin} role="row">
					<div class="c-place" role="cell">
						<span class="place" style:color={placeAccent(m.myPlacement)}>
							{ordinalSuffix(m.myPlacement)}
						</span>
						<span class="of">of {m.playerCount}</span>
					</div>
					<div class="c-mode" role="cell">
						<span class="mode-tag">{m.mode === 'ranked' ? 'Ranked' : 'Casual'}</span>
					</div>
					<div class="c-vp" role="cell"><span class="vp">{m.myVictoryPoints}</span></div>
					<div class="c-opps" role="cell">
						{#if m.opponents.length > 0}
							<span class="opps">
								{m.opponents.map((o) => o.displayName).join(', ')}
							</span>
						{:else}
							<span class="opps dim">—</span>
						{/if}
					</div>
					<div class="c-sr" role="cell">
						{#if m.gameId}
							<button
								type="button"
								class="replay-btn"
								onclick={() => openReplay(m)}
								disabled={openingReplay !== null}
								data-testid="history-open-replay"
							>
								{openingReplay === m.sessionId ? 'Opening…' : 'Watch'}
							</button>
						{:else}
							<span class="dim">—</span>
						{/if}
					</div>
					<div class="c-when" role="cell"><span class="when">{formatDate(m.endedAt)}</span></div>
				</div>
			{/each}
		</div>

		{#if replayError}
			<p class="replay-err" role="alert">{replayError}</p>
		{/if}

		<div class="archive-foot">
			Showing your last <b>{matches.length}</b> {matches.length === 1 ? 'game' : 'games'}
		</div>
	{/if}
</DetailOverlay>

<style>
	/* ── At a Glance (mirrors RecordsScreen) ──────────────── */
	.glance {
		display: flex;
		align-items: stretch;
		flex-wrap: wrap;
		gap: 16px 26px;
		padding-bottom: 22px;
		margin-bottom: 4px;
		border-bottom: 1px solid var(--color-mist);
	}
	.g-div {
		width: 1px;
		align-self: stretch;
		min-height: 36px;
		background: var(--color-mist);
	}

	/* ── Archive table (mirrors RecordsScreen) ────────────── */
	.archive {
		margin-top: 22px;
		border-top: 1px solid var(--color-mist);
	}
	.row {
		display: grid;
		grid-template-columns: minmax(96px, 0.9fr) 96px 56px minmax(140px, 1.6fr) 78px minmax(110px, 0.9fr);
		align-items: center;
		gap: 16px;
		padding: 13px 8px;
		border-bottom: 1px solid var(--color-mist);
	}
	.row.head {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
	}
	.row.data {
		position: relative;
		transition: background 180ms ease;
	}
	.row.data::after {
		content: '';
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: 0;
		height: 1px;
		background: var(--gradient-spectrum);
		transform: scaleX(0);
		transform-origin: left;
		opacity: 0.7;
		transition: transform 240ms ease;
	}
	.row.data:hover {
		background: rgba(255, 43, 199, 0.05);
	}
	.row.data:hover::after {
		transform: scaleX(1);
	}
	.row.data.win {
		background: linear-gradient(90deg, rgba(255, 43, 199, 0.06), transparent 70%);
	}

	.c-place {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	.place {
		font-family: var(--font-display);
		font-size: 1.15rem;
		letter-spacing: 0.02em;
		font-variant-numeric: tabular-nums;
	}
	.of {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--color-whisper);
	}

	.mode-tag {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--color-fog);
	}

	.c-vp {
		text-align: right;
	}
	.vp {
		font-family: var(--font-display);
		font-size: 1.05rem;
		color: var(--brand-amber-soft);
		font-variant-numeric: tabular-nums;
	}

	.opps {
		font-size: 0.82rem;
		color: var(--color-fog);
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.opps.dim {
		color: var(--color-whisper);
	}

	.c-sr {
		text-align: right;
	}
	.replay-btn {
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--brand-cyan);
		background: transparent;
		border: 1px solid color-mix(in srgb, var(--brand-cyan) 45%, transparent);
		border-radius: 999px;
		padding: 4px 12px;
		cursor: pointer;
	}
	.replay-btn:hover:not(:disabled),
	.replay-btn:focus-visible {
		background: color-mix(in srgb, var(--brand-cyan) 14%, transparent);
	}
	.replay-btn:disabled {
		opacity: 0.55;
		cursor: progress;
	}
	.dim {
		color: var(--color-whisper);
	}
	.replay-err {
		margin: 10px 0 0;
		font-size: 0.82rem;
		color: var(--brand-magenta-soft);
	}

	.c-when {
		text-align: right;
	}
	.when {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-fog);
		white-space: nowrap;
	}

	.archive-foot {
		margin-top: 22px;
		text-align: center;
		font-size: 0.8rem;
		color: var(--color-fog);
	}
	.archive-foot b {
		color: var(--color-bone);
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	/* ── Responsive column drops (mirrors RecordsScreen) ──── */
	@media (max-width: 720px) {
		.row {
			grid-template-columns: 1fr auto auto;
			gap: 12px;
			padding: 15px 8px;
		}
		.row.head {
			display: none;
		}
		.c-opps,
		.c-vp,
		.c-mode {
			display: none;
		}
	}
</style>
