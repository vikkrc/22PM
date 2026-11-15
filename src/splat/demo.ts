// Procedural stand-in scans, so the lighting tools can be tried (and golden-tested) without a real capture.
// Deterministic: same seed, same splat.
import { mulberry32 } from '../core/rng';
import { allocSplat, type SplatData } from './types';

type V = [number, number, number];

function quatFromNormal(n: V, spin: number): [number, number, number, number] {
  // Rotate +Z onto n, then spin around it.
  const z: V = [0, 0, 1];
  const d = n[2];
  let q: [number, number, number, number];
  if (d < -0.99999) q = [1, 0, 0, 0];
  else {
    const c: V = [z[1] * n[2] - z[2] * n[1], z[2] * n[0] - z[0] * n[2], z[0] * n[1] - z[1] * n[0]];
    const w = 1 + d;
    const l = Math.hypot(c[0], c[1], c[2], w);
    q = [c[0] / l, c[1] / l, c[2] / l, w / l];
  }
  const s = Math.sin(spin / 2), cs = Math.cos(spin / 2);
  const [x, y, zq, w] = q;
  return [x * cs + y * s, y * cs - x * s, zq * cs + w * s, w * cs - zq * s];
}

class Builder {
  pos: number[] = []; scale: number[] = []; quat: number[] = []; color: number[] = []; opacity: number[] = [];
  constructor(public rnd: () => number) {}
  surfel(p: V, n: V, size: number, col: V, alpha = 0.92) {
    const r = this.rnd;
    this.pos.push(p[0], p[1], p[2]);
    this.scale.push(size * (0.7 + r() * 0.8), size * (0.7 + r() * 0.8), size * 0.12);
    this.quat.push(...quatFromNormal(n, r() * 6.283));
    this.color.push(col[0], col[1], col[2]);
    this.opacity.push(alpha * (0.75 + r() * 0.25));
  }
  build(): SplatData {
    const n = this.opacity.length;
    const s = allocSplat(n);
    s.pos.set(this.pos); s.scale.set(this.scale); s.quat.set(this.quat); s.color.set(this.color); s.opacity.set(this.opacity);
    return s;
  }
}

const norm = (v: V): V => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
function vnoise(x: number, y: number, z: number): number {
  return (Math.sin(x * 1.7 + y * 2.3) * Math.cos(z * 1.3 - x * 0.7) + Math.sin(y * 3.1 + z * 1.9) * 0.5 + Math.sin(x * 5.3 + z * 4.1 + y * 2.2) * 0.25) / 1.75;
}
// A fake "baked" light from the upper left so de-lighting has something to remove.
const baked = (n: V) => 0.45 + 0.55 * Math.max(0, n[0] * -0.5 + n[1] * 0.75 + n[2] * 0.4);

function box(b: Builder, c: V, half: V, col: V, density: number, size: number) {
  const faces: [V, V, V][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 1, 0], [1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const hu = Math.abs(u[0] * half[0] + u[1] * half[1] + u[2] * half[2]);
    const hv = Math.abs(v[0] * half[0] + v[1] * half[1] + v[2] * half[2]);
    const hn = Math.abs(n[0] * half[0] + n[1] * half[1] + n[2] * half[2]);
    const count = Math.max(4, Math.round(hu * hv * 4 * density));
    for (let i = 0; i < count; i++) {
      const a = (b.rnd() * 2 - 1) * hu, bb = (b.rnd() * 2 - 1) * hv;
      const p: V = [c[0] + n[0] * hn + u[0] * a + v[0] * bb, c[1] + n[1] * hn + u[1] * a + v[1] * bb, c[2] + n[2] * hn + u[2] * a + v[2] * bb];
      const t = 0.8 + 0.3 * vnoise(p[0] * 3, p[1] * 3, p[2] * 3);
      const k = baked(n) * t;
      b.surfel(p, n, size, [col[0] * k, col[1] * k, col[2] * k]);
    }
  }
}

