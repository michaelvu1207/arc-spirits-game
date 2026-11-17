// Niji Batch — local server. It sends each job to Niji immediately; Niji does the queueing. Start: npm start, then open http://127.0.0.1:8787
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zlibConst } from 'node:zlib';
import { extname, join, normalize, basename, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as niji from './niji.mjs';
import { expand, MAX_JOBS } from './public/expand.js';
import * as workspace from './workspace.mjs';
import { routes as exportRoutes } from './exports.mjs';
import * as remote from './remote.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const STATE_FILE = join(ROOT, 'queue.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
// This machine's tailnet name, when `tailscale serve` shares the editor (it proxies https to 127.0.0.1).
const TAILNET_HOST = (process.env.NIJI_TAILNET_HOST || '').toLowerCase();

// Roles. Default: this computer does all. Worker (NIJI_WORKER=1): runs the queue and talks to Niji, but writes no images;
// it keeps the finished jobs until a client takes their images. Client (NIJI_REMOTE=<ssh host>, --remote <host>, or
// NIJI_REMOTE_URL): keeps the page, the workspace files, pins and tags here, and lets a worker run the queue.
const WORKER = /^(1|true|yes)$/i.test(process.env.NIJI_WORKER ?? '');
const argAt = process.argv.indexOf('--remote');
const REMOTE_HOST = process.env.NIJI_REMOTE || (argAt >= 2 ? process.argv[argAt + 1] : '');
const REMOTE_URL = process.env.NIJI_REMOTE_URL || (REMOTE_HOST ? 'http://127.0.0.1:8788' : '');
const CLIENT = Boolean(REMOTE_URL);
if (WORKER && CLIENT) {
  console.error('A server is a worker or a client, not both. Set NIJI_WORKER or NIJI_REMOTE, not the two.');
  process.exit(1);
}
const IMAGE_STUB = process.env.NIJI_IMAGE_STUB; // tests only: /api/image serves this file and does not download

// ---------- state ----------
const state = {
  settings: { mode: 'fast' },
  jobs: [], // jobs that are in work or failed (a completed job is removed): { id, prompt, status, jobId, error, width, height, batch, createdAt, sentAt, doneAt, seenInQueue }
  link: { ok: false, error: 'Not checked yet' },
  done: [], // the last completed jobs, newest first: { id, folder, prompt, doneAt }; on a worker also { jobId, batch, saved }
  ...(CLIENT ? { remote: true } : {}),
};
// A client shows the state of its worker and keeps no queue of its own.
if (!CLIENT && existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (saved.settings?.mode) state.settings.mode = saved.settings.mode;
    state.jobs = saved.jobs ?? [];
    state.done = saved.done ?? [];
    // A job that was in transit when the server stopped has an unknown result.
    // A job that was saving goes back to "running": the next tick starts the download again.
    for (const j of state.jobs) if (j.status === 'saving') Object.assign(j, { status: 'running', seenInQueue: true });
    // A job that waited for its turn goes on waiting after a restart (see `resumeWaiting` below).
    for (const j of state.jobs) if (j.status === 'pending') j.status = 'sending';
  } catch (e) {
    console.error('Could not read queue.json:', e.message);
  }
}

let saveTimer = null;
function saveNow() { if (!CLIENT) { try { writeFileSync(STATE_FILE, JSON.stringify({ settings: state.settings, jobs: state.jobs, done: state.done })); } catch {} } }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveNow(); process.exit(0); });
function save() {
  if (CLIENT) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = STATE_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify({ settings: state.settings, jobs: state.jobs, done: state.done }));
    await rename(tmp, STATE_FILE);
  }, 300);
}

const clients = new Set();
function publish() {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(data);
  save();
}

// ---------- engine ----------
let busy = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The done list keeps each entry that a client did not save yet, and the last 300 saved ones.
const keepDone = (list) => { let n = 0; return list.filter((d) => d.saved === false || n++ < 300); };

