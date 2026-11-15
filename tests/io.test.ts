import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { parsePly, writePly } from '../src/splat/ply';
import { parseSpz } from '../src/splat/spz';
import { makeDemoCourtyard } from '../src/splat/demo';
import { prepareSplat } from '../src/splat/preprocess';
import { analyze } from '../src/audio/analysis';

describe('splat files', () => {
  it('PLY round-trips', () => {
    const s = makeDemoCourtyard(3000);
    const back = parsePly(writePly(s));
    expect(back.count).toBe(s.count);
    for (const i of [0, 17, s.count - 1]) {
      expect(back.pos[i * 3 + 1]).toBeCloseTo(s.pos[i * 3 + 1], 5);
      expect(back.scale[i * 3]).toBeCloseTo(s.scale[i * 3], 5);
      expect(back.opacity[i]).toBeCloseTo(s.opacity[i], 4);
      expect(back.color[i * 3]).toBeCloseTo(s.color[i * 3], 4);
      expect(Math.abs(back.quat[i * 4 + 3])).toBeCloseTo(Math.abs(s.quat[i * 4 + 3]), 4);
    }
  });
  it('rejects junk', () => {
    expect(() => parsePly(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow();
    expect(() => parseSpz(new Uint8Array(32).buffer)).toThrow();
  });
  it('reads SPZ v2', () => {
    const n = 2;
    const b = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 3));
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x5053474e, true); dv.setUint32(4, 2, true); dv.setUint32(8, n, true);
    b[12] = 0; b[13] = 12;
    let o = 16;
    const put24 = (v: number) => { const i = Math.round(v * 4096) & 0xffffff; b[o++] = i & 255; b[o++] = (i >> 8) & 255; b[o++] = (i >> 16) & 255; };
    [1.5, -2.25, 0.125, -0.5, 3, 4].forEach(put24);
    b[o++] = 255; b[o++] = 128;
    for (let i = 0; i < 6; i++) b[o++] = 128;
    for (let i = 0; i < 6; i++) b[o++] = 160; // log scale 0 → 1
    for (let i = 0; i < 2; i++) { b[o++] = 127; b[o++] = 127; b[o++] = 255; }
    const s = parseSpz(gzipSync(b).buffer as ArrayBuffer);
    expect(s.count).toBe(2);
    expect(Array.from(s.pos)).toEqual([1.5, -2.25, 0.125, -0.5, 3, 4]);
    expect(s.opacity[0]).toBe(1);
    expect(s.scale[0]).toBeCloseTo(1);
    expect(s.quat[2]).toBeCloseTo(1, 1);
  });
});

describe('preprocessing', () => {
  it('produces unit normals that agree with the surface, and a de-light field', () => {
    const p = prepareSplat(makeDemoCourtyard(20000));
    let up = 0, total = 0;
    for (let i = 0; i < p.count; i++) {
      const l = Math.hypot(p.normal[i * 3], p.normal[i * 3 + 1], p.normal[i * 3 + 2]);
      expect(l).toBeCloseTo(1, 3);
      // Ground Gaussians (low, far from the objects) should have near-vertical normals.
      if (p.pos[i * 3 + 1] < 0.12 && Math.hypot(p.pos[i * 3], p.pos[i * 3 + 2]) > 5) { total++; if (Math.abs(p.normal[i * 3 + 1]) > 0.8) up++; }
    }
    expect(total).toBeGreaterThan(100);
    expect(up / total).toBeGreaterThan(0.9);
    expect(p.meanLum).toBeGreaterThan(0);
    expect(p.lowLum.every((v) => v > 0)).toBe(true);
    expect(p.boundsMax[0]).toBeGreaterThan(p.boundsMin[0]);
  });
});

describe('audio analysis', () => {
  function clickTrack(bpm: number, seconds: number, offset: number) {
    const sr = 44100;
    const pcm = new Float32Array(sr * seconds);
    const period = 60 / bpm;
    let n = 0;
    for (let t = offset; t < seconds - 0.2; t += period, n++) {
      const start = Math.round(t * sr);
      const kick = n % 4 === 0;
      for (let i = 0; i < sr * 0.08; i++) {
        const env = Math.exp(-i / (sr * 0.02));
        // Kick: low sine sweep on the bar; hats: seeded noise on the other beats.
        pcm[start + i] += kick ? Math.sin(2 * Math.PI * (55 + 60 * env) * (i / sr)) * env : (((i * 1103515245 + 12345) >>> 8) % 2000 / 1000 - 1) * env * 0.3;
      }
    }
    return { pcm, sr };
  }
  it('finds the tempo and grid of a click', () => {
    const { pcm, sr } = clickTrack(128, 24, 0.25);
    const a = analyze(pcm, sr);
    expect(a.bpm).toBeCloseTo(128, 0);
    const period = 60 / a.bpm;
    const phase = ((a.firstDownbeatSec - 0.25) % period + period) % period;
    expect(Math.min(phase, period - phase)).toBeLessThan(0.03);
    expect(a.onsets.kick.times.length).toBeGreaterThan(8);
    expect(a.frames).toBe(24 * 200);
    // Analysis is deterministic.
    const b = analyze(pcm, sr);
    expect(Array.from(b.onsets.kick.times)).toEqual(Array.from(a.onsets.kick.times));
  });
  it('handles a slower tempo', () => {
    const { pcm, sr } = clickTrack(92, 30, 0.1);
    expect(analyze(pcm, sr).bpm).toBeCloseTo(92, 0);
  });
});
