# Rules v1.2 — Fallen corruption shortfall costs VP (2026-07-02)

Requested by Michael after the Phase 2 findings (docs/phase2-report-2026-07-02.md).

## The rule

When a player corrupts **while already Fallen** (statusLevel 3 before the
corruption), the escalating spirit sacrifice still applies — but any part of
the debt the player **cannot pay in spirits is charged as victory points
instead: −1 VP per unpayable spirit**, clamped at 0 VP.

- The corruption that *crosses into* Fallen is exempt (pre-corruption status
  decides — "after fallen", not "on becoming fallen").
- Pre-Fallen corruptions keep the old forgiveness: the shortfall is dropped as
  before. The descent stays cheap; the Fallen treadmill no longer is.
- The payable part still becomes the normal `pendingCorruptionDiscard`
  obligation, settled in cleanup exactly as in v1.1.
- Combat log line: `Corruption while Fallen: N owed sacrifices could not be
  paid in spirits — N VP lost instead.`

## Why

Under v1.1 a Fallen player's Nth corruption owed N discards *capped at spirits
held* — so a spirit-poor Fallen player corrupted essentially for free (full
heal, no cost), which subsidized the corruption→Fallen→+3-PvP treadmill the
balance reports flagged. v1.2 makes late corruption bite: the 5th corruption
of a spirit-less Fallen player now costs 5 VP.

## Implementation

- `src/lib/play/types.ts` `setCorruptionDiscardObligation(player, reason?,
  {wasFallen})` — computes the shortfall before capping, charges VP when
  `wasFallen`, returns the VP charged for logging.
- Call sites pass the PRE-corruption status: `src/lib/play/combat.ts`
  `takeDamage` (the only live corruption path — PvP and monster damage both
  route here) and `runtime.ts` `adjustStatus` (structurally exempt: an upward
  move from Fallen is impossible, flag passed for parity).
- Tests: `src/lib/play/combat.test.ts` "rules v1.2" block (4 cases).

## Eval consequences

- **Gauntlet bumped to v4** (manifest.ts). v3 numbers are historical; the
  anchor pool is unchanged (weights are rules-agnostic), so v4 = v3 schedule
  under v1.2 rules.
- Training shards generated before/after v1.2 must not be mixed (returns and
  VP trajectories changed even though the candidate encoding did not).
