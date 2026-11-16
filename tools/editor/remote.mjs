// Client role: a worker on another computer runs the queue and talks to Niji, so the queue goes on when this
// computer is off. This side keeps the page, the workspace files, pins and tags, and copies the images of the
// finished jobs from the worker into the workspace. The worker is reached through an SSH tunnel.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import * as workspace from './workspace.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let base = '', state = null, publish = () => {};
let tunnelError = null;

/** Keeps an SSH tunnel to the worker open: local port 8788 goes to the worker's 8787. A new one starts 5 s after it stops. */
function tunnel(host) {
  let ssh, stopping = false;
  const open = () => {
    let err = '', restarted = false;
    ssh = spawn('ssh', ['-N', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-L', '8788:127.0.0.1:8787', host], { stdio: ['ignore', 'ignore', 'pipe'] });
    ssh.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const restart = (why) => {
      if (restarted || stopping) return;
      restarted = true;
      const msg = err.trim().split('\n').at(-1) || why;
      if (msg !== tunnelError) console.log(`SSH tunnel to ${host} stopped: ${msg}. It starts again in 5 s.`);
      tunnelError = msg;
      setTimeout(open, 5000);
    };
    ssh.on('error', (e) => restart(e.message)); // for example: no ssh program
    ssh.on('exit', (code) => restart(`ssh exited with code ${code}`));
  };
  open();
  // The tunnel must not stay open after the server stops.
  const stop = () => { stopping = true; ssh?.kill(); };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(0); });
}

/** Calls the worker. Returns { status, json }, or { status, data } with `raw`. Throws when the worker is not reachable. */
async function call(path, { body, raw = false, timeout = 300_000 } = {}) {
  let r;
  try {
    r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    if (raw) return { status: r.status, data: Buffer.from(await r.arrayBuffer()) };
    return { status: r.status, json: await r.json().catch(() => ({ error: `The worker answered ${r.status}.` })) };
  } catch (e) {
    const why = e.cause?.code ?? e.cause?.message ?? e.message;
    throw new Error(`Remote worker not reachable: ${why}${tunnelError ? ` (SSH tunnel: ${tunnelError})` : ''}`);
  }
}

// ---------- state ----------
let worker = { settings: { mode: 'fast' }, jobs: [], done: [], link: { ok: false, error: 'Not checked yet' } }; // the last state from the worker
let pollError = null; // why the last poll did not get the worker state
const pulling = new Map(); // done id -> entry whose images are being copied now
const pulled = new Set(); // done ids saved here and acknowledged; the worker shows them as saved after its next poll
const fails = new Map(); // done id -> { n, until, error }: failed copy rounds, and when to try again
const refolders = []; // folder moves that the worker did not get yet, oldest first
let lastSig = '';

const unsaved = (d) => d.saved === false && !pulled.has(d.id);
// Jobs and done entries follow a folder that was renamed or moved.
const move = (list, { from, to }) => { for (const j of list) if (j.folder === from || j.folder?.startsWith(from + '/')) j.folder = to + j.folder.slice(from.length); };

/** Gives the page the worker state. A finished job stays in the job list as "saving" until its images are here,
 *  as on a single computer: the page loads the new files when the job leaves the list. */
function show() {
  const stuck = [...fails.values()].find((f) => f.n >= 3); // one failed round is normal; say it only if it goes on
  Object.assign(state, {
    settings: worker.settings,
    jobs: [...worker.jobs, ...worker.done.filter(unsaved).map((d) => ({ id: d.id, folder: d.folder, prompt: d.prompt, label: d.label, status: 'saving', jobId: d.jobId, batch: d.batch, createdAt: d.doneAt, sentAt: d.doneAt }))],
    done: worker.done.filter((d) => !unsaved(d)),
    link: pollError ? { ok: false, error: pollError } : stuck ? { ...worker.link, error: `The images of a finished job did not copy from the worker: ${stuck.error}` } : worker.link,
    remote: true,
  });
  const sig = JSON.stringify(state);
  if (sig !== lastSig) { lastSig = sig; publish(); }
}

async function pollOnce() {
  try {
    while (refolders.length) {
      const r = await call('/api/refolder', { body: refolders[0], timeout: 15_000 });
      if (r.status !== 200) throw new Error(`Remote worker did not take a folder move: ${r.json?.error ?? r.status}`);
      refolders.shift();
    }
    const r = await call('/api/state', { timeout: 15_000 });
    if (r.status !== 200 || !Array.isArray(r.json?.jobs)) throw new Error(`Remote worker answered ${r.status} to /api/state. Is it the new version, started with NIJI_WORKER=1?`);
    worker = { settings: r.json.settings, jobs: r.json.jobs, done: r.json.done ?? [], link: r.json.link };
    for (const m of refolders) move([...worker.jobs, ...worker.done], m); // moves made while this poll was on its way
    if (pollError) console.log('Remote worker reachable.');
    pollError = null;
    // Forget what the worker does not list as unsaved any more.
    const open = new Set(worker.done.filter((d) => d.saved === false).map((d) => d.id));
    for (const id of [...pulled, ...fails.keys()]) if (!open.has(id)) { pulled.delete(id); fails.delete(id); }
  } catch (e) {
    if (e.message !== pollError) console.log(e.message); // log a new problem one time, not on each poll
    pollError = e.message;
  }
  show();
  if (!pollError) pullAll();
}
// One poll at a time. A route that changed the worker adds a poll, so the page shows the change at once.
let chain = Promise.resolve(), queued = 0;
function poll() {
  queued++;
  return (chain = chain.then(pollOnce).catch(() => {}).finally(() => { queued--; }));
}

