// Analysis tool: node tools/type.mjs "text" [--enter]
import { connect, nijiTarget } from '../cdp.mjs';
const page = await connect((await nijiTarget()).webSocketDebuggerUrl);
await page.send('Runtime.evaluate', { expression: 'document.querySelector("textarea").focus()' });
await page.send('Input.insertText', { text: process.argv[2] });
if (process.argv.includes('--enter')) {
  await new Promise((r) => setTimeout(r, 500));
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
}
page.close();
