# V32 frozen development and hidden-evaluation procedure

Status: Claude Fable high-effort review incorporated; implementation/tests must
still be frozen before development opens. Review artifact:
`evaluation-fable-review.md`. This file does not open development or hidden seeds.

This procedure implements phase 4, phase 5.1, and the phase-6 gate list from
`plan.md` without changing the frozen screen. Generation 8 is eligible only if
the single outcome-blind manipulation audit passes every movement check for both
treatments. If either treatment is underdosed, every arm and replicate continues
unchanged and generation 12 becomes the sole endpoint for both treatments. The
medoid selection then runs on generation 12, not generation 8. Performance
outcomes may not influence this global choice.

## Endpoint freeze

Before seed 949,000,000 is consumed, create one fail-closed endpoint manifest.
It must verify the screen lock, protocol and catalog hashes; the chosen
manipulation audit; all nine exact endpoint checkpoints/manifests; every
generation audit through the endpoint; one history row per generation; zero
training/evaluation stalls; and all audit trust/calibration gates. The manifest
records every hash, the evaluator/analyzer/launcher hashes, and the development
decode contract. It is immutable and may be created only once.

An integrity, trust, calibration, seed, or audit failure in any root invalidates
the entire paired V32 screen; an unaffected arm is not salvaged post hoc. Only a
single documented environment-only retry allowed by the frozen screen protocol
may preserve a root, and its evidence must prove unchanged checkpoint/seed
lineage and no reuse of partial data.

The three replicates estimate each mechanism's causal effect. They are not
three development candidates. To turn a passing mechanism into exactly one
checkpoint without outcome-driven replicate selection, preselect one policy
medoid per treatment family before opening development. On every exact-policy
row in the frozen critic-validation seeds 946,004,096-946,005,119, evaluate each replicate's
tempered policy on the row's exact legal support. For replicas `r,q`, compute
`0.5 * (KL(p_r || p_q) + KL(p_q || p_r))`; average rows within game, then games
equally. Each replicate's medoid score is its mean distance to the other two.
Select the minimum score with deterministic `a,b,c` tie-breaking and freeze the
control checkpoint from that same replicate. Run deterministically on CPU with
one thread, convert logits to float64 before probabilities/KL, and fail on
nonfinite values, support/coverage mismatch, or a hash mismatch. Freeze a hash
inventory of the validation corpus with the result.

This selector may inspect only states, exact legal supports and policy logits;
it may not inspect rewards, wins, VP, targets, guardians, quick evaluations, or
development outcomes. Development may select a mechanism but may never select
A/B/C within that mechanism. If the aggregate mechanism passes but its already
frozen medoid representative does not independently clear the deployability
point-estimate gates, the mechanism is informative but has no eligible single
checkpoint.

The medoid states come from the V30-distribution validation corpus and may not
perfectly represent each final policy's on-policy state distribution. This is an
accepted trade-off: it provides an outcome-blind centrality rule and is not a
strength claim, ensemble, parameter average, or development-selected replica.

## Development block

Evaluate V23, V30, the shared-critic checkpoint, and all nine frozen endpoints
on exactly seeds 949,000,000-949,004,095. All reports use the live frozen catalog,
one player, round 30, max status level 2, balanced guardians, hybrid sampling at
temperature 0.55, per-game telemetry, and production binary inference for v2.
Use the frozen 24-worker setting for every policy and waves of at most four
policies so actor load never exceeds 96 threads; GPU 4 remains excluded. No
report may contain a stall, a missing/duplicate seed, a different guardian
assignment, a checkpoint-hash mismatch, or a decode/source mismatch.

For each treatment family, compute treatment-minus-control within replicate and
seed, then average A/B/C with equal replicate weight. Bootstrap complete seed
clusters so the shared game/guardian randomness and all three replicate pairs
stay together. Use a deterministic percentile bootstrap with 10,000 draws and
RNG seed 320949. Use 97.5% two-sided intervals (Bonferroni family size two) in
two explicitly separate families: the two treatment-versus-control contrasts
and the two treatment-versus-V23 contrasts. These intervals are conditional on
the nine realized training roots; the two-of-three replicate gate provides the
pre-registered guard against a single training seed driving the result.

A mechanism passes only if all frozen gates in `plan.md` pass: mean causal win
gain at least 3 points; simultaneous lower bound above zero; at least two
positive replicate effects and none below -1 point; mean win gain versus V23 at
least 3 points with a positive simultaneous lower bound; nonnegative final-VP
and post-round-15 VP/round point effects against both matched controls and V23;
nonpositive censored-finish-round point effects against both; no guardian point
effect below -5 points against either after the pre-registered confirmation rule
below; zero stalls; and all endpoint integrity, calibration, trust and
manipulation gates. V30 and shared critic comparisons are descriptive and never
substitute for the causal control.

