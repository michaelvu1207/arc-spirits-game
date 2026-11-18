import { describe, it, expect } from 'vitest';
import { fire, makePlayer, makeState, spirit, ctxFor } from './testHelpers';
import { ability, QUEEN_UNAWAKEN_KIND } from './worldEnder';
import { applyTrigger } from '../apply';
import { buildEffectContext } from '../context';
import { DECISION_RESOLVERS } from '../decisions';

// Queen — DB intent: "In the Awakening Phase, gain 1 VP." Unconditional.
//
// CHANGED from an all-Evil win-con (+3 VP × players, surfaced as a Cleanup CLAIM)
// to a flat, unconditional +1 VP fired by a bespoke `run` handler on the
// `awakeningPhase` trigger. The handler mutates `player.victoryPoints` and emits a
// log line (the UX surface — no silent no-op).

describe('Queen (awakeningPhase +1 VP)', () => {
	it('grants exactly +1 VP in the Awakening Phase', () => {
		const { player } = fire({ 'Queen': 1 }, 'awakeningPhase', {
			player: { victoryPoints: 5 }
		});
		expect(player.victoryPoints).toBe(6);
	});

	it('grants +1 VP unconditionally — regardless of alignment (Good)', () => {
		const { player } = fire({ 'Queen': 1 }, 'awakeningPhase', {
			player: { victoryPoints: 0, statusLevel: 0 }
		});
		expect(player.victoryPoints).toBe(1);
	});

	it('grants +1 VP unconditionally — even when Evil', () => {
		const { player } = fire({ 'Queen': 1 }, 'awakeningPhase', {
			// A clearly-Evil status level; the grant must not depend on alignment.
			player: { victoryPoints: 3, statusLevel: 5 }
		});
		expect(player.victoryPoints).toBe(4);
	});

	it('surfaces the gain via the log (no silent no-op)', () => {
		const { log } = fire({ 'Queen': 1 }, 'awakeningPhase', {
			player: { victoryPoints: 0 }
		});
		expect(log.some((line) => line.includes('Queen') && line.includes('1 VP'))).toBe(true);
	});

	it('only fires on the awakeningPhase trigger, not on awakening', () => {
		const { player } = fire({ 'Queen': 1 }, 'awakening', {
			player: { victoryPoints: 5 }
		});
		// The old all-Evil claim is gone and nothing fires on the per-spirit `awakening`.
		expect(player.victoryPoints).toBe(5);
	});

	it('only grants +1 once per fire (no per-player ×N scaling)', () => {
		// Even with multiple Queen counts on one player, the flat handler grants
		// exactly +1 (it is alignment- and count-independent).
		const { player } = fire({ 'Queen': 3 }, 'awakeningPhase', {
			player: { victoryPoints: 0 }
		});
		expect(player.victoryPoints).toBe(1);
	});

	describe('handler unit (direct run)', () => {
		it('mutates victoryPoints and logs', () => {
			const player = makePlayer({ victoryPoints: 10 });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			const handler = ability.find((a) => a.on === 'awakeningPhase');
			expect(handler?.run).toBeDefined();
			handler!.run!(ctx);
			expect(player.victoryPoints).toBe(11);
			expect(ctx.log.length).toBeGreaterThan(0);
		});
	});
});

