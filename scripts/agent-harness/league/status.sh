#!/bin/bash
# Print the league state (status.json in short), whether its process is alive, and the top of
# report.md.
#
#   scripts/agent-harness/league/status.sh [league dir]    (default ~/arcspirits-harness/league)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
dir="${1:-$HOME/arcspirits-harness/league}"
[[ -f "$dir/status.json" ]] || { echo "no league status in $dir (not started yet)"; exit 1; }
node -e '
const s = require(process.argv[1]);
console.log(`state: ${s.state} (updated ${s.updatedAt}, pid ${s.pid})`);
console.log(`data version: ${s.dataVersion}${s.dataNote ? "  NOTE: " + s.dataNote : ""}`);
console.log(`games in flight: ${s.gamesInFlight} (peak ${s.peakInFlight}); calls/min: ${s.callsPerMin}; games per version: ${s.maxGames ?? "endless"}; peak memory ${s.peakRssMb} MB`);
for (const [id, v] of Object.entries(s.versions)) console.log(`  version ${id}: done ${v.done}, running ${v.running}, abandoned ${v.abandoned}, failed ${v.failed}`);
for (const a of s.accounts) console.log(`  account ${a.label}${a.provider && a.provider !== "openai-codex" ? " (" + a.provider + ")" : ""}: ${a.running}/${a.target} games, ${a.callsPerMin10} calls/min (10 min), live cap ${a.liveCap}, limit hits ${a.limitHits10}, quota ${a.quotaWindows || "?"}${a.blockedUntil ? ", BLOCKED until " + a.blockedUntil : ""}`);
console.log(`last event: ${s.lastEvent}`);
if (s.lastError) console.log(`last error: ${s.lastError}`);
if (s.stopReason) console.log(`stop reason: ${s.stopReason}`);
' "$dir/status.json"
if [[ -f "$dir/league.pid" ]] && kill -0 "$(cat "$dir/league.pid")" 2>/dev/null; then
	echo "process: ALIVE (pid $(cat "$dir/league.pid"))"
else
	echo "process: NOT RUNNING"
fi
if [[ -f "$dir/report.md" ]]; then
	echo
	sed -n '1,/^## What strategies emerge/p' "$dir/report.md" | sed '$d'
fi
