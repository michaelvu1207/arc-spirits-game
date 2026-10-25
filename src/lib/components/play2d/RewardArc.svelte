<script lang="ts">
	import { powerIconUrl } from '$lib/play/regionRules';
	import type { SeatColor, NavigationDestination } from '$lib/play/types';
	import type {
		GameLocationAsset,
		GameLocationRewardRow,
		IconPoolEntry,
		RewardIconToken
	} from '$lib/types';
	import { storageUrl, seatAccent } from './helpers';

	type Pos = 'tl' | 'tr' | 'bl' | 'br';
	interface Quad {
		name: NavigationDestination;
		pos: Pos;
		location: GameLocationAsset | null;
		accent: string;
		occupants: SeatColor[];
		selected: boolean;
		focused: boolean;
	}

	let {
		quads,
		iconPool = new Map(),
		seatNames = {},
		mySeat = null,
		size
	}: {
		quads: Quad[];
		iconPool?: Map<string, IconPoolEntry>;
		seatNames?: Partial<Record<SeatColor, string>>;
		mySeat?: SeatColor | null;
		size: number;
	} = $props();

	// Each quadrant fills a 90° wedge of the compass; its reward rows are concentric
	// arcs ("shells") centred on the Abyss hub, the innermost row hugging the core and
	// each later row a further-out shell. Angles are degrees, clockwise from straight up
	// (matching the compass's WEDGE_BY_POS convention).
	const CENTER_DEG: Record<Pos, number> = { tl: 315, tr: 45, bl: 225, br: 135 };
	const F_TITLE = 0.557; // realm name engraved inside the thick rim band (band centre)
	const F_REWARD_OUTER = 0.455; // outermost reward shell, just inside the ring's inner edge
	const F_REWARD_INNER = 0.188; // innermost shell, just clear of the Abyss hub
	const F_TOKENS = 0.49; // occupant pips, between the top shell and the rim
	const TITLE_HALF = 44; // half-sweep of the title arc (deg)
	const MAX_HALF = 40; // max half-sweep of a shell (deg)
	const UNIT_PX = 46; // baseline icon centre-to-centre spacing
	const ICON_PX = 38; // rendered icon size (keep in sync with .ico)
	const EDGE_GAP = 4; // clear channel (deg) the dividing spokes keep from any icon
	const RAD = Math.PI / 180;
	const WEIGHT: Record<string, number> = { icon: 1, or: 0.5, arrow: 0.85, text: 2 };

	type Item =
		| { kind: 'icon'; url: string | null; id: string }
		| { kind: 'or' }
		| { kind: 'arrow' }
		| { kind: 'text'; text: string };

	function tokenIcons(token: RewardIconToken): { id: string; url: string | null }[] {
		const ids = typeof token === 'string' ? [token] : token.icon_ids;
		return ids.map((id) => ({ id, url: powerIconUrl(id) ?? storageUrl(iconPool.get(id)?.file_path ?? null) }));
	}

	function pushGroup(out: Item[], tokens: RewardIconToken[]) {
		for (const token of tokens) {
			tokenIcons(token).forEach((ic, k) => {
				if (k > 0) out.push({ kind: 'or' });
				out.push({ kind: 'icon', url: ic.url, id: ic.id });
			});
		}
	}

	function buildItems(row: GameLocationRewardRow): Item[] {
		if (row.type === 'text') return [{ kind: 'text', text: row.text }];
		const out: Item[] = [];
		if (row.type === 'gain') {
			pushGroup(out, row.gain_icon_ids);
			return out;
		}
		pushGroup(out, row.cost_icon_ids);
		out.push({ kind: 'arrow' });
		pushGroup(out, row.gain_icon_ids);
		return out;
	}

	// Lay items along an arc at radius R (px), centred on the wedge centre angle c.
	// Spacing is angular but derived from a constant pixel step so inner shells don't
	// crowd; if the run is wider than the wedge allows it scales down to fit.
	function placeRow(items: Item[], c: number, R: number) {
		const base = UNIT_PX / R / RAD; // deg per pixel-unit at this radius
		const centers: number[] = [];
		let acc = 0;
		items.forEach((it, i) => {
			if (i > 0) {
				const w0 = WEIGHT[items[i - 1].kind] ?? 1;
				const w1 = WEIGHT[it.kind] ?? 1;
				acc += ((w0 + w1) / 2) * base;
			}
			centers.push(acc);
		});
		const span = (centers[centers.length - 1] ?? 0) - (centers[0] ?? 0);
		const half = span / 2;
		// The quadrant boundaries sit 45° from the wedge centre — that's exactly where the
		// dividing spokes are drawn. Keep every icon clear of them: subtract the angle an
		// icon's half-width subtends at this radius (larger on inner shells) plus a gap, so
		// the white lines fall in the empty channel between quadrants, never across a row.
		const edgePad = (ICON_PX / 2 + 6) / R / RAD;
		const wedgeHalf = Math.max(12, Math.min(MAX_HALF, 45 - edgePad - EDGE_GAP));
		const scale = half > wedgeHalf ? wedgeHalf / half : 1;
		const mid = ((centers[0] ?? 0) + (centers[centers.length - 1] ?? 0)) / 2;
		// Always read cost → gain left-to-right. Screen-x grows with the angle only where
		// cos(c) > 0 (top-right / top-left wedges); in the bottom wedges it runs the other
		// way, so flip the offset there to keep the first item on the left.
		const dir = Math.cos(c * RAD) >= 0 ? 1 : -1;
		const placed = items.map((it, i) => ({ item: it, theta: c + dir * (centers[i] - mid) * scale }));
		const usedHalf = Math.min(wedgeHalf, half * scale + 4);
		return { placed, dir, theta0: c - usedHalf, theta1: c + usedHalf };
	}

	const model = $derived(
		quads.map((q, qi) => {
			const c = CENTER_DEG[q.pos];
			// Longest rows go on the outermost (roomiest) shells so nothing gets crammed
			// onto a tight inner arc; ties keep their original order (stable sort).
			const rows = (q.location?.reward_rows ?? [])
				.map((row) => ({ row, items: buildItems(row) }))
				.sort((a, b) => b.items.length - a.items.length);
			// Spread the shells across the whole inner disc: outermost row hugs the rim,
			// innermost sits just off the hub, the rest evenly between (a lone row centres).
			const n = rows.length;
			const placedRows = rows.map(({ items }, i) => {
				const f =
					n <= 1
						? (F_REWARD_OUTER + F_REWARD_INNER) / 2
						: F_REWARD_OUTER - (i * (F_REWARD_OUTER - F_REWARD_INNER)) / (n - 1);
				const R = f * size;
				return { R, ...placeRow(items, c, R) };
			});
			// Divider arcs sit in the GAP between consecutive rows (midpoint radius), not on
			// top of a row — so the lines separate the reward rows instead of bisecting them.
			const dividers = [];
			for (let i = 0; i < placedRows.length - 1; i++) {
				const a = placedRows[i];
				const b = placedRows[i + 1];
				const h = Math.max((a.theta1 - a.theta0) / 2, (b.theta1 - b.theta0) / 2);
				dividers.push({ R: (a.R + b.R) / 2, theta0: c - h, theta1: c + h });
			}
			// Title arc: top wedges sweep clockwise (c-half → c+half); the bottom wedges
			// run the path the other way so the engraved glyphs stay upright, not inverted.
			const tR = F_TITLE * size;
			const top = q.pos === 'tl' || q.pos === 'tr';
			const titleD = top
				? arcPath(c - TITLE_HALF, c + TITLE_HALF, tR, 1)
				: arcPath(c + TITLE_HALF, c - TITLE_HALF, tR, 0);
			return {
				...q,
				c,
				tokenR: F_TOKENS * size,
				placedRows,
				dividers,
				titleD,
				titleId: `tp-${qi}`
			};
		})
	);

	function pt(theta: number, R: number): [number, number] {
		const a = theta * RAD;
		return [size / 2 + R * Math.sin(a), size / 2 - R * Math.cos(a)];
	}
	function arcPath(theta0: number, theta1: number, R: number, sweep = 1): string {
		const [x0, y0] = pt(theta0, R);
		const [x1, y1] = pt(theta1, R);
		return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R.toFixed(2)} ${R.toFixed(2)} 0 0 ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
	}
	const titleFont = $derived(Math.max(14, size * 0.042));
	// Position an element so its centre lands at (theta, R) and stays upright.
	function atArc(theta: number, R: number): string {
		return `transform: translate(-50%, -50%) rotate(${theta}deg) translateY(${(-R).toFixed(2)}px) rotate(${(-theta).toFixed(2)}deg);`;
	}
	// The trade arrow follows the shell's tangent, pointing along the reading flow toward
	// the gain side. Reading runs with increasing theta when dir > 0, decreasing when dir < 0
	// (the bottom wedges), so flip the glyph 180° there to keep it aimed cost → gain.
	function atArcTangent(theta: number, R: number, dir: number): string {
		return `transform: translate(-50%, -50%) rotate(${theta}deg) translateY(${(-R).toFixed(2)}px) rotate(${dir < 0 ? 180 : 0}deg);`;
	}
