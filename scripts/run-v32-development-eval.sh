#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT="$ROOT/scripts/run-v32-development-eval.sh"
EXPERIMENT="$ROOT/ml/experiments/v32-onpolicy-solo"
FREEZE="${ARC_V32_DEVELOPMENT_FREEZE:-$EXPERIMENT/artifacts/development-freeze.json}"
AUTHORIZATION="${ARC_V32_DEVELOPMENT_AUTHORIZATION:-$EXPERIMENT/artifacts/development-authorization.json}"
DEVELOPMENT="${ARC_V32_DEVELOPMENT_DIR:-$EXPERIMENT/development}"
PREDEVELOPMENT="${ARC_V32_PREDEVELOPMENT_DIR:-$EXPERIMENT/predevelopment}"
REPORTS_MANIFEST="$EXPERIMENT/artifacts/development-reports.json"
SCRATCH="${ARC_V32_EVAL_SCRATCH:-/dev/shm/arc-v32-development}"
PYTHON="${ARC_V32_PYTHON:-$ROOT/ml/.venv/bin/python}"

cd "$ROOT"

freeze_verify() {
  PYTHONPATH=ml "$PYTHON" ml/freeze_v32_development.py verify --manifest "$FREEZE"
}

authorization_verify() {
  PYTHONPATH=ml "$PYTHON" ml/freeze_v32_development.py verify-authorization \
    --manifest "$AUTHORIZATION" --freeze "$FREEZE"
}

manifest_value() {
  local expression="$1" file="${2:-$FREEZE}"
  jq -er "$expression" "$file"
}

resource_preflight() {
  mkdir -p "$SCRATCH"
  test -w "$SCRATCH"
  local scratch_kib data_kib
  scratch_kib="$(df -Pk "$SCRATCH" | awk 'NR == 2 {print $4}')"
  data_kib="$(df -Pk "$EXPERIMENT" | awk 'NR == 2 {print $4}')"
  if (( scratch_kib < 16 * 1024 * 1024 )); then
    printf 'V32 evaluation requires at least 16 GiB free scratch; found %s KiB\n' "$scratch_kib" >&2
    return 1
  fi
  if (( data_kib < 8 * 1024 * 1024 )); then
    printf 'V32 evaluation requires at least 8 GiB free experiment storage; found %s KiB\n' "$data_kib" >&2
    return 1
  fi
}

