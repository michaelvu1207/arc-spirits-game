/**
 * Scripted Fighter + Elementalist player (no model). It plays one fixed build: Fighter to 5 for
 * attack dice on Rest, Elementalist to 5 for dice upgrades, and scores by killing monsters.
 *
 * It reads only the seat's own projection (`seatProjection`, the data the LLM seats get as text)
 * and the catalog, and answers with one of the offered actions. Every decision the engine can
 * ask is answered: the plan's decisions by the rules below, everything else by a safe default
 * (decline, keep, pass, yield).
 *
 * Every option gets a value in "points-equivalents" (1 = one Victory Point now) and the best
 * one is taken. The weights are rough; `FeParams` holds the tunable ones, which were tuned on
 * seeded games (scripts/agent-harness/scripted/run-fe.ts).
 */

import { awakenedClassCounts } from '../../effects/apply';
import { diceTierFaces } from '../../combat';
import { buildMonsterRewards } from '../../monsterRewards';
import { arcaneBloodFor } from '../../runtime';
import type {
	AttackDie,
	DiceTier,
	GameCommand,
	MonsterState,
	PlayCatalog,
	PlayerProjection,
	PrivatePlayerState,
	SeatColor,
	SpectatorProjection
} from '../../types';
import type { OfferedAction } from '../contract';

export interface FeParams {
	/** Points per +1 expected damage of one roll (dice gained or upgraded). */
	attack: number;
	/** Extra weight on attack while it is low (the first dice make the first kills possible):
	 *  attack counts (1 + attackLow) times at 0 expected damage, falling to 1 times at 4. */
	attackLow: number;
	/** The same, when weighing Arcane Blood upgrades against a kill's points. */
	bloodAttack: number;
	/** Difficulty 1 and 2 cards left per player at which Arcane Blood counts half (more easy cards
	 *  left: points now are worth more than upgrades; fewer: upgrades for Difficulty 3 are). */
	bloodEasy: number;
	/** Take Arcane Blood only while the seat has at most this many points. */
	bloodMaxVp: number;
	/** Value of one Max Barrier below 7 / from 7 to 10. */
	maxBarrierLow: number;
	maxBarrierHigh: number;
	/** Weight of the chance to find a Max Barrier power with a Mountain replace while Max Barrier < 7. */
	mbHunt: number;
	/** Value of being able to take a monster's hit (Barrier readiness, 0..1). */
	ready: number;
	/** Value of one held basic rune. */
	rune: number;
	/** Value of one Navigation Power drawn at random. */
	randomPower: number;
	/** Multiplier on the value of Fighter / Elementalist class steps. */
	classScale: number;
	/** Value of a spare spirit that can host an augment the build still needs. */
	host: number;
	/** Value of a corruption (spirits lost, a lost strike). */
	corruption: number;
	/** Chip damage on a card kept in hand counts this share of the card's points per Barrier. */
	chip: number;
	/** A card drawn for a later visit counts this share of its fight value at full Barrier
	 *  (0: a small fixed value by its points). */
	hold: number;
	/** Fight only when the fight is worth at least this. */
	minFight: number;
	/** Value per point of Barrier lost in a fight (the Rest it costs later). */
	hitCost: number;
	/** Multiplier on the value of keeping a held power for later. */
	powerKeep: number;
}

export const DEFAULT_FE_PARAMS: FeParams = {
	attack: 1.2,
	attackLow: 0,
	bloodAttack: 2,
	bloodEasy: 3,
	bloodMaxVp: 14,
	maxBarrierLow: 1.5,
	maxBarrierHigh: 0.4,
	mbHunt: 0,
	ready: 1.5,
	rune: 0.6,
	randomPower: 0.9,
	classScale: 1,
	host: 0.5,
	corruption: 5,
	chip: 1.2,
	minFight: 1.3,
	hold: 1,
	hitCost: 0.1,
	powerKeep: 0.6
};

export interface FeChoice {
	id: string;
	reason: string;
}

const TARGET = 5;
const MAX_DICE = 10;
const MAX_SLOTS = 7;
const ABYSS = 'Arcane Abyss';
const DECLINE = /^(no|decline|skip|pass|keep|none|cancel)/i;

type Me = PlayerProjection & PrivatePlayerState;

/** Facts about the seat that every rule reads. */
export interface Situation {
	view: SpectatorProjection;
	seat: SeatColor;
	me: Me;
	catalog: PlayCatalog;
	params: FeParams;
	fighter: number;
	elementalist: number;
	tiers: DiceTier[];
	runes: number;
	faces: Record<DiceTier, number[]>;
	mean: Record<DiceTier, number>;
}

export function situationOf(
	view: SpectatorProjection,
	seat: SeatColor,
	catalog: PlayCatalog,
	params: FeParams = DEFAULT_FE_PARAMS
): Situation {
	const me = view.players[seat] as Me;
	const counts = awakenedClassCounts(me as PrivatePlayerState);
	const faces = diceTierFaces(catalog);
	const mean = Object.fromEntries(
		(Object.keys(faces) as DiceTier[]).map((t) => [
			t,
			faces[t].reduce((a, b) => a + b, 0) / faces[t].length
		])
	) as Record<DiceTier, number>;
	return {
		view,
		seat,
		me,
		catalog,
		params,
		fighter: counts.Fighter ?? 0,
		elementalist: counts.Elementalist ?? 0,
		tiers: (me.attackDice ?? []).map((d: AttackDie) => d.tier),
		runes: basicRuneCount(me),
		faces,
		mean
	};
}

// ───────────────────────────── build model ─────────────────────────────

/** Basic Attack dice a Rest gives at this Fighter count (Fighter 2 / 3 / 4 / 5 → 1 / 2 / 3 / 5). */
export function restDice(fighter: number): number {
	if (fighter >= 5) return 5;
	if (fighter >= 4) return 3;
	if (fighter >= 3) return 2;
	if (fighter >= 2) return 1;
	return 0;
}

/** Value of one more Fighter (+1) at this count. */
function fighterStep(s: Situation, f: number): number {
	return ([0.4, 3, 2, 1.6, 2.4][f] ?? 0) * s.params.classScale;
}
/** Value of one more Elementalist (+1) at this count. */
function elementalistStep(s: Situation, e: number): number {
	return ([0.4, 2, 2.4, 1.2, 0.9][e] ?? 0) * s.params.classScale;
}

