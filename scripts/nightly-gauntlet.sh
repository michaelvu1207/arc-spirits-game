#!/usr/bin/env bash
# Nightly gauntlet heartbeat (BOT_TAKEOVER_PLAN.md M4).
# Scores the current champion (and any extra candidates passed as args) on the
# frozen gauntlet-v1 and appends one dated line per candidate to
# ml/gauntlet_results/history.jsonl — the project's single Elo time series.
#
#   scripts/nightly-gauntlet.sh [WEIGHTS_PATH ...]
#
# Default candidate: the shipped live net (src/lib/play/ml/policy-weights.json).
set -euo pipefail
cd "$(dirname "$0")/.."

CANDIDATES=("${@:-src/lib/play/ml/policy-weights.json}")
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
GIT_REV=$(git rev-parse --short HEAD)

for W in "${CANDIDATES[@]}"; do
  echo "[nightly-gauntlet] scoring $W"
  GAUNTLET=1 GAUNTLET_WEIGHTS="$W" npx vitest run \
    src/lib/play/ml/gauntlet/_gauntlet.test.ts >/dev/null 2>&1 || {
      echo "[nightly-gauntlet] RUN FAILED for $W" >&2; continue; }
  # The runner writes ml/gauntlet_results/<slug>.json; find the newest result.
  LATEST=$(ls -t ml/gauntlet_results/*.json | grep -v history | head -1)
  python3 - "$LATEST" "$STAMP" "$GIT_REV" "$W" <<'EOF'
import json, sys
res_path, stamp, rev, weights = sys.argv[1:5]
d = json.load(open(res_path))
line = {
    "ts": stamp, "rev": rev, "weights": weights,
    "gauntletVersion": d.get("gauntletVersion"),
    "games": d.get("games"), "smoke": d.get("smoke"),
    "elo": d.get("eloVsAnchors", {}).get("aggregate", {}).get("elo"),
    "meanPlacement": d.get("meanPlacement"), "winRate": d.get("winRate"),
    "meanVP": d.get("meanVP"),
}
with open("ml/gauntlet_results/history.jsonl", "a") as f:
    f.write(json.dumps(line) + "\n")
print("[nightly-gauntlet]", json.dumps(line))
EOF
done
