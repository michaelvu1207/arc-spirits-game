#!/usr/bin/env node
/** Actual installed Safari platform/accessibility/WebGL smoke via safaridriver. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnOwned, stopOwned } from './procOwn.mjs';

const root = resolve(import.meta.dirname, '..');
const appUrl = 'http://localhost:4174';
const driverPort = 4445;
const driverUrl = `http://127.0.0.1:${driverPort}`;
const children = [];
const checks = [];
let sessionId = '';

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function own(label, command, args) {
	const child = spawnOwned(command, args, { cwd: root, env: process.env, label });
	children.push(child);
	return child;
}

async function waitFor(label, probe, child, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child?.exitCode != null) throw new Error(`${label} exited early\n${child.ownedLog.slice(-3000)}`);
		try {
			if (await probe()) return;
		} catch {
			// Startup/navigation race.
		}
		await sleep(250);
	}
	throw new Error(`${label} timed out`);
}

async function webdriver(path, method = 'GET', body) {
	const response = await fetch(`${driverUrl}${path}`, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(60_000)
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok || payload?.value?.error) {
		throw new Error(`Safari WebDriver ${method} ${path}: ${payload?.value?.message || response.status}`);
	}
	return payload.value;
}

const execute = (script, args = []) => webdriver(`/session/${sessionId}/execute/sync`, 'POST', { script, args });

function check(name, ok, detail = '') {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function visible(selector) {
	return execute(`const e=document.querySelector(arguments[0]); if(!e) return false; const s=getComputedStyle(e); const r=e.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;`, [selector]);
}

try {
	const stack = own('platform-stack', process.execPath, ['scripts/platform-stack.mjs']);
	await waitFor('platform stack', async () => (await fetch(`${appUrl}/play`)).ok, stack);
	const driver = own('safaridriver', '/usr/bin/safaridriver', ['-p', String(driverPort)]);
	await waitFor('safaridriver', async () => (await fetch(`${driverUrl}/status`)).ok, driver);

	const session = await webdriver('/session', 'POST', {
		capabilities: { alwaysMatch: { browserName: 'safari' } }
	});
	sessionId = session.sessionId;
	const browserVersion = session.capabilities?.browserVersion || 'unknown';
	check('installed Safari session created', Boolean(sessionId), `Safari ${browserVersion}`);

	await webdriver(`/session/${sessionId}/url`, 'POST', { url: appUrl });
	await execute(`localStorage.setItem('asp:splat-quality','"off"::v1'); localStorage.setItem('asp:visual-quality','"balanced"::v1'); return true;`);
	await webdriver(`/session/${sessionId}/url`, 'POST', { url: `${appUrl}/play` });
	await waitFor('Safari hydration', () => visible('[data-testid="play-home"][data-hydrated="true"]'), null, 45_000);
	check('play surface hydrates in Safari', true);

	const viewport = await execute(`return document.querySelector('meta[name="viewport"]')?.content || '';`);
	check('browser zoom remains enabled', !/user-scalable=no|maximum-scale=1/.test(viewport), viewport);
	await execute(`document.querySelector('[data-testid="menu-settings"]')?.click(); return true;`);
	await waitFor('settings panel', () => visible('[data-testid="menu-settings-panel"]'), null);
	const undersized = await execute(`return [...document.querySelectorAll('[data-testid="menu-settings-panel"] button,[data-testid="menu-settings-panel"] input,[data-testid="menu-settings-panel"] [role="radio"]')].map(e=>e instanceof HTMLInputElement&&(e.type==='checkbox'||e.type==='radio')?e.closest('label')||e:e).filter((e,i,a)=>a.indexOf(e)===i).filter(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(); return s.display!=='none'&&(r.width<44||r.height<44)}).map(e=>({id:e.getAttribute('data-testid'),w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}));`);
	check('settings controls meet the 44px target', undersized.length === 0, JSON.stringify(undersized));
	await execute(`document.querySelector('[data-testid="text-scale-130"]')?.click(); document.querySelector('[data-testid="locale-en-XA"]')?.click(); const labels=[...document.querySelectorAll('[data-testid="menu-settings-panel"] label')]; labels.find(e=>e.textContent?.includes('High contrast'))?.querySelector('input')?.click(); return true;`);
	const accessibility = await execute(`return {scale:document.documentElement.dataset.textScale,contrast:document.documentElement.dataset.highContrast,lang:document.documentElement.lang};`);
	check('text, contrast and pseudo-locale apply', accessibility.scale === '130' && accessibility.contrast === 'true' && accessibility.lang === 'en-XA', JSON.stringify(accessibility));
	await webdriver(`/session/${sessionId}/refresh`, 'POST', {});
	await waitFor('Safari reload hydration', () => visible('[data-testid="play-home"][data-hydrated="true"]'), null);
	const persisted = await execute(`return {scale:document.documentElement.dataset.textScale,contrast:document.documentElement.dataset.highContrast,lang:document.documentElement.lang};`);
	check('accessibility preferences survive reload', JSON.stringify(persisted) === JSON.stringify(accessibility));

	await waitFor('native low-poly WebGL stage', () => execute(`const c=document.querySelector('[data-testid="low-poly-spirit-stage"] canvas.ready'); return !!c;`), null, 45_000);
	const webgl = await execute(`const c=document.querySelector('[data-testid="low-poly-spirit-stage"] canvas'); return !!c&&(!!c.getContext('webgl2')||!!c.getContext('webgl'));`);
	check('low-poly showcase has a real Safari WebGL context', webgl === true);

	const quick = await webdriver(`/session/${sessionId}/element`, 'POST', {
		using: 'css selector', value: '[data-testid="quick-play"]'
	});
	const elementId = quick['element-6066-11e4-a52e-4f735466cecf'];
	await execute(`document.querySelector('[data-testid="quick-play"]')?.focus(); return true;`);
	await webdriver(`/session/${sessionId}/element/${elementId}/value`, 'POST', {
		text: '\uE007', value: ['\uE007']
	});
	await waitFor('keyboard Quick Play', () => visible('[data-testid="ranked-view"]'), null, 30_000);
	check('primary journey accepts keyboard Enter', true);

	const screenshot = await webdriver(`/session/${sessionId}/screenshot`, 'GET');
	mkdirSync(join(root, 'bench/results'), { recursive: true });
	const runId = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
	const screenshotPath = join(root, 'bench/results', `${runId}-safari-platform.png`);
	writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
	const summaryPath = join(root, 'bench/results', `${runId}-safari-platform.json`);
	writeFileSync(summaryPath, `${JSON.stringify({
		generatedAt: new Date().toISOString(), browserVersion, screenshotPath,
		passed: checks.filter((entry) => entry.ok).length,
		failed: checks.filter((entry) => !entry.ok).length,
		checks
	}, null, 2)}\n`);
	console.log(`${checks.filter((entry) => entry.ok).length}/${checks.length} Safari checks passed · ${summaryPath}`);
	if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	if (sessionId) await webdriver(`/session/${sessionId}`, 'DELETE').catch(() => {});
	for (const child of [...children].reverse()) await stopOwned(child);
}
