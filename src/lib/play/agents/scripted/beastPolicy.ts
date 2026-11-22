/**
 * Scripted Beast player (no model). Its plan: hold three spirits of one origin so that Cultivate
 * pays a rune, spend the runes on Beast Spirit Augments at the Water Region, summon Beast spirits,
 * raise Max Barrier (Cultivator traits, Powers), and score by killing monsters with Beast's flat
 * damage. It never attacks a player.
 *
 * Like the Fighter + Elementalist player it reads only the seat's own projection and the catalog,
 * and answers with one of the offered actions; every decision the engine can ask has an answer.
 *
 * How it decides: `beastPlan.ts` holds a small model of the seat's own board. For every option
 * the model says how many points the board would have by the expected end of the game if the
 * option were taken, and the option with the most points wins. Decisions outside the plan (relic
 * tools, decision cards of other classes, trades) get a safe default.
 */

import { CLASS_ABILITIES } from '../../effects/abilities';
import { awakenedClassCounts, cultivateRuneMultiplier } from '../../effects/apply';
import { selectBreakpoint, type EffectBreakpoint } from '../../effects/registry';
import { diceTierFaces, expectedAttack } from '../../combat';
import { SPIRIT_WORLD_BAG } from '../../bags';
import { buildMonsterRewards } from '../../monsterRewards';
import { restBarrier, ruleAdjustedActions, vpToWin } from '../../rules';
import { summonDrawSizes } from '../../runtime';
import { SPIRIT_WORLD_REWARD_IDS } from '../../spiritWorldRewards';
import {
	MAX_SPIRITS,
	RUNE_CARRY_LIMIT,
	type DiceTier,
	type GameCommand,
	type MonsterState,
	type PlayCatalog,
	type PlayerProjection,
	type PrivatePlayerState,
	type SeatColor,
	type SpectatorProjection
} from '../../types';
import type { OfferedAction } from '../contract';
import {
	applyAbyss,
	applyCultivate,
	applyRest,
	applySummon,
	buyAugments,
	cloneState,
	drawOutcomes,
	valueAfterRound,
	type FightMods,
	type PlanCard,
	type PlanRules,
	type PlanState
} from './beastPlan';
import { damagePmf } from './fePolicy';

export interface BeastParams {
	/** Rounds the plan looks ahead over every choice when choosing a destination. */
	depth: number;
	/** The same for the smaller decisions (which spirit, which augment, which card). */
	smallDepth: number;
	/** Rounds of "fight when able, else Rest" played out after that. */
	rollout: number;
	/** Weight of the rounds past the played ones. */
	tail: number;
	/** Points per round still to play that a board at the winning score counts for. */
	winBonus: number;
	/** What a point is worth one round later (sooner is better; nothing is put off). */
	discount: number;
	/** Value of a rune still held at the end of the plan. */
	runeLeft: number;
	/** Share of a card's points that damage on a card still in hand is worth at the end. */
	chipLeft: number;
	/** Points per round the leader is assumed to make at least (sets the expected end). */
	pace: number;
	/** Longest plan, in rounds. */
	horizon: number;
	/** Deck cards each other player is assumed to take per round. */
	rival: number;
	/** Value of one Navigation Power drawn at random. */
	powerDraw: number;
	/** Share of a Power's usual value that holding it for later is worth. */
	powerHold: number;
	/** Value of a second spirit of an origin (half of a trio), in points. */
	trio: number;
	/** Value of an Arcane Abyss Summon on a monster card. */
	abyssSummon: number;
	/** 1: awaken face-down (Arcane) spirits when the engine offers it; 0: leave them face-down. */
	awaken: number;
	/** A purchase must gain at least this. */
	margin: number;
	/** A fight is taken unless the plan is worse off by more than this (an idle round at the
	 *  Arcane Abyss is a round lost). */
	fightBias: number;
}

export const DEFAULT_BEAST_PARAMS: BeastParams = {
	depth: 3,
	smallDepth: 2,
	rollout: 10,
	tail: 0.7,
	winBonus: 3,
	discount: 0.95,
	runeLeft: 0.3,
	chipLeft: 0.5,
	pace: 1.5,
	horizon: 18,
	rival: 0.3,
	powerDraw: 0.8,
	powerHold: 0.6,
	trio: 0.5,
	abyssSummon: 0.3,
	awaken: 0,
	margin: 0.05,
	fightBias: 1
};

export interface BeastChoice {
	id: string;
	reason: string;
}

/** The engine's limits that have no exported name (effects/actions.ts, runtime.ts). */
const MAX_BARRIER_CAP = 10;
const MONSTER_HAND_LIMIT = 3;
const ABYSS = 'Arcane Abyss';
const DECLINE = /^(no|decline|skip|pass|keep|none|cancel)/i;

/**
 * Amounts of the Navigation Powers the plan uses. The engine keeps them as literals in
 * navigationPowerEffects.ts (no helper to read them from), so they are repeated here.
 */
const POWER = {
	emberRestore: 5,
	battleGuardReduce: 4,
	battleFuryDice: 2,
	unbrokenMaxBarrier: 4,
	duelistVp: 2,
	bastionMaxBarrier: 3,
	wealthRunes: 2,
	bountyAugments: 2,
	temperedUpgrades: 5,
	reckoningVp: [0, 1, 2, 4]
};

type Me = PlayerProjection & PrivatePlayerState;

interface SpiritLite {
	slot: number;
	name: string;
	cost: number;
	classes: Record<string, number>;
	origins: string[];
	faceDown: boolean;
	/** Class of the augment on it, or null. */
	augment: string | null;
}

export interface BeastSituation {
	view: SpectatorProjection;
	seat: SeatColor;
	me: Me;
	catalog: PlayCatalog;
	params: BeastParams;
	spirits: SpiritLite[];
	rules: PlanRules;
	state: PlanState;
	/** Rounds the game is expected to last from now (this round included). */
	left: number;
	mean: Record<DiceTier, number>;
	faces: Record<DiceTier, number[]>;
	/** Value of ending the round as the board stands (filled when first needed). */
	base?: number;
}

