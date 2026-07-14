# V29 Fable plan review

Reviewed with Claude Fable at high effort before implementation.

The review found that the first draft needed:

- an explicit strategic-row fidelity gate because terminal credit operates on that subgroup;
- a larger preregistered epoch budget with early stopping instead of likely needing a post-hoc extension;
- separate validation selection and gate sets;
- a policy-only d128 arm to test shared-trunk critic interference;
- explicit treatment of fresh-Adam transients;
- a quantitative encoder-alias definition;
- explicit diagnostic/checkpoint artifacts and per-epoch metrics; and
- clarity on d256 latency and the failure path if fidelity and latency disagree.

Those changes are incorporated in `protocol.json`. The suggested seed replicate
was not added because the warm d128 arms have a byte-identical start and fixed
row order, while d256 is a pragmatic eligibility arm rather than a causal width
claim. Any selected checkpoint must still pass a fresh-seed strength protocol;
V29 alone cannot establish playing strength.
