// Back-to-front counting sort by view depth. Used from the worker (live) and directly (frame-stepped render).
export function sortByDepth(worldPos: Float32Array, count: number, vx: number, vy: number, vz: number, out: Uint32Array, scratch: { depth: Float32Array; counts: Uint32Array }): void {
  const depth = scratch.depth;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = worldPos[i * 3] * vx + worldPos[i * 3 + 1] * vy + worldPos[i * 3 + 2] * vz;
    depth[i] = d;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const B = 65536;
  const counts = scratch.counts;
  counts.fill(0);
  const k = max > min ? (B - 1) / (max - min) : 0;
  // Bucket 0 = farthest. d is distance along the view direction, so far = large d.
  for (let i = 0; i < count; i++) counts[((max - depth[i]) * k) | 0]++;
  let sum = 0;
  for (let i = 0; i < B; i++) { const c = counts[i]; counts[i] = sum; sum += c; }
  for (let i = 0; i < count; i++) out[counts[((max - depth[i]) * k) | 0]++] = i;
}

export const makeScratch = (count: number) => ({ depth: new Float32Array(count), counts: new Uint32Array(65536) });
