<script lang="ts">
	import data from '$lib/play/sim/bot-stats.json';

	const counts = data.counts as number[];
	const groups = [...new Set(data.strategies.map((s) => s.group))];

	type Strat = (typeof data.strategies)[number];
	const wr = (s: Strat, c: number) => s.byCount[String(c) as keyof typeof s.byCount]?.winRate ?? 0;
	const rounds = (s: Strat, c: number) =>
		s.byCount[String(c) as keyof typeof s.byCount]?.avgWinRound ?? null;
	const pct = (x: number) => Math.round(100 * x);

	// Colour a win% by strength: solo (1p) on absolute reach-30, multiplayer on beating the
	// 1/N "fair share" of a Medium field. Keeps the grid scannable at a glance.
	function tone(x: number, players: number): 'good' | 'mid' | 'low' {
		if (players === 1) return x >= 0.7 ? 'good' : x >= 0.4 ? 'mid' : 'low';
		const fair = 1 / players;
		return x >= fair * 1.35 ? 'good' : x >= fair * 0.7 ? 'mid' : 'low';
	}

	function verdict(s: Strat): { tag: string; tone: 'good' | 'mid' | 'low' } {
		const two = wr(s, 2);
		const four = wr(s, 4);
		const six = wr(s, 6);
		// Strong = clears 1.3× fair share at a higher player count.
		if (four >= 1.3 / 4 || six >= 1.3 / 6) return { tag: 'Strong', tone: 'good' };
		if (four < 0.6 / 4 && two < 0.6 / 2) return { tag: 'Weak', tone: 'low' };
		return { tag: 'Viable', tone: 'mid' };
	}

	const stratsByGroup = (g: string) => data.strategies.filter((s) => s.group === g);
</script>

<svelte:head><title>Bot Stats | Arc Spirits Spectate</title></svelte:head>

