/**
 * Rule switch `powerRework` (rules.ts): the 2026-11-13 Navigation Power set, 11 general + 11 niche.
 * Each new Power's effect, the pool the engine drafts from, and that the old set is untouched
 * when the switch is off.
 *
 *   npx vitest run src/lib/play/navigationPowersV2.test.ts
 */

import { describe, expect, it } from 'vitest';
import type { MonsterState, PlayCatalog, PlayRules, PublicGameState, SeatColor } from './types';
import { setCorruptionDiscardObligation } from './types';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import {
	afterNavigationPowerCombat,
	beforeNavigationPowerCombat,
	navigationPowerPlayer,
	resolveNavigationPowerChoice,
	resolveNavigationPowerReveal,
	type NavigationPowerHooks
} from './navigationPowerEffects';
import {
	NAVIGATION_POWERS,
	NAVIGATION_POWERS_V2,
	navigationPowerById,
	navigationPowerPool,
	isNavigationPowerId,
	type NavigationPowerId
} from './navigationPowers';
import { ownerAugmentCapacity, SPIRIT_AUGMENT_CLASSES } from './augments';
import { fightMonster } from './combat';
import { parseRules } from './rules';
import { summonDrawSizes } from './runtime';
import { SPIRIT_WORLD_BAG } from './bags';
import { originRuneOptions } from './locationInteractions';
import { loadFrozenCatalog } from './agents/catalog';
import { buildRulesBrief } from './agents/rulesBrief';

const ON: PlayRules = { powerRework: true };
const catalog: PlayCatalog = {
	guardians: [],
	spirits: [
		{ id: 'rune-spirit', name: 'Rune Spirit', cost: 7, classes: {}, origins: {}, awaken: { kind: 'rune_cost', mats: [] } },
		{ id: 'text-spirit', name: 'Text Spirit', cost: 9, classes: {}, origins: {}, awaken: { kind: 'text', text: 'Have 7 Fire Spirits.' } }
	],
	mats: [],
	dice: [],
	classes: SPIRIT_AUGMENT_CLASSES.map((name, i) => ({
		id: `class-${i}`,
		name,
		classType: 'normal',
		isSpecial: false,
		effectSchema: []
	})),
	rules: ON
};

function setup(id: NavigationPowerId, destination = 'Arcane Abyss', overrides = {}) {
	const p = makePlayer({
		navigationPower: id,
		navigationDestination: destination,
		barrier: 2,
		maxBarrier: 8,
		brokenBarrier: 6,
		...overrides
	});
	const b = makePlayer({ playerColor: 'Blue', navigationDestination: 'Water Region', victoryPoints: 9 });
	const g = makePlayer({ playerColor: 'Green', navigationDestination: 'Fire Region', victoryPoints: 5 });
	const state = makeState(p, { Blue: b, Green: g });
	state.activeSeats = ['Red', 'Blue', 'Green'];
	state.round = 3;
	return { state, p: navigationPowerPlayer(p), b: navigationPowerPlayer(b) };
}
function choose(
	state: PublicGameState,
	seat: SeatColor,
	optionId: string,
	hooks: NavigationPowerHooks = {}
) {
	const offer = navigationPowerPlayer(state.players[seat]!).navigationPowerOffers?.[0];
	if (!offer) throw Error('missing offer');
	return resolveNavigationPowerChoice(state, seat, { offerId: offer.id, optionId }, catalog, hooks);
}
const monster = (over: Partial<MonsterState> = {}): MonsterState =>
	({
		id: 'm', name: 'Test Monster', hp: 6, maxHp: 6, damage: 5, rewardTrack: [], chooseAmount: 0,
		livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1, initiative: 9,
		...over
	}) as MonsterState;

