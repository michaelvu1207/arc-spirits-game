# V25 Solo Strategic-Decision Ceiling Audit

## Decision and target

V24 supplied strong evidence that perfecting ambiguous monster-reward choices cannot fix the solo bot. A fair
terminal teacher acted in every one of 512 fresh paired games and lost 288–292 (delta -0.78 points,
95% interval -2.93 to +1.37), with slightly worse final VP and post-15 pace. No V24 PPO run is
justified. That run was later found to over-weight six of ten guardians because shard-local guardian
cycling restarted in every shard; its uniformly scheduled replication runs before permanent V24
closure. The strongest frozen solo checkpoint remains V23 control generation 5 at 58.74% on its
4,096-game held-out block. The simulator ends at round 30, so the user's requested win by round 35
is evaluated at the stricter real round-30 cap.

On 2026-07-13, the finished human solo reference `7RPYHU` exposed production-catalog drift. Its
119-command stream replays exactly to the recorded round-17, 33-VP win only with live catalog SHA-256
`5f4ad348f6c7add612c736df0f3e00b7d4c821758e0561049f2e550e798c6e2e`; the V23/V25 frozen lane uses
`62203ec1b981c2e59f129db54cf1863639f605f331ed8d7408c53693c941bc59`. Counts and vocabularies are
unchanged, but ten spirit definitions, three class descriptions, and three monster rows differ.
Most materially, production contains corrected Cursed Spirit assignments, wildcard relic typing,
and lower barriers on two stage-one monsters. Frozen-catalog experiments remain valid causal tests
inside their environment, but none may be reported as a production win rate or promoted without a
separate live-catalog qualification.

V25 asks whether the two remaining repeated strategic choice families contain enough causal
headroom to reach 70–80% solo wins:

1. navigation: which public destination to lock each round;
2. meaningful location yield: whether to end Location actions while a legal engine-building,
   conversion, summon, or combat action remains.

This is a ceiling audit first, not a training run. A family is trainable only after a full-game
teacher intervention proves at least an eight-point win-rate gain with a paired interval excluding
small effects.

## 1. Freeze exact decision supports

Generalize the already tested V24 reducer-root terminal evaluator without changing its sanitizer,
common-random-number seeds, hidden-bag reshuffle, terminal outcome, or frozen continuation policy.
The generic evaluator receives explicit indices into the full legal command list, evaluates only
those commands, and maps its chosen local index back to the original list. Keep the reward-specific
wrapper and its tests bit-for-bit compatible.

The two new supports are:

- **navigation:** every legal `lockNavigation` command when at least two destinations are present;
- **meaningful location yield:** only in Location phase, only when no corruption debt, pending
  reward, or mandatory nested decision is active, and only when `endLocationActions` coexists in
  the policy-selectable support with at least one action from a frozen productive allow-list:
  `resolveLocationInteraction`, `attachRuneToSpirit`, `detachRuneFromSpirit`, `absorbSpirit`,
  `infiltratorSwap`, `placeAugmentOnSpirit`, or `startCombat`. Draw/summon, reward, corruption,
  awakening, and nested-decision commands are deliberately absent because their pending states are
  mandatory or belong to another phase. Evaluate the entire selectable support at such a state,
  not merely yield versus the historical action, so the ceiling is not understated.

Fail closed on duplicate command signatures, unsupported hidden bags, non-solo state, invalid root
commands, any stalled rollout, or a selected index outside the frozen support. Candidate order must
not affect rollout seeds, labels, or the canonical selected command. If a terminal estimate is not
decisive under the frozen V24 reach-count/utility margin, the teacher abstains and takes the
historical frozen-policy action; it may not replace a coherent choice with rollout noise.

## 2. Natural-support and cost audit

Run 512 frozen greedy solo games on a new seed block without changing any actions. Record per family:
decision count, games covered, candidates per decision, round/VP bands, historical action type,
historical yield rate, guardians, and estimated terminal rollout work. This establishes that a
teacher result is supported by normal play and chooses a safe shard size before expensive runs.

