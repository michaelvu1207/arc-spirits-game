# 2026-11-11: new concepts for the 5 Moon spirits (Moonrend, The Argent Loom, Threefold Watcher, Nhal, Vespera).
# Michael: Moon spirits must look evil and very dark, but "subtly evil, very cunning", not "madness evil".
# 2 designs x 2 poses = 4 jobs (16 images) per spirit, 8.2, 3:2, Relax, no image prompt (the old designs are light), into each spirit's "character design" folder.
import json,os,urllib.request
B='http://127.0.0.1:8787'
def post(p,b): return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,json.dumps(b).encode(),{'content-type':'application/json','origin':B}),timeout=180).read())
SREF='https://s.mj.run/AfKR2qk4FHY https://s.mj.run/q26JOxhBoSI https://s.mj.run/sKLIrmLWwXM https://s.mj.run/J_6O6qfkcaU https://s.mj.run/VnbfkjfD0Mk https://s.mj.run/w3zg_ZPiC_Y https://s.mj.run/KEqPOMNhrRg https://s.mj.run/RVEBGGZxlLM'
POSE={'person':['front view, chin a little down, a faint knowing smile, cold calculating eyes that look at the viewer','three-quarter view, a sideways glance at the viewer, one eyebrow raised, a small sly smile'],
      'animal':['front view, heads tilted, half-closed cold eyes that watch the viewer','three-quarter view, a sideways glance at the viewer, calm and still']}
LOOK='calm and composed, subtly evil and very cunning, an elegant and very dark character design, deep shadows, a pale full moon in a black night sky behind. Simple clear design with one main effect. Colors: black, deep indigo, dark violet and silver. Adult proportions.'
ROOT=os.path.expanduser('~/ArcSpiritsArt/')
C={
 'Moonrend':[('person','a duelist, male, 28 years old, dark skin, pale hair swept to one side, a black coat with a high collar and silver crescent clasps, he holds one thin crescent blade close to his face'),
             ('person','an assassin, male, 28 years old, dark skin, short pale hair, a black hood pushed back, dark indigo leather with silver trim, two crescent daggers crossed at his chest')],
 'The Argent Loom':[('person','a weaver, female, 30 years old, long silver hair, a thin black veil over her eyes, a black and indigo gown, she pulls silver threads between her fingers like a puppet master, a silver loom frame behind her'),
             ('person','a veiled spirit woman inside a floating silver loom, long white hair, a black lace veil, a dark violet gown, silver threads stretch around her like a spider web')],
 'Threefold Watcher':[('animal','three owls close together on one dead branch, one black, one dark grey, one silver, glowing violet eyes, silver crescent marks on their chests, animals'),
             ('person','a watcher, female, 25 years old, dark skin, short white hair, a black feather cloak, three dark owls with glowing violet eyes sit on her shoulders and her raised arm')],
 'Nhal':[('person','a tall man, 35 years old, pale skin, black hair, a broken silver halo above his head, a black coat that unravels into black threads at its edges, he offers one open hand to the viewer'),
             ('person','a tall figure in a black robe, a broken halo, thin void cracks with violet light across his chest, black threads drift from his sleeves, his hands are folded, half of his face in shadow')],
 'Vespera':[('person','an empress, female, 35 years old, long black hair, pale skin, violet eyes, a silver crescent crown, a black and indigo gown with a high collar, she rests her chin on one hand, a dark throne behind her'),
             ('person','an empress, female, 35 years old, long black hair, violet eyes, a silver crescent crown, a black veil cape, dark lipstick, she holds one black folding fan near her face that hides part of her smile')],
}
n=0
for name,designs in C.items():
    folder=f'assets/spirits/Moon/{name}/character design'; assert os.path.isdir(ROOT+folder), folder
    g=ROOT+f'assets/spirits/Moon/{name}/guide.txt'; bak=ROOT+f'assets/spirits/Moon/{name}/guide.bak-2026-11-11.txt'
    if not os.path.exists(bak): os.rename(g,bak)
    open(g,'w').write(f'{designs[0][1]}, {LOOK}\n')   # the folder guide now gives the dark direction (the old guide is the .bak file)
    for kind,c in designs:
        for pose in POSE[kind]:
            text=f'portrait, character icon, zoomed in, {pose}, {c}, {LOOK} --chaos 8 --ar 3:2 --sw 730 --stylize 0 --v 8.2 --no line art, full body, wide eyes, open mouth'
            r=post('/api/enqueue',{'text':text,'params':'--sref '+SREF,'prefix':'','repeat':1,'mode':'relax','folder':folder,'counts':{'imagePrompts':0,'imageReferences':8},'top':True})
            assert r.get('added')==1, r; n+=1
print('queued',n)
