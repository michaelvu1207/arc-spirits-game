#!/usr/bin/env bash
# League promotion gauntlet: sharded (fast-gauntlet.sh) + the same history.jsonl
# append as nightly-gauntlet.sh, so the manager's lastGauntletElo() reads it
# unchanged. A serial 800-game run stalls the league ~20 min per promotion
# check on the box; sharded is ~2-3 min for identical results.
#
#   scripts/league-gauntlet.sh WEIGHTS_PATH
set -euo pipefail
cd "$(dirname "$0")/.."

W="${1:?usage: league-gauntlet.sh WEIGHTS}"
SHARDS="${LEAGUE_GAUNTLET_SHARDS:-32}"
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
GIT_REV=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
OUT=$(mktemp /tmp/league-gauntlet-XXXXXX.json)
trap 'rm -f "$OUT"' EXIT

echo "[league-gauntlet] scoring $W ($SHARDS shards)"
bash scripts/fast-gauntlet.sh "$W" "$SHARDS" "$OUT"

python3 - "$OUT" "$STAMP" "$GIT_REV" "$W" <<'EOF'
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
print("[league-gauntlet]", json.dumps(line))
EOF
