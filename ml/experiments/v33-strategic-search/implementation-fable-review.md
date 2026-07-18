# Claude Fable high-effort implementation review

Reviewed the complete V33 planner, actor, evaluator, systems screen, source
lock, phase-2/guardian/qualification launchers, and paired analyzers on
2026-07-14 before any registered V33 game seed was opened.

Fable judged the Gumbel allocation, completed-Q target, information-set
determinization, hidden-root masking, solo reach-30 leaf, unique invocation
stream, and clustered bootstrap design sound. It found these pre-freeze defects:

1. Bash `read` calls consumed newline-free Node output and would terminate every
   search arm while allowing the raw phase-2 arm to consume its full seed block.
2. Hidden authorization did not explicitly carry the binding one/eight-game
   concurrency latency evidence.
3. Direct Python analyzer invocation could fail its `ml.*` import after games
   completed.
4. An all-ineligible systems result failed before writing immutable evidence.
5. Integrity/replay/serving/provenance gates lacked explicit evidence sources.
6. The source lock omitted much of the engine, observation, actor, and inference
   dependency closure and was not reverified before seed consumption.
7. Reports hashed the local checkpoint argument but not the checkpoint actually
   served by the inference process, and the systems runner did not force or
   attest the binary wire.
8. Phase-3 late-game and guardian tolerances were ambiguous in the protocol.
9. The generic benchmark could derive warm-up seeds inside a registered expert-
   iteration block.

All blocking findings were incorporated before source freeze: newline-safe
shell reads; package/module analyzer execution; immutable no-winner systems
evidence; pre-seed source verification and a broad tracked dependency closure;
server-handshake checkpoint SHA-256 plus wire provenance in every report;
outcome-blind integrity/replay preflight evidence; binding latency rejection
before strength seeds; explicit phase-3 point-estimate and guardian thresholds;
and caller-supplied disjoint warm-up seeds. Fable also warned that policy
self-model rollouts may fail the latency gate because each rollout decision is
a blocking inference call; V33 intentionally measures this before opening the
4,096-game strength screen.
