// Analysis tool: node tools/eval.mjs '<js expression>' — evaluates in the Niji tab.
import { connect, nijiTarget } from '../cdp.mjs';
const t = await nijiTarget();
if (!t) { console.log('no niji tab'); process.exit(1); }
const page = await connect(t.webSocketDebuggerUrl);
const r = await page.send('Runtime.evaluate', { expression: process.argv[2], returnByValue: true, awaitPromise: true });
console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value ?? r.exceptionDetails?.exception?.description, null, 1));
page.close();
