/**
 * Live integration smoke for the remote v2 planner (remoteV2.ts).
 *
 * Skipped unless ARC_INFER_URL + ARC_INFER_TOKEN point at a running infer shim
 * (see http_shim.py on the serving host), e.g.:
 *
 *   ssh -f -N -L 18787:127.0.0.1:8787 path-pc
 *   ARC_INFER_URL=http://127.0.0.1:18787 ARC_INFER_TOKEN=... npm run test -- _remoteV2Live
 *
 * Plays a full 4-bot game with the Red seat driven by the remote v2 champion and
 * the other three by the bundled v1 policy — the exact mixed-fleet shape a live
 * room has during the rollout. Asserts the remote seat plans real commands, the
 * game completes, and no remote error surfaces.
 */
import { describe, it, expect } from 'vitest';
import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from '../runtime';
import { botActorFor, botSeatNeedsToAct } from '../server/botPolicy';
import { SEAT_COLORS, type GameActor, type PublicGameState, type SeatColor } from '../types';
import { getNeuralPolicy, planNeuralPhaseActions } from './neuralBot';
import { getRemoteV2Client, planNeuralPhaseActionsV2 } from './remoteV2';
import { hasCatalog, loadPlayCatalogSync } from '../sim/_catalogSync';

const configured = !!process.env.ARC_INFER_URL && !!process.env.ARC_INFER_TOKEN;

describe('remote v2 live planner', () => {
	it.skipIf(!configured || !hasCatalog())(
		'plays a full mixed v2/v1 bot game through the remote server',
		async () => {
			const catalog = loadPlayCatalogSync();
			const client = await getRemoteV2Client();
			expect(client, 'handshake with ARC_INFER_URL failed').not.toBeNull();
			expect(client!.info.obs_dim).toBe(3419);
			expect(client!.info.act_dim).toBe(104);

			const v1 = await getNeuralPolicy();
			expect(v1, 'bundled v1 policy missing').not.toBeNull();

			const seats = SEAT_COLORS.slice(0, 4) as SeatColor[];
			const remoteSeat = seats[0];
			const guardianNames = catalog.guardians.slice(0, 4).map((g) => g.name);
			let state = createLobbyState({ roomCode: 'V2S', guardianNames });
			const host: GameActor = {
				memberId: 'host',
				displayName: 'host',
				role: 'host',
				seatColor: null
			};
			const ok = (r: ReturnType<typeof applyGameCommand>): PublicGameState => {
				if (!r.ok) throw new Error(r.error.code);
				return r.state;
			};
			seats.forEach((seat, i) => {
				const id = `bot-${seat}`;
				state = ok(
					applyGameCommand(
						state,
						{ memberId: id, displayName: seat, role: 'player', seatColor: null },
						{ type: 'claimSeat', seatColor: seat },
						catalog
					)
				);
				state = ok(
					applyGameCommand(
						state,
						{ memberId: id, displayName: seat, role: 'player', seatColor: seat },
						{ type: 'selectGuardian', guardianName: guardianNames[i] },
						catalog
					)
				);
			});
			state = ok(applyGameCommand(state, host, { type: 'startGame', seed: 424242 }, catalog));

			let remoteCommands = 0;
			let remoteDecisionsWithChoice = 0;
			let ticks = 0;
			while (state.status === 'active' && ticks < 8000) {
				ticks++;
				let progressed = false;
				for (const seat of state.activeSeats) {
					if (state.status !== 'active') break;
					if (!botSeatNeedsToAct(state, seat)) continue;
					const commands =
						seat === remoteSeat
							? await planNeuralPhaseActionsV2(state, seat, catalog, client!, {
									temperature: 0.55,
									temperatureScope: 'all'
								})
							: planNeuralPhaseActions(state, seat, catalog, v1!, {
									temperature: 0.65
								});
					if (seat === remoteSeat && commands.length > 1) remoteDecisionsWithChoice++;
					for (const cmd of commands) {
						const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, {
							mutate: true
						});
						if (!r.ok) break;
						if (seat === remoteSeat) remoteCommands++;
						state = r.state;
						progressed = true;
						if (state.status !== 'active') break;
					}
				}
				if (!progressed && state.status === 'active') applyDeadlineAdvance(state, catalog);
			}

			expect(remoteCommands).toBeGreaterThan(0);
			expect(remoteDecisionsWithChoice).toBeGreaterThan(0);
			expect(state.status).not.toBe('active');
			const vp = Object.fromEntries(seats.map((s) => [s, state.players[s]?.victoryPoints ?? 0]));
			// eslint-disable-next-line no-console
			console.log(
				`[remoteV2 smoke] finished in ${ticks} ticks; remote seat ${remoteSeat} issued ` +
					`${remoteCommands} commands; VP ${JSON.stringify(vp)}; winner ${String(state.winnerSeat)}`
			);
		},
		600_000
	);
});
