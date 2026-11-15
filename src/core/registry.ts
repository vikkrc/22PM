// The parameter registry. Every animatable parameter is declared here once.
// The inspector, timeline lanes, modulators, evaluate() and the file format are all generated from it.

export type TrackType = 'camera' | 'light' | 'modifier' | 'global';
export type ParamType = 'float' | 'bool' | 'enum';

export interface ParamDef {
  id: string;
  label: string;
  type: ParamType;
  unit?: string;
  min: number;
  max: number;
  /** Slider range when the hard range is too wide to be useful. */
  softMin?: number;
  softMax?: number;
  def: number;
  step?: number;
  /** Can take modulators (floats only). */
  mod: boolean;
  /** Parameters sharing a group id are shown on one row (vec3 / colour). */
  group?: string;
  groupLabel?: string;
  widget?: 'vec3' | 'color';
  options?: string[];
  section?: string;
}

export type Kind =
  | 'light.point' | 'light.spot' | 'light.sun' | 'light.area'
  | 'global' | 'post' | 'camera'
  | 'anim.disperse' | 'anim.wobble' | 'anim.sweep' | 'anim.cutoff';

export interface KindDef {
  kind: Kind;
  label: string;
  track: TrackType;
  params: ParamDef[];
  /** Only one is active at a time (top track wins); others accumulate. */
  exclusive: boolean;
  hasTargets?: boolean;
}

const BIG = 1000;
const f = (id: string, label: string, def: number, min: number, max: number, extra: Partial<ParamDef> = {}): ParamDef => ({
  id, label, type: 'float', def, min, max, mod: true, ...extra,
});
const bool = (id: string, label: string, def: boolean, extra: Partial<ParamDef> = {}): ParamDef => ({
  id, label, type: 'bool', def: def ? 1 : 0, min: 0, max: 1, mod: false, ...extra,
});
const en = (id: string, label: string, options: string[], def = 0, extra: Partial<ParamDef> = {}): ParamDef => ({
  id, label, type: 'enum', def, min: 0, max: options.length - 1, options, mod: false, ...extra,
});
const vec3 = (id: string, label: string, def: [number, number, number], extra: Partial<ParamDef> = {}): ParamDef[] =>
  (['x', 'y', 'z'] as const).map((a, i) =>
    f(`${id}.${a}`, `${label} ${a.toUpperCase()}`, def[i], -BIG, BIG, {
      unit: 'm', step: 0.01, softMin: -10, softMax: 10, group: id, groupLabel: label, widget: 'vec3', ...extra,
    }));
const color = (id: string, label: string, def: [number, number, number], extra: Partial<ParamDef> = {}): ParamDef[] =>
  (['r', 'g', 'b'] as const).map((a, i) =>
    f(`${id}.${a}`, `${label} ${a.toUpperCase()}`, def[i], 0, 1, { step: 0.001, group: id, groupLabel: label, widget: 'color', ...extra }));

const lightCommon = (intensity: number, softness = 0.3): ParamDef[] => [
  ...color('color', 'Colour', [1, 1, 1], { section: 'Light' }),
  f('intensity', 'Intensity', intensity, 0, 1000, { softMax: intensity * 4, step: 0.01, section: 'Light' }),
  f('specular', 'Specular', 0.15, 0, 1, { step: 0.01, section: 'Light' }),
  bool('castShadows', 'Cast shadows', true, { section: 'Shadow' }),
  f('shadowSoftness', 'Softness', softness, 0, 1, { step: 0.01, section: 'Shadow' }),
];

