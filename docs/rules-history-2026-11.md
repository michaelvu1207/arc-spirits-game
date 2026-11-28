# How the rules of November 2026 came about

Until 27 November 2026 the engine had about 80 rule switches (`ruleValue`, `rules.json`), so that a rule change could be tested against the rule before it. On that day Michael made the tested rules the one official ruleset: "have all experimental changes be the official ruleset in the engine, no more flags". The switches and the code of the rules they replaced were removed.

Below is the comment that stood at the top of `src/lib/play/rules.ts`: every switch, the day it was decided, and what it changed. A switch whose value was `true` on 27 November is how the game plays now; the values are listed after it. The last commit with the switches is `0d96e29`.

```text
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
 * - difficulty3Restores (default false; Michael, 2026-11-22: "have difficulty 3 monsters have special
 *   abilities. they shoudl restore 5 barriers after combat"): true ⇒ every Difficulty 3 card carries the
 *   ability "after a fight it survives, restore 5 Barrier" (never above its printed Barrier; the number
 *   can be set with `numbers.difficulty3Restore`). So a fight that deals 5 or less makes no progress.
 *   See `difficulty3Restore` below and `fightMonster` in combat.ts.
 * - abyssDrawByPoints (default false; Michael, 2026-11-22: "have least points to greatest player draw in
 *   that order"): true ⇒ the players at the Arcane Abyss draw from the monster decks one after the
 *   other, the one with the fewest points at the start of the round first (equal points: table order,
 *   starting one seat later each round). A player waits until those ahead have drawn, hold 3 cards or
 *   have ended their Location turn. The permanent monster needs no turn. See abyssDrawOrder.ts.
 * - monsterDrawOne (default false; Michael, 2026-11-23: "when drawing monsters you only just draw one
 *   monster and if you don't like the monster you can put it back on the top of the deck. Similarly you
 *   can replace monsters that you currently have with a new monster but you lose all the damage that you
 *   did to it and it goes back to the top of the deck"): true ⇒ a draw reveals ONE card (the top card of
 *   the chosen deck). The player keeps it, or puts it back on top of its deck (`keepMonsterCard` with
 *   `returnToDeck`); either way it was their draw of the visit. When they keep it they may put one card
 *   they hold back on top of that card's deck (`replaceHandIndex`): all damage on it is gone (full
 *   Barrier). With a full hand (3 cards) a draw is still allowed, and keeping then needs such a swap.
 *   A copy of the permanent monster that is swapped out just leaves the hand. See the `drawMonsterCards`
 *   and `keepMonsterCard` commands in runtime.ts.
 * - alchemistOncePerRound (default false; Michael, 2026-11-22: "arcane alchemist is just one time per
 *   turn"): only read under `alchemistAugmentToArcane`; true ⇒ a player converts at most one Spirit
 *   Augment a round, however often they Cultivate in it. See classes/arcMage.ts.
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
 *   `elementalistRest1235`; `elementalistNoRelic` n is the number at 5 Elementalists without a relic
 *   under `elementalist5NeedsRelic` (default: the number at 4). Absent ⇒ the numbers the switches give. See `parseRuleNumbers` below.
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
 * - initiativeDie (default false; Michael, 2026-11-26): true ⇒ initiative is no number. "initiaitve is no longer an
 *   integer value, its now a true/false". Each player has ONE initiative die with 12 sides and can never have more; at
 *   the start of a combat each player in it rolls it. The sides that give the initiative depend on the status:
 *   "if you're pure, you have 3/12, then tainted is 5/12, corrupt is 7/12, fallen is 9/12" (`numbers.initiativeHits`).
 *   A side (one or more players) has the initiative when any of its dice hits. Monsters always have it.
 *   Player fights: the one side that has the initiative attacks first; both or neither: "both players attack at the
 *   same time" (neither: my default, told to him). Monster fights: with the initiative the player attacks at the same
 *   time as the monster (the damage lands even when the monster's hit corrupts the player); without it the monster
 *   attacks first. No class gives an initiative number. Feral, Spellblade, Firecracker and the Power Sudden Strike
 *   "gain the initiative if your side doesn't"; Assassin loses its strike-first ("remove the strike first from
 *   assasin"); Paladin's side attacks first when both sides have the initiative; Bastion halves when the opponent
 *   has the initiative and its holder's side does not. The wording is "gain the initiative". See combat.ts.
 * - initiativeSum (default false; only read under `initiativeDie`; Michael, 2026-11-27: "have it such that iniative
 *   values can add up. for example in 1 evil vs 2 good, then if 2 good roll 1 initiative, then they will have 2
 *   iniative and possibly win"): true ⇒ in a player fight every die that hits is 1 initiative and the initiative of a
 *   side is the sum of its players'. The side with MORE initiative attacks first; the same number (0 and 0 too): both
 *   attack at the same time. My readings, told to him: "gain the initiative if your side does not have it" (Feral,
 *   Spellblade, Firecracker, Sudden Strike) makes a side with 0 have 1, no more; Paladin's side attacks first when
 *   both sides have the same initiative of 1 or more; Bastion halves when the opponent's side has more initiative;
 *   Prince deals 2 more when its side has more. Monster fights do not change (one player, one die; the monster
 *   always has the initiative). The same day: "adjust initiative dice such that the odds are 4/12, 6/12, 7/12, 8/12"
 *   (`numbers.initiativeHits` in the lab data).
 * - firetailDamage (default false; Michael, 2026-11-26, after the initiative die left Firetail with no effect:
 *   "ok change it to that"): true ⇒ Firetail is "In a round when another player is at your location, deal 3 more
 *   damage in combat." (monster fights and player fights; `FIRETAIL_DAMAGE` in effects/classes/firetail.ts). It gives
 *   no initiative then, whatever the other Firetail switches say.
 * - abyssFightOrSummon (default false; Michael, 2026-11-27: "bring back the summon action but have it an option to do
 *   the fight OR an arcane abyss summon action"): the Arcane Abyss has its Arcane Abyss Summon action again (the
 *   tables' `reward_rows` on the Arcane Abyss; Michael had removed it on 2026-11-20). true ⇒ in one round a player
 *   at the Arcane Abyss either fights or takes that action: the action holds the place of the round's fight, and
 *   after a fight the action is gone. A Monster Hunter's extra fight is on top of the choice (Michael, 2026-11-27:
 *   "monster hunter should still be able to trigger a fight"): two fights, or one fight and the action, in either
 *   order (`monsterFightsLeft` in locationInteractions.ts). The Power Abyssal Execution counts as a fight.
 *   Wording (Michael, 2026-11-27: "worded as using a battle action"): a player has 1 battle action a round; a fight,
 *   the Arcane Abyss Summon action and Abyssal Execution each use one; Monster Hunter has 1 extra battle action.
 *   Drawing and keeping monster cards is not touched. See `abyssSummonRow` in locationInteractions.ts.
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
```

