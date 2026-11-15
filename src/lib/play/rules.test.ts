/**
 * Rule switches (rules.ts, proposal-B and proposal-C): each rule ON vs OFF, the catalog/hash contract, and that
 * the agent brief, view and labels mention a rule only when it is on.
 *
 *   npx vitest run src/lib/play/rules.test.ts
 */

import { mkdtempSync, readdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRules, ruleAdjustedClassSchema, ruleValue } from './rules';
import { applyGameCommand, createLobbyState } from './runtime';
import { initRoundLoop } from './phases';
import { pvpGoodBounty, pvpVpForAttack, resetCombatFlags, takeDamage } from './combat';
import { setCorruptionDiscardObligation, settleUnpayableCorruptionDebt } from './types';
import { canApply } from './legality';
import { botActorFor } from './server/botPolicy';
import { ARCANE_ABYSS_BAG } from './bags';
import { applyCultivate, applyTrigger } from './effects/apply';
import { checkAwakenCondition, payAwakenCondition } from './effects/awaken';
import { buildEffectContext } from './effects/context';
import { DECISION_RESOLVERS } from './effects/decisions';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { agentLegalCommands } from './agents/actionSurface';
import { catalogHash, loadFrozenCatalog, loadLocalDesignCatalog } from './agents/catalog';
import { labelFor, publicLabelFor } from './agents/labels';
import { buildRulesBrief } from './agents/rulesBrief';
import { renderSeatView, seatProjection } from './agents/view';
import { createAgentLobby, pickGuardians, seatsFor } from './agents/setup';
import type { PlayCatalog, PlayRules, PublicGameState } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const withRules = (rules: PlayRules | undefined): PlayCatalog => ({ ...frozen, rules });
const ALL_ON: PlayRules = {
	feralMonsterStrikeFirst: false,
	summonReplaceWhenFull: true,
	cultivatorRelicOnce: true
};

describe('parseRules / ruleValue', () => {
	it('keeps only switches that differ from the default; none ⇒ undefined', () => {
		expect(parseRules(undefined).rules).toBeUndefined();
		expect(parseRules({}).rules).toBeUndefined();
		expect(
			parseRules({ feralMonsterStrikeFirst: true, summonReplaceWhenFull: false, cultivatorRelicOnce: false })
				.rules
		).toBeUndefined();
		expect(parseRules(ALL_ON).rules).toEqual(ALL_ON);
		// A table served as rows (the local game) is accepted too.
		expect(parseRules([{ summonReplaceWhenFull: true }]).rules).toEqual({ summonReplaceWhenFull: true });
	});

	it('reports unknown names and non-boolean values', () => {
		const { rules, problems } = parseRules({ summonReplaceWhenFul: true, cultivatorRelicOnce: 'yes' });
		expect(rules).toBeUndefined();
		expect(problems.join('\n')).toContain('unknown switch "summonReplaceWhenFul"');
		expect(problems.join('\n')).toContain('"cultivatorRelicOnce" must be true or false');
	});

	it('a catalog without rules has every default (the old rules)', () => {
		expect(ruleValue(frozen, 'feralMonsterStrikeFirst')).toBe(true);
		expect(ruleValue(frozen, 'summonReplaceWhenFull')).toBe(false);
		expect(ruleValue(frozen, 'cultivatorRelicOnce')).toBe(false);
		expect(ruleValue(withRules(ALL_ON), 'feralMonsterStrikeFirst')).toBe(false);
	});
});

describe('rules.json in a design folder', () => {
	const source = join(process.env.HOME ?? '', 'arcspirits-harness/experiments/proposal-A/game');
	it.skipIf(!existsSync(source))('absent or all-default ⇒ same catalog hash; switches on ⇒ catalog.rules', () => {
		const dir = mkdtempSync(join(tmpdir(), 'rules-test-'));
		for (const f of readdirSync(source).filter((n) => n.endsWith('.json'))) copyFileSync(join(source, f), join(dir, f));
		const before = loadLocalDesignCatalog(dir);
		expect(before.rules).toBeUndefined();
		writeFileSync(join(dir, 'rules.json'), JSON.stringify({ summonReplaceWhenFull: false }));
		expect(catalogHash(loadLocalDesignCatalog(dir))).toBe(catalogHash(before));
		writeFileSync(join(dir, 'rules.json'), JSON.stringify(ALL_ON));
		const after = loadLocalDesignCatalog(dir);
		expect(after.rules).toEqual(ALL_ON);
		expect(catalogHash(after)).not.toBe(catalogHash(before));
		writeFileSync(join(dir, 'rules.json'), JSON.stringify({ summonReplace: true }));
		expect(() => loadLocalDesignCatalog(dir)).toThrow(/unknown switch/);
	});
});

