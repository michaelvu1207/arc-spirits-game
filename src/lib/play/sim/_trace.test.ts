/**
 * Single-game round-by-round trace for diagnosing economy-bot speed.
 *   RUN_SIM=1 TRACE_PROFILE=cullean TRACE_SEED=1 npx vitest run src/lib/play/sim/_trace.test.ts --disable-console-intercept
 */
import { describe, expect, test } from 'vitest';
import { loadPlayCatalog } from '../server/catalog';
import { BOT_PROFILES } from '../server/botPolicy';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt, type RngState } from '../rng';
import { botActorFor, botSeatNeedsToAct, planBotPhaseActions, type BotRandom } from '../server/botPolicy';
import { awakenedClassCounts } from '../effects/apply';
import { SEAT_COLORS, type GameActor, type SeatColor } from '../types';

const RUN_SIM = !!process.env.RUN_SIM;
const rng = (r: RngState): BotRandom => ({ int: (m: number) => nextInt(r, m), chance: () => nextInt(r, 2) === 0 });
const ok = (r: ReturnType<typeof applyGameCommand>) => { if (!r.ok) throw new Error(r.error.code); return r.state; };
const TI: Record<string, string> = { basic: 'b', enchanted: 'n', exalted: 'x', arcane: 'a' };

describe.skipIf(!RUN_SIM)('single-game trace', () => {
	test('round-by-round', async () => {
		const catalog = await loadPlayCatalog();
		const profile = BOT_PROFILES[process.env.TRACE_PROFILE ?? 'cullean'];
		const seed = Number(process.env.TRACE_SEED ?? 1);
		const seat: SeatColor = SEAT_COLORS[0];
		const g = catalog.guardians[0].name;
		let state = createLobbyState({ roomCode: 'SIM', guardianNames: [g] });
		const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
		const m = { memberId: 'bot-Red', displayName: '🤖 Red', role: 'player' as const, seatColor: null };
		state = ok(applyGameCommand(state, m, { type: 'claimSeat', seatColor: seat }, catalog));
		state = ok(applyGameCommand(state, { ...m, seatColor: seat }, { type: 'selectGuardian', guardianName: g }, catalog));
		state = ok(applyGameCommand(state, host, { type: 'startGame', seed }, catalog));
		const botRng = rng(createRng(seed));
		const lines: string[] = [];
		let cur = state.round, dest = '?', combats = 0, rows = 0, augs = 0, ticks = 0;
		const flush = () => {
			const p = state.players[seat]!; const mon = p.monsterHand?.[0];
			const cc = awakenedClassCounts(p);
			const tiers = p.attackDice.reduce<Record<string, number>>((a, d) => ((a[d.tier] = (a[d.tier] ?? 0) + 1), a), {});
			const tstr = Object.entries(tiers).map(([k, v]) => `${v}${TI[k] ?? k[0]}`).join('+') || '—';
			const team = Object.entries(cc).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}${k.slice(0, 3)}`).join('+') || '∅';
			const relics = p.mats.filter((r: any) => r.hasRune && r.type === 'relic').length;
			lines.push(
				`r${String(cur).padStart(2)} ${dest.split(' ')[0].padEnd(7)} D${mon?.difficulty ?? 0} hp${String(mon?.hp ?? 0).padStart(2)}d${mon?.damage ?? 0} | bar${p.barrier}/${p.maxBarrier} dice${String(p.attackDice.length).padStart(2)}(${tstr}) ele${cc['Elementalist'] ?? 0} rel${relics} | fight${combats} row${rows} aug${augs} | vp${String(p.victoryPoints).padStart(2)} st${p.statusLevel} | ${team}`
			);
			dest = '?'; combats = 0; rows = 0; augs = 0;
		};
		while (state.status === 'active' && state.round <= 120) {
			if (++ticks > 50000) break;
			if (state.round !== cur) { flush(); cur = state.round; }
			let progressed = false;
			for (const s of state.activeSeats) {
				if (!botSeatNeedsToAct(state, s)) continue;
				for (const c of planBotPhaseActions(state, s, catalog, botRng, profile)) {
					const r = applyGameCommand(state, botActorFor(state, s), c, catalog);
					if (!r.ok) break; state = r.state; progressed = true;
					if (s === seat) {
						if (c.type === 'lockNavigation') dest = c.destination;
						if (c.type === 'startCombat') combats++;
						if (c.type === 'resolveLocationInteraction') rows++;
						if (c.type === 'placeAugmentOnSpirit') augs++;
					}
					if (state.status !== 'active') break;
				}
				if (state.status !== 'active') break;
			}
			if (!progressed && state.status === 'active') {
				const b = `${state.phase}:${state.round}`; applyDeadlineAdvance(state, catalog);
				if (`${state.phase}:${state.round}` === b) break;
			}
		}
		flush();
		const p = state.players[seat]!;
		console.log(`\n=== ${process.env.TRACE_PROFILE ?? 'cullean'} seed=${seed} → ${p.victoryPoints >= 30 ? 'WON' : 'NOWIN'} round=${state.round} vp=${p.victoryPoints} status=${p.statusLevel} ===`);
		console.log(lines.join('\n') + '\n');
		expect((catalog.monsters ?? []).length).toBeGreaterThan(0);
	}, 120000);
});
