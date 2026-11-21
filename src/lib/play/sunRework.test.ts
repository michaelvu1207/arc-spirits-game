/**
 * Rule switches sunRework, bastionVsMonsters, pvpEngageVp and pvpAttackerSacrificeCap (rules.ts):
 * each one OFF (the old rule) vs ON, and that the agent brief / labels change only when on.
 *
 *   npx vitest run src/lib/play/sunRework.test.ts
 */

import { describe, expect, it } from 'vitest';
import { parseRules, ruleAdjustedClassSchema } from './rules';
import { applyGameCommand, createLobbyState } from './runtime';
import { fightMonster, pvpVpForAttack, takeDamage } from './combat';
import { applyTrigger } from './effects/apply';
import { buildEffectContext } from './effects/context';
import { DECISION_RESOLVERS } from './effects/decisions';
import { WILDCARD_MAT_IDS } from './awakenConditions';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { loadFrozenCatalog } from './agents/catalog';
import { labelFor } from './agents/labels';
import { buildRulesBrief } from './agents/rulesBrief';
import type {
	MonsterState,
	PlayCatalog,
	PlayRules,
	PrivatePlayerState,
	PublicGameState
} from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const rulesCat = (rules?: PlayRules): PlayCatalog => ({ ...frozen, rules });
const SUN: PlayRules = { sunRework: true };

/** Fire `trigger` for Red under `rules`; returns the player and the log. */
function fireWith(
	player: PrivatePlayerState,
	trigger: Parameters<typeof applyTrigger>[2],
	rules?: PlayRules,
	command?: unknown
) {
	const state = makeState(player);
	const log: string[] = [];
	applyTrigger(state, 'Red', trigger, log, { catalog: rulesCat(rules), command });
	return { player, log, state };
}

/** Resolve Red's first pending decision with `optionId` the way `resolveDecision` does. */
function resolveFirst(state: PublicGameState, optionId: string, rules?: PlayRules) {
	const player = state.players.Red!;
	const decision = player.pendingDecisions[0];
	const log: string[] = [];
	DECISION_RESOLVERS[decision.kind](
		buildEffectContext({
			state,
			seat: 'Red',
			player,
			trigger: 'awakeningPhase',
			log,
			traitCount: 0,
			catalog: rulesCat(rules)
		}),
		optionId
	);
	player.pendingDecisions = player.pendingDecisions.filter((d) => d.id !== decision.id);
	return log;
}

describe('parseRules: the four new switches', () => {
	it('defaults are the old rules and are not written', () => {
		expect(
			parseRules({
				sunRework: false,
				bastionVsMonsters: false,
				pvpEngageVp: false,
				pvpAttackerSacrificeCap: false
			}).rules
		).toBeUndefined();
		const on = { sunRework: true, bastionVsMonsters: true, pvpEngageVp: true, pvpAttackerSacrificeCap: true };
		expect(parseRules(on).rules).toEqual(on);
	});
});

// ── sunRework ────────────────────────────────────────────────────────────────

