#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT_REL="ml/experiments/v34-latency-first-expert-iteration"
EXPERIMENT="$ROOT/$EXPERIMENT_REL"
ARTIFACTS="$EXPERIMENT/artifacts"
STRENGTH_LOCK_REL="$EXPERIMENT_REL/artifacts/strength-tooling-lock.json"
STRENGTH_LOCK="$ROOT/$STRENGTH_LOCK_REL"
STRENGTH_PROTOCOL_REL="$EXPERIMENT_REL/strength-protocol.json"
SYSTEMS_ELIGIBILITY="$ARTIFACTS/systems-eligibility.json"
PHASE2_AUTHORIZATION="$ARTIFACTS/phase2-authorization.json"
CONDITIONS_ROOT="$ARTIFACTS/phase2/conditions"
SCRATCH="${ARC_V34_PHASE2_SCRATCH:-/dev/shm/arc-v34-phase2}"
PERSISTENT_BYTES_PER_CONDITION=$((1024 * 1024 * 1024))
WATCHDOG_SECONDS=23400
WATCHDOG_KILL_AFTER_SECONDS=60

usage() {
	cat >&2 <<'EOF'
usage:
  scripts/run-v34-phase2-screen.sh [GPU]
  scripts/run-v34-phase2-screen.sh --condition CONDITION [GPU]
  scripts/run-v34-phase2-screen.sh --retry CONDITION "INFRASTRUCTURE REASON" [GPU]

The default form runs raw and every systems-eligible candidate sequentially on one free GPU.
The retry form is manual, outcome-blind, and is accepted only after an immutable attempt-1
infrastructure failure with no outcome report.
EOF
	exit 2
}

MODE="run"
CONDITION_TO_RETRY=""
CONDITION_ONLY=""
RETRY_REASON=""
GPU="${ARC_V34_PHASE2_GPU:-5}"
if [[ "${1:-}" == "--retry" ]]; then
	[[ $# -ge 3 && $# -le 4 ]] || usage
	MODE="retry"
	CONDITION_TO_RETRY="$2"
	RETRY_REASON="$3"
	GPU="${4:-$GPU}"
elif [[ "${1:-}" == "--condition" ]]; then
	[[ $# -ge 2 && $# -le 3 ]] || usage
	MODE="condition"
	CONDITION_ONLY="$2"
	GPU="${3:-$GPU}"
elif [[ $# -le 1 ]]; then
	GPU="${1:-$GPU}"
else
	usage
fi

case "$GPU" in
	0|5|6|7) ;;
	*) echo "V34 Phase 2 GPU must be one of 0, 5, 6, or 7; GPU 4 is forbidden" >&2; exit 2 ;;
esac

cd "$ROOT"
test -f "$STRENGTH_LOCK"
test -f "$SYSTEMS_ELIGIBILITY"
test -f "$PHASE2_AUTHORIZATION"
node scripts/record-v34-phase2-condition.mjs verify-lock --strength-lock "$STRENGTH_LOCK_REL" >/dev/null

SOURCE_COMMIT="$(node -e "const x=require('./$STRENGTH_LOCK_REL');process.stdout.write(x.implementationCommit)")"
POLICY_REL="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(x.base.checkpointPath)")"
CATALOG_REL="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(x.base.catalogPath)")"
SEED0="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.phase2.seed0))")"
GAMES="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.phase2.games))")"
SEED_MAX="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.phase2.seedMax))")"
REPLAY_GAMES="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.phase2.replayAudit.games))")"
REPLAY_WORKERS="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.phase2.replayAudit.workers))")"
MINIMUM_SCRATCH_BYTES="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.runtime.minimumScratchFreeBytes))")"
MAX_CONCURRENT_CONDITIONS="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.runtime.maxConcurrentConditions))")"
MAX_ACTOR_WORKERS="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.runtime.maxActorWorkers))")"
MAX_WORKERS_PER_CONDITION="$(node -e "const x=require('./$EXPERIMENT_REL/protocol.json');process.stdout.write(String(Math.max(...x.systems.throughput.workerCounts)))")"
CONDITIONS=(raw)
while IFS= read -r arm; do
	[[ -n "$arm" ]] && CONDITIONS+=("$arm")
