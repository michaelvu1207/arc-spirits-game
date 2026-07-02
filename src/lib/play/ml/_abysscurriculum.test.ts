/**
 * Arcane Abyss curriculum DATA GENERATION. This is a teacher-data harness, not
 * a bot-quality claim: it injects farmable Abyss states, then records the
 * deterministic monster-farm route through the same observation/legal-action
 * contract used by live neural bots.
 *
 * Opt in:
 *
 *   ABYSSCURRICULUM=1 ABYSSCURRICULUM_GAMES=4 \
 *     npx vitest run src/lib/play/ml/_abysscurriculum.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { legalActionsWithNext, commandMatches, type LegalAction } from './actions';
import { encodeAction, encodeObs, OBS_DIM, ACT_DIM } from './encode';
import { appendSamples, loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import type { Sample } from './driver';
import type { NeuralPolicy } from './net';
import { hybridIndex, policyIndexWithProgressGuard, valueGuidedIndex } from './neuralBot';

const RUN = process.env.ABYSSCURRICULUM === '1';
const RUN_EVAL = process.env.ABYSSCURRICULUM_EVAL === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;

interface CurriculumBuild {
	diceCount: number;
	diceTier: DiceTier;
	maxBarrier: number;
	spiritAnimalCount: number;
}

interface CurriculumStats {
	combats: number;
	kills: number;
	rewards: number;
	rewardVp: number;
	samples: number;
	decisionTypes: Record<string, number>;
}

function parseNumberList(name: string, fallback: string, min: number, max: number): number[] {
	const raw = process.env[name] ?? fallback;
	const out = raw
		.split(',')
		.map((x) => Math.max(min, Math.min(max, parseInt(x.trim(), 10))))
		.filter((x) => Number.isFinite(x));
	return out.length ? [...new Set(out)] : [parseInt(fallback, 10)];
}

function parseCommandTypeSet(raw: string | undefined): Set<GameCommand['type']> {
	if (!raw?.trim()) return new Set();
	return new Set(raw.split(',').map((x) => x.trim()).filter(Boolean) as GameCommand['type'][]);
}

function initialDice(count: number, tier: DiceTier): AttackDie[] {
	return Array.from({ length: count }, (_, i) => ({ instanceId: `curriculum-${tier}-${i}`, tier }));
}

function routeSpiritAnimal(seat: SeatColor, count: number): PlaySpirit {
	return {
		slotIndex: 7,
		id: `curriculum-spirit-animal-${seat}-${count}`,
		name: `Curriculum Spirit Animal x${count}`,
		cost: 3,
		classes: { 'Spirit Animal': count },
		origins: {},
		isFaceDown: false
	};
}

function applyCurriculumBuild(state: PublicGameState, seat: SeatColor, build: CurriculumBuild): void {
	const player = state.players[seat];
	if (!player) return;
	player.attackDice = initialDice(build.diceCount, build.diceTier);
	player.maxBarrier = build.maxBarrier;
	player.barrier = build.maxBarrier;
	player.brokenBarrier = 0;
	if (build.spiritAnimalCount > 0) {
		player.spirits = [
			...player.spirits.filter((spirit) => !spirit.id.startsWith(`curriculum-spirit-animal-${seat}-`)),
			routeSpiritAnimal(seat, build.spiritAnimalCount)
		];
	}
}

function oneHot(n: number, idx: number): number[] {
	return Array.from({ length: n }, (_, i) => (i === idx ? 1 : 0));
}

function countType(stats: CurriculumStats, cmd: GameCommand): void {
	stats.decisionTypes[cmd.type] = (stats.decisionTypes[cmd.type] ?? 0) + 1;
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

function findFirstByType(withNext: LegalAction[], types: GameCommand['type'][]): number {
	for (const type of types) {
		const idx = withNext.findIndex((x) => x.cmd.type === type);
		if (idx >= 0) return idx;
	}
	return -1;
}

function chooseRewardIndex(state: PublicGameState, seat: SeatColor, withNext: LegalAction[]): number {
	let best = -1;
	let bestVp = -1;
	for (let i = 0; i < withNext.length; i++) {
		const cmd = withNext[i].cmd;
		if (cmd.type !== 'resolveMonsterReward') continue;
		const vp = rewardVpForCommand(state, seat, cmd);
		if (vp > bestVp) {
			best = i;
			bestVp = vp;
		}
	}
	return best;
}

function chooseTeacherIndex(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, withNext: LegalAction[]): number {
	switch (state.phase) {
		case 'navigation':
			return withNext.findIndex((x) => commandMatches(x.cmd, { type: 'lockNavigation', destination: 'Arcane Abyss' }));
		case 'encounter':
			return findFirstByType(withNext, ['passEncounter']);
		case 'location': {
			const rewardIdx = chooseRewardIndex(state, seat, withNext);
			if (rewardIdx >= 0) return rewardIdx;
			const player = state.players[seat];
			if (player?.pendingDraw || (player?.handDraws?.length ?? 0) > 0) {
				return findFirstByType(withNext, ['spawnHandSpirit', 'discardHandDraws', 'redrawHandDraws']);
			}
			return findFirstByType(withNext, ['startCombat', 'endLocationActions']);
		}
		case 'benefits':
			return findFirstByType(withNext, ['commitBenefits']);
		case 'awakening':
			return findFirstByType(withNext, [
				'resolveAwakenReward',
				'resolveDecision',
				'placeAugmentOnSpirit',
				'awakenSpirit',
				'manualAwaken',
				'dismissManualPrompt' as GameCommand['type'],
				'commitAwakening'
			]);
		case 'cleanup':
			return findFirstByType(withNext, [
				'resolveAwakenReward',
				'resolveDecision',
				'placeAugmentOnSpirit',
				'awakenSpirit',
				'discardSpirit',
				'discardRune',
				'commitCleanup'
			]);
		default:
			void catalog;
			return -1;
	}
}

function setupGame(catalog: PlayCatalog, seed: number, seatsN: number, build: CurriculumBuild): {
	state: PublicGameState;
	seats: SeatColor[];
} {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'ABYC', guardianNames });
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
	for (const seat of seats) applyCurriculumBuild(state, seat, build);
	return { state, seats };
}

function runCurriculumGame(
	catalog: PlayCatalog,
	seed: number,
	seatsN: number,
	build: CurriculumBuild,
	skipRecordTypes: Set<GameCommand['type']>
) {
	const setup = setupGame(catalog, seed, seatsN, build);
	let state = setup.state;
	const seats = setup.seats;
	const stats: CurriculumStats = {
		combats: 0,
		kills: 0,
		rewards: 0,
		rewardVp: 0,
		samples: 0,
		decisionTypes: {}
	};
	const samples: Sample[] = [];
	let ticks = 0;

	while (state.status === 'active' && state.round <= 30 && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const withNext = legalActionsWithNext(state, seat, catalog);
			if (withNext.length === 0) continue;
			const idx = chooseTeacherIndex(state, seat, catalog, withNext);
			if (idx < 0) continue;
			const chosen = withNext[idx];
			if (withNext.length > 1 && !skipRecordTypes.has(chosen.cmd.type)) {
					samples.push({
						obs: encodeObs(state, seat),
						cands: withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
						chosen: idx,
					pi: oneHot(withNext.length, idx),
					ret: 0,
					seat,
					vp: state.players[seat]?.victoryPoints ?? 0,
					phi: 0,
					kill: chosen.cmd.type === 'resolveMonsterReward' ? 1 : 0
				});
			}
			countType(stats, chosen.cmd);
			if (chosen.cmd.type === 'startCombat') {
				stats.combats++;
				const combat = chosen.next.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
				if (combat?.killed) stats.kills++;
			}
			if (chosen.cmd.type === 'resolveMonsterReward') {
				stats.rewards++;
				stats.rewardVp += rewardVpForCommand(state, seat, chosen.cmd);
			}
			state = chosen.next;
			progressed = true;
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
	for (const sample of samples) sample.ret = Math.max(0, Math.min(1, (finalVP[sample.seat] ?? 0) / 30));
	stats.samples = samples.length;
	return { state, seats, stats, finalVP, finalStatus, samples };
}

function choosePolicyIndex(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	selection: string
): number {
	if (withNext.length <= 1) return 0;
	const rand = (): number => 0.5;
	if (selection === 'value') return valueGuidedIndex(policy, state, seat, withNext, { sample: false, temperature: 1, rand }, catalog);
	if (selection === 'hybrid') return hybridIndex(policy, state, seat, withNext, { sample: false, temperature: 1, rand }, catalog);
	return policyIndexWithProgressGuard(policy, state, seat, withNext, { sample: false, temperature: 1, rand }, catalog);
}

function runPolicyCurriculumGame(
	catalog: PlayCatalog,
	seed: number,
	seatsN: number,
	build: CurriculumBuild,
	policy: NeuralPolicy,
	selection: string,
	forceAbyss: boolean
) {
	const setup = setupGame(catalog, seed, seatsN, build);
	let state = setup.state;
	const seats = setup.seats;
	const stats: CurriculumStats = {
		combats: 0,
		kills: 0,
		rewards: 0,
		rewardVp: 0,
		samples: 0,
		decisionTypes: {}
	};
	const actionCounter = new Map<string, number>();
	let ticks = 0;

	while (state.status === 'active' && state.round <= 30 && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const key = `${seat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			const withNext = legalActionsWithNext(state, seat, catalog);
			if (withNext.length === 0) continue;
			let idx = -1;
			if (forceAbyss && state.phase === 'navigation') {
				idx = withNext.findIndex((x) => commandMatches(x.cmd, { type: 'lockNavigation', destination: 'Arcane Abyss' }));
			}
			if (idx < 0) idx = choosePolicyIndex(policy, state, seat, catalog, withNext, selection);
			const chosen = withNext[idx];
			countType(stats, chosen.cmd);
			if (chosen.cmd.type === 'startCombat') {
				stats.combats++;
				const combat = chosen.next.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
				if (combat?.killed) stats.kills++;
			}
			if (chosen.cmd.type === 'resolveMonsterReward') {
				stats.rewards++;
				stats.rewardVp += rewardVpForCommand(state, seat, chosen.cmd);
			}
			state = chosen.next;
			actionCounter.set(key, used + 1);
			progressed = true;
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
	return { state, seats, stats, finalVP, finalStatus };
}

describe('Arcane Abyss curriculum data', () => {
	(RUN ? it : it.skip)(
		'writes contract-compatible teacher samples for mature Abyss farming',
		async () => {
			const games = parseInt(process.env.ABYSSCURRICULUM_GAMES ?? '4', 10);
			const seatsN = parseInt(process.env.ABYSSCURRICULUM_SEATS ?? '4', 10);
			const diceTier = (process.env.ABYSSCURRICULUM_DICE_TIER ?? 'arcane') as DiceTier;
			const diceCounts = parseNumberList('ABYSSCURRICULUM_DICE_COUNTS', '6,10', 0, 10);
			const maxBarriers = parseNumberList('ABYSSCURRICULUM_MAX_BARRIERS', '12,16,20', 1, 99);
			const spiritAnimalCounts = parseNumberList('ABYSSCURRICULUM_SPIRIT_ANIMALS', '2', 0, 12);
			const dataDir = process.env.ABYSSCURRICULUM_DATA_DIR ?? mlPath('data_abyss_curriculum');
			const outFile = process.env.ABYSSCURRICULUM_OUT ?? `${dataDir}/abyss_curriculum.jsonl`;
			const summaryFile = process.env.ABYSSCURRICULUM_SUMMARY ?? `${dataDir}/summary.json`;
			const skipRecordTypes = parseCommandTypeSet(process.env.ABYSSCURRICULUM_SKIP_RECORD_TYPES);
			rmSync(dataDir, { recursive: true, force: true });
			mkdirSync(dirname(outFile), { recursive: true });
			const catalog = await loadOrSnapshotCatalog();
			const rows = [];
			let totalSamples = 0;
			let totalSeatGames = 0;
			for (const diceCount of diceCounts) {
				for (const maxBarrier of maxBarriers) {
					for (const spiritAnimalCount of spiritAnimalCounts) {
						const build: CurriculumBuild = { diceCount, diceTier, maxBarrier, spiritAnimalCount };
						let vp = 0;
						let status = 0;
						let rounds = 0;
						const total: CurriculumStats = {
							combats: 0,
							kills: 0,
							rewards: 0,
							rewardVp: 0,
							samples: 0,
							decisionTypes: {}
						};
						for (let g = 0; g < games; g++) {
							const seed = 21_000_000 + diceCount * 10_000 + maxBarrier * 100 + spiritAnimalCount * 1000 + g;
							const result = runCurriculumGame(catalog, seed, seatsN, build, skipRecordTypes);
							appendSamples(outFile, result.samples, rows.length + 1);
							totalSamples += result.samples.length;
							rounds += result.state.round;
							for (const seat of result.seats) {
								totalSeatGames++;
								vp += result.finalVP[seat] ?? 0;
								status += result.finalStatus[seat] ?? 0;
							}
							total.combats += result.stats.combats;
							total.kills += result.stats.kills;
							total.rewards += result.stats.rewards;
							total.rewardVp += result.stats.rewardVp;
							total.samples += result.stats.samples;
							for (const [k, v] of Object.entries(result.stats.decisionTypes)) {
								total.decisionTypes[k] = (total.decisionTypes[k] ?? 0) + v;
							}
						}
						const seatGames = games * Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
						rows.push({
							diceCount,
							diceTier,
							maxBarrier,
							spiritAnimalCount,
							games,
							seatGames,
							avgVP: +(vp / Math.max(1, seatGames)).toFixed(2),
							avgStatus: +(status / Math.max(1, seatGames)).toFixed(2),
							avgRounds: +(rounds / Math.max(1, games)).toFixed(1),
							samples: total.samples,
							samplesPerSeatGame: +(total.samples / Math.max(1, seatGames)).toFixed(2),
							combatsPerSeatGame: +(total.combats / Math.max(1, seatGames)).toFixed(2),
							killsPerSeatGame: +(total.kills / Math.max(1, seatGames)).toFixed(2),
							rewardsPerSeatGame: +(total.rewards / Math.max(1, seatGames)).toFixed(2),
							rewardVpPerSeatGame: +(total.rewardVp / Math.max(1, seatGames)).toFixed(2),
							decisionTypes: total.decisionTypes
						});
					}
				}
			}
			mkdirSync(dirname(summaryFile), { recursive: true });
			writeFileSync(`${dataDir}/meta.json`, JSON.stringify({
				obs_dim: OBS_DIM,
				act_dim: ACT_DIM,
				samples: totalSamples,
				games: rows.length * games,
				seatGames: totalSeatGames,
				mode: 'abyss-curriculum',
				skipRecordTypes: [...skipRecordTypes],
				rows
			}, null, 2));
			writeFileSync(summaryFile, JSON.stringify({
				mode: 'abyss-curriculum',
				obs_dim: OBS_DIM,
				act_dim: ACT_DIM,
				outFile,
				skipRecordTypes: [...skipRecordTypes],
				totalSamples,
				totalSeatGames,
				rows
			}, null, 2));
			/* eslint-disable no-console */
			for (const row of rows) {
				console.log(
					`[abysscurriculum] dice=${row.diceCount}x${row.diceTier} maxBarrier=${row.maxBarrier} spiritAnimal=${row.spiritAnimalCount} samples=${row.samples} VP=${row.avgVP} kills/g=${row.killsPerSeatGame}`
				);
			}
			console.log(`[abysscurriculum] DONE -> ${outFile} (${totalSamples} samples)`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});