describe('sunRework: Mage', () => {
	const mage = () =>
		makePlayer({
			spirits: [spirit(1, { Mage: 1 }), spirit(2, { Fighter: 1 })],
			mats: [{ slotIndex: 1, hasRune: true, id: 'r1', name: 'Mountain Rune', type: 'rune' }]
		});

	it('off: the Awakening Phase card trades a rune for 1 Enchanted die; no dice on awakening', () => {
		const { player, state } = fireWith(mage(), 'awakeningPhase');
		const card = player.pendingDecisions[0];
		expect(card.kind).toBe('runeMageTrade');
		expect(card.prompt).toBe('Awakening: you may discard a rune to gain an Enchanted Attack.');
		expect(card.options[0].label).toBe('Discard rune → 1 Enchanted Attack');
		resolveFirst(state, 'rune');
		expect(player.attackDice.map((d) => d.tier)).toEqual(['enchanted']);
		expect(player.mats[0].hasRune).toBe(false);
		const woke = fireWith(mage(), 'awakening', undefined, { slotIndex: 1 }).player;
		expect(woke.attackDice).toHaveLength(0);
	});

	it('on: the card gives 1 Exalted die ("may": No keeps the rune)', () => {
		const { player, state } = fireWith(mage(), 'awakeningPhase', SUN);
		const card = player.pendingDecisions[0];
		expect(card.prompt).toBe('Awakening: you may discard a rune to gain an Exalted Attack.');
		expect(card.options.map((o) => o.id)).toEqual(['rune', 'no']);
		resolveFirst(state, 'rune', SUN);
		expect(player.attackDice.map((d) => d.tier)).toEqual(['exalted']);
		const declined = fireWith(mage(), 'awakeningPhase', SUN);
		resolveFirst(declined.state, 'no', SUN);
		expect(declined.player.attackDice).toHaveLength(0);
		expect(declined.player.mats[0].hasRune).toBe(true);
	});

	it("on: 2 Exalted dice on this spirit's own awakening only", () => {
		const own = fireWith(mage(), 'awakening', SUN, { slotIndex: 1 }).player;
		expect(own.attackDice.map((d) => d.tier)).toEqual(['exalted', 'exalted']);
		const other = fireWith(mage(), 'awakening', SUN, { slotIndex: 2 }).player;
		expect(other.attackDice).toHaveLength(0);
	});
});

describe('sunRework: Chorus', () => {
	const chorus = () => makePlayer({ barrier: 1, maxBarrier: 6, brokenBarrier: 5, spirits: [spirit(1, { Chorus: 1 })] });
	it('off: restore 3 and gain 1 Max Barrier', () => {
		const p = fireWith(chorus(), 'awakening', undefined, { slotIndex: 1 }).player;
		expect([p.barrier, p.maxBarrier]).toEqual([5, 7]);
	});
	it('on: restore all and gain 2 Max Barrier', () => {
		const p = fireWith(chorus(), 'awakening', SUN, { slotIndex: 1 }).player;
		expect([p.barrier, p.maxBarrier, p.brokenBarrier]).toEqual([8, 8, 0]);
	});
});

describe('sunRework: Shieldbearer', () => {
	const hit = (barrier: number, rules?: PlayRules) => {
		const player = makePlayer({ barrier, maxBarrier: 10, spirits: [spirit(1, { Shieldbearer: 1 })] });
		const state = makeState(player);
		takeDamage(player, 5, { state, seat: 'Red', catalog: rulesCat(rules) }, []);
		return player.barrier;
	};
	it('off: 3 less only at full Barrier', () => {
		expect(hit(10)).toBe(8);
		expect(hit(8)).toBe(3);
	});
	it('on: 2 less, 4 less at full Barrier', () => {
		expect(hit(10, SUN)).toBe(9);
		expect(hit(8, SUN)).toBe(5);
	});
});

describe('sunRework: Nomad', () => {
	const nomad = () => makePlayer({ spirits: [spirit(1, { Nomad: 1 })] });
	it('off: no rune in the Awakening Phase; the extra location use is unchanged', () => {
		expect(fireWith(nomad(), 'awakeningPhase').player.mats).toHaveLength(0);
		expect(fireWith(nomad(), 'onNavigate').player.extraActions.locationInteraction).toBe(1);
	});
	it('on: 1 Any Rune in the Awakening Phase; the extra location use is unchanged', () => {
		const p = fireWith(nomad(), 'awakeningPhase', SUN).player;
		expect(p.mats).toEqual([
			{ slotIndex: 1, hasRune: true, id: WILDCARD_MAT_IDS.anyRune, name: 'Any Rune', type: 'rune' }
		]);
		expect(fireWith(nomad(), 'onNavigate', SUN).player.extraActions.locationInteraction).toBe(1);
	});
});