done < <(node -e "const x=require('$PHASE2_AUTHORIZATION');for(const arm of x.eligibleCandidateArms)console.log(arm)")

is_scheduled_condition() {
	local wanted="$1" condition
	for condition in "${CONDITIONS[@]}"; do
		[[ "$condition" == "$wanted" ]] && return 0
	done
	return 1
}

workers_for() {
	local condition="$1"
	if [[ "$condition" == "raw" ]]; then
		node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(String(x.runtime.rawWorkers))"
		return
	fi
	node -e '
		const [file, id] = process.argv.slice(1);
		const x = require(file);
		const arm = x.arms.find((row) => row.id === id);
		if (!arm || arm.operationallyEligible !== true || !Number.isSafeInteger(arm.selectedWorkers)) process.exit(2);
		process.stdout.write(String(arm.selectedWorkers));
	' "$SYSTEMS_ELIGIBILITY" "$condition"
}

free_bytes() {
	local target="$1"
	df -Pk "$target" | awk 'NR == 2 { printf "%.0f\n", $4 * 1024 }'
}

gpu_is_free() {
	local gpu="$1" uuid compute_apps
	command -v nvidia-smi >/dev/null
	if ! uuid="$(nvidia-smi --id="$gpu" --query-gpu=uuid --format=csv,noheader | tr -d '[:space:]')"; then
		echo "V34 Phase 2 could not query GPU $gpu identity" >&2
		return 1
	fi
	[[ -n "$uuid" ]]
	if ! compute_apps="$(nvidia-smi --query-compute-apps=gpu_uuid --format=csv,noheader 2>/dev/null)"; then
		echo "V34 Phase 2 could not query live GPU occupancy" >&2
		return 1
	fi
	if printf '%s\n' "$compute_apps" | tr -d ' \t\r' | grep -Fxq "$uuid"; then
		echo "V34 Phase 2 GPU $gpu is occupied; wait or select another eligible free GPU" >&2
		return 1
	fi
}

verify_completion() {
	local condition="$1" manifest="$CONDITIONS_ROOT/$condition/completion.json"
	node scripts/record-v34-phase2-condition.mjs verify \
		--strength-lock "$STRENGTH_LOCK_REL" --manifest "$manifest" >/dev/null
}

freeze_attempt() {
	local dir="$1"
	find "$dir" -type f -exec chmod 0444 {} +
	find "$dir" -type d -exec chmod 0555 {} +
}

record_failure() {
	local condition="$1" attempt="$2" dir="$3" report="$4" exit_code="$5" reason_code="$6"
	local out="$dir/failure.json"
	node --input-type=module - "$out" "$condition" "$attempt" "$report" "$exit_code" "$reason_code" \
		"$SOURCE_COMMIT" "$STRENGTH_LOCK_REL" "$dir/launch.json" "$dir/launch.pid" \
		"$dir/exit-code.txt" "$dir/infer.log" "$dir/evaluator.stdout" "$dir/evaluator.stderr" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out, condition, attemptText, report, exitText, reasonCode, sourceCommit, lockPath, ...files] = process.argv.slice(2);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const relative = (file) => path.relative(process.cwd(), path.resolve(file));
const record = (file) => ({ path: relative(file), bytes: readFileSync(file).length, sha256: sha256(file) });
const names = ['launch', 'launchPid', 'exitCode', 'inferLog', 'stdout', 'stderr'];
const inputs = {};
for (let index = 0; index < files.length; index += 1) {
	if (existsSync(files[index])) inputs[names[index]] = record(files[index]);
}
const reportExists = existsSync(report);
if (reportExists) inputs.report = record(report);
const value = {
	schemaVersion: 'arc-v34-phase2-attempt-failure-v1',
	condition,
	attempt: Number(attemptText),
	runtimeError: true,
	reasonCode,
	exitCode: Number(exitText),
	reportExists,
	outcomesInspected: false,
	sourceCommit,
	strengthLockSha256: sha256(lockPath),
	files: inputs
};
writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
chmodSync(out, 0o444);
NODE
}

