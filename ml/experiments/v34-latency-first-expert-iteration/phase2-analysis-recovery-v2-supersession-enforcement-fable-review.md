# Fable review of V34 Phase 2 recovery v2 supersession enforcement

Reviewed commit: `94e7b7832b26079e038076245959a7bbbb9c1fea`

## Verdict: REJECT

Gap 1 is fully closed; gaps 2 and 3 are only procedurally closed — the tooling at `94e7b78` still permits the superseding authorization to recommit revision 1's exact failure class without mechanical rejection.

What's verified closed:

- Gap 1 (reverse binding) is closed. `validate_embedded_file_record` binds the Git-context manifest's embedded authorization record — path, bytes, SHA-256 — to the exact supplied authorization, and likewise the inventory record. Supplying the preserved revision-1 manifest with a superseding authorization now fails deterministically.

Concrete remaining blockers:

1. Revision-1 Git-DB reuse is not mechanically excluded. The generator accepts any self-consistent manifest/DB pair; it must reject the revision-1 lineage or require ancestry through a post-revision-1 commit such as `94e7b78`.
2. Lineage-unique one-shot paths are unverifiable. Nothing loads the revision-1 authorization to assert path disjointness.
3. The supersession bindings are reviewer-enforced only. `validate_authorization` must require bound-file labels for the revision-1 incident, amended plan, corrected generator, and preserved revision-1 Git-context manifest/inventory, plus a machine-checkable revision-1 disposition that pins the exact revision-1 authorization record.

The incident record itself is accurate and outcome-blind. The review read no Phase 2 completion, report, replay, analysis, or outcome artifact.
