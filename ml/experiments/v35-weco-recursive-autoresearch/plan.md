# V35 Weco / AIDE Recursive Autoresearch Plan

Status: implementation authorized. The controller, proposal logic, candidate source, private metrics,
and research history remain local/private. No source or result is sent to Weco or another autoresearch
service. SimForge A100s may run trusted simulation, inference, and training under explicit GPU leases.

Date: 2026-07-14

## Decision

Arc Spirits is a strong fit for an AIDE-style autoresearch loop because it already
has a deterministic simulator, quantitative evaluation, modular bot components,
GPU capacity, replay/provenance tooling, and strict held-out promotion gates.

Adopt the approach, but do not give an optimizer unrestricted control of the bot
repository or let one scalar win-rate metric promote a bot. Create a separate V35
lane with:

1. a small mutable candidate surface;
2. an immutable evaluator and game engine;
3. public, private, and final hidden evaluation tiers;
4. equal cost budgets and paired seeds;
5. automatic rejection for correctness, fairness, latency, or provenance failures;
6. human-reviewed promotion through the existing Arc Spirits gates.

The immediate integration reproduces the useful AIDE/Weco architecture locally: a bounded lineage
controller, immutable evaluator, private selection tier, cost ledger, rejection memory, and an outer
loop that can improve the inner research policy. Weco's hosted CLI is deliberately disabled because
the user selected private/local source handling. Weco's new AIDE85 agent and the AIDE squared technical
report are not public, so the implementation must not depend on unavailable code.

## What We Are Borrowing

The useful ideas in Weco's AIDE squared report are broader than a particular product:

- An outer autoresearch loop improves an inner code-research agent.
- Every proposal is evaluated under a fixed token, compute, time, and query budget.
- Search preserves multiple lineages, exploits successful lineages, and forks new
  strategies after stagnation.
- Public feedback guides development while private tasks determine selection.
- Most proposals are expected to fail; rejection is a feature, not wasted evidence.
- Generalization is measured on both unseen in-distribution and far-out-of-
  distribution tasks.
- Concise research programs can outperform large prompt accretions by spending the
  saved budget on more experiments.
- Reward-hacking resistance must be tested explicitly.
- Generated research code can accumulate dead code and complexity, so maintainability
  is a gate rather than an afterthought.

Weco describes this as evidence for Level 1, net-positive recursive improvement,
not Level 2 self-sustaining ignition. That public article is an unverified external claim rather than
evidence this project relies on. Arc Spirits should nevertheless use the same conservative standard:
claim success only if an evolved researcher produces stronger held-out bots under
the same total budget as the human-designed researcher.

## Fit With the Current Arc Spirits Method

The current `ml/research/harness.py` is already the seed of an inner research agent:
it runs one configuration-defined experiment and exposes metrics for a human or
coding agent to inspect. V34 adds stronger scientific controls: locked source and
seeds, paired comparisons, bootstrap endpoints, guardian evaluation, replay and
fairness checks, width arms, late-game curricula, and multiplayer/exploiter/human
gates.

The gap is that hypothesis generation, experiment selection, and harness refinement
are still largely manual. The V35 loop should automate those steps without weakening
V34's measurement discipline.

The first target should be late-game planning and engine-building, not generic early
VP gain. The bot already performs reasonably early and then sacrifices compounding
strength. An optimizer given only total VP or average win rate is likely to rediscover
that short-term strategy.

## Safety Boundary

### Immutable control plane

The following remain outside the candidate worktree, mounted read-only for evaluation,
and hash-verified before and after every run:

- game rules, action legality, public-observation construction, and RNG;
- public/private/final seed ledgers and scenario definitions;
- evaluation and reward extraction code;
- fairness, hidden-information, replay, stall, and corruption-transition tests;
- resource accounting and timeout enforcement;
- baseline and champion checkpoints;
- promotion criteria and result-signing code;
- V34 artifacts, protocol, source lock, and in-progress recovery state.

