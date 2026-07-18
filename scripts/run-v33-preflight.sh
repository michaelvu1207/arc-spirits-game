#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT_DIR="${1:-$ROOT/ml/experiments/v33-strategic-search/artifacts/preflight}"
cd "$ROOT"
test ! -e "$OUT_DIR/result.json" || exit 2
mkdir -p "$OUT_DIR"

vitest_code=0
npm test -- --run src/lib/play/ml/_gumbelPlanner.test.ts src/lib/play/ml/actions.informationSafety.test.ts src/lib/play/ml/_actorpool.test.ts src/lib/play/ml/inferenceClient.test.ts > "$OUT_DIR/vitest.log" 2>&1 || vitest_code=$?
python_code=0
ml/.venv/bin/python -m unittest ml.test_analyze_v33_search ml.test_analyze_v33_qualification > "$OUT_DIR/python.log" 2>&1 || python_code=$?
check_code=0
npm run check > "$OUT_DIR/typecheck.log" 2>&1 || check_code=$?
protocol_code=0
node scripts/validate-v33-protocol.mjs > "$OUT_DIR/protocol.log" 2>&1 || protocol_code=$?
shell_code=0
bash -n scripts/run-v33-systems-screen.sh scripts/run-v33-phase2-screen.sh scripts/run-v33-guardian-confirmation.sh scripts/run-v33-qualification.sh > "$OUT_DIR/shell.log" 2>&1 || shell_code=$?

node scripts/record-v33-preflight.mjs "$OUT_DIR/result.json" \
  "$OUT_DIR/vitest.log" "$OUT_DIR/python.log" "$OUT_DIR/typecheck.log" \
  "$OUT_DIR/protocol.log" "$OUT_DIR/shell.log" \
  "$vitest_code" "$python_code" "$check_code" "$protocol_code" "$shell_code"