start_server() {
  local weights="$1" gpu="$2" socket="$3" log="$4"
  env CUDA_VISIBLE_DEVICES="$gpu" nice -n 10 "$PYTHON" ml/infer_server.py \
    --weights "$weights" --socket "$socket" --device cuda \
    --window-ms 2 --max-batch 512 --stats-interval 5 > "$log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    [[ -S "$socket" ]] && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  return 1
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

evaluation_worker() {
  local label="$1" gpu="$2" attempt="$3"
  local attempt_dir="$DEVELOPMENT/$label/attempt-$attempt"
  local policy weights obs expected_sha catalog source socket="" code
  test -d "$attempt_dir"
  if [[ -e "$attempt_dir/report.json" || -e "$attempt_dir/exit-code" || -e "$attempt_dir/server.log" ]]; then
    printf 'refusing to reuse V32 evaluation attempt: %s\n' "$attempt_dir" >&2
    exit 97
  fi
  policy=".policies[\"$label\"]"
  weights="$(manifest_value "$policy.weights")"
  obs="$(manifest_value "$policy.policyObsVersion")"
  expected_sha="$(manifest_value "$policy.weightsSha256")"
  catalog="$(manifest_value '.catalog.path')"
  source="$(manifest_value '.authorization.sourceContractSha256')"
  test "$(sha256sum "$weights" | awk '{print $1}')" = "$expected_sha"
  local work="$SCRATCH/development/$label/attempt-$attempt"
  mkdir -p "$work"
  SERVER_PID=""
  trap stop_server EXIT INT TERM
  local -a transport=(--policy-obs-version "$obs")
  if [[ "$obs" == "2" ]]; then
    socket="$work/infer.sock"
    if ! start_server "$weights" "$gpu" "$socket" "$attempt_dir/server.log"; then
      stop_server
      trap - EXIT INT TERM
      printf '98\n' > "$attempt_dir/exit-code"
      exit 98
    fi
    transport+=(--infer-socket "$socket")
  elif [[ "$obs" != "1" ]]; then
    printf 'unsupported frozen observation version: %s\n' "$obs" >&2
    printf '97\n' > "$attempt_dir/exit-code"
    exit 97
  fi
  set +e
  env TMPDIR="$work" nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$weights" "${transport[@]}" \
    --catalog "$catalog" --source-commit "$source" \
    --games 4096 --workers 24 --seed0 949000000 \
    --max-rounds 30 --max-status-level 2 \
    --sample --temperature 0.55 --include-games \
    --out "$attempt_dir/report.json"
  code=$?
  set -e
  stop_server
  trap - EXIT INT TERM
  printf '%s\n' "$code" > "$attempt_dir/exit-code"
  exit "$code"
}

freeze_failure() {
  local label="$1" attempt="$2" code="$3"
  local attempt_dir="$DEVELOPMENT/$label/attempt-$attempt"
  local out="$attempt_dir/failure-evidence.json"
  test ! -e "$out"
  local run_sha server_sha exit_sha launch_sha report_exists
  run_sha="$(sha256sum "$attempt_dir/run.log" | awk '{print $1}')"
  exit_sha="$(sha256sum "$attempt_dir/exit-code" | awk '{print $1}')"
  launch_sha="$(sha256sum "$attempt_dir/launch-pid" | awk '{print $1}')"
  server_sha=""
  [[ ! -f "$attempt_dir/server.log" ]] || server_sha="$(sha256sum "$attempt_dir/server.log" | awk '{print $1}')"
  report_exists=false
  [[ ! -e "$attempt_dir/report.json" ]] || report_exists=true
  jq -n \
    --arg label "$label" --argjson attempt "$attempt" --argjson exitCode "$code" \
    --arg runLog "${attempt_dir#"$ROOT/"}/run.log" --arg runLogSha256 "$run_sha" \
    --arg exitPath "${attempt_dir#"$ROOT/"}/exit-code" --arg exitSha256 "$exit_sha" \
    --arg launchPath "${attempt_dir#"$ROOT/"}/launch-pid" --arg launchSha256 "$launch_sha" \
    --arg serverLog "${attempt_dir#"$ROOT/"}/server.log" --arg serverLogSha256 "$server_sha" \
    --argjson reportExists "$report_exists" \
    --arg sourceContractSha256 "$(manifest_value '.authorization.sourceContractSha256')" \
    '{schemaVersion:"arc-v32-development-failure-evidence-v1",valid:true,label:$label,attempt:$attempt,exitCode:$exitCode,reportExists:$reportExists,outcomesInspected:false,rerunAuthorized:false,sourceContractSha256:$sourceContractSha256,contract:{seed0:949000000,seedMax:949004095,games:4096,workers:24},files:{runLog:{path:$runLog,sha256:$runLogSha256},exitCode:{path:$exitPath,sha256:$exitSha256},launchPid:{path:$launchPath,sha256:$launchSha256}} + (if $serverLogSha256 == "" then {} else {serverLog:{path:$serverLog,sha256:$serverLogSha256}} end)}' \
    > "$out"
  chmod 0444 "$out" "$attempt_dir/exit-code" "$attempt_dir/run.log" "$attempt_dir/server.log" 2>/dev/null || true
}

run_wave() {
  local -a specs=("$@") pids=() labels=()
  local spec label gpu attempt_dir
  for spec in "${specs[@]}"; do
    IFS=: read -r label gpu <<< "$spec"
    attempt_dir="$DEVELOPMENT/$label/attempt-1"
    test ! -e "$attempt_dir"
    mkdir -p "$attempt_dir"
    "$SCRIPT" --worker "$label" "$gpu" 1 > "$attempt_dir/run.log" 2>&1 &
    local worker_pid=$!
    printf '%s\n' "$worker_pid" > "$attempt_dir/launch-pid"
    pids+=("$worker_pid")
    labels+=("$label")
  done
  local failed=0 code index
  for index in "${!pids[@]}"; do
    set +e
    wait "${pids[$index]}"
    code=$?
    set -e
    if (( code != 0 )); then
      if [[ ! -f "$DEVELOPMENT/${labels[$index]}/attempt-1/exit-code" ]]; then
        printf '%s\n' "$code" > "$DEVELOPMENT/${labels[$index]}/attempt-1/exit-code"
      fi
      freeze_failure "${labels[$index]}" 1 "$code"
      printf 'V32 development policy failed label=%s code=%s\n' "${labels[$index]}" "$code" >&2
      failed=1
    fi
  done
  return "$failed"
}

record_reports() {
  test ! -e "$REPORTS_MANIFEST"
  test ! -e "$REPORTS_MANIFEST.sha256"
  PYTHONPATH=ml "$PYTHON" ml/freeze_v32_development.py record-reports \
    --freeze "$FREEZE" --authorization "$AUTHORIZATION" \
    --development "$DEVELOPMENT" --out "$REPORTS_MANIFEST"
}

orchestrate_development() {
  freeze_verify
  authorization_verify
  local failed=0
  run_wave v23:5 v30:6 shared-critic:7 rep-a-control-uniform:0 || failed=1
  run_wave rep-a-round-reweighted:5 rep-a-p30-credit025:6 rep-b-control-uniform:7 rep-b-round-reweighted:0 || failed=1
  run_wave rep-b-p30-credit025:5 rep-c-control-uniform:6 rep-c-round-reweighted:7 rep-c-p30-credit025:0 || failed=1
  if (( failed == 0 )); then
    record_reports
  fi
  printf '%s\n' "$failed" > "$DEVELOPMENT/orchestrator-exit-code"
  return "$failed"
}

predevelopment_diagnostic() {
  local dir="$PREDEVELOPMENT/v30-diagnostic" weights catalog source work socket code
  weights="$(manifest_value '.policies.v30.weights')"
  catalog="$(manifest_value '.catalog.path')"
  source="$(manifest_value '.authorization.sourceContractSha256')"
  work="$SCRATCH/predevelopment/v30-diagnostic"
  mkdir -p "$work"
  socket="$work/infer.sock"
  SERVER_PID=""
  trap stop_server EXIT INT TERM
  if ! start_server "$weights" 5 "$socket" "$dir/server.log"; then
    stop_server
    trap - EXIT INT TERM
    printf '98\n' > "$dir/exit-code"
    return 98
  fi
  set +e
  env TMPDIR="$work" nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$weights" --infer-socket "$socket" --policy-obs-version 2 \
    --catalog "$catalog" --source-commit "$source" \
    --games 256 --workers 24 --seed0 951920000 \
    --max-rounds 30 --max-status-level 2 \
    --sample --temperature 0.55 --include-games --out "$dir/report.json"
  code=$?
  set -e
  stop_server
  trap - EXIT INT TERM
  printf '%s\n' "$code" > "$dir/exit-code"
  return "$code"
}

predevelopment_latency() {
  local dir="$PREDEVELOPMENT/shared-critic-latency-smoke" weights validation work socket code
  weights="$(manifest_value '.policies["shared-critic"].weights')"
  validation="$(manifest_value '.validationCorpus.path')"
  work="$SCRATCH/predevelopment/shared-critic-latency-smoke"
  mkdir -p "$work"
  socket="$work/infer.sock"
  SERVER_PID=""
  trap stop_server EXIT INT TERM
  if ! start_server "$weights" 6 "$socket" "$dir/server.log"; then
    stop_server
    trap - EXIT INT TERM
    printf '98\n' > "$dir/exit-code"
    return 98
  fi
  set +e
  nice -n 10 "$PYTHON" ml/benchmark_infer_latency.py \
    --socket "$socket" --data "$validation" \
    --rows 32 --candidates 30 --clients 8 --warmup 20 --requests 200 \
    --out "$dir/report.json"
  code=$?
  set -e
  stop_server
  trap - EXIT INT TERM
  printf '%s\n' "$code" > "$dir/exit-code"
  return "$code"
}

orchestrate_predevelopment() {
  freeze_verify
  local tests_dir="$PREDEVELOPMENT/unit-tests" tests_code diagnostic_code latency_code
  mkdir -p "$tests_dir"
  set +e
  env PYTHONPATH=ml nice -n 10 "$PYTHON" -m unittest -v \
    ml.test_freeze_v32_development ml.test_select_v32_representatives \
    ml.test_analyze_v32_development ml.test_benchmark_infer_latency \
    > "$tests_dir/run.log" 2>&1
  tests_code=$?
  set -e
  printf '%s\n' "$tests_code" > "$tests_dir/exit-code"
  if (( tests_code != 0 )); then
    printf '%s\n' "$tests_code" > "$PREDEVELOPMENT/orchestrator-exit-code"
    return "$tests_code"
  fi
  mkdir -p "$PREDEVELOPMENT/v30-diagnostic" "$PREDEVELOPMENT/shared-critic-latency-smoke"
  predevelopment_diagnostic > "$PREDEVELOPMENT/v30-diagnostic/run.log" 2>&1 &
  local diagnostic_pid=$!
  predevelopment_latency > "$PREDEVELOPMENT/shared-critic-latency-smoke/run.log" 2>&1 &
  local latency_pid=$!
  set +e
  wait "$diagnostic_pid"
  diagnostic_code=$?
  wait "$latency_pid"
  latency_code=$?
  set -e
  if (( diagnostic_code != 0 || latency_code != 0 )); then
    printf '1\n' > "$PREDEVELOPMENT/orchestrator-exit-code"
    return 1
  fi
  test ! -e "$AUTHORIZATION"
  test ! -e "$AUTHORIZATION.sha256"
  PYTHONPATH=ml "$PYTHON" ml/freeze_v32_development.py authorize \
    --freeze "$FREEZE" \
    --diagnostic "$PREDEVELOPMENT/v30-diagnostic/report.json" \
    --latency-smoke "$PREDEVELOPMENT/shared-critic-latency-smoke/report.json" \
    --tests-exit "$PREDEVELOPMENT/unit-tests/exit-code" \
    --out "$AUTHORIZATION"
  printf '0\n' > "$PREDEVELOPMENT/orchestrator-exit-code"
}

gpu_for_label() {
  case "$1" in
    v23) printf '5\n' ;;
    v30) printf '6\n' ;;
    shared-critic) printf '7\n' ;;
    rep-a-control-uniform) printf '0\n' ;;
    rep-a-round-reweighted) printf '5\n' ;;
    rep-a-p30-credit025) printf '6\n' ;;
    rep-b-control-uniform) printf '7\n' ;;
    rep-b-round-reweighted) printf '0\n' ;;
    rep-b-p30-credit025) printf '5\n' ;;
    rep-c-control-uniform) printf '6\n' ;;
    rep-c-round-reweighted) printf '7\n' ;;
    rep-c-p30-credit025) printf '0\n' ;;
    *) return 1 ;;
  esac
}

