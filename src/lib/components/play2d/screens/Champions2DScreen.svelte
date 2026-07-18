<script lang="ts">
	import { onMount } from 'svelte';
	import { fetch2DRatingLeaderboard, type Rating2DRow } from '$lib/supabase';
	import { auth } from '$lib/auth/auth.svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import GameIcon from '$lib/components/GameIcon.svelte';
	import ScreenScaffold from './ScreenScaffold.svelte';
	import StateMessage from './StateMessage.svelte';

	interface Props {
		backHref?: string;
		backLabel?: string;
	}
	let { backHref = '/play', backLabel = 'Menu' }: Props = $props();

	let entries = $state<Rating2DRow[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let lastRefresh = $state<Date | null>(null);
	let search = $state('');

	// True global rank by user_id (index in the full sorted list) so search keeps real rank.
	const rankByUser = $derived(new Map(entries.map((e, i) => [e.userId, i + 1])));

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter((e) => e.displayName.toLowerCase().includes(q));
	});

	// The signed-in player's own standing, surfaced as a "your rank" banner.
	const myUserId = $derived(auth.user?.id ?? null);
	const me = $derived.by(() => {
		if (!myUserId) return null;
		const entry = entries.find((e) => e.userId === myUserId);
		if (!entry) return null;
		return { entry, rank: rankByUser.get(myUserId) ?? 0 };
	});

	function rankAccent(rank: number): string {
		if (rank === 1) return 'var(--brand-amber)';
		if (rank === 2) return 'var(--brand-cyan)';
		if (rank === 3) return 'var(--brand-coral)';
		return 'var(--brand-magenta)';
	}

	async function refresh() {
		loading = true;
		error = null;
		try {
			entries = await fetch2DRatingLeaderboard();
			lastRefresh = new Date();
		} catch (e) {
			console.error('Error fetching 2D champions:', e);
			error = e instanceof Error ? e.message : 'Failed to fetch leaderboard';
		} finally {
			loading = false;
		}
	}

	const hover = () => playMenuSfx('ui-hover', { volume: 0.4 });

	onMount(() => {
		void refresh();
	});
</script>

<ScreenScaffold
	eyebrow="Hall of Guardians"
	title="Ranked Ladder"
	subtitle="Conservative OpenSkill rating from ranked 2D games."
	syncedAt={lastRefresh}
	{backHref}
	{backLabel}
