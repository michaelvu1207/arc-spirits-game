# Claude Fable review of the V32 evaluation procedure

Model: Claude Fable
Effort: high
Reviews: two passes on 2026-07-14, before development seeds were opened.

The first pass approved the fail-closed endpoint manifest, paired seed-cluster
analysis and outcome-blind representative requirement, then identified missing
rules for mixed mechanism/representative eligibility, infrastructure retries,
bootstrap reproducibility, multiplicity, late-game definitions, mechanical seed
authorization, hidden manifests, tests and end-to-end dry runs.

The second pass reviewed the policy-medoid revision. It required a global rather
than per-treatment generation-8/12 rule; an explicit all-roots failure policy;
fully frozen hidden statistics; an unambiguous aggregate selection metric; a
V30-only diagnostic; exact latency warm-up/request counts plus a pre-development
smoke test; explicit medoid corpus seeds; and quantification of the guardian
subgroup gate's false-rejection risk. It also noted the accepted limitations of
single-replicate representative gates, repeated 3-point thresholds, conditional
training-seed inference and off-policy medoid states.

All material review points were incorporated into `evaluation-plan.md`:

- selection is over fully qualified mechanism/representative pairs;
- one pre-outcome infrastructure retry is the maximum;
- development uses deterministic 10,000-draw percentile seed-cluster bootstrap
  with seed 320949 and two explicit family-size-two comparison families;
- hidden uses the same frozen method with seed 320950;
- endpoint and hidden launchers require hash-valid authorization manifests;
- generation 12 globally replaces generation 8 if either movement check fails;
- representative selection is an outcome-blind symmetric-KL policy medoid on
  validation seeds 946004096-946005119;
- a V30-only 256-game pipeline diagnostic and shared-critic latency smoke test
  precede development;
- the binding latency test is 20 warm-ups and 200 measured requests per each of
  eight clients;
- guardian point flags trigger one fixed fresh-seed confirmation rather than an
  ad-hoc waiver; and
- integrity failure in any paired root invalidates the entire screen.
