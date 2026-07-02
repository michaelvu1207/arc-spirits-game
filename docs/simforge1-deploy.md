# Inference server on simforge1 (GPU 7)

One-command deploy of `ml/infer_server.py` to the 8xA100 box, for v2
self-play at scale (the v2 transformer saturates local MPS at ~1.4-3k rows/s;
an A100 with the binary wire is the intended fleet server).

**The box is frequently saturated.** `deploy` preflights the target GPU and
ABORTS if it is busy (>1 GiB used or >5% util) — that is the intended
behavior, not an error to work around. `FORCE=1` only bypasses the
load-average warning, never the GPU-busy abort.

## Commands

```bash
# Deploy the live champion to GPU 7 (aborts if GPU 7 is busy):
scripts/deploy-infer-simforge1.sh deploy

# A v2 checkpoint (the sibling .manifest.json is rsynced automatically):
scripts/deploy-infer-simforge1.sh deploy --weights ml/weights/v2_bc.pt --gpu 6

scripts/deploy-infer-simforge1.sh status
scripts/deploy-infer-simforge1.sh stop

# Print every remote command without executing anything:
scripts/deploy-infer-simforge1.sh deploy --dry-run
```

What `deploy` does, in order:

1. **Preflight** (read-only): `nvidia-smi` for the target GPU + load average.
   All SSH goes through one ControlMaster connection with a 5-attempt backoff
   retry — the simforge1 link flaps under parallel SSH, so never run two
   deploys concurrently.
2. **Rsync** the minimal subtree to `/data/share11/ubuntu/arc-spirits-infer/`:
   `infer_server.py`, `model.py`, `train.py`, `ppo.py`, `model_v2.py`,
   `obs_v2.py`, `requirements.txt`, and the checkpoint (+ manifest for `.pt`)
   into `weights/`. No catalog or game data — the server only scores.
3. **Venv** idempotently (`python3.12`/`python3 -m venv`, torch + numpy;
   the default linux torch wheel is CUDA).
4. **Launch**: `CUDA_VISIBLE_DEVICES=<gpu> nohup .venv/bin/python
   infer_server.py --weights ... --socket .../infer.sock --device cuda`,
   pidfile + `server.log`. Any previous server is stopped first.
5. **Health check**: the JSON `info` handshake, executed remotely over ssh
   against the unix socket (waits up to 120 s for the first torch import +
   model load). Prints the served format/obs_dim/act_dim on success.

Checkpoint swap without restart: rsync new weights over the same path, then
`ssh ubuntu@216.151.21.122 'kill -HUP $(cat /data/share11/ubuntu/arc-spirits-infer/server.pid)'`.
SIGHUP re-probes the format, so a v1-JSON -> v2-`.pt` swap works on the same
`--weights` path (see ml/infer_server.py).

## Client-side socket bridge

The server listens on a **unix socket on the box**; our clients
(`inferenceClient.ts` RemotePolicy, `ml/infer_server.py` InferClient) speak
unix sockets. Primary bridge — OpenSSH forwards unix sockets directly, no
extra tooling on either end:

```bash
ssh -N -o StreamLocalBindUnlink=yes \
    -L /tmp/arc-infer-simforge1.sock:/data/share11/ubuntu/arc-spirits-infer/infer.sock \
    ubuntu@216.151.21.122 &
```

Then point the client at `/tmp/arc-infer-simforge1.sock`. Add
`-o ServerAliveInterval=15` for long sessions (the link flaps; if the tunnel
dies, re-running the command reclaims the local socket thanks to
`StreamLocalBindUnlink`).

Fallback (older OpenSSH without streamlocal forwarding, or when a raw TCP hop
is preferred) — socat unix->tcp on the box, ssh port-forward, socat
tcp->unix locally:

```bash
# box (socat is stock Ubuntu; apt install socat if missing):
socat TCP-LISTEN:7645,bind=127.0.0.1,fork,reuseaddr \
      UNIX-CONNECT:/data/share11/ubuntu/arc-spirits-infer/infer.sock &
# local:
ssh -N -L 7645:127.0.0.1:7645 ubuntu@216.151.21.122 &
socat UNIX-LISTEN:/tmp/arc-infer-simforge1.sock,fork TCP:127.0.0.1:7645 &
```

Both bridges preserve the framing byte-for-byte, so JSON and binary frames
work unchanged (the mechanics of the unix->tcp->unix chain are verified by a
local loopback test; see the deploy-kit task report).

**Latency note:** every decision pays a WAN round-trip through the bridge.
Actor workers at B=1 will be RTT-bound — remote serving pays off when clients
batch rows and/or many workers coalesce server-side (use the binary wire and
consider raising `--window-ms` via `WINDOW_MS=` for WAN use).

## Environment overrides

| var | default | |
|---|---|---|
| `SIMFORGE_HOST` | `ubuntu@216.151.21.122` | ssh target |
| `REMOTE_DIR` | `/data/share11/ubuntu/arc-spirits-infer` | install dir |
| `WINDOW_MS` / `MAX_BATCH` | `2.0` / `512` | server batching knobs |
| `FORCE` | unset | `1` bypasses the load-average warning only |
