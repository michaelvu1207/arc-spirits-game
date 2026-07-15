#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v35-weco-recursive-autoresearch"
AUTHORIZATION="$EXPERIMENT/artifacts/phase1-development-authorization.json"
DEVELOPMENT="$EXPERIMENT/development"
REPORTS="$EXPERIMENT/artifacts/phase1-development-reports.json"
SCRATCH="${ARC_V35_DEVELOPMENT_SCRATCH:-/dev/shm/arc-v35-development}"
LEASE="$ROOT/.leases/arc-v35-gpu7"
PYTHON="$ROOT/ml/.venv/bin/python"
GPU_UUID="GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"
SERVER_PID=""

cd "$ROOT"

sha256() {
  sha256sum "$1" | awk '{print $1}'
}

stop_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

release() {
  stop_server
  rm -rf "$LEASE"
}

verify_authorization() {
  PYTHONPATH=ml "$PYTHON" - "$AUTHORIZATION" "$ROOT" <<'PY'
import hashlib,json,sys
from pathlib import Path

authorization_path=Path(sys.argv[1]).resolve(); root=Path(sys.argv[2]).resolve()
value=json.loads(authorization_path.read_text())
if value.get('schemaVersion')!='arc-v35-phase1-development-authorization-v1' or value.get('authorized') is not True or value.get('immutable') is not True:
    raise SystemExit('invalid V35 development authorization')
if value.get('privateSeedsOpen') is not False or value.get('promotionEligible') is not False:
    raise SystemExit('forbidden V35 gate opened')
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()
for name,entry in value['files'].items():
    path=Path(entry['path']); path=path if path.is_absolute() else root/path
    if not path.is_file() or sha(path)!=entry['sha256']:
        raise SystemExit(f'hash-invalid authorized file: {name}')
for label,entry in value['policies'].items():
    path=Path(entry['weights']); path=path if path.is_absolute() else root/path
    if not path.is_file() or sha(path)!=entry['weightsSha256']:
        raise SystemExit(f'hash-invalid authorized checkpoint: {label}')
print('V35 development authorization valid')
PY
}

resource_preflight() {
  mkdir -p "$ROOT/.leases" "$SCRATCH"
  test ! -e "$LEASE"
  mkdir "$LEASE"
  printf '%s\n' "$$" > "$LEASE/pid"
  printf '%s\n' "$(date -u +%FT%TZ)" > "$LEASE/acquired-at"
  printf '%s\n' "$GPU_UUID" > "$LEASE/gpu-uuid"
  local actual_uuid
  actual_uuid="$(nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits | awk -F', ' '$1 == 7 {print $2}')"
  test "$actual_uuid" = "$GPU_UUID"
  if nvidia-smi --query-compute-apps=gpu_uuid --format=csv,noheader,nounits | grep -qx "$GPU_UUID"; then
    printf 'physical GPU 7 is not empty\n' >&2
    return 1
  fi
  local data_kib scratch_kib available_kib
  data_kib="$(df -Pk "$EXPERIMENT" | awk 'NR == 2 {print $4}')"
  scratch_kib="$(df -Pk "$SCRATCH" | awk 'NR == 2 {print $4}')"
  available_kib="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  (( data_kib >= 4 * 1024 * 1024 ))
  (( scratch_kib >= 32 * 1024 * 1024 ))
  (( available_kib >= 64 * 1024 * 1024 ))
}

start_server() {
  local weights="$1" socket="$2" log="$3"
  env CUDA_VISIBLE_DEVICES=7 nice -n 10 "$PYTHON" ml/infer_server.py \
    --weights "$weights" --socket "$socket" --device cuda \
    --window-ms 2 --max-batch 512 --stats-interval 5 >"$log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    [[ -S "$socket" ]] && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  return 1
}

policy_value() {
  local label="$1" field="$2"
  jq -er --arg label "$label" --arg field "$field" '.policies[$label][$field]' "$AUTHORIZATION"
}

