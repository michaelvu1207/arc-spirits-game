import { describe, expect, test } from 'vitest';
import { buildPostgameInsights } from './postgameInsights';
import type { SpectatorProjection } from './types';

function room(): SpectatorProjection {
	return {
		activeSeats: ['Red', 'Blue'], winnerSeat: 'Blue', round: 5,
		players: {
			Red: {
				victoryPoints: 18, vpHistory: [2, 5, 11, 14, 18], statusLevel: 0,
				spirits: [
					{ isFaceDown: false, classes: { Cultivator: 2 } },
					{ isFaceDown: true, classes: { Fighter: 1 } }
				]
			},
			Blue: { victoryPoints: 22, vpHistory: [3, 8, 12, 17, 22], statusLevel: 0, spirits: [] }
		}
	} as unknown as SpectatorProjection;
}

describe('deterministic postgame insights', () => {
	test('reports recorded score evidence, dense placement, expression, and explicitly experimental advice', () => {
		const insight = buildPostgameInsights(room(), 'Red');
		expect(insight).not.toBeNull();
		expect(insight?.placement).toBe(2);
		expect(insight?.gapToLeader).toBe(4);
		expect(insight?.turningPoint).toEqual({ round: 3, gain: 6, from: 5, to: 11 });
		expect(insight?.topTrait).toEqual({ name: 'Cultivator', count: 2 });
		expect(insight?.observations.join(' ')).toContain('recorded');
		expect(insight?.nextExperiment).toMatch(/^Try /);
	});

	test('does not invent a turning point when the score never moved', () => {
		const value = room();
		value.players.Red!.victoryPoints = 0;
		value.players.Red!.vpHistory = [0, 0, 0];
		const insight = buildPostgameInsights(value, 'Red');
		expect(insight?.turningPoint).toBeNull();
		expect(insight?.nextExperiment).toContain('explicitly shows VP');
	});
});
