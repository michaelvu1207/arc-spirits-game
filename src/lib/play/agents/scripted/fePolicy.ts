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
import {
	ELEMENTALIST_METHOD_AT,
	elementalistKillUpgrades,
	elementalistRestUpgrades,
	elementalistUpgradesPerAction,
	holdsRelic
} from '../../effects/classes/elementalist';
import { CLASS_ABILITIES } from '../../effects/abilities';
import { CLASS_EFFECTS, selectBreakpoint, type EffectTrigger } from '../../effects/registry';
import { ORIGIN_REWARDS, spiritsByOrigin } from '../../effects/relicTools';
import { isRelic, meaningFor } from '../../locationInteractions';
import { buildMonsterRewards } from '../../monsterRewards';
import {
	elementalistUpgradeAction,
	restBarrier,
	ruleAdjustedActions,
	ruleValue
} from '../../rules';
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
import { MAX_ATTACK_DICE } from '../../types';
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
	/** Value of one Max Barrier below / above what the hardest monster hit still to come needs. */
	maxBarrierLow: number;
	maxBarrierHigh: number;
	/** Weight of the chance to find a Max Barrier power with a Mountain replace while Max Barrier is below what the hardest monster hit needs. */
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
	/** Rules where a relic raises the Elementalist Rest step (`elementalist5NeedsRelic`): points per
	 *  extra upgrade per Rest that holding a relic gives, at full use (scaled down by the upgrade room
	 *  left and by how far the Elementalist count is from the step). */
	relic: number;
	/** Weight on summoning toward 5 spirits of one origin (a Cultivate then takes its relic) while
	 *  no relic is held. 0: no chase. */
	originChase: number;
	/** Multiplier on the value of Cultivator traits (Max Barrier on Cultivate). */
	cultivator: number;
	/** Use a held relic tool that the Elementalist step needs only when its effect is worth this
	 *  multiple of the relic's value. */
	relicUse: number;
	/** Multiplier on the dice value of a Rest while Fighter is below 5 (a Rest pays more once the
	 *  build is done; below 1 builds first). */
	restBuilding: number;
	/** 1: a class step is worth the best average of the steps up to a later breakpoint; 0: its own. */
	lookahead: number;
	/** 1: a Spirit World Summon also counts the chance of a Cultivator spirit once Fighter and
	 *  Elementalist are complete; 0: only while they are not. */
	summonCultivator: number;
	/** Multiplier on the value of the Elementalist upgrades a Cultivate gives (the Rest / Cultivate
	 *  split when the ladder is on Cultivate). */
	upgradeScale: number;
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
	powerKeep: 0.6,
	relic: 2,
	originChase: 1,
	cultivator: 1,
	relicUse: 3,
	restBuilding: 1,
	lookahead: 1,
	summonCultivator: 1,
	upgradeScale: 1
};

export interface FeChoice {
	id: string;
	reason: string;
}

const TARGET = 5;
const MAX_DICE = MAX_ATTACK_DICE;
/** The engine's Max Barrier cap (effects/actions.ts `gainMaxBarrier`). */
const MB_CAP = 10;
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
	cultivator: number;
	tiers: DiceTier[];
	runes: number;
	/** Relics held (any relic, as the engine's `holdsRelic` counts them). */
	relics: number;
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
		cultivator: counts.Cultivator ?? 0,
		tiers: (me.attackDice ?? []).map((d: AttackDie) => d.tier),
		runes: basicRuneCount(me),
		relics: (me.mats ?? []).filter((m) => m?.hasRune && isRelic(m)).length,
		faces,
		mean
	};
}

// ───────────────────────────── rules, read from the engine ─────────────────────────────
//
// Every number the build depends on comes from the engine: the class breakpoints (with the rule
// switches that change their amounts), the Elementalist helpers, the Rest heal and the dice faces.
// Nothing here assumes a rule set.

/** Sum of the `kind` amounts a class gives on `trigger` at `count` traits, under the catalog's rules
 *  (the engine's declarative breakpoints, with `ruleAdjustedActions`). */