run_policy() {
  local label="$1" attempt="$DEVELOPMENT/$label/attempt-1"
  local weights expected_sha work socket code
  test ! -e "$attempt"
  mkdir -p "$attempt"
  weights="$(policy_value "$label" weights)"
  expected_sha="$(policy_value "$label" weightsSha256)"
  test "$(sha256 "$weights")" = "$expected_sha"
  work="$SCRATCH/$label"
  rm -rf "$work"
  mkdir -p "$work"
  socket="$work/infer.sock"
  if ! start_server "$weights" "$socket" "$attempt/server.log"; then
    stop_server
    printf '98\n' > "$attempt/exit-code"
    return 98
  fi
  set +e
  env TMPDIR="$work" nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$weights" --infer-socket "$socket" --policy-obs-version 2 \
    --catalog ml/catalog.json \
    --source-commit "$(jq -er '.sourceContractSha256' "$AUTHORIZATION")" \
    --games 4096 --workers 24 --seed0 969030000 \
    --max-rounds 30 --max-status-level 2 \
    --sample --temperature 0.55 --include-games \
    --out "$attempt/report.json" >"$attempt/evaluator.stdout" 2>"$attempt/evaluator.stderr"
  code=$?
  set -e
  stop_server
  printf '%s\n' "$code" > "$attempt/exit-code"
  rm -rf "$work"
  return "$code"
}

record_reports() {
  test ! -e "$REPORTS"
  PYTHONPATH=ml "$PYTHON" - "$AUTHORIZATION" "$DEVELOPMENT" "$REPORTS" <<'PY'
import hashlib,json,os,sys
from pathlib import Path

authorization_path=Path(sys.argv[1]).resolve(); development=Path(sys.argv[2]).resolve(); out=Path(sys.argv[3]).resolve()
authorization=json.loads(authorization_path.read_text())
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()
reports={}
for label,policy in authorization['policies'].items():
    attempt=development/label/'attempt-1'; report_path=attempt/'report.json'; exit_path=attempt/'exit-code'
    if exit_path.read_text().strip()!='0' or not report_path.is_file(): raise SystemExit(f'incomplete V35 report: {label}')
    report=json.loads(report_path.read_text())
    if report.get('weightsSha256')!=policy['weightsSha256']: raise SystemExit(f'checkpoint mismatch: {label}')
    if report.get('seed0')!=969030000 or report.get('games')!=4096 or report.get('stalls')!=0: raise SystemExit(f'contract or stall failure: {label}')
    reports[label]={
        'path':str(report_path), 'sha256':sha(report_path),
        'exitCode':{'path':str(exit_path),'sha256':sha(exit_path)},
        'serverLog':{'path':str(attempt/'server.log'),'sha256':sha(attempt/'server.log')},
        'evaluatorStdout':{'path':str(attempt/'evaluator.stdout'),'sha256':sha(attempt/'evaluator.stdout')},
        'evaluatorStderr':{'path':str(attempt/'evaluator.stderr'),'sha256':sha(attempt/'evaluator.stderr')},
    }
value={
    'schemaVersion':'arc-v35-phase1-development-reports-v1', 'complete':True,
    'outcomesInspected':False, 'promotionEligible':False,
    'authorization':str(authorization_path), 'authorizationSha256':sha(authorization_path),
    'reports':reports,
}
tmp=out.with_suffix(out.suffix+'.tmp'); tmp.write_text(json.dumps(value,indent=2)+'\n'); os.replace(tmp,out)
print('V35 development reports frozen')
PY
}

orchestrate() {
  verify_authorization
  resource_preflight
  trap release EXIT INT TERM
  test ! -e "$DEVELOPMENT"
  test ! -e "$REPORTS"
  mkdir -p "$DEVELOPMENT"
  local label
  while IFS= read -r label; do
    run_policy "$label"
  done < <(jq -r '.policyOrder[]' "$AUTHORIZATION")
  record_reports
  printf '0\n' > "$DEVELOPMENT/orchestrator-exit-code"
}

launch() {
  verify_authorization
  test ! -e "$DEVELOPMENT"
  test ! -e "$REPORTS"
  nohup env ARC_ROOT="$ROOT" "$0" --orchestrate >"$EXPERIMENT/artifacts/phase1-development-orchestrator.log" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$EXPERIMENT/artifacts/phase1-development-orchestrator.pid"
  printf 'V35 development launched pid=%s\n' "$!"
}

case "${1:-}" in
  --launch) launch ;;
  --orchestrate) orchestrate ;;
  *) printf 'usage: %s --launch|--orchestrate\n' "$0" >&2; exit 2 ;;
esac