// ───────────────────────────── rule numbers from the engine ─────────────────────────────

type Action = {
	kind: string;
	amount?: number;
	then?: Action[];
	when?: { kind: string; amount?: number };
};

function breakpointsOf(className: string, trigger: string): EffectBreakpoint[] {
	return (CLASS_ABILITIES[className] ?? []).flatMap((a) =>
		a.on === trigger && a.breakpoints ? a.breakpoints : []
	);
}

/** Sum of the amounts of the actions of `kind` that `count` traits of a class fire on `trigger`. */
function classAmount(
	catalog: PlayCatalog,
	className: string,
	trigger: string,
	kind: string,
	count: number
): number {
	const selected = selectBreakpoint(breakpointsOf(className, trigger), count);
	if (!selected) return 0;
	const actions = ruleAdjustedActions(
		catalog,
		className,
		selected.bp.count,
		selected.bp.actions as Action[]
	);
	return actions.reduce(
		(n, a) => n + (a.kind === kind ? (a.amount ?? 0) * selected.multiplier : 0),
		0
	);
}

/** Battle Adept: Max Barrier per trait for a kill with `at` or more damage to spare. */
function overkillRule(): { at: number; amount: number } {
	for (const bp of breakpointsOf('Battle Adept', 'onMonsterKill'))
		for (const a of bp.actions as Action[])
			if (a.kind === 'conditional' && a.when?.kind === 'overkillAtLeast') {
				const gain = (a.then ?? []).find((t) => t.kind === 'gainMaxBarrier');
				if (gain) return { at: a.when.amount ?? 2, amount: gain.amount ?? 1 };
			}
	return { at: 2, amount: 0 };
}

interface CardRewards {
	vp: number;
	runes: number;
	summons: number;
}

function rewardsOf(card: Pick<MonsterState, 'rewardTrack' | 'permanent'>): CardRewards {
	const out = { vp: 0, runes: 0, summons: 0 };
	for (const r of buildMonsterRewards(card.rewardTrack)) {
		if (r.effect.type === 'vp') out.vp += r.effect.amount;
		else if (r.effect.type === 'rune' || r.effect.type === 'chooseRune') out.runes += 1;
		else if (r.effect.type === 'action' && r.effect.action === 'abyssSummon') out.summons += 1;
	}
	// The permanent monster gives one of its rewards: its point.
	if (card.permanent) return { vp: Math.min(out.vp, 1) || 1, runes: 0, summons: 0 };
	return out;
}

function planCard(
	card: Pick<MonsterState, 'hp' | 'maxHp' | 'damage' | 'rewardTrack' | 'permanent' | 'difficulty'>,
	reduction: number,
	params: BeastParams,
	handIndex = -1
): PlanCard {
	const rewards = rewardsOf(card);
	return {
		hp: Math.max(0, card.hp),
		maxHp: card.maxHp,
		hit: Math.max(0, card.damage - reduction),
		vp: rewards.vp,
		runes: rewards.runes,
		extra: rewards.summons * params.abyssSummon,
		difficulty: card.permanent ? 0 : (card.difficulty ?? 1),
		handIndex
	};
}

/** Expected number of Beast spirits among the picks of one Spirit World Summon. */
function summonBeast(
	view: SpectatorProjection,
	catalog: PlayCatalog,
	spirits: number,
	picks: number
): number {
	const bag = view.bagSpirits?.spiritWorld ?? [];
	let total = 0;
	let beast = 0;
	for (const row of bag) {
		total += row.count;
		const sp = catalog.spirits.find((x) => x.id === row.id);
		if ((sp?.classes?.Beast ?? 0) > 0) beast += row.count;
	}
	const n = Math.min(spirits, total);
	if (total <= 0 || beast <= 0 || n <= 0) return 0;
	// P(X = k) for X Beast spirits among n drawn without replacement.
	const choose = (a: number, b: number): number => {
		if (b < 0 || b > a) return 0;
		let c = 1;
		for (let i = 0; i < b; i++) c = (c * (a - i)) / (i + 1);
		return c;
	};
	let expected = 0;
	for (let k = 1; k <= Math.min(n, beast); k++)
		expected +=
			Math.min(k, picks) * ((choose(beast, k) * choose(total - beast, n - k)) / choose(total, n));
	return expected;
}

// ───────────────────────────── the board ─────────────────────────────

function spiritsOf(me: Me): SpiritLite[] {
	const augments = new Map<number, string>();
	for (const a of me.spiritAugmentAttachments ?? [])
		augments.set(a.spiritSlotIndex, a.className ?? '?');
	return (me.spirits ?? []).map((sp) => ({
		slot: sp.slotIndex,
		name: sp.name,
		cost: sp.cost,
		classes: sp.classes ?? {},
		origins: Object.keys(sp.origins ?? {}).filter((o) => (sp.origins[o] ?? 0) > 0),
		faceDown: sp.isFaceDown,
		augment: augments.get(sp.slotIndex) ?? null
	}));
}

function traitCount(spirits: SpiritLite[], className: string): number {
	let n = 0;
	for (const sp of spirits) {
		if (sp.faceDown) continue;
		n += sp.classes[className] ?? 0;
		if (sp.augment === className) n += 1;
	}
	return n;
}

function originCounts(spirits: SpiritLite[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const sp of spirits) for (const o of sp.origins) counts.set(o, (counts.get(o) ?? 0) + 1);
	return counts;
}

function basicRunes(me: Me): number {
	return (me.mats ?? []).filter(
		(m) =>
			m?.hasRune &&
			!m.relicTool &&
			!m.special &&
			m.type !== 'relic' &&
			/rune/i.test(m.name ?? '') &&
			!/augment/i.test(m.name ?? '')
	).length;
}