/** Value of adding `df` Fighter and `de` Elementalist. */
function classGain(s: Situation, df: number, de: number): number {
	let v = 0;
	for (let i = 0; i < df; i++) v += fighterStep(s, s.fighter + i);
	for (let i = 0; i < de; i++) v += elementalistStep(s, s.elementalist + i);
	return v;
}

/** The better class for the next augment ('Fighter' | 'Elementalist' | null when both are full). */
export function nextAugmentClass(s: Situation): 'Fighter' | 'Elementalist' | null {
	const f = fighterStep(s, s.fighter);
	const e = elementalistStep(s, s.elementalist);
	if (f <= 0 && e <= 0) return null;
	return f >= e ? 'Fighter' : 'Elementalist';
}

function isFeSpirit(classes: Record<string, number> | undefined): boolean {
	return !!classes && ((classes.Fighter ?? 0) > 0 || (classes.Elementalist ?? 0) > 0);
}

function basicRuneCount(me: Me): number {
	return (me.mats ?? []).filter(
		(m) =>
			m?.hasRune &&
			!m.relicTool &&
			!m.special &&
			/rune/i.test(m.name ?? '') &&
			!/augment/i.test(m.name ?? '')
	).length;
}

function augmentedSlots(me: Me): Set<number> {
	return new Set((me.spiritAugmentAttachments ?? []).map((a) => a.spiritSlotIndex));
}

/** Face-up spirits that can still take an augment (one per spirit). */
function augmentHosts(me: Me): number {
	const used = augmentedSlots(me);
	return (me.spirits ?? []).filter((sp) => !sp.isFaceDown && !used.has(sp.slotIndex)).length;
}

/** Class points the build still needs. */
function classNeed(s: Situation): number {
	return Math.max(0, TARGET - s.fighter) + Math.max(0, TARGET - s.elementalist);
}

/** How much a spirit in play is worth keeping (low = first to replace or sacrifice). */
function keepValue(s: Situation, slot: number): number {
	const sp = s.me.spirits.find((x) => x.slotIndex === slot);
	if (!sp) return 0;
	const aug = (s.me.spiritAugmentAttachments ?? []).find((a) => a.spiritSlotIndex === slot);
	let v = 0;
	const f = sp.isFaceDown ? 0 : (sp.classes?.Fighter ?? 0);
	const e = sp.isFaceDown ? 0 : (sp.classes?.Elementalist ?? 0);
	// What the build loses without it.
	for (let i = 0; i < f; i++) v += fighterStep(s, Math.max(0, Math.min(4, s.fighter - 1 - i)));
	for (let i = 0; i < e; i++)
		v += elementalistStep(s, Math.max(0, Math.min(4, s.elementalist - 1 - i)));
	if (aug?.className === 'Fighter') v += fighterStep(s, Math.max(0, Math.min(4, s.fighter - 1)));
	else if (aug?.className === 'Elementalist')
		v += elementalistStep(s, Math.max(0, Math.min(4, s.elementalist - 1)));
	else if (aug) v += 0.2;
	else if (!sp.isFaceDown && classNeed(s) > 0) v += s.params.host * 0.5; // a free host
	return v + 0.01 * sp.cost;
}

// ───────────────────────────── dice and fights ─────────────────────────────

/** Tiers after gaining `add` Basic dice (cap 10) and `upgrades` upgrades (lowest first). */
export function diceAfter(tiers: DiceTier[], add: number, upgrades: number): DiceTier[] {
	const out = [...tiers];
	for (let i = 0; i < add && out.length < MAX_DICE; i++) out.push('basic');
	for (let u = 0; u < upgrades; u++) {
		const b = out.indexOf('basic');
		if (b >= 0) {
			out[b] = 'enchanted';
			continue;
		}
		const e = out.indexOf('enchanted');
		if (e >= 0) {
			out[e] = 'exalted';
			continue;
		}
		break;
	}
	return out;
}

/** Upgrades still possible (steps to make every die Exalted). */
export function upgradeRoom(tiers: DiceTier[]): number {
	return tiers.reduce((n, t) => n + (t === 'basic' ? 2 : t === 'enchanted' ? 1 : 0), 0);
}

function expectedAttack(s: Situation, tiers: DiceTier[]): number {
	return tiers.reduce((n, t) => n + (s.mean[t] ?? 0), 0);
}

const pmfCache = new Map<string, number[]>();

/** Probability of each damage total for these dice. */
export function damagePmf(tiers: DiceTier[], faces: Record<DiceTier, number[]>): number[] {
	const key = [...tiers].sort().join(',') + '|' + JSON.stringify(faces);
	const hit = pmfCache.get(key);
	if (hit) return hit;
	let pmf = [1];
	for (const t of tiers) {
		const f = faces[t] ?? [0];
		const next = new Array(pmf.length + Math.max(...f)).fill(0);
		for (let s = 0; s < pmf.length; s++) {
			if (!pmf[s]) continue;
			for (const x of f) next[s + x] += pmf[s] / f.length;
		}
		pmf = next;
	}
	if (pmfCache.size > 5000) pmfCache.clear();
	pmfCache.set(key, pmf);
	return pmf;
}

function pAtLeast(pmf: number[], n: number): number {
	let p = 0;
	for (let s = Math.max(0, n); s < pmf.length; s++) p += pmf[s];
	return Math.min(1, p);
}

function expectedCapped(pmf: number[], cap: number): number {
	let e = 0;
	for (let s = 0; s < pmf.length; s++) e += pmf[s] * Math.min(s, cap);
	return e;
}

/** Points on a card's reward track (the Abyss Lurker: its one point). */
export function cardVp(card: Pick<MonsterState, 'rewardTrack' | 'permanent'>): number {
	const rewards = buildMonsterRewards(card.rewardTrack);
	const vp = rewards.reduce((n, r) => n + (r.effect.type === 'vp' ? r.effect.amount : 0), 0);
	return card.permanent ? Math.min(vp, 1) || 1 : vp;
}

