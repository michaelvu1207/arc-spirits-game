import { beforeNavigationPowerCombat, afterNavigationPowerCombat } from './navigationPowerEffects';
/**
 * Combat resolution (pure). Currently covers Arcane Abyss monster combat, fought
 * by each player independently. PvP reuses the same damage/corruption primitives
 * (P2).
 *
 * Determinism: all rolls come from the seeded RNG carried in game state, so a
 * combat replays identically and is unit-testable.
 */

import type {
	CombatSide,
	CombatState,
	MonsterState,
	PlayCatalog,
	PrivatePlayerState,
	PublicGameState,
	DiceTier,
	SeatColor
} from './types';
import { STATUS_LADDER, setCorruptionDiscardObligation } from './types';
import { nextInt, nextId } from './rng';
import { applyTrigger, awakenedClassCounts } from './effects/apply';
import { applyStatusChange } from './effects/status';
import { applyCorruptionEffects } from './effects/corruption';
import type { EffectCombatInfo } from './effects/context';
import { AWAKEN_PROGRESS_KEYS, AWAKEN_SPIRIT_IDS, isFallen, recordAwakenProgress } from './effects/awakenHandlers';
import { INITIATIVE_DIE_SIDES, initiativeHits, ruleValue, sacrificeMax, sentinelDamagePerDie } from './rules';

/**
 * Per-combat effect flags that class effects (`inCombat`/`onTakeDamage`) set and
 * the combat primitives read. They MUST be cleared at the start of every combat so
 * a bonus/deflect granted in one fight never leaks into the next. `fightMonster`
 * and the PvP path both call this before any roll fires.
 */
export function resetCombatFlags(player: PrivatePlayerState): void {
	player.combatDamageBonus = 0;
	player.deflect = 0;
	player.damageReduction = 0;
	player.combatDamageMultiplier = 1;
	player.attackRollAdvantage = false;
	player.halveIncoming = false;
	player.skipTakeDamage = false;
	// An armed Firecracker ("strike first in one combat") keeps the flag on until the combat
	// that spends it (useStrikeFirstCharge), so the player view shows what that combat does.
	player.alwaysAttackFirst = (player.strikeFirstCharges ?? 0) > 0;
	player.winsInitiativeTies = false;
	player.discardDamageBonus = 0;
	player.rerollZeroDice = false;
	player.relicGuard = false;
	player.combatValueThisFight = undefined;
	// Initiative granted by an in-combat effect must not accumulate between fights,
	// but bonuses granted BEFORE combat must survive this reset. Rebuild that baseline
	// from the active classes whose initiative text fires during Awakening/Navigation;
	// the inCombat trigger below then layers Beast, Huntress, etc. on top.
	// Numeric class breakpoints apply once even if duplicate trait stacks exist.
	// Only Fairy ("When Awakened … Gain 3 Initiative.") grants initiative outside combat
	// today; Relic Envoy's old +3 is not in its November 2026 text, so it is gone.
	const classes = awakenedClassCounts(player);
	player.initiative = classes['Fairy'] ? 3 : 0;
	// `stunImmune` is a per-combat passive granted by inCombat effects (Sharpshooter);
	// clear it so it does not persist into a later combat where the class is absent.
	player.stunImmune = false;
	// `stunned` is a per-combat knockout (zero barrier / corrupted); never leaks out.
	player.stunned = false;
}

/**
 * "Your side may always attack at the same time as the enemy." Granted by an awakened
 * Sharpshooter (count ≥1) or Mystic (count ≥3). A player with this strikes
 * SIMULTANEOUSLY — a corrupting/zero-barrier hit cannot suppress their attack — so they
 * still roll and deal (and can kill with) their damage. Detected from awakened class counts
 * rather than the per-combat `stunImmune` flag, because Mystic grants it on rest and
 * `resetCombatFlags` would otherwise wipe that grant before the fight resolves.
 */
function hasSimultaneousAttack(
	player: PrivatePlayerState,
	catalog?: Pick<PlayCatalog, 'rules'> | null,
	against: 'monster' | 'player' = 'monster'
): boolean {
	const c = awakenedClassCounts(player);
	// Rule `mysticSwap23`: the simultaneous attack is Mystic (2), not (3).
	const mysticAt = 2;
	// Rule `mysticMonstersOnly` (Michael, 2026-11-21): Mystic's simultaneous attack is for fights
	// with monsters only; against players a corrupted Mystic holder is stunned like anyone else.
	const mystic =
		(c['Mystic'] ?? 0) >= mysticAt && !(against === 'player');
	return (c['Sharpshooter'] ?? 0) >= 1 || mystic;
}

/**
 * Spend one armed Firecracker use ("strike first in one combat") on THIS combat. Called after
 * the `inCombat` trigger, before any roll, in both the monster and the PvP path.
 */
export function useStrikeFirstCharge(
	player: PrivatePlayerState,
	log: string[],
	seat?: SeatColor,
	catalog?: Pick<PlayCatalog, 'rules'> | null
): void {
	if ((player.strikeFirstCharges ?? 0) <= 0) return;
	player.strikeFirstCharges = (player.strikeFirstCharges ?? 0) - 1;
	player.alwaysAttackFirst = true;
	log.push(
		`${seat ? `${seat} ` : ''}Firecracker: gains the initiative in this combat if the die misses.`
	);
}

/**
 * Rule `initiativeDie` (Michael, 2026-11-26): roll this player's ONE initiative die. It has 12 sides; how many of
 * them give the initiative depends on the status at the start of the combat (`initiativeHits`: Pure 3, Tainted 5,
 * Corrupt 7, Fallen 9). A roll of that number or less hits. The side rolled stays on the player for the records.
 * `who` starts the log line ("You roll" / "Red rolls").
 */
export function rollInitiativeDie(
	state: PublicGameState,
	player: PrivatePlayerState,
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	log: string[],
	who: string
): boolean {
	const roll = 1 + nextInt(state.rng, INITIATIVE_DIE_SIDES);
	const hits = initiativeHits(catalog, player.statusLevel ?? 0);
	player.initiativeRoll = roll;
	const hit = roll <= hits;
	log.push(
		`${who} the initiative die: ${roll} (${STATUS_LADDER[Math.min(3, Math.max(0, player.statusLevel ?? 0))]} needs ${hits} or less of ${INITIATIVE_DIE_SIDES}) — ${hit ? 'gains the initiative' : 'no initiative'}.`
	);
	return hit;
}

