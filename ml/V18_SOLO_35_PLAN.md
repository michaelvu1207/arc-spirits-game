# V18 solo-35 training and certification plan

Objective: produce a bot that reaches 30 VP without deadlocking in at least 70–80% of held-out solo games within the production engine's hard round-30 cap. This is stricter than, and therefore satisfies, the requested within-35-round target: the engine ends after round 30 and cannot enter rounds 31–35. Then retain that long-horizon competence while restoring multiplayer training. A stalled game is always a failure. No checkpoint is promoted from training or development results.

## 1. Select capacity without reusing training seeds

- Finish the causally paired 128-wide and 256-wide branches through generation 30.
- Evaluate both on the same disjoint solo-cap development seeds under greedy and production-temperature decoding.
- Select capacity by paired reach-30-without-stall rate, post-15 VP/round, and compute cost. Treat a statistical tie as evidence to keep the smaller model.

## 2. Warm the reach-30 critic without changing policy behavior

- Freeze the selected policy and generate fresh solo trajectories with the effective engine horizon 30 on a critic-training seed range.
- Train only the reach-30 BCE head (`policy_coef=value_coef=all other aux coefs=0`). Each episode has equal total loss weight regardless of decision count.
- Require policy/value/legacy-aux outputs to remain bit-identical before and after critic warm-up.
- Rerun the frozen policy with the trained head on a disjoint calibration range. Report episode-weighted NLL, Brier, AUROC, AUPRC, ECE/reliability bins, base rate, sharpness, and early/mid/late-round slices. Bootstrap NLL/Brier confidence intervals by whole episode.
- Do not use the critic for policy credit unless held-out calibration beats the constant base-rate predictor and has useful discrimination. Calibration is diagnostic, not a promotion gate by itself.

## 3. Isolate state-dependent policy credit

- Branch control and treatment from the exact same critic-bearing checkpoint.
- Keep reach-30 BCE training identical in both arms; vary only `solo_reach30_coef` (control 0, initial treatment 0.25).
- Use paired actor, environment, and trainer seeds, identical round-30 rollouts, temperature, workers, and generation count. Validate generation-one trajectory parity up to the policy update.
- Run three matched seeds. Select only on a disjoint development block using paired episode differences and episode-cluster bootstrap confidence intervals.

## 4. Escalate only from evidence

- If state-dependent credit improves conversion but remains below 70%, add a continuation curriculum from two logged failure strata: surviving late games below 30 VP and pre-collapse recovery states.
- If it does not improve, test conservative advantage-filtered self-imitation from successful complete games before changing model width again.
- Keep all stalls/deadlocks as losses. Never filter them out of training or certification.

## 5. Final gates and multiplayer transfer

- Untouched final solo block: at least 4,096 games, target lower confidence bound compatible with the 70% goal, zero unexplained stalls, and no guardian-specific collapse.
- Reintroduce 2p, 3p, and 4p training progressively while retaining a fixed solo rehearsal fraction and a solo regression gate.
- Multiplayer held-out gauntlets must cover champion, exploiter, heuristic profiles, late-game post-15 conversion, placement/win rate, corruption/deadlock behavior, and production decoding/search.
- Human play is the final promotion gate. Production remains unchanged until fairness, solo, multiplayer, and human gates all pass.
