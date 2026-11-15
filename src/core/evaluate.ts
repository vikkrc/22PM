// evaluate(show, song, t) → FrameState. Pure: no wall clock, no hidden state, no unseeded randomness.
// Live playback, show mode and the frame-stepped renderer all call this and nothing else.
import { KINDS, type Kind, type ParamDef } from './registry';
import type { Clip, ParamState, Show, Song, SplatInstance } from './model';
import { evalKeys } from './curves';
import { applyModulators, type ModCtx } from './modulators';
import type { Analysis } from './analysisTypes';
import { beatToSec, secToBeat } from './tempo';
import { clamp, dirFromYawPitch, v3, type Vec3 } from './math';

export type LightType = 'point' | 'spot' | 'sun' | 'area';

export interface LightState {
  id: string;
  type: LightType;
  color: Vec3;
  intensity: number;
  pos: Vec3;
  /** Unit vector the light shines along. */
  dir: Vec3;
  range: number;
  radius: number;
  cone: number;
  penumbra: number;
  width: number;
  height: number;
  disc: boolean;
  castShadows: boolean;
  softness: number;
  specular: number;
}

export interface AnimatorState {
  id: string;
  kind: Kind;
  /** Resolved parameter values. */
  p: Record<string, number>;
  /** Seconds since the clip started (drives noise motion). */
  time: number;
  /** Clip fade 0..1. */
  fade: number;
  targets: string[];
}

export interface CameraState { pos: Vec3; target: Vec3; fov: number; roll: number }
export interface GlobalState { sky: Vec3; ground: Vec3; intensity: number; background: Vec3 }
export interface PostState {
  exposure: number; contrast: number; saturation: number; tint: Vec3;
  bloom: number; bloomThreshold: number; vignette: number; master: number;
}

export interface FrameState {
  sec: number;
  beat: number;
  camera: CameraState;
  global: GlobalState;
  post: PostState;
  lights: LightState[];
  animators: AnimatorState[];
  splats: SplatInstance[];
}

export function clipFade(c: Clip, beat: number): number {
  const fi = c.fadeIn > 0 ? clamp((beat - c.start) / c.fadeIn, 0, 1) : 1;
  const fo = c.fadeOut > 0 ? clamp((c.start + c.length - beat) / c.fadeOut, 0, 1) : 1;
  return Math.min(fi, fo);
}

export const clipActive = (c: Clip, beat: number) => !c.muted && beat >= c.start && beat < c.start + c.length;

/** v(t) = clamp(base-or-keyframes + modulators). Keyframes, when present, replace the base value. */
export function evalParam(def: ParamDef, st: ParamState | undefined, clipStart: number, ctx: ModCtx): number {
  if (!st) return def.def;
  let v = st.keys && st.keys.length ? evalKeys(st.keys, ctx.beat - clipStart) : st.base;
  if (def.type !== 'float') return clamp(Math.round(v), def.min, def.max);
  if (def.mod && st.mods && st.mods.length) v = applyModulators(v, st.mods, ctx, def.softMin ?? def.min, def.softMax ?? def.max);
  return clamp(v, def.min, def.max);
}

export function evalClipParams(c: Clip, ctx: ModCtx): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of KINDS[c.kind].params) out[d.id] = evalParam(d, c.params[d.id], c.start, ctx);
  return out;
}

const vec = (p: Record<string, number>, id: string): Vec3 => [p[`${id}.x`], p[`${id}.y`], p[`${id}.z`]];
const col = (p: Record<string, number>, id: string): Vec3 => [p[`${id}.r`], p[`${id}.g`], p[`${id}.b`]];

function mix(a: Record<string, number>, b: Record<string, number>, w: number, kind: Kind): Record<string, number> {
  if (w >= 1) return b;
  const out: Record<string, number> = {};
  for (const d of KINDS[kind].params) out[d.id] = d.type === 'float' ? a[d.id] + (b[d.id] - a[d.id]) * w : w > 0.5 ? b[d.id] : a[d.id];
  return out;
}

function lightFromParams(c: Clip, p: Record<string, number>, fade: number): LightState {
  const type = c.kind.split('.')[1] as LightType;
  const pos: Vec3 = type === 'sun' ? [0, 0, 0] : vec(p, 'pos');
  let dir: Vec3 = [0, -1, 0];
  if (type === 'sun') dir = v3.scale(dirFromYawPitch(p.azimuth, p.elevation), -1);
  else if (type === 'spot' || type === 'area') {
    const d = v3.sub(vec(p, 'target'), pos);
    dir = v3.len(d) > 1e-6 ? v3.norm(d) : [0, -1, 0];
  }
  return {
    id: c.id, type, color: col(p, 'color'), intensity: p.intensity * fade, pos, dir,
    range: p.range ?? 1e6,
    radius: type === 'sun' ? p.angularSize : (p.radius ?? 0),
    cone: p.cone ?? 0, penumbra: p.penumbra ?? 0,
    width: p.width ?? 0, height: p.height ?? 0, disc: (p.shape ?? 0) === 1,
    castShadows: p.castShadows > 0.5, softness: p.shadowSoftness, specular: p.specular,
  };
}

/** `sec` is seconds from the start of the song's audio (timecode minus the song's start timecode). */
export function evaluate(show: Show, song: Song, sec: number, analysis: Analysis | null = null): FrameState {
  void show;
  const beat = secToBeat(song.tempo, sec);
  const ctx: ModCtx = { tempo: song.tempo, beat, sec, analysis, sections: song.sections };
  const base = song.scene.base;

  let cam = evalClipParams(base.camera, ctx);
  let glob = evalClipParams(base.global, ctx);
  let post = evalClipParams(base.post, ctx);
  const lights: LightState[] = [];
  const animators: AnimatorState[] = [];

  // Bottom track first, so the top track wins for exclusive kinds.
  for (let ti = song.tracks.length - 1; ti >= 0; ti--) {
    const tr = song.tracks[ti];
    if (tr.muted) continue;
    for (const c of tr.clips) {
      if (!clipActive(c, beat)) continue;
      const p = evalClipParams(c, ctx);
      const fade = clipFade(c, beat);
      if (c.kind === 'camera') cam = mix(cam, p, fade, 'camera');
      else if (c.kind === 'global') glob = mix(glob, p, fade, 'global');
      else if (c.kind === 'post') post = mix(post, p, fade, 'post');
      else if (c.kind.startsWith('light.')) lights.push(lightFromParams(c, p, fade));
      else animators.push({ id: c.id, kind: c.kind, p, time: beatToSec(song.tempo, beat) - beatToSec(song.tempo, c.start), fade, targets: c.targets ?? [] });
    }
  }
  // Stable order regardless of track iteration details.
  lights.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  animators.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    sec, beat,
    camera: { pos: vec(cam, 'pos'), target: vec(cam, 'target'), fov: cam.fov, roll: cam.roll },
    global: { sky: col(glob, 'sky'), ground: col(glob, 'ground'), intensity: glob.intensity, background: col(glob, 'background') },
    post: {
      exposure: post.exposure, contrast: post.contrast, saturation: post.saturation, tint: col(post, 'tint'),
      bloom: post.bloom, bloomThreshold: post.bloomThreshold, vignette: post.vignette, master: post.master,
    },
    lights, animators,
    splats: song.scene.splats,
  };
}
