import { parseSplatFile } from './spz';
import { prepareSplat } from './preprocess';
import { makeDemoCourtyard, makeDemoObject } from './demo';

self.onmessage = (e: MessageEvent<{ name: string; buf?: ArrayBuffer; demo?: string; lite?: boolean }>) => {
  try {
    const { name, buf, demo, lite } = e.data;
    const raw = demo ? (demo === 'demo_object' ? makeDemoObject(lite ? 10000 : 60000) : makeDemoCourtyard(lite ? 36000 : 180000)) : parseSplatFile(name, buf!);
    const p = prepareSplat(raw);
    (self as any).postMessage({ ok: p }, [p.pos.buffer, p.scale.buffer, p.quat.buffer, p.color.buffer, p.opacity.buffer, p.normal.buffer, p.lowLum.buffer]);
  } catch (err) {
    (self as any).postMessage({ error: String((err as Error).message ?? err) });
  }
};