>
	{#snippet actions()}
		<div class="search-bare">
			<GameIcon name="search" size={16} />
			<input
				class="input-bare"
				bind:value={search}
				placeholder="Filter by name…"
				spellcheck="false"
			/>
		</div>
		<button
			class="btn-ghost"
			type="button"
			onclick={refresh}
			onpointerenter={hover}
			disabled={loading}
		>
			<GameIcon name="refresh" size={16} /> Refresh
		</button>
	{/snippet}

	{#if loading && entries.length === 0}
		<StateMessage loading message="Tallying ascendant souls…" />
	{:else if error}
		<section class="hall-unavailable" data-testid="hall-unavailable-state">
			<div class="hall-mark"><GameIcon name="guardians" size={34} /></div>
			<div class="hall-copy">
				<p class="state-eyebrow">Hall remains open</p>
				<h2>Live standings are unavailable</h2>
				<p>
					The ladder could not be reached, but the rest of the game is ready. Try again or choose
					another destination.
				</p>
				<small>{error}</small>
			</div>
			<div class="hall-actions">
				<button class="btn-ghost" type="button" onclick={refresh}
					><GameIcon name="refresh" size={16} /> Try Again</button
				>
				<a class="btn-ghost" href="/play?action=ranked"
					><GameIcon name="quick" size={16} /> Quick Play</a
				>
				<a class="btn-ghost" href="/play/ranked"><GameIcon name="ranked" size={16} /> Season</a>
				<a class="btn-ghost" href="/play/builder"><GameIcon name="builder" size={16} /> Builder</a>
			</div>
		</section>
	{:else if entries.length === 0}
		<StateMessage
			title="No ranked games yet"
			message="Play a ranked match to claim a place on the ladder."
		/>
	{:else}
		{#if me}
			<div class="me-banner" style:--accent={rankAccent(me.rank)}>
				<span class="me-rank">#{me.rank}</span>
				<span class="me-name">{me.entry.displayName}</span>
				<span class="me-stat"><b>{me.entry.ordinal.toFixed(1)}</b> rating</span>
				<span class="me-stat"><b>{me.entry.gamesPlayed}</b> games</span>
			</div>
		{/if}

		<div class="standings-head">
			<h2 class="standings-title"><GameIcon name="ranked" size={24} /> Standings</h2>
			<span class="standings-rule" aria-hidden="true"></span>
		</div>

		{#if filtered.length === 0}
			<StateMessage title="No players match this search" />
		{:else}
			<div class="lb-table" role="table">
				<div class="lb-head" role="row">
					<div role="columnheader">Rank</div>
					<div role="columnheader">Player</div>
					<div class="num" role="columnheader">Rating</div>
					<div class="num" role="columnheader">Games</div>
				</div>
				{#each filtered as entry (entry.userId)}
					{@const rank = rankByUser.get(entry.userId) ?? 0}
					<div
						class="lb-row"
						class:top={rank <= 3}
						class:mine={entry.userId === myUserId}
						role="row"
					>
						<div class="rank-cell" role="cell">
							<span class="rank-chip rank-chip-{rank <= 3 ? rank : 'rest'}">{rank}</span>
						</div>
						<div class="player-cell" role="cell">
							<span class="player-name">{entry.displayName}</span>
						</div>
						<div class="num" role="cell">
							<span class="rating-num">{entry.ordinal.toFixed(1)}</span>
						</div>
						<div class="num" role="cell">{entry.gamesPlayed}</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="standings-foot">
			Showing <b>{filtered.length}</b> of <b>{entries.length}</b> ranked players
		</div>
	{/if}
</ScreenScaffold>

<style>
	.search-bare {
		position: relative;
		display: flex;
		align-items: center;
		min-width: 220px;
	}
	.search-bare :global(.game-icon) {
		position: absolute;
		left: 0;
		width: 16px;
		height: 16px;
		color: var(--color-fog);
		pointer-events: none;
	}
	.search-bare :global(.input-bare) {
		padding-left: 26px;
		min-width: 180px;
	}
	:global(.btn-ghost) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
	}
	.hall-unavailable {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 18px;
		align-items: start;
		padding: clamp(22px, 5vw, 42px);
		border: 1px solid rgba(92, 223, 255, 0.28);
		border-radius: 18px;
		background: linear-gradient(145deg, rgba(14, 8, 32, 0.88), rgba(7, 18, 28, 0.78));
	}
	.hall-mark {
		display: grid;
		place-items: center;
		width: 64px;
		height: 64px;
		border-radius: 18px;
		color: var(--brand-cyan, #5cdfff);
		background: rgba(92, 223, 255, 0.1);
		box-shadow: inset 0 0 0 1px rgba(92, 223, 255, 0.2);
	}
	.hall-copy h2 {
		margin: 2px 0 8px;
		font-family: var(--font-display);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.hall-copy p {
		max-width: 62ch;
		margin: 0;
		color: var(--color-fog, #9a93b0);
	}
	.hall-copy small {
		display: block;
		margin-top: 10px;
		color: var(--brand-coral, #ff704d);
	}
	.state-eyebrow {
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff) !important;
	}
	.hall-actions {
		grid-column: 2;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.hall-actions a {
		text-decoration: none;
	}

	/* ── "Your rank" banner ───────────────────────────────── */
	.me-banner {
		display: flex;
		align-items: center;
		gap: 22px;
		padding: 14px 20px;
		margin-bottom: 28px;
		background: linear-gradient(180deg, rgba(40, 16, 52, 0.6), rgba(16, 8, 28, 0.6));
		border: 1px solid var(--color-mist);
		border-left: 4px solid var(--accent);
		border-radius: 10px;
	}
	.me-rank {
		font-family: var(--font-display);
		font-size: 2rem;
		line-height: 1;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
	}
	.me-name {
		flex: 1;
		min-width: 0;
		font-family: var(--font-display);
		font-size: 1.4rem;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.me-stat {
		font-size: 0.85rem;
		color: var(--color-fog);
		font-family: var(--font-body);
	}
	.me-stat b {
		color: var(--color-bone);
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
		margin-right: 3px;
	}

	/* ── Standings heading ────────────────────────────────── */
	.standings-head {
		display: flex;
		align-items: center;
		gap: 18px;
		margin-bottom: 14px;
	}
	.standings-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-display);
		font-size: clamp(1.8rem, 4vmin, 2.6rem);
		line-height: 0.95;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--color-bone);
		margin: 0;
		padding-bottom: 6px;
		border-bottom: 3px solid var(--brand-magenta);
	}
	.standings-rule {
		flex: 1;
		height: 1px;
		background: var(--gradient-flame);
		opacity: 0.5;
	}

	/* ── Standings table ──────────────────────────────────── */
	.lb-table {
		border-top: 1px solid var(--color-mist);
	}
	.lb-head,
	.lb-row {
		display: grid;
		grid-template-columns: 70px minmax(160px, 1fr) 96px 72px;
		align-items: center;
		gap: 16px;
		padding: 12px 8px;
		border-bottom: 1px solid var(--color-mist);
	}
	.lb-head {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
	}
	.lb-row.top {
		background: rgba(255, 186, 61, 0.04);
	}
	.lb-row.mine {
		background: rgba(255, 43, 199, 0.08);
	}

	.rank-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 2.1rem;
		height: 2.1rem;
		font-family: var(--font-display);
		font-size: 1.3rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		color: var(--color-void);
		border-radius: 6px;
	}
	.rank-chip-1 {
		background: var(--brand-amber);
	}
	.rank-chip-2 {
		background: var(--brand-cyan);
	}
	.rank-chip-3 {
		background: var(--brand-coral);
	}
	.rank-chip-rest {
		background: transparent;
		color: var(--color-fog);
		font-size: 1.05rem;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--color-bone);
		font-family: var(--font-display);
		font-size: 1.05rem;
	}
	.player-cell {
		min-width: 0;
	}
	.player-name {
		font-family: var(--font-display);
		font-size: 1.3rem;
		line-height: 1;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		display: block;
	}
	.rating-num {
		font-family: var(--font-display);
		font-size: 1.1rem;
		color: var(--brand-magenta-soft);
	}

	.standings-foot {
		margin-top: 22px;
		text-align: center;
		font-size: 0.8rem;
		color: var(--color-fog);
	}
	.standings-foot b {
		color: var(--color-bone);
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 720px) {
		.hall-unavailable {
			grid-template-columns: 1fr;
		}
		.hall-actions {
			grid-column: 1;
		}
		.search-bare {
			min-width: 0;
			flex: 1;
		}
		.me-banner {
			gap: 14px;
		}
	}

	/* Hall of Guardians uses ceremonial banners and rank sigils. */
	.search-bare :global(.input-bare) {
		border-radius: 0;
		border-bottom: 3px solid #24d4ff;
	}
	.hall-unavailable {
		border: 0;
		border-radius: 0;
		background: #100725;
		clip-path: polygon(0 0, 96% 0, 100% 14%, 100% 100%, 0 100%);
	}
	.hall-mark {
		border-radius: 0;
		background: #087b91;
		box-shadow: none;
		color: #fff;
		clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
	}
	.hall-actions :global(.btn-ghost) {
		border-radius: 0;
		background: #28115b;
		clip-path: polygon(0 0, 90% 0, 100% 50%, 90% 100%, 0 100%);
	}
	.me-banner {
		border: 0;
		border-left: 9px solid var(--accent);
		border-radius: 0;
		background: #28115b;
		clip-path: polygon(0 0, 96% 0, 100% 50%, 96% 100%, 0 100%);
	}
	.standings-rule {
		height: 7px;
		background: #ff2bc7;
		opacity: 1;
	}
	.lb-table {
		border-top: 6px solid #43178f;
	}
	.lb-row {
		border-bottom: 3px solid #1f1043;
	}
	.lb-row.top {
		background: #28115b;
	}
	.lb-row.mine {
		background: #58104d;
	}
	.rank-chip {
		border-radius: 0;
		clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
	}
</style>