write_retry_justification() {
	local condition="$1" base="$2" out="$3" reason="$4"
	local failure="$base/attempt-1/failure.json" report="$base/attempt-1/report.json"
	node --input-type=module - "$out" "$condition" "$reason" "$failure" "$report" \
		"$SOURCE_COMMIT" "$STRENGTH_LOCK_REL" "$SEED0" "$GAMES" "$SEED_MAX" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out, condition, reason, failurePath, reportPath, sourceCommit, lockPath, seed0, games, seedMax] = process.argv.slice(2);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
assert(existsSync(failurePath), 'attempt 1 has no immutable failure evidence');
assert(!existsSync(reportPath), 'retry forbidden after an outcome report exists');
assert(/(infra|server|socket|cuda|gpu|oom|process|signal|host|machine|power|filesystem|disk|network|runtime|interrupt|service)/i.test(reason), 'manual retry reason is not infrastructure-specific');
assert(!/(outcome|result|win|victor|score|\bvp\b|stall|malform|missing seed|duplicate|provenance|replay|safety|integrity|weak|strength)/i.test(reason), 'manual retry reason may depend on outcomes or semantic validation');
const failure = JSON.parse(readFileSync(failurePath, 'utf8'));
const retryableCodes = { 'server-start': 90, 'process-interrupted': 92 };
assert(
	failure.schemaVersion === 'arc-v34-phase2-attempt-failure-v1' &&
	failure.condition === condition && failure.attempt === 1 && failure.runtimeError === true &&
	failure.reportExists === false && failure.outcomesInspected === false &&
	failure.sourceCommit === sourceCommit && failure.strengthLockSha256 === sha256(lockPath) &&
	Object.hasOwn(retryableCodes, failure.reasonCode) &&
	failure.exitCode === retryableCodes[failure.reasonCode],
	'attempt 1 is not retry-eligible'
);
assert(
	JSON.stringify(Object.keys(failure.files ?? {}).sort()) ===
	JSON.stringify(['exitCode', 'inferLog', 'launch', 'launchPid', 'stderr', 'stdout']),
	'attempt 1 failure inventory is incomplete'
);
for (const record of Object.values(failure.files)) {
	assert(
		record && typeof record.path === 'string' && Number.isSafeInteger(record.bytes) &&
		record.bytes >= 0 && /^[0-9a-f]{64}$/.test(record.sha256) && existsSync(record.path) &&
		readFileSync(record.path).length === record.bytes && sha256(record.path) === record.sha256,
		'attempt 1 failure input hash mismatch'
	);
}
const relative = (file) => path.relative(process.cwd(), path.resolve(file));
const value = {
	schemaVersion: 'arc-v34-phase2-retry-justification-v1',
	condition,
	attempt: 2,
	reason,
	reasonCode: failure.reasonCode,
	infrastructureAttributed: true,
	identicalSeedRetry: true,
	outcomesInspected: false,
	attempt1ReportExisted: false,
	sourceCommit,
	strengthLockSha256: sha256(lockPath),
	seed0: Number(seed0),
	games: Number(games),
	seedMax: Number(seedMax),
	failureEvidence: {
		path: relative(failurePath),
		bytes: readFileSync(failurePath).length,
		sha256: sha256(failurePath)
	}
};
if (existsSync(out)) {
	assert(JSON.stringify(JSON.parse(readFileSync(out, 'utf8'))) === JSON.stringify(value),
		'existing retry justification differs from the requested identical retry');
} else {
	writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
	chmodSync(out, 0o444);
}
NODE
}

SERVER_PID=""
EVALUATOR_PID=""
ACTIVE_CONDITION=""
ACTIVE_ATTEMPT=""
ACTIVE_DIR=""
ACTIVE_REPORT=""
cleanup_server() {
	if [[ -n "$SERVER_PID" ]]; then
		kill -TERM "$SERVER_PID" 2>/dev/null || true
		for _ in $(seq 1 100); do
			kill -0 "$SERVER_PID" 2>/dev/null || break
			sleep 0.1
		done
		kill -KILL "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=""
	fi
}

