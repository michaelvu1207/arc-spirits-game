// Makes the Arc Spirits workspace folders and downloads the current game art into them.
// It only reads from Supabase. It does not overwrite files that are already there.
// Usage: node tools/seed-arcspirits.mjs
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_FILE = process.env.ARCSPIRITS_ENV || join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend/.env');
const ROOT = process.env.NIJI_WORKSPACE || join(homedir(), 'ArcSpiritsArt');
const env = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const URL_ = env.PUBLIC_SUPABASE_URL, KEY = env.PUBLIC_SUPABASE_ANON_KEY;
const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, 'accept-profile': 'arc_spirits_assets' };

const table = async (q) => {
  const r = await fetch(`${URL_}/rest/v1/${q}`, { headers });
  if (!r.ok) throw new Error(`${q}: ${r.status} ${await r.text()}`);
  return r.json();
};
const clean = (s) => s.replace(/[\\/:*?"<>|]/g, '').trim();
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

let saved = 0, skipped = 0, failed = 0;
/** Downloads a storage image (max 1536 px, not cropped) to dir/name.<ext>. */
async function fetchArt(storagePath, dir, name, size = 1536) {
  if (!storagePath) return;
  await mkdir(dir, { recursive: true });
  if (['.png', '.jpg', '.webp'].some((e) => existsSync(join(dir, name + e)))) return void skipped++;
  const path = storagePath.split('/').map(encodeURIComponent).join('/');
  let r = await fetch(`${URL_}/storage/v1/render/image/public/game_assets/${path}?width=${size}&height=${size}&resize=contain`, { headers: { accept: 'image/png,image/jpeg' } });
  if (!r.ok) r = await fetch(`${URL_}/storage/v1/object/public/game_assets/${path}`);
  if (!r.ok) return void (failed++, console.warn(`  missing: ${storagePath}`));
  const buf = Buffer.from(await r.arrayBuffer());
  const magic = buf.subarray(0, 4).toString('hex');
  const ext = magic.startsWith('89504e47') ? '.png' : magic.startsWith('ffd8') ? '.jpg' : magic.startsWith('52494646') ? '.webp' : EXT[r.headers.get('content-type')] ?? '.png';
  await writeFile(join(dir, name + ext), buf);
  saved++;
}

const origins = await table('origins?select=id,name,icon_png');
const originName = Object.fromEntries(origins.map((o) => [o.id, clean(o.name)]));
// Michael's rule: only guardians of these origins exist (Arcane Spirits = sun and moon, Twilight Fairies = fairy).
// Guardians of other origins (Fjorn, Human Avatar) get no folder. This rule is for guardians only, not for spirits.
const GUARDIAN_ORIGINS = ['Fire', 'Forest', 'Water', 'Mountain', 'Arcane Spirits', 'Twilight Fairies'];
// Michael renamed these guardians in the workspace (2026-11-05). The game database still has the old names.
const GUARDIAN_NAMES = { Bubblepop: 'Petra', Taron: 'Taron', Prox: 'Nox', 'Void Avatar': 'Eclipse' };
const HUMANS = 'Heroes'; // the Hero spirits have no origin in the game data; Michael's name for their folder

for (const d of ['references/style', 'references/backgrounds', 'assets/spirits', 'assets/backgrounds']) await mkdir(join(ROOT, d), { recursive: true });
const stylePrompt = join(ROOT, 'references/style/prompt.txt');
if (!existsSync(stylePrompt)) await writeFile(stylePrompt, 'waist-up character portrait, soft painterly anime style\n');

console.log('Spirits…');
// Origin icons: hidden files that the page shows before the origin folder name.
const originIcons = async () => { for (const o of origins) if (existsSync(join(ROOT, 'assets/spirits', clean(o.name)))) await fetchArt(o.icon_png, join(ROOT, 'assets/spirits', clean(o.name)), `.origin-${clean(o.name)}`, 64);
  // The Heroes folder uses the icon of the human origin.
  const human = origins.find((o) => clean(o.name) === 'Human Enclave');
  if (human && existsSync(join(ROOT, 'assets/spirits', HUMANS))) await fetchArt(human.icon_png, join(ROOT, 'assets/spirits', HUMANS), `.origin-${HUMANS}`, 64); };
const classes = Object.fromEntries((await table('classes?select=id,name,icon_png,class_type')).map((c) => [c.id, c]));
for (const s of await table('hex_spirits?select=name,traits,art_raw_image_path&order=name')) {
  const origin = originName[s.traits?.origin_ids?.[0]] ?? HUMANS;
  const dir = join(ROOT, 'assets/spirits', origin, clean(s.name));
  await fetchArt(s.art_raw_image_path, dir, 'current');
  // Class icons: hidden files that the page shows before the folder name.
  for (const c of (s.traits?.class_ids ?? []).map((id) => classes[id]).filter(Boolean)) await fetchArt(c.icon_png, dir, `.class-${clean(c.name)}`, 64);
  // A `.special` marker puts the spirit in the second group of its origin (special classes).
  if ((s.traits?.class_ids ?? []).some((id) => classes[id]?.class_type === 'special') && existsSync(dir)) await writeFile(join(dir, '.special'), '');
}
console.log('Guardians…');
// Each guardian has a folder in assets/guardians, with one folder for each type of art.
const GUARDIAN_FOLDERS = ['character design', 'keyframe illustrations', 'background'];
for (const g of await table('guardians?select=name,origin_id,image_mat_path,chibi_image_path&order=name')) {
  if (!GUARDIAN_ORIGINS.includes(originName[g.origin_id])) continue;
  const dir = join(ROOT, 'assets/guardians', GUARDIAN_NAMES[clean(g.name)] ?? clean(g.name));
  for (const f of GUARDIAN_FOLDERS) await mkdir(join(dir, f), { recursive: true });
  await fetchArt(g.image_mat_path, join(dir, 'character design'), 'mat');
  await fetchArt(g.chibi_image_path, join(dir, 'character design'), 'chibi');
}
await originIcons();
console.log('Location backgrounds…');
for (const l of await table('game_locations?select=name,background_image_path')) await fetchArt(l.background_image_path, join(ROOT, 'references/backgrounds'), clean(l.name));

console.log(`Done: ${saved} saved, ${skipped} already there, ${failed} missing. Workspace: ${ROOT}`);
