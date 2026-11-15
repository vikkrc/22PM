// Import-time preprocessing (brief section 4): normals and the low-frequency luminance used for de-lighting.
import type { PreparedSplat, SplatData } from './types';

function percentileBounds(pos: Float32Array, n: number, axis: number): [number, number] {
  const step = Math.max(1, Math.floor(n / 20000));
  const s: number[] = [];
  for (let i = 0; i < n; i += step) s.push(pos[i * 3 + axis]);
  s.sort((a, b) => a - b);
  return [s[Math.floor(s.length * 0.01)], s[Math.min(s.length - 1, Math.floor(s.length * 0.99))]];
}

export function prepareSplat(s: SplatData): PreparedSplat {
  const n = s.count;
  const bx = percentileBounds(s.pos, n, 0), by = percentileBounds(s.pos, n, 1), bz = percentileBounds(s.pos, n, 2);
  const boundsMin: [number, number, number] = [bx[0], by[0], bz[0]];
  const boundsMax: [number, number, number] = [bx[1], by[1], bz[1]];
  const center: [number, number, number] = [(bx[0] + bx[1]) / 2, (by[0] + by[1]) / 2, (bz[0] + bz[1]) / 2];
  const diag = Math.hypot(bx[1] - bx[0], by[1] - by[0], bz[1] - bz[0]) || 1;

  // 1. Normal = shortest covariance axis, pointed away from the centre of the scan.
  //    (With solved capture cameras from Train this becomes "towards the cameras"; the shader can also flip to face the viewer.)
  const normal = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const sx = s.scale[i * 3], sy = s.scale[i * 3 + 1], sz = s.scale[i * 3 + 2];
    const axis = sx <= sy && sx <= sz ? 0 : sy <= sz ? 1 : 2;
    const x = s.quat[i * 4], y = s.quat[i * 4 + 1], z = s.quat[i * 4 + 2], w = s.quat[i * 4 + 3];
    let nx: number, ny: number, nz: number;
    if (axis === 0) { nx = 1 - 2 * (y * y + z * z); ny = 2 * (x * y + z * w); nz = 2 * (x * z - y * w); }
    else if (axis === 1) { nx = 2 * (x * y - z * w); ny = 1 - 2 * (x * x + z * z); nz = 2 * (y * z + x * w); }
    else { nx = 2 * (x * z + y * w); ny = 2 * (y * z - x * w); nz = 1 - 2 * (x * x + y * y); }
    const dx = s.pos[i * 3] - center[0], dy = s.pos[i * 3 + 1] - center[1], dz = s.pos[i * 3 + 2] - center[2];
    if (nx * dx + ny * dy + nz * dz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    normal[i * 3] = nx; normal[i * 3 + 1] = ny; normal[i * 3 + 2] = nz;
  }

  // 2. Smooth against neighbours: average inside a voxel grid, sign-aligned so opposite faces do not cancel.
  const cell = diag / 96;
  const key = (i: number, c: number) => {
    const x = Math.floor((s.pos[i * 3] - boundsMin[0]) / c), y = Math.floor((s.pos[i * 3 + 1] - boundsMin[1]) / c), z = Math.floor((s.pos[i * 3 + 2] - boundsMin[2]) / c);
    return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
  };
  const acc = new Map<number, Float32Array>();
  for (let i = 0; i < n; i++) {
    const k = key(i, cell);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = new Float32Array(3)));
    const wgt = s.opacity[i];
    const sign = a[0] * normal[i * 3] + a[1] * normal[i * 3 + 1] + a[2] * normal[i * 3 + 2] < 0 ? -1 : 1;
    a[0] += normal[i * 3] * wgt * sign; a[1] += normal[i * 3 + 1] * wgt * sign; a[2] += normal[i * 3 + 2] * wgt * sign;
  }
  for (let i = 0; i < n; i++) {
    const a = acc.get(key(i, cell))!;
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < 1e-6) continue;
    let ax = a[0] / l, ay = a[1] / l, az = a[2] / l;
    if (ax * normal[i * 3] + ay * normal[i * 3 + 1] + az * normal[i * 3 + 2] < 0) { ax = -ax; ay = -ay; az = -az; }
    const nx = normal[i * 3] + ax, ny = normal[i * 3 + 1] + ay, nz = normal[i * 3 + 2] + az;
    const m = Math.hypot(nx, ny, nz) || 1;
    normal[i * 3] = nx / m; normal[i * 3 + 1] = ny / m; normal[i * 3 + 2] = nz / m;
  }

  // 3. Low-frequency luminance: coarse voxel average blurred over the 3×3×3 neighbourhood.
  const coarse = diag / 14;
  const lum = (i: number) => 0.2126 * s.color[i * 3] + 0.7152 * s.color[i * 3 + 1] + 0.0722 * s.color[i * 3 + 2];
  const cells = new Map<string, [number, number]>();
  const ck = (i: number): [number, number, number] => [
    Math.floor((s.pos[i * 3] - boundsMin[0]) / coarse), Math.floor((s.pos[i * 3 + 1] - boundsMin[1]) / coarse), Math.floor((s.pos[i * 3 + 2] - boundsMin[2]) / coarse),
  ];
  let total = 0, totalW = 0;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = ck(i);
    const k = `${x},${y},${z}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = [0, 0]));
    const wgt = s.opacity[i], L = lum(i);
    c[0] += L * wgt; c[1] += wgt;
    total += L * wgt; totalW += wgt;
  }
  const blurred = new Map<string, number>();
  for (const k of cells.keys()) {
    const [x, y, z] = k.split(',').map(Number);
    let a = 0, w = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = cells.get(`${x + dx},${y + dy},${z + dz}`);
      if (!c) continue;
      const kw = dx === 0 && dy === 0 && dz === 0 ? 2 : 1;
      a += c[0] * kw; w += c[1] * kw;
    }
    blurred.set(k, w > 0 ? a / w : 0);
  }
  const meanLum = totalW > 0 ? total / totalW : 0.2;
  const lowLum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = ck(i);
    lowLum[i] = blurred.get(`${x},${y},${z}`) ?? meanLum;
  }
  return { ...s, normal, lowLum, meanLum, boundsMin, boundsMax, center };
}