interrupt_attempt() {
	trap - EXIT INT TERM
	set +e
	if [[ -n "$EVALUATOR_PID" ]]; then
		kill -TERM -- "-$EVALUATOR_PID" 2>/dev/null || kill "$EVALUATOR_PID" 2>/dev/null || true
		wait "$EVALUATOR_PID" 2>/dev/null || true
		EVALUATOR_PID=""
	fi
	cleanup_server
	if [[ -n "$ACTIVE_DIR" && -d "$ACTIVE_DIR" ]]; then
		[[ -e "$ACTIVE_DIR/evaluator.stdout" ]] || : > "$ACTIVE_DIR/evaluator.stdout"
		[[ -e "$ACTIVE_DIR/evaluator.stderr" ]] || : > "$ACTIVE_DIR/evaluator.stderr"
		[[ -e "$ACTIVE_DIR/infer.log" ]] || : > "$ACTIVE_DIR/infer.log"
		[[ -e "$ACTIVE_DIR/launch.pid" ]] || printf '%s\n' 'not-launched' > "$ACTIVE_DIR/launch.pid"
		printf '%s\n' '92' > "$ACTIVE_DIR/exit-code.txt"
		if [[ ! -e "$ACTIVE_DIR/failure.json" ]]; then
			record_failure "$ACTIVE_CONDITION" "$ACTIVE_ATTEMPT" "$ACTIVE_DIR" "$ACTIVE_REPORT" 92 process-interrupted
		fi
		freeze_attempt "$ACTIVE_DIR"
	fi
	echo "V34 Phase 2 active condition interrupted; immutable failure evidence recorded" >&2
	exit 130
}

run_condition() {
	local condition="$1" attempt="$2" workers="$3" justification="${4:-}"
	local base="$CONDITIONS_ROOT/$condition" dir="$base/attempt-$attempt"
	local report="$dir/report.json" replay_report="$dir/replay-report.json"
	local report_rel replay_report_rel socket tmp status replay_status reason_code
	(( workers >= 1 && workers <= MAX_WORKERS_PER_CONDITION ))
	(( MAX_CONCURRENT_CONDITIONS * workers <= MAX_ACTOR_WORKERS ))
	gpu_is_free "$GPU"
	base="$(mkdir -p "$base" && cd "$base" && pwd)"
	dir="$base/attempt-$attempt"
	test ! -e "$dir"
	mkdir "$dir"
	ACTIVE_CONDITION="$condition"
	ACTIVE_ATTEMPT="$attempt"
	ACTIVE_DIR="$dir"
	ACTIVE_REPORT="$report"
	EVALUATOR_PID=""
	trap cleanup_server EXIT
	trap interrupt_attempt INT TERM
	tmp="$SCRATCH/$condition/attempt-$attempt/tmp"
	socket="$SCRATCH/$condition/attempt-$attempt/infer.sock"
	test ! -e "${tmp%/tmp}"
	mkdir -p "$tmp"
	report_rel="$(node -e "const path=require('node:path');process.stdout.write(path.relative(process.cwd(),path.resolve(process.argv[1])))" "$report")"
	replay_report_rel="$(node -e "const path=require('node:path');process.stdout.write(path.relative(process.cwd(),path.resolve(process.argv[1])))" "$replay_report")"

	local arm_args=()
	case "$condition" in
		raw) ;;
		rerank-p025) arm_args=(--rerank-policy-weight 0.25) ;;
		rerank-p050) arm_args=(--rerank-policy-weight 0.5) ;;
		rerank-p075) arm_args=(--rerank-policy-weight 0.75) ;;
		rerank-p100) arm_args=(--rerank-policy-weight 1) ;;
		heuristic-s4-h2) arm_args=(--search-sims 4 --search-horizon 2 --search-objective solo-reach30 --search-rollout heuristic --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0) ;;
		heuristic-s8-h3) arm_args=(--search-sims 8 --search-horizon 3 --search-objective solo-reach30 --search-rollout heuristic --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0) ;;
		*) echo "unknown V34 Phase 2 condition $condition" >&2; return 2 ;;
	esac
	local evaluator_args=(
		scripts/evaluate-solo-checkpoint.mjs
		--weights "$POLICY_REL" --catalog "$CATALOG_REL" --source-commit "$SOURCE_COMMIT"
		--infer-socket "$socket" --policy-obs-version 2
		--games "$GAMES" --workers "$workers" --seed0 "$SEED0"
		--max-rounds 30 --max-status-level 2 --sample --temperature 0.55
		--include-games "${arm_args[@]}" --out "$report_rel"
	)
	local replay_evaluator_args=(
		scripts/evaluate-solo-checkpoint.mjs
		--weights "$POLICY_REL" --catalog "$CATALOG_REL" --source-commit "$SOURCE_COMMIT"
		--infer-socket "$socket" --policy-obs-version 2
		--games "$REPLAY_GAMES" --workers "$REPLAY_WORKERS" --seed0 "$SEED0"
		--max-rounds 30 --max-status-level 2 --sample --temperature 0.55
		--include-games "${arm_args[@]}" --out "$replay_report_rel"
	)

	local justification_arg="-"
	[[ -n "$justification" ]] && justification_arg="$justification"
	node --input-type=module - "$dir/launch.json" "$condition" "$attempt" "$workers" "$GPU" \
		"$SOURCE_COMMIT" "$STRENGTH_LOCK_REL" "$justification_arg" "$WATCHDOG_SECONDS" \
		"$WATCHDOG_KILL_AFTER_SECONDS" "${evaluator_args[@]}" --V34-REPLAY-ARGS-- \
		"${replay_evaluator_args[@]}" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out, condition, attemptText, workersText, gpuText, sourceCommit, lockPath, justification, watchdogText, killAfterText, ...allArgs] = process.argv.slice(2);
