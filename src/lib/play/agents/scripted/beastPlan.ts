/**
 * The planning model of the scripted Beast player (beastPolicy.ts).
 *
 * The player's own board is reduced to a few numbers (damage, Barrier, Max Barrier, runes, spirits
 * that can still take an augment, monster cards in hand, cards left in the decks) and a round is
 * one of: fight at the Arcane Abyss, Rest, Summon and buy augments, Cultivate. `planValue` looks
 * a few rounds ahead over those choices, then plays the rest of the game by a fixed habit ("fight
 * when the Barrier allows it, else Rest") and returns the points the board would have by the
 * expected end of the game (not capped at the winning score, so a faster board always counts for
 * more). The policy compares that number for every option it is offered.
 *
 * Everything random is replaced by its expectation (a drawn monster card is the typical better
 * card of two, a Summon adds the expected number of Beast spirits), so the model is deterministic.
 * Every rule number comes in through `PlanRules`, which the policy fills from the catalog.
 */

export interface PlanCard {
	hp: number;
	maxHp: number;
	/** Barrier the card's hit takes. */
	hit: number;
	vp: number;
	/** Runes among the card's rewards. */
	runes: number;
	/** Value of the card's other rewards, in points. */
	extra: number;
	/** 1-3: the deck; 0: the permanent monster. */
	difficulty: 0 | 1 | 2 | 3;
	/** Index in the real monster hand; -1 for a card the plan draws. */
	handIndex: number;
}

export interface PlanState {
	vp: number;
	/** Points-equivalents gained beside Victory Points (other rewards). */
	bonus: number;
	/** Damage that needs no roll (Beast traits). */
	flat: number;
	/** Expected damage of the attack dice. */
	dice: number;
	cultivator: number;
	maxBarrier: number;
	barrier: number;
	/** Basic runes held. */
	runes: number;
	/** Awake spirits that can still take an augment. */
	hosts: number;
	/** Empty spirit slots. */
	free: number;
	/** Spirits without a Beast trait and without an augment (a summoned Beast may replace one). */
	plain: number;
	/** Runes one Cultivate gives (origins with three or more spirits). */
	runesPerCultivate: number;
	hand: PlanCard[];
	/** Cards left in the decks, index 1-3 (index 0 unused). */
	pools: number[];
}

export interface PlanTuning {
	/** Rounds searched over every choice before the fixed habit takes over. */
	depth: number;
	/** Rounds of the fixed habit that are played out; the rest is extrapolated from its pace. */
	rollout: number;
	/** Weight of the extrapolated part. */
	tail: number;
	/** Points per round still to play that a board at the winning score counts for. */
	winBonus: number;
	/** What a point is worth one round later (below 1: sooner is better, and nothing is put off). */
	discount: number;
	/** Value of a rune still held at the end, in points. */
	runeLeft: number;
	/** Share of a card's points that damage on a card still in hand at the end is worth. */
	chip: number;
}

export interface PlanRules {
	/** Points that win the game. */
	target: number;
	/** Barrier one Rest restores. */
	heal: number;
	maxBarrierCap: number;
	/** Runes and relics kept at the end of a round. */
	carry: number;
	handLimit: number;
	/** Damage one Beast trait gives. */
	beastDamage: number;
	/** Max Barrier one Cultivate gives at this Cultivator count. */
	cultivateMaxBarrier: (cultivator: number) => number;
	/** Monster fights allowed in one round. */
	fightsPerRound: number;
	/** Max Barrier gained by a kill with `overkillAt` or more damage to spare (Battle Adept). */
	overkillMaxBarrier: number;
	overkillAt: number;
	/** Card kinds of each deck (index 1-3) with their number of copies. */
	deckTypes: { card: PlanCard; weight: number }[][];
	/** The permanent monster (always available), or null. */
	lurker: PlanCard | null;
	/** Beast spirits one Spirit World Summon is expected to add (at most two picks). */
	summonBeast: number;
	/** Chance that the Summon's reward hex is a rune. */
	hexRune: number;
	/** Deck cards the other players are expected to take per round. */
	rivalDraws: number;
	tuning: PlanTuning;
	/** Typical drawn card per deck and damage (filled while planning). */
	cache: Map<string, PlanCard | null>;
}

