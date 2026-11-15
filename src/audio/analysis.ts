// Offline audio analysis (brief section 9): band envelopes, onsets split kick/snare/other, BPM and grid.
// Pure function of the PCM, so it is cached per audio asset and never depends on live audio.
import { ANALYSIS_BANDS, ANALYSIS_RATE, bandHz, bandIndexForHz, type Analysis, type OnsetList } from '../core/analysisTypes';

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function pickOnsets(flux: Float32Array, rate: number): OnsetList {
  const n = flux.length;
  const win = Math.round(rate * 0.1);
  const minGap = Math.round(rate * 0.07);
  // Running mean for an adaptive threshold.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + flux[i];
  const sorted = Float32Array.from(flux).sort();
  const ref = sorted[Math.floor(n * 0.995)] || 1e-6;
  const floor = ref * 0.06;
  const times: number[] = [], strengths: number[] = [];
  let last = -minGap;
  for (let i = 2; i < n - 2; i++) {
    const v = flux[i];
    if (v < floor || v < flux[i - 1] || v < flux[i + 1] || v < flux[i - 2] || v <= flux[i + 2]) continue;
    const a = Math.max(0, i - win), b = Math.min(n, i + win);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    if (v < mean * 1.6 + floor) continue;
    if (i - last < minGap) {
      if (strengths.length && v / ref > strengths[strengths.length - 1]) {
        times[times.length - 1] = i / rate;
        strengths[strengths.length - 1] = Math.min(1, v / ref);
        last = i;
      }
      continue;
    }
    times.push(i / rate);
    strengths.push(Math.min(1, v / ref));
    last = i;
  }
  return { times: Float32Array.from(times), strengths: Float32Array.from(strengths) };
}

/** Score a tempo/phase by summing the onset envelope on the beat grid. */
function combScore(env: Float32Array, rate: number, bpm: number, phaseSec: number): number {
  const step = (60 / bpm) * rate;
  let s = 0, c = 0;
  for (let x = phaseSec * rate; x < env.length - 1; x += step) {
    const i = Math.floor(x);
    s += env[i] + (env[i + 1] - env[i]) * (x - i);
    c++;
  }
  return c ? s / c : 0;
}

export function estimateTempo(env: Float32Array, rate: number): { bpm: number; phaseSec: number } {
  const n = env.length;
  if (n < rate * 4) return { bpm: 120, phaseSec: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  // Autocorrelation on a 100 Hz copy to stay cheap on long songs.
  const ds = Math.max(1, Math.round(rate / 100));
  const m = Math.floor(n / ds);
  const e = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let k = 0; k < ds; k++) s += env[i * ds + k];
    e[i] = Math.max(0, s / ds - mean);
  }
  const r = rate / ds;
  let best = 120, bestScore = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = (60 / bpm) * r;
    let s = 0;
    const li = Math.floor(lag), lf = lag - li;
    let acc = 0;
    for (let i = 0; i + li + 1 < m; i++) acc += e[i] * (e[i + li] * (1 - lf) + e[i + li + 1] * lf);
    s = acc / m;
    // Gentle preference for 80..160.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
    s *= prior;
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  // Refine against the whole song with a comb, including phase.
  let refined = best, phase = 0, top = -1;
  for (let bpm = best - 1; bpm <= best + 1; bpm += 0.01) {
    const period = 60 / bpm;
    for (let p = 0; p < 24; p++) {
      const ph = (p / 24) * period;
      const s = combScore(env, rate, bpm, ph);
      if (s > top) { top = s; refined = bpm; phase = ph; }
    }
  }
  // Click sessions are almost always whole or half BPM; snap if we are close.
  const snapped = Math.round(refined * 2) / 2;
  if (Math.abs(snapped - refined) < 0.08) refined = snapped;
  const period = 60 / refined;
  top = -1;
  for (let p = 0; p < 200; p++) {
    const ph = (p / 200) * period;
    const s = combScore(env, rate, refined, ph);
    if (s > top) { top = s; phase = ph; }
  }
  return { bpm: Math.round(refined * 100) / 100, phaseSec: phase };
}

