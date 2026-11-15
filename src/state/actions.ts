// Editing operations on the show. UI code calls these; nothing else mutates the document.
import { KINDS, paramDef, type Kind, type ParamDef, type TrackType } from '../core/registry';
import {
  findClip, makeClip, makeModulator, makeSong, makeTrack, type Clip, type Ease, type Interp, type Keyframe, type ModType, type Modulator, type ParamState, type Song, type SplatInstance,
} from '../core/model';
import { evalKeys, sortKeys } from '../core/curves';
import { newId } from '../core/rng';
import { quantizeTicks, secToBeat } from '../core/tempo';
import { clamp } from '../core/math';
import { commit, currentSong, getState, select, setUi, toast, update } from './store';
import { transport } from './transport';

export const playheadBeat = (song: Song = currentSong()) => secToBeat(song.tempo, transport.sec);

/** Value shown in the inspector: keyframe curve at the playhead if keyed, else the base. Modulators excluded. */
export function staticValue(clip: Clip, id: string, beat: number): number {
  const st = clip.params[id];
  const def = paramDef(clip.kind, id);
  if (!st) return def?.def ?? 0;
  return st.keys?.length ? evalKeys(st.keys, beat - clip.start) : st.base;
}

const getClip = (song: Song, id: string) => findClip(song, id)?.clip;
const pstate = (c: Clip, id: string, def: ParamDef): ParamState => (c.params[id] ??= { base: def.def });

function writeValue(c: Clip, def: ParamDef, value: number, beat: number) {
  const st = pstate(c, def.id, def);
  const v = clamp(def.type === 'float' ? value : Math.round(value), def.min, def.max);
  if (st.keys?.length) {
    const t = quantizeTicks(beat - c.start);
    const k = st.keys.find((x) => Math.abs(x.t - t) < 1e-4);
    if (k) k.v = v;
    else {
      const prev = [...st.keys].reverse().find((x) => x.t < t);
      st.keys = sortKeys([...st.keys, { id: newId('k'), t, v, interp: def.type === 'float' ? prev?.interp ?? 'bezier' : 'hold', ease: prev?.ease }]);
    }
  } else st.base = v;
}

/** Set one or more parameters. Keyed parameters get a keyframe at the playhead (auto-key). */
export function setParams(clipId: string, values: Record<string, number>, mergeKey?: string) {
  const beat = playheadBeat();
  update((_s, song) => {
    const c = getClip(song, clipId);
    if (!c) return;
    for (const [id, v] of Object.entries(values)) {
      const def = paramDef(c.kind, id);
      if (def && Number.isFinite(v)) writeValue(c, def, v, beat);
    }
  }, mergeKey ? `param:${clipId}:${mergeKey}` : undefined);
}

export function hasKeyAt(clip: Clip, id: string, beat: number): boolean {
  const t = quantizeTicks(beat - clip.start);
  return !!clip.params[id]?.keys?.some((k) => Math.abs(k.t - t) < 1e-4);
}

/** Toggle a keyframe at the playhead for a group of parameters (a vec3 or colour keys all components). */
export function toggleKeys(clipId: string, ids: string[]) {
  const song = currentSong();
  const beat = playheadBeat(song);
  const clip = getClip(song, clipId);
  if (!clip) return;
  const allHave = ids.every((id) => hasKeyAt(clip, id, beat));
  update((_s, sg) => {
    const c = getClip(sg, clipId)!;
    const t = quantizeTicks(beat - c.start);
    for (const id of ids) {
      const def = paramDef(c.kind, id)!;
      const st = pstate(c, id, def);
      if (allHave) {
        st.keys = st.keys!.filter((k) => Math.abs(k.t - t) >= 1e-4);
        if (!st.keys.length) delete st.keys;
      } else if (!hasKeyAt(c, id, beat)) {
        const v = st.keys?.length ? evalKeys(st.keys, t) : st.base;
        st.keys = sortKeys([...(st.keys ?? []), { id: newId('k'), t, v, interp: def.type === 'float' ? 'bezier' : 'hold' }]);
      }
    }
  });
}

