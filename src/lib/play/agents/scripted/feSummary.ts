/** Aggregate numbers of a batch of scripted-player games (feGames.ts): `script:fe`, `script:beast`. */

import type { RoundSnapshot, SeatResult, TableGameResult } from './feGames';

const median = (xs: number[]): number | null => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number | null =>
	xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;

/** Points at the end of `round`; a player keeps the final value after the game ends. */
export function vpAt(vpByRound: number[], round: number): number {
	if (!vpByRound.length) return 0;
	return vpByRound[Math.min(round, vpByRound.length) - 1] ?? 0;
}

/** Rounds at which the per-kind summary reads every scripted seat. */
export const SUMMARY_ROUNDS = [4, 8, 12, 16, 20, 22, 24] as const;

/** A seat's kind: its spec without a variant name (`script:beast#a` → `script:beast`). */
export function seatKind(spec: string): string {
	return spec.split('#')[0];
}

/** A scripted seat's state at the end of `round` (its last state when the game ended earlier). */
export function snapshotAt(rows: RoundSnapshot[], round: number): RoundSnapshot | undefined {
	return rows.filter((b) => b.round <= round).pop() ?? rows[0];
}

/**
 * Per seat kind (`script:beast`, `script:fe`, `mock:…`): players, wins, final points, and for the
 * scripted kinds the averages at `SUMMARY_ROUNDS` (points, the engine's expected attack, dice by
 * tier, Beast / Fighter / Elementalist traits, Barrier, Max Barrier) and kills by monster level.
 * A player keeps the final value after the game ends.
 */
export function summarizeByKind(games: TableGameResult[]) {
	const kinds = [...new Set(games.flatMap((g) => g.seats.map((x) => seatKind(x.spec))))].sort();
	return Object.fromEntries(
		kinds.map((kind) => {
			const rows = games.flatMap((g) =>
				g.seats.filter((x) => seatKind(x.spec) === kind).map((x) => ({ g, x }))
			);
			const seats: SeatResult[] = rows.map((r) => r.x);
			const scripted = seats.filter((x) => x.scripted);
			const wins = rows.filter(({ g, x }) => g.winner === x.seat).length;
			const at = (pick: (snap: RoundSnapshot) => number) =>
				Object.fromEntries(
					SUMMARY_ROUNDS.map((r) => [
						`round${r}`,
						mean(
							scripted.map((x) => {
								const snap = snapshotAt(x.scripted!.byRound, r);
								return snap ? pick(snap) : 0;
							})
						)
					])
				);
			const perPlayer = (n: number) => Math.round((n / Math.max(1, scripted.length)) * 100) / 100;
			const kills = { lurker: 0, d1: 0, d2: 0, d3: 0 };
			for (const x of scripted)
				for (const k of Object.keys(kills) as (keyof typeof kills)[])
					kills[k] += x.scripted!.kills[k];
			return [
				kind,
				{
					players: seats.length,
					wins,
					/** Wins ÷ players of this kind (0.25 is an even share at a table of four). */
					winShare: seats.length ? Math.round((wins / seats.length) * 1000) / 1000 : null,
					finalVp: mean(seats.map((x) => x.finalVp)),
					pointsAt: Object.fromEntries(
						SUMMARY_ROUNDS.map((r) => [`round${r}`, mean(seats.map((x) => vpAt(x.vpByRound, r)))])
					),
					corruptionsPerPlayer:
						Math.round(
							(seats.reduce((n, x) => n + x.corruptions, 0) / Math.max(1, seats.length)) * 100
						) / 100,
					...(scripted.length
						? {
								attackAt: at((b) => b.attack),
								diceAt: {
									basic: at((b) => b.dice.basic),
									enchanted: at((b) => b.dice.enchanted),
									exalted: at((b) => b.dice.exalted),
									arcane: at((b) => b.dice.arcane)
								},
								beastAt: at((b) => b.beast),
								fighterAt: at((b) => b.fighter),
								elementalistAt: at((b) => b.elementalist),
								barrierAt: at((b) => b.barrier),
								maxBarrierAt: at((b) => b.maxBarrier),
								killsPerPlayer: {
									lurker: perPlayer(kills.lurker),
									d1: perPlayer(kills.d1),
									d2: perPlayer(kills.d2),
									d3: perPlayer(kills.d3)
								},
								fightsPerPlayer: perPlayer(
									scripted.reduce((n, x) => n + x.scripted!.fightsStarted, 0)
								)
							}
						: {})
				}
			];
		})
	);
}

