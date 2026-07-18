#!/usr/bin/env bash
set -euo pipefail

# Outcome-blind V35 old/new command-trace parity runner. This script is invoked
# on SimForge only after its SHA-256, the comparator SHA-256, the authorization,
# and both source archive hashes are committed locally.

if [[ $# -ne 7 ]]; then
	echo "usage: run-v35-runtime-parity-remote.sh ROOT OUT AUTH EXPECTED_AUTH_SHA COMPARATOR OLD_ARCHIVE NEW_ARCHIVE" >&2
	exit 2
fi

ROOT="$1"
OUT="$2"
AUTH="$3"
EXPECTED_AUTH_SHA="$4"
COMPARATOR="$5"
OLD_ARCHIVE="$6"
NEW_ARCHIVE="$7"

GPU_UUID="GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"
CHECKPOINT_REL="ml/experiments/v35-weco-recursive-autoresearch/league/rep-a/p30-credit025/checkpoints/main-0-gen8.pt"
CHECKPOINT_SHA="c799ee8587c5a82013dd06830eab7818b359a07944629a236de3dd1d2bd24e91"
CHECKPOINT_MANIFEST_SHA="fe21b3adfc1b688515dc3a3d2de0d7a6defa611728aac0ccbdfb79bf36678fad"
CATALOG_SHA="62203ec1b981c2e59f129db54cf1863639f605f331ed8d7408c53693c941bc59"
OLD_COMMIT="5574310327a19a609eb3713bff76efe48535aa91"
NEW_COMMIT="07dc5e2a183a3f8dbb3ad1719fc228da7d7508af"
OLD_ARCHIVE_SHA="b28b24669bf205a19b70e1160a0336afcc12d0084767ba37b256cfc75c323d1f"
NEW_ARCHIVE_SHA="d94b8d6ac9e320bb5b9648289e34af57ba3cc4d0d501e11ec9f8e4fc6d47d0cf"
INCIDENT_REL="ml/experiments/v35-weco-recursive-autoresearch/artifacts/runtime-parity-attempt-1-incident.json"
INCIDENT_SHA="b6fcaa14f1a7518e43071a22da1329c24c29aeec9a19c6a6cad7c111b888320d"
SEED0="969060000"
FUNCTIONAL_GAMES="8"
OPERATIONAL_GAMES="64"

CHECKPOINT="$ROOT/$CHECKPOINT_REL"
CHECKPOINT_MANIFEST="${CHECKPOINT%.pt}.manifest.json"
LEASE_PARENT="/tmp/arc-v35-gpu-leases"
LEASE="$LEASE_PARENT/gpu7"
LEASE_OWNER="v35-runtime-parity-attempt-1-$$"
SCRATCH="/tmp/arc-v35-runtime-parity-attempt-1-$$"
SERVER_PID=""

umask 077

cleanup() {
	local status=$?
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
	if [[ -f "$LEASE/owner" ]] && [[ "$(cat "$LEASE/owner")" == "$LEASE_OWNER" ]]; then
		rm -f "$LEASE/owner"
		rmdir "$LEASE" 2>/dev/null || true
	fi
	rm -rf "$SCRATCH"
	exit "$status"
}
trap cleanup EXIT INT TERM

test -d "$ROOT"
test -x "$ROOT/ml/.venv/bin/python"
test -d "$ROOT/node_modules"
test -f "$AUTH"
test -f "$COMPARATOR"
test -f "$OLD_ARCHIVE"
test -f "$NEW_ARCHIVE"
test ! -e "$OUT"
test "$(sha256sum "$AUTH" | awk '{print $1}')" = "$EXPECTED_AUTH_SHA"
test "$(sha256sum "$CHECKPOINT" | awk '{print $1}')" = "$CHECKPOINT_SHA"
test "$(sha256sum "$CHECKPOINT_MANIFEST" | awk '{print $1}')" = "$CHECKPOINT_MANIFEST_SHA"
test "$(sha256sum "$ROOT/ml/catalog.json" | awk '{print $1}')" = "$CATALOG_SHA"
test "$(sha256sum "$OLD_ARCHIVE" | awk '{print $1}')" = "$OLD_ARCHIVE_SHA"
test "$(sha256sum "$NEW_ARCHIVE" | awk '{print $1}')" = "$NEW_ARCHIVE_SHA"
test "$(sha256sum "$ROOT/$INCIDENT_REL" | awk '{print $1}')" = "$INCIDENT_SHA"
test "$(df -B1 "$ROOT" | awk 'NR==2 {print $4}')" -ge 8589934592
test "$(df -B1 /tmp | awk 'NR==2 {print $4}')" -ge 5368709120

mkdir -p "$LEASE_PARENT"
test ! -L "$LEASE_PARENT"
if ! mkdir "$LEASE" 2>/dev/null; then
	echo "GPU 7 lease is already held" >&2
	exit 73
fi
printf '%s\n' "$LEASE_OWNER" > "$LEASE/owner"

gpu_line="$(nvidia-smi --id="$GPU_UUID" --query-gpu=uuid,memory.used,utilization.gpu --format=csv,noheader,nounits)"
IFS=', ' read -r observed_uuid gpu_mem gpu_util <<< "$gpu_line"
test "$observed_uuid" = "$GPU_UUID"
test "$gpu_mem" = "0"
test "$gpu_util" = "0"
if nvidia-smi --query-compute-apps=gpu_uuid --format=csv,noheader | tr -d ' \t\r' | grep -Fxq "$GPU_UUID"; then
	echo "GPU 7 became occupied before parity launch" >&2
	exit 73
fi

mkdir "$OUT"
chmod 0700 "$OUT"
mkdir "$SCRATCH"
chmod 0700 "$SCRATCH"
mkdir "$SCRATCH/old" "$SCRATCH/new" "$SCRATCH/sockets"
tar -xzf "$OLD_ARCHIVE" -C "$SCRATCH/old"
tar -xzf "$NEW_ARCHIVE" -C "$SCRATCH/new"
ln -s "$ROOT/node_modules" "$SCRATCH/old/node_modules"
ln -s "$ROOT/node_modules" "$SCRATCH/new/node_modules"
ln -s "$ROOT/ml/.venv" "$SCRATCH/old/ml/.venv"
ln -s "$ROOT/ml/.venv" "$SCRATCH/new/ml/.venv"

# Verify authorization, runner, comparator, source allowlist, archive contents,
# and byte-identical trace instrumentation without printing their contents.
env OLD_TREE="$SCRATCH/old" NEW_TREE="$SCRATCH/new" RUNNER="$0" COMPARATOR="$COMPARATOR" OUT="$OUT" \
	OLD_ARCHIVE="$OLD_ARCHIVE" NEW_ARCHIVE="$NEW_ARCHIVE" \
	python3 - "$AUTH" > "$OUT/preflight.stdout" 2> "$OUT/preflight.stderr" <<'PY'
import hashlib, json, os, pathlib, sys

auth = json.load(open(sys.argv[1]))
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
expected = {
    "schemaVersion": "arc-v35-runtime-parity-authorization-v1",
    "attemptId": "attempt-2",
    "status": "authorized-public-outcome-blind-preflight",
    "oldCommit": "5574310327a19a609eb3713bff76efe48535aa91",
    "newCommit": "07dc5e2a183a3f8dbb3ad1719fc228da7d7508af",
    "checkpointSha256": "c799ee8587c5a82013dd06830eab7818b359a07944629a236de3dd1d2bd24e91",
    "checkpointManifestSha256": "fe21b3adfc1b688515dc3a3d2de0d7a6defa611728aac0ccbdfb79bf36678fad",
    "catalogSha256": "62203ec1b981c2e59f129db54cf1863639f605f331ed8d7408c53693c941bc59",
    "oldArchiveSha256": "b28b24669bf205a19b70e1160a0336afcc12d0084767ba37b256cfc75c323d1f",
    "newArchiveSha256": "d94b8d6ac9e320bb5b9648289e34af57ba3cc4d0d501e11ec9f8e4fc6d47d0cf",
    "attempt1IncidentSha256": "b6fcaa14f1a7518e43071a22da1329c24c29aeec9a19c6a6cad7c111b888320d",
}
for key, value in expected.items():
    if auth.get(key) != value:
        raise SystemExit(f"authorization-{key}-mismatch")
if sha(os.environ["RUNNER"]) != auth["trusted"]["runnerSha256"]:
    raise SystemExit("authorization-runner-hash-mismatch")
if sha(os.environ["COMPARATOR"]) != auth["trusted"]["comparatorSha256"]:
    raise SystemExit("authorization-comparator-hash-mismatch")
if auth.get("execution", {}).get("out") != os.environ["OUT"]:
    raise SystemExit("authorization-output-path-mismatch")
trace_files = auth["traceInstrumentationFiles"]
for rel, expected_sha in trace_files.items():
    old_sha = sha(pathlib.Path(os.environ["OLD_TREE"]) / rel)
    new_sha = sha(pathlib.Path(os.environ["NEW_TREE"]) / rel)
    if old_sha != expected_sha or new_sha != expected_sha:
        raise SystemExit("trace-instrumentation-hash-mismatch")
runtime = auth["runtimeFiles"]
for side, tree_key in (("old", "OLD_TREE"), ("new", "NEW_TREE")):
    for rel, expected_sha in runtime[side].items():
        if sha(pathlib.Path(os.environ[tree_key]) / rel) != expected_sha:
            raise SystemExit("runtime-file-hash-mismatch")
old_root = pathlib.Path(os.environ["OLD_TREE"])
new_root = pathlib.Path(os.environ["NEW_TREE"])
old_files = {str(path.relative_to(old_root)) for path in old_root.rglob("*") if path.is_file()}
new_files = {str(path.relative_to(new_root)) for path in new_root.rglob("*") if path.is_file()}
if old_files != new_files:
    raise SystemExit("runtime-archive-file-set-mismatch")
different = sorted(rel for rel in old_files if sha(old_root / rel) != sha(new_root / rel))
if different != auth["runtimeArchiveDiffPaths"]:
    raise SystemExit("runtime-archive-diff-allowlist-mismatch")
print(json.dumps({"schemaVersion": "arc-v35-runtime-parity-preflight-v1", "passed": True}, separators=(",", ":")))
PY

nvidia-smi --query-compute-apps=gpu_uuid,pid --format=csv,noheader > "$OUT/gpu-processes-before.csv"

wait_for_gpu_release() {
	local mem util
	for _ in $(seq 1 120); do
		IFS=', ' read -r mem util <<< "$(nvidia-smi --id="$GPU_UUID" --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits)"
		if [[ "$mem" = "0" && "$util" = "0" ]]; then return 0; fi
		sleep 0.5
	done
	return 1
}

env CUDA_VISIBLE_DEVICES="$GPU_UUID" PYTHONHASHSEED=0 CUBLAS_WORKSPACE_CONFIG=:4096:8 \
	NVIDIA_TF32_OVERRIDE=0 TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=0 \
	"$ROOT/ml/.venv/bin/python" - > "$OUT/environment.json" 2> "$OUT/environment.stderr" <<'PY'
import json, os, torch
assert torch.cuda.is_available()
assert torch.cuda.device_count() == 1
p = torch.cuda.get_device_properties(0)
print(json.dumps({
    "schemaVersion": "arc-v35-runtime-parity-environment-v1",
    "cudaVisibleDevices": os.environ["CUDA_VISIBLE_DEVICES"],
    "pythonHashSeed": os.environ["PYTHONHASHSEED"],
    "cublasWorkspaceConfig": os.environ["CUBLAS_WORKSPACE_CONFIG"],
    "torchVersion": torch.__version__,
    "cudaVersion": torch.version.cuda,
    "cudnnVersion": torch.backends.cudnn.version(),
    "deviceCount": torch.cuda.device_count(),
    "deviceName": p.name,
    "deviceTotalMemory": p.total_memory,
    "deterministicAlgorithms": torch.are_deterministic_algorithms_enabled(),
    "cudnnDeterministic": torch.backends.cudnn.deterministic,
    "cudnnBenchmark": torch.backends.cudnn.benchmark,
    "allowTf32Matmul": torch.backends.cuda.matmul.allow_tf32,
    "allowTf32Cudnn": torch.backends.cudnn.allow_tf32,
}, sort_keys=True, separators=(",", ":")))
PY
wait_for_gpu_release

run_job() {
	local name="$1" tree="$2" commit="$3" games="$4" workers="$5" window="$6" max_batch="$7"
	local job="$OUT/$name"
	local socket="$SCRATCH/sockets/${name}.sock"
	mkdir "$job"
	python3 - "$job/contract.json" "$name" "$commit" "$games" "$workers" "$window" "$max_batch" <<'PY'
import json, sys
out, name, commit, games, workers, window, max_batch = sys.argv[1:]
contract = {
    "schemaVersion": "arc-v35-runtime-parity-job-v1",
    "name": name, "sourceCommit": commit,
    "seed0": 969060000, "games": int(games), "workers": int(workers),
    "windowMs": int(window), "maxBatch": int(max_batch),
    "maxRounds": 30, "maxStatusLevel": 2,
    "wire": "binary", "gpuUuid": "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0",
    "candidateId": "f4e6230e8d983dbc",
    "candidateSha256": "f4e6230e8d983dbc65c25ab7132f9b9d24dc2c0d6567c1628fd70634416b7d18",
}
open(out, "x").write(json.dumps(contract, sort_keys=True, separators=(",", ":")) + "\n")
PY

	env CUDA_VISIBLE_DEVICES="$GPU_UUID" PYTHONHASHSEED=0 CUBLAS_WORKSPACE_CONFIG=:4096:8 \
		NVIDIA_TF32_OVERRIDE=0 TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=0 \
		nice -n 19 "$tree/ml/.venv/bin/python" "$tree/ml/infer_server.py" \
		--weights "$CHECKPOINT" --socket "$socket" --device cuda:0 \
		--window-ms "$window" --max-batch "$max_batch" --stats-interval 5 \
		> "$job/infer.stdout" 2> "$job/infer.stderr" &
	SERVER_PID=$!
	local ready=0
	for _ in $(seq 1 120); do
		if [[ -S "$socket" ]]; then ready=1; break; fi
		kill -0 "$SERVER_PID" 2>/dev/null || break
		sleep 1
	done
	if [[ "$ready" != "1" ]]; then
		echo "inference server failed before readiness" >&2
		return 1
	fi

	set +e
	env CUDA_VISIBLE_DEVICES="$GPU_UUID" ARC_INFER_WIRE=binary PYTHONHASHSEED=0 \
		CUBLAS_WORKSPACE_CONFIG=:4096:8 NVIDIA_TF32_OVERRIDE=0 \
		TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=0 TMPDIR="$job" nice -n 19 \
		node "$tree/scripts/evaluate-solo-checkpoint.mjs" \
		--weights "$CHECKPOINT" --catalog "$tree/ml/catalog.json" \
		--source-commit "$commit" --infer-socket "$socket" --policy-obs-version 2 \
		--games "$games" --workers "$workers" --seed0 "$SEED0" \
		--max-rounds 30 --max-status-level 2 --include-replay-hashes \
		--temperature 0.70727915 --search-sims 4 --search-objective solo-reach30 \
		--search-horizon 6 --search-frac 0.84868158 \
		--search-value-weight 0.25337527 --search-rollout policy \
		--search-nav-temperature 0.01453346 --out "$job/report.json" \
		> "$job/evaluator.stdout" 2> "$job/evaluator.stderr"
	local evaluator_exit=$?
	set -e
	printf '%s\n' "$evaluator_exit" > "$job/evaluator.exit"

	kill -TERM "$SERVER_PID" 2>/dev/null || true
	set +e
	wait "$SERVER_PID"
	local server_exit=$?
	set -e
	SERVER_PID=""
	printf '%s\n' "$server_exit" > "$job/infer.exit"
	test "$evaluator_exit" = "0"
	test "$server_exit" = "0"
	wait_for_gpu_release
	nvidia-smi --query-compute-apps=gpu_uuid,pid --format=csv,noheader > "$job/gpu-processes-after.csv"
}

run_job legacy-functional "$SCRATCH/old" "$OLD_COMMIT" "$FUNCTIONAL_GAMES" 1 0 1
run_job optimized-functional "$SCRATCH/new" "$NEW_COMMIT" "$FUNCTIONAL_GAMES" 1 0 1
run_job optimized-operational "$SCRATCH/new" "$NEW_COMMIT" "$OPERATIONAL_GAMES" 24 2 512
run_job legacy-operational "$SCRATCH/old" "$OLD_COMMIT" "$OPERATIONAL_GAMES" 24 2 512

env CUDA_VISIBLE_DEVICES="$GPU_UUID" PYTHONHASHSEED=0 \
	"$ROOT/ml/.venv/bin/python" "$COMPARATOR" --authorization "$AUTH" \
	--jobs-root "$OUT" --out "$OUT/parity-result.json" \
	> "$OUT/comparator.stdout" 2> "$OUT/comparator.stderr"

nvidia-smi --query-compute-apps=gpu_uuid,pid --format=csv,noheader > "$OUT/gpu-processes-after.csv"
wait_for_gpu_release

find "$OUT" -type f ! -name sealed-files.sha256 -print0 | sort -z | xargs -0 sha256sum \
	> "$OUT/sealed-files.sha256"

rm -rf "$SCRATCH"
trap - EXIT INT TERM
rm -f "$LEASE/owner"
rmdir "$LEASE" 2>/dev/null || true
exit 0
