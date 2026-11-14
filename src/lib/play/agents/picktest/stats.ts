/** Pick test statistics: pick rates with a 95% interval, and simple keyword groups of reasons. */

/** Wilson 95% interval of k successes in n tries ([0, 0] when n = 0). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
	if (!n) return [0, 0];
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = (p + (z * z) / (2 * n)) / d;
	const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
	return [Math.max(0, c - h), Math.min(1, c + h)];
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "k/n = p% [lo-hi]" */
export function rateText(k: number, n: number): string {
	if (!n) return '-';
	const [lo, hi] = wilson(k, n);
	return `${k}/${n} = ${pct(k / n)} [${Math.round(lo * 100)}-${Math.round(hi * 100)}]`;
}

/**
 * Keyword groups for "why the model did not pick this spirit". A reason may fall into several
 * groups; one that matches none is "other". Order is the display order.
 */
export const REASON_GROUPS: { id: string; label: string; re: RegExp }[] = [
	{
		id: 'fit',
		label: 'does not fit the build / no synergy',
		re: /synerg|fit|build|plan|engine|toward|stack|breakpoint|threshold|consolidat|focus|commit|count/i
	},
	{ id: 'slots', label: 'spirit slots / room', re: /slot|room|space|full\b|limit|capacity/i },
	{
		id: 'awaken',
		label: 'awakening cost or condition',
		re: /awaken|rune|condition|hard to (wake|flip)/i
	},
	{
		id: 'corruption',
		label: 'corruption / cursed / evil risk',
		re: /corrupt|curse|taint|evil|fallen|pure/i
	},
	{
		id: 'combat',
		label: 'combat value (damage, dice, barrier)',
		re: /damage|dice|\bdie\b|barrier|attack|monster|kill|fight|combat/i
	},
	{ id: 'vp', label: 'victory points / scoring', re: /\bvp\b|victory point|score|points/i },
	{ id: 'cost', label: 'cost / expensive / cheap', re: /\bcost|expensive|cheap|pricey/i },
	{
		id: 'redraw',
		label: 'wants a redraw / none of these',
		re: /redraw|draw again|none of|return them|nothing here/i
	}
];

export function reasonGroups(reason: string): string[] {
	const hits = REASON_GROUPS.filter((g) => g.re.test(reason)).map((g) => g.id);
	return hits.length ? hits : ['other'];
}

export function groupLabel(id: string): string {
	return REASON_GROUPS.find((g) => g.id === id)?.label ?? 'other';
}

/** Short quote: the first ~`max` characters, cut at a word. */
export function shortQuote(text: string, max = 160): string {
	const t = text.replace(/\s+/g, ' ').trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

/** Deterministic PRNG (mulberry32) for sampling. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffle<T>(items: T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * Stratified sample: every spirit gets up to `perSpirit` sampled points that offer it (rarest
 * spirits first; a point counts for every spirit it offers). `keyOf` names a point, `offered`
 * lists its spirits. Stops at `max` points.
 */
export function stratifiedSample<P>(
	points: P[],
	offered: (p: P) => string[],
	opts: { perSpirit: number; max: number; seed: number; spirits?: Set<string> }
): P[] {
	const random = rng(opts.seed);
	const pool = shuffle(points, random);
	const bySpirit = new Map<string, P[]>();
	for (const p of pool)
		for (const id of new Set(offered(p))) {
			if (opts.spirits && !opts.spirits.has(id)) continue;
			const list = bySpirit.get(id) ?? [];
			list.push(p);
			bySpirit.set(id, list);
		}
	const chosen = new Set<P>();
	const covered = new Map<string, number>();
	const order = [...bySpirit.keys()].sort(
		(a, b) => bySpirit.get(a)!.length - bySpirit.get(b)!.length || a.localeCompare(b)
	);
	for (const id of order) {
		for (const p of bySpirit.get(id)!) {
			if ((covered.get(id) ?? 0) >= opts.perSpirit) break;
			if (chosen.size >= opts.max) return [...chosen];
			if (chosen.has(p)) continue;
			chosen.add(p);
			for (const s of new Set(offered(p))) covered.set(s, (covered.get(s) ?? 0) + 1);
		}
	}
	return [...chosen];
}
