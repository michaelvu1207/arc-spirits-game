#!/usr/bin/env bash
set -euo pipefail

HOST="${ARC_BOT_GPU_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${ARC_BOT_REMOTE_DIR:-/data/share8/michaelvuaprilexperimentation/arc-bot}"

ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" REMOTE_DIR="$REMOTE_DIR" bash -s <<'REMOTE'
set -euo pipefail

echo "== host =="
hostname

echo
echo "== gpus =="
nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader

echo
echo "== running containers =="
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | sed -n '1,100p'

echo
echo "== arc bot workspace =="
cd "$REMOTE_DIR"
pwd
node -v
npm -v

if test -x ml/.venv/bin/python; then
  ml/.venv/bin/python - <<'PY'
import torch
print("torch", torch.__version__)
print("cuda", torch.cuda.is_available(), torch.cuda.device_count())
PY
else
  echo "ml/.venv missing; run: python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt"
fi

echo
echo "== docs =="
test -s docs/bot-testing-criteria.md
test -s AGENTS.md
echo "testing docs present"
REMOTE
