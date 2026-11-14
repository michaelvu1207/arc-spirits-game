<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { fetchGameSummaries } from '$lib/supabase';
	import { loadAssets, getGuardianAsset } from '$lib/stores/assetStore.svelte';
	import { toFullReplayCode, toShortReplayCode } from '$lib/replayCodes';
	import {
		formatDate,
		formatDuration,
		formatDurationHoursMinutes,
		safeDurationMs
	} from '$lib/features/stats/format';
	import { shortenGameId } from '$lib/features/records/records';
	import { explorerLinks, fetchGameRuns, fetchGameStories, fetchGameWinners, runLabel, runsOf, type GameStory } from '$lib/explorer';

	// `explorer`: the local game explorer shows this page on one screen, without the hero.
	let { explorer = false }: { explorer?: boolean } = $props();
	let gameRuns = $state(new Map<string, { run: string; version: string }>());
	let runFilter = $state('all');
	let winners = $state(new Map<string, string>());
	let winnerSearch = $state('');
	let stories = $state(new Map<string, GameStory>());
	const runs = $derived(runsOf([...gameRuns.values()]));

	interface GameListItem {
		game_id: string;
		started_at: string | null;
		navigation_count: number;
		player_count: number;
		ended_at: string | null;
		total_duration_ms: number | null;
		avg_navigation_ms: number | null;
		winner_guardian: string | null;
		winner_guardian_icon: string | null;
		winner_vp: number;
		verified: boolean;
	}

	let games = $state<GameListItem[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let lastRefresh = $state<Date | null>(null);
	const MIN_TURNS_TO_SHOW = 15;
	let gameFilter = $state<'15plus' | 'under15' | 'all'>('15plus');
	let verificationFilter = $state<'verified' | 'unverified' | 'all'>('verified');
	let copiedReplayForGame = $state<string | null>(null);
	let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

	const filteredGames = $derived(() => {
		let list = games;
		if (runFilter !== 'all') list = list.filter((g) => gameRuns.get(g.game_id)?.run === runFilter);
		const q = winnerSearch.trim().toLowerCase();
		if (q) list = list.filter((g) => (winners.get(g.game_id) ?? '').toLowerCase().includes(q));
		if (verificationFilter === 'verified') list = list.filter((g) => g.verified);
		else if (verificationFilter === 'unverified') list = list.filter((g) => !g.verified);
		if (gameFilter === 'all') return list;
		if (gameFilter === 'under15') return list.filter((g) => g.navigation_count < MIN_TURNS_TO_SHOW);
		return list.filter((g) => g.navigation_count >= MIN_TURNS_TO_SHOW);
	});

	const verifiedCount = $derived(() => games.filter((g) => g.verified).length);
	const unverifiedCount = $derived(() => games.filter((g) => !g.verified).length);

	// "At a Glance" stats only consider the past 8 verified games. Sort by
	// ended_at desc (falling back to started_at) so we always pick the most
	// recently completed runs, then truncate to 8.
	const GLANCE_LIMIT = 8;
	function gameSortTimestamp(g: GameListItem): number {
		const t = g.ended_at ?? g.started_at;
		if (!t) return 0;
		const ms = Date.parse(t);
		return Number.isNaN(ms) ? 0 : ms;
	}
	const glanceGames = $derived(() =>
		games
			.filter((g) => g.verified)
			.slice()
			.sort((a, b) => gameSortTimestamp(b) - gameSortTimestamp(a))
			.slice(0, GLANCE_LIMIT)
	);

	const totalRounds = $derived(() =>
		glanceGames().reduce((sum, g) => sum + g.navigation_count, 0)
	);
	const totalPlayers = $derived(() =>
		glanceGames().reduce((sum, g) => sum + g.player_count, 0)
	);
	const avgDurationMs = $derived(() => {
		const durations = glanceGames()
			.map((g) => g.total_duration_ms)
			.filter((d): d is number => d != null);
		if (durations.length === 0) return null;
		return durations.reduce((a, b) => a + b, 0) / durations.length;
	});

	// Median per-turn duration across the past-8 sample. Uses each game's
	// `avg_navigation_ms` (precomputed server-side) as its representative
	// turn-length, then medians those values to reduce skew from outlier games.
	const medianTurnDurationMs = $derived(() => {
		const turns = glanceGames()
			.map((g) => g.avg_navigation_ms)
			.filter((d): d is number => d != null && Number.isFinite(d) && d >= 0)
			.sort((a, b) => a - b);
		if (turns.length === 0) return null;
		const mid = Math.floor(turns.length / 2);
		return turns.length % 2 === 0 ? (turns[mid - 1] + turns[mid]) / 2 : turns[mid];
	});

	function navigateToGame(gameId: string) { goto(explorer ? explorerLinks.game(gameId) : `/admin/game/${encodeURIComponent(gameId)}`); }

	function handleRowClick(event: MouseEvent, gameId: string) {
		const t = event.target as HTMLElement | null;
		if (!t) return;
		if (t.closest('a, button, [data-no-nav]')) return;
		navigateToGame(gameId);
	}
	function handleRowKeydown(event: KeyboardEvent, gameId: string) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			navigateToGame(gameId);
		}
	}

	async function copyReplayCode(gameId: string, navigationCount: number) {
		const code = toFullReplayCode(gameId, navigationCount);
		try {
			await navigator.clipboard.writeText(code);
			copiedReplayForGame = gameId;
			if (copyResetTimer) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => { copiedReplayForGame = null; }, 2000);
		} catch (e) { console.error('Failed to copy replay code:', e); }
	}

	async function fetchGames() {
		loading = true;
		error = null;
		try {
			const rows = await fetchGameSummaries();
			if (explorer) [gameRuns, winners, stories] = await Promise.all([fetchGameRuns(), fetchGameWinners(), fetchGameStories()]);
			games = rows
				.map((row) => {
					const guardianAsset = row.winner_guardian ? getGuardianAsset(row.winner_guardian) : null;
					return {
						game_id: row.game_id,
						started_at: row.started_at,
						navigation_count: row.navigation_count,
						player_count: row.player_count,
						ended_at: row.ended_at ?? null,
						total_duration_ms: safeDurationMs(row.started_at, row.ended_at ?? null),
						avg_navigation_ms: row.avg_navigation_ms ?? null,
						winner_guardian: row.winner_guardian ?? null,
						winner_guardian_icon: guardianAsset?.iconUrl ?? null,
						winner_vp: row.winner_vp ?? 0,
						verified: row.verified
					};
				})
				.sort(
					(a, b) =>
						new Date(b.ended_at ?? b.started_at ?? 0).getTime() -
						new Date(a.ended_at ?? a.started_at ?? 0).getTime()
				);
			lastRefresh = new Date();
		} catch (e) {
			console.error('Error fetching games:', e);
			error = e instanceof Error ? e.message : 'Failed to fetch games';
		} finally {
			loading = false;
		}
	}

	let refreshInterval: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		let cancelled = false;
		(async () => {
			await loadAssets();
			if (cancelled) return;
			await fetchGames();
			if (cancelled) return;
			refreshInterval = setInterval(fetchGames, 30000);
		})();
		return () => {
			cancelled = true;
			if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
			if (copyResetTimer) { clearTimeout(copyResetTimer); copyResetTimer = null; }
		};
	});