/** Extra value of a card's non-point rewards to this build (runes; summons are worth nothing). */
function cardExtras(s: Situation, card: Pick<MonsterState, 'rewardTrack' | 'permanent'>): number {
	if (card.permanent) return 0;
	return buildMonsterRewards(card.rewardTrack).reduce((n, r) => {
		if (r.effect.type === 'chooseRune' || r.effect.type === 'rune') return n + s.params.rune * 0.6;
		return n;
	}, 0);
}

export interface FightSetup {
	tiers: DiceTier[];
	barrier: number;
	reduction: number;
	strikeFirst: boolean;
	extraArcane: number;
}

export interface FightOutcome {
	pKill: number;
	corrupted: boolean;
	/** Barrier lost to the monster's hit (when not corrupted). */
	hit: number;
	expectedDamage: number;
}

export function fightOutcome(s: Situation, card: MonsterState, setup: FightSetup): FightOutcome {
	const tiers = [...setup.tiers, ...new Array(setup.extraArcane).fill('arcane' as DiceTier)];
	const pmf = damagePmf(tiers, s.faces);
	const left = Math.max(0, card.hp);
	const hit = Math.max(0, card.damage - setup.reduction);
	const lethal = hit > 0 && hit >= setup.barrier;
	if (setup.strikeFirst) {
		const pKill = pAtLeast(pmf, left);
		return {
			pKill,
			corrupted: lethal && pKill < 1,
			hit: lethal ? 0 : hit * (1 - pKill),
			expectedDamage: expectedCapped(pmf, left)
		};
	}
	if (lethal) return { pKill: 0, corrupted: true, hit: 0, expectedDamage: 0 };
	return {
		pKill: pAtLeast(pmf, left),
		corrupted: false,
		hit,
		expectedDamage: expectedCapped(pmf, left)
	};
}

/** Points value of a kill of this card for this seat (points, or Arcane Blood upgrades). */
export function killValue(s: Situation, card: MonsterState): number {
	const vp = cardVp(card) + cardExtras(s, card);
	return Math.max(vp, bloodValue(s, card));
}

/** Points per +1 attack from Arcane Blood: high when the easy cards (Difficulty 1 and 2) are
 *  running out and the points must come from Difficulty 3. */
function bloodWeight(s: Situation): number {
	const easy =
		deckLeft(s, 1) +
		deckLeft(s, 2) +
		(s.me.monsterHand ?? []).filter((c) => !c.permanent && (c.difficulty ?? 1) <= 2).length;
	const perPlayer = easy / Math.max(1, s.view.activeSeats.length);
	const scarcity = Math.max(0.2, Math.min(1, 1 - perPlayer / (2 * s.params.bloodEasy)));
	return s.params.bloodAttack * scarcity;
}

/** Value of taking the card's Arcane Blood (one upgrade each with Elementalist 2). */
function bloodValue(s: Situation, card: Pick<MonsterState, 'difficulty' | 'permanent'>): number {
	if (s.elementalist < 2) return 0;
	if (s.me.victoryPoints > s.params.bloodMaxVp) return 0;
	const blood = arcaneBloodFor(card, s.catalog) ?? 0;
	const after = diceAfter(s.tiers, 0, blood);
	return (expectedAttack(s, after) - expectedAttack(s, s.tiers)) * bloodWeight(s);
}

/** Value of fighting `card` now with this setup (points-equivalents). */
export function fightValue(s: Situation, card: MonsterState, setup: FightSetup): number {
	const o = fightOutcome(s, card, setup);
	if (o.corrupted && !setup.strikeFirst) return -s.params.corruption;
	const kv = killValue(s, card);
	const chip =
		(1 - o.pKill) * (o.expectedDamage / Math.max(1, card.maxHp)) * cardVp(card) * s.params.chip;
	const corrupt = o.corrupted ? (1 - o.pKill) * s.params.corruption : 0;
	return o.pKill * kv + chip - o.hit * s.params.hitCost - corrupt;
}

/** Monster cards of a deck as the catalog prints them (the dealt pool is a random subset). */
function deckCards(s: Situation, difficulty: 1 | 2 | 3): MonsterState[] {
	return (s.catalog.monsters ?? [])
		.filter((m) => !m.permanent && m.stage === difficulty)
		.map((m) => ({
			id: m.id,
			name: m.name,
			hp: m.barrier,
			maxHp: m.barrier,
			difficulty,
			damage: m.damage,
			initiative: m.initiative,
			rewardTrack: m.rewardTrack,
			chooseAmount: m.chooseAmount,
			livesRemaining: 1,
			livesTotal: 1,
			ladderIndex: 0,
			ladderMax: 1
		}));
}

/** Expected value of the better of two cards drawn from a deck, fought with this setup. */
function drawFightValue(s: Situation, difficulty: 1 | 2 | 3, setup: FightSetup): number {
	const cards = deckCards(s, difficulty);
	if (cards.length < 2) return 0;
	const vals = cards.map((c) => fightValue(s, c, setup));
	let sum = 0;
	let n = 0;
	for (let i = 0; i < vals.length; i++)
		for (let j = i + 1; j < vals.length; j++) {
			sum += Math.max(vals[i], vals[j]);
			n++;
		}
	return sum / n;
}

function deckLeft(s: Situation, difficulty: 1 | 2 | 3): number {
	return s.view.monsterDecks?.find((d) => d.difficulty === difficulty)?.count ?? 0;
}

function baseSetup(s: Situation): FightSetup {
	return {
		tiers: s.tiers,
		barrier: s.me.barrier,
		reduction: s.me.damageReduction ?? 0,
		strikeFirst: false,
		extraArcane: 0
	};
}

/** Best fight available at the Abyss with this setup: a card in hand, or the best new draw. */
export function bestAbyssFight(
	s: Situation,
	setup: FightSetup,
	canDraw: boolean
): { value: number; target: string } {
	// A fight below the threshold is not fought (worth nothing).
	const worth = (v: number) => (v >= s.params.minFight ? v : 0);
	let best = { value: 0, target: 'none' };
	for (const card of s.me.monsterHand ?? []) {
		const v = worth(fightValue(s, card, setup));
		if (v > best.value) best = { value: v, target: card.name };
	}
	if (canDraw && (s.me.monsterHand?.length ?? 0) < 3) {
		for (const d of [1, 2, 3] as const) {
			if (deckLeft(s, d) < 1) continue;
			const v = worth(drawFightValue(s, d, setup));
			if (v > best.value) best = { value: v, target: `new Difficulty ${d} card` };
		}
		if (s.view.permanentMonster) {
			const v = worth(
				fightValue(s, { ...s.view.permanentMonster, hp: s.view.permanentMonster.maxHp }, setup)
			);
			if (v > best.value) best = { value: v, target: 'Abyss Lurker' };
		}
	}
	return best;
}