export function clearKeys(clipId: string, ids: string[]) {
  const beat = playheadBeat();
  update((_s, song) => {
    const c = getClip(song, clipId);
    if (!c) return;
    for (const id of ids) {
      const st = c.params[id];
      if (!st?.keys) continue;
      st.base = evalKeys(st.keys, beat - c.start);
      delete st.keys;
    }
  });
}

export function moveKeys(clipId: string, moves: { param: string; keyId: string; t: number; v?: number }[], merge = true) {
  update((_s, song) => {
    const c = getClip(song, clipId);
    if (!c) return;
    const touched = new Set<string>();
    for (const m of moves) {
      const k = c.params[m.param]?.keys?.find((x) => x.id === m.keyId);
      if (!k) continue;
      k.t = quantizeTicks(m.t);
      if (m.v != null) { const def = paramDef(c.kind, m.param)!; k.v = clamp(m.v, def.min, def.max); }
      touched.add(m.param);
    }
    for (const p of touched) c.params[p].keys = sortKeys(c.params[p].keys!);
  }, merge ? `keys:${clipId}` : undefined);
}

export function editKeys(clipId: string, refs: { param: string; keyId: string }[], patch: Partial<Pick<Keyframe, 'v' | 't' | 'interp' | 'ease'>>) {
  update((_s, song) => {
    const c = getClip(song, clipId);
    if (!c) return;
    for (const r of refs) {
      const def = paramDef(c.kind, r.param);
      const k = c.params[r.param]?.keys?.find((x) => x.id === r.keyId);
      if (!k || !def) continue;
      if (patch.v != null) k.v = clamp(patch.v, def.min, def.max);
      if (patch.t != null) k.t = quantizeTicks(patch.t);
      if (patch.interp && def.type === 'float') k.interp = patch.interp;
      if (patch.ease) { k.ease = patch.ease; if (def.type === 'float') k.interp = 'bezier'; }
      c.params[r.param].keys = sortKeys(c.params[r.param].keys!);
    }
  }, `keyedit:${clipId}`);
}

export function deleteSelectedKeys(): boolean {
  const { ui } = getState();
  if (ui.selection.type !== 'clip' || !ui.selectedKeys.length) return false;
  const clipId = ui.selection.id;
  update((_s, song) => {
    const c = getClip(song, clipId);
    if (!c) return;
    for (const r of ui.selectedKeys) {
      const st = c.params[r.param];
      if (!st?.keys) continue;
      st.keys = st.keys.filter((k) => k.id !== r.keyId);
      if (!st.keys.length) delete st.keys;
    }
  });
  setUi({ selectedKeys: [] });
  return true;
}

// ---- modulators ------------------------------------------------------------------------------

export function addModulator(clipId: string, paramId: string, type: ModType) {
  update((_s, song) => {
    const c = getClip(song, clipId);
    const def = c && paramDef(c.kind, paramId);
    if (!c || !def || !def.mod) return;
    const range = (def.softMax ?? def.max) - (def.softMin ?? def.min);
    const st = pstate(c, paramId, def);
    const m = makeModulator(type, Math.round(range * 0.25 * 1000) / 1000);
    if (type === 'section') for (const s of song.sections) (m as any).values[s.id] = 0;
    st.mods = [...(st.mods ?? []), m];
  });
}
export function patchModulator(clipId: string, paramId: string, modId: string, patch: Partial<Modulator> | ((m: any) => void)) {
  update((_s, song) => {
    const m = getClip(song, clipId)?.params[paramId]?.mods?.find((x) => x.id === modId);
    if (!m) return;
    if (typeof patch === 'function') patch(m); else Object.assign(m, patch);
  }, `mod:${modId}`);
}
export function removeModulator(clipId: string, paramId: string, modId: string) {
  update((_s, song) => {
    const st = getClip(song, clipId)?.params[paramId];
    if (!st?.mods) return;
    st.mods = st.mods.filter((m) => m.id !== modId);
    if (!st.mods.length) delete st.mods;
  });
}
let modClipboard: Modulator[] | null = null;
export const hasModClipboard = () => !!modClipboard?.length;
export function copyModulators(clipId: string, paramId: string) {
  const mods = getClip(currentSong(), clipId)?.params[paramId]?.mods;
  modClipboard = mods ? structuredClone(mods) : null;
  toast(mods?.length ? `Copied ${mods.length} modulator${mods.length > 1 ? 's' : ''}` : 'Nothing to copy');
}
export function pasteModulators(clipId: string, paramId: string) {
  if (!modClipboard) return;
  update((_s, song) => {
    const c = getClip(song, clipId);
    const def = c && paramDef(c.kind, paramId);
    if (!c || !def?.mod) return;
    pstate(c, paramId, def).mods = structuredClone(modClipboard!).map((m) => ({ ...m, id: newId('mod') }));
  });
}

