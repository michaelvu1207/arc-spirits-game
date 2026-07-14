#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT_REL="ml/experiments/v34-latency-first-expert-iteration"
EXPERIMENT="$ROOT/$EXPERIMENT_REL"
PROTOCOL_REL="$EXPERIMENT_REL/guardian-execution-protocol.json"
PROTOCOL="$ROOT/$PROTOCOL_REL"
EXECUTION_LOCK_REL="$EXPERIMENT_REL/artifacts/guardian/execution-lock.json"
EXECUTION_LOCK="$ROOT/$EXECUTION_LOCK_REL"
TOOLING_LOCK_REL="$EXPERIMENT_REL/artifacts/guardian/tooling-lock.json"
AUTHORIZATION_REL="$EXPERIMENT_REL/artifacts/guardian/authorization.json"
SYSTEMS_ELIGIBILITY_REL="$EXPERIMENT_REL/artifacts/systems-eligibility.json"
CONDITIONS_ROOT="$EXPERIMENT/artifacts/guardian/conditions"
SCRATCH="${ARC_V34_GUARDIAN_SCRATCH:-/dev/shm/arc-v34-guardian}"
LEGACY_LOCK_ROOT="$(node -e "const x=require(process.argv[1]);process.stdout.write(x.runtime.legacyPhase2GpuLockRoot)" "$PROTOCOL")"

usage() {
	cat >&2 <<'EOF'
usage:
  scripts/run-v34-guardian-confirmation.sh [GPU]
  scripts/run-v34-guardian-confirmation.sh --condition CONDITION [GPU]
  scripts/run-v34-guardian-confirmation.sh --retry CONDITION "INFRASTRUCTURE REASON" [GPU]

The default form runs raw once and every authorized candidate sequentially on one free GPU.
The retry form is manual, outcome-blind, and accepted only after immutable attempt-1
server-start/90 or process-interrupted/92 evidence with no primary or replay report.
EOF
	exit 2
}

MODE="run"
CONDITION_ONLY=""
CONDITION_TO_RETRY=""
RETRY_REASON=""
GPU="${ARC_V34_GUARDIAN_GPU:-5}"
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
	*) echo "V34 guardian GPU must be one of 0, 5, 6, or 7; GPU 4 is forbidden" >&2; exit 2 ;;
esac

cd "$ROOT"
test -f "$PROTOCOL"
test -f "$EXECUTION_LOCK"
node scripts/record-v34-guardian-condition.mjs verify-lock \
	--guardian-execution-lock "$EXECUTION_LOCK_REL" >/dev/null

SOURCE_COMMIT="$(node -e "const x=require('./$EXECUTION_LOCK_REL');process.stdout.write(x.sourceCommit)")"
POLICY_REL="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(x.base.checkpoint.path)")"
CATALOG_REL="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(x.base.catalog.path)")"
SEED0="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.guardian.seed0))")"
GAMES="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.guardian.games))")"
SEED_MAX="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.guardian.seedMax))")"
REPLAY_GAMES="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.guardian.replayAudit.games))")"
REPLAY_WORKERS="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.guardian.replayAudit.workers))")"
WATCHDOG_SECONDS="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.watchdogSeconds))")"
WATCHDOG_KILL_AFTER_SECONDS="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.watchdogKillAfterSeconds))")"
REPLAY_WATCHDOG_SECONDS="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.replayWatchdogSeconds))")"
MAX_CONCURRENT_CONDITIONS="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.maxConcurrentConditions))")"
MAX_ACTOR_WORKERS="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.maxActorWorkers))")"
MINIMUM_SCRATCH_BYTES="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.minimumScratchFreeBytes))")"
MINIMUM_PERSISTENT_BYTES="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.minimumPersistentFreeBytes))")"
PERSISTENT_BYTES_PER_CONDITION="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.persistentBytesPerRemainingCondition))")"
MINIMUM_MEMORY_BYTES="$(node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.minimumAvailableMemoryBytes))")"

CONDITIONS=(raw)
while IFS= read -r arm; do
	[[ -n "$arm" ]] && CONDITIONS+=("$arm")
done < <(node -e "const x=require('./$EXECUTION_LOCK_REL');for(const arm of x.authorizedArms)console.log(arm)")

