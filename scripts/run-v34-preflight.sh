#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v34-latency-first-expert-iteration"
OUT_DIR="${1:-$EXPERIMENT/artifacts/preflight}"
cd "$ROOT"
test -f "$EXPERIMENT/artifacts/source-lock.json"
node scripts/verify-v34-source-lock.mjs "$EXPERIMENT/artifacts/source-lock.json" >/dev/null
test ! -e "$OUT_DIR/result.json"
mkdir -p "$OUT_DIR"

vitest_code=0
npm test -- --run \
  src/lib/play/ml/actions.informationSafety.test.ts \
  src/lib/play/ml/_gumbelPlanner.test.ts \
  src/lib/play/ml/_heuristicRolloutPlanner.test.ts \
  src/lib/play/ml/_actorpool.test.ts \
  src/lib/play/ml/inferenceClient.test.ts \
  src/lib/play/ml/driver.ppo.test.ts > "$OUT_DIR/vitest.log" 2>&1 || vitest_code=$?
python_code=0
ml/.venv/bin/python -m unittest ml.test_analyze_v34_preview_calibration \
  > "$OUT_DIR/python.log" 2>&1 || python_code=$?
check_code=0
npm run check > "$OUT_DIR/typecheck.log" 2>&1 || check_code=$?
protocol_code=0
node scripts/validate-v34-protocol.mjs > "$OUT_DIR/protocol.log" 2>&1 || protocol_code=$?
shell_code=0
bash -n scripts/run-v34-preflight.sh scripts/run-v34-preview-calibration.sh \
  scripts/run-v34-systems-screen.sh > "$OUT_DIR/shell.log" 2>&1 || shell_code=$?
determinization_code=0
node scripts/check-v34-determinization.mjs --samples 100000 --seed0 956400000 \
  --out "$OUT_DIR/determinization-audit.json" \
  > "$OUT_DIR/determinization.log" 2>&1 || determinization_code=$?

node scripts/verify-v34-source-lock.mjs "$EXPERIMENT/artifacts/source-lock.json" >/dev/null
node scripts/record-v34-preflight.mjs "$OUT_DIR/result.json" \
  "$EXPERIMENT/artifacts/source-lock.json" \
  "$OUT_DIR/vitest.log" "$OUT_DIR/python.log" "$OUT_DIR/typecheck.log" \
  "$OUT_DIR/protocol.log" "$OUT_DIR/shell.log" "$OUT_DIR/determinization.log" \
  "$vitest_code" "$python_code" "$check_code" "$protocol_code" "$shell_code" \
  "$determinization_code"
chmod 0444 "$OUT_DIR/result.json" "$OUT_DIR/determinization-audit.json"
