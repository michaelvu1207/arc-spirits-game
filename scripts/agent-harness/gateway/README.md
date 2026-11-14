# Local model gateway for the agent harness

A local **omp auth gateway** (`omp-starline auth-gateway serve`) gives the harness an
OpenAI-compatible HTTP endpoint for `gpt-6.1-sol` on a ChatGPT/Codex subscription, without a
`codex` process per call. The gateway gets its credentials from Michael's omp auth broker
(simforge-laptop) and is **pinned to one Codex account** through an account pool file.

- Binds to `127.0.0.1` only (default port 4610). No launchd job: a plain background process.
- Runs with its own HOME (`~/.local/share/arcspirits-agent-gateway/home`), so it does not write
  to `~/.omp`, `~/.codex` or anything on the simforge-laptop. It only **reads** the broker URL and
  token from `~/.omp/agent/config.yml` (or from `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`).
- No secret is in this repo. The gateway token is a file the gateway creates outside the repo
  (mode 600); clients read it.

## Start and stop

```bash
# First start: choose the Codex account (an email on the broker). Saved for later starts.
scripts/agent-harness/gateway/start.sh --account <email>

# Later starts reuse the saved account
scripts/agent-harness/gateway/start.sh

scripts/agent-harness/gateway/stop.sh
```

`start.sh` prints the base URL, the token file, the pinned account and whether
`openai-codex/gpt-6.1-sol` is listed. It does nothing if the gateway is already running.

| setting (env)            | default                                       |
| ------------------------ | --------------------------------------------- |
| `ARC_GATEWAY_PORT`       | `4610`                                        |
| `ARC_GATEWAY_STATE_DIR`  | `~/.local/share/arcspirits-agent-gateway`     |
| `ARC_GATEWAY_OMP_BIN`    | `~/.local/bin/omp-starline` (needs 18.4.9+)   |
| `ARC_GATEWAY_ACCOUNT`    | same as `--account`                           |

Files in the state dir: `pool.json` (account pool), `gateway.pid`, `gateway.log`,
`home/.omp/auth-gateway.token` (the token), `home/.omp/logs/` (omp logs, one line per request).

## Account pool

`pool.json` maps each OAuth provider on the broker to the `identityKey`s this gateway may use:
`openai-codex` = only the chosen account; every other OAuth provider (anthropic, cursor, …) = `[]`
(hidden). API-key credentials (OpenRouter) stay visible by omp design, so always send a
provider-qualified model id (`openai-codex/...`). The pool is routing, not a security boundary:
the gateway process still holds the broker token.

## Client contract

- Base URL: `ARC_GATEWAY_URL=http://127.0.0.1:4610/v1`
- Token: read the file at `ARC_GATEWAY_TOKEN_FILE=~/.local/share/arcspirits-agent-gateway/home/.omp/auth-gateway.token`
  and send `Authorization: Bearer <token>`.
- Model: `openai-codex/gpt-6.1-sol`.
- Session key: `prompt_cache_key` (one per seat per game, for example `<run>:<game>:<seat>`).
  It keeps a conversation on one account and makes the provider cache the shared prefix.

Chat Completions (`POST /v1/chat/completions`):

```json
{
  "model": "openai-codex/gpt-6.1-sol",
  "reasoning_effort": "high",
  "prompt_cache_key": "run1:g0:red",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

Usage is in `usage.prompt_tokens`, `usage.prompt_tokens_details.cached_tokens`,
`usage.completion_tokens`, `usage.completion_tokens_details.reasoning_tokens`. The
`x-litellm-response-cost` header is a list-price estimate only (the subscription has no per-token bill).

Responses (`POST /v1/responses`): same model, `"reasoning": {"effort": "high"}`,
`"prompt_cache_key"`, `"instructions"` and `"input"`.

The gateway does not keep the conversation: send the full message history each turn.
Do not send sampling fields (`temperature`, `top_p`): the Codex backend does not accept them and
the gateway drops them.

## Checks

```bash
B=http://127.0.0.1:4610; T=$(cat ~/.local/share/arcspirits-agent-gateway/home/.omp/auth-gateway.token)
curl -s $B/healthz
curl -s -H "Authorization: Bearer $T" $B/v1/models | jq -r '.data[].id' | grep openai-codex
curl -s -H "Authorization: Bearer $T" $B/v1/credentials/check | jq '.credentials[] | {id, provider, email, ok}'
```

`/v1/credentials/check` and `/v1/usage` show only the pinned Codex account.

## Notes

- A usage-limit error on the pinned account cannot fail over (the pool has one account): the
  harness must stop or back off. "Selected model is at capacity" is a server condition; retry later.
- Usage-limit blocks are stored on the broker and apply to every omp client of that account.
- To change the account: `stop.sh`, then `start.sh --account <other email>`.
