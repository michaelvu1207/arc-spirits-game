/**
 * VP-BY-SOURCE audit. Drives all-heuristic games and attributes every per-seat VP gain to the
 * COMMAND that produced it (monster-reward claim, PvP +3, auto/cleanup class VP, …), and counts
 * monster-combat attempts + kills. Answers the owner's question directly: do bots ever kill the
 * monster, and where does their VP actually come from? If monster-reward VP ≈ 0 while combat
 * attempts > 0, kills are failing (survival/damage). If attempts ≈ 0, bots never even engage.
 *
 *   VPSRC=1 VPSRC_PROFILES=cultivator,paragon,medium,survivor,fighter,pvphunter VPSRC_GAMES=40 VPSRC_SEATS=4 \
 *     npx vitest run src/lib/play/ml/_vpsource.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import {
	planBotPhaseActions,
	botActorFor,
	botSeatNeedsToAct,
	profileFor,
	type BotRandom
} from '../server/botPolicy';
import { SEAT_COLORS, type GameActor, type SeatColor } from '../types';
import { loadOrSnapshotCatalog, mlPath } from './nodeIo';

const RUN = process.env.VPSRC === '1';

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed);
	return { int: (m: number) => nextInt(rng, m), chance: () => nextInt(rng, 2) === 0 };
}

interface Agg {
	name: string;
	games: number;
	wins: number;
	reached30: number;
	sumVP: number;
	sumStatus: number;
	sumBarrier: number;
	sumDice: number;
	monsterKills: number; // total monster kills credited to this profile
	combatAttempts: number; // total startCombat commands issued
	pvpAttacks: number; // total initiatePvp commands issued
	vpBySource: Record<string, number>; // total VP gained, keyed by the command that produced it
}

const MAX_TICKS = 50_000;

describe('VP-by-source audit', () => {
	(RUN ? it : it.skip)(
		'attribute VP to source command + count monster kills',
		async () => {
			const games = parseInt(process.env.VPSRC_GAMES ?? '40', 10);
			const seats = parseInt(process.env.VPSRC_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.VPSRC_MAXROUNDS ?? '30', 10);
			const profiles = (
				process.env.VPSRC_PROFILES ?? 'cultivator,paragon,medium,survivor,fighter,pvphunter'
			)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const catalog = await loadOrSnapshotCatalog();
			const n = Math.min(seats, SEAT_COLORS.length, catalog.guardians.length);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
			const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);

			const agg = new Map<string, Agg>();
			const get = (nm: string): Agg => {
				let a = agg.get(nm);
				if (!a) {
					a = {
						name: nm,
						games: 0,
						wins: 0,
						reached30: 0,
						sumVP: 0,
						sumStatus: 0,
						sumBarrier: 0,
						sumDice: 0,
						monsterKills: 0,
						combatAttempts: 0,
						pvpAttacks: 0,
						vpBySource: {}
					};
					agg.set(nm, a);
				}
				return a;
			};

			const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };

			for (let g = 0; g < games; g++) {
				const seatProfiles = seatList.map((_, i) => profiles[(g + i) % profiles.length]);
				const botRng = seededBotRandom((9_000_000 + g) ^ 0x5bd1e995);

				let state = createLobbyState({ roomCode: 'VPSRC', guardianNames });
				const expectOk = (r: ReturnType<typeof applyGameCommand>): void => {
					if (!r.ok) throw new Error(`setup: ${r.error.code} ${r.error.message}`);
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
						)
					);
					expectOk(
						applyGameCommand(
							state,
							{ memberId, displayName: seat, role: 'player', seatColor: seat },
							{ type: 'selectGuardian', guardianName: guardianNames[i] },
							catalog
						)
					);
				});
				expectOk(applyGameCommand(state, host, { type: 'startGame', seed: 9_000_000 + g }, catalog));

				// per-seat trackers for THIS game
				const vpSrc: Record<string, Record<string, number>> = {};
				const kills: Record<string, number> = {};
				const combatAttempts: Record<string, number> = {};
				const pvpAttacks: Record<string, number> = {};
				for (const s of seatList) {
					vpSrc[s] = {};
					kills[s] = 0;
					combatAttempts[s] = 0;
					pvpAttacks[s] = 0;
				}
				const vpNow = (): Record<string, number> => {
					const o: Record<string, number> = {};
					for (const s of seatList) o[s] = state.players[s]?.victoryPoints ?? 0;
					return o;
				};
				const attribute = (before: Record<string, number>, bucket: string): void => {
					for (const s of seatList) {
						const d = (state.players[s]?.victoryPoints ?? 0) - before[s];
						if (d !== 0) vpSrc[s][bucket] = (vpSrc[s][bucket] ?? 0) + d;
					}
				};

				let ticks = 0;
				while (state.status === 'active' && state.round <= maxRounds) {
					if (++ticks > MAX_TICKS) break;
					let progressed = false;
					for (const seat of state.activeSeats) {
						if (!botSeatNeedsToAct(state, seat)) continue;
						const profile = profileFor(seatProfiles[seatList.indexOf(seat)]);
						const plan = planBotPhaseActions(state, seat, catalog, botRng, profile);
						for (const cmd of plan) {
							const before = vpNow();
							const res = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, {
								mutate: true
							});
							if (!res.ok) break;
							state = res.state;
							progressed = true;
							attribute(before, cmd.type);
							if (cmd.type === 'startCombat') {
								combatAttempts[seat]++;
								const mc = state.combats.find(
									(c) => c.kind === 'monster' && c.sides[0]?.seat === seat
								);
								if (mc?.killed) kills[seat]++;
							} else if (cmd.type === 'initiatePvp') {
								pvpAttacks[seat]++;
							}
							if (state.status !== 'active') break;
						}
						if (state.status !== 'active') break;
					}
					if (state.status !== 'active') break;
					if (!progressed) {
						const before = vpNow();
						const sig = `${state.phase}:${state.round}`;
						applyDeadlineAdvance(state, catalog);
						attribute(before, 'AUTO(cleanup/class)');
						if (`${state.phase}:${state.round}` === sig) break; // stalled
					}
				}

				// fold this game into the aggregates
				seatList.forEach((seat) => {
					const a = get(seatProfiles[seatList.indexOf(seat)]);
					const p = state.players[seat];
					const vp = p?.victoryPoints ?? 0;
					a.games++;
					if (state.winnerSeat === seat) a.wins++;
					if (vp >= 30) a.reached30++;
					a.sumVP += vp;
					a.sumStatus += p?.statusLevel ?? 0;
					a.sumBarrier += p?.maxBarrier ?? 0;
					a.sumDice += p?.attackDice?.length ?? 0;
					a.monsterKills += kills[seat];
					a.combatAttempts += combatAttempts[seat];
					a.pvpAttacks += pvpAttacks[seat];
					for (const [k, v] of Object.entries(vpSrc[seat])) {
						a.vpBySource[k] = (a.vpBySource[k] ?? 0) + v;
					}
				});
			}

			const rows = [...agg.values()]
				.map((a) => {
					const src: Record<string, number> = {};
					for (const [k, v] of Object.entries(a.vpBySource)) src[k] = +(v / a.games).toFixed(2);
					return {
						name: a.name,
						avgVP: +(a.sumVP / a.games).toFixed(2),
						winPct: +((100 * a.wins) / a.games).toFixed(0),
						reach30: +((100 * a.reached30) / a.games).toFixed(0),
						status: +(a.sumStatus / a.games).toFixed(2),
						barrier: +(a.sumBarrier / a.games).toFixed(1),
						dice: +(a.sumDice / a.games).toFixed(1),
						monsterKillsPerGame: +(a.monsterKills / a.games).toFixed(2),
						combatAttemptsPerGame: +(a.combatAttempts / a.games).toFixed(2),
						pvpAttacksPerGame: +(a.pvpAttacks / a.games).toFixed(2),
						vpBySourcePerGame: src,
						games: a.games
					};
				})
				.sort((x, y) => y.avgVP - x.avgVP);

			/* eslint-disable no-console */
			console.log(
				`\n[vpsrc] ${rows.length} profiles, ${games} games, ${n}p, maxRounds=${maxRounds} (sorted by VP):`
			);
			for (const r of rows) {
				console.log(
					`[vpsrc] ${r.name.padEnd(11)} VP=${r.avgVP.toFixed(1).padStart(5)} win%=${String(r.winPct).padStart(3)} r30%=${String(r.reach30).padStart(3)} status=${r.status.toFixed(2)} barrier=${r.barrier.toFixed(1)} dice=${r.dice.toFixed(1)} | kills/g=${r.monsterKillsPerGame.toFixed(2)} combat/g=${r.combatAttemptsPerGame.toFixed(2)} pvp/g=${r.pvpAttacksPerGame.toFixed(2)}`
				);
				console.log(`[vpsrc]     VP source: ${JSON.stringify(r.vpBySourcePerGame)}`);
			}
			writeFileSync(mlPath('vpsource_result.json'), JSON.stringify(rows, null, 2));
			console.log(`[vpsrc] DONE → ml/vpsource_result.json`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
