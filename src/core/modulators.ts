// Modulators (brief section 8). Every output is a pure function of (settings, song time, analysis).
// Stateful-looking things (envelope followers, non-retriggering onsets) are precomputed over the
// whole song and memoised, so a frame never depends on the frames before it.
import type { Adsr, BandMod, BeatMod, LfoMod, Modulator, OnsetMod, Section, SectionMod } from './model';
import { ANALYSIS_BANDS, bandIndexForHz, type Analysis, type OnsetList } from './analysisTypes';
import { rand01 } from './rng';
import { clamp } from './math';
import type { TempoMap } from './tempo';

export interface ModCtx {
  tempo: TempoMap;
  /** Song position in beats and seconds (seconds from the start of the audio file). */
  beat: number;
  sec: number;
  analysis: Analysis | null;
  sections: Section[];
}

const fract = (x: number) => x - Math.floor(x);

export function lfoPeriodBeats(m: LfoMod): number {
  return m.rateBeats * (m.feel === 'dotted' ? 1.5 : m.feel === 'triplet' ? 2 / 3 : 1);
}

/** Returns 0..1 before bipolar mapping. */
export function lfoShape(m: LfoMod, cycles: number): number {
  const ph = fract(cycles);
  const idx = Math.floor(cycles);
  switch (m.waveform) {
    case 'sine': return 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
    case 'triangle': return ph < 0.5 ? ph * 2 : 2 - ph * 2;
    case 'sawUp': return ph;
    case 'sawDown': return 1 - ph;
    case 'square': return ph < m.pulseWidth ? 1 : 0;
    case 'random': return rand01(m.seed, idx);
    case 'smoothRandom': {
      const a = rand01(m.seed, idx), b = rand01(m.seed, idx + 1);
      const s = ph * ph * (3 - 2 * ph);
      return a + (b - a) * s;
    }
  }
}

export function evalLfo(m: LfoMod, beat: number): number {
  const u = lfoShape(m, beat / lfoPeriodBeats(m) + m.phase);
  return m.bipolar ? u * 2 - 1 : u;
}

export function adsrValue(e: Adsr, dt: number): number {
  if (dt < 0) return 0;
  if (dt < e.a) return dt / e.a;
  dt -= e.a;
  if (dt < e.d) return 1 - (1 - e.s) * (dt / e.d);
  dt -= e.d;
  if (dt < e.hold) return e.s;
  dt -= e.hold;
  if (e.r <= 0 || dt >= e.r) return 0;
  return e.s * (1 - dt / e.r);
}
export const adsrLength = (e: Adsr) => e.a + e.d + e.hold + e.r;

// ---- audio band ------------------------------------------------------------------------------

const envCache = new WeakMap<Analysis, Map<string, Float32Array>>();

export function bandRange(m: Pick<BandMod, 'band' | 'loHz' | 'hiHz'>): [number, number] {
  switch (m.band) {
    case 'low': return [30, 150];
    case 'mid': return [150, 2500];
    case 'high': return [2500, 16000];
    case 'custom': return [Math.min(m.loHz, m.hiHz), Math.max(m.loHz, m.hiHz)];
  }
}

/** Raw band envelope (mean of the analysis bands inside the Hz range), 0..1-ish. */
export function rawBandEnvelope(an: Analysis, loHz: number, hiHz: number): Float32Array {
  const key = `raw:${loHz}:${hiHz}`;
  let map = envCache.get(an);
  if (!map) envCache.set(an, (map = new Map()));
  let out = map.get(key);
  if (out) return out;
  let b0 = Math.floor(bandIndexForHz(loHz)), b1 = Math.ceil(bandIndexForHz(hiHz));
  b0 = clamp(b0, 0, ANALYSIS_BANDS - 1);
  b1 = clamp(b1, b0 + 1, ANALYSIS_BANDS);
  out = new Float32Array(an.frames);
  let peak = 1e-6;
  for (let i = 0; i < an.frames; i++) {
    let s = 0;
    for (let b = b0; b < b1; b++) s += an.bands[i * ANALYSIS_BANDS + b];
    out[i] = s / (b1 - b0);
    if (out[i] > peak) peak = out[i];
  }
  // Normalise to the song's own loudest moment so gain = 1 is a sensible start for any band.
  for (let i = 0; i < an.frames; i++) out[i] /= peak;
  map.set(key, out);
  return out;
}

export function bandEnvelope(an: Analysis, m: BandMod): Float32Array {
  const [lo, hi] = bandRange(m);
  const key = `env:${lo}:${hi}:${m.gain}:${m.threshold}:${m.attack}:${m.release}:${m.smoothing}`;
  const map = envCache.get(an) ?? (envCache.set(an, new Map()), envCache.get(an)!);
  let out = map.get(key);
  if (out) return out;
  const raw = rawBandEnvelope(an, lo, hi);
  out = new Float32Array(an.frames);
  const dt = 1 / an.rate;
  const ka = m.attack > 0 ? 1 - Math.exp(-dt / m.attack) : 1;
  const kr = m.release > 0 ? 1 - Math.exp(-dt / m.release) : 1;
  const th = clamp(m.threshold, 0, 0.999);
  let y = 0;
  for (let i = 0; i < an.frames; i++) {
    const x = clamp((raw[i] * m.gain - th) / (1 - th), 0, 1);
    y += (x - y) * (x > y ? ka : kr);
    out[i] = y;
  }
  if (m.smoothing > 0) {
    // Zero-phase smoothing (forward + backward one-pole), so the curve does not lag the music.
    const k = 1 - Math.exp(-dt / m.smoothing);
    let s = out[0];
    for (let i = 0; i < an.frames; i++) { s += (out[i] - s) * k; out[i] = s; }
    s = out[an.frames - 1];
    for (let i = an.frames - 1; i >= 0; i--) { s += (out[i] - s) * k; out[i] = s; }
  }
  map.set(key, out);
  return out;
}

