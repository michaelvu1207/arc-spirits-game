/**
 * Regression for the medium-opponent bug: a seat only plays its own net when it is in
 * `neuralSeats`. `opponentPolicies` alone is NOT enough — the driver gates net play on
 * neuralSet membership (driver: `neuralSet.has(seat) ? stepNeural : applyHeuristic`), so a
 * checkpoint opponent that isn't listed in neuralSeats silently plays the medium heuristic
 * and its `opponentPolicies` entry is ignored.
 *
 * buildMatchup emitted `neuralSeats: [learnerSeat]` from the M3 scaffold on, so every
 * frozen/PFSP/mirror opponent across ladder2-5 was a medium bot. The buildMatchup unit test
 * pins the fix (opponent-checkpoint seats now join neuralSeats); this test pins the driver
 * invariant that makes that fix load-bearing, and would have caught the bug at M3.
 */
import { describe, it, expect } from 'vitest';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { loadOrSnapshotCatalog, randomPolicy } from './nodeIo';

describe('driver neuralSeats routing (medium-opponent bug regression)', () => {
	it('a checkpoint opponent plays its net only when its seat is in neuralSeats', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const seatList = SEAT_COLORS.slice(0, 4) as SeatColor[];
		const learner = seatList[0];
		const oppSeat = seatList[1];
		const learnerNet = randomPolicy(1);
		const oppNet = randomPolicy(2); // distinct weights → decisions differ from medium

		// Only `learner` and `oppSeat` are ever candidates for a net; the other two seats stay
		// medium in every variant, so the sole moving part is how `oppSeat` is driven.
		const base = {
			seed: 424242,
			profiles: seatList.map(() => profileFor('medium')),
			maxRounds: 40,
			policy: learnerNet,
			selection: 'hybrid' as const,
			recordSeats: [] as SeatColor[]
		};

		// FIX routing: oppSeat is neural and carries its own net → it plays the net.
		const gNet = playRecordingGame(catalog, {
			...base,
			neuralSeats: [learner, oppSeat],
			opponentPolicies: { [oppSeat]: oppNet }
		});
		// BUG routing: oppSeat has an opponentPolicies entry but is NOT in neuralSeats →
		// the driver routes it to the medium heuristic and ignores the net.
		const gBug = playRecordingGame(catalog, {
			...base,
			neuralSeats: [learner],
			opponentPolicies: { [oppSeat]: oppNet }
		});
		// CONTROL: oppSeat explicitly plays medium (no opponentPolicies at all).
		const gMedium = playRecordingGame(catalog, {
			...base,
			neuralSeats: [learner]
		});

		// The bug routing is byte-identical to pure medium: the opponent's net was ignored.
		expect(gBug.finalVP).toEqual(gMedium.finalVP);
		expect(gBug.winnerSeat).toEqual(gMedium.winnerSeat);
		// The fix routing diverges from medium: the opponent actually used its net.
		expect(gNet.finalVP).not.toEqual(gMedium.finalVP);
	});
});