// ───────────────────────────── locations ─────────────────────────────

function restHeal(s: Situation, barrier = s.me.barrier): number {
	const status = s.me.statusLevel ?? 0; // 0 Pure … 3 Fallen
	const heal = 4 + Math.max(0, 3 - status);
	return Math.max(0, Math.min(s.me.maxBarrier, barrier + heal) - barrier);
}

/** Dice after a Rest (Fighter dice, Elementalist (3) upgrade). */
function tiersAfterRest(s: Situation, tiers = s.tiers): DiceTier[] {
	return diceAfter(tiers, restDice(s.fighter), s.elementalist >= 3 ? 1 : 0);
}

function diceValueDelta(s: Situation, before: DiceTier[], after: DiceTier[]): number {
	const low = 1 + s.params.attackLow * Math.max(0, 1 - expectedAttack(s, before) / 4);
	return (expectedAttack(s, after) - expectedAttack(s, before)) * s.params.attack * low;
}

/** How ready a Barrier is to take a monster's hit (hits are 3-4, Difficulty 3 5-6; the hit must be lower). */
function readiness(barrier: number): number {
	return [0, 0, 0, 0, 0.5, 0.7, 0.85, 1][Math.max(0, Math.min(7, barrier))];
}

function healValue(s: Situation, from: number, heal: number): number {
	if (heal <= 0) return 0;
	return (readiness(from + heal) - readiness(from)) * s.params.ready;
}

function restValue(s: Situation, barrier = s.me.barrier, tiers = s.tiers): number {
	const after = tiersAfterRest(s, tiers);
	let v = diceValueDelta(s, tiers, after) + healValue(s, barrier, restHeal(s, barrier));
	if (s.fighter >= 5) v += augmentValue(s, 1);
	return v;
}

/** Value of `n` augments of the class the build needs most (each needs a free host). */
function augmentValue(s: Situation, n: number, only?: 'Fighter' | 'Elementalist'): number {
	const hosts = augmentHosts(s.me);
	let f = s.fighter;
	let e = s.elementalist;
	let v = 0;
	for (let i = 0; i < Math.min(n, hosts); i++) {
		const fv = only === 'Elementalist' ? -1 : fighterStep(s, f);
		const ev = only === 'Fighter' ? -1 : elementalistStep(s, e);
		if (fv <= 0 && ev <= 0) break;
		if (fv >= ev) {
			v += fv;
			f++;
		} else {
			v += ev;
			e++;
		}
	}
	return v;
}

/** Chance that a Spirit World Summon (3 spirits) shows a Fighter or Elementalist spirit the build needs. */
function pBuildSpirit(s: Situation, spirits = 3): number {
	const bag = s.view.bagSpirits?.spiritWorld ?? [];
	let total = 0;
	let good = 0;
	for (const row of bag) {
		total += row.count;
		const sp = s.catalog.spirits.find((x) => x.id === row.id || x.name === row.name);
		const f = sp?.classes?.Fighter ?? 0;
		const e = sp?.classes?.Elementalist ?? 0;
		if ((f > 0 && s.fighter < TARGET) || (e > 0 && s.elementalist < TARGET)) good += row.count;
	}
	if (total <= 0 || good <= 0) return 0;
	let pNone = 1;
	for (let i = 0; i < spirits && total - i > 0; i++)
		pNone *= Math.max(0, total - good - i) / (total - i);
	return 1 - pNone;
}

function summonValue(s: Situation, drawSize = 4): number {
	let v = 0;
	if (classNeed(s) > 0) {
		const step = Math.max(fighterStep(s, s.fighter), elementalistStep(s, s.elementalist));
		v += pBuildSpirit(s, drawSize - 1) * step;
		// A spare spirit as a host for the augments still needed.
		const free = MAX_SLOTS - (s.me.spirits?.length ?? 0);
		if (free > 0 && augmentHosts(s.me) < classNeed(s)) v += s.params.host;
	}
	v += s.params.rune * 0.8; // the reward hex
	if (s.elementalist >= 5) v += diceValueDelta(s, s.tiers, diceAfter(s.tiers, 0, 1));
	return v;
}

function cultivateValue(s: Situation): number {
	let v = 0;
	if (s.elementalist >= 4) v += diceValueDelta(s, s.tiers, diceAfter(s.tiers, 0, 1));
	const byOrigin = new Map<string, Set<string>>();
	for (const sp of s.me.spirits ?? [])
		for (const o of Object.keys(sp.origins ?? {})) {
			if (!byOrigin.has(o)) byOrigin.set(o, new Set());
			byOrigin.get(o)!.add(sp.name);
		}
	for (const [, names] of byOrigin) if (names.size >= 3) v += s.params.rune;
	return v;
}

/** Value of spending runes at a location's trade row. */
function runeSpendValue(s: Situation, dest: string, runes = s.runes): number {
	if (runes <= 0) return 0;
	if (dest === 'Water Region')
		return Math.max(0, augmentValue(s, runes, 'Fighter') - runes * s.params.rune);
	if (dest === 'Fire Region')
		return Math.max(0, augmentValue(s, runes, 'Elementalist') - runes * s.params.rune);
	if (dest === 'Forest Region') return Math.max(0, s.params.randomPower - s.params.rune) * runes;
	return 0;
}

// ───────────────────────────── powers ─────────────────────────────

/** How much a power is worth holding (the value it usually gives this build). Powers that
 *  raise Max Barrier have a low hold value while it is low, so they are used at once. */