Candidates get no network access during evaluation and cannot read private seed IDs,
raw private game histories, other candidates' private results, or final promotion
outcomes. Private/final seeds are derived in trusted memory from a sealed master secret owned by a
different OS identity and never enter candidate-visible caches. Private evaluations use a fixed schedule,
and GPU allocator state is cleared before the next tenant. Terminal feedback is filtered to prevent
accidental disclosure.

Candidate code never shares a process with the trusted engine or scorer. The trusted process owns the
game loop, legality checks, RNG, replay generation, timing, and signing. A sandboxed candidate action
service receives only public observations and legal candidate features over a narrow local socket and may
return only one legal action index; it cannot supply a replay or metric. macOS requires a deny-network
`sandbox-exec` profile. SimForge requires a rootless container or separate unprivileged user with no
access to trusted controller state, `/proc` peers, leases, seed vault, or signing keys. Missing isolation
fails closed.

### Mutable candidate plane

Start with one small declarative file, for example:

`ml/autoresearch/v35/candidate.json`

It may control bounded policy/search parameters such as planning width, horizon,
reranker feature weights, phase-aware value mixing, curriculum sampling, and loss
coefficients. A trusted adapter applies and validates the configuration.

After the configuration pilot succeeds, allow up to ten copied V35-only source files,
within locally enforced size/count limits, drawn from:

- critic reranking;
- heuristic rollout planning;
- late-game shaping and phase-aware value targets;
- curriculum and replay sampling;
- model/loss configuration;
- search allocation and stopping rules.

Do not initially expose the engine, evaluator, reward parser, observation contract,
or production bot. Every candidate runs in a fresh disposable worktree. The local controller modifies
candidate source in place, so the runner must never point it at the canonical checkout.

## Evaluation Design

### Three evaluation tiers

1. **Public/dev tier**: fast deterministic tests, a small disclosed seed set, and
   actionable failure feedback. Its strategic content is primarily round-15+ snapshot
   tasks, so the visible optimization pressure directly targets late-game planning.
2. **Private/selection tier**: undisclosed paired seeds and task mixes. Queried only
   by the trusted controller. Each campaign gets a distinct private seed family and
   at most one private query per surviving candidate at the final successive-halving
   rung, with no more than ten private queries per campaign in the provisional pilot.
3. **Final hidden/promotion tier**: never queried during autoresearch. Includes solo,
   multiplayer, exploiters, catalog perturbations, latency, replays, and human play.
   It is the only tier that can support promotion.

Split by seed families and task construction, not random rows from the same games.
Keep the final tier sealed across the whole campaign, then replace it after any
human inspection. A selected finalist receives exactly one confirmation evaluation
on a fresh seed family that was used by neither its campaign nor another finalist.
Only that confirmation result may count toward a Phase 2 gate. Correct the confidence
rule for selection over multiple lineages; do not treat within-campaign candidates or
campaigns sharing any seeds as independent evidence.

Private queries are mediated by an immutable broker with a hard cap of ten per campaign. The broker
returns only pass/fail plus permitted diagnostic codes to candidate/researcher sandboxes; the trusted
selection controller may consume the scalar internally but never raw endpoints. Private evaluations use
a fixed-duration envelope, and their artifacts are excluded from all cross-candidate caches.

### Task families

Each serious candidate must generalize across:

- solo games with the primary target of winning by round 35 and a stretch target of
  winning by round 30;
- strategic snapshots from early, middle, and late game, especially rounds 15+;
- engine-building states where immediate VP competes with future production;
- recovery states: Fallen/corrupted bots, Telecove, post-combat rewards, and forced
  stage transitions;
- 2-, 3-, and 4-player fields with seat rotation and paired RNG;
- champion, historical-checkpoint, heuristic, specialist, and exploiter opponents;
- held-out spirit/monster/catalog combinations that remain rule-valid;
- latency and resource-load cases matching production serving.

### Hard gates

Any one of these failures rejects a candidate before strategic scoring:

