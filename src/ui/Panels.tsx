// Top bar, scene/asset panel, render dialog and the Train / Edit tabs.
import { useEffect, useRef, useState } from 'react';
import { KINDS } from '../core/registry';
import { clipActive } from '../core/evaluate';
import { beatToSec, secToBeat } from '../core/tempo';
import { makeInstance, type Asset } from '../core/model';
import { analysisFor, audioBuffers, getRenderer, importSplatFile, importSplatVersion, latestVersion, resetToDemo, saveNow, splatFor } from '../state/runtime';
import { currentSong, dismissJob, getState, loadShow, redo, select, setUi, toast, undo, update, useSong, useStore, type Tab } from '../state/store';
import { transport } from '../state/transport';
import { addSong, patchSplat } from '../state/actions';
import { download, readFile } from '../state/fs';
import { chooseSink, CODEC_LABEL, startRender, supportedCodecs, type Codec, type RenderJob, type RenderSettings } from '../export/render';
import { BBT, Menu, Num, Row, Section, Select, Toggle } from './widgets';
import { PositionReadout } from './Timeline';
import { usePlayhead } from './Inspector';
import { viewportBus } from './Viewport';

function usePlaying() {
  const [, set] = useState(0);
  useEffect(() => transport.subscribe(() => set((n) => n + 1)), []);
  return transport.playing;
}

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'train', label: 'Train', hint: 'Make splats from video' },
  { id: 'edit', label: 'Edit', hint: 'Clean splats up' },
  { id: 'animate', label: 'Animate', hint: 'Light, animate and render' },
  { id: 'show', label: 'Show', hint: 'Play the set' },
];

export function TopBar() {
  const tab = useStore((s) => s.ui.tab);
  const show = useStore((s) => s.show);
  const songId = useStore((s) => s.ui.songId);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.canUndo), canRedo = useStore((s) => s.canRedo);
  const jobs = useStore((s) => s.jobs);
  const loop = useStore((s) => s.ui.loop);
  const playing = usePlaying();
  const fileRef = useRef<HTMLInputElement>(null);
  const song = useSong();
  const running = jobs.filter((j) => j.status === 'running');
  return (
    <header className="topbar">
      <div className="brand" title="22PM · visuals for Délután 10"><b>22</b>PM</div>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} title={t.hint} onClick={() => setUi({ tab: t.id })}>{t.label}</button>)}
      </nav>
      <span className="sep" />
      <Select className="song-select" value={songId} title="Song (setlist order)" options={show.songs.map((s, i) => ({ value: s.id, label: `${i + 1}. ${s.title}` }))} onChange={(id) => setUi({ songId: id, selection: { type: 'none' }, selectedKeys: [] })} />
      <button className="btn" title="Add a song to the setlist" onClick={addSong}>+</button>
      <span className="spacer" />
      <div className="transport">
        <button className="btn icon" title="Back to start (Home)" onClick={() => transport.seek(0)}>⏮</button>
        <button className={`btn icon play ${playing ? 'on' : ''}`} title="Play / pause (Space)" disabled={transport.external} onClick={() => transport.toggle()}>{playing ? '❚❚' : '▶'}</button>
        <button className={`btn icon ${loop ? 'on' : ''}`} title="Loop the selected clip's range (L)" onClick={toggleLoop}>⟲</button>
        <PositionReadout />
      </div>
      <span className="spacer" />
      {running.length > 0 && (
        <div className="jobs" title={running.map((j) => j.label).join('\n')}>
          <span className="spinner" />{running[0].label}{running.length > 1 ? ` +${running.length - 1}` : ''}
          <span className="job-bar"><i style={{ width: `${running[0].progress * 100}%` }} /></span>
        </div>
      )}
      {jobs.filter((j) => j.status === 'error').map((j) => <button key={j.id} className="btn danger" title={j.error} onClick={() => dismissJob(j.id)}>{j.label} failed ×</button>)}
      <button className="btn icon" title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>↶</button>
      <button className="btn icon" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo}>↷</button>
      <span className={`save-dot ${dirty ? 'dirty' : ''}`} title={dirty ? 'Saving…' : 'All changes saved in this browser'} />
      <button className="btn primary" title="Render this song to video" onClick={() => setUi({ dialog: 'render' })}>Render</button>
      <Menu trigger="⋯" title="Project" className="right" items={[
        { heading: show.name },
        { label: 'Export project file…', onClick: () => download(`${show.name.replace(/[^\w-]+/g, '_')}.22pm.json`, new Blob([JSON.stringify(show, null, 1)], { type: 'application/json' })) },
        { label: 'Open project file…', onClick: () => fileRef.current?.click() },
        'sep',
        { label: 'Keyboard shortcuts', onClick: () => setUi({ dialog: 'shortcuts' }) },
        { label: 'Reset to demo scene', danger: true, onClick: () => { if (confirm('Replace the current project with the demo scene? This cannot be undone.')) resetToDemo(); } },
      ]} />
      <input ref={fileRef} type="file" accept=".json" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
          const s = JSON.parse(await f.text());
          if (s.format !== '22pm-show') throw new Error('Not a 22PM project file');
          loadShow(s); void saveNow();
          toast('Project opened. Splat and audio files are stored per browser; re-import any that are missing.');
        } catch (err) { toast(`Could not open: ${(err as Error).message}`); }
      }} />
      <span hidden>{song.id}</span>
    </header>
  );
}