export function powerHoldValue(id: string, s?: Situation): number {
	const mb = s?.me.maxBarrier ?? 10;
	if (id === 'mountain-bastion-2' || id === 'unbroken-assault-2')
		return mb < 7 ? 0.8 : mb < 10 ? 1.2 : 0.5;
	const map: Record<string, number> = {
		'sudden-strike': 4,
		'battle-guard': 3.5,
		'twin-rhythm': 3,
		'tempered-dice': 3,
		'abyssal-execution-2': 2.5,
		'battle-fury': 2.5,
		'underdogs-oath': 2,
		'forest-bounty-2': 2.5,
		'ember-charge-2': 1.5,
		'duelists-prize-2': 1.5,
		'mountains-wealth': 1.2,
		'watchful-eye-2': 0.8,
		'tidal-calling': 1,
		'dark-bargain': 0.5,
		'soul-ward': 0.5,
		'abyssal-reckoning-2': 0.3,
		'cinder-awakening-2': 0.1,
		'thorn-ward': 0.3,
		'tidal-tempo': 0.3,
		'stone-shelter': 0.3
	};
	return map[id] ?? 0.3;
}

/** Value of a power when choosing which to keep (draft, replace). */
export function powerDraftValue(id: string, s: Situation): number {
	const mb = s.me.maxBarrier;
	if (id === 'mountain-bastion-2') return mb < 7 ? 4 : mb < 10 ? 2 : 1;
	if (id === 'unbroken-assault-2') return mb < 7 ? 4.2 : mb < 10 ? 2.2 : 0.8;
	return powerHoldValue(id, s);
}

/** Value of one Mountain replace (draw 3, keep 1) for the weakest held power. */
function replaceValue(s: Situation): number {
	const held = s.me.powerInventory ?? [];
	if (!held.length) return 0;
	const weakest = Math.min(...held.map((id) => powerDraftValue(id, s)));
	const best3 = s.me.maxBarrier < 7 ? 3.6 : 3;
	let v = Math.max(0, best3 - weakest) * 0.5;
	// Below Max Barrier 7 Difficulty 3 hits cannot be taken: hunt Mountain Bastion / Unbroken
	// Assault (2 of the 22 powers; about 1 chance in 4 among 3 drawn).
	if (s.me.maxBarrier < 7 && weakest < 3) v += 0.25 * maxBarrierValue(s, 3) * s.params.mbHunt;
	return v;
}

interface Plan {
	value: number;
	why: string;
}

function playersAhead(s: Situation): number {
	return s.view.activeSeats.filter(
		(seat) => seat !== s.seat && (s.view.players[seat]?.victoryPoints ?? 0) > s.me.victoryPoints
	).length;
}

function maxBarrierValue(s: Situation, gain: number): number {
	let v = 0;
	for (let i = 0; i < gain; i++) {
		const at = s.me.maxBarrier + i;
		v += at >= 10 ? 1 : at < 7 ? s.params.maxBarrierLow : s.params.maxBarrierHigh;
	}
	return v;
}

/** Value of going to `dest` with `power` committed (null = none). */
export function destinationValue(s: Situation, dest: string, power: string | null): Plan {
	let value = 0;
	const why: string[] = [];
	// Effects at the reveal, before the location.
	let barrier = s.me.barrier;
	let tiers = s.tiers;
	if (power === 'ember-charge-2') {
		const heal = Math.min(5, s.me.maxBarrier - barrier);
		value += healValue(s, barrier, heal);
		barrier += heal;
	}
	if (power === 'twin-rhythm') {
		const heal = restHeal(s, barrier);
		value += restValue(s, barrier, tiers) + cultivateValue(s);
		barrier += heal;
		tiers = tiersAfterRest(s, tiers);
	}
	if (power === 'tempered-dice') {
		const after = diceAfter(tiers, 0, 5);
		value += diceValueDelta(s, tiers, after);
		tiers = after;
	}
	if (power === 'underdogs-oath') value += playersAhead(s);
	if (power === 'watchful-eye-2') value += s.params.rune;

	switch (dest) {
		case ABYSS: {
			const setup: FightSetup = {
				tiers,
				barrier,
				reduction: (s.me.damageReduction ?? 0) + (power === 'battle-guard' ? 4 : 0),
				strikeFirst: power === 'sudden-strike',
				extraArcane: power === 'battle-fury' ? 2 : 0
			};
			const best = bestAbyssFight(s, setup, true);
			let fight = Math.max(0, best.value);
			if (power === 'abyssal-execution-2') {
				const exec = (s.me.monsterHand ?? []).filter((c) => c.hp > 0 && c.hp * 2 <= c.maxHp);
				const ev = Math.max(0, ...exec.map((c) => killValue(s, c)));
				// The execution is the round's battle.
				fight = Math.max(fight, ev);
			}
			if (power === 'duelists-prize-2' || power === 'unbroken-assault-2') {
				// Pays when the battle does not kill (a corrupting hit too).
				let bonus = 0;
				const cards = [...(s.me.monsterHand ?? [])];
				for (const card of cards) {
					const o = fightOutcome(s, card, setup);
					const pay = power === 'duelists-prize-2' ? 2 : maxBarrierValue(s, 4);
					const cost = o.corrupted ? s.params.corruption : 0;
					bonus = Math.max(bonus, (1 - o.pKill) * pay - cost + o.pKill * killValue(s, card));
				}
				fight = Math.max(fight, bonus);
			}
			value += fight;
			why.push(`fight ${best.target} (${best.value.toFixed(2)})`);
			break;
		}
		case 'Forest Region': {
			value += restValue(s, barrier, tiers);
			value += runeSpendValue(s, dest);
			if (power === 'forest-bounty-2') value += augmentValue(s, 2);
			why.push('rest');
			break;
		}
		case 'Water Region': {
			value += summonValue(s, power === 'tidal-calling' ? 8 : 4);
			value += runeSpendValue(s, dest);
			why.push('summon');
			break;
		}
		case 'Fire Region': {
			value += cultivateValue(s);
			value += runeSpendValue(s, dest);
			why.push('cultivate');
			break;
		}
		case 'Mountain Region': {
			if (power === 'mountain-bastion-2') {
				const gain = Math.min(3, Math.max(0, 10 - s.me.maxBarrier));
				value += maxBarrierValue(s, 3) + healValue(s, barrier, s.me.maxBarrier + gain - barrier);
			}
			if (power === 'mountains-wealth') value += 2 * s.params.rune;
			// Replace held powers (pay a rune each, keep 1 of 3): a hunt for the strong ones.
			const held = s.me.powerInventory?.length ?? 0;
			const runes = s.runes + (power === 'mountains-wealth' ? 2 : 0);
			if (runes > 0 && held - (power ? 1 : 0) > 0) value += Math.min(runes, 3) * replaceValue(s);
			why.push('mountain');
			break;
		}
	}
	if (power) {
		value -= powerHoldValue(power, s) * s.params.powerKeep;
		why.push(`with ${power}`);
	}
	return { value, why: why.join(', ') };
}

