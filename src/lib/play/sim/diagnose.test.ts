/**
 * Instrumented solo self-play probe. Confirms WHERE the strategic bot stalls on the
 * escalating monster ladder by tracing per-round telemetry (monster faced, barrier vs
 * monster damage, potential, dice, VP) for one seed and aggregating over several.
 *
 *   RUN_SIM=1 npx vitest run src/lib/play/sim/diagnose.test.ts --disable-console-intercept
 */

import { describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { loadPlayCatalog } from '../server/catalog';
import { BOT_PROFILES } from '../server/botPolicy';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt, type RngState } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import { SEAT_COLORS, type GameActor, type PlayCatalog, type SeatColor } from '../types';
import { buildMonsterRewards } from '../monsterRewards';
import { playOneGame } from './selfPlay';

const RUN_SIM = !!process.env.RUN_SIM;

function seededBotRandom(rng: RngState): BotRandom {
	return { int: (m: number) => nextInt(rng, m), chance: () => nextInt(rng, 2) === 0 };
}

function ok(result: ReturnType<typeof applyGameCommand>) {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.state;
}

interface RoundSnap {
	round: number;
	ladder: number;
	monster: string;
	mdmg: number;
	mhp: number;
	barrier: number;
	pot: number;
	dice: number;
	tiers: string;
	vp: number;
	status: number;
	team: string;
}

