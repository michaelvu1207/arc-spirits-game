/**
 * Display-only combat/encounter log collapsing.
 *
 * The engine emits one log line per granted effect, each attributed to its source
 * trait (e.g. "Beast: Gained +1 combat damage." / "Beast: Gained 1
 * initiative."). When one source grants several numeric buffs in a row that reads as
 * a wall of near-duplicate lines. This merges CONSECUTIVE lines from the same source
 * into a single sentence, summing each distinct effect:
 *
 *   Beast: Gained +1 combat damage.
 *   Beast: Gained 1 initiative.
 *   Beast: Gained +2 combat damage.
 *   Beast: Gained 2 initiative.
 *      →  Beast: Gained +3 combat damage and 3 initiative.
 *
 * Purely cosmetic — the engine log is untouched; only the UI renders the merged view.
 */

// "<Source>: Gained <±N> <descriptor>." — the only shape we coalesce. Non-numeric
// "Gained" lines (loot, named runes) and unprefixed lines never match and pass through.
const GAINED_RE = /^(.+?): Gained ([+-]?)(\d+) (.+?)\.?$/;

export function mergeCombatLog(raw: string[]): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < raw.length) {
		const m = raw[i].match(GAINED_RE);
		if (!m) {
			out.push(raw[i]);
			i += 1;
			continue;
		}
		const source = m[1];
		// Sum every consecutive same-source "Gained N <descriptor>" line, keyed by the
		// descriptor so each effect type accumulates independently (insertion-ordered).
		const sums = new Map<string, { sign: string; total: number }>();
		let j = i;
		while (j < raw.length) {
			const mm = raw[j].match(GAINED_RE);
			if (!mm || mm[1] !== source) break;
			const [, , sign, num, desc] = mm;
			const cur = sums.get(desc) ?? { sign: '', total: 0 };
			if (sign) cur.sign = sign; // keep "+" when the effect uses it (combat damage)
			cur.total += Number(num);
			sums.set(desc, cur);
			j += 1;
		}
		if (j - i <= 1) {
			out.push(raw[i]); // single line — leave its original wording untouched
		} else {
			const parts = [...sums.entries()].map(([desc, { sign, total }]) => `${sign}${total} ${desc}`);
			out.push(`${source}: Gained ${parts.join(' and ')}.`);
		}
		i = j;
	}
	return out;
}
