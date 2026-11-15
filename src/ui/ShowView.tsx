// Show mode: setlist, sync status, output window and safety keys (brief section 10).
import { useEffect, useRef, useState } from 'react';
import { formatTimecode, secondsToSmpte, timecodeToSeconds } from '../core/timecode';
import { formatClock } from '../core/tempo';
import { ensureSplat, songDuration } from '../state/runtime';
import { getState, setUi, useStore } from '../state/store';
import { transport } from '../state/transport';
import { showControl } from '../state/showControl';
import { addSong, moveSong, removeSong } from '../state/actions';
import { Num, Select } from './widgets';
import { native, type DisplayInfo } from '../state/native';
import { viewportBus } from './Viewport';

function useShowControl() {
  const [, set] = useState(0);
  useEffect(() => showControl.subscribe(() => set((n) => n + 1)), []);
  useEffect(() => transport.subscribe(() => set((n) => n + 1)), []);
  return showControl;
}

export async function openOutput(displayId?: number | null) {
  if (showControl.output && !showControl.output.closed) {
    if (displayId === undefined) { showControl.output.focus(); return; }
    showControl.output.close();
  }
  // Desktop app: the shell places the window fullscreen on this display.
  if (native) await native.setOutputDisplay(displayId ?? null);
  const w = window.open('', '22pm-output', 'width=960,height=540');
  if (!w) return;
  w.document.title = '22PM output';
  w.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;cursor:none';
  w.document.body.innerHTML = '<canvas id="out" style="width:100vw;height:100vh;object-fit:contain;display:block"></canvas>';
  // F or double-click: fullscreen on whichever display the window is on (the LED processor).
  const fs = () => { void w.document.documentElement.requestFullscreen?.(); };
  w.document.addEventListener('dblclick', fs);
  w.document.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') fs(); else window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code })); });
  w.addEventListener('beforeunload', () => setTimeout(() => showControl.emit(), 0));
  showControl.output = w;
  showControl.emit();
  viewportBus.redraw();
}

export function skipSong(dir: 1 | -1 = 1) {
  const { show, ui } = getState();
  const i = show.songs.findIndex((s) => s.id === ui.songId);
  const next = show.songs[i + dir];
  if (!next) return;
  transport.pause();
  setUi({ songId: next.id, selection: { type: 'none' }, selectedKeys: [] });
}

