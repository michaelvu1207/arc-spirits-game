/**
 * Rule switches: rules.json (an object of named switches in the game-data folder) →
 * PlayCatalog.rules. They let a rule change be A/B tested from game data while old game
 * records still replay exactly:
 *
 *   { "feralMonsterStrikeFirst": false, "summonReplaceWhenFull": true, "cultivatorRelicOnce": true }
 *
 * Every switch is optional. Absent ⇒ its default, which is the rule before 2026-11-13. Loaders
 * write `catalog.rules` only with the switches that differ from the default (and not at all when
 * none do), so a catalog built without the table — every catalog saved before tonight — keeps
 * its hash and its games replay to the recorded state hash.
 *
 * The switches (proposals C2, C3, C6 in ~/arcspirits-harness/experiments/analysis/proposals.md):
 * - feralMonsterStrikeFirst (default true): false ⇒ against a monster, Feral no longer strikes
 *   first; it still deals 3 more damage. Against an Evil player it is unchanged.
 * - summonReplaceWhenFull (default false): true ⇒ with all 7 spirit slots full, a summon may
 *   replace one spirit of the player's choice (`spawnHandSpirit.replaceSlotIndex`); the replaced
 *   spirit is discarded exactly like `discardSpirit` (back to its bag, its augment lost, discard
 *   effects fire) but does not count as a corruption sacrifice.
 * - summonerOncePerRound (default false): true ⇒ Summoner gains its 4 VP for a discarded Arcane
 *   Abyss spirit only once per round (balance test 2026-11-18: with a full board every Abyss
 *   summon is a discard, which paid 8 to 13 VP a round).
 * - cultivatorRelicOnce (default false): true ⇒ Cultivator (5) grants its relic only the first
 *   time per game (the Max Barrier part is unchanged).
 *
 * Proposal C (P1-P4 in ~/arcspirits-harness/experiments/evil/report.md):
 * - pvpPaysOnCorrupt (default false): true ⇒ an Evil attacker gets 3 VP per Good player corrupted
 *   in the exchange and nothing for the attack itself (old: 2 + 2 per corrupted); each Good player
 *   in the exchange gets 2 VP per Evil attacker corrupted (old: nothing). See `pvpVpForAttack`.
 * - pvpGoodBounty (default true): only read under pvpPaysOnCorrupt. false ⇒ no Good bounty: the
 *   attacker still gets 3 VP per Good player corrupted, Good players get nothing (Michael,
 *   2026-11-13). Default true keeps the proposal-C test records replaying.
 * - abyssSummonDraw4Pick2 (default false): true ⇒ an Arcane Abyss Summon draws 4 and summons up
 *   to 2 (old: draw 3, summon 1). See `summonDrawSizes` in runtime.ts.
 * - firetailVsMonsters (default false): true ⇒ Firetail's +3 Initiative also applies in every monster
 *   combat (old: only in a round when another player is at your location).
 * - moonPerksNeedAttack (default false): true ⇒ Queen's 1 VP and Sorcerer's Enchanted die in the
 *   Awakening Phase only in a round in which that player attacked a player
 *   (`attackedPlayerThisRound`, written only under this rule).
 * - corruptorCountsAsCorruption (default false): true ⇒ Corruptor's drop to Fallen is one
 *   corruption: corruption count +1, Barrier restored, corruption effects (Cultist), and the usual
 *   sacrifice. The Spirit World → Arcane swap is unchanged.
 * - fallenDebtBelowZero (default false): true ⇒ while Fallen, each owed sacrifice that cannot be
 *   paid in spirits costs 1 VP even below 0: VP may go negative (no separate debt is kept).
 *
 * Sun / Bastion / PvP (2026-11-13):
 * - sunRework (default false): true ⇒ new texts for Mage, Chorus, Shieldbearer, Nomad, Gardener and
 *   Cleric (King unchanged); see RULE_CLASS_TEXT below and each class file.
 * - bastionVsMonsters (default false): true ⇒ Bastion halves every monster hit, whatever the
 *   monster's initiative (as when monsters had infinite initiative). PvP unchanged.
 * - pvpEngageVp (default false): only read under pvpPaysOnCorrupt. true ⇒ the Evil attacker also
 *   gets 2 VP for the attack itself (2 + 3 per Good player corrupted). See `pvpVpForAttack`.
 * - pvpAttackerSacrificeCap (default false): true ⇒ an Evil attacker corrupted in a PvP exchange it
 *   started owes at most 1 sacrifice for that corruption (its corruption count still rises).
 *
 * Powers (2026-11-13):
 * - powerRework (default false): true ⇒ the Navigation Power set is `NAVIGATION_POWERS_V2`
 *   (navigationPowers.ts): 11 general and 11 niche Powers, none needing another player to be Evil.
 *   Drafts, random Power gains and the rules brief read `navigationPowerPool(catalog)`.
 *
 * Mystic (2026-11-14, Michael):
 * - mysticCultivateDouble (default false): true ⇒ Mystic (2) is "When you Cultivate, you may gain
 *   twice as many runes." The engine always takes the second rune (runes over the carry limit are
 *   discarded by the player's choice, so more is never worse). It does not stack with another
 *   doubling of the turn. The old Mystic (2), 2 Max Barrier after a corruption, is off.
 *
 * Cultivate (2026-11-14, Michael):
 * - cultivateRuneOrRelic (default false): true ⇒ a Cultivate gives one reward per origin. 3+ spirits
 *   of the origin: its rune. 5+ spirits: its rune, or the origin's relic instead (the relic one
 *   time per player); the player chooses on a card (effects/originCultivate.ts). Old: at 5+ the
 *   rune and, the first time, also the relic.
 *
 * Ram (2026-11-14, Michael):
 * - ramAugmentDamage (default false): true ⇒ Ram is "In combat, deal 1 more damage for each Spirit
 *   Augment on your spirits." (effects/classes/infiltrator.ts). The old Ram, a Spirit Augment on
 *   arriving at the Mountain Region, is off.
 *
 * PvP place (2026-11-14):
 * - pvpInAbyss (default false): true ⇒ an Evil player may also attack the Good players that share
 *   the Arcane Abyss with it (old: only in the four regions). See `pvpAllowedAt`.
 *
 * Class changes of 2026-11-14 (Michael), one switch each:
 * - mysticSwap23 (default false): true ⇒ Mystic (2) is the simultaneous attack and Mystic (3) the
 *   Cultivate doubling (the two abilities change places). Read with `mysticCultivateDouble`.
 * - falconerDoubleKill (default false): true ⇒ Falconer is "On your next monster kill you may gain
 *   double the rewards. Then discard this spirit." A card after the kill asks; yes doubles every
 *   reward of that kill and discards the Falconer spirit. The old Falconer (2 augments on awaken,
 *   a remote augment trade) is off.
 * - herderArcaneAugments (default false): true ⇒ Herder is "Each of your Arcane spirits may hold up
 *   to 2 Spirit Augments." (capacity only; Arcane = cost 7 or more). The old Herder (runes for
 *   Beasts on awaken) is off.
 * - riderAugmentOption (default false): true ⇒ Rider's Mountain Region choice has a fourth option:
 *   gain 1 Spirit Augment of your choice.
 * - mageArcaneDice (default false): true ⇒ Mage is "On this spirit's Awakening, gain 4 Arcane
 *   Attack Dice." and nothing else (no rune trade in the Awakening Phase).
 * - shieldbearerFullOnly (default false): true ⇒ Shieldbearer is "When you take damage, if your
 *   Barrier is full, take 5 less." and nothing when it is not full.
 * - masterBarrierChoice (default false): true ⇒ Master is "On Cultivate, gain 2 Max Barrier or
 *   restore 2 Barrier". A card asks only while both would give something (some Barrier broken and
 *   Max Barrier below its cap); unanswered, it gives Max Barrier. See effects/classes/master.ts.
 *
 * Balance test of 2026-11-18 (games ended in round 4 to 13; see also `summonerOncePerRound`):
 * - falconerNoDoubleVp (default false): only read under falconerDoubleKill. true ⇒ Falconer doubles
 *   every reward of the kill except Victory Points (a doubled Difficulty 3 kill paid up to 14 VP
 *   in one move).
 * - relicAwakenNeedsBoard (default false): true ⇒ the Cleansing Teapot cannot awaken a spirit whose
 *   awakening text is "Have N <Origin> Spirits…" (Caldera, Storm King, Hollowbloom) while the
 *   player holds fewer than N spirits of that origin. The full origin board is then the only way.
 * - summonerPays2 (default false): true ⇒ Summoner gains 2 VP (not 4) for a discarded Arcane Abyss
 *   spirit. With `summonerOncePerRound` a 7-Forest board still paid 4 VP every round from round 6
 *   (24 of the winner's 30 points in three test games). The printed text assumes both are on.
 * - winAt40 (default false): true ⇒ the game is won at 40 Victory Points, not 30 (see `vpToWin`).
 *   Under the lower monster points of the balance test, a 30-point game ended near round 19.
 * - sidePointsHalf (default false): true ⇒ Victory Points from anything other than a monster's
 *   reward count half (two make 1 Victory Point). See sidePoints.ts. With monster kills at 1 to 2
 *   points, seats took their points from 1-point-a-round class effects instead.
 * - queenUnawakens (default false; Michael, 2026-11-18): true ⇒ Queen is "When this spirit awakens,
 *   every player must turn one of their awakened spirits face-down (their choice)." and gives no
 *   VP. See effects/classes/worldEnder.ts.
 * - summonerCultivate (default false; Michael, 2026-11-18): true ⇒ Summoner is "When you Cultivate
 *   with at least 5 Forest spirits, gain 2 points." and nothing else (no Arcane Abyss draw on a
 *   Spirit World summon, no points for a discarded Arcane Abyss spirit).
 * - cultistNoVp (default false; Michael, 2026-11-18): true ⇒ Cultist is "When you become Corrupted,
 *   sacrifice 1 fewer spirit." (no point). A new Cultist ability is not designed yet.
 * - captainPowerOnKill (default false; Michael, 2026-11-18): true ⇒ Captain is "After you defeat a
 *   monster, gain 1 random Power. When discarded, gain 1 Enchanted Attack." (no Cultivate clause).
 * - captainNoDiscardDie (default false; Michael, 2026-11-18): only read with captainPowerOnKill. true ⇒
 *   the Captain has no "When discarded" clause either.
 * - alchemistAugmentToArcane (default false; Michael, 2026-11-18): true ⇒ Arcane Alchemist is "When
 *   you Cultivate, you may convert 1 of your Spirit Augments into 1 Arcane Attack Dice."
 * - healerNoVp (default false; Michael, 2026-11-18): true ⇒ Healer's Rest restores 3 Barrier at 10
 *   Max Barrier and gives no point.
 * - feralNoDamage (default false; Michael, 2026-11-18): true ⇒ Feral deals no extra damage; it is
 *   "When an Evil player or a monster attacks you, your side strikes first."
 * - corruptorAwakenMaxBarrier (default false; Michael, 2026-11-18): true ⇒ awakening the Corruptor
 *   (Nhal) also gives 4 Max Barrier.
 * - kingPureOnly (default false; balance test, 2026-11-19): true ⇒ King is "In the Awakening Phase, if you
 *   are Pure, gain 1 VP. If you are Evil, you must discard this spirit." (Tainted and Corrupt: no point).
 * - nhalNeedsCorrupt (default false; balance test, 2026-11-19): true ⇒ Nhal's awakening is "Navigate to the
 *   Arcane Abyss while Corrupt or Fallen, but don't fight the monster.": a visit as Pure or Tainted does
 *   not count. The printed text comes from the data (`awaken_condition.text`); see runtime.ts.
 * - pvpCorruptPays4 (default false; balance test, 2026-11-19): only read under pvpPaysOnCorrupt. true ⇒ the
 *   Evil attacker gets 4 VP per Good player corrupted, not 3 (see `pvpVpPerCorrupted` in combat.ts).
 * - goodKillBonus (default false; Michael, 2026-11-19): true ⇒ a Good-aligned player (Pure, Tainted or
 *   Corrupt; not Fallen) gets GOOD_KILL_BONUS_VP (1) for every kill of a Difficulty 2 or 3 monster, on top
 *   of the card's rewards (`goodKillBonus` in runtime.ts). Those cards give 1 VP less each to go with it;
 *   Difficulty 1 cards are unchanged and pay no bonus.
 * - princessRune (default false; balance test, 2026-11-18): true ⇒ Princess is "In the Awakening Phase, if
 *   you are not Evil and all your spirits are awakened, gain 1 Any basic Rune." (no point).
 * - buffedDice (default false; Michael, 2026-11-20): true ⇒ the attack dice are stronger: Basic 0,0,0,1,1,1
 *   (average 0.5), Enchanted 0,1,1,1,1,2 (1), Exalted 1,1,1,2,2,2 (1.5), Arcane 0,0,1,3,3,5 (2 as before,
 *   with a wide spread). See `diceTierFaces` in combat.ts.
 * - weakLowDice (default false; Michael, 2026-11-21, during Test 31): true ⇒ Basic 0,0,0,0,1,1 (0.33) and
 *   Enchanted 0,0,1,1,1,2 (0.83); Exalted 1,1,1,2,2,2 and Arcane 0,0,1,3,3,5 as under `buffedDice`, which it
 *   overrides. See `diceTierFaces` in combat.ts.
 * - enchantedTwoThirds (default false; Michael, 2026-11-22): only read under `weakLowDice`; true ⇒ the
 *   Enchanted die is 0,0,1,1,1,1 (0.67), so the dice are 0.33 / 0.67 / 1.5. See `diceTierFaces` in combat.ts.
 * - elementalistRest1235 (default false; Michael, 2026-11-22): true ⇒ Elementalist upgrades on Rest only:
 *   1 / 2 / 3 / 5 attack dice at 2 / 3 / 4 / 5 Elementalists, the lowest die first. It overrides
 *   `elementalistMethods`: a kill, a Cultivate, a Spirit World Summon and Arcane Blood upgrade nothing.
 *   See `elementalistRestUpgrades` in classes/elementalist.ts.
 * - elementalistOnCultivate (default false; Michael, 2026-11-22: "move elementalists to on cultivate instead
 *   of on rest so it doesn't conflict with fighters"): only read under `elementalistRest1235`; true ⇒ the
 *   ladder's upgrades come when the player Cultivates, and a Rest upgrades nothing. A relic taken on a
 *   Cultivate counts from the next Cultivate. See `elementalistUpgradeAction` below.
 * - elementalist5NeedsRelic (default false; Michael, 2026-11-22): only read under `elementalistRest1235`;
 *   true ⇒ the step at 5 Elementalists counts only while the player holds a relic (any relic); without
 *   one, 5 Elementalists upgrade as 4 do.
 * - numbers (not a switch; Michael, 2026-11-22: "tweak the numbers for dice, and elementalist upgrade"): an
 *   optional object of rule numbers. `diceFaces` {tier: faces} replaces the faces of those attack-dice
 *   tiers under any dice switch; `elementalistRest` [a, b, c, d] replaces 1 / 2 / 3 / 5 under
 *   `elementalistRest1235`. Absent ⇒ the numbers the switches give. See `parseRuleNumbers` below.
 * - fighterInitiative (default false; Michael, 2026-11-20): true ⇒ in combat Fighter gives 1 initiative
 *   per Fighter trait, up to 5, starting at one trait (a new first breakpoint; the dice on Rest are
 *   unchanged). The printed text is in the class data. See classes/fighter.ts.
 * - elementalistMethods (default false; Michael, 2026-11-20): true ⇒ Elementalist is "upgrade an attack
 *   dice twice" per action (an upgrade raises the lowest Basic or Enchanted die one step, as before), and
 *   each breakpoint adds one action that upgrades: (2) defeating a monster (the permanent one too),
 *   (3) Rest, (4) Cultivate, (5) a Spirit World Summon. The old ladder (1 / 2 / 5 / 10 upgrades per Rest)
 *   is gone. The printed text is in the class data. See classes/elementalist.ts.
 * - elementalistOneUpgrade (default false; Michael, 2026-11-20): true ⇒ under `elementalistMethods` each
 *   action upgrades an attack dice once, not twice. See `elementalistUpgradesPerAction` in classes/elementalist.ts.
 * - elementalistBigKills (default false; Michael, 2026-11-21): true ⇒ under `elementalistMethods` a kill
 *   of a Difficulty 2 or 3 card upgrades an attack dice twice; a Difficulty 1 card and the permanent
 *   monster (the Abyss Lurker) keep the upgrades of one action. See `elementalistKillUpgrades` in
 *   classes/elementalist.ts.
 * - battleAdeptNoDice (default false; Michael, 2026-11-21): true ⇒ Battle Adept gains no attack dice
 *   when a fight does not kill; the Max Barrier for an overkill stays. See classes/adaptiveFighter.ts.
 * - arcaneBlood (default false; Michael, 2026-11-21): true ⇒ a player who defeats a monster takes
 *   either every reward of the card or Arcane Blood in their place: 1 for a Difficulty 1 card and the
 *   permanent monster, 2 for Difficulty 2, 3 for Difficulty 3 (`arcaneBloodFor` in runtime.ts). The
 *   Good-alignment kill bonus is not a reward and is kept either way. Elementalist (2) becomes "When
 *   you gain an Arcane Blood, upgrade an attack dice" and a kill by itself upgrades nothing
 *   (classes/elementalist.ts). Arcane Blood is not kept: it is an event other classes may use later.
 * - arcaneBloodDouble (default false; Michael, 2026-11-21, after Test 27 where Arcane Blood was taken in
 *   31 of 516 offers): only read under `arcaneBlood`. true ⇒ a kill offers 2 / 4 / 6 Arcane Blood
 *   (Difficulty 1 and the permanent monster 2, Difficulty 2 4, Difficulty 3 6), not 1 / 2 / 3.
 * - arcaneBloodPerPoint (default false; Michael, 2026-11-21, after Test 30): only read under `arcaneBlood`;
 *   overrides `arcaneBloodTwoPerPoint` and `arcaneBloodDouble`. true ⇒ a kill offers 1 Arcane Blood for
 *   the permanent monster, 2 for Difficulty 1, 4 for Difficulty 2, 7 for Difficulty 3 (one per point of
 *   the level's card).
 * - restBase4 (default false; Michael, 2026-11-21, during Test 29 where players rested in a third of
 *   their turns): true ⇒ a Rest restores 4 Barrier, not 2, before the `restByStatus` bonus (with it:
 *   Pure 7, Tainted 6, Corrupt 5, Fallen 4). See `restBarrier` below.
 * - arcaneBloodTwoPerPoint (default false; Michael, 2026-11-21, after Test 28 where Arcane Blood was taken
 *   in 0 of 165 offers): only read under `arcaneBlood`; overrides `arcaneBloodDouble`. true ⇒ a kill
 *   offers 2 Arcane Blood for the permanent monster, 4 for Difficulty 1, 8 for Difficulty 2, 12 for
 *   Difficulty 3 (two per point of the card's value).
 * - permanentRewardChoice (default false; Michael, 2026-11-21): true ⇒ a kill of the permanent monster
 *   gives ONE of the rewards on its card, the player's choice (`picks[0]`; the first when none is
 *   named), not every reward. Deck cards still give every reward. See `rewardChoiceOf` in runtime.ts.
 * - spiritInitiativeTrim (default false; Michael, 2026-11-21): true ⇒ Monk gives 3 Initiative (not 5),
 *   Paladin 2 (not 4; it still wins ties) and Firetail 2 (not 3), so single spirits do not stand in
 *   for a Fighter build. See classes/strategist.ts, darkAssassin.ts, firetail.ts.
 * - mysticMonstersOnly (default false; Michael, 2026-11-21): true ⇒ Mystic's attack "at the same time as
 *   the enemy" works in fights with monsters only, not against players (Sharpshooter is unchanged). See
 *   `hasSimultaneousAttack` in combat.ts.
 * - beastNoInitiative (default false; Michael, 2026-11-21): true ⇒ Beast gives 1 combat damage per trait
 *   and no combat initiative; initiative comes from Fighter (`fighterInitiative`). See
 *   classes/spiritAnimal.ts.
 * - restByStatus (default false; Michael, 2026-11-20): true ⇒ Rest restores 2 Barrier plus 1 for each
 *   status step above Fallen (Pure 5, Tainted 4, Corrupt 3, Fallen 2), never above Max Barrier. See
 *   `restBarrier` below and `applyRest` in effects/apply.ts.
 * - fairyEnchanted (default false; Michael, 2026-11-20): true ⇒ a Fairy's awakening gives Enchanted
 *   Attack Dice, not Exalted (still 1 for every spirit matching its origin). See `fairyDiceTier` below.
 * - cursedSpiritBasic (default false; Michael, 2026-11-20): true ⇒ the attack dice of Cursed Spirit's
 *   Tainted reward are Basic, not Enchanted (still 1 Max Barrier or 1 dice per Cursed Spirit). See
 *   `cursedSpiritDiceTier` below.
 * - fighterDice35 (default false; Michael, 2026-11-21, during Test 31): true ⇒ on Rest Fighter (4) gives
 *   3 Basic Attack Dice (not 5) and Fighter (5) gives 5 (not 10); 2 and 3 Fighter, the initiative and the
 *   Spirit Augment at 5 are unchanged. See `ruleAdjustedActions` below and `applyClassTrigger` in effects/apply.ts.
 * - cultivatorBarrier35 (default false; Michael, 2026-11-21, during Test 31): true ⇒ on Cultivate
 *   Cultivator (4) gives 3 Max Barrier (not 5) and Cultivator (5) gives 5 (not 10); the relic at 5 is
 *   unchanged. See `ruleAdjustedActions` below.
 * - monsterDeckByStage (default false): true ⇒ a monster card's deck (Difficulty 1, 2, 3) is its
 *   `stage` in the monster table, not its Barrier band (1-3, 4-7, 8+). A Barrier edit then never
 *   moves a card to another deck. See `monsterDifficulty` in runtime.ts.
 */

