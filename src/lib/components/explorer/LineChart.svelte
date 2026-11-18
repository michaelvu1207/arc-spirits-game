<script lang="ts">
	// Game explorer: lines over the rounds, drawn point to point. Hover or tap shows one round's
	// values. It fills the box it is put in.
	type Row = Record<string, number | null>;
	let {
		rows,
		x,
		series,
		label
	}: { rows: Row[]; x: string; series: { key: string; label: string; color: string }[]; label: string } = $props();

	let w = $state(320);
	let h = $state(160);
	let hover = $state<number | null>(null);
	const M = { t: 8, r: 10, b: 20, l: 28 };

	const xs = $derived(rows.map((r) => r[x] as number));
	const x0 = $derived(xs.length ? Math.min(...xs) : 0);
	const x1 = $derived(xs.length ? Math.max(...xs) : 1);
	const top = $derived.by(() => {
		const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] ?? 0)));
		const pow = 10 ** Math.floor(Math.log10(max));
		const step = [1, 2, 2.5, 5, 10].map((k) => (k * pow) / 4).find((s) => s * 4 >= max) ?? (pow * 10) / 4;
		return step * 4;
	});
	const sx = (v: number) => M.l + ((v - x0) / Math.max(1, x1 - x0)) * (w - M.l - M.r);
	const sy = (v: number) => h - M.b - (v / top) * (h - M.t - M.b);
	const yTicks = $derived([0, 1, 2, 3, 4].map((i) => (top * i) / 4));
	const xTicks = $derived.by(() => {
		const every = Math.max(1, Math.ceil((x1 - x0 + 1) / Math.max(2, Math.floor(w / 48))));
		return xs.filter((v) => (v - x0) % every === 0);
	});
	const path = (key: string) =>
		rows
			.filter((r) => r[key] != null)
			.map((r, i) => `${i ? 'L' : 'M'}${sx(r[x] as number).toFixed(1)},${sy(r[key] as number).toFixed(1)}`)
			.join('');
	const shown = $derived(hover == null ? null : (rows[hover] ?? null));

	function move(e: PointerEvent) {
		const box = (e.currentTarget as SVGElement).getBoundingClientRect();
		const px = e.clientX - box.left;
		let best = 0;
		rows.forEach((r, i) => {
			if (Math.abs(sx(r[x] as number) - px) < Math.abs(sx(rows[best][x] as number) - px)) best = i;
		});
		hover = rows.length ? best : null;
	}
</script>

<div class="chart" bind:clientWidth={w} bind:clientHeight={h}>
	<svg width={w} height={h} role="img" aria-label={label} onpointermove={move} onpointerleave={() => (hover = null)}>
		{#each yTicks as t (t)}
			<line class="grid" x1={M.l} x2={w - M.r} y1={sy(t)} y2={sy(t)} />
			<text x={M.l - 6} y={sy(t) + 4} text-anchor="end">{Number.isInteger(t) ? t : t.toFixed(1)}</text>
		{/each}
		{#each xTicks as t (t)}
			<text x={sx(t)} y={h - M.b + 14} text-anchor="middle">{t}</text>
		{/each}
		{#each series as s (s.key)}
			<path d={path(s.key)} fill="none" stroke={s.color} stroke-width="2" />
		{/each}
		{#if shown}
			<line class="rule" x1={sx(shown[x] as number)} x2={sx(shown[x] as number)} y1={M.t} y2={h - M.b} />
			{#each series as s (s.key)}
				{#if shown[s.key] != null}<circle cx={sx(shown[x] as number)} cy={sy(shown[s.key] as number)} r="3.5" fill={s.color} />{/if}
			{/each}
		{/if}
	</svg>
	{#if shown}
		<div class="tip" style={`left:${Math.min(Math.max(4, sx(shown[x] as number) + 8), Math.max(4, w - 190))}px`}>
			<div>Round {shown[x]}</div>
			{#each series as s (s.key)}
				<div><span class="dot" style={`background:${s.color}`}></span>{s.label}: {shown[s.key] ?? '–'}</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.chart { position: relative; flex: 1; min-height: 110px; }
	svg { position: absolute; inset: 0; display: block; touch-action: none; }
	.grid { stroke: var(--line); }
	.rule { stroke: var(--faint); }
	text { font-size: 11px; fill: var(--dim); }
	.tip { position: absolute; top: 4px; pointer-events: none; background: var(--card); border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 8px; white-space: nowrap; }
	.tip div { font-size: 12px !important; }
	.dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
</style>
