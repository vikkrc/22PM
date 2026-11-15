// End-to-end UI test: drives the real app with mouse and keyboard and checks the document.
// Run with the dev server up:  node tests/ui.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.goto((process.env.URL ?? 'http://127.0.0.1:5173/') + '?lite');
await page.waitForSelector('.timeline');
await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) await r.removeEntry(n, { recursive: true }); });
await page.reload();
await page.waitForSelector('.timeline');
await page.waitForTimeout(1500);

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const song = () => page.evaluate(() => { const s = window.__22pm.getState(); return s.show.songs.find((x) => x.id === s.ui.songId); });
const ui = () => page.evaluate(() => window.__22pm.getState().ui);
const clips = async () => (await song()).tracks.flatMap((t) => t.clips.map((c) => ({ ...c, track: t.id })));
const clip = async (id) => (await clips()).find((c) => c.id === id);
const box = async (sel) => (await page.locator(sel).first().boundingBox());
const drag = async (x0, y0, x1, y1) => { await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await page.mouse.move(x1, y1, { steps: 4 }); await page.mouse.up(); };

// 1. Add clips by double-clicking lanes.
let lane = await box('[data-track="trk_5"]');
await page.mouse.dblclick(lane.x + 300, lane.y + 15);
await page.click('.menu.inline .menu-item:has-text("Post")');
let all = await clips();
const post = all.find((c) => c.kind === 'post');
check('double-click + menu adds a post clip', !!post && post.track === 'trk_5', post && `start ${post.start}`);
check('new clip is selected', (await ui()).selection.id === post?.id);
check('clip snapped to the beat grid', post && Number.isInteger(post.start));

// 2. Move and trim a clip with the mouse.
const sw0 = await clip('clip_sweep');
let b = await box('.clip:has-text("Sweep")');
await drag(b.x + 40, b.y + 10, b.x + 40 + 96, b.y + 10);
const sw1 = await clip('clip_sweep');
check('dragging a clip moves it by whole beats', sw1.start === sw0.start + 4, `${sw0.start} → ${sw1.start}`);
b = await box('.clip:has-text("Sweep")');
await drag(b.x + b.width - 2, b.y + 10, b.x + b.width - 2 - 48, b.y + 10);
const sw2 = await clip('clip_sweep');
check('dragging the right edge trims the length', sw2.length === sw1.length - 2 && sw2.start === sw1.start, `${sw1.length} → ${sw2.length}`);
await page.keyboard.down('Alt');
b = await box('.clip:has-text("Sweep")');
await drag(b.x + 40, b.y + 10, b.x + 40 + 7, b.y + 10);
await page.keyboard.up('Alt');
const sw3 = await clip('clip_sweep');
check('Alt-drag ignores snapping', !Number.isInteger(sw3.start) && Math.abs(sw3.start - sw2.start - 7 / 24) < 0.02, `${sw3.start}`);

// 3. Undo / redo.
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
{ const c = await clip('clip_sweep'); check('undo ×3 restores the clip', c.start === sw0.start && c.length === sw0.length, `start ${c.start} len ${c.length}`); }
await page.keyboard.press('Control+Shift+z');
check('redo re-applies the move', (await clip('clip_sweep')).start === sw1.start);
await page.keyboard.press('Control+z');

// 4. Inspector: scrub, type, keyframe, auto-key.
await page.click('.clip:has-text("Key spot")');
check('clicking a clip selects it', (await ui()).selection.id === 'clip_spot');
const intensity = page.locator('.row:has(.row-label:text-is("Intensity")) .num').first();
let nb = await intensity.boundingBox();
await drag(nb.x + 30, nb.y + 10, nb.x + 60, nb.y + 10);
const i1 = (await clip('clip_spot')).params.intensity.base;
check('dragging a number scrubs it', i1 > 70, `70 → ${i1}`);
await intensity.click();
await page.keyboard.type('55.5');
await page.keyboard.press('Enter');
check('typing sets an exact value', (await clip('clip_spot')).params.intensity.base === 55.5);
await intensity.click();
await page.keyboard.type('*2');
await page.keyboard.press('Enter');
check('typed expressions work (*2)', (await clip('clip_spot')).params.intensity.base === 111);
await page.locator('.row:has(.row-label:text-is("Intensity")) .key-btn').click();
check('◆ adds a keyframe at the playhead', (await clip('clip_spot')).params.intensity.keys?.length === 1);
await page.evaluate(() => window.__22pm.transport.seek(4));
await intensity.click(); await page.keyboard.type('20'); await page.keyboard.press('Enter');
const keys = (await clip('clip_spot')).params.intensity.keys;
check('editing a keyed value elsewhere auto-keys', keys?.length === 2 && keys[1].t === 8 && keys[1].v === 20, JSON.stringify(keys?.map((k) => [k.t, k.v])));
check('keyframe lane appears in the timeline', await page.locator('.keylane .key-label:text-is("Intensity")').count() === 1);

