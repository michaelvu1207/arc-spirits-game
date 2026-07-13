# Arc Spirits V23 Persistent Round-Option Experiment

## Decision and objective

V22's explicit late-game feature tail is rejected. On 2,048 paired held-out solo games, the
treatment reached 30 VP in 56.15% versus 57.42% for the masked control (delta -1.27 percentage
points, 95% paired CI -3.27 to +0.68); mean VP and post-15 scoring pace also regressed. A fresh
16-simulation search screen on the V22 control reached only 37.5% on 64 matched seeds and reduced
post-15 pace from 1.129 to 0.836 VP/round. Existing scripted profiles have no valid round-30
teacher. Width, continuation replay, successful-episode imitation, scalar feature tails, and the
current navigation/encounter-only search are therefore not the next experiment.

V23 tests whether one strategy choice persisted through a complete round lets the low-level policy
learn coherent build/convert sequences. The production gate remains a true solo win (30 VP, no
stall) by round 30. The user's relaxed round-35 target is reported as a secondary diagnostic; it
cannot make a checkpoint production-eligible or contaminate the round-30 training/evaluation label.

## Model and checkpoint contract

Add `option_dim=4` to the v1 checkpoint contract without changing the public 199-float encoder or
the 84-float action encoder.

- `option`: an independent `199 -> H -> 4` categorical head.
- `option_value`: an independent `199 -> H -> 1` round-start baseline.
- Low-level policy trunk input: `obs199 + action84 + option4`.
- Low-level state-only heads used by PPO: `obs199 + option4`.
- Auxiliary heads with coefficient zero remain shape-compatible but cannot advertise an untrained
  capability.

`H` is the incumbent checkpoint's value-hidden width (128 for V22 control generation 5). Reusing
that width permits an exact numeric clone for `option_value`; it is not a new width comparison.

The four options are intentionally anonymous (`0..3`). They do not alter legality, mask actions,
add shaped rewards, or receive hand-authored semantic labels. In one-player training, option 3 is
masked at selection time and in the PPO support so that a later multiplayer-only contest/hunt mode
cannot consume solo exploration. Options 0..2 remain exchangeable and must earn any specialization
from outcomes. Reports may assign descriptive names only after measuring their learned action and
round-band distributions.

Create a deterministic expansion tool for the V22 control generation-5 checkpoint:

1. Set `option_dim=4` and append exactly four zero input columns to every option-conditioned
   low-level head.
2. Initialize the option head with zero final logits (uniform supported distribution).
3. Clone the existing value head's compatible 199-input weights into `option_value`.
4. Verify old outputs are unchanged for random base observations/actions under an all-zero option
   vector, and verify every appended low-level option column is exactly zero.

Legacy checkpoints have `option_dim=0` and retain bit-identical inference. The TypeScript loader and
Python loader/exporter validate the extended shapes and fail closed on malformed option metadata.
V23 actors are preregistered as in-process only: the old batched inference wire has no persistent
round-option field and must explicitly reject `option_dim>0` checkpoints until that protocol is
extended and separately parity-tested.

## Acting and persistence contract

For each policy-controlled seat, sample one supported option immediately before its first policy
decision of each round (normally navigation, including a forced single-candidate navigation). Use a
dedicated deterministic RNG stream derived from the game
seed and seat; it must not consume or perturb the engine RNG or low-level action-sampling RNG.
Persist the sampled option across navigation, location, encounter, benefits, awakening, and cleanup,
including forced transitions and corruption resolution. Clear it only when the public round
increments, the episode ends, or the seat disappears. Opponent policies and multiple seats require
independent option state.

Training samples supported options at temperature 1.0. Greedy evaluation takes the maximum
supported option logit. This temperature is independent of the low-level action temperature.

Every low-level row records the integer `optionId`. A separate `options-*.jsonl` stream records
exactly one high-level event at that first policy decision, even when the low-level candidate set has
only one action:

- base round-start observation and public round;
- chosen option and exact supported behavior log-probability/mask;
- behavior `option_value` prediction;
- a stable `(gameId, seat, round)` identity;
- the exact count of governed serialized low-level decisions (including explicit zero-count
  forced-only rounds).

An active round in which the seat never needs to act has no option and no duration; it is excluded
from the option episode. Every round in which the policy-controlled seat does need to act must have
exactly one event. Validation rejects duplicate, count-mismatched, missing, out-of-order,
unsupported, or within-round-mismatched option data rather than silently splicing it. The local
actor stream is a trusted training artifact, not an adversarial interchange format: a correctly
shaped fabricated zero-decision event cannot be independently replay-certified without replaying
the game engine. Capped/stalled games remain truncated and bootstrap the last option value.

Live production integration stays disabled for V23. The live bot must not gain private mutable
option state until a checkpoint passes every solo, multiplayer, fairness, exploitability, and human
gate.

## SMDP option PPO

