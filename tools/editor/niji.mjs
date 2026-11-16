// Niji Journey API client.
// Requests go through the network stack of the dedicated Chrome (CDP), because
// Cloudflare rejects requests that do not come from the browser. The session
// cookies stay in Chrome; this process never reads or stores them.
import { connect, nijiTarget, browserWsUrl, listTargets } from './cdp.mjs';

const ORIGIN = 'https://nijijourney.com';
let page = null;
let userId = null;

async function getPage() {
  if (page) return page;
  let target = await nijiTarget().catch(() => null);
  if (!target) {
    let browser;
    try {
      browser = await connect(await browserWsUrl());
    } catch {
      throw new Error('Chrome is not running with remote debugging. Start it with: npm run chrome');
    }
    await browser.send('Target.createTarget', { url: `${ORIGIN}/imagine`, background: true });
    browser.close();
    for (let i = 0; i < 20 && !target; i++) {
      await new Promise((r) => setTimeout(r, 500));
      target = await nijiTarget();
    }
    if (!target) throw new Error('Could not open a nijijourney.com tab in Chrome.');
  }
  const p = await connect(target.webSocketDebuggerUrl);
  p.on((method) => {
    if (method === 'Inspector.detached' || method === 'Inspector.targetCrashed') page = null;
  });
  page = p;
  return p;
}