// ---- clips -----------------------------------------------------------------------------------

export function addClip(trackId: string, kind: Kind, start: number, length?: number): string | null {
  let id: string | null = null;
  update((_s, song) => {
    const tr = song.tracks.find((t) => t.id === trackId);
    if (!tr || KINDS[kind].track !== tr.type) return;
    const len = length ?? song.tempo.beatsPerBar * 4;
    const c = makeClip(kind, Math.max(0, start), len);
    const n = song.tracks.flatMap((t) => t.clips).filter((x) => x.kind === kind).length;
    c.name = `${KINDS[kind].label}${n ? ` ${n + 1}` : ''}`;
    if (kind === 'camera' || kind === 'global' || kind === 'post') {
      // Start from what is on screen now, so a new clip does not jump.
      const base = kind === 'camera' ? song.scene.base.camera : kind === 'global' ? song.scene.base.global : song.scene.base.post;
      for (const d of KINDS[kind].params) c.params[d.id] = { base: staticValue(base, d.id, start) };
    }
    tr.clips.push(c);
    id = c.id;
  });
  if (id) select({ type: 'clip', id });
  return id;
}

export function patchClip(clipId: string, patch: Partial<Pick<Clip, 'name' | 'start' | 'length' | 'fadeIn' | 'fadeOut' | 'muted' | 'targets'>>, merge?: string) {
  update((_s, song) => {
    const c = getClip(song, clipId);
    if (!c) return;
    Object.assign(c, patch);
    c.start = quantizeTicks(Math.max(0, c.start));
    c.length = Math.max(1 / 16, quantizeTicks(c.length));
    c.fadeIn = clamp(c.fadeIn, 0, c.length);
    c.fadeOut = clamp(c.fadeOut, 0, c.length);
  }, merge ? `clip:${clipId}:${merge}` : undefined);
}

/** Move a clip in time and optionally to another track of the same type. */
export function moveClip(clipId: string, start: number, trackId?: string) {
  update((_s, song) => {
    const f = findClip(song, clipId);
    if (!f || !f.track) return;
    f.clip.start = quantizeTicks(Math.max(0, start));
    if (trackId && trackId !== f.track.id) {
      const to = song.tracks.find((t) => t.id === trackId);
      if (to && to.type === f.track.type) {
        f.track.clips = f.track.clips.filter((c) => c.id !== clipId);
        to.clips.push(f.clip);
      }
    }
  }, `clip:${clipId}:move`);
}

export function deleteClip(clipId: string) {
  update((_s, song) => { for (const t of song.tracks) t.clips = t.clips.filter((c) => c.id !== clipId); });
  select({ type: 'none' });
}

export function duplicateClip(clipId: string) {
  let id: string | null = null;
  update((_s, song) => {
    const f = findClip(song, clipId);
    if (!f?.track) return;
    const c = structuredClone(f.clip);
    c.id = newId('clip');
    c.start = quantizeTicks(f.clip.start + f.clip.length);
    c.name = `${f.clip.name} copy`;
    for (const st of Object.values(c.params)) {
      st.keys?.forEach((k) => (k.id = newId('k')));
      st.mods?.forEach((m) => (m.id = newId('mod')));
    }
    f.track.clips.push(c);
    id = c.id;
  });
  if (id) select({ type: 'clip', id });
}