export const KINDS: Record<Kind, KindDef> = {
  'light.point': {
    kind: 'light.point', label: 'Point light', track: 'light', exclusive: false,
    params: [
      ...vec3('pos', 'Position', [0, 1.5, 0], { section: 'Transform' }),
      ...lightCommon(8),
      f('radius', 'Size', 0.05, 0, 5, { unit: 'm', step: 0.005, softMax: 1, section: 'Light' }),
      f('range', 'Range', 8, 0.01, BIG, { unit: 'm', step: 0.05, softMax: 30, section: 'Light' }),
    ],
  },
  'light.spot': {
    kind: 'light.spot', label: 'Spot light', track: 'light', exclusive: false,
    params: [
      ...vec3('pos', 'Position', [2, 3, 2], { section: 'Transform' }),
      ...vec3('target', 'Aim at', [0, 0, 0], { section: 'Transform' }),
      ...lightCommon(40),
      f('cone', 'Cone angle', 35, 1, 170, { unit: '°', step: 0.1, section: 'Light' }),
      f('penumbra', 'Penumbra', 0.3, 0, 1, { step: 0.01, section: 'Light' }),
      f('range', 'Range', 15, 0.01, BIG, { unit: 'm', step: 0.05, softMax: 40, section: 'Light' }),
    ],
  },
  'light.sun': {
    kind: 'light.sun', label: 'Sun', track: 'light', exclusive: false,
    params: [
      f('azimuth', 'Azimuth', 30, -720, 720, { unit: '°', step: 0.1, softMin: -180, softMax: 180, section: 'Transform' }),
      f('elevation', 'Elevation', 40, -90, 90, { unit: '°', step: 0.1, section: 'Transform' }),
      ...lightCommon(2, 0.15),
      f('angularSize', 'Angular size', 1, 0, 20, { unit: '°', step: 0.05, section: 'Light' }),
    ],
  },
  'light.area': {
    kind: 'light.area', label: 'Area light', track: 'light', exclusive: false,
    params: [
      ...vec3('pos', 'Position', [0, 3, 2], { section: 'Transform' }),
      ...vec3('target', 'Aim at', [0, 0, 0], { section: 'Transform' }),
      ...lightCommon(30, 0.7),
      f('width', 'Width', 1.5, 0.01, 50, { unit: 'm', step: 0.01, softMax: 6, section: 'Light' }),
      f('height', 'Height', 1, 0.01, 50, { unit: 'm', step: 0.01, softMax: 6, section: 'Light' }),
      en('shape', 'Shape', ['Rect', 'Disc'], 0, { section: 'Light' }),
      f('range', 'Range', 15, 0.01, BIG, { unit: 'm', step: 0.05, softMax: 40, section: 'Light' }),
    ],
  },
  global: {
    kind: 'global', label: 'Global light', track: 'global', exclusive: true,
    params: [
      ...color('sky', 'Sky', [0.55, 0.65, 1], { section: 'Global light' }),
      ...color('ground', 'Ground', [0.25, 0.2, 0.18], { section: 'Global light' }),
      f('intensity', 'Intensity', 0.06, 0, 20, { softMax: 2, step: 0.001, section: 'Global light' }),
      ...color('background', 'Background', [0, 0, 0], { section: 'Global light' }),
    ],
  },
  post: {
    kind: 'post', label: 'Post', track: 'global', exclusive: true,
    params: [
      f('exposure', 'Exposure', 0, -8, 8, { unit: 'EV', step: 0.01, softMin: -4, softMax: 4, section: 'Grade' }),
      f('contrast', 'Contrast', 1, 0, 3, { step: 0.01, softMax: 2, section: 'Grade' }),
      f('saturation', 'Saturation', 1, 0, 3, { step: 0.01, softMax: 2, section: 'Grade' }),
      ...color('tint', 'Tint', [1, 1, 1], { section: 'Grade' }),
      f('bloom', 'Bloom', 0.25, 0, 3, { step: 0.01, softMax: 1.5, section: 'Bloom' }),
      f('bloomThreshold', 'Threshold', 1, 0, 10, { step: 0.01, softMax: 4, section: 'Bloom' }),
      f('vignette', 'Vignette', 0, 0, 1, { step: 0.01, section: 'Output' }),
      f('master', 'Master', 1, 0, 1, { step: 0.001, section: 'Output' }),
    ],
  },
  camera: {
    kind: 'camera', label: 'Camera', track: 'camera', exclusive: true,
    params: [
      ...vec3('pos', 'Position', [0, 1.4, 5], { section: 'Camera' }),
      ...vec3('target', 'Look at', [0, 1, 0], { section: 'Camera' }),
      f('fov', 'Field of view', 45, 5, 140, { unit: '°', step: 0.1, section: 'Camera' }),
      f('roll', 'Roll', 0, -180, 180, { unit: '°', step: 0.1, softMin: -45, softMax: 45, section: 'Camera' }),
    ],
  },
  'anim.disperse': {
    kind: 'anim.disperse', label: 'Disperse', track: 'modifier', exclusive: false, hasTargets: true,
    params: [
      f('amount', 'Amount', 0.5, 0, 50, { unit: 'm', step: 0.005, softMax: 3, section: 'Disperse' }),
      f('noiseScale', 'Noise scale', 1.2, 0.01, 50, { step: 0.01, softMax: 8, section: 'Disperse' }),
      f('speed', 'Speed', 0.15, -10, 10, { step: 0.01, softMin: 0, softMax: 2, section: 'Disperse' }),
      f('alongNormal', 'Along normals', 0.3, 0, 1, { step: 0.01, section: 'Disperse' }),
      ...vec3('bias', 'Direction bias', [0, 0.3, 0], { unit: '', softMin: -2, softMax: 2, section: 'Disperse' }),
      f('opacityFalloff', 'Opacity falloff', 0.5, 0, 1, { step: 0.01, section: 'Disperse' }),
      f('shrink', 'Shrink', 0.3, 0, 1, { step: 0.01, section: 'Disperse' }),
    ],
  },
  'anim.wobble': {
    kind: 'anim.wobble', label: 'Wobble', track: 'modifier', exclusive: false, hasTargets: true,
    params: [
      f('amplitude', 'Amplitude', 0.03, 0, 5, { unit: 'm', step: 0.001, softMax: 0.3, section: 'Wobble' }),
      f('frequency', 'Frequency', 0.4, 0, 20, { unit: 'Hz', step: 0.01, softMax: 4, section: 'Wobble' }),
      f('noiseScale', 'Noise scale', 0.8, 0.01, 50, { step: 0.01, softMax: 8, section: 'Wobble' }),
      ...vec3('axis', 'Axis weights', [1, 1, 1], { unit: '', softMin: 0, softMax: 1, min: 0, max: 4, section: 'Wobble' }),
    ],
  },
  'anim.sweep': {
    kind: 'anim.sweep', label: 'Depth sweep', track: 'modifier', exclusive: false, hasTargets: true,
    params: [
      en('pattern', 'Pattern', ['Plane', 'Sphere from point', 'Radial from camera', 'Noise'], 0, { section: 'Sweep' }),
      en('effect', 'Effect', ['Reveal', 'Hide', 'Brighten', 'Tint'], 2, { section: 'Sweep' }),
      f('position', 'Position', 0, -BIG, BIG, { unit: 'm', step: 0.01, softMin: -10, softMax: 10, section: 'Sweep' }),
      f('width', 'Width', 0.6, 0, BIG, { unit: 'm', step: 0.01, softMax: 10, section: 'Sweep' }),
      f('feather', 'Feather', 0.3, 0, BIG, { unit: 'm', step: 0.01, softMax: 5, section: 'Sweep' }),
      ...vec3('origin', 'Origin', [0, 0, 0], { section: 'Sweep' }),
      f('yaw', 'Plane yaw', 0, -720, 720, { unit: '°', step: 0.1, softMin: -180, softMax: 180, section: 'Sweep' }),
      f('pitch', 'Plane pitch', 0, -90, 90, { unit: '°', step: 0.1, section: 'Sweep' }),
      f('noiseScale', 'Noise scale', 1, 0.01, 50, { step: 0.01, softMax: 8, section: 'Sweep' }),
      f('gain', 'Gain', 4, 0, 100, { step: 0.01, softMax: 12, section: 'Sweep' }),
      ...color('tint', 'Tint', [1, 0.55, 0.2], { section: 'Sweep' }),
    ],
  },
  'anim.cutoff': {
    kind: 'anim.cutoff', label: 'Depth cut-off', track: 'modifier', exclusive: false, hasTargets: true,
    params: [
      en('from', 'Measure from', ['Camera', 'Origin'], 0, { section: 'Cut-off' }),
      f('near', 'Near', 0, 0, BIG, { unit: 'm', step: 0.01, softMax: 20, section: 'Cut-off' }),
      f('far', 'Far', 6, 0, BIG, { unit: 'm', step: 0.01, softMax: 20, section: 'Cut-off' }),
      f('feather', 'Feather', 0.3, 0, BIG, { unit: 'm', step: 0.01, softMax: 5, section: 'Cut-off' }),
      bool('invert', 'Invert', false, { section: 'Cut-off' }),
      ...vec3('origin', 'Origin', [0, 0, 0], { section: 'Cut-off' }),
    ],
  },
};

