<script lang="ts">
	import { onMount } from 'svelte';
	import {
		fetchGameResultsVerifiedForUsername,
		fetchPlayerBarrierTotalsByUsernameKey,
		fetchPlayerBarrierTotalsVerified,
		fetchPlayerBloodTotalsByUsernameKey,
		fetchPlayerBloodTotalsVerified,
		fetchPlayerFavoriteSpiritsByUsernameKey,
		fetchPlayerFavoriteSpiritsVerified,
		fetchPlayerMatchResultsByUsernameKey,
		fetchPlayerStatsVerifiedByUsername,
		fetchRatingLeaderboardByUsernameKey,
		fetchRatingLeaderboard
	} from '$lib/supabase';
	import { loadAssets, getGuardianAsset, getSpiritAsset } from '$lib/stores/assetStore.svelte';
	import type { FavoriteSpiritEntry, GameResultRow, PlayerStatsRow, RatingLeaderboardRow } from '$lib/types';

	import SpiritInfo from '$lib/components/SpiritInfo.svelte';
	import { SPIRIT_GROUPS, spiritGroup, explorerLinks, fetchAgentProfile, runLabel, type AgentProfile } from '$lib/explorer';

	// `explorer`: the local game explorer shows the profile on one screen; an AI player also
	// has an Agent tab (its model, strategy and notebook).
	interface Props { data: { username: string }; explorer?: boolean }
	let { data, explorer = false }: Props = $props();
	let agent = $state<AgentProfile | null>(null);
	let tab = $state<'stats' | 'agent'>('stats');

	let stats = $state<RatingLeaderboardRow | PlayerStatsRow | null>(null);
	let games = $state<GameResultRow[]>([]);
	let favoriteSpirits = $state<FavoriteSpiritEntry[]>([]);
	let barrierTotals = $state<{ gained: number; lost: number } | null>(null);
	let bloodTotals = $state<{ gained: number; spent: number } | null>(null);
	let leaderboardRank = $state<number | null>(null);
	let totalRanked = $state<number>(0);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const usernameKey = $derived(() => data.username.trim().toLowerCase());
	const displayUsername = $derived(() => stats?.username ?? data.username);
	const ratingValue = $derived(() => (stats && 'ordinal' in stats ? stats.ordinal : null));

	function gameDurationMs(g: GameResultRow): number | null {
		if (!g.started_at || !g.ended_at) return null;
		const s = Date.parse(g.started_at);
		const e = Date.parse(g.ended_at);
		if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
		return e - s;
	}

	function median(values: number[]): number | null {
		if (values.length === 0) return null;
		const s = [...values].sort((a, b) => a - b);
		const m = Math.floor(s.length / 2);
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	}

	function mean(values: number[]): number | null {
		if (values.length === 0) return null;
		return values.reduce((a, b) => a + b, 0) / values.length;
	}

	const last20 = $derived(() => games.slice(0, 20));

	const totalPlayTimeMs = $derived(() =>
		games.reduce((sum, g) => sum + (gameDurationMs(g) ?? 0), 0)
	);

	const placementDistribution = $derived(() => {
		const max = Math.max(0, ...games.map((g) => g.player_count ?? 4));
		const buckets = max > 0 ? max : 8;
		const counts = new Array(buckets).fill(0);
		for (const g of games) {
			const p = Math.max(1, Math.min(buckets, g.placement));
			counts[p - 1] += 1;
		}
		const peak = Math.max(1, ...counts);
		return counts.map((c, i) => ({ place: i + 1, count: c, frac: c / peak }));
	});

	const winRatePct = $derived(() => {
		if (!stats) return 0;
		if ('win_rate' in stats && stats.win_rate != null) return stats.win_rate * 100;
		const wp = stats.wins / Math.max(1, stats.games_played);
		return wp * 100;
	});

	const top4Pct = $derived(() => {
		if (games.length === 0) return 0;
		return (games.filter((g) => g.placement <= Math.ceil(g.player_count / 2)).length / games.length) * 100;
	});

	const pace = $derived(() => {
		const vpPerTurn = games
			.filter((g) => g.navigation_count > 0)
			.map((g) => g.victory_points / g.navigation_count);
		const timePerTurnMs = games
			.map((g) => {
				const d = gameDurationMs(g);
				return d != null && g.navigation_count > 0 ? d / g.navigation_count : null;
			})
			.filter((v): v is number => v != null);
		const rounds = games.map((g) => g.navigation_count).filter((v) => v > 0);
		const vp = games.map((g) => g.victory_points);
		const placement = games.map((g) => g.placement);
		const durations = games.map((g) => gameDurationMs(g)).filter((v): v is number => v != null);

		return {
			vpPerTurn: { mean: mean(vpPerTurn), median: median(vpPerTurn) },
			timePerTurn: { mean: mean(timePerTurnMs), median: median(timePerTurnMs) },
			rounds: { mean: mean(rounds), median: median(rounds) },
			vp: { mean: mean(vp), median: median(vp) },
			placement: { mean: mean(placement), median: median(placement) },
			duration: { mean: mean(durations), median: median(durations) }
		};
	});

	function formatTimestamp(t: string | null): string {
		if (!t) return '—';
		const d = new Date(t);
		if (Number.isNaN(d.getTime())) return String(t);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}
	function formatRelative(t: string | null): string {
		if (!t) return '—';
		const d = Date.parse(t);
		if (Number.isNaN(d)) return '—';
		const diff = Date.now() - d;
		const mins = Math.round(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.round(hrs / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.round(days / 30);
		return `${months}mo ago`;
	}
	function formatDuration(ms: number | null): string {
		if (ms == null || !Number.isFinite(ms)) return '—';
		const totalSeconds = Math.floor(ms / 1000);
		const seconds = totalSeconds % 60;
		const totalMinutes = Math.floor(totalSeconds / 60);
		const minutes = totalMinutes % 60;
		const hours = Math.floor(totalMinutes / 60);
		if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
		if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
		return `${seconds}s`;
	}
	function formatTotalPlayTime(ms: number): { value: string; label: string } {
		if (!Number.isFinite(ms) || ms <= 0) return { value: '—', label: 'Time Played' };
		const totalMinutes = Math.floor(ms / 60000);
		const minutes = totalMinutes % 60;
		const hours = Math.floor(totalMinutes / 60);
		if (hours > 0) return { value: `${hours}h ${String(minutes).padStart(2, '0')}m`, label: 'Time Played' };
		return { value: `${minutes}m`, label: 'Time Played' };
	}
	function placementColor(p: number, total: number): string {
		if (p === 1) return 'p-gold';
		if (p === 2) return 'p-silver';
		if (p <= Math.ceil(total / 2)) return 'p-good';
		return 'p-bad';
	}
	function initials(name: string): string {
		const parts = name.split(/\s+/);
		if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
		return name.slice(0, 2).toUpperCase();
	}

	onMount(async () => {
		loading = true;
		error = null;
		try {
			await loadAssets();
			const ratingRow = await fetchRatingLeaderboardByUsernameKey(usernameKey());
			let allRanks: RatingLeaderboardRow[] = [];
			try { allRanks = await fetchRatingLeaderboard(); } catch {}
			if (explorer) agent = await fetchAgentProfile(usernameKey()).catch(() => null);
			totalRanked = allRanks.length;
			if (ratingRow) {
				const sorted = [...allRanks].sort((a, b) => (b.ordinal ?? -Infinity) - (a.ordinal ?? -Infinity));
				const idx = sorted.findIndex((r) => r.username_key === ratingRow.username_key);
				leaderboardRank = idx >= 0 ? idx + 1 : null;
			}
			if (ratingRow) {
				const [gameRows, favorites, barrier, blood] = await Promise.all([
					fetchPlayerMatchResultsByUsernameKey(usernameKey()),
					fetchPlayerFavoriteSpiritsByUsernameKey(usernameKey()),
					fetchPlayerBarrierTotalsByUsernameKey(usernameKey()),
					fetchPlayerBloodTotalsByUsernameKey(usernameKey())
				]);
				stats = ratingRow; games = gameRows; favoriteSpirits = favorites; barrierTotals = barrier; bloodTotals = blood;
			} else {
				const [statsRow, gameRows, favorites, barrier, blood] = await Promise.all([
					fetchPlayerStatsVerifiedByUsername(data.username),
					fetchGameResultsVerifiedForUsername(data.username),
					fetchPlayerFavoriteSpiritsVerified(data.username),
					fetchPlayerBarrierTotalsVerified(data.username),
					fetchPlayerBloodTotalsVerified(data.username)
				]);
				stats = statsRow; games = gameRows; favoriteSpirits = favorites; barrierTotals = barrier; bloodTotals = blood;
			}
		} catch (e) {
			console.error('Failed to load player profile:', e);
			error = e instanceof Error ? e.message : 'Failed to load player profile';
		} finally { loading = false; }
	});
</script>

<svelte:head>
	<title>{displayUsername()} | Arc Spirits Spectate</title>
</svelte:head>

<div class="page" class:explorer>
	<a href={explorerLinks.players()} class="back-link">← All Players</a>

	{#if loading}
		<div class="msg"><div class="spin-ring"></div><p>Summoning profile…</p></div>
	{:else if error}
		<div class="msg msg-error"><h3>Profile error</h3><p>{error}</p></div>
	{:else if !stats}
		<div class="msg"><h3>No profile yet</h3><p>This user has no verified games recorded.</p></div>
	{:else}
		<!-- HERO BLOCK -->
		<div class="profile-hero">
			<div class="hero-left">
				<div class="hex-frame-lg">
					<div class="hex-init">{initials(displayUsername())}</div>
				</div>
			</div>
			<div class="hero-body">
				<div class="hero-eyebrow">Player</div>
				<h1 class="hero-username">{displayUsername()}</h1>
				<div class="hero-stats-row">
					<div class="hero-stat">
						<div class="hero-stat-num">{stats.games_played}</div>
						<div class="hero-stat-lab">Games</div>
					</div>
					<div class="hero-stat">
						<div class="hero-stat-num win">{winRatePct().toFixed(1)}%</div>
						<div class="hero-stat-lab">Win Rate</div>
					</div>
					<div class="hero-stat">
						<div class="hero-stat-num pos">{top4Pct().toFixed(0)}%</div>
						<div class="hero-stat-lab">Top Half</div>
					</div>
					{#if ratingValue() != null}
						<div class="hero-stat">
							<div class="hero-stat-num mag">{ratingValue()!.toFixed(1)}</div>
							<div class="hero-stat-lab">Rating</div>
						</div>
					{/if}
					{#if leaderboardRank}
						<div class="hero-stat">
							<div class="hero-stat-num">#{leaderboardRank}</div>
							<div class="hero-stat-lab">Rank</div>
						</div>
					{/if}
					{#if totalPlayTimeMs() > 0}
						<div class="hero-stat">
							<div class="hero-stat-num">{formatTotalPlayTime(totalPlayTimeMs()).value}</div>
							<div class="hero-stat-lab">Time Played</div>
						</div>
					{/if}
				</div>
			</div>
		</div>

		{#if agent}
			<div class="tabs-underline agent-tabs">
				<button class="tab-btn" class:active={tab === 'stats'} onclick={() => (tab = 'stats')}>Stats</button>
				<button class="tab-btn" class:active={tab === 'agent'} onclick={() => (tab = 'agent')}>Agent</button>
			</div>
		{/if}

		{#if agent && tab === 'agent'}
			<div class="agent-panel">
				<div class="agent-line">{agent.model} {agent.effort} · {runLabel(agent.run)}</div>
				{#if agent.strategy}
					<div class="agent-head">Strategy</div>
					<pre class="agent-text">{agent.strategy}</pre>
				{/if}
				{#if agent.notebook}
					<div class="agent-head">Notebook</div>
					<pre class="agent-text">{agent.notebook}</pre>
				{/if}
			</div>
		{:else}
		<div class="profile-grid">
			<!-- ============ LEFT RAIL ============ -->
			<aside class="rail">
				{#if leaderboardRank}
					<div class="rail-section rail-rank-block">
						<div class="rail-sub">Standing</div>
						<div class="rank-display">
							<span class="rank-hash">#</span><span class="rank-big">{leaderboardRank}</span>
						</div>
						{#if totalRanked > 0}
							<div class="rank-pct">Top {Math.max(0.1, (leaderboardRank / totalRanked) * 100).toFixed(1)}% of {totalRanked}</div>
						{/if}
					</div>
				{/if}

				<div class="rail-section">
					<div class="rail-sub">Summary</div>
					<div class="rail-summary">
						<div>
							<div class="rs-num">{pace().placement.mean?.toFixed(2) ?? '—'}</div>
							<div class="rs-lab">Avg Place</div>
							<div class="rs-meta">{stats.games_played} games</div>
						</div>
						<div>
							<div class="rs-num pos">{top4Pct().toFixed(0)}%</div>
							<div class="rs-lab">Top Half</div>
							<div class="rs-meta">{games.filter((g) => g.placement <= Math.ceil(g.player_count / 2)).length} games</div>
						</div>
						<div>
							<div class="rs-num win">{winRatePct().toFixed(1)}%</div>
							<div class="rs-lab">Win Rate</div>
							<div class="rs-meta">{stats.wins} wins</div>
						</div>
					</div>
				</div>

				{#if ratingValue() != null}
					<div class="rail-section rail-rating">
						<div class="rail-sub">OpenSkill Rating</div>
						<div class="rating-value">{ratingValue()!.toFixed(1)}</div>
					</div>
				{/if}

				{#if favoriteSpirits.length > 0}
					<div class="rail-section">
						<div class="rail-sub">Favorite Spirits</div>
						{#each explorer ? SPIRIT_GROUPS : [null] as g (g?.id ?? '')}
						{@const list = g ? favoriteSpirits.filter((s) => { const a = getSpiritAsset(s.spiritId); return spiritGroup(a?.cost ?? 0, a?.traits?.origins?.length ?? 0) === g.id; }).slice(0, 5) : favoriteSpirits.slice(0, 7)}
						{#if g && list.length > 0}<div class="rail-group">{g.label}</div>{/if}
						<div class="rail-spirits">
							{#each list as s (s.spiritId)}
								{@const asset = getSpiritAsset(s.spiritId)}
								<div class="rs-chip" title={`${asset?.name ?? s.name} — ${s.games} game${s.games === 1 ? '' : 's'}`}>
									<div class="rsc-portrait">
										{#if asset?.imageUrl}
											<img src={asset.imageUrl} alt={asset.name} loading="lazy" />
										{:else}
											<div class="rsc-empty">{(asset?.name ?? s.name ?? '??').slice(0, 2)}</div>
										{/if}
									</div>
									<div class="rsc-meta">
										<div class="rsc-name">{asset?.name ?? s.name}{#if explorer}<SpiritInfo id={s.spiritId} name={asset?.name ?? s.name} />{/if}</div>
										<div class="rsc-games">{#if explorer && asset?.traits.classes.length}{asset.traits.classes.map((c) => c.name).join(', ')} · {/if}{s.games} game{s.games === 1 ? '' : 's'}</div>
									</div>
								</div>
							{/each}
						</div>
						{/each}
					</div>
				{/if}
			</aside>

			<!-- ============ MAIN ============ -->
			<main class="main">
				<!-- Last 20 + Distribution + KPIs -->
				<section class="head-strip">
					<div class="hs-block">
						<div class="hs-title">Last {last20().length} Games</div>
						<div class="placement-squares">
							{#each last20() as g (g.game_id + g.player_color)}
								<span class="psq psq-{placementColor(g.placement, g.player_count)}" title={`Game ${g.game_id} — Place ${g.placement} / ${g.player_count}`}>{g.placement}</span>
							{/each}
						</div>

						<div class="hs-title with-margin">Placement Distribution</div>
						<div class="dist-chart">
							{#each placementDistribution() as d (d.place)}
								<div class="dist-bar-wrap">
									<div class="dist-count">{d.count}</div>
									<div class="dist-bar">
										<div class="dist-fill psq-{placementColor(d.place, placementDistribution().length)}" style:height={`${d.frac * 100}%`}></div>
									</div>
									<div class="dist-axis">{d.place}</div>
								</div>
							{/each}
						</div>
					</div>

					<div class="hs-kpis">
						<div class="hs-kpi">
							<div class="hsk-num">{pace().placement.mean?.toFixed(2) ?? '—'}</div>
							<div class="hsk-lab">Avg Place</div>
							<div class="hsk-sub">Median {pace().placement.median?.toFixed(1) ?? '—'}</div>
						</div>
						<div class="hs-kpi">
							<div class="hsk-num pos">{top4Pct().toFixed(1)}%</div>
							<div class="hsk-lab">Top Half Rate</div>
							<div class="hsk-sub">of {games.length} games</div>
						</div>
						<div class="hs-kpi">
							<div class="hsk-num win">{winRatePct().toFixed(1)}%</div>
							<div class="hsk-lab">Win Rate</div>
							<div class="hsk-sub">{stats.wins} 1st place</div>
						</div>
					</div>
				</section>

				<!-- PACE & ECONOMY -->
				<div class="section-block">
					<div class="section-block-header">
						<span class="eyebrow">Pace &amp; Economy</span>
						<div class="section-rule"></div>
					</div>
					<h2 class="section-block-title">Per-Turn Performance</h2>
					<p class="section-block-desc">Mean and median across all verified games. Time-per-turn requires both start and end timestamps to compute.</p>
				</div>

				<div class="pace-grid">
					<div class="pace-stat">
						<div class="ps-lab">VP / Turn</div>
						<div class="ps-row"><span class="ps-num">{pace().vpPerTurn.mean?.toFixed(2) ?? '—'}</span><span class="ps-tag">avg</span></div>
						<div class="ps-row"><span class="ps-num med">{pace().vpPerTurn.median?.toFixed(2) ?? '—'}</span><span class="ps-tag">median</span></div>
					</div>
					<div class="pace-stat">
						<div class="ps-lab">Time / Turn</div>
						<div class="ps-row"><span class="ps-num">{formatDuration(pace().timePerTurn.mean)}</span><span class="ps-tag">avg</span></div>
						<div class="ps-row"><span class="ps-num med">{formatDuration(pace().timePerTurn.median)}</span><span class="ps-tag">median</span></div>
					</div>
					<div class="pace-stat">
						<div class="ps-lab">Rounds / Game</div>
						<div class="ps-row"><span class="ps-num">{pace().rounds.mean?.toFixed(1) ?? '—'}</span><span class="ps-tag">avg</span></div>
						<div class="ps-row"><span class="ps-num med">{pace().rounds.median?.toFixed(0) ?? '—'}</span><span class="ps-tag">median</span></div>
					</div>
					<div class="pace-stat">
						<div class="ps-lab">VP / Game</div>
						<div class="ps-row"><span class="ps-num">{pace().vp.mean?.toFixed(1) ?? '—'}</span><span class="ps-tag">avg</span></div>
						<div class="ps-row"><span class="ps-num med">{pace().vp.median?.toFixed(0) ?? '—'}</span><span class="ps-tag">median</span></div>
					</div>
					<div class="pace-stat">
						<div class="ps-lab">Game Length</div>
						<div class="ps-row"><span class="ps-num">{formatDuration(pace().duration.mean)}</span><span class="ps-tag">avg</span></div>
						<div class="ps-row"><span class="ps-num med">{formatDuration(pace().duration.median)}</span><span class="ps-tag">median</span></div>
					</div>
					<div class="pace-stat">
						<div class="ps-lab">Resources</div>
						<div class="ps-row"><span class="ps-num"><span class="pos">+{barrierTotals?.gained ?? 0}</span> / <span class="neg">−{barrierTotals?.lost ?? 0}</span></span><span class="ps-tag">barrier</span></div>
						<div class="ps-row"><span class="ps-num"><span class="pos">+{bloodTotals?.gained ?? 0}</span> / <span class="neg">−{bloodTotals?.spent ?? 0}</span></span><span class="ps-tag">broken barrier</span></div>
					</div>
				</div>

				<!-- RECENT GAMES -->
				<div class="section-block">
					<div class="section-block-header">
						<span class="eyebrow">Recent Games</span>
						<div class="section-rule"></div>
					</div>
					<h2 class="section-block-title">Match History</h2>
					<p class="section-block-desc">Latest verified games for this binder.</p>
				</div>

				{#if games.length === 0}
					<div class="msg"><p>No games found.</p></div>
				{:else}
					<div class="rg-list">
						{#each games.slice(0, 25) as g (g.game_id + g.player_color)}
							{@const asset = getGuardianAsset(g.selected_character)}
							{@const dur = gameDurationMs(g)}
							{@const tpt = dur && g.navigation_count > 0 ? dur / g.navigation_count : null}
							{@const vpt = g.navigation_count > 0 ? g.victory_points / g.navigation_count : null}
							<a href={explorerLinks.game(g.game_id, `?player=${encodeURIComponent(g.player_color)}`)} class="rg-row rg-{placementColor(g.placement, g.player_count)}">
								<div class="rg-place">
									<div class="rgp-num">{g.placement}</div>
									<div class="rgp-of">/ {g.player_count}</div>
								</div>
								<div class="rg-portrait">
									{#if asset?.iconUrl}
										<img src={asset.iconUrl} alt={g.selected_character} loading="lazy" />
									{:else}
										<div class="rg-portrait-empty">{g.selected_character.slice(0, 2)}</div>
									{/if}
								</div>
								<div class="rg-info">
									<div class="rg-char">{g.selected_character}</div>
									<div class="rg-meta">{formatRelative(g.ended_at)} · {g.navigation_count} rounds · {formatDuration(dur)}</div>
								</div>
								<div class="rg-stats">
									<div class="rgs"><span class="rgs-n">{g.victory_points}</span><span class="rgs-l">VP</span></div>
									<div class="rgs"><span class="rgs-n">{vpt?.toFixed(2) ?? '—'}</span><span class="rgs-l">VP/turn</span></div>
									<div class="rgs"><span class="rgs-n">{formatDuration(tpt)}</span><span class="rgs-l">time/turn</span></div>
								</div>
								<div class="rg-arrow">→</div>
							</a>
						{/each}
					</div>
				{/if}
			</main>
		</div>
		{/if}
	{/if}
</div>

<style>
	.page { max-width: 1320px; margin: 0 auto; padding: 36px 32px 80px; position: relative; z-index: 1; }
	.back-link {
		display: inline-flex; align-items: center; gap: 6px;
		font-family: var(--font-display); font-size: 0.66rem;
		letter-spacing: 0.18em;
		color: var(--brand-magenta-soft); text-decoration: none;
		margin-bottom: 32px;
	}
	.back-link:hover { color: var(--brand-magenta); }

	/* ===== PROFILE HERO ===== */
	/* Local explorer: one screen. The hero stays, the rest scrolls inside its panel. */
	.page.explorer { height: 100%; width: 100%; padding: 12px 32px 0; display: flex; flex-direction: column; }
	.page.explorer .back-link { margin-bottom: 10px; }
	.page.explorer .profile-hero { padding: 16px 32px; margin-bottom: 12px; flex: none; }
	.page.explorer .hero-username { font-size: 2.6rem; }
	.page.explorer .hero-stat-num { font-size: 1.8rem; }
	.page.explorer .profile-grid,
	.page.explorer .agent-panel { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 16px; }
	.rail-group { margin: 10px 0 4px; font-size: 12px; color: var(--color-fog); }
	.agent-tabs { align-self: flex-start; margin-bottom: 14px; flex: none; }
	.agent-line { font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-fog); }
	.agent-head {
		margin: 18px 0 6px;
		font-family: var(--font-display); font-size: 0.66rem; letter-spacing: 0.22em;
		text-transform: uppercase; color: var(--color-fog);
	}
	.agent-text {
		margin: 0; max-width: 90ch; white-space: pre-wrap;
		font-family: var(--font-body); font-size: 0.9rem; line-height: 1.55; color: var(--color-parchment);
	}

	.profile-hero {
		display: flex;
		gap: 32px;
		align-items: center;
		background: var(--color-tomb);
		border-bottom: 3px solid var(--brand-magenta);
		padding: 40px 40px 36px;
		margin: 0 -32px 48px;
	}
	.hero-left { flex: none; }
	.hex-frame-lg {
		width: 100px; height: 100px;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--brand-magenta);
		padding: 2px;
	}
	.hex-init {
		width: 100%; height: 100%;
		display: grid; place-items: center;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--color-void);
		font-family: var(--font-display);
		font-size: 2rem;
		color: var(--color-bone);
	}
	.hero-body { flex: 1; min-width: 0; }
	.hero-eyebrow {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.36em;
		color: var(--brand-cyan);
		margin-bottom: 6px;
	}
	.hero-username {
		font-family: var(--font-display);
		font-size: clamp(3rem, 6vw, 5rem);
		line-height: 0.9;
		letter-spacing: 0.01em;
		color: var(--color-bone);
		margin: 0 0 20px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hero-stats-row {
		display: flex;
		gap: 0;
		flex-wrap: wrap;
	}
	.hero-stat {
		padding: 0 28px;
		border-right: 1px solid var(--color-mist);
	}
	.hero-stat:first-child { padding-left: 0; }
	.hero-stat:last-child { border-right: 0; }
	.hero-stat-num {
		font-family: var(--font-display);
		font-size: 2.8rem;
		line-height: 1;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.hero-stat-num.win { color: var(--brand-amber-soft); }
	.hero-stat-num.pos { color: var(--brand-teal); }
	.hero-stat-num.mag { color: var(--brand-magenta); }
	.hero-stat-lab {
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.24em;
		color: var(--color-fog);
		margin-top: 6px;
	}

	/* ===== PROFILE GRID ===== */
	.profile-grid {
		display: grid;
		grid-template-columns: 260px 1fr;
		gap: 36px;
		align-items: flex-start;
	}

	/* ===== LEFT RAIL ===== */
	.rail {
		position: sticky;
		top: calc(var(--app-topbar-height) + 16px);
		display: flex;
		flex-direction: column;
		gap: 0;
		background: var(--color-tomb);
		border: 1px solid var(--color-mist);
	}
	.rail-section {
		padding: 20px;
		border-bottom: 1px solid var(--color-mist);
	}
	.rail-section:last-child { border-bottom: 0; }
	.rail-sub {
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.32em;
		color: var(--color-fog);
		margin-bottom: 12px;
	}

	/* Rank display */
	.rail-rank-block { }
	.rank-display {
		display: flex;
		align-items: baseline;
		gap: 2px;
		line-height: 1;
		margin-bottom: 6px;
	}
	.rank-hash {
		font-family: var(--font-display);
		font-size: 1.8rem;
		color: var(--brand-magenta);
	}
	.rank-big {
		font-family: var(--font-display);
		font-size: 3.5rem;
		color: var(--brand-magenta);
		font-variant-numeric: tabular-nums;
	}
	.rank-pct { font-size: 0.72rem; color: var(--brand-amber-soft); font-family: var(--font-mono); }

	.rail-summary {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 0;
	}
	.rail-summary > div {
		text-align: center;
		padding: 0 4px;
		border-right: 1px solid var(--color-mist);
	}
	.rail-summary > div:last-child { border-right: 0; }
	.rs-num {
		font-family: var(--font-display);
		font-size: 1.4rem;
		line-height: 1;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.rs-num.win { color: var(--brand-amber-soft); }
	.rs-num.pos { color: var(--brand-teal); }
	.rs-lab { margin-top: 6px; font-size: 0.52rem; letter-spacing: 0.2em; color: var(--color-fog); }
	.rs-meta { margin-top: 2px; font-size: 0.6rem; color: var(--color-whisper); font-family: var(--font-mono); }

	.rail-rating { text-align: center; }
	.rating-value {
		font-family: var(--font-display);
		font-size: 3rem;
		color: var(--brand-magenta);
		font-variant-numeric: tabular-nums;
		line-height: 1;
		margin-top: 4px;
	}

	.rail-spirits { display: flex; flex-direction: column; gap: 0; }
	.rs-chip {
		display: flex; gap: 10px; align-items: center;
		padding: 10px 0;
		border-bottom: 1px solid var(--color-mist);
	}
	.rs-chip:last-child { border-bottom: 0; }
	.rsc-portrait {
		width: 36px; height: 36px;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--brand-magenta);
		padding: 1px;
		flex: none;
	}
	.rsc-portrait img { width: 100%; height: 100%; object-fit: cover; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); }
	.rsc-empty {
		width: 100%; height: 100%;
		display: grid; place-items: center;
		background: var(--color-void);
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		font-size: 0.65rem;
		color: var(--color-parchment);
	}
	.rsc-meta { min-width: 0; flex: 1; }
	.rsc-name {
		font-family: var(--font-display);
		font-size: 0.88rem;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.rsc-games { font-family: var(--font-mono); font-size: 0.66rem; color: var(--color-fog); margin-top: 2px; }

	/* ===== MAIN ===== */
	.main { min-width: 0; display: flex; flex-direction: column; gap: 0; }

	/* Head strip */
	.head-strip {
		display: grid;
		grid-template-columns: 1fr 220px;
		gap: 24px;
		padding: 24px;
		background: var(--color-tomb);
		border: 1px solid var(--color-mist);
		margin-bottom: 36px;
	}
	.hs-block { min-width: 0; }
	.hs-title {
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.22em;
		color: var(--color-bone);
		margin-bottom: 12px;
	}
	.hs-title.with-margin { margin-top: 22px; }

	.placement-squares { display: flex; flex-wrap: wrap; gap: 4px; }
	.psq {
		width: 28px; height: 28px;
		display: grid; place-items: center;
		font-family: var(--font-display);
		font-size: 0.88rem;
		color: var(--color-void);
		font-variant-numeric: tabular-nums;
		border-radius: 4px;
	}
	.psq-p-gold { background: var(--brand-amber-soft); }
	.psq-p-silver { background: var(--color-parchment); }
	.psq-p-good { background: var(--color-fog); color: var(--color-bone); }
	.psq-p-bad { background: var(--color-mist); color: var(--color-parchment); }

	.dist-chart {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 6px;
		height: 110px;
		align-items: end;
	}
	.dist-bar-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; }
	.dist-count { font-family: var(--font-display); font-size: 0.7rem; color: var(--color-bone); font-variant-numeric: tabular-nums; }
	.dist-bar { flex: 1; width: 100%; display: flex; align-items: end; min-height: 4px; }
	.dist-fill { width: 100%; min-height: 2px; border-radius: 2px 2px 0 0; }
	.dist-axis { font-family: var(--font-display); font-size: 0.6rem; color: var(--color-fog); font-variant-numeric: tabular-nums; }

	.hs-kpis {
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding-left: 24px;
		border-left: 1px solid var(--color-mist);
	}
	.hs-kpi { display: flex; flex-direction: column; gap: 2px; }
	.hsk-num {
		font-family: var(--font-display);
		font-size: 2.5rem;
		line-height: 1;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.hsk-num.win { color: var(--brand-amber-soft); }
	.hsk-num.pos { color: var(--brand-teal); }
	.hsk-lab { margin-top: 4px; font-size: 0.58rem; letter-spacing: 0.22em; color: var(--color-bone); }
	.hsk-sub { font-size: 0.65rem; color: var(--color-fog); font-family: var(--font-mono); margin-top: 2px; }

	/* Section block headers */
	.section-block {
		margin: 36px 0 18px;
	}
	.section-block-header {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 8px;
	}
	.section-rule { flex: 1; height: 1px; background: var(--color-mist); }
	.section-block-title {
		font-family: var(--font-display);
		font-size: 2.4rem;
		line-height: 0.95;
		letter-spacing: 0.02em;
		color: var(--color-bone);
		margin: 0 0 6px;
	}
	.section-block-desc { color: var(--color-fog); font-size: 0.88rem; line-height: 1.55; max-width: 60ch; margin: 0; }

	/* Pace grid */
	.pace-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0;
		border-top: 1px solid var(--color-mist);
		border-left: 1px solid var(--color-mist);
		margin-bottom: 0;
	}
	.pace-stat {
		padding: 16px 18px;
		border-right: 1px solid var(--color-mist);
		border-bottom: 1px solid var(--color-mist);
		background: var(--color-tomb);
	}
	.ps-lab {
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.22em;
		color: var(--color-fog);
		margin-bottom: 10px;
	}
	.ps-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 4px;
	}
	.ps-row:last-child { margin-bottom: 0; }
	.ps-num {
		font-family: var(--font-display);
		font-size: 1.5rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.ps-num.med { color: var(--brand-magenta-soft); font-size: 1.2rem; }
	.ps-num .pos { color: var(--brand-teal); }
	.ps-num .neg { color: var(--color-blood); }
	.ps-tag { font-family: var(--font-display); font-size: 0.52rem; letter-spacing: 0.22em; color: var(--color-whisper); }
	.pos { color: var(--brand-teal); }
	.neg { color: var(--color-blood); }

	/* Recent games */
	.rg-list { border-top: 1px solid var(--color-mist); }
	.rg-row {
		display: grid;
		grid-template-columns: 60px 48px 1fr auto 28px;
		align-items: center;
		gap: 16px;
		padding: 14px 8px 14px 16px;
		border-bottom: 1px solid var(--color-mist);
		text-decoration: none;
		color: inherit;
		transition: background 180ms ease;
		border-left: 3px solid transparent;
	}
	.rg-row:hover { background: rgba(255, 43, 199, 0.04); }
	.rg-p-gold { border-left-color: var(--brand-amber-soft); background: rgba(255, 213, 106, 0.04); }
	.rg-p-silver { border-left-color: var(--color-parchment); }
	.rg-p-good { border-left-color: var(--color-fog); }
	.rg-p-bad { border-left-color: var(--color-mist); }

	.rg-place { display: flex; flex-direction: column; align-items: center; }
	.rgp-num {
		font-family: var(--font-display);
		font-size: 2.2rem;
		line-height: 1;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.rg-p-gold .rgp-num { color: var(--brand-amber-soft); }
	.rgp-of { font-size: 0.6rem; color: var(--color-fog); margin-top: 4px; letter-spacing: 0.04em; }

	.rg-portrait {
		width: 44px; height: 44px;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--brand-magenta);
		padding: 1.5px;
	}
	.rg-portrait img { width: 100%; height: 100%; object-fit: cover; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); }
	.rg-portrait-empty {
		width: 100%; height: 100%;
		display: grid; place-items: center;
		background: var(--color-void);
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		font-family: var(--font-display);
		color: var(--color-parchment);
		font-size: 0.7rem;
	}

	.rg-info { min-width: 0; }
	.rg-char {
		font-family: var(--font-display);
		font-size: 1.15rem;
		color: var(--color-bone);
	}
	.rg-meta { margin-top: 2px; font-size: 0.7rem; color: var(--color-fog); letter-spacing: 0.04em; }

	.rg-stats { display: flex; gap: 24px; align-items: baseline; }
	.rgs { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
	.rgs-n {
		font-family: var(--font-display);
		font-size: 1.1rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.rgs-l { font-size: 0.52rem; letter-spacing: 0.2em; color: var(--color-fog); }

	.rg-arrow { font-size: 1rem; color: var(--color-fog); transition: color 180ms ease, transform 180ms ease; }
	.rg-row:hover .rg-arrow { color: var(--brand-magenta); transform: translateX(2px); }

	/* Common */
	.msg { padding: 80px 24px; text-align: center; color: var(--color-fog); display: flex; flex-direction: column; align-items: center; gap: 12px; }
	.msg h3 { font-family: var(--font-display); font-size: 2rem; color: var(--color-bone); margin: 0; }
	.msg p { max-width: 50ch; margin: 0; }
	.msg-error h3 { color: var(--color-blood); }
	.spin-ring { width: 32px; height: 32px; border: 2px solid var(--color-mist); border-top-color: var(--brand-magenta); border-radius: 50%; animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 1000px) {
		.profile-grid { grid-template-columns: 1fr; gap: 24px; }
		.rail { position: static; flex-direction: row; flex-wrap: wrap; gap: 0; }
		.rail-section { flex: 1; min-width: 200px; }
		.head-strip { grid-template-columns: 1fr; gap: 18px; }
		.hs-kpis { flex-direction: row; padding-left: 0; padding-top: 18px; border-left: 0; border-top: 1px solid var(--color-mist); justify-content: space-between; }
	}
	@media (max-width: 720px) {
		.page { padding: 24px 18px 60px; }
		.profile-hero { flex-direction: column; align-items: flex-start; gap: 16px; padding: 28px 18px; margin: 0 -18px 32px; }
		.hero-username { font-size: clamp(2.4rem, 10vw, 3.5rem); }
		.hero-stat-num { font-size: 2rem; }
		.rg-row { grid-template-columns: 50px 40px 1fr 24px; gap: 12px; }
		.rg-stats { display: none; }
	}
</style>