The occurrence audit must have zero game/action changes versus the frozen baseline, exact checkpoint
and catalog hashes, a source commit, and zero stalls. It may not read dry-run hidden outcomes.
Navigation must naturally occur in at least 90% of games and meaningful yield in at least 15% to
justify a family pilot. In addition, meaningful yield must occur in at least 64 of the 512 audited
games so a 64-game pilot cannot be structurally underpowered by sparse support. Coverage is decided
here, not reused as a treatment-effect criterion. Log every command type excluded at a
yield-eligible state; an unexpected productive command pauses the pilot for an allow-list review.

Cap a family pilot at 500,000 terminal candidate rollouts and 45 minutes of aggregate 32-shard wall
time. If full navigation exceeds that estimate, preregister and report a narrower support before
running: round 6 or later and top-two frozen-policy destination logits within 1.5. This is explicitly
an uncertainty-filtered navigation ceiling, not evidence about every navigation choice. Reserve a
10% deterministic absolute-seed slice for unfiltered navigation so confidently wrong choices are
measured rather than silently removed by the logit-gap filter.

## 3. Independent family ceiling pilots

Run navigation-only and yield-only teacher-in-loop pilots on disjoint 64-game seed blocks with eight
terminal determinizations per candidate. Each teacher uses the same frozen float32 policy and public
state encoding as its paired historical arm. Report paired win flips, final VP, reach-15, 15-to-30
conversion, post-15 pace, first-30 round, stalls, teacher decisions, candidate counts, and wall time.

Advance a family to confirmation only if the pilot gains at least four net paired wins (+6.25
points), does not reduce mean VP or post-15 pace, and has zero resulting-game stalls.
This pilot gate is intentionally permissive enough not to discard a plausible +8-point treatment,
but it prevents a large confirmation run for another flat intervention. Navigation and yield are
screened separately. A family with +2 or +3 net wins and non-regressing secondary metrics receives
one preregistered 64-game extension before rejection; pool the two blocks only after preserving each
verdict separately, then require at least +6.25 percentage points with non-regressing mean VP and
post-15 pace to advance. If both families are positive but neither survives its individual gate,
run one 64-game combined pilot because destination and arrival actions can interact; do not
otherwise combine them.

A flat pilot is a valid test of its teacher only if the support was evaluated in at least 90% of
games, a decisive teacher action changed the frozen policy in at least 50% of games and at least 1%
of evaluated decisions, and candidate terminal-return variance is reported by family and round
band. Otherwise classify it as estimator abstention, not evidence that the strategic family lacks
headroom. The 64-game gate is a screen, not a powered estimate: report the discordant-pair rate, and
do not interpret failure of a small block as a precise zero-effect claim.

Report teacher changes and paired flips by round band. In particular, early-round rollout noise may
not be hidden inside an aggregate result. A stalled or invalid candidate rollout makes that decision
an audited teacher abstention, not a fabricated loss; any resulting-game stall fails the run, and a
candidate-rollout stall rate above 0.1% invalidates the family.

## 4. Confirmation and train/no-train gate

For each pilot survivor, run 512 fresh paired games with 16 determinizations per candidate on a
preregistered seed block. Proceed to label collection or online teacher distillation only if all are
true:

- win-rate delta is at least +8 percentage points;
- paired bootstrap 95% lower bound is at least +4 points;
- mean final VP, reach-15, 15-to-30 conversion, and post-15 pace do not regress;
- every teacher decision stays on its exact support and both arms have zero stalls;
- an independent 8-versus-16 rollout agreement audit is reported; below 70% triggers a 32-rollout
  stability recheck before label collection rather than overruling an otherwise causal game-level
  pass;
- command reordering and hidden-bag permutation invariance tests pass.

