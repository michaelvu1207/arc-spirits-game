/**
 * The rule numbers of rules.ts, and rules of November 2026 that are now the one ruleset: Feral, Cultivator's
 * relic once per game, a summon that replaces a spirit on a full board, the capstone awaken numbers from the
 * data text, PvP paid per corrupted Good player, Fallen debt below 0 VP, Mystic (3) doubling the Cultivate runes,
 * the Cultivate rune or relic, Ram, and PvP at the Arcane Abyss. How each came about:
 * docs/rules-history-2026-11.md.
 *
 *   npx vitest run src/lib/play/rules.test.ts
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	DIFFICULTY_3_RESTORE,
	INITIATIVE_DIE_SIDES,
	INITIATIVE_HITS,
	VP_TO_WIN,
	difficulty3Restore,
	initiativeHits,
	pvpAllowedAt,
	restBarrier
} from './rules';
import { applyGameCommand, createLobbyState } from './runtime';
import { fightMonster, pvpVpForAttack, pvpVpPerCorrupted, resetCombatFlags, takeDamage } from './combat';
import { setCorruptionDiscardObligation, settleUnpayableCorruptionDebt } from './types';
import { canApply } from './legality';
import { computeAffordances } from './viewV2';
import { botActorFor } from './server/botPolicy';
import { ARCANE_ABYSS_BAG } from './bags';
import { applyCultivate, applyTrigger } from './effects/apply';
import { checkAwakenCondition, payAwakenCondition } from './effects/awaken';
import { buildEffectContext } from './effects/context';
import { DECISION_RESOLVERS } from './effects/decisions';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { agentLegalCommands } from './agents/actionSurface';
import { loadFrozenCatalog } from './agents/catalog';
import { labelFor, publicLabelFor } from './agents/labels';
import { buildRulesBrief } from './agents/rulesBrief';
import { renderSeatView, seatProjection } from './agents/view';
import { createAgentLobby, pickGuardians, seatsFor } from './agents/setup';
import type { PlayCatalog, PublicGameState } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();

/** The printed text of class `name` at `count` in the game data. */
const CLASSES = JSON.parse(readFileSync('data/classes.json', 'utf8')) as {
	name: string;
	effect_schema: { count: number | string; effects: { description: string }[] }[];
}[];
const classText = (name: string, count: number | string) =>
	CLASSES.find((c) => c.name === name)!.effect_schema.find((t) => t.count === count)!.effects[0].description;

describe('rules.ts', () => {
	it('Rest restores 4 / 4 / 3 / 2 by status; a status outside the ladder counts as its end', () => {
		expect([-1, 0, 1, 2, 3, 4].map(restBarrier)).toEqual([4, 4, 4, 3, 2, 2]);
	});

	it('the initiative die has 12 sides and hits on 4 / 6 / 7 / 8 of them by status', () => {
		expect(INITIATIVE_DIE_SIDES).toBe(12);
		expect(INITIATIVE_HITS).toEqual([4, 6, 7, 8]);
		expect([-1, 0, 1, 2, 3, 4].map(initiativeHits)).toEqual([4, 4, 6, 7, 8, 8]);
	});

	it('only a Difficulty 3 card restores Barrier after a fight, 5', () => {
		expect(DIFFICULTY_3_RESTORE).toBe(5);
		expect([undefined, 1, 2, 3].map(difficulty3Restore)).toEqual([0, 0, 0, 5]);
	});

	it('an Evil player may attack at every location, the Arcane Abyss too; a game is won at 30', () => {
		expect(['Mountain Region', 'Fire Region', 'Arcane Abyss'].map(pvpAllowedAt)).toEqual([true, true, true]);
		expect([null, undefined, ''].map(pvpAllowedAt)).toEqual([false, false, false]);
		expect(VP_TO_WIN).toBe(30);
	});
});