export function classAmount(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	className: string,
	trigger: EffectTrigger,
	count: number,
	kind: string
): number {
	if (count <= 0) return 0;
	let n = 0;
	for (const effect of CLASS_EFFECTS[className] ?? []) {
		if (effect.trigger !== trigger) continue;
		const sel = selectBreakpoint(effect.breakpoints, count);
		if (!sel) continue;
		for (const a of ruleAdjustedActions(catalog, className, sel.bp.count, sel.bp.actions)) {
			if (a.kind !== kind) continue;
			const amount = (a as { amount?: number }).amount;
			n += (typeof amount === 'number' ? amount : 1) * sel.multiplier;
		}
	}
	return n;
}

/** Basic Attack dice a Rest gives at this Fighter count (as the engine computes them). */
export function restDice(fighter: number, catalog?: Pick<PlayCatalog, 'rules'> | null): number {
	return classAmount(catalog, 'Fighter', 'onRest', fighter, 'gainAttackDice');
}

/** Spirit Augments a Rest gives at this Fighter count. */
function restAugments(s: Situation, fighter = s.fighter): number {
	return classAmount(s.catalog, 'Fighter', 'onRest', fighter, 'gainAugment');
}

/** Max Barrier a Cultivate gives at this Cultivator count. */
export function cultivateMaxBarrier(
	cultivator: number,
	catalog?: Pick<PlayCatalog, 'rules'> | null
): number {
	return classAmount(catalog, 'Cultivator', 'onCultivate', cultivator, 'gainMaxBarrier');
}

/** The Cultivator count whose Cultivate offers a relic of choice (engine: cultivator.ts, 5). */
const CULTIVATOR_RELIC_AT = 5;

const RELIC_MATS = [{ hasRune: true, type: 'relic' as const, slotIndex: 0 }];
const NO_MATS: never[] = [];

/** Upgrades of the engine's default Elementalist rule (no switch on) for one Rest: runs the class's
 *  own onRest ability on a scratch player. */
function defaultRestUpgrades(catalog: PlayCatalog, count: number): number {
	try {
		const player = {
			attackDice: new Array(10).fill(0).map((_, i) => ({ instanceId: `d${i}`, tier: 'basic' })),
			mats: [],
			pendingDecisions: []
		} as unknown as PrivatePlayerState;
		const ctx = {
			state: { players: {}, rng: { seed: 1, counter: 0 } },
			seat: 'Red',
			player,
			catalog,
			log: [] as string[],
			trigger: 'onRest',
			traitCount: count,
			colocated: []
		};
		for (const ab of CLASS_ABILITIES.Elementalist ?? []) {
			if (ab.on === 'onRest' && ab.run) ab.run(ctx as never);
		}
		return upgradeLevel(player.attackDice.map((d) => d.tier));
	} catch {
		return 0;
	}
}

export type UpgradeAction = 'rest' | 'cultivate' | 'summon' | 'kill';

/**
 * Dice upgrades Elementalist gives for one action at `count` Elementalists, as the engine's rule
 * switches decide (`elementalistRest1235`, `elementalist5NeedsRelic`, `elementalistMethods`,
 * `elementalistOneUpgrade`, `elementalistBigKills`, `arcaneBlood`). `relic`: whether the player
 * holds a relic at that time.
 */
export function elementalistUpgrades(
	catalog: PlayCatalog,
	action: UpgradeAction,
	count: number,
	relic: boolean,
	kill?: { difficulty?: number; permanent?: boolean }
): number {
	// The ladder rule: one action upgrades (Rest, or Cultivate under `elementalistOnCultivate`).
	const ladderAction = elementalistUpgradeAction(catalog);
	if (ladderAction) {
		if (action !== ladderAction) return 0;
		return elementalistRestUpgrades(catalog, count, {
			mats: relic ? RELIC_MATS : NO_MATS
		} as never);
	}
	if (ruleValue(catalog, 'elementalistMethods')) {
		const key =
			action === 'summon' ? 'spiritWorldSummon' : action === 'kill' ? 'monsterKill' : action;
		if (count < ELEMENTALIST_METHOD_AT[key]) return 0;
		if (action === 'kill') {
			// Under Arcane Blood a kill upgrades nothing by itself (the blood does, see bloodValue).
			if (ruleValue(catalog, 'arcaneBlood')) return 0;
			return elementalistKillUpgrades(catalog, {
				monsterDifficulty: (kill?.difficulty ?? 1) as 1 | 2 | 3,
				monsterPermanent: !!kill?.permanent
			});
		}
		return elementalistUpgradesPerAction(catalog);
	}
	return action === 'rest' ? defaultRestUpgrades(catalog, count) : 0;
}

