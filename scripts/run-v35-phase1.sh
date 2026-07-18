#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v35-weco-recursive-autoresearch"
LOCK="$EXPERIMENT/artifacts/phase1-long-run-source-lock.json"
AUTHORIZATION="$EXPERIMENT/artifacts/phase1-long-run-authorization.json"
VALIDATION="${ARC_V35_VALIDATION:-/dev/shm/arc-v32-critic/validation}"
LEASE="${ARC_V35_GPU7_LEASE:-$ROOT/.leases/arc-v35-gpu7}"
GPU_UUID="GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"
MODE="${1:---launch}"
ANALYSIS_LEASE_HELD=0

cd "$ROOT"
if [[ "$MODE" == "--launch" ]]; then
  PID_FILE="$EXPERIMENT/artifacts/phase1-orchestrator.pid"
  LOG_FILE="$EXPERIMENT/artifacts/phase1-orchestrator.log"
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "V35 Phase 1 orchestrator is already running pid=$(cat "$PID_FILE")" >&2
    exit 1
  fi
  test ! -e "$EXPERIMENT/artifacts/phase1-endpoint.json"
  nohup env ARC_ROOT="$ROOT" "$ROOT/scripts/run-v35-phase1.sh" --orchestrate \
    > "$LOG_FILE" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$PID_FILE"
  printf 'V35 Phase 1 orchestrator pid=%s\n' "$!"
  exit 0
fi
[[ "$MODE" == "--orchestrate" ]] || { echo "usage: $0 [--launch|--orchestrate]" >&2; exit 2; }

node scripts/lock-v35-phase1.mjs verify "$LOCK"
test "$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.authorized))' "$AUTHORIZATION")" = "true"
test -d "$VALIDATION"
mkdir -p "$(dirname "$LEASE")"

run_all_roots() {
  local target="$1"
  local replicate arm league log
  for replicate in a b c; do
    for arm in control-uniform late-reweighted p30-credit025; do
      league="$EXPERIMENT/league/rep-$replicate/$arm"
      mkdir -p "$league/artifacts"
      log="$league/artifacts/phase1-long-run.log"
      printf 'START target=%s at=%s\n' "$target" "$(date -u +%FT%TZ)" >> "$log"
      ARC_V35_SOURCE_LOCK="$LOCK" "$ROOT/scripts/run-v35-root.sh" "$league" "$target" \
        >> "$log" 2>&1
      printf 'DONE target=%s at=%s\n' "$target" "$(date -u +%FT%TZ)" >> "$log"
    done
  done
}

release_analysis_lease() {
  if (( ANALYSIS_LEASE_HELD == 1 )); then
    rm -rf "$LEASE"
    ANALYSIS_LEASE_HELD=0
  fi
}
trap release_analysis_lease EXIT INT TERM

run_manipulation_audit() {
  local generation="$1"
  local out="$EXPERIMENT/artifacts/phase1-manipulation-gen${generation}.json"
  local line index uuid memory utilization
  test ! -e "$out"
  mkdir "$LEASE"
  ANALYSIS_LEASE_HELD=1
  line="$(nvidia-smi --query-gpu=index,uuid,memory.used,utilization.gpu --format=csv,noheader,nounits | awk -F', *' '$1 == 7 {print $1","$2","$3","$4}')"
  IFS=, read -r index uuid memory utilization <<< "$line"
  [[ "$index" == "7" && "$uuid" == "$GPU_UUID" && "$memory" == "0" && "$utilization" == "0" ]]
  CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=7 PYTHONHASHSEED=0 \
    CUBLAS_WORKSPACE_CONFIG=:4096:8 PYTHONPATH=ml nice -n 10 \
    ml/.venv/bin/python ml/audit_v35_manipulation.py \
    --experiment "$EXPERIMENT" --validation "$VALIDATION" \
    --validation-lock "$EXPERIMENT/artifacts/phase1-validation-lock.json" \
    --generation "$generation" --out "$out"
  release_analysis_lease
}

run_all_roots 8
run_manipulation_audit 8
if [[ "$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.manipulation.passed))' \
  "$EXPERIMENT/artifacts/phase1-manipulation-gen8.json")" == "true" ]]; then
  ENDPOINT=8
  REASON="generation-8-manipulation-passed"
else
  run_all_roots 12
  run_manipulation_audit 12
  if [[ "$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.manipulation.passed))' \
    "$EXPERIMENT/artifacts/phase1-manipulation-gen12.json")" != "true" ]]; then
    echo "V35 Phase 1 rejected: outcome-blind manipulation remained underdosed at generation 12" >&2
    exit 1
  fi
  ENDPOINT=12
  REASON="global-generation-12-extension-manipulation-passed"
fi

node - "$EXPERIMENT" "$ENDPOINT" "$REASON" <<'NODE'
const fs = require('fs');
const path = require('path');
const [experiment, endpointRaw, reason] = process.argv.slice(2);
const endpoint = Number(endpointRaw);
const roots = [];
for (const replicate of ['a', 'b', 'c']) {
  for (const arm of ['control-uniform', 'late-reweighted', 'p30-credit025']) {
    const root = path.join(experiment, 'league', `rep-${replicate}`, arm);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    const auditPath = path.join(root, 'artifacts', `gen${endpoint}-audit.json`);
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    if (state.gen !== endpoint || state.phase !== 'idle' || audit.valid !== true) {
      throw new Error(`invalid endpoint root ${replicate}/${arm}`);
    }
    roots.push({replicate, arm, audit: path.relative(process.cwd(), auditPath), checkpointSha256: audit.checkpointSha256});
  }
}
const out = path.join(experiment, 'artifacts', 'phase1-endpoint.json');
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 'arc-v35-phase1-endpoint-v1',
  valid: true,
  endpoint,
  reason,
  performanceOutcomesInspected: false,
  promotionEligible: false,
  roots,
}, null, 2) + '\n');
console.log(out);
NODE
