# Agent player harness (version 2)

LLM agents sit at a 2–4 seat Arc Spirits table and play full games through text. Each seat
gets every decision a human player gets, sees only its own view of the table, and answers with
one action id and a short reason. Games run headless and local, against the real reducer.

- Code: `src/lib/play/agents/` (engine-facing library) and `scripts/agent-harness/run.ts` (CLI).
- Tests: `npx vitest run src/lib/play/agents` (offline, about 5 s; the Codex tests use a fake
  `codex` binary).
- No database. No network, except through the model a seat uses (Codex CLI or OpenRouter).
- Default real provider: the local **Codex CLI** (`codex exec`, the ChatGPT/Codex subscription
  login, model `gpt-6.1-sol`). No API key, no per-token bill.

## Quick start

```bash
# Offline: two mock seats, one game, local design catalog (~/ArcSpiritsArt/game, read only)
npx tsx scripts/agent-harness/run.ts --seats mock:random,mock:greedy

# A batch: 4 seats, 10 games, seat order rotates each game (fair seat positions)
npx tsx scripts/agent-harness/run.ts --seats mock:greedy,mock:random,mock:greedy,mock:first --games 10 --rotate

# Real model through the Codex CLI (logged in; gpt-6.1-sol on the subscription)
npx tsx scripts/agent-harness/run.ts --seats codex,codex --max-decisions 200
npx tsx scripts/agent-harness/run.ts --seats codex:gpt-6.1-sol,mock:greedy --codex-effort medium  # default effort: high

# Real model through OpenRouter (needs OPENROUTER_API_KEY in the environment; never written anywhere)
npx tsx scripts/agent-harness/run.ts --seats or:openai/gpt-4o-mini,mock:greedy --max-spend 1

# Replay a transcript (engine only, no model calls); exit code 1 if the final state differs
npx tsx scripts/agent-harness/run.ts --replay output/agent-harness/<run>/game-0.jsonl

# Print the rules brief the agents get
npx tsx scripts/agent-harness/run.ts --brief
```

Seat specs: `gw` (= `gw:openai-codex/gpt-6.1-sol`, local gateway), `codex` (= `codex:gpt-6.1-sol`), `codex:<model>`, a bare model id (= codex),
`mock:random`, `mock:greedy`, `mock:first`, `or:<OpenRouter model id>`.

| option                                        | default                                                              | meaning                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--seats`                                     | `mock:random,mock:random`                                            | 2–4 seat specs, in seat order (Red, Blue, Orange, Green)                                                                     |
| `--games`, `--seed`, `--rotate`               | 1, 1, off                                                            | game N uses seed `seed+N`; `--rotate` shifts the seat order each game                                                        |
| `--catalog`                                   | `local`                                                              | `local` (design JSON, falls back to `frozen`), `frozen` (`ml/catalog.json`), a design dir, or a PlayCatalog JSON file        |
| `--max-spend`                                 | `0.25`                                                               | USD for the whole run                                                                                                        |
| `--max-tokens`, `--max-calls`                 | 2,000,000 tokens / 5000 calls with an OpenRouter seat; else no limit | run-wide caps                                                                                                                |
| `--max-decisions`                             | 3000                                                                 | decisions per game (all seats)                                                                                               |
| `--max-phase-decisions`                       | 30                                                                   | decisions per seat per phase; then the seat yields                                                                           |
| `--max-output-tokens`, `--temperature`        | 200, provider default                                                | per call                                                                                                                     |
| `--ask-forced`                                | off                                                                  | also ask the agent when only one action is legal                                                                             |
| `--no-parallel`                               | off                                                                  | ask navigation decisions one seat at a time (default: in parallel)                                                           |
| `--codex-effort`                              | `high`                                                               | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`)                                                                    |
| `--codex-session`                             | `resume`                                                             | `resume`: one Codex thread per seat per game; `fresh`: a new stateless process per call                                      |
| `--codex-timeout`, `--codex-concurrency`      | 300 s, = `--max-concurrent-calls`                                    | per call; codex processes at once                                                                                            |
| `--parallel-games`, `--max-concurrent-calls`  | 1, 8                                                                 | games at once in one process; model calls in flight across the run (back-off on limits)                                      |
| `--max-limit-failures`                        | 3                                                                    | calls that gave up on rate/usage limits before the run stops                                                                 |
| `--gw-urls`, `--gw-token-file`, `--gw-effort` | 127.0.0.1:4610, gateway token file, high                             | gateway seats (`gw`, `gw:openai-codex/<model>`)                                                                              |
| `--gw-api`                                    | `responses`                                                          | `responses` (`reasoning.effort`; effort measurably reaches the model) or `chat` (`reasoning_effort`; little effect measured) |
| `--tournament`, `--pair-games`                | -, 2                                                                 | 2-seat round robin of the given seat specs; each pair plays N games, seats swapped, same seed                                |
| `--usage-check-games`, `--usage-max-percent`  | 4, 25                                                                | gateway quota check after the first N games; stop when the account is blocked or used more than this % of the 7-day window   |
| `--out`, `--run-id`                           | `output/agent-harness`, a timestamp                                  | output folder                                                                                                                |

