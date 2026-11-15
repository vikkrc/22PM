// A small ready-made show: the procedural courtyard lit by a few animated lights.
// Used for first launch, the render harness and golden tests. Ids are fixed so output is reproducible.
import { makeClip, makeModulator, makeShow, makeInstance, type Clip, type LfoMod, type BeatMod, type Show } from '../core/model';

export function makeDemoShow(courtyardAsset: string, objectAsset?: string): Show {
  const show = makeShow();
  const song = show.songs[0];
  song.id = 'song_demo';
  song.title = 'Demo – courtyard';
  song.tempo = { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 };
  song.lengthBeats = 64;
  song.sections = [{ id: 'sec_a', name: 'Intro', start: 0 }, { id: 'sec_b', name: 'Verse', start: 16 }, { id: 'sec_c', name: 'Chorus', start: 32 }, { id: 'sec_d', name: 'Outro', start: 48 }];
  show.assets.push({ id: courtyardAsset, type: 'splat', name: 'Demo courtyard', versions: [{ id: 'raw', label: 'raw', file: '', created: '' }] });
  const yard = { ...makeInstance(courtyardAsset, 'Courtyard'), id: 'spl_yard' };
  song.scene.splats.push(yard);
  if (objectAsset) {
    show.assets.push({ id: objectAsset, type: 'splat', name: 'Demo vase', versions: [{ id: 'raw', label: 'raw', file: '', created: '' }] });
    song.scene.splats.push({ ...makeInstance(objectAsset, 'Vase'), id: 'spl_vase', pos: [2.1, 0.74, 0.95], scale: 0.6 });
  }
  song.tracks.forEach((t, i) => (t.id = `trk_${i}`));
  const base = song.scene.base;
  base.camera.length = base.global.length = base.post.length = song.lengthBeats;
  Object.assign(base.camera.params, { 'pos.x': { base: 0.6 }, 'pos.y': { base: 1.5 }, 'pos.z': { base: 6.2 }, 'target.x': { base: 0 }, 'target.y': { base: 0.9 }, 'target.z': { base: 0 }, fov: { base: 42 } });
  base.global.params.intensity = { base: 0.05 };

  const clip = (c: Clip, id: string, name: string, set: Record<string, number>) => {
    c.id = id; c.name = name;
    for (const [k, v] of Object.entries(set)) c.params[k] = { base: v };
    return c;
  };
  const key = (t: number, v: number, interp: 'linear' | 'bezier' | 'hold' = 'bezier') => ({ id: `k${t}_${v}`, t, v, interp });

  // Slow camera push across the whole song.
  const cam = clip(makeClip('camera', 0, 64), 'clip_cam', 'Slow push', { 'pos.x': 0.6, 'pos.y': 1.5, 'pos.z': 6.2, 'target.y': 0.9, fov: 42 });
  cam.params['pos.z'].keys = [key(0, 6.6), key(64, 5.2)];
  cam.params['pos.x'].keys = [key(0, 1.2), key(64, -0.6)];
  song.tracks[0].clips.push(cam);

  // Warm spot sweeping across the frames.
  const spot = clip(makeClip('light.spot', 0, 48), 'clip_spot', 'Key spot', {
    'pos.x': -3, 'pos.y': 4.2, 'pos.z': 3.5, 'target.x': 0, 'target.y': 0.6, 'target.z': -1.5,
    'color.r': 1, 'color.g': 0.72, 'color.b': 0.42, intensity: 70, cone: 42, penumbra: 0.5, range: 18,
  });
  spot.fadeIn = 4;
  spot.params['target.x'].keys = [key(0, -3), key(24, 3), key(48, -1)];
  song.tracks[1].clips.push(spot);

  // A low point light breathing on the beat, cold.
  const point = clip(makeClip('light.point', 8, 56), 'clip_point', 'Low point', {
    'pos.x': 0.3, 'pos.y': 0.5, 'pos.z': 1.7, 'color.r': 0.35, 'color.g': 0.55, 'color.b': 1, intensity: 5, range: 7,
  });
  const beat = makeModulator('beat', 5) as BeatMod;
  beat.id = 'mod_beat'; beat.every = 1; beat.env = { a: 0.005, d: 0.28, s: 0, hold: 0, r: 0.05 };
  point.params.intensity.mods = [beat];
  const lfo = makeModulator('lfo', 0.6) as LfoMod;
  lfo.id = 'mod_lfo'; lfo.rateBeats = 16;
  point.params['pos.x'].mods = [lfo];
  song.tracks[2].clips.push(point);

  // Low sun raking across in the chorus.
  const sun = clip(makeClip('light.sun', 32, 16), 'clip_sun', 'Raking sun', { azimuth: -60, elevation: 14, 'color.r': 1, 'color.g': 0.5, 'color.b': 0.3, intensity: 1.6 });
  sun.fadeIn = 2; sun.fadeOut = 4;
  sun.params.azimuth.keys = [key(0, -70, 'linear'), key(16, 20)];
  song.tracks[1].clips.push(sun);

  // Depth sweep in the verse, disperse in the outro, gentle wobble throughout.
  const sweep = clip(makeClip('anim.sweep', 16, 16), 'clip_sweep', 'Sweep', { pattern: 1, effect: 3, width: 0.5, feather: 0.6, gain: 5 });
  sweep.params.position.keys = [key(0, 0, 'linear'), key(16, 9)];
  song.tracks[3].clips.push(sweep);
  const disperse = clip(makeClip('anim.disperse', 48, 16), 'clip_disperse', 'Come apart', { amount: 0, noiseScale: 1.1 });
  disperse.params.amount.keys = [key(0, 0), key(16, 1.6)];
  song.tracks[3].clips.push(disperse);
  return show;
}
