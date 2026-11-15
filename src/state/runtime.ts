// Runtime side of the project: loaded splats, decoded audio, analysis, the renderer, and persistence.
import { Renderer } from '../render/renderer';
import type { PreparedSplat } from '../splat/types';
import type { Analysis } from '../core/analysisTypes';
import { makeInstance, type Asset, type Show, type Song } from '../core/model';
import { newId } from '../core/rng';
import { beatsToDuration, secToBeat } from '../core/tempo';
import { makeDemoShow } from './demoShow';
import { readFile, writeFile } from './fs';
import { bumpAssets, currentSong, getState, loadShow, markSaved, select, startJob, subscribe, toast, update } from './store';
import { transport } from './transport';

let rendererPromise: Promise<Renderer> | null = null;
export const getRenderer = () => (rendererPromise ??= Renderer.create());

export const splats = new Map<string, PreparedSplat>();
export const audioBuffers = new Map<string, AudioBuffer>();
export const analyses = new Map<string, Analysis>();
const loading = new Set<string>();

export const latestVersion = (a: Asset) => a.versions[a.versions.length - 1];
export const splatKey = (assetId: string, version?: string) => `${assetId}:${version ?? ''}`;

function resolveVersion(show: Show, assetId: string, version?: string) {
  const asset = show.assets.find((a) => a.id === assetId);
  if (!asset) return null;
  const v = asset.versions.find((x) => x.id === version) ?? latestVersion(asset);
  return v ? { asset, v } : null;
}

function prepareInWorker(msg: { name: string; buf?: ArrayBuffer; demo?: string }): Promise<PreparedSplat> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../splat/splat.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { w.terminate(); if (e.data.ok) resolve(e.data.ok); else reject(new Error(e.data.error)); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage(msg, msg.buf ? [msg.buf] : []);
  });
}

/** Make sure a splat asset version is decoded and prepared. Resolves immediately if cached. */
export async function ensureSplat(show: Show, assetId: string, version?: string): Promise<void> {
  const r = resolveVersion(show, assetId, version);
  if (!r) return;
  const key = splatKey(assetId, r.v.id);
  if (splats.has(key) || loading.has(key)) return;
  loading.add(key);
  const job = startJob(`Preparing ${r.asset.name}`);
  try {
    let p: PreparedSplat;
    if (assetId.startsWith('demo_')) p = await prepareInWorker({ name: assetId, demo: assetId });
    else {
      const f = await readFile(r.v.file);
      if (!f) throw new Error(`Missing file ${r.v.file}`);
      p = await prepareInWorker({ name: r.v.file, buf: await f.arrayBuffer() });
    }
    splats.set(key, p);
    job.done();
    bumpAssets();
  } catch (e) { job.fail(e); } finally { loading.delete(key); }
}

export function splatFor(show: Show, assetId: string, version?: string): PreparedSplat | null {
  const r = resolveVersion(show, assetId, version);
  return r ? splats.get(splatKey(assetId, r.v.id)) ?? null : null;
}

let sceneKey = '';
/** Push the current song's splats into the renderer when the set of loaded instances changes. */
export async function syncScene(): Promise<boolean> {
  const { show } = getState();
  const song = currentSong();
  const parts: { id: string; data: PreparedSplat }[] = [];
  const keys: string[] = [];
  for (const inst of song.scene.splats) {
    const r = resolveVersion(show, inst.assetId, inst.version);
    if (!r) continue;
    const key = splatKey(inst.assetId, r.v.id);
    const data = splats.get(key);
    if (!data) { void ensureSplat(show, inst.assetId, inst.version); continue; }
    parts.push({ id: inst.id, data });
    keys.push(`${inst.id}=${key}`);
  }
  const k = `${song.id}|${keys.join(',')}`;
  if (k === sceneKey) return false;
  sceneKey = k;
  (await getRenderer()).setScene(parts);
  return true;
}
export const invalidateScene = () => { sceneKey = ''; };

// ---- import ----------------------------------------------------------------------------------

