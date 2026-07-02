#!/usr/bin/env bash
# Deploy/stop/status for the batched inference server (ml/infer_server.py) on
# simforge1 (8xA100). One command once the box frees up; see
# docs/simforge1-deploy.md for the client-side socket bridge.
#
#   scripts/deploy-infer-simforge1.sh deploy [--gpu 7] [--weights FILE] [--dry-run]
#   scripts/deploy-infer-simforge1.sh status [--dry-run]
#   scripts/deploy-infer-simforge1.sh stop   [--dry-run]
#
# deploy: preflight (GPU free + load), rsync the minimal ml/ subtree + the
# checkpoint, idempotent venv, nohup launch pinned to the GPU, health check via
# the info handshake (run REMOTELY over ssh — no bridge needed for health).
# ABORTS with a clear message if the GPU is busy (the box is often saturated);
# FORCE=1 skips only the load-average warning, never the GPU-busy abort.
#
# The simforge1 link flaps under parallel SSH: every remote command goes
# through ONE ControlMaster connection, serialized, with a retry loop.
set -euo pipefail

HOST="${SIMFORGE_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${REMOTE_DIR:-/data/share11/ubuntu/arc-spirits-infer}"
GPU=7
WEIGHTS="src/lib/play/ml/policy-weights.json"
DRY_RUN=0
WINDOW_MS="${WINDOW_MS:-2.0}"
MAX_BATCH="${MAX_BATCH:-512}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

CMD="${1:-}"
shift || true
case "$CMD" in deploy|stop|status) ;; *)
  echo "usage: $0 <deploy|stop|status> [--gpu N] [--weights FILE] [--host user@host] [--dry-run]" >&2
  exit 2 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) GPU="$2"; shift 2 ;;
    --weights) WEIGHTS="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SOCK="$REMOTE_DIR/infer.sock"
CTRL="/tmp/ssh-simforge1-infer-$$"
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
          -o ControlMaster=auto -o "ControlPath=$CTRL" -o ControlPersist=120)

log() { echo "[deploy-infer] $*"; }

# Serialized remote execution with backoff (the link flaps; never parallel).
sshx() {
  if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] ssh $HOST -- $*"; return 0; fi
  local attempt
  for attempt in 1 2 3 4 5; do
    if ssh "${SSH_OPTS[@]}" "$HOST" "$@"; then return 0; fi
    log "ssh attempt $attempt failed; retrying in $((attempt * 2))s"
    sleep $((attempt * 2))
  done
  log "FATAL: ssh to $HOST failed after 5 attempts"
  return 1
}

rsyncx() {
  if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] rsync -az -e 'ssh ...' $* $HOST:$REMOTE_DIR/"; return 0; fi
  local attempt
  for attempt in 1 2 3 4 5; do
    if rsync -az -e "ssh ${SSH_OPTS[*]}" "$@" "$HOST:$REMOTE_DIR/"; then return 0; fi
    log "rsync attempt $attempt failed; retrying in $((attempt * 2))s"
    sleep $((attempt * 2))
  done
  log "FATAL: rsync to $HOST failed after 5 attempts"
  return 1
}

cleanup() { [ "$DRY_RUN" = 1 ] || ssh -O exit -o "ControlPath=$CTRL" "$HOST" 2>/dev/null || true; }
trap cleanup EXIT

# ── status ───────────────────────────────────────────────────────────────────
if [ "$CMD" = status ]; then
  sshx "cd $REMOTE_DIR 2>/dev/null || { echo 'not deployed'; exit 0; };
        if [ -f server.pid ] && kill -0 \$(cat server.pid) 2>/dev/null; then
          echo \"RUNNING pid \$(cat server.pid)\";
        else echo 'NOT RUNNING'; fi;
        nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader 2>/dev/null | sed 's/^/gpu /';
        echo '--- server.log tail ---'; tail -n 5 server.log 2>/dev/null || true"
  exit 0
fi

# ── stop ─────────────────────────────────────────────────────────────────────
if [ "$CMD" = stop ]; then
  sshx "cd $REMOTE_DIR 2>/dev/null || exit 0;
        if [ -f server.pid ]; then kill \$(cat server.pid) 2>/dev/null || true; sleep 1;
          kill -9 \$(cat server.pid) 2>/dev/null || true; rm -f server.pid; fi;
        pkill -u \$(id -un) -f '$REMOTE_DIR/.*infer_server.py' 2>/dev/null || true;
        rm -f $SOCK; echo stopped"
  exit 0
fi

# ── deploy ───────────────────────────────────────────────────────────────────
if [ ! -f "$WEIGHTS" ]; then log "FATAL: weights not found: $WEIGHTS"; exit 1; fi
WBASE="$(basename "$WEIGHTS")"
MANIFEST=""
case "$WEIGHTS" in *.pt)
  MANIFEST="${WEIGHTS%.pt}.manifest.json"
  if [ ! -f "$MANIFEST" ]; then
    log "FATAL: v2 checkpoint needs a sibling manifest: $MANIFEST"; exit 1
  fi ;;
