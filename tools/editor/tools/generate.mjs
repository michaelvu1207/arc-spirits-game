// Starts generations through the running Niji Batch server, the same as the Generate panel does.
// The results show in the app, in the folder that you give, and save there.
// Usage:
//   node tools/generate.mjs --folder "assets/character sheets" --prompt "a fox --ar 3:2 --v 8.2" \
//     [--sref <workspace image or folder>]... [--image <workspace image>]... [--count 2] [--mode fast|relax|turbo] [--top]   (default: fast)
// --folder, --sref and --image are paths in the workspace (for example references/style/a.png).
// --count is the number of jobs; each job makes 4 images. Flags (--ar, --v, --niji, --hd …) go in the prompt text.
const BASE = process.env.NIJI_BATCH_URL || 'http://127.0.0.1:8787';
const args = process.argv.slice(2), opt = { sref: [], image: [] };
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, ''), v = args[i + 1];
  if (k === 'top') { opt.top = true; i--; continue; } // a flag without a value
  if (v === undefined || !['folder', 'prompt', 'sref', 'image', 'count', 'mode'].includes(k)) { console.error(`Bad argument: ${args[i]}`); process.exit(1); }
  if (Array.isArray(opt[k])) opt[k].push(v); else opt[k] = v;
}
if (!opt.folder || !opt.prompt) { console.error('Give --folder and --prompt.'); process.exit(1); }
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
};
const attach = async (paths) => (paths.length ? (await post('/api/ws/attach', { paths })).images.map((x) => x.url) : []);
try {
  const parts = opt.folder.split('/'); // makes the folder if it is not there (the parent folder must be there)
  await post('/api/ws/mkdir', { path: parts.slice(0, -1).join('/'), name: parts.at(-1) }).catch(() => {});
  const srefs = await attach(opt.sref), images = await attach(opt.image);
  const r = await post('/api/enqueue', {
    text: opt.prompt.replace(/\s*\n\s*/g, ' '),
    params: srefs.length ? `--sref ${srefs.join(' ')}` : '',
    prefix: images.join(' '),
    repeat: Math.max(1, Math.min(20, Number(opt.count) || 1)),
    mode: opt.mode ?? 'fast', // Michael's choice (2026-11-06): use the Fast hours first; the server falls back to Relax when they are gone
    folder: opt.folder,
    top: opt.top != null, // --top: before the jobs that wait
    counts: { imagePrompts: images.length, imageReferences: srefs.length },
  });
  console.log(`${r.added} job(s) started in ${opt.folder}. ${srefs.length} style reference(s), ${images.length} image prompt(s).`);
} catch (e) { console.error(e.message); process.exit(1); }
