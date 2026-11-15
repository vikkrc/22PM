// Usage: node tests/shot.mjs <sec> <out.png> [jsonOpts]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [sec = '4', out = 'shot.png', optsJson = '{}'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(process.env.URL ?? 'http://127.0.0.1:5173/harness.html');
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 120000 });
if ((await page.title()) === 'error') { console.log(await page.textContent('body')); process.exit(1); }
const t0 = Date.now();
const stats = await page.evaluate(async ([s, o]) => (await window.harness.frame(s, o.width ?? 640, o.height ?? 360, { ...o, returnPixels: false })).stats, [Number(sec), JSON.parse(optsJson)]);
console.log(JSON.stringify(stats), `${Date.now() - t0} ms`);
await (await page.$('#c')).screenshot({ path: out });
await browser.close();