- compile, typecheck, deterministic engine, or bot-contract failure;
- illegal action, unresolved prompt, stall, or forced-stage-transition failure;
- hidden-information/future-RNG leakage or seat asymmetry;
- replay mismatch, nondeterminism, missing provenance, or artifact hash mismatch;
- use of forbidden files, network, private seeds, or evaluator internals;
- resource-budget or wall-clock overrun;
- production latency or memory limit violation;
- more than the pre-registered changed-LOC/diff-size cap, a new dependency, or added
  serving branch without the pre-registered minimum held-out gain.

### Optimization score

The local controller expects a scalar. That scalar is a development surrogate, never a
promotion decision. The trusted evaluator should print exactly one `arc_fitness`
value: the lower confidence bound of a pre-registered late-game score computed from
round-15+ snapshots. The score combines only terminal success from those snapshots
and VP/engine growth after the snapshot; its exact formula and scale are frozen in
Phase 0 after power calibration.

Terminal success is the dominant scalar component so engine hoarding without conversion cannot win.
Phase 0 includes a deliberately degenerate hoarding candidate and must show that snapshot-score ordering
correlates with powered full-game round-15+ strength before the formula is frozen. Each campaign freezes
its initial snapshot pool; the next campaign regenerates round-15+ snapshots from the frozen current
champion so improved policies are not selected only on stale-state distributions.

Everything else is a gate, not another term hidden in a composite float. Solo
round-35 win rate, early-game strength, multiplayer Elo/win rate, worst-opponent
performance, exploitability, latency, compute, and complexity must all meet explicit
non-regression thresholds before the late-game scalar is accepted. The signed report
preserves every endpoint so the scalar cannot hide a regression. The incumbent and
all baselines are re-scored under this same V35 evaluator rather than compared using
the older harness's average-VP objective.

Do not include private or final raw outcomes in controller-visible feedback. Return only
coarse diagnostics such as `late_game_regression`, `latency_over_budget`, or
`fairness_gate_failed` when the protocol permits it.

## Fixed-Budget Accounting

Every candidate receives the same limits:

- controller/proposal compute allowance;
- number of public and private evaluator calls;
- simulator games and environment steps;
- GPU type/count and GPU-seconds;
- CPU threads, RAM, disk, and wall time;
- search/inference budget per decision.

Primary optimizer comparisons use one local cost currency: measured GPU-seconds plus CPU-seconds,
including controller/proposal-model compute, converted at a pre-registered fixed rate. Random,
TPE-style, evolutionary, and AIDE-style arms use the identical adapter, trusted runner, funnel, cache
policy, and evaluator. A secondary
sample-efficiency table compares equal evaluator-call counts. Both views are reported,
but only the equal-total-cost comparison supports a claim that autoresearch is the
better research method.

The ledger records attempted proposals, including compile failures and timeouts.
Cache only immutable build artifacts and exact hash-keyed simulator outputs. Never
reuse strategic results across nonidentical candidates.

Use common random numbers and paired seats wherever possible. A successive-halving
funnel keeps the campaign efficient:

1. seconds: static validation and deterministic unit tests;
2. minutes: tiny paired public smoke;
3. tens of minutes: medium public task mix;
4. hours: capped private selection evaluation;
5. campaign end: sealed final promotion suite.

## Search Policy

Maintain a lineage tree rather than a single incumbent:

- exploit the best validated child within each active lineage;
- preserve diverse high-performing lineages on a Pareto frontier;
- fork a materially different strategy after a lineage stagnates;
- penalize repeated near-identical diffs and rising code complexity;
- periodically simplify the best candidate while preserving score;
- record rejected hypotheses and failure categories to avoid cycling;
- enforce the campaign-level private-query cap and never return private raw outcomes
  to a lineage.

For the first pilot, compare the local AIDE-style lineage controller with random, TPE-style, and
evolutionary search. A local proposal-model adapter may be added later, but absence of a local LLM must
not block the deterministic controller. Separately vary the deployed
bot's neural width/depth only in matched arms with equal training steps, inference
budget, wall-clock allowance, and three or more scratch seeds. Outer-agent model size
and deployed-bot model size answer different questions and must not be confounded.

