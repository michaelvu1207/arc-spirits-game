# Fable implementation review of the V34 Phase 2 recovery v2 amendment

Reviewed commit: `3376637160f9b927f7eebced9f8b477e140d449d`

## Verdict: REJECT — one blocking gap

The five hardenings requested in my prior review (`phase2-analysis-recovery-v2-fable-review.md`) are all implemented, but the commit contains an internal plan-vs-launcher contradiction that must be fixed before the v2 authorization is committed.

**The five hardenings — all confirmed:**

1. **Wording fix** — Plan item 1 and the scientific-validity section now correctly say the excluded transport/session values *do* differ between connections and are passed through unchanged; only the equality comparison ignores them. The over-claim from the draft is gone.
2. **COLUMNS/LINES + stdout semantics** — Both halves done: the environment audit (`artifacts/phase2-analysis-recovery-v2-environment-audit.json`) greps the analyzer and locked verifiers for `get_terminal_size`, `COLUMNS`, `LINES`, and every excluded variable with zero matches, and plan item 12 plus the audit declare stdout audit-only with `phase2-analysis.json` as the sole measured output.
3. **Outcome-blind connection diff** — The audit records four fresh connections (2 PTY, 2 non-PTY), compared by value hash only. It confirms the three variables I named (`SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`) plus terminal sizing are handled; the resulting 13-variable exclusion set is identical (as a set) in plan item 3 and `ENV_FINGERPRINT_EXCLUDED` in the launcher, and the prepare script imports the launcher's constants rather than redefining them.
4. **Pinned serialization** — Plan item 4 pins it exactly, and the launcher implements it faithfully: excluded keys removed, `sorted()` (code-point order), JSON `[key,value]` array with `ensure_ascii` true, `(',',':')` separators, one trailing newline, UTF-8, SHA-256; the audit-only full hash uses the identical serialization before removal. The authorization validator hard-fails if the contract block or exclusion list drifts.
5. **Fingerprint in attempt records** — `analysisRelevantEnvironmentSha256`, `fullChildEnvironmentSha256`, and the excluded set are written into both the attempt-started and exec-confirmed records (and the exit record).

**Blocking gap:** Plan item 10 promises the records will also contain the **exact PATH and the Git additions** — "Record the analysis-relevant fingerprint, audit-only full child-environment hash, exact excluded-variable set, PATH, and Git additions in both the attempt-started and exec-confirmed records." The launcher (`ml/run_v34_phase2_analysis_recovery.py:330-343` and `366-382`) omits both fields from both records. PATH is enforced indirectly (it participates in the fingerprint) and the Git additions are recoverable via `authorizationSha256`, but the preregistered plan text and the launcher that item 6 will bind into the same v2 authorization contradict each other. Given that v1 died on exactly this class of contract mismatch and the one-shot records can't be regenerated afterward, this must be reconciled now — either add the two fields to both record dicts, or amend plan item 10 — before committing the v2 authorization.

Non-blocking note: the audit's source grep covers `analyze_v34_phase2.py` and the two verifier scripts but not modules the analyzer imports; immaterial because the stdout-audit-only designation (hardening 2's alternative) holds regardless.

I wasn't able to save a memory of this review — no Write tool is available in this session.