describe('powerRework: the pool', () => {
	it('is 11 general + 11 niche, with unique ids, names and no Evil-player trigger', () => {
		const pool = navigationPowerPool({ rules: ON });
		expect(pool).toHaveLength(22);
		expect(pool.filter((p) => p.group === 'general')).toHaveLength(11);
		expect(pool.filter((p) => p.group === 'niche')).toHaveLength(11);
		expect(new Set(pool.map((p) => p.id)).size).toBe(22);
		expect(new Set(pool.map((p) => p.name)).size).toBe(22);
		for (const power of pool) {
			expect(power.text).not.toMatch(/Evil player/i);
			expect(isNavigationPowerId(power.id)).toBe(true);
			expect(navigationPowerById(power.id)?.text).toBe(power.text);
		}
	});
	it('keeps the old set, and its texts, when the switch is off', () => {
		expect(navigationPowerPool(undefined)).toBe(NAVIGATION_POWERS);
		expect(navigationPowerPool({ rules: { sunRework: true } })).toBe(NAVIGATION_POWERS);
		expect(navigationPowerById('ember-charge')?.text).toMatch(/another player enters/);
		// A kept Power is the same entry in both sets.
		for (const entry of NAVIGATION_POWERS_V2)
			if (!('name' in entry))
				expect(NAVIGATION_POWERS.some((p) => p.id === entry.id)).toBe(true);
	});
	it('is a known rule switch and changes the agent brief only when on', () => {
		expect(parseRules({ powerRework: true })).toEqual({ rules: { powerRework: true }, problems: [] });
		expect(parseRules({ powerRework: false }).rules).toBeUndefined();
		const frozen = loadFrozenCatalog();
		const off = buildRulesBrief({ ...frozen, rules: undefined });
		const on = buildRulesBrief({ ...frozen, rules: ON });
		expect(off).toContain('Abyssal Reckoning: If an Evil player enters');
		expect(off).not.toContain('Underdog’s Oath');
		expect(on).toContain('Underdog’s Oath');
		expect(on).not.toMatch(/If an Evil player enters/);
	});
});

describe('powerRework: general Powers', () => {
	it('Ember Charge restores 5 Barrier at the reveal, alone, with no offer', () => {
		const { state, p } = setup('ember-charge-2');
		resolveNavigationPowerReveal(state, catalog);
		expect(p.barrier).toBe(7);
		expect(p.navigationPowerOffers ?? []).toHaveLength(0);
	});
	it("Underdog's Oath pays 1 VP per player ahead, from the VP before any Power resolved", () => {
		const { state, p, b } = setup('underdogs-oath', 'Fire Region', { victoryPoints: 6 });
		b.navigationPower = 'underdogs-oath';
		resolveNavigationPowerReveal(state, catalog);
		expect(p.victoryPoints).toBe(7); // only Blue (9) is ahead of 6; Green has 5
		expect(b.victoryPoints).toBe(9); // the leader gets nothing
	});
	it('Watchful Eye gives a rune of choice, then may change one held rune', () => {
		const [first, second] = originRuneOptions();
		const { state, p } = setup('watchful-eye-2', 'Forest Region');
		resolveNavigationPowerReveal(state, catalog);
		expect(choose(state, 'Red', first.runeId).ok).toBe(true);
		const held = () => p.mats.filter((m) => m.hasRune).map((m) => m.name);
		expect(held()).toEqual([first.name]);
		const convert = p.navigationPowerOffers![0];
		expect(convert.kind).toBe('convert-rune');
		const option = convert.options.find((o) => o.label.endsWith(`into ${second.name}`))!;
		expect(choose(state, 'Red', option.id).ok).toBe(true);
		expect(held()).toEqual([second.name]);
		expect(p.navigationPowerOffers).toEqual([]);
	});
	it('Unbroken Assault and Duelist’s Prize are on from the reveal and pay after a failed battle', () => {
		const a = setup('unbroken-assault-2');
		resolveNavigationPowerReveal(a.state, catalog);
		expect(a.p.navigationPowerOffers ?? []).toHaveLength(0); // no "Use power" step before the fight
		afterNavigationPowerCombat(a.state, 'Red', false);
		expect(choose(a.state, 'Red', 'accept').ok).toBe(true);
		expect([a.p.maxBarrier, a.p.barrier]).toEqual([10, 8]);

		const d = setup('duelists-prize-2');
		resolveNavigationPowerReveal(d.state, catalog);
		afterNavigationPowerCombat(d.state, 'Red', false);
		afterNavigationPowerCombat(d.state, 'Red', false);
		expect(d.p.victoryPoints).toBe(2); // once

		const won = setup('duelists-prize-2');
		resolveNavigationPowerReveal(won.state, catalog);
		afterNavigationPowerCombat(won.state, 'Red', true);
		expect(won.p.victoryPoints).toBe(0);
	});
});