</script>

<div class="arc-layer" aria-hidden="true">
	<svg class="shells" viewBox="0 0 {size} {size}" width={size} height={size}>
		<defs>
			{#each model as q (q.name)}
				<path id={q.titleId} d={q.titleD} fill="none" />
			{/each}
		</defs>
		{#each model as q (q.name)}
			{#each q.dividers as d, i (i)}
				<path
					d={arcPath(d.theta0, d.theta1, d.R)}
					class="shell"
					class:lit={q.focused || q.selected}
					style="--accent: {q.accent}"
				/>
			{/each}
		{/each}
		{#each model as q (q.name)}
			<text
				class="title"
				class:focused={q.focused}
				class:selected={q.selected}
				font-size={titleFont}
				text-anchor="middle"
				dominant-baseline="middle"
				style="--accent: {q.accent}"
			>
				<textPath href="#{q.titleId}" startOffset="50%">{q.name}</textPath>
			</text>
		{/each}
	</svg>

	{#each model as q (q.name)}
		<div class="quad" class:focused={q.focused} class:selected={q.selected} style="--accent: {q.accent}">
			{#if q.occupants.length}
				<span class="pips" style={atArc(q.c, q.tokenR)}>
					{#each q.occupants as seat (seat)}
						<span
							class="pip"
							class:mine={seat === mySeat}
							style="background: {seatAccent(seat)}"
							title={seatNames[seat] ?? seat}
						></span>
					{/each}
				</span>
			{/if}

			{#each q.placedRows as row, i (i)}
				{#each row.placed as p (p.theta)}
					<span
						class="slot"
						style={p.item.kind === 'arrow'
							? atArcTangent(p.theta, row.R, row.dir)
							: atArc(p.theta, row.R)}
					>
						{#if p.item.kind === 'icon'}
							<span class="ico">{#if p.item.url}<img src={p.item.url} alt="" loading="lazy" />{/if}</span>
						{:else if p.item.kind === 'or'}
							<span class="or">/</span>
						{:else if p.item.kind === 'arrow'}
							<span class="arrow">→</span>
						{:else}
							<span class="row-text">{p.item.text}</span>
						{/if}
					</span>
				{/each}
			{/each}
		</div>
	{/each}
</div>

<style>
	/* A hub-centred overlay that draws every realm's reward rows as concentric arcs.
	   Purely presentational — the quadrant hit-buttons underneath own all interaction. */
	.arc-layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 2;
	}
	.shells {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.shell {
		fill: none;
		stroke: rgba(255, 255, 255, 0.12);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
		transition: stroke 140ms ease;
	}
	.shell.lit {
		stroke: color-mix(in srgb, var(--accent) 45%, transparent);
	}

	/* Realm name engraved along the rim arc. A dark stroke halo (paint-order) keeps it
	   legible over the painted spirit-world behind the compass; the accent only lights it
	   on hover/lock so the resting state stays calm. */
	.title {
		font-family: var(--font-display);
		fill: #fff;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		paint-order: stroke;
		stroke: rgba(0, 0, 0, 0.62);
		stroke-width: 3.4px;
		stroke-linejoin: round;
		transition: fill 140ms ease;
	}
	.title.focused {
		filter: drop-shadow(0 0 7px color-mix(in srgb, var(--accent) 70%, transparent));
	}
	.title.selected {
		fill: color-mix(in srgb, var(--accent) 72%, #fff);
		filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 75%, transparent));
	}

	.quad {
		position: absolute;
		inset: 0;
	}
	/* Every arc-placed element is anchored at the compass centre then pushed out by the
	   inline transform; transform-origin stays centre so it lands upright on the shell. */
	.pips,
	.slot {
		position: absolute;
		left: 50%;
		top: 50%;
	}

	.pips {
		display: flex;
		gap: 5px;
	}
	.pip {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
	}
	.pip.mine {
		box-shadow: 0 0 0 2px #fff;
	}

	.slot {
		display: grid;
		place-items: center;
	}
	.ico {
		width: 38px;
		height: 38px;
		display: grid;
		place-items: center;
	}
	.ico img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
	}
	.or {
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--color-whisper, #8d8aa1);
		text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
	}
	.arrow {
		color: var(--brand-amber, #ffba3d);
		font-size: 1.3rem;
		text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
	}
	.row-text {
		font-size: 1rem;
		color: var(--color-fog, #8d8aa1);
		white-space: nowrap;
		text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
	}
</style>