import type { ClassBreakpoint } from '$lib/types';
import { DICE_TIER_ORDER, VP_TO_WIN, type DiceTier, type PlayCatalog, type PlayRuleSwitches, type PlayRules, type RuleNumbers } from './types';

export type RuleName = keyof PlayRuleSwitches;

export const RULE_DEFAULTS: Required<PlayRuleSwitches> = {
	feralMonsterStrikeFirst: true,
	summonReplaceWhenFull: false,
	cultivatorRelicOnce: false,
	summonerOncePerRound: false,
	pvpPaysOnCorrupt: false,
	pvpGoodBounty: true,
	abyssSummonDraw4Pick2: false,
	firetailVsMonsters: false,
	moonPerksNeedAttack: false,
	corruptorCountsAsCorruption: false,
	fallenDebtBelowZero: false,
	sunRework: false,
	bastionVsMonsters: false,
	pvpEngageVp: false,
	pvpAttackerSacrificeCap: false,
	powerRework: false,
	mysticCultivateDouble: false,
	cultivateRuneOrRelic: false,
	ramAugmentDamage: false,
	pvpInAbyss: false,
	mysticSwap23: false,
	falconerDoubleKill: false,
	herderArcaneAugments: false,
	riderAugmentOption: false,
	mageArcaneDice: false,
	shieldbearerFullOnly: false,
	masterBarrierChoice: false,
	falconerNoDoubleVp: false,
	relicAwakenNeedsBoard: false,
	monsterDeckByStage: false,
	summonerPays2: false,
	winAt40: false,
	sidePointsHalf: false,
	queenUnawakens: false,
	summonerCultivate: false,
	cultistNoVp: false,
	captainPowerOnKill: false,
	alchemistAugmentToArcane: false,
	healerNoVp: false,
	feralNoDamage: false,
	corruptorAwakenMaxBarrier: false,
	captainNoDiscardDie: false,
	princessRune: false,
	kingPureOnly: false,
	nhalNeedsCorrupt: false,
	pvpCorruptPays4: false,
	goodKillBonus: false,
	buffedDice: false,
	weakLowDice: false,
	enchantedTwoThirds: false,
	elementalistRest1235: false,
	elementalistOnCultivate: false,
	elementalist5NeedsRelic: false,
	fighterInitiative: false,
	elementalistMethods: false,
	restByStatus: false,
	fairyEnchanted: false,
	cursedSpiritBasic: false,
	elementalistOneUpgrade: false,
	elementalistBigKills: false,
	battleAdeptNoDice: false,
	beastNoInitiative: false,
	mysticMonstersOnly: false,
	spiritInitiativeTrim: false,
	arcaneBlood: false,
	arcaneBloodDouble: false,
	arcaneBloodTwoPerPoint: false,
	arcaneBloodPerPoint: false,
	restBase4: false,
	fighterDice35: false,
	cultivatorBarrier35: false,
	permanentRewardChoice: false
};

