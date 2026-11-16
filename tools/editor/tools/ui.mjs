// Analysis tool: node tools/ui.mjs click X Y | shot FILE | key Escape
import { writeFileSync } from 'node:fs';
import { connect, nijiTarget } from '../cdp.mjs';
const [cmd, a, b] = process.argv.slice(2);
const page = await connect((await nijiTarget()).webSocketDebuggerUrl);
if (cmd === 'click') {
  const x = Number(a), y = Number(b);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
} else if (cmd === 'key') {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: a, code: a });
} else if (cmd === 'shot') {
  const r = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  writeFileSync(a, Buffer.from(r.data, 'base64'));
}
page.close();
