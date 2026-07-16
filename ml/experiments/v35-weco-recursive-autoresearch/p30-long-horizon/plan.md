# V35 P30 long-horizon campaign and evidence plan

Status: implementation review pending; non-executable until every Phase 0 gate is signed and accepted.

## Goal

Determine whether explicit late-game reach-30 credit improves long-horizon Arc Spirits play without degrading ordinary policy learning, then carry only a statistically supported winner into fresh public, private, multiplayer, exploitability, fairness, latency, regression, and Michael gates. This campaign is development evidence only and cannot itself promote a bot.

The frozen comparison has three arms per replicate:

1. `control-zero`: no reach-30 residual credit.
2. `uniform-040`: a constant 0.40 reach-30 residual dose.
3. `late-scheduled`: a late-game schedule that concentrates the same mechanism where the current bot falls off.

The scheduled coefficients are not cumulative-dose matched to the uniform arm because the number of eligible decisions per round is endogenous to the learned policy. The frozen claim is therefore about the `late-scheduled` schedule-and-dose package jointly; this campaign cannot attribute a difference to scheduling alone.

There are 18 matched replicates (`a` through `r`), eight generations, identical paired seeds within each replicate, and 4,096 common public endpoint games. The implementation, V34 source and strength locks, initial checkpoint, catalog, power artifact, seed schedule, source registry, and proposal materialization are immutable inputs.

## Phase 0: freeze trust and prove the runtime

No GPU, training, evaluation, analyzer, source upload, production change, or outcome inspection is permitted until all items below pass.

1. Freeze the complete source registry, including the trainer, evaluator, analyzer, signing and receipt tools, scheduler, runtime profile, dependency lock, and tests.
2. Commit the implementation and build an authentic external shallow Git object database containing the implementation base and implementation commit. The source-lock verifier must prove every registered file is the blob in that commit; the experiment root must not contain a physical `.git` directory.
3. Run the prescribed Claude Fable high-effort read-only review. An `ACCEPT` verdict and its exact command/stdout/stderr receipt must be committed. A conditional or rejected verdict keeps the campaign closed. Before any campaign token, GPU lease, or seed consumption, a rejected/conditional review may be addressed and rerun within the same unlaunched instance; each review attempt and disposition is committed, and only the final unconditional `ACCEPT` can authorize launch. After any seed is consumed, the review and protocol are immutable.
4. Freeze an unpredictable 256-bit campaign-instance ID. All authorizations, consumed markers, receipts, barriers, manifests, and analysis artifacts live below its isolated ledger namespace.
5. Provision distinct Ed25519 role keys for authorization issuance, execution receipts, guardian/pair validation, and analysis authorization. Public keys and key IDs are protocol-pinned. Private keys stay in `MichaelAgents`. Every remote role first completes all source/request validation, writes a canonical unsigned payload, and commits a durable `O_EXCL` signing-attempt marker before emitting a source/request/output/plan-bound `SIGN_READY` message. A marker without its final artifact closes that logical action; ordinary recomputation or signing retry is forbidden. Only after local custody validates `SIGN_READY` may it release the named role key into a sealed unnamed 0600 `CLOEXEC` memfd for the short signature-and-exclusive-write step. For executor actions, candidate code must already have exited and the immutable unsigned receipt must be on disk before `SIGN_READY`. No private key is available to candidate code, validation/build work, a long-running job, or the scheduler.
6. Install the source-locked AppArmor profile for the exact hash-pinned `/usr/bin/bwrap` only after a signed host-change authorization. Then run the exact namespace smoke as `ubuntu`, not through privileged `sudo bwrap`. It must prove:
   - user, PID, IPC, UTS, cgroup, and network namespace creation;
   - no network egress;
   - only GPU7, `nvidiactl`, and UVM device nodes are visible;
   - GPUs 4-6 are absent;
   - the token-bound AF_UNIX socket binds, connects, and unlinks below 107 bytes.
