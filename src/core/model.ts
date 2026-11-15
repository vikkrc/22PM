// Data model (brief section 7). Plain JSON; time on the timeline is in beats.
import { KINDS, type Kind, type TrackType } from './registry';
import { defaultTempo, type TempoMap } from './tempo';
import { newId } from './rng';

export type Interp = 'hold' | 'linear' | 'bezier';
export type Ease = [number, number, number, number];

export interface Keyframe {
  id: string;
  /** Beats from the start of the clip. */
  t: number;
  v: number;
  /** Shape of the segment that starts at this key. */
  interp: Interp;
  /** CSS-style cubic-bezier control points for 'bezier'. */
  ease?: Ease;
}

export const EASE_PRESETS: Record<string, Ease> = {
  'Ease in-out': [0.42, 0, 0.58, 1],
  'Ease in': [0.42, 0, 1, 1],
  'Ease out': [0, 0, 0.58, 1],
  'Soft': [0.25, 0.1, 0.25, 1],
  'Slow in-out': [0.7, 0, 0.3, 1],
  'Expo out': [0.16, 1, 0.3, 1],
  'Expo in': [0.7, 0, 0.84, 0],
  'Overshoot': [0.34, 1.56, 0.64, 1],
};

export type Blend = 'add' | 'multiply' | 'replace';
export type Waveform = 'sine' | 'triangle' | 'sawUp' | 'sawDown' | 'square' | 'random' | 'smoothRandom';
export type OnsetDetector = 'kick' | 'snare' | 'other' | 'all';

export interface Adsr { a: number; d: number; s: number; hold: number; r: number }

interface ModBase { id: string; enabled: boolean; depth: number; blend: Blend }
export interface LfoMod extends ModBase {
  type: 'lfo'; waveform: Waveform; rateBeats: number; feel: 'straight' | 'dotted' | 'triplet';
  phase: number; pulseWidth: number; bipolar: boolean; seed: number;
}
export interface BandMod extends ModBase {
  type: 'band'; band: 'low' | 'mid' | 'high' | 'custom'; loHz: number; hiHz: number;
  gain: number; threshold: number; attack: number; release: number; smoothing: number;
}
export interface OnsetMod extends ModBase { type: 'onset'; detector: OnsetDetector; sensitivity: number; env: Adsr; retrigger: boolean }
export interface BeatMod extends ModBase { type: 'beat'; every: number; offset: number; env: Adsr; probability: number; seed: number }
export interface SectionMod extends ModBase { type: 'section'; values: Record<string, number>; crossfade: number }
export type Modulator = LfoMod | BandMod | OnsetMod | BeatMod | SectionMod;
export type ModType = Modulator['type'];

export interface ParamState { base: number; keys?: Keyframe[]; mods?: Modulator[] }

export interface Clip {
  id: string;
  kind: Kind;
  name: string;
  /** Beats. */
  start: number;
  length: number;
  fadeIn: number;
  fadeOut: number;
  muted?: boolean;
  params: Record<string, ParamState>;
  /** Splat instance ids an animator applies to; empty = all. */
  targets?: string[];
}

export interface Track { id: string; type: TrackType; name: string; muted?: boolean; clips: Clip[] }

export interface SplatInstance {
  id: string;
  assetId: string;
  /** Asset version id; undefined = latest. */
  version?: string;
  name: string;
  visible: boolean;
  pos: [number, number, number];
  /** Euler degrees. */
  rot: [number, number, number];
  scale: number;
  crop: boolean;
  cropMin: [number, number, number];
  cropMax: [number, number, number];
  deLight: number;
  bakedMix: number;
  opacity: number;
  normalMode: 'view' | 'outward' | 'inward';
  normalStrength: number;
}

export interface Section { id: string; name: string; start: number; color?: string }

export interface Scene {
  splats: SplatInstance[];
  /** Always-on base layer; clips on tracks override it. */
  base: { camera: Clip; global: Clip; post: Clip };
  maxShadowLights: number;
  shadowResolution: number;
}

export interface Song {
  id: string;
  title: string;
  audioAssetId?: string;
  tempo: TempoMap;
  sections: Section[];
  /** SMPTE start timecode hh:mm:ss:ff the click rig sends at the top of this song. */
  startTimecode: string;
  lengthBeats: number;
  scene: Scene;
  tracks: Track[];
}

