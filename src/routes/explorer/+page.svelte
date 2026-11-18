<script lang="ts">
	// Balance: where the AI test games stand against the targets. Top row: the round the game
	// ends, the points between first and last place, and where points come from (a box is green
	// when it meets its target and red when it does not). Below: damage per turn by round, final
	// points by end status, monsters left in each pool by round, and each monster's fights and kills.
	import { onMount } from 'svelte';
	import LineChart from '$lib/components/explorer/LineChart.svelte';
	import RangeStrip from '$lib/components/explorer/RangeStrip.svelte';
	import { balanceChecks, fetchBalance, type BalanceData } from '$lib/explorerBalance';

	const REFRESH_MS = 60_000;
	const SERIES = ['var(--accent)', 'var(--text)', '#6aa5ff'];

	let data = $state<BalanceData | null>(null);
	let error = $state<string | null>(null);

	const head = $derived(data?.headline[0] ?? null);
	const checks = $derived(data ? balanceChecks(data) : null);

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
</script>

<svelte:head><title>Balance · Arc Spirits</title></svelte:head>

<div class="page">
	{#if error}
		<div class="msg">{error}</div>
	{:else if !data || !head}
		<div class="msg">Loading…</div>
	{:else}
		<div class="row top">
			<section class="card" class:pass={checks?.round === true} class:fail={checks?.round === false}>
				<div class="title">Round the game ends</div>
				<div class="metric"><span class="num">{head.end_round_median}</span><span class="range">{head.end_round_low} – {head.end_round_high}</span></div>
				<RangeStrip
					low={head.end_round_low}
					high={head.end_round_high}
					median={head.end_round_median}
					targetLow={head.target_low}
					targetHigh={head.target_high}
					domain={[5, 35]}
					ticks={[5, 10, 15, 20, 25, 30, 35]}
					label="End round range against the target range"
				/>
			</section>
			<section class="card" class:pass={checks?.gap === true} class:fail={checks?.gap === false}>
				<div class="title">Points between first and last</div>
				<div class="metric"><span class="num">{head.gap_median}</span><span class="range">{head.gap_low} – {head.gap_high}</span></div>
				<RangeStrip
					low={head.gap_low}
					high={head.gap_high}
					median={head.gap_median}
					targetLow={0}
					targetHigh={head.gap_target}
					domain={[0, 30]}
					ticks={[0, 5, 10, 15, 20, 25, 30]}
					label="First-to-last point gap against the target range"
				/>
			</section>
			<section class="card" class:pass={checks?.split === true} class:fail={checks?.split === false}>
				<div class="title">Where points come from</div>
				<div class="bars">
					{#each data.split as s (s.source)}
						<div class="bar-row">
							<span class="bar-name">{s.source}</span>
							<div class="track">
								<div class="bar"><i class="goal" style={`width:${Math.max(0.5, s.goal_pct * 0.6)}%`}></i><span>{s.goal_pct}%</span></div>
								<div class="bar"><i class="now" style={`width:${Math.max(0.5, s.now_pct * 0.6)}%`}></i><span>{s.now_pct}%</span></div>
							</div>
						</div>
					{/each}
				</div>
				<div class="legend"><span><i class="goal"></i>Goal</span><span><i class="now"></i>Now</span></div>
			</section>
		</div>

		<div class="row mid">
			<section class="card">
				<div class="title">Average damage per turn, by round</div>
				<LineChart
					rows={data.damage.map((r) => ({ round: r.round, monster: r.monster_damage, seat: r.per_seat_damage }))}
					x="round"
					series={[
						{ key: 'monster', label: 'Against monsters', color: SERIES[0] },
						{ key: 'seat', label: 'All combat, every seat', color: SERIES[1] }
					]}
					label="Average damage per turn by round"
				/>
				<div class="legend"><span><i style={`background:${SERIES[0]}`}></i>Against monsters, turns with a fight</span><span><i style={`background:${SERIES[1]}`}></i>All combat, every seat</span></div>
			</section>
			<section class="card">
				<div class="title">End status and points</div>
				<div class="bars">
					{#each data.status as s (s.status)}
						<div class="bar-row">
							<span class="bar-name">{s.status}</span>
							<div class="track">
								<div class="bar"><i class="now" style={`width:${Math.max(0.5, (s.avg_points / 30) * 55)}%`}></i><span>{s.avg_points} pts</span></div>
								<div class="bar"><i class="goal" style={`width:${Math.max(0.5, s.share_pct * 0.55)}%`}></i><span>{s.share_pct}% of seats</span></div>
							</div>
						</div>
					{/each}
				</div>
				<div class="legend"><span><i class="now"></i>Average points</span><span><i class="goal"></i>Share of seats</span></div>
			</section>
		</div>

		<div class="row bottom">
			<section class="card" class:pass={checks?.pools === true} class:fail={checks?.pools === false}>
				<div class="title">Monsters left in each pool, by round</div>
				<LineChart
					rows={data.pools.map((r) => ({ round: r.round, d1: r.difficulty_1, d2: r.difficulty_2, d3: r.difficulty_3 }))}
					x="round"
					series={[
						{ key: 'd1', label: 'Difficulty 1', color: SERIES[0] },
						{ key: 'd2', label: 'Difficulty 2', color: SERIES[1] },
						{ key: 'd3', label: 'Difficulty 3', color: SERIES[2] }
					]}
					label="Monsters left in each pool by round"
				/>
				<div class="legend">
					{#each ['Difficulty 1', 'Difficulty 2', 'Difficulty 3'] as name, i (name)}<span><i style={`background:${SERIES[i]}`}></i>{name}</span>{/each}
				</div>
			</section>
			<section class="card">
				<div class="title">Monsters fought and killed</div>
				<div class="table-wrap">
					<table class="data-table">
						<thead>
							<tr class="thead-row">
								<th class="th">Monster</th><th class="th num">Difficulty</th><th class="th num">Barrier</th><th class="th num">Fights</th><th class="th num">Kills</th><th class="th num">Average kill round</th>
							</tr>
						</thead>
						<tbody>
							{#each data.monsters as m (m.monster)}
								<tr>
									<td class="td name">{m.monster}</td><td class="td num">{m.difficulty}</td><td class="td num">{m.barrier}</td><td class="td num">{m.fights}</td><td class="td num">{m.kills}</td><td class="td num">{m.avg_kill_round ?? '–'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	{/if}
</div>

<style>
	/* One screen: three rows of boxes; the monster table scrolls inside its box. */
	.page { height: 100%; width: 100%; padding: 10px 16px; display: grid; grid-template-rows: auto minmax(0, 1fr) minmax(0, 1.15fr); gap: 10px; }
	.row { display: grid; gap: 10px; min-height: 0; }
	.row.top { grid-template-columns: repeat(3, minmax(0, 1fr)); }
	.row.mid, .row.bottom { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.msg { padding: 60px 20px; text-align: center; color: var(--dim); }

	.card { display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
	.page .card.pass { border-color: var(--ok) !important; background: color-mix(in srgb, var(--ok) 13%, var(--panel)); }
	.page .card.fail { border-color: var(--bad) !important; background: color-mix(in srgb, var(--bad) 13%, var(--panel)); }
	.page .card .title { font-size: 12px !important; font-weight: 500; color: var(--dim); }
	.metric { display: flex; align-items: baseline; gap: 10px; }
	.page .card .metric .num { font-size: 30px !important; line-height: 1 !important; font-weight: 600; }
	.metric .range { color: var(--dim); }

	.bars { display: grid; gap: 6px; align-content: start; flex: 1; min-height: 0; overflow: hidden; }
	.bar-row { display: grid; grid-template-columns: 124px minmax(0, 1fr); gap: 8px; align-items: center; }
	.track { display: grid; gap: 2px; min-width: 0; }
	.bar { display: flex; align-items: center; gap: 6px; color: var(--dim); white-space: nowrap; }
	.page .bar span { font-size: 12px !important; }
	.bar i { display: block; height: 8px; border-radius: 2px; min-width: 2px; flex: none; }
	i.goal { background: var(--line-2); }
	i.now { background: var(--accent); }
	.legend { display: flex; flex-wrap: wrap; gap: 2px 14px; color: var(--dim); flex: none; }
	.page .legend span { font-size: 12px !important; }
	.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }

	.table-wrap { flex: 1; min-height: 0; overflow-y: auto; }
	.data-table { width: 100%; border-collapse: collapse; }
	.thead-row { position: sticky; top: 0; z-index: 1; background: var(--panel); }
	.th { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--line); }
	.th.num, .td.num { text-align: right; white-space: nowrap; }
	.td { padding: 4px 8px; border-bottom: 1px solid var(--line); }

	/* A narrow frame: the boxes stack and scroll inside the page area. */
	@media (max-width: 820px) {
		.page { display: flex; flex-direction: column; overflow-y: auto; }
		.row { flex: none; }
		.row.top, .row.mid, .row.bottom { grid-template-columns: minmax(0, 1fr); }
		.row.mid .card, .row.bottom .card { min-height: 230px; }
		.table-wrap { max-height: 320px; }
	}
</style>