const RULE_NAMES = Object.keys(RULE_DEFAULTS) as RuleName[];

/** The tier of the attack dice a Fairy gives when it awakens: Exalted, or Enchanted under `fairyEnchanted`. */
export function fairyDiceTier(catalog: Parameters<typeof ruleValue>[0]): 'enchanted' | 'exalted' {
	return ruleValue(catalog, 'fairyEnchanted') ? 'enchanted' : 'exalted';
}

/** The tier of the attack dice of Cursed Spirit's Tainted reward: Enchanted, or Basic under `cursedSpiritBasic`. */
export function cursedSpiritDiceTier(catalog: Parameters<typeof ruleValue>[0]): 'basic' | 'enchanted' {
	return ruleValue(catalog, 'cursedSpiritBasic') ? 'basic' : 'enchanted';
}

/** Amounts a rule switch gives a class breakpoint in place of the amount in its ability file. */
const RULE_CLASS_AMOUNTS: { rule: RuleName; className: string; count: number; kind: string; amount: number }[] = [
	{ rule: 'fighterDice35', className: 'Fighter', count: 4, kind: 'gainAttackDice', amount: 3 },
	{ rule: 'fighterDice35', className: 'Fighter', count: 5, kind: 'gainAttackDice', amount: 5 },
	{ rule: 'cultivatorBarrier35', className: 'Cultivator', count: 4, kind: 'gainMaxBarrier', amount: 3 },
	{ rule: 'cultivatorBarrier35', className: 'Cultivator', count: 5, kind: 'gainMaxBarrier', amount: 5 }
];

