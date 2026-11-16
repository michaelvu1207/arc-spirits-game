import json, sys, time, urllib.request
B='http://127.0.0.1:8787'
def post(path, body):
    r=urllib.request.Request(B+path, data=json.dumps(body).encode(), headers={'content-type':'application/json'})
    try: return json.load(urllib.request.urlopen(r, timeout=600))
    except urllib.error.HTTPError as e: return {'error': e.read().decode()[:300]}
    except Exception as e: return {'error': str(e)}
sp=json.load(urllib.request.urlopen(B+'/api/game/hex-spirits'))['spirits']
skip=set(sys.argv[2].split('|')) if len(sys.argv)>2 and sys.argv[2] else set()
only=set(sys.argv[3].split('|')) if len(sys.argv)>3 else None
todo=[m for m in sp if m.get('kit') and m['name'] not in skip and (only is None or m['name'] in only)]
ok=0; bad=[]; t=time.time()
for i,m in enumerate(todo,1):
    r=post('/api/game/hex-generate', {'name':m['name'],'force':True})
    if r.get('error'): bad.append((m['name'], r['error']))
    else: ok+=1
    print(f"{i}/{len(todo)} {m['name']} {'ERROR '+r['error'] if r.get('error') else r.get('sides')}", flush=True)
print(f"DONE ok={ok} failed={len(bad)} in {time.time()-t:.0f}s", bad, flush=True)
