<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchRatingLeaderboard } from '$lib/supabase';
	import { loadAssets, getGuardianAsset } from '$lib/stores/assetStore.svelte';
	import { toSortedChampions, type ChampionEntry } from '$lib/features/champions/champions';
	import { formatDateCompact } from '$lib/features/stats/format';
	import { explorerLinks, fetchPlayerRuns, runLabel, runsOf } from '$lib/explorer';

	// `explorer`: the local game explorer shows the standings on one screen.
	let { explorer = false }: { explorer?: boolean } = $props();
	let playerRuns = $state(new Map<string, string>());
	let runFilter = $state('all');
	const runs = $derived(runsOf([...playerRuns.values()].map((run) => ({ run }))));

	let entries = $state<ChampionEntry[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let lastRefresh = $state<Date | null>(null);
	let search = $state('');

	const filteredEntries = $derived(() => {
		const q = search.trim().toLowerCase();
		const list = runFilter === 'all' ? entries : entries.filter((e) => playerRuns.get(e.usernameKey) === runFilter);
		if (!q) return list;
		return list.filter((e) => e.username.toLowerCase().includes(q));
	});

	async function refreshLeaderboard() {
		loading = true;
		error = null;
		try {
			const rows = await fetchRatingLeaderboard();
			entries = toSortedChampions(rows);
			if (explorer) playerRuns = await fetchPlayerRuns();
			lastRefresh = new Date();
		} catch (e) {
			console.error('Error fetching leaderboard:', e);
			error = e instanceof Error ? e.message : 'Failed to fetch leaderboard';
		} finally { loading = false; }
	}

	onMount(() => { loadAssets(); refreshLeaderboard(); });
</script>

<svelte:head>
	<title>Leaderboard | Arc Spirits Spectate</title>
</svelte:head>

<div class="page" class:explorer>
	<!-- PAGE HEADER -->
	{#if !explorer}
	<div class="page-header">
		<div class="page-header-text">
			<span class="eyebrow">Hall of Champions</span>
			<h1 class="page-title">Leaderboard</h1>
			<p class="page-desc">
				Placement-only OpenSkill ratings drawn from verified games (over 10 turns) where players carry a TTS username and ≥10 VP.
				{#if lastRefresh}<span class="upd"><span class="dot-pulse"></span>Synced {lastRefresh.toLocaleTimeString()}</span>{/if}
			</p>
		</div>
		<div class="page-header-accent" aria-hidden="true">
			<!-- Triangle embellishment -->
			<svg width="72" height="72" viewBox="0 0 72 72" fill="none">
				<polygon points="36,4 68,68 4,68" stroke="var(--brand-magenta)" stroke-width="2" fill="none"/>
				<polygon points="36,18 56,60 16,60" stroke="var(--brand-magenta)" stroke-width="1" fill="none" opacity="0.4"/>
			</svg>
		</div>
	</div>

	{/if}

	<!-- TOP 3 PODIUM — solid colored rank chips, big names -->
	{#if !explorer && !loading && entries.length >= 1}
		<section class="podium">
			{#each entries.slice(0, 3) as champ, i (champ.usernameKey)}
				{@const rank = i + 1}
				{@const lastGame = champ.lastGames[0]}
				{@const asset = lastGame ? getGuardianAsset(lastGame.character) : null}
				<a href={explorerLinks.player(champ.username)} class="pod-card pod-rank-{rank}">
					<div class="pod-rank-chip">
						<span class="pod-rank-num">{rank}</span>
						<span class="pod-rank-label">{rank === 1 ? 'Champion' : rank === 2 ? 'Runner-Up' : 'Third'}</span>
					</div>
					<div class="pod-portrait">
						{#if asset?.iconUrl}
							<img src={asset.iconUrl} alt={lastGame?.character ?? champ.username} loading="lazy" />
						{:else}
							<div class="portrait-placeholder">{champ.username.slice(0, 2).toUpperCase()}</div>
						{/if}
					</div>
					<div class="pod-body">
						<div class="pod-name">{champ.username}</div>
						<div class="pod-stats">
							<span><b>{champ.gamesPlayed}</b> games</span>
							<span><b>{champ.winRatePct.toFixed(0)}%</b> wins</span>
							<span><b>{champ.avgPoints.toFixed(1)}</b> avg VP</span>
						</div>
					</div>
					{#if champ.rating != null}
						<div class="pod-rating-block">
							<div class="pod-rating-num">{champ.rating.toFixed(1)}</div>
							<div class="pod-rating-lab">Rating</div>
						</div>
					{/if}
				</a>
			{/each}
		</section>
	{/if}

	<!-- FULL STANDINGS -->
	<div class="standings-header">
		<h2 class="standings-title">Full Standings</h2>
		{#if explorer && runs.length > 1}
			<div class="tabs-underline">
				<button class="tab-btn" class:active={runFilter === 'all'} onclick={() => (runFilter = 'all')}>All runs</button>
				{#each runs as run (run)}
					<button class="tab-btn" class:active={runFilter === run} onclick={() => (runFilter = run)}>{runLabel(run)}</button>
				{/each}
			</div>
		{/if}
		<div class="search-bare">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3" stroke-linecap="round"/></svg>
			<input class="input-bare" bind:value={search} placeholder="Filter by name…" />
			<button onclick={refreshLeaderboard} disabled={loading} class="btn-ghost" type="button">
				<svg class={loading ? 'spin' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
				Refresh
			</button>
		</div>
	</div>

	{#if loading && entries.length === 0}
		<div class="msg"><div class="spin-ring"></div><p>Tallying ascendant souls…</p></div>
	{:else if error}
		<div class="msg msg-error"><h3>Could not summon leaderboard</h3><p>{error}</p></div>
	{:else if filteredEntries().length === 0}
		<div class="msg"><h3>No players match this search</h3></div>
	{:else}
		<div class="lb-table">
			<div class="lb-head">
				<div>Rank</div>
				<div>Player</div>
				<div class="num">Rating</div>
				<div class="num">Games</div>
				<div class="num">Win %</div>
				<div class="num">Avg VP</div>
				<div class="num">Avg Place</div>
				<div>Recent</div>
			</div>
			{#each filteredEntries() as entry, i (entry.usernameKey)}
				{@const rank = entries.findIndex((e) => e.usernameKey === entry.usernameKey) + 1}
				<div class="lb-row" class:top={rank <= 3}>
					<div class="rank-cell">
						<span class="rank-chip rank-chip-{rank <= 3 ? rank : 'rest'}">{rank}</span>
					</div>
					<div class="player-cell">
						<a href={explorerLinks.player(entry.username)} class="player-link">{entry.username}</a>
						{#if entry.lastGames[0]}
							<div class="player-meta">Last played {formatDateCompact(entry.lastGames[0].endedAt)}</div>
						{/if}
					</div>
					<div class="num">
						{#if entry.rating != null}
							<span class="rating-num">{entry.rating.toFixed(1)}</span>
						{:else}<span class="dim">—</span>{/if}
					</div>
					<div class="num">{entry.gamesPlayed}</div>
					<div class="num winrate">
						<span>{entry.winRatePct.toFixed(1)}%</span>
						<div class="winrate-bar"><div class="winrate-fill" style:width={`${Math.min(100, entry.winRatePct)}%`}></div></div>
					</div>
					<div class="num">{entry.avgPoints.toFixed(1)}</div>
					<div class="num">{entry.avgPlacement.toFixed(2)}</div>
					<div class="recent-cell">
						{#each entry.lastGames.slice(0, 5) as game (`${game.gameId}:${game.round}:${game.playerColor}`)}
							{@const a = getGuardianAsset(game.character)}
							<a
								href={explorerLinks.game(game.gameId, `?round=${encodeURIComponent(String(game.round))}&player=${encodeURIComponent(game.playerColor)}`)}
								class="recent-hex"
								title={`${game.character} • ${game.victoryPoints} VP • Place ${game.placement}`}
							>
								{#if a?.iconUrl}
									<img src={a.iconUrl} alt={game.character} loading="lazy" />
								{:else}
									<div class="recent-empty">{game.character.slice(0, 2)}</div>
								{/if}
							</a>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1280px; margin: 0 auto; padding: 56px 32px 80px; position: relative; z-index: 1; }

	/* Local explorer: one screen. The table scrolls inside its panel, the page does not. */
	.page.explorer { height: 100%; width: 100%; padding: 14px 32px 10px; display: flex; flex-direction: column; }
	.page.explorer .standings-header { margin-bottom: 0; align-items: center; }
	.page.explorer .standings-title { font-size: 2rem; }
	.page.explorer .lb-table { flex: 1; min-height: 0; overflow-y: auto; }
	.page.explorer .lb-head { position: sticky; top: 0; background: var(--color-void); z-index: 1; }

	/* PAGE HEADER */
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 56px;
	}
	.page-header-text { flex: 1; }
	.page-header-accent {
		flex: none;
		padding-top: 8px;
		opacity: 0.7;
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

	/* PODIUM — solid color cards */
	.podium {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 64px;
	}
	.pod-card {
		display: grid;
		grid-template-columns: 140px 64px 1fr auto;
		align-items: center;
		gap: 24px;
		padding: 20px 24px;
		background: var(--color-tomb);
		border: 1px solid var(--color-mist);
		text-decoration: none;
		color: inherit;
		transition: border-color 180ms ease, background 180ms ease;
	}
	.pod-card:hover { border-color: var(--brand-magenta); background: rgba(255, 43, 199, 0.04); }

	/* Rank chip — big solid colored pill */
	.pod-rank-chip {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.pod-rank-num {
		font-family: var(--font-display);
		font-size: 4rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
		/* color set per rank below */
	}
	.pod-rank-label {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.28em;
		color: var(--color-fog);
	}
	/* Rank 1 — amber */
	.pod-rank-1 .pod-rank-num {
		color: var(--brand-amber);
		font-size: 5rem;
	}
	.pod-rank-1 { border-left: 4px solid var(--brand-amber); }
	/* Rank 2 — cyan */
	.pod-rank-2 .pod-rank-num { color: var(--brand-cyan); }
	.pod-rank-2 { border-left: 4px solid var(--brand-cyan); }
	/* Rank 3 — coral */
	.pod-rank-3 .pod-rank-num { color: var(--brand-coral); }
	.pod-rank-3 { border-left: 4px solid var(--brand-coral); }

	.pod-portrait {
		width: 56px; height: 56px;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--brand-magenta);
		padding: 1.5px;
	}
	.pod-rank-1 .pod-portrait { width: 64px; height: 64px; background: var(--brand-amber); }
	.pod-rank-2 .pod-portrait { background: var(--brand-cyan); }
	.pod-rank-3 .pod-portrait { background: var(--brand-coral); }
	.pod-portrait img { width: 100%; height: 100%; object-fit: cover; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); }
	.portrait-placeholder {
		width: 100%; height: 100%;
		display: grid; place-items: center;
		background: var(--color-void);
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		font-family: var(--font-display);
		color: var(--brand-magenta-soft);
	}

	.pod-body { min-width: 0; }
	.pod-name {
		font-family: var(--font-display);
		font-size: 2rem;
		line-height: 1;
		letter-spacing: 0.01em;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pod-rank-1 .pod-name { font-size: 2.6rem; }
	.pod-stats {
		display: flex;
		gap: 20px;
		margin-top: 8px;
		font-size: 0.8rem;
		color: var(--color-fog);
		font-family: var(--font-body);
	}
	.pod-stats b { color: var(--color-bone); font-family: var(--font-display); font-variant-numeric: tabular-nums; margin-right: 3px; }

	.pod-rating-block { text-align: right; }
	.pod-rating-num {
		font-family: var(--font-display);
		font-size: 2.8rem;
		line-height: 1;
		color: var(--brand-magenta);
		font-variant-numeric: tabular-nums;
	}
	.pod-rank-1 .pod-rating-num { font-size: 3.4rem; color: var(--brand-amber); }
	.pod-rank-2 .pod-rating-num { color: var(--brand-cyan); }
	.pod-rank-3 .pod-rating-num { color: var(--brand-coral); }
	.pod-rating-lab {
		margin-top: 4px;
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.28em;
		color: var(--color-fog);
	}

	/* STANDINGS HEADER */
	.standings-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 24px;
		flex-wrap: wrap;
		margin-bottom: 18px;
	}
	.standings-title {
		font-family: var(--font-display);
		font-size: 3rem;
		line-height: 0.95;
		letter-spacing: 0.02em;
		color: var(--color-bone);
		margin: 0;
		border-bottom: 3px solid var(--brand-magenta);
		padding-bottom: 8px;
		display: inline-block;
	}
	.search-bare {
		position: relative;
		display: flex;
		gap: 12px;
		align-items: center;
		min-width: 320px;
	}
	.search-bare svg { position: absolute; left: 0; width: 16px; height: 16px; color: var(--color-fog); pointer-events: none; }
	.search-bare .input-bare { padding-left: 28px; min-width: 200px; }

	/* TABLE */
	.lb-table {
		margin-top: 8px;
		border-top: 1px solid var(--color-mist);
	}
	.lb-head,
	.lb-row {
		display: grid;
		grid-template-columns: 80px minmax(180px, 1.6fr) 90px 70px 130px 80px 100px minmax(220px, 1.4fr);
		align-items: center;
		gap: 18px;
		padding: 14px 8px;
		border-bottom: 1px solid var(--color-mist);
	}
	.lb-head {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.22em;
		color: var(--color-fog);
	}
	.lb-row { transition: background 180ms ease; }
	.lb-row:hover { background: rgba(255, 43, 199, 0.04); }
	.lb-row.top { background: rgba(255, 186, 61, 0.03); }

	/* Rank chip in table — solid colored pill for top 3 */
	.rank-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 2.2rem;
		height: 2.2rem;
		font-family: var(--font-display);
		font-size: 1.4rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		color: var(--color-void);
		border-radius: 4px;
	}
	.rank-chip-1 { background: var(--brand-amber); }
	.rank-chip-2 { background: var(--brand-cyan); }
	.rank-chip-3 { background: var(--brand-coral); }
	.rank-chip-rest {
		background: transparent;
		color: var(--color-fog);
		font-size: 1.1rem;
	}

	.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--color-bone); font-weight: 600; font-size: 0.92rem; }

	.player-cell { min-width: 0; }
	.player-link {
		font-family: var(--font-display);
		font-size: 1.3rem;
		line-height: 1;
		letter-spacing: 0.01em;
		color: var(--color-bone);
		text-decoration: none;
		transition: color 180ms ease;
	}
	.player-link:hover { color: var(--brand-magenta-soft); }
	.player-meta { margin-top: 3px; font-size: 0.7rem; color: var(--color-fog); letter-spacing: 0.04em; }

	.rating-num { font-family: var(--font-display); font-size: 1.15rem; color: var(--brand-magenta-soft); }

	.winrate { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
	.winrate-bar { width: 96px; height: 2px; background: var(--color-mist); }
	.winrate-fill { height: 100%; background: var(--brand-magenta); }

	.recent-cell { display: flex; gap: 6px; flex-wrap: wrap; }
	.recent-hex {
		display: block;
		width: 30px; height: 30px;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--brand-magenta);
		padding: 1px;
		transition: opacity 180ms ease;
	}
	.recent-hex:hover { opacity: 0.85; }
	.recent-hex img { width: 100%; height: 100%; object-fit: cover; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); }
	.recent-empty {
		width: 100%; height: 100%;
		display: grid; place-items: center;
		background: var(--color-void);
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		font-size: 0.6rem;
		font-weight: 700;
		color: var(--color-parchment);
	}

	/* MESSAGES */
	.msg { padding: 80px 24px; text-align: center; color: var(--color-fog); display: flex; flex-direction: column; align-items: center; gap: 12px; }
	.msg h3 { font-family: var(--font-display); font-size: 1.8rem; color: var(--color-bone); margin: 0; }
	.msg p { max-width: 50ch; margin: 0; }
	.msg-error h3 { color: var(--color-blood); }
	.spin-ring { width: 32px; height: 32px; border: 2px solid var(--color-mist); border-top-color: var(--brand-magenta); border-radius: 50%; animation: spin 1s linear infinite; }
	.spin { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.dim { color: var(--color-fog); }

	@media (max-width: 1100px) {
		.lb-head, .lb-row {
			grid-template-columns: 70px 1.4fr 80px 60px 110px 70px 90px;
			gap: 12px;
		}
		.lb-head > div:nth-child(8), .lb-row > div:nth-child(8) { display: none; }
	}
	@media (max-width: 720px) {
		.page { padding: 36px 22px 60px; }
		.pod-card { grid-template-columns: 80px 48px 1fr; gap: 14px; padding: 16px 12px; }
		.pod-card .pod-rating-block { display: none; }
		.pod-stats { display: none; }
		.pod-name { font-size: 1.3rem; }
		.pod-rank-1 .pod-name { font-size: 1.6rem; }
		.pod-rank-num { font-size: 2.8rem; }
		.pod-rank-1 .pod-rank-num { font-size: 3.2rem; }
		.lb-head, .lb-row { grid-template-columns: 50px 1fr 80px; gap: 10px; padding: 12px 8px; }
		.lb-head > div:nth-child(n+4), .lb-row > div:nth-child(n+4) { display: none; }
		.standings-header { flex-direction: column; align-items: stretch; }
		.search-bare { min-width: 0; }
	}
</style>