describe('Feral: "When an Evil player or a monster attacks you, your side gains the initiative if it does not have it."', () => {
	const feralPlayer = () => makePlayer({ spirits: [spirit(1, { Feral: 1 })] });

	it('against a monster: the initiative, no extra damage', () => {
		const player = feralPlayer();
		resetCombatFlags(player);
		applyTrigger(makeState(player), 'Red', 'inCombat', []);
		expect(player.alwaysAttackFirst).toBe(true);
		expect(player.combatDamageBonus).toBe(0);
	});

	it('when an Evil player attacks: the initiative, no extra damage', () => {
		const player = feralPlayer();
		const evil = makePlayer({ playerColor: 'Blue', statusLevel: 3, statusToken: 'Fallen' });
		resetCombatFlags(player);
		applyTrigger(makeState(player, { Blue: evil }), 'Red', 'inCombat', [], { opponent: 'Blue' });
		expect(player.alwaysAttackFirst).toBe(true);
		expect(player.combatDamageBonus).toBe(0);
	});
});

describe('Cultivator (5): the relic only the first time per game', () => {
	it('one relic card in three Cultivates; Max Barrier still grows', () => {
		const player = makePlayer({
			spirits: [1, 2, 3, 4, 5].map((slot) => spirit(slot, { Cultivator: 1 }))
		});
		const state = makeState(player);
		const offers: number[] = [];
		for (let i = 0; i < 3; i++) {
			applyCultivate(state, 'Red', []);
			offers.push(player.pendingDecisions.filter((d) => d.kind === 'cultivatorRelic').length);
		}
		expect(offers).toEqual([1, 1, 1]);
		expect(player.cultivatorRelicGained).toBe(true);
		expect(player.maxBarrier).toBe(10);
		expect(classText('Cultivator', 5)).toContain('once per game');
	});
});

// ── A summon on a full board replaces a spirit ───────────────────────────────

function fullBoardWithAbyssDraw(catalog: PlayCatalog): PublicGameState {
	const seats = seatsFor(2);
	const guardians = pickGuardians(catalog, 5, 2);
	const state = createAgentLobby(catalog, 5, seats.map((seat, i) => ({ seat, guardian: guardians[i] })));
	const red = state.players.Red!;
	const arcane = catalog.spirits.filter((s) => s.cost >= 7 && s.cost <= 9);
	red.spirits = Array.from({ length: 7 }, (_, i) => {
		const s = arcane[i % arcane.length];
		return { slotIndex: i + 1, id: s.id, name: s.name, cost: s.cost, classes: s.classes, origins: s.origins, isFaceDown: i % 2 === 0 };
	});
	red.spiritAugmentAttachments = [];
	const drawn = arcane.slice(10, 13);
	red.pendingDraw = { sourceBag: ARCANE_ABYSS_BAG, drawCount: 3, summonLimit: 1, summonedCount: 0 };
	red.handDraws = drawn.map((s, i) => ({ guid: `draw-${i}`, id: s.id, name: s.name, cost: s.cost }));
	state.phase = 'location';
	return state;
}

const abyssBagCount = (state: PublicGameState, id: string) =>
	(state.bags.abyssFallen?.contents ?? []).filter((e) => e.id === id).length;

