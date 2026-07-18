# Arc Spirits V22 Late-Game Macro-Tail Experiment

## Decision and objective

V21 conservative self-imitation is rejected: on 2,048 paired held-out solo games it changed the
round-30 win rate by +0.244 percentage points (95% paired bootstrap CI -2.002 to +2.539,
McNemar p=0.867) and mean VP by +0.188 (CI -0.157 to +0.532). Continuation training and width 512
were also neutral or negative. The next smallest evidence-supported intervention is to make the
late-game state machine explicit to the existing 256x256 candidate scorer. This tests omitted
representation before recurrence, options, search, or a wider model.

The screen target remains a 70-80% true solo win rate by the production round-30 cap. No checkpoint
is production-eligible from solo results alone.

## Append-only observation contract

Append 11 public, acting-seat-only floats after the frozen 188-feature prefix, bump the encoder
contract from v1.3 to v1.4, and bump `OBS_DIM` from 188 to 199. Do not change action features.
Every value below is clamped to `[0, 1]` after its stated normalization.

1. `crossed15`: current VP >= 15.
2. `post15Progress`: clamp((VP - 15) / 15, 0, 1).
3. `recent3CompletedVpPerRound`: mean of up to three most recent completed-round gains, /5. The
   first snapshot's gain is measured from zero; with no completed rounds the value is zero.
4. `currentRoundVpGain`: max(0, current VP minus the last completed-round snapshot), /10; before
   the first completed round, max(0, current VP), /10.
5. `requiredVpPerRemainingRound`: max(0, 30 - VP) / max(1, 31 - currentRound), then /5.
6. `freeSpiritSlots`: max(0, 7 - spirit count) / 7.
7. `awakenedSpiritFraction`: face-up spirit count / 7.
8. `carryOverflow`: max(0, held material-slot count - 4) / 4.
9. `carryHeadroom`: max(0, 4 - held material-slot count) / 4.
10. `heldRuneCountOverflowAware`: held rune count / 8.
11. `heldRelicCountOverflowAware`: held relic count / 8.

Every input is already public to the acting player at decision time. `vpHistory` contains only
completed-round snapshots; the live VP total is current public state. No terminal result, random
future draw, hidden opponent state, or held-out label enters the encoder.

The preregistered novelty classification is:

- New temporal information: features 3 and 4. The 188-prefix has only the most recent completed
  round's gain and does not expose within-round gain.
- New unsaturated capacity information: features 10-11. The prefix exposes each held material type
  only after clipping at four, so it cannot distinguish same-type overflow magnitudes.
- Convenience transforms of existing public scalars: features 1, 2, and 5-9. These deliberately
  make thresholds and interactions easy for a shallow MLP, but a null result on these alone would
  not prove the underlying information was absent.

The audit dropped three proposed columns before launch: `fullTableau` duplicated zero free slots,
total held materials were already exposed without saturation at /10, and held augments were not a
reliable semantic category because ordinary unplaced/attached augments live outside material slots.

Add exact index/value tests for early, post-15, empty/full-tableau, and under/over-cap resource
fixtures. Preserve the old 188 values byte-for-byte.

## Fair causal isolation

1. Zero-expand the canonical first-seed V18 reach-30 checkpoint
   `ml/league_v18_p30_treatment025_s0/checkpoints/main-0-gen10.json` from obs 188 to 199 with
   `ml/expand_obs_dim.py`. Require the new dimension explicitly. Verify every policy/value/aux
   output is unchanged on the old 188 columns, the 11 new input columns are exactly zero, and
   nonzero random tail inputs therefore have no effect before training.
2. Both arms initialize from the same expanded checkpoint and collect the same generation-1
   trajectories.
3. Add a PPO-only `--obs-feature-cutoff` control. The loader always executes the cutoff operation;
   control uses 188 (zero columns 188..198 before every loss) and treatment uses 199 (zero an empty
   suffix). This masks the new features from policy, value, reach-30, and KL inputs in control while
   keeping dimensions, tensor shapes, minibatch RNG, row count, and optimizer count identical.
4. Assert control tail input weights remain exactly zero after training and treatment tail weights
   become nonzero. Record per-column treatment tail norms after every generation. Reject the
   experiment if generation-1 actor trajectories differ before the first update. Trajectory and
   minibatch identity is expected only through the first update; later policy divergence is the
   treatment effect.
5. Preregister paired configs with 1,024 solo games/generation, temperature 0.55, 120,000 PPO rows
   per epoch, four epochs, batch 256, reach-30 policy coefficient 0.25, no target-KL early stop,
   no continuation, no self-imitation, no promotion, and one shared seed base. Configs may differ
   only in readme, output root, and `--obs-feature-cutoff` value.

## Screen and continuation gates

Run S0 through generation 5, then evaluate both checkpoints greedily on 2,048 fresh paired seeds
with full per-game output. `post15 VP/round` is VP earned after first reaching 15 divided by the
number of remaining played rounds. `15-to-30 conversion` is P(reach 30 by the round-30 cap |
reached 15 at any time) on that same paired game set.

- Continue to two additional matched seed pairs only if treatment improves true wins by at least
  4 percentage points with the 95% paired CI lower bound above +1 point, improves mean VP and
  post-15 VP/round, and has zero stalls.
- Reject immediately if the gain is below 2 points, the interval crosses zero, mean VP regresses,
  or stalls increase.
- A borderline +2 to +4 point result whose interval stays above zero but misses the continuation
  gate receives exactly one additional 2,048-game paired evaluation. Pool the two preregistered
  samples; continue only if the pooled estimate clears the original continuation gate, otherwise
  reject. Do not tune the feature set between samples.
- If the point estimate and interval clear the continuation gate but treatment tail-column norms
  are still monotonically increasing at generation 5, extend S0 unchanged to generation 8 before
  the two additional seed pairs. Tail growth alone cannot rescue a result that misses the gate.
- A generation-10 candidate must improve true wins by at least 8 points with CI lower bound above
  +5, improve mean VP by at least 1, and improve 15-to-30 conversion before broader training.

The two additional matched pairs, if admitted, each train independently through generation 10;
S0 also continues through generation 10. If V22 passes, run inference-time single-column ablations
on the same held-out seeds (zero one new column at a time) to diagnose attribution. These ablations
are explanatory only and cannot replace the treatment-vs-control gate.

If V22 fails, do not sweep dozens of similar scalar tails. The next escalation is a learned
round-level option head (`build`, `convert`, `stabilize`, `hunt`) or recurrent memory, using V22's
diagnostics to define labels. Model width/search remains deferred because width 512 and current
search already failed controlled tests.

## Promotion boundary

Even a 70-80% solo checkpoint is only a curriculum candidate. Production promotion additionally
requires fresh two-, three-, and four-player fields; frozen champion, heuristic, and exploiter
gauntlets; guardian and seat fairness; zero stalls; late-game conversion improvements; and live
human games. Keep the current production bot until all gates pass.