const marker = allArgs.indexOf('--V34-REPLAY-ARGS--');
if (marker <= 0 || marker === allArgs.length - 1) throw new Error('launch replay argv delimiter missing');
const evaluatorArgs = allArgs.slice(0, marker);
const replayEvaluatorArgs = allArgs.slice(marker + 1);
const protocol = JSON.parse(readFileSync('ml/experiments/v34-latency-first-expert-iteration/protocol.json', 'utf8'));
const strength = JSON.parse(readFileSync('ml/experiments/v34-latency-first-expert-iteration/strength-protocol.json', 'utf8'));
const systems = JSON.parse(readFileSync('ml/experiments/v34-latency-first-expert-iteration/artifacts/systems-eligibility.json', 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const relative = (file) => path.relative(process.cwd(), path.resolve(file));
const selectedWorkers = Number(workersText);
const arm = condition === 'raw'
	? { id: 'raw', kind: 'raw', selectedWorkers }
	: { ...protocol.systems.candidateArms.find((row) => row.id === condition), selectedWorkers };
if (!arm.id || (condition !== 'raw' && systems.arms.find((row) => row.id === condition)?.selectedWorkers !== selectedWorkers)) {
	throw new Error('launch arm/worker contract mismatch');
}
const value = {
	schemaVersion: 'arc-v34-phase2-launch-v1',
	condition,
	attempt: Number(attemptText),
	workers: selectedWorkers,
	gpu: Number(gpuText),
	sourceCommit,
	watchdogSeconds: Number(watchdogText),
	watchdogKillAfterSeconds: Number(killAfterText),
	strengthLock: { path: relative(lockPath), sha256: sha256(lockPath) },
	seed0: strength.phase2.seed0,
	games: strength.phase2.games,
	seedMax: strength.phase2.seedMax,
	commonDecode: strength.commonDecode,
	arm,
	checkpoint: { path: strength.base.checkpointPath, sha256: strength.base.checkpointSha256 },
	catalog: { path: strength.base.catalogPath, sha256: strength.base.catalogSha256 },
	retryJustification: justification === '-' ? null : { path: relative(justification), sha256: sha256(justification) },
		evaluatorArgs,
		replayEvaluatorArgs
};
writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
chmodSync(out, 0o444);
NODE

	env CUDA_VISIBLE_DEVICES="$GPU" nice -n 19 ml/.venv/bin/python ml/infer_server.py \
		--weights "$POLICY_REL" --socket "$socket" --device cuda --window-ms 2 --max-batch 512 \
		--stats-interval 5 > "$dir/infer.log" 2>&1 &
	SERVER_PID=$!
	local ready=false
	for _ in $(seq 1 120); do
		if [[ -S "$socket" ]]; then ready=true; break; fi
		kill -0 "$SERVER_PID" 2>/dev/null || break
		sleep 1
	done
	if [[ "$ready" != true ]]; then
		: > "$dir/evaluator.stdout"
		: > "$dir/evaluator.stderr"
		printf '%s\n' 'not-launched' > "$dir/launch.pid"
		printf '%s\n' '90' > "$dir/exit-code.txt"
		cleanup_server
		record_failure "$condition" "$attempt" "$dir" "$report" 90 server-start
		freeze_attempt "$dir"
		trap - EXIT INT TERM
		ACTIVE_DIR=""
		echo "V34 Phase 2 $condition attempt $attempt failed before evaluator launch" >&2
		return 1
	fi

	set +e
	setsid timeout --signal=TERM --kill-after="${WATCHDOG_KILL_AFTER_SECONDS}s" "${WATCHDOG_SECONDS}s" \
		env ARC_INFER_WIRE=binary TMPDIR="$tmp" nice -n 19 node "${evaluator_args[@]}" \
		> "$dir/evaluator.stdout" 2> "$dir/evaluator.stderr" &
	EVALUATOR_PID=$!
	printf '%s\n' "$EVALUATOR_PID" > "$dir/launch.pid"
	wait "$EVALUATOR_PID"
	status=$?
	EVALUATOR_PID=""
	set -e
		reason_code=evaluator-exit
	if [[ "$status" -eq 124 ]]; then
		reason_code=evaluator-timeout
	fi
		if [[ "$status" -eq 0 && ! -f "$report" ]]; then
		status=91
		reason_code=missing-report
		fi
		if [[ "$status" -eq 0 ]]; then
			set +e
			setsid timeout --signal=TERM --kill-after="${WATCHDOG_KILL_AFTER_SECONDS}s" 1800s \
				env ARC_INFER_WIRE=binary TMPDIR="$tmp" nice -n 19 node "${replay_evaluator_args[@]}" \
				> "$dir/replay-evaluator.stdout" 2> "$dir/replay-evaluator.stderr" &
			EVALUATOR_PID=$!
			wait "$EVALUATOR_PID"
			replay_status=$?
			EVALUATOR_PID=""
			set -e
			printf '%s\n' "$replay_status" > "$dir/replay-exit-code.txt"
			if [[ "$replay_status" -ne 0 || ! -f "$replay_report" ]]; then
				status=93
				reason_code=replay-audit-failure
			fi
		fi
		cleanup_server
		printf '%s\n' "$status" > "$dir/exit-code.txt"
	if [[ "$status" -ne 0 ]]; then
		record_failure "$condition" "$attempt" "$dir" "$report" "$status" "$reason_code"
		freeze_attempt "$dir"
		trap - EXIT INT TERM
		ACTIVE_DIR=""
		echo "V34 Phase 2 $condition attempt $attempt failed with exit $status" >&2
		return 1
	fi

	local record_justification_args=()
	[[ -n "$justification" ]] && record_justification_args=(--justification "$justification")
	set +e
	node scripts/record-v34-phase2-condition.mjs record \
		--strength-lock "$STRENGTH_LOCK_REL" --condition "$condition" --attempt "$attempt" \
			--workers "$workers" --report "$report" --infer-log "$dir/infer.log" \
			--replay-report "$replay_report" --replay-stdout "$dir/replay-evaluator.stdout" \
			--replay-stderr "$dir/replay-evaluator.stderr" \
			--replay-exit-code "$dir/replay-exit-code.txt" \
		--stdout "$dir/evaluator.stdout" --stderr "$dir/evaluator.stderr" \
		--launch "$dir/launch.json" --launch-pid "$dir/launch.pid" --exit-code "$dir/exit-code.txt" \
		"${record_justification_args[@]}" --out "$base/completion.json" \
		> "$dir/record.stdout" 2> "$dir/record.stderr"
	status=$?
	set -e
	printf '%s\n' "$status" > "$dir/record-exit-code.txt"
	trap - EXIT INT TERM
	ACTIVE_DIR=""
	freeze_attempt "$dir"
	if [[ "$status" -ne 0 ]]; then
		echo "V34 Phase 2 $condition produced an outcome report that failed strict recording; retry is forbidden" >&2
		return 1
	fi
	verify_completion "$condition"
	echo "V34 Phase 2 completed and hash-verified: $condition (attempt $attempt)"
}

mkdir -p "$CONDITIONS_ROOT" "$SCRATCH"
command -v timeout >/dev/null
command -v flock >/dev/null
command -v setsid >/dev/null
CONDITION_SLOT=""
for slot in $(seq 1 "$MAX_CONCURRENT_CONDITIONS"); do
	exec 8>"$SCRATCH/.condition-slot-$slot.lock"
	if flock -n 8; then
		CONDITION_SLOT="$slot"
		break
	fi
	exec 8>&-
done
if [[ -z "$CONDITION_SLOT" ]]; then
	echo "V34 Phase 2 already has the protocol maximum of $MAX_CONCURRENT_CONDITIONS concurrent runners" >&2
	exit 2
fi
exec 9>"$SCRATCH/.gpu-$GPU.lock"
if ! flock -n 9; then
	echo "another V34 Phase 2 runner holds the GPU $GPU execution lock" >&2
	exit 2
fi
scratch_free="$(free_bytes "$SCRATCH")"
if (( scratch_free < MINIMUM_SCRATCH_BYTES )); then
	echo "V34 Phase 2 requires at least $MINIMUM_SCRATCH_BYTES scratch bytes; found $scratch_free" >&2
	exit 2
fi
remaining=0
for condition in "${CONDITIONS[@]}"; do
	[[ -f "$CONDITIONS_ROOT/$condition/completion.json" ]] || remaining=$((remaining + 1))
done
persistent_required=$((remaining * PERSISTENT_BYTES_PER_CONDITION))
persistent_free="$(free_bytes "$ARTIFACTS")"
if (( persistent_free < persistent_required )); then
	echo "V34 Phase 2 persistent headroom is insufficient: need $persistent_required bytes, found $persistent_free" >&2
	exit 2
fi

if [[ "$MODE" == "retry" ]]; then
	is_scheduled_condition "$CONDITION_TO_RETRY" || { echo "condition is not in the authorized Phase 2 schedule" >&2; exit 2; }
	base="$CONDITIONS_ROOT/$CONDITION_TO_RETRY"
	test ! -e "$base/completion.json"
	test -d "$base/attempt-1"
	test ! -e "$base/attempt-2"
	retry_workers="$(workers_for "$CONDITION_TO_RETRY")"
	gpu_is_free "$GPU"
	write_retry_justification "$CONDITION_TO_RETRY" "$base" "$base/retry-justification.json" "$RETRY_REASON"
	run_condition "$CONDITION_TO_RETRY" 2 "$retry_workers" "$base/retry-justification.json"
	exit 0
fi

run_or_skip_condition() {
	local condition="$1" base="$CONDITIONS_ROOT/$1"
	if [[ -e "$base/completion.json" || -e "$base/completion.json.sha256" ]]; then
		verify_completion "$condition"
		echo "V34 Phase 2 hash-verified skip: $condition"
		return 0
	fi
	if [[ -e "$base/attempt-1" || -e "$base/attempt-2" || -e "$base/retry-justification.json" ]]; then
		echo "V34 Phase 2 $condition has an incomplete immutable attempt; inspect it and use the explicit --retry form only for a qualifying infrastructure failure" >&2
		return 2
	fi
	run_condition "$condition" 1 "$(workers_for "$condition")"
}

if [[ "$MODE" == "condition" ]]; then
	is_scheduled_condition "$CONDITION_ONLY" || { echo "condition is not in the authorized Phase 2 schedule" >&2; exit 2; }
	run_or_skip_condition "$CONDITION_ONLY"
	exit 0
fi

for condition in "${CONDITIONS[@]}"; do
	run_or_skip_condition "$condition"
done

echo "V34 Phase 2 execution complete. No analysis or later-stage authorization was run."
