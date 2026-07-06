# Arc Spirits — Interaction UX Overhaul (audit + design)

**Date:** 2026-07-06 · **Author:** design-lead audit agent · **Status:** design doc, no code changed
**Scope:** every player-facing interaction in the 2D play client (`src/lib/components/play2d/`, room page), audited live against the rules engine (`src/lib/play/`).

**Method.** Drove real games on a local dev server (port 4174) via the debug-room + command API
(the same recipes as `e2e/capture-fixtures.spec.ts`), walked every interactive moment across all
six phases at 1280×720, screenshotted each (`~/.claude/jobs/74ed1e76/tmp/ux-audit/*.png` —
ephemeral job dir; regenerate with the recipes in this doc), and cross-read the engine's
legality code (`legality.ts`, `locationInteractions.ts`, `effects/awaken.ts`, `effects/matMatch.ts`,
`effects/awakenHandlers.ts`, `runtime.ts`) to determine what SHOULD be selectable in each picker.

---

## 0. Executive summary

Michael's three directives, verified:

1. **"Interactions pop their own detached UI"** — partially true. The codebase already renders
   most game decisions *inside* the stage (`MainStage.svelte` owns one `.view` per phase). The
   problem is not literal popups; it is that several in-stage interactions are **sparse floating
   fragments** that use ~15% of a mostly-black stage (awaken discard picker, benefits claim,
   infiltrator swap, encounter choice, monster rewards) and don't look designed. True detached
   overlays are confined to reference chrome (bag viewer, info legend, chat, guardian picker) —
   those are appropriate as overlays.

2. **"Selection is over-generous"** — confirmed, and worse than cosmetic. The awaken
   rune-cost picker offers **every held mat** for any cost, and the engine **silently ignores
   wrong picks**. Proven live: cost "Discard Flower ×2", UI let me select two Fairy Relics,
   confirm button armed at 2/2, and on submit the engine discarded the two *Flowers* while the
   spirits' owner watched two *Fairy Relics* get check-marked. (§3 F1, screenshot
   `33-picker-wrong-items-selected.png`.) This is systemic to every `rune_cost` spirit
   (probed: Purifier, Infiltrator, Fairy Droid, Mod Injector, Undercover, Child Prodigy,
   Golden Ruler, Dragon Warrior, Spirit Animal — all over-generous; only scripted handlers
   like Arcane Advisor's "discard 2 Abyss spirits" are precise).

3. **"General pass"** — 10 functional defects found while driving (§3), 6 over-generous or
   nonsensical selection surfaces (§2 column S), and a handful of copy/layout bugs.

**Catalog totals** (26 interactive moments scored): quality 5 ×2 · 4 ×10 · 3 ×9 · 2 ×3 ·
n/a (chrome) ×2. Over-generous/nonsense selection cases: 6 major + 2 minor. Functional bugs: 10.

The rework (§4) is one pattern — **the Stage Takeover** — applied everywhere: the stage becomes
the picker, candidates are the real game objects enlarged in place, ineligible items stay visible
but locked with the reason, and a persistent **commit bar** shows the cost/pick meter filling as
you select. The engine ships exact eligibility in the projection (§5); the client never re-derives
a rule. Waves in §6.

**Scope expansion (Michael, 07-06):** the PRE-GAME surfaces — main menu, matchmaking queue,
server browser / room creation, and the room lobby — get their own audit and a
**mobile-game-grade redesign** (§7). Audited at both 1280×720 desktop AND 844×390 phone-landscape
(the app hard-gates portrait behind a "rotate your device" screen). Verdict: these screens read
as a website, not a game — text-link menus in a half-empty frame, a bare-form server browser,
and a lobby whose seat list doesn't even render at 720p. §7 designs the replacement (full-bleed
title menu, searching scene, card-based room browser, party-screen lobby) and adds **Wave M**,
runnable in parallel with Wave 1.

---

## 1. How interactions are hosted today (context for the rework)

- `GameBoard2D.svelte` lays out a 3-column pager: left trait rail (`MatSlots` + `TraitTracker`),
  center `.stage-cell` hosting `MainStage` (or `CompositionStage` when scouting), right
  `Leaderboard`. Pass-turn is a footer under the stage (`GameBoard2D.svelte:1360`).
- `MainStage.svelte` renders exactly ONE view per phase state (instruction line + view body).
  All redesigns below live inside this contract — it is the right architecture; the views
  inside it are what need the work.
- RoomView v2 affordances (`src/lib/play/viewV2.ts`) already give per-seat `legalCommandTypes`,
  `pendingWork` descriptors, `canPass`. The client doesn't consume them yet — the rework's data
  layer (§5) is an extension of exactly this surface.

---

## 2. Interaction catalog

Columns: **P** presentation (E = embedded in stage, O = detached overlay, C = chrome/rail) ·
**A** approx. share of stage area used · **Q** visual quality 1–5 · **S** selection behavior
(✓ = matches rules, ⚠ = over-generous/nonsense — detailed after the table).