/** The plan's numbers for a set of spirits (the seat's own, or the set after a change). */
function boardState(s: BeastSituation, spirits: SpiritLite[], from: PlanState): PlanState {
	const per = s.rules.beastDamage;
	const hosts = spirits.filter((sp) => !sp.faceDown && !sp.augment);
	const trios = [...originCounts(spirits).values()].filter((n) => n >= 3).length;
	return {
		...from,
		hand: from.hand.map((c) => ({ ...c })),
		pools: [...from.pools],
		flat: traitCount(spirits, 'Beast') * per,
		cultivator: traitCount(spirits, 'Cultivator'),
		hosts: Math.max(0, hosts.length - (s.me.unplacedAugments?.length ?? 0)),
		free: Math.max(0, MAX_SPIRITS - spirits.length),
		plain: hosts.filter((sp) => !(sp.classes.Beast > 0)).length,
		runesPerCultivate: trios * cultivateRuneMultiplier(s.me, s.catalog)
	};
}

/** The plan's rules for a set of spirits (two fights with a Monster Hunter, Battle Adept). */
function boardRules(s: BeastSituation, spirits: SpiritLite[]): PlanRules {
	const extraFights = classAmount(
		s.catalog,
		'Monster Hunter',
		'onNavigate',
		'extraAction',
		traitCount(spirits, 'Monster Hunter')
	);
	const fightsPerRound = 1 + extraFights;
	const overkillMaxBarrier = traitCount(spirits, 'Battle Adept') * overkillRule().amount;
	if (
		fightsPerRound === s.rules.fightsPerRound &&
		overkillMaxBarrier === s.rules.overkillMaxBarrier
	)
		return s.rules;
	return { ...s.rules, fightsPerRound, overkillMaxBarrier };
}

/** Half-built trios: a small value for a second spirit of an origin (the two best origins). */
function trioShape(s: BeastSituation, spirits: SpiritLite[]): number {
	const best = [...originCounts(spirits).values()].sort((a, b) => b - a).slice(0, 2);
	return best.reduce((n, c) => n + (c >= 2 ? 1 : c === 1 ? 0.25 : 0), 0) * s.params.trio;
}

export function beastSituation(
	view: SpectatorProjection,
	seat: SeatColor,
	catalog: PlayCatalog,
	params: BeastParams = DEFAULT_BEAST_PARAMS
): BeastSituation {
	const me = view.players[seat] as Me;
	const faces = diceTierFaces(catalog);
	const mean = Object.fromEntries(
		(Object.keys(faces) as DiceTier[]).map((t) => [
			t,
			faces[t].reduce((a, b) => a + b, 0) / faces[t].length
		])
	) as Record<DiceTier, number>;
	const spirits = spiritsOf(me);
	const counts = awakenedClassCounts(me as PrivatePlayerState);
	// `me.damageReduction` is not read: it is a per-combat value that stays set after a fight
	// (Battle Guard's 4) until the next fight starts, so between fights it is stale.
	const reduction = 0;
	const dice = (me.attackDice ?? []).reduce((n, d) => n + (mean[d.tier] ?? 0), 0);
	const sizes = summonDrawSizes(SPIRIT_WORLD_BAG, catalog, null);

	const deckTypes: PlanRules['deckTypes'] = [[], [], [], []];
	for (const m of catalog.monsters ?? []) {
		if (m.permanent || !(m.stage >= 1 && m.stage <= 3)) continue;
		const card = planCard(
			{
				hp: m.barrier,
				maxHp: m.barrier,
				damage: m.damage,
				rewardTrack: m.rewardTrack,
				difficulty: m.stage as 1 | 2 | 3
			},
			reduction,
			params
		);
		const same = deckTypes[m.stage].find(
			(t) =>
				t.card.hp === card.hp &&
				t.card.hit === card.hit &&
				t.card.vp === card.vp &&
				t.card.runes === card.runes &&
				t.card.extra === card.extra
		);
		if (same) same.weight += 1;
		else deckTypes[m.stage].push({ card, weight: 1 });
	}
	const overkill = overkillRule();
	const rules: PlanRules = {
		target: vpToWin(catalog),
		heal: restBarrier(catalog, me.statusLevel ?? 0),
		maxBarrierCap: MAX_BARRIER_CAP,
		carry: RUNE_CARRY_LIMIT,
		handLimit: MONSTER_HAND_LIMIT,
		beastDamage: classAmount(catalog, 'Beast', 'inCombat', 'combatBonus', 1) || 1,
		cultivateMaxBarrier: (c) =>
			classAmount(catalog, 'Cultivator', 'onCultivate', 'gainMaxBarrier', c),
		fightsPerRound:
			1 +
			classAmount(
				catalog,
				'Monster Hunter',
				'onNavigate',
				'extraAction',
				counts['Monster Hunter'] ?? 0
			),
		overkillMaxBarrier: (counts['Battle Adept'] ?? 0) * overkill.amount,
		overkillAt: overkill.at,
		deckTypes,
		lurker: view.permanentMonster
			? planCard({ ...view.permanentMonster, hp: view.permanentMonster.maxHp }, reduction, params)
			: null,
		summonBeast: summonBeast(view, catalog, sizes.draw - 1, sizes.pick),
		hexRune:
			SPIRIT_WORLD_REWARD_IDS.filter((id) => id.endsWith('-rune')).length /
			Math.max(1, SPIRIT_WORLD_REWARD_IDS.length),
		rivalDraws: params.rival * Math.max(0, view.activeSeats.length - 1),
		tuning: {
			depth: params.depth,
			rollout: params.rollout,
			tail: params.tail,
			winBonus: params.winBonus,
			discount: params.discount,
			runeLeft: params.runeLeft,
			chip: params.chipLeft
		},
		cache: new Map()
	};

	const pools = [0, 0, 0, 0];
	for (const d of view.monsterDecks ?? []) pools[d.difficulty] = d.count ?? 0;
	const s: BeastSituation = {
		view,
		seat,
		me,
		catalog,
		params,
		spirits,
		rules,
		state: undefined as unknown as PlanState,
		left: roundsLeft(view, me, rules.target, params),
		mean,
		faces
	};
	const blank: PlanState = {
		vp: me.victoryPoints,
		bonus: 0,
		// The engine's expected attack, less the dice: Beast's damage.
		flat: expectedAttack(me as PrivatePlayerState, catalog) - dice,
		dice,
		cultivator: 0,
		maxBarrier: me.maxBarrier,
		barrier: me.barrier,
		runes: basicRunes(me),
		hosts: 0,
		free: 0,
		plain: 0,
		runesPerCultivate: 0,
		hand: (me.monsterHand ?? []).map((c, i) => planCard(c, reduction, params, i)),
		pools
	};
	const flat = blank.flat;
	s.state = boardState(s, spirits, blank);
	// Keep the engine's number where it differs from the trait count times the class amount.
	s.state.flat = flat;
	return s;
}