export function splitClip(clipId: string, beat: number) {
  update((_s, song) => {
    const f = findClip(song, clipId);
    if (!f?.track) return;
    const c = f.clip;
    const at = quantizeTicks(beat);
    if (at <= c.start || at >= c.start + c.length) return;
    const b = structuredClone(c);
    b.id = newId('clip');
    const off = at - c.start;
    b.start = at; b.length = c.length - off; b.fadeIn = 0;
    c.length = off; c.fadeOut = 0;
    // Both halves keep the full curve; the second is shifted so it continues where the first left off.
    for (const st of Object.values(b.params)) {
      st.keys?.forEach((k) => { k.id = newId('k'); k.t = quantizeTicks(k.t - off); });
      st.mods?.forEach((m) => (m.id = newId('mod')));
    }
    f.track.clips.push(b);
  });
}

// ---- tracks ----------------------------------------------------------------------------------

export function addTrack(type: TrackType) {
  update((_s, song) => {
    const n = song.tracks.filter((t) => t.type === type).length + 1;
    const label = { camera: 'Camera', light: 'Lights', modifier: 'Modifiers', global: 'Global' }[type];
    const tr = makeTrack(type, `${label} ${n}`);
    let last = -1;
    song.tracks.forEach((t, i) => { if (t.type === type) last = i; });
    song.tracks.splice(last < 0 ? song.tracks.length : last + 1, 0, tr);
  });
}
export function patchTrack(trackId: string, patch: { name?: string; muted?: boolean }) {
  update((_s, song) => { const t = song.tracks.find((x) => x.id === trackId); if (t) Object.assign(t, patch); });
}
export function deleteTrack(trackId: string) {
  update((_s, song) => { song.tracks = song.tracks.filter((t) => t.id !== trackId); });
  select({ type: 'none' });
}

// ---- splats ----------------------------------------------------------------------------------

export function patchSplat(id: string, patch: Partial<SplatInstance>, merge?: string) {
  update((_s, song) => { const s = song.scene.splats.find((x) => x.id === id); if (s) Object.assign(s, patch); }, merge ? `splat:${id}:${merge}` : undefined);
}
export function removeSplat(id: string) {
  update((_s, song) => {
    song.scene.splats = song.scene.splats.filter((x) => x.id !== id);
    for (const t of song.tracks) for (const c of t.clips) if (c.targets) c.targets = c.targets.filter((x) => x !== id);
  });
  select({ type: 'none' });
}

// ---- songs -----------------------------------------------------------------------------------

export function patchSong(patch: (song: Song) => void, merge?: string) { update((_s, song) => patch(song), merge ? `song:${merge}` : undefined); }

export function setSongLength(beats: number) {
  patchSong((song) => {
    song.lengthBeats = Math.max(song.tempo.beatsPerBar, Math.round(beats));
    for (const c of Object.values(song.scene.base)) c.length = song.lengthBeats;
  }, 'len');
}

export function addSong() {
  let id = '';
  update((show) => {
    const s = makeSong(`Song ${show.songs.length + 1}`);
    const prev = show.songs[show.songs.length - 1];
    if (prev) {
      // Next free timecode slot: ten minutes after the previous song's start.
      const m = prev.startTimecode.match(/^(\d+):(\d+):(\d+):(\d+)$/);
      if (m) { const total = +m[1] * 60 + +m[2] + 10; s.startTimecode = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00:00`; }
    }
    show.songs.push(s);
    id = s.id;
  });
  setUi({ songId: id, selection: { type: 'song' }, selectedKeys: [] });
}
export function removeSong(id: string) {
  if (getState().show.songs.length <= 1) return;
  update((show) => { show.songs = show.songs.filter((s) => s.id !== id); });
  const s = getState();
  if (s.ui.songId === id) setUi({ songId: s.show.songs[0].id, selection: { type: 'none' } });
}
export function moveSong(id: string, dir: -1 | 1) {
  update((show) => {
    const i = show.songs.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= show.songs.length) return;
    [show.songs[i], show.songs[j]] = [show.songs[j], show.songs[i]];
  });
}

export function addSection(beat: number) {
  patchSong((song) => {
    const start = Math.max(0, Math.round(beat / song.tempo.beatsPerBar) * song.tempo.beatsPerBar);
    if (song.sections.some((s) => s.start === start)) return;
    song.sections.push({ id: newId('sec'), name: `Section ${song.sections.length + 1}`, start });
    song.sections.sort((a, b) => a.start - b.start);
  });
}

export { commit };
export type { Ease, Interp };