/** Downloads all images of a completed job into its folder, then removes the job from the list. */
async function saveToFolder(j) {
  if (WORKER) {
    // The images go to the client computer: it gets them through /api/image and then sends /api/ack.
    state.jobs = state.jobs.filter((x) => x !== j);
    state.done = keepDone([{ id: j.id, folder: j.folder, prompt: j.prompt, label: j.label, jobId: j.jobId, batch: j.batch ?? 4, doneAt: Date.now(), saved: false }, ...state.done]);
    niji.invalidateHistory();
    return publish();
  }
  j.status = 'saving';
  publish();
  try {
    for (let i = 0; i < (j.batch ?? 4); i++) {
      for (let attempt = 1; ; attempt++) {
        try {
          await workspace.saveImage({ path: j.folder, jobId: j.jobId, index: i, prompt: workspace.promptText(j.prompt), fullPrompt: j.prompt, label: j.label });
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          await sleep(3000);
        }
      }
    }
    state.jobs = state.jobs.filter((x) => x !== j);
    // The Queue popup lists the last completed jobs.
    state.done = keepDone([{ id: j.id, folder: j.folder, prompt: j.prompt, doneAt: Date.now() }, ...(state.done ?? [])]);
    niji.invalidateHistory();
  } catch (e) {
    Object.assign(j, { status: 'failed', saveFailed: true, error: `Niji completed the job, but the images did not download: ${e.message}` });
  }
  publish();
}
// Jobs (and done entries) follow their folder when it is renamed or moved.
const under = (folder, base) => folder != null && (folder === base || folder.startsWith(base + '/'));
function refolder(from, to) {
  for (const j of [...state.jobs, ...state.done]) if (under(j.folder, from)) j.folder = to + j.folder.slice(from.length);
}
// On a worker a folder is only a name: the files are on the client computer.
const folderName = (p) => posix.normalize(`/${p}`).slice(1).replace(/\/$/, '');

/** Submits one job to Niji. */
async function submit(j) {
  try {
    let r;
    try { r = j.action ? await sendAction(j) : await niji.submit(j.prompt, { mode: j.mode, counts: j.counts }); }
    catch (e) {
      // No Fast time left: the job goes again in Relax, and Relax becomes the speed for all jobs after it.
      if (!/out of credits|fast time/i.test(e.message) || j.mode !== 'fast') throw e;
      j.mode = state.settings.mode = 'relax';
      for (const x of state.jobs) if (x.status === 'sending') x.mode = 'relax';
      r = j.action ? await sendAction(j) : await niji.submit(j.prompt, { mode: j.mode, counts: j.counts });
    }
    Object.assign(j, {
      status: 'running',
      jobId: r.job_id,
      prompt: j.action ? j.prompt : r.prompt ?? j.prompt, // an action keeps the prompt of its source image
      width: r.meta?.width,
      height: r.meta?.height,
      batch: j.action?.batch ?? r.meta?.batch_size ?? 4,
      sentAt: Date.now(),
      seenInQueue: Boolean(r.is_queued),
    });
    state.link = { ok: true };
  } catch (e) {
    Object.assign(j, { status: 'failed', error: e.message });
  }
  publish();
}
// The next waiting job: the ones moved to the top first (the latest move first), then in the sequence in which they were made.
const nextWaiting = () => state.jobs.filter((x) => x.status === 'sending').sort((a, b) => (b.top ?? 0) - (a.top ?? 0) || a.createdAt - b.createdAt)[0];
const inFlight = () => state.jobs.filter((x) => ['running', 'saving'].includes(x.status)).length;
// Human pace (2026-11-06, after a 1-day block for scripting). The limit of jobs in flight is picked again
// for each send (1 to 4, most often 2 or 3), the pause before a send is random (2 s to 25 s), and now and then
// there is a longer break (about one send in ten: 30 s to 2 min), like a person who looks at the results.
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (nextWaiting()) {
      const limit = [1, 2, 2, 3, 3, 4][Math.floor(Math.random() * 6)];
      while (inFlight() >= limit && nextWaiting()) await sleep(3000 + Math.random() * 5000);
      await sleep(Math.random() < 0.1 ? 30000 + Math.random() * 90000 : 2000 + Math.random() * 23000);
      const j = nextWaiting(); // picked after the pause, so a job moved to the top goes first
      if (j) await submit(j);
    }
  } finally { pumping = false; }
}
function resumeWaiting() { pump(); }
function add(job) {
  const j = { id: randomUUID(), status: 'sending', createdAt: Date.now(), ...job };
  state.jobs.push(j);
  pump();
}