/** A courtyard: rough ground, a ring of standing empty frames, a boulder and a few slabs. ~`budget` Gaussians. */
export function makeDemoCourtyard(budget = 180000, seed = 22): SplatData {
  const b = new Builder(mulberry32(seed));
  const r = b.rnd;
  const D = budget / 180000;
  // Ground disc with gentle relief.
  const groundN = Math.round(70000 * D);
  for (let i = 0; i < groundN; i++) {
    const rad = Math.sqrt(r()) * 7, a = r() * 6.283;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    const h = (xx: number, zz: number) => 0.09 * vnoise(xx * 0.9, 0, zz * 0.9) + 0.02 * vnoise(xx * 4, 1, zz * 4);
    const y = h(x, z);
    const n = norm([-(h(x + 0.05, z) - y) / 0.05, 1, -(h(x, z + 0.05) - y) / 0.05]);
    const t = 0.5 + 0.5 * vnoise(x * 1.5, 3, z * 1.5);
    const edge = 1 - Math.pow(rad / 7, 6);
    const g = 0.2 + 0.16 * t;
    b.surfel([x, y, z], n, 0.05, [g * 1.02 * baked(n), g * 0.95 * baked(n), g * 0.85 * baked(n)], 0.92 * edge + 0.02);
  }
  // Standing frames (the stage concept's empty frames), in an arc.
  const frames = 5;
  for (let f = 0; f < frames; f++) {
    const a = -0.9 + (f / (frames - 1)) * 1.8;
    const cx = Math.sin(a) * 3.6, cz = -Math.cos(a) * 3.6 + 0.6;
    const w = 0.75 + 0.2 * Math.sin(f * 2.1), hgt = 1.7 + 0.5 * Math.cos(f * 1.3);
    const yaw = -a;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const bar = (lx: number, ly: number, hx: number, hy: number) => {
      // Thin box in the frame's local XY plane, rotated by yaw.
      const count = Math.round((hx + hy) * 2 * 2600 * D);
      for (let i = 0; i < count; i++) {
        const face = Math.floor(r() * 4);
        let px = lx + (r() * 2 - 1) * hx, py = ly + (r() * 2 - 1) * hy, pz = (r() * 2 - 1) * 0.05;
        let n: V = [0, 0, 1];
        if (face === 0) { pz = 0.05; n = [0, 0, 1]; }
        else if (face === 1) { pz = -0.05; n = [0, 0, -1]; }
        else if (hx > hy) { py = ly + (face === 2 ? hy : -hy); n = [0, face === 2 ? 1 : -1, 0]; }
        else { px = lx + (face === 2 ? hx : -hx); n = [face === 2 ? 1 : -1, 0, 0]; }
        const wp: V = [cx + px * cs + pz * sn, py, cz - px * sn + pz * cs];
        const wn: V = [n[0] * cs + n[2] * sn, n[1], -n[0] * sn + n[2] * cs];
        const k = baked(wn) * (0.85 + 0.2 * vnoise(wp[0] * 6, wp[1] * 6, wp[2] * 6));
        b.surfel(wp, wn, 0.018, [0.62 * k, 0.5 * k, 0.36 * k]);
      }
    };
    bar(-w, hgt / 2 + 0.2, 0.05, hgt / 2); bar(w, hgt / 2 + 0.2, 0.05, hgt / 2);
    bar(0, hgt + 0.2, w + 0.05, 0.05); bar(0, 0.2, w + 0.05, 0.05);
  }
  // Boulder.
  const rockN = Math.round(42000 * D);
  for (let i = 0; i < rockN; i++) {
    const u = r() * 2 - 1, a = r() * 6.283;
    const s = Math.sqrt(1 - u * u);
    const d: V = [s * Math.cos(a), u, s * Math.sin(a)];
    const bump = 1 + 0.22 * vnoise(d[0] * 2.2, d[1] * 2.2, d[2] * 2.2) + 0.06 * vnoise(d[0] * 9, d[1] * 9, d[2] * 9);
    const R: V = [0.95 * bump, 0.7 * bump, 0.8 * bump];
    const p: V = [d[0] * R[0] - 0.4, d[1] * R[1] + 0.55, d[2] * R[2] + 0.3];
    if (p[1] < 0) continue;
    const n = norm([d[0] / R[0], d[1] / R[1], d[2] / R[2]]);
    const t = 0.75 + 0.3 * vnoise(p[0] * 5, p[1] * 5, p[2] * 5);
    const k = baked(n) * t;
    b.surfel(p, n, 0.022, [0.34 * k, 0.33 * k, 0.36 * k]);
  }
  // Slabs and a small coloured object for scale.
  box(b, [1.9, 0.25, 0.9], [0.55, 0.25, 0.4], [0.42, 0.4, 0.38], 5200 * D, 0.02);
  box(b, [2.1, 0.62, 0.95], [0.3, 0.12, 0.28], [0.5, 0.3, 0.22], 6500 * D, 0.018);
  box(b, [-2.3, 0.6, 1.4], [0.12, 0.6, 0.12], [0.2, 0.34, 0.42], 9000 * D, 0.016);
  return b.build();
}

/** A close-up object: a faceted, slightly bumpy vase-like form on a plinth. */
export function makeDemoObject(budget = 60000, seed = 7): SplatData {
  const b = new Builder(mulberry32(seed));
  const r = b.rnd;
  const n = Math.round(budget * 0.8);
  for (let i = 0; i < n; i++) {
    const t = r(), a = r() * 6.283;
    const prof = (tt: number) => 0.18 + 0.2 * Math.sin(tt * 3.0) * (1 - tt * 0.6) + 0.03 * Math.sin(tt * 40);
    const rad = prof(t) * (1 + 0.04 * Math.sin(a * 7));
    const y = t * 1.0 + 0.3;
    const dr = (prof(t + 0.01) - prof(t)) / 0.01;
    const nrm = norm([Math.cos(a), -dr, Math.sin(a)]);
    const k = baked(nrm) * (0.85 + 0.25 * vnoise(a * 3, y * 9, 1));
    b.surfel([Math.cos(a) * rad, y, Math.sin(a) * rad], nrm, 0.01, [0.75 * k, 0.42 * k, 0.2 * k]);
  }
  box(b, [0, 0.15, 0], [0.32, 0.15, 0.32], [0.5, 0.5, 0.5], budget * 0.2 / 1.0, 0.012);
  return b.build();
}