/**
 * Sentinel — "Before you roll in combat, you may discard attack dice. For each dice that you
 * discard, deal 2 more damage." (2, or the catalog's `numbers.sentinelDamagePerDie`.) Discards the dice the owner chose on the Sentinel decision
 * card (still held, awakened Sentinel only) just before this combat's roll, in both the
 * monster and the PvP path. The dice are gone for good; the bonus is for this combat only.
 */
export function useSentinelDiscard(
	player: PrivatePlayerState,
	log: string[],
	seat?: SeatColor,
	catalog?: Pick<PlayCatalog, 'rules'> | null
): void {
	const chosen = new Set(player.sentinelDiscardIds ?? []);
	if (chosen.size === 0) return;
	player.sentinelDiscardIds = [];
	if ((awakenedClassCounts(player)['Sentinel'] ?? 0) < 1) return;
	const before = player.attackDice.length;
	player.attackDice = player.attackDice.filter((die) => !chosen.has(die.instanceId));
	const discarded = before - player.attackDice.length;
	if (discarded === 0) return;
	player.discardDamageBonus = discarded * sentinelDamagePerDie(catalog);
	log.push(
		`${seat ? `${seat} ` : ''}Sentinel: discarded ${discarded} attack ${discarded === 1 ? 'die' : 'dice'} before the roll for ${player.discardDamageBonus} more damage.`
	);
}

/** Prince: "When you strike first, deal 2 more damage." 0 when the class is not awakened. */
export function strikeFirstDamageBonus(player: PrivatePlayerState): number {
	return (awakenedClassCounts(player)['Prince'] ?? 0) >= 1 ? 2 : 0;
}

/**
 * The seat/state plumbing the `onTakeDamage` trigger needs. When present,
 * {@link takeDamage} fires the trigger BEFORE applying damage so class effects can
 * set reductions / halving / skip flags for this hit.
 */
export interface TakeDamageContext {
	state: PublicGameState;
	seat: SeatColor;
	catalog?: PlayCatalog;
	/** The opposing seat (PvP) — read by Bastion to compare initiative. */
	opponent?: SeatColor;
	/** The opposing SIDE's pooled initiative (group Encounter). Bastion prefers this
	 *  over the single representative seat's initiative so it judges the whole side. */
	opponentInitiative?: number;
	/** A monster deals this hit (fightMonster). */
	vsMonster?: boolean;
}

/**
 * Numeric damage per face for each attack-dice tier. These match the live
 * `dice_sides` data (Basic 0,0,0,0,1,1 → avg .33; Enchanted; Exalted; Arcane).
 * Hard-coded here so combat is self-contained and deterministic.
 */
export const DICE_TIER_FACES: Record<DiceTier, number[]> = {
	basic: [0, 0, 0, 0, 1, 1],
	enchanted: [0, 0, 1, 1, 1, 1],
	exalted: [0, 1, 1, 1, 1, 2],
	arcane: [1, 2, 2, 2, 2, 3]
};

export interface FightResult {
	playerDamage: number;
	monsterDamage: number;
	barrierLost: number;
	corrupted: boolean;
	killed: boolean;
	/**
	 * VP granted directly by the fight. Always 0 now — defeating a monster opens a
	 * reward selection (`pendingReward`) where the player claims VP and other
	 * rewards from the monster's reward track instead of a flat kill bonus.
	 */
	vpGained: number;
	log: string[];
	/**
	 * Snapshot of the card as it was fought (ending Barrier; 0 on a kill). The reward
	 * selection and the combat record read THIS, because a kill removes the card from the hand.
	 */
	fought: MonsterState | null;
}

/**
 * The dice under rule `buffedDice` (Michael, 2026-11-20): averages 0.5 / 1 / 1.5 / 2 instead of
 * 0.33 / 0.67 / 1 / 2. The Arcane die keeps its average of 2 but swings widely: these are the
 * faces of the Arcane die in the game data (`dice_sides`).
 */
export const BUFFED_DICE_TIER_FACES: Record<DiceTier, number[]> = {
	basic: [0, 0, 0, 1, 1, 1],
	enchanted: [0, 1, 1, 1, 1, 2],
	exalted: [1, 1, 1, 2, 2, 2],
	arcane: [0, 0, 1, 3, 3, 5]
};

/**
 * The dice under rule `weakLowDice` (Michael, 2026-11-21): Basic back at an average of 0.33 and
 * Enchanted at 0.83, the six-face average nearest below the middle of Basic and Exalted (0.92);
 * Exalted (1.5) and Arcane (2) as under `buffedDice`.
 */
export const WEAK_LOW_DICE_TIER_FACES: Record<DiceTier, number[]> = {
	basic: [0, 0, 0, 0, 1, 1],
	enchanted: [0, 0, 1, 1, 1, 2],
	exalted: BUFFED_DICE_TIER_FACES.exalted,
	arcane: BUFFED_DICE_TIER_FACES.arcane
};

/** Under `weakLowDice` with the rule `enchantedTwoThirds` (Michael, 2026-11-22): Enchanted 0,0,1,1,1,1 (0.67), not 0.83. */
export const TWO_THIRDS_DICE_TIER_FACES: Record<DiceTier, number[]> = {
	...WEAK_LOW_DICE_TIER_FACES,
	enchanted: [0, 0, 1, 1, 1, 1]
};

/** The faces of the attack dice: Basic averages 0.33, Enchanted 0.5, Exalted 1.5, Arcane 2. */
export const OFFICIAL_DICE_TIER_FACES: Record<DiceTier, number[]> = {
	basic: [0, 0, 0, 0, 1, 1],
	enchanted: [0, 0, 0, 1, 1, 1],
	exalted: [1, 1, 1, 2, 2, 2],
	arcane: [0, 0, 1, 3, 3, 5]
};