<div class="page">
	<header class="head">
		<div class="eyebrow">STRATEGY LAB</div>
		<h1 class="title">Bot Stats</h1>
		<p class="sub">
			Win rate = how often a strategy reaches <b>30 VP first</b> against a field of the standard
			<b>Medium</b> bot, from {data.gamesPerCell} self-play games per cell. Boss damage is
			<b>{data.ladder.damage[data.ladder.damage.length - 1]}</b>. Generated offline.
		</p>
		<a class="cta" href="/admin/bot-stats/curves">VP curves over rounds →</a>
	</header>

	<!-- KEY TAKEAWAYS — the decisions, up front -->
	<section class="insights">
		<div class="insight">
			<div class="insight-k">PvP</div>
			<div class="insight-t">The <b>Evil-hunter line dominates at 4+ players</b> — corrupt to Fallen, then camp the Rest chokepoint for <b>PvP VP every round</b>. It loses heads-up (2P) and stalls if everyone copies it.</div>
		</div>
		<div class="insight">
			<div class="insight-k">≥7</div>
			<div class="insight-t"><b>Potential ≥ 7</b> (= the boss's damage) to survive the climb — pot 5 wins only ~5%. On the slower one-action-per-round economy, over-building to 10 isn't punished; 5–6 also works with an "attack at the same time" spirit.</div>
		</div>
		<div class="insight">
			<div class="insight-k">0</div>
			<div class="insight-t">Win rate with <b>no potential at all</b> — potential is mandatory in some amount; below ~5 you can't survive the climb.</div>
		</div>
	</section>

	<!-- PER-STRATEGY GRID -->
	{#each groups as g (g)}
		<section class="grp">
			<div class="grp-head"><h2>{g}</h2><div class="grp-line"></div></div>
			<div class="tbl">
				<div class="tr th">
					<div class="c-name">Strategy</div>
					{#each counts as c (c)}
						<div class="c-stat">{c}P</div>
					{/each}
					<div class="c-verdict">Verdict</div>
				</div>
				{#each stratsByGroup(g) as s (s.key)}
					{@const v = verdict(s)}
					<div class="tr">
						<div class="c-name">
							<span class="s-label">{s.label}</span>
							<span class="s-blurb">{s.blurb}</span>
						</div>
						{#each counts as c (c)}
							<div class="c-stat">
								<span class="wr wr-{tone(wr(s, c), c)}">{pct(wr(s, c))}%</span>
								{#if c === 4 && rounds(s, c) != null}
									<span class="spd">{rounds(s, c)?.toFixed(0)} rds</span>
								{/if}
							</div>
						{/each}
						<div class="c-verdict"><span class="chip chip-{v.tone}">{v.tag}</span></div>
					</div>
				{/each}
			</div>
		</section>
	{/each}

	<p class="foot">{data.note}</p>
</div>

<style>
	.page { max-width: 1100px; margin: 0 auto; padding: 40px 32px 80px; }

	.head { margin-bottom: 36px; }
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.38em;
		color: var(--brand-cyan);
		margin-bottom: 10px;
	}
	.title {
		font-family: var(--font-display);
		font-size: clamp(2.6rem, 6vw, 4rem);
		line-height: 0.95;
		color: var(--brand-magenta);
		margin: 0 0 14px;
	}
	.sub { color: var(--color-fog); font-size: 0.92rem; line-height: 1.6; max-width: 70ch; margin: 0; }
	.sub b { color: var(--color-bone); font-weight: 400; }
	.cta {
		display: inline-block;
		margin-top: 16px;
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--brand-cyan);
		text-decoration: none;
		border-bottom: 1px solid transparent;
		transition: border-color 0.12s ease;
	}
	.cta:hover { border-color: var(--brand-cyan); }

	/* INSIGHTS */
	.insights {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 16px;
		margin-bottom: 48px;
	}
	.insight {
		background: var(--color-shadow);
		border: 1px solid var(--color-mist);
		border-left: 3px solid var(--brand-magenta);
		padding: 18px 20px;
		display: flex;
		gap: 16px;
		align-items: flex-start;
	}
	.insight-k {
		font-family: var(--font-display);
		font-size: 2.4rem;
		line-height: 1;
		color: var(--brand-amber);
		flex: none;
		font-variant-numeric: tabular-nums;
	}
	.insight-t { color: var(--color-fog); font-size: 0.82rem; line-height: 1.5; }
	.insight-t b { color: var(--color-bone); font-weight: 400; }

	/* GROUPS */
	.grp { margin-bottom: 40px; }
	.grp-head { display: flex; align-items: center; gap: 18px; margin-bottom: 14px; }
	.grp-head h2 {
		font-family: var(--font-display);
		font-size: 1.4rem;
		letter-spacing: 0.06em;
		color: var(--color-bone);
		margin: 0;
		white-space: nowrap;
	}
	.grp-line { flex: 1; height: 1px; background: var(--color-mist); }

	/* TABLE */
	.tbl { border-top: 1px solid var(--color-mist); }
	.tr {
		display: grid;
		grid-template-columns: minmax(220px, 2fr) repeat(4, 80px) 120px;
		align-items: center;
		gap: 14px;
		padding: 12px 8px;
		border-bottom: 1px solid var(--color-mist);
	}
	.th {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
	}
	.c-stat { text-align: right; }
	.th .c-stat, .th .c-verdict { text-align: right; }
	.th .c-name { text-align: left; }

	.s-label {
		display: block;
		font-family: var(--font-display);
		font-size: 1rem;
		color: var(--color-bone);
	}
	.s-blurb { display: block; font-size: 0.74rem; color: var(--color-fog); margin-top: 2px; }

	.wr {
		font-family: var(--font-display);
		font-size: 1.15rem;
		font-variant-numeric: tabular-nums;
		display: block;
	}
	.wr-good { color: var(--brand-teal); }
	.wr-mid { color: var(--color-bone); }
	.wr-low { color: var(--color-fog); opacity: 0.65; }
	.spd { display: block; font-family: var(--font-mono); font-size: 0.62rem; color: var(--color-fog); margin-top: 1px; }

	.c-verdict { text-align: right; }
	.chip {
		display: inline-block;
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		padding: 4px 10px;
		border: 1px solid currentColor;
		border-radius: 2px;
	}
	.chip-good { color: var(--brand-teal); }
	.chip-mid { color: var(--brand-amber-soft); }
	.chip-low { color: var(--color-blood); }

	.foot { margin-top: 32px; font-size: 0.74rem; color: var(--color-fog); line-height: 1.5; max-width: 80ch; }

	@media (max-width: 720px) {
		.page { padding: 28px 18px 60px; }
		.insights { grid-template-columns: 1fr; }
		.tr { grid-template-columns: minmax(140px, 1.6fr) repeat(4, 1fr) ; }
		.c-verdict { display: none; }
	}
</style>
