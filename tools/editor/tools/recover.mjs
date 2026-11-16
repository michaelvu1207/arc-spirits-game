// Saves the images of completed Niji jobs that are not in the workspace yet (for jobs whose download failed).
// Usage: node tools/recover.mjs [--since <ISO time>] [--dry]
// A job goes to the folder of the guardian that its prompt names.
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as niji from '../niji.mjs';
import * as workspace from '../workspace.mjs';

const ROOT = process.env.NIJI_WORKSPACE || join(homedir(), 'ArcSpiritsArt');
const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const since = new Date(arg('--since') ?? Date.now() - 3 * 3600_000), dry = process.argv.includes('--dry');
const have = new Set();
(function walk(d) { for (const n of readdirSync(d)) { if (n === '.thumbs') continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else { const m = n.match(/-([0-9a-f]{8})-\d+\.png$/); if (m) have.add(m[1]); } } })(ROOT);
// The start of each guardian guide, and the place line of each background, name the guardian.
const G = join(ROOT, 'assets/guardians'), keys = [];
for (const g of readdirSync(G)) if (existsSync(join(G, g, 'guide.txt'))) keys.push([`${g}, guardian of`, g]);
const PLACES = { Embers: 'volcano', Myrtle: 'giant old trees', Taron: 'harbor town', Petra: 'mining village', Pixia: 'hidden glade', Lumina: 'temple city', Nox: 'indigo city', Eclipse: 'ruined observatory', Pip: 'roadside camp' };
const promptText = (p) => p.replace(/https?:\/\/\S+/g, '').replace(/\s--[a-z].*$/, '').trim();

const uid = await niji.getUserId();
const { json } = await niji.api(`/api/imagine?user_id=${uid}&page_size=200`);
for (const j of json.data) {
  if (new Date(j.enqueue_time) < since || have.has(j.id.slice(0, 8)) || j.event_type !== 'diffusion' || !j.full_command) continue;
  const p = j.full_command, bg = p.startsWith('wide scenic');
  const name = bg ? Object.keys(PLACES).find((g) => p.includes(PLACES[g])) : keys.find(([k]) => p.includes(k))?.[1];
  if (!name) { console.log('no folder for', j.id.slice(0, 8), p.slice(0, 60)); continue; }
  const folder = `assets/guardians/${name}/${bg ? 'background' : 'character design'}`;
  console.log(dry ? 'would save' : 'save', j.id.slice(0, 8), `${j.width}x${j.height}`, folder);
  if (dry) continue;
  try { for (let i = 0; i < (j.batch_size ?? 4); i++) await workspace.saveImage({ path: folder, jobId: j.id, index: i, prompt: promptText(p), fullPrompt: p }); }
  catch (e) { console.log('  failed:', e.message); }
}
process.exit(0);