## A100 Execution

The optimizer itself does not require an A100 unless a local proposal model is used.
The game simulations and training do. The trusted scheduler should:

- inventory current processes, GPU memory, CPU load, and disk before claiming a GPU;
- require the V35 GPU-7 lease file and fail closed for every other physical GPU even if it looks idle;
- parallelize paired seeds and task families, not give different candidates different
  effective budgets;
- pin CPU workers and batch neural inference to keep GPU utilization high;
- overlap CPU simulation with GPU training/inference using bounded queues;
- cache engine builds and frozen checkpoint loads by verified hashes;
- run a throughput/variance sweep before choosing games per evaluation;
- release every GPU lease explicitly and preserve unrelated artifacts/processes.

V35 may use only an explicitly free, nonconflicting GPU lease. At authorization time GPU 7 was released
from V34 and is the only eligible V35 device; GPUs 4-6 remain out of scope. The controller and proposal
logic run locally, while trusted simulation/inference/training may run on SimForge GPU 7. No multi-GPU
campaign starts until evaluator noise and throughput are measured and a new explicit lease is recorded.
Candidate and trusted processes use GPU 7 sequentially unless a reviewed MPS/MIG cap proves isolation;
every boundary synchronizes and clears allocator state before the next tenant.

## Phased Implementation

### Phase 0: Threat model and benchmark calibration

Deliverables:

- immutable/mutable file allowlists and hash manifest;
- public/private/final seed construction and rotation policy;
- a candidate container/process isolated from the trusted evaluator, with
  evaluation-time network disabled;
- out-of-process trusted scoring that recomputes metrics from signed replays rather
  than importing or trusting candidate code;
- trusted replay production that replays every action through legality and engine transitions;
  candidates return only action indexes and can never supply their own replay;
- a whitelisted result schema containing only `arc_fitness` and enumerated diagnostic
  codes; candidate stdout and raw stack traces never reach the local research controller;
- a strict JSON schema with type and hard-range validation for every candidate field,
  plus adapter property/fuzz tests;
- fixed-budget ledger and signed artifact schema;
- chained signatures over replay hash, engine/evaluator hashes, seed-family commitment, candidate diff
  hash, resource ledger, and prior ledger hash. The signing key lives outside repository/worker mounts,
  mode `0600`, under the trusted controller identity;
- reward-hacking, private-seed access, timeout, evaluator-tampering, monkeypatching,
  path traversal, and candidate-stdout exfiltration tests, including an adversarial
  candidate that deliberately attempts to print private seeds;
- baseline variance and throughput report across solo and multiplayer task families;
- a pre-registered late-game scalar plus explicit thresholds for every hard endpoint;
- a powered correlation check between snapshot score and full-game round-15+ strength, plus an
  engine-hoarding Goodhart attack that must rank below converting play;
- the incumbent and all search baselines re-scored under the V35 evaluator.

Gate: the same baseline must reproduce within its confidence interval, paired seeds
must reduce variance, all attacks must fail closed, and no candidate-visible artifact
may reveal private/final information.

### Phase 1: Bounded local AIDE-style pilot

After Phase 0 determines affordable statistical power, run a provisional 20 outer steps in disposable
V35 candidate directories, initially mutating only `candidate.json`. Use one public metric, fixed cost,
and no private/final promotion access. Compare a local AIDE-style lineage controller with random,
TPE-style, and evolutionary search. If that validates the control plane, run a second bounded pilot that
exposes one small V35-only typed reranker file so the system is tested on code research, not only
black-box hyperparameter tuning. The trusted runner enforces the same ten-file/size ceiling anticipated
for hosted tools, but no hosted tool is invoked.

Compare against:

- random search under equal total cost;
- the current hand-authored configuration;
- a small Bayesian/evolutionary parameter search under equal total cost.