/** Upgrades per Arcane Blood gained (the engine: Elementalist (2) under `elementalistMethods`,
 *  not under `elementalistRest1235`). */
function upgradesPerBlood(s: Situation): number {
	const c = s.catalog;
	if (!ruleValue(c, 'arcaneBlood') || !ruleValue(c, 'elementalistMethods')) return 0;
	if (ruleValue(c, 'elementalistRest1235')) return 0;
	return s.elementalist >= ELEMENTALIST_METHOD_AT.monsterKill ? 1 : 0;
}

/** Extra upgrades per upgrading action (Rest or Cultivate, as the rules say) a held relic gives at
 *  `count` Elementalists (0 unless the rules gate a step on a relic). */
export function relicRestGain(catalog: PlayCatalog, count: number): number {
	const action = elementalistUpgradeAction(catalog) ?? 'rest';
	return (
		elementalistUpgrades(catalog, action, count, true) -
		elementalistUpgrades(catalog, action, count, false)
	);
}

/** Summed tier level of dice (Basic 0, Enchanted 1, Exalted 2). */
function upgradeLevel(tiers: DiceTier[]): number {
	return tiers.reduce((n, t) => n + (t === 'enchanted' ? 1 : t === 'exalted' ? 2 : 0), 0);
}

/**
 * What one relic held now is worth to the build: the extra Rest upgrades it unlocks, scaled by the
 * upgrade room still left on a full set of dice and by how close the Elementalist step is.
 * 0 when the rules give a relic no Rest value.
 */
export function relicWorth(s: Situation): number {
	const gain = relicRestGain(s.catalog, Math.max(TARGET, s.elementalist));
	if (gain <= 0) return 0;
	const room = 2 * MAX_DICE - upgradeLevel(s.tiers.filter((t) => t !== 'arcane'));
	if (room <= 0) return 0;
	const near =
		s.elementalist >= TARGET
			? 1
			: s.elementalist >= TARGET - 1
				? 0.8
				: s.elementalist >= 2
					? 0.5
					: 0.3;
	return s.params.relic * gain * Math.min(1, room / (2 * MAX_DICE)) * near;
}

/** Value lost if the player gives up one relic now (only the last relic counts). */
function lastRelicLoss(s: Situation): number {
	return s.relics <= 1 ? relicWorth(s) : 0;
}

// ───────────────────────────── build model ─────────────────────────────

const FIGHTER_STEPS = [0.4, 3, 2, 1.6, 2.4];
const ELEMENTALIST_STEPS = [0.4, 2, 2.4, 1.2, 0.9];

/** Value of one more trait at count `c` on a ladder of step values. With `lookahead`, a step that
 *  opens a later breakpoint is worth the best average of the steps up to it (so a first Fighter,
 *  which does little by itself, is worth its share of the second). */
function ladderStep(s: Situation, steps: number[], c: number): number {
	const own = steps[c] ?? 0;
	if (!s.params.lookahead || own <= 0) return own * s.params.classScale;
	let best = own;
	let sum = 0;
	for (let k = c; k < steps.length; k++) {
		sum += steps[k];
		best = Math.max(best, sum / (k - c + 1));
	}
	return best * s.params.classScale;
}

/** Value of one more Fighter (+1) at this count. */
function fighterStep(s: Situation, f: number): number {
	return ladderStep(s, FIGHTER_STEPS, f);
}
/** Value of one more Elementalist (+1) at this count. */
function elementalistStep(s: Situation, e: number): number {
	return ladderStep(s, ELEMENTALIST_STEPS, e);
}

/**
 * Value of one more Cultivator (+1) at this count: the Max Barrier its Cultivates add (the engine's
 * Cultivator ladder) while Max Barrier is below what the strongest monsters need. Worth nothing once
 * Max Barrier is there.
 */