// ───────────────────────────── the chooser ─────────────────────────────

interface Scored {
	action: OfferedAction;
	score: number;
	why: string;
}

/** Choose one of the offered actions. */
export function chooseFeAction(
	view: SpectatorProjection,
	seat: SeatColor,
	actions: OfferedAction[],
	catalog: PlayCatalog,
	params: FeParams = DEFAULT_FE_PARAMS
): FeChoice {
	if (actions.length === 1) return { id: actions[0].id, reason: 'only legal action' };
	const s = situationOf(view, seat, catalog, params);
	const scored: Scored[] = [];
	for (const action of actions) {
		const r = scoreAction(s, action, actions);
		if (r) scored.push({ action, score: r.score, why: r.why });
	}
	if (!scored.length) {
		const fallback =
			actions.find((a) => a.group === 'yield') ??
			actions.find((a) => {
				const c = a.command;
				return (
					(c.type === 'resolveDecision' || c.type === 'resolveNavigationPower') &&
					DECLINE.test(c.optionId)
				);
			}) ??
			actions[0];
		return { id: fallback.id, reason: 'default: nothing in the plan applies' };
	}
	// Highest score; ties keep the engine's order.
	let best = scored[0];
	for (const x of scored) if (x.score > best.score) best = x;
	return { id: best.action.id, reason: best.why };
}

function scoreAction(
	s: Situation,
	action: OfferedAction,
	all: OfferedAction[]
): { score: number; why: string } | null {
	const c = action.command;
	const p = s.params;
	switch (c.type) {
		// Yields: the baseline every other action must beat.
		case 'endLocationActions':
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
			return { score: 0, why: 'done' };
		case 'passEncounter':
			return { score: 1, why: 'no player attacks in this plan' };
		case 'initiatePvp':
			return { score: -100, why: 'no player attacks' };

		case 'lockNavigation': {
			const plan = destinationValue(s, c.destination, c.navigationPowerId ?? null);
			return {
				score: plan.value,
				why: `go to ${c.destination}: ${plan.why} (${plan.value.toFixed(2)})`
			};
		}
		case 'unlockNavigation':
			return null;

		case 'chooseNavigationPower': {
			let v = powerDraftValue(c.powerId, s);
			if (c.replacePowerId) v -= powerDraftValue(c.replacePowerId, s) + 0.01;
			return {
				score: 10 + v,
				why: `keep power ${c.powerId}${c.replacePowerId ? ` for ${c.replacePowerId}` : ''}`
			};
		}
		case 'resolveNavigationPower':
			return scorePowerOffer(s, c, action.label);
		case 'respondNavigationPowerTrade':
			return { score: c.accept ? -1 : 1, why: 'decline trades' };
		case 'tradeNavigationPower':
		case 'acquireNavigationPower':
			return null;

		case 'resolveLocationInteraction':
			return scoreLocationRow(s, action.label);

		case 'drawMonsterCards': {
			if ((s.me.monsterHand?.length ?? 0) >= 3) return null;
			const setup = currentFightSetup(s);
			// The best fight with a card already in hand (the draw does not block it).
			const inHand = Math.max(
				0,
				...(s.me.monsterHand ?? []).map((card) => fightValue(s, card, setup))
			);
			const fightNow = (v: number) => (v >= p.minFight && v > inHand ? v - inHand : 0);
			let v: number;
			if (c.permanent) {
				const lurker = s.view.permanentMonster;
				const f = lurker ? fightNow(fightValue(s, { ...lurker, hp: lurker.maxHp }, setup)) : 0;
				// Only a fight makes the Lurker worth taking (it is the visit's draw).
				v = f > 0 ? f : -0.5;
			} else {
				// A card held for later is worth something even when it cannot be fought now.
				v = Math.max(
					fightNow(drawFightValue(s, c.difficulty, setup)),
					holdValueOfDeck(s, c.difficulty)
				);
			}
			return {
				score: 5 + v,
				why: `draw ${c.permanent ? 'the Abyss Lurker' : `Difficulty ${c.difficulty}`} (${v.toFixed(2)})`
			};
		}
		case 'keepMonsterCard': {
			const card = s.me.pendingMonsterDraw?.cards?.[c.index];
			if (!card) return { score: 1, why: 'keep' };
			const v = Math.max(fightValue(s, card, currentFightSetup(s)), holdValue(s, card));
			return { score: 5 + v, why: `keep ${card.name} (${v.toFixed(2)})` };
		}
		case 'startCombat': {
			const card = s.me.monsterHand?.[c.handIndex];
			if (!card) return null;
			const setup = currentFightSetup(s);
			const v = fightValue(s, card, setup);
			if (v < p.minFight) return { score: -1, why: `do not fight ${card.name} (${v.toFixed(2)})` };
			return { score: 3 + v, why: `fight ${card.name} (${v.toFixed(2)})` };
		}
		case 'resolveMonsterReward':
			return scoreMonsterReward(s, c, all);

		case 'spawnHandSpirit':
			return scoreSummon(s, c);
		case 'discardHandDraws':
			return { score: 0.05, why: 'summon none' };
		case 'redrawHandDraws':
			return { score: -1, why: 'keep the draw' };

		case 'placeAugmentOnSpirit':
			return scoreAugmentPlacement(s, c);
		case 'discardUnplacedAugments':
			return { score: -0.5, why: 'discard unplaced augments' };

		case 'awakenSpirit':
		case 'manualAwaken': {
			const slot = c.slotIndex;
			const sp = s.me.spirits.find((x) => x.slotIndex === slot);
			if (!sp || !isFeSpirit(sp.classes)) return { score: -0.5, why: 'not a build spirit' };
			return { score: 2, why: `awaken ${sp.name}` };
		}

		case 'resolveDecision':
			return scoreDecision(s, c, action.label);
		case 'resolveAwakenReward': {
			// Cursed Spirit grants: Max Barrier while it is low, else dice.
			const mb =
				(c.taintedMaxBarrier ?? 0) + (c.corruptMaxBarrier ?? 0) + (c.fallenMaxBarrier ?? 0);
			const pref = s.me.maxBarrier < 10 ? mb : -mb;
			return { score: 2 + 0.01 * pref, why: 'claim the Awakening-phase grant' };
		}

		case 'discardSpirit': {
			// Only to pay a corruption: the spirit the build needs least.
			if (!((s.me.pendingCorruptionDiscard?.count ?? 0) > 0)) return null;
			const v = keepValue(s, c.slotIndex);
			return { score: 10 - v, why: `sacrifice slot ${c.slotIndex}` };
		}
		case 'discardRune': {
			// Only down to the carry limit of 4: the least useful item.
			const held = (s.me.mats ?? []).filter((m) => m?.hasRune).length;
			if (held <= 4) return null;
			const m = s.me.mats?.find((x) => x.slotIndex === c.slotIndex);
			return { score: 10 - matKeepValue(m), why: `discard ${m?.name ?? 'item'}` };
		}
		default:
			return null;
	}
}

