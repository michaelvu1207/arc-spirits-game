# Navigation Powers

This is the consumable Navigation Power catalog approved for implementation. The card text is defined in `src/lib/play/navigationPowers.ts`; IDs stay stable across wording changes.

## Shared rules

- Choose a destination, then optionally commit one held Navigation Power with it. Do not offer the full catalog as a free choice each round.
- Powers are consumable. A committed power is used for this round only and cannot trigger its reward repeatedly.
- Beneficial effects are optional. Declaring a card does not force a player to heal, awaken, take a reward, or spend a Rune later.
- All navigation destinations are committed in parallel. Co-location and Evil-player conditions use the same revealed destination snapshot, rather than the order players lock or effects resolve.
- “Another player enters your location” means at least one other player selected the same revealed destination. It does not mean another player locked after you. Multiple co-located players do not multiply a card's trigger.
- Temporary combat modifiers expire after their applicable battle or round. Power dice are not permanent additions to the attack pool.
- Powers acquired during resolution are inventory items for later Navigation; they cannot be committed after this round's destinations reveal.
- A power's optional choices cannot retroactively change a locked destination.
- Rest and Cultivate effects use the normal game functions and their normal class triggers; the two calls on cards 20 and 21 are two separate actions.
- Direct-damage effects on cards 1 and 9 stay direct damage. Only the flat attack bonus on card 15 was converted to Attack Dice. Arcane Attack Dice have faces 1, 2, 2, 2, 2, 3, so two dice average 4 damage.

## Region compatibility

The card-facing names map to the existing destination names:

| Card region      | Existing destination |
| ---------------- | -------------------- |
| Forest           | Floral Patch         |
| Fire             | Lantern Canyon       |
| Mountain / Earth | Cyber City           |
| Water            | Tidal Cove           |
| Arcane Abyss     | Arcane Abyss         |

An origin's display-name migration must not disable an existing destination's trigger. “Potential” is the player's maximum Barrier capacity; “restore Barrier” restores only missing Barrier up to capacity.

## Catalog

1. **Thorn Ward** (`thorn-ward`) — If another player enters your location this round, you may deal 1 damage to all opponents there. Gain 1 VP for each opponent damaged.

2. **Ember Charge** (`ember-charge`) — If another player enters your location this round, you may restore 4 Barrier.

3. **Stone Shelter** (`stone-shelter`) — If another player enters your location this round, you may steal 1 Rune from them. They choose the Rune.

4. **Tidal Tempo** (`tidal-tempo`) — If another player enters your location this round, you may resolve each Location action one additional time.

5. **Shared Current** (`shared-current`) — If another player enters your location this round, you may trade Spirits or Runes with another player there.

6. **Watchful Eye** (`watchful-eye`) — If another player enters your location this round, you may pay 1 Rune to gain 2 Runes of the same type.

7. **Augment Relay** (`augment-relay`) — If another player enters your location this round, you may steal 1 Spirit Augment from an opponent there.

8. **Guardian’s Accord** (`guardians-accord`) — If another player enters your location this round, you may deal double damage this turn.

9. **Abyssal Reckoning** (`abyssal-reckoning`) — If an Evil player enters your location this round, you may immediately deal damage to all Evil players equal to the number of Arcane Spirits you control.

10. **Cinder Awakening** (`cinder-awakening`) — If an Evil player enters the Fire region with you this round, you may awaken 1 of your Spirits.

11. **Abyssal Execution** (`abyssal-execution`) — If an Evil player enters the Arcane Abyss with you this round, you may defeat the monster without battling it.

12. **Forest Bounty** (`forest-bounty`) — If an Evil player enters the Forest region with you this round, you may gain 3 Spirit Augments of your choice.

13. **Mountain Bastion** (`mountain-bastion`) — If an Evil player enters the Mountain region with you this round, you may gain 3 Potential or restore 6 Barrier.

14. **Tidal Arsenal** (`tidal-arsenal`) — If an Evil player enters the Water region with you this round, you may gain 3 random Powers.

15. **Battle Fury** (`battle-fury`) — If you engage in battle this turn, you may gain 2 Arcane Attack Dice for that battle.

16. **Battle Guard** (`battle-guard`) — If you engage in battle this turn, you may reduce incoming damage by 4 for that battle.

