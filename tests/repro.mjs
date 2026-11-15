// Visual reproduction of reported issues, rendered through the headless harness.
// Usage: node tests/repro.mjs <outdir>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto((process.env.URL ?? 'http://127.0.0.1:5173/') + 'harness.html');
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 120000 });

const shot = async (name, sec, setup, opts = {}) => {
  const url = await page.evaluate(async ([sec, setup, opts]) => {
    const h = window.harness;
    const song = h.song;
    const clip = (id) => song.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    const restore = JSON.stringify(h.show);
    new Function('song', 'clip', setup)(song, clip);
    await h.frame(sec, opts.w ?? 640, opts.h ?? 360, { returnPixels: false, ...opts });
    const r = document.getElementById('c').toDataURL('image/png');
    h.show = JSON.parse(restore);
    h.song = h.show.songs[0];
    return r;
  }, [sec, setup, opts]);
  writeFileSync(join(out, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
};

// 1. Soft shadows: only the point light, close on the rock.
const closeCam = `
  for (const t of song.tracks) t.clips = t.clips.filter((c) => c.id === 'clip_point' || c.id === 'clip_cam');
  const cam = clip('clip_cam'); cam.params['pos.x'] = { base: 1.6 }; cam.params['pos.y'] = { base: 1.4 }; cam.params['pos.z'] = { base: 2.6 };
  cam.params['target.x'] = { base: -0.3 }; cam.params['target.y'] = { base: 0.6 }; cam.params['target.z'] = { base: 0.3 }; cam.params.fov = { base: 40 };
  const p = clip('clip_point'); p.start = 0; p.params.intensity = { base: 4 };
  p.params['pos.x'] = { base: 1.2 }; p.params['pos.y'] = { base: 2.2 }; p.params['pos.z'] = { base: 1.6 }; p.params.range = { base: 12 };`;
const only = process.env.ONLY;
for (const soft of [0, 0.3, 0.8]) await shot(`shadow_soft_${soft}`, 1, closeCam + `p.params.shadowSoftness = { base: ${soft} };`);
await shot('shadow_off', 1, closeCam + `p.params.castShadows = { base: 0 };`);
await shot('shadow_soft_0.3_lighting', 1, closeCam + `p.params.shadowSoftness = { base: 0.3 };`, { debugView: 5 });
await shot('shadow_term', 1, closeCam + `p.params.shadowSoftness = { base: 0.3 };`, { debugView: 6 });
await shot('normals', 1, closeCam, { debugView: 2 });

// 2. Global light at zero and no lights: should be black.
await shot('global_zero', 1, `for (const t of song.tracks) t.clips = t.clips.filter((c) => c.id === 'clip_cam'); song.scene.base.global.params.intensity = { base: 0 };`);

// 3. Fade-out curve: mean brightness of a point-lit frame across a 4-beat fade.
const fade = await page.evaluate(async () => {
  const h = window.harness, song = h.song;
  const keep = JSON.stringify(h.show);
  for (const t of song.tracks) t.clips = t.clips.filter((c) => c.id === 'clip_point' || c.id === 'clip_cam');
  song.scene.base.global.params.intensity = { base: 0 };
  const p = song.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_point');
  p.start = 0; p.length = 8; p.fadeOut = 4; p.params.intensity = { base: 4, mods: [] };
  const rows = [];
  for (let b = 3.5; b <= 8.01; b += 0.5) {
    const r = await h.frame(b * 0.5, 160, 90, {});
    let s = 0; for (let i = 0; i < r.px.length; i += 4) s += (r.px[i] + r.px[i + 1] + r.px[i + 2]) / 3;
    rows.push([b, +(s / (r.px.length / 4)).toFixed(2)]);
  }
  h.show = JSON.parse(keep); h.song = h.show.songs[0];
  return rows;
});
console.log('fade-out (beat, mean 0-255):', fade.map(([b, v]) => `${b}:${v}`).join('  '));
await browser.close();