export const KIND_LIST = Object.values(KINDS);
export const kindsForTrack = (t: TrackType) => KIND_LIST.filter((k) => k.track === t);

const defIndex = new Map<string, ParamDef>();
for (const k of KIND_LIST) for (const p of k.params) defIndex.set(`${k.kind}/${p.id}`, p);
export const paramDef = (kind: Kind, id: string): ParamDef | undefined => defIndex.get(`${kind}/${id}`);

export interface ParamGroup { id: string; label: string; widget?: 'vec3' | 'color'; defs: ParamDef[]; section: string }

/** Parameters of a kind folded into rows (vec3 and colour groups become one row). */
export function paramGroups(kind: Kind): ParamGroup[] {
  const out: ParamGroup[] = [];
  const seen = new Map<string, ParamGroup>();
  for (const d of KINDS[kind].params) {
    if (d.group) {
      let g = seen.get(d.group);
      if (!g) {
        g = { id: d.group, label: d.groupLabel ?? d.group, widget: d.widget, defs: [], section: d.section ?? '' };
        seen.set(d.group, g);
        out.push(g);
      }
      g.defs.push(d);
    } else out.push({ id: d.id, label: d.label, defs: [d], section: d.section ?? '' });
  }
  return out;
}

export const TRACK_LABEL: Record<TrackType, string> = { camera: 'Camera', light: 'Light', modifier: 'Modifier', global: 'Global' };