/** Run a solo game, capturing a snapshot at each round boundary. */
function instrumentedSolo(
	catalog: PlayCatalog,
	seed: number,
	profile: BotProfile,
	maxRounds: number,
	trace?: RoundSnap[]
) {
	const seat: SeatColor = SEAT_COLORS[0];
	const guardianName = catalog.guardians[0].name;
	let state = createLobbyState({ roomCode: 'SIM', guardianNames: [guardianName] });
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const member = { memberId: 'bot-Red', displayName: '🤖 Red', role: 'player' as const, seatColor: null };
	state = ok(applyGameCommand(state, member, { type: 'claimSeat', seatColor: seat }, catalog));
	state = ok(
		applyGameCommand(state, { ...member, seatColor: seat }, { type: 'selectGuardian', guardianName }, catalog)
	);
	state = ok(applyGameCommand(state, host, { type: 'startGame', seed }, catalog));

	const botRng = seededBotRandom(createRng(seed));
	let lastRound = -1;
	let maxLadder = 0;
	let maxPot = 0;
	let ticks = 0;

	const snap = () => {
		const p = state.players[seat]!;
		const m = state.monster;
		const t = p.attackDice.reduce<Record<string, number>>((a, d) => ((a[d.tier] = (a[d.tier] ?? 0) + 1), a), {});
		const cc = p.spirits.reduce<Record<string, number>>((a, s) => {
			for (const c of Object.keys(s.classes ?? {})) if (!s.isFaceDown) a[c] = (a[c] ?? 0) + 1;
			return a;
		}, {});
		const team = Object.entries(cc).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${v}${k.slice(0, 3)}`).join('+') || '∅';
		trace?.push({
			round: state.round,
			ladder: m?.ladderIndex ?? -1,
			monster: m?.name ?? '—',
			mdmg: m?.damage ?? 0,
			mhp: m?.hp ?? 0,
			barrier: p.barrier,
			pot: p.maxBarrier,
			dice: p.attackDice.length,
			tiers: Object.entries(t).map(([k, v]) => `${v}${k[0]}`).join('+') || '—',
			vp: p.victoryPoints,
			status: p.statusLevel,
			team
		});
	};

	while (state.status === 'active' && state.round <= maxRounds) {
		if (++ticks > 50_000) break;
		if (state.round !== lastRound) {
			snap();
			lastRound = state.round;
		}
		maxLadder = Math.max(maxLadder, state.monster?.ladderIndex ?? 0);
		maxPot = Math.max(maxPot, state.players[seat]?.maxBarrier ?? 0);
		let progressed = false;
		for (const s of state.activeSeats) {
			if (!botSeatNeedsToAct(state, s)) continue;
			const cmds = planBotPhaseActions(state, s, catalog, botRng, profile);
			for (const c of cmds) {
				const r = applyGameCommand(state, botActorFor(state, s), c, catalog);
				if (!r.ok) break;
				state = r.state;
				progressed = true;
				if (state.status !== 'active') break;
			}
			if (state.status !== 'active') break;
		}
		if (!progressed && state.status === 'active') {
			const before = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === before) break;
		}
	}
	const p = state.players[seat]!;
	return {
		// TRUE win = reached the 30-VP target. NB: a solo game also "finishes" when the bot
		// Falls (allPlayersFallen) — a hollow win at low VP — so we measure VP≥30 explicitly.
		won: p.victoryPoints >= 30,
		fellOut: state.status === 'finished' && p.victoryPoints < 30,
		rounds: state.round,
		vp: p.victoryPoints,
		dice: p.attackDice.length,
		pot: p.maxBarrier,
		maxLadder,
		maxPot,
		status: p.statusLevel
	};
}

describe.skipIf(!RUN_SIM)('diagnose solo stall', () => {
	test('per-profile solo telemetry + trace', async () => {
		const catalog = await loadPlayCatalog();
		console.log(`\nLadder (${(catalog.monsters ?? []).length} rungs): ` +
			(catalog.monsters ?? []).map((m, i) => `${i}:${m.name.slice(0, 4)}(hp${m.barrier}/dmg${m.damage})`).join(' '));

		// 'arcane' = medium + pursueArcane (NO search, so it's fast to observe the arcane mechanism).
		const arcaneProfile: BotProfile = { ...BOT_PROFILES['medium'], pursueArcane: true };
		const profilesUnderTest: Record<string, BotProfile> = {
			medium: BOT_PROFILES['medium'],
			arcane: arcaneProfile,
			fighter: BOT_PROFILES['fighter'],
			cultivator: BOT_PROFILES['cultivator']
		};
		const NSEED = 24;
		for (const [name, profile] of Object.entries(profilesUnderTest)) {
			if (!profile) continue;
			const rows: ReturnType<typeof instrumentedSolo>[] = [];
			for (let seed = 1; seed <= NSEED; seed++) rows.push(instrumentedSolo(catalog, seed, profile, 250));
			const won = rows.filter((r) => r.won).length;
			const fell = rows.filter((r) => r.fellOut).length;
			const avg = (f: (r: (typeof rows)[number]) => number) =>
				(rows.reduce((a, r) => a + f(r), 0) / rows.length).toFixed(1);
			console.log(
				`\n${name.padEnd(10)} WON(vp≥30)=${won}/${NSEED} (${Math.round((100 * won) / NSEED)}%)  fellOut=${fell}  avgVP=${avg((r) => r.vp)}  avgMaxLadder=${avg((r) => r.maxLadder)}  avgMaxPot=${avg((r) => r.maxPot)}  avgDice=${avg((r) => r.dice)}  avgStatus=${avg((r) => r.status)}`
			);
		}

		// Detailed per-round trace for the ARCANE profile on seed 1 — watch for arcane dice (×a)
		// and an Arcane Ascendant (Arc) appearing once it claims an Abyss summon + awakens it.
		const trace: RoundSnap[] = [];
		instrumentedSolo(catalog, 1, arcaneProfile, 50, trace);
		console.log('\n--- arcane seed=1 per-round trace ---');
		for (const s of trace) {
			console.log(
				`r${String(s.round).padStart(2)} L${s.ladder} dmg${s.mdmg} hp${s.mhp} | bar${s.barrier}/pot${s.pot} dice${s.dice}(${s.tiers}) vp${s.vp} st${s.status} | ${s.team}`
			);
		}
		expect((catalog.monsters ?? []).length).toBeGreaterThan(0);
	}, 180_000);

	test('diagnose: low-potential + simultaneous-attack (corruption path)', async () => {
		const catalog = await loadPlayCatalog();
		const base = BOT_PROFILES['hard'];
		const simClasses = {
			preCapClasses: ['Sharpshooter', 'Fighter', 'Elementalist', 'Spirit Animal', 'Cultivator'],
			postCapClasses: ['Sharpshooter', 'Spirit Animal', 'Elementalist'],
			originFocus: false
		};
		const profiles: Record<string, BotProfile> = {
			pot7: { ...base, maxBarrierTarget: 7 },
			pot6_safe: { ...base, maxBarrierTarget: 6 },
			corruption: BOT_PROFILES['corruption'],
			sim6: { ...base, ...simClasses, maxBarrierTarget: 6, pursueCorruption: true },
			sim5: { ...base, ...simClasses, maxBarrierTarget: 5, pursueCorruption: true }
		};
		const NSEED = 24;
		const out: string[] = [`Ladder: ${(catalog.monsters ?? []).map((m, i) => `${i}(hp${m.barrier}/dmg${m.damage})`).join(' ')}`];
		for (const [name, profile] of Object.entries(profiles)) {
			const rows = Array.from({ length: NSEED }, (_, i) => instrumentedSolo(catalog, i + 1, profile, 250));
			const won = rows.filter((r) => r.won).length;
			const fell = rows.filter((r) => r.fellOut).length;
			const avg = (f: (r: (typeof rows)[number]) => number) => (rows.reduce((a, r) => a + f(r), 0) / rows.length).toFixed(1);
			out.push(
				`${name.padEnd(11)} WON=${won}/${NSEED} (${Math.round((100 * won) / NSEED)}%) fellOut=${fell} avgVP=${avg((r) => r.vp)} avgMaxLadder=${avg((r) => r.maxLadder)} avgPot=${avg((r) => r.pot)} avgDice=${avg((r) => r.dice)} avgStatus=${avg((r) => r.status)}`
			);
		}
		for (const tn of ['sim6', 'corruption']) {
			const trace: RoundSnap[] = [];
			instrumentedSolo(catalog, 1, profiles[tn] ?? BOT_PROFILES[tn], 60, trace);
			out.push(`\n--- ${tn} seed=1 trace ---`);
			for (const s of trace)
				out.push(`r${String(s.round).padStart(2)} L${s.ladder} dmg${s.mdmg} hp${s.mhp} | bar${s.barrier}/pot${s.pot} dice${s.dice}(${s.tiers}) vp${s.vp} st${s.status} | ${s.team}`);
		}
		writeFileSync('/tmp/corrupt_diag.txt', out.join('\n') + '\n');
		console.log('\n' + out.join('\n') + '\n');
		expect((catalog.monsters ?? []).length).toBeGreaterThan(0);
	}, 300_000);

	test('balance: build-pillar ablation (what is FORCED to win?)', async () => {
		const catalog = await loadPlayCatalog();
		const M = BOT_PROFILES['medium'];
		// Each ablation removes ONE pillar of the winning build. A big win-rate drop ⇒ that pillar
		// is mandatory ⇒ the game forces it (low build diversity).
		const ablations: Record<string, BotProfile> = {
			'FULL build (baseline)': M,
			'– potential (cap stays 4)': { ...M, maxBarrierTarget: 4 },
			'– flat damage (no Spirit Animal)': {
				...M,
				damageClasses: [],
				postCapClasses: ['Cultivator', 'Healer', 'Elementalist']
			},
			'– origin focus (trio left to luck)': { ...M, originFocus: false }
		};
		const NSEED = 16;
		console.log('\n--- build-pillar ablation (solo, 16 seeds) ---');
		for (const [name, profile] of Object.entries(ablations)) {
			const rows = Array.from({ length: NSEED }, (_, i) => instrumentedSolo(catalog, i + 1, profile, 250));
			const won = rows.filter((r) => r.won).length;
			const avg = (f: (r: (typeof rows)[number]) => number) =>
				(rows.reduce((a, r) => a + f(r), 0) / rows.length).toFixed(1);
			console.log(
				`${name.padEnd(34)} WON=${won}/${NSEED} (${Math.round((100 * won) / NSEED)}%)  avgVP=${avg((r) => r.vp)}  avgMaxLadder=${avg((r) => r.maxLadder)}  avgMaxPot=${avg((r) => r.maxPot)}`
			);
		}
		expect((catalog.monsters ?? []).length).toBeGreaterThan(0);
	}, 180_000);

	test('multiplayer reach-30 rate (medium bots)', async () => {
		const catalog = await loadPlayCatalog();
		const medium = BOT_PROFILES['medium'];
		for (const n of [2, 3, 4]) {
			let reached = 0;
			let viaFallen = 0;
			const roundsToWin: number[] = [];
			const NSEED = 16;
			for (let seed = 1; seed <= NSEED; seed++) {
				const r = playOneGame(catalog, { seed, profiles: Array(n).fill(medium), maxRounds: 250 });
				const maxVp = Math.max(...Object.values(r.finalVP));
				if (maxVp >= 30) {
					reached += 1;
					roundsToWin.push(r.rounds);
				} else if (r.finished) {
					viaFallen += 1; // game ended (all Fallen) with nobody at 30
				}
			}
			const med = roundsToWin.length
				? [...roundsToWin].sort((a, b) => a - b)[Math.floor(roundsToWin.length / 2)]
				: NaN;
			console.log(
				`${n}-player medium: reached30=${reached}/${NSEED} (${Math.round((100 * reached) / NSEED)}%)  endedAllFallen=${viaFallen}  medianRoundsToWin=${med}`
			);
		}
		expect((catalog.monsters ?? []).length).toBeGreaterThan(0);
	}, 240_000);

	test('win economics + build feasibility', async () => {
		const catalog = await loadPlayCatalog();

		// Per-rung VP if you claim the top `chooseAmount` VP tokens.
		console.log('\n--- reward economics per rung ---');
		let cum = 0;
		(catalog.monsters ?? []).forEach((m, i) => {
			const opts = buildMonsterRewards(m.rewardTrack);
			const vps = opts.filter((o) => o.effect.type === 'vp').map((o) => (o.effect as { amount: number }).amount).sort((a, b) => b - a);
			const claimVP = vps.slice(0, m.chooseAmount).reduce((a, b) => a + b, 0);
			cum += claimVP;
			const labels = opts.map((o) => o.label).join(', ');
			console.log(`rung${i} ${m.name.slice(0, 12).padEnd(12)} hp${m.barrier} dmg${m.damage} choose${m.chooseAmount} → claimVP=${claimVP} (cum if 1 kill each=${cum}) [${labels}]`);
		});

		// Class census across the spirit pool.
		const classCount: Record<string, number> = {};
		const originCount: Record<string, number> = {};
		const cultivatorOrigins: Record<string, number> = {};
		for (const s of catalog.spirits) {
			for (const c of Object.keys(s.classes ?? {})) classCount[c] = (classCount[c] ?? 0) + 1;
			for (const o of Object.keys(s.origins ?? {})) {
				originCount[o] = (originCount[o] ?? 0) + 1;
				if ((s.classes?.['Cultivator'] ?? 0) > 0) cultivatorOrigins[o] = (cultivatorOrigins[o] ?? 0) + 1;
			}
		}
		// Per-class cost/bag reachability — Spirit World = cost 1-5, Arcane Abyss = cost 7-9.
		console.log('\n--- key class reachability (cost → bag) ---');
		for (const cls of ['Healer', 'Spirit Animal', 'Cultivator', 'Fighter', 'Elementalist', 'Arcane Ascendant', 'Sharpshooter']) {
			const costs = catalog.spirits.filter((s) => (s.classes?.[cls] ?? 0) > 0).map((s) => s.cost).sort((a, b) => a - b);
			const sw = costs.filter((c) => c >= 1 && c <= 5).length;
			const ab = costs.filter((c) => c >= 7 && c <= 9).length;
			console.log(`${cls.padEnd(14)} costs=[${costs.join(',')}]  SpiritWorld=${sw}  Abyss=${ab}  other=${costs.length - sw - ab}`);
		}

		console.log(`\n--- spirit pool (${catalog.spirits.length} spirits) ---`);
		console.log('classes: ' + Object.entries(classCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));
		console.log('origins: ' + Object.entries(originCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));
		console.log('origins WITH a Cultivator: ' + Object.entries(cultivatorOrigins).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}(of ${originCount[k]})`).join('  '));

		// Dice-tier kill odds reference: P(sum of N tier dice >= hp).
		console.log('\n--- max firepower reference (avg dmg by 10-dice pool) ---');
		console.log('10 basic≈3.3  10 enchanted≈6.7  10 exalted≈10.0  10 arcane≈20.0  (+1 per Spirit Animal trait, flat)');
		expect((catalog.monsters ?? []).length).toBeGreaterThan(0);
	}, 120_000);
});
