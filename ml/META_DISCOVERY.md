# Arc Spirits AlphaZero Meta Discovery

Run the new loop with one command:

```bash
bash ml/discover_meta.sh
```

A100-sized run:

```bash
CUDA_VISIBLE_DEVICES=0 OUTER=20 GAMES=400 SHARDS=12 MCTS=200 META_GAMES=48 bash ml/discover_meta.sh
```

Smoke test:

```bash
RUN_ID=smoke OUTER=1 GAMES=1 SHARDS=1 MCTS=4 EPOCHS=1 META_GAMES=1 META_MCTS=4 bash ml/discover_meta.sh
```

What it does:

- Generates all-seat AlphaZero self-play with `AZ_PLANNER_SEATS=all`, so there are no heuristic opponent profiles in the main loop.
- Trains only `ml/train.py --mode alphazero`, using MCTS visit distributions as policy targets and final VP outcome as the value target.
- Starts from random weights unless `INIT_WEIGHTS=...` is explicitly provided.
- Uses `MICRO_PROFILE=random` by default so the remaining within-round executor is not seeded with the old hand-discovered strategy profiles.
- Writes each run to `ml/meta_runs/<RUN_ID>/`, with `ml/meta_runs/latest` pointing at the newest run.
- Produces `latest_meta.json`, `best_meta.json`, `best_policy.json`, and per-iteration checkpoints/logs.
- Leaves heuristic field benchmarking off by default. Set `BENCH_EVERY=5` if you want periodic comparison against `pvphunter,medium,cultivator,survivor`.

Important current boundary: the planner currently searches navigation decisions. Within-round actions still flow through the existing bot action executor, controlled by `MICRO_PROFILE` only as a temporary micro-action driver. The default is `random`, not `cultivator`, `pvphunter`, or any previous discovered lane. The next framework step for fully hand-hold-free AlphaZero is to expand MCTS candidates from navigation-only to every legal command.
