/**
 * AlphaZero self-play recorder. Plays games where each "planner" seat chooses its NAVIGATION
 * (the multi-round strategy skeleton) with the neural ISMCTS planner, and records the search-improved
 * visit distribution `pi` as the policy target + the game OUTCOME as the value target. Within-round
 * micro-execution is delegated to a heuristic profile (a training teacher during bootstrap) — the
 * planning decision is where search adds signal the 1-step net can't produce.
 *
 * Output samples feed ml/train.py's alphazero mode:
 *   policy loss = cross-entropy(net softmax over cands, pi)   value loss = MSE(value(obs), ret)
 *
 * Split into focused modules; this file is a re-export barrel so importers keep compiling:
 *   ./selfplay/gates    — archived hand-crafted strategy gates/oracles (benchmark opponents ONLY)
 *   ./selfplay/recorder — sample/planner-stat/trace accumulation + trace types
 *   ./selfplay/loop     — playPlannerSelfPlayGame + options/result types + action filtering
 */

export * from './selfplay/gates';
export * from './selfplay/recorder';
export * from './selfplay/loop';