describe('sunRework: Gardener', () => {
	const gardener = (statusLevel = 0) =>
		makePlayer({ barrier: 2, maxBarrier: 6, brokenBarrier: 4, statusLevel, spirits: [spirit(1, { Gardener: 1 })] });
	it('off: restore 2', () => {
		const p = fireWith(gardener(), 'awakeningPhase').player;
		expect([p.barrier, p.maxBarrier]).toEqual([4, 6]);
	});
	it('on: restore 3 and gain 1 Max Barrier; nothing while Evil', () => {
		const p = fireWith(gardener(), 'awakeningPhase', SUN).player;
		expect([p.barrier, p.maxBarrier]).toEqual([6, 7]);
		const evil = fireWith(gardener(3), 'awakeningPhase', SUN).player;
		expect([evil.barrier, evil.maxBarrier]).toEqual([2, 6]);
	});
});

describe('sunRework: Cleric', () => {
	const cleric = () => makePlayer({ spirits: [spirit(1, { Cleric: 1 }), spirit(2, { Fighter: 1 })] });
	it('off: no relic on awakening', () => {
		expect(fireWith(cleric(), 'awakening', undefined, { slotIndex: 1 }).player.pendingDecisions).toHaveLength(0);
	});
	it("on: a relic choice card (Cultivator's options) on this spirit's own awakening only", () => {
		const { player, state } = fireWith(cleric(), 'awakening', SUN, { slotIndex: 1 });
		const card = player.pendingDecisions[0];
		expect(card.kind).toBe('clericRelic');
		expect(card.options.map((o) => o.label)).toEqual([
			'Fairy Relic',
			'Cleansing Teapot Relic',
			'Firecracker Relic',
			'Flower Relic',
			'Diamond Relic'
		]);
		const log = resolveFirst(state, '2', SUN);
		expect(log).toContain('Cleric: gained Firecracker Relic.');
		expect(player.relics).toBe(1);
		expect(player.mats[0]).toMatchObject({ name: 'Firecracker Relic', type: 'relic', relicTool: true });
		expect(fireWith(cleric(), 'awakening', SUN, { slotIndex: 2 }).player.pendingDecisions).toHaveLength(0);
	});
	it('the damage reduction per unique relic is unchanged', () => {
		for (const rules of [undefined, SUN]) {
			const player = makePlayer({
				barrier: 10,
				maxBarrier: 10,
				spirits: [spirit(1, { Cleric: 1 })],
				mats: [{ slotIndex: 1, hasRune: true, name: 'Flower Relic', type: 'relic' }]
			});
			takeDamage(player, 5, { state: makeState(player), seat: 'Red', catalog: rulesCat(rules) }, []);
			expect(player.barrier).toBe(7);
		}
	});
});

// ── bastionVsMonsters ────────────────────────────────────────────────────────

describe('bastionVsMonsters', () => {
	const monster = (initiative?: number): MonsterState =>
		({
			id: 'm', name: 'Test Monster', hp: 50, maxHp: 50, damage: 10, rewardTrack: [], chooseAmount: 0,
			livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1,
			...(initiative === undefined ? {} : { initiative })
		}) as MonsterState;
	// Fairy (awake) gives initiative 3, higher than the monster's 2.
	const fight = (m: MonsterState, rules?: PlayRules) => {
		const player = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			spirits: [spirit(1, { Fairy: 1 }), spirit(2, { Bastion: 1 })],
			monsterHand: [m]
		});
		return fightMonster(makeState(player), 'Red', rulesCat(rules), 0)!;
	};
	it('off: a monster with lower initiative is not halved; an infinite one is', () => {
		expect(fight(monster(2)).barrierLost).toBe(10);
		expect(fight(monster()).barrierLost).toBe(5);
	});
	it('on: every monster hit is halved', () => {
		expect(fight(monster(2), { bastionVsMonsters: true }).barrierLost).toBe(5);
		expect(fight(monster(), { bastionVsMonsters: true }).barrierLost).toBe(5);
	});
	it('on: PvP is unchanged (lower opposing initiative is not halved)', () => {
		const player = makePlayer({ barrier: 10, maxBarrier: 10, initiative: 2, spirits: [spirit(1, { Bastion: 1 })] });
		const state = makeState(player, { Blue: makePlayer({ playerColor: 'Blue' }) });
		const r = takeDamage(
			player,
			6,
			{ state, seat: 'Red', catalog: rulesCat({ bastionVsMonsters: true }), opponent: 'Blue', opponentInitiative: 1 },
			[]
		);
		expect(r.barrierLost).toBe(6);
	});
});

