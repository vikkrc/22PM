import { makeScratch, sortByDepth } from './sort';

let pos: Float32Array | null = null;
let count = 0;
let scratch = makeScratch(0);

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'positions') {
    pos = m.pos; count = m.count; scratch = makeScratch(count);
  } else if (m.type === 'sort' && pos) {
    const out = new Uint32Array(count);
    sortByDepth(pos, count, m.dir[0], m.dir[1], m.dir[2], out, scratch);
    (self as any).postMessage({ order: out, gen: m.gen, key: m.key }, [out.buffer]);
  }
};