/** What a committed Navigation Power changes in this round's fights. */
export interface FightMods {
	/** Damage taken off every monster hit. */
	reduce?: number;
	/** The player strikes first: a kill is not answered. */
	strikeFirst?: boolean;
	extraDamage?: number;
	/** After the first battle that does not kill: Max Barrier and Barrier gained, points gained. */
	failMaxBarrier?: number;
	failVp?: number;
	/** Fight this card first (index in `hand`), whatever the habit would pick. */
	first?: number;
	/** Fight no card. */
	noFight?: boolean;
}

/** A draw of the visit: a deck (1-3), the permanent monster (0), no draw (-1), or a known card. */
export type Draw = number | PlanCard;

export function cloneState(s: PlanState): PlanState {
	return { ...s, hand: s.hand.map((c) => ({ ...c })), pools: [...s.pools] };
}

/** Damage of one attack in the model: whole Beast traits plus the dice's expectation. */
export function planDamage(s: PlanState): number {
	return Math.round(s.flat) + s.dice;
}

function fightsNeeded(hp: number, damage: number): number {
	return damage <= 0 ? Infinity : Math.max(1, Math.ceil(hp / damage - 1e-9));
}

/** Points per round a card pays: its rewards over the fights it needs and the Rest they cost. */
export function cardPace(card: PlanCard, damage: number, r: PlanRules, reduce = 0): number {
	const fights = fightsNeeded(card.hp, damage);
	if (!Number.isFinite(fights)) return 0;
	const hit = Math.max(0, card.hit - reduce);
	const gain = card.vp + card.extra + card.runes * 0.5;
	return gain / (fights * (1 + hit / Math.max(1, r.heal)));
}

/**
 * What a draw from a deck can add: two cards are revealed and the better one is kept. Returns
 * every card kind of the deck with the chance that it is the one kept (best first).
 */
export function drawOutcomes(
	deck: number,
	s: PlanState,
	r: PlanRules
): { card: PlanCard; chance: number }[] {
	const types = r.deckTypes[deck] ?? [];
	if (!types.length) return [];
	const damage = planDamage(s);
	// A card whose hit the Max Barrier cannot take is the worst kind.
	const pace = (c: PlanCard) => (c.hit >= s.maxBarrier ? -1 : cardPace(c, damage, r));
	const sorted = [...types].sort(
		(a, b) => pace(b.card) - pace(a.card) || a.card.hit - b.card.hit || a.card.hp - b.card.hp
	);
	const total = sorted.reduce((n, t) => n + t.weight, 0);
	let worse = 1; // share of the deck that is this kind or worse
	return sorted.map((t) => {
		const next = Math.max(0, worse - t.weight / total);
		const chance = worse * worse - next * next;
		worse = next;
		return { card: t.card, chance };
	});
}

/**
 * The card a draw from a deck is expected to add, as one card: the Barrier and hit of the median
 * of "the better of two", with its rewards scaled so that it pays per round what the card kept
 * pays on average (a deck whose cards often need one more fight is worth less than its median).
 */
export function typicalCard(deck: number, s: PlanState, r: PlanRules): PlanCard | null {
	const key = `${deck}|${planDamage(s)}|${s.maxBarrier}`;
	const hit = r.cache.get(key);
	if (hit !== undefined) return hit;
	const outcomes = drawOutcomes(deck, s, r);
	let card: PlanCard | null = null;
	if (outcomes.length) {
		let seen = 0;
		let median = outcomes[outcomes.length - 1].card;
		for (const o of outcomes) {
			seen += o.chance;
			if (seen >= 0.5) {
				median = o.card;
				break;
			}
		}
		const damage = planDamage(s);
		const usable = (c: PlanCard) => (c.hit >= s.maxBarrier ? 0 : cardPace(c, damage, r));
		const meanPace = outcomes.reduce((n, o) => n + o.chance * usable(o.card), 0);
		const medianPace = usable(median);
		const scale = medianPace > 0 ? Math.min(1, meanPace / medianPace) : 1;
		card = {
			...median,
			vp: median.vp * scale,
			runes: median.runes * scale,
			extra: median.extra * scale
		};
	}
	r.cache.set(key, card);
	return card;
}

function canDraw(deck: number, s: PlanState, r: PlanRules): boolean {
	if (s.hand.length >= r.handLimit) return false;
	if (deck === 0) return r.lurker !== null;
	return (s.pools[deck] ?? 0) >= 0.5 && typicalCard(deck, s, r) !== null;
}