// Rule `queenUnawakens` (Michael, 2026-11-18).
describe('Queen with rule queenUnawakens: every player turns one awakened spirit face-down', () => {
	const RULES = { rules: { queenUnawakens: true } } as never;
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
		applyTrigger(state, 'Red', 'awakening', [], { catalog: RULES, command: { type: 'awakenSpirit', slotIndex: 1 } });
		expect(card(red)!.options.map((o) => o.id)).toEqual(['slot:2']);
		expect(card(blue)!.options.map((o) => o.id)).toEqual(['slot:1', 'slot:2']);
		expect(card(blue)!.expiryOptionId).toBe('slot:2');
		expect(blue.phaseReady).toBe(false);
		expect(card(green)).toBeUndefined(); // no awakened spirit
	});

	it('the answer turns that spirit face-down', () => {
		const { blue, state } = setup();
		applyTrigger(state, 'Red', 'awakening', [], { catalog: RULES, command: { type: 'awakenSpirit', slotIndex: 1 } });
		const ctx = buildEffectContext({ state, seat: 'Blue', player: blue, trigger: 'awakening', log: [], traitCount: 0, catalog: RULES });
		DECISION_RESOLVERS[QUEEN_UNAWAKEN_KIND](ctx, 'slot:1');
		expect(blue.spirits.map((s) => s.isFaceDown)).toEqual([true, false]);
	});

	it('another spirit awakening while the Queen is awake makes no card, and the Queen gives no VP', () => {
		const { red, blue, state } = setup();
		applyTrigger(state, 'Red', 'awakening', [], { catalog: RULES, command: { type: 'awakenSpirit', slotIndex: 2 } });
		expect(card(red)).toBeUndefined();
		expect(card(blue)).toBeUndefined();
		applyTrigger(state, 'Red', 'awakeningPhase', [], { catalog: RULES });
		expect(red.victoryPoints).toBe(0);
	});

	it('rule off: no card, and the Awakening Phase point as before', () => {
		const { red, blue, state } = setup();
		applyTrigger(state, 'Red', 'awakening', [], { command: { type: 'awakenSpirit', slotIndex: 1 } });
		expect(card(blue)).toBeUndefined();
		applyTrigger(state, 'Red', 'awakeningPhase', [], {});
		expect(red.victoryPoints).toBe(1);
	});
});

// Rule `summonerCultivate` (Michael, 2026-11-18).
describe('Summoner with rule summonerCultivate: "When you Cultivate with at least 5 Forest spirits, gain 2 points."', () => {
	const RULES = { rules: { summonerCultivate: true } } as never;
	const board = (forest: number) => [
		spirit(1, { Summoner: 1 }, { name: 'Hollowbloom', origins: { 'Forest Region': 1 } }),
		...Array.from({ length: forest - 1 }, (_, i) => spirit(2 + i, {}, { origins: { 'Forest Region': 1 }, faceDown: i === 0 })),
		spirit(7, {}, { origins: { 'Water Region': 1 } })
	];
	const cultivate = (forest: number, catalog?: never) => {
		const p = makePlayer({ spirits: board(forest) });
		applyTrigger(makeState(p), 'Red', 'onCultivate', [], { catalog });
		return p.victoryPoints;
	};
	it('5 Forest spirits (face-down ones count): 2 points; 4: none; rule off: none', () => {
		expect(cultivate(5, RULES)).toBe(2);
		expect(cultivate(6, RULES)).toBe(2);
		expect(cultivate(4, RULES)).toBe(0);
		expect(cultivate(6)).toBe(0);
	});
});

// Rule `cultistNoVp` (Michael, 2026-11-18).
describe('Cultist with rule cultistNoVp: no point when corrupted', () => {
	it('on: 0; off: 1', async () => {
		const { applyCorruptionEffects } = await import('../corruption');
		const gain = (catalog?: never) => {
			const p = makePlayer({ spirits: [spirit(1, { Cultist: 1 })] });
			applyCorruptionEffects(p, [], { catalog });
			return p.victoryPoints;
		};
		expect(gain({ rules: { cultistNoVp: true } } as never)).toBe(0);
		expect(gain()).toBe(1);
	});
});