Freeze the pilot's exact command support into confirmation. Before launch, estimate the candidate
rollout count and shard wall time; cap confirmation at two million candidate rollouts and 90 minutes
of aggregate 32-shard wall time unless a written amendment preserves the seed block and explains
the new budget.

If a family passes, collect a balanced immutable label set and run the smallest compute-matched
coefficient-zero versus teacher-loss PPO screen, retaining V23's width 256 and function-preserving
V24 observation/action expansion. If both fail, do not reopen reward labels, width 512, latent
options, generic search, continuation replay, or self-imitation: those mechanisms already failed
controlled screens. The next experiment becomes a late-state failure curriculum built from
round-12–20 clean continuation snapshots, with a direct held-out terminal ceiling gate before PPO.

The teacher-in-loop intervention compounds repeated corrections, but every future action inside one
candidate rollout still comes from the frozen policy. A flat V25 result therefore rejects this
particular estimator/intervention, not the existence of all navigation or yield headroom. That
distinction is why the fallback changes the state distribution with a late-failure curriculum
instead of declaring the strategic problem solved.

## 5. Live-catalog and human-reference qualification

Finish any already-started paired frozen-catalog pilot or extension so its causal comparison and
paired seeds remain intact, but never pool outcomes across catalog hashes. Save the production
catalog as an immutable versioned artifact, verify `7RPYHU` still replays with zero rejected commands
and an exact RNG cursor/final state, and rerun the frozen V23 checkpoint on at least 1,024 fresh,
absolute-seed-balanced solo games using that live catalog. Report the live-catalog round-30 win rate,
mean VP, reach-15, post-15 pace, guardian strata, and zero-stall status before choosing the next
treatment. Any V25 family that advances on the old catalog must repeat its pilot on the live catalog
before confirmation or training.

As of discovery of the drift, the yield rescue extension is the only frozen-catalog experiment that
may finish. Run no further frozen-catalog V25 pilot or confirmation. After the extension, qualify the
live V23 checkpoint first and make every new treatment decision from that environment. The corrected
uniform-guardian V24 reward replication remains a historical closure test; schedule it after the
live baseline and run it on the live catalog if the decision is meant to govern production.

Treat `7RPYHU` as held-out human strategy evidence, not a one-episode behavior-cloning set. Its
score line is `0,3,3,6,6,8,10,13,13,13,17,17,17,17,23,23,33`: the player built through multiple
zero-VP rounds, revisited the Abyss ten times, converted at rounds 11, 15, and 17, and finished with
seven spirits and three augments. Use it as a trajectory/regression target for build-to-convert
timing and exact-replay tests. Direct imitation is permitted only after multiple independent human
wins are available, the human games remain disjoint from evaluation, and every training observation
is reconstructed through the same public-information encoder used by the bot.

On the live catalog, run a combined navigation+yield pilot whenever both families show positive
paired deltas with adequate intervention coverage, including when one family individually passes
and the other remains positive below gate. Keep all individual and combined verdicts separate.

## Artifact and promotion contract

Use seed blocks disjoint from V22–V24 training, development, teacher, and held-out blocks. Store the
source commit, checkpoint/catalog SHA-256, full environment configuration, shard manifests, raw
paired outcomes, bootstrap code/version, and wall time. Preserve unrelated SimForge processes and
paired seeds. A solo improvement is not production-promotable until multiplayer gauntlet,
exploitability, collusion, hidden-information invariance, regression, and Michael live-play gates
all pass.

Every reported result is scoped to one exact catalog hash. A production catalog change invalidates
comparability, not the underlying artifact: retain the old result, freeze the new catalog, rerun the
qualification gate, and never silently overwrite `ml/catalog.json` while an experiment is active.

Guardian assignment is a pure function of the absolute game seed, never a shard-local game ordinal.
The first V25 support/pilot artifacts that violated this contract are explicitly retained under
`invalid-guardian-sharding` / `biased-guardian-sharding` names and are excluded from every verdict.
