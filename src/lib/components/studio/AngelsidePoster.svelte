<script lang="ts">
	import BellVideo from './BellVideo.svelte';

	// The ANGELSIDE studio homepage. The name fills the width at the top in an
	// extra-wide heavy face, on a band of blur that fades out toward the bell.
	const year = new Date().getFullYear();
</script>

<svelte:head>
	<link
		rel="stylesheet"
		href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;800&family=Unbounded:wght@600;900&display=swap"
	/>
</svelte:head>

<div class="poster" data-testid="studio-home" data-hydrated="true">
	<div class="scene"><BellVideo position="50% 50%" /></div>
	<div class="band" aria-hidden="true"></div>

	<header class="ui">
		<h1><span class="name">Angelside</span> <span class="studios">Studios</span></h1>
		<p class="line">We make Arc Spirits, a strategy game about summoning spirits.</p>
	</header>

	<main class="ui low">
		<nav aria-label="Main menu">
			<a class="play" href="/game" data-testid="studio-play-arc-spirits">Play Arc Spirits</a>
			<a href="/play/champions">Hall of Guardians</a>
			<a href="/account">Sign in</a>
		</nav>
		<p class="legal">© {year} Angelside Studios</p>
	</main>
</div>

<style>
	.poster {
		--paper: #ffffff;
		--gold: #ffc861;
		--dusk: 20, 22, 34;
		position: fixed;
		inset: 0;
		z-index: 60;
		overflow: hidden;
		background: rgb(var(--dusk));
		color: var(--paper);
		font-family: 'Manrope', system-ui, sans-serif;
	}
	.scene {
		position: absolute;
		inset: 0;
	}
	/* Blur that is full strength at the top and fades to nothing. */
	.band {
		position: absolute;
		inset: 0 0 auto 0;
		height: 52vh;
		pointer-events: none;
		background: linear-gradient(180deg, rgba(var(--dusk), 0.62), rgba(var(--dusk), 0));
		backdrop-filter: blur(26px) saturate(1.2);
		-webkit-backdrop-filter: blur(26px) saturate(1.2);
		-webkit-mask: linear-gradient(180deg, #000 0%, #000 46%, transparent 100%);
		mask: linear-gradient(180deg, #000 0%, #000 46%, transparent 100%);
	}

	.ui {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding-inline: 16px;
		animation: settle 1.6s ease 0.2s both;
	}
	header.ui {
		top: calc(clamp(54px, 8.5vh, 92px) + env(safe-area-inset-top));
	}
	.low {
		bottom: calc(clamp(18px, 4vh, 40px) + env(safe-area-inset-bottom));
	}

	h1 {
		margin: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		font-family: 'Unbounded', 'Arial Black', sans-serif;
		font-weight: 900;
		font-size: min(10.6vw, 21vh);
		line-height: 0.92;
		letter-spacing: -0.035em;
		text-transform: uppercase;
	}
	.studios {
		margin-top: 0.34em;
		font-size: max(0.17em, 0.8rem);
		font-weight: 600;
		line-height: 1;
		letter-spacing: 0.9em;
		/* Optical centring: tracking adds space after the last letter. */
		margin-right: -0.9em;
	}
	.line {
		margin: clamp(12px, 2.2vh, 22px) 0 0;
		max-width: 30em;
		font-size: clamp(1rem, 1.3vw, 1.25rem);
		font-weight: 600;
		line-height: 1.45;
	}

	nav {
		display: inline-flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 6px;
		padding: 8px;
		border: 1px solid rgba(255, 255, 255, 0.22);
		border-radius: 999px;
		background: rgba(var(--dusk), 0.46);
		backdrop-filter: blur(28px) saturate(1.3);
		-webkit-backdrop-filter: blur(28px) saturate(1.3);
	}
	nav a {
		padding: 16px 30px;
		border-radius: 999px;
		font-size: 1.06rem;
		font-weight: 800;
		letter-spacing: -0.005em;
		color: var(--paper);
		text-decoration: none;
		transition: background 200ms ease;
	}
	nav a:hover {
		background: rgba(255, 255, 255, 0.16);
	}
	nav a.play {
		background: #fff;
		color: #14151d;
	}
	nav a.play:hover {
		background: var(--gold);
	}
	nav a:focus-visible {
		outline: 3px solid var(--gold);
		outline-offset: 2px;
	}
	.legal {
		margin: 12px 0 0;
		font-size: 0.82rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.7);
	}

	@keyframes settle {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@media (max-width: 560px) {
		nav {
			border-radius: 30px;
		}
		nav a {
			padding: 15px 14px;
			text-align: center;
			white-space: nowrap;
		}
		nav a.play {
			flex: 1 0 100%;
		}
		nav a:not(.play) {
			flex: 1 1 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ui {
			animation: none;
		}
		nav a {
			transition: none;
		}
	}
</style>
