// Timeline: ruler, sections, waveform, tracks with clips, and keyframe lanes for the selected clip.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { KINDS, kindsForTrack, paramGroups, TRACK_LABEL, type Kind, type ParamGroup, type TrackType } from '../core/registry';
import { findClip, type Clip, type Song, type Track } from '../core/model';
import { evalKeys } from '../core/curves';
import { beatToSec, formatBBT, formatClock, secToBeat, SNAP_LABEL, SNAP_MODES, snapBeat, type SnapMode } from '../core/tempo';
import { analysisFor, importAudioFile } from '../state/runtime';
import { commit, getState, select, setUi, useSong, useStore } from '../state/store';
import { transport } from '../state/transport';
import { addClip, addSection, addTrack, deleteTrack, moveClip, moveKeys, patchClip, patchTrack, toggleKeys } from '../state/actions';
import { Menu, Select, Text } from './widgets';

const HEAD_W = 184;

/** Follow a drag on the window, so it survives the dragged element re-rendering or moving between rows. */
function trackDrag(move: (ev: PointerEvent) => void, end?: () => void) {
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); end?.(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

const snapOf = (e: { altKey: boolean }): SnapMode => (e.altKey ? 'off' : getState().ui.snap);

function useLaneMetrics() {
  const ppb = useStore((s) => s.ui.pxPerBeat);
  const scroll = useStore((s) => s.ui.scrollBeat);
  return { ppb, scroll, x: (beat: number) => (beat - scroll) * ppb };
}

/** Zoom keeping the beat under `anchorPx` fixed. */
function zoomAt(factor: number, anchorPx: number) {
  const { pxPerBeat, scrollBeat } = getState().ui;
  const next = Math.min(400, Math.max(1.5, pxPerBeat * factor));
  const beat = scrollBeat + anchorPx / pxPerBeat;
  setUi({ pxPerBeat: next, scrollBeat: beat - anchorPx / next });
}

function Ruler({ song, width }: { song: Song; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { ppb, scroll } = useLaneMetrics();
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const H = 38;
    c.width = Math.max(1, width * dpr); c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, H);
    const bpb = song.tempo.beatsPerBar;
    const barPx = ppb * bpb;
    let barStep = 1;
    while (barPx * barStep < 56) barStep *= barStep === 1 ? 2 : barStep === 2 ? 2 : 2;
    const b0 = Math.floor(scroll / bpb) - 1, b1 = Math.ceil((scroll + width / ppb) / bpb) + 1;
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'top';
    // Sections band.
    song.sections.forEach((s, i) => {
      const x0 = (s.start - scroll) * ppb;
      const x1 = ((song.sections[i + 1]?.start ?? song.lengthBeats) - scroll) * ppb;
      if (x1 < 0 || x0 > width) return;
      g.fillStyle = i % 2 ? 'rgba(255,178,36,0.10)' : 'rgba(255,178,36,0.18)';
      g.fillRect(x0, 0, x1 - x0 - 1, 14);
      g.fillStyle = '#e9c98a';
      g.save(); g.beginPath(); g.rect(x0, 0, x1 - x0 - 2, 14); g.clip();
      g.fillText(s.name, Math.max(x0, 0) + 5, 2);
      g.restore();
    });
    for (let bar = b0; bar <= b1; bar++) {
      const x = Math.round((bar * bpb - scroll) * ppb) + 0.5;
      const major = bar % barStep === 0;
      g.strokeStyle = major ? '#5a616b' : '#343941';
      g.beginPath(); g.moveTo(x, major ? 16 : 28); g.lineTo(x, H); g.stroke();
      if (major) { g.fillStyle = bar >= 0 ? '#9aa1ab' : '#5a616b'; g.fillText(String(bar + 1), x + 4, 18); }
      if (ppb >= 7) for (let b = 1; b < bpb; b++) {
        const bx = Math.round((bar * bpb + b - scroll) * ppb) + 0.5;
        g.strokeStyle = '#2c3138';
        g.beginPath(); g.moveTo(bx, 32); g.lineTo(bx, H); g.stroke();
        if (ppb >= 48) { g.fillStyle = '#5f6670'; g.fillText(`${bar + 1}.${b + 1}`, bx + 4, 24); }
      }
    }
    const endX = (song.lengthBeats - scroll) * ppb;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    if (endX < width) g.fillRect(endX, 0, width - endX, H);
  }, [song.tempo, song.sections, song.lengthBeats, ppb, scroll, width]);

  const scrub = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const go = (ev: { clientX: number; altKey: boolean }) => {
      const r = el.getBoundingClientRect();
      const { pxPerBeat, scrollBeat } = getState().ui;
      const beat = snapBeat(song.tempo, scrollBeat + (ev.clientX - r.left) / pxPerBeat, transport.playing ? 'off' : snapOf(ev));
      transport.seek(beatToSec(song.tempo, Math.min(song.lengthBeats, Math.max(-song.tempo.beatsPerBar, beat))));
    };
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    trackDrag(move);
  };
  return <canvas ref={ref} className="tl-ruler" style={{ width, height: 38 }} onPointerDown={scrub} onDoubleClick={(e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientY - r.top < 15) addSection(getState().ui.scrollBeat + (e.clientX - r.left) / getState().ui.pxPerBeat);
  }} title="Drag to scrub · Alt = no snap · double-click the top strip to add a section" />;
}

