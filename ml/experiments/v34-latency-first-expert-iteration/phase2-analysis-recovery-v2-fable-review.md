# Fable review of the V34 Phase 2 recovery v2 amendment

Reviewed plan commit: `20496687f8ed6245a64e9d79879001269a124ca0`

Command:

```text
claude -p --model fable --effort high --tools "Read" --no-session-persistence "Review the plan at /Users/maikyon/Documents/Programming/ArcSpirits/arc-spirits-game/ml/experiments/v34-latency-first-expert-iteration/phase2-analysis-recovery-v2-plan.md. Identify important gaps, risks, and concrete improvements. Decide whether excluding only the preregistered SSH/session variables from the equality fingerprint while passing the full inherited child environment unchanged is scientifically defensible after v1 stopped at reservation-only with no analyzer process. Return ACCEPT or REJECT explicitly. Be concise."
```

Exit code: `0`

## Review

I don't have a Write tool available in this session, so I can't persist that memory — skipping it.

**Final answer: ACCEPT.** The v2 amendment is scientifically defensible because the change is outcome-blind (no v1 analyzer process ever started, no Phase 2 value was observed), preregistered, and confined to the equality check on variables the analyzer doesn't consume, while the no-retry rule and v1 immutability are preserved. Before committing the v2 authorization: (1) fix the "does not change the analyzer's actual environment" wording — the excluded variables do differ in the real child env, only the check ignores them; (2) verify nothing in the frozen analyzer reads `COLUMNS`/`LINES` (Python's `shutil.get_terminal_size` honors them even without a TTY) or state that stdout is audit-only and `phase2-analysis.json` is the sole measured value; (3) diff two fresh SSH connections' environments now, outcome-blind, to confirm the nine-variable exclusion set is complete — `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR`, and `DBUS_SESSION_BUS_ADDRESS` are common per-login variants that would reproduce the v1 failure; (4) pin the canonical environment serialization for the fingerprint; and (5) record the invoking connection's fingerprint and audit-only full hash in the `attempt-started`/`exec-confirmed` records.