/** Rounds until the game is expected to end: the leader's distance from the winning score. */
function roundsLeft(
	view: SpectatorProjection,
	me: Me,
	target: number,
	params: BeastParams
): number {
	let leader = me.victoryPoints;
	for (const seat of view.activeSeats)
		leader = Math.max(leader, view.players[seat]?.victoryPoints ?? 0);
	const pace = Math.max(params.pace, leader / Math.max(6, view.round));
	const left = Math.ceil((target - leader) / pace);
	return Math.max(2, Math.min(params.horizon, left));
}

// ───────────────────────────── values ─────────────────────────────

/** Value of ending this round with the board `st` (the rest of the game by the plan). */
function after(
	s: BeastSituation,
	st: PlanState,
	rules = s.rules,
	depth = s.params.smallDepth
): number {
	return valueAfterRound(st, rules, s.left, depth);
}

function baseValue(s: BeastSituation): number {
	s.base ??= after(s, s.state);
	return s.base;
}

function playersAhead(s: BeastSituation): number {
	return s.view.activeSeats.filter(
		(seat) => seat !== s.seat && (s.view.players[seat]?.victoryPoints ?? 0) > s.me.victoryPoints
	).length;
}

/** Expected dice damage after `times` upgrades (the lowest Basic or Enchanted die first). */
function diceAfterUpgrades(s: BeastSituation, times: number): number {
	const tiers = (s.me.attackDice ?? []).map((d) => d.tier);
	for (let u = 0; u < times; u++) {
		const b = tiers.indexOf('basic');
		if (b >= 0) tiers[b] = 'enchanted';
		else {
			const e = tiers.indexOf('enchanted');
			if (e < 0) break;
			tiers[e] = 'exalted';
		}
	}
	return tiers.reduce((n, t) => n + (s.mean[t] ?? 0), 0);
}

/** What a committed Power changes in the fights of the round. */
function fightMods(s: BeastSituation, power: string | null, triggered = false): FightMods {
	const mods: FightMods = {};
	// An armed Firecracker. (`alwaysAttackFirst` is per-combat and stale between fights.)
	if ((s.me.strikeFirstCharges ?? 0) > 0) mods.strikeFirst = true;
	if (power === 'battle-guard') mods.reduce = POWER.battleGuardReduce;
	if (power === 'battle-fury') mods.extraDamage = POWER.battleFuryDice * (s.mean.arcane ?? 0);
	if (power === 'sudden-strike') mods.strikeFirst = true;
	if (power === 'unbroken-assault-2' && !triggered) mods.failMaxBarrier = POWER.unbrokenMaxBarrier;
	if (power === 'duelists-prize-2' && !triggered) mods.failVp = POWER.duelistVp;
	return mods;
}

/** Best value of a visit to the Arcane Abyss over the possible draws. */
function abyssValue(s: BeastSituation, st: PlanState, mods: FightMods, depth: number): number {
	let best = -Infinity;
	for (const draw of [-1, 1, 2, 3, 0]) {
		const n = cloneState(st);
		applyAbyss(n, s.rules, draw, mods);
		best = Math.max(best, after(s, n, s.rules, depth));
	}
	return best;
}

/** Best value of buying augments with the runes held (Cultivator ones up to the next step). */
function buyValue(
	s: BeastSituation,
	st: PlanState,
	depth: number
): { value: number; cultivator: number } {
	let best = { value: -Infinity, cultivator: 0 };
	for (const cultivator of [0, 1, 2]) {
		if (cultivator > Math.min(st.runes, st.hosts)) break;
		if (
			cultivator > 0 &&
			!(
				s.rules.cultivateMaxBarrier(st.cultivator + cultivator) >
				s.rules.cultivateMaxBarrier(st.cultivator)
			)
		)
			continue;
		const n = cloneState(st);
		buyAugments(n, s.rules, cultivator);
		const value = after(s, n, s.rules, depth);
		if (value > best.value) best = { value, cultivator };
	}
	return best;
}

/** How much a Power is usually worth to this player (for drafts, and for holding it back). */
export function powerWorth(id: string, s: BeastSituation): number {
	const mb = s.me.maxBarrier;
	switch (id) {
		case 'mountain-bastion-2':
			return mb <= 7 ? 5 : 2.5;
		case 'unbroken-assault-2':
			return mb <= 6 ? 5.5 : mb < MAX_BARRIER_CAP ? 2.5 : 0.3;
		case 'forest-bounty-2':
			return 4;
		case 'battle-guard':
			return 3;
		case 'abyssal-execution-2':
			return 3;
		case 'sudden-strike':
			return 2.8;
		case 'ember-charge-2':
			return 2.5;
		case 'twin-rhythm':
			return 2.5;
		case 'battle-fury':
			return 2.2;
		case 'mountains-wealth':
			return 2.2;
		case 'duelists-prize-2':
			return 2;
		case 'underdogs-oath':
			return 1.5;
		case 'watchful-eye-2':
			return 1.3;
		case 'tidal-calling':
			return 1.2;
		default:
			return 0.2;
	}
}