// ── PvP harness (as in rules.test.ts) ─────────────────────────────────────────

const HOST = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null } as const;
const ACTORS = {
	Red: { ...HOST, seatColor: 'Red' },
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
	let state = createLobbyState({ roomCode: 'SUNP', guardianNames: ['Myrtle', 'Nyra', 'Orro'] });
	state = ok(state, { ...HOST, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
	state = ok(state, { ...ACTORS.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
	state = ok(state, { ...ACTORS.Orange, seatColor: null }, { type: 'claimSeat', seatColor: 'Orange' });
	state = ok(state, ACTORS.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
	state = ok(state, ACTORS.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
	state = ok(state, ACTORS.Orange, { type: 'selectGuardian', guardianName: 'Orro' });
	state = ok(state, ACTORS.Red, { type: 'startGame', seed: 99 });
	for (const seat of ['Red', 'Blue', 'Orange'] as const)
		state = ok(state, ACTORS[seat], { type: 'lockNavigation', destination: 'Mountain Region' });
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
	state = ok(state, ACTORS.Red, { type: 'forceAdvancePhase' });
	return ok(state, ACTORS.Red, { type: 'initiatePvp' });
}
const vps = (s: PublicGameState) => (['Red', 'Blue', 'Orange'] as const).map((k) => s.players[k]!.victoryPoints);
const oneCorrupted = (s: PublicGameState) => {
	s.players.Red!.attackDice = arcaneDice(3); // 3-9 damage: corrupts Blue (2), never Orange (14)
	s.players.Blue!.maxBarrier = 2;
	s.players.Blue!.barrier = 2;
};

// ── pvpEngageVp ──────────────────────────────────────────────────────────────

describe('pvpEngageVp', () => {
	it('formula: only under pvpPaysOnCorrupt, 2 for the attack + 3 per corrupted', () => {
		expect([0, 1, 2].map((c) => pvpVpForAttack(c, true, true))).toEqual([2, 5, 8]);
		expect([0, 1, 2].map((c) => pvpVpForAttack(c, true))).toEqual([0, 3, 6]);
		expect([0, 1, 2].map((c) => pvpVpForAttack(c, false, true))).toEqual([2, 4, 6]);
	});
	it('in a game: nobody corrupted 0 → 2 VP; one corrupted 3 → 5 VP; alone it changes nothing', () => {
		const pays = { pvpPaysOnCorrupt: true };
		const both = { pvpPaysOnCorrupt: true, pvpEngageVp: true };
		expect(vps(pvpExchange(pvpCatalog(pays), () => {}))).toEqual([0, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog(both), () => {}))).toEqual([2, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog(pays), oneCorrupted))).toEqual([3, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog(both), oneCorrupted))).toEqual([5, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog({ pvpEngageVp: true }), oneCorrupted))).toEqual([4, 0, 0]);
	});
	it('pvpCorruptPays4: 4 per corrupted under pvpPaysOnCorrupt, nothing alone; brief says 4', () => {
		const four = { pvpPaysOnCorrupt: true, pvpCorruptPays4: true };
		expect(vps(pvpExchange(pvpCatalog(four), () => {}))).toEqual([0, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog(four), oneCorrupted))).toEqual([4, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog({ ...four, pvpEngageVp: true }), oneCorrupted))).toEqual([6, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog({ pvpCorruptPays4: true }), oneCorrupted))).toEqual([4, 0, 0]);
		expect(buildRulesBrief(rulesCat({ pvpCorruptPays4: true }))).toBe(buildRulesBrief(frozen));
		expect(buildRulesBrief(rulesCat({ pvpPaysOnCorrupt: true, pvpGoodBounty: false, pvpCorruptPays4: true }))).toContain(
			'An Evil attacker gets 4 VP per opponent corrupted in the attack and nothing for the attack itself.'
		);
	});
	it('brief and initiatePvp label change only when on (and only under pvpPaysOnCorrupt)', () => {
		const pays = rulesCat({ pvpPaysOnCorrupt: true, pvpGoodBounty: false });
		const both = rulesCat({ pvpPaysOnCorrupt: true, pvpGoodBounty: false, pvpEngageVp: true });
		expect(buildRulesBrief(rulesCat({ pvpEngageVp: true }))).toBe(buildRulesBrief(frozen));
		expect(buildRulesBrief(pays)).toContain(
			'An Evil attacker gets 3 VP per opponent corrupted in the attack and nothing for the attack itself.'
		);
		expect(buildRulesBrief(both)).toContain('An Evil attacker gets 2 VP for the attack plus 3 VP per opponent corrupted in it.');
		expect(buildRulesBrief(both)).not.toContain('nothing for the attack itself');
		const me = makePlayer({ statusLevel: 3, statusToken: 'Fallen' });
		const view = makeState(me) as unknown as Parameters<typeof labelFor>[1];
		expect(labelFor({ type: 'initiatePvp' }, view, 'Red', pays)).toBe(
			'Attack the Good players at your location (PvP group attack: you get 3 VP per Good player corrupted, nothing otherwise)'
		);
		expect(labelFor({ type: 'initiatePvp' }, view, 'Red', both)).toBe(
			'Attack the Good players at your location (PvP group attack: you get 2 VP for the attack plus 3 VP per Good player corrupted)'
		);
		expect(labelFor({ type: 'initiatePvp' }, view, 'Red', rulesCat({ pvpEngageVp: true }))).toBe(
			'Attack the Good players at your location (PvP group attack)'
		);
	});
});