function cultivatorStep(s: Situation, c: number): number {
	if (s.params.cultivator <= 0) return 0;
	const room = Math.max(0, mbTarget(s) - s.me.maxBarrier);
	if (room <= 0) return 0;
	// The Max Barrier of the next two Cultivates with one more trait, against without it (capped
	// at what is still needed); each Cultivate costs a round, so half value.
	const k = 2;
	const gain =
		Math.min(room, k * cultivateMaxBarrier(c + 1, s.catalog)) -
		Math.min(room, k * cultivateMaxBarrier(c, s.catalog));
	if (gain <= 0) {
		// The first trait opens the second one's breakpoint.
		const next = Math.min(room, k * cultivateMaxBarrier(c + 2, s.catalog));
		return next > 0 && cultivateMaxBarrier(c + 1, s.catalog) === 0
			? 0.25 * s.params.cultivator * next * s.params.maxBarrierLow
			: 0;
	}
	return s.params.cultivator * 0.5 * gain * s.params.maxBarrierLow;
}

export type BuildClass = 'Fighter' | 'Elementalist' | 'Cultivator';
const BUILD_CLASSES: BuildClass[] = ['Fighter', 'Elementalist', 'Cultivator'];

function countOf(s: Situation, cls: BuildClass): number {
	return cls === 'Fighter' ? s.fighter : cls === 'Elementalist' ? s.elementalist : s.cultivator;
}

function stepOf(s: Situation, cls: string, at: number): number {
	if (cls === 'Fighter') return fighterStep(s, at);
	if (cls === 'Elementalist') return elementalistStep(s, at);
	if (cls === 'Cultivator') return cultivatorStep(s, at);
	return 0;
}

/** Value of adding these class traits (Fighter, Elementalist, Cultivator; others count nothing). */
function classGain(s: Situation, classes: Record<string, number> | undefined): number {
	let v = 0;
	for (const cls of BUILD_CLASSES) {
		const n = classes?.[cls] ?? 0;
		for (let i = 0; i < n; i++) v += stepOf(s, cls, countOf(s, cls) + i);
	}
	return v;
}

/** The best class for the next augment (null when none adds anything). */
export function nextAugmentClass(s: Situation): BuildClass | null {
	let best: BuildClass | null = null;
	let bestV = 0;
	for (const cls of BUILD_CLASSES) {
		const v = stepOf(s, cls, countOf(s, cls));
		if (v > bestV) {
			best = cls;
			bestV = v;
		}
	}
	return best;
}