/** A fight at full Barrier with today's dice: what a card held for a later visit is worth. */
function laterSetup(s: Situation): FightSetup {
	return { ...baseSetup(s), barrier: s.me.maxBarrier };
}

function holdValueOfDeck(s: Situation, d: 1 | 2 | 3): number {
	if (deckLeft(s, d) < 1) return -1;
	if (s.params.hold <= 0) {
		const mean =
			deckCards(s, d).reduce((n, c) => n + cardVp(c), 0) / Math.max(1, deckCards(s, d).length);
		return 0.05 * mean;
	}
	return s.params.hold * Math.max(0, drawFightValue(s, d, laterSetup(s)));
}

function holdValue(s: Situation, card: MonsterState): number {
	if (s.params.hold <= 0) return 0.05 * cardVp(card) - 0.02 * card.hp;
	return s.params.hold * Math.max(0, fightValue(s, card, laterSetup(s)));
}

/** The setup of a fight started now (the committed power is already applied by the engine,
 *  except the per-battle ones, which apply when the battle starts). */
function currentFightSetup(s: Situation): FightSetup {
	const power = s.me.navigationPower ?? null;
	// The committed battle power applies to the first battle (its "use" offer is answered first).
	const enabled = !!power && !s.me.navigationPowerBattleTriggered;
	return {
		tiers: s.tiers,
		barrier: s.me.barrier,
		reduction: (s.me.damageReduction ?? 0) + (enabled && power === 'battle-guard' ? 4 : 0),
		strikeFirst:
			s.me.alwaysAttackFirst === true ||
			(s.me.strikeFirstCharges ?? 0) > 0 ||
			(enabled && power === 'sudden-strike'),
		extraArcane: enabled && power === 'battle-fury' ? 2 : 0
	};
}

function matKeepValue(
	m: { name?: string; relicTool?: boolean; special?: boolean } | undefined
): number {
	if (!m) return 0;
	if (m.relicTool) {
		if (/firecracker/i.test(m.name ?? '')) return 1.5;
		if (/diamond/i.test(m.name ?? '')) return 1.4;
		if (/flower/i.test(m.name ?? '')) return 0.8;
		return 0.3;
	}
	if (m.special) return 0.2;
	return 0.7;
}

function scoreLocationRow(s: Situation, label: string): { score: number; why: string } | null {
	const p = s.params;
	if (/Rest\b/.test(label)) {
		const v = restValue(s);
		return { score: v + 0.05, why: `rest (${v.toFixed(2)})` };
	}
	if (/Spirit World Summon/.test(label)) return { score: 1, why: 'summon' };
	if (/Cultivate/.test(label)) return { score: 0.5 + cultivateValue(s), why: 'cultivate' };
	const aug = /gain (\w+) Spirit Augment/.exec(label)?.[1];
	if (aug) {
		if (aug !== 'Fighter' && aug !== 'Elementalist') return null;
		const v = augmentValue(s, 1, aug);
		const cost = p.rune;
		return v > cost ? { score: v - cost + 0.1, why: `buy a ${aug} augment` } : null;
	}
	if (/random Power/i.test(label)) {
		const v = p.randomPower - p.rune;
		return v > 0 || s.runes > 3 ? { score: Math.max(0.05, v), why: 'buy a random power' } : null;
	}
	if (/replace/i.test(label)) {
		// Replace a weak held power with a choice of 3.
		const held = s.me.powerInventory ?? [];
		if (!held.length) return null;
		const v = replaceValue(s) - p.rune * 0.5;
		return v > 0 ? { score: v, why: 'replace a weak power (keep 1 of 3)' } : null;
	}
	return null;
}

function scorePowerOffer(
	s: Situation,
	c: Extract<GameCommand, { type: 'resolveNavigationPower' }>,
	label: string
): { score: number; why: string } {
	const offer = s.me.navigationPowerOffers?.find((o) => o.id === c.offerId);
	const opt = offer?.options.find((o) => o.id === c.optionId);
	const text = `${opt?.label ?? ''} ${label}`;
	const decline = DECLINE.test(c.optionId) || /decline|do not|don't/i.test(opt?.label ?? '');
	// Stone Shelter (another player's power) takes one of our runes: give the least useful.
	if (offer?.powerId === 'stone-shelter' || /steal/i.test(offer?.prompt ?? '')) {
		return { score: decline ? 0 : 1, why: 'answer Stone Shelter' };
	}
	// Augment choices: the class the build needs.
	const want = nextAugmentClass(s);
	if (/augment/i.test(text) && want && new RegExp(want, 'i').test(opt?.label ?? ''))
		return { score: 21, why: `take a ${want} augment` };
	// Rune choices: any rune pays for this build.
	if (decline) return { score: 0.5, why: 'decline' };
	// Answer power offers before anything else at the location (a battle power must be on first).
	return { score: 20, why: `use ${offer?.powerId ?? 'power'}` };
}