| # | Interaction | Where (file:line) | P | A | Q | S | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Lobby seats / start game | `routes/play/[roomCode]/+page.svelte:473-660` | page | — | 3 | ⚠S4 | Party list unreachable at 720p (F2). `canStart` = any seat occupied, guardians not required (line 92) |
| 2 | Guardian picker | `GuardianPicker.svelte:92-117` | O (modal z80) | ~60% | 4 | ✓ | Taken-set client-derived from seats (page :99-108); letter-placeholder tiles for missing art |
| 3 | Navigation compass/carousel | `SpiritWorldBoard.svelte:596-607, 535-548` | E | 100% | **5** | ✓ | The benchmark. All 5 destinations always pickable (rules-correct) |
| 4 | Confirmed-destination circle | `ConfirmDestinationCircle.svelte`, `ConfirmedDestinationPanel.svelte:92` | E | ~70% | 4 | ✓ | "Change selection" gated by parent |
| 5 | Destination reveal | `DestinationReveal.svelte` | O (z60, transient) | 100% | 4 | ✓ | Auto-dismiss; fine as a cutscene overlay |
| 6 | Location interaction cards | `LocationInteractionMenu.svelte:221-366` | E | ~55% | 4 | ⚠S1,S6 | Frosted-glass cards; **the only precise cost chooser in the game** (`costChooserFor` :47 uses `eligibleCostSlots` + dedupes) |
| 7 | Wildcard-cost "Discard one" chooser | `LocationInteractionMenu.svelte:253-291` | E (in card) | tiny | 3 | ✓ | Correct but cramped; specific (non-wildcard) costs are spent invisibly |
| 8 | "Or"-gain chooser | `LocationInteractionMenu.svelte:308-333` | E (in card) | tiny | 3 | ⚠S6 | Defaults to option 0 — resolving without ever picking is one click |
| 9 | Draw tray (summon pick) | `DrawTray.svelte:146-192` | E | ~80% | **4.5** | ✓ | Best interaction in the game: big hex cards, awaken cost + ability on card, redraw/return |
| 10 | Abyss fight/summon stage cards | `MainStage.svelte:920-955`, `StageCard.svelte` | E | ~50% | 3 | ✓ | Fight card disabled when spent; "S1Monster" raw name leaks (F7-adjacent) |
| 11 | Combat overlay + continue | `CombatOverlay.svelte`, `MainStage.svelte:829-840` | E | ~60% | 4 | ✓ | Result log card; combat itself has no interaction |
| 12 | Monster reward menu | `MainStage.svelte:841-912` | E | ~35% | 3 | ✓ | Client runs `buildMonsterRewards` on raw `rewardTrack` (S-note §5.3); sparse medallions |
| 13 | Action result card | `ActionResult.svelte` | E | ~40% | 3.5 | ✓ | Log lines + Continue |
| 14 | Awaken offers (face-down flips) | `MainStage.svelte:1190-1218` | E | ~25% | 3 | ✓ | One floating hex per offer in an empty stage; requirement text tiny inside card |
| 15 | **Awaken discard picker** | `MainStage.svelte:1154-1189` | E | ~30% | **2** | **⚠S2** | Michael's named case. Options = ALL spendable mats (engine bug, see F1); duplicates not collapsed |
| 16 | Decision cards (location/encounter) | `MainStage.svelte:726-785` | E | ~30% | 2.5 | ✓ | Plain prompt + option buttons; Arc Mage dice picker embedded (`:731-767`) |
| 17 | Decision/manual cards (awakening) | `MainStage.svelte:1136-1152, 1221-1233` | E | ~30% | 2.5 | ✓ | Same plain panels |
| 18 | Benefits claim (grants/tainted/relics) | `MainStage.svelte:1048-1131` | E | ~45% | **2** | ✓ | Raw label rows, ± stepper, 4×5 grid of 30px relic buttons (screenshot 28) |
| 19 | Corruption discard | `MainStage.svelte:642-658` | E | ~70% | 4 | ✓ | Hex board discard mode, clear prompt; Pass Turn stays enabled → F3 |
| 20 | Augment placement | `MainStage.svelte:661-724` | E | ~65% | 3.5 | ⚠S5 | Icon→spirit flow good; "Done" silently forfeits unplaced augments (F6); eligibility client-derived (`isAugmentEligible` :428) |
| 21 | Cleanup rune overflow | `MainStage.svelte:1237-1259` | E | ~50% | 3.5 | ✓ | Every click = irreversible instant discard, no staging/undo |
| 22 | Infiltrator dice swap | `MainStage.svelte:957-1021` | E | ~40% | **2** | ✓ | Text-pill dice, plain rows; "Swap 0 dies" copy bug (F5) |
| 23 | Encounter attack/hold | `MainStage.svelte:786-816` | E | ~20% | 3 | ✓ | Two buttons + seat chips floating in an empty stage |
| 24 | Pass turn | `GameBoard2D.svelte:1360-1370` | E (footer) | — | 3.5 | ⚠S3 | `canPassTurn` re-implements phase rules client-side (:944-964) and gets location-corruption wrong (F3) |
| 25 | Scout board + spirit detail + discard | `CompositionStage.svelte:218-292` | E | 100% | 4.5 | ⚠S7 | Gorgeous board; detail card's Discard overlaps text (F4) and discards with **no confirmation** |
| 26 | Chrome overlays (bag/legend/chat/settings) | `BagViewer`, `InfoLegend`, `GameChat`, `GameBoard2D:1208-1256` | O | — | 4 | ✓ | Appropriate as overlays; keep |

