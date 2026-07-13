# V24 Solo Terminal Reward Teacher

## Decision and evidence

V23 persistent round options are rejected. On 4,096 paired held-out solo seeds, the option
treatment scored 58.52% versus 58.74% for its compute-matched control (delta -0.22 percentage
points, paired 95% CI -1.59 to +1.20). Treatment also reduced reach-15 by 1.66 points and post-15
scoring pace by 0.033 VP/round. The strongest current solo checkpoint is therefore V23 control
generation 5: 58.74% on the independent 4,096-game block, with zero stalls. The game engine ends
at round 30, so the user's “within 35 rounds” target is operationally the same as within 30.

The next experiment targets a concrete policy bottleneck rather than adding capacity or another
latent objective. `hybridIndex` currently takes the largest immediate VP gain before consulting the
policy. In V23 control generation 5, all 4,894 ambiguous `resolveMonsterReward` choices were
therefore deterministic `policyMask=0` overrides across 1,024 games (4.78 per game); 3,174 occurred
in rounds 1–10. PPO cannot learn
whether to take early VP or a summon/rune/engine reward, and inference would ignore the learned
answer even if it could. The current action encoding compounds this by representing reward picks
mostly as track indices rather than their public semantic effects.

V24 first measures the attainable ceiling, then—only if the ceiling is real—trains the smallest
causal fix. The initial target remains 70–80% true solo wins by the real round-30 cap. Nothing from
this solo lane is production-promotable without the multiplayer, fairness, exploitability, and
human gates already specified in the V16 plan.

## 1. Make monster-reward choices learnable without changing the rules

Add an explicit hybrid-selection mode whose default preserves every historical checkpoint:

- always take an action that immediately reaches the 30-VP win condition;
- for an ambiguous decision containing only `resolveMonsterReward` candidates, do **not** force
  the largest immediate VP reward when the new mode is enabled; route the full legal support to
  `policyIndexWithProgressGuard` and record exact sampled behavior probabilities;
- retain the existing immediate-VP safeguard for all other decision families in this experiment;
- forced one-candidate rewards remain deterministic and unrecorded, as before.

Strip V23 control's unused option heads and the four exactly-zero low-level option columns first;
the resulting non-option checkpoint must have exactly the same logits, values, reach-30 predictions,
and greedy games. Append public reward-effect features to the action vector while preserving all 84 existing values
as an exact prefix. Encode the selected rewards' total VP, Spirit World summon count, Abyss summon
count, Cultivate, Rest, barrier restore, fixed origin rune, class augment, relic, wildcard-rune and
wildcard-relic counts, plus the chosen rune/relic type when a public choice resolves a wildcard.
Do not encode dry-run draw identities, bag order, future rolls, or any realized stochastic result.
Scale count features by their rules-defined maxima. Zero-expand every first-layer weight on the new
action suffix, then prove exact logits/value/reach-30 parity on the old prefix before training.

## 2. Reward-choice terminal counterfactual ceiling audit

Collect an immutable set of at most 4,096 naturally reached ambiguous monster-reward states from
frozen V23-control-gen5 solo games. Balance the reservoir across guardians, source wins/failures,
round bands 1–10/11–20/21–30, and current VP bands. Record the acting seat's fair observation,
fair candidate vectors, canonical command signatures, source checkpoint/catalog hashes, and a
replayable reducer snapshot. Source outcome is sampling metadata only and never an input feature.

For each state and every legal reward command:

1. Clone the original pre-action state.
2. Replace the future environment RNG with a seed derived only from `(stateId, rolloutIndex)`.
3. Re-shuffle every still-hidden bag order with that synthetic RNG while preserving the public bag
   multiset. The audit is solo-only, so no opponent secret-navigation field exists; the sanitizer
   nevertheless fails closed if it sees another seat. This prevents the
   server's real future bag order or RNG cursor from becoming a teacher advantage.
4. Reapply the root command through the reducer. Never descend from `LegalAction.next`, because a
   summon candidate there has already consumed the real hidden draw.
5. Continue to the true round-30 terminal cap with the frozen greedy policy and the same common
   random-number determinization for every candidate.

Use eight rollout determinizations per candidate for discovery. Rank actions lexicographically by
terminal reach-30 count, then mean final VP, post-15 VP/round, and earlier first-30 round. Label only
states where the best action beats the runner-up by at least two of eight wins or by a preregistered
paired utility margin. For every evaluated candidate, set
`q=(reach30Wins+0.5)/(rollouts+1)` and `terminalPi=softmax(q/0.10)` over the evaluated mask; the VP
and tempo tie-breaks decide only exact equal-win cases. The student CE is renormalized over the same
mask. Store that normalized `terminalPi` over only evaluated legal candidates;
unevaluated/truncated candidates are masked, never treated as losses.

