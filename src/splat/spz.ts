// Reader for Niantic .spz (gzip container, versions 2 and 3). Spherical harmonics above band 0 are skipped:
// 22PM relights the splat, so view-dependent baked colour is not used.
import { gunzipSync } from 'fflate';
import { allocSplat, type SplatData } from './types';
import { srgbToLinear } from '../core/color';

const SH_C0 = 0.28209479177387814;
const MAGIC = 0x5053474e;

export function parseSpz(buf: ArrayBuffer): SplatData {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not an SPZ file');
  const version = dv.getUint32(4, true);
  if (version < 2 || version > 3) throw new Error(`Unsupported SPZ version ${version}`);
  const n = dv.getUint32(8, true);
  const fractionalBits = bytes[13];
  const rotBytes = version >= 3 ? 4 : 3;
  let o = 16;
  const need = o + n * (9 + 1 + 3 + 3 + rotBytes);
  if (bytes.length < need) throw new Error('SPZ is truncated');
  const out = allocSplat(n);
  const posScale = 1 / (1 << fractionalBits);
  for (let i = 0; i < n * 3; i++, o += 3) {
    let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
    if (v & 0x800000) v |= ~0xffffff;
    out.pos[i] = v * posScale;
  }
  for (let i = 0; i < n; i++) out.opacity[i] = bytes[o++] / 255;
  for (let i = 0; i < n * 3; i++) {
    const dc = (bytes[o++] / 255 - 0.5) / 0.15;
    out.color[i] = srgbToLinear(Math.min(1, Math.max(0, 0.5 + SH_C0 * dc)));
  }
  for (let i = 0; i < n * 3; i++) out.scale[i] = Math.exp(bytes[o++] / 16 - 10);
  if (version >= 3) {
    const S = Math.SQRT1_2;
    for (let i = 0; i < n; i++, o += 4) {
      let comp = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
      const largest = comp >>> 30;
      let sum = 0;
      for (let k = 3; k >= 0; k--) {
        if (k === largest) continue;
        const mag = comp & 511, neg = (comp >>> 9) & 1;
        comp >>>= 10;
        const v = ((S * mag) / 511) * (neg ? -1 : 1);
        out.quat[i * 4 + k] = v;
        sum += v * v;
      }
      out.quat[i * 4 + largest] = Math.sqrt(Math.max(0, 1 - sum));
    }
  } else {
    for (let i = 0; i < n; i++, o += 3) {
      const x = bytes[o] / 127.5 - 1, y = bytes[o + 1] / 127.5 - 1, z = bytes[o + 2] / 127.5 - 1;
      out.quat[i * 4] = x; out.quat[i * 4 + 1] = y; out.quat[i * 4 + 2] = z;
      out.quat[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    }
  }
  return out;
}

export function parseSplatFile(name: string, buf: ArrayBuffer): SplatData {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (/\.spz$/i.test(name) || (b[0] === 0x1f && b[1] === 0x8b)) return parseSpz(buf);
  return parsePly(buf);
}
import { parsePly } from './ply';