export async function importSplatFile(file: File, addToScene = true): Promise<string | null> {
  const job = startJob(`Importing ${file.name}`);
  try {
    const id = newId('asset');
    const ext = /\.spz$/i.test(file.name) ? 'spz' : 'ply';
    const path = `assets/${id}/raw.${ext}`;
    const buf = await file.arrayBuffer();
    await writeFile(path, buf.slice(0));
    const p = await prepareInWorker({ name: file.name, buf });
    splats.set(splatKey(id, 'raw'), p);
    const name = file.name.replace(/\.(ply|spz)$/i, '');
    update((show, song) => {
      show.assets.push({ id, type: 'splat', name, versions: [{ id: 'raw', label: 'raw', file: path, created: new Date().toISOString(), count: p.count }], recipe: { source: file.name, imported: true } });
      if (addToScene) {
        const inst = makeInstance(id, name);
        // 3DGS .ply files are Y-down (COLMAP); .spz is already Y-up.
        if (ext === 'ply') inst.rot = [0, 0, 180];
        song.scene.splats.push(inst);
      }
    });
    job.done();
    bumpAssets();
    return id;
  } catch (e) { job.fail(e); return null; }
}

/** Add a cleaned (or retrained) file as a new version of an existing splat asset. Scenes on "latest" pick it up in place. */
export async function importSplatVersion(assetId: string, file: File, label?: string): Promise<void> {
  const job = startJob(`Importing ${file.name}`);
  try {
    const asset = getState().show.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error('Asset not found');
    const n = asset.versions.filter((v) => v.id.startsWith('clean')).length + 1;
    const vid = `clean${n}`;
    const ext = /\.spz$/i.test(file.name) ? 'spz' : 'ply';
    const path = `assets/${assetId}/${vid}.${ext}`;
    const buf = await file.arrayBuffer();
    await writeFile(path, buf.slice(0));
    const p = await prepareInWorker({ name: file.name, buf });
    splats.set(splatKey(assetId, vid), p);
    update((show) => {
      show.assets.find((a) => a.id === assetId)!.versions.push({ id: vid, label: label ?? `clean v${n}`, file: path, created: new Date().toISOString(), count: p.count, note: file.name });
    });
    job.done();
    bumpAssets();
  } catch (e) { job.fail(e); }
}

function analyzeInWorker(pcm: Float32Array, sampleRate: number, onProgress: (p: number) => void): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../audio/analysis.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { if (e.data.result) { w.terminate(); resolve(e.data.result); } else if (e.data.progress != null) onProgress(e.data.progress); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage({ pcm, sampleRate }, [pcm.buffer]);
  });
}

let decodeCtx: AudioContext | null = null;
async function decode(buf: ArrayBuffer): Promise<AudioBuffer> {
  decodeCtx ??= new AudioContext();
  return decodeCtx.decodeAudioData(buf);
}
function mono(b: AudioBuffer): Float32Array {
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / b.numberOfChannels; }
  return out;
}

function packAnalysis(a: Analysis): Blob {
  const meta = { version: a.version, duration: a.duration, rate: a.rate, frames: a.frames, bpm: a.bpm, firstDownbeatSec: a.firstDownbeatSec, beatsPerBar: a.beatsPerBar, peaksPerSec: a.peaksPerSec };
  const arrays = [a.bands, a.peaks, a.onsets.kick.times, a.onsets.kick.strengths, a.onsets.snare.times, a.onsets.snare.strengths, a.onsets.other.times, a.onsets.other.strengths];
  const head = new TextEncoder().encode(JSON.stringify({ meta, lengths: arrays.map((x) => x.length) }));
  const pad = (4 - (head.length % 4)) % 4;
  return new Blob([new Uint32Array([head.length + pad]), head, new Uint8Array(pad), ...arrays.map((x) => x.slice().buffer)]);
}
function unpackAnalysis(buf: ArrayBuffer): Analysis {
  const hl = new Uint32Array(buf, 0, 1)[0];
  const { meta, lengths } = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)).replace(/\0+$/, ''));
  let o = 4 + hl;
  const next = (n: number) => { const a = new Float32Array(buf.slice(o, o + n * 4)); o += n * 4; return a; };
  const [bands, peaks, kt, ks, st, ss, ot, os] = (lengths as number[]).map(next);
  return { ...meta, bands, peaks, onsets: { kick: { times: kt, strengths: ks }, snare: { times: st, strengths: ss }, other: { times: ot, strengths: os } } };
}