/** Looks for completed jobs and saves their images. */
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const live = state.jobs.filter((j) => j.status === 'running');
    if (!live.length) return;
    // Niji says when a job is completed. A job can wait a long time on Niji when many jobs are sent together.
    const status = await niji.jobStatus(live.map((j) => j.jobId));
    state.link = { ok: true };
    for (const j of live) {
      const st = status.get(j.jobId);
      if (st === 'completed') {
        if (j.folder) saveToFolder(j);
        else state.jobs = state.jobs.filter((x) => x !== j);
      } else if (/fail|error|cancel|reject|moderat/i.test(st ?? '')) Object.assign(j, { status: 'failed', error: `Niji reported: ${st}` });
      else if (Date.now() - j.sentAt > 30 * 60_000) Object.assign(j, { status: 'failed', saveFailed: true, error: 'Niji did not complete the job in 30 minutes. Retry looks for the images again.' });
    }
    publish();
  } catch (e) {
    if (state.link.error !== e.message) {
      state.link = { ok: false, error: e.message };
      publish();
    }
  } finally {
    busy = false;
  }
}
if (!CLIENT) setInterval(tick, 2000);

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function readBody(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 40_000_000) throw new Error('Body too large');
  }
  return s ? JSON.parse(s) : {};
}

/**
 * Sends text (a page or JSON) so that a slow link carries as little as possible:
 * - compressed (Brotli, or gzip) when the browser accepts it;
 * - with an ETag on GET, so a second visit gets "304 Not Modified" with no body.
 * The browser asks again each time (`no-cache`), so it never shows old data.
 */