is_scheduled_condition() {
	local wanted="$1" condition
	for condition in "${CONDITIONS[@]}"; do [[ "$condition" == "$wanted" ]] && return 0; done
	return 1
}

workers_for() {
	local condition="$1"
	if [[ "$condition" == "raw" ]]; then
		node -e "const x=require('./$PROTOCOL_REL');process.stdout.write(String(x.runtime.rawWorkers))"
		return
	fi
	node -e '
		const [file,id]=process.argv.slice(1); const x=require(file);
		const arm=x.arms.find((row)=>row.id===id);
		if(!arm || arm.operationallyEligible!==true || !Number.isSafeInteger(arm.selectedWorkers))process.exit(2);
		process.stdout.write(String(arm.selectedWorkers));
	' "$SYSTEMS_ELIGIBILITY_REL" "$condition"
}

free_bytes() { df -Pk "$1" | awk 'NR == 2 { printf "%.0f\n", $4 * 1024 }'; }
available_memory_bytes() { awk '/^MemAvailable:/ { printf "%.0f\n", $2 * 1024 }' /proc/meminfo; }

gpu_identity_if_free() {
	local gpu="$1" uuid compute_apps
	uuid="$(nvidia-smi --id="$gpu" --query-gpu=uuid --format=csv,noheader | tr -d '[:space:]')"
	[[ -n "$uuid" ]]
	compute_apps="$(nvidia-smi --query-compute-apps=gpu_uuid --format=csv,noheader 2>/dev/null)"
	if printf '%s\n' "$compute_apps" | tr -d ' \t\r' | grep -Fxq "$uuid"; then
		echo "V34 guardian GPU $gpu is occupied; wait or choose another eligible GPU" >&2
		return 1
	fi
	printf '%s' "$uuid"
}

verify_completion() {
	node scripts/record-v34-guardian-condition.mjs verify \
		--guardian-execution-lock "$EXECUTION_LOCK_REL" \
		--manifest "$CONDITIONS_ROOT/$1/completion.json" >/dev/null
}

freeze_attempt() {
	find "$1" -type f -exec chmod 0444 {} +
	find "$1" -type d -exec chmod 0555 {} +
}

record_failure() {
	local condition="$1" attempt="$2" dir="$3" exit_code="$4" reason_code="$5"
	local out="$dir/failure.json"
	node --input-type=module - "$out" "$condition" "$attempt" "$exit_code" "$reason_code" \
		"$SOURCE_COMMIT" "$EXECUTION_LOCK_REL" "$dir/launch.json" "$dir/resource-snapshot.json" \
		"$dir/launch.pid" "$dir/exit-code.txt" "$dir/infer.log" \
		"$dir/evaluator.stdout" "$dir/evaluator.stderr" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out,condition,attemptText,exitText,reasonCode,sourceCommit,lockPath,...files]=process.argv.slice(2);
const sha256=(file)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const relative=(file)=>path.relative(process.cwd(),path.resolve(file));
const record=(file)=>({path:relative(file),bytes:readFileSync(file).length,sha256:sha256(file)});
const names=['launch','resourceSnapshot','launchPid','exitCode','inferLog','stdout','stderr'];
const inputs=Object.fromEntries(files.map((file,index)=>[names[index],record(file)]));
const report=path.join(path.dirname(out),'report.json');
const replay=path.join(path.dirname(out),'replay-report.json');
const value={
	schemaVersion:'arc-v34-guardian-attempt-failure-v1',condition,attempt:Number(attemptText),
	runtimeError:true,reasonCode,exitCode:Number(exitText),
	reportExists:existsSync(report),replayReportExists:existsSync(replay),outcomesInspected:false,
	sourceCommit,guardianExecutionLockSha256:sha256(lockPath),files:inputs
};
writeFileSync(out,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o444}); chmodSync(out,0o444);
NODE
}

write_retry_justification() {
	local condition="$1" base="$2" out="$3" reason="$4"
	node --input-type=module - "$out" "$condition" "$reason" "$base/attempt-1/failure.json" \
		"$SOURCE_COMMIT" "$EXECUTION_LOCK_REL" "$SEED0" "$GAMES" "$SEED_MAX" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out,condition,reason,failurePath,sourceCommit,lockPath,seed0,games,seedMax]=process.argv.slice(2);