/**
 * The actions of the breakpoint `count` of class `className` under the rules of `catalog`: the same
 * list (the same array when no rule changes it) with the amounts of `RULE_CLASS_AMOUNTS` put in.
 */
export function ruleAdjustedActions<A extends { kind: string }>(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	className: string,
	count: number | string,
	actions: A[]
): A[] {
	const changes = RULE_CLASS_AMOUNTS.filter((c) => c.className === className && c.count === Number(count) && ruleValue(catalog, c.rule));
	if (!changes.length) return actions;
	return actions.map((a) => { const c = changes.find((x) => x.kind === a.kind); return c ? { ...a, amount: c.amount } : a; });
}

/** The Barrier a Rest restores without the rule `restByStatus`, and at Fallen with it. */
export const REST_BARRIER = 2;

/**
 * The Barrier a Rest restores at status `statusLevel` (0 Pure, 1 Tainted, 2 Corrupt, 3 Fallen).
 * Under `restByStatus`: 2 plus 1 for each status step above Fallen.
 */
export function restBarrier(catalog: Pick<PlayCatalog, 'rules'> | null | undefined, statusLevel: number): number {
	// Rule `restBase4` (Michael, 2026-11-21): the base is 4, not 2.
	const base = ruleValue(catalog, 'restBase4') ? 4 : REST_BARRIER;
	if (!ruleValue(catalog, 'restByStatus')) return base;
	return base + Math.max(0, 3 - Math.max(0, statusLevel));
}