// ── pvpAttackerSacrificeCap ──────────────────────────────────────────────────

describe('pvpAttackerSacrificeCap', () => {
	/** Red (Fallen, 3 corruptions so far) is corrupted by the Good side's counter-strike. */
	const attackerCorrupted =
		(redSpirits: number) =>
		(s: PublicGameState) => {
			const red = s.players.Red!;
			red.maxBarrier = 1;
			red.barrier = 1;
			red.corruptionCount = 3;
			red.victoryPoints = 5;
			red.spirits = Array.from({ length: redSpirits }, (_, i) => spirit(i + 1, {}));
			s.players.Blue!.attackDice = arcaneDice(1); // ≥1 damage, simultaneous (initiative tie)
			s.players.Orange!.attackDice = arcaneDice(1);
		};
	it('off: the 4th corruption owes 4; on: at most 1 (count still rises, Barrier restored)', () => {
		const off = pvpExchange(pvpCatalog(), attackerCorrupted(6)).players.Red!;
		expect(off.corruptionCount).toBe(4);
		expect(off.pendingCorruptionDiscard?.count).toBe(4);
		const onState = pvpExchange(pvpCatalog({ pvpAttackerSacrificeCap: true }), attackerCorrupted(6));
		const on = onState.players.Red!;
		expect(on.corruptionCount).toBe(4);
		expect(on.pendingCorruptionDiscard?.count).toBe(1);
		expect(on.barrier).toBe(on.maxBarrier);
		expect(onState.combats.find((c) => c.kind === 'pvp')!.log.join('\n')).toContain(
			'Evil attacker: this corruption costs at most 1 sacrifice.'
		);
	});
	it('while Fallen with no spirits: off 4 VP lost, on 1 VP lost', () => {
		expect(vps(pvpExchange(pvpCatalog(), attackerCorrupted(0)))).toEqual([5 - 4 + 2, 0, 0]);
		expect(vps(pvpExchange(pvpCatalog({ pvpAttackerSacrificeCap: true }), attackerCorrupted(0)))).toEqual([
			5 - 1 + 2,
			0,
			0
		]);
	});
	it('a Good player corrupted in the same kind of exchange is not capped', () => {
		const goodCorrupted = (s: PublicGameState) => {
			oneCorrupted(s);
			s.players.Blue!.corruptionCount = 2;
			s.players.Blue!.spirits = Array.from({ length: 5 }, (_, i) => spirit(i + 1, {}));
		};
		for (const rules of [undefined, { pvpAttackerSacrificeCap: true }]) {
			const blue = pvpExchange(pvpCatalog(rules), goodCorrupted).players.Blue!;
			expect(blue.corruptionCount).toBe(3);
			expect(blue.pendingCorruptionDiscard?.count).toBe(3);
		}
	});
	it('the brief sentence appears only when on', () => {
		const sentence = 'An Evil attacker corrupted in a player attack it started owes at most 1 sacrifice for that corruption.';
		expect(buildRulesBrief(frozen)).not.toContain(sentence);
		expect(buildRulesBrief(rulesCat({ pvpAttackerSacrificeCap: true }))).toContain(sentence);
	});
});

