# Local game (no Supabase)

Play Arc Spirits on this Mac with the local design data. The command uses no Supabase project:
no database, no storage, no sign-in service on the internet.

```sh
npm run local                    # then open the URL on the last line
npm run local -- --port 5400     # another port (default 5317, else the next free one)
npm run local -- --open          # also open the browser
npm run local -- --strict-port   # fail instead of taking the next free port
npm run local -- --state-dir <dir> --log-dir <dir>
```

The last line is the URL to open, for example `Open http://127.0.0.1:5317/play`.
Stop with Ctrl+C.

- **Data edits**: a change to `<game-dir>/*.json` (or a new image in the art folders) is picked
  up without a restart: the backend re-reads the files when their mtime changes (checked at most
  once a second), and the server's engine catalog is cached for 1 s instead of 60 s. The next
  game uses the new data (a running game also sees it on its next step, as in production).
- **Saved games**: rooms, finished games, replays and the anonymous accounts are written to
  `<state-dir>/emulator/<schema>.<table>.json` (default state dir `~/.arc-local-game`; about 1 s
  after a write, only the tables it touched, temp file + rename) and loaded at start. Delete the
  folder for a clean database.
- **Admin pages**: `<state-dir>/secrets.json` (mode 600) holds an `ADMIN_SECRET_KEY` and
  `HOST_SECRET_KEY` made on the first start. The admin login asks for `ADMIN_SECRET_KEY`.
- **Bots** are on (`VITE_ARC_LOCAL_BOTS=1`, see `src/lib/play/botAvailability.ts`) and play with
  the bundled policy weights.
- **Other devices** (Tailscale): `tailscale serve --bg --https=5317 http://127.0.0.1:5317`, then
  open `https://<machine>.<tailnet>.ts.net:5317/play`. The browser uses its own page origin for
  the Supabase paths (`PUBLIC_SUPABASE_SAME_ORIGIN=1`, `src/lib/supabaseOrigin.ts`), Vite allows
  `*.ts.net` host names, and `vite.config.local.mjs` maps the `https://` Origin that Tailscale
  forwards to the `http://` origin the app sees.

## Game explorer

`http://127.0.0.1:5317/explorer` (local game only; the data editor on port 8787 shows it as its
"Games" page): Trends, Games (records and the round-by-round viewer with a time-lapse),
Leaderboard, Players. They are the original records / game viewer / leaderboard / player pages
(`src/routes/admin/...`) without the site bar, each on one screen.

`import-agent-games.ts` fills their tables in the emulator and runs every 30 s while the game
runs (log: `explorer-import.log`; `--no-explorer-import` turns it off, `--agent-games <dir>` is
the folder with the AI runs, default `~/arcspirits-harness`):

- AI games: every finished record under `<dir>/<league>/versions/*/games/*.jsonl` and
  `<dir>/tournament/*/games/*.jsonl` is replayed through the engine (no AI call; it must reach
  the recorded final state) and written as `game_state_snapshots` rows, one per seat per round.
  Files still playing, `.abandoned-` and `.failed-` files are skipped. Read only.
- Games played here: from the frames the game saves (`replay_frames`), once a round is complete.
- From those: `game_summaries`, `player_match_results`, `player_ratings_leaderboard` (OpenSkill by
  placement), favourite spirits and totals, `agent_profiles` (model, strategy, notebook).

One-off run: `node --import tsx scripts/local-game/import-agent-games.ts --base http://127.0.0.1:5317 [--force]`.
The switch is `PUBLIC_ARC_LOCAL_EXPLORER=1` (set by `start.mjs`; `src/lib/explorer.ts`). Without
it `/explorer` answers 404 and the app may not be framed, as in production.

## Two players on one Mac

Each browser profile is one player. For player 2, use a private window (Cmd+Shift+N) or
another browser:

1. Player 1: Custom Lobby → Create Room → Tap to sit → choose a guardian.
2. Player 2: open the same URL → Custom Lobby → set a name ("change") → JOIN on the room →
   Tap to sit → choose a guardian.
3. Player 1: Start Game.

A window that opens the room link without a name and without "JOIN" only watches the room.
Rooms live in memory: a restart clears them.

## What it starts