/** Value of going to `dest` with `power` committed (null: none). */
export function destinationValue(s: BeastSituation, dest: string, power: string | null): number {
	const st = cloneState(s.state);
	const r = s.rules;
	const depth = s.params.depth - 1;
	// Effects at the reveal, before the location.
	if (power === 'ember-charge-2')
		st.barrier = Math.min(st.maxBarrier, st.barrier + POWER.emberRestore);
	if (power === 'twin-rhythm') {
		applyRest(st, r);
		applyCultivate(st, r);
	}
	if (power === 'watchful-eye-2') st.runes += 1;
	if (power === 'underdogs-oath') st.vp += playersAhead(s);
	if (power === 'abyssal-reckoning-2')
		st.vp += POWER.reckoningVp[Math.max(0, Math.min(3, s.me.statusLevel ?? 0))];
	if (power === 'tempered-dice') st.dice = diceAfterUpgrades(s, POWER.temperedUpgrades);

	let value: number;
	switch (dest) {
		case ABYSS: {
			const mods = fightMods(s, power);
			value = abyssValue(s, st, mods, depth);
			if (power === 'abyssal-execution-2') {
				// Defeat a card at half its Barrier or less without a battle (the round's battle).
				st.hand.forEach((card, i) => {
					if (!(card.hp > 0 && card.hp * 2 <= card.maxHp)) return;
					const n = cloneState(st);
					n.vp += card.vp;
					n.bonus += card.extra;
					n.runes += card.runes;
					n.hand.splice(i, 1);
					for (const draw of [-1, 1, 2, 3]) {
						const m = cloneState(n);
						applyAbyss(m, r, draw, { noFight: true });
						value = Math.max(value, after(s, m, r, depth));
					}
				});
			}
			break;
		}
		case 'Forest Region': {
			applyRest(st, r);
			if (power === 'forest-bounty-2' && s.spirits.some((sp) => !sp.faceDown))
				st.flat += POWER.bountyAugments * r.beastDamage;
			value = after(s, st, r, depth);
			break;
		}
		case 'Water Region': {
			const sizes = summonDrawSizes(SPIRIT_WORLD_BAG, s.catalog, {
				navigationPower: power as Me['navigationPower'],
				navigationDestination: dest
			});
			applySummon(st, r, summonBeast(s.view, s.catalog, sizes.draw - 1, sizes.pick));
			value = buyValue(s, st, depth).value;
			break;
		}
		case 'Fire Region': {
			applyCultivate(st, r);
			value = after(s, st, r, depth);
			break;
		}
		case 'Mountain Region': {
			if (power === 'mountain-bastion-2') {
				const over = Math.max(0, st.maxBarrier + POWER.bastionMaxBarrier - r.maxBarrierCap);
				st.maxBarrier = Math.min(r.maxBarrierCap, st.maxBarrier + POWER.bastionMaxBarrier);
				st.barrier = st.maxBarrier;
				st.vp += over;
			}
			if (power === 'mountains-wealth') st.runes += POWER.wealthRunes;
			value = after(s, st, r, depth);
			break;
		}
		default:
			value = after(s, st, r, depth);
	}
	if (power) value -= powerWorth(power, s) * s.params.powerHold;
	return value;
}

// ───────────────────────────── the chooser ─────────────────────────────

interface Scored {
	action: OfferedAction;
	score: number;
	why: string;
}

