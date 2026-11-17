#!/bin/bash
# Pause the league: no new game starts, and each running game stops before its next decision
# (calls that are under way finish and are recorded). Nothing is lost: resume.sh continues every
# game from its last decision. This is the same as stop.sh.
#
#   scripts/agent-harness/league/pause.sh [league dir]     (default ~/arcspirits-harness/league)
exec "$(dirname "$0")/stop.sh" "$@"