| Part | What it does |
| --- | --- |
| `emulator.ts` | `server/pgrestEmu.ts` (the database and anonymous sign-in the tests use), saved to `<state-dir>/emulator/`. |
| `backend.mjs` | Serves the catalog (`arc_spirits_assets`) from `~/ArcSpiritsArt/game/*.json`, images from local files, and realtime room updates. Refuses all writes to assets and storage. Sends the rest to the emulator. |
| `import-agent-games.ts` | Fills the explorer's tables from the AI game records and the games played here (above). |
| Vite dev server (`vite.config.local.mjs`) | The normal app. It sends `/rest/v1`, `/auth/v1`, `/storage/v1`, `/realtime/v1` to the backend. |

The server gets `PUBLIC_SUPABASE_URL` = `http://127.0.0.1:<port>` and the browser uses its own
page origin (`PUBLIC_SUPABASE_SAME_ORIGIN=1`; from the environment of this command only, `.env`
does not change). So the browser talks to one origin, and the Content Security Policy (`'self'`)
allows it. The dev server writes to its own `.svelte-kit-local-<port>` folder
(`ARC_SVELTEKIT_OUT_DIR`), so other dev servers in this checkout do not disturb it.

### Catalog

All tables come from `<game-dir>/<table>.json` (default `~/ArcSpiritsArt/game`). Two tables
have no local file and come from this repo, as in the agent harness (`src/lib/play/agents/catalog.ts`):

- `mat_items` (runes and relics): the rows of `ml/catalog.json`, with the names from the local
  `runes.json` and `relics.json`. A rune or relic that is only in the local files is added.
- `reward_row_assignments`: the Arcane Abyss row (Abyss summon) from `ml/catalog.json`. The
  four regions get their rows from code.

### Images

The storage path in each row is mapped to a local file (read only):

| Rows | Local files |
| --- | --- |
| Spirit card faces | `~/ArcSpiritsArt/assets/exports/hex-spirits/<name>_front.png`, `_back.png` |
| Class icons, augment tokens | `~/ArcSpiritsArt/references/icons/classes/` |
| Origin icons | `~/ArcSpiritsArt/references/icons/origins/` |
| Icon pool, relics | `~/ArcSpiritsArt/references/icons/icon_pool/` |
| Base runes | `~/ArcSpiritsArt/references/icons/runes/` |
| Guardians, location backgrounds, dice | the Tabletop Simulator image cache (`~/Library/Tabletop Simulator/Mods/Images`), a local copy of the storage bucket. Not used for spirit or monster card faces (an old copy can show old card text). Turn it off with `--no-tts-cache`. |

Monster cards use the web copies in `static/monster-cards/` (as in the normal game).
A row with no path gets a local path when a local file exists (new spirits, icons).
Resized copies (for the `?width=` requests) are cached in `$TMPDIR/arc-local-game/image-cache`.

To see what is still missing: `http://127.0.0.1:5317/__local/status` (`missingImages`).
On 2026-11-12 these 7 were missing: the 5 "Hero" spirit fronts (no export), one dice template
image and the spirit world board.

### Realtime

The game listens on the broadcast channel `room:<CODE>` and loads its view on each `sync`
message. The backend sends `sync` when a room's revision, status or members change after a
write. The 3-second poll of the game stays on as before.

## Drive a seat from a script

Use the same origin as the browser (`BASE=http://127.0.0.1:5317`):

```sh
TOKEN=$(curl -s -X POST $BASE/auth/v1/signup -H 'apikey: local-emu' \
  -H 'content-type: application/json' -d '{}' | jq -r .access_token)
curl -s -X POST $BASE/api/play/sessions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"displayName":"Script seat"}'      # new room
curl -s $BASE/api/play/sessions/<CODE>/view -H "authorization: Bearer $TOKEN" # view + legal commands
```

Then use the room endpoints (`join`, `claim-seat`, `commands`, ...) under
`/api/play/sessions/<CODE>/` with the same header. Realtime: subscribe to `room:<CODE>` on
`ws://127.0.0.1:5317/realtime/v1/websocket?apikey=local-emu&vsn=1.0.0`, or poll `view`.

## Logs

`--log-dir` (default `$TMPDIR/arc-local-game/`): `app.log` (Vite), `emulator.log`, `backend.log`
(writes, refused requests, data reloads, `sync` messages).
