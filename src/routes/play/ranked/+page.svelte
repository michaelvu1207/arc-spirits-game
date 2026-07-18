<script lang="ts">
	import GameIcon from '$lib/components/GameIcon.svelte';
	import LowPolySpiritStage from '$lib/components/LowPolySpiritStage.svelte';
	let { data } = $props();
	const season = $derived(
		data.snapshot?.season ?? {
			id: data.leaderboard.seasonId,
			name: data.leaderboard.seasonName ?? 'Ranked Season'
		}
	);
	const self = $derived(data.snapshot?.self ?? null);
	const achievements = $derived(data.snapshot?.achievements ?? []);
</script>

<svelte:head>
	<title>{season.name} | Arc Spirits Ranked</title>
	<meta
		name="description"
		content="Arc Spirits ranked season standings, placements, achievements, and cosmetic rewards."
	/>
</svelte:head>

<main class="ranked-page">
	<nav aria-label="Ranked navigation">
		<a href="/play"><GameIcon name="back" /> Play</a>
		<a href="/account">Account <GameIcon name="account" /></a>
	</nav>
	<header>
		<div class="core">
			<LowPolySpiritStage
				moment="matchmaking"
				guardianName="Season Core"
				accent="#65f3e1"
				compact
			/>
		</div>
		<p class="eyebrow">Competitive path · live games only</p>
		<h1>{season.name}</h1>
		<p>
			Five placements reveal your division. Rating uses conservative OpenSkill (μ − 3σ); confidence
			describes stability, not certainty.
		</p>
	</header>

	{#if data.notice}
		<section
			class="season-notice"
			class:partial={data.available}
			data-testid={data.available ? 'ranked-partial-state' : 'ranked-preseason-state'}
		>
			<div class="notice-icon">
				<GameIcon name={data.available ? 'refresh' : 'ranked'} size={30} />
			</div>
			<div>
				<strong>{data.available ? 'Season data syncing' : 'Between seasons'}</strong>
				<p>{data.notice}</p>
			</div>
			{#if !data.available}
				<div class="notice-actions">
					<a href="/play?action=ranked"><GameIcon name="quick" /> Quick Play</a>
					<a href="/play/champions"><GameIcon name="guardians" /> Hall</a>
				</div>
			{/if}
		</section>
	{/if}

	<section class="grid">
		<article class="card self-card">
			<h2><GameIcon name="account" /> Your season</h2>
			{#if !data.signedIn}<p>
					Start as a guest or sign in to view your season. Guest Quick Play remains casual and
					unrated.
				</p>
			{:else if self}
				<strong class="division"
					>{self.provisional
						? `Placement ${self.placementsCompleted} / ${self.placementsRequired}`
						: self.division?.label}</strong
				>
				<dl>
					<div>
						<dt>Ordinal</dt>
						<dd>{self.ordinal.toFixed(2)}</dd>
					</div>
					<div>
						<dt>Confidence</dt>
						<dd>{self.confidence}%</dd>
					</div>
					<div>
						<dt>Record</dt>
						<dd>{self.wins}–{self.gamesPlayed - self.wins}</dd>
					</div>
					<div>
						<dt>Peak</dt>
						<dd>{self.peakOrdinal.toFixed(2)}</dd>
					</div>
				</dl>
				<h3>Achievements</h3>
				{#if achievements.length}<ul class="achievements">
						{#each achievements as achievement}<li class:unlocked={achievement.unlockedAt}>
								<GameIcon name="achievement" />
								<div>
									<b>{achievement.name}</b><small
										>{achievement.description}{achievement.rewardName
											? ` · Reward: ${achievement.rewardName}`
											: ''}</small
									>
								</div>
								<em>{achievement.progress}/{achievement.target}</em>
							</li>{/each}
					</ul>{:else}<p>Complete a rated match to begin.</p>{/if}
			{:else}<p>Your placement card will appear here when the next season opens.</p>
			{/if}
		</article>

		<article class="card leaderboard">
			<h2><GameIcon name="ranked" /> Leaderboard</h2>
			{#if data.leaderboard.entries.length}
				<ol>
					{#each data.leaderboard.entries as entry}<li>
							<b>{entry.position}</b><span>{entry.displayName}</span><em
								>{entry.provisional ? 'Placement' : entry.division}</em
							><small>{entry.ordinal.toFixed(2)}</small>
						</li>{/each}
				</ol>
			{:else}<p>No placed players yet. First Light is waiting.</p>{/if}
		</article>
	</section>

	{#if data.signedIn && data.history.events.length}
		<section class="card history">
			<h2><GameIcon name="history" /> Rating history</h2>
			<ol>
				{#each data.history.events as event}<li>
						<time>{new Date(event.createdAt).toLocaleDateString()}</time><b>{event.kind}</b><span
							>{event.ordinalBefore.toFixed(2)} → {event.ordinalAfter.toFixed(2)}</span
						>
					</li>{/each}
			</ol>
		</section>
	{/if}
	{#if data.signedIn && data.history.seasons.length}
		<section class="card history">
			<h2><GameIcon name="history" /> Your past seasons</h2>
			<ol>
				{#each data.history.seasons as past}<li>
						<time>{past.seasonName}</time><b>{past.division} · #{past.position}</b><span
							>{past.finalOrdinal.toFixed(2)} final · {past.peakOrdinal.toFixed(2)} peak</span
						>
					</li>{/each}
			</ol>
		</section>
	{/if}
	{#if data.archive.seasons.length}
		<section class="card history" data-testid="ranked-season-archive">
			<h2><GameIcon name="archive" /> Season archive</h2>
			{#each data.archive.seasons as past}<article class="past-season">
					<h3>{past.name}</h3>
					<small
						>{new Date(past.startsAt).toLocaleDateString()} – {new Date(
							past.endsAt
						).toLocaleDateString()}</small
					>
					<ol>
						{#each past.entries.slice(0, 5) as entry}<li>
								<b>#{entry.position}</b><span>{entry.displayName}</span><em>{entry.division}</em
								><small>{entry.finalOrdinal.toFixed(2)}</small>
							</li>{/each}
					</ol>
				</article>{/each}
		</section>
	{/if}
	<p class="integrity">
		Season cosmetics never change gameplay stats. Apple Game Center and Google Play Games are
		optional outbound mirrors; Arc Spirits remains canonical.
	</p>
</main>

<style>
	.ranked-page {
		position: relative;
		z-index: 2;
		min-height: 100dvh;
		padding: max(20px, env(safe-area-inset-top)) clamp(18px, 6vw, 88px)
			max(32px, env(safe-area-inset-bottom));
		color: #f5f0ff;
		background:
			radial-gradient(circle at 50% 12%, rgba(123, 29, 255, 0.23), transparent 34%),
			linear-gradient(180deg, rgba(5, 3, 16, 0.72), #050310 76%);
		font-family: var(--font-body);
	}
	nav {
		display: flex;
		justify-content: space-between;
	}
	a {
		color: #78f2e1;
		text-decoration: none;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-weight: 800;
	}
	header {
		text-align: center;
		max-width: 760px;
		margin: 1rem auto 2.2rem;
	}
	h1,
	h2,
	h3,
	.eyebrow {
		font-family: var(--font-display);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	h1 {
		font-size: clamp(2rem, 6vw, 4.5rem);
		margin: 0.25rem 0;
	}
	.eyebrow {
		color: #78f2e1;
		font-size: 0.72rem;
	}
	.core {
		position: relative;
		width: min(280px, 74vw);
		height: 150px;
		margin: -0.4rem auto -1rem;
	}
	.season-notice {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 1rem;
		max-width: 1180px;
		margin: 0 auto 1rem;
		padding: 1rem 1.2rem;
		border: 1px solid rgba(120, 242, 225, 0.4);
		border-radius: 18px;
		background: rgba(9, 28, 31, 0.86);
	}
	.season-notice.partial {
		border-color: rgba(157, 77, 255, 0.42);
		background: rgba(22, 12, 43, 0.86);
	}
	.season-notice p {
		margin: 0.25rem 0;
		color: #c8c1d7;
	}
	.notice-icon {
		width: 52px;
		height: 52px;
		display: grid;
		place-items: center;
		border-radius: 14px;
		color: #78f2e1;
		background: rgba(120, 242, 225, 0.1);
	}
	.notice-actions {
		display: flex;
		gap: 0.7rem;
	}
	.notice-actions a {
		padding: 0 0.9rem;
		border: 1px solid rgba(120, 242, 225, 0.35);
		border-radius: 12px;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
		gap: 1rem;
		max-width: 1180px;
		margin: auto;
	}
	.card {
		border: 1px solid rgba(139, 92, 255, 0.45);
		border-radius: 20px;
		padding: clamp(1rem, 3vw, 1.6rem);
		background: rgba(11, 6, 28, 0.91);
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.32);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		margin-top: 0;
	}
	.division {
		display: block;
		font-family: var(--font-display);
		font-size: clamp(1.5rem, 4vw, 2.6rem);
		color: #78f2e1;
		margin: 1.2rem 0;
	}
	dl {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.7rem;
	}
	dl div {
		padding: 0.7rem;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.04);
	}
	dt,
	small {
		color: #9f96b4;
		font-size: 0.72rem;
	}
	dd {
		margin: 0.2rem 0 0;
		font-family: var(--font-mono);
	}
	ol,
	ul {
		list-style: none;
		padding: 0;
	}
	.leaderboard li,
	.history li,
	.achievements li {
		display: grid;
		grid-template-columns: 2.4rem 1fr auto auto;
		align-items: center;
		gap: 0.65rem;
		min-height: 46px;
		border-top: 1px solid rgba(255, 255, 255, 0.07);
	}
	em {
		font-style: normal;
		color: #78f2e1;
	}
	.achievements li {
		grid-template-columns: 1.5rem 1fr auto;
	}
	.achievements li div {
		display: grid;
		gap: 0.15rem;
	}
	.achievements li:not(.unlocked) {
		opacity: 0.55;
	}
	.history {
		max-width: 1180px;
		margin: 1rem auto;
	}
	.history li {
		grid-template-columns: 8rem 1fr auto;
	}
	.past-season {
		margin-top: 1rem;
		padding: 1rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 14px;
	}
	.past-season h3 {
		margin: 0;
	}
	.past-season li {
		grid-template-columns: 3rem 1fr auto auto;
	}
	.integrity {
		max-width: 860px;
		margin: 1.5rem auto;
		text-align: center;
		color: #a79dbb;
		font-size: 0.86rem;
	}
	@media (max-width: 760px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.leaderboard li {
			grid-template-columns: 2rem 1fr auto;
		}
		.leaderboard li small {
			display: none;
		}
	}
	@media (max-width: 680px) {
		.season-notice {
			grid-template-columns: auto 1fr;
		}
		.notice-actions {
			grid-column: 1/-1;
			flex-wrap: wrap;
		}
	}

	/* Ranked season presented as a tournament poster, never a card grid. */
	.ranked-page {
		background: #050310;
		overflow: hidden;
	}
	.ranked-page::before,
	.ranked-page::after {
		content: '';
		position: fixed;
		pointer-events: none;
	}
	.ranked-page::before {
		left: -13vw;
		top: 9vh;
		width: 72vw;
		height: 30vh;
		background: #43178f;
		opacity: 0.3;
		clip-path: polygon(0 0, 100% 22%, 72% 100%, 0 68%);
	}
	.ranked-page::after {
		right: -16vw;
		bottom: -10vh;
		width: 66vw;
		height: 38vh;
		background: #087b91;
		opacity: 0.22;
		clip-path: polygon(28% 0, 100% 18%, 100% 100%, 0 100%);
	}
	nav,
	header,
	.season-notice,
	.grid,
	.history,
	.integrity {
		position: relative;
		z-index: 1;
	}
	header {
		text-align: left;
		margin-inline: 0;
	}
	h1 {
		font-size: clamp(3rem, 9vw, 7rem);
		line-height: 0.82;
		color: #fff;
		text-shadow: none;
	}
	.core {
		margin-left: 0;
	}
	.season-notice,
	.season-notice.partial {
		border: 0;
		border-radius: 0;
		background: #087b91;
		clip-path: polygon(0 0, 96% 0, 100% 50%, 96% 100%, 0 100%);
	}
	.season-notice.partial {
		background: #43178f;
	}
	.notice-icon {
		border-radius: 0;
		background: #24d4ff;
		color: #080311;
		clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
	}
	.notice-actions a,
	nav a {
		border: 0;
		border-radius: 0;
		background: #160a34;
		clip-path: polygon(0 0, 91% 0, 100% 50%, 91% 100%, 0 100%);
	}
	.grid {
		gap: 3px;
	}
	.card {
		border: 0;
		border-radius: 0;
		background: #14092f;
		box-shadow: none;
		clip-path: polygon(0 0, 96% 0, 100% 7%, 100% 100%, 0 100%);
	}
	.card:nth-child(even) {
		background: #1e0c45;
	}
	dl div,
	.past-season {
		border: 0;
		border-radius: 0;
		background: #2f1464;
		clip-path: polygon(0 0, 94% 0, 100% 50%, 94% 100%, 0 100%);
	}
	.leaderboard li,
	.history li,
	.achievements li {
		border-top: 3px solid #2f1464;
	}
</style>