/**
 * rules.json content (an object; a one-row array as served by a table is accepted too) → the
 * switches that differ from their default, or `undefined` when none do. Unknown names and
 * non-boolean values are reported in `problems` and ignored.
 */
export function parseRules(raw: unknown): { rules: PlayRules | undefined; problems: string[] } {
	const problems: string[] = [];
	const rows = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
	const rules: PlayRules = {};
	for (const row of rows) {
		if (!row || typeof row !== 'object') {
			problems.push(`rules: expected an object, got ${JSON.stringify(row)}`);
			continue;
		}
		for (const [name, value] of Object.entries(row as Record<string, unknown>)) {
			if (name === 'local' || name === 'id' || name.startsWith('_')) continue; // notes / row ids
			if (name === 'numbers') {
				const numbers = parseRuleNumbers(value, problems);
				if (numbers) rules.numbers = numbers;
				else delete rules.numbers;
				continue;
			}
			if (!RULE_NAMES.includes(name as RuleName)) {
				problems.push(`rules: unknown switch "${name}" (known: ${RULE_NAMES.join(', ')})`);
				continue;
			}
			if (typeof value !== 'boolean') {
				problems.push(`rules: "${name}" must be true or false, got ${JSON.stringify(value)}`);
				continue;
			}
			if (value !== RULE_DEFAULTS[name as RuleName]) rules[name as RuleName] = value;
			else delete rules[name as RuleName];
		}
	}
	return { rules: Object.keys(rules).length ? rules : undefined, problems };
}

