# Fable review of the V34 Phase 2 recovery plan

Run after the shared Claude Fable quota reset with:

```text
claude -p --model fable --effort high --tools "Read" --no-session-persistence "Review the plan at /Users/maikyon/Documents/Programming/ArcSpirits/arc-spirits-game/ml/experiments/v34-latency-first-expert-iteration/phase2-analysis-recovery-plan.md. Identify important gaps, risks, and concrete improvements. Decide whether the single corrected attempt is scientifically defensible given that the first launch failed before Python load_conditions but automated integrity verifiers machine-read outcome-bearing rows with discarded output. Be concise."
```

Exit code: `0`

## Review

I've read the plan. Verdict first, then the gaps.

### Verdict: the single corrected attempt is scientifically defensible

The hard line for validity is outcome exposure and outcome-conditioned decision-making, not attempt count. All four conditions that matter hold:

1. **The failure is provably pre-outcome.** The traceback ordering (crash in `validate_strength_lock` before `load_conditions`), zero-byte stdout, and absent `phase2-analysis.json` jointly prove no endpoint, gate, or ranking value ever existed to be seen.
2. **The failure cause is outcome-independent.** A missing Git checkout fails deterministically for *any* data, so the decision to retry cannot correlate with which arm would win.
3. **The JS verifiers don't break this.** They ran identically regardless of results, performed no comparative computation, and their only observable was an integrity pass/fail bit — which is uncorrelated with cross-arm outcomes. Machine-reading rows with discarded output is not exposure in any sense that biases the retry decision. (One nit: the rationale should explicitly acknowledge that the verifiers' *exit status* was observed, and dismiss it on these grounds, rather than only saying "emitted nothing.")
4. **The fix changes only environment, not analysis.** Same executable, argv, conditions, seeds, thresholds.

There's a stronger argument the plan doesn't make and should: with frozen seeds and inputs, the analyzer is deterministic, so attempt 2 produces the *identical* value attempt 1 would have produced. This isn't a second draw from a stochastic process at all — it's mechanical completion of the first draw. State this in the scientific rationale.

### Important gaps and risks

**1. "Discarded output" needs evidence, not assertion.** The no-exposure claim rests partly on the verifiers' output being discarded. Record *how*: were they redirected to `/dev/null` by a locked wrapper, or captured and deleted? Check for side channels — SimForge job logs, scheduler stdout capture, shell history, monitoring agents — that may have persisted verifier or analyzer output. Concrete step: enumerate and hash every file created during attempt 1, commit the inventory, and quarantine anything that could contain outcome-derived values before relaunch.

**2. The consumed-marker ordering creates a crash hole.** The marker is committed *before* launch (steps 6–7), and step 8 forbids retry "for any reason." A machine crash between marker creation and analyzer exec would consume the attempt without the analyzer ever running — closing Lane A on an event that exposed nothing. Define what counts as consumption: e.g., marker exists *and* analyzer process was exec'd (wrapper records PID/start time, or attempt-2 stdout file was created). A marker-present-but-never-exec'd state should be explicitly adjudicated, not left ambiguous.

**3. Step 8's unconditional closure is a policy device, not a scientific requirement — and it raises the stakes on preflight.** By the plan's own logic, a second failure that is also provably pre-`load_conditions` with zero output would be exactly as correctable as the first. Keeping the one-shot rule for commitment credibility is fine, but then the preflight must exercise *everything* except outcome-bearing computation: output-path writability, disk space, Python import of the analyzer module, readability of all seven condition inputs — and above all, a dry run of the exact frozen command `git -C <repo> merge-base --is-ancestor fe8cdb HEAD` under the exact exported environment (step 5's first bullet covers the ancestry check; the filesystem/Python preflight items are missing). You lost attempt 1 to an environment gap; don't lose the last attempt to a second one.

**4. Global/system Git config is an unpinned input.** The plan rejects inherited `GIT_*` variables and injected config overrides, but `/etc/gitconfig` and `~/.gitconfig` on SimForge still apply to the analyzer's subprocess. Set `GIT_CONFIG_SYSTEM=/dev/null` and `GIT_CONFIG_GLOBAL=/dev/null` (adding them to the allowed-env list) or hash-pin those files in the prelaunch manifest. Note the current wording would *reject* these variables as non-allowlisted — the allowlist needs amending either way.

**5. `GIT_WORK_TREE` is probably unnecessary — drop it if so.** `merge-base --is-ancestor` needs only the object database and refs; it runs fine with just `GIT_DIR` (even against a bare repo). Binding the authoritative artifact root as a work tree adds surface area for accidental worktree-touching behavior with no benefit to the frozen check. Test whether the analyzer's subprocess succeeds with `GIT_DIR` alone; if yes, remove `GIT_WORK_TREE` from the amendment.

**6. Shallow-boundary detail: side parents may need their own shallow entries.** If any merge between `fe8cdb` and HEAD has a side parent that is *older* than `fe8cdb`, that parent must either be imported or itself listed in `.git/shallow` — a single shallow entry at `fe8cdb` won't make the graph connected. The plan gestures at this ("import every… merge side-parent needed") but the `.git/shallow` exactness check should explicitly enumerate the full expected shallow set, derived from the frozen graph, not assume one entry. The positive/negative ancestry controls in step 5 would catch a mistake here, which is good — but only after the database is built; derive it correctly first.

### Smaller improvements

- Commit the incident record's evidence artifacts themselves (traceback text, `ls -la` of the output dir, `wc -c` of the stdout file), not just a narrative — the defensibility argument in the verdict rests entirely on that evidence chain surviving scrutiny.
- Step 10's post-exit re-hash of the Git database is good; also record the analyzer subprocess's actual Git invocation (via `GIT_TRACE=…` is *not* allowed by the env allowlist — fine, skip tracing; instead rely on the frozen source line and record the git version string in the manifest, which step 5 already does).
- The plan's own framing ("this amendment is not literal compliance with the original wording") is the right honest posture. Consider stating the general principle it instantiates — *failures provably prior to any outcome exposure are correctable via reviewed, preregistered amendment* — so that the authorization documents why this is sound rather than appearing to be a one-off exception.

Bottom line: approve the single corrected attempt conditional on fixing items 1–4 (evidence for output discarding, consumed-marker edge case, expanded preflight, config pinning) before the authorization is committed. Items 5–6 are correctness hardening for the Git-context construction itself.
