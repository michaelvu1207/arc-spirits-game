# 2026-11-10: 10 new Fire Arcane concepts, humanoid characters or creatures only (no golems). 2 jobs (8 images) each, 8.2, 3:2, Relax.
import json,os,urllib.request
B='http://127.0.0.1:8787'
def post(p,b): return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,json.dumps(b).encode(),{'content-type':'application/json','origin':B}),timeout=180).read())
SREF='https://s.mj.run/AfKR2qk4FHY https://s.mj.run/q26JOxhBoSI https://s.mj.run/sKLIrmLWwXM https://s.mj.run/J_6O6qfkcaU https://s.mj.run/VnbfkjfD0Mk https://s.mj.run/w3zg_ZPiC_Y https://s.mj.run/KEqPOMNhrRg https://s.mj.run/RVEBGGZxlLM'
POSE=['front view, calm, looks at the viewer','three-quarter view, turned a little to the side, a clear expression']
ROOT=os.path.expanduser('~/ArcSpiritsArt/')
C={
 'Lantern Keeper':'a lantern keeper, female, 30 years old, dark hair in a bun, a simple red robe, she holds one glowing paper lantern on a short pole, night festival lights behind',
 'Fire Dancer':'a dancer, female, 24 years old, long black hair, a red and gold dance dress, she spins with one ribbon of fire around her',
 'Forge Apprentice':'a young blacksmith apprentice, male, 20 years old, soot on his cheeks, rolled sleeves, tongs with one piece of glowing hot metal',
 'Fire Fox':'a red fox with a tail tip of flame and bright orange eyes, it sits by a campfire, an animal',
 'Ember Monk':'a calm monk, male, 40 years old, a shaved head, red and cream robes, one small flame floats above his open palm',
 'Torch Bearer':'a messenger, male, 25 years old, short hair and a headband, a simple red tunic, he runs with one burning torch held high',
 'Phoenix Chick':'a small round baby phoenix with red and gold feathers and a small crest of flame, an animal',
 'Fire Cook':'a cheerful cook, female, 35 years old, a red headscarf and an apron, she tosses food in a wok over a big flame',
 'Ash Wanderer':'a wanderer, male, 45 years old, grey hair and stubble, a worn black cloak with a red scarf, warm sparks drift past him',
 'Fire Salamander':'a salamander with black skin and glowing orange spots, it rests on a warm rock, small flames near its tail, an animal',
}
n=0
for name,c in C.items():
    folder=f'assets/spirits/Fire/Concepts/{name}'; os.makedirs(ROOT+folder,exist_ok=True)
    open(ROOT+folder+'/guide.txt','w').write(c+'. Simple clear design with one main effect. Colors: red, black, gold and cream. Adult proportions.\n')
    for pose in POSE:
        text=f'portrait, character icon, zoomed in, {pose}, {c}. Simple clear design with one main effect. Colors: red, black, gold and cream. Adult proportions. --chaos 8 --ar 3:2 --sw 730 --stylize 0 --v 8.2 --no line art, full body'
        r=post('/api/enqueue',{'text':text,'params':'--sref '+SREF,'prefix':'','repeat':1,'mode':'relax','folder':folder,'counts':{'imagePrompts':0,'imageReferences':8},'top':True})
        assert r.get('added')==1, r; n+=1
print('queued',n)