// ── class text shown to agents ───────────────────────────────────────────────

describe('class text for agents (sunRework, bastionVsMonsters)', () => {
	const OLD: Record<string, string> = {
		Mage: 'In the Awakening Phase, you may discard a rune to gain an Enchanted Attack.',
		Chorus: 'When you awaken a spirit, restore 3 Barrier and gain 1 Max Barrier.',
		Shieldbearer: 'When you take damage, if your Barrier is full, take 3 less.',
		Nomad: 'You may do ALL location interactions up to two times.',
		Gardener: 'In the Awakening Phase, if you are not Evil, restore 2 Barrier.',
		Cleric: 'For every unique Relic you hold, reduce incoming damage by 2.',
		King: 'In the Awakening Phase, Gain 1 VP. If you are evil, you must discard this spirit.',
		Bastion: 'If the opponent has higher initiative, when you Take Damage, half it (rounding up).'
	};
	const NEW: Record<string, string> = {
		Mage: "On this spirit's Awakening, gain 2 Exalted Attack Dice. In the Awakening Phase, you may discard a rune to gain 1 Exalted Attack Dice.",
		Chorus: 'When you awaken a spirit (this one included), restore all your Barrier and gain 2 Max Barrier.',
		Shieldbearer: 'When you take damage, take 2 less. If your Barrier is full, take 4 less instead.',
		Nomad: 'You may do ALL location interactions up to two times. In the Awakening Phase, gain 1 Any basic Rune.',
		Gardener: 'In the Awakening Phase, if you are not Evil, restore 3 Barrier and gain 1 Max Barrier.',
		Cleric: "On this spirit's Awakening, gain 1 relic of your choice. For every unique Relic you hold, reduce incoming damage by 2.",
		Bastion: 'If the opponent has higher initiative, or is a monster, when you Take Damage, half it (rounding up).'
	};
	/** The frozen catalog plus the Sun classes and Bastion with their printed (old) text, each on a spirit. */
	const withClasses = (rules?: PlayRules): PlayCatalog => ({
		...frozen,
		rules,
		classes: [
			...frozen.classes.filter((k) => !(k.name in OLD)),
			...Object.entries(OLD).map(([name, description]) => ({
				id: `c-${name}`,
				name,
				classType: 'special',
				isSpecial: true,
				effectSchema: [{ count: 1, effects: [{ type: 'benefit', description }] }]
			}))
		],
		spirits: [
			...frozen.spirits,
			...Object.keys(OLD).map((name) => ({ id: `sp-${name}`, name: `Test ${name}`, cost: 7, classes: { [name]: 1 }, origins: {} }))
		]
	});

	it('off: the brief is byte-identical (absent or all four at default) and shows the old texts', () => {
		const base = buildRulesBrief(withClasses());
		expect(
			buildRulesBrief(
				withClasses({ sunRework: false, bastionVsMonsters: false, pvpEngageVp: false, pvpAttackerSacrificeCap: false })
			)
		).toBe(base);
		for (const [name, text] of Object.entries(OLD)) expect(base).toContain(`- ${name}: (1) ${text}`);
		for (const text of Object.values(NEW)) expect(base).not.toContain(text);
		for (const name of Object.keys(OLD)) {
			const schema = [{ count: 1, effects: [{ type: 'benefit', description: 'old' }] }];
			expect(ruleAdjustedClassSchema(frozen, name, schema)).toBe(schema);
		}
	});

	it('sunRework on: the six Sun classes show the new text; King and Bastion unchanged', () => {
		const brief = buildRulesBrief(withClasses(SUN));
		for (const name of ['Mage', 'Chorus', 'Shieldbearer', 'Nomad', 'Gardener', 'Cleric'])
			expect(brief).toContain(`- ${name}: (1) ${NEW[name]}`);
		expect(brief).toContain(`- King: (1) ${OLD.King}`);
		expect(brief).toContain(`- Bastion: (1) ${OLD.Bastion}`);
	});

	it('bastionVsMonsters on: only Bastion changes', () => {
		const brief = buildRulesBrief(withClasses({ bastionVsMonsters: true }));
		expect(brief).toContain(`- Bastion: (1) ${NEW.Bastion}`);
		expect(brief).toContain(`- Mage: (1) ${OLD.Mage}`);
	});
});

