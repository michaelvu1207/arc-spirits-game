# V28 Fable plan review

Reviewed with Claude Fable at high effort before implementation.

The review identified these material issues in the first draft:

- The terminal-credit mechanism needed direct treatment-versus-anchor tests, not only comparisons with V23.
- Different stage-2 seeds would confound outcome coefficient with randomness.
- A 512-game block had weak power for simultaneous confidence gates.
- Teacher/student temperature semantics needed to rule out double-tempering.
- Offline policy-gradient drift needed importance correction and an in-training trust gate.
- The hidden confirmation block needed a preregistered pass criterion.
- Non-finite stage-2 runs must be invalid, not silently restored.
- The ordinary value target and rare-state KL guard needed explicit definitions.

All of those changes are incorporated in `protocol.json`. The review also noted
that correcting across three variants was overly conservative when there are
only two treatment claims; V28 therefore uses simultaneous 97.5% intervals and
Holm correction across the two treatment-versus-anchor comparisons.
