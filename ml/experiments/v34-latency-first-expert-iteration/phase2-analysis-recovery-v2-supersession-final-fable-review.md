# Final Fable review of V34 Phase 2 recovery v2 supersession

Reviewed commit: `1c04a4e`

## Verdict: ACCEPT

No remaining blockers. All three gaps from the `94e7b78` REJECT are now mechanically closed in commit `1c04a4e`'s tooling, and the earlier reverse-binding fix is retained:

1. Revision-1 Git-DB/HEAD reuse is fail-closed, redundantly. The launcher rejects the revision-1 Git directory and pins `requiredAncestryCommit` to `94e7b78`, a post-revision-1 commit. The preflight independently rejects the revision-1 Git directory and HEAD `d5535bc`, and enforces strict descendance of the floor with positive ancestry and reverse-negative controls. A path-aliased copy of the revision-1 DB also fails the ancestry floor.
2. Path disjointness is verifiable and enforced. The constants match all seven paths in the actual revision-1 authorization. Every new resolved one-shot path must be unique and disjoint; the revision-1 authorization path and Git directory are separately forbidden. The canonical `analysisOutput` correctly remains shared and absent because revision 1 never created it.
3. Supersession bindings are machine-checked. `validate_authorization` requires exact bound records for the revision-1 authorization, incident, Git-context manifest, inventory, amended plan, corrected generator, both test files, and this final Fable review. Runtime validation re-hashes each. The revision-1 disposition must equal the exact object: Git context created, nothing prelaunch-or-later, zero analyzer processes, immutable and abandoned.
4. Outcome-blind ACCEPT is mandatory. The decision object must exactly record `ACCEPT`, no remaining gaps, and no outcome artifact read by the reviewer.

The corrected generator derives HEAD/ref only from the hash-bound Git-context manifest and reverse-binds the manifest's authorization and inventory records to the supplied files. Unit tests cover each rejection class.

Non-blocking observations: Git-directory comparisons use string equality, but the ancestry floor backstops aliases; and there is no dedicated test mutating `requiredAncestryCommit`, although the enforced lineage-policy equality exercises the same value. Neither permits recommitting the revision-1 failure class.

This review read only launcher/preflight code and tests, the v2 plan, prior Fable review, and revision-1 incident/Git-context/authorization metadata. No Phase 2 completion, report, replay, analysis, or outcome artifact was read.
