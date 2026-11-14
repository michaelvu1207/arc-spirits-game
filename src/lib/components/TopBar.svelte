<script lang="ts">
	import { page } from '$app/stores';
	import AccountWidget from './AccountWidget.svelte';
</script>

{#if !$page.url.pathname.endsWith('/export')}
	{@const pathname = $page.url.pathname}
	{@const isImmersivePlay = /^\/play\/[^/]+$/.test(pathname)}
	{@const isAccount = pathname === '/account'}
	{@const isPlay = pathname.startsWith('/play')}
	{@const isAdmin = pathname.startsWith('/admin')}
	{@const isRecords = pathname.startsWith('/admin/records')}
	{@const isLeaderboard = pathname.startsWith('/admin/leaderboard') || pathname.startsWith('/admin/players')}
	{@const isStats =
		pathname.startsWith('/admin/stats') && !pathname.startsWith('/admin/stats-analysis')}
	{@const isGamesAdmin = pathname.startsWith('/admin/games')}

	{#if !isImmersivePlay && !isAccount}
	<header class="screen-only topbar">
		<div class="spectrum-line"></div>
		<div class="topbar-inner">
			<a href="/game" class="brand">
				<span class="lantern" aria-hidden="true">
					<img src="/favicon.png" alt="" width="44" height="44" />
				</span>
				<div class="brand-text">
					<div class="brand-eyebrow">Angelside Studios</div>
					<div class="brand-title">ARC <span>SPIRITS</span> Spectate</div>
				</div>
			</a>

			<div class="nav-wrap">
				<nav class="nav">
					<a href="/play" class="nav-link" class:active={isPlay} aria-current={isPlay ? 'page' : undefined}>
						<span class="nav-dot"></span>Play
					</a>

					{#if $page.data.isAdmin}
						<a href="/admin/records" class="nav-link" class:active={isRecords} aria-current={isRecords ? 'page' : undefined}>
							<span class="nav-dot"></span>Records
						</a>
						<a href="/admin/leaderboard" class="nav-link" class:active={isLeaderboard} aria-current={isLeaderboard ? 'page' : undefined}>
							<span class="nav-dot"></span>Leaderboard
						</a>
						<a href="/admin/stats" class="nav-link" class:active={isStats} aria-current={isStats ? 'page' : undefined}>
							<span class="nav-dot"></span>Stats
						</a>
						<a href="/admin/games" class="nav-link" class:active={isGamesAdmin} aria-current={isGamesAdmin ? 'page' : undefined}>
							<span class="nav-dot"></span>Games
						</a>
					{/if}
				</nav>

				{#if $page.data.isAdmin}
					<div class="admin-pill" title="You are viewing as admin">
						<span class="admin-dot"></span>Admin
					</div>
				{/if}

				<AccountWidget />
			</div>
		</div>
	</header>
	{/if}
{/if}

<style>
	.topbar {
		position: sticky;
		top: 0;
		z-index: 50;
		background: var(--color-shadow);
		border-bottom: 1px solid var(--color-mist);
	}

	.spectrum-line {
		height: 3px;
		background: var(--brand-magenta);
	}

	.topbar-inner {
		max-width: 1280px;
		margin: 0 auto;
		padding: 14px 28px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		min-height: var(--app-topbar-height);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 14px;
		text-decoration: none;
		color: inherit;
		min-width: 0;
	}

	.lantern {
		flex: none;
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		border-radius: 4px;
		overflow: hidden;
		background: var(--color-shadow);
	}

	.lantern img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.brand-text { min-width: 0; }
	.brand-eyebrow {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: var(--color-fog);
	}
	.brand-title {
		font-family: var(--font-display);
		font-size: 1.6rem;
		letter-spacing: 0.04em;
		color: var(--brand-magenta);
		line-height: 1;
		white-space: nowrap;
	}
	.brand-title span {
		color: var(--color-bone);
	}

	.nav-wrap {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.nav {
		display: inline-flex;
		gap: 2px;
	}

	.nav-link {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 8px 18px;
		font-family: var(--font-display);
		font-size: 0.9rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-fog);
		text-decoration: none;
		transition: color 180ms ease;
		position: relative;
	}

	.nav-link:hover {
		color: var(--color-bone);
	}

	.nav-link.active {
		color: var(--color-bone);
	}

	.nav-link.active::after {
		content: '';
		position: absolute;
		bottom: 0;
		left: 18px;
		right: 18px;
		height: 2px;
		background: var(--brand-magenta);
	}

	.nav-dot {
		width: 4px;
		height: 4px;
		background: var(--brand-magenta);
		transform: rotate(45deg);
		flex-shrink: 0;
		opacity: 0;
	}

	.nav-link.active .nav-dot {
		opacity: 1;
	}

	.admin-pill {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		background: var(--brand-cyan);
		color: var(--color-void);
		font-family: var(--font-display);
		font-size: 0.75rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		border-radius: 2px;
	}

	.admin-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-void);
	}

	@media (max-width: 720px) {
		.topbar-inner { flex-direction: column; align-items: flex-start; gap: 10px; }
		.brand-title { font-size: 1.3rem; }
		.nav-wrap { width: 100%; justify-content: space-between; }
	}
</style>