describe('a summon on a full board replaces a spirit of the player\'s choice', () => {
	const replace = { type: 'spawnHandSpirit', guid: 'draw-0', replaceSlotIndex: 3 } as const;

	it('the summon replaces the chosen spirit, which goes back to its bag', () => {
		const state = fullBoardWithAbyssDraw(frozen);
		const red = state.players.Red!;
		const old = red.spirits.find((s) => s.slotIndex === 3)!;
		const drawnId = red.handDraws[0].id!;
		const bagBefore = abyssBagCount(state, old.id);
		const actor = botActorFor(state, 'Red');
		expect(canApply(state, actor, replace, frozen)).toBe(true);
		const result = applyGameCommand(state, actor, replace, frozen);
		expect(result.ok).toBe(true);
		const after = result.ok ? result.state.players.Red! : red;
		expect(after.spirits).toHaveLength(7);
		expect(after.spirits.find((s) => s.slotIndex === 3)).toMatchObject({ id: drawnId, isFaceDown: true });
		expect(result.ok && abyssBagCount(result.state, old.id)).toBe(bagBefore + 1);
		expect(after.pendingDraw).toBeNull(); // the one Abyss pick is used
		expect(after.pendingCorruptionDiscard ?? null).toBeNull();
		expect(after.lastAction?.label).toContain(`replacing ${old.name}`);
	});

	it('not allowed while a slot is open, nor for an empty slot', () => {
		const state = fullBoardWithAbyssDraw(frozen);
		const red = state.players.Red!;
		red.spirits = red.spirits.filter((s) => s.slotIndex !== 7);
		const actor = botActorFor(state, 'Red');
		expect(canApply(state, actor, replace, frozen)).toBe(false);
		expect(applyGameCommand(state, actor, replace, frozen).ok).toBe(false);
		// With a free slot the normal summon is offered and no replace variant is.
		const offered = agentLegalCommands(state, 'Red', frozen).commands.filter((c) => c.type === 'spawnHandSpirit');
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.every((c) => c.type === 'spawnHandSpirit' && c.replaceSlotIndex === undefined)).toBe(true);
	});

	it('the agent is offered "Summon X, replacing Y" for each drawn spirit × each board spirit', () => {
		const state = fullBoardWithAbyssDraw(frozen);
		const offered = agentLegalCommands(state, 'Red', frozen).commands.filter(
			(c) => c.type === 'spawnHandSpirit'
		);
		expect(offered).toHaveLength(3 * 7);
		const view = seatProjection(state, 'Red');
		const old = state.players.Red!.spirits.find((s) => s.slotIndex === 3)!;
		const label = labelFor(replace, view, 'Red', frozen);
		expect(label).toMatch(/^Summon .+, replacing /);
		expect(label).toContain(`replacing ${old.name} (slot 3`);
		expect(label).toContain('discarded back to its bag');
		expect(publicLabelFor(replace, 'Red', view)).toBe(`Red summoned a spirit, replacing ${old.name}.`);
		expect(renderSeatView(view, 'Red', frozen)).toContain('all 7 slots are full: a summon may replace');
	});
});

describe('rules text for agents', () => {
	it('the brief names the full-board summon', () => {
		expect(buildRulesBrief(frozen)).toContain('- Full board: when all 7 of your slots hold spirits, a summon may replace');
	});

	it('the view mentions the Cultivator relic only once it is taken', () => {
		const state = fullBoardWithAbyssDraw(frozen);
		expect(renderSeatView(seatProjection(state, 'Red'), 'Red', frozen)).not.toContain('Cultivator (5) relic');
		state.players.Red!.cultivatorRelicGained = true;
		expect(renderSeatView(seatProjection(state, 'Red'), 'Red', frozen)).toContain(
			'Cultivator (5) relic already gained (once per game)'
		);
	});
});

// ── Capstone awaken numbers come from the data text ──────────────────────────