/** Upgrades per Rest at 2 / 3 / 4 / 5 Elementalists under `elementalistRest1235`, unless `numbers.elementalistRest` says otherwise. */
export const ELEMENTALIST_REST_DEFAULT: [number, number, number, number] = [1, 2, 3, 5];

const wholeNumbers = (v: unknown, min: number, max: number): v is number[] =>
	Array.isArray(v) && v.length >= min && v.length <= max && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 99);

/** rules.json `numbers` → the valid rule numbers, or `undefined` when there are none. Bad entries are reported and ignored. */
function parseRuleNumbers(raw: unknown, problems: string[]): RuleNumbers | undefined {
	if (raw == null) return undefined;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		problems.push(`rules: "numbers" must be an object, got ${JSON.stringify(raw)}`);
		return undefined;
	}
	const numbers: RuleNumbers = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (name.startsWith('_')) continue; // notes
		if (name === 'diceFaces') {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				problems.push(`rules: numbers.diceFaces must be an object of tier → faces, got ${JSON.stringify(value)}`);
				continue;
			}
			const faces: Partial<Record<DiceTier, number[]>> = {};
			for (const [tier, list] of Object.entries(value as Record<string, unknown>)) {
				if (!DICE_TIER_ORDER.includes(tier as DiceTier)) problems.push(`rules: numbers.diceFaces: unknown tier "${tier}" (known: ${DICE_TIER_ORDER.join(', ')})`);
				else if (!wholeNumbers(list, 1, 12)) problems.push(`rules: numbers.diceFaces.${tier} must be 1 to 12 whole numbers from 0 to 99, got ${JSON.stringify(list)}`);
				else faces[tier as DiceTier] = [...list];
			}
			if (Object.keys(faces).length) numbers.diceFaces = faces;
		} else if (name === 'elementalistRest') {
			if (!wholeNumbers(value, 4, 4)) problems.push(`rules: numbers.elementalistRest must be 4 whole numbers (upgrades per Rest at 2, 3, 4, 5 Elementalists), got ${JSON.stringify(value)}`);
			else numbers.elementalistRest = [value[0], value[1], value[2], value[3]];
		} else {
			problems.push(`rules: unknown number "${name}" (known: diceFaces, elementalistRest)`);
		}
	}
	return Object.keys(numbers).length ? numbers : undefined;
}

/** Upgrades per Rest at 2 / 3 / 4 / 5 Elementalists under `elementalistRest1235`: the catalog's numbers, else 1 / 2 / 3 / 5. */
export function elementalistRestLadder(catalog: Pick<PlayCatalog, 'rules'> | null | undefined): [number, number, number, number] {
	return catalog?.rules?.numbers?.elementalistRest ?? ELEMENTALIST_REST_DEFAULT;
}

/**
 * Under `elementalistRest1235`: the action whose resolution gives the ladder's upgrades: Rest, or
 * Cultivate with the rule `elementalistOnCultivate`. `null` when the ladder rule is off.
 */
export function elementalistUpgradeAction(catalog: Pick<PlayCatalog, 'rules'> | null | undefined): 'rest' | 'cultivate' | null {
	if (!ruleValue(catalog, 'elementalistRest1235')) return null;
	return ruleValue(catalog, 'elementalistOnCultivate') ? 'cultivate' : 'rest';
}

/** The value of one switch for this catalog (its default when the catalog has no rules). */
export function ruleValue(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	name: RuleName
): boolean {
	const value = catalog?.rules?.[name];
	return typeof value === 'boolean' ? value : RULE_DEFAULTS[name];
}

/** Victory Points that win the game: 30, or 40 under rule `winAt40`. */
export function vpToWin(catalog: Pick<PlayCatalog, 'rules'> | null | undefined): number {
	return ruleValue(catalog, 'winAt40') ? 40 : VP_TO_WIN;
}

/** Whether an Evil player may attack Good players at this destination (rule `pvpInAbyss`). */
export function pvpAllowedAt(
	dest: string | null | undefined,
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined
): boolean {
	if (!dest) return false;
	return dest !== 'Arcane Abyss' || ruleValue(catalog, 'pvpInAbyss');
}

/** Printed class text that a switch replaces: class → breakpoint count → text. */
/** "upgrade an attack dice" for `n` upgrades, as the Elementalist text words it. */
const upgradeWords = (n: number): string => (n === 1 ? 'upgrade an attack dice' : `upgrade an attack dice ${n} times`);
const timesWords = (n: number): string => (n === 1 ? 'once' : `${n} times`);
/** The Elementalist text at `count` (2 to 5) under `elementalistRest1235`, from the catalog's ladder and action. */
function elementalistRestText(catalog: Pick<PlayCatalog, 'rules'> | null | undefined, count: number, needsRelic: boolean): string {
	const ladder = elementalistRestLadder(catalog);
	const n = ladder[count - 2] ?? 0;
	const when = elementalistUpgradeAction(catalog) === 'cultivate' ? 'When you Cultivate' : 'On Rest';
	if (count === 5 && needsRelic) return `${when}, ${upgradeWords(n)} if you have a relic (any relic); ${timesWords(ladder[2])} if you have none.`;
	return `${when}, ${upgradeWords(n)}.`;
}