7. Run CPU-only signed fault-injection preflights on a fresh root. Lease acquisition, output-open failure, `Popen` failure, child failure, signal interruption, GPU-postcheck failure, ENOSPC during output/receipt sealing, authorization clock skew/expiry, custody-host death after the durable signing marker, and receipt-signing failure must each end in exactly one immutable signed success/failure receipt or an explicit quarantined incident. The Linux preflight must also prove that `posix_fallocate` reserves real (non-sparse) blocks, shrinks one action at a time, and returns to zero after the sealed evaluation phase. No ambiguous consumed token or silently orphaned lease is allowed.
8. Rehearse the exact one-shot analyzer against a synthetic, label-shuffled 54-endpoint manifest with the production schema, isolation, empty-output, signing, and consumed-token paths.
9. Run a bitwise primary/replay determinism smoke through fresh CUDA servers and the exact evaluator on physical GPU7 with the identical driver, CUDA/cuDNN/cuBLAS versions, container/runtime hashes, environment variables, inference batch shapes, client concurrency, and evaluator command used by production evaluation. A mismatch is an integrity failure, not a retryable infrastructure event, and closes the campaign instance.
10. Obtain a fresh independent read-only security/runtime audit with no P0/P1 launch blocker.

The keyless scheduler enforces this order rather than relying on an operator checklist. It cannot create the generation-one start record until three source-locked `preflight` executions have valid executor-signed receipts: the eleven-case Linux fault matrix, the full-shape synthetic analyzer rehearsal, and a 4,096-game production-concurrency CUDA primary/replay run using two fresh inference servers. The CUDA child writes raw per-game evidence only into the sealed artifact root; the guardian recomputes exact per-game and replay-hash equality and exposes only commitments and diagnostic codes. A local-only review-attester then signs an independent Fable `ACCEPT` receipt over the metric-free Phase-0 evidence, after which the guardian may sign `phase0-readiness`. Any missing, invalid, consumed-but-unsealed, or non-accepted state stops before generation authorization.

The directly reviewable enforcement closure is `ml/run_v35_p30_campaign.py`, `ml/run_v35_p30_role.py`, `ml/v35_p30_phase0.py`, `ml/issue_v35_p30_preflight_authorization.py`, `ml/run_v35_p30_fault_injection.py`, `ml/run_v35_p30_cuda_determinism.py`, `ml/run_v35_p30_gate_review_local.py`, `ml/v35_p30_authorized_execution.py`, and `ml/test_v35_p30_phase0_gates.py`.

After the three matched generation-one arms and the guardian storage/runtime projection, the scheduler again stops. A second local-only Fable review must accept the exact protocol, plan, source lock, Phase-0 readiness receipt, and generation-one preflight receipt. Only then may the guardian sign `full-campaign-authorization`; every later scheduler call revalidates that signature and its complete hash chain before releasing storage reservation or entering generation 2+. Neither review capsule contains raw reports, logs, model outputs, seeds beyond the already-public protocol schedule, or comparative game outcomes.

### Frozen bounded recovery policy

Each endpoint/generation or evaluation role permits at most one outcome-blind infrastructure recovery. Recovery requires a guardian-signed incident classification, immutable consumed-token and unsigned-draft evidence, unchanged protocol/source/config/input-checkpoint/seed bindings, and zero metric exposure. Candidate code may rerun only with a fresh token when the guardian proves that no child started and no seed was consumed. The only eligible classes are:

- `PRE_CHILD`: no game process started and no game seed was consumed;
- `RECEIPT_ONLY`: all authorized artifacts, process cleanup, and GPU-empty evidence are complete, so a supplemental receipt may be sealed without rerunning candidate or evaluator code.

The one-recovery budget is per logical generation/evaluation action, not global per role: an independently completed action does not consume another action's recovery allowance. Any second failure of the same logical action, child-started execution lacking a complete sealable draft, state ambiguity, seed ambiguity, unknown classification, outcome exposure, deterministic replay mismatch, trust-gate failure, or partially advanced state permanently closes the campaign instance. A closed instance can restart only with a new campaign ID, wholly fresh paired seeds, a new Fable review, and a new launch authorization.

