# Makes every monster card again with the built-in generator (tools/monster_generate.py through the server).
# The automatic check is off in client mode (NIJI_REMOTE), so run this after a change of monster art, values or reward icons.
import json, sys, time, urllib.request
B='http://127.0.0.1:8787'
def post(path, body):
    r=urllib.request.Request(B+path, data=json.dumps(body).encode(), headers={'content-type':'application/json'})
    try: return json.load(urllib.request.urlopen(r, timeout=600))
    except urllib.error.HTTPError as e: return {'error': e.read().decode()[:300]}
    except Exception as e: return {'error': str(e)}
ms=json.load(urllib.request.urlopen(B+'/api/game/monsters'))
todo=[m for m in ms if m.get('art') and (m.get('stale') or '--all' in sys.argv)]
bad=[]; t=time.time()
for m in todo:
    r=post('/api/game/monster-generate', {'name': m['name']})
    if r.get('error'): bad.append((m['name'], r['error']))
print(f"made {len(todo)-len(bad)} of {len(todo)} in {time.time()-t:.0f}s; failed: {bad}")