type RuleClassText = string | ((catalog: Pick<PlayCatalog, 'rules'> | null | undefined) => string);
const RULE_CLASS_TEXT: { rule: RuleName; when: boolean; className: string; count: number; text: RuleClassText }[] = [
	// The 2026-11-14 class changes come first: for one class and breakpoint the first entry wins,
	// so they replace the `sunRework` and `mysticCultivateDouble` texts below.
	// Listed before the Arcane Blood text: the first matching entry of a tier is the one printed.
	{ rule: 'elementalistRest1235', when: true, className: 'Elementalist', count: 2, text: (c) => elementalistRestText(c, 2, false) },
	{ rule: 'elementalistRest1235', when: true, className: 'Elementalist', count: 3, text: (c) => elementalistRestText(c, 3, false) },
	{ rule: 'elementalistRest1235', when: true, className: 'Elementalist', count: 4, text: (c) => elementalistRestText(c, 4, false) },
	{ rule: 'elementalist5NeedsRelic', when: true, className: 'Elementalist', count: 5, text: (c) => elementalistRestText(c, 5, true) },
	{ rule: 'elementalistRest1235', when: true, className: 'Elementalist', count: 5, text: (c) => elementalistRestText(c, 5, false) },
	{
		rule: 'arcaneBlood',
		when: true,
		className: 'Elementalist',
		count: 2,
		text: 'When you gain an Arcane Blood, upgrade an attack dice.'
	},
	// 2026-11-21: before the `mysticSwap23` text of the same breakpoint (the first entry wins).
	{
		rule: 'mysticMonstersOnly',
		when: true,
		className: 'Mystic',
		count: 2,
		text: 'In combat with a monster, you may always attack at the same time as the monster. In addition to (1).'
	},
	{
		rule: 'mysticSwap23',
		when: true,
		className: 'Mystic',
		count: 2,
		text: 'In combat, your side may always attack at the same time as the enemy. In addition to (1).'
	},
	{
		rule: 'mysticSwap23',
		when: true,
		className: 'Mystic',
		count: 3,
		text: 'When you Cultivate, you may gain twice as many runes. In addition to (1) and (2).'
	},
	{
		// Listed before `falconerDoubleKill`: the first matching entry of a tier is the one printed.
		rule: 'falconerNoDoubleVp',
		when: true,
		className: 'Falconer',
		count: 1,
		text: 'On your next monster kill you may gain double the rewards, except Victory Points. Then discard this spirit.'
	},
	{
		rule: 'falconerDoubleKill',
		when: true,
		className: 'Falconer',
		count: 1,
		text: 'On your next monster kill you may gain double the rewards. Then discard this spirit.'
	},
	{
		rule: 'herderArcaneAugments',
		when: true,
		className: 'Herder',
		count: 1,
		text: 'Each of your Arcane spirits may hold up to 2 Spirit Augments.'
	},
	{
		rule: 'riderAugmentOption',
		when: true,
		className: 'Rider',
		count: 1,
		text: 'When you navigate to the Mountain Region from a different location, choose one: restore 3 Barrier, gain 3 Max Barrier, gain 3 Basic Attack Dice, or gain 1 Spirit Augment of your choice.'
	},
	{
		rule: 'mageArcaneDice',
		when: true,
		className: 'Mage',
		count: 1,
		text: "On this spirit's Awakening, gain 4 Arcane Attack Dice."
	},
	{
		rule: 'shieldbearerFullOnly',
		when: true,
		className: 'Shieldbearer',
		count: 1,
		text: 'When you take damage, if your Barrier is full, take 5 less.'
	},
	{
		rule: 'masterBarrierChoice',
		when: true,
		className: 'Master',
		count: 1,
		text: 'On Cultivate, gain 2 Max Barrier or restore 2 Barrier.'
	},
	{
		rule: 'feralNoDamage',
		when: true,
		className: 'Feral',
		count: 1,
		text: 'When an Evil player or a monster attacks you, your side strikes first.'
	},
	{
		rule: 'feralMonsterStrikeFirst',
		when: false,
		className: 'Feral',
		count: 1,
		text: 'When an Evil player attacks you, your side strikes first and deals 3 more damage. When a monster attacks you, deal 3 more damage.'
	},
	// 2026-11-21: before the `firetailVsMonsters` text of the same breakpoint (the first entry wins).
	{
		rule: 'spiritInitiativeTrim',
		when: true,
		className: 'Firetail',
		count: 1,
		text: 'In combat with a monster, or in a round when another player is at your location, gain 2 Initiative.'
	},
	{
		rule: 'firetailVsMonsters',
		when: true,
		className: 'Firetail',
		count: 1,
		text: 'In combat with a monster, or in a round when another player is at your location, gain 3 Initiative.'
	},
	// First entry wins: `captainNoDiscardDie` is only read together with `captainPowerOnKill`.
	{
		rule: 'captainNoDiscardDie',
		when: true,
		className: 'Captain',
		count: 1,
		text: 'After you defeat a monster, gain 1 random Power.'
	},
	{
		rule: 'captainPowerOnKill',
		when: true,
		className: 'Captain',
		count: 1,
		text: 'After you defeat a monster, gain 1 random Power. When discarded, gain 1 Enchanted Attack.'
	},
	{
		rule: 'alchemistAugmentToArcane',
		when: true,
		className: 'Arcane Alchemist',
		count: 1,
		text: 'When you Cultivate, you may convert 1 of your Spirit Augments into 1 Arcane Attack Dice.'
	},
	{
		rule: 'kingPureOnly',
		when: true,
		className: 'King',
		count: 1,
		text: 'In the Awakening Phase, if you are Pure, gain 1 VP. If you are Evil, you must discard this spirit.'
	},
	{
		rule: 'princessRune',
		when: true,
		className: 'Princess',
		count: 1,
		text: 'In the Awakening Phase, if you are not Evil and all your spirits are awakened, gain 1 Any basic Rune.'
	},
	{
		rule: 'healerNoVp',
		when: true,
		className: 'Healer',
		count: 1,
		text: 'On rest, if you have 10 max barrier, you may restore 3 barrier. When discarded, restore 2 barrier.'
	},
	{
		rule: 'cultistNoVp',
		when: true,
		className: 'Cultist',
		count: 1,
		text: 'When you become Corrupted, sacrifice 1 fewer spirit.'
	},
	{
		// Listed first: with this switch the other Summoner switches are not read.
		rule: 'summonerCultivate',
		when: true,
		className: 'Summoner',
		count: 1,
		text: 'When you Cultivate with at least 5 Forest spirits, gain 2 points.'
	},
	{
		// Listed before `summonerOncePerRound`: the first matching entry of a tier is the one printed.
		rule: 'summonerPays2',
		when: true,
		className: 'Summoner',
		count: 1,
		text: 'On Spirit World summon, you may draw from the Arcane Abyss Bag. Once per round, when you discard an Arcane Abyss Spirit, gain 2 points.'
	},
	{
		rule: 'summonerOncePerRound',
		when: true,
		className: 'Summoner',
		count: 1,
		text: 'On Spirit World summon, you may draw from the Arcane Abyss Bag. Once per round, when you discard an Arcane Abyss Spirit, gain 4 points.'
	},
	{
		// Listed before `cultivatorRelicOnce`: the first matching entry of a tier is the one printed.
		rule: 'cultivatorBarrier35',
		when: true,
		className: 'Cultivator',
		count: 5,
		text: 'On Cultivate, gain 5 Max Barrier. The first time (once per game), also gain 1 relic of your choice.'
	},
	{
		rule: 'cultivatorBarrier35',
		when: true,
		className: 'Cultivator',
		count: 4,
		text: 'On Cultivate, gain 3 Max Barrier.'
	},
	{
		rule: 'fighterDice35',
		when: true,
		className: 'Fighter',
		count: 4,
		text: 'In combat, gain 4 combat initiative. On Rest, gain 3 Basic Attack Dice.'
	},
	{
		rule: 'fighterDice35',
		when: true,
		className: 'Fighter',
		count: 5,
		text: 'In combat, gain 5 combat initiative. On Rest, gain 5 Basic Attack Dice and 1 of any spirit augment.'
	},
	{
		rule: 'cultivatorRelicOnce',
		when: true,
		className: 'Cultivator',
		count: 5,
		text: 'On Cultivate, gain 10 Max Barrier. The first time (once per game), also gain 1 relic of your choice.'
	},
	{
		// Listed before `moonPerksNeedAttack`: the first matching entry of a tier is the one printed.
		rule: 'queenUnawakens',
		when: true,
		className: 'Queen',
		count: 1,
		text: 'When this spirit awakens, every player must turn one of their awakened spirits face-down (their choice).'
	},
	{
		rule: 'moonPerksNeedAttack',
		when: true,
		className: 'Queen',
		count: 1,
		text: 'In the Awakening Phase, if you attacked a player this round, gain 1 VP.'
	},
	{
		rule: 'moonPerksNeedAttack',
		when: true,
		className: 'Sorcerer',
		count: 1,
		text: 'In the Awakening Phase, if you are Evil and attacked a player this round, gain 1 Enchanted Attack Dice.'
	},
	// First entry wins: with both Corruptor switches on, this text is printed (the corruption part
	// of `corruptorCountsAsCorruption` still applies in the engine).
	{
		rule: 'corruptorAwakenMaxBarrier',
		when: true,
		className: 'Corruptor',
		count: 1,
		text: 'Set your status to Fallen (this is not a corruption). Replace all Spirit World spirits with a random Arcane Abyss Spirit. Gain 4 Max Barrier. Gain 2 Initiative.'
	},
	{
		rule: 'corruptorCountsAsCorruption',
		when: true,
		className: 'Corruptor',
		count: 1,
		text: 'Drop your status to Fallen; this counts as one corruption (Barrier restored, sacrifice as usual). Replace all Spirit World spirits with a random Arcane Abyss Spirit. Gain 2 Initiative.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Mage',
		count: 1,
		text: "On this spirit's Awakening, gain 2 Exalted Attack Dice. In the Awakening Phase, you may discard a rune to gain 1 Exalted Attack Dice."
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Chorus',
		count: 1,
		text: 'When you awaken a spirit (this one included), restore all your Barrier and gain 2 Max Barrier.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Shieldbearer',
		count: 1,
		text: 'When you take damage, take 2 less. If your Barrier is full, take 4 less instead.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Nomad',
		count: 1,
		text: 'You may do ALL location interactions up to two times. In the Awakening Phase, gain 1 Any basic Rune.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Gardener',
		count: 1,
		text: 'In the Awakening Phase, if you are not Evil, restore 3 Barrier and gain 1 Max Barrier.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Cleric',
		count: 1,
		text: "On this spirit's Awakening, gain 1 relic of your choice. For every unique Relic you hold, reduce incoming damage by 2."
	},
	{
		rule: 'mysticCultivateDouble',
		when: true,
		className: 'Mystic',
		count: 2,
		text: 'When you Cultivate, you may gain twice as many runes.'
	},
	{
		rule: 'ramAugmentDamage',
		when: true,
		className: 'Ram',
		count: 1,
		text: 'In combat, deal 1 more damage for each Spirit Augment on your spirits.'
	},
	{
		rule: 'bastionVsMonsters',
		when: true,
		className: 'Bastion',
		count: 1,
		text: 'If the opponent has higher initiative, or is a monster, when you Take Damage, half it (rounding up).'
	}
];

/**
 * A class's printed breakpoints with the text of every switched-on rule applied. Returns the
 * schema itself (same object) when no switch changes it, so callers that print it are unchanged
 * for catalogs without rules.
 */
export function ruleAdjustedClassSchema(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	className: string,
	schema: ClassBreakpoint[] | null
): ClassBreakpoint[] | null {
	const changes = RULE_CLASS_TEXT.filter(
		(c) => c.className === className && ruleValue(catalog, c.rule) === c.when
	);
	if (!changes.length || !Array.isArray(schema)) return schema;
	return schema.map((tier) => {
		const change = changes.find((c) => c.count === Number(tier.count));
		if (!change) return tier;
		const description = typeof change.text === 'function' ? change.text(catalog) : change.text;
		return { ...tier, effects: [{ ...tier.effects?.[0], type: 'benefit', description }] };
	});
}