describe('feralMonsterStrikeFirst (C2)', () => {
	const feralPlayer = () => makePlayer({ spirits: [spirit(1, { Feral: 1 })] });

	it('default: strikes first and +3 damage against a monster', () => {
		const player = feralPlayer();
		resetCombatFlags(player);
		applyTrigger(makeState(player), 'Red', 'inCombat', [], { catalog: frozen });
		expect(player.alwaysAttackFirst).toBe(true);
		expect(player.combatDamageBonus).toBe(3);
	});

	it('off: +3 damage against a monster, no strike first', () => {
		const player = feralPlayer();
		resetCombatFlags(player);
		applyTrigger(makeState(player), 'Red', 'inCombat', [], { catalog: withRules(ALL_ON) });
		expect(player.alwaysAttackFirst).toBeFalsy();
		expect(player.combatDamageBonus).toBe(3);
	});

	it('off: still strikes first and +3 when an Evil player attacks', () => {
		const player = feralPlayer();
		const evil = makePlayer({ playerColor: 'Blue', statusLevel: 3, statusToken: 'Fallen' });
		resetCombatFlags(player);
		applyTrigger(makeState(player, { Blue: evil }), 'Red', 'inCombat', [], {
			catalog: withRules(ALL_ON),
			opponent: 'Blue'
		});
		expect(player.alwaysAttackFirst).toBe(true);
		expect(player.combatDamageBonus).toBe(3);
	});
});

describe('cultivatorRelicOnce (C6)', () => {
	const cultivate = (catalog: PlayCatalog, times: number) => {
		const player = makePlayer({
			spirits: [1, 2, 3, 4, 5].map((slot) => spirit(slot, { Cultivator: 1 }))
		});
		const state = makeState(player);
		const offers: number[] = [];
		for (let i = 0; i < times; i++) {
			applyCultivate(state, 'Red', [], { catalog });
			offers.push(player.pendingDecisions.filter((d) => d.kind === 'cultivatorRelic').length);
		}
		return { player, offers };
	};

	it('default: a relic on every Cultivate at 5', () => {
		const { player, offers } = cultivate(frozen, 3);
		expect(offers).toEqual([1, 2, 3]);
		expect(player.cultivatorRelicGained).toBeUndefined(); // not written without the rule
		expect(player.maxBarrier).toBe(10);
	});

	it('on: the relic only the first time; Max Barrier unchanged', () => {
		const { player, offers } = cultivate(withRules(ALL_ON), 3);
		expect(offers).toEqual([1, 1, 1]);
		expect(player.cultivatorRelicGained).toBe(true);
		expect(player.maxBarrier).toBe(10);
	});
});

// ── summonReplaceWhenFull (C3) ────────────────────────────────────────────────

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

