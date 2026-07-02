# Arc Spirits Best-Bot Strategy Handoff

You are investigating the best possible bot strategy for Arc Spirits. Your job is
to read the included repo slice, understand the actual rules, and produce a
serious plan for discovering or creating the strongest possible bot/meta strategy.

## Repository

- GitHub: https://github.com/michaelvu1207/arc-spirit-spectate
- Local source path: `/Users/maikyon/Documents/Programming/ArcSpiritsPlan2/arc-spirits-spectate`
- Remote GPU workspace: `ubuntu@216.151.21.122:/data/share8/michaelvuaprilexperimentation/arc-bot`

Treat the GitHub/game repo as source of truth. Treat the GPU workspace as a synced
training checkout, not a second source of truth.

## Read First

- `AGENTS.md`
- `docs/bot-development-architecture.md`
- `docs/bot-testing-criteria.md`
- `ml/README.md`
- `ml/META_DISCOVERY.md`
- `ml/PLANNING_ARCHITECTURE.md`
- `docs/bot-ladder-research.md`
- `docs/balance-review.md`
- `docs/balancing-goals.md`

## Core Rule Files

- `src/lib/play/runtime.ts`
- `src/lib/play/phases.ts`
- `src/lib/play/types.ts`
- `src/lib/play/locationInteractions.ts`
- `src/lib/play/monsterRewards.ts`
- `src/lib/play/effects/`

The rule principle is: the engine owns the rules. Bots receive a versioned
observation plus legal actions and return one legal action id.

## Bot / ML Files

- `src/lib/play/bots/contract.ts`
- `src/lib/play/ml/actions.ts`
- `src/lib/play/ml/encode.ts`
- `src/lib/play/ml/driver.ts`
- `src/lib/play/ml/selfplay.ts`
- `src/lib/play/ml/planner.ts`
- `src/lib/play/ml/neuralBot.ts`
- `src/lib/play/ml/net.ts`
- `src/lib/play/ml/nodeIo.ts`
- `ml/model.py`
- `ml/train.py`
- `ml/discover_meta.sh`

Current bot contract: `arc-bot-v1`.

Live bot profile target: `neural`.

Heuristic bots should not be the final product strategy, but they should remain
as sparring partners, teachers, fixtures, and regression tests.

## Important Current Diagnosis

The current bot system is not yet training in the best possible way. It is closer
to a hybrid bootstrap:

- heuristic/self-play data
- AlphaZero-ish planner targets
- one-step candidate scoring
- value head
- local diagnostics/oracles/curriculum experiments

This is useful, but not sufficient to discover the best Arc Spirits strategies.

The desired direction is layered:

1. Rule-perfect simulator
2. Search/planning with MCTS/ISMCTS or AlphaZero-style search
3. Self-play reinforcement learning
4. Curriculum states
5. League training with historical checkpoints
6. Population/evolution sweeps over hyperparameters and curriculum mixes
7. Dashboard meta evaluation

Target stack:

```text
AlphaZero-style self-play
+ auxiliary farm-value head
+ explicit reward-pick policy head
+ league opponents
+ curriculum states
+ evolutionary sweeps over training/search parameters
+ dashboard evaluation
```

## Game Strategy Notes To Verify In Code

Arcane Abyss / monster farming is a key suspected strategy.

- Players can navigate to `Arcane Abyss`.
- Monsters have reward tracks.
- Killing a monster does not grant VP immediately.
- `startCombat` can create `pendingReward`.
- The player/bot must call `resolveMonsterReward`.
- The reward is a choice from the monster reward track, up to `chooseAmount`.
- Reward tracks can contain VP, runes, relic choices, summons, barrier restore,
  and other effects.
- In a 4-player game, monster rungs generally have multiple lives, one per active
  seat, so low-rung monsters can be farmed multiple times before the ladder advances.
- The monster hits first, so blind Abyss fighting can corrupt the player or stall
  unless the bot has barrier, mitigation, enough damage, or intentionally accepts
  corruption.

The current learned bots often lean into corruption/Fallen/PvP pressure. They can
beat some heuristic fields, but clean monster/economy play is not solved.

## Your Output

Produce a strategic plan for finding the strongest possible bot and strategy
landscape. Include:

- the true objective function and promotion criteria;
- the likely strongest known strategy families;
- simulator/rules gaps that could invalidate training;
- the recommended training architecture;
- the first experiments to run;
- dashboard metrics needed for balance analysis;
- concrete success criteria;
- risks and unknowns;
- the first 3-5 implementation steps.

The end goal is a bot-development system where game-rule changes can be evaluated
by running meta simulations and comparing the resulting strategy landscape.