function scoreMonsterReward(
	s: Situation,
	c: Extract<GameCommand, { type: 'resolveMonsterReward' }>,
	all: OfferedAction[]
): { score: number; why: string } {
	const reward = s.me.pendingReward;
	if (!reward) return { score: 1, why: 'claim' };
	const vp = buildMonsterRewards(reward.rewardTrack).reduce(
		(n, r) => n + (r.effect.type === 'vp' ? r.effect.amount : 0),
		0
	);
	if (c.arcaneBlood) {
		const blood = reward.arcaneBlood ?? 0;
		const gain = expectedAttack(s, diceAfter(s.tiers, 0, blood)) - expectedAttack(s, s.tiers);
		const v =
			s.elementalist >= 2 &&
			s.me.victoryPoints <= s.params.bloodMaxVp &&
			s.me.victoryPoints + vp < 30
				? gain * bloodWeight(s)
				: -1;
		return { score: 1 + v - vp, why: `take ${blood} Arcane Blood` };
	}
	// The Lurker (one reward): the point, not the summon.
	if (reward.chooseOne) {
		const pick = c.picks?.[0] ?? 0;
		const r = buildMonsterRewards(reward.rewardTrack).find((x) => x.index === pick);
		return { score: r?.effect.type === 'vp' ? 1.2 : 0.8, why: 'claim the point' };
	}
	void all;
	return { score: 1, why: `claim ${vp} points and the card's rewards` };
}

function scoreSummon(
	s: Situation,
	c: Extract<GameCommand, { type: 'spawnHandSpirit' }>
): { score: number; why: string } | null {
	const draw = s.me.handDraws?.find((h) => h.guid === c.guid);
	if (!draw) return null;
	if (draw.rewardId || draw.rewardLabel) {
		const l = draw.rewardLabel ?? '';
		let v = 0.3;
		if (/rune/i.test(l)) v = s.params.rune;
		else if (/power/i.test(l)) v = s.params.randomPower + 0.2;
		else if (/barrier/i.test(l))
			v = healValue(s, s.me.barrier, Math.min(2, s.me.maxBarrier - s.me.barrier)) + 0.05;
		return { score: v, why: `take ${l || 'the reward'}` };
	}
	const spirit = s.catalog.spirits.find((x) => x.id === draw.id || x.name === draw.name);
	if (s.me.pendingDraw?.sourceBag === 'Arcane Abyss Bag')
		return { score: -0.2, why: 'arcane spirit' };
	if (!spirit || !isFeSpirit(spirit.classes)) {
		// Another class: only into a free slot, as a host for augments the build still needs.
		const free = MAX_SLOTS - (s.me.spirits?.length ?? 0);
		if (c.replaceSlotIndex === undefined && free > 0 && augmentHosts(s.me) < classNeed(s))
			return { score: s.params.host, why: `summon ${draw.name ?? 'a spirit'} as an augment host` };
		return { score: -0.2, why: 'not a build spirit' };
	}
	const gain = classGain(s, spirit.classes.Fighter ?? 0, spirit.classes.Elementalist ?? 0);
	let v = gain + 0.3;
	if (c.replaceSlotIndex !== undefined) v -= keepValue(s, c.replaceSlotIndex) + 0.1;
	if (gain <= 0) v = c.replaceSlotIndex !== undefined ? -1 : 0.1;
	return { score: v, why: `summon ${spirit.name}` };
}

function scoreAugmentPlacement(
	s: Situation,
	c: Extract<GameCommand, { type: 'placeAugmentOnSpirit' }>
): { score: number; why: string } {
	const cls = c.className ?? '';
	const sp = s.me.spirits.find((x) => x.slotIndex === c.spiritSlotIndex);
	let v =
		cls === 'Fighter'
			? fighterStep(s, s.fighter)
			: cls === 'Elementalist'
				? elementalistStep(s, s.elementalist)
				: -0.2;
	if (v <= 0) v = cls === 'Fighter' || cls === 'Elementalist' ? 0.01 : -0.2;
	// Prefer hosts that stay: build spirits, then the more valuable others; never face-down ones.
	if (sp?.isFaceDown) v -= 1;
	else if (sp && isFeSpirit(sp.classes)) v += 0.3;
	else if (sp) v += 0.05 * sp.cost;
	return { score: 1 + v, why: `place a ${cls} augment on ${sp?.name ?? 'a spirit'}` };
}

function scoreDecision(
	s: Situation,
	c: Extract<GameCommand, { type: 'resolveDecision' }>,
	label: string
): { score: number; why: string } {
	const card = s.me.pendingDecisions?.find((d) => d.id === c.decisionId);
	const opt = card?.options.find((o) => o.id === c.optionId);
	const text = `${card?.prompt ?? ''} ${opt?.label ?? ''} ${label}`;
	const id = c.optionId;
	// Relic tools: keep / points / effect.
	if (/^vp:/.test(id)) return { score: 3, why: 'relic for points' };
	if (/^effect:/.test(id) || /^awaken:/.test(id)) {
		if (/flower/i.test(text))
			return { score: s.me.barrier < s.me.maxBarrier ? 2 : 0, why: 'use Flower' };
		if (/diamond/i.test(text))
			return { score: nextAugmentClass(s) && augmentHosts(s.me) > 0 ? 2 : 0, why: 'use Diamond' };
		if (/firecracker/i.test(text))
			return { score: 2, why: 'use Firecracker (strike first next fight)' };
		return { score: 0.2, why: 'use relic' };
	}
	if (/^keep:/.test(id)) return { score: 1, why: 'keep relic' };
	// Augment class choices (Fighter (5) "1 of any spirit augment" and similar).
	const want = nextAugmentClass(s);
	if (want && new RegExp(`\\b${want}\\b`, 'i').test(opt?.label ?? ''))
		return { score: 2, why: `choose ${want}` };
	if (DECLINE.test(id) || /^no\b/i.test(opt?.label ?? '')) return { score: 0.5, why: 'decline' };
	return { score: 0.4, why: 'default option' };
}