The preselected medoid representative must also have causal and V23 win point
gains of at least 3 points, the same late-game and guardian point gates, and zero
stalls. This representative check does not add a new confidence test; the
simultaneous inferential decision remains at mechanism level. Form the eligible
set from mechanisms for which both the aggregate and the already-frozen
representative pass. If both are eligible, select the higher equal-replicate mean
raw treatment win rate across the three endpoint reports; a difference below one
point is a tie and selects `round-reweighted`. The selection metric is aggregate,
never the representative's raw win rate.
If only one is eligible, select it even if the other has the higher aggregate
point estimate. Freeze exactly the resulting representative checkpoint and its
same-replicate matched control. If nothing is eligible, do not open hidden seeds.

The single-replicate and repeated 3-point thresholds reduce power when the true
effect is near the boundary. That conservative false-negative risk is accepted;
thresholds may not be relaxed after outcomes are visible.

The evaluator must mechanically refuse any 949M seed without a hash-valid
endpoint/evaluation manifest. Before consuming strength seeds, run unit tests of
report validation, seed-cluster aggregation, bootstrap bounds, all gates and the
tie rule, plus a 256-game end-to-end diagnostic on seeds
951,920,000-951,920,255. That diagnostic is systems-only and cannot inform
strength or selection. It runs V30 only.

The guardian point gate is noisy with ten guardians (about 409 games/guardian):
on the prior V31 block, null-like paired discordance implies roughly a 9%-30%
chance that at least one guardian crosses -5 points per comparator. Therefore a
guardian point effect below -5 points is an explicit follow-up trigger, not an
immediate waiver or rejection. If any aggregate or representative guardian is
flagged, evaluate all twelve frozen policies once on exactly 8,192 fresh seeds
949,100,000-949,108,191 with the unchanged contract. Pool only the corresponding
guardian deltas from the original and confirmation blocks; confirmation outcomes
cannot alter any other gate or mechanism selection metric. The guardian gate
passes only if every pooled point effect is at least -5 points. No second
follow-up is allowed; a remaining regression rejects that mechanism.

## Latency and hidden confirmation

Before development, run a non-binding smoke test of the same serving path on the
shared-critic checkpoint. Before hidden evaluation, run the binding frozen V30
binary-wire protocol on the sole representative: 32 rows/request, 30
candidates/row, eight clients, 20 warm-up requests/client and 200 measured
requests/client (1,600 total). P95 must be at most 100 ms, with zero protocol or
response errors. A binding latency failure rejects the candidate and does not
authorize a second development winner.

Only then create an immutable hidden-input manifest containing the selected
checkpoint/control hashes, development-decision hash, latency-pass hash, hidden
analyzer hash/gate constants, and decode/source contract. The hidden launcher mechanically refuses any 950M seed
unless that manifest verifies. Evaluate the sole representative, its already
frozen matched control and V23 on seeds 950,000,000-950,004,095 with the
identical game/decode contract. Require candidate-minus-control and
candidate-minus-V23 win gains of at least 3 points, positive paired 97.5% lower
bounds in one frozen family of two comparisons, zero stalls, nonnegative final
VP and post-round-15 VP/round point effects, nonpositive censored-finish-round
point effects, and no guardian point effect below -5 points after the same single
confirmation rule. Hidden uses a percentile paired seed-cluster bootstrap with
10,000 draws, RNG seed 320950, and one family of two comparisons (97.5%
two-sided intervals, providing 95% familywise coverage). If a guardian is
flagged, evaluate all three hidden policies once on seeds
950,100,000-950,108,191 and apply only the pooled guardian gate. Hidden failure
rejects V32; it does not reopen development selection.

For development and hidden evaluation, one infrastructure-attributed failure
before a valid report exists permits exactly one identical-seed rerun of the
affected report. Quarantine partial files and freeze exit codes/logs/hashes
before inspecting per-game outcomes or deciding to rerun. A game stall, valid
weak result, hash/integrity mismatch, or second infrastructure failure is not
rerunnable and fails closed.

Solo evidence never promotes a bot. A hidden-qualified checkpoint must still
pass the fixed two/three/four-player champion/exploiter/heuristic gauntlets,
exploitability and Fallen/corruption recovery suites, hidden-information and
future-public-information audits, rules/catalog/replay regression, zero-stall
soak, production load/latency, disjoint Michael replay comparisons, and balanced
live human matches before deployment.