/** The faces of each attack-dice tier. */
export function diceTierFaces(catalog?: Parameters<typeof ruleValue>[0]): Record<DiceTier, number[]> {
	return OFFICIAL_DICE_TIER_FACES;
}

function rollTier(state: PublicGameState, tier: DiceTier, catalog?: Parameters<typeof ruleValue>[0]): number {
	const faces = diceTierFaces(catalog)[tier];
	return faces[nextInt(state.rng, faces.length)];
}

/**
 * Apply `amount` damage to a player: flip barrier tokens to broken barrier; if the damage
 * reduces the player's barrier to ZERO (all tokens flipped to the broken barrier
 * side / 0 barrier), the player Corrupts (status drops one step and all barriers
 * are restored). Returns whether corruption happened.
 */
export function takeDamage(
	player: PrivatePlayerState,
	amount: number,
	ctx?: TakeDamageContext,
	log?: string[],
	/** Catalog read only for rule switches (`fallenDebtBelowZero`) when `ctx` has none. */
	rulesCatalog?: Pick<PlayCatalog, 'rules'>,
	/** `sacrificeCap` (rule `pvpAttackerSacrificeCap`): a corruption from this hit owes at most this. */
	opts?: { sacrificeCap?: number }
): { corrupted: boolean; barrierLost: number; discarded: number; deflected: number } {
	// Fire the onTakeDamage trigger BEFORE applying, so class effects (Aquamaiden,
	// Firekeeper, Bastion, Guardian) can set reductions / halve / skip flags for
	// this hit. The incoming `amount` is exposed via combat.dealt so handlers that
	// branch on the raw hit (Guardian) can see it.
	// Reductions that onTakeDamage effects add (Warden, Shieldbearer) are for THIS hit only:
	// the combat-wide reduction (inCombat: Titan, Monk, …) is restored after the hit.
	const combatReduction = player.damageReduction ?? 0;
	if (ctx) {
		const combat: EffectCombatInfo = {
			dealt: amount,
			overkill: 0,
			killed: false,
			opponent: ctx.opponent,
			opponentInitiative: ctx.opponentInitiative,
			...(ctx.vsMonster ? { vsMonster: true } : {})
		};
		applyTrigger(ctx.state, ctx.seat, 'onTakeDamage', log ?? [], {
			catalog: ctx.catalog,
			combat,
			opponent: ctx.opponent
		});
	}

	// Guardian: skip the take-damage step entirely (it would have corrupted).
	if (player.skipTakeDamage) {
		player.damageReduction = combatReduction;
		return { corrupted: false, barrierLost: 0, discarded: 0, deflected: 0 };
	}

	// Mitigation primitives (default 0 ⇒ no change): reduce + deflect before barriers.
	// DEFLECTED damage is not just absorbed — it is dealt BACK to the opponent
	// (Michael's ruling, 2026-07-03): the caller receives `deflected` and applies it
	// (fightMonster counts it as damage dealt to the monster this combat; the PvP
	// strike hits the attacking side's representative). Reduction soaks first; only
	// damage that would have landed can be deflected.
	const deflected = Math.min(
		player.deflect ?? 0,
		Math.max(0, amount - (player.damageReduction ?? 0))
	);
	const mitigation = (player.damageReduction ?? 0) + (player.deflect ?? 0);
	player.damageReduction = combatReduction;
	amount = Math.max(0, amount - mitigation);
	// 'Bastion': halve the (post-reduction) incoming damage, rounding up.
	if (player.halveIncoming) amount = Math.ceil(amount / 2);
	if (amount <= 0) return { corrupted: false, barrierLost: 0, discarded: 0, deflected };
	// Relic Sentinel: "When you Take Damage, you may choose to take 0 damage if you discard a
	// relic." Combat does not pause between hits, so the owner's guard rule (set on the Relic
	// Sentinel decision card) decides: 'lethal' = only a hit that would corrupt (empty the
	// barrier), 'everyHit' = every hit. ('never' does not arm the guard.)
	const guardThisHit =
		player.relicGuard &&
		((player.relicGuardMode ?? 'lethal') === 'everyHit' || amount >= player.barrier);
	if (guardThisHit) {
		// Spend a relic without a tool text (e.g. a Fairy relic) before a relic tool.
		const held = (player.mats ?? []).filter((slot) => slot.type === 'relic' && slot.hasRune);
		const relic = held.find((slot) => !slot.relicTool) ?? held[0];
		if (relic) {
			relic.hasRune = false;
			if ((player.relics ?? 0) > 0) player.relics -= 1;
			log?.push(`Relic Sentinel: discarded ${relic.name ?? 'a relic'} to take 0 damage.`);
			return { corrupted: false, barrierLost: 0, discarded: 0, deflected };
		}
	}
	const barrierBefore = player.barrier;
	const barrierLost = Math.min(barrierBefore, amount);
	player.barrier = Math.max(0, barrierBefore - amount);
	player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);

	// Corruption fires when the hit empties the barrier — all tokens are now on the
	// broken barrier side (0 barrier). NOT on "overkill" (damage strictly exceeding barrier): being
	// ground down to EXACTLY zero must corrupt too, and a hit that only dents the barrier must not.
	// `player.barrier` was just clamped on the line above, so this is the post-hit value.
	const corrupted = player.barrier === 0;
	if (corrupted) {
		const oldStatus = player.statusLevel;
		player.statusLevel = Math.min(STATUS_LADDER.length - 1, player.statusLevel + 1);
		player.statusToken = STATUS_LADDER[player.statusLevel];
		// Corruption INSTANTLY restores all barrier (flip broken barrier back to barrier side) — then
		// bills the escalating SACRIFICE: bump the corruption counter and owe that many forced
		// spirit discards (1st corruption sheds 1, 2nd 2, 3rd 3, …; accumulates across one
		// exchange). The owner picks which spirits to shed; the deadline drain auto-resolves any
		// remainder. This is the single corruption site for combat.
		player.barrier = player.maxBarrier;
		player.brokenBarrier = 0;
		// Mystic II: after corruption restores barrier to full, gain 2 potential.
		// The new capacity begins broken, preserving the ordering stated by the ability.
		// Under rule `mysticCultivateDouble` Mystic (2) is the Cultivate doubling instead (apply.ts).
		if (
			(awakenedClassCounts(player)['Mystic'] ?? 0) >= 2 &&
			false
		) {
			const before = player.maxBarrier;
			player.maxBarrier = Math.min(10, player.maxBarrier + 2);
			player.brokenBarrier = player.maxBarrier - player.barrier;
			const gained = player.maxBarrier - before;
			if (gained > 0) log?.push(`Mystic: gained ${gained} max barrier after corruption.`);
		}
		player.corruptionCount = (player.corruptionCount ?? 0) + 1;
		applyCorruptionEffects(player, log, {
			wasFallen: oldStatus === STATUS_LADDER.length - 1,
			catalog: ctx?.catalog ?? rulesCatalog
		});
		const sacrificeCap = opts?.sacrificeCap;
		const vpCharged = setCorruptionDiscardObligation(player, undefined, {
			wasFallen: oldStatus === STATUS_LADDER.length - 1,
			vpBelowZero: true,
			...(sacrificeCap != null ? { maxOwed: sacrificeCap } : {}),
			maxCount: sacrificeMax(ctx?.catalog ?? rulesCatalog)
		});
		if (sacrificeCap != null && (player.corruptionCount ?? 0) > sacrificeCap) {
			log?.push(
				`Evil attacker: this corruption costs at most ${sacrificeCap} sacrifice${sacrificeCap === 1 ? '' : 's'}.`
			);
		}
		if (vpCharged > 0) {
			log?.push(
				`Corruption while Fallen: ${vpCharged} owed sacrifice${vpCharged === 1 ? '' : 's'} could not be paid in spirits — ${vpCharged} VP lost instead.`
			);
		}
		// onStatusChange: record the crossed thresholds + fire the trigger (only when
		// we have the state/seat plumbing — `ctx` is absent for bare-player tests).
		if (ctx && player.statusLevel !== oldStatus) {
			applyStatusChange(ctx.state, ctx.seat, oldStatus, player.statusLevel, ctx.catalog, log ?? []);
		}
	}
	// `discarded` is retained for caller back-compat but is always 0 now: corruption no
	// longer auto-trims spirits here — it queues a forced player-chosen discard instead.
	return { corrupted, barrierLost, discarded: 0, deflected };
}

