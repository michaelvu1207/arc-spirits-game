# V35 Search Runtime and Fresh-Public Confirmation Plan

Status: public-development only; promotion-ineligible; private/status-3 flags remain closed.

## Objective

Preserve the public-development strength gain of the frozen random-search champion while reducing its search latency enough for a fair confirmation. The champion is not a Weco/AIDE efficiency result: the AIDE parity gate failed. It is a random-search configuration candidate that improved the development endpoint and still requires fresh-public, private, multiplayer, exploitability, fairness, regression, and Michael gates.

## Frozen inputs

- Frozen public-pilot/development commit before runtime changes: `0239cb8`.
- The repaired runtime receives a new immutable commit after all reviews and tests. The confirmation authorization must bind that exact commit and re-verify every frozen input/configuration hash there; it must not refer to a dirty working tree.
- P30 checkpoint: `ml/experiments/v35-weco-recursive-autoresearch/league/rep-a/p30-credit025/checkpoints/main-0-gen8.pt`, SHA-256 `c799ee8587c5a82013dd06830eab7818b359a07944629a236de3dd1d2bd24e91`.
- Baseline inference configuration: the V35 default candidate in `ml/autoresearch/v35/core.py` at `0239cb8`.
- Champion configuration: candidate `f4e6230e8d983dbc` from the immutable public pilot result at `0239cb8`.
- Development-only observations: champion minus baseline win rate `+3.515625` percentage points, final VP `+0.67578125`, post-round-15 VP/round `+0.039927`, and reach-15 `+3.125` percentage points; development p95 game wall time was about `43.1 s` versus `2.27 s`.

## Lane R1: exact-output runtime repair

1. Change only inference execution, not model weights, features, action generation, search allocation, candidate ranking, RNG, or game rules.
2. Make entity-v2 compute all requested heads from one `encode_state` result.
3. For auxiliary-only requests, especially reach-30 leaf batches, do not run unused policy/value heads. Preserve v1 behavior and wire compatibility.
4. Add tests proving:
   - reach-30-only v1 and v2 requests never invoke the policy `forward` path;
   - mixed v2 outputs use exactly one state encoding;
   - every returned float is bit-identical to the legacy head computation on the same padded batch;
   - JSON/binary, SIGHUP, capability, engine, and ML smoke gates remain green.
5. Benchmark legacy versus repaired computation on physical GPU 7 only, using the frozen checkpoint and public observation fixture, at representative batch sizes. Use an isolated `/tmp` overlay and delete it after the benchmark. Do not touch GPUs 4-6.
6. Before any game benchmark, run deterministic old/new action and replay parity on a small newly inventoried public-only seed block. Any difference closes this optimization lane until diagnosed. Do not inspect private outcomes.
7. Bind CUDA, driver, PyTorch, cuDNN/SDPA settings, dtype, deterministic flags, inference-server argv, and checkpoint/source hashes. Bit identity is claimed only for the same padded tensor batch under this environment.

## Lane R2: system sweep after parity

Under the exact same checkpoint/configuration and public seed block, sweep only operational settings:

- actor workers;
- inference `max_batch_rows`;
- inference batching window;
- one persistent inference server per campaign rather than per proposal;
- compact result/log emission that does not alter replay content.

Select settings by completed games per wall-second subject to zero stalls and zero action/replay mismatches against the fixed operational reference. Varying batch composition is not expected to preserve every float bit. Operational parity means identical legal-action indices and replay hashes for the committed corpus under the frozen seeded selection/tie-breaking implementation; any mismatch rejects that setting. Record GPU-seconds, CPU-seconds, wall-seconds, peak GPU memory, batch-size histogram, and disk bytes. Equal proposal counts are not an equal-cost claim; later method comparisons must normalize total compute and model/API cost.

Current `/data/share8` headroom must be rechecked immediately before launch. Do not start a large run below 8 GiB free; stop cleanly if projected free space is below 6 GiB. Store only compact reports/replay hashes locally and archive bulky disposable logs outside `/data/share8` or remove them after hash verification.

## Lane R3: outcome-blind latency precheck

Before allocating fresh confirmation seeds, run a committed public-only 256-seed paired latency precheck (512 total games: each seed once per configuration) with outcome fields suppressed from the human-facing artifact. The trusted recorder may compute games but exports only provenance, completion/stall counts, per-game/per-decision latency distributions, inference request/batch telemetry, and resource usage. Hash and archive raw reports without opening strength values.