// 5. Drag a keyframe in its lane.
const kd = page.locator('.keylane:has(.key-label:text-is("Intensity")) .key').nth(1);
await kd.scrollIntoViewIfNeeded();
let kb = await kd.boundingBox();
await drag(kb.x + 5, kb.y + 5, kb.x + 5 + 48, kb.y + 5);
check('dragging a keyframe moves it in time', (await clip('clip_spot')).params.intensity.keys[1].t === 10);
check('dragged keyframe is selected and editable', await page.locator('.section-title:has-text("Keyframe")').count() === 1);
await page.click('.seg button:text-is("Linear")');
check('segment shape can be set', (await clip('clip_spot')).params.intensity.keys[1].interp === 'linear');

// 6. Modulators.
await page.locator('.row:has(.row-label:text-is("Cone angle")) .mod-btn').click();
await page.click('.mod-foot .btn:has-text("+ Modulator")');
await page.click('.menu-item:text-is("LFO")');
let mods = (await clip('clip_spot')).params.cone.mods;
check('adding an LFO modulator', mods?.length === 1 && mods[0].type === 'lfo');
await page.click('.mod-card .mini:text-is("×2")');
check('×2 halves the LFO period', (await clip('clip_spot')).params.cone.mods[0].rateBeats === 2);
await page.click('.mod-card .seg button:text-is("Triplet")');
check('triplet feel', (await clip('clip_spot')).params.cone.mods[0].feel === 'triplet');
await page.click('.mod-foot .btn:has-text("+ Modulator")');
await page.click('.menu-item:text-is("Beat trigger")');
check('modulators stack', (await clip('clip_spot')).params.cone.mods.length === 2);

// 7. Keyboard: split, duplicate, delete, transport.
await page.evaluate(() => window.__22pm.transport.seek(8));
await page.locator('.vp-bar').click({ position: { x: 300, y: 10 } });
const n0 = (await clips()).length;
await page.keyboard.press('s');
all = await clips();
const halves = all.filter((c) => c.name === 'Key spot');
check('S splits the clip at the playhead', all.length === n0 + 1 && halves.some((c) => c.start === 0 && c.length === 16) && halves.some((c) => c.start === 16 && c.length === 32));
check('split keeps the keyframe curve continuous', halves.find((c) => c.start === 16)?.params.intensity.keys[1].t === 10 - 16);
await page.keyboard.press('Control+d');
check('⌘D duplicates', (await clips()).length === n0 + 2);
await page.keyboard.press('Delete');
check('Delete removes the selected clip', (await clips()).length === n0 + 1);
const t0 = await page.evaluate(() => window.__22pm.transport.sec);
await page.keyboard.press('Space');
await page.waitForTimeout(1200);
const playing = await page.evaluate(() => window.__22pm.transport.playing);
await page.keyboard.press('Space');
const t1 = await page.evaluate(() => window.__22pm.transport.sec);
check('Space plays and pauses', playing && t1 > t0 + 0.5, `${t0.toFixed(2)} → ${t1.toFixed(2)}`);

// 8. Song settings: BPM change moves seconds, not beats.
await page.click('.song-item');
const bpm = page.locator('.row:has(.row-label:text-is("BPM")) .num').first();
await bpm.click(); await page.keyboard.type('90'); await page.keyboard.press('Enter');
check('BPM edit keeps clips on their beats', (await song()).tempo.bpm === 90 && (await clip('clip_sweep')).start === sw0.start, `bpm ${(await song()).tempo.bpm}, sweep ${(await clip('clip_sweep')).start}`);

// 9. Other tabs.
await page.click('.tabs button:text-is("Show")');
check('Show tab: setlist and safety keys', await page.locator('.set-item').count() === 1 && await page.locator('.safety .btn').count() === 4);
await page.keyboard.press('b');
check('B toggles blackout', await page.locator('.safety .btn.on.danger').count() === 1);
await page.keyboard.press('b');
await page.click('.seg button:text-is("MIDI Timecode")');
await page.click('.btn:has-text("Send test timecode")');
await page.waitForTimeout(1500);
const pill = await page.locator('.status-pill').textContent();
const tsec = await page.evaluate(() => window.__22pm.transport.sec);
check('timecode chase locks and drives the position', pill === 'Locked' && tsec > 0.5, `${pill}, ${tsec.toFixed(2)} s`);
await page.click('.btn:has-text("Stop test timecode")');
await page.waitForTimeout(3200);
const pill2 = await page.locator('.status-pill').textContent();
const held = await page.evaluate(() => window.__22pm.transport.sec);
await page.waitForTimeout(500);
check('on dropout: freewheel, then hold the last frame', pill2 === 'Holding last frame' && held === await page.evaluate(() => window.__22pm.transport.sec), pill2);
await page.click('.seg button:text-is("Manual")');
await page.click('.tabs button:text-is("Train")');
check('Train tab renders', await page.locator('.page h1:text-is("Train")').count() === 1);
await page.click('.tabs button:text-is("Edit")');
check('Edit tab lists asset versions', await page.locator('.versions').count() === 2);
await page.click('.tabs button:text-is("Animate")');

// 10. Autosave survives a reload.
await page.waitForTimeout(1500);
await page.reload();
await page.waitForSelector('.timeline');
await page.waitForTimeout(800);
check('project autosaves and reloads', (await song()).tempo.bpm === 90 && (await clips()).some((c) => c.kind === 'post'));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
