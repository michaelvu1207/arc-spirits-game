/**
 * Deterministic Arcane Abyss route sanity check. This is not a bot and not a
 * balance patch; it drives the real reducer through the owner's proposed line:
 * lock Arcane Abyss, start monster combat when legal, claim the highest-VP monster
 * reward tokens, resolve required draws, and end phases.
 *
 * Opt in:
 *
 *   ABYSSROUTE=1 ABYSSROUTE_GAMES=4 ABYSSROUTE_DICE_COUNTS=0,1,2 \
 *     npx vitest run src/lib/play/ml/_abyssroute.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { botActorFor, botSeatNeedsToAct } from '../server/botPolicy';
import { buildMonsterRewards } from '../monsterRewards';
import {
	SEAT_COLORS,
	type AttackDie,
	type DiceTier,
	type GameActor,
	type GameCommand,
	type PlayCatalog,
	type PlaySpirit,
	type PublicGameState,
	type SeatColor
} from '../types';
import { legalActionsWithNext } from './actions';
import { loadOrSnapshotCatalog, mlPath } from './nodeIo';

const RUN = process.env.ABYSSROUTE === '1';
const MAX_TICKS = 80_000;

interface RouteStats {
	combats: number;
	kills: number;
	rewards: number;
	rewardVp: number;
	vpFromRewardCommands: number;
	abyssLocks: number;
	decisionTypes: Record<string, number>;
	rewardLabels: Record<string, number>;
}

interface RouteBuild {
	diceCount: number;
	diceTier: DiceTier;
	maxBarrier?: number;
	spiritAnimalCount: number;
}

function parseDiceCounts(): number[] {
	const raw = process.env.ABYSSROUTE_DICE_COUNTS ?? '0,1,2';
	const out = raw
		.split(',')
		.map((x) => Math.max(0, Math.min(10, parseInt(x.trim(), 10))))
		.filter((x) => Number.isFinite(x));
	return out.length ? [...new Set(out)] : [0, 1, 2];
}

function parseOptionalNumberList(raw: string | undefined): Array<number | undefined> {
	if (!raw?.trim()) return [undefined];
	const out = raw
		.split(',')
		.map((x) => x.trim())
		.map((x) => (x === '' || x.toLowerCase() === 'default' ? undefined : parseInt(x, 10)))
		.filter((x): x is number | undefined => x === undefined || Number.isFinite(x))
		.map((x) => (x === undefined ? x : Math.max(1, Math.min(99, x))));
	return out.length ? [...new Set(out)] : [undefined];
}

function parseNumberList(name: string, fallback: string, min: number, max: number): number[] {
	const raw = process.env[name] ?? fallback;
	const out = raw
		.split(',')
		.map((x) => Math.max(min, Math.min(max, parseInt(x.trim(), 10))))
		.filter((x) => Number.isFinite(x));
	return out.length ? [...new Set(out)] : [parseInt(fallback, 10)];
}

function initialDice(count: number, tier: DiceTier): AttackDie[] {
	return Array.from({ length: count }, (_, i) => ({ instanceId: `route-${tier}-${i}`, tier }));
}

function routeSpiritAnimal(seat: SeatColor, count: number): PlaySpirit {
	return {
		slotIndex: 7,
		id: `route-spirit-animal-${seat}-${count}`,
		name: `Route Spirit Animal x${count}`,
		cost: 3,
		classes: { 'Spirit Animal': count },
		origins: {},
		isFaceDown: false
	};
}

function applyRouteBuild(state: PublicGameState, seat: SeatColor, build: RouteBuild): void {
	const player = state.players[seat];
	if (!player) return;
	player.attackDice = initialDice(build.diceCount, build.diceTier);
	if (build.maxBarrier !== undefined) {
		player.maxBarrier = build.maxBarrier;
		player.barrier = build.maxBarrier;
		player.brokenBarrier = 0;
	}
	if (build.spiritAnimalCount > 0) {
		player.spirits = [
			...player.spirits.filter((spirit) => spirit.id !== `route-spirit-animal-${seat}-${build.spiritAnimalCount}`),
			routeSpiritAnimal(seat, build.spiritAnimalCount)
		];
	}
}

function vpOf(state: PublicGameState, seat: SeatColor): number {
	return state.players[seat]?.victoryPoints ?? 0;
}

function countType(stats: RouteStats, cmd: GameCommand): void {
	stats.decisionTypes[cmd.type] = (stats.decisionTypes[cmd.type] ?? 0) + 1;
}

function highestVpRewardCommand(state: PublicGameState, seat: SeatColor): GameCommand | null {
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return null;
	const options = buildMonsterRewards(pending.rewardTrack);
	if (options.length === 0) return null;
	const picks = [...options]
		.sort((a, b) => {
			const av = a.effect.type === 'vp' ? a.effect.amount : 0;
			const bv = b.effect.type === 'vp' ? b.effect.amount : 0;
			return bv - av || a.index - b.index;
		})
		.slice(0, pending.chooseAmount)
		.map((x) => x.index);
	return { type: 'resolveMonsterReward', picks, choices: picks.map(() => 0) };
}

function rewardVpForCommand(state: PublicGameState, seat: SeatColor, cmd: GameCommand): number {
	if (cmd.type !== 'resolveMonsterReward') return 0;
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return 0;
	const options = buildMonsterRewards(pending.rewardTrack);
	let total = 0;
	for (const pick of cmd.picks ?? []) {
		const opt = options.find((x) => x.index === pick);
		if (opt?.effect.type === 'vp') total += opt.effect.amount;
	}
	return total;
}

function addRewardLabels(stats: RouteStats, state: PublicGameState, seat: SeatColor, cmd: GameCommand): void {
	if (cmd.type !== 'resolveMonsterReward') return;
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return;
	const options = buildMonsterRewards(pending.rewardTrack);
	for (const pick of cmd.picks ?? []) {
		const opt = options.find((x) => x.index === pick);
		if (opt) stats.rewardLabels[opt.label] = (stats.rewardLabels[opt.label] ?? 0) + 1;
	}
}

function firstLegal(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, types: GameCommand['type'][]): GameCommand | null {
	const legal = legalActionsWithNext(state, seat, catalog);
	for (const type of types) {
		const found = legal.find((x) => x.cmd.type === type);
		if (found) return found.cmd;
	}
	return null;
}

function routeCommand(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): GameCommand | null {
	switch (state.phase) {
		case 'navigation':
			return { type: 'lockNavigation', destination: 'Arcane Abyss' };
		case 'encounter':
			return firstLegal(state, seat, catalog, ['passEncounter']);
		case 'location': {
			const reward = highestVpRewardCommand(state, seat);
			if (reward) return reward;
			const player = state.players[seat];
			if (player?.pendingDraw || (player?.handDraws?.length ?? 0) > 0) {
				return firstLegal(state, seat, catalog, ['spawnHandSpirit', 'discardHandDraws', 'redrawHandDraws']);
			}
			return firstLegal(state, seat, catalog, ['startCombat', 'endLocationActions']);
		}
		case 'benefits':
			return firstLegal(state, seat, catalog, ['commitBenefits']);
		case 'awakening':
			return firstLegal(state, seat, catalog, [
				'resolveAwakenReward',
				'resolveDecision',
				'placeAugmentOnSpirit',
				'awakenSpirit',
				'manualAwaken',
				'dismissManualPrompt' as GameCommand['type'],
				'commitAwakening'
			]);
		case 'cleanup':
			return firstLegal(state, seat, catalog, [
				'resolveAwakenReward',
				'resolveDecision',
				'placeAugmentOnSpirit',
				'awakenSpirit',
				'discardSpirit',
				'discardRune',
				'commitCleanup'
			]);
		default:
			return null;
	}
}

function runRouteGame(catalog: PlayCatalog, seed: number, seatsN: number, build: RouteBuild) {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'ABYS', guardianNames });
	const stats: RouteStats = {
		combats: 0,
		kills: 0,
		rewards: 0,
		rewardVp: 0,
		vpFromRewardCommands: 0,
		abyssLocks: 0,
		decisionTypes: {},
		rewardLabels: {}
	};
	const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		const memberId = `bot-${seat}`;
		expectOk(
			applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog),
			`claimSeat ${seat}`
		);
		expectOk(
			applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog),
			`selectGuardian ${seat}`
		);
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed }, catalog), 'startGame');
	for (const seat of seats) {
		applyRouteBuild(state, seat, build);
	}

	let ticks = 0;
	while (state.status === 'active' && state.round <= 30 && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const cmd = routeCommand(state, seat, catalog);
			if (!cmd) continue;
			const beforeVp = vpOf(state, seat);
			const rewardVp = rewardVpForCommand(state, seat, cmd);
			addRewardLabels(stats, state, seat, cmd);
			const result = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
			if (!result.ok) continue;
			state = result.state;
			progressed = true;
			countType(stats, cmd);
			if (cmd.type === 'lockNavigation' && cmd.destination === 'Arcane Abyss') stats.abyssLocks++;
			if (cmd.type === 'startCombat') {
				stats.combats++;
				const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
				if (combat?.killed) stats.kills++;
			}
			if (cmd.type === 'resolveMonsterReward') {
				stats.rewards++;
				stats.rewardVp += rewardVp;
				stats.vpFromRewardCommands += vpOf(state, seat) - beforeVp;
			}
			if (state.status !== 'active') break;
		}
		if (state.status !== 'active') break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === sig) break;
		}
	}
	const finalVP: Record<string, number> = {};
	const finalStatus: Record<string, number> = {};
	for (const seat of seats) {
		finalVP[seat] = state.players[seat]?.victoryPoints ?? 0;
		finalStatus[seat] = state.players[seat]?.statusLevel ?? 0;
	}
	return { state, seats, stats, finalVP, finalStatus, ticks };
}

describe('Arcane Abyss route sanity', () => {
	(RUN ? it : it.skip)(
		'reports actual VP from deterministic Abyss farming',
		async () => {
			const games = parseInt(process.env.ABYSSROUTE_GAMES ?? '4', 10);
			const seatsN = parseInt(process.env.ABYSSROUTE_SEATS ?? '4', 10);
			const diceTier = (process.env.ABYSSROUTE_DICE_TIER ?? 'arcane') as DiceTier;
			const diceCounts = parseDiceCounts();
			const maxBarriers = parseOptionalNumberList(process.env.ABYSSROUTE_MAX_BARRIERS);
			const spiritAnimalCounts = parseNumberList('ABYSSROUTE_SPIRIT_ANIMALS', '0', 0, 12);
			const outPath = process.env.ABYSSROUTE_OUT ?? mlPath('abyssroute_result.json');
			const catalog = await loadOrSnapshotCatalog();
			const rows = [];
			for (const diceCount of diceCounts) {
				for (const maxBarrier of maxBarriers) {
					for (const spiritAnimalCount of spiritAnimalCounts) {
						const build: RouteBuild = { diceCount, diceTier, maxBarrier, spiritAnimalCount };
						let seatGames = 0;
						let vp = 0;
						let status = 0;
						let rounds = 0;
						let finished = 0;
						const total: RouteStats = {
							combats: 0,
							kills: 0,
							rewards: 0,
							rewardVp: 0,
							vpFromRewardCommands: 0,
							abyssLocks: 0,
							decisionTypes: {},
							rewardLabels: {}
						};
						for (let g = 0; g < games; g++) {
							const seed = 11_000_000 + diceCount * 10_000 + (maxBarrier ?? 0) * 100 + spiritAnimalCount * 1000 + g;
							const result = runRouteGame(catalog, seed, seatsN, build);
							if (result.state.status === 'finished') finished++;
							rounds += result.state.round;
							for (const seat of result.seats) {
								seatGames++;
								vp += result.finalVP[seat] ?? 0;
								status += result.finalStatus[seat] ?? 0;
							}
							total.combats += result.stats.combats;
							total.kills += result.stats.kills;
							total.rewards += result.stats.rewards;
							total.rewardVp += result.stats.rewardVp;
							total.vpFromRewardCommands += result.stats.vpFromRewardCommands;
							total.abyssLocks += result.stats.abyssLocks;
							for (const [k, v] of Object.entries(result.stats.decisionTypes)) {
								total.decisionTypes[k] = (total.decisionTypes[k] ?? 0) + v;
							}
							for (const [k, v] of Object.entries(result.stats.rewardLabels)) {
								total.rewardLabels[k] = (total.rewardLabels[k] ?? 0) + v;
							}
						}
						rows.push({
							diceCount,
							diceTier,
							startingMaxBarrier: maxBarrier ?? 'catalog-default',
							spiritAnimalCount,
							games,
							seatGames,
							avgVP: +(vp / Math.max(1, seatGames)).toFixed(2),
							avgStatus: +(status / Math.max(1, seatGames)).toFixed(2),
							avgRounds: +(rounds / Math.max(1, games)).toFixed(1),
							finishedPct: +((100 * finished) / Math.max(1, games)).toFixed(1),
							abyssLocksPerSeatGame: +(total.abyssLocks / Math.max(1, seatGames)).toFixed(2),
							combatsPerSeatGame: +(total.combats / Math.max(1, seatGames)).toFixed(2),
							killsPerSeatGame: +(total.kills / Math.max(1, seatGames)).toFixed(2),
							rewardsPerSeatGame: +(total.rewards / Math.max(1, seatGames)).toFixed(2),
							rewardVpPerSeatGame: +(total.rewardVp / Math.max(1, seatGames)).toFixed(2),
							actualVpFromRewardCommandsPerSeatGame: +(total.vpFromRewardCommands / Math.max(1, seatGames)).toFixed(2),
							decisionTypes: total.decisionTypes,
							rewardLabels: total.rewardLabels
						});
					}
				}
			}
			writeFileSync(outPath, JSON.stringify(rows, null, 2));
			/* eslint-disable no-console */
			for (const row of rows) {
				console.log(
					`[abyssroute] dice=${row.diceCount}x${row.diceTier} maxBarrier=${row.startingMaxBarrier} spiritAnimal=${row.spiritAnimalCount} VP=${row.avgVP} rewardVP=${row.rewardVpPerSeatGame} kills/g=${row.killsPerSeatGame} combats/g=${row.combatsPerSeatGame} rewards/g=${row.rewardsPerSeatGame}`
				);
			}
			console.log(`[abyssroute] DONE -> ${outPath}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