/** Calls a Niji API path. Returns { status, json, text }. */
export async function api(path, { method = 'GET', body } = {}) {
  const init = {
    method,
    headers: { 'x-csrf-protection': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  return run(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify(init)});
    return JSON.stringify({ status: r.status, text: await r.text() });
  })()`);
}

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`Chrome did not answer (${what}).`)), ms))]);
let lastOk = 0;

function dropPage() {
  try { page?.close(); } catch {}
  page = null;
}

async function run(expression, timeout = 60_000) {
  let res;
  try {
    let p = await getPage();
    // The connection to Chrome can die silently (for example after the computer sleeps).
    // If it was idle, test it with a fast ping and connect again if there is no answer.
    if (Date.now() - lastOk > 20_000) {
      try {
        await withTimeout(p.send('Runtime.evaluate', { expression: '1' }), 3000, 'ping');
      } catch {
        dropPage();
        p = await getPage();
      }
    }
    res = await withTimeout(p.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), timeout, 'request');
    lastOk = Date.now();
  } catch (e) {
    dropPage();
    throw e;
  }
  if (res.exceptionDetails) {
    page = null; // the tab probably navigated; attach again on the next call
    throw new Error(`Request failed in Chrome: ${res.exceptionDetails.exception?.description?.split('\n')[0] ?? 'unknown error'}`);
  }
  const { status, text } = JSON.parse(res.result.value);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (status === 401 || (status === 403 && !json)) {
    throw new Error(status === 401 ? 'Not logged in. Log in to nijijourney.com in the dedicated Chrome.' : 'Cloudflare challenge. Open the Niji tab in the dedicated Chrome and complete it.');
  }
  return { status, json, text };
}

export async function getUserId() {
  if (userId) return userId;
  const p = await getPage();
  // The id token cookie is HttpOnly, so read the id from the browser cookie store.
  const { cookies } = await p.send('Network.getCookies', { urls: [ORIGIN] });
  const tok = cookies.find((c) => c.name.endsWith('AuthUserTokenV3_i'))?.value;
  if (!tok) throw new Error('Not logged in. Log in to nijijourney.com in the dedicated Chrome.');
  userId = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).midjourney_id;
  return userId;
}

/** Sends one imagine job. Returns the entry from `success`. Throws on failure. */
export const submit = (prompt, opts) => submitBody({ t: 'imagine', prompt }, opts);

/** Sends one job to Niji. `extra` holds the job type and its fields (for example { t: 'imagine', prompt }). */
export async function submitBody(extra, { mode = 'fast', isPrivate = false, counts = {} } = {}) {
  const uid = await getUserId();
  const { status, json, text } = await api('/api/submit-jobs', {
    method: 'POST',
    body: {
      f: { mode: mode === 'relax' ? 'relaxed' : mode, private: isPrivate }, // Niji's name for Relax is "relaxed"; "relax" gets a 400
      channelId: `singleplayer_${uid}`,
      metadata: { isMobile: null, imagePrompts: counts.imagePrompts ?? 0, imageReferences: counts.imageReferences ?? 0, characterReferences: counts.characterReferences ?? 0, depthReferences: 0, lightboxOpen: null },
      ...extra,
    },
  });
  if (status !== 200 || !json) throw new Error(`submit-jobs returned ${status}: ${text.slice(0, 200)}`);
  if (json.failure?.length) {
    const f = json.failure[0];
    throw new Error(f.message || f.error || f.type || JSON.stringify(f).slice(0, 300));
  }
  const job = json.success?.[0];
  if (!job?.job_id) throw new Error(`Unexpected submit-jobs response: ${text.slice(0, 200)}`);
  return job;
}

const idsOf = (list) => (list ?? []).map((x) => (typeof x === 'string' ? x : x.job_id ?? x.id)).filter(Boolean);

/** Returns the ids of the jobs that Niji is running or holding. */
export async function userQueue() {
  const { status, json, text } = await api('/api/user-queue');
  if (status !== 200 || !json) throw new Error(`user-queue returned ${status}: ${text.slice(0, 120)}`);
  return { running: idsOf(json.running), waiting: idsOf(json.waiting) };
}

const CDN_U = 'https://cdn.midjourney.com/u/';
/** Returns the status that Niji reports for each job id: Map(id -> 'completed' | 'running' | ...). */
export async function jobStatus(ids) {
  if (!ids.length) return new Map();
  const { status, json, text } = await api('/api/job-status', { method: 'POST', body: { jobIds: ids, _frontend_source: 'useJobSubmitter_fetchJobStatus' } });
  if (status !== 200 || !Array.isArray(json)) throw new Error(`job-status returned ${status}: ${String(text).slice(0, 120)}`);
  return new Map(json.map((j) => [j.id, j.current_status]));
}

const toImage = (bucketPathname) => ({
  url: CDN_U + bucketPathname,
  thumb: CDN_U + bucketPathname.replace(/(\.\w+)$/, '_384_N$1'),
});

/** Returns the images that the user uploaded to Niji, newest first. */
export async function library() {
  const { status, json, text } = await api('/api/storage');
  if (status !== 200 || !Array.isArray(json)) throw new Error(`storage returned ${status}: ${text.slice(0, 120)}`);
  return json
    .filter((x) => x.state === 'completed' && !x.hidden && x.bucketPathname)
    .sort((a, b) => b.timeCreated - a.timeCreated)
    .map((x) => toImage(x.bucketPathname));
}

export async function moodboards() {
  const { status, json, text } = await api('/api/moodboards');
  if (status !== 200 || !Array.isArray(json)) throw new Error(`moodboards returned ${status}: ${text.slice(0, 120)}`);
  return json.map((m) => ({ id: m.moodboard_id, title: m.title, images: m.images?.length ?? 0 }));
}

/** Uploads one image to the Niji library. `base64` is the file content. */
export async function upload({ name, type, base64 }) {
  const { status, json, text } = await run(`(async () => {
    const bin = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('file', new File([bin], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    const r = await fetch('/api/storage-upload-file', { method: 'POST', headers: { 'x-csrf-protection': '1' }, body: fd });
    return JSON.stringify({ status: r.status, text: await r.text() });
  })()`, 180_000);
  if (status !== 200 || !json?.bucketPathname) throw new Error(`Upload failed (${status}): ${text.slice(0, 200)}`);
  return toImage(json.bucketPathname);
}

/**
 * Downloads a CDN file through its own background tab. The CDN sometimes answers 403 (Cloudflare) to a request
 * that comes from the Niji page, but it lets a direct visit through; a request from that tab then has its cookies.
 */
async function downloadInTab(url) {
  const browser = await connect(await browserWsUrl());
  let targetId, tab;
  try {
    ({ targetId } = await browser.send('Target.createTarget', { url, background: true }));
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      await new Promise((r) => setTimeout(r, 500));
      target = (await listTargets()).find((t) => t.id === targetId && t.url.startsWith('https://cdn.midjourney.com/'));
    }
    if (!target) throw new Error('Download failed (the image tab did not open).');
    tab = await connect(target.webSocketDebuggerUrl);
    for (let attempt = 0; ; attempt++) {
      const res = await withTimeout(tab.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
        const r = await fetch(${JSON.stringify(url)});
        if (!r.ok) return JSON.stringify({ status: r.status, text: '' });
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return JSON.stringify({ status: 200, text: btoa(bin) });
      })()` }), 180_000, 'download');
      const out = res.exceptionDetails ? { status: 0 } : JSON.parse(res.result.value);
      if (out.status === 200) return Buffer.from(out.text, 'base64');
      if (attempt >= 4) throw new Error(`Download failed (${out.status}).`);
      await new Promise((r) => setTimeout(r, 2000)); // a Cloudflare check can take some seconds
    }
  } finally {
    tab?.close();
    if (targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    browser.close();
  }
}

