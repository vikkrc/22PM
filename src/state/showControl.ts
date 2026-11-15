// Live show state: safety keys and timecode chase. Deliberately outside the Show document and undo.
import { chaseInit, chasePosition, chaseReceive, locateSong, MtcDecoder, timecodeToSeconds, type ChaseState } from '../core/timecode';
import { songDuration } from './runtime';
import { getState, setUi } from './store';
import { transport } from './transport';

type Listener = () => void;

class ShowControl {
  blackout = false;
  freeze = false;
  fadeToColor = false;
  /** Smoothed 0..1 mixes (advanced per frame by the viewport). */
  blackMix = 0;
  colorMix = 0;
  fadeSec = 0.6;

  source: 'internal' | 'mtc' = 'internal';
  chase: ChaseState = chaseInit();
  freewheelSec = 2;
  midiInputs: { id: string; name: string }[] = [];
  midiInputId = '';
  midiError = '';
  lastTc = 0;
  private decoder = new MtcDecoder();
  private shownStatus = '';
  private access: MIDIAccess | null = null;
  private listeners = new Set<Listener>();
  output: Window | null = null;

  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  emit() { for (const l of this.listeners) l(); }
  set(patch: Partial<Pick<ShowControl, 'blackout' | 'freeze' | 'fadeToColor' | 'freewheelSec' | 'fadeSec'>>) { Object.assign(this, patch); this.emit(); }

  /** Advance the safety fades. dt is real time: these are live overrides, not part of the timeline. */
  tick(dt: number) {
    const step = this.fadeSec > 0 ? dt / this.fadeSec : 1;
    const go = (v: number, on: boolean) => Math.min(1, Math.max(0, v + (on ? step : -step)));
    this.blackMix = go(this.blackMix, this.blackout);
    this.colorMix = go(this.colorMix, this.fadeToColor);
  }

  async enableMidi() {
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      const refresh = () => {
        this.midiInputs = [...this.access!.inputs.values()].map((i) => ({ id: i.id, name: i.name ?? i.id }));
        if (!this.midiInputs.some((i) => i.id === this.midiInputId)) this.selectInput(this.midiInputs[0]?.id ?? '');
        this.emit();
      };
      this.access.onstatechange = refresh;
      refresh();
      this.midiError = '';
    } catch (e) {
      this.midiError = `MIDI unavailable: ${(e as Error).message}`;
    }
    this.emit();
  }

  selectInput(id: string) {
    if (!this.access) return;
    for (const i of this.access.inputs.values()) i.onmidimessage = null;
    this.midiInputId = id;
    const input = this.access.inputs.get(id);
    if (input) input.onmidimessage = (e) => { if (e.data) this.feed(e.data); };
    this.emit();
  }

  /** Feed raw MIDI bytes (also used by the built-in timecode simulator and tests). */
  feed(data: ArrayLike<number>) {
    const tc = this.decoder.feed(data);
    if (tc == null) return;
    this.chase = chaseReceive(this.chase, tc, performance.now() / 1000);
  }
  /** Inject a timecode position directly, as if a full-frame message arrived. */
  feedSeconds(tc: number) { this.chase = chaseReceive(this.chase, tc, performance.now() / 1000); }

  setSource(s: 'internal' | 'mtc') {
    this.source = s;
    transport.pause();
    transport.external = s === 'mtc';
    if (s === 'mtc') { this.chase = chaseInit(); if (!this.access) void this.enableMidi(); }
    this.emit();
  }

  /** Called once per frame in chase mode: follow timecode to the right song and position. */
  follow() {
    if (this.source !== 'mtc') return;
    const r = chasePosition(this.chase, performance.now() / 1000, this.freewheelSec);
    this.chase = r.state;
    this.lastTc = r.tc;
    if (r.state.status !== 'idle') {
      const { show, ui } = getState();
      const fps = show.output.timecodeFps;
      const hit = locateSong(show.songs.map((s) => timecodeToSeconds(s.startTimecode, fps)), show.songs.map(songDuration), r.tc);
      if (hit) {
        const song = show.songs[hit.index];
        if (song.id !== ui.songId) setUi({ songId: song.id, selection: { type: 'none' }, selectedKeys: [] });
        transport.setExternal(Math.min(hit.sec, songDuration(song)));
      }
    }
    if (this.shownStatus !== r.state.status) { this.shownStatus = r.state.status; this.emit(); }
  }
}

export const showControl = new ShowControl();
