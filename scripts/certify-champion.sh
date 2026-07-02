#!/usr/bin/env bash
# Champion certification suite (Phase F, plan happy-quail) — the "ship only when
# ALL hold" battery. Runs the cheap layers; the held-out exploiter (the gold
# standard) is a separate bounded training run via ml/exploit_probe.py.
#
#   scripts/certify-champion.sh WEIGHTS [OUT_DIR]
#
# Layers:
#   1. Frozen gauntlet (sharded) — strength vs the anchor field.
#   2. Held-out exploiter probe — fresh 16-gen exploiter must stay < +50 Elo
#      head-to-head (KataGo lesson: Elo alone is necessary, not sufficient).
#   3. 2v1 collusion probe — two coordinated pvphunter seats vs the candidate:
#      candidate's seat-normalized score must not collapse vs the 1v1 baseline.
#   4. Mirror sanity — candidate vs 3 copies of itself: placement ≈ 2.5, no
#      seat-order pathology beyond the engine's tiebreak edge.
# Human layers (Michael's 20 games, BC-of-human response training) are logged
# as PENDING — they cannot be automated here.
set -euo pipefail
cd "$(dirname "$0")/.."

W="${1:?usage: certify-champion.sh WEIGHTS [OUT_DIR]}"
OUT="${2:-ml/cert_results/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
echo "[certify] candidate: $W → $OUT"

echo "[certify] 1/4 frozen gauntlet (sharded)"
bash scripts/fast-gauntlet.sh "$W" "${CERT_GAUNTLET_SHARDS:-32}" "$OUT/gauntlet.json"

echo "[certify] 2/4 held-out exploiter probe (bounded ${CERT_EXPLOIT_GENS:-16} gens)"
ml/.venv/bin/python ml/exploit_probe.py \
  --champion "$W" \
  --budget-gens "${CERT_EXPLOIT_GENS:-16}" \
  --games-per-gen 64 --workers "${CERT_EXPLOIT_WORKERS:-32}" \
  --out "$OUT/exploit_probe.json" 2>&1 | tail -3

echo "[certify] 3/4 2v1 collusion probe"
node scripts/run-actor-pool.mjs --games "${CERT_PROBE_GAMES:-200}" --workers 100 \
  --seed0 8300000 --weights "$W" --neural-seats Red \
  --profiles pvphunter,pvphunter,medium --max-rounds 120 \
  --out "$OUT/collusion-2v1" --quiet
node scripts/run-actor-pool.mjs --games "${CERT_PROBE_GAMES:-200}" --workers 100 \
  --seed0 8300000 --weights "$W" --neural-seats Red \
  --profiles pvphunter,medium,medium --max-rounds 120 \
  --out "$OUT/collusion-1v1" --quiet

echo "[certify] 4/4 mirror sanity"
node scripts/run-actor-pool.mjs --games "${CERT_PROBE_GAMES:-200}" --workers 100 \
  --seed0 8400000 --weights "$W" --max-rounds 120 \
  --out "$OUT/mirror" --quiet

python3 - "$OUT" <<'EOF'
import json, sys, glob, os
out = sys.argv[1]
report = {"pending_human_layers": ["michael-20-games", "bc-of-human-response-training"]}

g = json.load(open(f"{out}/gauntlet.json"))
report["gauntlet"] = {
    "version": g["gauntletVersion"], "elo": g["eloVsAnchors"]["aggregate"]["elo"],
    "winRate": g["winRate"], "meanVP": g["meanVP"],
}

ep_path = f"{out}/exploit_probe.json"
if os.path.exists(ep_path):
    ep = json.load(open(ep_path))
    # exploit_probe.py's own pass criterion (< +50 Elo head-to-head).
    report["exploiter"] = {k: ep.get(k) for k in ("verdict", "eloGainEstimate", "thresholdElo", "budgetGens") if k in ep}

def seat_score(dirname, seat="Red"):
    tot, n = 0.0, 0
    for f in glob.glob(f"{out}/{dirname}/games-*.jsonl"):
        for line in open(f):
            d = json.loads(line)
            mine = next((p for p in d["perSeat"] if p["seat"] == seat), None)
            if mine:
                n += 1
                tot += (len(d["perSeat"]) - mine["placement"]) / (len(d["perSeat"]) - 1)
    return (tot / n if n else None), n

s2, n2 = seat_score("collusion-2v1")
s1, n1 = seat_score("collusion-1v1")
report["collusion"] = {
    "score_vs_2_hunters": s2, "score_vs_1_hunter": s1, "games": [n2, n1],
    "drop": (s1 - s2) if (s1 is not None and s2 is not None) else None,
    "note": "large drop = coordinated pair exploits the candidate; compare to how heuristics degrade",
}

ms, mn = seat_score("mirror")
report["mirror"] = {"red_seat_score": ms, "games": mn,
                    "note": "expected ~0.5; large deviation = seat-order pathology"}

json.dump(report, open(f"{out}/report.json", "w"), indent=1)
print("[certify] REPORT:", json.dumps(report, indent=1))
EOF
