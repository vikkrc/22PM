// End-to-end import and export test: a .ply scan, a song's audio, then a short video render.
// Run with the dev server up:  node tests/import.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

// A 14 s click at 128 BPM: kick on the bar, noise ticks on the other beats, starting 0.25 s in.
function clickWav(bpm = 128, seconds = 14, offset = 0.25, sr = 22050) {
  const n = sr * seconds, pcm = new Int16Array(n), period = 60 / bpm;
  for (let b = 0, t = offset; t < seconds - 0.2; t += period, b++) {
    const s0 = Math.round(t * sr), kick = b % 4 === 0;
    for (let i = 0; i < sr * 0.08; i++) {
      const env = Math.exp(-i / (sr * 0.02));
      const v = kick ? Math.sin(2 * Math.PI * (55 + 60 * env) * (i / sr)) * env : ((((i * 1103515245 + 12345) >>> 8) % 2000) / 1000 - 1) * env * 0.3;
      pcm[s0 + i] = Math.max(-32767, Math.min(32767, pcm[s0 + i] + v * 28000));
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  return buf;
}
const dir = mkdtempSync(join(tmpdir(), '22pm-'));
const wav = join(dir, 'click128.wav');
writeFileSync(wav, clickWav());

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
const base = process.env.URL ?? 'http://127.0.0.1:5173/';
await page.goto(base + '?lite');
await page.waitForSelector('.timeline');
await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) await r.removeEntry(n, { recursive: true }); });
await page.reload();
await page.waitForSelector('.timeline');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const song = () => page.evaluate(() => { const s = window.__22pm.getState(); return s.show.songs.find((x) => x.id === s.ui.songId); });
const idle = () => page.waitForFunction(() => window.__22pm.getState().jobs.every((j) => j.status !== 'running'), null, { timeout: 120000 });

// Audio: import through the real file input.
await page.setInputFiles('.wave-row input[type=file]', wav);
await page.waitForFunction(() => { const s = window.__22pm.getState(); return !!s.show.songs[0].audioAssetId; }, null, { timeout: 120000 });
await idle();
const s1 = await song();
check('audio import detects the tempo', Math.abs(s1.tempo.bpm - 128) < 0.5, `${s1.tempo.bpm} BPM`);
const period = 60 / s1.tempo.bpm;
const ph = (((s1.tempo.firstDownbeatSec - 0.25) % period) + period) % period;
check('beat grid lines up with the click', Math.min(ph, period - ph) < 0.03, `first downbeat ${s1.tempo.firstDownbeatSec.toFixed(3)} s`);
check('song length follows the audio', Math.abs(s1.lengthBeats - 28) <= 4, `${s1.lengthBeats} beats`);
await page.waitForTimeout(500);
const wavePixels = await page.evaluate(() => { const c = document.querySelector('.tl-wave'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
check('waveform is drawn in the timeline', wavePixels > 500, `${wavePixels} px`);

// A music-driven modulator now produces a signal locked to the kicks.
const env = await page.evaluate(async () => {
  const { evaluate } = await import('/src/core/evaluate.ts');
  const { makeModulator } = await import('/src/core/model.ts');
  const rt = await import('/src/state/runtime.ts');
  const d = window.__22pm;
  d.update((_s, sg) => { const c = sg.tracks.flatMap((t) => t.clips).find((x) => x.id === 'clip_spot'); c.start = 0; c.fadeIn = 0; c.params.intensity = { base: 10, mods: [{ ...makeModulator('onset', 50), detector: 'kick' }] }; });
  const s = d.getState(), sg = s.show.songs[0], an = rt.analysisFor(sg);
  const at = (sec) => evaluate(s.show, sg, sec, an).lights.find((l) => l.id === 'clip_spot')?.intensity ?? -1;
  const bar = (60 / sg.tempo.bpm) * 4;
  return { onKick: at(sg.tempo.firstDownbeatSec + bar + 0.02), between: at(sg.tempo.firstDownbeatSec + bar * 1.5) };
});
check('onset trigger fires on the kick and decays', env.onKick > 40 && env.between < 12, JSON.stringify(env));

// Splat: write a real .ply and import it like a dropped file.
const imp = await page.evaluate(async () => {
  const { makeDemoObject } = await import('/src/splat/demo.ts');
  const { writePly } = await import('/src/splat/ply.ts');
  const rt = await import('/src/state/runtime.ts');
  const file = new File([writePly(makeDemoObject(5000, 3))], 'scan_test.ply');
  const id = await rt.importSplatFile(file);
  const again = new File([writePly(makeDemoObject(3000, 3))], 'scan_test_clean.ply');
  await rt.importSplatVersion(id, again);
  const s = window.__22pm.getState();
  const asset = s.show.assets.find((a) => a.id === id);
  const inst = s.show.songs[0].scene.splats.find((x) => x.assetId === id);
  await rt.syncScene();
  const r = await rt.getRenderer();
  return { versions: asset.versions.map((v) => [v.id, v.count]), inst: !!inst, rot: inst?.rot, slots: r.slotIds.length, gaussians: r.stats.gaussians };
});
check('.ply import adds an asset and a scene instance', imp.inst && imp.versions[0][1] > 4000, JSON.stringify(imp.versions));
check('a cleaned file becomes a new version and the scene updates in place', imp.versions.length === 2 && imp.slots === 3, `${imp.slots} splats, ${imp.gaussians} gaussians`);

// Render a short range to video (or PNG where no encoder exists) through the real export path.
const out = await page.evaluate(async () => {
  const ex = await import('/src/export/render.ts');
  const rt = await import('/src/state/runtime.ts');
  const { viewportBus } = await import('/src/ui/Viewport.tsx');
  const s = window.__22pm.getState(), sg = s.show.songs[0];
  const codecs = await ex.supportedCodecs(320, 180, 30);
  const renderer = await rt.getRenderer();
  viewportBus.paused = true;
  const res = {};
  for (const codec of [codecs[0], 'png']) {
    const settings = { width: 320, height: 180, fps: 30, codec, fromBeat: 8, toBeat: 8.5, supersample: 1, subFrames: 2, shutter: 0.5, shadowRes: 512, embedAudio: true, bitrateMbps: 8 };
    const audio = sg.audioAssetId ? rt.audioBuffers.get(sg.audioAssetId) : null;
    const job = ex.startRender(renderer, s.show, sg, rt.analysisFor(sg), audio, settings, { kind: 'memory' }, () => {});
    const r = await job.done;
    const head = new Uint8Array(await r.blob.slice(0, 12).arrayBuffer());
    res[codec] = { frames: r.frames, bytes: r.blob.size, magic: String.fromCharCode(...head.slice(codec === 'png' ? 0 : 4, codec === 'png' ? 2 : 8)) };
  }
  viewportBus.paused = false;
  return { codecs, res };
});
const [vc] = out.codecs;
console.log('     encoders available here:', out.codecs.join(', '));
const expectFrames = Math.round(0.5 * (60 / 128) * 30);
if (vc !== 'png') check(`renders ${vc} video with audio`, out.res[vc].frames === expectFrames && out.res[vc].magic === 'ftyp' && out.res[vc].bytes > 2000, JSON.stringify(out.res[vc]));
check('renders a PNG sequence', out.res.png.frames === expectFrames && out.res.png.magic === 'PK' && out.res.png.bytes > 5000, JSON.stringify(out.res.png));

check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
