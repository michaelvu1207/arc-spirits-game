# Claude Fable high-effort review

Reviewed `plan.md` on 2026-07-14 before any V33 strength seed was opened.

The reviewer judged the paired seed-cluster analysis, fail-closed gates, seed
hygiene, outcome-blind systems screen, and preservation rules strong. It found
that the core search contract needed more precision before it could be frozen:

1. define the exact real-engine leaf evaluation and how the value/rollout blend
   handles active, terminal, and hidden-root states;
2. state how simulations are allocated across determinizations and verify the
   determinization distribution, not only deterministic replay;
3. vary horizon as well as simulation count so a null is interpretable;
4. increase the dose screen from 2,048 to 4,096 games or explicitly accept low
   power near a three-point effect;
5. acknowledge value-head distribution shift and re-test online search after
   search-state value training;
6. freeze expert-iteration generations, teacher update cadence, target contract,
   training/development seeds, and compute budget; and
7. define the guardian trigger, binding production latency, late-game metric,
   and unique per-game search invocation RNG key.

All material points were incorporated. V33 now uses a real-engine
one-determinization-per-sim Gumbel search; a calibrated `solo-reach30` leaf;
16x4, 16x6, and 32x6 registered doses; a 4,096-game paired screen; exact
guardian and production-latency gates; a three-generation iterative teacher;
preassigned 954M/955M seeds; and an explicit online-search comparison with the
newly trained value head.