const assert=(ok,message)=>{if(!ok)throw new Error(message)};
const sha256=(file)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const failure=JSON.parse(readFileSync(failurePath,'utf8'));
const retryable={'server-start':90,'process-interrupted':92};
assert(!existsSync(path.join(path.dirname(failurePath),'report.json')),'retry forbidden after primary report');
assert(!existsSync(path.join(path.dirname(failurePath),'replay-report.json')),'retry forbidden after replay report');
assert(failure.schemaVersion==='arc-v34-guardian-attempt-failure-v1' && failure.condition===condition &&
	failure.attempt===1 && failure.runtimeError===true && failure.reportExists===false &&
	failure.replayReportExists===false && failure.outcomesInspected===false &&
	failure.sourceCommit===sourceCommit && failure.guardianExecutionLockSha256===sha256(lockPath) &&
	Object.hasOwn(retryable,failure.reasonCode) && failure.exitCode===retryable[failure.reasonCode],
	'attempt 1 is not retry eligible');
assert(/(infra|server|socket|cuda|gpu|oom|process|signal|host|machine|power|filesystem|disk|network|runtime|interrupt|service)/i.test(reason),
	'retry reason is not infrastructure specific');
assert(!/(outcome|result|win|victor|score|\bvp\b|stall|malform|missing seed|duplicate|provenance|replay|safety|integrity|weak|strength|guardian result)/i.test(reason),
	'retry reason may depend on semantic outcomes');
const record={path:path.relative(process.cwd(),path.resolve(failurePath)),bytes:readFileSync(failurePath).length,sha256:sha256(failurePath)};
const value={
	schemaVersion:'arc-v34-guardian-retry-justification-v1',condition,attempt:2,reason,
	reasonCode:failure.reasonCode,infrastructureAttributed:true,identicalSeedRetry:true,
	outcomesInspected:false,attempt1ReportExisted:false,attempt1ReplayReportExisted:false,
	sourceCommit,guardianExecutionLockSha256:sha256(lockPath),seed0:Number(seed0),games:Number(games),
	seedMax:Number(seedMax),failureEvidence:record
};
if(existsSync(out))assert(JSON.stringify(JSON.parse(readFileSync(out,'utf8')))===JSON.stringify(value),
	'existing retry justification differs');
else {writeFileSync(out,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o444});chmodSync(out,0o444)}
NODE
}

SERVER_PID=""
EVALUATOR_PID=""
ACTIVE_CONDITION=""
ACTIVE_ATTEMPT=""
ACTIVE_DIR=""
cleanup_server() {
	if [[ -n "$SERVER_PID" ]]; then
		kill -TERM "$SERVER_PID" 2>/dev/null || true
		for _ in $(seq 1 100); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
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
		[[ -e "$ACTIVE_DIR/failure.json" ]] || record_failure "$ACTIVE_CONDITION" "$ACTIVE_ATTEMPT" "$ACTIVE_DIR" 92 process-interrupted
		freeze_attempt "$ACTIVE_DIR"
	fi
	echo "V34 guardian active condition interrupted; immutable failure evidence recorded" >&2
	exit 130
}

