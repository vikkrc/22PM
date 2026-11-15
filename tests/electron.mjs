// Desktop app test: launches the real Electron shell on the built app (no dev server) and checks
// rendering, the on-disk project folder, save-on-quit, reopening, native render export and menu commands.
// Run:  npm run build && node tests/electron.mjs      (Linux needs: xvfb-run -a node tests/electron.mjs)
// Packaged app:  TWENTYTWO_EXE=release/mac-arm64/22PM.app/Contents/MacOS/22PM node tests/electron.mjs
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
/** The project's own Electron binary (Playwright may be installed elsewhere). */
const executablePath = process.env.TWENTYTWO_EXE || require('electron');

const root = resolve(new URL('..', import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), '22pm-electron-'));
const project = join(work, 'My Show');
const env = {
  ...process.env,
  TWENTYTWO_PROJECT: project,
  TWENTYTWO_USER_DATA: join(work, 'userdata'),
  TWENTYTWO_SOFTWARE_GPU: process.platform === 'linux' ? '1' : '',
  TWENTYTWO_LITE: '1',
};
// A packaged app (TWENTYTWO_EXE) carries its own code; the dev binary is pointed at the repo.
const args = [...(process.env.TWENTYTWO_EXE ? [] : [root]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

async function launch() {
  const app = await _electron.launch({ executablePath, args, env, timeout: 60000 });
  const win = await app.firstWindow();
  const errors = [];
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await win.waitForSelector('.timeline', { timeout: 60000 });
  return { app, win, errors };
}

// ---- first launch ----
let { app, win, errors } = await launch();
check('loads the bundled app (no dev server)', win.url().startsWith('app://22pm/index.html'), win.url());
check('desktop bridge is present', await win.evaluate(() => !!window.native && document.body.classList.contains('desktop')));
const info = await win.evaluate(() => window.native.project.info());
check('project folder is the one configured', info.root === project, info.root);
// Wait for the demo splats to prepare and a frame to render.
await win.waitForFunction(async () => (await window.__22pm.getRenderer()).stats.gaussians > 0, null, { timeout: 120000 });
await win.waitForFunction(() => /\d+ lights/.test(document.querySelector('.hud')?.textContent ?? ''), null, { timeout: 120000 });
const hud = await win.evaluate(() => document.querySelector('.hud').textContent);
check('WebGPU renders the scene', /0\.\d\dM gaussians/.test(hud) && !/0\.00M/.test(hud), hud.split('\n')[2]);

// Autosave lands on disk as show.json.
await win.evaluate(() => window.__22pm.update((_s, sg) => { sg.title = 'Disk test'; }));
await win.waitForFunction(() => !window.__22pm.getState().dirty, null, { timeout: 60000 });
const saved = JSON.parse(readFileSync(join(project, 'show.json'), 'utf8'));
check('autosave writes show.json into the project folder', saved.songs[0].title === 'Disk test');

// Imports are copied into the project folder.
const assetId = await win.evaluate(async () => {
  // The bundled app has no /src to import helpers from; build a minimal valid PLY by hand.
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const n = 500;
  const head = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${names.map((p) => `property float ${p}`).join('\n')}\nend_header\n`);
  const body = new Float32Array(n * names.length);
  for (let i = 0; i < n; i++) {
    const o = i * names.length;
    body[o] = Math.cos(i) * 0.3; body[o + 1] = 1 + (i % 10) * 0.05; body[o + 2] = Math.sin(i) * 0.3;
    body[o + 6] = 2; body[o + 7] = body[o + 8] = body[o + 9] = -4; body[o + 10] = 1;
  }
  const file = new File([head, body], 'disk_scan.ply');
  return window.__22pm.importSplatFile(file);
});
await win.waitForTimeout(500);
check('imported scan is stored in the project folder', !!assetId && existsSync(join(project, 'assets', assetId, 'raw.ply')));

// Native render export: stub the save dialog in the main process, render a few frames to a real file.
const mp4 = join(work, 'out.mp4');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, mp4);
await win.evaluate(() => window.__22pm.setUi({ dialog: 'render' }));
await win.waitForSelector('.modal');
// Short range: from bar 3 to bar 3 beat 2.
const bbt = win.locator('.modal .row:has(.row-label:text-is("To")) input');
await bbt.fill('3.2.0'); await bbt.press('Enter');
const from = win.locator('.modal .row:has(.row-label:text-is("From")) input');
await from.fill('3.1.0'); await from.press('Enter');
// Small and short, so it finishes quickly even on a software GPU.
const setNum = async (row, i, v) => { await win.locator(`.modal .row:has(.row-label:text-is("${row}")) .num`).nth(i).click(); await win.keyboard.type(String(v)); await win.keyboard.press('Enter'); };
await setNum('Resolution', 0, 320); await setNum('Resolution', 1, 180);
await win.click('.modal .row:has(.row-label:text-is("Frame rate")) .seg button:text-is("30")');
await win.selectOption('.modal .row:has(.row-label:text-is("Shadow maps")) select', '1024');
await win.click('.modal .seg button:text-is("1×")');
await win.click('.modal .seg button:text-is("Off")');
await win.click('.modal-foot .btn.primary');
for (let t = 0; t < 240 && !(await win.locator('.render-result').count()); t += 10) {
  await win.waitForTimeout(10000);
  if (process.env.DEBUG_RENDER) console.log('   …', (await win.locator('.render-side').textContent()).slice(0, 160), '| file', existsSync(mp4) ? statSync(mp4).size : 'none');
}
await win.waitForSelector('.render-result', { timeout: 5000 });
const result = await win.locator('.render-result').textContent();
const size = existsSync(mp4) ? statSync(mp4).size : 0;
const magic = size ? readFileSync(mp4).subarray(4, 8).toString() : '';
check('render writes an MP4 straight to the chosen file', /^Saved/.test(result) && magic === 'ftyp' && size > 2000, `${result.trim()} · ${size} bytes`);
check('offers Show in Finder after rendering', await win.locator('.render-result .link:has-text("Show in Finder")').count() === 1);
await win.click('.modal-foot .btn:text-is("Close")');

// Menu commands reach the page.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', 'tab:show'));
await win.waitForSelector('.show-right');
check('menu bar commands switch tabs', await win.evaluate(() => window.__22pm.getState().ui.tab === 'show'));
const displays = await win.evaluate(() => window.native.displays());
check('lists displays for the output', displays.length >= 1 && displays.some((d) => d.primary), displays.map((d) => d.label).join(', '));
await win.click('.btn:text-is("Open output")');
await win.waitForTimeout(1500);
const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
check('opens the LED output window', titles.includes('22PM output'), titles.join(' | '));

// Edit something, then quit immediately: the shell must wait for the save.
await win.evaluate(() => window.__22pm.update((_s, sg) => { sg.title = 'Saved on quit'; }));
check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await app.close();
check('quitting flushes the last edit to disk', JSON.parse(readFileSync(join(project, 'show.json'), 'utf8')).songs[0].title === 'Saved on quit');

// ---- second launch: the project reopens from disk ----
({ app, win, errors } = await launch());
const s2 = await win.evaluate(() => { const s = window.__22pm.getState(); return { title: s.show.songs[0].title, assets: s.show.assets.length }; });
check('reopening loads the project from the folder', s2.title === 'Saved on quit' && s2.assets >= 3, JSON.stringify(s2));
await win.waitForFunction(async () => (await window.__22pm.getRenderer()).stats.gaussians > 0, null, { timeout: 120000 });
const slots = await win.evaluate(async () => (await window.__22pm.getRenderer()).slotIds.length);
check('imported scan reloads from disk into the scene', slots === 3, `${slots} splats`);
await app.close();

console.log(`\nproject folder: ${project}\n  ${readdirSync(project).join('  ')}`);
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