/**
 * Total attack damage from a player's dice pool (rolled via the seeded RNG),
 * plus any flat `combatDamageBonus` (default 0 ⇒ no change). This is the single
 * source of a player's dealt damage, so `fightMonster` inherits the bonus
 * through this call rather than re-adding it.
 */
export function rollAttack(
	state: PublicGameState,
	player: PrivatePlayerState,
	catalog?: Parameters<typeof ruleValue>[0]
): number {
	const rollOnce = (): number => {
		let total = 0;
		for (const die of player.attackDice) {
			let face = rollTier(state, die.tier, catalog);
			// Salamander: "roll again each attack dice that shows 0, once."
			if (face === 0 && player.rerollZeroDice) face = rollTier(state, die.tier, catalog);
			total += face;
		}
		return total;
	};
	// Assassin (Space Invader) rolls the whole attack twice and keeps the higher
	// total ("roll twice, take the higher roll"). Default ⇒ a single roll.
	const total = player.attackRollAdvantage ? Math.max(rollOnce(), rollOnce()) : rollOnce();
	// Flat bonus (combatBonus / Woundreaver) added to the rolled dice, then the
	// whole sum scaled by the per-combat multiplier (Paladin's odd-barrier
	// doubling). Default multiplier is 1 ⇒ no change.
	const withBonus = total + (player.combatDamageBonus ?? 0);
	const value = withBonus * (player.combatDamageMultiplier ?? 1);
	player.combatValueThisFight = value;
	// Sentinel: +2 damage per attack die discarded before this roll (flat, after the
	// multiplier, and not part of the combat value — like the earlier Sentinel bonus).
	return value + (player.discardDamageBonus ?? 0);
}

/**
 * Expected (average) total damage of a player's attack roll AT REST: the mean of
 * each attack die's faces, plus the flat Beast bonus (+1 per awakened
 * Beast trait — its `inCombat` combatBonus, which only goes live mid-fight).
 * Situational modifiers (Woundreaver, Paladin) are excluded. Shared by the
 * scout dice-pool readout and the leaderboard so they always agree.
 */
export function expectedAttack(player: PrivatePlayerState, catalog?: Parameters<typeof ruleValue>[0]): number {
	let dice = 0;
	const tiers = diceTierFaces(catalog);
	for (const die of player.attackDice) {
		const faces = tiers[die.tier];
		dice += faces.reduce((a, b) => a + b, 0) / faces.length;
	}
	return dice + (awakenedClassCounts(player)['Beast'] ?? 0);
}

type EncounterCombatant = { seat: SeatColor; player: PrivatePlayerState };

/**
 * Resolve a single group Encounter (PvP) exchange at one location.
 *
 * EVIL (the co-located Fallen aggressors) and GOOD (co-located non-Fallen players)
 * each pool their initiative and dice. Rules:
 *  • Higher TOTAL initiative side strikes first; EQUAL initiative → both strike at
 *    once (both rolls are locked before either lands, so a stun can't suppress a
 *    simultaneous counter-strike).
 *  • A side's TOTAL rolled damage hits EVERY opposing player in full — no splitting.
 *  • A player reduced to zero barrier OR corrupted is STUNNED (unless `stunImmune`)
 *    and cannot strike back this exchange.
 *  • Single exchange — faster side, then the slower side's survivors. No looping.
 *
 * Pure w.r.t. the seeded RNG (replayable). Mutates the participants; VP and awaken
 * progress for the Evil side are applied by the caller. Returns the CombatState for
 * the overlay.
 */