write_resource_snapshot() {
	local out="$1" workers="$2" uuid="$3" remaining="$4"
	local scratch_free persistent_free memory_free persistent_required load host
	scratch_free="$(free_bytes "$SCRATCH")"
	persistent_free="$(free_bytes "$EXPERIMENT/artifacts")"
	memory_free="$(available_memory_bytes)"
	persistent_required=$((MINIMUM_PERSISTENT_BYTES + remaining * PERSISTENT_BYTES_PER_CONDITION))
	(( scratch_free >= MINIMUM_SCRATCH_BYTES )) || { echo "guardian scratch headroom insufficient" >&2; return 2; }
	(( persistent_free >= persistent_required )) || { echo "guardian persistent headroom insufficient: need $persistent_required, found $persistent_free" >&2; return 2; }
	(( memory_free >= MINIMUM_MEMORY_BYTES )) || { echo "guardian memory headroom insufficient" >&2; return 2; }
	load="$(cut -d' ' -f1-3 /proc/loadavg)"
	host="$(hostname -f 2>/dev/null || hostname)"
	node --input-type=module - "$out" "$host" "$SOURCE_COMMIT" "$TOOLING_LOCK_REL" \
		"$EXECUTION_LOCK_REL" "$GPU" "$uuid" "$CONDITION_SLOT" "$workers" \
		"$MAX_CONCURRENT_CONDITIONS" "$MAX_ACTOR_WORKERS" "$scratch_free" \
		"$MINIMUM_SCRATCH_BYTES" "$persistent_free" "$persistent_required" "$remaining" \
		"$memory_free" "$MINIMUM_MEMORY_BYTES" "$load" "$SCRATCH" "$LEGACY_LOCK_ROOT" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out,host,sourceCommit,toolingLock,executionLock,gpu,uuid,slot,workers,maxConditions,maxWorkers,
	scratchFree,scratchRequired,persistentFree,persistentRequired,remaining,memoryFree,memoryRequired,
	load,scratchRoot,legacyRoot]=process.argv.slice(2);
const sha256=(file)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const relative=(file)=>path.relative(process.cwd(),path.resolve(file));
const link=(file)=>({path:relative(file),sha256:sha256(file)});
const value={
	schemaVersion:'arc-v34-guardian-resource-snapshot-v1',recordedAt:new Date().toISOString(),host,
	sourceCommit,guardianToolingLock:link(toolingLock),guardianExecutionLock:link(executionLock),
	gpu:{index:Number(gpu),uuid,computeApps:[]},
	locks:{conditionSlot:path.join(scratchRoot,`.condition-slot-${slot}.lock`),
		gpu:path.join(scratchRoot,`.gpu-${gpu}.lock`),phase2Gpu:path.join(legacyRoot,`.gpu-${gpu}.lock`)},
	workers:Number(workers),maxConcurrentConditions:Number(maxConditions),maxActorWorkers:Number(maxWorkers),
	scratch:{freeBytes:Number(scratchFree),requiredBytes:Number(scratchRequired)},
	persistent:{freeBytes:Number(persistentFree),requiredBytes:Number(persistentRequired),remainingConditions:Number(remaining)},
	memory:{availableBytes:Number(memoryFree),requiredBytes:Number(memoryRequired)},loadAverage:load,passed:true
};
writeFileSync(out,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o444});chmodSync(out,0o444);
NODE
}

