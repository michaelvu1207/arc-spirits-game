#!/bin/zsh
# Run SQL on a Supabase project through the Management API.
#   tools/sbq.sh <project ref> < query.sql        prints the JSON rows
# Uses the Supabase CLI sign-in of this machine (~/.supabase/access-token) when there is one,
# else the one on the key host over ssh (ARC_KEY_HOST, default seablue). The token is never printed.
ref=$1
py='
import sys, json, os, urllib.request
sql = sys.stdin.read()
tok = open(os.path.expanduser("~/.supabase/access-token")).read().strip()
req = urllib.request.Request("https://api.supabase.com/v1/projects/'$ref'/database/query",
    data=json.dumps({"query": sql}).encode(),
    headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json", "User-Agent": "supabase-cli"})
try:
    print(urllib.request.urlopen(req, timeout=120).read().decode())
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:2000]); sys.exit(1)
'
if [[ -f ~/.supabase/access-token ]]; then
	python3 -c "$py"
else
	ssh -o BatchMode=yes -o ConnectTimeout=20 ${ARC_KEY_HOST:-seablue} "python3 -c $(printf %q "$py")"
fi