export function resolveEncounterCombat(
	state: PublicGameState,
	catalog: PlayCatalog | undefined,
	evilSeats: SeatColor[],
	goodSeats: SeatColor[]
): CombatState {
	const collect = (seats: SeatColor[]): EncounterCombatant[] =>
		seats
			.map((seat) => ({ seat, player: state.players[seat] }))
			.filter((c): c is EncounterCombatant => !!c.player);
	const evil = collect(evilSeats);
	const good = collect(goodSeats);

	// Clear per-combat flags, then fire `inCombat` for every participant so class
	// effects (initiative, combatBonus, deflect, stunImmune, …) land before any roll.
	// Each participant is threaded a representative opposing seat (first in seat order)
	// for effects that read the opponent (e.g. Bastion's initiative compare).
	const repGood = good[0]?.seat;
	const repEvil = evil[0]?.seat;
	const damageOpts = (seat: SeatColor): { sacrificeCap?: number } | undefined =>
		undefined;
	// The combat log is built up-front so the pre-roll triggers below write into it —
	// otherwise class-buff lines (Beast's +dmg/+init, Paladin's doubling,
	// Assassin's +init) would be discarded and the PvP overlay would show damage
	// change with no explanation (PvE already threads its real log into inCombat).
	const log: string[] = [];
	for (const { player } of [...evil, ...good]) resetCombatFlags(player);
	// Every participant encounters an opposing player before the exchange. Effects
	// such as Infiltrator and Undercover receive a representative opposing seat.
	for (const { seat } of evil)
		applyTrigger(state, seat, 'onPlayerInteraction', log, { catalog, opponent: repGood });
	for (const { seat } of good)
		applyTrigger(state, seat, 'onPlayerInteraction', log, { catalog, opponent: repEvil });
	for (const { seat } of evil)
		applyTrigger(state, seat, 'inCombat', log, { catalog, opponent: repGood });
	for (const { seat } of good)
		applyTrigger(state, seat, 'inCombat', log, { catalog, opponent: repEvil });

	for (const { seat } of [...evil, ...good]) beforeNavigationPowerCombat(state, seat, true);
	for (const { seat, player } of [...evil, ...good]) useStrikeFirstCharge(player, log, seat, catalog);
	for (const { seat, player } of [...evil, ...good]) useSentinelDiscard(player, log, seat, catalog);
	const sumInit = (group: EncounterCombatant[]): number =>
		group.reduce((s, { player }) => s + (player.initiative ?? 0), 0);
	const sideInitiative = (group: EncounterCombatant[], label: string): number => {
		let hits = 0;
		for (const { seat, player } of group) {
			if (rollInitiativeDie(state, player, catalog, log, `${seat} rolls`)) hits += 1;
		}
		if (hits === 0 && group.some(({ player }) => player.alwaysAttackFirst)) {
			hits = 1;
			log.push(`${label} gains the initiative through an ability.`);
		}
		const total = hits;
		for (const { player } of group) player.initiative = total;
		if (group.length > 1) log.push(`${label} has ${total} initiative in all.`);
		return total;
	};
	const initE = sideInitiative(evil, 'Evil');
	const initG = sideInitiative(good, 'Good');

	const dealt = new Map<SeatColor, number>();
	const rolledSeats = new Set<SeatColor>();
	const corruptedSeats = new Set<SeatColor>();
	// Lock every combat value before the first strike (makes simultaneous combat
	// deterministic; Sentinel's discard bonus is already set at this point).
	const lockedRolls = new Map<SeatColor, number>();
	for (const { seat, player } of [...evil, ...good]) {
		lockedRolls.set(seat, rollAttack(state, player, catalog));
	}

	const rollSide = (group: EncounterCombatant[], strikesFirst = false): number => {
		let total = 0;
		for (const { seat, player } of group) {
			let r = lockedRolls.get(seat) ?? rollAttack(state, player, catalog);
			// Prince: +2 damage for each striker on the side that strikes first.
			const princeBonus = strikesFirst ? strikeFirstDamageBonus(player) : 0;
			if (princeBonus > 0) {
				r += princeBonus;
				log.push(
					`${seat} Prince: its side has more initiative — deals ${princeBonus} more damage.`
				);
			}
			dealt.set(seat, r);
			rolledSeats.add(seat);
			total += r;
		}
		return total;
	};

	/** Apply one side's total damage to every defender; returns the largest Barrier loss. */
	const strike = (
		defenders: EncounterCombatant[],
		dmg: number,
		attackerRep: SeatColor | undefined,
		attackerInit: number,
		attackerLabel: string,
		defenderLabel: string
	): number => {
		log.push(`${attackerLabel} deals ${dmg} to each ${defenderLabel} player.`);
		let maxLost = 0;
		for (const { seat, player } of defenders) {
			// opponentInitiative = the attacking SIDE's pooled total, so Bastion judges
			// against the whole side (not just the representative seat).
			const { corrupted, deflected, barrierLost } = takeDamage(
				player,
				dmg,
				{ state, seat, catalog, opponent: attackerRep, opponentInitiative: attackerInit },
				log,
				undefined,
				damageOpts(seat)
			);
			maxLost = Math.max(maxLost, barrierLost);
			if (corrupted) corruptedSeats.add(seat);
			// Deflected damage is dealt BACK to the attacking side's representative.
			// Applied without a trigger context so it cannot chain (a reflection is
			// never itself deflected — takeDamage only reports; callers reflect).
			if (deflected > 0 && attackerRep) {
				const attacker = state.players[attackerRep];
				if (attacker) {
					const bounce = takeDamage(attacker, deflected, undefined, log, catalog, damageOpts(attackerRep));
					if (bounce.corrupted) corruptedSeats.add(attackerRep);
					log.push(
						`${seat} deflects ${deflected} damage back at ${attackerRep}` +
							(bounce.corrupted ? ` — ${attackerRep} is corrupted!` : '.')
					);
				}
			}
			const attacksSimultaneously = player.stunImmune || hasSimultaneousAttack(player, catalog, 'player');
			if ((corrupted || player.barrier === 0) && !attacksSimultaneously) {
				player.stunned = true;
				log.push(`${seat} is stunned and cannot strike back.`);
			} else if (corrupted) {
				log.push(`${seat} attacks at the same time despite corruption.`);
			}
		}
		return maxLost;
	};

	/** After a strike that made a player lose Barrier: Acolyte restores, Veiled Acolyte's awaken. */
	const afterStrike = (attackers: EncounterCombatant[], lost: number): void => {
		if (lost <= 0) return;
		for (const { seat, player } of attackers) {
			const own = dealt.get(seat) ?? 0;
			if (own <= 0) continue;
			if (isFallen(player)) {
				recordAwakenProgress(player, AWAKEN_SPIRIT_IDS.veiledAcolyte, AWAKEN_PROGRESS_KEYS.veiledAcolyte);
			}
			if ((awakenedClassCounts(player)['Acolyte'] ?? 0) <= 0) continue;
			const before = player.barrier;
			player.barrier = Math.min(player.maxBarrier, player.barrier + Math.min(lost, own));
			player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
			if (player.barrier > before) log.push(`${seat} Acolyte: restores ${player.barrier - before} Barrier.`);
		}
	};
	// Paladin: "If initiative is tied, your side strikes first." Only breaks a real tie
	// (same initiative AND same attack-first priority); both sides with a Paladin stay tied.
	const tied = initE === initG && false === false;
	// Under `initiativeDie` Paladin only decides when BOTH sides have the initiative (neither: at the same time).
	// Under `initiativeSum`: the same number of 1 or more.
	const paladinCounts = tied && (initE >= 1);
	const evilWinsTie = paladinCounts && evil.some(({ player }) => player.winsInitiativeTies);
	const goodWinsTie = paladinCounts && good.some(({ player }) => player.winsInitiativeTies);
	if (tied && evilWinsTie === goodWinsTie) {
		// Simultaneous: lock BOTH rolls (full rosters) before either hit lands.
		const dmgE = rollSide(evil);
		const dmgG = rollSide(good);
		log.push(
			`Both sides have ${initE} initiative — they attack at the same time.`
		);
		afterStrike(evil, strike(good, dmgE, repEvil, initE, 'Evil', 'Good'));
		afterStrike(good, strike(evil, dmgG, repGood, initG, 'Good', 'Evil'));
	} else {
		const evilFaster = tied
			? evilWinsTie
			: false !== false
				? false
				: initE > initG;
		const first = evilFaster ? evil : good;
		const second = evilFaster ? good : evil;
		const firstRep = evilFaster ? repEvil : repGood;
		const secondRep = evilFaster ? repGood : repEvil;
		const firstInit = evilFaster ? initE : initG;
		const secondInit = evilFaster ? initG : initE;
		const firstLabel = evilFaster ? 'Evil' : 'Good';
		const secondLabel = evilFaster ? 'Good' : 'Evil';
		log.push(
			tied
					? `Both sides have ${firstInit} initiative — ${firstLabel} attacks first through Paladin.`
					: `${firstLabel} has more initiative (${firstInit} against ${secondInit}) and attacks first.`
		);
		// Prince ("when your side has the initiative and the enemy does not") gains nothing from Paladin's tie-break.
		afterStrike(first, strike(second, rollSide(first, !(tied)), firstRep, firstInit, firstLabel, secondLabel));
		// Only un-stunned members of the slower side strike back.
		const retaliators = second.filter(({ player }) => !player.stunned);
		if (retaliators.length > 0) {
			afterStrike(
				retaliators,
				strike(first, rollSide(retaliators), secondRep, secondInit, secondLabel, firstLabel)
			);
		} else {
			log.push(`${secondLabel} is fully stunned — no retaliation.`);
		}
	}

	// Witch: give back the dice taken for this combat.
	for (const { player } of [...evil, ...good]) {
		for (const { fromSeat, die } of player.witchBorrowedDice ?? []) {
			const owner = state.players[fromSeat];
			const at = player.attackDice.findIndex((d) => d.instanceId === die.instanceId);
			if (at < 0 || !owner) continue;
			player.attackDice.splice(at, 1);
			owner.attackDice.push(die);
		}
		player.witchBorrowedDice = [];
	}
	// Moonrend's awaken ("While Fallen, attack another player."): the Evil side is the attacking side.
	for (const { player } of evil) {
		if (isFallen(player)) recordAwakenProgress(player, AWAKEN_SPIRIT_IDS.moonrend, AWAKEN_PROGRESS_KEYS.moonrend);
	}

	for (const { seat } of evil)
		afterNavigationPowerCombat(
			state,
			seat,
			good.some((x) => corruptedSeats.has(x.seat)),
			true
		);
	for (const { seat } of good)
		afterNavigationPowerCombat(
			state,
			seat,
			evil.some((x) => corruptedSeats.has(x.seat)),
			true
		);
	const sideFor = (group: EncounterCombatant[], side: 'evil' | 'good'): CombatSide[] =>
		group.map(({ seat, player }) => ({
			seat,
			side,
			initiative: player.initiative ?? 0,
			...(player.initiativeRoll != null ? { initiativeRoll: player.initiativeRoll } : {}),
			rolled: rolledSeats.has(seat),
			damageDealt: dealt.get(seat) ?? 0,
			stunned: !!player.stunned,
			corrupted: corruptedSeats.has(seat)
		}));

	return {
		id: nextId(state.rng, 'pvp'),
		kind: 'pvp',
		step: 'resolved',
		killed: false,
		sides: [...sideFor(evil, 'evil'), ...sideFor(good, 'good')],
		monster: null,
		log
	};
}

