/**
 * The Sun class rework (Mage, Chorus, Shieldbearer, Nomad, Gardener, Cleric), Bastion against
 * monsters, the Victory Points of a player attack, the sacrifices of a corrupted Evil attacker, and
 * Mystic's attack at the same time against monsters only. (They were rule switches until 2026-11-27;
 * see docs/rules-history-2026-11.md.)
 *
 *   npx vitest run src/lib/play/sunRework.test.ts
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
import type { MonsterState, PlayCatalog, PrivatePlayerState, PublicGameState } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();

/** Fire `trigger` for Red; returns the player and the log. */
function fire(player: PrivatePlayerState, trigger: Parameters<typeof applyTrigger>[2], command?: unknown) {
	const state = makeState(player);
	const log: string[] = [];
	applyTrigger(state, 'Red', trigger, log, { catalog: frozen, command });
	return { player, log, state };
}

/** Resolve Red's first pending decision with `optionId` the way `resolveDecision` does. */
function resolveFirst(state: PublicGameState, optionId: string) {
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
			catalog: frozen
		}),
		optionId
	);
	player.pendingDecisions = player.pendingDecisions.filter((d) => d.id !== decision.id);
	return log;
}

/** The printed text of `className` (1), from the game data. */
const classText = (className: string, count = 1): string => {
	const classes = JSON.parse(readFileSync('data/classes.json', 'utf8')) as {
		name: string;
		effect_schema: { count: number; effects: { description: string }[] }[];
	}[];
	const row = classes.find((c) => c.name === className)?.effect_schema.find((r) => r.count === count);
	return row?.effects.map((e) => e.description).join(' ') ?? '';
};

// ── the Sun classes ──────────────────────────────────────────────────────────

describe('Mage', () => {
	const mage = () =>
		makePlayer({
			spirits: [spirit(1, { Mage: 1 }), spirit(2, { Fighter: 1 })],
			mats: [{ slotIndex: 1, hasRune: true, id: 'r1', name: 'Mountain Rune', type: 'rune' }]
		});

	it("3 Arcane dice on this spirit's own awakening only, and no Awakening Phase card", () => {
		const own = fire(mage(), 'awakening', { slotIndex: 1 }).player;
		expect(own.attackDice.map((d) => d.tier)).toEqual(['arcane', 'arcane', 'arcane']);
		const other = fire(mage(), 'awakening', { slotIndex: 2 }).player;
		expect(other.attackDice).toHaveLength(0);
		const phase = fire(mage(), 'awakeningPhase').player;
		expect(phase.pendingDecisions).toHaveLength(0);
		expect(phase.mats[0].hasRune).toBe(true);
	});
});

describe('Chorus', () => {
	const chorus = () => makePlayer({ barrier: 1, maxBarrier: 6, brokenBarrier: 5, spirits: [spirit(1, { Chorus: 1 })] });
	it('restore all and gain 2 Max Barrier', () => {
		const p = fire(chorus(), 'awakening', { slotIndex: 1 }).player;
		expect([p.barrier, p.maxBarrier, p.brokenBarrier]).toEqual([8, 8, 0]);
	});
});

describe('Shieldbearer', () => {
	const hit = (barrier: number) => {
		const player = makePlayer({ barrier, maxBarrier: 10, spirits: [spirit(1, { Shieldbearer: 1 })] });
		const state = makeState(player);
		takeDamage(player, 5, { state, seat: 'Red', catalog: frozen }, []);
		return player.barrier;
	};
	it('5 less at full Barrier, nothing below', () => {
		expect(hit(10)).toBe(10);
		expect(hit(8)).toBe(3);
	});
});

describe('Nomad', () => {
	const nomad = () => makePlayer({ spirits: [spirit(1, { Nomad: 1 })] });
	it('1 Any Rune in the Awakening Phase; the extra location use is unchanged', () => {
		const p = fire(nomad(), 'awakeningPhase').player;
		expect(p.mats).toEqual([
			{ slotIndex: 1, hasRune: true, id: WILDCARD_MAT_IDS.anyRune, name: 'Any Rune', type: 'rune' }
		]);
		expect(fire(nomad(), 'onNavigate').player.extraActions.locationInteraction).toBe(1);
	});
});

