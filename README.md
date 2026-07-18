# Arc Spirits Spectate

SvelteKit app plus the current Arc Spirits rules engine, bot simulation harness, and ML bot pipeline.

The bot development architecture lives in
[`docs/bot-development-architecture.md`](docs/bot-development-architecture.md), and the
testing entrypoint is [`docs/bot-testing-criteria.md`](docs/bot-testing-criteria.md).

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
