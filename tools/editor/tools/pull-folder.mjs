// Downloads all images of a Niji folder into a workspace folder.
// Usage: node tools/pull-folder.mjs <niji folder title> <workspace-relative folder>
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as niji from '../niji.mjs';
import { ROOT } from '../workspace.mjs';

const [title, dest] = process.argv.slice(2);
const { json } = await niji.api('/api/folders');
const folder = json.find((f) => f.title === title);
if (!folder) throw new Error(`No Niji folder "${title}". Found: ${json.map((f) => f.title).join(', ')}`);
const dir = join(ROOT, dest);
await mkdir(dir, { recursive: true });
let saved = 0, skipped = 0, failed = 0;
for (const { id, index } of folder.images) {
  const file = join(dir, `${title}-${id.slice(0, 8)}-${index}.png`);
  if (existsSync(file)) { skipped++; continue; }
  try { await writeFile(file, await niji.download(`https://cdn.midjourney.com/${id}/0_${index}.png`)); saved++; }
  catch (e) { failed++; console.warn(`  ${id} ${index}: ${e.message}`); }
}
console.log(`${folder.images.length} in folder: ${saved} saved, ${skipped} already there, ${failed} failed -> ${dir}`);
process.exit(0);