function sendText(res, code, type, body) {
  const req = res.req;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'content-type': type, vary: 'accept-encoding' };
  if (code === 200 && req?.method === 'GET') {
    headers.etag = `W/"${createHash('sha1').update(buf).digest('base64url').slice(0, 22)}"`;
    headers['cache-control'] = 'private, no-cache';
    if (req.headers['if-none-match'] === headers.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  const accept = String(req?.headers['accept-encoding'] ?? '');
  let out = buf;
  if (buf.length > 1024) {
    if (/\bbr\b/.test(accept)) {
      out = brotliCompressSync(buf, { params: { [zlibConst.BROTLI_PARAM_QUALITY]: 5 } });
      headers['content-encoding'] = 'br';
    } else if (/\bgzip\b/.test(accept)) {
      out = gzipSync(buf, { level: 6 });
      headers['content-encoding'] = 'gzip';
    }
  }
  headers['content-length'] = out.length;
  res.writeHead(code, headers);
  res.end(out);
}

const json = (res, code, obj) => sendText(res, code, 'application/json', JSON.stringify(obj));

// Actions on one generated image. The request formats come from the Niji web app.
const ACTIONS = {
  zoom15: { label: 'Zoom out 1.5x', zoom: 1.5 }, zoom2: { label: 'Zoom out 2x', zoom: 2 },
  panLeft: { label: 'Pan left', dir: 3 }, panRight: { label: 'Pan right', dir: 1 }, panUp: { label: 'Pan up', dir: 2 }, panDown: { label: 'Pan down', dir: 0 },
  upSubtle: { label: 'Upscale (subtle)', up: 'subtle' }, upCreative: { label: 'Upscale (creative)', up: 'creative' },
  // Request shapes read from the Niji web app bundle (2026-11-07): vary, remix, enhance, reroll, retexture.
  varySubtle: { label: 'Vary (subtle)', vary: false }, varyStrong: { label: 'Vary (strong)', vary: true },
  remix: { label: 'Remix', remix: true }, rerun: { label: 'Rerun', rerun: true },
  enhance: { label: 'Enhance', enhance: true }, retexture: { label: 'Retexture', retexture: true },
};
const PAN_FRACTION = 0.5; // the web app adds 50% in the pan direction
const splitFlags = (p) => { const at = p.search(/(^|\s)--[a-z]/i); return at < 0 ? { body: p.trim(), flags: [] } : { body: p.slice(0, at).trim(), flags: p.slice(at).trim().split(/\s+(?=--[a-z])/i) }; };
const flagName = (f) => f.split(/\s+/)[0].slice(2).toLowerCase();

/** Sends an action job (zoom out, pan, upscale). Returns the Niji response for the new job. */
async function sendAction(j) {
  const a = j.action, opts = { mode: j.mode, counts: a.counts ?? {} };
  if (a.body) return niji.submitBody(a.body, opts);
  // 8.x zoom out and pan: a larger canvas with the image on it, sent as an edit reference.
  const pad = await niji.padAndUpload(a.pad.imageUrl, a.pad.act, a.pad.hd);
  const { body, flags } = splitFlags(j.prompt);
  const drop = ['ar', 'aspect', 'seed', 'stop', 'q', 'quality', 'tile', 'draft', 'bs', 'edit', 'ev', 'v', 'version'];
  const text = body.replace(/https?:\/\/\S+/g, '').trim() ? body : `${body} ${a.pad.act.kind === 'zoom' ? 'zoom out' : a.label.toLowerCase()}`.trim();
  const prompt = [text, ...flags.filter((f) => !drop.includes(flagName(f))), `--ar ${pad.ratio.w}:${pad.ratio.h}`, `--edit ${pad.url}`, `--v ${a.pad.version}`].join(' ');
  return niji.submitBody({ t: 'edit_diffusion', prompt, editorPageRequest: true, parentJob: null, imageWasEdited: pad.edited ? true : null }, opts);
}

const routes = {
  async 'POST /api/action'(body) {
    const act = ACTIONS[body.action];
    if (!act) return [400, { error: 'Unknown action.' }];
    // A client sends the prompt from its own file (null if the file has none): the file is not on this computer.
    const given = 'prompt' in body;
    const m = basename(String(body.path ?? '')).match(/-([0-9a-f]{8})-(\d+)\.png$/);
    if (!m || (!given && !existsSync(workspace.safe(body.path ?? '')))) return [400, { error: 'This works only on images that this app generated.' }];
    const job = await niji.findJob(m[1]);
    // An image from another account (or one Niji forgot): the 8.x zoom and pan work from the pixels alone, so upload the file instead.
    let foreign = null;
    if (!job) {
      foreign = body.imageUrl ?? (given ? null : (await workspace.uploadCached(workspace.safe(body.path)).catch(() => null))?.url) ?? null;
      if (!foreign) return [400, { error: 'Niji does not list the job of this image any more.' }];
    }
    const prompt = (given ? body.prompt : await workspace.readPrompt(workspace.safe(body.path))) ?? job?.full_command;
    if (!prompt) return [400, { error: 'The prompt of this image is not known.' }];
    const version = /(^|\s)--niji 7\b/i.test(prompt) ? 'niji 7' : /(^|\s)--v(ersion)? 8\.2\b/i.test(prompt) ? '8.2' : null;
    if (!version) return [400, { error: 'Actions work only on Niji 7 and 8.2 images.' }];
    const flags = splitFlags(prompt).flags.map(flagName), isUp = /upsample|upscale/.test(job?.event_type ?? '');
    let id = job?.id, index = Number(m[2]), action;
    if (foreign && !act.retexture && (act.up || act.vary || act.remix || act.rerun || act.enhance || version === 'niji 7')) return [400, { error: 'Niji does not list the job of this image: only retexture, and zoom and pan of 8.2 images, work from the file.' }];
    const hd = flags.includes('hd'), hdFlags = { v8_1_hd: null, v8_2_hd: version === '8.2' && hd ? true : null };
    const newPrompt = typeof body.newPrompt === 'string' && body.newPrompt.trim() ? body.newPrompt.trim() : null;
    // A new text keeps the flags of the original prompt (unless the text brings its own flags).
    const withFlags = (text) => (/(^|\s)--[a-z]/i.test(text) ? text : [text, ...splitFlags(prompt).flags].join(' '));
    if (act.vary) {
      if (isUp) return [400, { error: 'Vary works on grid images, not on an upscale.' }];
      action = { label: act.label, body: { t: 'vary', strong: act.vary === true, ...hdFlags, id, index } };
    } else if (act.remix) {
      if (!newPrompt) return [400, { error: 'Remix needs a new prompt.' }];
      action = { label: act.label, body: { t: 'remix', strong: body.strong === true, newPrompt: withFlags(newPrompt), id, index } };
    } else if (act.rerun) {
      action = { label: act.label, body: { t: 'reroll', newPrompt: newPrompt ? withFlags(newPrompt) : prompt, id } };
    } else if (act.enhance) {
      if (version !== '8.2') return [400, { error: 'Enhance works on 8.2 images only.' }];
      action = { label: act.label, batch: 1, body: { t: 'enhance', ...hdFlags, id, index } };
    } else if (act.retexture) {
      // Retexture (shape from the Niji bundle): t:'retexture' with the image as the IMAGE PROMPT of the string, Niji 7. Same drawing, new surface from the text.
      const drop = ['edit', 'ev', 'v', 'version', 'niji', 'draft', 'hd', 'oref', 'ow'];
      const base = newPrompt ?? splitFlags(prompt).body.replace(/https?:\/\/\S+/g, '').trim();
      const { body: text, flags: own } = splitFlags(withFlags(base));
      const url = foreign ?? `https://cdn.midjourney.com/${id}/0_${index}.png`;
      action = { label: act.label, counts: { imagePrompts: 1, imageReferences: Math.max(0, (own.find((f) => flagName(f) === 'sref') ?? '').split(/\s+/).length - 1) }, body: { t: 'retexture', prompt: [url, text, ...own.filter((f) => !drop.includes(flagName(f))), '--niji 7'].join(' ') } };
    } else if (act.up) {
      if (isUp) return [400, { error: 'This image is already an upscale.' }];
      if (flags.includes('hd') || flags.includes('draft')) return [400, { error: 'Niji has no upscale for HD or Draft images.' }];
      action = { label: act.label, batch: 1, body: { t: 'upscale', type: `${version === 'niji 7' ? 'v7' : 'v8r2'}_2x_${act.up}`, id, index } };
    } else if (version === 'niji 7') {
      action = act.zoom
        ? { label: act.label, body: { t: 'outpaint', newPrompt: prompt, zoomFactor: Math.round(50 + (100 - (act.zoom - 1) * 100) / 2), id, index } }
        : { label: act.label, body: { t: 'pan', newPrompt: prompt, direction: act.dir, fraction: PAN_FRACTION, stitch: true, id, index } };
    } else {
      action = { label: act.label, pad: { version, hd: flags.includes('hd'), imageUrl: foreign ?? `https://cdn.midjourney.com/${id}/0_${index}.png`, act: act.zoom ? { kind: 'zoom', factor: act.zoom } : { kind: 'pan', direction: act.dir, fraction: PAN_FRACTION } } };
    }
    const folder = WORKER ? folderName(dirname(String(body.path))) : await workspace.checkFolder(dirname(String(body.path)));
    add({ prompt, mode: state.settings.mode, counts: {}, folder, action, label: act.label });
    return [200, { label: act.label }];
  },
  async 'POST /api/enqueue'(body) {
    const prompts = expand(body);
    if (!prompts.length) return [400, { error: 'No prompts.' }];
    if (prompts.length > MAX_JOBS) return [400, { error: `${prompts.length} jobs is more than the limit of ${MAX_JOBS} for each batch.` }];
    const mode = ['fast', 'relax', 'turbo'].includes(body.mode) ? body.mode : state.settings.mode;
    const counts = { imagePrompts: Number(body.counts?.imagePrompts) || 0, imageReferences: Number(body.counts?.imageReferences) || 0 };
    // A job with a folder saves its images there when it is done.
    const folder = body.folder == null ? undefined : WORKER ? folderName(body.folder) : await workspace.checkFolder(body.folder);
    const top = body.top ? Date.now() : undefined;
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 40) : undefined;
    for (const prompt of prompts) add({ prompt, mode, counts, folder, top, label });
    return [200, { added: prompts.length }];
  },
  async 'POST /api/settings'(body) {
    // The speed applies to the jobs that still wait, too.
    // With `folder`, only the waiting jobs in that folder (or below it) change; the default speed stays.
    if (['fast', 'relax', 'turbo'].includes(body.mode)) {
      const folder = typeof body.folder === 'string' ? body.folder.replace(/\/$/, '') : null;
      if (!folder) state.settings.mode = body.mode;
      for (const j of state.jobs) if (j.status === 'sending' && (!folder || j.folder === folder || j.folder.startsWith(folder + '/'))) j.mode = body.mode;
    }
    return [200, {}];
  },
  async 'POST /api/retry'(body) {
    const j = state.jobs.find((x) => x.id === body.id && x.status === 'failed');
    if (!j) return [404, { error: 'Job not found.' }];
    // A worker downloads nothing: it asks Niji again whether the job is completed (for 30 more minutes).
    if (j.saveFailed && j.jobId && WORKER) Object.assign(j, { status: 'running', sentAt: Date.now(), error: undefined, saveFailed: undefined });
    else if (j.saveFailed && j.jobId) saveToFolder(Object.assign(j, { error: undefined, saveFailed: undefined }));
    else { Object.assign(j, { status: 'sending', error: undefined, createdAt: Date.now() }); pump(); }
    return [200, {}];
  },
  async 'POST /api/top'(body) {
    // Moves a waiting job to the top of the waiting list.
    const j = state.jobs.find((x) => x.id === body.id && x.status === 'sending');
    if (!j) return [404, { error: 'Job not found.' }];
    j.top = Date.now(); publish();
    return [200, {}];
  },
  async 'POST /api/remove'(body) {
    state.jobs = state.jobs.filter((x) => x.id !== body.id);
    publish(); // saved at once: a restart must not bring a removed job back
    return [200, {}];
  },
  async 'POST /api/clear'() {
    // Removes failed entries from this list only. It does not cancel or delete jobs on Niji.
    state.jobs = state.jobs.filter((x) => x.status !== 'failed');
    publish();
    return [200, {}];
  },
  async 'GET /api/history'(_, url) {
    const list = await niji.history();
    // ?types=1 (for a client): also the job type of each id, for the labels "Upscale", "Pan", ...
    return [200, url.searchParams.has('types') ? { list, types: [...niji.jobTypes()] } : list];
  },
  async 'GET /api/library'() {
    return [200, await niji.library()];
  },
  async 'GET /api/moodboards'() {
    return [200, await niji.moodboards()];
  },
  async 'POST /api/upload'(body) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(body.type ?? '') || typeof body.base64 !== 'string') return [400, { error: 'Only PNG, JPEG, WebP or GIF images.' }];
    return [200, await niji.upload({ name: String(body.name || 'image').slice(0, 120), type: body.type, base64: body.base64 })];
  },
  async 'POST /api/check'() {
    try {
      await niji.userQueue();
      state.link = { ok: true };
    } catch (e) {
      state.link = { ok: false, error: e.message };
    }
    return [200, state.link];
  },
  // ---- for a client (see remote.mjs) ----
  async 'GET /api/state'() {
    return [200, state];
  },
  /** The client saved the images of these done entries. */
  async 'POST /api/ack'(body) {
    const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
    for (const d of state.done) if (ids.has(d.id)) d.saved = true;
    state.done = keepDone(state.done);
    return [200, {}];
  },
  /** A folder was renamed or moved on the client computer. */
  async 'POST /api/refolder'(body) {
    if (typeof body.from !== 'string' || !body.from || typeof body.to !== 'string' || !body.to) return [400, { error: 'Give from and to.' }];
    refolder(body.from, body.to);
    return [200, {}];
  },
};
// A client sends the queue routes to its worker.
// NIJI_REMOTE_URL (for tests) goes to a worker directly, without the SSH tunnel.
if (CLIENT) Object.assign(routes, remote.start({ state, publish, url: REMOTE_URL, tunnel: process.env.NIJI_REMOTE_URL ? null : REMOTE_HOST }));