/** Downloads a file from the Niji CDN through Chrome. Returns a Buffer. */
export async function download(url) {
  try { return await downloadFromPage(url); } catch (e) {
    if (/\(404\)/.test(e.message)) throw e;
    return downloadInTab(url);
  }
}
async function downloadFromPage(url) {
  const { status, text } = await run(`(async () => {
    const r = await fetch(${JSON.stringify(url)});
    if (!r.ok) return JSON.stringify({ status: r.status, text: '' });
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return JSON.stringify({ status: 200, text: btoa(bin) });
  })()`, 180_000);
  if (status !== 200) throw new Error(`Download failed (${status}).`);
  return Buffer.from(text, 'base64');
}

let historyCache = { at: 0, list: [] };
/** Returns the user's past generations, newest first: [{ id, prompt, time, width, height, batch }]. */
export async function history({ fresh = false } = {}) {
  if (!fresh && historyCache.at && Date.now() - historyCache.at < 600_000) return historyCache.list;
  const uid = await getUserId();
  const { status, json, text } = await api(`/api/imagine?user_id=${uid}&page_size=1000`);
  if (status !== 200 || !Array.isArray(json?.data)) throw new Error(`imagine returned ${status}: ${text.slice(0, 120)}`);
  const list = json.data.filter((d) => d.full_command && d.event_type === 'diffusion').map((d) => ({ id: d.id, prompt: d.full_command, time: d.enqueue_time, width: d.width, height: d.height, batch: d.batch_size }));
  historyCache = { at: Date.now(), list, all: json.data };
  return list;
}

/** Makes the next history() call read from Niji again (call it after a job completes). */
export function invalidateHistory() {
  historyCache.at = 0;
}

/** Finds one of the user's jobs (of any type) by the start of its id. Returns the raw Niji record, or null. */
export async function findJob(prefix) {
  for (const fresh of [false, true]) {
    await history({ fresh });
    const hit = (historyCache.all ?? []).find((d) => d.id?.startsWith(prefix));
    if (hit) return hit;
  }
  return null;
}
/** The event type of each known job id (for labels such as "Upscale"). Empty if the history is not loaded. */
export const jobTypes = () => new Map((historyCache.all ?? []).map((d) => [d.id, d.event_type]));

/**
 * Zoom out and pan for the 8.x models. Those models have no outpaint job: the Niji web app draws the image on a larger,
 * empty canvas, uploads that, and sends it as an edit reference. This is the same geometry as the web app.
 * act: { kind: 'zoom', factor } or { kind: 'pan', direction (0 down, 1 right, 2 up, 3 left), fraction }.
 * Returns { url, ratio: { w, h }, edited }.
 */