function isFeSpirit(classes: Record<string, number> | undefined): boolean {
	return !!classes && BUILD_CLASSES.some((c) => (classes[c] ?? 0) > 0);
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
	// What the build loses without it.
	for (const cls of BUILD_CLASSES) {
		const n = sp.isFaceDown ? 0 : (sp.classes?.[cls] ?? 0);
		for (let i = 0; i < n; i++)
			v += stepOf(s, cls, Math.max(0, Math.min(4, countOf(s, cls) - 1 - i)));
	}
	if (aug && BUILD_CLASSES.includes(aug.className as BuildClass))
		v += stepOf(
			s,
			aug.className!,
			Math.max(0, Math.min(4, countOf(s, aug.className as BuildClass) - 1))
		);
	else if (aug) v += 0.2;
	else if (!sp.isFaceDown && classNeed(s) > 0) v += s.params.host * 0.5; // a free host
	// Spirits of the origin the relic chase counts on.
	v += originKeep(s, sp.origins);
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

/** Points value of a kill of this card for this seat (points, or Arcane Blood upgrades; plus the
 *  upgrades a kill itself gives under the rules where it does). */
export function killValue(s: Situation, card: MonsterState): number {
	const vp = cardVp(card) + cardExtras(s, card);
	const up = elementalistUpgrades(s.catalog, 'kill', s.elementalist, s.relics > 0, card);
	const upV = up > 0 ? diceValueDelta(s, s.tiers, diceAfter(s.tiers, 0, up)) : 0;
	return Math.max(vp, bloodValue(s, card)) + upV;
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
	const per = upgradesPerBlood(s);
	if (per <= 0) return 0;
	if (s.me.victoryPoints > s.params.bloodMaxVp) return 0;
	const blood = (arcaneBloodFor(card, s.catalog) ?? 0) * per;
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
		// `me.damageReduction` and `me.alwaysAttackFirst` are per-combat flags that stay set after a
		// fight until the next one starts (combat.ts, `resetCombatFlags`): they say nothing about
		// the next fight, so they are not read here.
		reduction: 0,
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
	const heal = restBarrier(s.catalog, s.me.statusLevel ?? 0);
	return Math.max(0, Math.min(s.me.maxBarrier, barrier + heal) - barrier);
}

/** Dice after a Rest: the Fighter dice, then the Elementalist upgrades (relic held or not). */
function tiersAfterRest(s: Situation, tiers = s.tiers): DiceTier[] {
	return diceAfter(
		tiers,
		restDice(s.fighter, s.catalog),
		elementalistUpgrades(s.catalog, 'rest', s.elementalist, s.relics > 0)
	);
}

function diceValueDelta(s: Situation, before: DiceTier[], after: DiceTier[]): number {
	const low = 1 + s.params.attackLow * Math.max(0, 1 - expectedAttack(s, before) / 4);
	return (expectedAttack(s, after) - expectedAttack(s, before)) * s.params.attack * low;
}

/** Monster hits still to come: the damage of every card in the decks that are not empty and in hand. */
function hitsAhead(s: Situation): number[] {
	const out: number[] = [];
	for (const d of [1, 2, 3] as const)
		if (deckLeft(s, d) > 0) for (const c of deckCards(s, d)) out.push(c.damage);
	for (const c of s.me.monsterHand ?? []) out.push(c.damage);
	if (!out.length)
		for (const d of [1, 2, 3] as const) for (const c of deckCards(s, d)) out.push(c.damage);
	return out;
}

/** The Max Barrier that takes the hardest hit still to come and strikes back (the hit must be lower
 *  than the Barrier), from the catalog's monster cards. */
function mbTarget(s: Situation): number {
	const hits = hitsAhead(s);
	return Math.min(MB_CAP, (hits.length ? Math.max(...hits) : 0) + 1);
}

/** How ready a Barrier is to take a monster's hit: the share of the monster cards still to come
 *  whose hit is lower than it. */
function readiness(s: Situation, barrier: number): number {
	const hits = hitsAhead(s);
	if (!hits.length) return 1;
	return hits.filter((h) => h < barrier).length / hits.length;
}

function healValue(s: Situation, from: number, heal: number): number {
	if (heal <= 0) return 0;
	return (readiness(s, from + heal) - readiness(s, from)) * s.params.ready;
}

function restValue(s: Situation, barrier = s.me.barrier, tiers = s.tiers): number {
	const after = tiersAfterRest(s, tiers);
	const building = s.fighter < TARGET ? s.params.restBuilding : 1;
	let v = diceValueDelta(s, tiers, after) * building + healValue(s, barrier, restHeal(s, barrier));
	const augs = restAugments(s);
	if (augs > 0) v += augmentValue(s, augs);
	return v;
}

/** Value of `n` augments of the class the build needs most (each needs a free host); `only`
 *  limits the classes to choose from. */
function augmentValue(s: Situation, n: number, only?: BuildClass[]): number {
	const hosts = augmentHosts(s.me);
	const at: Record<BuildClass, number> = {
		Fighter: s.fighter,
		Elementalist: s.elementalist,
		Cultivator: s.cultivator
	};
	let v = 0;
	for (let i = 0; i < Math.min(n, hosts); i++) {
		let best: BuildClass | null = null;
		let bestV = 0;
		for (const cls of only ?? BUILD_CLASSES) {
			const x = stepOf(s, cls, at[cls]);
			if (x > bestV) {
				best = cls;
				bestV = x;
			}
		}
		if (!best) break;
		v += bestV;
		at[best]++;
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
		if (sp && classGain(s, sp.classes) > 0) good += row.count;
	}
	if (total <= 0 || good <= 0) return 0;
	let pNone = 1;
	for (let i = 0; i < spirits && total - i > 0; i++)
		pNone *= Math.max(0, total - good - i) / (total - i);
	return 1 - pNone;
}

function summonValue(s: Situation, drawSize = 4): number {
	let v = 0;
	// A spirit of a class the build still gains from (Cultivator too, after Fighter and
	// Elementalist are done: Max Barrier).
	const step = Math.max(...BUILD_CLASSES.map((c) => stepOf(s, c, countOf(s, c))));
	if (classNeed(s) > 0 || s.params.summonCultivator) v += pBuildSpirit(s, drawSize - 1) * step;
	if (classNeed(s) > 0) {
		// A spare spirit as a host for the augments still needed.
		const free = MAX_SLOTS - (s.me.spirits?.length ?? 0);
		if (free > 0 && augmentHosts(s.me) < classNeed(s)) v += s.params.host;
	}
	v += s.params.rune * 0.8; // the reward hex
	const up = elementalistUpgrades(s.catalog, 'summon', s.elementalist, s.relics > 0);
	if (up > 0) v += diceValueDelta(s, s.tiers, diceAfter(s.tiers, 0, up));
	// The chance to add a spirit of the origin the relic chase counts on.
	v += originChaseValue(s) * 0.5;
	return v;
}

/** Whether the origin's Cultivate relic is still open to this player. */
function originRelicOpen(s: Situation, origin: string): boolean {
	return !!ORIGIN_REWARDS[origin] && !(s.me.originRelicsGained ?? []).includes(origin);
}

/** Spirits per origin (the engine's count: every spirit, awake or not). */
function originCounts(s: Situation): Record<string, number> {
	return spiritsByOrigin(s.me.spirits ?? []);
}

/** The origin closest to its relic (open, most spirits) and its spirit count. */
function chaseOrigin(s: Situation): { origin: string; count: number } | null {
	let best: { origin: string; count: number } | null = null;
	for (const [origin, n] of Object.entries(originCounts(s))) {
		if (!originRelicOpen(s, origin)) continue;
		if (!best || n > best.count) best = { origin, count: n };
	}
	return best;
}

/** Share of the relic's worth that one more spirit of `origin` (now `n` spirits) brings: most for
 *  the spirit that reaches the relic count. */
function originStep(origin: string, n: number): number {
	const at = ORIGIN_REWARDS[origin]?.relicAt;
	if (!at || n >= at) return 0;
	return [0.5, 0.3, 0.15][at - (n + 1)] ?? 0.05;
}

/** Value of the relic chase for one more spirit of the best open origin (0 while a relic is held). */
function originChaseValue(s: Situation): number {
	if (s.params.originChase <= 0 || s.relics > 0) return 0;
	const c = chaseOrigin(s);
	if (!c) return 0;
	return s.params.originChase * relicWorth(s) * originStep(c.origin, c.count);
}

/** Value of a spirit (or its origins) for the relic chase. */
function originGain(s: Situation, origins: Record<string, number> | undefined): number {
	if (s.params.originChase <= 0 || s.relics > 0 || !origins) return 0;
	const counts = originCounts(s);
	const worth = relicWorth(s);
	let v = 0;
	for (const [o, n] of Object.entries(origins)) {
		if (!(n > 0) || !originRelicOpen(s, o)) continue;
		v = Math.max(v, s.params.originChase * worth * originStep(o, counts[o] ?? 0));
	}
	return v;
}

/** Value lost for the relic chase if a spirit of these origins leaves. */
function originKeep(s: Situation, origins: Record<string, number> | undefined): number {
	if (s.params.originChase <= 0 || s.relics > 0 || !origins) return 0;
	const counts = originCounts(s);
	const worth = relicWorth(s);
	let v = 0;
	for (const [o, n] of Object.entries(origins)) {
		if (!(n > 0) || !originRelicOpen(s, o)) continue;
		v = Math.max(
			v,
			s.params.originChase * worth * originStep(o, Math.max(0, (counts[o] ?? 1) - 1))
		);
	}
	return v;
}

function cultivateValue(s: Situation): number {
	let v = 0;
	const up = elementalistUpgrades(s.catalog, 'cultivate', s.elementalist, s.relics > 0);
	if (up > 0) v += diceValueDelta(s, s.tiers, diceAfter(s.tiers, 0, up)) * s.params.upgradeScale;
	// Cultivator: Max Barrier (capped), and its relic of choice.
	const mb = Math.min(cultivateMaxBarrier(s.cultivator, s.catalog), MB_CAP - s.me.maxBarrier);
	if (mb > 0) v += maxBarrierValue(s, mb) + healValue(s, s.me.barrier, mb);
	let relicTaken = false;
	if (
		s.cultivator >= CULTIVATOR_RELIC_AT &&
		!(ruleValue(s.catalog, 'cultivatorRelicOnce') && s.me.cultivatorRelicGained)
	) {
		v += Math.max(s.params.rune, s.relics > 0 ? 0 : relicWorth(s));
		relicTaken = true;
	}
	// Origin rewards: 3+ spirits a rune; 5+ the rune or the relic (once per origin).
	for (const [origin, n] of Object.entries(originCounts(s))) {
		const reward = ORIGIN_REWARDS[origin];
		if (!reward || n < reward.runeAt) continue;
		if (n >= reward.relicAt && originRelicOpen(s, origin) && !relicTaken && s.relics === 0) {
			v += Math.max(s.params.rune, relicWorth(s));
			relicTaken = true;
		} else v += s.params.rune;
	}
	return v;
}

const augmentRowCache = new WeakMap<PlayCatalog, Map<string, BuildClass[]>>();

/** The build classes whose Spirit Augment a location's trade rows sell (from the catalog). */
function augmentRow(s: Situation, dest: string): BuildClass[] {
	let byDest = augmentRowCache.get(s.catalog);
	if (!byDest) {
		byDest = new Map();
		for (const loc of s.catalog.locations ?? []) {
			const out = new Set<BuildClass>();
			for (const row of loc.rewardRows ?? []) {
				if (row.type !== 'trade') continue;
				const ids = (row.gain_icon_ids ?? []).flatMap((g: unknown) =>
					typeof g === 'string' ? [g] : ((g as { icon_ids?: string[] })?.icon_ids ?? [])
				);
				for (const id of ids) {
					const m = meaningFor(id);
					if (!m || !/augment/i.test(m.label)) continue;
					const name = 'runeName' in m ? m.runeName : '';
					if (BUILD_CLASSES.includes(name as BuildClass)) out.add(name as BuildClass);
				}
			}
			byDest.set(loc.name, [...out]);
		}
		augmentRowCache.set(s.catalog, byDest);
	}
	return byDest.get(dest) ?? [];
}

/** Value of spending runes at a location's trade row. */
function runeSpendValue(s: Situation, dest: string, runes = s.runes): number {
	if (runes <= 0) return 0;
	const row = augmentRow(s, dest);
	if (row.length) return Math.max(0, augmentValue(s, runes, row) - runes * s.params.rune);
	if (dest === 'Forest Region') return Math.max(0, s.params.randomPower - s.params.rune) * runes;
	return 0;
}

// ───────────────────────────── powers ─────────────────────────────

/** How much a power is worth holding (the value it usually gives this build). Powers that
 *  raise Max Barrier have a low hold value while it is low, so they are used at once. */
export function powerHoldValue(id: string, s?: Situation): number {
	const mb = s?.me.maxBarrier ?? MB_CAP;
	const target = s ? mbTarget(s) : MB_CAP;
	if (id === 'mountain-bastion-2' || id === 'unbroken-assault-2')
		return mb < target ? 0.8 : mb < MB_CAP ? 1.2 : 0.5;
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
	const target = mbTarget(s);
	if (id === 'mountain-bastion-2') return mb < target ? 4 : mb < MB_CAP ? 2 : 1;
	if (id === 'unbroken-assault-2') return mb < target ? 4.2 : mb < MB_CAP ? 2.2 : 0.8;
	return powerHoldValue(id, s);
}

/** Value of one Mountain replace (draw 3, keep 1) for the weakest held power. */
function replaceValue(s: Situation): number {
	const held = s.me.powerInventory ?? [];
	if (!held.length) return 0;
	const weakest = Math.min(...held.map((id) => powerDraftValue(id, s)));
	const low = s.me.maxBarrier < mbTarget(s);
	const best3 = low ? 3.6 : 3;
	let v = Math.max(0, best3 - weakest) * 0.5;
	// Below Max Barrier 7 Difficulty 3 hits cannot be taken: hunt Mountain Bastion / Unbroken
	// Assault (2 of the 22 powers; about 1 chance in 4 among 3 drawn).
	if (low && weakest < 3) v += 0.25 * maxBarrierValue(s, 3) * s.params.mbHunt;
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
	const target = mbTarget(s);
	for (let i = 0; i < gain; i++) {
		const at = s.me.maxBarrier + i;
		v += at >= MB_CAP ? 1 : at < target ? s.params.maxBarrierLow : s.params.maxBarrierHigh;
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
				reduction: power === 'battle-guard' ? 4 : 0,
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
			const pref = s.me.maxBarrier < MB_CAP ? mb : -mb;
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
			const keep = matKeepValue(m) + (m && isRelic(m) ? lastRelicLoss(s) : 0);
			return { score: 10 - keep, why: `discard ${m?.name ?? 'item'}` };
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
		reduction: enabled && power === 'battle-guard' ? 4 : 0,
		strikeFirst:
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
		if (!BUILD_CLASSES.includes(aug as BuildClass)) return null;
		const v = augmentValue(s, 1, [aug as BuildClass]);
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
		const chase = spirit ? originGain(s, spirit.origins) : 0;
		if (c.replaceSlotIndex === undefined && free > 0 && augmentHosts(s.me) < classNeed(s))
			return {
				score: s.params.host + chase,
				why: `summon ${draw.name ?? 'a spirit'} as an augment host`
			};
		if (chase > 0) {
			const v =
				chase - (c.replaceSlotIndex !== undefined ? keepValue(s, c.replaceSlotIndex) + 0.1 : 0);
			if (v > 0) return { score: v, why: `summon ${draw.name ?? 'a spirit'} for its origin relic` };
		}
		return { score: -0.2, why: 'not a build spirit' };
	}
	const gain = classGain(s, spirit.classes) + originGain(s, spirit.origins);
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
	const build = BUILD_CLASSES.includes(cls as BuildClass);
	let v = build ? stepOf(s, cls, countOf(s, cls as BuildClass)) : -0.2;
	if (v <= 0) v = build ? 0.01 : -0.2;
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
	// Relic tools: keep / points / effect. Using one discards it: while the Elementalist step needs a
	// relic, the last one is kept unless its effect is worth more than the upgrades it gives.
	const loss = lastRelicLoss(s) * s.params.relicUse;
	if (/^vp:/.test(id)) {
		const vp = Number(/(\d+)\s*VP/i.exec(opt?.label ?? '')?.[1] ?? 0);
		return { score: 1 + vp - loss, why: `relic for ${vp} points` };
	}
	if (/^effect:/.test(id) || /^awaken:/.test(id)) {
		let v = 0.2;
		if (/flower/i.test(text)) v = s.me.barrier < s.me.maxBarrier ? 2 : 0;
		else if (/diamond/i.test(text)) v = nextAugmentClass(s) && augmentHosts(s.me) > 0 ? 2 : 0;
		else if (/firecracker/i.test(text)) v = 2;
		return {
			score: 1 + v - loss,
			why: `use the relic (${v.toFixed(2)} against ${loss.toFixed(2)})`
		};
	}
	if (/^keep:/.test(id)) return { score: 1, why: 'keep relic' };
	// Cultivate at 5+ spirits of an origin: the origin's relic or its rune(s).
	if (card?.kind === 'originCultivate') {
		if (/^relic\|/.test(id)) {
			const v = s.relics > 0 ? 0.3 : Math.max(0.3, relicWorth(s));
			return { score: 1 + v, why: `take the origin relic (${v.toFixed(2)})` };
		}
		const n = Number(id.split('|')[2] ?? 1) || 1;
		return { score: 1 + n * s.params.rune, why: `take ${n} rune(s)` };
	}
	// A relic of choice (Cultivator (5), Cleric): one that is not a tool cannot be used up by mistake;
	// when no Rest step needs a relic, the Firecracker (strike first) is the most useful tool.
	if (card?.kind === 'cultivatorRelic' || /choose any relic/i.test(card?.prompt ?? '')) {
		const name = opt?.label ?? '';
		const gate = relicWorth(s) > 0;
		const v = gate ? (/fairy/i.test(name) ? 2 : 1) : /firecracker/i.test(name) ? 2 : 1;
		return { score: 1 + v, why: `choose ${name}` };
	}
	// Augment class choices (Fighter (5) "1 of any spirit augment" and similar).
	const want = nextAugmentClass(s);
	if (want && new RegExp(`\\b${want}\\b`, 'i').test(opt?.label ?? ''))
		return { score: 2, why: `choose ${want}` };
	if (DECLINE.test(id) || /^no\b/i.test(opt?.label ?? '')) return { score: 0.5, why: 'decline' };
	return { score: 0.4, why: 'default option' };
}