### Over-generous / nonsensical selection cases (the S column)

- **S1 — invisible specific-cost spends.** A trade whose cost is a *specific* rune shows the cost
  icon but never which held copy will be consumed; only wildcard costs get a chooser
  (`LocationInteractionMenu.svelte:47-67`). Payment feels like a black box.
- **S2 — awaken rune-cost picker offers everything.** `buildAwakenOffer`
  (`src/lib/play/effects/awaken.ts:224-228`) sets `options = spendableMats(player.mats)` — the
  entire rack, not the cost-eligible subset — and duplicates are not collapsed (contrast with the
  trade chooser's dedupe). Probed live: "Discard Flower ×2" → 4-6 options including Fairy Relics,
  Magnet, Teapot. Combined with F1 this is the flagship fix.
- **S3 — pass-turn eligibility re-derived client-side.** `GameBoard2D.svelte:944-972` re-implements
  phase legality and the phase→command map; misses the location-phase corruption block
  (`legality.ts:146`) → enabled button whose command the server rejects (F3).
- **S4 — Start Game with no guardians.** `+page.svelte:92` enables start when ≥1 seat is occupied,
  even if no seated player picked a guardian; server is the only guard.
- **S5 — augment placement eligibility computed in the component.** `MainStage.svelte:428-439`
  reimplements host-class/capacity rules (`augmentCapacityForSpirit`); the projection's
  `unplacedAugments` carries `boundSlotIndex`/`hostClass`/`hostCapacity` but not the *verdict*,
  and the capacity default (1 vs Fairy Droid ∞) lives only in client code.
- **S6 — one-click resolution of choices you never made.** "Or" gains pre-select option 0 and a
  costed row can be resolved without touching either chooser; similarly a trade that grants
  nothing useful is still presented as an attractive card — I paid a Fairy Relic and the result
  was "Restored 0 barrier" (full barriers). Legal, but the UI sold me a null trade.
- Minor: server browser Join not disabled on full rooms (`screens/ServerBrowser.svelte:319-347`);
  DrawTray trusts every card whenever picks remain (fine today — engine validates guid).

---

## 3. Functional bugs found while driving

| ID | Bug | Evidence / location |
|---|---|---|
| **F1** | **Awaken payment silently overrides the player's selection.** Picker sends refs → `runtime.ts:2166-2177` maps them to instance ids → `matchMatCost` treats them as *preferences only* (`effects/matMatch.ts:103-108`): non-matching picks are ignored and the greedy fallback spends other items. Selected 2 Fairy Relics for "Flower ×2"; engine discarded the 2 Flowers; spirit awakened. UI state and game state disagree about what the player just paid. | run5 log: mats before `[Fairy, Fairy, Flower, Flower, Magnet, Teapot]` → after `[Fairy, Fairy, Magnet, Teapot]`; shots `33/34-*.png` |
| **F2** | **Lobby party list & guardian picking unreachable at 1280×720.** At 16:9 720p the seat rows don't render in the viewport (title → nav-timer row directly) and the page doesn't scroll to them; automation could not open the picker at all. Works at 1280×1600. | shots `01-lobby.png` vs `01c-lobby-tall.png` |
| **F3** | **Pass Turn enabled while a location-phase corruption discard is pending.** `canPassTurn` only blocks corruption in cleanup (`GameBoard2D.svelte:944-964`); `endLocationActions` is provably illegal then (`legality.ts:146`). Click → server rejection. | shot `12-corruption-discard.png` (PASS TURN lit) |
| **F4** | **Spirit-detail Discard button overlaps the class description text** in the scout inspector's in-flow card. | shot `19-spirit-detail.png`; `CompositionStage.svelte:284-292` |
| **F5** | **"SWAP 0 DIES"** — `Swap {n} die{n===1?'':'s'}` pluralizes *die* to *dies* (`MainStage.svelte:1015`). |
| **F6** | **"Done" forfeits unplaced augments with no warning.** The button reads "Done" whenever any spirit is still eligible; it actually calls `onDiscardAugments()` and destroys the remaining augments (`MainStage.svelte:706-723`). Only the no-target state admits it ("Discard N & continue"). |
| **F7** | **Unrecognized reward icons render as "?" hexes** (Cyber City rows, Abyss summon card) and the seeded monster shows a raw internal name ("S1Monster"). | shots `31-*.png`, `20/21/22-*.png` |
| **F8** | **`spawnHandSpirit` silently overwrites an occupied slot** — a valid in-range `slotIndex` that is occupied is not rejected; the resident spirit + its augments are destroyed (`runtime.ts:1226-1233`). Latent (UI defaults to first open slot). |
| **F9** | **`resolveDecision` with an unknown `optionId` silently consumes the decision** as a no-op (`runtime.ts:2085-2106`) — a malformed client discards a decision card. |
| **F10** | **No dedupe in the awaken picker** — identical copies each get a card ("Fairy Relic, Fairy Relic"), while the trade chooser collapses them (`LocationInteractionMenu.svelte:55-66`). Cosmetic-functional mismatch between the two piles of the same UX. |

Also observed (not bugs, catalog notes): the phase bar shows 4 nodes — Benefits/Awakening/Cleanup
all sit under "CLEANUP" with only the small sub-label differing (`PhaseBar`), which reads wrong
during awakening; the reveal-overlay debug param `?showDestinationReveal=1` pins the overlay
forever (dev-only).

---

## 4. The rework — "Stage Takeover" pattern language

One pattern, applied to every game decision. The stage (MainStage's `.view-body`) *becomes* the
picker; nothing floats detached, and nothing sits in a corner of an empty void.

### 4.1 Anatomy (shared components, build once)

```
┌────────────────────────────────────────────────────────────┐
│  INSTRUCTION ROW  (existing .main-instruction — keep)      │
│                                                            │
│  ┌──────────┐   ┌──────────────────────────────────────┐   │
│  │  SOURCE  │   │  CANDIDATE RACK                      │   │
│  │  (why)   │   │  the real game objects, enlarged:    │   │
│  │ spirit / │   │  · eligible → lit, hover-lift, tap   │   │
│  │ trade    │   │  · ineligible → present, dimmed 40%, │   │
│  │ card,    │   │    lock badge, reason chip on        │   │
│  │ pinned   │   │    hover/tap ("Not a Flower")        │   │
│  └──────────┘   │  · identical copies collapse to one  │   │
│                 │    card + ×N stepper                 │   │
│                 └──────────────────────────────────────┘   │
│                                                            │
│  COMMIT BAR (fixed bottom row of the stage)                │
│  [cost slots: ◇◇ fill in as you pick]  [Confirm CTA]  [✕] │
└────────────────────────────────────────────────────────────┘
```

- **Source panel**: the object that caused the decision (face-down spirit being awakened, the
  trade card, the monster) pinned large on the left — the player never loses the "why".
- **Candidate rack**: candidates render as the game's own objects (mat cards, spirit hexes, die
  gems) at readable size (≥72px), never as text pills. Dim-and-lock beats hiding: the player
  learns the rule from seeing what's excluded and why. Reasons come from the engine (§5), the
  client only displays them.
- **Commit bar**: one home for every multi-step decision. Left side = the cost/pick meter — one
  slot per required item, each slot showing the *requirement* (Flower icon ×2) and filling with
  the chosen item as you tap. Right = single CTA with live count ("Discard 2 & Awaken Rootguard"),
  disabled until the meter is exactly full; Cancel beside it. Staged, not instant: nothing mutates
  until Confirm (gives overflow/corruption an undo for free).
- **Motion**: candidates scale in from their board position (the mat rail / hex board), the rest
  of the stage dims 30% behind the takeover. Reduced-motion honored.
- Board chrome (trait rail, leaderboard, pass footer) stays visible but de-emphasized; Pass Turn
  disabled (from `affordances.canPass`) while a takeover is open.

### 4.2 Per-interaction redesigns

**W1a · Awaken offer → payment takeover** (Michael's named case; replaces `MainStage.svelte:1154-1218`)
Awakening stage shows the offers as a spread of face-down spirit hexes (existing offer art) plus
locked offers (`awakenLocked`) as dimmed hexes with their requirement chip — everything you own
that could ever flip is on stage, eligible or not. Tapping an eligible spirit opens the takeover:
spirit card pinned left flipping halfway (tease of the front art), requirement headline
("Awaken: discard Flower ×2"), candidate rack = your mat rack with only cost-eligible mats lit
(engine-supplied, §5.1), duplicates collapsed with ×N. Cost meter = one slot per required item.
Confirm = "Discard … & Awaken". Free flips skip the takeover (single tap, small confirm pulse).
Rides with the F1 engine fix: submitted refs become *binding* (§5.1) — what you see is what is spent.

**W1b · Trade/cost payment on location cards** (extends `LocationInteractionMenu`)
Card grid stays (it's good). A free gain stays one-click. A **costed** trade no longer resolves
on card click — it *arms*: the card pins as the source panel, the mat rack rises as the candidate
rack, and every cost slot (specific AND wildcard) is a visible meter slot. Specific costs come
pre-filled with the engine's auto-match but are shown (fixes S1 — you always see what you're
about to lose, and can swap between identical copies); wildcard slots need a tap. "Or" gains
become explicit chips in the armed view with no silent default (fixes S6): the confirm CTA stays
disabled until each choice group has a selection. Rows whose gains are currently worthless
(restore-barrier at full barrier) get a warning chip ("no effect right now") instead of a
full-brightness CTA.

**W1c · Benefits claim** (replaces `MainStage.svelte:1048-1131`)
Grants render as a vertical stack of grant cards (source class art + amount), full stage width.
The Cursed-Spirit tainted split becomes a segmented slider: N segments, each segment a heart↔die
toggle, with live icon rows showing the resulting split (no ± stepper arithmetic). Relic choice:
one row per unit, the 5 relics at full mat-card size with names, selected = check badge — same
rack component as W1a. Commit bar CTA = "Claim rewards".

**W2a · Monster rewards** (replaces `MainStage.svelte:841-912`)
This is the loot moment — let it celebrate. Reward track as large medallion cards fanned across
the stage (art at ≥120px), pick-meter in the commit bar ("Choose 2 — 1 picked"), chooseRune
options expand as sub-chips inside a selected card. Already-at-max cards dim with "pick limit"
chip. Uses resolved reward options from the projection (§5.3), deleting the client's
`buildMonsterRewards` call.

**W2b · Awakening decisions & manual prompts** (restyle `MainStage.svelte:726-785, 1136-1152, 1221-1233`)
Decision panels become ability cards: class/spirit art header, prompt, option buttons as full-width
choice rows. Pickers inside decisions (Arc Mage's 4 dice) use the candidate-rack + commit-bar
components with engine `pickerSpec` (§5.4) instead of the bespoke `arc-convert` block.

**W2c · Corruption discard & rune overflow** (upgrade in place)
Both keep their layouts (they're already takeover-shaped) but adopt the commit bar: selections
stage (red-marked hexes / crossed runes), meter shows "2 of 2 selected", single Confirm commits,
Cancel restores — replacing today's irreversible per-click mutation (`onDiscardSpirit`/`onDiscardRune`
fire immediately). Corruption reason line ("You corrupted fighting the monster") from the engine's
`reason` field.

**W2d · Infiltrator swap + encounter choice** (replace `MainStage.svelte:957-1021, 786-816`)
Dice become physical gem tokens (tier-colored, the TIER_COLOR ramp already exists) in two facing
rows per opponent with an animated swap-arrow between the chosen pair; commit bar "Swap 1 die"
(copy fixed). Encounter: co-located targets as large seat-avatar cards (guardian art), Attack
Together / Hold as commit-bar actions, and the "all Evil must agree" state shown as vote chips
per Evil seat.

**W2e · Augment placement** (upgrade `MainStage.svelte:661-724`)
Keep icon→board flow. Eligible spirits glow when an augment is armed; ineligible hexes dim with
reason chips ("No Fighter class", "Augment slots full") from engine data (§5.4). Button honesty:
"Done" only when nothing is left; otherwise "Forfeit 2 unplaced augments" with a confirm beat (F6).

**W3 · Chrome & shell**
- Lobby: fix the 720p layout so seats are always above the fold (F2); guardian picking becomes a
  full-screen embedded character-select (same visual family as the takeover) instead of a modal.
- Phase bar: 6 real phases (or 4 groups with visible sub-steps) so "CLEANUP" isn't lit during
  Benefits/Awakening.
- Scout inspector: fix the Discard overlap (F4) and give discard a confirm beat.
- Pass Turn switches to `affordances.canPass` + `passBlockedReason` tooltip (F3, S3); auto-pass
  logic (`shouldAutoPassLocation`) switches to `hasResolutionWork`/`canPass` instead of local
  `buildLocationInteractions` re-derivation.
- Server browser: disable Join on full rooms; icon fallback for unknown reward tokens (F7);
  monster display names.

### 4.3 Which screens share which pattern

- **Payment takeover** (source + mat rack + cost meter): awaken picker (W1a), trade arming (W1b).
- **Candidate rack multi-pick**: relic choice (W1c), monster rewards (W2a), decision pickers (W2b),
  corruption/overflow staging (W2c), infiltrator gems (W2d).
- **Board-target pick** (arm a token, tap a hex): augment placement (W2e) — also the future home
  for any "choose one of your spirits" effect.
- **Card stack + options**: decisions, manual prompts, benefits grants.

---

## 5. Engine data requirements (client must never re-derive rules)

All additive, extending `viewV2.ts` affordances / the projection. Field names are proposals.

### 5.1 Awaken offers (fixes S2 + F1) — `AwakenOffer` (types.ts:416)
```ts
interface AwakenOffer {
  // existing: slotIndex, spiritName, requirement, discardCount, options
  costSlots?: {                      // one entry per required item, in payment order
    need: string;                    // display label of the requirement ("Flower", "Any Relic")
    needRuneId?: string;             // icon lookup
    wildcard: boolean;
    eligibleRefs: AwakenDiscardRef[]; // ONLY refs that can legally fill this slot
  }[];
  ineligible?: { ref: AwakenDiscardRef; label: string; reason: string }[]; // for dim+reason chips
}
```
Options for scripted handlers keep the current shape (they're already precise). Duplicate
collapsing stays a client concern (group by runeId/label).
**Reducer change (required, same PR):** `awakenSpirit` with explicit `discardRefs` must **validate
and reject** (`failure('invalid_discard_selection')`) when the refs don't exactly satisfy the cost
— mirror `validRefs` (`awakenHandlers.ts:232-250`) for the `rune_cost` path; `matchMatCost` gets a
strict mode where `preferIds` are binding, not preferences. Omitted refs keep auto-pick (bots).

### 5.2 Location interactions (fixes S1/S3/S6) — per-seat affordance block
```ts
interface LocationInteractionAffordance {
  rowIndex: number;
  usesRemaining: number;             // allowance − used (engine owns the 1+extraActions formula)
  affordable: boolean;
  freeTrade?: 'modInjector' | 'undercover';  // waiver + why
  costSlots: {
    need: string; wildcard: boolean;
    eligibleMatSlotIndexes: number[];        // all legal payers
    autoPick: number | null;                 // what auto-match would spend (pre-fill)
  }[];
  choiceGroups: { options: { runeId: string; name: string }[] }[]; // "or" gains, no default
  noEffectNow?: boolean;             // gains currently worthless (e.g. barrier already full)
}
```
Delivered per seat (it reads private mats) under `SeatAffordances.locationInteractions`.
The reducer already validates rowIndex/allowance/affordability; optionally make explicit
`costChoices` binding (reject instead of fallback) for symmetry with 5.1.

### 5.3 Monster rewards — resolve server-side
`pendingReward` today ships raw `rewardTrack: string[]` icon ids and the client runs
`buildMonsterRewards` (`MainStage.svelte:330`). Ship resolved options instead:
```ts
pendingReward: {
  monsterName: string; chooseAmount: number;
  options: { index: number; label: string; iconToken: string;
             effect: 'vp' | 'rune' | 'chooseRune' | ...;
             chooseOptions?: { runeId: string; name: string }[] }[];
}
```

### 5.4 PendingWork descriptor extensions (`viewV2.ts:51`)
- `corruptionDiscard`: + `eligibleSpiritSlots: number[]`, `reason?: string`.
- `overflow`: + `heldRuneSlotIndexes: number[]` (count exists).
- `augment`: + per-augment `{ runeId, eligibleSpiritSlots: number[], slotReasons: Record<number,string>, classChoices: string[] }` — replaces client `isAugmentEligible` (S5) and encodes the capacity default.
- `decision`: + `pickerSpec?: { kind: 'attackDice'; count: 4; eligibleInstanceIds: string[] }` for
  arcMageTrade-class decisions; reducer rejects unknown `optionId` (F9) and wrong-count selections.
- New kind `encounter`: `{ eligibleTargets: SeatColor[]; votesPending: SeatColor[] }` (resolves the
  `initiatePvp` `undefined` verdict engine-side).
- New kind `infiltratorSwap`: `{ targets: { seat, dice: {instanceId,tier}[] }[]; myDice: {...}[] }`.
- `canPass` exists; add `passBlockedReason?: string` (drives F3's disabled-state tooltip).

### 5.5 Reducer hardening (rides with the waves)
- W1: 5.1 strict refs; F5 copy; (optional) binding costChoices.
- W2: F9 unknown-option reject; `spawnHandSpirit` occupied-slot reject (F8).
- Lobby view: server-computed `canStart` + reason (S4).

---

## 6. Waves

**Wave 1 — the payment pattern (worst-looking + most-used + Michael-named)**
1. Shared components: commit bar, candidate rack (+dim/reason chip), source panel, takeover choreography.
2. W1a awaken offers + discard picker, with §5.1 (engine eligibility + strict validation → F1, F10, S2).
3. W1b trade arming on location cards, with §5.2 (S1, S6, no-effect warning).
4. W1c benefits claim (worst quality score in the audit alongside the picker, appears every round a Cursed Spirit is corrupting).
5. Ride-alongs: F3 (canPass wiring), F5 copy fix.
*Engine tests: `_canApply.test.ts` fidelity suite + new strict-refs cases; goldens: see below.*

**Wave 2 — the remaining decision surfaces**
W2a monster rewards (+§5.3) · W2b decisions/manual prompts (+pickerSpec, F9) · W2c staged
corruption/overflow · W2d infiltrator + encounter · W2e augment eligibility (+§5.4) · F8.

**Wave M — pre-game mobile-game rework (Michael 07-06, see §7)**
Main menu title screen · matchmaking searching scene · room browser + create sheet · party-screen
lobby (subsumes F2/S4 and the wave-3 "lobby 720p + embedded character select" items). Touches only
`routes/play/*` pages + pre-game components — **no engine or MainStage dependency, so it runs in
parallel with Wave 1** (separate implementer).

**Wave 3 — shell polish**
Phase bar 6 phases · scout inspector fixes (F4 + discard confirm) · icon/name fallbacks (F7).
(Lobby/character-select/browser items moved to Wave M.)

### Parity-fixture impact (12 fixtures in `../arc-spirits-godot/fixtures`, goldens `goldens/web/`)

| Wave | Invalidated goldens |
|---|---|
| 1 | `05-location-interaction` (armed-trade cards), `08-awaken-offers` (offers spread + takeover), `09-benefits-claim` (full redesign). Commit-bar presence may also touch `10/11` if shared footer lands globally — keep the bar per-takeover in W1 to avoid it. |
| M | **`01-lobby` dies with the party-screen redesign** — regenerate after Wave M lands. The Godot M2 lobby must be built to the NEW design (web-first, then port); do not port the current lobby. |
| 2 | `07-reward-claim`, `10-cleanup-rune-discard`, `11-corruption-discard`, `06-combat-overlay` (only if the continue CTA moves into the commit bar). |
| 3 | **The 6-phase phase bar invalidates every in-game golden (02–11)** — land it at the start of a wave boundary and re-golden once (`npx playwright test e2e/capture-fixtures.spec.ts`). |
| untouched | `02/03/04` navigation set, `12-postgame` (until wave 3 phase-bar regold). |

---

## 7. Pre-game surfaces — mobile-game rework (scope expansion, Michael 07-06)

**Directive (verbatim intent):** main menu, lobby, custom room creation, and the matchmaking
queue should be "greatly reworked"; the lobby "should look a lot different"; create-room and
queue "way different" — the UI should **resemble a mobile game**; today it "looks too small and
the layout doesn't look good on mobile."

**Method:** audited at 1280×720 desktop AND phone viewport. Note: the app hard-gates portrait —
390×844 shows only a full-screen "ROTATE YOUR DEVICE" panel — so the phone audit ran at
**844×390 landscape** (iPhone-class, `isMobile`+touch). Screenshots `40–44-*-{desktop,phone-landscape}.png`.

### 7.1 Pre-game catalog

| Screen | Where | Desktop 720p | Phone landscape | Findings |
|---|---|---|---|---|
| Main menu | `routes/play/+page.svelte:216-360` (`MenuShell`) | **2.5** | **2.5** | Wordmark + tagline top-left, then five text-link rows (`Solo Play / Quick Play / Custom Lobby / Hall of Guardians / Builder`) hugging the left edge; the right ~60% of the screen is empty black. Reads as a dev index page, not a game title screen. Hover gem/arrow microinteractions are nice; nothing communicates game modes visually. |
| Ranked matchmaking queue | same file, `ranked-view` (`:293-352`) | **—** (did not open in the desktop run — clicking Quick Play left the menu unchanged; opened fine on phone. Flag as a reliability follow-up) | **3** | Right-side card: spinner + timer + pip meter + queue roster is a solid skeleton. Defects: card **overflows the viewport** (Cancel button below the fold at 844×390); the corner sound/settings chrome overlaps the card; players show as duplicate "Nameless Spirit" identity defaults; left half of the screen is empty. |
| Server browser / room creation | `screens/ServerBrowser.svelte` (route `play/browse`) | **2.5** | **2.5** | "SERVERS" heading, a bare underlined text input ("Playing as") next to one gradient CREATE ROOM button, a dev spawn row, then the list. Creation is a *form field*, not a flow — no room options at create time (timer/bots/invite live in the lobby instead). Join not disabled on full rooms (S4). On phone the open-lobbies list starts below the fold. |
| Room lobby | `routes/play/[roomCode]/+page.svelte:473-660` | **1.5** | **2.5** | Desktop 720p: **seat/party section does not render at all** (F2) — title → timer/bot/invite buttons → Start Game → chat; a player cannot see seats or pick a guardian at the single most common desktop resolution. Phone landscape: seat grid appears (2-col, right of chat) but the host row is broken — display name truncated ("Au…"→"AI"), "No character" wraps under the avatar, CHOOSE/LEAVE buttons overlap the name block; Start Game below the fold; chat consumes the left half of a *party* screen. Settings read as a row of identical outline chips ("2:00 / ML POLICY / + ADD BOT / INVITE PLAYER") with no hierarchy. |
| Guardian picker | `GuardianPicker.svelte` | **unreachable at 720p** (F2); 4 at taller sizes | **4** | On phone it fills the screen and works well — closest thing to a mobile game already. Tiles crop art oddly (two-band layout), missing-art guardians show letter placeholders, selected/taken states are subtle. |
| Portrait gate | `+layout` rotate panel | n/a | n/a | ALL surfaces, including menus, are landscape-only. Mobile-game norm is portrait-capable menus with the rotate gate at *game entry* — holding a phone sideways to browse a menu is friction. |

### 7.2 Redesign — "title screen to party screen", one visual family

Keep the Arc Spirits identity everywhere: Opsilon display type, the flame/violet/cyan palette,
splat backdrops (with the existing quality setting). The shift is compositional: **full-bleed
scenes, one hero element per screen, big tappable cards (≥56px touch targets), generous type,
bottom-anchored primary actions on phone** — and every screen works in portrait too (the rotate
gate moves to game entry; these are simple column layouts, portrait support is cheap).

**M1 · Main menu → title screen.** Full-bleed splat/key-art backdrop (guardian art carousel
slowly panning). Wordmark as the hero. The five modes become **mode cards** — large gem-shaped
buttons with an icon, title, and one-line subtitle ("Quick Play — ranked, 4 players"), stacked
bottom-left on desktop, bottom-anchored row/column on phone. Solo Play keeps primary treatment.
Profile chip (avatar + name + sign-in state) docks top-left; sound/settings stay top-right.
The empty right half becomes the art, not dead space.

**M2 · Quick Play → searching scene.** Full-screen takeover (same family as the in-game Stage
Takeover): your guardian art center-stage with a radar-pulse ring, big mono timer, the pip meter
kept, and the queue roster as **portrait chips that flip in** as players join (empty slots =
silhouettes). Cancel is the single bottom-anchored action. Fixes riding along: card must fit
390-height (no below-fold cancel), corner chrome yields to the scene, prompt for a display name
(or use the account name) instead of stacking "Nameless Spirit"s, and make the desktop
Quick-Play → ranked-view transition reliable.

**M3 · Custom lobby browser → room cards + create sheet.** Rooms render as **big cards**: host
guardian portrait, room name/code, seat pips (4/6), spectate/live badge, and a JOIN button —
disabled with a "Full" chip when full (closes S4). "Create room" is the bottom-anchored primary
action opening a **create sheet** (name, nav timer, bot policy + count, invite toggle) so a room
is configured at creation instead of via the lobby's chip row. "Playing as" becomes part of the
profile chip, not a bare form field. Empty state keeps the "Scanning the abyss…" copy.

**M4 · Room lobby → party screen.** The party IS the hero: six **seat slots as large
guardian-portrait frames** in a row/arc across the center (color-rimmed per seat), each slot
either a filled portrait + name + ready state, an "invite" plus-tile, or a bot tile with
difficulty badge. Tapping your slot opens the character select (M5). Room code renders big with
a one-tap copy/share chip. Host controls (timer, bots) live in a compact settings strip; **Start
Game is the dominant bottom-right CTA**, lit only when the server says ready (server-computed
`canStart` + reason, §5.5 — "waiting for guardians…" shown otherwise). Chat collapses to a
drawer tab (it currently eats half the screen). This layout is seat-first by construction, so
the 720p disappearing-party bug (F2) is fixed by design, not patched.

**M5 · Guardian picker → character select screen.** Full-screen (not a modal): guardian grid on
the left, a **detail pane** on the right (full art, name, flavor/kit summary), big Confirm
bottom-right. Taken guardians show the claiming seat's color chip instead of just dimming.
Missing-art guardians get a designed sigil placeholder rather than a letter.

Shared pieces with the in-game overhaul: the commit-bar/CTA styling, portrait-chip component
(queue roster, lobby seats, encounter targets in W2d), and reason-chip pattern ("Full",
"waiting for guardians…").

### 7.3 Wave placement & parity impact

Wave M (see §6) — parallel with Wave 1; different file surface (`routes/play/*`,
`GuardianPicker`, `ServerBrowser`, `MenuShell`), no engine dependency beyond the lobby
`canStart` field. Suggested order: M4 lobby (worst defect + Michael-named) → M1 menu →
M2 queue → M3 browser → M5 character select → portrait un-gating for pre-game routes.
`01-lobby` golden is invalidated; **the Godot M2 lobby port must target the NEW design** —
web ships first, then the port copies it.

---

## 8. Reproduction recipes (for whoever implements)

- Dev server: `npx vite dev --port 4174 --strictPort`. Headless audits: set
  `localStorage['asp:splat-quality'] = '"off"::v1'` (splat renderer pegs headless CPU) and use
  `?e2e=1`.
- Awaken picker: `POST /api/play/debug {className:'Purifier'}` → offer "Discard Flower ×2";
  grant extra relics via `{type:'debugGrant', grant:{kind:'rune', runeId:<Magnet>}}` to see
  over-generosity. F1 repro: select the two Fairy Relics, confirm, diff `player.mats`.
- Benefits pickers: 2p game → debugGrant 2 face-up Cursed Spirits → location → `adjustStatus +2`
  → pay corruption discards → `endLocationActions` both → benefits holds with taintedChoice +
  relicChoice ×N.
- Encounter: `adjustStatus +3` (Fallen ⇒ Evil), settle discards, next round co-locate both seats.
- Full recipe set: `e2e/capture-fixtures.spec.ts` + the audit driver scripts (`audit*.mjs` in the
  job tmp dir, disposable).
- Pre-game phone audit: Playwright context `{ viewport: {width: 844, height: 390}, isMobile: true,
  hasTouch: true }` — portrait (390×844) only shows the rotate gate. Queue: click `quick-play`
  from `/play` (dev matchmaking pairs any two waiting sessions); browser at `/play/browse`;
  lobby = create session via API, claim a seat, load `/play/<code>?e2e=1` without starting.
