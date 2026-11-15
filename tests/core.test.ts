import { describe, expect, it } from 'vitest';
import { beatToBBT, beatToSec, bbtToBeat, formatBBT, parseBBT, secToBeat, snapBeat, defaultTempo, formatLength, parseLength } from '../src/core/tempo';
import { cubicBezier, evalKeys } from '../src/core/curves';
import { adsrValue, evalBeat, evalLfo, evalSection, applyModulators, bandEnvelope, sampleEnvelope, evalOnset } from '../src/core/modulators';
import { makeClip, makeModulator, makeShow, type Keyframe, type LfoMod, type BeatMod, type SectionMod, type BandMod, type OnsetMod } from '../src/core/model';
import { evaluate, evalParam } from '../src/core/evaluate';
import { KINDS, paramDef, KIND_LIST } from '../src/core/registry';
import { MtcDecoder, chaseInit, chasePosition, chaseReceive, formatTimecode, locateSong, parseTimecode, secondsToSmpte, smpteToSeconds } from '../src/core/timecode';
import { ANALYSIS_BANDS, type Analysis } from '../src/core/analysisTypes';

const tm = { bpm: 128, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0.5 };

describe('tempo maths', () => {
  it('converts beats and seconds both ways', () => {
    expect(beatToSec(tm, 0)).toBe(0.5);
    expect(beatToSec(tm, 128)).toBeCloseTo(60.5, 9);
    expect(secToBeat(tm, beatToSec(tm, 37.25))).toBeCloseTo(37.25, 9);
  });
  it('formats and parses bars.beats.ticks', () => {
    expect(formatBBT(tm, 0)).toBe('1.1.000');
    expect(formatBBT(tm, 4.5)).toBe('2.1.480');
    expect(formatBBT(tm, -1)).toBe('0.4.000');
    expect(parseBBT(tm, '2.1.480')).toBe(4.5);
    expect(parseBBT(tm, '3')).toBe(8);
    expect(parseBBT(tm, 'x')).toBeNull();
    for (const b of [0, 1, 3.999, 17.5, 123.125]) expect(bbtToBeat(tm, beatToBBT(tm, b))).toBeCloseTo(b, 3);
    expect(parseLength(tm, formatLength(tm, 9.5))).toBe(9.5);
  });
  it('handles odd time signatures', () => {
    const t7 = { ...tm, beatsPerBar: 7 };
    expect(formatBBT(t7, 7)).toBe('2.1.000');
    expect(formatBBT(t7, 6)).toBe('1.7.000');
  });
  it('snaps to the grid', () => {
    expect(snapBeat(tm, 3.4, '1')).toBe(3);
    expect(snapBeat(tm, 3.4, 'bar')).toBe(4);
    expect(snapBeat(tm, 3.4, '1/4')).toBe(3.5);
    expect(snapBeat(tm, 3.4, 'off')).toBeCloseTo(3.4, 3);
  });
  it('moving the BPM moves everything with it', () => {
    const a = beatToSec({ ...defaultTempo(), bpm: 100 }, 50);
    const b = beatToSec({ ...defaultTempo(), bpm: 200 }, 50);
    expect(a).toBe(b * 2);
  });
});

const key = (t: number, v: number, interp: Keyframe['interp'] = 'linear', ease?: Keyframe['ease']): Keyframe => ({ id: `${t}`, t, v, interp, ease });

