<script lang="ts">
	// Test runs: every tested rule set (40-point rules) against the four checks, the games of the
	// chosen run seat by seat, and the newest run's games scored with other payouts. Left: the
	// runs and the re-scoring table. Right: the chosen run's games; each opens round by round.
	import { onMount } from 'svelte';
	import LineChart from '$lib/components/explorer/LineChart.svelte';
	import { fetchBalance, type BalanceData, type BalanceRun, type BalanceRunSeat } from '$lib/explorerBalance';

	const REFRESH_MS = 60_000;
	const SEAT_COLOR: Record<string, string> = { Red: '#f0616d', Blue: '#6aa5ff', Orange: '#f0a03c', Green: '#4ecb8f' };
	const FALLBACK = ['var(--accent)', 'var(--text)', '#6aa5ff', '#4ecb8f'];

	let data = $state<BalanceData | null>(null);
	let error = $state<string | null>(null);
	let chosen = $state<string | null>(null);
	let table = $state<string>('all');

	// Newest first.
	const runs = $derived([...(data?.runs ?? [])].reverse());
	const tables = $derived([...new Set(runs.map((r) => r.table))]);
	const shown = $derived(runs.filter((r) => table === 'all' || r.table === table));
	const run = $derived<BalanceRun | null>(shown.find((r) => r.id === chosen) ?? shown[0] ?? null);
	const games = $derived((data?.run_games ?? []).filter((g) => g.run === run?.id));
	const newest = $derived(runs[0] ?? null);

	async function load() {
		try {
			data = await fetchBalance();
			error = null;
		} catch (e) {
			if (!data) error = e instanceof Error ? e.message : 'Failed to load the balance data.';
		}
	}
	onMount(() => {
		void load();
		const timer = setInterval(load, REFRESH_MS);
		return () => clearInterval(timer);
	});

	/** "astra62-medium-a" → "Astra A"; "opus55-medium" → "Opus". */
	function agentName(agent: string): string {
		const [model, , letter] = agent.split('-');
		const name = (model ?? agent).replace(/\d+$/, '');
		return `${name.charAt(0).toUpperCase()}${name.slice(1)}${letter ? ` ${letter.toUpperCase()}` : ''}`;
	}
	const color = (s: BalanceRunSeat, i: number) => SEAT_COLOR[s.seat] ?? FALLBACK[i % FALLBACK.length];
	const dash = (v: number | null | undefined) => (v == null ? '–' : String(v));
	function curve(seats: BalanceRunSeat[]) {
		const n = Math.max(0, ...seats.map((s) => s.points_by_round.length));
		return Array.from({ length: n }, (_, i) => {
			const row: Record<string, number | null> = { round: i + 1 };
			seats.forEach((s, k) => (row[`s${k}`] = s.points_by_round[i] ?? null));
			return row;
		});
	}
</script>

<svelte:head><title>Test runs · Arc Spirits</title></svelte:head>

