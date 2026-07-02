/**
 * Round-by-round MONSTER trace for one 4-player game. Logs per round: each seat's VP/barrier/dice/avgDmg
 * and the shared monster's rung (ladderIndex) + hp + damage + livesRemaining. Reveals where the ~13-VP
 * farming ceiling comes from — does the monster advance? do kills credit VP? how often does a seat fight
 * + kill? Is there a structural block (r30=0% for every bot)?
 *
 *   MONTRACE=1 MONTRACE_PROFILE=godly npx vitest run src/lib/play/ml/_montrace.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import { botActorFor, botSeatNeedsToAct, planBotPhaseActions, profileFor } from '../server/botPolicy';
import { DICE_TIER_FACES } from '../combat';
import { SEAT_COLORS, type GameActor, type SeatColor } from '../types';
import { loadOrSnapshotCatalog } from './nodeIo';

const RUN = process.env.MONTRACE === '1';

describe('monster trace', () => {
	(RUN ? it : it.skip)(
		'round-by-round monster + VP for one 4p game',
		async () => {
			const profileName = process.env.MONTRACE_PROFILE ?? 'godly';
			const catalog = await loadOrSnapshotCatalog();
			const seats = SEAT_COLORS.slice(0, 4) as SeatColor[];
			const guardianNames = catalog.guardians.map((g) => g.name).slice(0, 4);
			const profile = profileFor(profileName);
			const rng = createRng(424242);
			const botRng = { int: (m: number) => nextInt(rng, m), chance: () => nextInt(rng, 2) === 0 };
			const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };

			let state = createLobbyState({ roomCode: 'TRACE', guardianNames });
			const ok = (r: ReturnType<typeof applyGameCommand>) => { if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`); state = r.state; };
			seats.forEach((s, i) => {
				const mid = `bot-${s}`;
				ok(applyGameCommand(state, { memberId: mid, displayName: s, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: s }, catalog));
				ok(applyGameCommand(state, { memberId: mid, displayName: s, role: 'player', seatColor: s }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog));
			});
			ok(applyGameCommand(state, host, { type: 'startGame', seed: 12321 }, catalog));

			/* eslint-disable no-console */
			console.log(`[montrace] all-${profileName} 4p`);
			const fights: Record<string, number> = {}, kills: Record<string, number> = {};
			for (const s of seats) { fights[s] = 0; kills[s] = 0; }
			let curRound = state.round;
			const logRound = (rnd: number) => {
				const m = state.monster;
				const avgDmg = (s: SeatColor) => (state.players[s]?.attackDice ?? []).reduce((sum, d) => { const f = DICE_TIER_FACES[d.tier]; return sum + f.reduce((a, b) => a + b, 0) / f.length; }, 0);
				const vps = seats.map((s) => `${s}:vp${state.players[s]?.victoryPoints ?? 0}/b${state.players[s]?.maxBarrier ?? 0}/d${state.players[s]?.attackDice.length ?? 0}/dmg${avgDmg(s).toFixed(0)}`).join(' ');
				console.log(`[montrace] end r${String(rnd).padStart(2)} | monster rung=${m?.ladderIndex ?? '-'} hp=${m?.maxHp ?? '-'} dmg=${m?.damage ?? '-'} lives=${m?.livesRemaining ?? '-'} | ${vps}`);
			};

			let ticks = 0;
			while (state.status === 'active' && state.round <= 30) {
				if (++ticks > 50000) break;
				let progressed = false;
				for (const s of state.activeSeats) {
					if (!botSeatNeedsToAct(state, s)) continue;
					const plan = planBotPhaseActions(state, s, catalog, botRng, profile);
					for (const c of plan) {
						const r = applyGameCommand(state, botActorFor(state, s), c, catalog, { mutate: true });
						if (!r.ok) break;
						state = r.state;
						progressed = true;
						if (c.type === 'startCombat') {
							const mc = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === s);
							fights[s]++; if (mc?.killed) kills[s]++;
						}
						if (state.status !== 'active') break;
					}
					if (state.status !== 'active') break;
				}
				if (state.round !== curRound) { logRound(curRound); curRound = state.round; }
				if (state.status !== 'active') break;
				if (!progressed) {
					const sig = `${state.phase}:${state.round}`;
					applyDeadlineAdvance(state, catalog);
					if (state.round !== curRound) { logRound(curRound); curRound = state.round; }
					if (`${state.phase}:${state.round}` === sig) break;
				}
			}
			console.log(`[montrace] FINAL round=${state.round} winner=${state.winnerSeat}`);
			console.log(`[montrace] seats: ${seats.map((s) => `${s}=vp${state.players[s]?.victoryPoints} fights${fights[s]} kills${kills[s]}`).join('  ')}`);
			/* eslint-enable no-console */
		},
		120000
	);
});