Gate: the configuration pilot must validate the pipeline end to end and the AIDE-style controller must
reach parity with simple search without hard-gate regressions. The code-mutation pilot must produce
a reproducible valid candidate and positive fresh-public late-game evidence. Beating
the simple optimizers is required for an efficiency claim, not for continuing from a
safe configuration pilot to the code pilot.

### Phase 2: Replicated first-order autoresearch

Run three independent campaigns, provisionally 50 to 100 steps each, preserving all
proposals and lineages. Final steps, games, and replicates come from Phase 0 power and
cost results. Expand the mutable surface cautiously to V35 copies of the reranker,
planner, curriculum, and loss configuration. Give each campaign a disjoint private
seed family, enforce the numeric query cap, then give each frozen winner one one-shot
confirmation on fresh private seeds.

Gate: at least two campaign winners must show positive late-game lower-confidence-
bound improvement on their fresh one-shot confirmations, with solo improvement and no
multiplayer, exploitability, fairness, latency, or complexity regression. Apply the
pre-registered multiple-selection correction to each claim.

### Phase 3: Far-OOD and human-reference evaluation

Evaluate frozen finalists on unseen catalog mixes, new seed families, adversarial
specialists, all player counts, and Michael's replay-derived strategic snapshots.
Then run blinded Michael-versus-bot games with no tuning on those outcomes.

Gate: pass the full existing promotion suite and demonstrate that gains persist after
round 15 in the powered simulator snapshot suites. A candidate that only increases
early VP is rejected even if its aggregate score rises. Michael's blinded games are
qualitative strategic and UX sanity checks, not statistical proof by themselves.

### Phase 4: Local AIDE-squared experiment

Create two frozen inner researchers:

- control: the human-designed V35 autoresearch harness;
- treatment: an outer AIDE-style process allowed to modify only the inner research
  policy/program, lineage selection, and experiment-allocation code.

The meta-evaluator, candidate task set, cost ledger, private seeds, and promotion gates
remain immutable. Evolved researcher code runs in the same untrusted sandbox as candidate code and has
no direct private-tier access. An immutable broker enforces query caps and returns only permitted coarse
feedback. Run at least three independent, rejection-memory-isolated control/treatment campaign pairs
under equal total cost, with disjoint seeds and a pre-registered paired bootstrap test plus Holm
correction. The
initial implementation is a small local tree-search controller informed by open-source AIDE's published
architecture; a future AIDE85 comparison requires a separate privacy and availability review.

Gate: claim Level 1-style recursive improvement only if the evolved researcher
produces stronger unseen bots under equal budget across multiple seeds. Do not claim
Level 2 ignition unless successive outer generations improve the rate of improvement
with statistical support, not merely faster early convergence.

### Phase 5: Promotion and operationalization

Freeze the best candidate before final evaluation. Run solo, 2/3/4-player, champion,
historical, heuristic, exploiter, fairness, replay, stall, latency, regression, and
human gates. Publish the full attempt ledger, selection lineage, hashes, and negative
results. Promotion remains an explicit human decision and uses the normal V35
deployment path.

Gate: no production deployment until every required gate passes. The automation identity has no
credential capable of writing production or the canonical champion pointer; only a separate human
promotion credential can do so. Final-tier seeds remain a commitment until that human-only gate, and its
result store is unreadable to the controller. Neither the local controller nor outer loop may write
production state.

## Provisional Experiment Matrix

| Arm                    |     Mutable surface |     Outer steps |      Replicates | Purpose                        |
| ---------------------- | ------------------: | --------------: | --------------: | ------------------------------ |
| Incumbent              |                none |               0 | Phase 0 decides | variance and strength baseline |
| Random                 |         config only |             ~20 | Phase 0 decides | minimal search baseline        |
| Evolutionary           |         config only |             ~20 | Phase 0 decides | current-method baseline        |
| Local AIDE config      |         config only |             ~20 | Phase 0 decides | control-plane feasibility      |
| Local AIDE small-code  | config + 1 V35 file | Phase 0 decides | Phase 0 decides | code-research feasibility      |
| Local AIDE code        |  up to 10 V35 files |         ~50-100 | Phase 0 decides | first-order autoresearch       |
| AIDE squared control   |    fixed researcher |    cost-matched | Phase 0 decides | human-designed outer loop      |
| AIDE squared treatment |  mutable researcher |    cost-matched | Phase 0 decides | recursive-improvement test     |

