// Analysis tool: records Niji API traffic from the dedicated Chrome into capture.json.
// Usage: node tools/record.mjs [--prompt "text"] [--seconds 90]
// Secrets (cookies, authorization, JWTs) are redacted before they are written.
import { writeFileSync } from 'node:fs';
import { connect, nijiTarget, browserWsUrl } from '../cdp.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const PROMPT = arg('prompt', '');
const SECONDS = Number(arg('seconds', PROMPT ? 90 : 12));
const MANUAL = process.argv.includes('--manual'); // record only: no reload, no prompt
const OUT = arg('out', new URL('../capture.json', import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const redact = (s) =>
  typeof s === 'string'
    ? s.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, '<JWT>').replace(/AMf-[\w-]{40,}/g, '<REFRESH>')
    : s;
const cleanHeaders = (h = {}) =>
  Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, /^(cookie|set-cookie|authorization)$/i.test(k) ? '<redacted>' : redact(v)]),
  );

// 1. Wait for login.
const browser = await connect(await browserWsUrl());
process.stderr.write('Waiting for the Niji login...\n');
for (let i = 0; ; i++) {
  const { cookies } = await browser.send('Storage.getCookies');
  if (cookies.some((c) => c.name.includes('AuthUserToken') && c.domain.includes('nijijourney'))) break;
  if (i > 600) throw new Error('No login after 20 minutes.');
  await sleep(2000);
}
browser.close();
await sleep(3000);

// 2. Attach to the page and record.
let target = await nijiTarget();
if (!target) throw new Error('No nijijourney.com tab in the dedicated Chrome.');
const page = await connect(target.webSocketDebuggerUrl);
const reqs = new Map();
const sockets = new Map();
const interesting = (url) => /nijijourney\.com|midjourney\.com|mj\.run|googleapis\.com|storage/.test(url) && !/\.(js|css|woff2?|png|jpg|webp|svg|ico)(\?|$)/.test(url) && !/_next\/static/.test(url);

page.on(async (method, p) => {
  if (method === 'Network.requestWillBeSent') {
    if (p.request.method === 'GET' ? !interesting(p.request.url) : /google|analytics|proxima|traces|datadog/.test(p.request.url)) return;
    reqs.set(p.requestId, {
      t: p.type,
      method: p.request.method,
      url: redact(p.request.url),
      reqHeaders: cleanHeaders(p.request.headers),
      postData: redact(p.request.postData),
    });
  } else if (method === 'Network.requestWillBeSentExtraInfo') {
    const r = reqs.get(p.requestId);
    if (r) r.reqHeadersExtra = cleanHeaders(p.headers);
  } else if (method === 'Network.responseReceived') {
    const r = reqs.get(p.requestId);
    if (!r) return;
    r.status = p.response.status;
    r.mime = p.response.mimeType;
    r.resHeaders = cleanHeaders(p.response.headers);
  } else if (method === 'Network.loadingFinished') {
    const r = reqs.get(p.requestId);
    if (!r || !/json|text/.test(r.mime || '')) return;
    try {
      const b = await page.send('Network.getResponseBody', { requestId: p.requestId });
      r.body = redact(b.base64Encoded ? '<binary>' : b.body).slice(0, 20000);
    } catch {}
  } else if (method === 'Network.webSocketCreated') {
    sockets.set(p.requestId, { url: redact(p.url), frames: [] });
  } else if (method === 'Network.webSocketWillSendHandshakeRequest') {
    const s = sockets.get(p.requestId);
    if (s) s.reqHeaders = cleanHeaders(p.request.headers);
  } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
    const s = sockets.get(p.requestId);
    if (s && s.frames.length < 400)
      s.frames.push({ dir: method.endsWith('Sent') ? 'out' : 'in', data: redact(p.response.payloadData).slice(0, 3000) });
  }
});

await page.send('Network.enable', { maxPostDataSize: 1_000_000 });
await page.send('Page.enable');
if (!MANUAL) {
  await page.send('Page.navigate', { url: 'https://nijijourney.com/imagine' });
  await sleep(9000);
}

if (PROMPT) {
  const { result } = await page.send('Runtime.evaluate', {
    expression: `(()=>{const t=document.querySelector('textarea');if(!t)return 'no textarea';t.focus();return 'ok'})()`,
    returnByValue: true,
  });
  if (result.value !== 'ok') throw new Error(`Prompt box: ${result.value}`);
  await page.send('Input.insertText', { text: PROMPT });
  await sleep(500);
  for (const type of ['keyDown', 'keyUp'])
    await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
  process.stderr.write('Prompt sent.\n');
}
await sleep(SECONDS * 1000);

const ua = (await page.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.value;
writeFileSync(OUT, JSON.stringify({ ua, requests: [...reqs.values()], sockets: [...sockets.values()] }, null, 1));
console.log(`Wrote ${OUT}: ${reqs.size} requests, ${sockets.size} websockets`);
page.close();