esac

# 1. Preflight: target GPU must be idle (READ-ONLY check; abort loudly if not).
log "preflight: checking GPU $GPU on $HOST"
if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] ssh $HOST -- nvidia-smi --query-gpu=... (abort if GPU $GPU busy)"
else
  GPULINE=$(sshx "nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader,nounits" \
            | awk -F', *' -v g="$GPU" '$1 == g {print $2, $3}')
  if [ -z "$GPULINE" ]; then log "FATAL: GPU $GPU not found on $HOST"; exit 1; fi
  read -r MEM_MB UTIL_PCT <<<"$GPULINE"
  if [ "$MEM_MB" -gt 1024 ] || [ "$UTIL_PCT" -gt 5 ]; then
    log "ABORT: GPU $GPU is BUSY on $HOST (${MEM_MB} MiB used, ${UTIL_PCT}% util)."
    log "The box is likely still saturated — pick another GPU with --gpu, or wait."
    exit 1
  fi
  LOAD=$(sshx "cut -d' ' -f1 /proc/loadavg")
  NCPU=$(sshx "nproc")
  log "GPU $GPU free (${MEM_MB} MiB, ${UTIL_PCT}%); load ${LOAD}/${NCPU} cores"
  if [ "${LOAD%.*}" -ge "$NCPU" ] && [ "${FORCE:-0}" != 1 ]; then
    log "ABORT: load average ${LOAD} >= ${NCPU} cores. Re-run with FORCE=1 to deploy anyway."
    exit 1
  fi
fi

# 2. Rsync the minimal subtree. infer_server.py imports model.py + train.py
#    (train pulls ppo.py) and lazily model_v2.py -> obs_v2.py. No catalog needed
#    (the server never touches game data).
log "rsync -> $HOST:$REMOTE_DIR"
sshx "mkdir -p $REMOTE_DIR/weights"
rsyncx ml/infer_server.py ml/model.py ml/train.py ml/ppo.py ml/model_v2.py ml/obs_v2.py ml/requirements.txt
if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] rsync -az $WEIGHTS ${MANIFEST:+$MANIFEST }-> $HOST:$REMOTE_DIR/weights/"
else
  # shellcheck disable=SC2086
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$WEIGHTS" ${MANIFEST:+"$MANIFEST"} "$HOST:$REMOTE_DIR/weights/"
fi

# 3. Idempotent venv (CUDA torch wheels are the linux default).
log "remote venv (idempotent)"
sshx "cd $REMOTE_DIR &&
      PY=\$(command -v python3.12 || command -v python3) &&
      [ -x .venv/bin/python ] || \$PY -m venv .venv;
      .venv/bin/pip install -q --upgrade pip &&
      .venv/bin/pip install -q -r requirements.txt"

# 4. Launch under nohup, pinned to the GPU. Restart-safe: stop any old server.
log "launching on GPU $GPU (weights/$WBASE)"
# The braces matter: without them the & would background the whole cd-&&-chain
# and \$! would be the transient subshell pid, not python's.
sshx "cd $REMOTE_DIR &&
      { [ -f server.pid ] && kill \$(cat server.pid) 2>/dev/null; rm -f server.pid $SOCK; sleep 1; true; } &&
      { CUDA_VISIBLE_DEVICES=$GPU nohup .venv/bin/python infer_server.py \
          --weights weights/$WBASE --socket $SOCK --device cuda \
          --window-ms $WINDOW_MS --max-batch $MAX_BATCH \
          >> server.log 2>&1 & echo \$! > server.pid; } &&
      sleep 1 && cat server.pid"

# 5. Health check: info handshake, run REMOTELY against the unix socket.
log "health check (info handshake)"
HEALTH_PY='
import asyncio, json, sys, time
sys.path.insert(0, ".")
async def main():
    from infer_server import InferClient
    deadline = time.monotonic() + 120  # first start pays the torch import + model load
    last = None
    while time.monotonic() < deadline:
        try:
            c = await InferClient.connect("'"$SOCK"'")
            info = (await c.info())["info"]
            await c.close()
            print("HEALTH OK " + json.dumps(info))
            return 0
        except OSError as e:
            last = e
            await asyncio.sleep(2)
    print(f"HEALTH FAILED: {last}", file=sys.stderr)
    return 1
raise SystemExit(asyncio.run(main()))
'
if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] ssh $HOST -- cd $REMOTE_DIR && .venv/bin/python -c '<info handshake against $SOCK>'"
else
  sshx "cd $REMOTE_DIR && .venv/bin/python -c '$HEALTH_PY'" || {
    log "health check FAILED — server log tail:"
    sshx "tail -n 20 $REMOTE_DIR/server.log"
    exit 1
  }
fi

log "deployed. Client-side bridge (run locally, keeps running):"
log "  ssh -N -o StreamLocalBindUnlink=yes -L /tmp/arc-infer-simforge1.sock:$SOCK $HOST"
log "then point RemotePolicy / InferClient at /tmp/arc-infer-simforge1.sock"
