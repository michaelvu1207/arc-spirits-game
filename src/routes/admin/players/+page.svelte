<script lang="ts">
	import { explorerLinks } from '$lib/explorer';
	import { onMount } from 'svelte';
	import { fetchRatingLeaderboard } from '$lib/supabase';
	import type { RatingLeaderboardRow } from '$lib/types';

	type PlayerRow = RatingLeaderboardRow & { winRatePct: number };

	let players = $state<PlayerRow[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let lastRefresh = $state<Date | null>(null);
	let search = $state('');
	let sortBy = $state<'games' | 'wins' | 'winrate' | 'avgvp' | 'avgplace' | 'recent'>('games');

	const filteredPlayers = $derived(() => {
		const q = search.trim().toLowerCase();
		const list = q ? players.filter((p) => p.username.toLowerCase().includes(q)) : players.slice();
		return list.sort((a, b) => {
			switch (sortBy) {
				case 'wins': return b.wins - a.wins;
				case 'winrate': return b.winRatePct - a.winRatePct;
				case 'avgvp': return b.avg_victory_points - a.avg_victory_points;
				case 'avgplace': return a.avg_placement - b.avg_placement;
				case 'recent': {
					const at = a.last_game_at ? Date.parse(a.last_game_at) : 0;
					const bt = b.last_game_at ? Date.parse(b.last_game_at) : 0;
					return bt - at;
				}
				default: return b.games_played - a.games_played;
			}
		});
	});

	function formatTimestamp(t: string | null): string {
		if (!t) return '—';
		const d = new Date(t);
		if (Number.isNaN(d.getTime())) return String(t);
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
	}

	// `explorer`: the local game explorer shows the roster on one screen.
	let { explorer = false }: { explorer?: boolean } = $props();

	async function refreshPlayers() {
		loading = true;
		error = null;
		try {
			const rows = await fetchRatingLeaderboard();
			players = rows.map((r) => ({ ...r, winRatePct: Math.round(((r.win_rate ?? 0) * 100 + Number.EPSILON) * 10) / 10 }));
			lastRefresh = new Date();
		} catch (e) {
			console.error('Error fetching players:', e);
			error = e instanceof Error ? e.message : 'Failed to fetch players';
		} finally { loading = false; }
	}

	onMount(() => { refreshPlayers(); });
</script>

<svelte:head>
	<title>Players | Arc Spirits Spectate</title>
</svelte:head>

<div class="page" class:explorer>
	<!-- PAGE HEADER -->
	{#if !explorer}
	<div class="page-header">
		<div>
			<span class="eyebrow">Player Leaderboard</span>
			<h1 class="page-title">Players</h1>
			<p class="page-desc">
				Every TTS username with verified games (over 10 turns, ≥10 VP) — sorted, filterable, searchable.
				{#if lastRefresh}<span class="upd"><span class="dot-pulse"></span>Synced {lastRefresh.toLocaleTimeString()}</span>{/if}
			</p>
		</div>
	</div>

	{/if}

	<!-- CONTROLS -->
	<div class="controls">
		<div class="search-bare">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3" stroke-linecap="round"/></svg>
			<input class="input-bare" bind:value={search} placeholder="Filter usernames…" />
		</div>
		<div class="sort-row">
			<span class="sort-label">Sort by</span>
			<div class="tabs-underline">
				<button class="tab-btn" class:active={sortBy === 'games'} onclick={() => (sortBy = 'games')}>Games</button>
				<button class="tab-btn" class:active={sortBy === 'wins'} onclick={() => (sortBy = 'wins')}>Wins</button>
				<button class="tab-btn" class:active={sortBy === 'winrate'} onclick={() => (sortBy = 'winrate')}>Win %</button>
				<button class="tab-btn" class:active={sortBy === 'avgvp'} onclick={() => (sortBy = 'avgvp')}>Avg VP</button>
				<button class="tab-btn" class:active={sortBy === 'avgplace'} onclick={() => (sortBy = 'avgplace')}>Avg Place</button>
				<button class="tab-btn" class:active={sortBy === 'recent'} onclick={() => (sortBy = 'recent')}>Recent</button>
			</div>
			<button onclick={refreshPlayers} disabled={loading} class="btn-ghost" type="button">
				<svg class={loading ? 'spin' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
				Refresh
			</button>
		</div>
	</div>

	{#if loading && players.length === 0}
		<div class="msg"><div class="spin-ring"></div><p>Loading roster…</p></div>
	{:else if error}
		<div class="msg msg-error"><h3>Roster unavailable</h3><p>{error}</p></div>
	{:else if filteredPlayers().length === 0}
		<div class="msg"><h3>No matches</h3><p>{players.length === 0 ? 'Verify a game to populate the roster.' : 'No players match this search.'}</p></div>
	{:else}
		<div class="players-table">
			<div class="pt-head">
				<div>Player</div>
				<div class="num">Games</div>
				<div class="num">Wins</div>
				<div class="num">Win %</div>
				<div class="num">Avg VP</div>
				<div class="num">Avg Place</div>
				<div class="num">Last Played</div>
			</div>
			{#each filteredPlayers() as p (p.username_key)}
				<a href={explorerLinks.player(p.username)} class="pt-row">
					<div class="player-cell">
						<span class="player-name">{p.username}</span>
					</div>
					<div class="num">{p.games_played}</div>
					<div class="num">{p.wins}</div>
					<div class="num winrate">
						<span>{p.winRatePct.toFixed(1)}%</span>
						<div class="winrate-bar"><div class="winrate-fill" style:width={`${Math.min(100, p.winRatePct)}%`}></div></div>
					</div>
					<div class="num">{p.avg_victory_points.toFixed(1)}</div>
					<div class="num">{p.avg_placement.toFixed(2)}</div>
					<div class="num last-cell">{formatTimestamp(p.last_game_at)}</div>
				</a>
			{/each}
		</div>
		<div class="archive-foot">Showing <b>{filteredPlayers().length}</b> of <b>{players.length}</b> binders</div>
	{/if}
</div>

<style>
	.page { max-width: 1280px; margin: 0 auto; padding: 56px 32px 80px; position: relative; z-index: 1; }

	/* Local explorer: one screen. The table scrolls inside its panel, the page does not. */
	.page.explorer { height: 100%; width: 100%; padding: 14px 32px 10px; display: flex; flex-direction: column; }
	.page.explorer .controls { margin-bottom: 8px; gap: 8px; }
	.page.explorer .players-table { flex: 1; min-height: 0; overflow-y: auto; }
	.page.explorer .pt-head { position: sticky; top: 0; background: var(--color-void); z-index: 1; }

	/* PAGE HEADER */
	.page-header {
		margin-bottom: 48px;
	}
	.page-title {
		font-family: var(--font-display);
		font-size: clamp(3.5rem, 7vw, 5.5rem);
		line-height: 0.9;
		letter-spacing: 0.02em;
		color: var(--color-bone);
		margin: 8px 0 14px;
	}
	.page-desc { color: var(--color-fog); font-size: 0.92rem; line-height: 1.55; max-width: 68ch; margin: 0; }
	.upd { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 0.7rem; color: var(--color-fog); margin-left: 12px; }
	.dot-pulse { width: 6px; height: 6px; background: var(--brand-teal); border-radius: 50%; box-shadow: 0 0 6px var(--brand-teal); }

	/* CONTROLS */
	.controls {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-bottom: 24px;
	}
	.sort-row {
		display: flex;
		align-items: flex-end;
		gap: 20px;
		flex-wrap: wrap;
	}
	.sort-label {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.3em;
		color: var(--color-fog);
		padding-bottom: 12px;
		white-space: nowrap;
	}
	.search-bare { position: relative; display: flex; align-items: center; }
	.search-bare svg { position: absolute; left: 0; width: 16px; height: 16px; color: var(--color-fog); pointer-events: none; }
	.search-bare .input-bare { padding-left: 28px; min-width: 300px; }

	/* TABLE */
	.players-table { margin-top: 8px; border-top: 1px solid var(--color-mist); }
	.pt-head, .pt-row {
		display: grid;
		grid-template-columns: minmax(220px, 2fr) 80px 70px 130px 90px 110px 160px;
		align-items: center;
		gap: 16px;
		padding: 14px 8px;
		border-bottom: 1px solid var(--color-mist);
	}
	.pt-head {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.22em;
		color: var(--color-fog);
	}
	.pt-row {
		text-decoration: none;
		color: inherit;
		transition: background 180ms ease;
	}
	.pt-row:hover { background: rgba(255, 43, 199, 0.04); }

	.player-name {
		font-family: var(--font-display);
		font-size: 1.5rem;
		line-height: 1;
		letter-spacing: 0.01em;
		color: var(--color-bone);
		transition: color 180ms ease;
	}
	.pt-row:hover .player-name { color: var(--brand-magenta-soft); }

	.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--color-bone); font-weight: 600; font-size: 0.92rem; }
	.last-cell { font-family: var(--font-mono); font-size: 0.78rem; color: var(--color-fog); font-weight: 400; }
	.winrate { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
	.winrate-bar { width: 92px; height: 2px; background: var(--color-mist); }
	.winrate-fill { height: 100%; background: var(--brand-magenta); }

	.archive-foot { margin-top: 28px; text-align: center; font-size: 0.78rem; color: var(--color-fog); }
	.archive-foot b { color: var(--color-bone); font-family: var(--font-display); font-variant-numeric: tabular-nums; }

	.msg { padding: 80px 24px; text-align: center; color: var(--color-fog); display: flex; flex-direction: column; align-items: center; gap: 12px; }
	.msg h3 { font-family: var(--font-display); font-size: 1.8rem; color: var(--color-bone); margin: 0; }
	.msg p { max-width: 50ch; margin: 0; }
	.msg-error h3 { color: var(--color-blood); }
	.spin-ring { width: 32px; height: 32px; border: 2px solid var(--color-mist); border-top-color: var(--brand-magenta); border-radius: 50%; animation: spin 1s linear infinite; }
	.spin { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 960px) {
		.pt-head, .pt-row { grid-template-columns: 1.4fr 70px 110px 90px 130px; gap: 12px; }
		.pt-head > div:nth-child(3), .pt-row > div:nth-child(3),
		.pt-head > div:nth-child(6), .pt-row > div:nth-child(6) { display: none; }
	}
	@media (max-width: 560px) {
		.page { padding: 36px 22px 60px; }
		.pt-head, .pt-row { grid-template-columns: 1fr 60px 90px; gap: 10px; }
		.pt-head > div:nth-child(n+4), .pt-row > div:nth-child(n+4) { display: none; }
		.controls { align-items: stretch; }
		.search-bare .input-bare { min-width: 0; width: 100%; }
	}
</style>
