# 0.2.5

One name per spirit (the card name). Sun spirits cost 3 runes, Aureate Mage and Dawnborn 4. Mystic (2) and (3) change places. New Falconer, Herder, Mage and Shieldbearer abilities; Rider can give a Spirit Augment. 17 spirit cards remade to match the data.

Changes since 0.2.4: 44 changed

## Classes

- **Mystic**
  - effect_schema: [{"count":1,"effects":[{"type":"benefit","description":"On a Spirit World or Abyss Summon, you may put all spirits back and draw again."}… → [{"count":1,"effects":[{"type":"benefit","description":"On a Spirit World or Abyss Summon, you may put all spirits back and draw again."}…
- **Herder**
  - description: Gains a rune for each of your Beasts when awakened. → Lets each of your Arcane spirits hold two Spirit Augments.
  - effect_schema: [{"count":1,"effects":[{"type":"benefit","description":"On awaken, for each Beast that you have, gain 1 rune of the origin of that Beast.… → [{"count":1,"effects":[{"type":"benefit","description":"Each of your Arcane spirits may hold up to 2 Spirit Augments."}]}]
- **Mage**
  - description: Can discard a rune during Awakening to gain an Enchanted Attack die. → Gains 4 Arcane Attack Dice when awakened.
  - effect_schema: [{"count":1,"effects":[{"type":"benefit","description":"On this spirit's Awakening, gain 2 Exalted Attack Dice. In the Awakening Phase, y… → [{"count":1,"effects":[{"type":"benefit","description":"On this spirit's Awakening, gain 4 Arcane Attack Dice."}]}]
- **Falconer**
  - description: Gains two Spirit Augments when awakened, and trades for a Spirit Augment from any location. → Doubles the rewards of one monster kill, then leaves.
  - effect_schema: [{"count":1,"effects":[{"type":"benefit","description":"On awaken, gain 2 Spirit Augments of your choice. In the Location Phase, you may … → [{"count":1,"effects":[{"type":"benefit","description":"On your next monster kill you may gain double the rewards. Then discard this spir…
- **Rider**
  - description: Gains Barrier, Max Barrier or Basic Attack Dice when you arrive at the Mountain Region. → Gains Barrier, Max Barrier, Basic Attack Dice or a Spirit Augment when you arrive at the Mountain Region.
  - effect_schema: [{"count":1,"effects":[{"type":"benefit","description":"When you navigate to the Mountain Region from a different location, choose one: r… → [{"count":1,"effects":[{"type":"benefit","description":"When you navigate to the Mountain Region from a different location, choose one: r…
- **Shieldbearer**
  - effect_schema: [{"count":1,"effects":[{"type":"benefit","description":"When you take damage, take 2 less. If your Barrier is full, take 4 less instead."… → [{"count":1,"effects":[{"type":"benefit","description":"When you take damage, if your Barrier is full, take 5 less."}]}]

## Spirits

- **Ash Paladin**
  - name: Ashveil, the Rekindled Blade → Ash Paladin
- **Black Lily**
  - name: Blacklily → Black Lily
- **Caldera**
  - name: Caldera, the Sixfold Inferno → Caldera
- **Storm King**
  - name: Sovereign of the Drowned Sky → Storm King
- **Water Fairy**
  - name: Crestwing Regent → Water Fairy
- **Ink Scholar**
  - name: Inkweaver → Ink Scholar
- **Nhal**
  - name: Nhal, the World Unwoven → Nhal
- **Tide Huntress**
  - name: The Huntress of All Tides → Tide Huntress
- **Stone Fist**
  - name: Cragfist → Stone Fist
- **Geode Keeper**
  - name: Geode Tender → Geode Keeper
- **Dawn Chorus**
  - name: Dawn Chorus, Heralds of First Light → Dawn Chorus
  - awaken_condition: {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune"]} → {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune","Any basic rune"]}
- **Moonrend**
  - name: Moonrend, the Twice-Striking → Moonrend
- **Root Druid**
  - name: Oathroot Ancient → Root Druid
- **Aureate Mage**
  - name: Aureate Runeweaver → Aureate Mage
  - awaken_condition: {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune"]} → {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune","Any basic rune","Any basic rune"]}
- **Crystal Ghoul**
  - name: Blightshard → Crystal Ghoul
- **Hollowbloom**
  - name: Hollowbloom, Gate of the First Forest → Hollowbloom
- **Elk Guardian**
  - name: Elderhorn, the Living Bastion → Elk Guardian
- **Reef Otter**
  - name: Reefrunner → Reef Otter
- **Twin Flame Keeper**
  - name: Keeper of the Twin Pyres → Twin Flame Keeper
- **Rune Smith**
  - name: Twinforge Runemaster → Rune Smith
- **Solar Cleric**
  - name: The Solar Reliquarian → Solar Cleric
  - awaken_condition: {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune"]} → {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune","Any basic rune"]}
- **Mushroom Druid**
  - name: Sporecap → Mushroom Druid
- **Aurelion**
  - name: Aurelion, Crown of the Undying Sun → Aurelion
- **Dawnborn**
  - name: Dawnborn, Child of Two Suns → Dawnborn
  - awaken_condition: {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune"]} → {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune","Any basic rune","Any basic rune"]}
- **Tide Warden**
  - name: Tidewarden, the Unbroken Current → Tide Warden
- **Vine Fox**
  - name: Briarfox → Vine Fox
- **Forest Fairy**
  - name: Briarwing Regent → Forest Fairy
- **Fire Fairy**
  - name: Cinderwing Regent → Fire Fairy
- **Black Flame Novice**
  - name: Blackflame Novice → Black Flame Novice
- **Frost Wolf**
  - name: Frostfang → Frost Wolf
- **Hearth Spirit**
  - name: Hearthling → Hearth Spirit
- **Ash Blade**
  - name: Ashblade → Ash Blade
- **Thorn Ranger**
  - name: Briarblade → Thorn Ranger
- **Ember Weaver**
  - name: Ashweaver → Ember Weaver
- **Vespera**
  - name: Vespera, Empress of the Last Moon → Vespera
- **Dawn Knight**
  - awaken_condition: {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune"]} → {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune","Any basic rune"]}
- **Sunflower Maiden**
  - awaken_condition: {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune"]} → {"type":"rune_cost","rune_ids":["Any basic rune","Any basic rune","Any basic rune"]}

## Rule switches

- **row 1**
  - mysticSwap23: — → true
  - falconerDoubleKill: — → true
  - herderArcaneAugments: — → true
  - riderAugmentOption: — → true
  - mageArcaneDice: — → true
  - shieldbearerFullOnly: — → true