function Waveform({ song, width }: { song: Song; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { ppb, scroll } = useLaneMetrics();
  const gen = useStore((s) => s.assetGen);
  const an = analysisFor(song);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const H = 44;
    c.width = Math.max(1, width * dpr); c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, H);
    if (!an) return;
    const secAt = (px: number) => beatToSec(song.tempo, scroll + px / ppb);
    g.fillStyle = '#56606d';
    for (let px = 0; px < width; px++) {
      const i0 = Math.floor(secAt(px) * an.peaksPerSec), i1 = Math.max(i0 + 1, Math.floor(secAt(px + 1) * an.peaksPerSec));
      if (i1 < 0 || i0 * 2 >= an.peaks.length) continue;
      let lo = 0, hi = 0;
      for (let i = Math.max(0, i0); i < i1 && i * 2 + 1 < an.peaks.length; i++) { lo = Math.min(lo, an.peaks[i * 2]); hi = Math.max(hi, an.peaks[i * 2 + 1]); }
      const y0 = H / 2 - hi * (H / 2 - 3), y1 = H / 2 - lo * (H / 2 - 3);
      g.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
    const t0 = secAt(0), t1 = secAt(width);
    const marks = (list: { times: Float32Array; strengths: Float32Array }, color: string, y: number) => {
      g.fillStyle = color;
      for (let i = 0; i < list.times.length; i++) {
        const t = list.times[i];
        if (t < t0 || t > t1) continue;
        const x = (secToBeat(song.tempo, t) - scroll) * ppb;
        g.globalAlpha = 0.35 + 0.65 * list.strengths[i];
        g.fillRect(Math.round(x), y, 1.5, 5);
      }
      g.globalAlpha = 1;
    };
    if (ppb > 3) { marks(an.onsets.kick, '#ffb224', H - 6); marks(an.onsets.snare, '#6aa9ff', 1); }
  }, [an, gen, song.tempo, ppb, scroll, width]);
  return <canvas ref={ref} className="tl-wave" style={{ width, height: 44 }} />;
}

