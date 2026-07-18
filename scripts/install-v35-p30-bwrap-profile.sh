#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROFILE="$ROOT/ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/runtime/usr.bin.bwrap.apparmor"
DESTINATION="/etc/apparmor.d/arc-v35-p30-bwrap"
BWRAP="/usr/bin/bwrap"
GPU_UUID="GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"

if [[ $# -ne 2 ]]; then
  echo "usage: $0 EXPECTED_BWRAP_SHA256 EXPECTED_PROFILE_SHA256" >&2
  exit 64
fi
EXPECTED_BWRAP_SHA256="$1"
EXPECTED_PROFILE_SHA256="$2"

[[ "${ARC_V35_P30_HOST_CHANGE_AUTHORIZED:-}" =~ ^[0-9a-f]{64}$ ]]
[[ "$(sha256sum "$BWRAP" | awk '{print $1}')" == "$EXPECTED_BWRAP_SHA256" ]]
[[ "$(sha256sum "$PROFILE" | awk '{print $1}')" == "$EXPECTED_PROFILE_SHA256" ]]
[[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" == "1" ]]

sudo -n install -o root -g root -m 0644 "$PROFILE" "$DESTINATION"
sudo -n apparmor_parser -r "$DESTINATION"

SMOKE="$(mktemp -d /dev/shm/arc-v35-p30-bwrap-smoke.XXXXXX)"
trap 'rm -rf "$SMOKE"' EXIT

"$BWRAP" \
  --die-with-parent \
  --new-session \
  --unshare-user \
  --unshare-pid \
  --unshare-uts \
  --unshare-ipc \
  --unshare-net \
  --cap-drop ALL \
  --clearenv \
  --proc /proc \
  --dev /dev \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /usr /usr \
  --bind "$SMOKE" "$SMOKE" \
  --dev-bind /dev/nvidia7 /dev/nvidia7 \
  --dev-bind /dev/nvidiactl /dev/nvidiactl \
  --dev-bind /dev/nvidia-uvm /dev/nvidia-uvm \
  --setenv PATH /usr/bin:/bin \
  --chdir "$SMOKE" \
  -- /usr/bin/python3 - "$GPU_UUID" <<'PY'
import os
import socket
import sys

expected_uuid = sys.argv[1]
assert expected_uuid == "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"
assert os.path.exists("/dev/nvidia7")
assert not any(os.path.exists(f"/dev/nvidia{index}") for index in (4, 5, 6))
path = os.path.join(os.getcwd(), "s")
assert len(os.fsencode(path)) <= 107
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen(1)
client = socket.socket(socket.AF_UNIX)
client.connect(path)
connection, _ = server.accept()
client.sendall(b"ok")
assert connection.recv(2) == b"ok"
connection.close()
client.close()
server.close()
os.unlink(path)
probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
probe.settimeout(0.2)
try:
    probe.connect(("1.1.1.1", 53))
except OSError:
    pass
else:
    raise AssertionError("network namespace unexpectedly has egress")
finally:
    probe.close()
PY

printf '{"profile":"installed","bubblewrapSmoke":"pass","outcomesInspected":false}\n'
