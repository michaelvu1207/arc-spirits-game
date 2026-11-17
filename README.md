# Arc Spirits Spectate

SvelteKit app plus the current Arc Spirits rules engine, bot simulation harness, and ML bot pipeline.

The bot development architecture lives in
[`docs/bot-development-architecture.md`](docs/bot-development-architecture.md), and the
testing entrypoint is [`docs/bot-testing-criteria.md`](docs/bot-testing-criteria.md).

## Where things are

Everything is in this repo; the raw art (about 20 GB) is the only part that stays on one computer, the art host.

| Folder | What it is |
| --- | --- |
| `src/` | The web site and the game engine. A push to `main` deploys it. |
| `data/` | The working game tables (JSON). `npm run package:release` turns them into a package for the site. |
| `tools/editor/` | The data editor and image tools (port 8787). See its README. |
| `tools/replay-check/` | Recorded games that must still replay the same way: `npm run replay-check`. |
| `scripts/local-game/` | The local game: `npm run local` (port 5317). |

`arc.local.json` (not in git) holds the settings of one computer. On the art host: `{ "artHost": true, "artDir": "~/ArcSpiritsArt" }`.
On another computer: `{ "artHostSsh": "<user>@<art host>", "artHostRepo": "<path of this repo there>" }`.

### Work from another computer

The simple way is to work on the art host from a distance: a terminal over SSH, and a browser on the
editor (port 8787) and the local game (port 5317). The editor sends compressed pages and small images,
and the browser keeps them, so this also works on a slow connection.

To run the game on another computer with no connection: clone, `npm ci`, `npm run art:fetch` (downloads the
published game images, about 15 MB), then `npm run local`. Image work (`npm run cards:remake`) always runs on
the art host; from another computer the command runs there over SSH and then fetches the result.

## Local Development

```bash
npm ci
npm run dev
```

## Core Checks

```bash
npm run check
npm test
npm run test:e2e
npm run gate:journey
npm run test:bot:engine
npm run gate:human-loop
npm run gate:mixed-full-games
npm run test:e2e:platform:local
npm run perf:journey
```

`gate:journey` owns a private PostgREST/auth emulator and production preview,
runs the seven stateful browser journeys twice against the same store, and proves
cleanup. It covers guest Quick Play, single-attempt cancellation, ranked disconnect
takeover/read-only recovery, persistent party leave/rematch, progression, replay
privacy/revocation, and animated-highlight export. The sibling Godot repository's
`npm run rc:full` is the cumulative web/desktop/iOS-Simulator/Android-Emulator gate.

## Ranked season operation

Apply the checked-in Supabase migrations in timestamp order. The current ranked
product depends on `20260715_ranked_seasons_achievements.sql`,
`20260716_ranked_product_completion.sql`, and
`20260717_ranked_disconnect_integrity.sql`; migration tests run against a real
local PostgreSQL instance in the portable RC tier.

Preview or perform an idempotent season rollover with the service-authorized CLI:

```bash
npm run ranked:roll -- --dry-run --next-name "Season Two"
npm run ranked:roll -- --next-name "Season Two"
```

The transaction freezes the final leaderboard, archives personal finishes and
division rules, grants participation/mastery rewards once, closes the old season,
and opens the next. Never run the mutating command against production without the
separate production authorization required by the project workflow.

## Bot/ML Smoke

```bash
npm run test:bot:az-smoke
```

See [`ml/README.md`](ml/README.md) for the training pipeline and [`ml/META_DISCOVERY.md`](ml/META_DISCOVERY.md) for the current AlphaZero-style loop.

## SimForge GPU Box

Remote arc bot workspace:

```bash
ssh ubuntu@216.151.21.122
cd /data/share8/michaelvuaprilexperimentation/arc-bot
```

Use [`docs/bot-testing-criteria.md`](docs/bot-testing-criteria.md) for GPU preflight, Browser tunnel testing, smoke runs, and long-run promotion criteria.

```bash
npm run bot:gpu:preflight
npm run bot:gpu:sync
```

## Build

```bash
npm run build
npm run preview
```