// ---------- images ----------
/** Starts copying the images of finished jobs, oldest first, at most 2 jobs at a time. */
function pullAll() {
  for (const d of [...worker.done].reverse()) {
    if (pulling.size >= 2) return;
    if (!unsaved(d) || pulling.has(d.id) || (fails.get(d.id)?.until ?? 0) > Date.now()) continue;
    pulling.set(d.id, d);
    pull(d).finally(() => { pulling.delete(d.id); show(); });
  }
}

/** Copies all images of one done entry into its workspace folder, then tells the worker. */
async function pull(d) {
  try {
    for (let i = 0; i < (d.batch ?? 4); i++) {
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await call(`/api/image?jobId=${encodeURIComponent(d.jobId)}&index=${i}`, { raw: true });
          if (r.status !== 200) throw new Error(`image ${i + 1}: ${tryJson(r.data)?.error ?? `the worker answered ${r.status}`}`);
          await mkdir(workspace.safe(d.folder), { recursive: true }); // the folder can be gone here (for example deleted)
          await workspace.saveImageBytes({ path: d.folder, jobId: d.jobId, index: i, prompt: workspace.promptText(d.prompt), fullPrompt: d.prompt, label: d.label, data: r.data });
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          await sleep(3000);
        }
      }
    }
    const r = await call('/api/ack', { body: { ids: [d.id] } });
    if (r.status !== 200) throw new Error(`The worker did not take the acknowledgement: ${r.json?.error ?? r.status}`);
    pulled.add(d.id);
    fails.delete(d.id);
    invalidateHistory(); // the new job is in the Niji history now
  } catch (e) {
    // Try again on the next poll, then less often: a job whose images never come must not keep the worker busy.
    const n = (fails.get(d.id)?.n ?? 0) + 1;
    fails.set(d.id, { n, until: Date.now() + Math.min(300_000, 5000 * 2 ** (n - 1)), error: e.message });
    if (n === 3) console.log(`Images of ${d.folder} did not copy (3 rounds): ${e.message}`);
  }
}
const tryJson = (buf) => { try { return JSON.parse(buf.toString()); } catch { return null; } };

// ---------- history ----------
// The worker has the Niji history. Keep it 10 minutes, like niji.history() does; a copied job makes it new.
let hist = null;
function history() {
  if (hist && Date.now() - hist.at < 600_000) return hist.promise;
  const h = { at: Date.now() };
  h.promise = call('/api/history?types=1', { timeout: 120_000 }).then((r) => {
    if (r.status !== 200 || !Array.isArray(r.json?.list)) throw new Error(r.json?.error ?? `history: ${r.status}`);
    return { list: r.json.list, types: new Map(r.json.types) };
  });
  h.promise.catch(() => { if (hist === h) hist = null; }); // a failed load is tried again next time
  return (hist = h).promise;
}
const invalidateHistory = () => { hist = null; };

// ---------- routes ----------
/** A route that the worker answers. After a POST, the state is polled at once. */
const forward = (key) => {
  const [method, path] = key.split(' ');
  return async (body, url) => {
    try {
      const r = await call(path + (url?.search ?? ''), method === 'POST' ? { body } : {});
      if (method === 'POST') await poll();
      return [r.status, r.json];
    } catch (e) {
      return [502, { error: e.message }];
    }
  };
};
const FORWARD = ['POST /api/enqueue', 'POST /api/settings', 'POST /api/retry', 'POST /api/top', 'POST /api/remove', 'POST /api/clear', 'POST /api/check', 'GET /api/history', 'GET /api/library', 'GET /api/moodboards', 'POST /api/upload'];

/** A folder was renamed or moved here: the jobs and the done entries follow it, here at once and on the worker. */
export function moved(from, to) {
  move([...worker.jobs, ...worker.done, ...pulling.values()], { from, to });
  refolders.push({ from, to });
  show();
  poll();
}

/** Starts the client role. Returns the routes that replace the local queue routes. */
export function start(opts) {
  ({ state, publish } = opts);
  base = opts.url;
  if (opts.tunnel) tunnel(opts.tunnel);
  workspace.setHistorySource(history);
  workspace.setUploader(async (img) => {
    const r = await call('/api/upload', { body: img });
    if (r.status !== 200) throw new Error(r.json?.error ?? `Upload failed (${r.status}).`);
    return r.json;
  });
  setInterval(() => { if (!queued) poll(); }, 2000);
  poll();
  return {
    ...Object.fromEntries(FORWARD.map((k) => [k, forward(k)])),
    // The prompt comes from the local file: the worker does not have the workspace files.
    async 'POST /api/action'(body, url) {
      const abs = workspace.safe(body.path ?? '');
      if (!/-[0-9a-f]{8}-\d+\.png$/.test(basename(abs)) || !existsSync(abs)) return [400, { error: 'This works only on images that this app generated.' }];
      // The image goes along as an upload: an image made on another account is not in the worker's Niji history, and the 8.x zoom/pan only needs the pixels.
      const up = await workspace.uploadCached(abs).catch(() => null);
      return forward('POST /api/action')({ ...body, prompt: await workspace.readPrompt(abs), imageUrl: up?.url ?? null }, url);
    },
  };
}
