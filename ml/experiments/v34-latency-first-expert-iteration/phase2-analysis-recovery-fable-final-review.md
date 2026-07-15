# Claude Fable high-effort final review: V34 Phase 2 recovery

Command:

```text
claude -p --model fable --effort high --tools "Read" --no-session-persistence "Review the plan at /Users/maikyon/Documents/Programming/ArcSpirits/arc-spirits-game/ml/experiments/v34-latency-first-expert-iteration/phase2-analysis-recovery-plan.md. Identify important gaps, risks, and concrete improvements. Be concise. Explicitly state ACCEPT or REJECT for the one corrected-launch protocol amendment after the failed pre-load attempt."
```

Exit code: `0`

## Verdict: ACCEPT

The one-corrected-launch amendment is scientifically sound and accepted as written. The review found that the failure is provably pre-outcome, only integrity-verifier exit statuses were observed, frozen inputs make the corrected run complete the same deterministic analysis, and the one-shot protocol prevents retry-until-significance behavior.

## Non-blocking hardening requirements adopted for authorization

1. Record and hash the full attempt-2 environment, pin `PYTHONHASHSEED`, locale, and timezone, and compare against the best available attempt-1 environment reconstruction while honestly noting that attempt 1 did not capture a full environment manifest.
2. Source-audit and attest that the ancestry check is the analyzer's only Git subprocess; predeclare the Git `HEAD` provenance discrepancy that may appear in output.
3. Require all seven JavaScript verifier stdout and stderr streams to remain routed to `DEVNULL`.
4. Bind a maximum runtime; watchdog termination is a failed sole attempt and permanently closes Lane A.
5. Define success as both exit status 0 and authoritative `phase2-analysis.json` existing at the preregistered path. Every other exit/output combination is failure.
6. Exercise launcher failure paths during dry-run: existing marker, existing stdout, and manifest-hash mismatch.
7. Add a valid-but-absent commit-ID ancestry control expecting Git exit 128.
8. Document that Git-context/prelaunch/started-marker commits postdate the provenance database `HEAD`; importing them afterward is forbidden.

These requirements strengthen enforcement without altering the amendment's outcome-independent decision logic. This is an accepting, not qualified, review.