function addDraw(s: PlanState, r: PlanRules, draw: Draw): void {
	if (typeof draw !== 'number') {
		if (s.hand.length < r.handLimit) s.hand.push({ ...draw });
		return;
	}
	if (draw < 0 || !canDraw(draw, s, r)) return;
	if (draw === 0) {
		s.hand.push({ ...r.lurker! });
		return;
	}
	s.hand.push({ ...typicalCard(draw, s, r)! });
	s.pools[draw] -= 1;
}

/** One battle with the card at `index`. */
function fight(
	s: PlanState,
	r: PlanRules,
	index: number,
	damage: number,
	mods: FightMods
): boolean {
	const card = s.hand[index];
	const kills = damage >= card.hp - 1e-9;
	if (!(mods.strikeFirst && kills)) s.barrier -= Math.max(0, card.hit - (mods.reduce ?? 0));
	const spare = damage - card.hp;
	card.hp -= damage;
	if (!kills) return false;
	s.vp += card.vp;
	s.bonus += card.extra;
	s.runes += card.runes;
	if (r.overkillMaxBarrier > 0 && spare >= r.overkillAt)
		s.maxBarrier = Math.min(r.maxBarrierCap, s.maxBarrier + r.overkillMaxBarrier);
	s.hand.splice(index, 1);
	return true;
}

/** The card in hand worth fighting most now (-1: none can be fought without a corruption). */
function bestTarget(s: PlanState, r: PlanRules, damage: number, mods: FightMods): number {
	let best = -1;
	let bestPace = 0;
	s.hand.forEach((card, i) => {
		const hit = Math.max(0, card.hit - (mods.reduce ?? 0));
		const safe = s.barrier > hit || (mods.strikeFirst === true && damage >= card.hp - 1e-9);
		if (!safe) return;
		const pace = cardPace(card, damage, r, mods.reduce ?? 0);
		if (pace > bestPace) {
			best = i;
			bestPace = pace;
		}
	});
	return best;
}

/** A visit to the Arcane Abyss: the draw, then as many fights as the round allows. */
export function applyAbyss(s: PlanState, r: PlanRules, draw: Draw, mods: FightMods = {}): void {
	addDraw(s, r, draw);
	if (mods.noFight) return;
	const damage = planDamage(s) + (mods.extraDamage ?? 0);
	if (damage <= 0) return;
	let failPaid = false;
	for (let n = 0; n < r.fightsPerRound; n++) {
		const index =
			n === 0 && mods.first !== undefined && mods.first < s.hand.length
				? mods.first
				: bestTarget(s, r, damage, mods);
		if (index < 0) break;
		const killed = fight(s, r, index, damage, mods);
		if (!killed && !failPaid) {
			failPaid = true;
			if (mods.failMaxBarrier) {
				s.maxBarrier = Math.min(r.maxBarrierCap, s.maxBarrier + mods.failMaxBarrier);
				s.barrier = Math.min(s.maxBarrier, s.barrier + mods.failMaxBarrier);
			}
			if (mods.failVp) s.vp += mods.failVp;
		}
	}
}

export function applyRest(s: PlanState, r: PlanRules): void {
	s.barrier = Math.min(s.maxBarrier, s.barrier + r.heal);
}

export function applyCultivate(s: PlanState, r: PlanRules): void {
	s.runes += s.runesPerCultivate;
	s.maxBarrier = Math.min(r.maxBarrierCap, s.maxBarrier + r.cultivateMaxBarrier(s.cultivator));
}

/** Spend runes on augments: `cultivator` of them Cultivator, the rest Beast. */
export function buyAugments(s: PlanState, r: PlanRules, cultivator: number): void {
	const n = Math.max(0, Math.min(s.runes, s.hosts));
	if (n <= 0) return;
	const c = Math.min(cultivator, n);
	s.cultivator += c;
	s.flat += (n - c) * r.beastDamage;
	s.runes -= n;
	// Beast spirits take the augments first; then spirits a summoned Beast could have replaced.
	const beastHosts = Math.max(0, s.hosts - s.plain);
	s.plain -= Math.max(0, n - beastHosts);
	s.hosts -= n;
}