export async function padAndUpload(imageUrl, act, hd) {
  const { status, json, text } = await run(`(async () => {
    const act = ${JSON.stringify(act)}, hd = ${JSON.stringify(Boolean(hd))};
    const gcd = (a, b) => { while (b) { [a, b] = [b, a % b]; } return a; };
    const HD = { defaultResolution: 2048, maxMegapixels: 4.88, divisor: 16, maxSize: 4096 }, SD = { defaultResolution: 1024, maxMegapixels: 1.22, divisor: 16, maxSize: 4096 };
    const vm = (e, t, a, r) => { const i = Math.max(e, t) / Math.min(e, t); const long = (Math.floor(r * i) + (a >> 1)) & ~(a - 1); return e > t ? { width: long, height: r } : { width: r, height: long }; };
    const kb = (e, t, a, r, n = 4096) => {
      const i = a * 1e6, l = t > e ? (p, h) => p / h : (p, h) => h / p, s = e * t, d = l(e, t), c = n / r; let u = Infinity, f;
      for (let p = 1; p <= c; p++) for (let h = 1; h <= c; h++) { const g = p * r, y = h * r, b = g * y; if (b <= i) { const k = Math.abs(b - s) / 1e6 + Math.abs(l(g, y) - d) * 16; if (k < u) { u = k; f = { width: g, height: y }; } } }
      return f ?? null;
    };
    const frameFor = (e, t) => {
      const { maxMegapixels: r, divisor: n, maxSize: i, defaultResolution: l } = hd ? HD : SD, s = Math.max(e, t), d = Math.min(e, t);
      if (d <= 0) return null; if (hd && s > d * 4) return 'hdAspectRatio';
      const ok = (u, f) => u % n === 0 && f % n === 0 && Math.max(u, f) <= i && u * f <= r * 1e6 && u * f >= l * l;
      if (ok(e, t)) return { width: e, height: t };
      if (hd && ok(e * 2, t * 2)) return { width: e * 2, height: t * 2 };
      if (s * r * 1e6 > i * i * d) { const u = Math.max(n, Math.floor(i * d / s / n) * n); return e >= t ? { width: i, height: u } : { width: u, height: i }; }
      const g = gcd(e, t), v = vm(e / g, t / g, n, l); return kb(v.width, v.height, r, n, i);
    };
    const img = await new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('The image did not load.')); im.src = ${JSON.stringify(imageUrl)}; });
    const e = img.naturalWidth, t = img.naturalHeight; let n = e, i = t;
    if (act.kind === 'zoom') { n = e * act.factor; i = t * act.factor; } else if (act.direction === 3 || act.direction === 1) n = e * (1 + act.fraction); else i = t * (1 + act.fraction);
    const frame = frameFor(Math.round(n), Math.round(i));
    if (!frame || frame === 'hdAspectRatio') return JSON.stringify({ status: 400, text: frame === 'hdAspectRatio' ? 'HD supports aspect ratios up to 4:1.' : 'No frame size for this image.' });
    const scale = act.kind === 'zoom' ? Math.min(frame.width / n, frame.height / i) : (act.direction === 3 || act.direction === 1) ? frame.height / t : frame.width / e;
    const w = Math.min(frame.width, Math.round(e * scale)), h = Math.min(frame.height, Math.round(t * scale));
    let x = Math.round((frame.width - w) / 2), y = Math.round((frame.height - h) / 2);
    if (act.kind === 'pan') { if (act.direction === 3) x = frame.width - w; if (act.direction === 1) x = 0; if (act.direction === 2) y = frame.height - h; if (act.direction === 0) y = 0; }
    const c = document.createElement('canvas'); c.width = frame.width; c.height = frame.height;
    c.getContext('2d').drawImage(img, x, y, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const fd = new FormData(); fd.append('file', blob, 'image.png');
    const r = await fetch('/api/storage-upload-file?source=editor', { method: 'POST', headers: { 'x-csrf-protection': '1' }, body: fd });
    const body = await r.text(); if (!r.ok) return JSON.stringify({ status: r.status, text: body });
    const g = gcd(frame.width, frame.height);
    return JSON.stringify({ status: 200, text: JSON.stringify({ bucketPathname: JSON.parse(body).bucketPathname, ratio: { w: frame.width / g, h: frame.height / g }, edited: x !== 0 || y !== 0 || w !== frame.width || h !== frame.height }) });
  })()`, 180_000);
  if (status !== 200 || !json?.bucketPathname) throw new Error(`The larger canvas did not upload (${status}): ${String(text).slice(0, 200)}`);
  return { url: `https://cdn.midjourney.com/e/${json.bucketPathname.replace(/^\//, '')}`, ratio: json.ratio, edited: json.edited };
}
