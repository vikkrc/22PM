// Headless render harness for golden-frame tests (tests/golden.mjs). Not part of the app.
import { Renderer } from '../render/renderer';
import { makeDemoCourtyard, makeDemoObject } from '../splat/demo';
import { prepareSplat } from '../splat/preprocess';
import { evaluate } from '../core/evaluate';
import { makeDemoShow } from '../state/demoShow';

declare global { interface Window { harness: any } }

async function boot() {
  const renderer = await Renderer.create();
  const show = makeDemoShow('demo_courtyard', 'demo_object');
  const song = show.songs[0];
  const assets: Record<string, ReturnType<typeof prepareSplat>> = {
    demo_courtyard: prepareSplat(makeDemoCourtyard(60000)),
    demo_object: prepareSplat(makeDemoObject(20000)),
  };
  renderer.setScene(song.scene.splats.map((s) => ({ id: s.id, data: assets[s.assetId] })));
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  window.harness = {
    show, song, renderer,
    /** Render song time `sec` and return RGBA pixels as a plain array (also drawn to the canvas). */
    async frame(sec: number, width = 480, height = 270, opts: any = {}) {
      // Read the current show from the harness object, so tests can swap or edit it between frames.
      const { show, song } = window.harness;
      const state = evaluate(show, song, sec, null);
      const sub = opts.subFrames ? Array.from({ length: opts.subFrames - 1 }, (_, i) => evaluate(show, song, sec + ((i + 1) / opts.subFrames) / 60, null)) : undefined;
      const px = await renderer.renderToPixels(state, { width, height, shadowRes: 512, ...opts, subFrames: sub });
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), width, height), 0, 0);
      return { stats: { ...renderer.stats }, px: opts.returnPixels === false ? null : Array.from(px) };
    },
  };
  document.title = 'ready';
}
boot().catch((e) => { document.title = 'error'; document.body.textContent = String(e?.stack ?? e); console.error(e); });
