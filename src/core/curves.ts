// Keyframe curves: hold, linear and cubic-bezier eased segments.
import type { Ease, Keyframe } from './model';

/** Solve a CSS-style cubic-bezier easing: given progress x in 0..1 return y. */
export function cubicBezier(e: Ease, x: number): number {
  const [x1, y1, x2, y2] = e;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sx(t) - x;
    if (Math.abs(err) < 1e-7) break;
    const d = dx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  if (!(t >= 0 && t <= 1) || Math.abs(sx(t) - x) > 1e-5) {
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}

/** Keys must be sorted by t. Before the first key and after the last, the value holds. */
export function evalKeys(keys: Keyframe[], t: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = keys[lo], b = keys[hi];
  if (a.interp === 'hold') return a.v;
  const span = b.t - a.t;
  const x = span > 0 ? (t - a.t) / span : 1;
  const y = a.interp === 'bezier' ? cubicBezier(a.ease ?? [0.42, 0, 0.58, 1], x) : x;
  return a.v + (b.v - a.v) * y;
}

export const sortKeys = (keys: Keyframe[]) => [...keys].sort((a, b) => a.t - b.t);