retry_supervisor() {
  local label="$1" gpu attempt_dir code
  gpu="$(gpu_for_label "$label")"
  attempt_dir="$DEVELOPMENT/$label/attempt-2"
  printf '%s\n' "$$" > "$attempt_dir/launch-pid"
  set +e
  "$SCRIPT" --worker "$label" "$gpu" 2 > "$attempt_dir/run.log" 2>&1
  code=$?
  set -e
  if (( code != 0 )); then
    [[ -f "$attempt_dir/exit-code" ]] || printf '%s\n' "$code" > "$attempt_dir/exit-code"
    freeze_failure "$label" 2 "$code"
    return "$code"
  fi
  record_reports
}

authorize_retry() {
  local label="${1:?policy label required}" reason="${2:?infrastructure reason required}"
  freeze_verify
  authorization_verify
  gpu_for_label "$label" >/dev/null
  if [[ ! "$reason" =~ (socket|infer|inference|OOM|out.of.memory|ENOSPC|disk|device|CUDA|signal|worker.*exit) ]]; then
    printf 'retry reason is not an infrastructure attribution\n' >&2
    return 2
  fi
  if [[ "$reason" =~ (stall|weak|win|loss|VP|Elo|outcome|result|hash|integrity) ]]; then
    printf 'retry reason may not depend on outcomes, stalls, or integrity results\n' >&2
    return 2
  fi
  local policy_dir="$DEVELOPMENT/$label" failure="$policy_dir/attempt-1/failure-evidence.json"
  local retry="$policy_dir/retry-authorization.json" attempt_dir="$policy_dir/attempt-2"
  test -f "$DEVELOPMENT/orchestrator-exit-code"
  test "$(cat "$DEVELOPMENT/orchestrator-exit-code")" != "0"
  test -f "$failure"
  test "$(jq -r '.reportExists' "$failure")" = "false"
  test "$(jq -r '.outcomesInspected' "$failure")" = "false"
  test ! -e "$retry"
  test ! -e "$attempt_dir"
  test ! -e "$REPORTS_MANIFEST"
  jq -n --arg label "$label" --arg reason "$reason" \
    --arg failureEvidence "${failure#"$ROOT/"}" \
    --arg failureEvidenceSha256 "$(sha256sum "$failure" | awk '{print $1}')" \
    --arg sourceContractSha256 "$(manifest_value '.authorization.sourceContractSha256')" \
    '{schemaVersion:"arc-v32-development-retry-authorization-v1",valid:true,label:$label,attempt:2,reason:$reason,infrastructureAttributed:true,outcomesInspected:false,identicalSeedRetry:true,failureEvidence:$failureEvidence,failureEvidenceSha256:$failureEvidenceSha256,sourceContractSha256:$sourceContractSha256,contract:{seed0:949000000,seedMax:949004095,games:4096,workers:24}}' \
    > "$retry"
  chmod 0444 "$retry"
  mkdir -p "$attempt_dir"
  nohup env ARC_ROOT="$ROOT" "$SCRIPT" --retry-supervisor "$label" \
    > "$policy_dir/retry-supervisor.log" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$policy_dir/retry-supervisor.pid"
  printf 'V32 identical-seed retry launched label=%s pid=%s\n' "$label" "$!"
}

