// Golden-frame render tests: a fixed scene and time must give the same image within a tolerance.
// Run with the dev server up:  node tests/golden.mjs          (compare)
//                              node tests/golden.mjs --update (re-record after an intended look change)
// Goldens are recorded on the software rasteriser (SwiftShader) used in CI; expect small differences on real GPUs.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const dir = join(dirname(fileURLToPath(import.meta.url)), 'golden');
mkdirSync(dir, { recursive: true });
const update = process.argv.includes('--update');
const W = 320, H = 180, TOLERANCE = 2.0; // mean absolute difference, 0..255

const CASES = [
  { name: 'spot_shadows', sec: 4 },            // spot + point light, shadows
  { name: 'sweep', sec: 12 },                  // depth sweep (tint) passing through
  { name: 'sun', sec: 19 },                    // low sun, orthographic shadow map
  { name: 'disperse', sec: 29 },               // disperse animator late in the outro
  { name: 'normals', sec: 4, opts: { debugView: 2 } },
  { name: 'supersampled_blur', sec: 4, opts: { ss: 2, subFrames: 4 } },
];

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto((process.env.URL ?? 'http://127.0.0.1:5173/') + 'harness.html');
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 120000 });
if ((await page.title()) === 'error') { console.log(await page.textContent('body')); process.exit(1); }

const render = (c) => page.evaluate(async ([sec, w, h, opts]) => {
  await window.harness.frame(sec, w, h, { ...opts, returnPixels: false });
  return document.getElementById('c').toDataURL('image/png');
}, [c.sec, W, H, c.opts ?? {}]);
const diff = (a, b) => page.evaluate(async ([a, b]) => {
  const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const [x, y] = [await load(a), await load(b)];
  if (x.length !== y.length) return { mean: 255, max: 255 };
  let sum = 0, max = 0;
  for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i] - y[i]); sum += d; if (d > max) max = d; }
  return { mean: sum / x.length, max };
}, [a, b]);

let failed = 0;
// Determinism: the same time rendered twice, with other frames in between, must be bit-identical.
const a1 = await render(CASES[0]);
await render(CASES[3]);
const a2 = await render(CASES[0]);
const det = await diff(a1, a2);
console.log(`${det.max === 0 ? 'ok  ' : 'FAIL'} deterministic: frame is identical after rendering other frames (max diff ${det.max})`);
if (det.max !== 0) failed++;

for (const c of CASES) {
  const url = c === CASES[0] ? a1 : await render(c);
  const file = join(dir, `${c.name}.png`);
  if (update || !existsSync(file)) {
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    console.log(`rec  ${c.name}`);
    continue;
  }
  const gold = 'data:image/png;base64,' + readFileSync(file).toString('base64');
  const d = await diff(url, gold);
  const ok = d.mean <= TOLERANCE;
  if (!ok) { failed++; writeFileSync(join(dir, `${c.name}.actual.png`), Buffer.from(url.split(',')[1], 'base64')); }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}  mean ${d.mean.toFixed(3)}  max ${d.max}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
