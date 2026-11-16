// Makes one workspace folder for each monster of the game, with a guide.txt (the prompt text for its art).
// Names, difficulty and Barrier come from the game database (read only). The looks are written here.
// It does not overwrite a guide.txt that is already there, unless you add --rewrite. Usage: node tools/seed-monsters.mjs [--rewrite]
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_FILE = process.env.ARCSPIRITS_ENV || join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend/.env');
const ROOT = process.env.NIJI_WORKSPACE || join(homedir(), 'ArcSpiritsArt');
const env = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const headers = { apikey: env.PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${env.PUBLIC_SUPABASE_ANON_KEY}`, 'accept-profile': 'arc_spirits_assets' };

// The look of each difficulty. Difficulty 1 is the least threatening; 3 is the most evil and dark.
const TIER = {
  1: 'A small, weak monster that looks more mischievous than dangerous, with round soft shapes and big simple eyes. Background: PLACE, bright and peaceful in daylight, with soft light. Light and friendly colors, low threat.',
  2: 'A dangerous predator monster of medium to large size, with sharp angular shapes, glowing eyes, claws or teeth, in an aggressive pose. Background: PLACE, dark and corrupted at night under a huge blood moon, with fog and deep shadows. Blood moon lighting: the whole scene is dark and tinted deep red, with crimson light on the edges of the monster and black shadows. Dark red, black and crimson colors, clear threat.',
  3: 'A nightmare horror entity, like Slender Man: tall, thin, unnaturally elongated, silent and wrong, pure evil. Extreme close-up: it stands very close and stares straight at the viewer with a dead, hateful expression, an unnaturally wide mouth of thin needle teeth, and hollow black eyes. Thick dark purple blood runs from its mouth and eyes and drips down. Almost the whole image is pitch black: the figure melts into the black void, and only its face and teeth are lit. Color scheme: bright electric purple and bright blood red in a dramatic sense, with burning neon red-orange eyes, magenta and violet light on the face, and black everywhere else. Lots of effects: glowing purple and red auras, energy particles, embers and sparks that fly around the monster, speed lines and motion lines that radiate from it, light streaks and smears across the image. No scenery, no sky, no stars. Black, bright purple, bright red and magenta, extreme contrast, dread, horror mood.',
};
// The home of each origin. It replaces PLACE in the difficulty text.
const PLACE = {
  'Fire': 'a volcanic land with black rock and lava streams',
  'Forest': 'an old forest with giant trees and moss',
  'Water': 'a sea shore with tide pools and marsh water',
  'Mountain': 'a high snowy mountain with stone cliffs and crystals',
  'Twilight Fairies': 'a fairy glade with giant flowers and mushrooms',
  'Arcane Spirits': 'a broken sun and moon temple that floats in a sky of stars',
};
const LOOK = {
  // Difficulty 1
  'Ashwisp': 'a tiny floating puff of grey ash with two small ember eyes and a thin trail of smoke',
  'Bog Whisperer': 'a small round mud creature with reeds on its head, a wide mouth and one hand at its mouth as if it tells a secret',
  'Cinder Mite': 'a small round beetle with a shell like a glowing coal and short stubby legs',
  'Driftshade': 'a small soft shadow blob that floats like a leaf in the wind, with pale round eyes',
  'Dusk Sprite': 'a small purple sprite with moth-like wings and a body that glows faintly',
  'Ember Gnat': 'a fat little flying bug with a glowing orange belly and very small wings',
  'Fogkin': 'a small child-sized creature made of thick white fog, with stubby arms and hollow round eyes',
  'Gloom Moth': 'a fluffy grey moth with large sad eye patterns on its wings and soft antennae',
  'Grave Nettle': 'a small walking nettle plant with a grumpy face, spiky leaves and root feet',
  'Hollow Lantern': 'a small old paper lantern that hops, with a hollow face cut into it and a weak dying flame inside',
  'Mire Imp': 'a small green swamp imp covered in mud, with big ears, a cheeky grin and a lily pad as a hat',
  'Murk Tadpole': 'a fat dark tadpole with large shiny eyes and a short wiggly tail, half out of a puddle',
  'Pale Wanderer': 'a short thin ghost in a ragged white cloak covered in frost that carries a small walking stick, its face only two dots',
  'Rattlebone Pup': 'a playful skeleton wolf pup with moss on its bones, a wagging bone tail and small green lights in its eye sockets',
  'Rustveil Ghostling': 'a small ghost that wears a rusty miner helmet too big for it and a torn grey veil',
  'Shiver Wisp': 'a small pale blue flame spirit that shakes from the cold, with frost crystals around it',
  'Splinter Imp': 'a small imp made of broken wood and twigs, with sharp splinter hair and a naughty grin',
  'Thornling': 'a small round seed creature with a thorny vine tail and one pink flower on its head',
  'Tidepool Lurker': 'a small crab-like creature that hides under a shell covered in seaweed and barnacles, only its eyes show',
  'Weeping Candle': 'a short melting candle creature with wax tears on its face and a small flame on its head',
  // Difficulty 2
  'Ashen Lynx': 'a lean lynx with fur of grey ash and smoke, glowing orange cracks in its skin and ember eyes',
  'Blightfang': 'a sick-looking giant serpent with oversized green fangs that drip poison and patches of rot on its scales',
  'Bone Weaver': 'a large spider made of bones that spins a web of white sinew between dead trees',
  'Bramble Wyrm': 'a long wingless dragon made of twisted thorn vines, with red berries like eyes along its body',
  'Carrion Crown': 'a huge vulture with feathers of ash, a crown of charred bones on its head and smoking black wings spread wide',
  'Chainmaw Brute': 'a heavy ogre-like beast of black slag with red-hot iron chains around its arms and a jaw like a steel trap',
  'Dread Mantis': 'a tall black mantis with scythe arms like polished blades and many small red eyes',
  'Ember Maw': 'a squat lava beast that is mostly one huge mouth, with a furnace glow in its throat and rock teeth',
  'Gravemoss Golem': 'a golem built from old gravestones and wet moss, with one green lantern light in its chest',
  'Gutter Hydra': 'a three-headed hydra that comes out of dirty water, with slimy grey-green skin and yellow eyes',
  'Hollow Stag': 'a large stag with an empty ribcage, antlers like dead branches and a pale light where its heart was',
  'Howling Shroud': 'a large torn shroud of snow and wind that flies like a ghost, with a screaming face pressed out of the cloth',
  'Ironjaw Hound': 'a muscular hound with an iron muzzle plate, a spiked collar and sparks at its teeth',
  'Marrow Wolf': 'a gaunt white wolf with bones that show through its skin and a red glow in its mouth',
  'Mirror Stalker': 'a thin tall creature with skin of broken mirror shards and a smooth face with no features',
  'Riftjackal': 'a jackal with purple rift cracks across its body, where parts of it flicker out of place',
  'Stormgut Toad': 'a giant bloated toad with a see-through belly full of lightning and storm clouds',
  'Sunken Bellwraith': 'a drowned wraith that carries a cracked bronze bell covered in barnacles, with wet seaweed hair',
  'Tidecaller Eel': 'a huge electric eel with fin crests like a crown, in a spiral of dark water',
  'Venom Lotus': 'a large beautiful lotus flower with a fanged mouth in its center and whip-like roots that drip purple poison',
  // Difficulty 3
  'Abyss Leviathan': 'an endless black serpent that swims through the night sky, with rows of pale star lights along its body and a mouth like a cave of teeth',
  'Ashfall Tyrant': 'a giant horned tyrant in black armor with gold rune cracks, a cloak of night sky and a black sun that burns behind its head as a crown',
  'Cinder Colossus': 'a sky-high giant with a dying, cracked sun in its open chest, a body of dark gold plates that break apart and an empty burning face',
  'Eclipse Wyrm': 'a vast dragon whose body circles a black sun, with scales like the night sky and a thin white corona along its spine',
  'Gloamheart Dragon': 'a dark dragon with torn wings of starlight and a huge dying star that beats like a heart through its open chest',
  'Grief Titan': 'a kneeling giant with a cracked full moon for a face, hidden in its hands, and silver tears that pour down to make a lake',
  'Maw of the Deep Rift': 'a crack in the sky that is a living mouth, with rings of teeth, broken rune circles around it and long tentacles that reach out of the dark',
  'Nightmare Loom': 'a monstrous many-armed weaver of bone and gold that weaves threads of starlight into a cloth of screaming faces',
  'Obsidian Hydra': 'a nine-headed hydra of black glass, where each head carries a different moon phase and a cold white light in its throat',
  'Pale Monarch': 'a tall skeletal spirit king in white rags on a throne of broken crescent moons, with a crown that floats above an empty hood',
  'Plague Choir': 'a ring of many tall hooded faceless spirits grown together into one body, all with open singing mouths that pour out black starless mist',
  'Rootrot Ancient': 'a colossal floating stone head covered in glowing runes, cracked open, with a blind gold eye and broken pillars that turn around it',
  'Ruin Phoenix': 'a giant skeletal phoenix made of black sun fire, with a white corona on its wings and falling sparks like dying stars',
  'Starless Seraph': 'a fallen angel with six black wings, no face, a broken halo and a body like a hole in the night sky',
  'Storm-Eater': 'a sky-filling beast made of dark nebula clouds, with a huge mouth that swallows stars and many arms of light',
  'The Drowned Bell': 'a colossal cracked gold temple bell that hangs in the void, with a monstrous creature inside it and long arms and chains that reach out from below',
  'The Hollow Regent': 'a giant empty set of holy temple armor with a dark void inside, a tattered rune cape, a huge sword and a broken halo that burns with cold fire',
  'Thousand-Eye Warden': 'a towering winged guardian whose body, wings and shield are covered in hundreds of open staring eyes',
  'Void Shepherd': 'a very tall thin robed figure with a crooked crescent staff that leads a flock of lost star souls, with a void where its face should be',
  'World Gnawer': 'a planet-sized worm that bites into the moon, with rings of grinding teeth and pieces of the moon that break in its mouth',
};

// Michael's names for the workspace (2026-11-06), in the style of Realm of the Mad God: plain names for weak monsters,
// named bosses with a title for Difficulty 3. Key = name in the game database (not changed).
const NAME = {
  'Ashwisp': 'Ash Puff',
  'Bog Whisperer': 'Mud Slime',
  'Cinder Mite': 'Coal Beetle',
  'Driftshade': 'Shade Blob',
  'Dusk Sprite': 'Dusk Sprite',
  'Ember Gnat': 'Fire Gnat',
  'Fogkin': 'Fog Child',
  'Gloom Moth': 'Grey Moth',
  'Grave Nettle': 'Angry Nettle',
  'Hollow Lantern': 'Lantern Ghost',
  'Mire Imp': 'Swamp Imp',
  'Murk Tadpole': 'Fat Tadpole',
  'Pale Wanderer': 'Lost Ghost',
  'Rattlebone Pup': 'Bone Puppy',
  'Rustveil Ghostling': 'Helmet Ghost',
  'Shiver Wisp': 'Frost Wisp',
  'Splinter Imp': 'Twig Imp',
  'Thornling': 'Thorn Sprout',
  'Tidepool Lurker': 'Shy Crab',
  'Weeping Candle': 'Sad Candle',
  'Ashen Lynx': 'Ash Lynx',
  'Blightfang': 'Rot Serpent',
  'Bone Weaver': 'Bone Spider',
  'Bramble Wyrm': 'Thorn Wyrm',
  'Carrion Crown': 'Vulture King',
  'Chainmaw Brute': 'Chain Ogre',
  'Dread Mantis': 'Mantis Reaper',
  'Ember Maw': 'Lava Maw',
  'Gravemoss Golem': 'Tomb Golem',
  'Gutter Hydra': 'Sewer Hydra',
  'Hollow Stag': 'Ghost Stag',
  'Howling Shroud': 'Screaming Shroud',
  'Ironjaw Hound': 'Iron Hound',
  'Marrow Wolf': 'Starved Wolf',
  'Mirror Stalker': 'Mirror Demon',
  'Riftjackal': 'Rift Jackal',
  'Stormgut Toad': 'Storm Toad',
  'Sunken Bellwraith': 'Bell Wraith',
  'Tidecaller Eel': 'Eel Queen',
  'Venom Lotus': 'Poison Lotus',
  'Abyss Leviathan': 'Morvath the Abyss Serpent',
  'Ashfall Tyrant': 'Kargoth the Eclipsed Tyrant',
  'Cinder Colossus': 'Volgrim the Fallen Sun',
  'Eclipse Wyrm': 'Solnyx the Eclipse Dragon',
  'Gloamheart Dragon': 'Vyrax the Bleeding Star',
  'Grief Titan': 'Oron the Weeping Moon',
  'Maw of the Deep Rift': 'The Hungering Rift',
  'Nightmare Loom': 'Sethra the Fate Weaver',
  'Obsidian Hydra': 'Nyxara the Nine Moons',
  'Pale Monarch': 'Selvane the Pale Moon King',
  'Plague Choir': 'The Silent Choir',
  'Rootrot Ancient': 'Eldergrim the Broken Oracle',
  'Ruin Phoenix': 'Pyrrhos the Black Sun Phoenix',
  'Starless Seraph': 'Zerathiel the Fallen Seraph',
  'Storm-Eater': 'Tempestus the Star Eater',
  'The Drowned Bell': 'The Bell of the Void',
  'The Hollow Regent': 'Malric the Hollow Saint',
  'Thousand-Eye Warden': 'Argoth the All-Seeing',
  'Void Shepherd': 'Charos the Soul Shepherd',
  'World Gnawer': 'Gorm the Moon Eater',
};

// Michael's theme (2026-11-06): each monster is a fallen entity of one origin. Key = origin folder in assets/spirits.
const FALLEN = {
  'Fire': 'It is a fallen spirit of Fire: its flame is dying or burns black, with ash, charcoal skin and ember cracks.',
  'Forest': 'It is a fallen spirit of the Forest: rotten and overgrown, with dead wood, thorns, fungus and sick green sap.',
  'Water': 'It is a fallen spirit of Water: drowned and murky, with dark still water, barnacles, seaweed and pale deep-sea lights.',
  'Mountain': 'It is a fallen spirit of the Mountain: cracked and frozen, with broken stone, dull dead crystals and frost.',
  'Twilight Fairies': 'It is a fallen Twilight Fairy: torn butterfly or moth wings, a faded pink and violet glow, and sick, flickering sparkles.',
  'Arcane Spirits': 'It is a fallen arcane spirit of cosmic power, not of any land: sun, moon, star and void motifs, a broken halo, dimmed gold, glowing runes, a black sun and a cracked moon.',
};
// Difficulty 1 and 2: fallen entities of Fire, Forest, Water, Mountain and Twilight Fairies. Difficulty 3: all arcane (sun, moon, stars, void).
// There are no Hero monsters (Michael, 2026-11-06).
const ORIGIN = {
  'Ashwisp': 'Fire',
  'Cinder Mite': 'Fire',
  'Ember Gnat': 'Fire',
  'Weeping Candle': 'Fire',
  'Hollow Lantern': 'Fire',
  'Ashen Lynx': 'Fire',
  'Ember Maw': 'Fire',
  'Chainmaw Brute': 'Fire',
  'Carrion Crown': 'Fire',
  'Grave Nettle': 'Forest',
  'Splinter Imp': 'Forest',
  'Thornling': 'Forest',
  'Rattlebone Pup': 'Forest',
  'Bramble Wyrm': 'Forest',
  'Hollow Stag': 'Forest',
  'Venom Lotus': 'Forest',
  'Blightfang': 'Forest',
  'Bog Whisperer': 'Water',
  'Murk Tadpole': 'Water',
  'Tidepool Lurker': 'Water',
  'Mire Imp': 'Water',
  'Gutter Hydra': 'Water',
  'Tidecaller Eel': 'Water',
  'Stormgut Toad': 'Water',
  'Sunken Bellwraith': 'Water',
  'Shiver Wisp': 'Mountain',
  'Fogkin': 'Mountain',
  'Rustveil Ghostling': 'Mountain',
  'Pale Wanderer': 'Mountain',
  'Gravemoss Golem': 'Mountain',
  'Ironjaw Hound': 'Mountain',
  'Marrow Wolf': 'Mountain',
  'Howling Shroud': 'Mountain',
  'Dusk Sprite': 'Twilight Fairies',
  'Gloom Moth': 'Twilight Fairies',
  'Driftshade': 'Twilight Fairies',
  'Dread Mantis': 'Twilight Fairies',
  'Bone Weaver': 'Twilight Fairies',
  'Mirror Stalker': 'Twilight Fairies',
  'Riftjackal': 'Twilight Fairies',
  'Abyss Leviathan': 'Arcane Spirits',
  'Ashfall Tyrant': 'Arcane Spirits',
  'Cinder Colossus': 'Arcane Spirits',
  'Eclipse Wyrm': 'Arcane Spirits',
  'Gloamheart Dragon': 'Arcane Spirits',
  'Grief Titan': 'Arcane Spirits',
  'Maw of the Deep Rift': 'Arcane Spirits',
  'Nightmare Loom': 'Arcane Spirits',
  'Obsidian Hydra': 'Arcane Spirits',
  'Pale Monarch': 'Arcane Spirits',
  'Plague Choir': 'Arcane Spirits',
  'Rootrot Ancient': 'Arcane Spirits',
  'Ruin Phoenix': 'Arcane Spirits',
  'Starless Seraph': 'Arcane Spirits',
  'Storm-Eater': 'Arcane Spirits',
  'The Drowned Bell': 'Arcane Spirits',
  'The Hollow Regent': 'Arcane Spirits',
  'Thousand-Eye Warden': 'Arcane Spirits',
  'Void Shepherd': 'Arcane Spirits',
  'World Gnawer': 'Arcane Spirits',
};

const table = async (q) => { const r = await fetch(`${env.PUBLIC_SUPABASE_URL}/rest/v1/${q}`, { headers }); if (!r.ok) throw new Error(`${q}: ${r.status} ${await r.text()}`); return r.json(); };
const clean = (s) => s.replace(/[\\/:*?"<>|]/g, '').trim();
const rewrite = process.argv.includes('--rewrite'); // writes all guides again
const put = async (file, text) => { if (rewrite || !existsSync(file)) await writeFile(file, text + '\n'); };

let made = 0, missing = [];
for (const [stage, look] of Object.entries(TIER)) {
  const dir = join(ROOT, 'assets/monsters', `Difficulty ${stage}`);
  await mkdir(dir, { recursive: true });
  await put(join(dir, 'guide.txt'), `Difficulty ${stage} monster. ${look.replace('PLACE', 'the home of its origin')}`);
}
for (const m of await table('monsters_v2?select=name,stage,barrier&order=stage,barrier,name')) {
  if (!LOOK[m.name] || !TIER[m.stage]) { missing.push(m.name); continue; }
  const name = NAME[m.name] ?? m.name;
  const dir = join(ROOT, 'assets/monsters', `Difficulty ${m.stage}`, clean(name));
  const origin = ORIGIN[m.name];
  if (origin === 'Twilight Fairies') continue; // Michael (2026-11-07): no fairy monsters in the game art.
  await mkdir(dir, { recursive: true });
  await put(join(dir, 'guide.txt'), `${m.stage === 3 ? 'dark anime horror illustration of a monster' : 'anime fantasy illustration of a monster'}, ${name}: ${LOOK[m.name]}. ${FALLEN[origin]} ${TIER[m.stage].replace('PLACE', PLACE[origin])} ${m.stage === 3 ? 'Anime illustration style with clean painted shapes, heavy black shadows, low key, neon purple and red effects on black. Extreme close-up, no background, no scenery, no landscape.' : 'Flat anime illustration style with clean shapes and soft painted light. Medium shot: the monster and the background each fill about half of the image, and the background is clear and detailed.'} One monster only, no text.`);
  // The origin icon shows before the monster name in the page.
  const icon = join(ROOT, 'assets/spirits', origin, `.origin-${origin}.png`);
  if (existsSync(icon) && !existsSync(join(dir, `.origin-${origin}.png`))) await copyFile(icon, join(dir, `.origin-${origin}.png`));
  made++;
}
console.log(`Done: ${made} monster folders in ${join(ROOT, 'assets/monsters')}.${missing.length ? ` No look written for: ${missing.join(', ')}` : ''}`);
