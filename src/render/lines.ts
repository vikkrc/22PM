// Editor overlay geometry (light wireframes, grid, bounds). Lines only; never part of the output.
import { composeTRS, eulerToQuat, transformPoint, v3, DEG, type Mat4, type Vec3 } from '../core/math';
import type { FrameState, LightState } from '../core/evaluate';
import type { SplatInstance } from '../core/model';

export type RGBA = [number, number, number, number];

export class LineBuf {
  private data: number[] = [];
  line(a: Vec3, b: Vec3, c: RGBA) { this.data.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c[0], c[1], c[2], c[3]); }
  circle(center: Vec3, u: Vec3, v: Vec3, r: number, c: RGBA, seg = 40) {
    let prev = v3.add(center, v3.scale(u, r));
    for (let i = 1; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const p = v3.add(center, v3.add(v3.scale(u, Math.cos(a) * r), v3.scale(v, Math.sin(a) * r)));
      this.line(prev, p, c);
      prev = p;
    }
  }
  sphere(center: Vec3, r: number, c: RGBA) {
    this.circle(center, [1, 0, 0], [0, 1, 0], r, c); this.circle(center, [1, 0, 0], [0, 0, 1], r, c); this.circle(center, [0, 1, 0], [0, 0, 1], r, c);
  }
  box(min: Vec3, max: Vec3, m: Mat4 | null, c: RGBA) {
    const p = (i: number): Vec3 => { const q: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]; return m ? transformPoint(m, q) : q; };
    for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) this.line(p(a), p(b), c);
  }
  build() { return new Float32Array(this.data); }
}

export function basis(dir: Vec3): [Vec3, Vec3] {
  let r = v3.cross(dir, [0, 1, 0]);
  if (v3.len(r) < 1e-5) r = [1, 0, 0];
  r = v3.norm(r);
  return [r, v3.cross(r, dir)];
}

export function lightGizmo(buf: LineBuf, l: LightState, selected: boolean, sceneCenter: Vec3) {
  const lum = Math.max(l.color[0], l.color[1], l.color[2], 1e-3);
  const a = selected ? 1 : 0.55;
  const c: RGBA = [0.35 + 0.65 * l.color[0] / lum, 0.35 + 0.65 * l.color[1] / lum, 0.35 + 0.65 * l.color[2] / lum, a];
  const faint: RGBA = [c[0], c[1], c[2], selected ? 0.35 : 0.12];
  if (l.type === 'point') {
    buf.sphere(l.pos, Math.max(l.radius, 0.06), c);
    if (selected) buf.sphere(l.pos, l.range, faint);
  } else if (l.type === 'spot') {
    const [r, u] = basis(l.dir);
    const len = selected ? l.range : Math.min(l.range, 1.2);
    const rad = Math.tan((l.cone * DEG) / 2) * len;
    const end = v3.add(l.pos, v3.scale(l.dir, len));
    buf.circle(end, r, u, rad, selected ? c : faint);
    if (selected && l.penumbra > 0) buf.circle(end, r, u, Math.tan(((l.cone * DEG) / 2) * (1 - l.penumbra)) * len, faint);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      buf.line(l.pos, v3.add(end, v3.add(v3.scale(r, Math.cos(ang) * rad), v3.scale(u, Math.sin(ang) * rad))), selected ? c : faint);
    }
    buf.sphere(l.pos, 0.05, c);
  } else if (l.type === 'area') {
    const [r, u] = basis(l.dir);
    if (l.disc) {
      let prev: Vec3 | null = null;
      for (let i = 0; i <= 40; i++) {
        const ang = (i / 40) * Math.PI * 2;
        const p = v3.add(l.pos, v3.add(v3.scale(r, Math.cos(ang) * l.width / 2), v3.scale(u, Math.sin(ang) * l.height / 2)));
        if (prev) buf.line(prev, p, c);
        prev = p;
      }
    } else {
      const k = (sx: number, sy: number) => v3.add(l.pos, v3.add(v3.scale(r, sx * l.width / 2), v3.scale(u, sy * l.height / 2)));
      buf.line(k(-1, -1), k(1, -1), c); buf.line(k(1, -1), k(1, 1), c); buf.line(k(1, 1), k(-1, 1), c); buf.line(k(-1, 1), k(-1, -1), c);
    }
    buf.line(l.pos, v3.add(l.pos, v3.scale(l.dir, selected ? Math.min(l.range, 3) : 0.5)), selected ? c : faint);
  } else {
    // Sun: a bundle of parallel rays above the scene.
    const [r, u] = basis(l.dir);
    const o = v3.sub(sceneCenter, v3.scale(l.dir, 4));
    buf.circle(o, r, u, 0.35, c);
    for (const [x, y] of [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) {
      const s = v3.add(o, v3.add(v3.scale(r, x), v3.scale(u, y)));
      buf.line(s, v3.add(s, v3.scale(l.dir, selected ? 1.6 : 0.8)), selected ? c : faint);
    }
  }
}

export const sunGizmoPos = (l: LightState, sceneCenter: Vec3): Vec3 => v3.sub(sceneCenter, v3.scale(l.dir, 4));

export function grid(buf: LineBuf, size = 10) {
  for (let i = -size; i <= size; i++) {
    const c: RGBA = i === 0 ? [0.5, 0.5, 0.55, 0.35] : [0.5, 0.5, 0.55, i % 5 === 0 ? 0.16 : 0.07];
    buf.line([i, 0, -size], [i, 0, size], c);
    buf.line([-size, 0, i], [size, 0, i], c);
  }
}

export function cameraFrustum(buf: LineBuf, cam: FrameState['camera'], aspect: number, c: RGBA) {
  const f = v3.norm(v3.sub(cam.target, cam.pos));
  const [r, u] = basis(f);
  const d = 0.6, h = Math.tan((cam.fov * DEG) / 2) * d, w = h * aspect;
  const k = (sx: number, sy: number) => v3.add(cam.pos, v3.add(v3.scale(f, d), v3.add(v3.scale(r, sx * w), v3.scale(u, sy * h))));
  const pts = [k(-1, -1), k(1, -1), k(1, 1), k(-1, 1)];
  for (let i = 0; i < 4; i++) { buf.line(cam.pos, pts[i], c); buf.line(pts[i], pts[(i + 1) % 4], c); }
  buf.line(cam.pos, cam.target, [c[0], c[1], c[2], 0.2]);
}

export function instanceMatrix(s: SplatInstance): Mat4 {
  return composeTRS(s.pos, eulerToQuat(...s.rot), [s.scale, s.scale, s.scale]);
}
