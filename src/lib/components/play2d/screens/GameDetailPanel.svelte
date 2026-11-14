<script lang="ts">
	import { onMount } from 'svelte';
	import DetailOverlay from './DetailOverlay.svelte';
	import HexPortrait from './HexPortrait.svelte';
	import StatCell from './StatCell.svelte';
	import StateMessage from './StateMessage.svelte';
	import { shortenGameId, type RecordGame } from '$lib/features/records/records';
	import { loadGameFinalState, type FinalStanding } from '$lib/features/records/gameDetail';
	import { formatDate, formatDuration, formatDurationHoursMinutes } from '$lib/features/stats/format';
	import { toShortReplayCode } from '$lib/replayCodes';
	import { getGuardianAsset } from '$lib/stores/assetStore.svelte';
	import { LOCAL_EXPLORER, explorerLinks } from '$lib/explorer';

	interface Props {
		game: RecordGame;
		onClose: () => void;
	}

	let { game, onClose }: Props = $props();

	let standings = $state<FinalStanding[]>([]);
	let standingsLoading = $state(true);
	let standingsError = $state(false);

	// Prefer the snapshot-derived #1 standing so the header always agrees with the
	// Final Standings list below. Fall back to the game_summaries winner (which comes
	// from a separate source) while standings load or when they're unavailable.
	const topStanding = $derived(standings.length > 0 ? standings[0] : null);
	const winnerGuardianName = $derived(topStanding ? topStanding.character : game.winnerGuardian);
	const winnerName = $derived(
		topStanding ? (topStanding.username ?? topStanding.character) : (game.winnerGuardian ?? 'No winner')
	);
	const winnerVp = $derived(topStanding ? topStanding.victoryPoints : game.winnerVp);
	const hasWinner = $derived(topStanding != null || game.winnerGuardian != null);
	/** Show the guardian as a secondary tag only when the headline name is a username. */
	const showGuardianTag = $derived(
		!!winnerGuardianName && topStanding?.username != null && topStanding.username !== winnerGuardianName
	);
	const winnerIcon = $derived(
		winnerGuardianName ? (getGuardianAsset(winnerGuardianName)?.iconUrl ?? null) : null
	);

	onMount(() => {
		let cancelled = false;
		(async () => {
			standingsLoading = true;
			standingsError = false;
			try {
				const state = await loadGameFinalState(game.gameId);
				if (cancelled) return;
				standings = state?.standings ?? [];
			} catch (e) {
				if (cancelled) return;
				console.error('Failed to load final standings:', e);
				standingsError = true;
			} finally {
				if (!cancelled) standingsLoading = false;
			}
		})();
		return () => {
			cancelled = true;
		};
	});
</script>

