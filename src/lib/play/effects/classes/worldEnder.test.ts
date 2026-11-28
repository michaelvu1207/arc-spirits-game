import { describe, it, expect } from 'vitest';
import { makePlayer, makeState, spirit } from './testHelpers';
import { QUEEN_UNAWAKEN_KIND } from './worldEnder';
import { applyTrigger } from '../apply';
import { buildEffectContext } from '../context';
import { DECISION_RESOLVERS } from '../decisions';

// Queen — "When this spirit awakens, every player must turn one of their awakened spirits
// face-down (their choice)." No VP (Michael, 2026-11-18).
describe('Queen: every player turns one awakened spirit face-down', () => {
	const setup = () => {
		const red = makePlayer({
			spirits: [spirit(1, { Queen: 1 }, { name: 'Vespera' }), spirit(2, {}, { name: 'Red Two' }), spirit(3, {}, { name: 'Red Three', faceDown: true })]
		});
		const blue = makePlayer({ playerColor: 'Blue', phaseReady: true, spirits: [spirit(1, {}, { name: 'Blue One' }), spirit(2, {}, { name: 'Blue Two' })] });
		const green = makePlayer({ playerColor: 'Green', spirits: [spirit(1, {}, { name: 'Sleeper', faceDown: true })] });
		const state = makeState(red, { Blue: blue, Green: green });
		return { red, blue, green, state };
	};
	const card = (p: { pendingDecisions: { kind: string }[] }) => p.pendingDecisions.find((d) => d.kind === QUEEN_UNAWAKEN_KIND) as
		| { id: string; options: { id: string; label: string }[]; expiryOptionId?: string }
		| undefined;

	it('her own awakening gives every player with an awakened spirit a card; the Queen is not on her owner\'s card', () => {
		const { red, blue, green, state } = setup();
		applyTrigger(state, 'Red', 'awakening', [], { command: { type: 'awakenSpirit', slotIndex: 1 } });
		expect(card(red)!.options.map((o) => o.id)).toEqual(['slot:2']);
		expect(card(blue)!.options.map((o) => o.id)).toEqual(['slot:1', 'slot:2']);
		expect(card(blue)!.expiryOptionId).toBe('slot:2');
		expect(blue.phaseReady).toBe(false);
		expect(card(green)).toBeUndefined(); // no awakened spirit
	});

	it('the answer turns that spirit face-down', () => {
		const { blue, state } = setup();
		applyTrigger(state, 'Red', 'awakening', [], { command: { type: 'awakenSpirit', slotIndex: 1 } });
		const ctx = buildEffectContext({ state, seat: 'Blue', player: blue, trigger: 'awakening', log: [], traitCount: 0 });
		DECISION_RESOLVERS[QUEEN_UNAWAKEN_KIND](ctx, 'slot:1');
		expect(blue.spirits.map((s) => s.isFaceDown)).toEqual([true, false]);
	});

	it('another spirit awakening while the Queen is awake makes no card, and the Queen gives no VP', () => {
		const { red, blue, state } = setup();
		applyTrigger(state, 'Red', 'awakening', [], { command: { type: 'awakenSpirit', slotIndex: 2 } });
		expect(card(red)).toBeUndefined();
		expect(card(blue)).toBeUndefined();
		applyTrigger(state, 'Red', 'awakeningPhase', []);
		expect(red.victoryPoints).toBe(0);
	});
});

// Summoner (Michael, 2026-11-18).
describe('Summoner: "When you Cultivate with at least 5 Forest spirits, gain 2 points."', () => {
	const board = (forest: number) => [
		spirit(1, { Summoner: 1 }, { name: 'Hollowbloom', origins: { 'Forest Region': 1 } }),
		...Array.from({ length: forest - 1 }, (_, i) => spirit(2 + i, {}, { origins: { 'Forest Region': 1 }, faceDown: i === 0 })),
		spirit(7, {}, { origins: { 'Water Region': 1 } })
	];
	const cultivate = (forest: number) => {
		const p = makePlayer({ spirits: board(forest) });
		applyTrigger(makeState(p), 'Red', 'onCultivate', []);
		return p.victoryPoints;
	};
	it('5 Forest spirits (face-down ones count): 2 points; 4: none', () => {
		expect(cultivate(5)).toBe(2);
		expect(cultivate(6)).toBe(2);
		expect(cultivate(4)).toBe(0);
	});
});

// Cultist (Michael, 2026-11-18).
describe('Cultist: no point when corrupted', () => {
	it('a corruption gives the Cultist no point', async () => {
		const { applyCorruptionEffects } = await import('../corruption');
		const p = makePlayer({ spirits: [spirit(1, { Cultist: 1 })] });
		const log: string[] = [];
		applyCorruptionEffects(p, log);
		expect(p.victoryPoints).toBe(0);
		expect(log).toContain('Cultist: corrupted — sacrifice 1 fewer spirit.');
	});
});