## What an agent gets for each decision

1. **Rules brief** (first system message, the same bytes for the whole run, so providers can
   cache it). `rulesBrief.ts` builds it: a short core-rules part written from the engine and
   the docs, plus card text generated from the catalog and the engine's own tables (locations
   and their actions, monster decks, Navigation Powers, relic tools, origin rewards, every
   class breakpoint text, every spirit). No strategy advice. Its sha256 goes in each header.
   The "rules brief" tests in `agents.test.ts` and `preview.test.ts` compare the hand-written
   statements (start Barrier, starting items, power draft, summon sizes, Rest capped at Max
   Barrier, which items pay "Any basic rune", a hit equal to your Barrier corrupts) with a real
   game, so an engine change fails a test. The "On Rest" class list is generated from the
   catalog.
2. **Its own view** (`view.ts`), rendered only from `buildSessionProjection(state, viewer)` —
   the same per-viewer redaction the server sends a human client. Other seats' secret
   destinations, committed powers, monster hands and reveals, hand draws, power cards, decision
   cards, rewards, unplaced augments and all bag orders are not in it.
3. **Recent events** (`events.ts`), each with an audience: public lines come from diffs of
   spectator projections (VP, status, Barrier, dice, spirits, revealed destinations, combat
   logs); private lines (your own action and its engine log) go only to you. A lock shows to
   others as "Blue locked a destination."; the reveal names everyone's destination.
4. **Pace** (`preview.ts` `paceLine`): round R of the engine's round cap, its VP, the VP to go
   and the VP per round that needs (facts only).
5. **Engine facts** (`preview.ts`), computed by the reducer on COPIES of the state, never by
   hand-written rules:
   - navigation: a DESTINATION PREVIEW. For each destination the seat alone is placed there in
     the Location phase and every location action is tried with `applyGameCommand`: legal →
     its effect on the seat's own Barrier, Max Barrier, VP, dice, items and Powers (dry run,
     e.g. "Rest: no change", "pay Any Rune; Powers held 0→1"); illegal → the reducer's own error
     ("You need a held Power to replace") and the items the seat holds that pay the cost. At
     the Abyss: whether a monster draw is possible, and the monster facts below;
   - monster facts (navigation, Abyss location turns, and revealed cards): each card is fought
     12 times with the engine's `fightMonster` on copies: "its hit vs your Barrier 4: you are
     corrupted before you strike (you deal 0 damage) in all 12 trials", or how often the seat
     survives and kills it; in navigation also with each held Power committed.
     Hidden information: dry runs use fixed practice seeds made from public data (round, seat,
     trial), never the real RNG; anything from a bag, a deck or the RNG is shown only as a count
     or "random". A test changes the other seat's secrets, every bag order and the real RNG and
     checks that the preview does not change. Building a preview takes about 10 ms.
6. **Legal actions** with short ids (`a1`, `a2`, …) and plain-language labels. Each action also
   has the canonical `arc-bot-v1` id (canonical JSON of the command) in the transcript.

It answers `{"action": "a3", "reason": "<1-3 sentences>"}`. An invalid answer gets ONE repair turn (the error
and the valid ids). A second invalid answer → safe fallback: yield if legal, else the
decline/keep option, else the first legal action. Repairs, fallbacks and every raw answer are
recorded.

### The action surface (`actionSurface.ts`)

It reuses `ml/actions.ts` `enumerateCandidates` and filters every candidate through the reducer
(`canApply`, then a dry-run `applyGameCommand`). It adds what the bots leave to autopilots:

- Navigation Powers: the opening and bought power drafts (all 3 cards; with replacement), every
  option of every power offer (including the mandatory Stone Shelter answer), trade answers,
  one-for-one Shared Current proposals, and a held power committed with the destination;
- Abyss monster cards: which deck to draw from, which revealed card to keep;
- decision cards in every phase (Rider and Falconer cards come in the Location phase; the ML
  surface offers them only in Awakening), with dice pickers expanded per distinct tier set
  (Sentinel, Arcane Alchemist); relic tools (keep / 2 VP / effect);
- augment placement in every phase; every "or" option of a location row; monster rewards once
  per distinct rune choice; Cursed Spirit "Corrupt" rune picks.

Forced moves (one legal action) are applied without a model call and recorded as `forced`.
Use `--ask-forced` to send them too.

## Records (reproducible benchmark seed)

Per run folder: `game-<i>.jsonl`, `summary.json`, `summary.md`.

- `header`: run/game ids, seed, seats (guardian, controller, model), catalog source + sha256,
  rules-brief sha256 and text, prompt/contract/harness versions, git commit + dirty-file count,
  options and budget limits.