describe('"Have N <Origin> Spirits, or discard M Arcane Abyss Spirits."', () => {
	const CALDERA = '504c77b5-8f46-427d-a339-1ef11160b0d7';
	const catalogWith = (text: string): PlayCatalog => ({
		...frozen,
		spirits: frozen.spirits.map((s) =>
			s.id === CALDERA ? { ...s, origins: { 'Fire Region': 1 }, awaken: { kind: 'text', text } } : s
		)
	});
	const board = (fire: number, otherArcane: number) => {
		const spirits = [spirit(1, { Titan: 1 }, { faceDown: true })];
		spirits[0] = { ...spirits[0], id: CALDERA, cost: 9, origins: { 'Fire Region': 1 } };
		for (let i = 0; i < fire - 1; i++)
			spirits.push({ ...spirit(spirits.length + 1, {}), cost: 3, origins: { 'Fire Region': 1 } });
		for (let i = 0; i < otherArcane; i++)
			spirits.push({ ...spirit(spirits.length + 1, {}), cost: 7, origins: { 'Water Region': 1 } });
		return makePlayer({ spirits });
	};
	const check = (text: string, fire: number, otherArcane: number) => {
		const player = board(fire, otherArcane);
		const ctx = buildEffectContext({
			state: makeState(player),
			seat: 'Red',
			player,
			trigger: 'awakening',
			log: [],
			traitCount: 0,
			colocated: [],
			catalog: catalogWith(text)
		});
		return { ok: checkAwakenCondition(ctx, { spirit: player.spirits[0] }).ok, ctx, player };
	};

	it('the November 2026 text keeps 7 / 3', () => {
		const text = 'Have 7 Fire Spirits, or discard 3 Arcane Abyss Spirits.';
		expect(check(text, 6, 0).ok).toBe(false);
		expect(check(text, 7, 0).ok).toBe(true);
		expect(check(text, 1, 2).ok).toBe(false);
		expect(check(text, 1, 3).ok).toBe(true);
	});

	it('a data edit to 5 / 2 is the rule', () => {
		const text = 'Have 5 Fire Spirits, or discard 2 Arcane Abyss Spirits.';
		expect(check(text, 4, 0).ok).toBe(false);
		expect(check(text, 5, 0).ok).toBe(true);
		expect(check(text, 1, 1).ok).toBe(false);
		const viaDiscard = check(text, 1, 2);
		expect(viaDiscard.ok).toBe(true);
		expect(payAwakenCondition(viaDiscard.ctx, { spirit: viaDiscard.player.spirits[0] }).ok).toBe(true);
		expect(viaDiscard.player.spirits).toHaveLength(1); // the 2 Arcane spirits were discarded
	});
});

// ── PvP ──────────────────────────────────────────────────────────────────────

const HOST_C = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null } as const;
const ACTORS_C = {
	Red: { ...HOST_C, seatColor: 'Red' },
	Blue: { memberId: 'm-b', displayName: 'B', role: 'player', seatColor: 'Blue' },
	Orange: { memberId: 'm-o', displayName: 'O', role: 'player', seatColor: 'Orange' }
} as const;
const PVP_CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' },
		{ id: 'g-c', name: 'Orro', originId: 'o3' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 6 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: 2, classes: {}, origins: {} }))
};
const arcaneDice = (n: number) => Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));