17. **Battle Reward** (`battle-reward`) — If you engage in battle with another player this turn, you may gain 2 VP.

18. **Unbroken Assault** (`unbroken-assault`) — If you fail to Corrupt or defeat an opponent this turn, you may gain 4 Potential and restore 4 Barrier.

19. **Duelist’s Prize** (`duelists-prize`) — If you fail to Corrupt or defeat an opponent this turn, you may gain 2 VP.

20. **Fire’s Rhythm** (`fires-rhythm`) — If you travel to the Fire region this turn, you may Rest twice.

21. **Forest’s Rhythm** (`forests-rhythm`) — If you travel to the Forest region this turn, you may Cultivate twice.

22. **Mountain’s Wealth** (`mountains-wealth`) — If you travel to the Mountain region this turn, you may gain 2 Runes of your choice.

## Implemented resolution rules

- Thorn Ward counts only opponents who actually lose Barrier to its damage, not immune or fully protected opponents. It awards at most 1 VP per damaged opponent.
- Stone Shelter leaves the Rune choice with the affected opponent. An opponent with no Rune transfers nothing. Do not take a random Rune silently.
- Shared Current enables a voluntary, mutually accepted trade. Never transfer another player's Spirits or Runes without acceptance; validate ownership, capacity, and co-location when accepting.
- Watchful Eye pays exactly 1 owned Rune and grants 2 Runes of one chosen type. Insufficient payment cancels the exchange without a partial grant.
- Augment Relay transfers one existing augment; it does not create a duplicate. Respect the destination's legal placement and the opponent's remaining attachments.
- Abyssal Reckoning's trigger requires an Evil co-located player, but its text targets all Evil players. Take the Evil/Arcane-count snapshot before applying damage so seat resolution order does not alter the target set.
- Abyssal Execution should use the normal monster-defeat reward and life/progression path, without fabricating a battle or granting battle-triggered rewards.
- Cinder Awakening permits a chosen owned face-down Spirit to awaken without paying its normal awakening condition, while retaining normal awakening hooks.
- Forest Bounty allows three augment choices, including repeat classes if normal rules allow them. It grants unplaced augments rather than bypassing placement limits.
- Tidal Arsenal is an explicit exception to the usual reveal-three/choose-one acquisition: this card says gain 3 random Powers.
- Unbroken Assault and Duelist’s Prize require an actual completed battle with no opponent Corrupted or defeated by the player. Declining a fight never qualifies.

These notes constrain resolution and tests; they do not grant new cards or change the Rune-generation economy.

## Acquisition and expiry

New games offer three random powers once; choose one for the inventory. At a Spirit World location, Gain a Power spends one Origin Rune and offers three distinct random powers; keep one. This action is limited to once per round and does not replace existing location trades or change the Rune economy. Tidal Arsenal grants its three random cards directly.

Only held inventory cards can be selected. A lock is reversible during the normal navigation grace period; at reveal the held card is removed exactly once, even if its trigger does not occur. Effects and trade permission expire with the round; unplayed inventory persists. Old saved games default to an empty power inventory.

Combat benefits are opted into after reveal before any fight. Failed-battle rewards are offered after the outcome. Normal play never auto-accepts optional effects. A missed deadline declines optional effects, makes a valid compulsory rune-owner choice, and declines unanswered trades. Bot fallback uses the same conservative choices.

## Verification

- 325 focused tests cover effect resolution, all 22 powers through complete games reaching 30 VP, real reward claims, phase progression, consent, duplicate/stale requests, hidden information, legacy Rune records, and JSONB persistence order.
- `npx playwright test --config=playwright.navigation.config.ts` runs against the isolated local auth/database emulator. The multiplayer browser scenario selects and resolves every card, purchases a power, and reaches the finished-game screen. It uses controlled development grants for resources and the final scoreboard; separate engine scenarios reach victory through normal monster reward claims.
- The second browser scenario checks the draft's fit, scrolling and keyboard focus in mobile landscape. Portrait retains the game's existing rotate-device requirement.
- `npm run check` and `npm run build` validate the integration. Build verification uses nonsecret placeholder service configuration; these artifacts are not a production deployment.

The build command allocates a 4 MiB JavaScript stack for Vite's traversal of the existing Spark renderer bundle; the default local Node stack overflowed in Rollup's CommonJS resolver.