All counts marked with `~` are planning estimates, not commitments. Phase 0 chooses
outer steps, replicates, games, and GPU budget
from power and variance measurements. Pre-register the minimum meaningful effect,
multiple-selection correction, and confidence rule before any strategic result is
visible. Raising the immutable ten-query private broker cap requires a new plan and Fable review.

## Security and Privacy Decision

Decision made: local/private source handling only. No hosted Weco job, source upload, terminal output,
metric, replay, or credential leaves the controlled hosts. The implementation is a deterministic local
AIDE-style lineage controller and may optionally use a separately reviewed local model endpoint later.
The trusted runner scrubs environment variables and never mounts the seed/signing vault into candidate
or researcher sandboxes.

## Success Criteria

The integration is successful only if it demonstrates all of the following:

- valid reproducible proposals with a complete cost/provenance ledger;
- stronger solo round-35 performance and materially stronger rounds-15+ play;
- no loss across 2/3/4-player fields and no exploiter/collusion regression;
- fairness, hidden-information, replay, stall, corruption, and reward-selection gates;
- acceptable production latency and resource cost;
- private and final gains that survive multiple campaigns and confidence bounds;
- better results than random/evolutionary and human-designed researcher baselines
  under equal total budgets;
- maintainable final code after a simplification pass.

## Stop Rules

Stop or redesign the lane if:

- private performance fails to improve after the pre-registered budget;
- public gains repeatedly disappear on private tasks;
- private queries or hidden task details leak;
- reward hacking, nondeterminism, or evaluator tampering occurs;
- gains are only early-game VP or trade away engine strength;
- simulator variance makes per-step ranking unreliable at affordable game counts;
- complexity or inference cost grows faster than held-out strength;
- the required local sandbox or trusted GPU-7 lease boundary cannot be enforced.

On evaluator tampering, private/final seed leakage, signing-key exposure, or broker bypass: invalidate the
entire campaign, revoke its artifacts, rotate affected seed families and keys, preserve an incident
record, and require a fresh security audit before resuming.

## Resolved Implementation Decisions

1. Source handling and proposal control are local/private; SimForge GPU 7 is trusted compute only.
2. Phase 1 is capped at 20 proposals, 8 GPU-hours, 64 CPU-hours, and 24 wall-clock hours. Phase 0 may
   reduce an arm for power/cost reasons but may not exceed those caps without a new review.
3. Feasibility first requires solo success by the effective round-35 ceiling (currently engine-capped at
   round 30). Among feasible candidates, the primary scalar is the round-15+
   terminal-conversion/engine-growth LCB. Multiplayer, fairness, exploitability, latency, replay, stall,
   and complexity remain hard gates.

## References

The Weco links below motivate architectural hypotheses only. Their recursive-improvement claims and
unreleased AIDE85/AIDE-squared implementation are not treated as verified evidence.

- Weco, “AIDE²: The First Evidence of Recursive Self-Improvement”:
  https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement
- Weco, “The 4 Levels of Recursive Self-Improvement”:
  https://www.weco.ai/blog/4-levels-of-recursive-self-improvement
- Weco CLI documentation: https://docs.weco.ai/
- Weco evaluation scripts: https://docs.weco.ai/using-weco/eval-scripts
- Weco CLI optimization reference: https://docs.weco.ai/reference/cli/optimizing
- Weco privacy FAQ: https://docs.weco.ai/resources/faq
- Open-source AIDE reference: https://github.com/WecoAI/aideml