// Hero reworks and Healer (Michael, 2026-11-18).
describe('Captain, Arcane Alchemist and Healer reworks', () => {
	const kill = (killed: boolean) => {
		const p = makePlayer({ spirits: [spirit(1, { Captain: 1 })] });
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], { combat: { dealt: 5, overkill: 0, killed } });
		return (p.powerInventory ?? []).length;
	};
	it('Captain: a random Power after a kill, none after a fight that does not kill', () => {
		expect(kill(true)).toBe(1);
		expect(kill(false)).toBe(0);
	});
	it('Captain: no augment on Cultivate', () => {
		const hero = () => spirit(1, { Captain: 1 }, { origins: { 'Human Enclave': 1 } });
		const p = makePlayer({ spirits: [hero(), { ...hero(), slotIndex: 2, classes: {} }, { ...hero(), slotIndex: 3, classes: {} }] });
		applyTrigger(makeState(p), 'Red', 'onCultivate', []);
		expect(p.unplacedAugments ?? []).toHaveLength(0);
	});
	it('Arcane Alchemist: converts a placed Spirit Augment into 1 Arcane Attack Dice', () => {
		const p = makePlayer({
			spirits: [spirit(1, { 'Arcane Alchemist': 1 }), spirit(2, {}, { name: 'Carrier' })],
			spiritAugmentAttachments: [{ runeId: 'aug-fighter', spiritId: 's2', spiritSlotIndex: 2, className: 'Fighter', classId: 'c-fighter' }]
		});
		const state = makeState(p);
		applyTrigger(state, 'Red', 'onCultivate', []);
		const card = p.pendingDecisions.find((d) => d.kind === 'alchemistAugment')!;
		expect(card.options.map((o) => o.id)).toEqual(['aug:2:aug-fighter', 'no']);
		const ctx = buildEffectContext({ state, seat: 'Red', player: p, trigger: 'onCultivate', log: [], traitCount: 0 });
		DECISION_RESOLVERS.alchemistAugment(ctx, 'aug:2:aug-fighter');
		expect(p.spiritAugmentAttachments).toEqual([]);
		expect(p.attackDice.map((d) => d.tier)).toEqual(['arcane']);
	});
	it('Arcane Alchemist: no card without a placed augment, even with 4 attack dice', () => {
		const p = makePlayer({
			spirits: [spirit(1, { 'Arcane Alchemist': 1 })],
			attackDice: Array.from({ length: 4 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as const }))
		});
		applyTrigger(makeState(p), 'Red', 'onCultivate', []);
		expect(p.pendingDecisions).toEqual([]);
	});
	it('Healer: the Rest card gives no point', () => {
		const p = makePlayer({ spirits: [spirit(1, { Healer: 1 })], maxBarrier: 10, barrier: 5, brokenBarrier: 5 });
		const state = makeState(p);
		applyTrigger(state, 'Red', 'onRest', []);
		const ctx = buildEffectContext({ state, seat: 'Red', player: p, trigger: 'onRest', log: [], traitCount: 0 });
		DECISION_RESOLVERS.healerRestore(ctx, 'yes');
		expect([p.victoryPoints, p.barrier]).toEqual([0, 8]);
	});
});

describe('Captain discard clause', () => {
	it('a discarded Captain gives no Enchanted Attack', () => {
		const p = makePlayer({ spirits: [spirit(1, { Captain: 1 })] });
		applyTrigger(makeState(p), 'Red', 'onSpiritDiscard', [], { counts: { Captain: 1 } });
		expect(p.attackDice).toHaveLength(0);
	});
});

describe('Feral deals no extra damage', () => {
	it('against a monster: the initiative flag only, no extra damage', () => {
		const p = makePlayer({ spirits: [spirit(1, { Feral: 1 })] });
		applyTrigger(makeState(p), 'Red', 'inCombat', []);
		expect([p.combatDamageBonus, p.alwaysAttackFirst]).toEqual([0, true]);
	});
});

describe('Princess gives a rune, not a point', () => {
	const phase = (extra: object = {}) => {
		const p = makePlayer({ spirits: [spirit(1, { Princess: 1 })], ...extra });
		const before = p.mats.length;
		applyTrigger(makeState(p), 'Red', 'awakeningPhase', []);
		return [p.victoryPoints, p.mats.length - before];
	};
	it('1 Any Rune and no point; Evil: nothing', () => {
		expect(phase()).toEqual([0, 1]);
		expect(phase({ statusLevel: 3 })).toEqual([0, 0]);
	});
});
