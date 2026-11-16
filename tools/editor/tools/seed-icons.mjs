// Downloads every icon of the game (read only from Supabase) into references/icons/<table>/<name>.<ext>.
// It probes the tables below, takes every text column that holds a storage image path, and skips the large art
// columns (card prints, raw art, mats, backgrounds). Usage: node tools/seed-icons.mjs [--all]  (--all: also the large art)
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_FILE = process.env.ARCSPIRITS_ENV || join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend/.env');
const ROOT = process.env.NIJI_WORKSPACE || join(homedir(), 'ArcSpiritsArt');
const env = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const URL_ = env.PUBLIC_SUPABASE_URL, KEY = env.PUBLIC_SUPABASE_ANON_KEY;
const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, 'accept-profile': 'arc_spirits_assets' };
const all = process.argv.includes('--all');

const TABLES = ['origins', 'classes', 'runes', 'icon_pool', 'icons', 'rewards', 'reward_tokens', 'tokens', 'relics', 'augments', 'spirit_augments', 'statuses', 'status_icons',
  'monsters_v2', 'monsters', 'hex_spirits', 'guardians', 'game_locations', 'game_location_rows', 'dice_sides', 'custom_dice', 'dice_templates', 'extra_components', 'event_cards',
  'vengeance_cards', 'artifacts', 'artifact_tags', 'stage_dividers', 'travelers', 'traveler_quests', 'special_categories', 'rarity_traits', 'scenarios', 'edition_scenarios', 'ui_settings', 'editions'];
const BIG = /card_image|game_print|art_raw|mat_path|chibi|background|combined|back_side|template|export|display_image|row_image|image_with_icons|card_base|event_card_image|image_path$/;
const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim();

async function rows(table) {
  const r = await fetch(`${URL_}/rest/v1/${table}?select=*&limit=1000`, { headers });
  if (!r.ok) return null;
  return r.json();
}
let saved = 0, skipped = 0, failed = 0;
async function fetchFile(storagePath, dir, name) {
  const ext = (storagePath.match(/\.(png|svg|jpe?g|webp|gif)(\?|$)/i)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
  const out = join(dir, `${name}.${ext}`);
  if (existsSync(out)) return void skipped++;
  await mkdir(dir, { recursive: true });
  const path = storagePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  let r = await fetch(/^https?:/.test(storagePath) ? storagePath : `${URL_}/storage/v1/object/public/game_assets/${path}`);
  if (!r.ok && !/^https?:/.test(storagePath)) r = await fetch(`${URL_}/storage/v1/object/public/${path}`); // a path that starts with its bucket
  if (!r.ok) return void (failed++, console.warn(`  missing: ${storagePath}`));
  await writeFile(out, Buffer.from(await r.arrayBuffer()));
  saved++;
}
for (const table of TABLES) {
  const list = await rows(table);
  if (!list) continue;
  if (!list.length) { console.log(`${table}: empty`); continue; }
  const cols = Object.keys(list[0]).filter((c) => list.some((x) => typeof x[c] === 'string' && /\.(png|svg|jpe?g|webp|gif)(\?|$)/i.test(x[c])));
  const use = cols.filter((c) => all || !BIG.test(c));
  if (!cols.length) continue;
  console.log(`${table}: ${use.join(', ')}${cols.length > use.length ? `  (skipped large art: ${cols.filter((c) => !use.includes(c)).join(', ')})` : ''}`);
  for (const x of list) {
    const base = clean(x.name ?? x.label ?? x.title ?? x.id);
    for (const c of use) {
      if (typeof x[c] !== 'string' || !/\.(png|svg|jpe?g|webp|gif)(\?|$)/i.test(x[c])) continue;
      await fetchFile(x[c], join(ROOT, 'references/icons', table), use.length > 1 ? `${base} (${c.replace(/_?(path|png|svg)$/g, '').replace(/_/g, ' ')})` : base);
    }
  }
}
console.log(`Done: ${saved} saved, ${skipped} already there, ${failed} missing.`);
