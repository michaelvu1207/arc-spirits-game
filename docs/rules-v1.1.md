# Rules v1.1 — market family removed (location-commitment fix)

**Change (2026-07-02).** The `takeSpirit`, `replaceSpirit` and `refillMarket`
commands are no longer player actions: the reducer rejects all three with
`unsupported_command` (runtime.ts), `canApply` returns `false` for them
(legality.ts), and they are no longer enumerated as bot candidates
(ml/actions.ts). `selectNavigationDestination` (a legacy, UI-less command)
additionally gained the same gate as `lockNavigation` — pre-reveal Navigation
phase only — closing a latent mid-round destination-switch hole. The market
array remains in state for snapshot compatibility; `startGame` still stocks it,
but it is display-only and inert.

**Why.** A rules-integrity audit (scripts/audit-location-integrity.mjs)
confirmed the location-commitment rule — one locked destination per round,
that location's reward rows and (at the Abyss) monster combat only — is
structurally enforced for `resolveLocationInteraction` and `startCombat`. The
market family, however, sat entirely outside it: no UI dispatch path, no cost,
no phase/destination gate, no once-per-round tracking, and `replaceSpirit`
permanently destroyed the replaced spirit instead of returning it to its bag.
Under the pre-fix ruleset the gen-20 champion built ~99% of its board from
free market takes (≈62 acquisitions/game, 98% while locked to the Arcane
Abyss, vs ≈0.8 real bag summons/game) plus ≈300 `refillMarket` churns/game.
This is what a spectator perceived as a bot "summoning at the Abyss"; the only
legitimate Abyss summon flows are monster-reward "Arcane Abyss Summon" tokens
and the Abyss's own free summon row (live catalog).

**Measurement impact.** Every gauntlet/league/meta number produced before this
change measured the exploitable ruleset and is not comparable to post-v1.1
runs; the gauntlet version bump to v2 lands with the re-baseline. Removing the
market candidates also changed the candidate enumeration ORDER in
`enumerateCandidates`, so BC `chosen` indices recorded pre-v1.1 do not align
with post-v1.1 candidate sets — do not mix shards across the boundary.
Re-verify any weights with `node scripts/audit-location-integrity.mjs`
(expects zero market events and zero invariant violations, exit 0).
