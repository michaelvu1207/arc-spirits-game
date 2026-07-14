# Final Fable review of the V34 Phase 2 recovery amendment

Reviewed commit: `5f1bacbcb70c382b082a3847ad4358d9db86a049`

Command:

```text
claude -p --model fable --effort high --tools "Read" --no-session-persistence "Re-review the amended V34 Phase 2 recovery plan at /Users/maikyon/Documents/Programming/ArcSpirits/arc-spirits-game/ml/experiments/v34-latency-first-expert-iteration/phase2-analysis-recovery-plan.md, frozen in commit 5f1bacbcb70c382b082a3847ad4358d9db86a049. The prior Fable review is at phase2-analysis-recovery-fable-review.md. Determine whether required items 1-4 and Git hardening items 5-6 are now adequately addressed without reading any Phase 2 outcome artifact. Return an explicit ACCEPT or REJECT verdict, list any remaining blocking gaps, and be concise."
```

Exit code: `0`

## Verdict: ACCEPT

The amended plan adequately addresses all four required items and both Git hardening items. I read only the plan, the prior review, and the committed `GIT_DIR`-only probe (a git-environment record containing no Phase 2 values) — no outcome artifact was opened.

**Item-by-item:**

1. **Output-discarding evidence** — Addressed. The plan now states the mechanism (the frozen Python parent routes verifier stdout/stderr to `subprocess.DEVNULL`), commits an attempt-window side-channel inventory that enumerates and hashes every file created under the authoritative root, `/tmp`, and the remote home, adjudicates the only findings (zero-byte stdout, unrelated Brave cache entries), and concludes nothing needs quarantine. It also explicitly acknowledges the seven observed exit statuses and dismisses them on outcome-independence grounds — the exact nit the prior review raised.

2. **Consumed-marker crash hole** — Addressed. Consumption is now precisely defined via a three-stage ladder: a committed **reservation** (explicitly does not claim exec), an **attempt-started** marker plus `O_CREAT|O_EXCL` stdout (either durably consumes the slot), and an **exec-confirmed** manifest backed by a `Popen` handshake proving `execve`. Every ambiguous state is adjudicated: reservation-only may resume the same committed invocation; started-without-exec-confirmed conservatively closes Lane A. Nothing is left undefined.

3. **Expanded preflight** — Addressed. Step 5 now covers analyzer/dependency import without executing `main`, atomic writability sentinel on the output directory, absence of the final JSON and attempt-2 stdout, `test -r` on all seven completion and input paths, disk/RAM/fd/`/tmp` headroom, executable identity pinning, the exact frozen ancestry command under the exact final exported environment (plus reverse negative control), and a dry run of the one-shot launcher's pre-exec validations against dummy paths.

4. **Git config pinning** — Addressed. `GIT_CONFIG_SYSTEM=/dev/null` and `GIT_CONFIG_GLOBAL=/dev/null` are on the amended allowlist (fixing the prior allowlist contradiction), and step 5 requires that system/global config be "disabled, not merely assumed irrelevant." Injected `GIT_CONFIG_COUNT`/`KEY`/`VALUE` and other override variables are explicitly rejected.

5. **Drop `GIT_WORK_TREE`** — Addressed. `GIT_WORK_TREE` is now forbidden, justified by the committed probe at `artifacts/phase2-analysis-git-dir-only-probe.json`, which I verified exists: it shows the exact frozen command (`git -C … merge-base --is-ancestor fe8dcdb HEAD`) succeeding from a non-Git cwd with `GIT_DIR` alone. The probe ran against the development repo's object database, so it proves the mechanism rather than the final configuration — but step 5 requires repeating the exact command against the isolated database under the final environment before launch, which closes that loop.

6. **Complete shallow boundary** — Addressed. Step 3 derives the full `.git/shallow` set from the frozen parent graph (every imported boundary commit with an omitted out-of-graph parent, and nothing else), imports all needed first-parents and merge side-parents, and step 5 verifies `rev-list --parents` equality, per-object re-hashing, exact shallow-set membership, and both positive and negative ancestry controls.

The review's smaller suggestions were also incorporated: the determinism argument ("mechanical completion of the same draw") and the general governing principle now appear in the scientific rationale, and the incident evidence chain must be committed before any recovery launch.

**Remaining blocking gaps: none.**

Two non-blocking notes: the side-channel inventory's stated scope (authoritative root, `/tmp`, remote home) doesn't literally name system log directories, though the plan asserts no scheduler/service/process sink persisted values — given the kernel-level `DEVNULL` routing and the pre-`load_conditions` crash, residual risk is negligible; and I could not independently confirm the inventory file's path from the plan text alone, but step 2's authorization hash-binds it, so its existence is mechanically enforced before any launch.