export function sampleEnvelope(env: Float32Array, rate: number, sec: number): number {
  const x = sec * rate;
  if (x <= 0) return env.length ? env[0] : 0;
  const i = Math.floor(x);
  if (i >= env.length - 1) return env.length ? env[env.length - 1] : 0;
  const f = x - i;
  return env[i] + (env[i + 1] - env[i]) * f;
}

// ---- onsets ----------------------------------------------------------------------------------

const onsetCache = new WeakMap<Analysis, Map<string, Float32Array>>();

function mergedOnsets(an: Analysis, det: OnsetMod['detector']): OnsetList {
  if (det !== 'all') return an.onsets[det];
  const all: [number, number][] = [];
  for (const k of ['kick', 'snare', 'other'] as const) {
    const o = an.onsets[k];
    for (let i = 0; i < o.times.length; i++) all.push([o.times[i], o.strengths[i]]);
  }
  all.sort((a, b) => a[0] - b[0]);
  return { times: Float32Array.from(all, (a) => a[0]), strengths: Float32Array.from(all, (a) => a[1]) };
}

/** Onset times that pass the sensitivity threshold (and the no-retrigger rule). */
export function acceptedOnsets(an: Analysis, m: OnsetMod): Float32Array {
  const len = adsrLength(m.env);
  const key = `${m.detector}:${m.sensitivity}:${m.retrigger ? 'r' : len}`;
  let map = onsetCache.get(an);
  if (!map) onsetCache.set(an, (map = new Map()));
  let out = map.get(key);
  if (out) return out;
  const src = mergedOnsets(an, m.detector);
  const th = 1 - clamp(m.sensitivity, 0, 1);
  const acc: number[] = [];
  let busyUntil = -Infinity;
  for (let i = 0; i < src.times.length; i++) {
    if (src.strengths[i] < th) continue;
    const t = src.times[i];
    if (!m.retrigger && t < busyUntil) continue;
    acc.push(t);
    busyUntil = t + len;
  }
  out = Float32Array.from(acc);
  map.set(key, out);
  return out;
}

export function evalOnset(m: OnsetMod, an: Analysis | null, sec: number): number {
  if (!an) return 0;
  const times = acceptedOnsets(an, m);
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= sec) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return 0;
  return adsrValue(m.env, sec - times[lo - 1]);
}

// ---- beat trigger ----------------------------------------------------------------------------

export function evalBeat(m: BeatMod, tempo: TempoMap, beat: number): number {
  const every = Math.max(m.every, 1 / 64);
  const k = Math.floor((beat - m.offset) / every);
  const secPerBeat = 60 / tempo.bpm;
  const span = Math.min(64, Math.ceil(adsrLength(m.env) / (every * secPerBeat)) + 1);
  for (let i = 0; i < span; i++) {
    const idx = k - i;
    if (m.probability < 1 && rand01(m.seed, idx, 7919) >= m.probability) continue;
    // The most recent trigger that fires owns the envelope (retrigger).
    return adsrValue(m.env, (beat - (m.offset + idx * every)) * secPerBeat);
  }
  return 0;
}

// ---- sections --------------------------------------------------------------------------------

export function evalSection(m: SectionMod, sections: Section[], beat: number): number {
  if (!sections.length) return 0;
  let idx = -1;
  for (let i = 0; i < sections.length; i++) if (sections[i].start <= beat) idx = i;
  if (idx < 0) return 0;
  const cur = m.values[sections[idx].id] ?? 0;
  if (idx === 0 || m.crossfade <= 0) return cur;
  const prev = m.values[sections[idx - 1].id] ?? 0;
  const x = clamp((beat - sections[idx].start) / m.crossfade, 0, 1);
  return prev + (cur - prev) * x;
}

// ---- stack -----------------------------------------------------------------------------------

/** Raw modulator output: −1..1 for a bipolar LFO, otherwise 0..1. */
export function evalModulator(m: Modulator, ctx: ModCtx): number {
  switch (m.type) {
    case 'lfo': return evalLfo(m, ctx.beat);
    case 'band': return ctx.analysis ? sampleEnvelope(bandEnvelope(ctx.analysis, m), ctx.analysis.rate, ctx.sec) : 0;
    case 'onset': return evalOnset(m, ctx.analysis, ctx.sec);
    case 'beat': return evalBeat(m, ctx.tempo, ctx.beat);
    case 'section': return evalSection(m, ctx.sections, ctx.beat);
  }
}

/** Apply a modulator stack to a value. Depth is in the parameter's own units for 'add'. */
export function applyModulators(v: number, mods: Modulator[] | undefined, ctx: ModCtx, min: number, max: number): number {
  if (!mods) return v;
  for (const m of mods) {
    if (!m.enabled) continue;
    const o = evalModulator(m, ctx);
    if (m.blend === 'add') v += m.depth * o;
    else if (m.blend === 'multiply') v *= 1 + (o - 1) * clamp(m.depth, 0, 1);
    else {
      const u = clamp(o * 0.5 + (m.type === 'lfo' && m.bipolar ? 0.5 : o * 0.5), 0, 1);
      v += (min + (max - min) * u - v) * clamp(m.depth, 0, 1);
    }
  }
  return v;
}
