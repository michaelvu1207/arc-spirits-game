# Arc Spirits AI test system: plan and handoff

Written 2026-11-12 on the Mac `seablue` (user `maikyon`) for a new session on the Simforge laptop
(ssh host `simforge-laptop`, user `michaelvu-simforge`). Owner: Michael. This is for Michael only:
no public platform, no outside players. Keep it simple.

## Goal

Michael changes game data (spirits, classes, costs) in the Niji Batch data editor, presses
"Run simulation", and gets a report on how AI players played: which strategies they used, which
won, and what the change did. The players run headless on the game engine. No browser.

## The plan (three steps, approved by Michael)

### Step 1: find the best AI (in work)

A tournament through the omp gateway:

- Entrants: 12 = 4 models × 3 efforts. Models: `openai-codex/gpt-6.1-sol`, `gpt-6.1-terra`,
  `gpt-6-astra`, `gpt-6-luna`. Efforts: low, medium, high.
- Games: 4 players each. Batches of 18 games; each entrant plays 6 games per batch. Balanced, seeded
  schedule: seat positions rotate, opponents are mixed, no table is all one model or one effort.
- Each game runs to its real end: a player reaches 30 VP, or round 40 closes.
- Adaptive: after each batch, compute a rating per entrant from the placements, with a 95% range
  (also per model and per effort). Stop when the rank order was the same in the last two batches and
  neighbours' ranges do not overlap. After 6 batches, show entrants that cannot be separated as a
  tie. Hard stops: 10 batches, a usage limit, or 60% of the 7-day quota of the account.
- Parallel: as many games at once as the account permits (start 9 games / 36 calls, then 18 / 72),
  with automatic back-off on limits.
- Before the tournament: one 4-player mock game and one short 4-player gateway game, because all
  real games up to now had 2 players.
- Output: wins, average place, average VP, round of the win, kills, corruptions, player combat,
  illegal-answer rate, seconds per call, tokens (read / cached / written / reasoning) per game.
- The choice is the strongest entrant that is not much slower or more costly than the next one.

### Step 2: one AI, different strategies

All seats use the winner of step 1. Seats differ only by a strategy text:

- Named strategies, one short instruction per seat. Examples: "win through Fire and attack dice",
  "go Evil early with Moon", "build Max Barrier and hunt Difficulty 3 monsters". Take the texts from
  the origin playstyle wheel (Fire: Initiative + Damage; Water: Awakening + Purity; Sun: Purity +
  Barrier; Forest: Barrier + Dice count; Mountain: Augments + (open); Moon: Corruption + Initiative).
- One free seat with no instruction, to show what the AI selects by itself.
- Strategy report per run: win rate and average VP per strategy; spirits and classes collected and
  never taken; awaken counts per spirit; the winner's path (locations, monsters, Evil or not); a
  short text from each player on why it played as it did.

This step does not need the tournament result. It can start at once.

### Step 3: the button in the data editor

- In Niji Batch (`~/niji-batch`, `public/data.html`): a "Run simulation" action after a data change.
- The games run on the Simforge laptop.
- The editor shows the strategy report. If a card changed, it compares before and after: the same
  seeds and the same players on the old data and on the new data.
- Each run stores a copy of the data with a hash, so "old" and "new" are clear. A folder copy is
  enough; no server.

### Not in the plan (decided)

No public server, no leaderboard, no outside workers, no new ability language. New kinds of
abilities are added to the engine by hand. The game records can be replayed and checked, so a larger
system stays possible later.

### Later idea (not approved yet)

A learning profile: a player keeps a strategy notebook between games and updates it after each game.

## What exists now

Game repo on seablue: `~/Documents/Programming/ArcSpirits/products/online-game-and-bot`
(commit `65069da`, about 247 uncommitted files; these are the real state; do not stash, reset,
checkout or clean). Not committed, by Michael's choice so far.

- **Harness:** `src/lib/play/agents/` and `scripts/agent-harness/run.ts` (+ `README.md`).
  Tests: `npx vitest run src/lib/play/agents`.
- **Seat types:** `mock:random|greedy|first`, `codex[:model]` (Codex CLI, one session per seat),
  `gw[:model]` (direct HTTP to the omp gateway; the route for scale), `or:<model>` (OpenRouter, paid).
- **What a player gets:** the rules brief with the full trait sheet (all classes with breakpoints,
  all spirits with awaken cost, locations, monsters, Powers, relic tools); its own view each turn;
  recent events; engine-made previews of what each destination offers now; facts on each monster
  in hand (hit versus Barrier, test fight results); pace facts; legal actions. Answer: one action id
  and a reason. No plan note. One continuous conversation per seat for the whole game, no reset.
- **Options:** `--parallel-games N`, `--max-concurrent-calls`, `--codex-effort` (default high),
  `--gw-urls` (list of gateways; one per game), `--replay <file>` (checks a record).
- **Local game for humans:** `npm run local` → `http://127.0.0.1:5317/play` (local data, no
  database). Files in `scripts/local-game/`.
- **Local design data:** `~/ArcSpiritsArt/game/*.json` (64 spirits, 55 classes, 108 monsters).

Engine decisions of 2026-11-12:

- Maximum 40 rounds (`MAX_ROUNDS` in `src/lib/play/types.ts`, was 30). 30 VP wins.
- All 7 Sun spirits cost 3 of any rune to awaken (the special Solar Cleric rule is removed).
- The word "potential" is now "Max Barrier" in the data and in all visible texts.