Training-quality failure is never relabelled as infrastructure. A completed run with finite, schema-valid weights but weak/collapsed play remains a valid bad endpoint and is evaluated unchanged. A non-finite checkpoint, NaN loss, invalid checkpoint schema, or other deterministic training-contract failure is non-retryable and closes the instance; it cannot consume `PRE_CHILD` or `RECEIPT_ONLY` recovery.

## Phase 1: outcome-blind three-arm GPU7 preflight

After a separate immutable preflight authorization:

1. Acquire the external GPU7 lease and verify physical UUID `GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0` is idle. Never touch GPUs 4-6.
2. Run generation 1 for replicate `a` in all three arms, sequentially, with the exact signed commands and seeds.
3. Validate the prospective environment, source identity, checkpoint chain, raw-tree commitment, PPO/reach-30 trust gates, stalls, malformed counters, process cleanup, and GPU-empty postcondition.
4. Compute retained training bytes only from signed generated artifacts. Apply the frozen 25% per-generation growth/safety factor plus a 512 MiB evaluation reserve. Require at least 6 GiB projected final `/data/share8` headroom. Before each later launch, maintain a real `posix_fallocate` reservation for all projected later bytes, release exactly one action's frozen allocation, and fail before token consumption if reservation or headroom cannot be proven.
5. Record runtime and compute a conservative campaign duration projection. The signed projection must be at most the frozen `1,209,600` compute-second (14-day) campaign ceiling; exceeding it is a non-discretionary no-go. A Fable-reviewed immutable full-campaign authorization is required after this preflight; no metric or comparative outcome may be read.

## Phase 2: statistically powered matched training

Run one root at a time on GPU7 in generation-major, replicate-major, arm-major order. Every generation requires a fresh unpredictable token, exact authorization, consumed marker, prospective environment, process record, audit, artifact commitment, and signed receipt chained to the prior generation.

At every generation boundary, recompute remaining storage and runtime from the larger of the frozen preflight estimate and the running maximum signed per-generation bytes/runtime observed so far. These are outcome-blind operational quantities. The executor's generation audit additionally records applied reach-30 rows and realized coefficient dose overall and in rounds 1-8, 9-18, and 19-30; those sealed manipulation-check quantities cannot affect scheduling or selection. Stop before launch if unreserved free space plus the verified reservation is below:

`6 GiB floor + 512 MiB evaluation reserve + projected remaining training bytes`.

No seed substitution, arm substitution, unclassified retry, unsafe partial-root salvage, or outcome-conditioned change is allowed. Only the bounded recovery policy may reuse the exact failed seed. Logs remain sealed and do not feed the scheduler.

Every child-launching executor call additionally requires a one-shot launch permit signed by local custody with the protocol/source/action/host identity. Local custody holds the role key locally while the remote process validates and durably consumes only that permit; the key itself is not sent remotely until the candidate exits and the executor emits `SIGN_READY`. The executor primitive validates the permit and every registered source hash before token consumption, and binds the permit into its launch and receipt evidence. Direct CLI/import calls, permit replay, or a permit/action mismatch therefore fail before `Popen` or seed use.

## Phase 3: sealed deterministic endpoint evaluation

Before the first endpoint evaluation, the guardian must validate all 54 complete eight-generation authorization/receipt/audit/checkpoint chains and sign a metric-free completeness barrier.

For each endpoint:

1. Issue a one-shot primary authorization and start a fresh inference server.
2. Run the candidate server in a nested PID/mount/network namespace with only its short socket directory writable and only GPU7 devices visible.
3. Run the trusted evaluator in a separate nested PID/mount/network namespace with the report directory writable, the socket directory read-only, no GPU devices, and no candidate access to scorer outputs.
4. Require empty evaluator stdout/stderr, exclusive output creation, bounded TERM/KILL shutdown, no remaining descendants, and a bounded GPU-empty poll before lease release. Server logs remain sealed diagnostics and are never exposed to the optimizer.
5. Repeat with a distinct replay token, server, socket path, and socket inode.
6. The guardian independently verifies signed canonical replay artifacts, recomputes trusted scores out of process, and signs only fixed diagnostic codes plus exact per-game/replay commitments. Primary and replay evidence must match exactly.

No endpoint metric is available until all 108 attempts and all 54 pair receipts are complete.

## Phase 4: one-shot outcome analysis

The guardian builds and signs an exact 54-endpoint manifest containing every signed generation chain, 108 evaluation receipts, 54 pair receipts, the completeness barrier, source/protocol identities, 540 unique execution tokens, and a Merkle root over the canonical 595-receipt inventory. It hashes report artifacts but never parses report JSON and exposes no metrics.

The separate Claude Fable high-effort review runs through the source-locked local review launcher. Before invoking Fable, the launcher atomically consumes a request-bound remote review-attempt token; any later failure closes the lane and cannot be retried. It downloads only the signed metric-free manifest, exact unsigned authorization draft, signed source lock, and local review-attester request into a private local capsule. `Read` is the only model tool. A default-deny filesystem sandbox grants reads only to the capsule and the exact immutable runtime, denies outcome and credential paths, and uses a resolved absolute Claude executable whose bytes/version are hash-bound in the receipt. Outbound network access is retained solely because the Claude API call requires it; the sandbox exposes no outcome-bearing file, reusable credential, or other network-facing candidate interface. Stdout, empty stderr, command, sandbox profile, local-copy hashes, and exact `VERDICT: ACCEPT` are captured with exclusive-create semantics. The local launcher then produces a cryptographic review-attester signature using a locally custodied key that is never delivered to SimForge; the analysis authorizer verifies that provenance before signing the final analysis authorization. No outcome-bearing artifact or reusable secret is available to Fable, and a forged remote unsigned claim cannot pass.

The reviewed draft fixes every operational field. Immediately after the guardian-signed review, the analysis authorizer may rebind only `issuedAtUtc`, `notBeforeUtc`, and `expiresAtUtc`; the final 24-hour interval must begin after review completion, and a machine validator proves every other byte matches the reviewed draft. Exactly one analyzer execution may then occur. The executor commits a random launch capability only by hash and passes the secret through a sealed inherited memfd; before opening the manifest or any report, the analyzer must validate that capability plus its isolated PID, user, and network namespaces. Direct CLI invocation is therefore invalid even with copied authorization and consumed-marker files.

The analyzer runs networkless with GPU mode `none` and a fixed output path. Only the analysis JSON directory is child-writable. Supervisor stdout, stderr, exit-code, launch, and receipt evidence live outside that mount; stdout/stderr must be empty. Analysis deliberately has no recovery path: even a pre-output process may have opened a report, so the supervisor does not infer outcome blindness from missing output. Any analyzer launch or sealing failure closes this campaign lane, and analysis code may never execute twice. The bounded `PRE_CHILD`/`RECEIPT_ONLY` state machine applies only to generation and evaluation work. The analysis JSON and signed execution receipt are hashed and committed before human or agent inspection.

Primary inference uses exact paired sign-flip tests over the 18 replicate-level differences with Holm correction across all six treatment-by-primary-endpoint tests. Planning effects are win-rate `+0.04`, late-game score `+0.025`, and post-round-15 VP `+0.10`; the variance inflation and 262,144 exact sign assignments are frozen by the power artifact. That artifact simulates the conjunction of the sign-flip test and the win-effect/replicate-consistency gates; its conservative simultaneous joint-power lower bound is `0.8090690427248277`, above the frozen 0.80 requirement. A treatment is eligible only if every primary endpoint is Holm-significant and all safety gates pass, including true-win point estimate at least `+0.03`, at least 13/18 positive true-win replicate effects, and at most 2/18 below `-0.01`.