describe('Gardener', () => {
	const gardener = (statusLevel = 0) =>
		makePlayer({ barrier: 2, maxBarrier: 6, brokenBarrier: 4, statusLevel, spirits: [spirit(1, { Gardener: 1 })] });
	it('restore 3 and gain 1 Max Barrier; nothing while Evil', () => {
		const p = fire(gardener(), 'awakeningPhase').player;
		expect([p.barrier, p.maxBarrier]).toEqual([6, 7]);
		const evil = fire(gardener(3), 'awakeningPhase').player;
		expect([evil.barrier, evil.maxBarrier]).toEqual([2, 6]);
	});
});

describe('Cleric', () => {
	const cleric = () => makePlayer({ spirits: [spirit(1, { Cleric: 1 }), spirit(2, { Fighter: 1 })] });
	it("a relic choice card (Cultivator's options) on this spirit's own awakening only", () => {
		const { player, state } = fire(cleric(), 'awakening', { slotIndex: 1 });
		const card = player.pendingDecisions[0];
		expect(card.kind).toBe('clericRelic');
		expect(card.options.map((o) => o.label)).toEqual([
			'Fairy Relic',
			'Cleansing Teapot Relic',
			'Firecracker Relic',
			'Flower Relic',
			'Diamond Relic'
		]);
		const log = resolveFirst(state, '2');
		expect(log).toContain('Cleric: gained Firecracker Relic.');
		expect(player.relics).toBe(1);
		expect(player.mats[0]).toMatchObject({ name: 'Firecracker Relic', type: 'relic', relicTool: true });
		expect(fire(cleric(), 'awakening', { slotIndex: 2 }).player.pendingDecisions).toHaveLength(0);
	});
	it('2 less damage per unique relic', () => {
		const player = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			spirits: [spirit(1, { Cleric: 1 })],
			mats: [{ slotIndex: 1, hasRune: true, name: 'Flower Relic', type: 'relic' }]
		});
		takeDamage(player, 5, { state: makeState(player), seat: 'Red', catalog: frozen }, []);
		expect(player.barrier).toBe(7);
	});
});

// ── Bastion ──────────────────────────────────────────────────────────────────

describe('Bastion against monsters', () => {
	const monster = (initiative?: number): MonsterState =>
		({
			id: 'm', name: 'Test Monster', hp: 50, maxHp: 50, damage: 10, rewardTrack: [], chooseAmount: 0,
			livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1,
			...(initiative === undefined ? {} : { initiative })
		}) as MonsterState;
	const fight = (m: MonsterState) => {
		const player = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			spirits: [spirit(1, { Fairy: 1 }), spirit(2, { Bastion: 1 })],
			monsterHand: [m]
		});
		return fightMonster(makeState(player), 'Red', frozen, 0)!;
	};
	it('every monster hit is halved', () => {
		expect(fight(monster(2)).barrierLost).toBe(5);
		expect(fight(monster()).barrierLost).toBe(5);
	});
	it('PvP: lower opposing initiative is not halved', () => {
		const player = makePlayer({ barrier: 10, maxBarrier: 10, initiative: 2, spirits: [spirit(1, { Bastion: 1 })] });
		const state = makeState(player, { Blue: makePlayer({ playerColor: 'Blue' }) });
		const r = takeDamage(player, 6, { state, seat: 'Red', catalog: frozen, opponent: 'Blue', opponentInitiative: 1 }, []);
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
const arcaneDice = (n: number) => Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));