// Hero reworks and Healer (Michael, 2026-11-18).
describe('rules captainPowerOnKill, alchemistAugmentToArcane, healerNoVp', () => {
	const kill = (catalog: never, killed: boolean) => {
		const p = makePlayer({ spirits: [spirit(1, { Captain: 1 })] });
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], { catalog, combat: { dealt: 5, overkill: 0, killed } } as never);
		return (p.powerInventory ?? []).length;
	};
	it('Captain: a random Power after a kill, none after a fight that does not kill, none with the rule off', () => {
		const ON = { rules: { captainPowerOnKill: true } } as never;
		expect(kill(ON, true)).toBe(1);
		expect(kill(ON, false)).toBe(0);
		expect(kill({} as never, true)).toBe(0);
	});
	it('Captain: no augment on Cultivate with the rule on', () => {
		const hero = () => spirit(1, { Captain: 1 }, { origins: { 'Human Enclave': 1 } });
		const cultivate = (catalog: never) => {
			const p = makePlayer({ spirits: [hero(), { ...hero(), slotIndex: 2, classes: {} }, { ...hero(), slotIndex: 3, classes: {} }] });
			applyTrigger(makeState(p), 'Red', 'onCultivate', [], { catalog });
			return (p.unplacedAugments ?? []).length;
		};
		expect(cultivate({ rules: { captainPowerOnKill: true } } as never)).toBe(0);
	});
	it('Arcane Alchemist: converts a placed Spirit Augment into 1 Arcane Attack Dice', () => {
		const ON = { rules: { alchemistAugmentToArcane: true } } as never;
		const p = makePlayer({
			spirits: [spirit(1, { 'Arcane Alchemist': 1 }), spirit(2, {}, { name: 'Carrier' })],
			spiritAugmentAttachments: [{ runeId: 'aug-fighter', spiritId: 's2', spiritSlotIndex: 2, className: 'Fighter', classId: 'c-fighter' }]
		});
		const state = makeState(p);
		applyTrigger(state, 'Red', 'onCultivate', [], { catalog: ON });
		const card = p.pendingDecisions.find((d) => d.kind === 'alchemistAugment')!;
		expect(card.options.map((o) => o.id)).toEqual(['aug:2:aug-fighter', 'no']);
		const ctx = buildEffectContext({ state, seat: 'Red', player: p, trigger: 'onCultivate', log: [], traitCount: 0, catalog: ON });
		DECISION_RESOLVERS.alchemistAugment(ctx, 'aug:2:aug-fighter');
		expect(p.spiritAugmentAttachments).toEqual([]);
		expect(p.attackDice.map((d) => d.tier)).toEqual(['arcane']);
	});
	it('Arcane Alchemist: no card without a placed augment; rule off keeps the 4-dice trade', () => {
		const ON = { rules: { alchemistAugmentToArcane: true } } as never;
		const p = makePlayer({ spirits: [spirit(1, { 'Arcane Alchemist': 1 })] });
		applyTrigger(makeState(p), 'Red', 'onCultivate', [], { catalog: ON });
		expect(p.pendingDecisions).toEqual([]);
		const q = makePlayer({
			spirits: [spirit(1, { 'Arcane Alchemist': 1 })],
			attackDice: Array.from({ length: 4 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as const }))
		});
		applyTrigger(makeState(q), 'Red', 'onCultivate', [], {});
		expect(q.pendingDecisions.map((d) => d.kind)).toEqual(['arcMageTrade']);
	});
	it('Healer: the Rest card gives no point with healerNoVp', () => {
		const rest = (catalog: never) => {
			const p = makePlayer({ spirits: [spirit(1, { Healer: 1 })], maxBarrier: 10, barrier: 5, brokenBarrier: 5 });
			const state = makeState(p);
			applyTrigger(state, 'Red', 'onRest', [], { catalog });
			const ctx = buildEffectContext({ state, seat: 'Red', player: p, trigger: 'onRest', log: [], traitCount: 0, catalog });
			DECISION_RESOLVERS.healerRestore(ctx, 'yes');
			return [p.victoryPoints, p.barrier];
		};
		expect(rest({ rules: { healerNoVp: true } } as never)).toEqual([0, 8]);
		expect(rest({} as never)).toEqual([1, 8]);
	});
});

describe('Captain discard clause', () => {
	const discard = (catalog: never) => {
		const p = makePlayer({ spirits: [spirit(1, { Captain: 1 })] });
		applyTrigger(makeState(p), 'Red', 'onSpiritDiscard', [], { catalog, counts: { Captain: 1 } } as never);
		return p.attackDice.length;
	};
	it('rule off or captainPowerOnKill alone: 1 Enchanted Attack; with captainNoDiscardDie: nothing', () => {
		expect(discard({} as never)).toBe(1);
		expect(discard({ rules: { captainPowerOnKill: true } } as never)).toBe(1);
		expect(discard({ rules: { captainPowerOnKill: true, captainNoDiscardDie: true } } as never)).toBe(0);
	});
});

describe('rule feralNoDamage', () => {
	const fight = (catalog: never) => {
		const p = makePlayer({ spirits: [spirit(1, { Feral: 1 })] });
		applyTrigger(makeState(p), 'Red', 'inCombat', [], { catalog });
		return [p.combatDamageBonus, p.alwaysAttackFirst];
	};
	it('rule off: +3 and strike first against a monster; rule on: strike first only', () => {
		expect(fight({} as never)).toEqual([3, true]);
		expect(fight({ rules: { feralNoDamage: true } } as never)).toEqual([0, true]);
	});
});
