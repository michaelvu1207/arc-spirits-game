#!/usr/bin/env bash
# Create 4 isolated population-based training lanes (one per GPU). Each lane is a workspace clone
# sharing node_modules + the python venv via symlink, with its own ml/data, ml/weights, ckpt, logs.
# Seeded from the current best policy + recent self-play data (the poisoned cold-BC data is dropped).
set -u
WS="${WS:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
cd "$WS"
for i in 0 1 2 3; do
  L="$WS/../lane$i"
  echo "=== lane$i -> $L ==="
  rsync -a --delete \
    --exclude node_modules --exclude 'ml/.venv' --exclude 'ml/data' --exclude ckpt --exclude logs \
    --exclude 'ml/weights' --exclude static --exclude build --exclude .svelte-kit \
    "$WS/" "$L/"
  rm -rf "$L/node_modules" "$L/ml/.venv" "$L/static"
  ln -sfn "$WS/node_modules" "$L/node_modules"
  ln -sfn "$WS/ml/.venv" "$L/ml/.venv"
  [ -d "$WS/static" ] && ln -sfn "$WS/static" "$L/static"
  mkdir -p "$L/ml/data" "$L/ml/weights" "$L/ckpt" "$L/logs"
  cp "$WS/ml/weights/policy.json" "$L/ml/weights/policy.json"
  # warm-start data: recent self-play only (drop the 0-VP champion-BC cold data)
  cp $WS/ml/data/x1_*.jsonl $WS/ml/data/it2_*.jsonl $WS/ml/data/it3_*.jsonl "$L/ml/data/" 2>/dev/null || true
  echo "  seeded: $(ls "$L"/ml/data/*.jsonl 2>/dev/null | wc -l) data files, $(cat "$L"/ml/data/*.jsonl 2>/dev/null | wc -l) samples"
done
echo SETUP_LANES_DONE