/** Red (Fallen) attacks Blue and Orange (Good) in Mountain Region; `setup` shapes the sides. */
function pvpExchange(setup: (s: PublicGameState) => void, catalog: PlayCatalog = PVP_CATALOG): PublicGameState {
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

// ── the Victory Points of a player attack ────────────────────────────────────

describe('PvP Victory Points: 3 per opponent corrupted, nothing for the attack itself', () => {
	it('formula', () => {
		expect([0, 1, 2].map((c) => pvpVpForAttack(c))).toEqual([0, 3, 6]);
	});
	it('in a game: nobody corrupted 0 VP; one corrupted 3 VP', () => {
		expect(vps(pvpExchange(() => {}))).toEqual([0, 0, 0]);
		expect(vps(pvpExchange(oneCorrupted))).toEqual([3, 0, 0]);
	});
	it('the rules text and the initiatePvp label say so', () => {
		expect(buildRulesBrief(frozen)).toContain(
			'An Evil attacker gets 3 VP per opponent corrupted in the attack and nothing for the attack itself.'
		);
		const me = makePlayer({ statusLevel: 3, statusToken: 'Fallen' });
		const view = makeState(me) as unknown as Parameters<typeof labelFor>[1];
		expect(labelFor({ type: 'initiatePvp' }, view, 'Red', frozen)).toBe(
			'Attack the Good players at your location (PvP group attack: you get 3 VP per Good player corrupted, nothing otherwise)'
		);
	});
});

// ── the sacrifices of a corrupted Evil attacker ──────────────────────────────

describe('a corrupted Evil attacker pays the full sacrifice', () => {
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
	it('the 4th corruption owes 4', () => {
		const red = pvpExchange(attackerCorrupted(6)).players.Red!;
		expect(red.corruptionCount).toBe(4);
		expect(red.pendingCorruptionDiscard?.count).toBe(4);
	});
	it('while Fallen with no spirits: 4 VP lost', () => {
		expect(vps(pvpExchange(attackerCorrupted(0)))).toEqual([5 - 4, 0, 0]);
	});
	it('a Good player corrupted in the same kind of exchange pays the same way', () => {
		const goodCorrupted = (s: PublicGameState) => {
			oneCorrupted(s);
			s.players.Blue!.corruptionCount = 2;
			s.players.Blue!.spirits = Array.from({ length: 5 }, (_, i) => spirit(i + 1, {}));
		};
		const blue = pvpExchange(goodCorrupted).players.Blue!;
		expect(blue.corruptionCount).toBe(3);
		expect(blue.pendingCorruptionDiscard?.count).toBe(3);
	});
});

// ── class texts ──────────────────────────────────────────────────────────────

describe('class texts in the game data (data/classes.json)', () => {
	const FINAL: Record<string, string> = {
		Mage: "On this spirit's Awakening, gain 3 Arcane Attack Dice.",
		Chorus: 'When you awaken a spirit (this one included), restore all your Barrier and gain 2 Max Barrier.',
		Shieldbearer: 'When you take damage, if your Barrier is full, take 5 less.',
		Nomad: 'You may do ALL location interactions up to two times. In the Awakening Phase, gain 1 Any basic Rune.',
		Gardener: 'In the Awakening Phase, if you are not Evil, restore 3 Barrier and gain 1 Max Barrier.',
		Cleric: "On this spirit's Awakening, gain 1 relic of your choice. For every unique Relic you hold, reduce incoming damage by 2.",
		Bastion: "If the opponent's side has more initiative than your side, or is a monster, when you Take Damage, half it (rounding up)."
	};
	it('the Sun classes and Bastion hold their final texts', () => {
		for (const [name, text] of Object.entries(FINAL)) expect(classText(name)).toBe(text);
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
	const pvpLog = () => pvpExchange(slowMystic).combats.find((c) => c.kind === 'pvp')!.log.join('\n');
	it('against players it is stunned like anyone else', () => {
		const log = pvpLog();
		expect(log).toContain('Red is stunned and cannot strike back.');
		expect(log).not.toContain('Red attacks at the same time');
	});
	it('against a monster it still strikes back when corrupted', () => {
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 1,
			attackDice: arcaneDice(5),
			spirits: [spirit(1, { Mystic: 2 })],
			monsterHand: [{ id: 'm', name: 'Test Monster', hp: 10, maxHp: 10, damage: 5, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 } as never]
		});
		const result = fightMonster(makeState(p), 'Red', frozen, 0)!;
		expect(result.corrupted).toBe(true);
		expect(result.playerDamage).toBeGreaterThan(0);
	});
	it('the printed text in the game data', () => {
		expect(classText('Mystic', 2)).toContain('In combat with a monster');
	});
});