</script>

<svelte:head>
	<title>Game Records | Arc Spirits Spectate</title>
</svelte:head>

<div class="page" class:explorer>
	<!-- ======= HERO ======= -->
	{#if !explorer}
	<section class="hero">
		<div class="hero-content">
			<div class="hero-eyebrow">SPECTATE</div>
			<h1 class="hero-wordmark">ARC SPIRITS</h1>
			<p class="hero-tagline">FIGHT FOR THE ARCANE ABYSS</p>
			<div class="hero-actions">
				<a href="/admin/leaderboard" class="btn-primary">Hall of Champions</a>
				<a href="/admin/players" class="btn-secondary">Browse Players</a>
			</div>
		</div>
		<div class="hero-emblem" aria-hidden="true">
			<svg viewBox="0 0 320 280" preserveAspectRatio="xMidYMid slice">
				<defs>
					<radialGradient id="portal" cx="50%" cy="50%" r="50%">
						<stop offset="0%" stop-color="#ffd56a"/>
						<stop offset="20%" stop-color="#ff5dd1"/>
						<stop offset="60%" stop-color="#7b1dff"/>
						<stop offset="100%" stop-color="#11091f"/>
					</radialGradient>
					<linearGradient id="silhouette" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="#11091f"/>
						<stop offset="100%" stop-color="#050310"/>
					</linearGradient>
				</defs>
				<rect width="320" height="280" fill="#11091f"/>
				<circle cx="200" cy="120" r="100" fill="url(#portal)" opacity="0.85"/>
				<circle cx="200" cy="120" r="70" fill="none" stroke="rgba(255,43,199,0.35)" stroke-width="1"/>
				<circle cx="200" cy="120" r="50" fill="none" stroke="rgba(255,43,199,0.25)" stroke-width="1"/>
				<rect x="0" y="200" width="320" height="80" fill="url(#silhouette)"/>
				<g fill="#050310">
					<path d="M120 200 Q125 175 132 175 Q139 175 144 200 L144 220 L120 220 Z"/>
					<path d="M155 200 Q160 170 168 170 Q176 170 181 200 L181 220 L155 220 Z"/>
					<path d="M195 200 Q200 168 208 168 Q216 168 221 200 L221 220 L195 220 Z"/>
					<path d="M235 200 Q240 175 248 175 Q256 175 261 200 L261 220 L235 220 Z"/>
				</g>
				<path d="M0 220 L320 220" stroke="rgba(255,43,199,0.3)" stroke-width="1"/>
			</svg>
		</div>
	</section>
	{/if}

	<!-- ======= AT A GLANCE ======= -->
	{#if !explorer}
	<section class="stats-section">
		<div class="stats-header">
			<span class="eyebrow">At a Glance</span>
			<div class="stats-accent"></div>
		</div>
		<div class="icon-strip stats-strip">
			<div>
				<div class="icon-strip-icon">
					<svg viewBox="0 0 24 24"><polygon points="12,3 21,8 21,16 12,21 3,16 3,8" stroke-linejoin="round"/></svg>
				</div>
				<div class="strip-num">{glanceGames().length}</div>
				<div class="icon-strip-label">Recent (Verified)</div>
			</div>
			<div>
				<div class="icon-strip-icon">
					<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round"/></svg>
				</div>
				<div class="strip-num">{totalRounds()}</div>
				<div class="icon-strip-label">Rounds</div>
			</div>
			<div>
				<div class="icon-strip-icon">
					<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5" stroke-linecap="round"/><path d="M14 19c0-2 2-3.5 4-3.5s3 1 3 3" stroke-linecap="round"/></svg>
				</div>
				<div class="strip-num">{totalPlayers()}</div>
				<div class="icon-strip-label">Player Slots</div>
			</div>
			<div>
				<div class="icon-strip-icon">
					<svg viewBox="0 0 24 24"><path d="M3 12h6l3 8 3-16 3 8h3" stroke-linecap="round" stroke-linejoin="round"/></svg>
				</div>
				<div class="strip-num">{formatDurationHoursMinutes(avgDurationMs())}</div>
				<div class="icon-strip-label">Avg Length</div>
			</div>
			<div>
				<div class="icon-strip-icon">
					<svg viewBox="0 0 24 24"><path d="M12 2v6m0 8v6M2 12h6m8 0h6" stroke-linecap="round"/><circle cx="12" cy="12" r="3"/></svg>
				</div>
				<div class="strip-num">{formatDuration(medianTurnDurationMs())}</div>
				<div class="icon-strip-label">Median Turn</div>
			</div>
		</div>
	</section>

	{/if}

	<!-- ======= RECORDS ARCHIVE ======= -->
	<section class="archive-section">
		<div class="archive-head-row">
			<div class="archive-title-block">
				<h2 class="section-title">Game Archive</h2>
				<p class="subhead-meta">
					Browse completed games and open any round.
					{#if lastRefresh}
						<span class="upd"><span class="dot-pulse"></span> Synced {lastRefresh.toLocaleTimeString()}</span>
					{/if}
				</p>
			</div>
			<div class="archive-filters">
				{#if explorer && runs.length > 1}
					<div class="tabs-underline">
						<button class="tab-btn" class:active={runFilter === 'all'} onclick={() => (runFilter = 'all')}>All runs</button>
						{#each runs as run (run)}
							<button class="tab-btn" class:active={runFilter === run} onclick={() => (runFilter = run)}>{runLabel(run)}</button>
						{/each}
					</div>
				{/if}
				<div class="tabs-underline">
					<button class="tab-btn" class:active={verificationFilter === 'verified'} onclick={() => (verificationFilter = 'verified')}>Verified <span class="tab-num">{verifiedCount()}</span></button>
					<button class="tab-btn" class:active={verificationFilter === 'unverified'} onclick={() => (verificationFilter = 'unverified')}>Pending <span class="tab-num">{unverifiedCount()}</span></button>
					<button class="tab-btn" class:active={verificationFilter === 'all'} onclick={() => (verificationFilter = 'all')}>All <span class="tab-num">{games.length}</span></button>
				</div>
				<div class="tabs-underline">
					<button class="tab-btn" class:active={gameFilter === '15plus'} onclick={() => (gameFilter = '15plus')}>{MIN_TURNS_TO_SHOW}+ turns</button>
					<button class="tab-btn" class:active={gameFilter === 'under15'} onclick={() => (gameFilter = 'under15')}>Under {MIN_TURNS_TO_SHOW}</button>
					<button class="tab-btn" class:active={gameFilter === 'all'} onclick={() => (gameFilter = 'all')}>All</button>
				</div>
				{#if explorer}<input bind:value={winnerSearch} placeholder="Winner…" aria-label="Filter by winner" class="winner-search" />{/if}
				<button onclick={fetchGames} disabled={loading} class="btn-ghost" type="button">
					<svg class={loading ? 'spin' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
					</svg>
					Refresh
				</button>
			</div>
		</div>

		{#if loading && games.length === 0}
			<div class="msg"><div class="spin-ring"></div><p>Summoning records from the abyss…</p></div>
		{:else if error}
			<div class="msg msg-error"><h3>The lantern has guttered out</h3><p>{error}</p><button onclick={fetchGames} class="btn-primary">Try Again</button></div>
		{:else if games.length === 0}
			<div class="msg"><h3>No conjurings recorded</h3><p>Game records appear here once players sync from Tabletop Simulator.</p></div>
		{:else if filteredGames().length === 0}
			<div class="msg">
				<h3>No games match this filter</h3>
				<p>
					{#if verificationFilter === 'verified' && verifiedCount() === 0}No verified games yet.
					{:else if verificationFilter === 'unverified' && unverifiedCount() === 0}No unverified games found.
					{:else if gameFilter === '15plus'}No games have reached {MIN_TURNS_TO_SHOW} turns yet.
					{:else if gameFilter === 'under15'}No games are under {MIN_TURNS_TO_SHOW} turns right now.
					{:else}No games found.{/if}
				</p>
			</div>
		{:else}
			<div class="games-table">
				<div class="gt-header">
					<div class="gt-col-winner">Winner</div>
					<div class="gt-col-id">Game</div>
					<div class="gt-col-stat">Rounds</div>
					<div class="gt-col-stat">Players</div>
					<div class="gt-col-stat">Duration</div>
					<div class="gt-col-stat">Avg Nav</div>
					<div class="gt-col-replay">Replay</div>
					<div class="gt-col-status">Status</div>
					<div class="gt-col-action"></div>
				</div>
				{#each filteredGames() as game (game.game_id)}
					<div
						class="gt-row"
						role="link"
						tabindex="0"
						onclick={(e) => handleRowClick(e, game.game_id)}
						onkeydown={(e) => handleRowKeydown(e, game.game_id)}
					>
						<div class="gt-col-winner">
							<div class="winner-portrait">
								{#if game.winner_guardian_icon}
									<img src={game.winner_guardian_icon} alt={game.winner_guardian} loading="lazy" />
								{:else}
									<div class="winner-empty">{explorer && game.winner_guardian ? game.winner_guardian.slice(0, 2) : '—'}</div>
								{/if}
							</div>
							<div class="winner-meta">
								{#if explorer && winners.get(game.game_id)}
									<div class="winner-name" title={winners.get(game.game_id)}>{winners.get(game.game_id)}</div>
									<div class="winner-vp">{game.winner_guardian} · {game.winner_vp} VP</div>
								{:else if game.winner_guardian}
									<div class="winner-name">{game.winner_guardian}</div>
									<div class="winner-vp">{game.winner_vp} VP</div>
								{:else}
									<div class="winner-name dim">No winner</div>
								{/if}
							</div>
						</div>
						<div class="gt-col-id">
							<div class="game-id">{explorer ? game.game_id : shortenGameId(game.game_id)}</div>
							{#if explorer && stories.get(game.game_id)}
								{@const st = stories.get(game.game_id)!}
								<div class="game-date story-line" title={`${st.headline} (${st.luck})`}>{st.headline}{st.luck ? ` · ${st.luck}` : ''}</div>
							{:else}
								<div class="game-date">{game.ended_at ? formatDate(game.ended_at) : '—'}</div>
							{/if}
						</div>
						<div class="gt-col-stat"><span class="stat-num">{game.navigation_count}</span></div>
						<div class="gt-col-stat"><span class="stat-num">{game.player_count}</span></div>
						<div class="gt-col-stat"><span class="stat-num">{formatDurationHoursMinutes(game.total_duration_ms)}</span></div>
						<div class="gt-col-stat"><span class="stat-num">{formatDuration(game.avg_navigation_ms)}</span></div>
						<div class="gt-col-replay">
							<span class="replay-code">{toShortReplayCode(game.navigation_count)}</span>
							<button
								type="button"
								data-no-nav
								onclick={() => copyReplayCode(game.game_id, game.navigation_count)}
								class="text-btn-sm"
								title={`Copy ${toFullReplayCode(game.game_id, game.navigation_count)}`}
							>{copiedReplayForGame === game.game_id ? 'Copied' : 'Copy'}</button>
						</div>
						<div class="gt-col-status">
							<span class="status-tag" class:verified={game.verified}>{game.verified ? 'Verified' : 'Pending'}</span>
						</div>
						<div class="gt-col-action">
							<a href={explorerLinks.game(game.game_id)} class="open-arrow" aria-label="Open game">→</a>
						</div>
					</div>
				{/each}
			</div>

			<div class="archive-foot">Showing <b>{filteredGames().length}</b> of <b>{games.length}</b> chronicles</div>
		{/if}
	</section>

	<!-- ======= FOOTER ======= -->
	{#if !explorer}
	<footer class="page-foot">
		<div>
			<div class="foot-brand">LANTERN <span>LIGHT</span> GAMES</div>
			<div class="foot-tag">We create worlds. You create legends.</div>
		</div>
		<div class="foot-meta">Arc Spirits Spectate · Companion app for Tabletop Simulator</div>
	</footer>
	{/if}
</div>

<style>
	.page {
		max-width: 1280px;
		margin: 0 auto;
		padding: 0 32px 80px;
		position: relative;
		z-index: 1;
	}

	/* Local explorer: one screen. The table scrolls inside its panel, the page does not. */
	.page.explorer {
		height: 100%;
		width: 100%;
		padding-bottom: 10px;
		display: flex;
		flex-direction: column;
	}
	.page.explorer .archive-section { margin: 14px 0 0; flex: 1; min-height: 0; display: flex; flex-direction: column; }
	.page.explorer .archive-head-row { margin-bottom: 0; }
	.page.explorer .section-title { font-size: 2rem; }
	.page.explorer .games-table { margin-top: 12px; flex: 1; min-height: 0; overflow-y: auto; }
	.page.explorer .game-id { max-width: none; overflow: visible; white-space: nowrap; }
	.page.explorer .story-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.page.explorer .gt-col-id { min-width: 0; }
	.page.explorer .winner-search { width: 120px; }
	.page.explorer .open-arrow { padding: 0 !important; }
	.page.explorer .archive-filters { gap: 12px; flex-wrap: nowrap; }
	.page.explorer .gt-header, .page.explorer .gt-row { grid-template-columns: minmax(250px, 1.6fr) minmax(190px, 1.6fr) 60px 60px 80px 80px 120px 70px 24px; }
	.page.explorer .winner-vp { color: var(--dim); }
	.page.explorer .gt-header { position: sticky; top: 0; background: var(--color-void); z-index: 1; }
	.page.explorer .gt-row { padding-top: 8px; padding-bottom: 8px; }
	.page.explorer .archive-foot { margin-top: 8px; }
	.page.explorer .msg { padding: 40px 20px; }

	/* ===== HERO ===== */
	.hero {
		display: grid;
		grid-template-columns: 1fr 420px;
		min-height: 420px;
		background: var(--color-void);
		border-bottom: 1px solid var(--brand-magenta);
		margin: 0 -32px 72px;
		overflow: hidden;
	}
	.hero-content {
		padding: 64px 56px 64px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0;
	}
	.hero-eyebrow {
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.38em;
		color: var(--brand-cyan);
		margin-bottom: 12px;
	}
	.hero-wordmark {
		font-family: var(--font-display);
		font-size: clamp(5rem, 10vw, 8rem);
		line-height: 0.9;
		letter-spacing: 0.02em;
		color: var(--brand-magenta);
		margin: 0;
	}
	.hero-tagline {
		margin: 18px 0 36px;
		font-family: var(--font-display);
		font-size: clamp(1.1rem, 2.2vw, 1.6rem);
		letter-spacing: 0.12em;
		color: var(--brand-amber);
		line-height: 1.2;
	}
	.hero-actions { display: flex; gap: 12px; flex-wrap: wrap; }
	.hero-emblem {
		background: var(--color-shadow);
		display: flex;
		align-items: stretch;
	}
	.hero-emblem svg { width: 100%; height: 100%; display: block; }

	/* ===== STATS SECTION ===== */
	.stats-section { margin-bottom: 72px; }
	.stats-header {
		display: flex;
		align-items: center;
		gap: 20px;
		margin-bottom: 24px;
	}
	.stats-accent {
		flex: 1;
		height: 1px;
		background: var(--color-mist);
	}
	.stats-strip { margin-bottom: 0; }
	.strip-num {
		font-family: var(--font-display);
		font-weight: 400;
		font-size: 2.6rem;
		line-height: 1;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
		margin-top: -4px;
	}

	/* ===== ARCHIVE SECTION ===== */
	.archive-section { margin-bottom: 72px; }
	.section-title {
		font-family: var(--font-display);
		font-size: 3rem;
		line-height: 0.95;
		letter-spacing: 0.02em;
		color: var(--color-bone);
		margin: 0 0 8px;
	}
	.subhead-meta { color: var(--color-fog); font-size: 0.92rem; line-height: 1.55; max-width: 60ch; margin: 0; }
	.subhead-meta em { color: var(--brand-cyan-soft); font-style: italic; font-weight: 500; }

	.archive-head-row {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 28px;
		flex-wrap: wrap;
		margin-bottom: 18px;
	}
	.archive-title-block { min-width: 240px; }
	.archive-filters {
		display: flex;
		gap: 32px;
		flex-wrap: wrap;
		align-items: flex-end;
	}
	.upd {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--color-fog);
		margin-left: 8px;
	}
	.dot-pulse {
		width: 6px; height: 6px;
		background: var(--brand-teal);
		border-radius: 50%;
		box-shadow: 0 0 6px var(--brand-teal);
	}
	.tab-num {
		margin-left: 4px;
		font-family: var(--font-mono);
		font-weight: 500;
		font-size: 0.62rem;
		color: var(--color-whisper);
		letter-spacing: 0;
	}
	.spin { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	/* MESSAGES */
	.msg {
		padding: 80px 24px;
		text-align: center;
		color: var(--color-fog);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}
	.msg h3 { font-family: var(--font-display); font-weight: 400; font-size: 1.8rem; color: var(--color-bone); margin: 0; }
	.msg p { max-width: 50ch; margin: 0; }
	.msg-error h3 { color: var(--color-blood); }
	.spin-ring {
		width: 32px; height: 32px;
		border: 2px solid var(--color-mist);
		border-top-color: var(--brand-magenta);
		border-radius: 50%;
		animation: spin 1s linear infinite;
		margin-bottom: 8px;
	}

	/* GAMES TABLE */
	.games-table {
		margin-top: 24px;
		border-top: 1px solid var(--color-mist);
	}
	.gt-header,
	.gt-row {
		display: grid;
		grid-template-columns: minmax(220px, 1.6fr) minmax(140px, 1.2fr) 80px 80px 100px 100px 130px 100px 40px;
		align-items: center;
		gap: 18px;
		padding: 14px 8px;
		border-bottom: 1px solid var(--color-mist);
	}
	.gt-header {
		font-family: var(--font-display);
		font-weight: 400;
		font-size: 0.6rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
		padding-top: 10px;
		padding-bottom: 10px;
	}
	.gt-row {
		cursor: pointer;
		transition: background 180ms ease;
		outline: none;
	}
	.gt-row:hover,
	.gt-row:focus-visible { background: rgba(255, 43, 199, 0.04); }

	.gt-col-stat { text-align: right; }
	.stat-num { font-family: var(--font-display); font-weight: 400; font-size: 1.1rem; color: var(--color-bone); font-variant-numeric: tabular-nums; }

	.gt-col-winner { display: flex; align-items: center; gap: 12px; min-width: 0; }
	.winner-portrait {
		width: 36px; height: 36px;
		flex: none;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--brand-magenta);
		padding: 1px;
	}
	.winner-portrait img {
		width: 100%; height: 100%;
		object-fit: cover;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		display: block;
	}
	.winner-empty {
		width: 100%; height: 100%;
		display: grid; place-items: center;
		background: var(--color-void);
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		color: var(--color-fog);
		font-size: 0.8rem;
	}
	.winner-meta { min-width: 0; }
	.winner-name {
		font-family: var(--font-display);
		font-weight: 400;
		font-size: 1rem;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.winner-name.dim { color: var(--color-fog); }
	.winner-vp { font-family: var(--font-mono); font-size: 0.7rem; color: var(--brand-amber-soft); margin-top: 2px; }

	.game-id {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--color-bone);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.game-date { font-size: 0.7rem; color: var(--color-fog); margin-top: 2px; }

	.gt-col-replay {
		display: flex;
		align-items: center;
		gap: 8px;
		justify-content: flex-end;
	}
	.replay-code {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--color-bone);
		font-weight: 600;
	}
	.text-btn-sm {
		background: transparent;
		border: 0;
		padding: 0;
		font-family: var(--font-display);
		font-weight: 400;
		font-size: 0.6rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft);
		cursor: pointer;
		transition: color 180ms ease;
	}
	.text-btn-sm:hover { color: var(--brand-magenta); }

	.gt-col-status { text-align: right; }
	.status-tag {
		display: inline-block;
		font-family: var(--font-display);
		font-size: 0.58rem;
		font-weight: 400;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--brand-amber-soft);
	}
	.status-tag.verified { color: var(--brand-teal); }

	.gt-col-action { text-align: right; }
	.open-arrow {
		display: inline-grid;
		place-items: center;
		width: 28px; height: 28px;
		font-size: 1rem;
		color: var(--color-fog);
		text-decoration: none;
		transition: color 180ms ease, transform 180ms ease;
	}
	.gt-row:hover .open-arrow { color: var(--brand-magenta); transform: translateX(2px); }

	.archive-foot {
		margin-top: 28px;
		text-align: center;
		font-size: 0.78rem;
		color: var(--color-fog);
	}
	.archive-foot b { color: var(--color-bone); font-family: var(--font-display); font-weight: 400; font-variant-numeric: tabular-nums; }

	/* PAGE FOOT */
	.page-foot {
		margin-top: 80px;
		padding-top: 36px;
		border-top: 1px solid var(--color-mist);
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
	}
	.foot-brand { font-family: var(--font-display); font-weight: 400; font-size: 1rem; letter-spacing: 0.22em; color: var(--color-bone); }
	.foot-brand span { color: var(--brand-magenta); }
	.foot-tag { margin-top: 4px; color: var(--color-fog); font-size: 0.78rem; }
	.foot-meta { font-size: 0.78rem; color: var(--color-fog); }
	.dim { color: var(--color-fog); }

	@media (max-width: 1024px) {
		.gt-header,
		.gt-row {
			grid-template-columns: minmax(180px, 1.4fr) minmax(120px, 1fr) 60px 60px 90px 130px 36px;
			gap: 12px;
		}
		.gt-header > div:nth-child(6),
		.gt-header > div:nth-child(8),
		.gt-row > div:nth-child(6),
		.gt-row > div:nth-child(8) { display: none; }
	}
	@media (max-width: 720px) {
		.page { padding: 0 22px 60px; }
		.hero {
			grid-template-columns: 1fr;
			margin: 0 -22px 48px;
		}
		.hero-emblem { min-height: 200px; }
		.hero-content { padding: 40px 28px 32px; }
		.hero-wordmark { font-size: clamp(3.5rem, 14vw, 5rem); }
		.archive-head-row { flex-direction: column; align-items: stretch; }
		.gt-header { display: none; }
		.gt-row {
			grid-template-columns: 1fr auto;
			gap: 12px;
			padding: 16px 8px;
		}
		.gt-row > .gt-col-id,
		.gt-row > .gt-col-stat,
		.gt-row > .gt-col-replay,
		.gt-row > .gt-col-status { display: none; }
	}
</style>