describe('powerRework: niche Powers', () => {
	it('Cinder Awakening offers only face-down spirits with a rune cost, and only at Fire', () => {
		const spirits = [
			spirit(1, {}, { id: 'rune-spirit', name: 'Rune Spirit', faceDown: true }),
			spirit(2, {}, { id: 'text-spirit', name: 'Text Spirit', faceDown: true })
		];
		const away = setup('cinder-awakening-2', 'Forest Region', { spirits });
		resolveNavigationPowerReveal(away.state, catalog);
		expect(away.p.navigationPowerOffers ?? []).toHaveLength(0);

		const { state, p } = setup('cinder-awakening-2', 'Fire Region', { spirits: structuredClone(spirits) });
		resolveNavigationPowerReveal(state, catalog);
		expect(p.navigationPowerOffers![0].options.map((o) => o.label)).toEqual([
			'Awaken Rune Spirit',
			'Decline'
		]);
		const awaken: NavigationPowerHooks['awaken'] = (s, seat, slot) => {
			s.players[seat]!.spirits.find((x) => x.slotIndex === slot)!.isFaceDown = false;
		};
		expect(choose(state, 'Red', '1', { awaken }).ok).toBe(true);
		expect(p.spirits.map((s) => s.isFaceDown)).toEqual([false, true]);
	});
	it('Forest Bounty gives 2 augments and a second augment slot for the round, only at the Forest', () => {
		const { state, p } = setup('forest-bounty-2', 'Forest Region', { spirits: [spirit(1, {})] });
		resolveNavigationPowerReveal(state, catalog);
		expect(choose(state, 'Red', 'Beast').ok).toBe(true);
		expect(choose(state, 'Red', 'Beast').ok).toBe(true);
		expect(p.navigationPowerOffers).toEqual([]);
		expect(p.unplacedAugments ?? []).toHaveLength(2);
		expect(ownerAugmentCapacity(p, p.spirits[0])).toBe(2);
		p.navigationDestination = 'Fire Region';
		expect(ownerAugmentCapacity(p, p.spirits[0])).toBe(1);
		p.navigationDestination = 'Forest Region';
		p.navigationPower = null; // next round
		expect(ownerAugmentCapacity(p, p.spirits[0])).toBe(1);
	});
	it('Mountain Bastion: +3 Max Barrier, full Barrier, and VP for what the cap of 10 cuts off', () => {
		const { state, p } = setup('mountain-bastion-2', 'Mountain Region');
		resolveNavigationPowerReveal(state, catalog);
		expect([p.maxBarrier, p.barrier, p.victoryPoints]).toEqual([10, 10, 1]);
		const low = setup('mountain-bastion-2', 'Mountain Region', { maxBarrier: 4, barrier: 1, brokenBarrier: 3 });
		resolveNavigationPowerReveal(low.state, catalog);
		expect([low.p.maxBarrier, low.p.barrier, low.p.victoryPoints]).toEqual([7, 7, 0]);
		const away = setup('mountain-bastion-2', 'Arcane Abyss');
		resolveNavigationPowerReveal(away.state, catalog);
		expect([away.p.maxBarrier, away.p.barrier]).toEqual([8, 2]);
	});
	it('Tidal Calling: Spirit World Summons draw 8 at the Water Region only', () => {
		const at = (navigationPower: NavigationPowerId | null, navigationDestination: string) =>
			summonDrawSizes(SPIRIT_WORLD_BAG, { rules: ON }, { navigationPower, navigationDestination });
		expect(at('tidal-calling', 'Water Region')).toEqual({ draw: 8, pick: 2 });
		expect(at('tidal-calling', 'Fire Region')).toEqual({ draw: 4, pick: 2 });
		expect(at(null, 'Water Region')).toEqual({ draw: 4, pick: 2 });
		expect(summonDrawSizes(SPIRIT_WORLD_BAG, { rules: ON })).toEqual({ draw: 4, pick: 2 });
	});
	it('Abyssal Execution offers only cards at half Barrier or less, at the Abyss', () => {
		const monsterHand = [monster({ name: 'Fresh' }), monster({ name: 'Chipped', hp: 3 }), monster({ name: 'Scratched', hp: 4 })];
		const { state, p } = setup('abyssal-execution-2', 'Arcane Abyss', { monsterHand });
		resolveNavigationPowerReveal(state, catalog);
		expect(p.navigationPowerOffers![0].options.map((o) => o.id)).toEqual(['1', 'decline']);
		let executed = -1;
		const defeatMonster: NavigationPowerHooks['defeatMonster'] = (_s, _seat, _c, index) => {
			executed = index ?? -1;
		};
		expect(choose(state, 'Red', '1', { defeatMonster }).ok).toBe(true);
		expect(executed).toBe(1);
		const away = setup('abyssal-execution-2', 'Fire Region', { monsterHand: structuredClone(monsterHand) });
		resolveNavigationPowerReveal(away.state, catalog);
		expect(away.p.navigationPowerOffers ?? []).toHaveLength(0);
	});
	it('Sudden Strike: you strike first, so a kill takes no hit', () => {
		const fight = (power: NavigationPowerId | null) => {
			const { state, p } = setup(power ?? 'battle-guard', 'Arcane Abyss', {
				navigationPower: power,
				barrier: 4,
				maxBarrier: 4,
				brokenBarrier: 0,
				spirits: [spirit(1, { Beast: 9 })], // 9 flat damage, no dice needed
				monsterHand: [monster()]
			});
			resolveNavigationPowerReveal(state, catalog);
			const result = fightMonster(state, 'Red', catalog, 0)!;
			return { result, p };
		};
		const plain = fight(null);
		expect(plain.result.corrupted).toBe(true); // initiative 9 monster hits first for 5 at Barrier 4
		const struck = fight('sudden-strike');
		expect(struck.result.killed).toBe(true);
		expect(struck.result.barrierLost).toBe(0);
		expect(struck.p.barrier).toBe(4);
	});
	it('Sudden Strike flag is set in the combat hook', () => {
		const { state, p } = setup('sudden-strike');
		resolveNavigationPowerReveal(state, catalog);
		beforeNavigationPowerCombat(state, 'Red', false);
		expect(p.alwaysAttackFirst).toBe(true);
	});
	it('Tempered Dice upgrades the lowest dice 5 times and stops at exalted', () => {
		const dice = (tiers: string[]) => tiers.map((tier, i) => ({ instanceId: `d${i}`, tier })) as never;
		const { state, p } = setup('tempered-dice', 'Forest Region', {
			attackDice: dice(['basic', 'basic', 'basic', 'enchanted', 'arcane'])
		});
		resolveNavigationPowerReveal(state, catalog);
		expect(p.attackDice.map((d) => d.tier).sort()).toEqual(['arcane', 'enchanted', 'enchanted', 'exalted', 'exalted']);
		const capped = setup('tempered-dice', 'Forest Region', { attackDice: dice(['exalted', 'arcane']) });
		resolveNavigationPowerReveal(capped.state, catalog);
		expect(capped.p.attackDice.map((d) => d.tier)).toEqual(['exalted', 'arcane']);
	});
	it('Dark Bargain pays 3 VP on the first corruption of the round only', () => {
		const { state, p } = setup('dark-bargain', 'Arcane Abyss', { spirits: [spirit(1, {}), spirit(2, {})] });
		resolveNavigationPowerReveal(state, catalog);
		p.corruptionCount = 1;
		setCorruptionDiscardObligation(p);
		expect(p.victoryPoints).toBe(3);
		expect(p.pendingCorruptionDiscard?.count).toBe(1); // the sacrifice is still owed
		p.corruptionCount = 2;
		setCorruptionDiscardObligation(p);
		expect(p.victoryPoints).toBe(3);
	});
	it('Soul Ward cancels the sacrifice (and the Fallen VP debt) of the first corruption only', () => {
		const { state, p } = setup('soul-ward', 'Arcane Abyss', { spirits: [spirit(1, {})], victoryPoints: 5 });
		resolveNavigationPowerReveal(state, catalog);
		p.corruptionCount = 4;
		expect(setCorruptionDiscardObligation(p, undefined, { wasFallen: true })).toBe(0);
		expect(p.pendingCorruptionDiscard ?? null).toBeNull();
		expect(p.victoryPoints).toBe(5);
		p.corruptionCount = 5;
		expect(setCorruptionDiscardObligation(p, undefined, { wasFallen: true })).toBe(4); // 5 owed, 1 spirit
		expect(p.pendingCorruptionDiscard?.count).toBe(1);
	});
	it('a player without these Powers is corrupted exactly as before', () => {
		const { p } = setup('battle-guard', 'Arcane Abyss', { spirits: [spirit(1, {}), spirit(2, {})] });
		p.corruptionCount = 2;
		expect(setCorruptionDiscardObligation(p)).toBe(0);
		expect(p.pendingCorruptionDiscard?.count).toBe(2);
		expect(p.victoryPoints).toBe(0);
	});
	it('Abyssal Reckoning pays by status: Pure 0, Tainted 1, Corrupt 2, Fallen 4', () => {
		const paid = [0, 1, 2, 3].map((statusLevel) => {
			const { state, p } = setup('abyssal-reckoning-2', 'Forest Region', { statusLevel });
			resolveNavigationPowerReveal(state, catalog);
			return p.victoryPoints;
		});
		expect(paid).toEqual([0, 1, 2, 4]);
	});
	it('Twin Rhythm rests once and cultivates once, wherever the player is', () => {
		const { state } = setup('twin-rhythm', 'Arcane Abyss');
		resolveNavigationPowerReveal(state, catalog);
		const calls: string[] = [];
		const hooks: NavigationPowerHooks = {
			rest: () => void calls.push('rest'),
			cultivate: () => void calls.push('cultivate')
		};
		expect(choose(state, 'Red', 'accept', hooks).ok).toBe(true);
		expect(calls).toEqual(['rest', 'cultivate']);
	});
});