/** Choose one of the offered actions. */
export function chooseBeastAction(
	view: SpectatorProjection,
	seat: SeatColor,
	actions: OfferedAction[],
	catalog: PlayCatalog,
	params: BeastParams = DEFAULT_BEAST_PARAMS
): BeastChoice {
	if (actions.length === 1) return { id: actions[0].id, reason: 'only legal action' };
	const s = beastSituation(view, seat, catalog, params);
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
	s: BeastSituation,
	action: OfferedAction,
	all: OfferedAction[]
): { score: number; why: string } | null {
	const c = action.command;
	switch (c.type) {
		// Yields: the baseline every other action must beat.
		case 'endLocationActions':
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
			return { score: 0, why: 'done' };
		case 'passEncounter':
			return { score: 1, why: 'this player attacks no one' };
		case 'initiatePvp':
			return { score: -100, why: 'this player attacks no one' };

		case 'lockNavigation': {
			const value = destinationValue(s, c.destination, c.navigationPowerId ?? null);
			return {
				score: value,
				why: `go to ${c.destination}${c.navigationPowerId ? ` with ${c.navigationPowerId}` : ''} (plan ${value.toFixed(2)}, ${s.left} rounds)`
			};
		}
		case 'unlockNavigation':
		case 'tradeNavigationPower':
		case 'acquireNavigationPower':
			return null;
		case 'respondNavigationPowerTrade':
			return { score: c.accept ? -1 : 1, why: 'decline trades' };

		case 'chooseNavigationPower': {
			let v = powerWorth(c.powerId, s);
			if (c.replacePowerId) v -= powerWorth(c.replacePowerId, s) + 0.01;
			return {
				score: 10 + v,
				why: `keep power ${c.powerId}${c.replacePowerId ? ` for ${c.replacePowerId}` : ''}`
			};
		}
		case 'resolveNavigationPower':
			return scorePowerOffer(s, c, action.label);

		case 'resolveLocationInteraction':
			return scoreLocationRow(s, action.label);

		case 'drawMonsterCards': {
			// The average over the cards the draw may add (the better of two revealed).
			const outcomes = c.permanent
				? [{ card: s.rules.lurker!, chance: 1 }]
				: drawOutcomes(c.difficulty, s.state, s.rules);
			let value = 0;
			for (const o of outcomes) {
				const st = cloneState(s.state);
				if (!c.permanent) st.pools[c.difficulty] -= 1;
				applyAbyss(st, s.rules, o.card, currentMods(s));
				value += o.chance * after(s, st);
			}
			const v = value - baseValue(s);
			return {
				// A draw that does no harm comes before a fight: it only adds choices.
				score: v >= 0 ? v + s.params.fightBias + 0.003 : v,
				why: `draw ${c.permanent ? 'the Abyss Lurker' : `Difficulty ${c.difficulty}`} (${v.toFixed(2)})`
			};
		}
		case 'keepMonsterCard': {
			const card = s.me.pendingMonsterDraw?.cards?.[c.index];
			if (!card) return { score: 1, why: 'keep' };
			const st = cloneState(s.state);
			applyAbyss(st, s.rules, planCard(card, 0, s.params), currentMods(s));
			const v = after(s, st);
			return { score: 1000 + v, why: `keep ${card.name} (${(v - baseValue(s)).toFixed(2)})` };
		}
		case 'startCombat':
			return scoreFight(s, c.handIndex);
		case 'resolveMonsterReward': {
			const reward = s.me.pendingReward;
			if (c.arcaneBlood) return { score: 0.5, why: 'Arcane Blood does nothing for this build' };
			if (reward?.chooseOne) {
				const pick = c.picks?.[0] ?? 0;
				const r = buildMonsterRewards(reward.rewardTrack).find((x) => x.index === pick);
				return { score: r?.effect.type === 'vp' ? 1.2 : 0.8, why: 'claim the point' };
			}
			return { score: 1, why: 'claim the rewards' };
		}

		case 'spawnHandSpirit':
			return scoreSummon(s, c);
		case 'discardHandDraws':
			return { score: 0, why: 'summon none' };
		case 'redrawHandDraws': {
			// Mystic: draw again when no Beast spirit is offered and one could be used.
			const beast = (s.me.handDraws ?? []).some((h) => {
				const sp = s.catalog.spirits.find((x) => x.id === h.id);
				return (sp?.classes?.Beast ?? 0) > 0;
			});
			const room = s.state.free > 0 || s.state.plain > 0;
			const picked = (s.me.pendingDraw?.summonedCount ?? 0) > 0;
			return !beast && room && !picked && s.me.pendingDraw?.sourceBag !== 'Arcane Abyss Bag'
				? { score: 50, why: 'no Beast spirit: draw again' }
				: null;
		}

		case 'placeAugmentOnSpirit':
			return scoreAugmentPlacement(s, c);
		case 'discardUnplacedAugments':
			return { score: -0.5, why: 'discard unplaced augments' };

		case 'awakenSpirit':
		case 'manualAwaken': {
			const sp = s.spirits.find((x) => x.slot === c.slotIndex);
			const v = sp && s.params.awaken > 0 ? awakenWorth(sp) : -1;
			return v > 0
				? { score: v, why: `awaken ${sp?.name}` }
				: { score: -0.5, why: 'leave it face-down' };
		}

		case 'resolveDecision':
			return scoreDecision(s, c, action.label);
		case 'resolveAwakenReward': {
			// Cursed Spirit grants: Max Barrier while it is below the cap.
			const mb =
				(c.taintedMaxBarrier ?? 0) + (c.corruptMaxBarrier ?? 0) + (c.fallenMaxBarrier ?? 0);
			const pref = s.me.maxBarrier < MAX_BARRIER_CAP ? mb : -mb;
			return { score: 2 + 0.01 * pref, why: 'claim the Awakening-phase grant' };
		}

		case 'discardSpirit': {
			// Only to pay a corruption: the spirit the build needs least.
			if (!((s.me.pendingCorruptionDiscard?.count ?? 0) > 0)) return null;
			return { score: 100 - spiritWorth(s, c.slotIndex), why: `sacrifice slot ${c.slotIndex}` };
		}
		case 'discardRune': {
			// Only down to the carry limit: the least useful item.
			const held = (s.me.mats ?? []).filter((m) => m?.hasRune).length;
			if (held <= RUNE_CARRY_LIMIT) return null;
			const m = s.me.mats?.find((x) => x.slotIndex === c.slotIndex);
			return { score: 10 - matWorth(m), why: `discard ${m?.name ?? 'item'}` };
		}
		default:
			void all;
			return null;
	}
}

/** The fight changes of the Power committed this round (it is applied at the reveal). */
function currentMods(s: BeastSituation): FightMods {
	return fightMods(s, s.me.navigationPower ?? null, s.me.navigationPowerBattleTriggered === true);
}

/**
 * Fight the card at `handIndex` now, against not fighting. The fight is judged with the plan's
 * own damage (Beast traits plus the dice's average), the same as the plan's later fights, so a
 * fight is neither put off nor rushed because of the dice. A corruption is never risked.
 */
function scoreFight(s: BeastSituation, handIndex: number): { score: number; why: string } | null {
	const card = s.me.monsterHand?.[handIndex];
	const index = s.state.hand.findIndex((c) => c.handIndex === handIndex);
	if (!card || index < 0) return null;
	const mods = currentMods(s);
	const plan = s.state.hand[index];
	const hit = Math.max(0, plan.hit - (mods.reduce ?? 0));
	// The real chance of a kill: for the safety of a strike-first fight, and for the record.
	const pmf = damagePmf(
		(s.me.attackDice ?? []).map((d) => d.tier),
		s.faces
	);
	const flat = Math.round(s.state.flat) + (mods.extraDamage ?? 0);
	let pKill = 0;
	for (let roll = 0; roll < pmf.length; roll++) if (roll + flat >= plan.hp) pKill += pmf[roll];
	if (!(s.me.barrier > hit) && !(mods.strikeFirst && pKill >= 1))
		return { score: -100, why: `${card.name} would corrupt` };
	const n = cloneState(s.state);
	applyAbyss(n, { ...s.rules, fightsPerRound: 1 }, -1, { ...mods, first: index });
	const gain = after(s, n) - baseValue(s);
	// A round at the Abyss without a fight is a round lost: fight unless it is clearly worse.
	return gain >= -s.params.fightBias
		? {
				score: gain + s.params.fightBias + 0.002,
				why: `fight ${card.name} (kill ${Math.round(pKill * 100)} %, plan ${gain >= 0 ? '+' : ''}${gain.toFixed(2)})`
			}
		: { score: -1, why: `do not fight ${card.name} (${gain.toFixed(2)})` };
}