export function ShowSetlist() {
  const show = useStore((s) => s.show);
  const songId = useStore((s) => s.ui.songId);
  const idx = show.songs.findIndex((s) => s.id === songId);
  // Preload the next song's splats while the current one plays.
  useEffect(() => {
    const next = show.songs[idx + 1];
    if (next) for (const inst of next.scene.splats) void ensureSplat(show, inst.assetId, inst.version);
  }, [idx, show]);
  return (
    <aside className="panel left show-left">
      <div className="panel-title">Setlist<button className="mini wide" onClick={addSong} title="Add song">+</button></div>
      <div className="panel-scroll">
        {show.songs.map((s, i) => (
          <div key={s.id} className={`set-item ${i === idx ? 'current' : i === idx + 1 ? 'next' : ''}`} onClick={() => setUi({ songId: s.id, selection: { type: 'none' } })}>
            <span className="set-num mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="set-main">
              <span className="set-title">{s.title}</span>
              <span className="set-meta mono">{s.startTimecode} · {formatClock(songDuration(s))} · {s.tempo.bpm} BPM</span>
            </span>
            {i === idx && <span className="tag live">now</span>}
            {i === idx + 1 && <span className="tag">next</span>}
            <span className="set-actions" onClick={(e) => e.stopPropagation()}>
              <button className="mini" title="Move up" disabled={i === 0} onClick={() => moveSong(s.id, -1)}>↑</button>
              <button className="mini" title="Move down" disabled={i === show.songs.length - 1} onClick={() => moveSong(s.id, 1)}>↓</button>
              <button className="mini" title="Remove song" disabled={show.songs.length < 2} onClick={() => { if (confirm(`Remove “${s.title}” and everything in it?`)) removeSong(s.id); }}>×</button>
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function ShowStatus() {
  const sc = useShowControl();
  const show = useStore((s) => s.show);
  const songId = useStore((s) => s.ui.songId);
  const song = show.songs.find((s) => s.id === songId) ?? show.songs[0];
  const tcRef = useRef<HTMLDivElement>(null);
  const sim = useRef<ReturnType<typeof setInterval> | null>(null);
  const [simOn, setSimOn] = useState(false);
  const fps = show.output.timecodeFps;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const tc = sc.source === 'mtc' ? sc.lastTc : timecodeToSeconds(song.startTimecode, fps) + transport.sec;
      if (tcRef.current) tcRef.current.textContent = formatTimecode(secondsToSmpte(tc, fps));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [song.startTimecode, fps, sc.source]);
  useEffect(() => () => { if (sim.current) clearInterval(sim.current); }, []);

  const toggleSim = () => {
    if (sim.current) { clearInterval(sim.current); sim.current = null; setSimOn(false); return; }
    // Stand-in for the click rig: sends this song's timecode from its start, 25 messages a second.
    const base = timecodeToSeconds(song.startTimecode, fps) + Math.max(0, transport.sec);
    const t0 = performance.now();
    sim.current = setInterval(() => sc.feedSeconds(base + (performance.now() - t0) / 1000), 40);
    setSimOn(true);
  };
  const status = sc.source === 'mtc' ? sc.chase.status : transport.playing ? 'running' : 'stopped';
  const outOpen = !!sc.output && !sc.output.closed;
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [displayId, setDisplayId] = useState<number | null>(null);
  useEffect(() => {
    if (!native) return;
    const load = () => native!.displays().then((d) => {
      setDisplays(d);
      // Default to the first display that is not the laptop screen: that is usually the LED processor.
      setDisplayId((cur) => (cur != null && d.some((x) => x.id === cur) ? cur : (d.find((x) => !x.primary) ?? d[0])?.id ?? null));
    });
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <aside className="panel right show-right">
      <div className="panel-scroll">
        <div className="tc-block">
          <div className="tc mono" ref={tcRef}>00:00:00:00</div>
          <div className={`status-pill s-${status}`}>{{ idle: 'Waiting for timecode', locked: 'Locked', freewheel: 'Freewheeling', hold: 'Holding last frame', running: 'Running (internal clock)', stopped: 'Stopped' }[status]}</div>
        </div>
        <div className="show-group">
          <div className="list-head">Sync</div>
          <div className="seg">
            <button className={sc.source === 'internal' ? 'on' : ''} onClick={() => sc.setSource('internal')} title="Manual GO with the internal clock (rehearsal and emergencies)">Manual</button>
            <button className={sc.source === 'mtc' ? 'on' : ''} onClick={() => sc.setSource('mtc')} title="Chase MIDI Timecode from the click rig">MIDI Timecode</button>
          </div>
          {sc.source === 'internal' ? (
            <div className="btn-row">
              <button className="btn go" onClick={() => { transport.seek(0); transport.play(); }}>GO</button>
              <button className="btn" onClick={() => transport.pause()}>Stop</button>
            </div>
          ) : (
            <>
              <Select value={sc.midiInputId} options={sc.midiInputs.length ? sc.midiInputs.map((i) => ({ value: i.id, label: i.name })) : [{ value: '', label: 'No MIDI inputs found' }]} onChange={(id) => sc.selectInput(id)} title="MIDI input carrying timecode" />
              {sc.midiError && <div className="hint warn">{sc.midiError}</div>}
              <div className="kv"><span>Freewheel</span><Num value={sc.freewheelSec} step={0.5} min={0} max={30} unit="s" onChange={(v) => sc.set({ freewheelSec: v })} /></div>
              <div className="hint">On dropout the show keeps running for this long, then holds the last frame. It never goes black on its own.</div>
              <button className={`btn ${simOn ? 'on' : ''}`} onClick={toggleSim} title="Rehearse the chase without the rig: generates this song's timecode">{simOn ? 'Stop test timecode' : 'Send test timecode'}</button>
            </>
          )}
        </div>
        <div className="show-group">
          <div className="list-head">Output</div>
          {native ? (
            <>
              <Select value={displayId ?? -1} title="Display the LED processor is connected to"
                options={displays.length ? displays.map((d) => ({ value: d.id, label: d.label })) : [{ value: -1, label: 'Looking for displays…' }]}
                onChange={(id) => { setDisplayId(id); if (outOpen) void openOutput(id); }} />
              <div className="btn-row">
                <button className={`btn ${outOpen ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => void openOutput(displayId)}>{outOpen ? 'Output on' : 'Open output'}</button>
                {outOpen && <button className="btn" onClick={() => { sc.output?.close(); sc.emit(); }}>Close</button>}
              </div>
              <div className="hint">
                {displays.find((d) => d.id === displayId)?.primary
                  ? 'This is the main screen, so the output opens as a window. Connect the LED processor and pick it here for fullscreen.'
                  : 'Opens fullscreen on that display; the display will not sleep while it is open.'}{' '}
                Renders at {show.output.width}×{show.output.height}.
              </div>
            </>
          ) : (
            <>
              <button className={`btn ${outOpen ? 'on' : ''}`} onClick={() => void openOutput()}>{outOpen ? 'Output window open' : 'Open output window'}</button>
              <div className="hint">Drag it to the LED processor's display and press F for fullscreen. {show.output.width}×{show.output.height}.</div>
            </>
          )}
        </div>
        <div className="show-group">
          <div className="list-head">Safety</div>
          <div className="safety">
            <button className={`btn big ${sc.blackout ? 'on danger' : ''}`} onClick={() => sc.set({ blackout: !sc.blackout })}>Blackout<kbd>B</kbd></button>
            <button className={`btn big ${sc.freeze ? 'on' : ''}`} onClick={() => sc.set({ freeze: !sc.freeze })}>Freeze<kbd>Z</kbd></button>
            <button className={`btn big ${sc.fadeToColor ? 'on' : ''}`} onClick={() => sc.set({ fadeToColor: !sc.fadeToColor })}>Fade to colour<kbd>C</kbd></button>
            <button className="btn big" onClick={() => skipSong(1)}>Skip song<kbd>N</kbd></button>
          </div>
          <div className="kv"><span>Fade time</span><Num value={sc.fadeSec} step={0.1} min={0} max={10} unit="s" onChange={(v) => sc.set({ fadeSec: v })} /></div>
        </div>
        <div className="show-group">
          <div className="list-head">Not in this build</div>
          <div className="hint">LTC, Ableton Link and MIDI clock sync, and fallback videos. See docs/STATUS.md.</div>
        </div>
      </div>
    </aside>
  );
}