- `decision`: seat, round, phase, kind, the exact user message (`prompt`), offered actions
  (id, canonical id, label), chosen action, reason, flags (`forced`, `phaseCapped`,
  `repaired`, `fallback`), every attempt (raw text ≤2000 chars, parse error, latency, tokens,
  cost, served model).
- `stale`: a parallel navigation answer that was not applied (see the Codex section).
- `advance`: the harness forced the phase machine on (the navigation reveal, or no seat can
  act), the same call the server's deadline enforcement makes.
- `result`: the summary and the final state hash.

The game summary has: winner, rounds, stop reason (`finished`, `budget`, `decision-cap`,
`stalled`, `reducer-rejection`, `provider-errors`, `aborted`), and per seat: final VP, VP by round, the first round
at Tainted/Corrupt/Fallen, corruptions, monster fights and kills, PvP attacks, final origin and
class counts, dice, Max Barrier, decisions by kind, invalid answers, repairs, fallbacks, tokens
(prompt, cached prompt, completion, reasoning — when the provider reports them; Codex and the
gateway do), cost, latency, session restarts, and the input tokens of the last/largest call. `summary.md` adds a per-model table (wins, average VP, average Fallen round,
kills, PvP, invalid answers, fallbacks, cost, latency).

Replays are exact: the engine is deterministic for a seed and a command list (the one
wall-clock field, the engine `gameId` timestamp, is normalized in `setup.ts`).

## Cost notes

Measured with the mock provider (4 chars ≈ 1 token) on the local catalog, 4 seats:
about 430 asked decisions per 30-round game (measured when the round cap was 30; it is now the engine's `MAX_ROUNDS`, 40), about 5,600 prompt tokens per call (the brief is
≈4,700 of them), so ≈2.4 M prompt tokens per game. At $0.15 per M input tokens that is ≈$0.36
per game before caching. The brief is a fixed prefix: OpenAI, DeepSeek and Grok models cache it
automatically; the provider marks it with `cache_control` for `anthropic/*` and `google/*`.

The budget guard is run-wide and is checked BEFORE each call: a call is refused when spend so
far plus the larger of (the provider's upper-bound estimate for this call, the most expensive
call so far) would pass `--max-spend`. The estimate uses the model's list price from
`GET /api/v1/models`; an unknown price counts as $10 / $30 per M tokens. OpenRouter's reported
`cost` (credits, 1 credit = 1 USD) is used when present. Every HTTP request counts as a call,
retries included. A request that fails without an HTTP status (timeout, broken connection) may
have been billed, so its estimate is added to the spend; a timed-out request is not sent again.
A provider failure is retried once as is (no repair turn) and is counted as `providerErrors`,
not as an invalid answer. All CLI numbers are checked (a value like `1usd` stops the run), and
each run gets its own folder (`run-<time>-<random>`; an existing folder is refused).

## The Codex provider (`providers/codex.ts`)

Each seat is a **Codex session**: the first decision of a seat starts a thread with `codex exec`,
every later decision (and every repair turn) continues it with `codex exec resume <thread>`.
The seat keeps its memory of the game (its earlier views, choices and reasons) like a player at
the table; each new message still carries the full current view, so nothing depends on memory
for correctness. **One session per seat for the whole game**: no restart by turn count. The
user's `model_context_window` (872k) and `model_auto_compact_token_limit` (780k) are read from
`~/.codex/config.toml` and passed with `-c` (because `--ignore-user-config` drops them); Codex
compacts inside the same session if it ever gets there. The only restart: a thread whose
context is full, or that failed twice in a row (one failure keeps it, so a network drop does
not cost the seat its memory), is replaced by a new thread; its first message says so and
carries the full current view, the brief stays the system prompt, and the attempt records
`session: {event: 'restarted', reason}` (the seat summary counts `sessionRestarts`). Every
attempt records its thread id and `started`/`resumed`; seat summaries record the input tokens
of the last and largest call (the session's context size).

Isolation (nothing in `~/.codex` is changed; only the login is used):

- **No tools.** Codex takes a model's tools from its catalog entry (`tool_mode`, `shell_type`,
  multi-agent), and `--disable <feature>` alone does not remove them: with every tool feature
  off, gpt-6.1-sol still had `exec`, `wait` and sub-agent tools. So the provider writes a
  private copy of the user's model catalog (`model_catalog_json` from `~/.codex/config.toml`,
  read only) with every tool field off and passes that copy. Checked live: the model reports no
  tools, and when asked to run `ls /` it makes no tool call. The tool features are also
  disabled, as a second layer.