launch_background() {
  local phase="$1" directory="$2" mode="$3"
  resource_preflight
  test ! -e "$directory"
  mkdir -p "$directory"
  nohup env ARC_ROOT="$ROOT" "$SCRIPT" "$mode" \
    > "$directory/orchestrator.log" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$directory/orchestrator.pid"
  printf 'V32 %s orchestrator pid=%s\n' "$phase" "$!"
}

case "${1:-}" in
  --worker)
    shift
    evaluation_worker "$@"
    ;;
  --orchestrate)
    orchestrate_development
    ;;
  --predevelopment-orchestrate)
    orchestrate_predevelopment
    ;;
  --retry-supervisor)
    shift
    retry_supervisor "$@"
    ;;
  --retry)
    shift
    authorize_retry "$@"
    ;;
  --launch-predevelopment)
    freeze_verify
    test "$(manifest_value '.authorization.developmentSeedsOpen')" = "false"
    launch_background predevelopment "$PREDEVELOPMENT" --predevelopment-orchestrate
    ;;
  --launch|"")
    freeze_verify
    authorization_verify
    launch_background development "$DEVELOPMENT" --orchestrate
    ;;
  *)
    printf 'usage: %s [--launch-predevelopment|--launch|--retry LABEL INFRASTRUCTURE_REASON]\n' "$0" >&2
    exit 2
    ;;
esac
