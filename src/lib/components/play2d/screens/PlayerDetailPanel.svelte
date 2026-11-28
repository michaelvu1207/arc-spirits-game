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
		fetchRatingLeaderboard,
		fetchRatingLeaderboardByUsernameKey
	} from '$lib/supabase';
	import { loadAssets, getGuardianAsset, getSpiritAsset } from '$lib/stores/assetStore.svelte';
	import type { FavoriteSpiritEntry, GameResultRow, RatingLeaderboardRow } from '$lib/types';
	import { formatRelative, formatDuration } from '$lib/features/stats/format';
	import {
		winRatePct as calcWinRatePct,
		top4Pct,
		totalPlayTimeMs as calcTotalPlayTimeMs,
		placementDistribution,
		placementColor,
		playerPace,
		ratingOf,
		gameDurationMs,
		type PlayerStats
	} from '$lib/features/player/playerProfile';
	import DetailOverlay from './DetailOverlay.svelte';
	import StatCell from './StatCell.svelte';
	import HexPortrait from './HexPortrait.svelte';
	import StateMessage from './StateMessage.svelte';

	interface Props {
		username: string;
		onClose: () => void;
	}
	let { username, onClose }: Props = $props();

	let stats = $state<PlayerStats | null>(null);
	let games = $state<GameResultRow[]>([]);
	let favoriteSpirits = $state<FavoriteSpiritEntry[]>([]);
	let barrierTotals = $state<{ gained: number; lost: number } | null>(null);
	let bloodTotals = $state<{ gained: number; spent: number } | null>(null);
	let leaderboardRank = $state<number | null>(null);
	let totalRanked = $state(0);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const usernameKey = $derived(username.trim().toLowerCase());
	const displayUsername = $derived(stats?.username ?? username);
	const ratingValue = $derived(ratingOf(stats));
	const winPct = $derived(calcWinRatePct(stats));
	const topHalfPct = $derived(top4Pct(games));
	const totalPlayMs = $derived(calcTotalPlayTimeMs(games));
	const pace = $derived(playerPace(games));
	const dist = $derived(placementDistribution(games));
	const last20 = $derived(games.slice(0, 20));
	const matchHistory = $derived(games.slice(0, 20));

	function formatTotalPlayTime(ms: number): string {
		if (!Number.isFinite(ms) || ms <= 0) return '—';
		const totalMinutes = Math.floor(ms / 60000);
		const minutes = totalMinutes % 60;
		const hours = Math.floor(totalMinutes / 60);
		if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
		return `${minutes}m`;
	}

	onMount(async () => {
		loading = true;
		error = null;
		try {
			await loadAssets();
			const ratingRow = await fetchRatingLeaderboardByUsernameKey(usernameKey);
			let allRanks: RatingLeaderboardRow[] = [];
			try {
				allRanks = await fetchRatingLeaderboard();
			} catch {
				/* ranking is best-effort */
			}
			totalRanked = allRanks.length;
			if (ratingRow) {
				const sorted = [...allRanks].sort(
					(a, b) => (b.ordinal ?? -Infinity) - (a.ordinal ?? -Infinity)
				);
				const idx = sorted.findIndex((r) => r.username_key === ratingRow.username_key);
				leaderboardRank = idx >= 0 ? idx + 1 : null;
			}
			if (ratingRow) {
				const [gameRows, favorites, barrier, blood] = await Promise.all([
					fetchPlayerMatchResultsByUsernameKey(usernameKey),
					fetchPlayerFavoriteSpiritsByUsernameKey(usernameKey),
					fetchPlayerBarrierTotalsByUsernameKey(usernameKey),
					fetchPlayerBloodTotalsByUsernameKey(usernameKey)
				]);
				stats = ratingRow;
				games = gameRows;
				favoriteSpirits = favorites;
				barrierTotals = barrier;
				bloodTotals = blood;
			} else {
				const [statsRow, gameRows, favorites, barrier, blood] = await Promise.all([
					fetchPlayerStatsVerifiedByUsername(username),
					fetchGameResultsVerifiedForUsername(username),
					fetchPlayerFavoriteSpiritsVerified(username),
					fetchPlayerBarrierTotalsVerified(username),
					fetchPlayerBloodTotalsVerified(username)
				]);
				stats = statsRow;
				games = gameRows;
				favoriteSpirits = favorites;
				barrierTotals = barrier;
				bloodTotals = blood;
			}
		} catch (e) {
			console.error('Failed to load player profile:', e);
			error = e instanceof Error ? e.message : 'Failed to load player profile';
		} finally {
			loading = false;
		}
	});