function ClipView({ clip, track, song }: { clip: Clip; track: Track; song: Song }) {
  const { ppb, x } = useLaneMetrics();
  const selected = useStore((s) => s.ui.selection.type === 'clip' && s.ui.selection.id === clip.id);
  const left = x(clip.start), w = Math.max(4, clip.length * ppb);
  const keyTimes = [...new Set(Object.values(clip.params).flatMap((p) => p.keys?.map((k) => k.t) ?? []))];
  const mods = Object.values(clip.params).some((p) => p.mods?.length);

  const startDrag = (e: React.PointerEvent, mode: 'move' | 'l' | 'r' | 'fi' | 'fo') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    select({ type: 'clip', id: clip.id });
    const el = e.currentTarget as HTMLElement;
    const x0 = e.clientX, start0 = clip.start, len0 = clip.length, fi0 = clip.fadeIn, fo0 = clip.fadeOut;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const db = (ev.clientX - x0) / getState().ui.pxPerBeat;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const sn = (b: number) => snapBeat(song.tempo, b, snapOf(ev));
      if (mode === 'move') {
        // Vertical drag moves the clip to another track of the same type.
        const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-track]') as HTMLElement | null;
        moveClip(clip.id, sn(start0 + db), row?.dataset.track);
      } else if (mode === 'l') {
        const ns = Math.min(sn(start0 + db), start0 + len0 - 1 / 16);
        const s = Math.max(0, ns);
        patchClip(clip.id, { start: s, length: start0 + len0 - s }, 'trim');
      } else if (mode === 'r') patchClip(clip.id, { length: Math.max(1 / 16, sn(start0 + len0 + db) - start0) }, 'trim');
      else if (mode === 'fi') patchClip(clip.id, { fadeIn: Math.max(0, sn(start0 + fi0 + db) - start0) }, 'fade');
      else patchClip(clip.id, { fadeOut: Math.max(0, start0 + len0 - sn(start0 + len0 - fo0 + db)) }, 'fade');
    };
    trackDrag(move, commit);
  };

  const fiW = clip.fadeIn * ppb, foW = clip.fadeOut * ppb;
  return (
    <div className={`clip track-${track.type} ${selected ? 'sel' : ''} ${clip.muted ? 'muted' : ''}`} style={{ left, width: w }}
      onPointerDown={(e) => startDrag(e, 'move')} onDoubleClick={(e) => { e.stopPropagation(); transport.seek(beatToSec(song.tempo, clip.start)); }}
      title={`${clip.name} · ${KINDS[clip.kind].label} · ${formatBBT(song.tempo, clip.start)} → ${formatBBT(song.tempo, clip.start + clip.length)}`}>
      {fiW > 0 && <svg className="fade" style={{ left: 0, width: fiW }} viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M0 0H10L0 10Z" /></svg>}
      {foW > 0 && <svg className="fade" style={{ right: 0, width: foW }} viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M0 0H10V10Z" /></svg>}
      <span className="clip-name">{clip.name}{mods ? <span className="clip-mod" title="Has modulators"> ∿</span> : null}</span>
      {keyTimes.map((t) => t >= 0 && t <= clip.length ? <i key={t} className="clip-key" style={{ left: t * ppb }} /> : null)}
      {w > 28 && <>
        <span className="fade-h in" style={{ left: Math.min(fiW, w - 12) }} onPointerDown={(e) => startDrag(e, 'fi')} title="Drag: fade in" />
        <span className="fade-h out" style={{ right: Math.min(foW, w - 12) }} onPointerDown={(e) => startDrag(e, 'fo')} title="Drag: fade out" />
      </>}
      <span className="clip-edge l" onPointerDown={(e) => startDrag(e, 'l')} />
      <span className="clip-edge r" onPointerDown={(e) => startDrag(e, 'r')} />
    </div>
  );
}

function kindItems(type: TrackType, onPick: (k: Kind) => void) {
  return kindsForTrack(type).map((k) => ({ label: k.label, onClick: () => onPick(k.kind) }));
}

function TrackRow({ track, song }: { track: Track; song: Song }) {
  const selected = useStore((s) => s.ui.selection.type === 'track' && s.ui.selection.id === track.id);
  const [menu, setMenu] = useState<{ x: number; beat: number } | null>(null);
  const kinds = kindsForTrack(track.type);
  const addAt = (kind: Kind, beat: number) => addClip(track.id, kind, snapBeat(song.tempo, beat, getState().ui.snap === 'off' ? '1' : getState().ui.snap));
  return (
    <div className={`tl-row track track-${track.type} ${track.muted ? 'muted' : ''} ${selected ? 'sel' : ''}`}>
      <div className="tl-head" onClick={() => select({ type: 'track', id: track.id })}>
        <span className="track-stripe" />
        <Text className="track-name" value={track.name} onChange={(name) => patchTrack(track.id, { name })} />
        <button className={`mini ${track.muted ? 'on warn' : ''}`} title="Mute track" onClick={(e) => { e.stopPropagation(); patchTrack(track.id, { muted: !track.muted }); }}>M</button>
        <Menu trigger="+" title={`Add a ${TRACK_LABEL[track.type].toLowerCase()} clip at the playhead`} className="tight"
          items={[...kindItems(track.type, (k) => addAt(k, secToBeat(song.tempo, transport.sec))), 'sep', { label: 'Delete track', danger: true, disabled: track.clips.length > 0, onClick: () => deleteTrack(track.id) }]} />
      </div>
      <div className="tl-lane" data-track={track.id}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const beat = getState().ui.scrollBeat + (e.clientX - r.left) / getState().ui.pxPerBeat;
          if (kinds.length === 1) addAt(kinds[0].kind, beat); else setMenu({ x: e.clientX - r.left, beat });
        }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) { select({ type: 'none' }); setMenu(null); } }}>
        {track.clips.map((c) => <ClipView key={c.id} clip={c} track={track} song={song} />)}
        {track.clips.length === 0 && !menu && <span className="lane-hint">Double-click to add a {kinds.length === 1 ? kinds[0].label.toLowerCase() : TRACK_LABEL[track.type].toLowerCase()} clip</span>}
        {menu && (
          <div className="menu inline" style={{ left: menu.x }} onPointerDown={(e) => e.stopPropagation()}>
            {kinds.map((k) => <button key={k.kind} className="menu-item" onClick={() => { addAt(k.kind, menu.beat); setMenu(null); }}>{k.label}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

const AXIS_COLORS = ['#ff6b6b', '#7bd88f', '#6aa9ff'];

function KeyLane({ clip, group, song, width }: { clip: Clip; group: ParamGroup; song: Song; width: number }) {
  const { ppb, x, scroll } = useLaneMetrics();
  const selectedKeys = useStore((s) => s.ui.selectedKeys);
  const keyed = group.defs.filter((d) => clip.params[d.id]?.keys?.length);
  // One diamond per distinct time across the group's components.
  const times = [...new Set(keyed.flatMap((d) => clip.params[d.id]!.keys!.map((k) => k.t)))].sort((a, b) => a - b);
  const refsAt = (t: number) => keyed.flatMap((d) => clip.params[d.id]!.keys!.filter((k) => Math.abs(k.t - t) < 1e-4).map((k) => ({ param: d.id, keyId: k.id })));
  const isSel = (t: number) => refsAt(t).some((r) => selectedKeys.some((s) => s.keyId === r.keyId));

  // Curve preview, normalised to the range of the key values.
  const H = 26;
  const paths = keyed.map((d, i) => {
    const keys = clip.params[d.id]!.keys!;
    let lo = Infinity, hi = -Infinity;
    for (const k of keys) { lo = Math.min(lo, k.v); hi = Math.max(hi, k.v); }
    // Bezier overshoot can leave the key range; sample first.
    const pts: [number, number][] = [];
    for (let px = 0; px <= width; px += 3) { const v = evalKeys(keys, scroll + px / ppb - clip.start); pts.push([px, v]); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const span = hi - lo || 1;
    const d2 = pts.map(([px, v], j) => `${j ? 'L' : 'M'}${px} ${(H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1)}`).join('');
    return <path key={d.id} d={d2} stroke={group.defs.length > 1 ? AXIS_COLORS[group.defs.indexOf(d)] : 'currentColor'} opacity={hi === lo ? 0.35 : 0.9} />;
  });

  const dragKey = (e: React.PointerEvent, t: number) => {
    e.stopPropagation();
    const here = refsAt(t);
    let refs = getState().ui.selectedKeys;
    if (e.shiftKey) refs = isSel(t) ? refs.filter((r) => !here.some((h) => h.keyId === r.keyId)) : [...refs, ...here];
    else if (!isSel(t)) refs = here;
    setUi({ selectedKeys: refs });
    const el = e.currentTarget as HTMLElement;
    const x0 = e.clientX;
    const orig = refs.map((r) => ({ ...r, t: clip.params[r.param]?.keys?.find((k) => k.id === r.keyId)?.t ?? 0 }));
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) < 3) return;
      const target = snapBeat(song.tempo, clip.start + t + (ev.clientX - x0) / getState().ui.pxPerBeat, snapOf(ev)) - clip.start;
      const delta = target - t;
      moveKeys(clip.id, orig.map((o) => ({ param: o.param, keyId: o.keyId, t: o.t + delta })));
    };
    trackDrag(move, commit);
  };

  return (
    <div className="tl-row keylane">
      <div className="tl-head"><span className="key-label">{group.label}</span><span className="key-count">{times.length}</span></div>
      <div className="tl-lane" title="Double-click to add a keyframe here · drag keys to move · Shift-click to multi-select"
        onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as Element).tagName === 'svg') setUi({ selectedKeys: [] }); }}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const beat = snapBeat(song.tempo, getState().ui.scrollBeat + (e.clientX - r.left) / getState().ui.pxPerBeat, snapOf(e));
          transport.seek(beatToSec(song.tempo, beat));
          toggleKeys(clip.id, group.defs.map((d) => d.id));
        }}>
        <div className="clip-span" style={{ left: x(clip.start), width: clip.length * ppb }} />
        <svg className="key-curve" width={width} height={H}>{paths}</svg>
        {times.map((t) => (
          <span key={t} className={`key ${isSel(t) ? 'sel' : ''}`} style={{ left: x(clip.start + t) }} onPointerDown={(e) => dragKey(e, t)}
            onDoubleClick={(e) => { e.stopPropagation(); transport.seek(beatToSec(song.tempo, clip.start + t)); }}
            title={`${formatBBT(song.tempo, clip.start + t)} · double-click to jump here`} />
        ))}
      </div>
    </div>
  );
}

