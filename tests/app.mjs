// Drives the real app headlessly. Usage: node tests/app.mjs <out.png> [script.js]
// The optional script is evaluated with `page` in scope, for ad-hoc UI checks.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [out = 'app.png', script] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1600), height: Number(process.env.H ?? 1000) }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.goto(process.env.URL ?? 'http://127.0.0.1:5173/');
await page.waitForSelector('.timeline', { timeout: 60000 });
// Wait for the demo splats to finish preparing and a frame to land.
await page.waitForFunction(() => !document.querySelector('.jobs'), null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(Number(process.env.WAIT ?? 25000));
if (script) await new Function('page', `return (async () => { ${readFileSync(script, 'utf8')} })()`)(page);
await page.screenshot({ path: out });
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'no console errors');
await browser.close();
