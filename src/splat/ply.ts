// Reader for the standard 3D Gaussian Splatting .ply layout (binary little endian).
import { allocSplat, type SplatData } from './types';
import { srgbToLinear } from '../core/color';

const SH_C0 = 0.28209479177387814;
const TYPE_SIZE: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

export function parsePly(buf: ArrayBuffer): SplatData {
  const bytes = new Uint8Array(buf);
  const headEnd = findHeaderEnd(bytes);
  if (headEnd < 0) throw new Error('Not a PLY file (no end_header)');
  const header = new TextDecoder().decode(bytes.subarray(0, headEnd));
  const lines = header.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new Error('Not a PLY file');
  if (!/format binary_little_endian/.test(header)) throw new Error('Only binary little-endian PLY is supported');
  let count = 0;
  let inVertex = false;
  const props: { name: string; type: string; offset: number }[] = [];
  let stride = 0;
  let preVertexBytes = 0;
  let curCount = 0, curStride = 0, seenVertex = false;
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'element') {
      if (!seenVertex && !inVertex) preVertexBytes += curCount * curStride;
      inVertex = t[1] === 'vertex';
      curCount = +t[2]; curStride = 0;
      if (inVertex) { count = +t[2]; seenVertex = true; }
    } else if (t[0] === 'property') {
      if (t[1] === 'list') { if (inVertex) throw new Error('List properties on vertices are not supported'); continue; }
      const size = TYPE_SIZE[t[1]];
      if (!size) throw new Error(`Unknown PLY type ${t[1]}`);
      if (inVertex) { props.push({ name: t[2], type: t[1], offset: stride }); stride += size; }
      curStride += size;
    }
  }
  if (!count) throw new Error('PLY has no vertices');
  const dv = new DataView(buf, headEnd + preVertexBytes);
  if (dv.byteLength < count * stride) throw new Error('PLY is truncated');
  const idx = new Map(props.map((p) => [p.name, p]));
  const reader = (name: string): ((i: number) => number) | null => {
    const p = idx.get(name);
    if (!p) return null;
    const o = p.offset;
    switch (p.type) {
      case 'float': case 'float32': return (i) => dv.getFloat32(i * stride + o, true);
      case 'double': case 'float64': return (i) => dv.getFloat64(i * stride + o, true);
      case 'uchar': case 'uint8': return (i) => dv.getUint8(i * stride + o);
      case 'char': case 'int8': return (i) => dv.getInt8(i * stride + o);
      case 'short': case 'int16': return (i) => dv.getInt16(i * stride + o, true);
      case 'ushort': case 'uint16': return (i) => dv.getUint16(i * stride + o, true);
      case 'int': case 'int32': return (i) => dv.getInt32(i * stride + o, true);
      default: return (i) => dv.getUint32(i * stride + o, true);
    }
  };
  const x = reader('x'), y = reader('y'), z = reader('z');
  if (!x || !y || !z) throw new Error('PLY has no x/y/z');
  const dc = [reader('f_dc_0'), reader('f_dc_1'), reader('f_dc_2')];
  const rgb = [reader('red'), reader('green'), reader('blue')];
  const op = reader('opacity');
  const sc = [reader('scale_0'), reader('scale_1'), reader('scale_2')];
  const rot = [reader('rot_0'), reader('rot_1'), reader('rot_2'), reader('rot_3')];
  const out = allocSplat(count);
  for (let i = 0; i < count; i++) {
    out.pos[i * 3] = x(i); out.pos[i * 3 + 1] = y(i); out.pos[i * 3 + 2] = z(i);
    for (let c = 0; c < 3; c++) {
      let v = 0.5;
      if (dc[c]) v = 0.5 + SH_C0 * dc[c]!(i);
      else if (rgb[c]) v = rgb[c]!(i) / 255;
      out.color[i * 3 + c] = srgbToLinear(Math.min(1, Math.max(0, v)));
      out.scale[i * 3 + c] = sc[c] ? Math.exp(sc[c]!(i)) : 0.01;
    }
    out.opacity[i] = op ? 1 / (1 + Math.exp(-op(i))) : 1;
    if (rot[0] && rot[1] && rot[2] && rot[3]) {
      // File order is w x y z.
      const w = rot[0](i), qx = rot[1](i), qy = rot[2](i), qz = rot[3](i);
      const l = Math.hypot(w, qx, qy, qz) || 1;
      out.quat[i * 4] = qx / l; out.quat[i * 4 + 1] = qy / l; out.quat[i * 4 + 2] = qz / l; out.quat[i * 4 + 3] = w / l;
    } else out.quat[i * 4 + 3] = 1;
  }
  return out;
}

function findHeaderEnd(b: Uint8Array): number {
  const key = [101, 110, 100, 95, 104, 101, 97, 100, 101, 114]; // end_header
  const lim = Math.min(b.length, 65536);
  outer: for (let i = 0; i < lim; i++) {
    for (let k = 0; k < key.length; k++) if (b[i + k] !== key[k]) continue outer;
    let j = i + key.length;
    if (b[j] === 13) j++;
    return j + 1;
  }
  return -1;
}

/** Writes a standard 3DGS .ply (used for the demo scene and tests; Edit hand-off later). */
export function writePly(s: SplatData): ArrayBuffer {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${s.count}\n${names.map((n) => `property float ${n}`).join('\n')}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(head.length + s.count * names.length * 4);
  new Uint8Array(buf).set(head);
  const dv = new DataView(buf, head.length);
  const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  for (let i = 0; i < s.count; i++) {
    let o = i * names.length * 4;
    const put = (v: number) => { dv.setFloat32(o, v, true); o += 4; };
    put(s.pos[i * 3]); put(s.pos[i * 3 + 1]); put(s.pos[i * 3 + 2]);
    for (let c = 0; c < 3; c++) put((toSrgb(s.color[i * 3 + c]) - 0.5) / SH_C0);
    const a = Math.min(0.9999, Math.max(0.0001, s.opacity[i]));
    put(Math.log(a / (1 - a)));
    for (let c = 0; c < 3; c++) put(Math.log(Math.max(1e-7, s.scale[i * 3 + c])));
    put(s.quat[i * 4 + 3]); put(s.quat[i * 4]); put(s.quat[i * 4 + 1]); put(s.quat[i * 4 + 2]);
  }
  return buf;
}