run_condition() {
	local condition="$1" attempt="$2" workers="$3" justification="${4:-}"
	local base="$CONDITIONS_ROOT/$condition" dir="$base/attempt-$attempt"
	local report="$dir/report.json" replay_report="$dir/replay-report.json"
	local socket tmp status replay_status reason_code report_rel replay_report_rel uuid remaining resource_tmp
	(( MAX_CONCURRENT_CONDITIONS * workers <= MAX_ACTOR_WORKERS ))
	uuid="$(gpu_identity_if_free "$GPU")"
	remaining=0
	for scheduled in "${CONDITIONS[@]}"; do [[ -f "$CONDITIONS_ROOT/$scheduled/completion.json" ]] || remaining=$((remaining + 1)); done
	resource_tmp="$(mktemp "$SCRATCH/.resource-${condition}-attempt-${attempt}.XXXXXX")"
	rm -f "$resource_tmp"
	write_resource_snapshot "$resource_tmp" "$workers" "$uuid" "$remaining"
	base="$(mkdir -p "$base" && cd "$base" && pwd)"
	dir="$base/attempt-$attempt"
	test ! -e "$dir"
	mkdir "$dir"
	mv "$resource_tmp" "$dir/resource-snapshot.json"
	tmp="$SCRATCH/$condition/attempt-$attempt/tmp"
	socket="$SCRATCH/$condition/attempt-$attempt/infer.sock"
	test ! -e "${tmp%/tmp}"
	mkdir -p "$tmp"
	report_rel="$(node -e "const p=require('node:path');process.stdout.write(p.relative(process.cwd(),p.resolve(process.argv[1])))" "$report")"
	replay_report_rel="$(node -e "const p=require('node:path');process.stdout.write(p.relative(process.cwd(),p.resolve(process.argv[1])))" "$replay_report")"
	local arm_args=()
	case "$condition" in
		raw) ;;
		rerank-p025) arm_args=(--rerank-policy-weight 0.25) ;;
		rerank-p050) arm_args=(--rerank-policy-weight 0.5) ;;
		rerank-p075) arm_args=(--rerank-policy-weight 0.75) ;;
		rerank-p100) arm_args=(--rerank-policy-weight 1) ;;
		heuristic-s4-h2) arm_args=(--search-sims 4 --search-horizon 2 --search-objective solo-reach30 --search-rollout heuristic --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0) ;;
		heuristic-s8-h3) arm_args=(--search-sims 8 --search-horizon 3 --search-objective solo-reach30 --search-rollout heuristic --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0) ;;
		*) echo "unknown guardian condition $condition" >&2; return 2 ;;
	esac
	local evaluator_args=(scripts/evaluate-solo-checkpoint.mjs --weights "$POLICY_REL" --catalog "$CATALOG_REL"
		--source-commit "$SOURCE_COMMIT" --infer-socket "$socket" --policy-obs-version 2
		--games "$GAMES" --workers "$workers" --seed0 "$SEED0" --max-rounds 30
		--max-status-level 2 --sample --temperature 0.55 --include-games "${arm_args[@]}" --out "$report_rel")
	local replay_evaluator_args=(scripts/evaluate-solo-checkpoint.mjs --weights "$POLICY_REL" --catalog "$CATALOG_REL"
		--source-commit "$SOURCE_COMMIT" --infer-socket "$socket" --policy-obs-version 2
		--games "$REPLAY_GAMES" --workers "$REPLAY_WORKERS" --seed0 "$SEED0" --max-rounds 30
		--max-status-level 2 --sample --temperature 0.55 --include-games "${arm_args[@]}" --out "$replay_report_rel")
	local justification_arg="-"
	[[ -n "$justification" ]] && justification_arg="$justification"
	node --input-type=module - "$dir/launch.json" "$condition" "$attempt" "$workers" "$GPU" \
		"$SOURCE_COMMIT" "$EXECUTION_LOCK_REL" "$dir/resource-snapshot.json" "$justification_arg" \
		"$WATCHDOG_SECONDS" "$WATCHDOG_KILL_AFTER_SECONDS" "${evaluator_args[@]}" \
		--V34-GUARDIAN-REPLAY-ARGS-- "${replay_evaluator_args[@]}" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out,condition,attempt,workers,gpu,sourceCommit,executionLock,resourceSnapshot,justification,
	watchdog,killAfter,...args]=process.argv.slice(2);
const marker=args.indexOf('--V34-GUARDIAN-REPLAY-ARGS--'); if(marker<=0)throw new Error('missing replay delimiter');
const protocol=JSON.parse(readFileSync('ml/experiments/v34-latency-first-expert-iteration/guardian-execution-protocol.json','utf8'));
const base=JSON.parse(readFileSync('ml/experiments/v34-latency-first-expert-iteration/protocol.json','utf8'));
const systems=JSON.parse(readFileSync('ml/experiments/v34-latency-first-expert-iteration/artifacts/systems-eligibility.json','utf8'));
const lock=JSON.parse(readFileSync(executionLock,'utf8'));
const sha256=(file)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const relative=(file)=>path.relative(process.cwd(),path.resolve(file)); const link=(file)=>({path:relative(file),sha256:sha256(file)});
const selectedWorkers=Number(workers);
const arm=condition==='raw'?{id:'raw',kind:'raw',selectedWorkers}:
	{...base.systems.candidateArms.find((row)=>row.id===condition),selectedWorkers};
if(!arm.id || (condition!=='raw' && systems.arms.find((row)=>row.id===condition)?.selectedWorkers!==selectedWorkers) ||
	(condition!=='raw' && !lock.authorizedArms.includes(condition)))throw new Error('guardian arm/worker mismatch');