describe('Arcane Abyss curriculum policy eval', () => {
	(RUN_EVAL ? it : it.skip)(
		'reports whether a checkpoint can execute prebuilt Abyss farming states',
		async () => {
			const games = parseInt(process.env.ABYSSCURRICULUM_EVAL_GAMES ?? '4', 10);
			const seatsN = parseInt(process.env.ABYSSCURRICULUM_EVAL_SEATS ?? '4', 10);
			const diceTier = (process.env.ABYSSCURRICULUM_EVAL_DICE_TIER ?? 'arcane') as DiceTier;
			const diceCounts = parseNumberList('ABYSSCURRICULUM_EVAL_DICE_COUNTS', '6,10', 0, 10);
			const maxBarriers = parseNumberList('ABYSSCURRICULUM_EVAL_MAX_BARRIERS', '12,16,20', 1, 99);
			const spiritAnimalCounts = parseNumberList('ABYSSCURRICULUM_EVAL_SPIRIT_ANIMALS', '2', 0, 12);
			const weights = process.env.ABYSSCURRICULUM_EVAL_WEIGHTS ?? mlPath('weights', 'policy.json');
			const outFile = process.env.ABYSSCURRICULUM_EVAL_OUT ?? mlPath('abysscurriculum_eval_result.json');
			const selection = process.env.ABYSSCURRICULUM_EVAL_SELECTION ?? 'policy';
			const forceAbyss = process.env.ABYSSCURRICULUM_EVAL_FORCE_ABYSS !== '0';
			const policy = loadPolicyForEval(weights);
			const catalog = await loadOrSnapshotCatalog();
			const rows = [];
			for (const diceCount of diceCounts) {
				for (const maxBarrier of maxBarriers) {
					for (const spiritAnimalCount of spiritAnimalCounts) {
						const build: CurriculumBuild = { diceCount, diceTier, maxBarrier, spiritAnimalCount };
						let vp = 0;
						let status = 0;
						let rounds = 0;
						const total: CurriculumStats = {
							combats: 0,
							kills: 0,
							rewards: 0,
							rewardVp: 0,
							samples: 0,
							decisionTypes: {}
						};
						for (let g = 0; g < games; g++) {
							const seed = 31_000_000 + diceCount * 10_000 + maxBarrier * 100 + spiritAnimalCount * 1000 + g;
							const result = runPolicyCurriculumGame(catalog, seed, seatsN, build, policy, selection, forceAbyss);
							rounds += result.state.round;
							for (const seat of result.seats) {
								vp += result.finalVP[seat] ?? 0;
								status += result.finalStatus[seat] ?? 0;
							}
							total.combats += result.stats.combats;
							total.kills += result.stats.kills;
							total.rewards += result.stats.rewards;
							total.rewardVp += result.stats.rewardVp;
							for (const [k, v] of Object.entries(result.stats.decisionTypes)) {
								total.decisionTypes[k] = (total.decisionTypes[k] ?? 0) + v;
							}
						}
						const seatGames = games * Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
						rows.push({
							diceCount,
							diceTier,
							maxBarrier,
							spiritAnimalCount,
							games,
							seatGames,
							selection,
							forceAbyss,
							avgVP: +(vp / Math.max(1, seatGames)).toFixed(2),
							avgStatus: +(status / Math.max(1, seatGames)).toFixed(2),
							avgRounds: +(rounds / Math.max(1, games)).toFixed(1),
							combatsPerSeatGame: +(total.combats / Math.max(1, seatGames)).toFixed(2),
							killsPerSeatGame: +(total.kills / Math.max(1, seatGames)).toFixed(2),
							rewardsPerSeatGame: +(total.rewards / Math.max(1, seatGames)).toFixed(2),
							rewardVpPerSeatGame: +(total.rewardVp / Math.max(1, seatGames)).toFixed(2),
							decisionTypes: total.decisionTypes
						});
					}
				}
			}
			writeFileSync(outFile, JSON.stringify({ weights, rows }, null, 2));
			/* eslint-disable no-console */
			for (const row of rows) {
				console.log(
					`[abysscurriculum-eval] selection=${row.selection} dice=${row.diceCount}x${row.diceTier} maxBarrier=${row.maxBarrier} spiritAnimal=${row.spiritAnimalCount} VP=${row.avgVP} kills/g=${row.killsPerSeatGame}`
				);
			}
			console.log(`[abysscurriculum-eval] DONE -> ${outFile}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