describe('summonReplaceWhenFull (C3)', () => {
	const replace = { type: 'spawnHandSpirit', guid: 'draw-0', replaceSlotIndex: 3 } as const;

	it('default: a full board cannot summon, and a replace command is rejected', () => {
		const state = fullBoardWithAbyssDraw(frozen);
		const actor = botActorFor(state, 'Red');
		expect(canApply(state, actor, { type: 'spawnHandSpirit', guid: 'draw-0' }, frozen)).toBe(false);
		expect(canApply(state, actor, replace, frozen)).toBe(false);
		const result = applyGameCommand(state, actor, replace, frozen);
		expect(result.ok).toBe(false);
		const offered = agentLegalCommands(state, 'Red', frozen).commands;
		expect(offered.some((c) => c.type === 'spawnHandSpirit')).toBe(false);
	});

	it('on: the summon replaces the chosen spirit, which goes back to its bag', () => {
		const catalog = withRules(ALL_ON);
		const state = fullBoardWithAbyssDraw(catalog);
		const red = state.players.Red!;
		const old = red.spirits.find((s) => s.slotIndex === 3)!;
		const drawnId = red.handDraws[0].id!;
		const bagBefore = abyssBagCount(state, old.id);
		const actor = botActorFor(state, 'Red');
		expect(canApply(state, actor, replace, catalog)).toBe(true);
		const result = applyGameCommand(state, actor, replace, catalog);
		expect(result.ok).toBe(true);
		const after = result.ok ? result.state.players.Red! : red;
		expect(after.spirits).toHaveLength(7);
		expect(after.spirits.find((s) => s.slotIndex === 3)).toMatchObject({ id: drawnId, isFaceDown: true });
		expect(result.ok && abyssBagCount(result.state, old.id)).toBe(bagBefore + 1);
		expect(after.pendingDraw).toBeNull(); // the one Abyss pick is used
		expect(after.pendingCorruptionDiscard ?? null).toBeNull();
		expect(after.lastAction?.label).toContain(`replacing ${old.name}`);
	});

	it('on: not allowed while a slot is open, nor for an empty slot', () => {
		const catalog = withRules(ALL_ON);
		const state = fullBoardWithAbyssDraw(catalog);
		const red = state.players.Red!;
		red.spirits = red.spirits.filter((s) => s.slotIndex !== 7);
		const actor = botActorFor(state, 'Red');
		expect(canApply(state, actor, replace, catalog)).toBe(false);
		expect(applyGameCommand(state, actor, replace, catalog).ok).toBe(false);
		// With a free slot the normal summon is offered and no replace variant is.
		const offered = agentLegalCommands(state, 'Red', catalog).commands.filter((c) => c.type === 'spawnHandSpirit');
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.every((c) => c.type === 'spawnHandSpirit' && c.replaceSlotIndex === undefined)).toBe(true);
	});

	it('on: the agent is offered "Summon X, replacing Y" for each drawn spirit × each board spirit', () => {
		const catalog = withRules(ALL_ON);
		const state = fullBoardWithAbyssDraw(catalog);
		const offered = agentLegalCommands(state, 'Red', catalog).commands.filter(
			(c) => c.type === 'spawnHandSpirit'
		);
		expect(offered).toHaveLength(3 * 7);
		const view = seatProjection(state, 'Red');
		const old = state.players.Red!.spirits.find((s) => s.slotIndex === 3)!;
		const label = labelFor(replace, view, 'Red', catalog);
		expect(label).toMatch(/^Summon .+, replacing /);
		expect(label).toContain(`replacing ${old.name} (slot 3`);
		expect(label).toContain('discarded back to its bag');
		expect(publicLabelFor(replace, 'Red', view)).toBe(`Red summoned a spirit, replacing ${old.name}.`);
		expect(renderSeatView(view, 'Red', catalog)).toContain('all 7 slots are full: a summon may replace');
		expect(renderSeatView(view, 'Red', frozen)).not.toContain('slots are full');
	});
});