Before any PPO run, regenerate a disjoint 512-state audit with 16 discovery determinizations and
evaluate both the teacher action and the historical immediate-VP action on another 16 independent
determinizations. Proceed only if all are true:

- the teacher improves paired terminal win probability by at least 8 percentage points and the
  95% confidence-interval lower bound is at least +4 points;
- mean final VP and post-15 scoring pace do not regress;
- top-action agreement between the 8- and 16-rollout estimates is at least 70%;
- candidate reordering leaves every label and rollout seed unchanged;
- no snapshot, command, or encoded feature exposes hidden bag order, realized draws, future rolls,
  or another player's private information.

The one-step audit can understate gains that compound over several reward choices. Therefore the
actual go/no-go gate is a 512-game fresh paired teacher-in-the-loop evaluation: one arm runs the
frozen policy and historical immediate-VP override; the other invokes the independently seeded
teacher at **every** ambiguous monster-reward choice in the same game. Proceed to PPO only if this
full-game intervention improves true wins by at least 8 points with paired CI lower bound above +4,
does not regress VP/post-15 pace, and has zero stalls. If it fails, the next audit is terminal
branching over navigation and meaningful yield-versus-act decisions; do not spend a five-generation
PPO screen on an intervention without a game-level ceiling.

## 3. Compute-matched training screen

Both arms start from the same function-preserving expanded checkpoint and enable learnable
monster-reward selection. They retain V23 control's non-option low-level policy, width 256, value
width 128, reach-30 coefficient 0.25, flat win bonus, KL anchor, temperature 0.55, four epochs, and
120,000 PPO rows per epoch. Width 512, continuation replay, self-imitation, scalar macro features,
and latent options have already failed controlled screens and are not reopened here.

- Control: ordinary on-policy PPO, terminal-teacher coefficient 0.
- Treatment: identical PPO plus coefficient 0.10 cross-entropy to the fixed `terminalPi` dataset.
- Both arms load the same teacher batches, perform the same teacher forward passes, use the same
  row order and minibatch count, and take the same optimizer-step budget. Only the scalar loss
  coefficient differs.
- Teacher rows affect only the existing policy trunk. They do not train the value or reach-30 head
  and do not enter GAE.
- Generation-1 source trajectories and pre-update behavior fields must match exactly across arms.
- Coefficient zero must be numerically identical to the ordinary PPO loss/update.

Before generation 1, evaluate the expanded checkpoint with learnable reward selection enabled on
the fixed development block. The old policy never trained on this support, so this generation-0
measurement is mandatory. If it regresses more than 2 points versus the historical override, give
**both** arms the same short behavior-cloning warm-start on historical VP choices, stop at the first
checkpoint within 1 point of the incumbent, and only then begin the paired experiment. Record the
warm-start as a shared initialization, not a V24 treatment effect.

Run five generations of 1,024 solo games per arm. Evaluate every checkpoint on one fixed,
preregistered 1,024-game development block and select each arm's checkpoint by Wilson lower bound
on reach-30, then mean VP, post-15 pace, and earliest generation. Touch the final 4,096 paired seeds
only once after selection.

Continue only if treatment beats control by at least 5 points with the paired 95% interval lower
bound above +2 points, improves mean VP by at least 0.5, improves post-15 pace by at least 0.05,
improves 15-to-30 conversion by at least 3 points, and adds zero stalls. Also report early reward
choices by semantic effect so a win-rate change can be tied to actual engine-building behavior.
Report teacher agreement on the fixed dataset at every generation. Keep the dataset and coefficient
fixed during the five-generation causal screen; if V24 passes and student agreement or on-policy
coverage later falls, refresh labels under the selected student in a separate, versioned extension
rather than silently changing this experiment.

## 4. Follow-on ablation if V24 passes

The current `engine-cycle` classifier marks about 97.7% of V23 rows strategic, so full-episode
Monte Carlo has effectively replaced GAE almost everywhere and strategic value error is roughly an
order of magnitude larger than tactical value error. Do not change this during V24. If the reward
teacher passes, run a separate matched V25 ablation that narrows full-episode credit to navigation,
ambiguous reward/build conversion, combat commitment, and meaningful yield-versus-act states,
restoring ordinary GAE for micro-resolution rows. Keeping this separate preserves causal evidence
for both changes.

## Artifact and safety contract

All source, teacher, development, PPO actor, and final-heldout seed blocks are disjoint and recorded
with source commit, checkpoint SHA-256, catalog SHA-256, configuration, wall time, and rollout
counts. Teacher labels may use future simulated outcomes during offline training, exactly like a
terminal return; inference receives only current public state and public catalog facts. Never
promote the rollout teacher or any checkpoint that fails hidden-seed invariance, exact behavior
ratio validation, multiplayer gauntlets, a fresh exploiter, and Michael's live-play gate.
