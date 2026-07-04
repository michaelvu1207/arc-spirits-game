/**
 * Regression for the ladder8-C collapse-is-loss lever: the driver must stamp `allFallen=1` on
 * EVERY seat's terminal (done) row exactly when the game ended via the all-Fallen collapse (finished,
 * no seat reached 30 VP, every player Fallen), and 0 otherwise. The PPO trainer's --all-fallen-loss
 * reads this flag to price the collapse as a uniform loss. This test drives real games (aggressive
 * corruptors → collapse; paragon non-corruptors → reach-30/cap) and asserts the flag matches the
 * actual terminal condition, so the stamping can't silently drift from phases.ts's terminal logic.
 */
import { describe, it, expect } from 'vitest';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, VP_TO_WIN, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { loadOrSnapshotCatalog } from './nodeIo';

describe('allFallen terminal stamping (ladder8-C collapse-is-loss)', () => {
	it('stamps allFallen on every terminal row iff the game ended all-Fallen (no 30-VP finish)', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const seats = SEAT_COLORS.slice(0, 4) as SeatColor[];
		// pvphunter tables reliably collapse to all-Fallen (mutual PvP damage forces everyone
		// Fallen); paragon tables (non-corruptors) reach 30 / round-cap instead — covering both
		// branches of the stamp.
		const lineups: Array<{ profiles: string[]; seed: number }> = [
			...[101, 202, 303, 404, 505, 606].map((seed) => ({
				profiles: ['pvphunter', 'pvphunter', 'pvphunter', 'pvphunter'],
				seed
			})),
			...[707, 808, 909, 111].map((seed) => ({
				profiles: ['paragon', 'paragon', 'paragon', 'paragon'],
				seed
			}))
		];
		let sawAllFallen = false;
		let sawNonAllFallen = false;
		for (const { profiles, seed } of lineups) {
			const r = playRecordingGame(catalog, {
				seed,
				profiles: profiles.map((p) => profileFor(p)),
				maxRounds: 40,
				recordSeats: seats // record heuristic BC rows so terminal stamps land on samples
			});
			if (!r.finished) continue; // stall (rare) — nothing terminal to assert
			const fs = r.finalState?.players ?? {};
			const maxVp = Math.max(...seats.map((s) => r.finalVP[s] ?? 0));
			const allFallenEnd =
				maxVp < VP_TO_WIN && seats.every((s) => (fs[s]?.statusLevel ?? 0) >= 3);
			if (allFallenEnd) sawAllFallen = true;
			else sawNonAllFallen = true;

			const terminals = r.samples.filter((s) => s.done);
			expect(terminals.length).toBeGreaterThan(0);
			for (const t of terminals) {
				expect(t.allFallen).toBe(allFallenEnd ? 1 : 0);
				if (allFallenEnd) expect(t.won).toBe(0); // a collapse is never a 30-VP win
			}
		}
		// Coverage: the corruptor lineups produce the collapse, the paragon lineups don't.
		expect(sawAllFallen).toBe(true);
		expect(sawNonAllFallen).toBe(true);
	});
});
