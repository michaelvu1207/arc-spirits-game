#!/bin/bash
# Continue a paused or stopped league (also after a crash or a reboot): finished games are kept,
# games that were in flight go on from their last recorded decision, the rest of the schedule is
# played. This is the same as start.sh.
#
# Between a pause and a resume you may change league.json (games, gateways, limits) and add or
# remove agent folders: finished games stay, unfinished games whose agents are all still there
# are continued, and the rest is scheduled again for the new list. Do not change the model or
# effort of an agent that has games; give the changed agent a new folder name.
#
#   scripts/agent-harness/league/resume.sh [league dir]    (default ~/arcspirits-harness/league)
exec "$(dirname "$0")/start.sh" "$@"