/** Damage still needed to defeat `monster`: its remaining Barrier (stored in `hp`). It persists
 *  between fights, so every hit any player lands brings the shared monster card closer to death. */
export function monsterBarrierLeft(monster: Pick<MonsterState, 'hp'>): number {
	return Math.max(0, monster.hp);
}

/**
 * Resolve one full monster fight for `seat`. Monsters have infinite initiative,
 * so the monster strikes first; a corrupted player cannot strike back. The monster card in
 * the player's hand is PERSISTENT: damage lowers its Barrier and nothing resets between
 * combats, so the player can wear it down across fights and visits. On a kill
 * the player gains a reward pick and the card leaves the game at the round boundary.
 * Mutates state; returns a result for the UI.
 */
/** A monster card's initiative; no printed number ⇒ infinite (it always strikes first). */
export function monsterInitiativeOf(monster: { initiative?: number }): number {
	return typeof monster.initiative === 'number' ? monster.initiative : Number.POSITIVE_INFINITY;
}

export function fightMonster(
	state: PublicGameState,
	seat: SeatColor,
	catalog?: PlayCatalog,
	handIndex = 0
): FightResult | null {
	const player = state.players[seat];
	const monster = player?.monsterHand?.[handIndex];
	if (!player || !monster) return null;

	const log: string[] = [];

	// 0. Fresh combat: clear any per-combat flags from a previous fight, then fire
	//    the `inCombat` trigger so this player's class effects (combatBonus,
	//    initiative, deflect, damageReduction, Paladin doubling, …) apply to
	//    THIS combat before any roll happens.
	resetCombatFlags(player);
	applyTrigger(state, seat, 'inCombat', log, { catalog });
	beforeNavigationPowerCombat(state, seat, false);
	useStrikeFirstCharge(player, log, undefined, catalog);
	useSentinelDiscard(player, log, undefined, catalog);
	let hasInitiative = false;
	hasInitiative = rollInitiativeDie(state, player, catalog, log, 'You roll');
	if (!hasInitiative && player.alwaysAttackFirst) {
		hasInitiative = true;
		log.push('You gain the initiative through an ability.');
	}
	player.initiative = hasInitiative ? 1 : 0;
	log.push(
		hasInitiative
			? `${monster.name} has the initiative too — you attack at the same time.`
			: `${monster.name} has the initiative and attacks first.`
	);
	// Lock the combat value before damage.
	let rolledDamage = rollAttack(state, player, catalog);
	// A monster with an initiative number is outpaced by a player with HIGHER initiative (a tie
	// goes to the monster unless the player wins ties, e.g. Paladin). No number ⇒ infinite.
	const monsterInitiative = 1;
	const princeBonus = 0;
	if (princeBonus > 0) {
		rolledDamage += princeBonus;
		log.push(`Prince: you strike first and deal ${princeBonus} more damage.`);
	}

	// 1. Unless an attack-first strike already defeated it, the monster attacks.
	//    The take-damage context lets onTakeDamage class
	//    effects (Aquamaiden/Firekeeper/Guardian) fire before the hit is applied.
	//    Bastion compares against the monster's initiative (infinite without a number); under
	//    rule `bastionVsMonsters` it halves every monster hit (`vsMonster`).
	const damageResult = takeDamage(
				player,
				monster.damage,
				{ state, seat, catalog, opponentInitiative: monsterInitiative, vsMonster: true },
				log
			);
	const { corrupted, barrierLost, discarded, deflected } = damageResult;
	log.push(`${monster.name} attacks for ${monster.damage} (${barrierLost} barrier lost).`);
	if (deflected > 0) log.push(`Deflected ${deflected} damage back at ${monster.name}.`);
	if (corrupted) log.push(`You were corrupted — status is now ${player.statusToken}.`);
	if (discarded > 0) log.push(`Discarded ${discarded} spirit(s) to meet the new limit.`);

	// 2. Player counter-attacks against the monster's CURRENT Barrier + HP (both persist between
	//    combats). Normally a corrupted player cannot strike back — but a player with "attack at the
	//    same time as the enemy" (Sharpshooter / Mystic ≥2) strikes SIMULTANEOUSLY, so even a
	//    corrupting hit still lands their damage (and can kill).
	let playerDamage = 0;
	const hpBeforeStrike = monsterBarrierLeft(monster);
	const simultaneous = hasSimultaneousAttack(player, catalog) || hasInitiative;
	if ((!corrupted || simultaneous)) {
		playerDamage = rolledDamage;
		log.push(
			corrupted
				? `You attack at the same time as the monster for ${playerDamage} damage (despite corruption).`
				: `You roll ${player.attackDice.length} attack dice for ${playerDamage} damage.`
		);
	} else {
		log.push(`Corrupted players cannot strike back this combat.`);
	}

	// 3. Resolve the outcome: damage removes the monster's Barrier, which never recovers. DEFLECTED
	//    damage from the monster's opening strike counts as damage
	//    dealt to it (it is passive reflection, so it lands even for a corrupted player who
	//    cannot strike back). The `onMonsterKill` trigger fires on EVERY combat resolution
	//    (carrying `killed`), so Battle Adept's no-kill branch runs; Fairy's rune is gated
	//    behind `killed`.
	const incomingMonsterDamage = playerDamage + deflected;
	const barrierLostByMonster = Math.min(monsterBarrierLeft(monster), incomingMonsterDamage);
	monster.hp = Math.max(0, monster.hp - barrierLostByMonster);
	const endingHp = monster.hp;
	const killed = endingHp <= 0;
	if (barrierLostByMonster > 0 && !killed)
		log.push(`${monster.name} loses ${barrierLostByMonster} Barrier (${monster.hp}/${monster.maxHp} left).`);
	if (corrupted) {
		player.awakenProgress ??= {};
		player.awakenProgress[AWAKEN_PROGRESS_KEYS.cosmicGuardian] = true;
		if (!killed) player.awakenProgress[AWAKEN_PROGRESS_KEYS.hollowEyes] = true;
	}
	const vpGained = 0; // VP now comes from the reward selection, not a flat kill bonus.
	if (killed) {
		log.push(`${monster.name} defeated! Claim your rewards.`);
	}
	applyTrigger(state, seat, 'onMonsterKill', log, {
		catalog,
		combat: {
			dealt: playerDamage,
			overkill: Math.max(0, playerDamage + deflected - hpBeforeStrike),
			killed,
			monsterDifficulty: monster.difficulty,
			monsterPermanent: monster.permanent === true
		}
	});

	// Rule `difficulty3Restores`: a card with the ability restores Barrier after a fight it survives
	// (never above its printed Barrier). Whatever the fight dealt beyond that stays on the card.
	if (!killed && (monster.restoreAfterCombat ?? 0) > 0 && monster.hp < monster.maxHp) {
		const restored = Math.min(monster.restoreAfterCombat!, monster.maxHp - monster.hp);
		monster.hp += restored;
		log.push(`${monster.name} restores ${restored} Barrier (${monster.hp}/${monster.maxHp}).`);
	}

	// Snapshot the card AS FOUGHT (the Barrier it is left with after this combat; 0 on a kill) for
	// the reward and the combat record. A surviving card keeps its damage in the player's hand.
	const fought: MonsterState = { ...monster, hp: monster.hp };
	if (killed) {
		// A defeated card leaves the game at once.
		player.monsterHand = (player.monsterHand ?? []).filter((card) => card !== monster);
		log.push(`The ${monster.name} card leaves the game.`);
	}

	afterNavigationPowerCombat(state, seat, killed, false);
	return {
		playerDamage,
		monsterDamage: monster.damage,
		barrierLost,
		corrupted,
		killed,
		vpGained,
		log,
		fought
	};
}

