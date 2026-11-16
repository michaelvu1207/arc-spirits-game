# 2026-11-11: 10 new Moon concepts with the look Michael gave for Moon: evil, a mean expression, a very dark character design.
# (The first Moon set in sun-moon-concepts.py is too light and friendly.) 2 jobs (8 images) each, 8.2, 3:2, Relax; the same recipe as fire-concepts.py.
import json,os,urllib.request
B='http://127.0.0.1:8787'
def post(p,b): return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,json.dumps(b).encode(),{'content-type':'application/json','origin':B}),timeout=180).read())
SREF='https://s.mj.run/AfKR2qk4FHY https://s.mj.run/q26JOxhBoSI https://s.mj.run/sKLIrmLWwXM https://s.mj.run/J_6O6qfkcaU https://s.mj.run/VnbfkjfD0Mk https://s.mj.run/w3zg_ZPiC_Y https://s.mj.run/KEqPOMNhrRg https://s.mj.run/RVEBGGZxlLM'
POSE=['front view, chin down, a cold mean glare at the viewer','three-quarter view, turned a little to the side, a cruel smirk and narrowed eyes']
ROOT=os.path.expanduser('~/ArcSpiritsArt/')
LOOK='an evil look, a very dark character design, deep shadows, a pale full moon in a black night sky behind. Simple clear design with one main effect. Colors: black, deep indigo, dark violet and silver. Adult proportions.'
C={
 'Night Witch':'a witch, female, 30 years old, long black hair, pale skin, violet eyes with dark eye shadow, a black robe with a silver crescent brooch, one violet flame in her open palm',
 'Dark Moon Knight':'a knight, male, 35 years old, pale skin, white hair swept back, black armor with sharp edges and a silver crescent crest, he holds one long black spear',
 'Moon Executioner':'a tall executioner, male, 40 years old, a black hood that shadows his eyes, a scar on his chin, he rests one large axe with a crescent blade on his shoulder',
 'Shadow Wolf':'a large black wolf with glowing violet eyes and bared teeth, a silver crescent scar on its forehead, an animal',
 'Night Raven':'a large black raven with glowing violet eyes and a sharp beak, it sits on a broken silver crescent, an animal',
 'Moon Cultist':'a cult priest, male, 50 years old, a thin hollow face, black hooded robes, a silver crescent mask on half of his face, he holds one black candle with a violet flame',
 'Dark Moon Priestess':'a priestess, female, 32 years old, long black hair under a black veil, black and indigo robes, a sharp silver crescent headpiece, she holds one silver ritual dagger',
 'Night Lord':'a vampire noble, male, 30 years old, pale skin, long black hair, small fangs, a black coat with a high collar and silver crescent clasps, one glass of dark wine in his hand',
 'Poisoner':'a poisoner, female, 28 years old, a short black bob, dark lipstick, a black coat with silver buttons, she holds up one small vial of glowing violet poison',
 'Shadow Dancer':'a dancer, female, 24 years old, black hair, a dark veil across her lower face, a black dance dress with silver crescents, she moves with one long ribbon of shadow',
}
n=0
for name,c in C.items():
    folder=f'assets/spirits/Moon/Concepts/{name}'; os.makedirs(ROOT+folder,exist_ok=True)
    desc=f'{c}, {LOOK}'
    open(ROOT+folder+'/guide.txt','w').write(desc+'\n')
    for pose in POSE:
        text=f'portrait, character icon, zoomed in, {pose}, {desc} --chaos 8 --ar 3:2 --sw 730 --stylize 0 --v 8.2 --no line art, full body, smile'
        r=post('/api/enqueue',{'text':text,'params':'--sref '+SREF,'prefix':'','repeat':1,'mode':'relax','folder':folder,'counts':{'imagePrompts':0,'imageReferences':8},'top':True})
        assert r.get('added')==1, r; n+=1
print('queued',n)