If both arms are eligible, the deterministic tie-break is: larger true-win point effect, then larger late-game-score point effect, then frozen arm order. The analyzer recomputes the Monte Carlo/Wilson power bound from the frozen seed and parameters and verifies it against the hash-bound power artifact; the literal is not trusted in isolation. This screen is powered only for the complete planning-effect vector. The diagnostic joint point-power lower bound falls to `0.024` at 75% of that vector and `0.0` at 50%, so a null result cannot rule out smaller useful effects; neither sensitivity curve carries an adequacy, selection, or promotion claim.

## Phase 5: confirmation and promotion gates

At most one public-screen winner advances. Every numerical rule is frozen before P30 outcomes in the hash-bound `confirmation-gates.proposed.json`; the summary below is not a substitute for that machine-readable contract. It must then pass, in order:

1. 8,192 one-shot fresh public solo seeds never used for training or selection: the Bonferroni family requires at least 6,631 round-30 wins (Wilson lower bound at least 0.80), at least 7,431 round-35 wins (lower bound at least 0.90), and a 100,000-draw paired-bootstrap lower bound of at least `+0.05` post-round-15 VP/round versus the locked incumbent;
2. 4,096 status-3 private solo seeds require at least 3,337 round-30 wins, 3,732 round-35 wins, and the frozen 1,024-game late-state slice floors;
3. balanced 2/3/4-player evaluation requires the overall Elo-delta lower 95% bound to exceed `+50`, every format's lower bound to be nonnegative, and seat spread at most 0.02;
4. champion, exploiter, heuristic, and adversarial gauntlets require aggregate score-delta lower 95% at least `+0.03`, per-family noninferiority above `-0.01`, best-response exploit upper 95% at most 0.40, and improvement upper 95% at most `-0.02`;
5. fairness requires exactly zero hidden/future/private outcome reads and zero counterfactual-hidden-state action mismatches, while public monster stats and deterministic drops remain allowed;
6. stalls, malformed actions, corruption/fallen-state progress failures, and replay mismatches must each be zero; binary inference p95 must be at most 100 ms and at most 1.10x baseline, game-wall p95 at most 60 s and 1.25x baseline, and GPU memory at most 1.10x baseline; all named regression suites pass;
7. 40 precommitted live fair games against Michael with alternated first-player/order conditions and immutable replays. The binary primary endpoint is a bot win; ties/draws count as non-wins. The bot must win at least 28/40 games. A separate Fable review freezes the exact live-game procedure before game one.

Promotion requires every gate. The target remains at least 80% fair held-out solo wins by round 30 (stretch 95%+), materially better multiplayer Elo, and demonstrated superiority to Michael. A failed gate does not get waived by a strong public P30 result.

## Phase 6: evidence-supported autoresearch continuation

Only after the P30 result and confirmation gates are sealed may V35 autoresearch vary width, search budget, curriculum, reranker weights, or training hyperparameters. Random, evolutionary, and local AIDE-style search receive equal total GPU/model cost. Private/final seeds never feed candidate generation. An outer harness-improvement loop is allowed only under a frozen meta-evaluator and a new Fable-reviewed protocol.

## Acceptance checklist

- Full source registry and authentic Git source lock pass.
- Fable plan verdict is `ACCEPT` and committed.
- Role-separated key custody is implemented and adversarially tested.
- Exact non-privileged bubblewrap/AppArmor smoke passes on SimForge.
- Fresh-root and all injected failure paths seal correctly.
- Independent security/runtime re-audit reports no P0/P1 blocker.
- Signed outcome-blind three-arm preflight passes on GPU7.
- Full-campaign and analysis authorizations are separately frozen.
- All 54 training chains, 108 evaluation attempts, 54 pair receipts, completeness barrier, manifest, and analyzer receipt validate.
- No promotion occurs before all held-out and Michael gates pass.
