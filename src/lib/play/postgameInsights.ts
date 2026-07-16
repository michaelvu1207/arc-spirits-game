import type { PlayerProjection, SeatColor, SpectatorProjection } from './types';

export interface ScoreTurningPoint {
	round: number;
	gain: number;
	from: number;
	to: number;
}

export interface PostgameInsights {
	finalVp: number;
	placement: number;
	gapToLeader: number;
	turningPoint: ScoreTurningPoint | null;
	topTrait: { name: string; count: number } | null;
	awakenedSpirits: number;
	faceDownSpirits: number;
	observations: string[];
	nextExperiment: string;
}

function densePlacement(room: SpectatorProjection, seat: SeatColor): number {
	if (room.winnerSeat === seat) return 1;
	const winnerOffset = room.winnerSeat ? 1 : 0;
	const values = room.activeSeats
		.filter((candidate) => candidate !== room.winnerSeat)
		.map((candidate) => room.players[candidate]?.victoryPoints ?? 0)
		.sort((a, b) => b - a);
	const mine = room.players[seat]?.victoryPoints ?? 0;
	return winnerOffset + 1 + new Set(values.filter((vp) => vp > mine)).size;
}

function scoreTurningPoint(player: PlayerProjection): ScoreTurningPoint | null {
	const history = [...(player.vpHistory ?? [])];
	if (history.at(-1) !== player.victoryPoints) history.push(player.victoryPoints);
	let previous = 0;
	let best: ScoreTurningPoint | null = null;
	for (let i = 0; i < history.length; i += 1) {
		const value = Math.max(0, Number(history[i] ?? 0));
		const gain = value - previous;
		if (gain > 0 && (!best || gain > best.gain)) {
			best = { round: i + 1, gain, from: previous, to: value };
		}
		previous = value;
	}
	return best;
}

function topTrait(player: PlayerProjection): { name: string; count: number } | null {
	const counts = new Map<string, number>();
	for (const spirit of player.spirits ?? []) {
		if (spirit.isFaceDown) continue;
		for (const [name, raw] of Object.entries(spirit.classes ?? {})) {
			counts.set(name, (counts.get(name) ?? 0) + (typeof raw === 'number' ? raw : 1));
		}
	}
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return ranked[0] ? { name: ranked[0][0], count: ranked[0][1] } : null;
}

/**
 * Deterministic postgame explanation built only from public, recorded board state.
 * It describes evidence and labels the advice as an experiment; it never claims a
 * counterfactual move would certainly have changed the result.
 */
export function buildPostgameInsights(
	room: SpectatorProjection,
	seat: SeatColor
): PostgameInsights | null {
	const player = room.players[seat];
	if (!player) return null;
	const leaderVp = Math.max(...room.activeSeats.map((candidate) => room.players[candidate]?.victoryPoints ?? 0));
	const turningPoint = scoreTurningPoint(player);
	const trait = topTrait(player);
	const awakenedSpirits = player.spirits.filter((spirit) => !spirit.isFaceDown).length;
	const faceDownSpirits = player.spirits.length - awakenedSpirits;
	const placement = densePlacement(room, seat);
	const gapToLeader = Math.max(0, leaderVp - player.victoryPoints);
	const observations = [
		`Finished ${placement === 1 ? '1st' : `#${placement}`} with ${player.victoryPoints} VP${gapToLeader > 0 ? `, ${gapToLeader} behind the leader` : ''}.`,
		turningPoint
			? `Largest recorded score jump: +${turningPoint.gain} VP in round ${turningPoint.round} (${turningPoint.from} → ${turningPoint.to}).`
			: 'No positive end-of-round VP jump was recorded.',
		trait
			? `Most expressed awakened trait: ${trait.name} ×${trait.count}.`
			: `Awakened spirits: ${awakenedSpirits}; face-down spirits: ${faceDownSpirits}.`
	];

	let nextExperiment: string;
	if (player.victoryPoints === 0) {
		nextExperiment = 'Try prioritizing a reward row that explicitly shows VP, then compare the next score timeline.';
	} else if (faceDownSpirits > awakenedSpirits) {
		nextExperiment = `Try awakening one more spirit before the late rounds; ${faceDownSpirits} remained face-down in this recorded finish.`;
	} else if ((player.statusLevel ?? 0) >= 2) {
		nextExperiment = 'Try preserving more barrier before a high-risk action, then compare your corruption level and final VP.';
	} else if (trait) {
		nextExperiment = `Try choosing one more deterministic reward that supports ${trait.name}, then compare whether its next threshold changes your scoring.`;
	} else {
		nextExperiment = 'Try one different destination in the opening rounds and compare the recorded score timeline.';
	}

	return {
		finalVp: player.victoryPoints,
		placement,
		gapToLeader,
		turningPoint,
		topTrait: trait,
		awakenedSpirits,
		faceDownSpirits,
		observations,
		nextExperiment
	};
}
