// One-time: fetch the class icon files the import skipped (.svg+xml) from storage, save SVG + 256px PNG.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path'; import { homedir } from 'node:os'; import { execFileSync } from 'node:child_process';
const ENV = join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend/.env');
const env = Object.fromEntries(readFileSync(ENV, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const ROOT = join(homedir(), 'ArcSpiritsArt'), DIR = join(ROOT, 'references/icons/classes'), SVG = join(DIR, 'svg');
mkdirSync(SVG, { recursive: true });
const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim();
let ok = 0, miss = [];
for (const c of JSON.parse(readFileSync(join(ROOT, 'game/classes.json'), 'utf8'))) {
  const p = c.icon_png; if (!p || !/svg/.test(p)) continue;
  const out = join(DIR, `${clean(c.name)} (icon).png`); if (existsSync(out)) continue;
  const path = p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  let r = await fetch(`${env.PUBLIC_SUPABASE_URL}/storage/v1/object/public/game_assets/${path}`);
  if (!r.ok) r = await fetch(`${env.PUBLIC_SUPABASE_URL}/storage/v1/object/public/${path}`);
  if (!r.ok) { miss.push(`${c.name}: ${r.status}`); continue; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.subarray(0, 4).toString('latin1') === '\x89PNG') writeFileSync(out, buf);
  else { const svg = join(SVG, `${clean(c.name)}.svg`); writeFileSync(svg, buf); execFileSync('rsvg-convert', ['-w', '256', '-h', '256', '-o', out, svg]); }
  ok++;
}
console.log(`saved ${ok}`, miss.length ? 'missing: ' + miss.join('; ') : '');