<DetailOverlay eyebrow="Game Record" title={shortenGameId(game.gameId)} {onClose}>
	{#snippet headerActions()}
		<!-- There is no /game/<id> page: the round-by-round viewer exists only in the local
		     explorer. Online, a player opens a replay from Past Games (/replay/<code>). -->
		{#if LOCAL_EXPLORER}
			<a class="full-replay" href={explorerLinks.game(game.gameId)}>
				<span>Full Replay</span>
				<span class="fr-arrow" aria-hidden="true">→</span>
			</a>
		{/if}
	{/snippet}

	<!-- ── Winner summary ─────────────────────────────────────── -->
	<div class="summary">
		<HexPortrait
			src={winnerIcon}
			name={winnerGuardianName ?? ''}
			alt={winnerGuardianName ?? 'No winner'}
			size={64}
			accent="var(--brand-amber)"
		/>
		<div class="summary-text">
			<div class="winner-eyebrow">Winner</div>
			<div class="winner-name" class:dim={!hasWinner}>
				{winnerName}
			</div>
			<div class="summary-meta">
				{#if hasWinner}
					<span class="vp">{winnerVp} VP</span>
					<span class="dot-sep" aria-hidden="true">·</span>
				{/if}
				{#if showGuardianTag}
					<span class="as-guardian">{winnerGuardianName}</span>
					<span class="dot-sep" aria-hidden="true">·</span>
				{/if}
				<span class="status-tag" class:verified={game.verified}>
					{game.verified ? 'Verified' : 'Pending'}
				</span>
				<span class="dot-sep" aria-hidden="true">·</span>
				<span class="when">{formatDate(game.endedAt)}</span>
			</div>
		</div>
	</div>

	<!-- ── Stat strip ─────────────────────────────────────────── -->
	<div class="stat-strip">
		<StatCell value={game.navigationCount} label="Rounds" size="sm" />
		<span class="divider" aria-hidden="true"></span>
		<StatCell value={game.playerCount} label="Players" size="sm" />
		<span class="divider" aria-hidden="true"></span>
		<StatCell
			value={formatDurationHoursMinutes(game.totalDurationMs)}
			label="Duration"
			size="sm"
		/>
		<span class="divider" aria-hidden="true"></span>
		<StatCell value={formatDuration(game.avgNavigationMs)} label="Avg Turn" size="sm" />
		<span class="divider" aria-hidden="true"></span>
		<StatCell
			value={toShortReplayCode(game.navigationCount)}
			label="Replay"
			size="sm"
			accent="var(--brand-cyan)"
		/>
	</div>

	<!-- ── Final standings ────────────────────────────────────── -->
	<section class="standings">
		<div class="section-head">
			<span class="section-eyebrow">Final Standings</span>
			<span class="section-rule" aria-hidden="true"></span>
		</div>

		{#if standingsLoading}
			<StateMessage compact loading message="Reading the final round…" />
		{:else if standingsError}
			<StateMessage
				compact
				title="Standings unavailable"
				message="The final round couldn't be read for this game."
			/>
		{:else if standings.length === 0}
			<StateMessage
				compact
				title="No standings recorded"
				message="No final standings were recorded for this game."
			/>
		{:else}
			<ol class="standings-list">
				{#each standings as s (s.playerColor + s.placement)}
					<li class="standing" class:lead={s.placement === 1}>
						<span class="place">{s.placement}</span>
						<HexPortrait
							src={getGuardianAsset(s.character)?.iconUrl ?? null}
							name={s.character}
							alt={s.character}
							size={38}
							accent={s.placement === 1 ? 'var(--brand-amber)' : 'var(--color-aether)'}
						/>
						<div class="who">
							<div class="username">{s.username ?? s.playerColor}</div>
							<div class="character">{s.character}</div>
						</div>
						<div class="player-stats">
							<div class="ps">
								<span class="ps-num vp">{s.victoryPoints}</span>
								<span class="ps-lbl">VP</span>
							</div>
							<div class="ps">
								<span class="ps-num">{s.barrier}</span>
								<span class="ps-lbl">Barrier</span>
							</div>
							<div class="ps">
								<span class="ps-num">{s.blood}</span>
								<span class="ps-lbl">Broken Barrier</span>
							</div>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</section>
</DetailOverlay>

<style>
	/* ── Header action: full replay link ────────────────────── */
	.full-replay {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 8px 14px;
		border: 1px solid var(--color-mist);
		border-radius: 999px;
		background: linear-gradient(180deg, rgba(255, 43, 199, 0.1), rgba(255, 43, 199, 0.02));
		color: var(--color-parchment);
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		text-decoration: none;
		transition:
			color 160ms ease,
			border-color 160ms ease,
			transform 160ms ease;
	}
	.full-replay:hover,
	.full-replay:focus-visible {
		color: var(--brand-magenta-soft);
		border-color: var(--brand-magenta);
		transform: translateY(-1px);
		outline: none;
	}
	.fr-arrow {
		color: var(--brand-magenta);
	}

	/* ── Winner summary ─────────────────────────────────────── */
	.summary {
		display: flex;
		align-items: center;
		gap: 16px;
		padding-bottom: 20px;
		border-bottom: 1px solid var(--color-mist);
	}
	.summary-text {
		min-width: 0;
	}
	.winner-eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.32em;
		text-transform: uppercase;
		color: var(--brand-amber-soft);
		margin-bottom: 4px;
	}
	.winner-name {
		font-family: var(--font-display);
		font-size: clamp(1.4rem, 5vmin, 1.9rem);
		line-height: 1;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.winner-name.dim {
		color: var(--color-fog);
	}
	.summary-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
		font-size: 0.8rem;
	}
	.summary-meta .vp {
		font-family: var(--font-mono);
		color: var(--brand-amber-soft);
		font-variant-numeric: tabular-nums;
	}
	.summary-meta .as-guardian {
		font-family: var(--font-display);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-parchment);
	}
	.dot-sep {
		color: var(--color-whisper);
	}
	.summary-meta .when {
		font-family: var(--font-mono);
		color: var(--color-fog);
	}

	.status-tag {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--brand-amber-soft);
	}
	.status-tag.verified {
		color: var(--brand-teal);
	}

	/* ── Stat strip ─────────────────────────────────────────── */
	.stat-strip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 14px 18px;
		padding: 20px 0;
		border-bottom: 1px solid var(--color-mist);
	}
	.divider {
		width: 1px;
		align-self: stretch;
		min-height: 30px;
		background: var(--color-mist);
	}

	/* ── Final standings ────────────────────────────────────── */
	.standings {
		margin-top: 22px;
	}
	.section-head {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 14px;
	}
	.section-eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: var(--brand-cyan);
	}
	.section-rule {
		flex: 1;
		height: 1px;
		background: var(--color-mist);
	}

	.standings-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.standing {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 14px;
		border: 1px solid var(--color-mist);
		border-left-width: 2px;
		border-radius: 10px;
		background: linear-gradient(180deg, rgba(46, 29, 82, 0.22), rgba(10, 6, 20, 0.22));
		font-variant-numeric: tabular-nums;
	}
	.standing.lead {
		border-left: 2px solid var(--brand-amber);
		background: linear-gradient(180deg, rgba(255, 186, 61, 0.1), rgba(10, 6, 20, 0.24));
	}
	.place {
		flex: none;
		width: 26px;
		text-align: center;
		font-family: var(--font-display);
		font-size: 1.4rem;
		line-height: 1;
		color: var(--color-fog);
		font-variant-numeric: tabular-nums;
	}
	.standing.lead .place {
		color: var(--brand-amber);
	}
	.who {
		flex: 1;
		min-width: 0;
	}
	.username {
		font-family: var(--font-display);
		font-size: 1rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-bone);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.character {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-fog);
		margin-top: 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.player-stats {
		flex: none;
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.ps {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		min-width: 0;
	}
	.ps-num {
		font-family: var(--font-display);
		font-size: 1.05rem;
		line-height: 1;
		color: var(--color-bone);
		font-variant-numeric: tabular-nums;
	}
	.ps-num.vp {
		color: var(--brand-amber);
	}
	.ps-lbl {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--color-whisper);
	}

	@media (max-width: 520px) {
		.player-stats {
			gap: 12px;
		}
		.ps-lbl {
			font-size: 0.8rem;
		}
		.character {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.full-replay {
			transition: none;
		}
	}
</style>