- `--ignore-user-config` (no MCP servers, hooks, notify scripts or full-access sandbox from
  the user's config), `-s read-only`, an empty temp working directory, web search off,
  approvals never; skills, permission, environment and collaboration-mode instructions off.
- The rules brief is `model_instructions_file` (it replaces Codex's coding-agent prompt), with a
  short preface: no tools, answer one JSON object. Codex still adds the user's global
  `~/.codex/AGENTS.md` (only another `CODEX_HOME` would drop it, and that needs a copy of the
  login); the preface tells the seat to ignore it, and with no tools it cannot act on it.
- `--output-schema` forces `{"action", "reason"}`. stdin is closed (the CLI waits for it
  otherwise). A hard timeout kills the whole process group (the `codex` on PATH is a Node
  wrapper around the native binary). Only `--json` events are parsed (thread id, last agent
  message, usage); the banner is never read.

Tokens: `turn.completed` reports the thread's running totals, so each call records the
difference (input includes the cached part). Cost is 0. Session files go to the normal Codex
history (`~/.codex/sessions`), one per seat per game; `summary.json` lists the thread ids.
Plan limits, login and unknown-model errors are not retried, and a game stops with
`provider-errors` when a seat gets no answer for 3 decisions in a row.

Navigation (the secret destination choice) is the one truly simultaneous decision: the runner
asks all seats at once from the same state and applies the answers in seat order. An answer that
another seat's move made out of date is recorded as `stale` and that seat is asked again.
Parallel calls hold a budget reservation, so they cannot pass a cap together.

The answer is returned as soon as `turn.completed` arrives; the process then saves its session
file and exits by itself, and the next resume of that seat waits for the exit. Each attempt
records `timing: {startupMs, turnMs}` (process start → turn start, and the model turn).

## Many games at once (`--parallel-games`)

`--games N --parallel-games K` runs K games at the same time in one process (a pool takes
game indices in order). All seats of all games share one `CallGate` (`callGate.ts`):
`--max-concurrent-calls` (default 8) model calls in flight at most, and on a rate or usage
limit (429, "rate limit", "usage limit", quota) the gate pauses ALL new calls (5 s, 10 s, …
up to 120 s, with jitter) and retries the same call up to 6 times before the seat sees the
error. Codex processes at once follow the same cap unless `--codex-concurrency` is given.
Transcripts are streamed to disk (`JsonlStreamSink`, one open file per running game); only the
small game summaries stay in memory. A progress line every 30 s shows games done/running,
decisions, calls in flight and queued, limit pauses, tokens and RSS; `summary.json` gets
`runStats` (wall time, peak RSS, gate stats). A `budget` or `provider-errors` stop ends the
launch of new games. The engine work is synchronous on one thread (about 1.7 s of CPU per full
2-seat mock game, previews included), so with real models the model latency is the limit.
The runner yields to the event loop every 16 decisions, so file writes and timers keep running
even when offline mock seats never wait for I/O.

Measured on this Mac (codex-cli 0.162.1, gpt-6.1-sol, 2026-11-12):

| run                  | calls | in flight | process start → turn start (median) | model turn (median) | call (median) | limit errors |
| -------------------- | ----- | --------- | ----------------------------------- | ------------------- | ------------- | ------------ |
| 4 games, low effort  | 131   | ≤ 8       | 0.39 s                              | 4.4 s               | 5.2 s         | 0            |
| 16 games, low effort | 187   | ≤ 32      | 1.4 s                               | 5.9 s               | 10.1 s        | 0            |

The process cost per call is about 0.4 s to start plus about 0.4 s to exit (the answer is
returned before the exit), about 12% of a low-effort call. At 32 processes the Mac itself
slows down (start 1.4 s, call 10 s) before the subscription returned any limit error, so a
process per call does not scale to hundreds of games. `codex app-server` (JSON-RPC over stdio:
`thread/start`, `turn/start` with `effort` and `outputSchema`) would keep one process per seat
or a pool, but it has no `--ignore-user-config`: it would load the user's config with its MCP
servers (including Supabase), so it was not started. The route for hundreds of games is the
`gw:` provider below (HTTP, no process per call).

## The gateway provider (`gw:`, `providers/gateway.ts`)

The local omp auth gateway (`scripts/agent-harness/gateway/`, started with `start.sh`; owned by
another agent) is an OpenAI-compatible endpoint on 127.0.0.1 pinned to one subscription account.

```bash
scripts/agent-harness/gateway/start.sh            # once
npx tsx scripts/agent-harness/run.ts --seats gw,gw                       # one full game
npx tsx scripts/agent-harness/run.ts --seats gw,gw --games 20 --parallel-games 4 --max-concurrent-calls 8
```

- URL: `--gw-urls` (comma list) or `ARC_GATEWAY_URL`, default `http://127.0.0.1:4610/v1`. Each
  game is pinned to one URL of the list (hash of the game id).
- Token: the file in `--gw-token-file` / `ARC_GATEWAY_TOKEN_FILE` (default the gateway's own
  token file), read once, kept in memory, sent as `Authorization: Bearer …`, redacted from every
  error, never written to a record.
- Model: only `openai-codex/…` ids (default `openai-codex/gpt-6.1-sol`); any other id is refused
  before a request is sent, because the gateway also holds a per-token OpenRouter key.
- One continuous conversation per seat for the whole game: the provider keeps each seat's
  history and sends brief + history + the new message on each call, with
  `prompt_cache_key=<run>-g<game>-s<seed>:<seat>` and `reasoning_effort` (`--gw-effort`, default
  high). A failed call adds nothing; a repair adds only the repair message. A finished game's
  conversations are dropped from memory.
- Before a run, `check()` lists the gateway's models (no model call): a stopped gateway gives
  "no gateway at … ; start it with scripts/agent-harness/gateway/start.sh".
- Usage per attempt: prompt, cached prompt (`prompt_tokens_details.cached_tokens`), completion and
  reasoning tokens (`completion_tokens_details.reasoning_tokens`); cost 0.
- One account, no failover: a 429 / usage limit goes to the call gate (shared back-off); after
  `--max-limit-failures` (default 3) calls gave up on limits, the gate stops the run (every later
  call fails at once, games end with `provider-errors`, no new game starts). Keep
  `--max-concurrent-calls` conservative (default 8): a block also hits the owner's own sessions
  on that account.
- Route: `--gw-api responses` (default) sends `instructions`, `input` and
  `reasoning: {effort}`; `chat` sends `messages` and `reasoning_effort`. Measured on a hard
  prompt: responses/high 229–258 reasoning tokens vs 108 at low; chat/high 105–162 vs 96 at low,
  so effort reaches the model through the responses route.
- The run reads the account quota (`/v1/usage`, 7-day window) at the start and after
  `--usage-check-games` games, records both in `summary.json`, and stops launching games when
  the account is blocked or the first games used more than `--usage-max-percent`.
- Measured: a full 2-seat game (chat route) took 16 min, 244 calls at 4.5 s, 98% of the input
  cached, last call 171k tokens.
- Account turn limit: about 200–235 model turns per minute. Above it the gateway answers HTTP 502
  "Codex is at capacity … (code=turn_rate_limit_exceeded)"; the provider maps it to 429. With 36
  calls in flight this gave waves of 150 s pauses. The gate therefore has a rate cap
  (`--max-calls-per-min`, tournament default 150) and an adaptive mode (a limit halves the live
  concurrency, successes raise it again).
- Context: the models' default window is 272k tokens; a 4-seat game can come near it late. Safety
  path only: when the gateway says the context is full, the oldest half of the seat's stored turns
  is dropped and the call is sent again; the attempt records a `restarted` session event with the
  reason (counted in `sessionRestarts`).

- Per-seat effort: `gw:<model>@<effort>` (e.g. `gw:gpt-6-luna@low`); without `@` the seat uses
  `--gw-effort`. One provider per effort; they share the token and the call gate.
- History modes (`--gw-history`): `messages` (plain user/assistant turns), `reasoning` (responses
  route; each earlier answer's encrypted reasoning items go back in `input` with
  `include: ["reasoning.encrypted_content"]`, `store: false`, as the Codex CLI does), `single` (the
  whole conversation so far as text in ONE user message per call: a single-turn request with the
  full memory; every call's text is a prefix of the next, so the cache still works).
- `scripts/agent-harness/reasoning-check.ts` measures reasoning tokens, seconds per call and
  cached input per call on turns 1…N of real seat conversations (gw seat vs `mock:greedy`, one
  seed) for every model × effort × history mode: `calls.jsonl` + `report.md`.
- Measured 2026-11-12 (reasoning tokens per call, turns 2+; in brackets the share of calls with
  any reasoning): low 0 for all four models; medium sol 6, terra 1, astra 0, luna 21; high sol 14
  (15/39), terra 5, astra 7, luna 122 (29/29); turn 1 is 0 too, except luna@high. The history mode
  changes little (sol@high: messages 9, reasoning 13, single 23; cache 88–90% in all three); a
  think-first rule in the system text and a reasoning-summary request change nothing; xhigh: sol 89,
  terra 22, astra 36, luna 209; max: 103–291, reasoning on 6–9 of 9 calls. So through this route
  the models judge most game decisions as easy and spend reasoning only at high/xhigh/max. The
  Codex CLI at high reasoned on every turn (mean 42–59 tokens, 6–12 after turn 50).

## Adaptive tournament (`tournament.ts`, resumable)

```bash
npx tsx scripts/agent-harness/tournament.ts --dir ../tournament/run-1 --catalog ../design-data/game \
  --gw-urls http://127.0.0.1:4610/v1 --gw-token-file <file> --source-file ../SOURCE.json
```

- Entrants (default): 4 models × low/medium/high = 12 `gw:<model>@<effort>` seats. A batch is 6
  rounds; in each round every entrant plays one 4-seat game, so 18 games per batch, 6 per
  entrant. The tables come from a seeded search (`tournament.ts` in `src/lib/play/agents/`):
  every entrant meets all 11 others in a batch, no table is all one model or all one effort, no
  entrant sits twice at a table, and the seat positions even out over the batches (each entrant
  in each position 3 times per 2 batches). Seeds: `--seed` + 1000 × batch + game index.
- Place per game: the engine winner is 1st, the rest by final VP (equal VP share a place).
  Rating: Plackett-Luce on the finishing order (Elo scale), bootstrap 95% intervals over games,
  for entrants, models and efforts; also average place and average VP with intervals.
- Stop rule after each batch: the same rank order as the batch before AND no neighbouring
  intervals overlap → stop. After `--tie-after` batches (6) it stops and shows the entrants that
  cannot be separated as tie groups. Hard stops: `--max-batches` (10); the quota guard (reads
  `/v1/usage` every `--quota-every-min` minutes; stops at a usage limit or when the 7-day window
  reaches `--quota-max-percent`, default 60); the call gate after repeated limit failures.
- Parallel: `--parallel-games 9 --max-concurrent-calls 36` at the start; after
  `--ramp-after-min` minutes without a limit pause it goes to `--ramp-parallel-games 18`,
  `--ramp-calls 72`. The account's turn limit is the real bound: `--max-calls-per-min 150` and
  the adaptive gate keep the run below it.
- Gateway settings: `--gw-history` (default `messages`; the laptop run uses `reasoning`). A
  4-seat game is about 30–40 rounds and 600–850 agent calls; the context of a seat grows about
  7k tokens per round.
- Resume: start it again with the same `--dir`. Finished games (`results/*.json`) are skipped; a
  game that was cut off is played again from its start (its partial transcript moves to
  `games/cut-off/`); a game that ends without a finish (decision cap, stall) is recorded in
  `failed/` and tried once more. The first start writes `config.json` (entrants, seeds, catalog
  hash, rules-brief hash, prompt version, source commit); a resume with other data stops.
- Files: `STATUS.md` / `status.json` (state, pid, batch, games done, calls per minute, quota),
  `standings.md` / `standings.json` (after each game; full bootstrap after each batch),
  `decisions.json` (stop rule per batch), `events.log`, `batches/b001.json` (schedule + balance).
- Laptop scripts (`scripts/agent-harness/tournament/`, copied to `~/arcspirits-harness/tournament/`):
  `resume.sh [run]` starts it in tmux session `arc-<run>` under `caffeinate -is` (survives ssh
  logout) through `run-loop.sh` (restarts after a crash, up to 5 times; a clean stop ends it);
  `status.sh [run]` prints the state, whether the process is alive, and the standings.

## Two-seat round robin (`run.ts --tournament`)

`--tournament gw:gpt-6.1-sol,gw:gpt-6.1-terra,gw:gpt-6-sol,gw:gpt-6-luna --pair-games 2` plays
every pair twice with the seats swapped and the same seed (seed = `--seed` + pair index), to the
real end of each game. `tournament.md` has a row per model (games, wins, win rate, average VP,
average round of a win, kills, corruptions, PvP, illegal-answer rate, seconds per call, input /
cached / output / reasoning tokens per game) and the pair matrix; `summary.json` has the same
data and the schedule. A dozen games is a small sample: read differences with care.

## Strategies, statements and the simulation job (Step 2)

```bash
# One model for all seats (--model, default gw:gpt-6.1-sol); each seat gets one strategy text
npx tsx scripts/agent-harness/run.ts --strategies fire,moon-evil,barrier-hunter,free --rotate --games 4 --gw-effort low
# A finished run folder: build the strategy report again; compare two runs (old data first)
npx tsx scripts/agent-harness/sim/report.ts <run>
npx tsx scripts/agent-harness/sim/compare.ts <old run> <new run>
# The job the data editor starts (detached), and its status
scripts/agent-harness/sim/run-sim.sh --data <design dir> [--baseline <design dir>] --games 4 --effort low
scripts/agent-harness/sim/status.sh [run-id]
```

- Strategies: `strategies.json` (id, name, a 1-2 sentence goal; `free` has no text). The text is a
  second system message after the rules brief, so the brief keeps the same bytes for every seat
  and the decision message does not change; a `free` seat's prompt is byte-identical to a seat
  without a strategy. `--rotate` moves the strategies with the seats. Header and game summary
  record each seat's strategy (`strategy.ts`).
- Statement: with `--strategies`, after each game every model seat is asked once, in its own
  conversation, why it played as it did (`statement` record, also `statement` in the seat
  summary; replay ignores it). Mock seats get a placeholder without a call; a failed call is
  recorded and the game result stands.
- Each run folder keeps its catalog: `catalog/play-catalog.json` (sha256 = the run's catalog hash),
  `catalog/source/*.json` and `catalog/catalog-info.json` (`runCatalog.ts`).
- `strategy-report.{json,md}` (`strategyReport.ts`): per strategy games, wins, win rate, average
  place and VP; spirits and classes collected (by strategy) and never taken; awaken counts; each
  game's winner path (destinations by round, monsters, status rounds, VP by round); statements.
  Every number comes from replaying the transcripts on the run's catalog copy.
- `compare.{json,md}` (`strategyCompare.ts`): changed spirits, classes and monsters by name and
  field; per strategy win rate and VP before/after; per changed card collected / awakened /
  fought before/after.
- `sim/run-sim.sh` (nohup + `caffeinate -i`) runs `sim/sim.ts` into
  `~/arcspirits-harness/runs/<run-id>/`: `status.json`, `new/`, `baseline/` (same seeds, seats and
  strategies; a finished run with the same catalog hash, model, effort, strategies, seeds, decision
  cap and harness version is reused), `compare.{json,md}`. A gateway usage stop ends the job as
  `failed` with that message.

## The league (always playing; `league/`, `src/lib/play/agents/league/`)

```bash
npx tsx scripts/agent-harness/league/league.ts --dir ~/arcspirits-harness/league --init  # league.json + one agent per strategy
scripts/agent-harness/league/start.sh  [dir]   # detached (nohup + caffeinate -i; SIGHUP ignored)
scripts/agent-harness/league/status.sh [dir]   # state, versions, accounts, top of report.md
scripts/agent-harness/league/stop.sh   [dir]   # clean stop; waits for the process to end
```

- Agents are folders `agents/<id>/`: `agent.json` (`name`, `model` = `openai-codex/…`,
  `anthropic/…`, `mock:<policy>` or `default`, `effort`, `memory` = `fresh` | `history`, `learn`), `strategy.md`,
  `notebook.md` (+ `notebook.history.jsonl`). Copy a folder to add one (read at start).
- Fresh-question seats (`memory.ts`): each decision is one request: the brief, the strategy, the
  notebook (system messages), then the seat's plan note and the normal decision message (full
  view, events since its last decision, engine facts, legal actions). No earlier turns. The answer
  may carry `"note"` (≤ 600 characters), recorded as `note` in the decision record. An answer that
  goes stale hands its events back (`EventLog.rewind`), so they are not lost.
- After a game each learning agent gets one notebook call (the end-of-game statement with
  `promptFor`): statement + complete new notebook (≤ 40 lines), saved atomically under a per-agent
  lock; each update appends time, game, data hash, old/new hash and the old text (to undo it). When
  the data changed since the last update, the prompt lists the changed cards.
- Schedule (`league/schedule.ts`): game `i` has seed `seed + i` and the same seats in every data
  version; each agent plays each seat once per block of n games; meetings are spread evenly. A game
  starts when each provider its seats use has a free slot; a game whose provider is full (e.g. the
  one Claude account) waits and later games that fit start meanwhile (look-ahead = agents + all
  slots), so a small account never stalls the others. Which game is which never changes.
- Data versions (`league/versions.ts`): the data dir is hashed every tick; a new catalog hash copies
  the data to `data/<hash12>/`, abandons the old version's running games (`*.abandoned-*.jsonl`) and
  starts the new version at game 0. A data dir that does not load is skipped (status `dataNote`).
- `league.json` (`league/config.ts`): `agentsDir`, `dataDir`, `gateways` (label, url, tokenFile,
  games in flight, `provider` = `openai-codex` (default) or `anthropic`), `mockGamesInFlight`, `defaultModel`, `defaultEffort`, `seed`, `maxGames` (per
  data version; null = endless), `seatsPerGame`, `maxDecisions`, `eventsPerPrompt`, gate settings.
  Gateway accounts, gates and blocked-account handling are the tournament's (`gatewayPool.ts`).
  Model ids must start with `openai-codex/` or `anthropic/` (`GATEWAY_PROVIDERS`; anything else,
  e.g. `openrouter/…`, is refused). A game's seats of one provider share one account of it; Codex
  seats stay pinned to the game's Codex account; an agent whose provider has no gateway fails at
  start. Through the omp gateway, `anthropic/claude-opus-5-5` caches the brief on both routes
  (cached_tokens reported) and reports no separate reasoning tokens.
- History seats (`memory: "history"`): the full game conversation per seat; on the responses route
  the earlier turns' encrypted reasoning goes back (`store: false`), the oldest turns are dropped
  when the context is full, and the end-of-game statement is asked in the same conversation. The
  omp Claude gateway returns no encrypted reasoning, so an `anthropic/` history seat keeps the
  plain conversation only.
- Benchmark (`"benchmark": true`): agents must have `learn: false` and an empty `strategy.md`; the
  report starts with the tournament's Plackett-Luce ratings (95% bootstrap range) by agent, model
  and effort, with games, wins, places, VP, win round, illegal answers, seconds per call and tokens
  per game (from each trace file's `result`). Example folder: `~/arcspirits-harness/benchmark`.
- Files: `status.json`, `events.log`, `league.log`, `versions.json`, `versions/<id>/games/*.jsonl`,
  `versions/<id>/traces/*.json`, `versions/<id>/report.{json,md}`, `report.md` (current version +
  the comparison with the version before, on the games both played).

## How to add a provider

Implement `ChatProvider` (`src/lib/play/agents/providers/types.ts`): `name`,
`complete(request)` → text + tokens + cost, and `estimateCostUsd(request)` (an upper bound;
estimate high when unsure). `request.meta.sessionKey` (`<gameId>:<seat>`) lets a provider with
sessions continue one conversation per seat. Then add a seat spec in `controllerFor` in `run.ts`. An agent that
is not a chat model (a search bot, a human over a socket) implements `SeatController`
(`contract.ts`) directly.

## The seam, and where a live seat attaches later

`contract.ts` defines `arc-agent-v1`: a `DecisionRequest` (the seat's view text, events and
offered actions) and a `SeatController.decide(request) → { actionId, reason }`.
`decision.ts` `buildDecision({ state, seat, catalog, … })` builds the request from the
authoritative state, using only the seat's projection. The harness runner (`runner.ts`) is
one user of this; a live room is the other.

Today bot seats work like this:

- admission: `src/lib/play/server/botSim.ts` `seatOneBot` / `addBot` / `fillBots` →
  `joinRoom(…, { isBot: true, botProfile, admission: 'internal' })`, then `claimSeat` and
  `selectGuardian` as the bot member; `loadBotMembers(sessionId)` maps member id → `bot_profile`;
  `bots/contract.ts` `normalizeBotProfileKey` maps every unknown profile to `neural`;
  `botAvailability.ts` `BOTS_ENABLED` is false now;
- driving, WebSocket server: `server/roomHost.ts` `runTick` step 2 → `server/bots.ts`
  `stepBotSeats` → `planSeatCommands` → `applyBotCommand` inside the room queue, committed
  as one CAS batch per tick; HTTP twin: `botSim.ts` `tickBots` → `runRoomCommand` per command.

An LLM seat attaches there, as follows (not built):

1. Profile: allow a key such as `llm:<model>` in `bots/contract.ts` (`BOT_PROFILE_KEYS` /
   `normalizeBotProfileKey`), stored in `bot_profile` by `seatOneBot`.
2. Driver: in `server/bots.ts` `stepBotSeats`, skip `llm:*` seats. A per-room `AgentSeatDriver`
   (new file next to `server/bots.ts`) runs OUTSIDE the room queue, because a model call takes
   seconds: for each `llm:*` seat with `botSeatNeedsToAct`, take the host's current state,
   `buildDecision(...)`, await `LlmSeatController.decide`, then submit the chosen command
   through the normal player command path as the bot member (`RoomHost` apply with a fresh
   `cmdId` and the snapshot revision). A revision conflict means the state moved: rebuild and
   ask again. This is how a remote human client acts, so the ledger and CAS rules stay as
   they are.
3. Events: keep one `EventLog` per room and feed it from consecutive committed states
   (`recordCommandEvents` / `publicDiff`).
4. Deadlines: `resolvePassedDeadline(…, botSeats)` does not extend for bot seats, and a
   Location phase is 120 s. An LLM seat needs to count as "human" for extensions, or a faster
   model, or several decisions per call.
5. Budget: one `BudgetGuard` per room, the key only in the server environment.

## Benchmarking (next steps)

- Run fixed seed sets with `--rotate` so each model plays each seat; compare per-model rows in
  `summary.json` (`byModel`).
- Keep `promptVersion`, `rulesBriefSha256`, `catalog.hash` and `git.commit` equal across a
  comparison; the header records all four.
- Mix models with the existing neural bot as a baseline seat (a `SeatController` around
  `planNeuralPhaseActions`).

## Known limits (version 2)

- Engine-side optional effects that are applied automatically, so no agent can decline them:
  Druid's extra Exalted die; Smith's extra augment (it can only be thrown away together with
  all unplaced augments); Abyssal Execution defeats the toughest card in hand (no choice of
  card). Combat itself has no mid-fight choices (by design: Sentinel and Relic Sentinel are set
  in advance by decision cards).
- Not offered by the harness surface (engine supports them): the slot for a summoned spirit
  (first open slot), which copy of a rune pays an awaken cost (fungible), Shared Current trades
  with more than one item per side. A long list is cut at 96 actions (`truncated` in the
  record); the cut keeps every yield and at least one action of each kind (each decision-card
  option separately). Identical unplaced augments are offered once.
- While a Navigation Power prompt is open, only its options are offered (the engine also blocks
  other commands at the table while any power offer is open).
- The harness has no clock: an agent has unlimited time per decision. A decision card that
  arrives after a seat has finished its phase is not asked and expires as the engine decides.
- The destination preview places only the acting seat: what other seats do there (PvP, their
  Powers, shared occupancy effects) is secret and not in it. For a row with several ways to
  pay or choose, the effect of the first legal way is shown. Monster trial fights use 12
  practice rolls each: "corrupted before you strike" is exact (no dice involved), kill counts
  are estimates.
- Codex adds the user's global `~/.codex/AGENTS.md` to each seat's context (see the Codex
  section).
