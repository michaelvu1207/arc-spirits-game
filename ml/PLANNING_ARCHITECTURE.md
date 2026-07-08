# Arc Spirits 2D — Neural Planning Architecture (AlphaZero / ISMCTS)

**Goal:** an ML bot that *plans* over the game's multi-round horizon and definitively
beats the field — discovering strong lines (the monster/economy farm, multi-spirit
class setups) on its own, not just the corruption faucet. ML only; heuristics are
training opponents / bootstrap rollouts, never a shipped deliverable.

## Why the current bot can't plan (the diagnosis)

The deployed neural bot is a **1-step candidate scorer**: `trunk(concat(obs, action)) → logit`,
softmax → pick one action now. It has no lookahead beyond an optional 1-ply value peek.

The game's value is in **multi-round sequences whose payoff is invisible to a greedy scorer**:
- Monster farm: navigate to the Abyss → survive the monster's first strike → deal its full
  barrier in one combat → claim the reward track → repeat every round as the monster escalates.
  (The monster's `livesRemaining` scales with player count — 1-2p→1, 3p→2, 4+p→3; a weak rung dies to ~1 damage and is killable
  repeatedly — a fight-every-round bot farms ~12+ VP trivially, but the heuristics fight ~3×/30r
  and the 1-step net fights ~0.)
- maxBarrier via the Cultivator breakpoint (collect 2→3→4→5 Cultivators for +1/+2/+5/+10): the
  *first* Cultivator has zero immediate effect, so a greedy net never assembles it.
- World Ender = +1 VP/round from one awakened spirit — easy, but still a multi-round commitment.

A greedy scorer can't represent "pay now, win later." **Search can.**

## The architecture

We have a **perfect forward model** — the engine (`applyGameCommand`, `legalActionsWithNext`)
— so model-based search is the correct tool. This is AlphaZero, adapted for the game's
stochasticity (dice, bag draws) and imperfect information (hidden bags/hands) via
**Information-Set MCTS with determinization** (already implemented for navigation in
`botPolicy.ts`; we upgrade and learn it).

```
                 ┌─────────────────────────────────────────────┐
   decision  →   │  ISMCTS planner (multi-round lookahead)       │  → move + visit dist π
                 │   • determinize hidden bags/dice each iter     │
                 │   • descend by PUCT(prior P, value Q, visits)  │
                 │   • expand one node via engine (legal only)    │
                 │   • LEAF EVAL = learned Value net  V(obs)      │   (replaces heuristic rollout)
                 │   • within-round micro-moves = Policy net      │   (replaces heuristic execution)
                 └─────────────────────────────────────────────┘
                                      │ self-play
                                      ▼
        records (obs, cands, π=visit dist, seat) ; label ret = game OUTCOME
                                      │ train (Python)
                                      ▼
   policy loss = CE(policy_logits, π)        value loss = MSE(V(obs), outcome)
                                      │ export JSON weights (format unchanged)
                                      ▼
                   stronger net → next self-play iteration (bootstraps)
```

### Components

1. **Search — ISMCTS over the strategy skeleton** (`src/lib/play/ml/planner.ts`, new).
   Start with the navigation decision (where to lock each round) — that *is* the multi-round
   plan. Each iteration: clone state, sample a determinization (engine RNG reseeds bag/dice),
   descend the tree by **PUCT** `Q(s,a) + c·P(s,a)·√ΣN / (1+N(s,a))`, expand one legal child,
   evaluate the leaf, backprop. Every move trial-applied through the real engine → only ever
   legal. Reuses the existing `advanceAfterNav` determinize-and-advance pattern.

2. **Leaf evaluation — learned Value net.** Replace `ismctsSimValue`'s heuristic rollout with
   `NeuralPolicy.value(encodeObs(state, seat))`. The value head learns foresight (rates "3
   Cultivators held / dice can kill ladder-rung N / Abyss-farm tempo" as winning). Optional
   bootstrap: blend a short policy-net rollout early, anneal to pure value. No heuristic at
   convergence.

3. **Action priors — learned Policy net.** PUCT prior `P(s,a)` = policy-net softmax over the
   legal candidates (`scoreCandidates` → softmax). Focuses search on plausible moves.

4. **Within-round micro-execution — Policy net** (not the heuristic). Inside a determinized
   rollout/advance, non-searched decisions (rows, summons, awakens, the fight + reward claim)
   are taken by the policy net greedily. This makes the agent fully ML; the heuristic is only
   an optional bootstrap rollout for the very first iteration.

5. **Self-play training** (`driver.ts` new mode + `train.py` alphazero mode).
   - Generate: play games where the searched decision is chosen by ISMCTS; **sample** the move
     from the visit distribution π (temperature τ, annealed) for exploration.
   - Record `{obs, cands, chosen, pi, seat}`; at game end set `ret` = **outcome** from that
     seat's view (win = 1 / loss = 0, or normalized final VP/30 — configurable; default blends
     win primary + VP density).
   - Train: **policy loss = cross-entropy to π** (the search-improved target — this is the
     policy-improvement operator that bootstraps past the heuristic), **value loss = MSE to
     outcome**. AWR path kept as a fallback when `pi` is absent (old data).
   - Export JSON in the existing `arc-cand-scorer-v1` format → `net.ts` loads unchanged.
   - Iterate: stronger net → better search → better targets → stronger net.

### Why this produces the monster line

The value net is trained on **real outcomes**, so Abyss-farm positions (rising VP, climbing
ladder index, survivable barrier) get high value; ISMCTS then confirms by lookahead that
navigating to the Abyss and fighting every round out-scores corruption. The Cultivator
breakpoint becomes reachable because search explores the multi-step assembly and the value net
credits the held-but-not-yet-paid-off Cultivators. No hard-coded `initiatePvp` crutch — the
search finds whatever line actually wins.

## Build order (tasks #29–#33)

1. ✅ Design (this doc).
2. `planner.ts` — PUCT-ISMCTS with pluggable leaf eval (value net) + policy prior. Unit-test vs
   the engine; sanity-check it raises Abyss-fight frequency + VP vs the 1-step net.
3. `driver.ts` self-play mode emitting `pi` + outcome `ret`.
4. `train.py` alphazero mode (π cross-entropy + outcome value), export unchanged.
5. Iteration loop on the A100 (GPUs 0–3 only; 4–7 = CARLA): gen → train → export → eval vs the
   corruption champion + heuristic field. Definitive-best gate: ML bot wins the multiplayer
   arena AND its VP is monster/economy-sourced (status low), not corruption-only.

## Open knobs (tuned during training)
- Search budget (iterations × horizon) vs wall-clock; PUCT `c`; τ anneal schedule.
- Value target: pure win/loss vs VP-normalized vs blend.
- Search scope: navigation-only first; extend to in-round combat/reward decisions if needed.
- Net size: start small (the ladder showed ~2K params solved one strategy; planning may want
  more value-head capacity). Re-sweep once search is in.
