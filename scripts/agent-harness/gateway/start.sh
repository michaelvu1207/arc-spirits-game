#!/usr/bin/env bash
# Start the local omp auth gateway for the agent harness, pinned to ONE Codex account.
#
#   scripts/agent-harness/gateway/start.sh --account <email>   # first start (or to change account)
#   scripts/agent-harness/gateway/start.sh                     # later starts reuse the saved account
#
# The gateway runs as a plain background process on 127.0.0.1 only. It uses its own HOME
# ($STATE_DIR/home), so it does not write to ~/.omp or ~/.codex. It reads the broker URL and
# token from ~/.omp/agent/config.yml (read only) unless OMP_AUTH_BROKER_URL/TOKEN are set.
# No secret is written to this repo: the gateway token is in $STATE_DIR/home/.omp/auth-gateway.token
# (mode 600), created by the gateway itself.
set -euo pipefail

STATE_DIR="${ARC_GATEWAY_STATE_DIR:-$HOME/.local/share/arcspirits-agent-gateway}"
PORT="${ARC_GATEWAY_PORT:-4610}"
OMP_BIN="${ARC_GATEWAY_OMP_BIN:-$HOME/.local/bin/omp-starline}"
OMP_CONFIG="$HOME/.omp/agent/config.yml"
GW_HOME="$STATE_DIR/home"
POOL_FILE="$STATE_DIR/pool.json"
PID_FILE="$STATE_DIR/gateway.pid"
LOG_FILE="$STATE_DIR/gateway.log"
TOKEN_FILE="$GW_HOME/.omp/auth-gateway.token"
BASE="http://127.0.0.1:${PORT}"

ACCOUNT="${ARC_GATEWAY_ACCOUNT:-}"
while [ $# -gt 0 ]; do
	case "$1" in
		--account) ACCOUNT="${2:?--account needs an email}"; shift 2 ;;
		--account=*) ACCOUNT="${1#--account=}"; shift ;;
		-h|--help) sed -n '2,12p' "$0"; exit 0 ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

die() { echo "start.sh: $*" >&2; exit 1; }
command -v jq >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"
[ -x "$OMP_BIN" ] || die "omp-starline not found at $OMP_BIN (set ARC_GATEWAY_OMP_BIN)"

# Already running?
if [ -f "$PID_FILE" ]; then
	pid="$(cat "$PID_FILE")"
	if ps -p "$pid" -o command= 2>/dev/null | grep -q "auth-gateway serve"; then
		echo "gateway already running (pid $pid) at $BASE/v1"
		exit 0
	fi
	rm -f "$PID_FILE"
fi

umask 077
mkdir -p "$STATE_DIR" "$GW_HOME"
chmod 700 "$STATE_DIR"

# Read one `auth.broker.<key>` literal value from the omp config (read only).
read_broker_value() {
	awk -v want="$1" -v q="'" '
		/^[^[:space:]#]/ { in_auth = ($1 == "auth:"); in_broker = 0; next }
		in_auth && /^  [^[:space:]#]/ { in_broker = ($1 == "broker:"); next }
		in_auth && in_broker && $1 == want":" {
			v = $0; sub(/^[^:]*:[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v)
			gsub("^[\"" q "]|[\"" q "]$", "", v); print v; exit
		}' "$OMP_CONFIG" 2>/dev/null
}
BROKER_URL="${OMP_AUTH_BROKER_URL:-$(read_broker_value url)}"
BROKER_TOKEN="${OMP_AUTH_BROKER_TOKEN:-$(read_broker_value token)}"
[ -n "$BROKER_URL" ] || die "no broker URL (set OMP_AUTH_BROKER_URL or auth.broker.url in $OMP_CONFIG)"
[ -n "$BROKER_TOKEN" ] || die "no broker token (set OMP_AUTH_BROKER_TOKEN or auth.broker.token in $OMP_CONFIG)"
case "$BROKER_TOKEN" in '!'*) die "auth.broker.token is a shell command; export OMP_AUTH_BROKER_TOKEN instead" ;; esac

# Build the account pool: openai-codex = only the chosen account; every other OAuth provider on
# the broker = [] (hidden), so this gateway cannot spend Michael's other subscriptions.
# API-key credentials (for example OpenRouter) stay visible by omp design.
if [ -n "$ACCOUNT" ]; then
	snapshot="$(curl -sS -m 20 -H "Authorization: Bearer $BROKER_TOKEN" "$BROKER_URL/v1/snapshot")" \
		|| die "cannot read the broker snapshot at $BROKER_URL"
	pool="$(jq --arg email "$ACCOUNT" '
		[.credentials[] | select(.credential.type == "oauth")] as $oauth
		| ($oauth | map(.provider) | unique | map({key: ., value: []}) | from_entries)
		+ {"openai-codex": [$oauth[] | select(.provider == "openai-codex" and ((.credential.email // "") | ascii_downcase) == ($email | ascii_downcase)) | .identityKey]}
	' <<<"$snapshot")" || die "cannot parse the broker snapshot"
	unset snapshot
	[ "$(jq '."openai-codex" | length' <<<"$pool")" = "1" ] \
		|| die "no single openai-codex account with email $ACCOUNT on the broker"
	printf '%s\n' "$pool" > "$POOL_FILE"
	chmod 600 "$POOL_FILE"
fi
[ -f "$POOL_FILE" ] || die "no account chosen yet: run start.sh --account <email>"

# Start the gateway with its own HOME; drop variables that would point omp at Michael's dirs.
nohup env -u PI_CODING_AGENT_DIR -u OMP_PROFILE -u PI_PROFILE -u PI_CONFIG_DIR \
	HOME="$GW_HOME" \
	OMP_AUTH_BROKER_URL="$BROKER_URL" \
	OMP_AUTH_BROKER_TOKEN="$BROKER_TOKEN" \
	OMP_AUTH_BROKER_ACCOUNT_POOL_FILE="$POOL_FILE" \
	"$OMP_BIN" auth-gateway serve --bind="127.0.0.1:${PORT}" >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
unset BROKER_TOKEN

for _ in $(seq 1 60); do
	curl -fsS -m 2 "$BASE/healthz" >/dev/null 2>&1 && break
	if ! ps -p "$(cat "$PID_FILE")" >/dev/null 2>&1; then
		rm -f "$PID_FILE"; die "gateway exited; see $LOG_FILE"
	fi
	sleep 0.5
done
curl -fsS -m 2 "$BASE/healthz" >/dev/null 2>&1 || die "gateway did not answer /healthz; see $LOG_FILE"

if curl -fsS -m 30 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$BASE/v1/models" \
	| jq -e '.data[] | select(.id == "openai-codex/gpt-6.1-sol")' >/dev/null; then
	models_ok="yes"
else
	models_ok="NO (check $LOG_FILE)"
fi

cat <<EOF
gateway running (pid $(cat "$PID_FILE"))
  ARC_GATEWAY_URL=$BASE/v1
  ARC_GATEWAY_TOKEN_FILE=$TOKEN_FILE
  codex account: $(jq -r '."openai-codex"[0]' "$POOL_FILE" | sed 's/|.*//')
  openai-codex/gpt-6.1-sol listed: $models_ok
  log: $LOG_FILE (omp logs: $GW_HOME/.omp/logs)
EOF
