<script lang="ts">
	// Game explorer: one value on a scale. The shaded band is the target, the bar runs from the
	// low to the high percentile, the mark is the median.
	let {
		low,
		high,
		median,
		targetLow,
		targetHigh,
		domain,
		ticks,
		label
	}: { low: number; high: number; median: number; targetLow: number; targetHigh: number; domain: [number, number]; ticks: number[]; label: string } = $props();

	let w = $state(300);
	const H = 44;
	const PAD = 14;
	const x = (v: number) => PAD + ((Math.min(domain[1], Math.max(domain[0], v)) - domain[0]) / (domain[1] - domain[0])) * (w - 2 * PAD);
</script>

<div class="strip" bind:clientWidth={w}>
	<svg width={w} height={H} role="img" aria-label={label}>
		<rect class="target" x={x(targetLow)} y="3" width={Math.max(0, x(targetHigh) - x(targetLow))} height="22" rx="3" />
		<rect class="range" x={x(low)} y="9" width={Math.max(3, x(high) - x(low))} height="10" rx="2" />
		<rect class="median" x={x(median) - 1.5} y="1" width="3" height="26" />
		{#each ticks as t (t)}
			<line class="tick" x1={x(t)} x2={x(t)} y1="27" y2="31" />
			<text x={x(t)} y="42" text-anchor="middle">{t}</text>
		{/each}
	</svg>
</div>

<style>
	.strip { width: 100%; height: 44px; }
	svg { display: block; }
	.target { fill: var(--line-2); }
	.range { fill: var(--accent); }
	.median { fill: var(--text); }
	.tick { stroke: var(--faint); }
	text { font-size: 11px; fill: var(--dim); }
</style>