</script>

<DetailOverlay wide eyebrow="Player" title={displayUsername} {onClose}>
	{#if loading}
		<StateMessage compact loading message="Summoning profile…" />
	{:else if error}
		<StateMessage compact tone="error" title="Profile error" message={error} />
	{:else if !stats}
		<StateMessage compact title="No profile yet" message="This user has no verified games recorded." />
	{:else}
		<!-- ── KPI strip ──────────────────────────────────────── -->
		<div class="kpi-strip">
			<StatCell value={stats.games_played} label="Games" size="md" />
			<StatCell value={`${winPct.toFixed(1)}%`} label="Win Rate" size="md" accent="var(--brand-amber-soft)" />
			<StatCell value={`${topHalfPct.toFixed(0)}%`} label="Top Half" size="md" accent="var(--brand-teal)" />
			{#if ratingValue != null}
				<StatCell value={ratingValue.toFixed(1)} label="Rating" size="md" accent="var(--brand-magenta)" />
			{/if}
			{#if leaderboardRank}
				<StatCell
					value={`#${leaderboardRank}`}
					label="Rank"
					size="md"
					sub={totalRanked > 0 ? `of ${totalRanked}` : undefined}
				/>
			{/if}
			{#if totalPlayMs > 0}
				<StatCell value={formatTotalPlayTime(totalPlayMs)} label="Time Played" size="md" />
			{/if}
		</div>

		<!-- ── Last games + placement distribution ────────────── -->
		<section class="panel-block">
			<div class="block-head">
				<span class="block-eyebrow">Form</span>
				<span class="block-rule"></span>
			</div>
			<div class="form-grid">
				<div>
					<div class="sub-title">Last {last20.length} Games</div>
					{#if last20.length === 0}
						<p class="empty-line">No games recorded.</p>
					{:else}
						<div class="placement-squares">
							{#each last20 as g (g.game_id + g.player_color)}
								<span
									class="psq psq-{placementColor(g.placement, g.player_count)}"
									title={`Place ${g.placement} / ${g.player_count}`}>{g.placement}</span
								>
							{/each}
						</div>
					{/if}
				</div>
				<div>
					<div class="sub-title">Placement Distribution</div>
					<div class="dist-chart">
						{#each dist as d (d.place)}
							<div class="dist-col">
								<div class="dist-count">{d.count}</div>
								<div class="dist-bar">
									<div
										class="dist-fill psq-{placementColor(d.place, dist.length)}"
										style:height={`${d.frac * 100}%`}
									></div>
								</div>
								<div class="dist-axis">{d.place}</div>
							</div>
						{/each}
					</div>
				</div>
			</div>
		</section>

		<!-- ── Per-turn performance ───────────────────────────── -->
		<section class="panel-block">
			<div class="block-head">
				<span class="block-eyebrow">Pace &amp; Economy</span>
				<span class="block-rule"></span>
			</div>
			<div class="sub-title">Per-Turn Performance</div>
			<div class="pace-grid">
				<div class="pace-stat">
					<div class="ps-lab">VP / Turn</div>
					<div class="ps-row"><span class="ps-num">{pace.vpPerTurn.mean?.toFixed(2) ?? '—'}</span><span class="ps-tag">avg</span></div>
					<div class="ps-row"><span class="ps-num med">{pace.vpPerTurn.median?.toFixed(2) ?? '—'}</span><span class="ps-tag">median</span></div>
				</div>
				<div class="pace-stat">
					<div class="ps-lab">Time / Turn</div>
					<div class="ps-row"><span class="ps-num">{formatDuration(pace.timePerTurn.mean)}</span><span class="ps-tag">avg</span></div>
					<div class="ps-row"><span class="ps-num med">{formatDuration(pace.timePerTurn.median)}</span><span class="ps-tag">median</span></div>
				</div>
				<div class="pace-stat">
					<div class="ps-lab">Rounds / Game</div>
					<div class="ps-row"><span class="ps-num">{pace.rounds.mean?.toFixed(1) ?? '—'}</span><span class="ps-tag">avg</span></div>
					<div class="ps-row"><span class="ps-num med">{pace.rounds.median?.toFixed(0) ?? '—'}</span><span class="ps-tag">median</span></div>
				</div>
				<div class="pace-stat">
					<div class="ps-lab">VP / Game</div>
					<div class="ps-row"><span class="ps-num">{pace.vp.mean?.toFixed(1) ?? '—'}</span><span class="ps-tag">avg</span></div>
					<div class="ps-row"><span class="ps-num med">{pace.vp.median?.toFixed(0) ?? '—'}</span><span class="ps-tag">median</span></div>
				</div>
				<div class="pace-stat">
					<div class="ps-lab">Game Length</div>
					<div class="ps-row"><span class="ps-num">{formatDuration(pace.duration.mean)}</span><span class="ps-tag">avg</span></div>
					<div class="ps-row"><span class="ps-num med">{formatDuration(pace.duration.median)}</span><span class="ps-tag">median</span></div>
				</div>
				<div class="pace-stat">
					<div class="ps-lab">Resources</div>
					<div class="ps-row"><span class="ps-num"><span class="pos">+{barrierTotals?.gained ?? 0}</span> / <span class="neg">−{barrierTotals?.lost ?? 0}</span></span><span class="ps-tag">barrier</span></div>
					<div class="ps-row"><span class="ps-num"><span class="pos">+{bloodTotals?.gained ?? 0}</span> / <span class="neg">−{bloodTotals?.spent ?? 0}</span></span><span class="ps-tag">broken barrier</span></div>
				</div>
			</div>
		</section>

		<!-- ── Favorite spirits ───────────────────────────────── -->
		{#if favoriteSpirits.length > 0}
			<section class="panel-block">
				<div class="block-head">
					<span class="block-eyebrow">Affinity</span>
					<span class="block-rule"></span>
				</div>
				<div class="sub-title">Favorite Spirits</div>
				<div class="spirit-list">
					{#each favoriteSpirits.slice(0, 8) as s (s.spiritId)}
						{@const asset = getSpiritAsset(s.spiritId)}
						<div class="spirit-chip" title={`${asset?.name ?? s.name} — ${s.games} game${s.games === 1 ? '' : 's'}`}>
							<HexPortrait src={asset?.imageUrl} name={asset?.name ?? s.name} alt={asset?.name ?? s.name} size={36} />
							<div class="spirit-meta">
								<div class="spirit-name">{asset?.name ?? s.name}</div>
								<div class="spirit-games">{s.games} game{s.games === 1 ? '' : 's'}</div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ── Match history ──────────────────────────────────── -->
		<section class="panel-block">
			<div class="block-head">
				<span class="block-eyebrow">Recent Games</span>
				<span class="block-rule"></span>
			</div>
			<div class="sub-title">Match History</div>
			{#if matchHistory.length === 0}
				<p class="empty-line">No games found.</p>
			{:else}
				<div class="mh-list">
					{#each matchHistory as g (g.game_id + g.player_color)}
						{@const asset = getGuardianAsset(g.selected_character)}
						{@const dur = gameDurationMs(g)}
						{@const tpt = dur != null && g.navigation_count > 0 ? dur / g.navigation_count : null}
						{@const vpt = g.navigation_count > 0 ? g.victory_points / g.navigation_count : null}
						<a
							href={`/game/${encodeURIComponent(g.game_id)}`}
							class="mh-row mh-{placementColor(g.placement, g.player_count)}"
						>
							<div class="mh-place">
								<div class="mhp-num">{g.placement}</div>
								<div class="mhp-of">/ {g.player_count}</div>
							</div>
							<HexPortrait src={asset?.iconUrl} name={g.selected_character} alt={g.selected_character} size={42} />
							<div class="mh-info">
								<div class="mh-char">{g.selected_character}</div>
								<div class="mh-meta">{formatRelative(g.ended_at)} · {g.navigation_count} rounds · {formatDuration(dur)}</div>
							</div>
							<div class="mh-stats">
								<div class="mhs"><span class="mhs-n">{g.victory_points}</span><span class="mhs-l">VP</span></div>
								<div class="mhs"><span class="mhs-n">{vpt?.toFixed(2) ?? '—'}</span><span class="mhs-l">VP/turn</span></div>
								<div class="mhs"><span class="mhs-n">{formatDuration(tpt)}</span><span class="mhs-l">time/turn</span></div>
							</div>
							<div class="mh-arrow">→</div>
						</a>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</DetailOverlay>

<style>
	/* ── KPI strip ────────────────────────────────────────── */
	.kpi-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0;
		margin-bottom: 28px;
		padding-bottom: 22px;
		border-bottom: 1px solid var(--color-mist);
	}
	.kpi-strip :global(.cell) {
		padding: 0 24px;
		border-right: 1px solid var(--color-mist);
	}
	.kpi-strip :global(.cell:first-child) {
		padding-left: 0;
	}
	.kpi-strip :global(.cell:last-child) {
		border-right: 0;
	}

	/* ── Block scaffolding ────────────────────────────────── */
	.panel-block {
		margin-bottom: 30px;
	}
	.panel-block:last-child {
		margin-bottom: 0;
	}
	.block-head {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 12px;
	}
	.block-eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.32em;
		text-transform: uppercase;
		color: var(--brand-cyan);
	}
	.block-rule {
		flex: 1;
		height: 1px;
		background: var(--color-mist);
	}
	.sub-title {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--color-bone);
		margin-bottom: 12px;
	}
	.empty-line {
		color: var(--color-fog);
		font-size: 0.85rem;
		margin: 0;
	}

	/* ── Form grid ────────────────────────────────────────── */
	.form-grid {
		display: grid;
		grid-template-columns: 1fr minmax(0, 320px);
		gap: 28px;
		align-items: start;
	}
	.placement-squares {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.psq {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		font-family: var(--font-display);
		font-size: 0.82rem;
		color: var(--color-void);
		font-variant-numeric: tabular-nums;
		border-radius: 4px;
	}
	.psq-p-gold {
		background: var(--brand-amber-soft);
	}
	.psq-p-silver {
		background: var(--color-parchment);
	}
	.psq-p-good {
		background: var(--color-fog);
		color: var(--color-bone);
	}
	.psq-p-bad {
		background: var(--color-mist);
		color: var(--color-parchment);
	}

	.dist-chart {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 6px;
		height: 104px;
		align-items: end;
	}
	.dist-col {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		height: 100%;
	}
	.dist-count {
		font-family: var(--font-display);
		font-size: 0.8rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.dist-bar {
		flex: 1;
		width: 100%;
		display: flex;
		align-items: end;
		min-height: 4px;
	}
	.dist-fill {
		width: 100%;
		min-height: 2px;
		border-radius: 2px 2px 0 0;
	}
	.dist-axis {
		font-family: var(--font-display);
		font-size: 0.8rem;
		color: var(--color-fog);
		font-variant-numeric: tabular-nums;
	}

	/* ── Pace grid ────────────────────────────────────────── */
	.pace-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		border-top: 1px solid var(--color-mist);
		border-left: 1px solid var(--color-mist);
	}
	.pace-stat {
		padding: 14px 16px;
		border-right: 1px solid var(--color-mist);
		border-bottom: 1px solid var(--color-mist);
		background: rgba(20, 12, 36, 0.4);
	}
	.ps-lab {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
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
	.ps-row:last-child {
		margin-bottom: 0;
	}
	.ps-num {
		font-family: var(--font-display);
		font-size: 1.4rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.ps-num.med {
		color: var(--brand-magenta-soft);
		font-size: 1.15rem;
	}
	.ps-tag {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-whisper);
	}
	.pos {
		color: var(--brand-teal);
	}
	.neg {
		color: var(--brand-coral);
	}

	/* ── Favorite spirits ─────────────────────────────────── */
	.spirit-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 10px 18px;
	}
	.spirit-chip {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.spirit-meta {
		min-width: 0;
		flex: 1;
	}
	.spirit-name {
		font-family: var(--font-display);
		font-size: 0.9rem;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.spirit-games {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-fog);
		margin-top: 2px;
	}

	/* ── Match history ────────────────────────────────────── */
	.mh-list {
		border-top: 1px solid var(--color-mist);
	}
	.mh-row {
		position: relative;
		display: grid;
		grid-template-columns: 54px 42px 1fr auto 24px;
		align-items: center;
		gap: 14px;
		padding: 12px 6px 12px 14px;
		border-bottom: 1px solid var(--color-mist);
		border-left: 3px solid transparent;
		text-decoration: none;
		color: inherit;
		transition: background 180ms ease;
	}
	.mh-row::after {
		content: '';
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: 0;
		height: 1px;
		background: var(--gradient-spectrum);
		transform: scaleX(0);
		transform-origin: left;
		opacity: 0.8;
		transition: transform 240ms ease;
	}
	.mh-row:hover,
	.mh-row:focus-visible {
		background: rgba(255, 43, 199, 0.05);
		outline: none;
	}
	.mh-row:hover::after,
	.mh-row:focus-visible::after {
		transform: scaleX(1);
	}
	.mh-p-gold {
		border-left-color: var(--brand-amber-soft);
		background: rgba(255, 213, 106, 0.04);
	}
	.mh-p-silver {
		border-left-color: var(--color-parchment);
	}
	.mh-p-good {
		border-left-color: var(--color-fog);
	}
	.mh-p-bad {
		border-left-color: var(--color-mist);
	}

	.mh-place {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.mhp-num {
		font-family: var(--font-display);
		font-size: 2rem;
		line-height: 1;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.mh-p-gold .mhp-num {
		color: var(--brand-amber-soft);
	}
	.mhp-of {
		font-size: 0.8rem;
		color: var(--color-fog);
		margin-top: 3px;
		letter-spacing: 0.04em;
	}

	.mh-info {
		min-width: 0;
	}
	.mh-char {
		font-family: var(--font-display);
		font-size: 1.1rem;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.mh-meta {
		margin-top: 2px;
		font-size: 0.8rem;
		color: var(--color-fog);
		letter-spacing: 0.04em;
		font-family: var(--font-mono);
	}

	.mh-stats {
		display: flex;
		gap: 20px;
		align-items: baseline;
	}
	.mhs {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
	}
	.mhs-n {
		font-family: var(--font-display);
		font-size: 1.05rem;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.mhs-l {
		font-size: 0.8rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--color-fog);
	}

	.mh-arrow {
		font-size: 1rem;
		color: var(--color-fog);
		transition:
			color 180ms ease,
			transform 180ms ease;
	}
	.mh-row:hover .mh-arrow {
		color: var(--brand-magenta);
		transform: translateX(2px);
	}

	/* ── Responsive ───────────────────────────────────────── */
	@media (max-width: 760px) {
		.form-grid {
			grid-template-columns: 1fr;
			gap: 20px;
		}
	}
	@media (max-width: 600px) {
		.kpi-strip :global(.cell) {
			padding: 0 16px;
		}
		.mh-row {
			grid-template-columns: 46px 38px 1fr 24px;
			gap: 12px;
		}
		.mh-stats {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mh-row,
		.mh-row::after,
		.mh-arrow {
			transition: none;
		}
	}
</style>