/** A Spirit World Summon in expectation: Beast spirits first, then the rune hex, then any host. */
export function applySummon(s: PlanState, r: PlanRules, beast = r.summonBeast): void {
	let picks = 2;
	const taken = Math.max(0, Math.min(beast, picks, s.free + s.plain));
	s.flat += taken * r.beastDamage;
	const intoFree = Math.min(s.free, taken);
	s.free -= intoFree;
	s.hosts += intoFree;
	s.plain -= taken - intoFree; // a replaced spirit: one host for another
	picks -= taken;
	const hex = Math.min(1, picks) * r.hexRune;
	s.runes += hex;
	picks -= hex;
	const fill = Math.min(s.free, picks);
	s.free -= fill;
	s.hosts += fill;
	s.plain += fill;
}

/** A visit to the Water Region: the Summon, then augments for the runes held. */
export function applyWater(s: PlanState, r: PlanRules, cultivator: number, beast?: number): void {
	applySummon(s, r, beast);
	buyAugments(s, r, cultivator);
}

/** The end of a round: the carry limit, and the cards the other players take. */
export function endRound(s: PlanState, r: PlanRules): void {
	if (s.runes > r.carry) s.runes = r.carry;
	let take = r.rivalDraws;
	for (const deck of [1, 2]) {
		if (take <= 0) break;
		const n = Math.min(take, Math.max(0, s.pools[deck] ?? 0));
		s.pools[deck] -= n;
		take -= n;
	}
}

function chipValue(s: PlanState, r: PlanRules): number {
	return s.hand.reduce(
		(n, c) => n + (c.maxHp > 0 ? (1 - c.hp / c.maxHp) * c.vp * r.tuning.chip : 0),
		0
	);
}

/** Points and other rewards so far. */
function score(s: PlanState): number {
	return s.vp + s.bonus;
}

/** What the board is worth beyond its points when the plan ends. */
function leftovers(s: PlanState, r: PlanRules): number {
	return chipValue(s, r) + s.runes * r.tuning.runeLeft + 0.02 * s.flat + 0.01 * s.maxBarrier;
}

/** The deck whose typical card pays best with this board (0: the permanent monster; -1: none). */
function bestDeck(s: PlanState, r: PlanRules, mustFightNow: boolean): number {
	const damage = planDamage(s);
	let best = -1;
	let bestPace = 0;
	for (const deck of [1, 2, 3, 0]) {
		if (!canDraw(deck, s, r)) continue;
		const card = deck === 0 ? r.lurker! : typicalCard(deck, s, r)!;
		if (card.hit >= (mustFightNow ? s.barrier : s.maxBarrier)) continue;
		const pace = cardPace(card, damage, r);
		if (pace > bestPace) {
			best = deck;
			bestPace = pace;
		}
	}
	return best;
}

/** One round of the fixed habit. False when nothing more can be done. */
function habitRound(s: PlanState, r: PlanRules): boolean {
	const damage = planDamage(s);
	if (damage <= 0) return false;
	const inHand = bestTarget(s, r, damage, {});
	const drawNow = bestDeck(s, r, true);
	if (inHand >= 0 || drawNow >= 0) {
		// Fight; draw the card worth most, for this fight or a later one.
		let draw = drawNow;
		if (inHand >= 0 && drawNow >= 0) {
			const card = drawNow === 0 ? r.lurker! : typicalCard(drawNow, s, r)!;
			if (cardPace(s.hand[inHand], damage, r) >= cardPace(card, damage, r))
				draw = bestDeck(s, r, false);
		} else if (inHand >= 0) draw = bestDeck(s, r, false);
		// The permanent monster is drawn only to be fought now.
		if (draw === 0 && drawNow !== 0) draw = -1;
		applyAbyss(s, r, draw);
		return true;
	}
	if (s.barrier < s.maxBarrier) {
		const later = s.hand.some((c) => c.hit < s.maxBarrier) || bestDeck(s, r, false) >= 0;
		if (!later) return false;
		applyRest(s, r);
		return true;
	}
	return false;
}

/** Sum of `rounds` rounds of 1 point each, discounted. */
function discounted(rounds: number, discount: number): number {
	return discount >= 1 ? rounds : (1 - Math.pow(discount, rounds)) / (1 - discount);
}