/** VP an Evil attacker earns from a PvP exchange: 2 for engaging, plus 2 per opposing
 *  player corrupted during the exchange. (Michael's ruling, 2026-07-07 — flat engage
 *  fee + corruption bounty; no roll-scaling, no target-VP scaling.)
 *  Rule switch `pvpPaysOnCorrupt` (`paysOnCorrupt`): 3 per opposing player corrupted, nothing
 *  for the attack itself; with `pvpEngageVp` (`engageVp`) also 2 for the attack. */
export function pvpVpForAttack(
	corruptedOpponents: number,
	paysOnCorrupt = false,
	engageVp = false,
	perCorrupted = PVP_VP_PER_CORRUPTED
): number {
	const corrupted = Math.max(0, corruptedOpponents);
	if (!paysOnCorrupt) return 2 + 2 * corrupted;
	return (engageVp ? PVP_ENGAGE_VP : 0) + perCorrupted * corrupted;
}

/** `pvpPaysOnCorrupt` + `pvpEngageVp`: the Evil attacker's VP for the attack itself. */
export const PVP_ENGAGE_VP = 2;

/** `pvpPaysOnCorrupt`: the Evil attacker's VP per Good player corrupted. */
export const PVP_VP_PER_CORRUPTED = 3;
/** `pvpPaysOnCorrupt`: that amount under the rules of `catalog` (4 with `pvpCorruptPays4`). */
export function pvpVpPerCorrupted(catalog: Parameters<typeof ruleValue>[0]): number {
	return PVP_VP_PER_CORRUPTED;
}
/** `pvpPaysOnCorrupt`: each Good player's VP per Evil attacker corrupted in the exchange. */
export const PVP_GOOD_BOUNTY = 2;

