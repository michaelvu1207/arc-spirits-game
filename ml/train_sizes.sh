#!/usr/bin/env bash
# Train the full 8-size ladder on a shared dataset (offline AWR), scheduled across 4 GPUs.
# Each size -> ml/sizes/<name>.json (self-describing params). Run alongside the CPU-bound league.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" 2>/dev/null; nvm use 22 >/dev/null 2>&1
DATA="${DATA:-ml/sizes_data}"; BETA="${BETA:-3.0}"
mkdir -p ml/sizes logs
echo "TRAIN_SIZES data=$DATA samples=$(cat "$DATA"/*.jsonl 2>/dev/null | wc -l) $(date)"
# name : trunk_hidden : value_hidden : gpu : batch : epochs
CFG=(
  "nano:16:8:0:8192:30"
  "tiny:48,48:32:0:8192:30"
  "small:96,96:48:1:8192:30"
  "base:128,128:64:1:8192:30"
  "medium:384,384:128:2:8192:30"
  "large:1024,1024,1024:256:2:4096:28"
  "xl:4096,4096,4096:512:3:1536:18"
  "xxl:11500,11500,11500,11500,11500,11500,11500,11500:1024:3:384:8"
)
for c in "${CFG[@]}"; do
  IFS=: read -r nm th vh gpu batch ep <<< "$c"
  ( CUDA_VISIBLE_DEVICES="$gpu" ARC_HIDDEN="$th" ARC_VALUE_HIDDEN="$vh" \
    ml/.venv/bin/python ml/train.py --data "$DATA" --out "ml/sizes/$nm.json" --epochs "$ep" --beta "$BETA" --batch-size "$batch" \
    > "logs/size_$nm.log" 2>&1
    echo "$nm DONE gpu=$gpu $(grep -oE 'top1_acc=[0-9.]+' "logs/size_$nm.log" | tail -1)" ) &
done
wait
echo "=== SIZES_DONE $(date) ==="
for c in "${CFG[@]}"; do nm="${c%%:*}"; P=$(python3 -c "import json;print(f\"{json.load(open('ml/sizes/$nm.json'))['params']:,}\")" 2>/dev/null || echo '?'); T=$(grep -oE 'top1_acc=[0-9.]+' "logs/size_$nm.log" | tail -1); echo "  $nm: params=$P  $T"; done
