# Encoder v2 (`arc-obs-v2`) — entity-level observation schema

Source: `src/lib/play/ml/encodeV2.ts` · Tests: `src/lib/play/ml/encodeV2.test.ts`

v2 replaces the lossy 62-float summary observation (`encode.ts` v1, `OBS_DIM=62`)
with **per-entity token sets** for a Python set-transformer. v1 stays live and
untouched (the distilled net consumes it); **action encoding is NOT duplicated** —
candidates keep using v1 `encodeAction` (52 floats, `ACT_DIM`).

This document is the input contract for the model-v2 work: field names, widths,
caps, masks, and the flat layout are all fixed here. Any change must bump
`OBS_V2_VERSION` / `OBS_V2_VERSION_CODE` (currently `arc-obs-v2` / `2`).

## Top-level shape

```ts
encodeEntityObsV2(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): EntityObsV2

EntityObsV2 = {
  version: 'arc-obs-v2',
  global:  number[122],        // 1 token
  seats:   number[6][55],      // padded to SEATS_CAP=6; row 0 = acting seat
  spirits: number[42][58],     // padded to SPIRITS_CAP=42 (6 seats × 7 slots)
  market:  number[6][49],      // MARKET_CAP=6 (engine market is a fixed 6 slots)
  runes:   number[8][18],      // RUNES_CAP=8 — the ACTING seat's held runes/relics
  monster: number[10],         // 1 token
  masks:   { seats[6], spirits[42], market[6], runes[8], monster[1] }  // 1=real, 0=pad
}
```

- All features are clamped to ~[0,1] (v1 convention). Padded rows are all-zero.
- **Token order is deterministic**: seats = acting seat first, then remaining
  active seats in `SEAT_COLORS` order; spirits grouped per seat in that same
  order, each board sorted by `slotIndex`; runes sorted by mat `slotIndex`.
- Dims derive from the frozen catalog (`ml/catalog.json`) vocabularies, sorted
  for determinism: **37 classes, 8 origins, 12 rune ids, 53 spirit ids**. The
  test suite pins these counts and the dims below; a catalog change that alters
  them fails the tests (intentional — that is a schema version event).

## Flat layout (Python side)

`flattenObsV2(obs, catalog)` → one float array, constant length **3419**:

```
[header 20] [global 122] [seats 6×55] [spirits 42×58] [market 6×49] [runes 8×18] [monster 10]
[mask seats 6] [mask spirits 42] [mask market 6] [mask runes 8] [mask monster 1]
```

Header (self-describing): `[versionCode=2, numTokenTypes=6, (typeId, cap, dim)×6]`
with typeIds `0=global 1=seat 2=spirit 3=market 4=rune 5=monster` in payload order.

`obsV2Meta(catalog)` returns `{version, versionCode, tokenTypes, caps, dims,
fieldNames, vocab{classes,origins,runeIds,spiritIds}, flatHeader, flatLength}` —
serialize it to `meta.json` next to any v2 dataset; the Python loader should
reconstruct token tensors from it, never from hard-coded offsets.

## Information safety (the critical contract)

The encoder emits **strictly the acting seat's information set**. Authority:
`buildSessionProjection` (`runtime.ts`) — the exact per-seat redaction the live
server applies for non-owner viewers. Owner-only fields (`handDraws`,
`pendingDraw` + queue, `pendingReward`, `pendingAwakenReward`,
`pendingCorruptionDiscard`, `pendingDestination`, `manualPrompts`,
`pendingDecisions`, `lastAction`, `unplacedAugments`) appear ONLY in the self
row's `own:*` block; opponent rows carry zeros there, read from nothing private.

Destination features are additionally gated on `state.revealedDestinations`:
`navigationDestination` is only assigned at reveal (`phases.ts` `tryRevealNavigation`),
but the legacy `selectNavigationDestination` command can write it pre-reveal, so
the gate protects against that path too.

Tested (`encodeV2.test.ts`): mutating every owner-only field of an opponent —
including flipping their secret `pendingDestination` and force-writing their
public `navigationDestination` pre-reveal — produces a **bit-identical** encoding
for the acting seat; the same mutations on the acting seat itself change the
encoding (proving the fields are actually consumed); post-reveal destination
changes DO change the encoding (public then).

