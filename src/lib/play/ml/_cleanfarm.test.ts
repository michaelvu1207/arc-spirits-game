/**
 * Normal-start clean-farm oracle diagnostic.
 *
 * This is a proof harness, not a promotion gate. It drives real reducer games
 * from legal starts with named profiles, then records whether the profile ever
 * reaches farmable Abyss states: clean kill probability, boss-rung readiness,
 * monster reward VP, build stats, and corruption status.
 *
 *   CLEANFARM=1 CLEANFARM_PROFILES=paragon,farmer,farmer2,hard CLEANFARM_GAMES=4 \
 *     npx vitest run src/lib/play/ml/_cleanfarm.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	computeKillProbability,
	firepowerKillProbability,
	planBotPhaseActions,
	profileFor,
	type BotRandom
} from '../server/botPolicy';
import { DICE_TIER_FACES } from '../combat';
import { awakenedClassCounts } from '../effects/apply';
import { buildMonsterRewards } from '../monsterRewards';
import {
	SEAT_COLORS,
	type GameActor,
	type GameCommand,
	type PlayCatalog,
	type PrivatePlayerState,
	type PublicGameState,
	type SeatColor
} from '../types';
import { loadOrSnapshotCatalog, mlPath } from './nodeIo';
import { evaluateFarmValue } from './farmValue';

const RUN = process.env.CLEANFARM === '1';
const MAX_TICKS = 80_000;

interface ProfileTotals {
	profile: string;
	games: number;
	seatGames: number;
	wins: number;
	reach30: number;
	cleanReach30: number;
	sumVP: number;
	sumRounds: number;
	sumStatus: number;
	sumMaxBarrier: number;
	sumDice: number;
	sumExpectedAttack: number;
	sumSpiritAnimal: number;
	sumCultivator: number;
	sumElementalist: number;
	sumHealer: number;
	abyssNavs: number;
	combats: number;
	kills: number;
	rewards: number;
	rewardVp: number;
	pvpVp: number;
	farmableNavs: number;
	missedFarmableNavs: number;
	farmOpportunityVp: number;
	missedFarmOpportunityVp: number;
	bossFarmableNavs: number;
	missedBossFarmableNavs: number;
	firstFarmableRounds: number[];
	firstBossFarmableRounds: number[];
	firstReach30Rounds: number[];
	maxKillProb: number;
	maxFirepowerProb: number;
	maxExpectedAttack: number;
	maxPendingRewardVp: number;
	maxFarmOpportunityVp: number;
	rewardLabels: Record<string, number>;
	decisionTypes: Record<string, number>;
}

interface SeatTrace {
	firstFarmableRound: number | null;
	firstBossFarmableRound: number | null;
	firstReach30Round: number | null;
	maxKillProb: number;
	maxFirepowerProb: number;
	maxExpectedAttack: number;
	maxPendingRewardVp: number;
	maxFarmOpportunityVp: number;
}

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed);
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

function initTotals(profile: string): ProfileTotals {
	return {
		profile,
		games: 0,
		seatGames: 0,
		wins: 0,
		reach30: 0,
		cleanReach30: 0,
		sumVP: 0,
		sumRounds: 0,
		sumStatus: 0,
		sumMaxBarrier: 0,
		sumDice: 0,
		sumExpectedAttack: 0,
		sumSpiritAnimal: 0,
		sumCultivator: 0,
		sumElementalist: 0,
		sumHealer: 0,
		abyssNavs: 0,
		combats: 0,
		kills: 0,
		rewards: 0,
		rewardVp: 0,
		pvpVp: 0,
		farmableNavs: 0,
		missedFarmableNavs: 0,
		farmOpportunityVp: 0,
		missedFarmOpportunityVp: 0,
		bossFarmableNavs: 0,
		missedBossFarmableNavs: 0,
		firstFarmableRounds: [],
		firstBossFarmableRounds: [],
		firstReach30Rounds: [],
		maxKillProb: 0,
		maxFirepowerProb: 0,
		maxExpectedAttack: 0,
		maxPendingRewardVp: 0,
		maxFarmOpportunityVp: 0,
		rewardLabels: {},
		decisionTypes: {}
	};
}

function newSeatTrace(): SeatTrace {
	return {
		firstFarmableRound: null,
		firstBossFarmableRound: null,
		firstReach30Round: null,
		maxKillProb: 0,
		maxFirepowerProb: 0,
		maxExpectedAttack: 0,
		maxPendingRewardVp: 0,
		maxFarmOpportunityVp: 0
	};
}

function expectedAttackApprox(player: PrivatePlayerState | undefined): number {
	if (!player) return 0;
	let total = 0;
	for (const die of player.attackDice ?? []) {
		const faces = DICE_TIER_FACES[die.tier];
		if (!faces?.length) continue;
		total += faces.reduce((sum, face) => sum + face, 0) / faces.length;
	}
	const counts = awakenedClassCounts(player);
	total += counts['Spirit Animal'] ?? 0;
	total += counts.Sharpshooter ?? 0;
	total += counts['Dragon Warrior'] ?? 0;
	return total;
}

function pendingRewardVpPotential(state: PublicGameState, seat: SeatColor): number {
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return 0;
	return buildMonsterRewards(pending.rewardTrack)
		.map((opt) => (opt.effect.type === 'vp' ? opt.effect.amount : 0))
		.sort((a, b) => b - a)
		.slice(0, pending.chooseAmount)
		.reduce((sum, vp) => sum + vp, 0);
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

function addRewardLabels(total: ProfileTotals, state: PublicGameState, seat: SeatColor, cmd: GameCommand): void {
	if (cmd.type !== 'resolveMonsterReward') return;
	const pending = state.players[seat]?.pendingReward;
	if (!pending) return;
	const options = buildMonsterRewards(pending.rewardTrack);
	for (const pick of cmd.picks ?? []) {
		const opt = options.find((x) => x.index === pick);
		if (opt) total.rewardLabels[opt.label] = (total.rewardLabels[opt.label] ?? 0) + 1;
	}
}

function recordFarmability(
	trace: SeatTrace,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	farmableThreshold: number
): void {
	const player = state.players[seat];
	if (!player || !state.monster) return;
	const cleanKillProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const expected = expectedAttackApprox(player);
	const pendingVp = pendingRewardVpPotential(state, seat);
	const farmSignal = evaluateFarmValue(state, seat, catalog, { threshold: farmableThreshold });
	trace.maxKillProb = Math.max(trace.maxKillProb, cleanKillProb);
	trace.maxFirepowerProb = Math.max(trace.maxFirepowerProb, firepower);
	trace.maxExpectedAttack = Math.max(trace.maxExpectedAttack, expected);
	trace.maxPendingRewardVp = Math.max(trace.maxPendingRewardVp, pendingVp);
	trace.maxFarmOpportunityVp = Math.max(trace.maxFarmOpportunityVp, farmSignal.opportunityVp);
	if (trace.firstFarmableRound === null && farmSignal.valid && farmSignal.statusLevel === 0 && farmSignal.farmable) {
		trace.firstFarmableRound = state.round;
	}
	if (
		trace.firstBossFarmableRound === null &&
		farmSignal.valid &&
		farmSignal.statusLevel === 0 &&
		farmSignal.bossFarmable
	) {
		trace.firstBossFarmableRound = state.round;
	}
	if (trace.firstReach30Round === null && player.victoryPoints >= 30) {
		trace.firstReach30Round = state.round;
	}
}

function cleanFarmableFlags(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	farmableThreshold: number
): { farmable: boolean; bossFarmable: boolean; farmOpportunityVp: number } {
	const signal = evaluateFarmValue(state, seat, catalog, { threshold: farmableThreshold });
	if (!signal.valid || signal.statusLevel !== 0) {
		return { farmable: false, bossFarmable: false, farmOpportunityVp: 0 };
	}
	return {
		farmable: signal.farmable,
		bossFarmable: signal.bossFarmable,
		farmOpportunityVp: signal.opportunityVp
	};
}

function recordDecision(total: ProfileTotals, cmd: GameCommand): void {
	total.decisionTypes[cmd.type] = (total.decisionTypes[cmd.type] ?? 0) + 1;
}

describe('normal-start clean farm oracle', () => {
	(RUN ? it : it.skip)(
		'reports whether named profiles reach clean Abyss farmability from legal starts',
		async () => {
			const games = parseInt(process.env.CLEANFARM_GAMES ?? '4', 10);
			const seatsN = parseInt(process.env.CLEANFARM_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.CLEANFARM_MAXROUNDS ?? '30', 10);
			const threshold = parseFloat(process.env.CLEANFARM_KILL_THRESHOLD ?? '0.5');
			const profiles = (process.env.CLEANFARM_PROFILES ?? 'paragon,farmer,farmer2,hard')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const out = process.env.CLEANFARM_OUT ?? mlPath('cleanfarm_result.json');
			const catalog = await loadOrSnapshotCatalog();
			const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
			const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
			const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
			const totals = new Map<string, ProfileTotals>();

			for (const profileName of profiles) {
				const total = initTotals(profileName);
				totals.set(profileName, total);
				const profile = profileFor(profileName);
				for (let g = 0; g < games; g++) {
					let state = createLobbyState({ roomCode: 'CLNF', guardianNames });
					const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
						if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
						state = r.state;
					};
					seatList.forEach((seat, i) => {
						const memberId = `bot-${seat}`;
						expectOk(
							applyGameCommand(
								state,
								{ memberId, displayName: seat, role: 'player', seatColor: null },
								{ type: 'claimSeat', seatColor: seat },
								catalog
							),
							`claimSeat ${seat}`
						);
						expectOk(
							applyGameCommand(
								state,
								{ memberId, displayName: seat, role: 'player', seatColor: seat },
								{ type: 'selectGuardian', guardianName: guardianNames[i] },
								catalog
							),
							`selectGuardian ${seat}`
						);
					});
					expectOk(applyGameCommand(state, host, { type: 'startGame', seed: 7_700_000 + g }, catalog), 'startGame');

					total.games++;
					const rng = seededBotRandom((7_700_000 + g) ^ 0x2f6e2b1);
					const traces: Record<string, SeatTrace> = Object.fromEntries(
						seatList.map((seat) => [seat, newSeatTrace()])
					);

					let ticks = 0;
					while (state.status === 'active' && state.round <= maxRounds) {
						if (++ticks > MAX_TICKS) break;
						let progressed = false;
						for (const seat of state.activeSeats) {
							recordFarmability(traces[seat], state, seat, catalog, threshold);
							if (!botSeatNeedsToAct(state, seat)) continue;
							const navFarmability =
								state.phase === 'navigation'
									? cleanFarmableFlags(state, seat, catalog, threshold)
									: { farmable: false, bossFarmable: false, farmOpportunityVp: 0 };
							const plan = planBotPhaseActions(state, seat, catalog, rng, profile);
							if (navFarmability.farmable) {
								total.farmableNavs++;
								total.farmOpportunityVp += navFarmability.farmOpportunityVp;
								const goesAbyss = plan.some((cmd) => cmd.type === 'lockNavigation' && cmd.destination === 'Arcane Abyss');
								if (!goesAbyss) {
									total.missedFarmableNavs++;
									total.missedFarmOpportunityVp += navFarmability.farmOpportunityVp;
								}
							}
							if (navFarmability.bossFarmable) {
								total.bossFarmableNavs++;
								const goesAbyss = plan.some((cmd) => cmd.type === 'lockNavigation' && cmd.destination === 'Arcane Abyss');
								if (!goesAbyss) total.missedBossFarmableNavs++;
							}
							for (const cmd of plan) {
								const beforeVp = state.players[seat]?.victoryPoints ?? 0;
								const rewardVp = rewardVpForCommand(state, seat, cmd);
								addRewardLabels(total, state, seat, cmd);
								const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
								if (!r.ok) break;
								state = r.state;
								progressed = true;
								recordDecision(total, cmd);
								recordFarmability(traces[seat], state, seat, catalog, threshold);
								if (cmd.type === 'lockNavigation' && cmd.destination === 'Arcane Abyss') total.abyssNavs++;
								if (cmd.type === 'startCombat') {
									total.combats++;
									const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
									if (combat?.killed) total.kills++;
								}
								if (cmd.type === 'resolveMonsterReward') {
									total.rewards++;
									total.rewardVp += rewardVp;
								}
								if (cmd.type === 'initiatePvp') {
									total.pvpVp += Math.max(0, (state.players[seat]?.victoryPoints ?? 0) - beforeVp);
								}
								if (state.status !== 'active') break;
							}
							if (state.status !== 'active') break;
						}
						if (state.status !== 'active') break;
						if (!progressed) {
							const sig = `${state.phase}:${state.round}`;
							applyDeadlineAdvance(state, catalog);
							for (const seat of state.activeSeats) recordFarmability(traces[seat], state, seat, catalog, threshold);
							if (`${state.phase}:${state.round}` === sig) break;
						}
					}

					for (const seat of seatList) {
						const player = state.players[seat];
						const trace = traces[seat];
						if (!player) continue;
						const classes = awakenedClassCounts(player);
						const vp = player.victoryPoints ?? 0;
						total.seatGames++;
						if (state.winnerSeat === seat) total.wins++;
						if (vp >= 30) total.reach30++;
						if (vp >= 30 && (player.statusLevel ?? 0) <= 1) total.cleanReach30++;
						total.sumVP += vp;
						total.sumRounds += state.round;
						total.sumStatus += player.statusLevel ?? 0;
						total.sumMaxBarrier += player.maxBarrier ?? 0;
						total.sumDice += player.attackDice?.length ?? 0;
						total.sumExpectedAttack += expectedAttackApprox(player);
						total.sumSpiritAnimal += classes['Spirit Animal'] ?? 0;
						total.sumCultivator += classes.Cultivator ?? 0;
						total.sumElementalist += classes.Elementalist ?? 0;
						total.sumHealer += classes.Healer ?? 0;
						total.maxKillProb = Math.max(total.maxKillProb, trace.maxKillProb);
						total.maxFirepowerProb = Math.max(total.maxFirepowerProb, trace.maxFirepowerProb);
						total.maxExpectedAttack = Math.max(total.maxExpectedAttack, trace.maxExpectedAttack);
						total.maxPendingRewardVp = Math.max(total.maxPendingRewardVp, trace.maxPendingRewardVp);
						total.maxFarmOpportunityVp = Math.max(total.maxFarmOpportunityVp, trace.maxFarmOpportunityVp);
						if (trace.firstFarmableRound !== null) total.firstFarmableRounds.push(trace.firstFarmableRound);
						if (trace.firstBossFarmableRound !== null) total.firstBossFarmableRounds.push(trace.firstBossFarmableRound);
						if (trace.firstReach30Round !== null) total.firstReach30Rounds.push(trace.firstReach30Round);
					}
				}
			}

			const avg = (values: number[]): number | null =>
				values.length ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : null;
			const rows = [...totals.values()].map((t) => ({
				profile: t.profile,
				games: t.games,
				seatGames: t.seatGames,
				winPct: +((100 * t.wins) / Math.max(1, t.seatGames)).toFixed(1),
				reach30Pct: +((100 * t.reach30) / Math.max(1, t.seatGames)).toFixed(1),
				cleanReach30Pct: +((100 * t.cleanReach30) / Math.max(1, t.seatGames)).toFixed(1),
				avgVP: +(t.sumVP / Math.max(1, t.seatGames)).toFixed(2),
				avgRounds: +(t.sumRounds / Math.max(1, t.seatGames)).toFixed(1),
				avgStatus: +(t.sumStatus / Math.max(1, t.seatGames)).toFixed(2),
				avgMaxBarrier: +(t.sumMaxBarrier / Math.max(1, t.seatGames)).toFixed(2),
				avgDice: +(t.sumDice / Math.max(1, t.seatGames)).toFixed(2),
				avgExpectedAttack: +(t.sumExpectedAttack / Math.max(1, t.seatGames)).toFixed(2),
				avgSpiritAnimal: +(t.sumSpiritAnimal / Math.max(1, t.seatGames)).toFixed(2),
				avgCultivator: +(t.sumCultivator / Math.max(1, t.seatGames)).toFixed(2),
				avgElementalist: +(t.sumElementalist / Math.max(1, t.seatGames)).toFixed(2),
				avgHealer: +(t.sumHealer / Math.max(1, t.seatGames)).toFixed(2),
				abyssNavsPerSeatGame: +(t.abyssNavs / Math.max(1, t.seatGames)).toFixed(2),
				combatsPerSeatGame: +(t.combats / Math.max(1, t.seatGames)).toFixed(2),
				killsPerSeatGame: +(t.kills / Math.max(1, t.seatGames)).toFixed(2),
				rewardsPerSeatGame: +(t.rewards / Math.max(1, t.seatGames)).toFixed(2),
				rewardVpPerSeatGame: +(t.rewardVp / Math.max(1, t.seatGames)).toFixed(2),
				pvpVpPerSeatGame: +(t.pvpVp / Math.max(1, t.seatGames)).toFixed(2),
				farmableNavsPerSeatGame: +(t.farmableNavs / Math.max(1, t.seatGames)).toFixed(2),
				missedFarmableNavsPerSeatGame: +(t.missedFarmableNavs / Math.max(1, t.seatGames)).toFixed(2),
				missedFarmableNavPct: +((100 * t.missedFarmableNavs) / Math.max(1, t.farmableNavs)).toFixed(1),
				farmOpportunityVpPerSeatGame: +(t.farmOpportunityVp / Math.max(1, t.seatGames)).toFixed(2),
				missedFarmOpportunityVpPerSeatGame: +(t.missedFarmOpportunityVp / Math.max(1, t.seatGames)).toFixed(2),
				missedFarmOpportunityVpPct: +((100 * t.missedFarmOpportunityVp) / Math.max(1, t.farmOpportunityVp)).toFixed(1),
				bossFarmableNavsPerSeatGame: +(t.bossFarmableNavs / Math.max(1, t.seatGames)).toFixed(2),
				missedBossFarmableNavsPerSeatGame: +(t.missedBossFarmableNavs / Math.max(1, t.seatGames)).toFixed(2),
				missedBossFarmableNavPct: +((100 * t.missedBossFarmableNavs) / Math.max(1, t.bossFarmableNavs)).toFixed(1),
				farmableSeatPct: +((100 * t.firstFarmableRounds.length) / Math.max(1, t.seatGames)).toFixed(1),
				bossFarmableSeatPct: +((100 * t.firstBossFarmableRounds.length) / Math.max(1, t.seatGames)).toFixed(1),
				avgFirstFarmableRound: avg(t.firstFarmableRounds),
				avgFirstBossFarmableRound: avg(t.firstBossFarmableRounds),
				avgFirstReach30Round: avg(t.firstReach30Rounds),
				maxKillProb: +t.maxKillProb.toFixed(3),
				maxFirepowerProb: +t.maxFirepowerProb.toFixed(3),
				maxExpectedAttack: +t.maxExpectedAttack.toFixed(2),
				maxPendingRewardVp: +t.maxPendingRewardVp.toFixed(2),
				maxFarmOpportunityVp: +t.maxFarmOpportunityVp.toFixed(2),
				rewardLabels: t.rewardLabels,
				decisionTypes: Object.fromEntries(
					Object.entries(t.decisionTypes).sort((a, b) => b[1] - a[1]).slice(0, 20)
				)
			})).sort((a, b) => b.cleanReach30Pct - a.cleanReach30Pct || b.avgVP - a.avgVP);

			writeFileSync(out, JSON.stringify(rows, null, 2));
			/* eslint-disable no-console */
			console.log(`\n[cleanfarm] profiles=${profiles.join(',')} games=${games} seats=${n} threshold=${threshold}`);
			for (const row of rows) {
				console.log(
					`[cleanfarm] ${row.profile.padEnd(10)} VP=${row.avgVP.toFixed(2)} r30=${row.reach30Pct.toFixed(1)} clean30=${row.cleanReach30Pct.toFixed(1)} status=${row.avgStatus.toFixed(2)} rewardVP=${row.rewardVpPerSeatGame.toFixed(2)} kills=${row.killsPerSeatGame.toFixed(2)} farmable=${row.farmableSeatPct.toFixed(1)}% missedNav=${row.missedFarmableNavPct.toFixed(1)}% boss=${row.bossFarmableSeatPct.toFixed(1)}% firstFarm=${row.avgFirstFarmableRound ?? '-'}`
				);
			}
			console.log(`[cleanfarm] DONE -> ${out}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
