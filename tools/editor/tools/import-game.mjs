// ONE-TIME import of the game data: reads Supabase (read only) and writes local files. After this, the app works
// only from these files. Writes ~/ArcSpiritsArt/game/<table>.json (every row of every table found) and
// ~/ArcSpiritsArt/references/icons/<table>/<name>.<ext> (all icon images; large art is not downloaded).
// Usage: node tools/import-game.mjs
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_FILE = process.env.ARCSPIRITS_ENV || join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend/.env');
const ROOT = process.env.NIJI_WORKSPACE || join(homedir(), 'ArcSpiritsArt');
const env = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const URL_ = env.PUBLIC_SUPABASE_URL, KEY = env.PUBLIC_SUPABASE_ANON_KEY;
const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, 'accept-profile': 'arc_spirits_assets' };

const TABLES = ['origins', 'classes', 'runes', 'icon_pool', 'icons', 'rewards', 'reward_tokens', 'tokens', 'relics', 'augments', 'spirit_augments', 'statuses',
  'monsters_v2', 'monsters', 'hex_spirits', 'guardians', 'game_locations', 'game_location_rows', 'dice_sides', 'custom_dice', 'dice_templates', 'extra_components', 'event_cards',
  'vengeance_cards', 'artifacts', 'artifact_tags', 'stage_dividers', 'travelers', 'traveler_quests', 'special_categories', 'rarity_traits', 'scenarios', 'edition_scenarios', 'editions', 'ui_settings'];
const IMG = /\.(png|svg|jpe?g|webp|gif)(\?|$)/i;
const BIG = /card_image|game_print|art_raw|mat_path|chibi|background|combined|back_side|template|export|display_image|row_image|image_with_icons|card_base|event_card_image|image_path$/;
const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim();

let saved = 0, skipped = 0, failed = 0;
async function fetchFile(storagePath, dir, name) {
  const ext = (storagePath.match(IMG)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
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
await mkdir(join(ROOT, 'game'), { recursive: true });
for (const table of TABLES) {
  const r = await fetch(`${URL_}/rest/v1/${table}?select=*&limit=2000`, { headers });
  if (!r.ok) continue;
  const list = await r.json();
  await writeFile(join(ROOT, 'game', `${table}.json`), JSON.stringify(list, null, 1));
  if (!list.length) { console.log(`${table}: 0 rows`); continue; }
  const cols = Object.keys(list[0]).filter((c) => list.some((x) => typeof x[c] === 'string' && IMG.test(x[c])));
  const use = cols.filter((c) => !BIG.test(c));
  console.log(`${table}: ${list.length} rows${use.length ? `, icons: ${use.join(', ')}` : ''}`);
  for (const x of list) {
    const base = clean(x.name ?? x.label ?? x.title ?? x.id);
    for (const c of use) {
      if (typeof x[c] !== 'string' || !IMG.test(x[c])) continue;
      await fetchFile(x[c], join(ROOT, 'references/icons', table), use.length > 1 ? `${base} (${c.replace(/_?(path|png|svg)$/g, '').replace(/_/g, ' ')})` : base);
    }
  }
}
console.log(`Done: ${saved} icons saved, ${skipped} already there, ${failed} missing. Data in ${join(ROOT, 'game')}.`);
