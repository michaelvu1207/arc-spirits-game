// Analysis tool: node tools/upload.mjs FILE — puts a file into the page's file input.
import { connect, nijiTarget } from '../cdp.mjs';
const page = await connect((await nijiTarget()).webSocketDebuggerUrl);
const { root } = await page.send('DOM.getDocument', { depth: 0 });
const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await page.send('DOM.setFileInputFiles', { nodeId, files: [process.argv[2]] });
console.log('file set');
page.close();