const value={
	schemaVersion:'arc-v34-guardian-launch-v1',condition,attempt:Number(attempt),workers:selectedWorkers,
	gpu:Number(gpu),sourceCommit,watchdogSeconds:Number(watchdog),watchdogKillAfterSeconds:Number(killAfter),
	guardianExecutionLock:link(executionLock),resourceSnapshot:link(resourceSnapshot),
	seed0:protocol.guardian.seed0,games:protocol.guardian.games,seedMax:protocol.guardian.seedMax,
	commonDecode:protocol.commonDecode,arm,
	checkpoint:{path:protocol.base.checkpoint.path,sha256:protocol.base.checkpoint.sha256},
	catalog:{path:protocol.base.catalog.path,sha256:protocol.base.catalog.sha256},
	retryJustification:justification==='-'?null:link(justification),
	evaluatorArgs:args.slice(0,marker),replayEvaluatorArgs:args.slice(marker+1)
};
writeFileSync(out,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o444});chmodSync(out,0o444);
NODE
	ACTIVE_CONDITION="$condition"; ACTIVE_ATTEMPT="$attempt"; ACTIVE_DIR="$dir"; EVALUATOR_PID=""
	trap cleanup_server EXIT
	trap interrupt_attempt INT TERM
	# Recheck occupancy immediately before serving; the resource snapshot already recorded the first empty probe.
	[[ "$(gpu_identity_if_free "$GPU")" == "$uuid" ]]
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
		: > "$dir/evaluator.stdout"; : > "$dir/evaluator.stderr"
		printf '%s\n' 'not-launched' > "$dir/launch.pid"; printf '%s\n' '90' > "$dir/exit-code.txt"
		cleanup_server
		record_failure "$condition" "$attempt" "$dir" 90 server-start
		freeze_attempt "$dir"; trap - EXIT INT TERM; ACTIVE_DIR=""
		echo "V34 guardian $condition attempt $attempt failed before evaluator launch" >&2
		return 1
	fi
	set +e
	setsid timeout --signal=TERM --kill-after="${WATCHDOG_KILL_AFTER_SECONDS}s" "${WATCHDOG_SECONDS}s" \
		env ARC_INFER_WIRE=binary TMPDIR="$tmp" nice -n 19 node "${evaluator_args[@]}" \
		> "$dir/evaluator.stdout" 2> "$dir/evaluator.stderr" &
	EVALUATOR_PID=$!; printf '%s\n' "$EVALUATOR_PID" > "$dir/launch.pid"; wait "$EVALUATOR_PID"; status=$?; EVALUATOR_PID=""
	set -e
	reason_code=evaluator-exit
	[[ "$status" -eq 124 ]] && reason_code=evaluator-timeout
	if [[ "$status" -eq 0 && ! -f "$report" ]]; then status=91; reason_code=missing-report; fi
	if [[ "$status" -eq 0 ]]; then
		set +e
		setsid timeout --signal=TERM --kill-after="${WATCHDOG_KILL_AFTER_SECONDS}s" "${REPLAY_WATCHDOG_SECONDS}s" \
			env ARC_INFER_WIRE=binary TMPDIR="$tmp" nice -n 19 node "${replay_evaluator_args[@]}" \
			> "$dir/replay-evaluator.stdout" 2> "$dir/replay-evaluator.stderr" &
		EVALUATOR_PID=$!; wait "$EVALUATOR_PID"; replay_status=$?; EVALUATOR_PID=""; set -e
		printf '%s\n' "$replay_status" > "$dir/replay-exit-code.txt"
		if [[ "$replay_status" -ne 0 || ! -f "$replay_report" ]]; then status=93; reason_code=replay-audit-failure; fi
	fi
	cleanup_server
	printf '%s\n' "$status" > "$dir/exit-code.txt"
	if [[ "$status" -ne 0 ]]; then
		record_failure "$condition" "$attempt" "$dir" "$status" "$reason_code"
		freeze_attempt "$dir"; trap - EXIT INT TERM; ACTIVE_DIR=""
		echo "V34 guardian $condition attempt $attempt failed with exit $status" >&2
		return 1
	fi
	local justification_args=()
	[[ -n "$justification" ]] && justification_args=(--justification "$justification")
	set +e
	node scripts/record-v34-guardian-condition.mjs record --guardian-execution-lock "$EXECUTION_LOCK_REL" \
		--condition "$condition" --attempt "$attempt" --workers "$workers" --report "$report" \
		--replay-report "$replay_report" --replay-stdout "$dir/replay-evaluator.stdout" \
		--replay-stderr "$dir/replay-evaluator.stderr" --replay-exit-code "$dir/replay-exit-code.txt" \
		--infer-log "$dir/infer.log" --stdout "$dir/evaluator.stdout" --stderr "$dir/evaluator.stderr" \
		--launch "$dir/launch.json" --resource-snapshot "$dir/resource-snapshot.json" \
		--launch-pid "$dir/launch.pid" --exit-code "$dir/exit-code.txt" "${justification_args[@]}" \
		--out "$base/completion.json" > "$dir/record.stdout" 2> "$dir/record.stderr"
	status=$?; set -e
	printf '%s\n' "$status" > "$dir/record-exit-code.txt"
	trap - EXIT INT TERM; ACTIVE_DIR=""; freeze_attempt "$dir"
	if [[ "$status" -ne 0 ]]; then
		echo "V34 guardian $condition produced a report that failed strict recording; retry is forbidden" >&2
		return 1
	fi
	verify_completion "$condition"
	echo "V34 guardian completed and hash-verified: $condition (attempt $attempt)"
}