- Reject the champion before confirmation if p95 game wall time exceeds 60 seconds, any inference timeout/stall occurs, or the separately preregistered production decision-latency SLO fails.
- Do not use a relative 1.25-times-baseline requirement: extra search is intentional and the development champion was about 19 times slower. Public confirmation remains promotion-ineligible; a later production gate must still show that live bot turns meet the user-facing SLO.
- Estimate confirmation wall time and disk use from the upper confidence bound of this precheck before launch. The estimate must satisfy the disk policy above.

## Lane C: one fresh-public confirmation

Only after R1/R2 parity and a separate immutable authorization:

1. Commit a machine-readable seed ledger covering every local and SimForge Arc evaluation/training artifact that can be inventoried, not only V32-V35. Hash every source ledger and explicitly list any legacy namespace that cannot be proven complete.
2. Before binding seeds, pre-register a simulation/analytic power calculation for the full conjunction of statistical gates using conservative paired covariance and the development effect only as an upper scenario. Target at least 80% pass power for a truly useful candidate. Choose the paired sample size from that calculation (8,192 pairs is the initial design, not an immutable answer); commit the calculation before seed generation.
3. Bind one disjoint common seed block at the selected size and one frozen champion. Do not reopen candidate selection.
4. For 8,192 pairs, run two 4,096-seed blocks in ABBA order: block A baseline then champion; block B champion then baseline. Every seed is evaluated under both configurations, for 16,384 total games. Scale blocks proportionally if power analysis changes the pair count. Use the same persistent-server settings, checkpoint, game code, and physical GPU 7.
5. Correct for the 20-proposal public search with a deliberately conservative one-sided Bonferroni level of `0.05 / 20 = 0.0025` (99.75% lower confidence bound), using 100,000 paired seed-cluster bootstrap draws with a committed RNG seed. Fresh seeds already remove direct winner selection on this block; Bonferroni is retained as extra protection against the public search/researcher degrees of freedom.
6. Require all of:
   - corrected win-rate lower bound at least `+1.0` percentage point (no separate observed `+3.0`-point threshold);
   - post-round-15 scoring and the frozen late-game composite lower bounds above zero;
   - final-VP lower bound at least zero;
   - finish-round upper bound at most zero;
   - reach-15 lower bound at least `-1.0` percentage point;
   - raw win rate no worse than the frozen development baseline;
   - each frozen public guardian difference at least `-5.0` percentage points;
   - zero stalls and exact provenance/replay integrity;
   - p95 game wall time at most 60 seconds and the frozen production decision-latency SLO passes;
   - complexity units at most 40, computed by the hash-bound `CandidateConfig.complexity_units()` implementation in `ml/autoresearch/v35/core.py`.
7. The authorization must enumerate and hash every public guardian checkpoint/configuration, not use an open-ended phrase such as "frozen guardians."
8. Persist each completed shard as an atomic signed ledger entry containing seed interval, configuration order, source/checkpoint hashes, replay-hash Merkle root, row count, stalls, and resource totals. An infrastructure interruption may resume only missing seed/configuration pairs from the same committed invocation after verifying all completed entries; it may not replay or replace completed pairs. Any semantic failure, overlap, source drift, or outcome inspection invalidates the block.
9. Freeze stdout, result JSON, exit status, file hashes, environment, source hashes, checkpoint hashes, seed commitment, and resource telemetry before inspecting comparative values.
10. This gate may advance only to private/status-3 evaluation. It cannot promote or deploy a bot.

## Failure policy

- Any parity mismatch, seed overlap, unsigned replay, stall, source drift, GPU-scope violation, unauthorized recomputation, or resume outside the signed missing-pair protocol invalidates the confirmation.
- A latency failure rejects this champion configuration even if strength improves; retain its evidence to guide a cheaper search/distillation design.
- A statistical failure does not justify reusing the confirmation seeds or tuning on their outcomes.

## Next training lane

Run separately from confirmation: three matched replicates of control coefficient `0`, uniform dose-up `--solo-reach30-coef 0.40`, and a late-only residual schedule (`1-8:0.15`, `9-18:0.30`, `19-30:0.50`) for eight generations, with fresh training seeds and a disjoint 4,096-game public common block. Keep critic settings fixed and apply simultaneous paired gates. This lane requires its own Fable-reviewed authorization before launch.
