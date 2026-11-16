# 2026-11-10: 10 new Mountain Arcane concepts, humanoid characters or creatures only (no golems). 2 jobs (8 images) each, 8.2, 3:2, Relax.
import json,os,urllib.request
B='http://127.0.0.1:8787'
def post(p,b): return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,json.dumps(b).encode(),{'content-type':'application/json','origin':B}),timeout=180).read())
SREF='https://s.mj.run/AfKR2qk4FHY https://s.mj.run/q26JOxhBoSI https://s.mj.run/sKLIrmLWwXM https://s.mj.run/J_6O6qfkcaU https://s.mj.run/VnbfkjfD0Mk https://s.mj.run/w3zg_ZPiC_Y https://s.mj.run/KEqPOMNhrRg https://s.mj.run/RVEBGGZxlLM'
POSE=['front view, calm, looks at the viewer','three-quarter view, turned a little to the side, a clear expression']
ROOT=os.path.expanduser('~/ArcSpiritsArt/')
C={
 'Mountain Monk':'a calm monk, male, 35 years old, a shaved head, simple ochre and brown robes, prayer beads of bone, he sits on a snowy mountain peak',
 'Snow Hunter':'a hunter, female, 28 years old, white hair in a braid, a thick fur coat and hood, a bow on her back, cold breath in the air',
 'Mountain Goat':'a large white mountain goat with big curved horns and thick fur, it stands on a rock, an animal',
 'Peak Climber':'a young climber, male, 22 years old, messy brown hair, a scarf and a heavy coat, a rope over his shoulder and an ice pick in his hand, a happy grin',
 'Snow Leopard':'a snow leopard with pale grey fur and dark spots, bright blue eyes, it lies on a rock in the snow, an animal',
 'Old Hermit':'an old hermit, male, 70 years old, a long white beard, a patched brown cloak, a walking stick, a small campfire next to him',
 'Shield Maiden':'a warrior, female, 30 years old, white braids, a fur collar, simple iron armor, a round wooden shield and an axe',
 'Eagle Keeper':'a falconer, male, 40 years old, a grey beard, a leather glove, a large golden eagle on his arm, a fur cloak',
 'Yak Herder':'a herder, female, 25 years old, rosy cheeks, a colorful wool hat and a thick coat, she stands next to a big shaggy yak',
 'Mountain King':'a king, male, 50 years old, a grey beard, a plain iron crown, a heavy fur cloak over slate armor, a serious look, snowy peaks behind him',
}
n=0
for name,c in C.items():
    folder=f'assets/spirits/Mountain/Concepts/{name}'; os.makedirs(ROOT+folder,exist_ok=True)
    open(ROOT+folder+'/guide.txt','w').write(c+'. Simple clear design with one main effect. Colors: ochre, brown, slate grey and bone. Adult proportions.\n')
    for pose in POSE:
        text=f'portrait, character icon, zoomed in, {pose}, {c}. Simple clear design with one main effect. Colors: ochre, brown, slate grey and bone. Adult proportions. --chaos 8 --ar 3:2 --sw 730 --stylize 0 --v 8.2 --no line art, full body'
        r=post('/api/enqueue',{'text':text,'params':'--sref '+SREF,'prefix':'','repeat':1,'mode':'relax','folder':folder,'counts':{'imagePrompts':0,'imageReferences':8},'top':True})
        assert r.get('added')==1, r; n+=1
print('queued',n)