export async function ensureAudio(show: Show, assetId: string): Promise<void> {
  if (audioBuffers.has(assetId) || loading.has(assetId)) return;
  const asset = show.assets.find((a) => a.id === assetId);
  if (!asset) return;
  loading.add(assetId);
  const job = startJob(`Loading ${asset.name}`);
  try {
    const f = await readFile(latestVersion(asset).file);
    if (!f) throw new Error('Audio file is missing from the project');
    const buffer = await decode(await f.arrayBuffer());
    audioBuffers.set(assetId, buffer);
    const cached = await readFile(`cache/analysis_${assetId}.bin`);
    let an: Analysis | null = null;
    if (cached) { try { an = unpackAnalysis(await cached.arrayBuffer()); } catch { an = null; } }
    if (!an) {
      an = await analyzeInWorker(mono(buffer), buffer.sampleRate, job.progress);
      await writeFile(`cache/analysis_${assetId}.bin`, packAnalysis(an));
    }
    analyses.set(assetId, an);
    job.done();
    bumpAssets();
  } catch (e) { job.fail(e); } finally { loading.delete(assetId); }
}

/** Import a song's audio: store it, analyse it, and set the tempo map and length from the result. */
export async function importAudioFile(file: File): Promise<void> {
  const job = startJob(`Analysing ${file.name}`);
  try {
    const id = newId('asset');
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'wav').toLowerCase();
    const path = `assets/${id}/audio.${ext}`;
    const buf = await file.arrayBuffer();
    await writeFile(path, buf.slice(0));
    const buffer = await decode(buf);
    audioBuffers.set(id, buffer);
    const an = await analyzeInWorker(mono(buffer), buffer.sampleRate, job.progress);
    analyses.set(id, an);
    await writeFile(`cache/analysis_${id}.bin`, packAnalysis(an));
    const name = file.name.replace(/\.[a-z0-9]+$/i, '');
    update((show, song) => {
      show.assets.push({ id, type: 'audio', name, versions: [{ id: 'v1', label: 'original', file: path, created: new Date().toISOString() }] });
      song.audioAssetId = id;
      if (/^(Song \d+|New song)$/.test(song.title)) song.title = name;
      song.tempo = { ...song.tempo, bpm: an.bpm, firstDownbeatSec: an.firstDownbeatSec, beatsPerBar: an.beatsPerBar };
      const beats = secToBeat(song.tempo, an.duration);
      song.lengthBeats = Math.ceil(beats / song.tempo.beatsPerBar) * song.tempo.beatsPerBar;
      for (const c of Object.values(song.scene.base)) c.length = song.lengthBeats;
    });
    job.done();
    bumpAssets();
    toast(`Detected ${an.bpm} BPM. Check the grid against the click and adjust in Song settings if needed.`);
  } catch (e) { job.fail(e); }
}

export const analysisFor = (song: Song): Analysis | null => (song.audioAssetId ? analyses.get(song.audioAssetId) ?? null : null);
export const songDuration = (song: Song) => song.tempo.firstDownbeatSec + beatsToDuration(song.tempo, song.lengthBeats);

// ---- persistence -----------------------------------------------------------------------------

const SHOW_FILE = 'show.json';

export async function boot(): Promise<void> {
  let show: Show | null = null;
  try {
    const f = await readFile(SHOW_FILE);
    if (f) show = JSON.parse(await f.text());
  } catch (e) { console.warn('Could not read saved show', e); }
  if (!show || show.format !== '22pm-show') show = makeDemoShow('demo_courtyard', 'demo_object');
  loadShow(show);
  select({ type: 'none' });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastShow = getState().show;
  let lastSong = '';
  const onChange = () => {
    const s = getState();
    const song = currentSong(s);
    if (s.show !== lastShow) {
      lastShow = s.show;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void saveNow(), 800);
    }
    transport.end = songDuration(song);
    if (song.id !== lastSong) {
      lastSong = song.id;
      transport.pause();
      transport.seek(0);
    }
    const buf = song.audioAssetId ? audioBuffers.get(song.audioAssetId) ?? null : null;
    if (song.audioAssetId && !buf) void ensureAudio(s.show, song.audioAssetId);
    if ((transport as any)._buf !== buf) { (transport as any)._buf = buf; transport.setBuffer(buf); }
    void syncScene();
  };
  subscribe(onChange);
  onChange();
}

export async function saveNow(): Promise<void> {
  try {
    await writeFile(SHOW_FILE, JSON.stringify(getState().show));
    markSaved();
  } catch (e) { console.warn('Autosave failed', e); }
}

export function resetToDemo() {
  loadShow(makeDemoShow('demo_courtyard', 'demo_object'));
  invalidateScene();
  void syncScene();
}
