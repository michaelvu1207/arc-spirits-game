# 0.2.1

Mystic (2): Cultivate gives twice as many runes (was: 2 Max Barrier after a corruption). Cultivate: one reward per origin, the rune at 3+ spirits, the rune or the relic at 5+ (was: rune and relic).

Changes since 0.2.0: 6 changed

## Classes

- **Mystic**
  - description: Reshapes spirit summons and unlocks corruption recovery, simultaneous attacks, and additional augment placement. → Reshapes spirit summons and unlocks doubled Cultivate runes, simultaneous attacks, and additional augment placement.
  - effect_schema: [{"count":1,"effects":[{"type":"benefit","description":"On a Spirit World or Abyss Summon, you may put all spirits back and draw again."}… → [{"count":1,"effects":[{"type":"benefit","description":"On a Spirit World or Abyss Summon, you may put all spirits back and draw again."}…

## Origins

- **Forest**
  - calling_card: {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Plant Rune","icon_ids":["Rune: Forest"]},{"count":5,"label":"On Cultiv… → {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Plant Rune","icon_ids":["Rune: Forest"]},{"count":5,"label":"On Cultiv…
- **Fire**
  - calling_card: {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Fire Rune","icon_ids":["Rune: Lantern Lights"]},{"count":5,"label":"On… → {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Fire Rune","icon_ids":["Rune: Lantern Lights"]},{"count":5,"label":"On…
- **Mountain**
  - calling_card: {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Mountain Rune","icon_ids":["Rune: Cyber City"]},{"count":5,"label":"On… → {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Mountain Rune","icon_ids":["Rune: Cyber City"]},{"count":5,"label":"On…
- **Water**
  - calling_card: {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Water Rune","icon_ids":["Rune: Tidal Tribe"]},{"count":5,"label":"On C… → {"enabled":true,"breakpoints":[{"count":3,"label":"On Cultivate: 1 Water Rune","icon_ids":["Rune: Tidal Tribe"]},{"count":5,"label":"On C…

## Rule switches

- **row 1**
  - mysticCultivateDouble: — → true
  - cultivateRuneOrRelic: — → true

