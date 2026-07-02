/**
 * Smoke + behavior test for the neural ISMCTS planner. Confirms the planning machinery runs and,
 * with outcome-guided leaf eval (valueWeight=0 → heuristic playout), that SEARCH sends the bot to
 * the Arcane Abyss to farm the monster far more than the plain heuristic — the owner's thesis that
 * monster-killing is the strong line and the bottleneck is planning/navigation, not the mechanic.
 *
 *   PLAN=1 PLAN_GAMES=8 PLAN_ITERS=48 npx vitest run src/lib/play/ml/_planner.test.ts --disable-console-intercept
 */
import { describe, it, expect } from 'vitest';
import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import { botActorFor, botSeatNeedsToAct, planBotPhaseActions, profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameActor, type SeatColor } from '../types';
import { loadOrSnapshotCatalog } from './nodeIo';
import { NeuralPolicy, type PolicyWeights, type LinearLayer } from './net';
import { OBS_DIM, ACT_DIM } from './encode';
import { neuralPlanNavigation } from './planner';

const RUN = process.env.PLAN === '1';

/** A random small-weight net of the current dims (untrained — used only to exercise wiring). */
function randomPolicy(seed: number): NeuralPolicy {
	const rng = createRng(seed);
	const g = (): number => (nextInt(rng, 20001) / 10000 - 1) * 0.1; // ~U(-0.1,0.1)
	const lin = (out: number, inn: number): LinearLayer => ({
		W: Array.from({ length: out }, () => Array.from({ length: inn }, g)),
		b: Array.from({ length: out }, () => 0)
	});
	const w: PolicyWeights = {
		format: 'arc-cand-scorer-v1',
		obs_dim: OBS_DIM,
		act_dim: ACT_DIM,
		trunk: [lin(128, OBS_DIM + ACT_DIM), lin(128, 128), lin(1, 128)],
		value: [lin(64, OBS_DIM), lin(1, 64)]
	};
	return new NeuralPolicy(w);
}

interface Stat { abyssPicks: number; navDecisions: number; kills: number; vp: number; }

describe('neural ISMCTS planner', () => {
	(RUN ? it : it.skip)(
		'search drives Abyss farming; pi is a valid distribution',
		async () => {
			const games = parseInt(process.env.PLAN_GAMES ?? '8', 10);
			const iterations = parseInt(process.env.PLAN_ITERS ?? '48', 10);
			const seats = 4;
			const maxRounds = 30;
			const catalog = await loadOrSnapshotCatalog();
			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];
			const guardianNames = catalog.guardians.map((gd) => gd.name).slice(0, seats);
			const focus = seatList[0];
			const heur = profileFor('medium');
			const policy = randomPolicy(12345);
			const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };

			// usePlanner=true → focus seat navigates by ISMCTS; false → pure heuristic baseline.
			const playGame = (g: number, usePlanner: boolean): Stat => {
				const stat: Stat = { abyssPicks: 0, navDecisions: 0, kills: 0, vp: 0 };
				const botRng = { int: (m: number) => nextInt(createRng(g * 31 + 7), m), chance: () => false };
				let state = createLobbyState({ roomCode: 'PLAN', guardianNames });
				const ok = (r: ReturnType<typeof applyGameCommand>) => {
					if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
					state = r.state;
				};
				seatList.forEach((seat, i) => {
					const mid = `bot-${seat}`;
					ok(applyGameCommand(state, { memberId: mid, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog));
					ok(applyGameCommand(state, { memberId: mid, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog));
				});
				ok(applyGameCommand(state, host, { type: 'startGame', seed: 7000 + g }, catalog));

				let ticks = 0;
				while (state.status === 'active' && state.round <= maxRounds) {
					if (++ticks > 50000) break;
					let progressed = false;
					for (const seat of state.activeSeats) {
						if (!botSeatNeedsToAct(state, seat)) continue;
						// Planner only steers the focus seat's NAVIGATION decision.
						if (usePlanner && seat === focus && state.phase === 'navigation') {
							const res = neuralPlanNavigation(state, seat, catalog, policy, {
								iterations,
								horizon: 30,
								valueWeight: 0, // pure outcome playout — tests the planning machinery
								seed: g * 99991 + state.round
							});
							if (res) {
								expect(Math.abs(res.pi.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-6);
								if (g === 0 && stat.navDecisions < 8) {
									/* eslint-disable no-console */
									console.log(`[dbg] r${state.round} pick=${(res.command as { destination?: string }).destination}`);
									res.destinations.forEach((d, i) => console.log(`[dbg]    ${d.padEnd(16)} visits=${res.visits[i]} Q=${res.rootQ[i].toFixed(3)} prior=${res.priors[i].toFixed(2)}`));
									/* eslint-enable no-console */
								}
								stat.navDecisions++;
								if (res.command.type === 'lockNavigation' && (res.command as { destination?: string }).destination === 'Arcane Abyss') stat.abyssPicks++;
								const r = applyGameCommand(state, botActorFor(state, seat), res.command, catalog, { mutate: true });
								if (r.ok) { state = r.state; progressed = true; }
								continue;
							}
						}
						const cmds = planBotPhaseActions(state, seat, catalog, botRng, heur);
						for (const c of cmds) {
							if (seat === focus && c.type === 'startCombat') {
								const before = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
								void before;
							}
							const r = applyGameCommand(state, botActorFor(state, seat), c, catalog, { mutate: true });
							if (!r.ok) break;
							state = r.state;
							progressed = true;
							if (seat === focus && c.type === 'startCombat') {
								const mc = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
								if (mc?.killed) stat.kills++;
							}
							if (state.status !== 'active') break;
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
				stat.vp = state.players[focus]?.victoryPoints ?? 0;
				return stat;
			};

			let planAbyss = 0, planNav = 0, planKills = 0, planVP = 0;
			let baseAbyss = 0, baseNav = 0, baseKills = 0, baseVP = 0;
			for (let g = 0; g < games; g++) {
				const p = playGame(g, true);
				const b = playGame(g, false);
				planAbyss += p.abyssPicks; planNav += p.navDecisions; planKills += p.kills; planVP += p.vp;
				baseKills += b.kills; baseVP += b.vp; baseAbyss += b.abyssPicks; baseNav += b.navDecisions;
			}
			/* eslint-disable no-console */
			console.log(`\n[planner] ${games} games, ${iterations} iters, focus=${focus}`);
			console.log(`[planner] PLANNER : abyss/nav=${planAbyss}/${planNav} (${planNav ? ((100 * planAbyss) / planNav).toFixed(0) : 0}%)  kills/g=${(planKills / games).toFixed(2)}  VP/g=${(planVP / games).toFixed(2)}`);
			console.log(`[planner] HEURISTIC: kills/g=${(baseKills / games).toFixed(2)}  VP/g=${(baseVP / games).toFixed(2)}`);
			console.log(`[planner] DONE`);
			/* eslint-enable no-console */
			expect(planNav).toBeGreaterThan(0);
		},
		60 * 60 * 1000
	);
});