describe('curves', () => {
  it('bezier easing hits its end points and is monotonic for standard eases', () => {
    const e: [number, number, number, number] = [0.42, 0, 0.58, 1];
    expect(cubicBezier(e, 0)).toBe(0);
    expect(cubicBezier(e, 1)).toBe(1);
    expect(cubicBezier(e, 0.5)).toBeCloseTo(0.5, 5);
    let prev = 0;
    for (let x = 0; x <= 1; x += 0.01) { const y = cubicBezier(e, x); expect(y).toBeGreaterThanOrEqual(prev - 1e-6); prev = y; }
    expect(cubicBezier([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 5);
  });
  it('evaluates hold, linear and bezier segments and holds outside', () => {
    const keys = [key(0, 1, 'hold'), key(4, 3, 'linear'), key(8, 5, 'bezier'), key(12, 9)];
    expect(evalKeys(keys, -5)).toBe(1);
    expect(evalKeys(keys, 3.99)).toBe(1);
    expect(evalKeys(keys, 4)).toBe(3);
    expect(evalKeys(keys, 6)).toBe(4);
    expect(evalKeys(keys, 10)).toBeCloseTo(7, 5);
    expect(evalKeys(keys, 9)).toBeLessThan(6);
    expect(evalKeys(keys, 99)).toBe(9);
  });
});

function fakeAnalysis(): Analysis {
  const rate = 200, frames = rate * 10;
  const bands = new Float32Array(frames * ANALYSIS_BANDS);
  // A burst in every band at 2.0 s lasting 50 ms.
  for (let f = 400; f < 410; f++) for (let b = 0; b < ANALYSIS_BANDS; b++) bands[f * ANALYSIS_BANDS + b] = 1;
  const ol = (t: number[], s: number[]) => ({ times: Float32Array.from(t), strengths: Float32Array.from(s) });
  return {
    version: 1, duration: 10, rate, frames, bands,
    onsets: { kick: ol([1, 1.05, 2, 3], [1, 0.9, 0.3, 1]), snare: ol([1.5], [1]), other: ol([], []) },
    bpm: 120, firstDownbeatSec: 0, beatsPerBar: 4, peaks: new Float32Array(0), peaksPerSec: 100,
  };
}

describe('modulators', () => {
  const lfo = (o: Partial<LfoMod>) => ({ ...(makeModulator('lfo', 1) as LfoMod), ...o });
  it('LFO shapes are locked to the beat grid', () => {
    const s = lfo({ waveform: 'sine', rateBeats: 4 });
    expect(evalLfo(s, 0)).toBeCloseTo(-1, 6);
    expect(evalLfo(s, 2)).toBeCloseTo(1, 6);
    expect(evalLfo(s, 4)).toBeCloseTo(-1, 6);
    expect(evalLfo(lfo({ waveform: 'sawUp', rateBeats: 1, bipolar: false }), 2.25)).toBeCloseTo(0.25, 6);
    expect(evalLfo(lfo({ waveform: 'square', rateBeats: 2, bipolar: false, pulseWidth: 0.25 }), 0.4)).toBe(1);
    expect(evalLfo(lfo({ waveform: 'square', rateBeats: 2, bipolar: false, pulseWidth: 0.25 }), 0.6)).toBe(0);
  });
  it('dotted and triplet change the period', () => {
    expect(evalLfo(lfo({ waveform: 'sawUp', rateBeats: 1, feel: 'dotted', bipolar: false }), 0.75)).toBeCloseTo(0.5, 6);
    expect(evalLfo(lfo({ waveform: 'sawUp', rateBeats: 1, feel: 'triplet', bipolar: false }), 1 / 3)).toBeCloseTo(0.5, 6);
  });
  it('random LFOs are seeded and repeatable', () => {
    const r = lfo({ waveform: 'random', rateBeats: 1, seed: 5 });
    expect(evalLfo(r, 3.2)).toBe(evalLfo(r, 3.9));
    expect(evalLfo(r, 3.2)).not.toBe(evalLfo(r, 4.1));
    expect(evalLfo(r, 3.2)).not.toBe(evalLfo({ ...r, seed: 6 }, 3.2));
    const sm = lfo({ waveform: 'smoothRandom', rateBeats: 1, seed: 5 });
    expect(Math.abs(evalLfo(sm, 3.999) - evalLfo(sm, 4.001))).toBeLessThan(0.01);
  });
  it('ADSR', () => {
    const e = { a: 0.1, d: 0.1, s: 0.5, hold: 0.2, r: 0.2 };
    expect(adsrValue(e, -1)).toBe(0);
    expect(adsrValue(e, 0.05)).toBeCloseTo(0.5);
    expect(adsrValue(e, 0.1)).toBeCloseTo(1);
    expect(adsrValue(e, 0.3)).toBeCloseTo(0.5);
    expect(adsrValue(e, 0.5)).toBeCloseTo(0.25);
    expect(adsrValue(e, 1)).toBe(0);
  });
  it('beat trigger fires every N beats with offset and seeded probability', () => {
    const m = { ...(makeModulator('beat', 1) as BeatMod), every: 2, offset: 1, env: { a: 0, d: 0.1, s: 0, hold: 0, r: 0 } };
    expect(evalBeat(m, tm, 1)).toBeCloseTo(1);
    expect(evalBeat(m, tm, 3)).toBeCloseTo(1);
    expect(evalBeat(m, tm, 2)).toBe(0);
    const p = { ...m, probability: 0.5, seed: 3 };
    const fired = Array.from({ length: 200 }, (_, i) => evalBeat(p, tm, 1 + i * 2) > 0.5);
    const count = fired.filter(Boolean).length;
    expect(count).toBeGreaterThan(60);
    expect(count).toBeLessThan(140);
    expect(fired).toEqual(Array.from({ length: 200 }, (_, i) => evalBeat(p, tm, 1 + i * 2) > 0.5));
  });
  it('section modulator crossfades between section values', () => {
    const sections = [{ id: 'a', name: 'A', start: 0 }, { id: 'b', name: 'B', start: 16 }];
    const m = { ...(makeModulator('section', 1) as SectionMod), values: { a: 0.2, b: 1 }, crossfade: 4 };
    expect(evalSection(m, sections, 8)).toBe(0.2);
    expect(evalSection(m, sections, 18)).toBeCloseTo(0.6);
    expect(evalSection(m, sections, 30)).toBe(1);
  });
  it('band envelope follows the analysis with attack and release', () => {
    const an = fakeAnalysis();
    const m = { ...(makeModulator('band', 1) as BandMod), attack: 0, release: 0.1 };
    const env = bandEnvelope(an, m);
    expect(sampleEnvelope(env, an.rate, 1.9)).toBe(0);
    expect(sampleEnvelope(env, an.rate, 2.02)).toBeCloseTo(1);
    const tail = sampleEnvelope(env, an.rate, 2.1);
    expect(tail).toBeGreaterThan(0.2);
    expect(tail).toBeLessThan(0.8);
    expect(bandEnvelope(an, m)).toBe(env); // memoised
  });
  it('onset trigger respects sensitivity and retrigger', () => {
    const an = fakeAnalysis();
    const env = { a: 0, d: 0.2, s: 0, hold: 0, r: 0 };
    const m = { ...(makeModulator('onset', 1) as OnsetMod), env, sensitivity: 0.5 };
    expect(evalOnset(m, an, 0.9)).toBe(0);
    expect(evalOnset(m, an, 1.0)).toBeCloseTo(1);
    expect(evalOnset(m, an, 1.05)).toBeCloseTo(1); // retriggered by the 1.05 onset
    expect(evalOnset({ ...m, retrigger: false }, an, 1.05)).toBeCloseTo(0.75);
    expect(evalOnset(m, an, 2.0)).toBeLessThan(0.01); // 0.3-strength onset is below threshold
    expect(evalOnset({ ...m, sensitivity: 0.9 }, an, 2.0)).toBeCloseTo(1);
  });
  it('stack: add, multiply, replace', () => {
    const ctx = { tempo: tm, beat: 2, sec: 1, analysis: null, sections: [] };
    const up = lfo({ waveform: 'sine', rateBeats: 4, bipolar: false }); // = 1 at beat 2
    expect(applyModulators(10, [{ ...up, depth: 3 }], ctx, 0, 100)).toBeCloseTo(13);
    expect(applyModulators(10, [{ ...up, depth: 3, enabled: false }], ctx, 0, 100)).toBe(10);
    expect(applyModulators(10, [{ ...up, blend: 'multiply', depth: 1 }], { ...ctx, beat: 0 }, 0, 100)).toBeCloseTo(0);
    expect(applyModulators(10, [{ ...up, blend: 'replace', depth: 1 }], ctx, 0, 100)).toBeCloseTo(100);
  });
});

describe('registry', () => {
  it('every parameter is declared once with a sane range', () => {
    for (const k of KIND_LIST) {
      const ids = new Set<string>();
      for (const p of k.params) {
        expect(ids.has(p.id)).toBe(false);
        ids.add(p.id);
        expect(p.min).toBeLessThanOrEqual(p.def);
        expect(p.max).toBeGreaterThanOrEqual(p.def);
        if (p.type !== 'float') expect(p.mod).toBe(false);
        expect(paramDef(k.kind, p.id)).toBe(p);
      }
    }
  });
});

describe('evaluate', () => {
  function song() {
    const show = makeShow();
    const s = show.songs[0];
    s.tempo = { ...tm, firstDownbeatSec: 0 };
    const spot = makeClip('light.spot', 4, 8);
    spot.fadeIn = 2; spot.fadeOut = 2;
    spot.params.intensity = { base: 10, mods: [{ ...(makeModulator('lfo', 5) as LfoMod), waveform: 'random', rateBeats: 0.5 }] };
    spot.params['pos.x'] = { base: 0, keys: [key(0, -2, 'bezier'), key(8, 2)] };
    s.tracks[1].clips.push(spot);
    const cam = makeClip('camera', 8, 8);
    cam.params.fov = { base: 90 };
    cam.fadeIn = 4;
    s.tracks[0].clips.push(cam);
    const dis = makeClip('anim.disperse', 0, 16);
    s.tracks[3].clips.push(dis);
    return { show, s, spot };
  }
  it('is a pure function of project and time', () => {
    const { show, s } = song();
    const secs = [0, 1.234, 3.3, 5.5, 2.2, 1.234];
    const a = secs.map((t) => JSON.stringify(evaluate(show, s, t)));
    const b = [...secs].reverse().map((t) => JSON.stringify(evaluate(show, s, t))).reverse();
    expect(a).toEqual(b);
    expect(a[1]).toBe(a[5]);
    const copy = JSON.parse(JSON.stringify(show));
    expect(JSON.stringify(evaluate(copy, copy.songs[0], 3.3))).toBe(a[2]);
  });
  it('lights exist only for the length of their clip, with fades', () => {
    const { show, s } = song();
    const at = (beat: number) => evaluate(show, s, beatToSec(s.tempo, beat));
    expect(at(3.9).lights.length).toBe(0);
    expect(at(4).lights.length).toBe(1);
    expect(at(4).lights[0].intensity).toBe(0);
    expect(at(12).lights.length).toBe(0);
    const mid = at(8);
    expect(mid.lights[0].pos[0]).toBeCloseTo(0, 4);
    expect(mid.lights[0].intensity).toBeGreaterThan(4.9);
    expect(mid.lights[0].intensity).toBeLessThan(15.1);
  });
  it('exclusive clips crossfade over the base layer', () => {
    const { show, s } = song();
    const at = (beat: number) => evaluate(show, s, beatToSec(s.tempo, beat));
    expect(at(7).camera.fov).toBe(45);
    expect(at(10).camera.fov).toBeCloseTo(67.5);
    expect(at(13).camera.fov).toBe(90);
    expect(at(17).camera.fov).toBe(45);
  });
  it('clamps to the registry range', () => {
    const def = paramDef('light.spot', 'cone')!;
    const ctx = { tempo: tm, beat: 0, sec: 0, analysis: null, sections: [] };
    expect(evalParam(def, { base: 9999 }, 0, ctx)).toBe(def.max);
    expect(evalParam(def, undefined, 0, ctx)).toBe(def.def);
  });
  it('muted clips and tracks are skipped', () => {
    const { show, s, spot } = song();
    spot.muted = true;
    expect(evaluate(show, s, beatToSec(s.tempo, 8)).lights.length).toBe(0);
    spot.muted = false; s.tracks[1].muted = true;
    expect(evaluate(show, s, beatToSec(s.tempo, 8)).lights.length).toBe(0);
    expect(KINDS['light.spot'].exclusive).toBe(false);
  });
});

describe('timecode', () => {
  it('parses and formats SMPTE', () => {
    const t = parseTimecode('01:02:03:04')!;
    expect(smpteToSeconds(t, 25)).toBeCloseTo(3723.16);
    expect(formatTimecode(secondsToSmpte(3723.16, 25))).toBe('01:02:03:04');
    expect(parseTimecode('nope')).toBeNull();
  });
  it('decodes MTC quarter frames and full frames', () => {
    const d = new MtcDecoder();
    // 01:02:03:04 at 25 fps (rate code 1).
    const vals = [4, 0, 3, 0, 2, 0, 1, 0b010];
    let out: number | null = null;
    vals.forEach((v, i) => { out = d.feed([0xf1, (i << 4) | v]); });
    expect(d.fps).toBe(25);
    expect(out).toBeCloseTo(3723 + 6 / 25);
    const full = d.feed([0xf0, 0x7f, 0x7f, 0x01, 0x01, (1 << 5) | 1, 2, 3, 4, 0xf7]);
    expect(full).toBeCloseTo(3723.16);
  });
  it('chase: lock, freewheel, then hold the last frame', () => {
    let s = chaseInit();
    s = chaseReceive(s, 100, 10);
    let r = chasePosition(s, 10.1, 2);
    expect(r.state.status).toBe('locked');
    expect(r.tc).toBeCloseTo(100.1);
    r = chasePosition(r.state, 11, 2);
    expect(r.state.status).toBe('freewheel');
    expect(r.tc).toBeCloseTo(101);
    r = chasePosition(r.state, 20, 2);
    expect(r.state.status).toBe('hold');
    expect(r.tc).toBeCloseTo(102.25);
    expect(chasePosition(r.state, 99, 2).tc).toBeCloseTo(102.25);
    // A jump relocates instantly.
    s = chaseReceive(r.state, 500, 30);
    expect(chasePosition(s, 30, 2).tc).toBe(500);
  });
  it('locates the song from timecode', () => {
    expect(locateSong([3600, 7200], [200, 200], 3700)).toEqual({ index: 0, sec: 100 });
    expect(locateSong([3600, 7200], [200, 200], 7201)).toEqual({ index: 1, sec: 1 });
    expect(locateSong([3600, 7200], [200, 200], 100)).toBeNull();
    expect(locateSong([3600, 7200], [200, 200], 5000)).toBeNull();
  });
});

describe('fades', () => {
  it('light fades are eased and perceptual', async () => {
    const { lightFade, easeFade } = await import('../src/core/evaluate');
    expect(lightFade(0)).toBe(0);
    expect(lightFade(1)).toBe(1);
    expect(easeFade(0.5)).toBeCloseTo(0.5);
    // Halfway through, intensity is low enough to look about half as bright.
    expect(lightFade(0.5)).toBeCloseTo(Math.pow(0.5, 2.2), 6);
    // Near the end the light is already almost gone, so the clip end is not a visible cut.
    expect(lightFade(0.1)).toBeLessThan(0.003);
    let prev = 0;
    for (let f = 0; f <= 1.0001; f += 0.01) { const v = lightFade(Math.min(1, f)); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
  });
});