export function toggleLoop() {
  const s = getState();
  const song = currentSong(s);
  if (s.ui.loop) { transport.loop = null; setUi({ loop: false }); return; }
  let a = 0, b = song.lengthBeats;
  if (s.ui.selection.type === 'clip') {
    for (const t of song.tracks) for (const c of t.clips) if (c.id === s.ui.selection.id) { a = c.start; b = c.start + c.length; }
  }
  transport.loop = [beatToSec(song.tempo, a), beatToSec(song.tempo, b)];
  setUi({ loop: true });
}

// ---- scene + assets --------------------------------------------------------------------------

function AssetRow({ asset, onAdd }: { asset: Asset; onAdd?: () => void }) {
  const v = latestVersion(asset);
  return (
    <div className="asset">
      <span className="asset-icon">{asset.type === 'splat' ? '◆' : '♪'}</span>
      <span className="asset-name" title={asset.name}>{asset.name}</span>
      <span className="asset-meta">{asset.versions.length > 1 ? `${v.label} · ${asset.versions.length} versions` : v.count ? `${(v.count / 1000).toFixed(0)}k` : v.label}</span>
      {onAdd && <button className="mini wide" title="Add to this song's scene" onClick={onAdd}>Add</button>}
    </div>
  );
}

export function ScenePanel() {
  const song = useSong();
  const show = useStore((s) => s.show);
  const sel = useStore((s) => s.ui.selection);
  useStore((s) => s.assetGen);
  const sec = usePlayhead(6);
  const beat = secToBeat(song.tempo, sec);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = song.tracks.flatMap((t) => (t.muted ? [] : t.clips.filter((c) => clipActive(c, beat))));
  const isSel = (type: string, id: string) => sel.type === type && (sel as any).id === id;
  return (
    <aside className="panel left">
      <div className="panel-scroll">
        <Section title="Scene">
          <div className="list-head">Splats</div>
          {song.scene.splats.length === 0 && <div className="hint pad">Empty. Add a splat from the library below, or drop a .ply / .spz file anywhere.</div>}
          {song.scene.splats.map((s) => {
            const loaded = !!splatFor(show, s.assetId, s.version);
            return (
              <div key={s.id} className={`item ${isSel('splat', s.id) ? 'sel' : ''}`} onClick={() => select({ type: 'splat', id: s.id })}>
                <button className={`eye ${s.visible ? '' : 'off'}`} title={s.visible ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); patchSplat(s.id, { visible: !s.visible }); }}>{s.visible ? '●' : '○'}</button>
                <span className="item-name">{s.name}</span>
                {!loaded && <span className="item-meta">loading…</span>}
              </div>
            );
          })}
          <div className="list-head">Base layer</div>
          {(['camera', 'global', 'post'] as const).map((k) => (
            <div key={k} className={`item ${isSel('clip', song.scene.base[k].id) ? 'sel' : ''}`} onClick={() => select({ type: 'clip', id: song.scene.base[k].id })}>
              <span className={`dot track-${KINDS[k].track}`} /><span className="item-name">{KINDS[k].label}</span><span className="item-meta">always on</span>
            </div>
          ))}
          <div className="list-head">Playing now</div>
          {active.length === 0 && <div className="hint pad">No clips at the playhead.</div>}
          {active.map((c) => (
            <div key={c.id} className={`item ${isSel('clip', c.id) ? 'sel' : ''}`} onClick={() => select({ type: 'clip', id: c.id })}>
              <span className={`dot track-${KINDS[c.kind].track}`} /><span className="item-name">{c.name}</span><span className="item-meta">{KINDS[c.kind].label}</span>
            </div>
          ))}
          <div className="item song-item" onClick={() => select({ type: 'song' })}><span className="item-name">Song settings</span><span className="item-meta">{song.tempo.bpm} BPM</span></div>
        </Section>
        <Section title="Library" right={<button className="mini wide" title="Import .ply or .spz" onClick={() => fileRef.current?.click()}>Import</button>}>
          <input ref={fileRef} type="file" accept=".ply,.spz" multiple hidden onChange={(e) => { for (const f of e.target.files ?? []) void importSplatFile(f); e.target.value = ''; }} />
          {show.assets.filter((a) => a.type === 'splat').map((a) => (
            <AssetRow key={a.id} asset={a} onAdd={() => update((_s, sg) => { const inst = makeInstance(a.id, a.name); if (/\.ply$/i.test(latestVersion(a).file)) inst.rot = [0, 0, 180]; sg.scene.splats.push(inst); })} />
          ))}
          {show.assets.filter((a) => a.type === 'audio').map((a) => <AssetRow key={a.id} asset={a} />)}
          <div className="hint pad">Drop .ply / .spz scans or a song's audio file anywhere in the window.</div>
        </Section>
      </div>
    </aside>
  );
}

