# V25 Solo Strategic-Decision Ceiling Audit

## Decision and target

V24 proved that perfecting ambiguous monster-reward choices cannot fix the solo bot. A fair
terminal teacher acted in every one of 512 fresh paired games and lost 288–292 (delta -0.78 points,
95% interval -2.93 to +1.37), with slightly worse final VP and post-15 pace. No V24 PPO run is
justified. The strongest frozen solo checkpoint remains V23 control generation 5 at 58.74% on its
4,096-game held-out block. The simulator ends at round 30, so the user's requested win by round 35
is evaluated at the stricter real round-30 cap.

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
justify a family pilot. Coverage is decided here, not reused as a treatment-effect criterion.

Cap a family pilot at 500,000 terminal candidate rollouts and 45 minutes of aggregate 32-shard wall
time. If full navigation exceeds that estimate, preregister and report a narrower support before
running: round 6 or later and top-two frozen-policy destination logits within 1.5. This is explicitly
an uncertainty-filtered navigation ceiling, not evidence about every navigation choice.

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
one preregistered 64-game extension before rejection. If both families are positive but neither
survives its individual gate, run one 64-game combined pilot because destination and arrival actions
can interact; do not otherwise combine them.

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

## Artifact and promotion contract

Use seed blocks disjoint from V22–V24 training, development, teacher, and held-out blocks. Store the
source commit, checkpoint/catalog SHA-256, full environment configuration, shard manifests, raw
paired outcomes, bootstrap code/version, and wall time. Preserve unrelated SimForge processes and
paired seeds. A solo improvement is not production-promotable until multiplayer gauntlet,
exploitability, collusion, hidden-information invariance, regression, and Michael live-play gates
all pass.