export interface AssetVersion { id: string; label: string; file: string; created: string; count?: number; note?: string }
export interface Asset {
  id: string;
  type: 'splat' | 'audio';
  name: string;
  versions: AssetVersion[];
  /** How it was made, so it can be retrained (Train tab). */
  recipe?: Record<string, unknown>;
}

export interface OutputSettings { width: number; height: number; fps: number; timecodeFps: number }

export interface Show {
  format: '22pm-show';
  version: 1;
  name: string;
  output: OutputSettings;
  assets: Asset[];
  /** Setlist order. */
  songs: Song[];
}

// ---- factories -------------------------------------------------------------------------------

export function defaultParams(kind: Kind): Record<string, ParamState> {
  const out: Record<string, ParamState> = {};
  for (const d of KINDS[kind].params) out[d.id] = { base: d.def };
  return out;
}

export function makeClip(kind: Kind, start: number, length: number, name?: string): Clip {
  return { id: newId('clip'), kind, name: name ?? KINDS[kind].label, start, length, fadeIn: 0, fadeOut: 0, params: defaultParams(kind) };
}

export function makeTrack(type: TrackType, name: string): Track {
  return { id: newId('trk'), type, name, clips: [] };
}

export function makeSong(title = 'New song'): Song {
  const lengthBeats = 64 * 4;
  const base = (kind: Kind) => ({ ...makeClip(kind, 0, lengthBeats), id: `base_${kind}`, name: KINDS[kind].label });
  return {
    id: newId('song'),
    title,
    tempo: defaultTempo(),
    sections: [],
    startTimecode: '01:00:00:00',
    lengthBeats,
    scene: { splats: [], base: { camera: base('camera'), global: base('global'), post: base('post') }, maxShadowLights: 4, shadowResolution: 1024 },
    tracks: [makeTrack('camera', 'Camera'), makeTrack('light', 'Lights 1'), makeTrack('light', 'Lights 2'), makeTrack('modifier', 'Modifiers'), makeTrack('global', 'Global')],
  };
}

export function makeShow(): Show {
  return { format: '22pm-show', version: 1, name: 'Délután 10', output: { width: 1920, height: 1080, fps: 60, timecodeFps: 25 }, assets: [], songs: [makeSong('Song 1')] };
}

export function makeInstance(assetId: string, name: string): SplatInstance {
  return {
    id: newId('spl'), assetId, name, visible: true, pos: [0, 0, 0], rot: [0, 0, 0], scale: 1,
    crop: false, cropMin: [-5, -5, -5], cropMax: [5, 5, 5], deLight: 0.5, bakedMix: 0.1, opacity: 1, normalMode: 'view', normalStrength: 1,
  };
}

const adsr = (): Adsr => ({ a: 0.005, d: 0.18, s: 0, hold: 0, r: 0.1 });

export function makeModulator(type: ModType, depth: number): Modulator {
  const base = { id: newId('mod'), enabled: true, depth, blend: 'add' as Blend };
  switch (type) {
    case 'lfo': return { ...base, type, waveform: 'sine', rateBeats: 4, feel: 'straight', phase: 0, pulseWidth: 0.5, bipolar: true, seed: 1 };
    case 'band': return { ...base, type, band: 'low', loHz: 200, hiHz: 2000, gain: 1, threshold: 0, attack: 0.005, release: 0.15, smoothing: 0 };
    case 'onset': return { ...base, type, detector: 'kick', sensitivity: 0.5, env: adsr(), retrigger: true };
    case 'beat': return { ...base, type, every: 1, offset: 0, env: adsr(), probability: 1, seed: 1 };
    case 'section': return { ...base, type, values: {}, crossfade: 1 };
  }
}

/** Fill in anything a newer registry added, drop nothing. Keeps old files loading. */
export function normalizeShow(show: Show): Show {
  const fix = (c: Clip) => {
    for (const d of KINDS[c.kind]?.params ?? []) if (!c.params[d.id]) c.params[d.id] = { base: d.def };
  };
  for (const s of show.songs) {
    fix(s.scene.base.camera); fix(s.scene.base.global); fix(s.scene.base.post);
    for (const t of s.tracks) t.clips.forEach(fix);
  }
  return show;
}

export function findClip(song: Song, id: string): { clip: Clip; track: Track | null } | null {
  const b = song.scene.base;
  for (const c of [b.camera, b.global, b.post]) if (c.id === id) return { clip: c, track: null };
  for (const t of song.tracks) for (const c of t.clips) if (c.id === id) return { clip: c, track: t };
  return null;
}