function Playhead({ song, height }: { song: Song; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { pxPerBeat, scrollBeat } = getState().ui;
      const sec = transport.sec;
      const beat = secToBeat(song.tempo, sec);
      const x = (beat - scrollBeat) * pxPerBeat;
      const el = ref.current;
      if (el) { el.style.transform = `translateX(${HEAD_W + x}px)`; el.style.display = x < 0 ? 'none' : ''; }
      if (transport.playing && el) {
        // Page the view when the playhead leaves it.
        const w = (el.parentElement?.clientWidth ?? 0) - HEAD_W;
        if (w > 100 && (x > w - 30 || x < 0)) setUi({ scrollBeat: beat - 60 / pxPerBeat });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [song.tempo]);
  return <div ref={ref} className="tl-playhead" style={{ height }}><span ref={readRef} /></div>;
}

export function PositionReadout() {
  const song = useSong();
  const ref = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState(false);
  useEffect(() => {
    let raf = 0, last = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const sec = transport.sec;
      const text = `${formatBBT(song.tempo, secToBeat(song.tempo, sec))}|${formatClock(sec)}`;
      if (text !== last && ref.current) { last = text; const [a, b] = text.split('|'); ref.current.children[0].textContent = a; ref.current.children[1].textContent = b; }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [song.tempo, edit]);
  if (edit) {
    return (
      <input className="pos-edit mono" autoFocus defaultValue={formatBBT(song.tempo, secToBeat(song.tempo, transport.sec))}
        onBlur={() => setEdit(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') setEdit(false);
          if (e.key === 'Enter') {
            const parts = e.currentTarget.value.trim().split(/[.:\s]+/).map(Number);
            if (parts.every(Number.isFinite) && parts.length) transport.seek(beatToSec(song.tempo, (parts[0] - 1) * song.tempo.beatsPerBar + ((parts[1] ?? 1) - 1) + (parts[2] ?? 0) / 960));
            setEdit(false);
          }
        }} />
    );
  }
  return <div ref={ref} className="pos" onClick={() => setEdit(true)} title="Bar.beat.tick and time. Click to type a position"><span className="pos-bbt mono" /><span className="pos-clock mono" /></div>;
}

export function Timeline() {
  const song = useSong();
  const ui = useStore((s) => s.ui);
  useStore((s) => s.assetGen);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [bodyH, setBodyH] = useState(200);
  const fileRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = bodyRef.current!;
    const ro = new ResizeObserver(() => { setWidth(Math.max(100, el.clientWidth - HEAD_W)); setBodyH(el.scrollHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => { if (bodyRef.current) setBodyH(bodyRef.current.scrollHeight); });

  useEffect(() => {
    const el = bodyRef.current!;
    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.004), Math.max(0, e.clientX - r.left - HEAD_W));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setUi({ scrollBeat: getState().ui.scrollBeat + d / getState().ui.pxPerBeat });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const selClip = ui.selection.type === 'clip' ? findClip(song, ui.selection.id)?.clip ?? null : null;
  const keyGroups = selClip ? paramGroups(selClip.kind).filter((g) => g.defs.some((d) => selClip.params[d.id]?.keys?.length)) : [];
  const bpb = song.tempo.beatsPerBar;
  const laneVars = {
    '--bar-px': `${ui.pxPerBeat * bpb}px`, '--beat-px': `${ui.pxPerBeat}px`,
    '--grid-x': `${-ui.scrollBeat * ui.pxPerBeat}px`, '--beat-alpha': ui.pxPerBeat >= 7 ? 1 : 0,
    '--end-x': `${(song.lengthBeats - ui.scrollBeat) * ui.pxPerBeat}px`,
  } as CSSProperties;
  const fit = () => setUi({ pxPerBeat: Math.max(1.5, (width - 40) / (song.lengthBeats + 2)), scrollBeat: -1 });
  const audio = !!song.audioAssetId;

  return (
    <div className="timeline" style={laneVars}>
      <div className="tl-toolbar">
        <span className="tl-label">Snap</span>
        <Select value={ui.snap} options={SNAP_MODES.map((m) => ({ value: m, label: SNAP_LABEL[m] }))} onChange={(v) => setUi({ snap: v })} title="Grid for moving clips, keys and the playhead. Hold Alt to place freely" />
        <span className="sep" />
        <button className="btn" title="Zoom out (−)" onClick={() => zoomAt(1 / 1.4, width / 2)}>−</button>
        <button className="btn" title="Zoom in (+)" onClick={() => zoomAt(1.4, width / 2)}>+</button>
        <button className="btn" title="Fit the whole song" onClick={fit}>Fit</button>
        <span className="sep" />
        <Menu trigger="+ Track" title="Add a track" items={(['camera', 'light', 'modifier', 'global'] as TrackType[]).map((t) => ({ label: `${TRACK_LABEL[t]} track`, onClick: () => addTrack(t) }))} />
        <span className="spacer" />
        <span className="tl-hint">Ctrl/⌘-scroll to zoom · Shift-scroll to pan · Alt to ignore snap</span>
      </div>
      <div className="tl-body" ref={bodyRef}>
        <div className="tl-row ruler-row">
          <div className="tl-head ruler-head"><span className="tl-song">{song.title}</span><span className="tl-bpm mono">{song.tempo.bpm} BPM · {bpb}/{song.tempo.beatUnit}</span></div>
          <Ruler song={song} width={width} />
        </div>
        <div className="tl-row wave-row">
          <div className="tl-head"><span className="track-name static">Audio</span>
            <button className="mini wide" onClick={() => fileRef.current?.click()} title="Import the song's audio; BPM, beats, onsets and bands are analysed offline">{audio ? 'Replace' : 'Import'}</button>
            <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.m4a" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importAudioFile(f); e.target.value = ''; }} />
          </div>
          <div className="tl-lane wave-lane">
            <Waveform song={song} width={width} />
            {!audio && <span className="lane-hint">No audio yet. Import the song to get its waveform, beat grid and music-driven modulators.</span>}
          </div>
        </div>
        {song.tracks.map((t) => <TrackRow key={t.id} track={t} song={song} />)}
        {selClip && (
          <>
            <div className="tl-row keys-title"><div className="tl-head"><span className="key-title">Keyframes · {selClip.name}</span></div><div className="tl-lane plain" /></div>
            {keyGroups.map((g) => <KeyLane key={g.id} clip={selClip} group={g} song={song} width={width} />)}
            {keyGroups.length === 0 && <div className="tl-row keylane"><div className="tl-head" /><div className="tl-lane plain"><span className="lane-hint">No keyframes on this clip. Click ◆ next to a parameter in the inspector to add one at the playhead.</span></div></div>}
          </>
        )}
        <Playhead song={song} height={bodyH} />
      </div>
    </div>
  );
}