/** VP each Good player of a PvP exchange earns under `pvpPaysOnCorrupt` (0 without the rule). */
export function pvpGoodBounty(corruptedAttackers: number, paysOnCorrupt = false): number {
	return paysOnCorrupt ? PVP_GOOD_BOUNTY * Math.max(0, corruptedAttackers) : 0;
}

/** Kills needed to defeat a monster — every rung of the ladder, including the final one —
 *  scaled by player count: 1 player → 1 life, 2-3 players → 2 lives, 4+ players → 3 lives.
 *  (Michael's rulings, 2026-07-07: the 2p bump keeps the monster pool rich enough that
 *  someone can reach 30 VP without PvP at every table size.) */
export function monsterLivesForPlayerCount(playerCount: number): number {
	if (playerCount >= 4) return 3;
	if (playerCount >= 2) return 2;
	return 1;
}

/**
 * Round-boundary upkeep for the monster cards (called from `enterCleanup`). Open reveals settle.
 * A card in a hand keeps its damage: its Barrier never recovers. Once every monster card is gone
 * — decks empty, no cards in any hand — the spirit world is saved and the game ends at this
 * cleanup with final scoring. Not with a permanent monster in the catalog: it is never gone.
 */
export function advanceMonsterIfDefeated(state: PublicGameState, catalog?: PlayCatalog): void {
	returnOpenMonsterReveals(state, catalog);
	if (!monsterDeckWasDealt(state)) return;
	// A permanent monster is never gone, so empty decks do not end the game.
	if (state.permanentMonster || (catalog?.monsters ?? []).some((m) => m.permanent)) return;
	const deckEmpty = (state.bags?.monsters?.contents?.length ?? 0) === 0;
	const handsEmpty = (state.activeSeats ?? []).every((seat) => {
		const p = state.players[seat];
		return !p?.monsterHand?.length && !p?.pendingMonsterDraw?.cards.length;
	});
	if (deckEmpty && handsEmpty) {
		state.spiritWorldSaved = true;
	}
}

/** A monster reveal still open when the Location phase ends (deadline / forced advance) keeps
 *  its first card for the player when their hand has room; every other revealed card goes back
 *  to the bottom of its deck, so no card ever leaks out of play. Rule `monsterDrawOne`: a card that
 *  is not kept goes back on TOP of its deck (where it was drawn from). */
export function returnOpenMonsterReveals(state: PublicGameState, catalog?: PlayCatalog): void {
	for (const seat of state.activeSeats ?? []) {
		const player = state.players[seat];
		const cards = player?.pendingMonsterDraw?.cards ?? [];
		if (!player || cards.length === 0) continue;
		player.monsterHand ??= [];
		const keepFirst = player.monsterHand.length < 3;
		if (keepFirst) player.monsterHand.push(cards[0]);
		for (const [index, card] of cards.entries()) {
			if (keepFirst && index === 0) continue;
			state.bags.monsters.contents['unshift']({
				guid: `monster-card-${card.id}-${state.round}-${seat}-${index}`,
				id: card.id,
				name: card.name,
				barrier: card.maxHp,
				damage: card.damage,
				difficulty: card.difficulty
			});
		}
		state.bags.monsters.count = state.bags.monsters.contents.length;
		player.pendingMonsterDraw = null;
	}
}

/** True once a monster deck existed in this game (a bare unit-test state never had one). */
function monsterDeckWasDealt(state: PublicGameState): boolean {
	return state.monsterDecks?.some((deck) => deck.total > 0) ?? false;
}