export function summarizeFeRun(games: TableGameResult[]) {
	const scripted = games.flatMap((g) => g.seats.filter((s) => s.scripted).map((s) => ({ g, s })));
	const others = games.flatMap((g) => g.seats.filter((s) => !s.scripted));
	const ends = games.map((g) => g.endRound);
	const pointsAt = (rows: { vpByRound: number[] }[]) =>
		Object.fromEntries(
			[8, 16, 24].map((r) => [`round${r}`, mean(rows.map((x) => vpAt(x.vpByRound, r)))])
		);
	const reached = (pick: (x: (typeof scripted)[number]) => number | null) => {
		const rounds = scripted.map(pick).filter((r): r is number => r !== null);
		return {
			medianRound: median(rounds),
			share: scripted.length ? Math.round((rounds.length / scripted.length) * 1000) / 1000 : null
		};
	};
	const kills = { lurker: 0, d1: 0, d2: 0, d3: 0 };
	for (const { s } of scripted)
		for (const k of Object.keys(kills) as (keyof typeof kills)[]) kills[k] += s.scripted!.kills[k];
	const perPlayer = (n: number) => Math.round((n / Math.max(1, scripted.length)) * 100) / 100;
	const scriptedWins = games.filter(
		(g) => g.winner && g.seats.find((s) => s.seat === g.winner)?.scripted
	).length;
	return {
		games: games.length,
		finished: games.filter((g) => g.finished).length,
		stopReasons: games.reduce<Record<string, number>>(
			(m, g) => ((m[g.stopReason] = (m[g.stopReason] ?? 0) + 1), m),
			{}
		),
		fallbacks: games.reduce((n, g) => n + g.fallbacks, 0),
		endRound: {
			median: median(ends),
			min: Math.min(...ends),
			max: Math.max(...ends),
			mean: mean(ends)
		},
		scripted: {
			players: scripted.length,
			wins: scriptedWins,
			/** Wins ÷ games (with one scripted seat: its win rate; 0.25 is an even share at 4 seats). */
			winRate: games.length ? Math.round((scriptedWins / games.length) * 1000) / 1000 : null,
			finalVp: mean(scripted.map((x) => x.s.finalVp)),
			pointsAt: pointsAt(scripted.map((x) => x.s)),
			attackAt: Object.fromEntries(
				[8, 16, 24].map((r) => [
					`round${r}`,
					mean(
						scripted.map((x) => {
							const rows = x.s.scripted!.byRound;
							return (rows.filter((b) => b.round <= r).pop() ?? rows[0])?.attack ?? 0;
						})
					)
				])
			),
			fighter5: reached((x) => x.s.scripted!.roundFighter5),
			elementalist5: reached((x) => x.s.scripted!.roundElementalist5),
			tenExalted: reached((x) => x.s.scripted!.round10Exalted),
			killsPerPlayer: {
				lurker: perPlayer(kills.lurker),
				d1: perPlayer(kills.d1),
				d2: perPlayer(kills.d2),
				d3: perPlayer(kills.d3)
			},
			fightsPerPlayer: perPlayer(scripted.reduce((n, x) => n + x.s.scripted!.fightsStarted, 0)),
			bloodTakenPerPlayer: perPlayer(scripted.reduce((n, x) => n + x.s.scripted!.bloodTaken, 0)),
			corruptionsPerPlayer: perPlayer(scripted.reduce((n, x) => n + x.s.corruptions, 0))
		},
		/** Per seat kind: the numbers of `summarizeByKind`. */
		byKind: summarizeByKind(games),
		/** Per seat spec (A/B tables): players, wins, points. */
		bySpec: Object.fromEntries(
			[...new Set(games.flatMap((g) => g.seats.map((x) => x.spec)))].map((spec) => {
				const rows = games.flatMap((g) =>
					g.seats.filter((x) => x.spec === spec).map((x) => ({ g, x }))
				);
				return [
					spec,
					{
						players: rows.length,
						wins: rows.filter(({ g, x }) => g.winner === x.seat).length,
						finalVp: mean(rows.map(({ x }) => x.finalVp)),
						pointsAt: pointsAt(rows.map(({ x }) => x))
					}
				];
			})
		),
		others: others.length
			? {
					players: others.length,
					finalVp: mean(others.map((s) => s.finalVp)),
					pointsAt: pointsAt(others)
				}
			: null
	};
}
