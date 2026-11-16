#!/bin/zsh
# Run a command with the play project's keys in its environment (needed to upload art or to run
# scripts against the live site). The keys come from the Supabase CLI at run time: the one on
# this machine when it is signed in (`supabase login`), else the one on the key host over ssh
# (ARC_KEY_HOST, default seablue). Nothing is written to disk or printed.
#   tools/with-keys.sh <command…>
ref=ydmlhjucgvultqhpctlr
json=""
if command -v supabase >/dev/null 2>&1; then json=$(supabase projects api-keys --project-ref $ref -o json 2>/dev/null); fi
if [[ $json != \[* ]]; then
	json=$(ssh -o BatchMode=yes -o ConnectTimeout=20 ${ARC_KEY_HOST:-seablue} "zsh -lc 'supabase projects api-keys --project-ref $ref -o json 2>/dev/null'")
fi
if [[ $json != \[* ]]; then echo "with-keys: no keys (sign in with: supabase login)" >&2; exit 1; fi
eval "$(print -r -- $json | python3 -c '
import json, sys, shlex
keys = {k["name"]: k["api_key"] for k in json.load(sys.stdin) if k.get("type") == "legacy"}
print("export PUBLIC_SUPABASE_ANON_KEY=" + shlex.quote(keys["anon"]))
print("export SUPABASE_SERVICE_ROLE_KEY=" + shlex.quote(keys["service_role"]))
')"
export PUBLIC_SUPABASE_URL=https://$ref.supabase.co
export PUBLIC_ART_SUPABASE_URL=https://gvxfokbptelmvvlxbigh.supabase.co
export SUPABASE_URL=$PUBLIC_SUPABASE_URL SUPABASE_ANON_KEY=$PUBLIC_SUPABASE_ANON_KEY
export VITE_ARC_LOCAL_BOTS=1
exec "$@"
