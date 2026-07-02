# Arc Spirits Spectate

SvelteKit app plus the current Arc Spirits rules engine, bot simulation harness, and ML bot pipeline.

The bot development architecture lives in
[`docs/bot-development-architecture.md`](docs/bot-development-architecture.md), and the
testing entrypoint is [`docs/bot-testing-criteria.md`](docs/bot-testing-criteria.md).

## Local Development

```bash
npm install
npm run dev
```

## Core Checks

```bash
npm run check
npm test
npm run test:e2e
npm run test:bot:engine
```

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
