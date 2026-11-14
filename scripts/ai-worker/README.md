# AI worker (laptop)

Plays the "AI player" seats of arcspirits.com with Claude. A host adds one in a room lobby
with "+ Add AI" (shown only when the site has `ARC_AI_WORKER_KEY`). The worker polls
`/api/ai/pending`, asks the model through this laptop's claude-cli gateway
(`~/arcspirits-harness/gateway/claude-cli`, so the calls use the laptop's Claude subscription),
and posts the answer to `/api/ai/act`. If the worker is off or slow, the site lets the built-in
bot play the seat after `ARC_AI_SEAT_TIMEOUT_MS` (default 90 s), so a game never hangs.

Run (gateway running on port 4620):

    ARC_AI_WORKER_KEY=<same value as on the site> node scripts/ai-worker/worker.mjs

Optional env: `ARC_SITE_URL` (https://arcspirits.com), `ARC_AI_GATEWAY_URL`
(http://127.0.0.1:4620/v1), `ARC_AI_GATEWAY_TOKEN_FILE`
(~/.local/share/arcspirits-claude-cli/laptop/token), `ARC_AI_MODEL` (anthropic/claude-opus-5-5),
`ARC_AI_EFFORT` (medium). It refuses Fable models, runs at most 4 calls at once, and logs one
line per decision, never keys, tokens or prompts. Stop with Ctrl+C.
