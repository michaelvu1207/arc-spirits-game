// Dev tool: opens the local UI in the dedicated Chrome and takes screenshots.
import { writeFileSync } from 'node:fs';
import { connect, browserWsUrl, listTargets } from '../cdp.mjs';
const out = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t = (await listTargets()).find((x) => x.url.startsWith('http://127.0.0.1:8787'));
if (!t) {
  const b = await connect(await browserWsUrl());
  await b.send('Target.createTarget', { url: 'http://127.0.0.1:8787/', background: true });
  b.close(); await sleep(1500);
  t = (await listTargets()).find((x) => x.url.startsWith('http://127.0.0.1:8787'));
}
const p = await connect(t.webSocketDebuggerUrl);
const errors = [];
p.on((m, a) => { if (m === 'Runtime.exceptionThrown') errors.push(a.exceptionDetails.exception?.description?.slice(0, 300)); if (m === 'Log.entryAdded' && a.entry.level === 'error') errors.push(a.entry.text.slice(0, 200) + ' ' + (a.entry.url || '').slice(0, 120)); });
await p.send('Runtime.enable'); await p.send('Log.enable'); await p.send('Page.enable');
await p.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await p.send('Page.reload'); await sleep(2500);
const ev = async (expression) => (await p.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const shot = async (name) => writeFileSync(`${out}/${name}.jpg`, Buffer.from((await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 })).data, 'base64'));
for (const step of process.argv.slice(3)) {
  const [name, js] = step.split('::');
  if (js) console.log(name, '=>', await ev(js));
  await sleep(1800); await shot(name);
}
console.log('errors:', JSON.stringify(errors));
p.close();
