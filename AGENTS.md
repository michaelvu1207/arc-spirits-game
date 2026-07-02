# Arc Spirits Bot Testing Notes

- Use `docs/bot-testing-criteria.md` as the testing gate for bot, ML, dashboard, and Browser work.
- Use `docs/bot-development-architecture.md` for the current bot/game code map, repo strategy, shared `arc-bot-v1` contract, and dashboard plan.
- Prefer the executable package scripts from that doc, especially `npm run test:bot:engine`, `npm run test:bot:ml-smoke`, `npm run test:bot:az-smoke`, `npm run test:bot:clean-farm`, `npm run test:bot:clean-route-proof`, `npm run test:bot:trace-state-counterfactual`, `npm run test:bot:browser`, `npm run bot:gpu:preflight`, `npm run bot:gpu:sync`, `npm run bot:clean-route-proof`, and `npm run bot:traceq:fullcontrol`.
- UI or dashboard changes need a Browser check against a running app, plus Playwright when the flow is automatable.
- Bot/ML changes need deterministic engine tests first, then a smoke training/eval run before any long GPU run.
- The SimForge GPU box arc bot workspace is `/data/share8/michaelvuaprilexperimentation/arc-bot` on `ubuntu@216.151.21.122`; only clear files inside that workspace unless the user explicitly asks for broader cleanup.