/** One result image of a Niji job, for a client: GET /api/image?jobId=&index= */
async function serveImage(url, res) {
  const jobId = url.searchParams.get('jobId') ?? '', index = url.searchParams.get('index') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(jobId) || !/^\d{1,2}$/.test(index) || Number(index) >= 16) return json(res, 400, { error: 'Invalid image.' });
  let data;
  try {
    data = IMAGE_STUB ? await readFile(IMAGE_STUB) : await workspace.downloadImage(jobId, Number(index));
  } catch (e) {
    return json(res, 404, { error: `The image did not download: ${e.message}` });
  }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this page may call the server: block requests from other web sites.
    const origin = req.headers.origin;
    const host = req.headers.host ?? '';
    // Also allowed: this laptop's tailnet name, which `tailscale serve` proxies over https to 127.0.0.1.
    const local = /^(127\.0\.0\.1|localhost):\d+$/.test(host);
    const tailnet = !!TAILNET_HOST && host.replace(/:\d+$/, '') === TAILNET_HOST;
    if (!(local || tailnet) || (origin && origin !== `http://${host}` && !(tailnet && origin === `https://${host}`))) {
      return json(res, 403, { error: 'Forbidden' });
    }
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ws/file') return await workspace.serveFile(url, res);
    if (req.method === 'GET' && url.pathname === '/api/image' && !CLIENT) return await serveImage(url, res);

    const handler = routes[`${req.method} ${url.pathname}`] ?? workspace.routes[`${req.method} ${url.pathname}`] ?? exportRoutes[`${req.method} ${url.pathname}`];
    if (handler) {
      const [code, out] = await handler(req.method === 'POST' ? await readBody(req) : {}, url);
      if (out?.movedFolder) {
        const { from, to } = out.movedFolder;
        if (CLIENT) remote.moved(from, to); // the worker has the jobs; it gets /api/refolder
        else refolder(from, to);
        publish();
      }
      if (req.method === 'POST' && !url.pathname.startsWith('/api/ws/') && !url.pathname.startsWith('/api/saved')) publish();
      return json(res, code, out);
    }

    if (req.method === 'GET') {
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
      try {
        const data = await readFile(file);
        return sendText(res, 200, MIME[extname(file)] ?? 'application/octet-stream', data);
      } catch {
        return json(res, 404, { error: 'Not found' });
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Niji Batch${WORKER ? ' (worker)' : CLIENT ? ` (client of ${REMOTE_HOST || REMOTE_URL})` : ''}: http://${HOST}:${PORT}`);
  if (CLIENT) return; // no Chrome and no dispatcher here: the worker does that
  routes['POST /api/check']().then(() => {
    console.log(state.link.ok ? 'Connected to Niji through Chrome.' : `Not connected: ${state.link.error}`);
    publish();
    resumeWaiting();
  });
});
