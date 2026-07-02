# Arc Spirits 2D — Strategy Diversity: Findings & Deliverables (2026-06-24)

Goal: break the corruption-only bot meta; get a **diverse set of non-corrupt strategies** (economy/monster/class lines); answer "is the game balanced?".

## ★ THE ANSWER: a rebalance that creates a diverse competitive meta (PROVEN)
**RECOMMENDED CONFIG: monster/reward VP ×2 (runtime.ts:464 `gain.amount * 2`) + REMOVE the +3 Evil group-attack (runtime.ts:2658 → `+= 0`).** Sandbox-tested (reverted), 4p/30r, 8 profiles — the flattest, most diverse meta found:
- pvphunter 19.2 VP / win **46%** (was 85%) ; cursed 17.0 (42%) ; survivor 15.1 (21%) ; medium 14.8 (38%) ; **cultivator 14.7 (38% win, status 0.00 — PURE ECONOMY)** ; paragon 14.0 (13%).
- VP clustered 13.6–19.2 (tight), wins spread across **6 strategies, NO dominant line**, corruption down from 85%→46% win and a pure-economy line winning 38%. This is the diverse competitive meta — exactly the owner's instinct (monster VP up, player-kill faucet removed).
- Bracketing: ×2 (above) is best-balanced; ×3 + remove-PvP also works (pvphunter 54% win, VP 12–24, more reach-30 but wider spread). Tune ×2–×3 to taste. **Live engine NOT changed — owner's product decision (the change is 2 lines).**

## TL;DR
- **The corruption monoculture is a GAME-BALANCE problem, not (only) a training one.** Measured: at the 30-round cap, the corruption/Fallen line scores **~20–26 VP and wins ~85–93%** at every table size (2p/3p/4p); **every** non-corrupt line — even optimally built (Cultivator: maxBarrier 10 + dice 10) — caps at **~6–9 VP and never reaches 30.** The bots correctly found the dominant line.
- **Owner's instincts, adjudicated by data:** "monster kill > player kill" ✅ true per event (10 vs 3 VP); "economy is strongest" ❌ *not* at the 30-round cap (it can't convert fast enough); "is the game balanced?" → **No**, tilted to corruption at 30 rounds.
- **The corruption monoculture was BROKEN**: diverse non-corrupt neural bots now exist (status 0, distinct builds) — but they are not yet *competitive* (see limits below).

## Why corruption dominates (root cause, measured)
- The **+3 Evil group-attack** is a repeatable, no-setup VP faucet (~15 VP/game, ~4–5 hits) only the Fallen line can open. Removing it drops corruption 26→11.5.
- **Without that faucet, NO line reaches 30 in 30 rounds** (max ~11.5) — the non-PvP VP economy is too slow for the cap.
- maxBarrier (Cultivator) only grows at spirit-count **breakpoints** (2/3/4/5 Cultivators → +1/+2/+5/+10; a lone Cultivator = 0). World Ender = +1 VP/round from one awakened spirit. Both are **multi-round, multi-spirit setups**.

## Why from-scratch NEURAL bots can't yet score the non-corrupt lines
1. Those lines aren't competitive under current balance (cap ~8 VP) — little signal.
2. They need multi-spirit setups **invisible to a 1-step candidate scorer**: acquiring the first Cultivator / World Ender has zero immediate effect, so a greedy net never assembles the breakpoint. (Corruption avoided this via a hard-coded `initiatePvp` override.)

## What was built (reusable)
- `src/lib/play/ml/encode.ts`: **effect-aware action encoding** (ΔmaxBarrier/ΔVP/Δdice/Δstatus/Δawakened/wins) + **spirit-class obs features** (Cultivator/World Ender/… counts) — so the net can see action effects and its own composition.
- `driver.ts`: `forbidTypes` (e.g. forbid `initiatePvp` → no PvP-VP), `guardianNames` (per-game guardian/origin variety — was using 4 of 10), explicit **monster-kill reward** (`ARC_HUNT_BONUS`), `selection=policy/value` with `ARC_STATUS_SHAPE` (corruption pull configurable).
- `shaping.ts`: archetype presets (`economy/hunter/pure/banker/ascend`, status≤0).
- Tooling: `_diversity.test.ts` (behavioral fingerprint + true VP), `_heuraudit.test.ts` (per-profile VP/behavior), `_elo.test.ts`, `diverse_lane.sh`/`diverse_launch.sh`/`diverse_report.sh`/`probe.sh` (sharded league on the A100, GPUs 0–3).

## Deliverable: diverse strategy set (measured, 4p/30r)
| Strategy (heuristic profile) | VP | corruption | style |
|---|---|---|---|
| pvphunter | ~26 | Fallen | corrupt → repeat +3 PvP |
| cursed | ~9 | low | Cursed value engine |
| cultivator | ~8 | none | maxBarrier economy |
| survivor / medium | ~8 | none | defensive economy |
| paragon | ~7 | none | Good scaler |
| aggressive / fighter | ~3–7 | none | combat |
Plus: diverse **non-corrupt neural** bots (archived on A100 `diverse_archive/`), the corruption **champion** (27.8 VP).

## To get a diverse, COMPETITIVE set — recommended next phase
1. **Rebalance (the real lever; PROVEN):** raise non-PvP VP rate so economy/monster/class lines can reach ~30 in 30 rounds. Sandbox tests: monster VP ×3 + PvP+1 → non-corrupt lines ~doubled (11–14), started reaching 30, corruption usage dropped (status 2.7→1.86); monster ×4 + PvP+1 → cursed 15 / paragon 12 reaching 30 (19–23%), pvphunter's corruption fell further (status→1.64, now wins by *killing monsters*, not PvP). **KEY NUANCE:** buffing monster VP achieves the owner's vision *directionally* (less corruption, more monster-killing) — BUT the `pvphunter` profile still tops VP because it's a flexible GENERALIST (builds + fights monsters + opportunistic corruption) that rides any buff, while the economy profiles (cultivator/paragon) are narrower/weaker-played. So diversity needs BOTH: (a) the VP rebalance AND (b) comparably strong NON-CORRUPT-SPECIALIST bots (better heuristics, or the ML — currently blocked by the 1-step architecture limit). Just nerfing PvP makes the game unwinnable-by-30. **The live engine was NOT changed — this is a product decision.**
2. **Architecture (for the neural bot):** the spirit-class obs features (added) are necessary; if the 1-step scorer still can't plan multi-spirit setups, add multi-step search (MCTS) or scripted setup (mirroring how the corruption champion hard-codes its key action).
3. Then **retrain** under the rebalanced game → self-play diversifies on its own.

See project memory: `ml-bot-diversity-harness`, `ml-bot-current-meta`, `arc-spirits-vp-structure`.
