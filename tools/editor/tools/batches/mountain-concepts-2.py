# 2026-11-10: 10 new Mountain Arcane concepts, humanoid characters or creatures only (no golems). 2 jobs (8 images) each, 8.2, 3:2, Relax.
import json,os,urllib.request
B='http://127.0.0.1:8787'
def post(p,b): return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,json.dumps(b).encode(),{'content-type':'application/json','origin':B}),timeout=180).read())
SREF='https://s.mj.run/AfKR2qk4FHY https://s.mj.run/q26JOxhBoSI https://s.mj.run/sKLIrmLWwXM https://s.mj.run/J_6O6qfkcaU https://s.mj.run/VnbfkjfD0Mk https://s.mj.run/w3zg_ZPiC_Y https://s.mj.run/KEqPOMNhrRg https://s.mj.run/RVEBGGZxlLM'
POSE=['front view, calm, looks at the viewer','three-quarter view, turned a little to the side, a clear expression']
ROOT=os.path.expanduser('~/ArcSpiritsArt/')
C={
 'Bell Ringer':'a temple bell ringer, female, 30 years old, short dark hair, simple brown robes, she holds the rope of a large bronze bell, snow in the air',
 'Mountain Bear':'a large brown bear with thick fur and a calm face, it sits in the snow next to a pine tree, an animal',
 'Stone Carver':'a stone carver, male, 45 years old, a short beard, rolled sleeves and a dusty apron, a chisel and a small hammer in his hands',
 'Mountain Guide':'a mountain guide, female, 35 years old, sunburned cheeks, a wool cap, a lantern in one hand and a walking pole in the other',
 'Snow Owl':'a white snowy owl with yellow eyes, it sits on a bare branch in the snow, an animal',
 'Tea Master':'an old tea master, female, 65 years old, grey hair in a bun, a warm shawl, she holds a steaming cup of tea in both hands',
 'Miner':'a miner, male, 30 years old, a strong build, a headband, a pickaxe on his shoulder, one glowing ochre gem in his hand',
 'Mountain Wolf Rider':'a young scout, female, 20 years old, a fur hood, she sits on the back of a large grey wolf',
 'Horn Blower':'a watchman, male, 40 years old, a thick beard, a fur cloak, he blows a long curved horn on a cliff',
 'Ibex':'an ibex with very long curved ridged horns and brown fur, it stands on a narrow cliff edge, an animal',
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