## Results so far

| Game | Setup | Result |
|---|---|---|
| codex-smoke-1 | 2 seats, low effort, capped at 80 decisions | Weak play: 0 and 3 VP after 9 rounds |
| codex-full-1 | 2 seats, high effort, plan note + session restart | Red won 31–20 in round 35; 323 calls; 10.7 M tokens read; 36 min |
| codex-full-2 | 2 seats, high effort, one session per seat | Blue won 31–14 in round 26; 233 calls; 17.7 M tokens read; 20.7 min; 6.0 s per call |

- The engine previews fixed the wasted turns and the wrong beliefs about locations.
- Still weak: a player with 4 Max Barrier did not cultivate to raise it and did not awaken its
  strike-first spirit. About 8 of 233 reasons were wrong about the board.
- Not covered yet in real games: relics, origin relic rewards, Difficulty 3 monsters, 4-player
  tables. Player combat and Evil status appeared in one game only.
- Scale: 200 mock games at once = one core, 457 MB. Codex CLI: 39 calls/min with 4 games, 74 with
  16 games, no rate limit; the Mac slowed down first (one process per call). So use `gw:` for scale.
- Gateway: 4.6 s per call, up to 90% of the read tokens cached from a seat's second turn.

## omp accounts and gateway

- Broker on the Simforge laptop: `https://simforge-laptop.tail1cad6a.ts.net:8765` (launchd
  `com.starline.omp-auth-broker`, local port 18765). It holds 3 Codex accounts: Gmail (promax),
  Simforge (pro), Berkeley (prolite). Michael approved pooled use; **use the Berkeley account only
  for now.**
- The laptop also runs Michael's own gateway on `127.0.0.1:4141` (`com.starline.omp-auth-gateway`).
  Do not change it, the broker, or the Tailscale serve entries (8765, 7347).
- Harness gateway on seablue: `http://127.0.0.1:4610/v1`, pinned to Berkeley by a pool file
  (`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE`). Scripts: `scripts/agent-harness/gateway/{start.sh,stop.sh,README.md}`.
  State and token outside the repo: `~/.local/share/arcspirits-agent-gateway/` (token file
  `home/.omp/auth-gateway.token`, env `ARC_GATEWAY_TOKEN_FILE`).
- Request: `POST /v1/chat/completions`, model `openai-codex/<id>`, `reasoning_effort`,
  `prompt_cache_key`, full history each turn. Send only `openai-codex/` models: the gateway also
  exposes an OpenRouter key, and another model id could be billed per token.
- An account fills one at a time and a session stays on its account. A usage-limit block also
  stops Michael's own omp and Starline sessions on that account.
- `omp` on PATH (seablue) is stock 18.1.2 and lists only gpt-5.6 models; `omp-starline` 18.4.9
  lists gpt-6.1-sol.

## Open items (check first in the new session)

1. **Move to the laptop (was in work when this was written):** copy the harness, the engine and the
   design data to `~/arcspirits-harness/` on the laptop; set up a Berkeley-pinned gateway there on
   `127.0.0.1` (own port, own token, user launchd agent or nohup; no sudo); run the tournament as a
   detached process with `caffeinate`, with `tournament/status.sh`, `tournament/resume.sh`,
   `STATUS.md` and a standings file. When this was written, `~/arcspirits-harness/` did not exist
   on the laptop yet. Check there first; if it is missing or half done, do it again from seablue's
   repo (rsync without `node_modules`, `.svelte-kit`, `output`, `static`, `ml` archives; node ≥ 22).
2. **Effort on the gateway:** most `gw:` calls reported 0 reasoning tokens. Confirm that
   `reasoning_effort` reaches the model (compare `/v1/chat/completions` with `/v1/responses`, low
   against high, on a hard prompt) BEFORE the tournament, because it compares efforts.
3. **Token rotation:** part of the seablue gateway token was printed into a local tool output.
   Rotate it when no game runs. The laptop gateway gets its own new token.
4. **Full `--seats gw,gw` game at high effort** was running on seablue; its result was not read yet.
5. **Possible engine fault:** in codex-full-2, Blue stayed above its spirit slot limit for its
   status (7 of 6, then 6 of 5) and could still summon; Red at 7 of 7 could not. Ask Michael if this
   is a guardian rule.
6. **Prompt improvements (proposed, not built):** repeat the texts of the player's current classes
   and next breakpoints each turn; show what a face-down spirit's class does next to its awaken
   condition; show that a hit above Max Barrier can never be fought; show pace against the opponent.
7. **Michael's open question:** keep the test fight results ("kills in 12 of 12 trials") in the
   prompt, or show plain numbers only? A human must estimate this.
8. **Tests:** about 42 engine tests fail and failed before today's changes (navigation "Finish your
   Power choice first", three Navigation Power tests, spirit draw tests). Not caused by this work.
9. **Live site:** arcspirits.com and its database still have the old Sun costs, 30 rounds and the
   word "potential". Michael said the local game is what matters now; do not deploy unless he asks.

## Rules for the session

- Reply in ASD-STE100 Simplified Technical English; lead with the result; keep the UX minimal and
  do only what Michael says.
- Subagents: always Opus (`model: 'opus'`), never Haiku.
- No secrets in files, records or reports. No commit, deploy or database change without Michael's word.
- A background process on the laptop must survive a closed ssh session and must stop cleanly at the
  quota guard.