describe('rules text for agents', () => {
	it('the brief is unchanged without rules (absent or all defaults) and names each rule when on', () => {
		const base = buildRulesBrief(frozen);
		expect(buildRulesBrief(withRules({}))).toBe(base);
		expect(base).not.toContain('Full board:');
		const on = buildRulesBrief(withRules(ALL_ON));
		expect(on).toContain('- Full board: when all 7 of your slots hold spirits, a summon may replace');
		expect(on).not.toBe(base);
		const feralText = ruleAdjustedClassSchema(withRules(ALL_ON), 'Feral', [
			{ count: 1, effects: [{ type: 'benefit', description: 'old' }] }
		]);
		expect(feralText?.[0].effects?.[0].description).toContain('When a monster attacks you, deal 3 more damage.');
		const schema = [{ count: 5, effects: [{ type: 'benefit', description: 'old' }] }];
		expect(ruleAdjustedClassSchema(frozen, 'Cultivator', schema)).toBe(schema);
		expect(ruleAdjustedClassSchema(withRules(ALL_ON), 'Cultivator', schema)?.[0].effects?.[0].description).toContain(
			'once per game'
		);
	});

	it('the view mentions the Cultivator relic only once it is taken under the rule', () => {
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

// ── Proposal C (experiments/evil/report.md P1-P4) ────────────────────────────

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
const pvpCatalog = (rules?: PlayRules): PlayCatalog => ({ ...PVP_CATALOG, rules });
const arcaneDice = (n: number) => Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));

/** Red (Fallen) attacks Blue and Orange (Good) in Mountain Region; `setup` shapes the sides. */
function pvpExchange(catalog: PlayCatalog, setup: (s: PublicGameState) => void): PublicGameState {
	const ok = (state: PublicGameState, actor: object, command: object) => {
		const r = applyGameCommand(state, actor as never, command as never, catalog);
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
		state = ok(state, ACTORS_C[seat], { type: 'lockNavigation', destination: 'Mountain Region' });
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
	return ok(state, ACTORS_C.Red, { type: 'initiatePvp' });
}
const vps = (s: PublicGameState) => (['Red', 'Blue', 'Orange'] as const).map((k) => s.players[k]!.victoryPoints);

describe('pvpPaysOnCorrupt (P1)', () => {
	it('formula: old 2 + 2 per corrupted; on 3 per corrupted, and a Good bounty of 2 per corrupted attacker', () => {
		expect([0, 1, 2].map((c) => pvpVpForAttack(c))).toEqual([2, 4, 6]);
		expect([0, 1, 2].map((c) => pvpVpForAttack(c, true))).toEqual([0, 3, 6]);
		expect([0, 1].map((c) => pvpGoodBounty(c))).toEqual([0, 0]);
		expect([0, 1].map((c) => pvpGoodBounty(c, true))).toEqual([0, 2]);
	});

	const oneCorrupted = (s: PublicGameState) => {
		s.players.Red!.attackDice = arcaneDice(3); // 3-9 damage: corrupts Blue (2), never Orange (14)
		s.players.Blue!.maxBarrier = 2;
		s.players.Blue!.barrier = 2;
	};
	it('one Good corrupted: off 4 VP, on 3 VP', () => {
		expect(vps(pvpExchange(pvpCatalog(), oneCorrupted))).toEqual([4, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog({ pvpPaysOnCorrupt: true }), oneCorrupted))).toEqual([3, 0, 0]);
	});

	it('nobody corrupted: off 2 VP for the attack, on 0', () => {
		expect(vps(pvpExchange(pvpCatalog(), () => {}))).toEqual([2, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog({ pvpPaysOnCorrupt: true }), () => {}))).toEqual([0, 0, 0]);
	});

	const attackerCorrupted = (s: PublicGameState) => {
		const red = s.players.Red!;
		red.maxBarrier = 1;
		red.barrier = 1;
		red.corruptionCount = 3;
		s.players.Blue!.attackDice = arcaneDice(1); // ≥1 damage, simultaneous (initiative tie)
		s.players.Orange!.attackDice = arcaneDice(1);
		s.players.Red!.victoryPoints = 5;
	};
	it('Evil attacker corrupted: off nothing for the Good side; on each Good player gets 2 VP', () => {
		// Red was Fallen with no spirits: the 4th corruption owes 4 sacrifices → 4 VP lost (5 → 1).
		expect(vps(pvpExchange(pvpCatalog(), attackerCorrupted))).toEqual([1 + 2, 0, 0]);
		const on = pvpExchange(pvpCatalog({ pvpPaysOnCorrupt: true }), attackerCorrupted);
		expect(vps(on)).toEqual([1, 2, 2]);
		expect(on.combats.find((c) => c.kind === 'pvp')!.log.join('\n')).toContain('PvP bounty: each Good player gains 2 VP.');
	});

	it('pvpGoodBounty false: attacker still 3 per corrupted, Good players get nothing', () => {
		const rules = { pvpPaysOnCorrupt: true, pvpGoodBounty: false };
		expect(vps(pvpExchange(pvpCatalog(rules), oneCorrupted))).toEqual([3, 0, 0]);
		const off = pvpExchange(pvpCatalog(rules), attackerCorrupted);
		expect(vps(off)).toEqual([1, 0, 0]);
		expect(off.combats.find((c) => c.kind === 'pvp')!.log.join('\n')).not.toContain('PvP bounty');
		expect(buildRulesBrief(pvpCatalog(rules))).not.toContain('Each Good player in it gets');
		expect(buildRulesBrief(pvpCatalog({ pvpPaysOnCorrupt: true }))).toContain('Each Good player in it gets');
	});

	it('with fallenDebtBelowZero the corrupted attacker can end below 0', () => {
		const at0 = (s: PublicGameState) => {
			attackerCorrupted(s);
			s.players.Red!.victoryPoints = 0;
		};
		expect(vps(pvpExchange(pvpCatalog({ pvpPaysOnCorrupt: true }), at0))).toEqual([0, 2, 2]);
		expect(vps(pvpExchange(pvpCatalog({ pvpPaysOnCorrupt: true, fallenDebtBelowZero: true }), at0))).toEqual([-4, 2, 2]);
	});
});

describe('moonPerksNeedAttack (P2)', () => {
	const awakening = (classes: Record<string, number>, rules: PlayRules | undefined, attacked?: boolean) => {
		const player = makePlayer({ statusLevel: 3, statusToken: 'Fallen', spirits: [spirit(1, classes)] });
		if (attacked !== undefined) player.attackedPlayerThisRound = attacked;
		applyTrigger(makeState(player), 'Red', 'awakeningPhase', [], { catalog: withRules(rules) });
		return player;
	};
	it('Queen: off 1 VP every round; on only in a round you attacked a player', () => {
		expect(awakening({ Queen: 1 }, undefined).victoryPoints).toBe(1);
		expect(awakening({ Queen: 1 }, { moonPerksNeedAttack: true }).victoryPoints).toBe(0);
		expect(awakening({ Queen: 1 }, { moonPerksNeedAttack: true }, true).victoryPoints).toBe(1);
	});
	it('Sorcerer: off a die every round while Evil; on only in a round you attacked a player', () => {
		expect(awakening({ Sorcerer: 1 }, undefined).attackDice).toHaveLength(1);
		expect(awakening({ Sorcerer: 1 }, { moonPerksNeedAttack: true }).attackDice).toHaveLength(0);
		expect(awakening({ Sorcerer: 1 }, { moonPerksNeedAttack: true }, true).attackDice).toHaveLength(1);
	});
	it('the flag is written only under the rule, set by a resolved attack and cleared at the next round', () => {
		const off = pvpExchange(pvpCatalog(), () => {});
		expect('attackedPlayerThisRound' in off.players.Red!).toBe(false);
		const on = pvpExchange(pvpCatalog({ moonPerksNeedAttack: true }), () => {});
		expect(on.players.Red!.attackedPlayerThisRound).toBe(true);
		expect('attackedPlayerThisRound' in on.players.Blue!).toBe(false); // only the attacker
		initRoundLoop(on);
		expect(on.players.Red!.attackedPlayerThisRound).toBe(false);
		expect('attackedPlayerThisRound' in on.players.Blue!).toBe(false);
	});
});

describe('corruptorCountsAsCorruption (P3)', () => {
	const awakenNhal = (rules: PlayRules | undefined, extra: { corruptionCount?: number; cultist?: boolean } = {}) => {
		const spirits = [
			{ ...spirit(1, { Corruptor: 1 }, { id: 'nhal', name: 'Nhal' }), cost: 7 },
			{ ...spirit(2, { Fighter: 1 }, { id: 'w1', name: 'World One' }), cost: 3 },
			{ ...spirit(3, { Beast: 1 }, { id: 'w2', name: 'World Two' }), cost: 3 }
		];
		if (extra.cultist) spirits.push({ ...spirit(4, { Cultist: 1 }, { id: 'mc', name: 'Moon Cultist' }), cost: 7 });
		const player = makePlayer({ statusLevel: 1, statusToken: 'Tainted', barrier: 1, maxBarrier: 6, brokenBarrier: 5, corruptionCount: extra.corruptionCount ?? 1 });
		player.spirits = spirits;
		const state = makeState(player) as PublicGameState;
		state.round = 3;
		state.bags = {
			hexSpirits: { count: 0, contents: [] },
			abyssFallen: { count: 2, contents: [{ guid: 'g1', id: 'a1', name: 'Abyss One', cost: 7 }, { guid: 'g2', id: 'a2', name: 'Abyss Two', cost: 8 }] }
		} as unknown as PublicGameState['bags'];
		applyTrigger(state, 'Red', 'awakening', [], { command: { slotIndex: 1 }, catalog: withRules(rules) });
		return player;
	};
	it('off: Fallen with no corruption, no sacrifice, no Barrier restore (the swap happens)', () => {
		const p = awakenNhal(undefined);
		expect(p.statusLevel).toBe(3);
		expect(p.corruptionCount).toBe(1);
		expect(p.pendingCorruptionDiscard ?? null).toBeNull();
		expect(p.barrier).toBe(1);
		expect(p.spirits.find((s) => s.slotIndex === 2)?.id).toBe('a1');
	});
	it('on: one corruption — count +1, Barrier restored, the usual sacrifice; the swap stays', () => {
		const p = awakenNhal({ corruptorCountsAsCorruption: true });
		expect(p.statusLevel).toBe(3);
		expect(p.corruptionCount).toBe(2);
		expect(p.pendingCorruptionDiscard?.count).toBe(2); // the 2nd corruption owes 2
		expect(p.barrier).toBe(6);
		expect(p.brokenBarrier).toBe(0);
		expect(p.spirits.find((s) => s.slotIndex === 2)?.id).toBe('a1');
		expect(p.spirits.find((s) => s.slotIndex === 3)?.id).toBe('a2');
	});
	it('on: an awake Cultist lowers the sacrifice by 1 and gives 1 VP', () => {
		const p = awakenNhal({ corruptorCountsAsCorruption: true }, { corruptionCount: 0, cultist: true });
		expect(p.corruptionCount).toBe(1);
		expect(p.pendingCorruptionDiscard ?? null).toBeNull(); // 1 owed − 1 (Cultist)
		expect(p.victoryPoints).toBe(1);
	});
});

describe('fallenDebtBelowZero (P4)', () => {
	const fallen = (vp: number, corruptionCount: number) =>
		makePlayer({ statusLevel: 3, statusToken: 'Fallen', victoryPoints: vp, corruptionCount, spirits: [] });
	it('setCorruptionDiscardObligation: off clamps at 0, on goes below 0', () => {
		const off = fallen(1, 3);
		expect(setCorruptionDiscardObligation(off, undefined, { wasFallen: true })).toBe(3);
		expect(off.victoryPoints).toBe(0);
		const on = fallen(1, 3);
		expect(setCorruptionDiscardObligation(on, undefined, { wasFallen: true, vpBelowZero: true })).toBe(3);
		expect(on.victoryPoints).toBe(-2);
	});
	it('settleUnpayableCorruptionDebt: below 0 only while Fallen and only on', () => {
		const withDebt = (statusLevel: number) => {
			const p = fallen(1, 3);
			p.statusLevel = statusLevel;
			p.pendingCorruptionDiscard = { count: 3 };
			return p;
		};
		const a = withDebt(3);
		settleUnpayableCorruptionDebt(a);
		expect(a.victoryPoints).toBe(0);
		const b = withDebt(3);
		settleUnpayableCorruptionDebt(b, { vpBelowZero: true });
		expect(b.victoryPoints).toBe(-2);
		const c = withDebt(2);
		settleUnpayableCorruptionDebt(c, { vpBelowZero: true });
		expect(c.victoryPoints).toBe(0);
	});
	it('a monster hit that corrupts a Fallen seat at 0 VP with no spirits: off 0, on −(N)', () => {
		const hit = (rules?: PlayRules) => {
			const p = fallen(0, 1);
			p.barrier = 2;
			takeDamage(p, 5, { state: makeState(p), seat: 'Red', catalog: withRules(rules) }, []);
			return p;
		};
		expect(hit().victoryPoints).toBe(0);
		expect(hit({ fallenDebtBelowZero: true }).victoryPoints).toBe(-2); // the 2nd corruption owes 2
	});
});

describe('proposal C text for agents (only when on)', () => {
	const C_ON: PlayRules = { pvpPaysOnCorrupt: true, moonPerksNeedAttack: true, corruptorCountsAsCorruption: true, fallenDebtBelowZero: true };
	// The brief lists the classes of the catalog's spirits: the frozen fixture has older class names,
	// so the class-text part uses proposal-B's data (Queen, Sorcerer, Corruptor).
	const B_DIR = join(process.env.HOME ?? '', 'arcspirits-harness/experiments/proposal-B/game');
	it.skipIf(!existsSync(B_DIR))('brief: unchanged when off; the PvP and Fallen lines and the class texts change when on; the brief stays short', () => {
		const real = loadLocalDesignCatalog(B_DIR);
		const base = buildRulesBrief(real);
		expect(buildRulesBrief({ ...real, rules: { ...real.rules, pvpPaysOnCorrupt: false, fallenDebtBelowZero: false } })).toBe(base);
		const on = buildRulesBrief({ ...real, rules: { ...real.rules, ...C_ON } });
		expect(base).toContain('An Evil attacker gets 2 VP for the attack plus 2 VP per opponent corrupted in it.');
		expect(on).toContain('An Evil attacker gets 3 VP per opponent corrupted in the attack and nothing for the attack itself. Each Good player in it gets 2 VP per Evil attacker corrupted.');
		expect(on).toContain('each missing spirit costs 1 VP, even below 0 (VP can go negative).');
		expect(on).toContain('- Queen: (1) In the Awakening Phase, if you attacked a player this round, gain 1 VP.');
		expect(on).toContain('- Sorcerer: (1) In the Awakening Phase, if you are Evil and attacked a player this round, gain 1 Enchanted Attack Dice.');
		expect(on).toContain('- Corruptor: (1) Drop your status to Fallen; this counts as one corruption');
		expect(base).not.toContain('attacked a player this round');
		expect(on.length - base.length).toBeLessThan(500);
		for (const k of ['Queen', 'Sorcerer', 'Corruptor']) {
			const schema = [{ count: 1, effects: [{ type: 'benefit', description: 'old' }] }];
			expect(ruleAdjustedClassSchema(frozen, k, schema)).toBe(schema);
		}
	});
	it('labels and view: the PvP payoff and the Queen/Sorcerer note only when on', () => {
		const me = makePlayer({ statusLevel: 3, statusToken: 'Fallen', spirits: [spirit(1, { Queen: 1 })] });
		const view = makeState(me) as unknown as Parameters<typeof labelFor>[1];
		expect(labelFor({ type: 'initiatePvp' }, view, 'Red', frozen)).toBe('Attack the Good players at your location (PvP group attack)');
		expect(labelFor({ type: 'passEncounter' }, view, 'Red', frozen)).toBe('Do not attack this round (pass the encounter)');
		const cat = withRules(C_ON);
		expect(labelFor({ type: 'initiatePvp' }, view, 'Red', cat)).toBe(
			'Attack the Good players at your location (PvP group attack: you get 3 VP per Good player corrupted, nothing otherwise; each of them gets 2 VP per attacker corrupted) (this turns on your Queen this round)'
		);
		expect(labelFor({ type: 'passEncounter' }, view, 'Red', cat)).toBe('Do not attack this round (pass the encounter) (no Queen gain this round)');
		const state = fullBoardWithAbyssDraw(frozen);
		const red = state.players.Red!;
		red.statusLevel = 3;
		red.statusToken = 'Fallen';
		red.spirits[1] = { ...red.spirits[1], classes: { Sorcerer: 1 }, isFaceDown: false };
		expect(renderSeatView(seatProjection(state, 'Red'), 'Red', frozen)).not.toContain('Attacked a player this round');
		expect(renderSeatView(seatProjection(state, 'Red'), 'Red', cat)).toContain(
			'Attacked a player this round: no (Sorcerer gain only in a round you attacked a player)'
		);
	});
});

describe('mysticCultivateDouble: Mystic (2) "When you Cultivate, you may gain twice as many runes."', () => {
	const ON = withRules({ mysticCultivateDouble: true });
	const fire3 = (mystic: number, faceDown = false) => [
		spirit(1, { Mystic: mystic }, { origins: { 'Fire Region': 1 }, faceDown }),
		spirit(2, {}, { origins: { 'Fire Region': 1 } }),
		spirit(3, {}, { origins: { 'Fire Region': 1 } })
	];
	const runesAfterCultivate = (catalog: PlayCatalog, spirits: ReturnType<typeof spirit>[]) => {
		const player = makePlayer({ spirits });
		applyCultivate(makeState(player), 'Red', [], { catalog });
		return player.mats.filter((m) => m.hasRune).length;
	};

	it('on, 2 awakened Mystic: 2 runes per origin reward', () => {
		expect(runesAfterCultivate(ON, fire3(2))).toBe(2);
	});

	it('on, 1 Mystic or a face-down Mystic: 1 rune', () => {
		expect(runesAfterCultivate(ON, fire3(1))).toBe(1);
		expect(runesAfterCultivate(ON, fire3(2, true))).toBe(1);
	});

	it('off (default): 1 rune', () => {
		expect(runesAfterCultivate(frozen, fire3(2))).toBe(1);
	});

	it('does not stack with another doubling of the turn', () => {
		const player = makePlayer({ spirits: fire3(2), doubleRunes: true });
		applyCultivate(makeState(player), 'Red', [], { catalog: ON });
		expect(player.mats.filter((m) => m.hasRune).length).toBe(2);
	});

	it('on: no Max Barrier after a corruption; off: +2 as before', () => {
		const hit = (catalog: PlayCatalog) => {
			const player = makePlayer({ barrier: 2, maxBarrier: 4, statusLevel: 0, spirits: [spirit(1, { Mystic: 2 })] });
			takeDamage(player, 9, { state: makeState(player), seat: 'Red', catalog }, []);
			return player.maxBarrier;
		};
		expect(hit(ON)).toBe(4);
		expect(hit(frozen)).toBe(6);
	});

	it('printed text follows the switch', () => {
		const schema = [
			{ count: 1, effects: [{ type: 'benefit', description: 'one' }] },
			{ count: 2, effects: [{ type: 'benefit', description: 'old two' }] }
		] as never;
		expect(ruleAdjustedClassSchema(frozen, 'Mystic', schema)).toBe(schema);
		expect(ruleAdjustedClassSchema(ON, 'Mystic', schema)?.[1].effects?.[0].description).toBe(
			'When you Cultivate, you may gain twice as many runes.'
		);
	});
});

describe('cultivateRuneOrRelic: one reward per origin, the rune at 3+, the rune or the relic at 5+', () => {
	const ON = withRules({ cultivateRuneOrRelic: true });
	const fire = (n: number, mystic = 0) =>
		Array.from({ length: n }, (_, i) =>
			spirit(i + 1, i === 0 && mystic ? { Mystic: mystic } : {}, { origins: { 'Fire Region': 1 } })
		);
	const cultivate = (catalog: PlayCatalog, spirits: ReturnType<typeof spirit>[]) => {
		const player = makePlayer({ spirits });
		const state = makeState(player);
		applyCultivate(state, 'Red', [], { catalog });
		return { player, state };
	};
	const runes = (p: { mats: { hasRune: boolean; type?: string }[] }) =>
		p.mats.filter((m) => m.hasRune && m.type !== 'relic').length;
	const relics = (p: { mats: { hasRune: boolean; type?: string }[] }) =>
		p.mats.filter((m) => m.hasRune && m.type === 'relic').length;
	it('2 spirits: nothing. 3 and 4 spirits: the rune at once, no card', () => {
		expect(runes(cultivate(ON, fire(2)).player)).toBe(0);
		for (const n of [3, 4]) {
			const { player } = cultivate(ON, fire(n));
			expect(runes(player)).toBe(1);
			expect(player.pendingDecisions).toHaveLength(0);
		}
	});

	it('5, 6 and 7 spirits: a card with the relic and the rune; nothing is given before the answer', () => {
		for (const n of [5, 6, 7]) {
			const { player } = cultivate(ON, fire(n));
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
			const { player, state } = cultivate(ON, fire(5));
			const card = player.pendingDecisions[0];
			const ctx = buildEffectContext({ state, seat: 'Red', player, trigger: 'awakeningPhase', log: [], traitCount: 0, catalog: ON });
			DECISION_RESOLVERS.originCultivate(ctx, card.options.find((o) => o.id.startsWith(which))!.id);
			return player;
		};
		const relic = pick('relic');
		expect([runes(relic), relics(relic), relic.originRelicsGained]).toEqual([0, 1, ['Fire Region']]);
		const rune = pick('rune');
		expect([runes(rune), relics(rune), rune.originRelicsGained ?? []]).toEqual([1, 0, []]);
	});

	it('after the relic is taken, 5+ gives the rune at once; the relic is one time', () => {
		const player = makePlayer({ spirits: fire(6), originRelicsGained: ['Fire Region'] });
		applyCultivate(makeState(player), 'Red', [], { catalog: ON });
		expect([runes(player), relics(player), player.pendingDecisions.length]).toEqual([1, 0, 0]);
	});

	it('after the rune is chosen, the next Cultivate offers the relic again', () => {
		const { player, state } = cultivate(ON, fire(5));
		const ctx = buildEffectContext({ state, seat: 'Red', player, trigger: 'awakeningPhase', log: [], traitCount: 0, catalog: ON });
		DECISION_RESOLVERS.originCultivate(ctx, player.pendingDecisions[0].options[1].id);
		player.pendingDecisions = [];
		applyCultivate(state, 'Red', [], { catalog: ON });
		expect(player.pendingDecisions).toHaveLength(1);
	});

	it('two cards in one round: the second "relic" answer gives the rune', () => {
		const { player, state } = cultivate(ON, fire(5));
		applyCultivate(state, 'Red', [], { catalog: ON });
		expect(player.pendingDecisions).toHaveLength(2);
		const ctx = buildEffectContext({ state, seat: 'Red', player, trigger: 'awakeningPhase', log: [], traitCount: 0, catalog: ON });
		for (const card of player.pendingDecisions) DECISION_RESOLVERS.originCultivate(ctx, card.options[0].id);
		expect([runes(player), relics(player)]).toEqual([1, 1]);
	});

	it('with Mystic (2) doubling: the rune option is 2 runes; the relic is not doubled', () => {
		const both = withRules({ cultivateRuneOrRelic: true, mysticCultivateDouble: true });
		const at3 = cultivate(both, fire(3, 2)).player;
		expect(runes(at3)).toBe(2);
		const { player, state } = cultivate(both, fire(5, 2));
		expect(player.pendingDecisions[0].options[1].label).toBe('2 Fire Runes');
		const ctx = buildEffectContext({ state, seat: 'Red', player, trigger: 'awakeningPhase', log: [], traitCount: 0, catalog: both });
		DECISION_RESOLVERS.originCultivate(ctx, player.pendingDecisions[0].options[1].id);
		expect([runes(player), relics(player)]).toEqual([2, 0]);
	});

	it('off (default): the rune and, the first time, also the relic; no card', () => {
		const { player } = cultivate(frozen, fire(5));
		expect([runes(player), relics(player), player.pendingDecisions.length]).toEqual([1, 1, 0]);
	});
});