## The values on 27 November 2026

```json
{
 "rules": {
  "feralMonsterStrikeFirst": true,
  "summonReplaceWhenFull": true,
  "cultivatorRelicOnce": true,
  "summonerOncePerRound": true,
  "pvpPaysOnCorrupt": true,
  "pvpGoodBounty": false,
  "abyssSummonDraw4Pick2": true,
  "firetailVsMonsters": true,
  "moonPerksNeedAttack": false,
  "corruptorCountsAsCorruption": false,
  "fallenDebtBelowZero": true,
  "sunRework": true,
  "bastionVsMonsters": true,
  "pvpEngageVp": false,
  "pvpAttackerSacrificeCap": false,
  "powerRework": true,
  "mysticCultivateDouble": true,
  "cultivateRuneOrRelic": true,
  "ramAugmentDamage": true,
  "pvpInAbyss": true,
  "mysticSwap23": true,
  "falconerDoubleKill": true,
  "herderArcaneAugments": true,
  "riderAugmentOption": true,
  "mageArcaneDice": true,
  "shieldbearerFullOnly": true,
  "masterBarrierChoice": true,
  "falconerNoDoubleVp": true,
  "relicAwakenNeedsBoard": true,
  "monsterDeckByStage": true,
  "summonerPays2": false,
  "winAt40": false,
  "sidePointsHalf": false,
  "queenUnawakens": true,
  "summonerCultivate": true,
  "cultistNoVp": true,
  "captainPowerOnKill": true,
  "alchemistAugmentToArcane": true,
  "healerNoVp": true,
  "feralNoDamage": true,
  "corruptorAwakenMaxBarrier": false,
  "captainNoDiscardDie": true,
  "princessRune": true,
  "kingPureOnly": true,
  "nhalNeedsCorrupt": true,
  "pvpCorruptPays4": false,
  "goodKillBonus": false,
  "buffedDice": true,
  "weakLowDice": true,
  "enchantedTwoThirds": true,
  "elementalistRest1235": true,
  "alchemistOncePerRound": true,
  "abyssDrawByPoints": true,
  "monsterDrawOne": true,
  "difficulty3Restores": true,
  "elementalistOnCultivate": true,
  "elementalist5NeedsRelic": true,
  "fighterInitiative": true,
  "elementalistMethods": true,
  "restByStatus": true,
  "fairyEnchanted": true,
  "cursedSpiritBasic": true,
  "elementalistOneUpgrade": true,
  "elementalistBigKills": true,
  "battleAdeptNoDice": true,
  "beastNoInitiative": true,
  "mysticMonstersOnly": true,
  "spiritInitiativeTrim": true,
  "arcaneBlood": false,
  "arcaneBloodDouble": true,
  "arcaneBloodTwoPerPoint": false,
  "arcaneBloodPerPoint": true,
  "restBase4": false,
  "fighterDice35": true,
  "cultivatorBarrier35": true,
  "permanentRewardChoice": true,
  "initiativeDie": true,
  "initiativeSum": true,
  "firetailDamage": true,
  "abyssFightOrSummon": true
 },
 "numbers": {
  "diceFaces": {
   "enchanted": [
    0,
    0,
    0,
    1,
    1,
    1
   ]
  },
  "elementalistRest": [
   1,
   2,
   3,
   5
  ],
  "elementalistNoRelic": 4,
  "sentinelDamagePerDie": 1,
  "mageAwakenArcaneDice": 3,
  "sacrificeMax": 4,
  "initiativeHits": [
   4,
   6,
   7,
   8
  ],
  "restBarrier": [
   4,
   4,
   3,
   2
  ]
 }
}
```