// ---- render dialog ---------------------------------------------------------------------------

export function RenderDialog() {
  const song = useSong();
  const show = useStore((s) => s.show);
  const sel = useStore((s) => s.ui.selection);
  const [codecs, setCodecs] = useState<Codec[]>(['png']);
  const [st, setSt] = useState<RenderSettings>(() => ({
    width: show.output.width, height: show.output.height, fps: 60, codec: 'h264', fromBeat: 0, toBeat: song.lengthBeats,
    supersample: 2, subFrames: 4, shutter: 0.5, shadowRes: Math.max(2048, song.scene.shadowResolution), embedAudio: true, bitrateMbps: 60,
  }));
  const [progress, setProgress] = useState<{ done: number; total: number; started: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const job = useRef<RenderJob | null>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const set = (p: Partial<RenderSettings>) => setSt((s) => ({ ...s, ...p }));

  useEffect(() => {
    void supportedCodecs(st.width, st.height, st.fps).then((c) => { setCodecs(c); if (!c.includes(st.codec)) set({ codec: c[0] }); });
  }, [st.width, st.height, st.fps]);

  const selClip = sel.type === 'clip' ? song.tracks.flatMap((t) => t.clips).find((c) => c.id === sel.id) : undefined;
  const frames = Math.max(1, Math.round((beatToSec(song.tempo, st.toBeat) - beatToSec(song.tempo, st.fromBeat)) * st.fps));
  const close = () => { if (!progress) setUi({ dialog: null }); };

  const go = async () => {
    setResult(null);
    let sink;
    try { sink = await chooseSink(st.codec, song.title.replace(/[^\w-]+/g, '_')); } catch { return; }
    const renderer = await getRenderer();
    transport.pause();
    viewportBus.paused = true;
    const started = performance.now();
    setProgress({ done: 0, total: frames, started });
    const audio = song.audioAssetId ? audioBuffers.get(song.audioAssetId) ?? null : null;
    job.current = startRender(renderer, show, song, analysisFor(song), audio, st, sink, (done, total, px) => {
      setProgress({ done, total, started });
      const c = preview.current;
      if (px && c) {
        if (c.width !== st.width) { c.width = st.width; c.height = st.height; }
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), st.width, st.height), 0, 0);
      }
    });
    try {
      const r = await job.current.done;
      if (r.blob) download(`${song.title.replace(/[^\w-]+/g, '_')}.${st.codec === 'png' ? 'zip' : 'mp4'}`, r.blob);
      setResult(`${r.note}: ${r.frames} frames in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
    } catch (e) {
      setResult(`Render failed: ${(e as Error).message}`);
    } finally {
      viewportBus.paused = false;
      viewportBus.redraw();
      setProgress(null);
      job.current = null;
    }
  };

  const eta = progress && progress.done > 2 ? ((performance.now() - progress.started) / progress.done) * (progress.total - progress.done) / 1000 : null;
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-label="Render to video">
        <header className="modal-head"><h2>Render “{song.title}”</h2><button className="mini" onClick={close} disabled={!!progress}>×</button></header>
        <div className="modal-body two">
          <div>
            <Section title="Picture">
              <Row label="Resolution">
                <Num value={st.width} step={2} min={64} max={8192} unit="px" onChange={(v) => set({ width: Math.round(v / 2) * 2 })} />
                <Num value={st.height} step={2} min={64} max={8192} unit="px" onChange={(v) => set({ height: Math.round(v / 2) * 2 })} />
                <button className="mini wide" title="Use the show's output size" onClick={() => set({ width: show.output.width, height: show.output.height })}>Show</button>
              </Row>
              <Row label="Frame rate">
                <div className="seg small">{[30, 60].map((f) => <button key={f} className={st.fps === f ? 'on' : ''} onClick={() => set({ fps: f })}>{f}</button>)}</div>
                <Num value={st.fps} step={1} min={1} max={240} unit="fps" onChange={(v) => set({ fps: Math.round(v) })} />
              </Row>
              <Row label="Format"><Select value={st.codec} options={codecs.map((c) => ({ value: c, label: CODEC_LABEL[c] }))} onChange={(c) => set({ codec: c })} /></Row>
              {st.codec !== 'png' && <Row label="Bitrate"><Num value={st.bitrateMbps} step={1} min={1} max={400} soft={[5, 200]} unit="Mbit/s" onChange={(v) => set({ bitrateMbps: v })} /></Row>}
              {st.codec !== 'png' && <Row label="Embed audio"><Toggle value={st.embedAudio && !!song.audioAssetId} onChange={(v) => set({ embedAudio: v })} /></Row>}
              <div className="hint pad">ProRes is not available from a browser. For ProRes 422 HQ, render a PNG sequence and run:<br /><code>ffmpeg -framerate {st.fps} -i frame_%06d.png -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le out.mov</code></div>
            </Section>
            <Section title="Range">
              <Row label="From"><BBT tempo={song.tempo} beat={st.fromBeat} onChange={(b) => set({ fromBeat: Math.max(-song.tempo.beatsPerBar, Math.min(b, st.toBeat - 1 / 4)) })} /></Row>
              <Row label="To"><BBT tempo={song.tempo} beat={st.toBeat} onChange={(b) => set({ toBeat: Math.max(st.fromBeat + 1 / 4, b) })} /></Row>
              <div className="btn-row pad">
                <button className="btn" onClick={() => set({ fromBeat: 0, toBeat: song.lengthBeats })}>Whole song</button>
                <button className="btn" disabled={!selClip} onClick={() => selClip && set({ fromBeat: selClip.start, toBeat: selClip.start + selClip.length })}>Selected clip</button>
              </div>
            </Section>
            <Section title="Quality">
              <Row label="Supersampling" title="Renders at N× the resolution and filters down"><div className="seg small">{[1, 2, 3, 4].map((n) => <button key={n} className={st.supersample === n ? 'on' : ''} onClick={() => set({ supersample: n })}>{n}×</button>)}</div></Row>
              <Row label="Motion blur" title="Sub-frames averaged per frame. 1 = off"><div className="seg small">{[1, 2, 4, 8].map((n) => <button key={n} className={st.subFrames === n ? 'on' : ''} onClick={() => set({ subFrames: n })}>{n === 1 ? 'Off' : n}</button>)}</div></Row>
              {st.subFrames > 1 && <Row label="Shutter" title="Part of the frame the shutter is open (0.5 = 180°)"><Num value={st.shutter} step={0.01} min={0.05} max={1} soft={[0, 1]} onChange={(v) => set({ shutter: v })} /></Row>}
              <Row label="Shadow maps"><Select value={st.shadowRes} options={[1024, 2048, 4096].map((v) => ({ value: v, label: `${v} px` }))} onChange={(v) => set({ shadowRes: v })} /></Row>
            </Section>
          </div>
          <div className="render-side">
            <div className="render-preview" style={{ aspectRatio: `${st.width} / ${st.height}` }}><canvas ref={preview} /></div>
            <div className="render-info mono">{frames.toLocaleString()} frames · {(frames / st.fps).toFixed(1)} s · {st.width}×{st.height} @ {st.fps}</div>
            {progress && (
              <>
                <div className="progress"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
                <div className="render-info mono">Frame {progress.done} / {progress.total}{eta != null ? ` · about ${eta > 90 ? `${Math.round(eta / 60)} min` : `${Math.round(eta)} s`} left` : ''}</div>
              </>
            )}
            {result && <div className={`render-result ${result.startsWith('Render failed') ? 'bad' : ''}`}>{result}</div>}
            <div className="hint">Rendering runs the same evaluate → render path as live playback, one frame at a time, so the file matches the show frame for frame.</div>
          </div>
        </div>
        <footer className="modal-foot">
          {progress ? <button className="btn danger" onClick={() => job.current?.cancel()}>Cancel render</button> : <button className="btn" onClick={close}>Close</button>}
          <button className="btn primary" disabled={!!progress} onClick={go}>{progress ? 'Rendering…' : 'Render'}</button>
        </footer>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], ['Home', 'Back to start'], ['← →', 'Step by the snap grid (Shift: one bar)'], ['L', 'Loop the selected clip'],
  ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘D', 'Duplicate clip'], ['S', 'Split clip at the playhead'], ['[ ]', 'Trim clip start / end to the playhead'],
  ['M', 'Mute clip'], ['Delete', 'Delete selected keyframes, else the clip'], ['1 / 2', 'Camera / Explore view'], ['F', 'Frame the scene'],
  ['G / H', 'Gizmos / HUD'], ['W A S D Q E', 'Move the view camera (viewport focused)'], ['+ −', 'Zoom the timeline'], ['Alt-drag', 'Ignore snapping'],
  ['Shift-drag a number', 'Fine adjustment'], ['Alt-click ◆', 'Clear all keyframes on a parameter'],
];
export function ShortcutsDialog() {
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) setUi({ dialog: null }); }}>
      <div className="modal narrow" role="dialog" aria-label="Keyboard shortcuts">
        <header className="modal-head"><h2>Keyboard shortcuts</h2><button className="mini" onClick={() => setUi({ dialog: null })}>×</button></header>
        <div className="modal-body shortcuts">{SHORTCUTS.map(([k, d]) => <div key={k} className="shortcut"><kbd>{k}</kbd><span>{d}</span></div>)}</div>
      </div>
    </div>
  );
}

// ---- Train and Edit --------------------------------------------------------------------------

function VersionTable({ asset }: { asset: Asset }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="card">
      <div className="card-head"><span className="asset-icon">◆</span><b>{asset.name}</b>
        <span className="spacer" />
        <button className="btn" title="Import a cleaned or retrained file as a new version" onClick={() => fileRef.current?.click()}>Add version…</button>
        <input ref={fileRef} type="file" accept=".ply,.spz" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSplatVersion(asset.id, f); e.target.value = ''; }} />
      </div>
      <table className="versions">
        <thead><tr><th>Version</th><th>Gaussians</th><th>Created</th><th>Source</th><th /></tr></thead>
        <tbody>
          {asset.versions.map((v, i) => (
            <tr key={v.id}>
              <td>{v.label}{i === asset.versions.length - 1 ? <span className="tag">latest</span> : null}</td>
              <td className="mono">{v.count?.toLocaleString() ?? '–'}</td>
              <td>{v.created ? new Date(v.created).toLocaleString() : 'built in'}</td>
              <td>{v.note ?? String(asset.recipe?.source ?? (asset.id.startsWith('demo_') ? 'procedural demo' : '–'))}</td>
              <td>{v.file && <button className="btn ghost" title="Download this version, e.g. to clean it in SuperSplat" onClick={async () => { const f = await readFile(v.file); if (f) download(`${asset.name}_${v.label.replace(/\s+/g, '_')}.${v.file.split('.').pop()}`, f); }}>Download</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TrainTab() {
  const assets = useStore((s) => s.show.assets).filter((a) => a.type === 'splat');
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="page">
      <div className="page-inner">
        <h1>Train</h1>
        <p className="lead">Turn phone or camera video into a splat. Training runs the <code>vauss</code> command-line tool as a separate process, which a browser cannot start.</p>
        <div className="notice">
          <b>Not wired up in this build.</b> In-app training (milestone M1b) needs the desktop shell to spawn Vauss, or COLMAP + Brush for photos. The solver interface is in <code>src/train/solver.ts</code>. Until then, train outside 22PM and import the result here: it lands in the same asset library, with versions, ready for Edit and Animate.
        </div>
        <div className="btn-row">
          <button className="btn primary" onClick={() => fileRef.current?.click()}>Import .ply / .spz…</button>
          <input ref={fileRef} type="file" accept=".ply,.spz" multiple hidden onChange={(e) => { for (const f of e.target.files ?? []) void importSplatFile(f, false); e.target.value = ''; }} />
        </div>
        <h2>Capture rules for relighting</h2>
        <ul className="rules">
          <li><b>Flat, even light.</b> Overcast, shade or big soft boxes. Baked sun shadows cannot be fully removed.</li>
          <li><b>Lock exposure, white balance and focus</b> for the whole capture.</li>
          <li><b>70–80% overlap, several heights, no motion blur.</b> 150–400 photos per location.</li>
          <li><b>Objects:</b> walk around them; do not use a turntable. Matte, neutral background.</li>
          <li><b>Collages:</b> scan the pieces separately and assemble them in Animate.</li>
          <li><b>Keep the raw footage</b> so scans can be retrained as tools improve.</li>
        </ul>
        <h2>Asset library</h2>
        {assets.map((a) => <VersionTable key={a.id} asset={a} />)}
      </div>
    </div>
  );
}

export function EditTab() {
  const assets = useStore((s) => s.show.assets).filter((a) => a.type === 'splat');
  return (
    <div className="page">
      <div className="page-inner">
        <h1>Edit</h1>
        <p className="lead">Remove floaters, crop and recolour. Edits never move the whole splat, so lights and cameras in Animate stay where they are when a cleaned version replaces the old one.</p>
        <div className="notice">
          <b>The embedded SuperSplat editor is not vendored yet</b> (milestone M1c: pinned fork in <code>vendor/supersplat</code> plus the open-from / save-to bridge). The round trip already works by hand: download a version below, clean it in SuperSplat, export a .ply and add it back as a new version. Scenes set to “Latest” update in place.
        </div>
        <h2>Versions</h2>
        {assets.length === 0 && <p className="hint">No splat assets yet.</p>}
        {assets.map((a) => <VersionTable key={a.id} asset={a} />)}
      </div>
    </div>
  );
}