// ── mysticMonstersOnly (Michael, 2026-11-21) ─────────────────────────────────

describe('mysticMonstersOnly: Mystic strikes at the same time against monsters only', () => {
	/** Red (Fallen, Mystic 2, Barrier 1) attacks; Blue is faster (2 Beasts) and corrupts Red first. */
	const slowMystic = (s: PublicGameState) => {
		const red = s.players.Red!;
		red.maxBarrier = 1;
		red.barrier = 1;
		red.attackDice = arcaneDice(3);
		red.spirits = [spirit(1, { Mystic: 2 })];
		s.players.Blue!.attackDice = arcaneDice(1);
		s.players.Blue!.spirits = [spirit(2, { Beast: 2 })];
	};
	const pvpLog = (rules: PlayRules) =>
		pvpExchange(pvpCatalog(rules), slowMystic).combats.find((c) => c.kind === 'pvp')!.log.join('\n');
	it('off: a corrupted Mystic (2) attacker still strikes the players', () => {
		expect(pvpLog({ mysticSwap23: true })).toContain('Red attacks at the same time despite corruption.');
	});
	it('on: against players it is stunned like anyone else', () => {
		const log = pvpLog({ mysticSwap23: true, mysticMonstersOnly: true });
		expect(log).toContain('Red is stunned and cannot strike back.');
		expect(log).not.toContain('Red attacks at the same time');
	});
	it('on: against a monster it still strikes back when corrupted', () => {
		const catalog = { ...frozen, rules: { mysticSwap23: true, mysticMonstersOnly: true } };
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 1,
			attackDice: arcaneDice(5),
			spirits: [spirit(1, { Mystic: 2 })],
			monsterHand: [{ id: 'm', name: 'Test Monster', hp: 10, maxHp: 10, damage: 5, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 } as never]
		});
		const result = fightMonster(makeState(p), 'Red', catalog, 0)!;
		expect(result.corrupted).toBe(true);
		expect(result.playerDamage).toBeGreaterThan(0);
	});
	it('printed text follows the switch', () => {
		const schema = [1, 2].map((count) => ({ count, effects: [{ type: 'benefit', description: `old ${count}` }] })) as never;
		const out = ruleAdjustedClassSchema({ ...frozen, rules: { mysticSwap23: true, mysticMonstersOnly: true } }, 'Mystic', schema)!;
		expect(out[1].effects?.[0].description).toContain('In combat with a monster');
	});
});
