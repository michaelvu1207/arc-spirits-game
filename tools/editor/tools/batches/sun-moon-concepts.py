# 2026-11-11: 10 new Sun and 10 new Moon Arcane concepts (Michael wants 7 spirits in each; each has 5), humanoid characters or creatures only.
# 2 jobs (8 images) each, 8.2, 3:2, Relax. The same recipe as fire-concepts.py; colors and backdrop from the old Arcane Spirits guide (now assets/spirits/Sun|Moon/guide.txt; the folders moved there on 2026-11-11).
import json,os,urllib.request
B='http://127.0.0.1:8787'
def post(p,b): return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,json.dumps(b).encode(),{'content-type':'application/json','origin':B}),timeout=180).read())
SREF='https://s.mj.run/AfKR2qk4FHY https://s.mj.run/q26JOxhBoSI https://s.mj.run/sKLIrmLWwXM https://s.mj.run/J_6O6qfkcaU https://s.mj.run/VnbfkjfD0Mk https://s.mj.run/w3zg_ZPiC_Y https://s.mj.run/KEqPOMNhrRg https://s.mj.run/RVEBGGZxlLM'
POSE=['front view, calm, looks at the viewer','three-quarter view, turned a little to the side, a clear expression']
ROOT=os.path.expanduser('~/ArcSpiritsArt/')
LOOK={'Sun':('a large setting sun and amber clouds behind','white, gold and dark green'),
      'Moon':('a large full moon and a night sky behind','indigo, violet, silver and white')}
C={'Sun':{
 'Sun Priestess':'a priestess, female, 30 years old, long pale blond hair and gold eyes, white and gold robes, she lifts one round gold mirror that reflects the sunlight',
 'Dawn Knight':'a knight, male, 35 years old, short pale blond hair, white and gold armor, he holds one round shield with a sunburst emblem',
 'Sun Lion':'a white lion with a golden mane in the shape of sun rays and gold eyes, it sits upright and calm, an animal',
 'Sunflower Maiden':'a gardener, female, 22 years old, pale blond braids, a wide straw hat, a white dress with a dark green sash, she holds one large sunflower',
 'Golden Stag':'a white stag with golden antlers, one small sun disc glows between the antlers, an animal',
 'Sun Archer':'an archer, female, 26 years old, pale blond hair in a ponytail, a white and gold tunic, she draws a gold bow with one arrow of light',
 'Lamp Lighter':'an old lamp lighter, male, 65 years old, a white beard, a white cloak with gold trim, he carries one lantern with a small sun inside',
 'Sun Dancer':'a dancer, female, 24 years old, pale blond hair, gold bangles, a white and gold dance dress, she spins with one ribbon of sunlight',
 'Dawn Rooster':'a white rooster with a long golden tail and a red crest, it crows on a fence post at sunrise, an animal',
 'Sundial Sage':'a scholar, female, 40 years old, pale blond hair in a bun, round glasses, white and dark green robes, she holds one small gold sundial',
},'Moon':{
 'Moon Rabbit':'a white rabbit with violet eyes and a silver crescent mark on its forehead, it sits in tall grass, an animal',
 'Moon Archer':'an archer, female, 28 years old, long white hair and violet eyes, an indigo cloak, she holds one silver bow in the shape of a crescent',
 'Moon Moth':'a large pale moth with soft white fur and crescent patterns on its violet wings, it rests on a branch, an animal',
 'Star Reader':'an astrologer, male, 55 years old, long silver hair, indigo robes with small pearls, he holds one star chart, a small telescope at his belt',
 'Veil Dancer':'a dancer, female, 24 years old, white hair, crescent earrings, an indigo dance dress, she moves with one long violet veil',
 'Dream Keeper':'a dream keeper, female, 20 years old, sleepy half-closed violet eyes, messy white hair, a loose indigo robe, one small crescent lantern floats next to her',
 'Black Cat':'a black cat with silver eyes and a small crescent charm on its collar, it sits on a roof, an animal',
 'Night Thief':'a thief, male, 26 years old, white hair under a dark indigo hood, a half mask in the shape of a crescent, one silver dagger in his hand',
 'Moon Priestess':'a priestess, female, 32 years old, long white hair, a silver crescent headpiece, white and indigo robes, she holds one bowl of water that reflects the moon',
 'Moon Knight':'a knight, male, 35 years old, white hair and violet eyes, dark indigo armor with a silver crescent crest, he holds one long spear',
}}
n=0
for origin,concepts in C.items():
    back,colors=LOOK[origin]
    for name,c in concepts.items():
        folder=f'assets/spirits/{origin}/Concepts/{name}'; os.makedirs(ROOT+folder,exist_ok=True)
        desc=f'{c}, {back}. Simple clear design with one main effect. Colors: {colors}. Adult proportions.'
        open(ROOT+folder+'/guide.txt','w').write(desc+'\n')
        for pose in POSE:
            text=f'portrait, character icon, zoomed in, {pose}, {desc} --chaos 8 --ar 3:2 --sw 730 --stylize 0 --v 8.2 --no line art, full body'
            r=post('/api/enqueue',{'text':text,'params':'--sref '+SREF,'prefix':'','repeat':1,'mode':'relax','folder':folder,'counts':{'imagePrompts':0,'imageReferences':8},'top':True})
            assert r.get('added')==1, r; n+=1
print('queued',n)