export function analyze(pcm: Float32Array, sampleRate: number, onProgress?: (f: number) => void): Analysis {
  const N = 2048;
  const hop = sampleRate / ANALYSIS_RATE;
  const frames = Math.max(1, Math.floor(pcm.length / hop));
  const window = new Float32Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  // FFT bin → band lookup.
  const half = N / 2;
  const binBand = new Int16Array(half);
  const bandCount = new Float32Array(ANALYSIS_BANDS);
  for (let k = 0; k < half; k++) {
    const hz = (k * sampleRate) / N;
    const b = hz < bandHz(0) ? -1 : Math.floor(bandIndexForHz(hz));
    binBand[k] = b >= ANALYSIS_BANDS ? -1 : b;
    if (binBand[k] >= 0) bandCount[binBand[k]]++;
  }
  // Low bands can be narrower than one bin; borrow the nearest bin.
  const bandFallbackBin = new Int32Array(ANALYSIS_BANDS);
  for (let b = 0; b < ANALYSIS_BANDS; b++) bandFallbackBin[b] = Math.min(half - 1, Math.max(1, Math.round((bandHz(b + 0.5) * N) / sampleRate)));

  const bands = new Float32Array(frames * ANALYSIS_BANDS);
  const re = new Float32Array(N), im = new Float32Array(N);
  const mag = new Float32Array(half);
  let peak = 1e-9;
  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop) - N / 2;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < pcm.length ? pcm[j] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const o = f * ANALYSIS_BANDS;
    for (let k = 0; k < half; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      const b = binBand[k];
      if (b >= 0) bands[o + b] += mag[k];
    }
    for (let b = 0; b < ANALYSIS_BANDS; b++) {
      const v = bandCount[b] > 0 ? bands[o + b] / bandCount[b] : mag[bandFallbackBin[b]];
      // Compress: perceived loudness is closer to log than linear.
      bands[o + b] = Math.log1p(v * 0.05);
      if (bands[o + b] > peak) peak = bands[o + b];
    }
    if (onProgress && f % 2000 === 0) onProgress(f / frames);
  }
  for (let i = 0; i < bands.length; i++) bands[i] /= peak;

  // Spectral flux per region.
  const bLow = Math.round(bandIndexForHz(150)), bMid = Math.round(bandIndexForHz(5000));
  const fluxK = new Float32Array(frames), fluxS = new Float32Array(frames), fluxO = new Float32Array(frames), fluxAll = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const o = f * ANALYSIS_BANDS, p = o - ANALYSIS_BANDS;
    let k = 0, s = 0, h = 0;
    for (let b = 0; b < ANALYSIS_BANDS; b++) {
      const d = bands[o + b] - bands[p + b];
      if (d <= 0) continue;
      if (b < bLow) k += d; else if (b < bMid) s += d; else h += d;
    }
    fluxK[f] = k; fluxS[f] = s; fluxO[f] = h; fluxAll[f] = k * 1.5 + s + h * 0.5;
  }
  const kick = pickOnsets(fluxK, ANALYSIS_RATE);
  const snare = pickOnsets(fluxS, ANALYSIS_RATE);
  const other = pickOnsets(fluxO, ANALYSIS_RATE);

  const { bpm, phaseSec } = estimateTempo(fluxAll, ANALYSIS_RATE);
  // Downbeat guess: the beat-of-bar with the most low-end energy.
  const beatsPerBar = 4;
  const period = 60 / bpm;
  const score = new Float32Array(beatsPerBar);
  for (let i = 0, t = phaseSec; t < frames / ANALYSIS_RATE; i++, t += period) {
    const fi = Math.min(frames - 1, Math.round(t * ANALYSIS_RATE));
    let m = 0;
    for (let d = -2; d <= 2; d++) m = Math.max(m, fluxK[Math.min(frames - 1, Math.max(0, fi + d))]);
    score[i % beatsPerBar] += m;
  }
  let down = 0;
  for (let i = 1; i < beatsPerBar; i++) if (score[i] > score[down]) down = i;
  const firstDownbeatSec = phaseSec + down * period;

  const peaksPerSec = 100;
  const pn = Math.ceil((pcm.length / sampleRate) * peaksPerSec);
  const peaks = new Float32Array(pn * 2);
  const spp = sampleRate / peaksPerSec;
  for (let i = 0; i < pn; i++) {
    let lo = 0, hi = 0;
    const a = Math.floor(i * spp), b = Math.min(pcm.length, Math.floor((i + 1) * spp));
    for (let j = a; j < b; j++) { const v = pcm[j]; if (v < lo) lo = v; else if (v > hi) hi = v; }
    peaks[i * 2] = lo; peaks[i * 2 + 1] = hi;
  }

  return {
    version: 1, duration: pcm.length / sampleRate, rate: ANALYSIS_RATE, frames, bands,
    onsets: { kick, snare, other }, bpm, firstDownbeatSec, beatsPerBar, peaks, peaksPerSec,
  };
}