function scoreLocationRow(s: BeastSituation, label: string): { score: number; why: string } | null {
	if (/Rest\b/.test(label))
		return s.me.barrier < s.me.maxBarrier ? { score: 50, why: 'rest' } : null;
	if (/Spirit World Summon/.test(label)) return { score: 50, why: 'summon' };
	if (/Cultivate/.test(label)) return { score: 50, why: 'cultivate' };
	const augment = /gain (.+?) Spirit Augment/.exec(label)?.[1];
	if (augment) {
		if (augment !== 'Beast' && augment !== 'Cultivator') return null;
		if (s.state.hosts < 1 || s.state.runes < 1) return null;
		const best = buyValue(s, s.state, s.params.smallDepth);
		const gain = best.value - baseValue(s);
		if (gain < s.params.margin) return null;
		const want = best.cultivator > 0 ? 'Cultivator' : 'Beast';
		return augment === want
			? { score: 1 + gain, why: `buy a ${augment} augment (plan +${gain.toFixed(2)})` }
			: null;
	}
	if (/random Power/i.test(label)) {
		if (s.state.runes < 1) return null;
		const n = cloneState(s.state);
		n.runes -= 1;
		const gain = s.params.powerDraw + after(s, n) - baseValue(s);
		return gain >= s.params.margin ? { score: gain, why: 'buy a random power' } : null;
	}
	if (/replace/i.test(label)) {
		// Replace the weakest held Power with a choice of three, when it is of little use.
		const held = s.me.powerInventory ?? [];
		if (!held.length || s.state.runes < 1) return null;
		const weakest = Math.min(...held.map((id) => powerWorth(id, s)));
		const n = cloneState(s.state);
		n.runes -= 1;
		const gain = Math.max(0, 2.5 - weakest) * 0.6 + after(s, n) - baseValue(s);
		return weakest < 1 && gain >= s.params.margin
			? { score: gain, why: 'replace a weak power' }
			: null;
	}
	return null;
}

function scorePowerOffer(
	s: BeastSituation,
	c: Extract<GameCommand, { type: 'resolveNavigationPower' }>,
	label: string
): { score: number; why: string } {
	const offer = s.me.navigationPowerOffers?.find((o) => o.id === c.offerId);
	const opt = offer?.options.find((o) => o.id === c.optionId);
	const text = `${opt?.label ?? ''} ${label}`;
	const decline = DECLINE.test(c.optionId) || /decline|do not|don't/i.test(opt?.label ?? '');
	// Stone Shelter (another player's power) takes one of our runes: any will do.
	if (offer?.powerId === 'stone-shelter' || /steal/i.test(offer?.prompt ?? ''))
		return { score: decline ? 0 : 1, why: 'answer Stone Shelter' };
	if (/augment/i.test(text) && /Beast/i.test(opt?.label ?? ''))
		return { score: 21, why: 'take a Beast augment' };
	// Abyssal Execution: the card worth most.
	if (offer?.powerId === 'abyssal-execution-2' && !decline) {
		const card = s.state.hand.find((x) => x.handIndex === Number(c.optionId));
		return { score: 20 + (card?.vp ?? 0), why: 'defeat the card without a battle' };
	}
	if (decline) return { score: 0.5, why: 'decline' };
	// Answer power offers before anything else at the location (a battle power must be on first).
	return { score: 20, why: `use ${offer?.powerId ?? 'power'}` };
}

/** Spirits after summoning `add` into a free slot, or in place of the spirit in `replace`. */
function spiritsWith(s: BeastSituation, add: SpiritLite, replace?: number): SpiritLite[] {
	const rest = replace === undefined ? s.spirits : s.spirits.filter((sp) => sp.slot !== replace);
	return [...rest, add];
}

function scoreSummon(
	s: BeastSituation,
	c: Extract<GameCommand, { type: 'spawnHandSpirit' }>
): { score: number; why: string } | null {
	const draw = s.me.handDraws?.find((h) => h.guid === c.guid);
	if (!draw) return null;
	const atWater = s.me.navigationDestination === 'Water Region';
	// The value of a board at this location: augments may still be bought here this round.
	const worth = (st: PlanState, rules: PlanRules) =>
		atWater && st.runes >= 1 && st.hosts >= 1 ? buyValueWith(s, st, rules) : after(s, st, rules);
	const now = worth(s.state, s.rules) + trioShape(s, s.spirits);

	if (draw.rewardId || draw.rewardLabel) {
		const id = draw.rewardId ?? '';
		const st = cloneState(s.state);
		let gain: number;
		if (/rune/i.test(id) || /rune/i.test(draw.rewardLabel ?? '')) {
			st.runes += 1;
			gain = worth(st, s.rules) + trioShape(s, s.spirits) - now;
		} else if (/barrier/i.test(id) || /barrier/i.test(draw.rewardLabel ?? '')) {
			st.barrier = Math.min(st.maxBarrier, st.barrier + 2);
			gain = worth(st, s.rules) + trioShape(s, s.spirits) - now;
		} else gain = s.params.powerDraw;
		return {
			score: gain,
			why: `take ${draw.rewardLabel ?? 'the reward'} (plan +${gain.toFixed(2)})`
		};
	}

	const spirit = s.catalog.spirits.find((x) => x.id === draw.id || x.name === draw.name);
	if (!spirit) return null;
	const arcane = s.me.pendingDraw?.sourceBag === 'Arcane Abyss Bag';
	const add: SpiritLite = {
		slot: -1,
		name: spirit.name,
		cost: spirit.cost,
		classes: spirit.classes ?? {},
		origins: Object.keys(spirit.origins ?? {}),
		// Arcane spirits enter face-down; the plan counts their origin only.
		faceDown: arcane,
		augment: null
	};
	const spirits = spiritsWith(s, add, c.replaceSlotIndex);
	const st = boardState(s, spirits, s.state);
	const gain =
		worth(st, boardRules(s, spirits)) + trioShape(s, spirits) - now + 0.001 * spirit.cost;
	return {
		score: gain,
		why: `summon ${spirit.name}${c.replaceSlotIndex !== undefined ? ` over slot ${c.replaceSlotIndex}` : ''} (plan +${gain.toFixed(2)})`
	};
}