/** Play the fixed habit for `left` rounds: the discounted points it gains from `start`. */
function rollout(start: PlanState, r: PlanRules, left: number): number {
	const s = cloneState(start);
	const rounds = Math.min(left, r.tuning.rollout);
	const g = r.tuning.discount;
	let gain = 0;
	let weight = 1;
	let played = 0;
	for (; played < rounds; played++) {
		if (s.vp >= r.target) return gain + weight * discounted(left - played, g) * r.tuning.winBonus;
		const before = score(s);
		if (!habitRound(s, r)) break;
		endRound(s, r);
		gain += weight * (score(s) - before);
		weight *= g;
	}
	gain += weight * leftovers(s, r);
	if (played === rounds && left > rounds && rounds > 0) {
		// Past the played rounds: the same pace, weighted down.
		const pace = (s.vp - start.vp) / rounds;
		gain += weight * pace * discounted(left - rounds, g) * r.tuning.tail;
	}
	return gain;
}

/** The choices of one round in the model. Each returns the board after it. */
function successors(s: PlanState, r: PlanRules): PlanState[] {
	const out: PlanState[] = [];
	const next = (apply: (n: PlanState) => void) => {
		const n = cloneState(s);
		apply(n);
		endRound(n, r);
		out.push(n);
	};
	const damage = planDamage(s);
	if (damage > 0) {
		const fightable = (hit: number) => s.barrier > hit;
		let drew = false;
		for (const deck of [1, 2, 3, 0]) {
			if (!canDraw(deck, s, r)) continue;
			const card = deck === 0 ? r.lurker! : typicalCard(deck, s, r)!;
			// The permanent monster only for a fight now; a deck card also to hold for later.
			if (deck === 0 && !fightable(card.hit)) continue;
			drew = true;
			next((n) => applyAbyss(n, r, deck));
		}
		if (!drew && s.hand.some((c) => fightable(c.hit))) next((n) => applyAbyss(n, r, -1));
	}
	if (s.barrier < s.maxBarrier) next((n) => applyRest(n, r));
	const canBuy = s.runes >= 1 && s.hosts >= 1;
	if (canBuy || s.free > 0 || (s.plain > 0 && r.summonBeast > 0)) {
		next((n) => applyWater(n, r, 0));
		// Cultivator augments: up to the next step that raises Max Barrier on Cultivate.
		if (s.maxBarrier < r.maxBarrierCap) {
			const now = r.cultivateMaxBarrier(s.cultivator);
			for (let k = 1; k <= 2; k++) {
				if (r.cultivateMaxBarrier(s.cultivator + k) > now) {
					// The summon may add the host and the rune this needs: let `buyAugments` cap it.
					next((n) => applyWater(n, r, k));
					break;
				}
			}
		}
	}
	if (
		s.runesPerCultivate > 0 ||
		(s.maxBarrier < r.maxBarrierCap && r.cultivateMaxBarrier(s.cultivator) > 0)
	)
		next((n) => applyCultivate(n, r));
	return out;
}

/** Discounted points a board gains from the start of a round with `left` rounds to play: the
 *  best line of `depth` rounds over every choice, then the fixed habit. */
function futureGain(s: PlanState, r: PlanRules, left: number, depth: number): number {
	const g = r.tuning.discount;
	if (s.vp >= r.target) return discounted(left, g) * r.tuning.winBonus;
	if (left <= 0) return leftovers(s, r);
	if (depth <= 0) return rollout(s, r, left);
	const now = score(s);
	let best = -Infinity;
	for (const n of successors(s, r))
		best = Math.max(best, score(n) - now + g * futureGain(n, r, left - 1, depth - 1));
	if (best === -Infinity) {
		const n = cloneState(s);
		endRound(n, r);
		best = g * futureGain(n, r, left - 1, depth - 1);
	}
	return best;
}

/**
 * Value of a board at the start of a round with `left` rounds to play: its points so far plus
 * the discounted points of the best plan from here.
 */
export function planValue(
	s: PlanState,
	r: PlanRules,
	left: number,
	depth = r.tuning.depth
): number {
	return score(s) + futureGain(s, r, left, depth);
}

/** Value of a board whose round has just been played (the round's end, then `planValue`). */
export function valueAfterRound(s: PlanState, r: PlanRules, left: number, depth?: number): number {
	const n = cloneState(s);
	endRound(n, r);
	return score(n) + r.tuning.discount * futureGain(n, r, left - 1, depth ?? r.tuning.depth);
}