<div class="page">
	{#if error}
		<div class="msg">{error}</div>
	{:else if !data}
		<div class="msg">Loading…</div>
	{:else if !runs.length}
		<div class="msg">No test runs in the balance data yet.</div>
	{:else}
		<div class="top">
			<section class="card runs">
				<div class="head">
					<div class="title">Tested rule sets, newest first. Choose one to see its games.</div>
					<div class="seg">
						<button class:on={table === 'all'} onclick={() => (table = 'all')}>All tables</button>
						{#each tables as t (t)}<button class:on={table === t} onclick={() => (table = t)}>{t}</button>{/each}
					</div>
				</div>
				<div class="table-wrap">
					<table class="data-table">
						<thead>
							<tr class="thead-row">
								<th class="th">What changed</th>
								<th class="th">Table</th>
								<th class="th num">Games</th>
								<th class="th num">End round<br /><span class="goal">20 to 30</span></th>
								<th class="th num">First to last<br /><span class="goal">10 or less</span></th>
								<th class="th num">Monsters / spirits / attacks<br /><span class="goal">70 / 10 / 20, within 5</span></th>
								<th class="th num">Pools left<br /><span class="goal">a quarter or less</span></th>
							</tr>
						</thead>
						<tbody>
							{#each shown as r (r.id)}
								<tr class="pick" class:on={run?.id === r.id} onclick={() => (chosen = r.id)}>
									<td class="td name">
										<button class="link" onclick={() => (chosen = r.id)}>{r.change || r.setup}</button>
										{#if r.note}<span class="tag">{r.note}</span>{/if}
									</td>
									<td class="td">{r.table}</td>
									<td class="td num">{r.games}</td>
									<td class="td num" class:ok={r.round_ok} class:bad={!r.round_ok}>{r.end_round_median}<div class="sub">{r.end_rounds.join(', ')}</div></td>
									<td class="td num" class:ok={r.gap_ok} class:bad={!r.gap_ok}>{r.gap_median}<div class="sub">first to second {r.first_second_median}</div></td>
									<td class="td num" class:ok={r.split_ok} class:bad={!r.split_ok}>{r.monster_pct.toFixed(1)} / {r.spirit_pct.toFixed(1)} / {r.combat_pct.toFixed(1)}</td>
									<td class="td num" class:ok={r.pools_ok} class:bad={!r.pools_ok}>{r.pool_left.join(', ')}<div class="sub">of {r.pool_start.join(', ')}</div></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<div class="foot">Green meets the target, red does not. Pools left: Difficulty 1 at round 10, Difficulty 2 at round 20, Difficulty 3 at round 30 (the last round if the game ends earlier).</div>
			</section>

			{#if data.whatif?.length && newest}
				<section class="card whatif">
					<div class="title">The newest run's {newest.games} games scored with other payouts</div>
					<div class="table-wrap">
					<table class="data-table">
						<thead>
							<tr class="thead-row"><th class="th">Payout</th><th class="th num">Monsters</th><th class="th num">Spirits</th><th class="th num">Attacks</th></tr>
						</thead>
						<tbody>
							{#each data.whatif as w (w.change)}
								<tr>
									<td class="td">{w.change}</td>
									<td class="td num" class:ok={Math.abs(w.monster_pct - 70) <= 5} class:bad={Math.abs(w.monster_pct - 70) > 5}>{w.monster_pct.toFixed(1)}</td>
									<td class="td num" class:ok={Math.abs(w.spirit_pct - 10) <= 5} class:bad={Math.abs(w.spirit_pct - 10) > 5}>{w.spirit_pct.toFixed(1)}</td>
									<td class="td num" class:ok={Math.abs(w.combat_pct - 20) <= 5} class:bad={Math.abs(w.combat_pct - 20) > 5}>{w.combat_pct.toFixed(1)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					</div>
					<div class="foot">Play is assumed unchanged, so this shows the direction, not a result.</div>
				</section>
			{/if}
		</div>

		<section class="card games">
			{#if run}
				<div class="title">{run.games} games · {run.table} · first to {run.win_points} points</div>
				<div class="setup">{run.setup}</div>
				<div class="list">
					{#each games as g, gi (g.folder + g.game)}
						<article class="game">
							<div class="game-head">
								<span class="game-name">Game {gi + 1}</span>
								<span>{g.rounds} rounds</span>
								<span>first to last {g.gap}</span>
								{#if g.game_id}<a class="open" href={`/explorer/game/${g.game_id}`}>Open round by round</a>{/if}
							</div>
							<div class="game-body">
								<div class="table-x">
									<table class="data-table seats">
										<thead>
											<tr class="thead-row">
												<th class="th">Seat</th><th class="th num">Points</th><th class="th">End<br />status</th><th class="th num">Fallen<br />(round)</th><th class="th num">Kills</th>
												<th class="th num">From<br />monsters</th><th class="th num">From<br />attacks</th><th class="th num">From<br />spirits</th><th class="th num">From<br />Powers</th>
												<th class="th num">Attacks<br />made</th><th class="th num">Attacked<br />(corrupted)</th><th class="th num">Spirits<br />lost</th><th class="th">Spirits<br />awakened</th>
											</tr>
										</thead>
										<tbody>
											{#each g.seats as s, i (s.agent)}
												<tr>
													<td class="td nowrap"><i class="dot" style={`background:${color(s, i)}`}></i>{agentName(s.agent)}</td>
													<td class="td num strong">{s.points}</td>
													<td class="td">{s.status}</td>
													<td class="td num">{dash(s.fallen_round)}</td>
													<td class="td num">{s.kills}</td>
													<td class="td num">{s.from_monsters}</td>
													<td class="td num" class:hot={s.from_attacks > 0}>{s.from_attacks}</td>
													<td class="td num">{s.from_spirits}</td>
													<td class="td num">{s.from_powers}</td>
													<td class="td num">{dash(s.attacks_made)}</td>
													<td class="td num">{dash(s.times_attacked)}{#if s.times_attacked} ({dash(s.times_corrupted)}){/if}</td>
													<td class="td num">{dash(s.spirits_lost)}</td>
													<td class="td nowrap">{s.awakened}{#if s.notable.length}: {s.notable.join(', ')}{/if}</td>
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
								<div class="chart-box">
									<LineChart
										rows={curve(g.seats)}
										x="round"
										series={g.seats.map((s, i) => ({ key: `s${i}`, label: agentName(s.agent), color: color(s, i) }))}
										label={`Points by round, game ${gi + 1}`}
									/>
								</div>
							</div>
						</article>
					{/each}
				</div>
				<div class="foot">Spirits awakened: the count, with Nhal, Aurelion (the King) and Ocean Princess named. Attacked (corrupted): attacks on this seat, and how many corrupted it. From spirits: every point not from monsters, attacks or Powers, as in the points split. The chart is each seat's points by round.</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	/* One screen: the runs and the re-scoring table on top, the chosen run's games below. */
	.page { height: 100%; width: 100%; padding: 10px 16px; display: grid; grid-template-rows: minmax(0, 0.95fr) minmax(0, 1.05fr); gap: 10px; }
	.top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 0.36fr); gap: 10px; min-height: 0; }
	.msg { padding: 60px 20px; text-align: center; color: var(--dim); }

	.card { display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
	.page .card .title { font-size: 12px !important; font-weight: 500; color: var(--dim); }
	.head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; flex: none; }
	.seg { display: flex; flex-wrap: wrap; gap: 4px; }
	.page .seg button { font-size: 12px !important; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--dim); cursor: pointer; }
	.page .seg button.on { background: var(--seg); color: var(--text); border-color: var(--line-2); }
	.page .foot { font-size: 12px !important; color: var(--faint); flex: none; }
	.page .setup { font-size: 13px !important; color: var(--text); flex: none; }

	.table-wrap { flex: 1; min-height: 0; overflow: auto; }
	.table-x { overflow-x: auto; min-width: 0; flex: 1; }
	.data-table { width: 100%; border-collapse: collapse; }
	.thead-row { position: sticky; top: 0; z-index: 1; background: var(--panel); }
	.th { padding: 4px 8px; text-align: left; vertical-align: bottom; border-bottom: 1px solid var(--line); font-weight: 500; color: var(--dim); }
	.page .th { font-size: 12px !important; }
	.page .th .goal { font-size: 11px !important; font-weight: 400; color: var(--faint); }
	.th.num, .td.num { text-align: right; white-space: nowrap; }
	.td { padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
	.td.nowrap { white-space: nowrap; }
	.td.name { min-width: 190px; }
	.td.num .sub { white-space: normal; }
	.td.strong { font-weight: 600; }
	.td.ok { color: var(--ok); }
	.td.bad { color: var(--bad); }
	.td.hot { color: var(--accent); }
	.page .sub { font-size: 11px !important; color: var(--faint); font-weight: 400; }
	tr.pick { cursor: pointer; }
	tr.pick:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
	tr.pick.on { background: var(--seg); }
	.page .link { all: unset; cursor: pointer; color: var(--text); font-size: 13px !important; }
	.page .link:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
	.page .tag { display: inline-block; margin-left: 6px; padding: 0 6px; border: 1px solid var(--line-2); border-radius: 999px; font-size: 11px !important; color: var(--dim); white-space: nowrap; }

	.games .list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
	.game { flex: none; border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
	.game-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; color: var(--dim); }
	.page .game-head span { font-size: 12px !important; }
	.page .game-head .game-name { font-size: 13px !important; font-weight: 600; color: var(--text); }
	.page .open { margin-left: auto; font-size: 12px !important; color: var(--accent); text-decoration: none; }
	.open:hover { text-decoration: underline; }
	.game-body { display: flex; gap: 12px; min-width: 0; align-items: stretch; }
	.seats .thead-row { position: static; background: transparent; }
	.seats .td { vertical-align: middle; }
	.seats .th, .seats .td { padding: 4px 6px; }
	.chart-box { flex: none; width: 26%; min-width: 240px; height: 170px; }
	.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; }

	/* A narrow frame: everything in one column that scrolls. */
	@media (max-width: 1000px) {
		.page { display: flex; flex-direction: column; overflow-y: auto; }
		.top { display: flex; flex-direction: column; flex: none; }
		.card { flex: none; }
		.runs .table-wrap { max-height: 420px; }
		.td.name { min-width: 150px; }
		.games .list { overflow: visible; }
		.game-body { flex-direction: column; }
		.chart-box { width: 100%; }
	}
</style>