Train the low-level policy/value losses exactly as V22, except that the selected option one-hot is
provided as a separate tensor. Build a separate option-event buffer from validated complete seat
episodes. For event `k`, aggregate the existing low-level `rStep` rewards from its round until the
next option event or terminal row. Let duration be the number of low-level transitions in that
interval. Its SMDP reward is `R_k = sum(i=0..duration-1, gamma**i * r[k,i])`; its temporal-difference
residual is `delta_k = R_k + gamma**duration * V(next) - V(k)` (with no terminal bootstrap), and its
GAE recursion is `A_k = delta_k + gamma**duration * 0.95 * A_(k+1)`. Apply the clipped option
policy ratio, option entropy, and option-value loss once per option event, never once per low-level
action. Terminal win/loss additions enter exactly once through the final interval. Use gamma 0.999,
clip epsilon 0.15, option entropy coefficient 0.02, option-value coefficient 0.5, a fixed 16,384
option-event rows per epoch, batch size 256, and four epochs. Deterministically sample with
replacement if a valid generation has fewer events, preserving the event's importance weight. Log option KL,
entropy, clip fraction, value error, counts, and support violations separately from low-level PPO.

Do not share parameters between the option heads and low-level trunk. Do not use the learned option
head as a target for itself, and do not add semantic auxiliary labels during this experiment.

## Compute-matched causal control

Both arms use the same option-capable expanded checkpoint, option samples, event losses, architecture,
RNG streams, game seeds, 1,024 games/generation, fixed 120,000 low-level rows/epoch, fixed option-event
rows/epoch, four epochs, batch sizes, optimizer steps, and V22 PPO objective. The only difference is
an explicit low-level option cutoff:

- Control: zero the option tensor before every low-level policy, value, KL-reference, auxiliary, and
  self-imitation input.
- Treatment: expose the sampled one-hot option to those same low-level inputs.

The option and option-value heads always consume only base obs199 and use an identical training
procedure in both arms (their later data and weights are not expected to remain equal). The mask
operation executes in both arms (the treatment zeros an empty suffix). Generation-1 actor decision
rows and game summaries must match exactly before training. After every update, all control
low-level option-column weights must remain exactly zero. Treatment columns 0..2 must become finite
and nonzero; masked solo option column 3 must remain exactly zero in both arms. The Adam optimizer
configuration must preserve exact zero weights in the absence of gradients. Optimizer parameter
ordering and checkpoint serialization must be identical across arms. Malformed-option episode
rejection counts are logged and must be zero in both arms; any nonzero or arm-imbalanced rejection
invalidates the comparison.

Tests cover checkpoint expansion parity, loader validation, independent RNG streams, solo option-3
masking, one event per round, forced-only rounds, corruption persistence, round clearing, multiple
seats, event rejection, SMDP reward/duration/terminal math, control masking, and TypeScript/PyTorch
forward parity for every head.

## Screen and gates

Run paired S0 control/treatment through generation 5. Evaluate greedy low-level actions and greedy
supported options on 4,096 fresh paired seeds at round 30, and report sampled-option decoding as a
secondary result. Separately replay the same checkpoints on a disjoint round-35 diagnostic set;
never pool the two horizons.

As a manipulation check, freeze 4,096 held-out decision states and evaluate each with options 0, 1,
and 2. Report mean pairwise Jensen-Shannon divergence and argmax-action disagreement among the three
conditioned low-level policies, overall and by round band. Mean pairwise JS >= 0.005 is the
preregistered evidence that options differentiated; a null game result below that threshold means
the mechanism never engaged, not that persistent strategies were disproved.

Continue V23 only if treatment over control has all of:

- true round-30 wins at least +5 percentage points with paired 95% CI lower bound above +2;
- no statistically supported regression in mean VP or post-15 VP/round;
- report reach-15 and reach-15-to-30 conversion with paired intervals as diagnostics;
- zero added stalls, zero persistence violations, and valid option ratios;
- non-collapsed option use: at least two solo-supported options each used in at least 10% of held-out
  rounds, reported by early/mid/late band and guardian.

Reject immediately for a statistically supported VP/post-15 regression, option collapse, or any
contract failure. A +2 to +5 point win result whose CI stays above zero gets exactly one
preregistered 4,096-game replication; pool only those two round-30 samples and apply the original
gate. If the win delta is 0 to +2 points with no supported performance regression but the
manipulation check passes, extend the already-running S0 pair once to generation 8 before the final
rejection decision. A negative point estimate or failed manipulation check receives no extension.

If V23 passes, extend S0 unchanged to generation 10 and run two additional matched seed pairs. The
solo curriculum target is at least 70% absolute true wins by round 30 (with 80% the next gate), plus
the user's round-35 diagnostic. Only after that run two-, three-, and four-player fields, frozen
champion/exploiter/heuristic gauntlets, guardian/seat fairness, zero-stall checks, and live human games.

If V23 fails, recurrence is admissible only after an observation-alias audit finds materially common
identical `(obs, candidates)` contexts whose best action differs because of omitted public history.
Do not reopen the current search until its critic is held-out calibrated and its horizon covers
build, awakening, and location sequences rather than only navigation and encounter roots.