**Deliberate consequence of following the projection**: opponents' *face-down*
spirits are encoded with full identity (classes/origins/cost). The projection
sends full `spirits` arrays (incl. `isFaceDown` cards' ids/names/classes) to every
viewer today, so this is exactly the acting client's information set. If the
product ever redacts face-down identity in the projection, v2 must follow and
bump its version. Flagged as a possible product-level information leak, distinct
from the encoder's correctness.

## Token schemas

Field names below are exactly `obsV2FieldNames(catalog)`; tests assert
`names.length === dim` per token type.

### Global token (dim 122)

| # | field | notes |
|---|-------|-------|
| 0 | `round` | `round / MAX_ROUNDS` (30 — the real cap, not v1's 36) |
| 1–6 | `phase:<navigation…cleanup>` | one-hot over `GAME_PHASES` (6) |
| 7 | `activeSeats` | /6 |
| 8 | `revealedDestinations` | 0/1 |
| 9 | `monsterPresent` | 0/1 |
| 10 | `monsterLadderFrac` | `ladderIndex / ladderMax` |
| 11 | `monsterLivesFrac` | `livesRemaining / livesTotal` |
| 12–15 | `bagSpiritWorldCount`, `bagMonstersCount`, `bagAbyssCount`, `bagStageDeckCount` | /60, /8, /60, /20 |
| 16–68 | `bagSW:<spiritId>` ×53 | per-id copies REMAINING in the Spirit World bag, /3 (max edition duplicates). Bag contents are public (`SpectatorProjection.bagSpirits`, order hidden) |
| 69–121 | `bagAbyss:<spiritId>` ×53 | same for the Arcane Abyss bag |

Spirit-id axis = `vocab.spiritIds` (catalog spirit UUIDs, sorted). Bag entries
without a resolvable id are counted in the totals but not per-id.

### Seat token (dim 55) — self first, opponents after

Public block (encoded for every seat):

| # | field | notes |
|---|-------|-------|
| 0 | `present` | 1 on real rows |
| 1 | `isSelf` | 1 only on row 0 |
| 2–7 | `seat:<Red…Yellow>` | absolute seat one-hot (6) — joins to spirit `owner:*` |
| 8 | `vp` | /30 (`VP_TO_WIN`) |
| 9 | `vpToWin` | `(30 − vp)/30` — distance to win |
| 10–12 | `barrier`, `maxBarrier`, `brokenBarrier` | /20 |
| 13 | `statusLevel` | /3 (0 Pure … 3 Fallen) |
| 14 | `corruptionCount` | /5 |
| 15 | `isEvil` | `isEvilAlignment(statusLevel)` |
| 16 | `diceTotal` | /10 (`MAX_ATTACK_DICE`) |
| 17–20 | `dice:<basic|enchanted|exalted|arcane>` | per-tier counts /10 |
| 21 | `spiritCount` | /7 (`MAX_SPIRITS`) |
| 22 | `faceDownCount` | /7 |
| 23 | `matRunes` | held mat slots of kind rune, /4 (`RUNE_CARRY_LIMIT`) |
| 24 | `matRelics` | held mat slots of kind relic, /4 |
| 25 | `relicSpecials` | `player.relics` counter /10 |
| 26 | `augmentSpecials` | `player.spiritAugments` counter /10 |
| 27 | `attachedAugments` | placed `spiritAugmentAttachments` /7 |
| 28 | `navLocked` | `state.navigation[seat].locked` (public) |
| 29 | `destKnown` | 1 iff revealed AND destination set |
| 30–34 | `dest:<FloralPatch…ArcaneAbyss>` | one-hot over `ALL_DESTINATIONS` (5), **zero pre-reveal** |
| 35 | `coLocatedWithSelf` | post-reveal, shares acting seat's destination (0 on self row) |
| 36 | `phaseReady` | 0/1 |
| 37 | `initiative` | /10 |
| 38 | `awakenOfferCount` | public per projection (owner-derived from public tableau) |

`own:*` block (indices 39–54) — **owner-only; zeros on every non-self row**:

| # | field | notes |
|---|-------|-------|
| 39 | `own:handDraws` | drawn-to-hand count /5 |
| 40 | `own:pendingDrawActive` | 0/1 |
| 41 | `own:summonsLeft` | `(summonLimit − summonedCount)/5` |
| 42 | `own:drawQueueLen` | /3 |
| 43 | `own:pendingRewardActive` | monster-kill reward awaiting, 0/1 |
| 44 | `own:rewardChooseAmount` | /4 |
| 45 | `own:corruptionDiscardOwed` | owed forced discards /5 |
| 46 | `own:decisionCount` | pendingDecisions /3 |
| 47 | `own:promptCount` | manualPrompts /3 |
| 48 | `own:awakenRewardActive` | 0/1 |
| 49 | `own:unplacedAugments` | /5 |
| 50–54 | `own:pendingDest:<…>` | SECRET pre-reveal navigation choice one-hot (5) |

### Spirit token (dim 58) — every slot on every board

| # | field | notes |
|---|-------|-------|
| 0 | `present` | |
| 1–6 | `owner:<Red…Yellow>` | owner seat one-hot |
| 7 | `ownerIsSelf` | |
| 8 | `slot` | `slotIndex/7` |
| 9 | `faceDown` | |
| 10 | `awakened` | `1 − faceDown` (kept explicit per spec) |
| 11 | `cost` | /9 (max catalog cost) |
| 12–48 | `class:<name>` ×37 | class counts /3, **including placed augments' chosen classes on this spirit** (mirrors `awakenedClassCounts` + `augmentContributions`) |
| 49–56 | `origin:<name>` ×8 | origin counts /3 |
| 57 | `augments` | attachments on this spirit /2 |

Class axis (sorted, 37): Abyss Summoner, Adaptive Fighter, Ancient Magus,
Aquamaiden, Arc Mage, Arcane Advisor, Blood Hunter, Captain, Child Prodigy,
Cultivator, Cursed Spirit, Dark Assassin, Dark Fighter, Deep Sea Hunter,
Disruptor, Dragon Warrior, Elementalist, Fairy, Fairy Droid, Fighter,
Firekeeper, Golden Ruler, Golem of Wishes, Healer, Infiltrator, Ironmane,
Mod Injector, Purifier, Rune Mage, Sharpshooter, Soul Weaver, Spirit Animal,
Strategist, The Corruptor, Undercover, World Ender, World Guardian.
The breakpoint/win-con classes the strategy work cares about (Cultivator
2/3/4/5 maxBarrier breakpoints, World Ender / Golden Ruler VP-per-round,
World Guardian capstone, Cursed Spirit corruption engine, Sharpshooter PvP)
are therefore first-class per-entity features, not curated aggregates.

Origin axis (sorted, 8): Astral Zone, Cyber City, Floral Patch, Human Enclave,
Lantern Lights, Moon Tide, Royal Family, Void.

### Market token (dim 49) — 6 slots, always mask=1

| # | field | notes |
|---|-------|-------|
| 0 | `present` | slot exists (all 6) |
| 1 | `filled` | has a spirit |
| 2 | `slot` | index /6 |
| 3 | `cost` | /9 |
| 4–40 | `class:<name>` ×37 | catalog lookup by `spiritId`, /3 |
| 41–48 | `origin:<name>` ×8 | /3 |

### Rune token (dim 18) — acting seat's held mats only

| # | field | notes |
|---|-------|-------|
| 0 | `present` | |
| 1–3 | `kind:rune|relic|augment` | resolved via catalog by mat `id`, fallback to snapshot `type` (the two starting Fairy Relics have no id) |
| 4–15 | `id:<runeId>` ×12 | identity one-hot; zero when the mat has no catalog id |
| 16 | `special` | class/named special rune flag |
| 17 | `hasClass` | mat carries a `classId` |

Rune-id axis (sorted by UUID): Any Relic, Forest, Cyber City, Lantern Lights,
Tidal Tribe, Flower (relic), Any Rune, Firecracker (relic), Royal Family,
Teapot (relic), Fairy Rune (relic), Magnet (relic) — see `obsV2Meta().vocab.runeIds`
for the exact UUID order.

### Monster token (dim 10)

| # | field | notes |
|---|-------|-------|
| 0 | `present` | |
| 1 | `hpFrac` | hp/maxHp |
| 2 | `hp` | /20 |
| 3 | `damage` | /20 |
| 4 | `livesFrac` | livesRemaining/livesTotal |
| 5 | `lives` | /6 |
| 6 | `ladderFrac` | ladderIndex/ladderMax |
| 7 | `ladder` | /8 |
| 8 | `chooseAmount` | /4 |
| 9 | `rewardCount` | rewardTrack length /8 |

## Caps and observed maxima

Smoke (3 seeded 4-player heuristic games to the 30-round cap, **2838 decision
points**, every decision encoded; `encodeV2.test.ts` "full-game smoke"):

| token family | cap | observed max | headroom note |
|---|---|---|---|
| seats | 6 | 4 | cap = engine max seats |
| spirits | 42 | 28 | cap = 6 seats × `MAX_SPIRITS` 7 — cannot overflow |
| market | 6 | 6 | fixed-size market |
| runes | 8 | 6 | carry limit 4 + mid-round overflow; rows beyond 8 are dropped (counts still visible via seat `matRunes`/`matRelics`) |

## Test results (all green — 11 tests, `npx tsc --noEmit` clean)

- **Vocab/dims contract**: 37/8/12/53 vocab sizes; dims `{global:122, seat:55,
  spirit:58, market:49, rune:18, monster:10}`; flat length 3419; field-name lists
  match dims; meta round-trips.
- **Determinism**: same state+seat → deep-equal structured AND flat output;
  structuredClone of the state encodes identically; seat row 0 is always self.
- **Info safety**: opponent owner-only mutations → bit-identical encoding
  (incl. pre-reveal destination secrecy and the legacy public-field write);
  self mutations → changed encoding; post-reveal destinations encoded.
- **Smoke**: every decision point of 3 seeded games encodes without throwing;
  caps hold.

## Downstream (model v2)

- Feed each token family through a per-type linear embed, concat type embedding,
  run set attention with the masks; the acting seat is `seats[0]` by contract.
- Candidate actions stay on v1 `encodeAction` (52 floats) — score
  `f(obs_tokens, action_feat)` per legal candidate as today.
- Write `obsV2Meta(catalog)` to `meta.json` for every v2 dataset; the trainer
  must refuse data whose `flatHeader` mismatches its parser.

## Format clarifications (pinned 2026-07-02, after model-v2 integration)
1. `global` is the only maskless family; consumers must synthesize an all-ones
   mask for it. **At least the global token is always real** — this is a
   contract (rune family can be all-pad early game; monster mask can be 0).
2. `obsV2Meta().caps` key naming is fixed as: `seats`, `spirits`, `runes`,
   `market` (no caps entries for global/monster — cap 1 implied by header).
   Renaming or adding keys breaks `obs_v2.from_meta` validation — version bump
   required.
3. The monster-present bit exists in three places (monster mask, monster.present
   field, global.monsterPresent); **the mask is the authority**.
4. `flattenObsV2` emits float64 JS numbers; header entries are small ints so
   float32 casting is exact. Parsers compare headers after float32 cast.
5. Python consumers: parse via the self-describing header / `obs_v2.ObsV2Spec`,
   never hard-coded offsets.

## PINNED DATA CONTRACT — v2 training rows (authoritative, 2026-07-02)
One JSONL row format serves PPO-v2, BC warm start, AND v1<-v2 distillation:
- `obs`  = v1 62-float vector (ALWAYS present, every row, all obs versions)
- `obsV2` = 3,419-float arc-obs-v2 flat array (present when recorded at
  obsVersion 2; absent on v1-only datasets)
- `cands` = v1 encodeAction rows (52 floats) in every case
- meta.json = { "obs_dim": 62, "act_dim": 52, "obs_version": 1|2,
  "obs_v2": <obsV2Meta(catalog) block>  (present iff obs_version 2), ... }
Consumers:
- train.py --model v1 / awr / alphazero / ppo: read `obs`, ignore `obsV2`.
- train.py --model v2 + bc_warmstart_v2.py: read `obsV2` (skip+count rows
  lacking it), validate via ObsV2Spec.from_meta(meta["obs_v2"]).
- distill.py: reads both keys on the same row (paired teacher/student).
Any deviation from this shape is a bug; version-bump the contract to change it.
