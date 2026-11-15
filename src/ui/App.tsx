import { useEffect, useRef, useState } from 'react';
import { beatToSec, secToBeat, snapStep } from '../core/tempo';
import { findClip } from '../core/model';
import { boot, importAudioFile, importSplatFile, saveNow } from '../state/runtime';
import { currentSong, getState, redo, setUi, undo, useStore } from '../state/store';
import { transport } from '../state/transport';
import { deleteClip, deleteSelectedKeys, duplicateClip, patchClip, splitClip } from '../state/actions';
import { showControl } from '../state/showControl';
import { Viewport, viewportBus } from './Viewport';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';
import { EditTab, RenderDialog, ScenePanel, ShortcutsDialog, toggleLoop, TopBar, TrainTab } from './Panels';
import { ShowSetlist, ShowStatus, skipSong } from './ShowView';

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const s = getState();
  const song = currentSong(s);
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  const selClip = s.ui.selection.type === 'clip' ? findClip(song, s.ui.selection.id) : null;
  const beat = secToBeat(song.tempo, transport.sec);
  const done = () => e.preventDefault();
  if (mod && k.toLowerCase() === 'z') { if (e.shiftKey) redo(); else undo(); return done(); }
  if (mod && k.toLowerCase() === 'y') { redo(); return done(); }
  if (mod && k.toLowerCase() === 's') { void saveNow(); return done(); }
  if (mod && k.toLowerCase() === 'd') { if (selClip?.track) duplicateClip(selClip.clip.id); return done(); }
  if (mod) return;
  if (k === ' ') { transport.toggle(); return done(); }
  if (k === 'Escape') { if (s.ui.dialog) setUi({ dialog: null }); return; }
  if (s.ui.dialog) return;
  if (s.ui.tab === 'show') {
    const lk = k.toLowerCase();
    if (lk === 'b') showControl.set({ blackout: !showControl.blackout });
    else if (lk === 'z') showControl.set({ freeze: !showControl.freeze });
    else if (lk === 'c') showControl.set({ fadeToColor: !showControl.fadeToColor });
    else if (lk === 'n' || k === 'ArrowRight') skipSong(1);
    else if (k === 'ArrowLeft') skipSong(-1);
    return;
  }
  if (s.ui.tab !== 'animate') return;
  // WASDQE belong to the viewport when it has focus.
  if ((t?.closest?.('.vp-stage')) && 'wasdqe'.includes(k.toLowerCase())) return;
  switch (k) {
    case 'Home': transport.seek(0); return done();
    case 'ArrowLeft': case 'ArrowRight': {
      const step = e.shiftKey ? song.tempo.beatsPerBar : snapStep(song.tempo, s.ui.snap) || 1 / 4;
      const dir = k === 'ArrowLeft' ? -1 : 1;
      transport.seek(beatToSec(song.tempo, Math.max(0, Math.min(song.lengthBeats, dir > 0 ? Math.floor(beat / step + 1e-6) * step + step : Math.ceil(beat / step - 1e-6) * step - step))));
      return done();
    }
    case 'Delete': case 'Backspace':
      if (!deleteSelectedKeys() && selClip?.track) deleteClip(selClip.clip.id);
      return done();
    case '[': if (selClip?.track && beat < selClip.clip.start + selClip.clip.length) patchClip(selClip.clip.id, { start: beat, length: selClip.clip.start + selClip.clip.length - beat }); return;
    case ']': if (selClip?.track && beat > selClip.clip.start) patchClip(selClip.clip.id, { length: beat - selClip.clip.start }); return;
    case '+': case '=': setUi({ pxPerBeat: Math.min(400, s.ui.pxPerBeat * 1.4) }); return;
    case '-': setUi({ pxPerBeat: Math.max(1.5, s.ui.pxPerBeat / 1.4) }); return;
    case '1': setUi({ viewMode: 'camera' }); return;
    case '2': setUi({ viewMode: 'explore' }); return;
  }
  switch (k.toLowerCase()) {
    case 's': if (selClip?.track) splitClip(selClip.clip.id, beat); return;
    case 'm': if (selClip?.track) patchClip(selClip.clip.id, { muted: !selClip.clip.muted }); return;
    case 'l': toggleLoop(); return;
    case 'g': setUi({ showGizmos: !s.ui.showGizmos }); return;
    case 'h': setUi({ showHud: !s.ui.showHud }); return;
    case 'f': viewportBus.frameAll(); return;
    case '?': setUi({ dialog: 'shortcuts' }); return;
  }
}

function useSplit(key: string, initial: number, min: number, max: number, dir: 'x' | 'y', invert = false) {
  const [size, setSize] = useState(() => Number(localStorage.getItem(`22pm.${key}`)) || initial);
  const start = (e: React.PointerEvent) => {
    const p0 = dir === 'x' ? e.clientX : e.clientY, s0 = size;
    const move = (m: PointerEvent) => {
      const d = (dir === 'x' ? m.clientX : m.clientY) - p0;
      const n = Math.min(max, Math.max(min, s0 + (invert ? -d : d)));
      setSize(n);
      localStorage.setItem(`22pm.${key}`, String(n));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return [size, start] as const;
}

export function App() {
  const tab = useStore((s) => s.ui.tab);
  const dialog = useStore((s) => s.ui.dialog);
  const toastMsg = useStore((s) => s.toast);
  const [ready, setReady] = useState(false);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const [leftW, dragLeft] = useSplit('left', 232, 160, 420, 'x');
  const [rightW, dragRight] = useSplit('right', 352, 280, 560, 'x', true);
  const [tlH, dragTl] = useSplit('timeline', 300, 120, 700, 'y', true);

  useEffect(() => { void boot().then(() => { (window as any).__22pm.viewportBus = viewportBus; setReady(true); }); }, []);
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    for (const f of e.dataTransfer.files) {
      if (/\.(ply|spz)$/i.test(f.name)) void importSplatFile(f);
      else if (f.type.startsWith('audio/') || /\.(wav|mp3|aif|aiff|flac|m4a|ogg)$/i.test(f.name)) void importAudioFile(f);
    }
  };
  const viewportVisible = tab === 'animate' || tab === 'show';
  return (
    <div className={`app tab-${tab}`}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDropping(true); } }}
      onDragLeave={() => { if (--dragDepth.current <= 0) setDropping(false); }}
      onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <TopBar />
      {ready && (
        <div className="main" style={{ display: viewportVisible ? undefined : 'none' }}>
          <div className="upper">
            <div style={{ width: leftW }} className="col">{tab === 'show' ? <ShowSetlist /> : <ScenePanel />}</div>
            <div className="split x" onPointerDown={dragLeft} />
            <Viewport hidden={!viewportVisible} />
            <div className="split x" onPointerDown={dragRight} />
            <div style={{ width: rightW }} className="col">{tab === 'show' ? <ShowStatus /> : <aside className="panel right"><Inspector /></aside>}</div>
          </div>
          {tab === 'animate' && <><div className="split y" onPointerDown={dragTl} /><div style={{ height: tlH }} className="lower"><Timeline /></div></>}
        </div>
      )}
      {ready && tab === 'train' && <TrainTab />}
      {ready && tab === 'edit' && <EditTab />}
      {dialog === 'render' && <RenderDialog />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      {dropping && <div className="drop-veil"><div>Drop .ply / .spz scans or a song's audio</div></div>}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
  );
}
