// One-time (Michael, 2026-11-09): local copies of what the hex spirit creator needs.
//  - class icons missing locally (by id, from the repo backup; storage as fallback), saved under the LOCAL class name
//  - rune icons (800px, background composed) -> references/icons/runes/<Rune name>.png
//  - fonts -> references/fonts
//  - the live front-base / back-base of each hex spirit -> references/hex_bases/<Spirit name>/{front-base,back-base}.png
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path'; import { homedir } from 'node:os';
const H = homedir(), ROOT = join(H, 'ArcSpiritsArt'), REPO = join(H, 'Documents/Programming/ArcSpirits/products/game-data-backend');
const BK = join(REPO, 'exports/spirit-migration-2026-10-15/backup-assets');
const env = Object.fromEntries(readFileSync(join(REPO, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const game = (t) => JSON.parse(readFileSync(join(ROOT, 'game', `${t}.json`), 'utf8'));
const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim();
async function fetchStorage(path) {
  const p = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const r = await fetch(`${env.PUBLIC_SUPABASE_URL}/storage/v1/object/public/game_assets/${p}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return Buffer.from(await r.arrayBuffer());
}
const miss = [];
// 1. class icons
const CDIR = join(ROOT, 'references/icons/classes');
let n = 0;
for (const c of game('classes')) {
  if (!c.icon_png) continue;
  const out = join(CDIR, `${clean(c.name)} (icon).png`); if (existsSync(out)) continue;
  const local = join(BK, c.icon_png.replace(/^class_icons\//, 'class_icons/'));
  try { const buf = existsSync(local) ? readFileSync(local) : await fetchStorage(c.icon_png); writeFileSync(out, buf); n++; } catch (e) { miss.push(`class ${c.name}: ${e.message}`); }
}
console.log('class icons added', n);
// 2. rune icons (ids from the live mat_items snapshot the runes table was seeded from: runes.json ids are mat_items ids)
const RDIR = join(ROOT, 'references/icons/runes'); mkdirSync(RDIR, { recursive: true }); n = 0;
for (const r of game('runes')) {
  const out = join(RDIR, `${clean(r.name)}.png`); if (existsSync(out)) continue;
  const local = join(BK, 'runes', r.id, 'icon.png');
  try { const buf = existsSync(local) ? readFileSync(local) : await fetchStorage(`runes/${r.id}/icon.png`); writeFileSync(out, buf); n++; } catch (e) { miss.push(`rune ${r.name}: ${e.message}`); }
}
console.log('rune icons added', n);
// 3. fonts
const FDIR = join(ROOT, 'references/fonts'); mkdirSync(FDIR, { recursive: true });
for (const f of readdirSync(join(REPO, 'static/fonts'))) if (!existsSync(join(FDIR, f))) copyFileSync(join(REPO, 'static/fonts', f), join(FDIR, f));
// 4. bases
const names = JSON.parse(readFileSync(join(H, 'niji-batch/spirit-names.json'), 'utf8'));
const origins = Object.fromEntries(game('origins').map((o) => [o.id, o.name]));
const BDIR = join(ROOT, 'references/hex_bases'); n = 0;
for (const s of game('hex_spirits')) {
  const origin = origins[s.traits?.origin_ids?.[0]] ?? 'Heroes';
  const name = names[`${origin}/${s.name}`] ?? names[`Arcane Spirits/${s.name}`] ?? s.name;
  const dir = join(BDIR, clean(name)); mkdirSync(dir, { recursive: true });
  for (const [k, p] of [['front-base', s.game_print_no_icons_path], ['back-base', s.back_side_base]]) {
    const out = join(dir, `${k}.png`); if (existsSync(out) || !p) { if (!p) miss.push(`${name}: no ${k}`); continue; }
    try { writeFileSync(out, await fetchStorage(p.startsWith('hex_spirits/') ? p : `hex_spirits/${p}`)); n++; } catch (e) { miss.push(`${name} ${k}: ${e.message}`); }
  }
  writeFileSync(join(dir, 'spirit.json'), JSON.stringify({ id: s.id, dbName: s.name, name, origin }, null, 1));
}
console.log('bases downloaded', n, miss.length ? '\nMISSING:\n' + miss.join('\n') : '');