function buyValueWith(s: BeastSituation, st: PlanState, rules: PlanRules): number {
	let best = -Infinity;
	for (const cultivator of [0, 1, 2]) {
		if (cultivator > Math.min(st.runes, st.hosts)) break;
		const n = cloneState(st);
		buyAugments(n, rules, cultivator);
		best = Math.max(best, after(s, n, rules));
	}
	return best;
}

function scoreAugmentPlacement(
	s: BeastSituation,
	c: Extract<GameCommand, { type: 'placeAugmentOnSpirit' }>
): { score: number; why: string } {
	const cls = c.className ?? '';
	const sp = s.spirits.find((x) => x.slot === c.spiritSlotIndex);
	// The class: Beast, or Cultivator when the plan gains more from it.
	let v = -1;
	if (cls === 'Beast' || cls === 'Cultivator') {
		const st = cloneState(s.state);
		if (cls === 'Beast') st.flat += s.rules.beastDamage;
		else st.cultivator += 1;
		v = after(s, st) - baseValue(s) + (cls === 'Beast' ? 0.01 : 0);
	}
	// The host: a spirit that stays. Beast spirits first, then spirits with a class the plan uses.
	let host = 0;
	if (sp?.faceDown) host = -50;
	else if (sp && sp.classes.Beast > 0) host = 0.3;
	else if (
		sp &&
		(sp.classes.Cultivator > 0 ||
			sp.classes['Monster Hunter'] > 0 ||
			sp.classes['Battle Adept'] > 0)
	)
		host = 0.2;
	else if (sp) host = 0.01 * sp.cost;
	// Augments are placed at once (an unplaced one is lost when the round ends).
	return { score: 100 + v + host, why: `place a ${cls} augment on ${sp?.name ?? 'a spirit'}` };
}

/** What a face-down spirit is worth awake (0 or less: leave it). */
function awakenWorth(sp: SpiritLite): number {
	const harmful = ['Corruptor', 'Queen'];
	if (Object.keys(sp.classes).some((k) => harmful.includes(k))) return -1;
	return 2;
}

/** How much the build would miss the spirit in `slot` (low: first to sacrifice). */
function spiritWorth(s: BeastSituation, slot: number): number {
	const sp = s.spirits.find((x) => x.slot === slot);
	if (!sp) return 0;
	const rest = s.spirits.filter((x) => x.slot !== slot);
	const st = boardState(s, rest, s.state);
	return (
		baseValue(s) +
		trioShape(s, s.spirits) -
		after(s, st, boardRules(s, rest)) -
		trioShape(s, rest) +
		0.01 * sp.cost
	);
}

function matWorth(
	m: { name?: string; relicTool?: boolean; special?: boolean; type?: string } | undefined
): number {
	if (!m) return 0;
	if (m.relicTool) {
		if (/flower/i.test(m.name ?? '')) return 1.5;
		if (/diamond/i.test(m.name ?? '')) return 1.4;
		if (/firecracker/i.test(m.name ?? '')) return 1.2;
		return 0.3;
	}
	if (m.special || m.type === 'relic') return 0.2;
	return 1;
}

function scoreDecision(
	s: BeastSituation,
	c: Extract<GameCommand, { type: 'resolveDecision' }>,
	label: string
): { score: number; why: string } {
	const card = s.me.pendingDecisions?.find((d) => d.id === c.decisionId);
	const opt = card?.options.find((o) => o.id === c.optionId);
	const text = `${card?.prompt ?? ''} ${opt?.label ?? ''} ${label}`;
	const id = c.optionId;
	const lowBarrier = s.me.barrier <= Math.max(0, s.me.maxBarrier - s.rules.heal);
	// A Cultivate with five spirits of an origin: the relic once, when it is one the plan uses.
	if (card?.kind === 'originCultivate') {
		const relic = /^relic\|/.test(id);
		const useful = /flower|diamond|firecracker/i.test(
			card.options.find((o) => /^relic\|/.test(o.id))?.label ?? ''
		);
		return { score: relic === useful ? 2 : 1, why: relic ? 'take the relic' : 'take the rune' };
	}
	// Relic tools: keep / points / effect.
	if (/^vp:/.test(id)) return { score: 3, why: 'relic for points' };
	if (/^effect:/.test(id) || /^awaken:/.test(id)) {
		if (/flower/i.test(text)) return { score: lowBarrier ? 2 : 0, why: 'use Flower' };
		if (/diamond/i.test(text)) return { score: s.state.hosts > 0 ? 2 : 0, why: 'use Diamond' };
		if (/firecracker/i.test(text))
			return { score: 2, why: 'use Firecracker (strike first next fight)' };
		return { score: 0.2, why: 'use relic' };
	}
	if (/^keep:/.test(id)) return { score: 1, why: 'keep relic' };
	// Choices of other classes: Max Barrier while it is below the cap, a Beast augment, a relic.
	const optLabel = opt?.label ?? '';
	if (/max barrier/i.test(optLabel) && s.me.maxBarrier < MAX_BARRIER_CAP)
		return { score: 3, why: 'choose Max Barrier' };
	if (/\bBeast\b/i.test(optLabel)) return { score: 2.5, why: 'choose Beast' };
	if (/spirit augment/i.test(optLabel) && s.state.hosts > 0)
		return { score: 2.2, why: 'choose an augment' };
	if (/^flower$/i.test(optLabel.trim())) return { score: 2, why: 'choose Flower' };
	if (DECLINE.test(id) || /^no\b/i.test(optLabel)) return { score: 0.5, why: 'decline' };
	return { score: 0.4, why: 'default option' };
}