/** Red (Fallen) attacks Blue and Orange (Good) in Mountain Region; `setup` shapes the sides. */
function pvpExchange(
	setup: (s: PublicGameState) => void,
	destination = 'Mountain Region',
	attack = true
): PublicGameState {
	const ok = (state: PublicGameState, actor: object, command: object) => {
		const r = applyGameCommand(state, actor as never, command as never, PVP_CATALOG);
		if (!r.ok) throw new Error(`${(command as { type: string }).type}: ${r.error.message}`);
		return r.state;
	};
	let state = createLobbyState({ roomCode: 'PVPC', guardianNames: ['Myrtle', 'Nyra', 'Orro'] });
	state = ok(state, { ...HOST_C, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
	state = ok(state, { ...ACTORS_C.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
	state = ok(state, { ...ACTORS_C.Orange, seatColor: null }, { type: 'claimSeat', seatColor: 'Orange' });
	state = ok(state, ACTORS_C.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
	state = ok(state, ACTORS_C.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
	state = ok(state, ACTORS_C.Orange, { type: 'selectGuardian', guardianName: 'Orro' });
	state = ok(state, ACTORS_C.Red, { type: 'startGame', seed: 99 });
	for (const seat of ['Red', 'Blue', 'Orange'] as const)
		state = ok(state, ACTORS_C[seat], { type: 'lockNavigation', destination });
	for (const seat of state.activeSeats) {
		const p = state.players[seat]!;
		p.spirits = [];
		p.attackDice = [];
		p.maxBarrier = 14;
		p.barrier = 14;
		p.brokenBarrier = 0;
	}
	const red = state.players.Red!;
	red.statusLevel = 3;
	red.statusToken = 'Fallen';
	setup(state);
	state = ok(state, ACTORS_C.Red, { type: 'forceAdvancePhase' });
	return attack ? ok(state, ACTORS_C.Red, { type: 'initiatePvp' }) : state;
}
const vps = (s: PublicGameState) => (['Red', 'Blue', 'Orange'] as const).map((k) => s.players[k]!.victoryPoints);
const oneCorrupted = (s: PublicGameState) => {
	s.players.Red!.attackDice = arcaneDice(3); // 3-9 damage: corrupts Blue (2), never Orange (14)
	s.players.Blue!.maxBarrier = 2;
	s.players.Blue!.barrier = 2;
};
const attackerCorrupted = (s: PublicGameState) => {
	const red = s.players.Red!;
	red.maxBarrier = 1;
	red.barrier = 1;
	red.corruptionCount = 3;
	s.players.Blue!.attackDice = arcaneDice(1);
	s.players.Orange!.attackDice = arcaneDice(1);
	s.players.Red!.victoryPoints = 5;
};

describe('PvP pays the Evil attacker 3 VP per Good player corrupted, nothing for the attack itself', () => {
	it('formula: 0 / 3 / 6 for 0 / 1 / 2 corrupted', () => {
		expect(pvpVpPerCorrupted(PVP_CATALOG)).toBe(3);
		expect([0, 1, 2].map((c) => pvpVpForAttack(c))).toEqual([0, 3, 6]);
	});

	it('one Good player corrupted: 3 VP', () => {
		expect(vps(pvpExchange(oneCorrupted))).toEqual([3, 0, 0]);
	});

	it('nobody corrupted: 0 VP', () => {
		expect(vps(pvpExchange(() => {}))).toEqual([0, 0, 0]);
	});

	it('the Evil attacker corrupted: the Good players get nothing', () => {
		// Red was Fallen with no spirits: the 4th corruption owes 4 sacrifices → 4 VP lost (5 → 1).
		const s = pvpExchange(attackerCorrupted);
		expect(vps(s)).toEqual([1, 0, 0]);
		expect(s.combats.find((c) => c.kind === 'pvp')!.log.join('\n')).not.toContain('PvP bounty');
	});

	it('a corrupted Fallen attacker at 0 VP ends below 0', () => {
		const at0 = (s: PublicGameState) => {
			attackerCorrupted(s);
			s.players.Red!.victoryPoints = 0;
		};
		expect(vps(pvpExchange(at0))).toEqual([-4, 0, 0]);
	});

	it('the brief and the labels say so', () => {
		const brief = buildRulesBrief(frozen);
		expect(brief).toContain('An Evil attacker gets 3 VP per opponent corrupted in the attack and nothing for the attack itself.');
		expect(brief).not.toContain('Each Good player in it gets');
		expect(brief).toContain('each missing spirit costs 1 VP, even below 0 (VP can go negative).');
		const me = makePlayer({ statusLevel: 3, statusToken: 'Fallen', spirits: [spirit(1, { Queen: 1 })] });
		const view = makeState(me) as unknown as Parameters<typeof labelFor>[1];
		expect(labelFor({ type: 'initiatePvp' }, view, 'Red', frozen)).toBe(
			'Attack the Good players at your location (PvP group attack: you get 3 VP per Good player corrupted, nothing otherwise)'
		);
		expect(labelFor({ type: 'passEncounter' }, view, 'Red', frozen)).toBe('Do not attack this round (pass the encounter)');
	});
});

describe('while Fallen, an owed sacrifice that cannot be paid in spirits costs 1 VP, even below 0', () => {
	const fallen = (vp: number, corruptionCount: number) =>
		makePlayer({ statusLevel: 3, statusToken: 'Fallen', victoryPoints: vp, corruptionCount, spirits: [] });
	it('setCorruptionDiscardObligation goes below 0', () => {
		const p = fallen(1, 3);
		expect(setCorruptionDiscardObligation(p, undefined, { wasFallen: true, vpBelowZero: true })).toBe(3);
		expect(p.victoryPoints).toBe(-2);
	});
	it('settleUnpayableCorruptionDebt: below 0 only while Fallen', () => {
		const withDebt = (statusLevel: number) => {
			const p = fallen(1, 3);
			p.statusLevel = statusLevel;
			p.pendingCorruptionDiscard = { count: 3 };
			return p;
		};
		const b = withDebt(3);
		settleUnpayableCorruptionDebt(b, { vpBelowZero: true });
		expect(b.victoryPoints).toBe(-2);
		const c = withDebt(2);
		settleUnpayableCorruptionDebt(c, { vpBelowZero: true });
		expect(c.victoryPoints).toBe(0);
	});
	it('a monster hit that corrupts a Fallen seat at 0 VP with no spirits', () => {
		const p = fallen(0, 1);
		p.barrier = 2;
		takeDamage(p, 5, { state: makeState(p), seat: 'Red' }, []);
		expect(p.victoryPoints).toBe(-2); // the 2nd corruption owes 2
	});
});

describe('Mystic (3): "When you Cultivate, you may gain twice as many runes."', () => {
	const fire3 = (mystic: number, faceDown = false) => [
		spirit(1, { Mystic: mystic }, { origins: { 'Fire Region': 1 }, faceDown }),
		spirit(2, {}, { origins: { 'Fire Region': 1 } }),
		spirit(3, {}, { origins: { 'Fire Region': 1 } })
	];
	const runesAfterCultivate = (spirits: ReturnType<typeof spirit>[]) => {
		const player = makePlayer({ spirits });
		applyCultivate(makeState(player), 'Red', []);
		return player.mats.filter((m) => m.hasRune).length;
	};

	it('3 awakened Mystic: 2 runes per origin reward', () => {
		expect(runesAfterCultivate(fire3(3))).toBe(2);
	});

	it('2 Mystic or a face-down Mystic: 1 rune', () => {
		expect(runesAfterCultivate(fire3(2))).toBe(1);
		expect(runesAfterCultivate(fire3(3, true))).toBe(1);
	});

	it('does not stack with another doubling of the turn', () => {
		const player = makePlayer({ spirits: fire3(3), doubleRunes: true });
		applyCultivate(makeState(player), 'Red', []);
		expect(player.mats.filter((m) => m.hasRune).length).toBe(2);
	});

	it('no Max Barrier after a corruption', () => {
		const player = makePlayer({ barrier: 2, maxBarrier: 4, statusLevel: 0, spirits: [spirit(1, { Mystic: 3 })] });
		takeDamage(player, 9, { state: makeState(player), seat: 'Red' }, []);
		expect(player.maxBarrier).toBe(4);
	});

	it('the class text in the game data', () => {
		expect(classText('Mystic', 3)).toContain('When you Cultivate, you may gain twice as many runes.');
	});
});

describe('Cultivate: one reward per origin, the rune at 3+, the rune or the relic at 5+', () => {
	const fire = (n: number, mystic = 0) =>
		Array.from({ length: n }, (_, i) =>
			spirit(i + 1, i === 0 && mystic ? { Mystic: mystic } : {}, { origins: { 'Fire Region': 1 } })
		);
	const cultivate = (spirits: ReturnType<typeof spirit>[]) => {
		const player = makePlayer({ spirits });
		const state = makeState(player);
		applyCultivate(state, 'Red', []);
		return { player, state };
	};
	const runes = (p: { mats: { hasRune: boolean; type?: string }[] }) =>
		p.mats.filter((m) => m.hasRune && m.type !== 'relic').length;
	const relics = (p: { mats: { hasRune: boolean; type?: string }[] }) =>
		p.mats.filter((m) => m.hasRune && m.type === 'relic').length;
	const ctxOf = (player: ReturnType<typeof makePlayer>, state: PublicGameState) =>
		buildEffectContext({ state, seat: 'Red', player, trigger: 'awakeningPhase', log: [], traitCount: 0 });

	it('2 spirits: nothing. 3 and 4 spirits: the rune at once, no card', () => {
		expect(runes(cultivate(fire(2)).player)).toBe(0);
		for (const n of [3, 4]) {
			const { player } = cultivate(fire(n));
			expect(runes(player)).toBe(1);
			expect(player.pendingDecisions).toHaveLength(0);
		}
	});

	it('5, 6 and 7 spirits: a card with the relic and the rune; nothing is given before the answer', () => {
		for (const n of [5, 6, 7]) {
			const { player } = cultivate(fire(n));
			expect(runes(player) + relics(player)).toBe(0);
			expect(player.pendingDecisions).toHaveLength(1);
			expect(player.pendingDecisions[0].options.map((o) => o.label)).toEqual([
				'The Firecracker relic (one time)',
				'1 Fire Rune'
			]);
		}
	});

	it('the resolver gives exactly the chosen reward', () => {
		const pick = (which: 'relic' | 'rune') => {
			const { player, state } = cultivate(fire(5));
			const card = player.pendingDecisions[0];
			DECISION_RESOLVERS.originCultivate(ctxOf(player, state), card.options.find((o) => o.id.startsWith(which))!.id);
			return player;
		};
		const relic = pick('relic');
		expect([runes(relic), relics(relic), relic.originRelicsGained]).toEqual([0, 1, ['Fire Region']]);
		const rune = pick('rune');
		expect([runes(rune), relics(rune), rune.originRelicsGained ?? []]).toEqual([1, 0, []]);
	});

	it('after the relic is taken, 5+ gives the rune at once; the relic is one time', () => {
		const player = makePlayer({ spirits: fire(6), originRelicsGained: ['Fire Region'] });
		applyCultivate(makeState(player), 'Red', []);
		expect([runes(player), relics(player), player.pendingDecisions.length]).toEqual([1, 0, 0]);
	});

	it('after the rune is chosen, the next Cultivate offers the relic again', () => {
		const { player, state } = cultivate(fire(5));
		DECISION_RESOLVERS.originCultivate(ctxOf(player, state), player.pendingDecisions[0].options[1].id);
		player.pendingDecisions = [];
		applyCultivate(state, 'Red', []);
		expect(player.pendingDecisions).toHaveLength(1);
	});

	it('two cards in one round: the second "relic" answer gives the rune', () => {
		const { player, state } = cultivate(fire(5));
		applyCultivate(state, 'Red', []);
		expect(player.pendingDecisions).toHaveLength(2);
		const ctx = ctxOf(player, state);
		for (const card of player.pendingDecisions) DECISION_RESOLVERS.originCultivate(ctx, card.options[0].id);
		expect([runes(player), relics(player)]).toEqual([1, 1]);
	});

	it('with Mystic (3) doubling: the rune option is 2 runes; the relic is not doubled', () => {
		const at3 = cultivate(fire(3, 3)).player;
		expect(runes(at3)).toBe(2);
		const { player, state } = cultivate(fire(5, 3));
		expect(player.pendingDecisions[0].options[1].label).toBe('2 Fire Runes');
		DECISION_RESOLVERS.originCultivate(ctxOf(player, state), player.pendingDecisions[0].options[1].id);
		expect([runes(player), relics(player)]).toEqual([2, 0]);
	});
});

describe('Ram: "In combat, deal 1 more damage for each Spirit Augment on your spirits."', () => {
	const ram = (augments: number, faceDown = false) =>
		makePlayer({
			spirits: [spirit(1, { Ram: 1 }, { faceDown }), spirit(2, { Fighter: 1 }), spirit(3, { Fighter: 1 }, { faceDown: true })],
			spiritAugmentAttachments: Array.from({ length: augments }, (_, i) => ({
				spiritSlotIndex: 2 + (i % 2),
				className: 'Fighter'
			})) as never
		});
	const bonus = (player: ReturnType<typeof makePlayer>, opponent?: 'Blue') => {
		resetCombatFlags(player);
		const evil = makePlayer({ playerColor: 'Blue', statusLevel: 3, statusToken: 'Fallen' });
		applyTrigger(makeState(player, { Blue: evil }), 'Red', 'inCombat', [], { opponent });
		return player.combatDamageBonus;
	};

	it('+1 damage per placed augment, against a monster and against a player', () => {
		expect(bonus(ram(0))).toBe(0);
		expect(bonus(ram(1))).toBe(1);
		expect(bonus(ram(3))).toBe(3); // an augment on a face-down spirit counts too
		expect(bonus(ram(2), 'Blue')).toBe(2);
	});

	it('a face-down Ram gives nothing; augments not yet placed do not count', () => {
		expect(bonus(ram(2, true))).toBe(0);
		const player = ram(1);
		player.unplacedAugments = [{ runeId: 'x', name: 'Spirit Augment' }] as never;
		expect(bonus(player)).toBe(1);
	});

	it('no augment card at the Mountain Region', () => {
		const player = ram(2);
		player.navigationDestination = 'Mountain Region' as never;
		applyTrigger(makeState(player), 'Red', 'onNavigate', []);
		expect(player.pendingDecisions.filter((d) => d.kind === 'ramAugment')).toHaveLength(0);
	});

	it('in a real monster fight the damage dealt is the dice plus 1 per placed augment', () => {
		const player = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			attackDice: [],
			spirits: [spirit(1, { Ram: 1 }), spirit(2, {})],
			spiritAugmentAttachments: [
				{ runeId: 'a', spiritId: 's2', spiritSlotIndex: 2, className: 'Fighter' },
				{ runeId: 'b', spiritId: 's1', spiritSlotIndex: 1, className: 'Healer' }
			],
			monsterHand: [
				{ id: 'm', name: 'Test Monster', hp: 9, maxHp: 9, damage: 1, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 }
			] as never
		});
		expect(fightMonster(makeState(player), 'Red')!.playerDamage).toBe(2); // no dice: 0 + 2 augments
	});
});

describe('an Evil player may attack Good players at the Arcane Abyss', () => {
	it('the Encounter step opens at the Abyss with both Good players as targets', () => {
		const state = pvpExchange(oneCorrupted, 'Arcane Abyss', false);
		expect(state.phase).toBe('encounter');
		expect(computeAffordances(state, 'Red', PVP_CATALOG).encounter).toEqual({
			eligibleTargets: ['Blue', 'Orange'],
			votesPending: ['Red']
		});
		expect(computeAffordances(state, 'Blue', PVP_CATALOG).encounter).toBeUndefined();
	});

	it('the attack resolves as a player fight, then the Abyss Location step follows', () => {
		const state = pvpExchange(oneCorrupted, 'Arcane Abyss');
		expect(state.combats.filter((c) => c.kind === 'pvp')).toHaveLength(1);
		expect(vps(state)).toEqual([3, 0, 0]); // the same payout as in a region
		expect(state.players.Blue!.statusLevel).toBe(1); // corrupted once
		expect(state.phase).toBe('location');
	});

	it('passing instead of attacking gives no fight', () => {
		const before = pvpExchange(oneCorrupted, 'Arcane Abyss', false);
		const r = applyGameCommand(before, ACTORS_C.Red as never, { type: 'passEncounter' } as never, PVP_CATALOG);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.state.combats.filter((c) => c.kind === 'pvp')).toHaveLength(0);
			expect(r.state.phase).toBe('location');
		}
	});

	it('regions are unchanged', () => {
		expect(vps(pvpExchange(oneCorrupted))).toEqual([3, 0, 0]);
	});
});