mkdir -p "$SCRATCH" "$LEGACY_LOCK_ROOT" "$CONDITIONS_ROOT"
command -v timeout >/dev/null; command -v flock >/dev/null; command -v setsid >/dev/null; command -v nvidia-smi >/dev/null
CONDITION_SLOT=""
for slot in $(seq 1 "$MAX_CONCURRENT_CONDITIONS"); do
	eval "exec $((10 + slot))>\"$SCRATCH/.condition-slot-$slot.lock\""
	fd=$((10 + slot))
	if flock -n "$fd"; then CONDITION_SLOT="$slot"; CONDITION_FD="$fd"; break; fi
	eval "exec ${fd}>&-"
done
if [[ -z "$CONDITION_SLOT" ]]; then echo "V34 guardian condition concurrency limit reached" >&2; exit 2; fi
exec 8>"$SCRATCH/.gpu-$GPU.lock"
flock -n 8 || { echo "another guardian runner holds GPU $GPU" >&2; exit 2; }
exec 9>"$LEGACY_LOCK_ROOT/.gpu-$GPU.lock"
flock -n 9 || { echo "a Phase 2 runner holds GPU $GPU" >&2; exit 2; }

if [[ "$MODE" == "retry" ]]; then
	is_scheduled_condition "$CONDITION_TO_RETRY" || { echo "condition is not authorized" >&2; exit 2; }
	base="$CONDITIONS_ROOT/$CONDITION_TO_RETRY"
	test ! -e "$base/completion.json"; test -d "$base/attempt-1"; test ! -e "$base/attempt-2"
	write_retry_justification "$CONDITION_TO_RETRY" "$base" "$base/retry-justification.json" "$RETRY_REASON"
	run_condition "$CONDITION_TO_RETRY" 2 "$(workers_for "$CONDITION_TO_RETRY")" "$base/retry-justification.json"
	exit 0
fi

run_or_skip_condition() {
	local condition="$1" base="$CONDITIONS_ROOT/$1"
	if [[ -e "$base/completion.json" || -e "$base/completion.json.sha256" ]]; then
		verify_completion "$condition"; echo "V34 guardian hash-verified skip: $condition"; return
	fi
	if [[ -e "$base/attempt-1" || -e "$base/attempt-2" || -e "$base/retry-justification.json" ]]; then
		echo "V34 guardian $condition has an incomplete immutable attempt; only an eligible explicit retry is allowed" >&2
		return 2
	fi
	run_condition "$condition" 1 "$(workers_for "$condition")"
}

if [[ "$MODE" == "condition" ]]; then
	is_scheduled_condition "$CONDITION_ONLY" || { echo "condition is not authorized" >&2; exit 2; }
	run_or_skip_condition "$CONDITION_ONLY"; exit 0
fi
for condition in "${CONDITIONS[@]}"; do run_or_skip_condition "$condition"; done
echo "V34 guardian execution complete. No analysis or later authorization was run."
