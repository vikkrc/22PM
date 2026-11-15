// Transport: where "now" is in the current song. This is the only place a wall clock is read;
// everything downstream is evaluate(show, song, sec).
type Listener = () => void;

class Transport {
  private _sec = 0;
  playing = false;
  /** Loop range in seconds, or null. */
  loop: [number, number] | null = null;
  /** Song end in seconds; playback stops (or loops) here. */
  end = 60;
  /** When true, position is driven by timecode chase and the internal clock is ignored. */
  external = false;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private anchorClock = 0;
  private anchorSec = 0;
  private listeners = new Set<Listener>();
  volume = 1;

  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit() { for (const l of this.listeners) l(); }

  private clock(): number { return this.buffer && this.ctx ? this.ctx.currentTime : performance.now() / 1000; }

  /** Current position in seconds. Call once per frame. */
  now(): number {
    if (!this.playing || this.external) return this._sec;
    let s = this.anchorSec + (this.clock() - this.anchorClock);
    const [a, b] = this.loop ?? [0, this.end];
    if (s >= b) {
      if (this.loop) { this.seek(a + ((s - a) % Math.max(0.01, b - a))); return this._sec; }
      this.pause();
      this._sec = b;
      this.emit();
      return b;
    }
    this._sec = s;
    return s;
  }

  get sec() { return this._sec; }

  setBuffer(buf: AudioBuffer | null) {
    const was = this.playing;
    if (was) this.pause();
    this.buffer = buf;
    if (was) this.play();
  }

  setVolume(v: number) { this.volume = v; if (this.gain) this.gain.gain.value = v; }

  play() {
    if (this.playing || this.external) return;
    if (this._sec >= this.end - 0.01) this._sec = this.loop ? this.loop[0] : 0;
    if (this.buffer) {
      if (!this.ctx) { this.ctx = new AudioContext(); this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); this.gain.gain.value = this.volume; }
      void this.ctx.resume();
      this.startSource();
    }
    this.anchorClock = this.clock();
    this.anchorSec = this._sec;
    this.playing = true;
    this.emit();
  }

  private startSource() {
    if (!this.ctx || !this.buffer) return;
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain!);
    if (this._sec >= 0) src.start(0, Math.min(this._sec, this.buffer.duration));
    else src.start(this.ctx.currentTime - this._sec, 0);
    this.src = src;
  }
  private stopSource() {
    try { this.src?.stop(); } catch { /* not started */ }
    this.src?.disconnect();
    this.src = null;
  }

  pause() {
    if (!this.playing) return;
    this._sec = this.anchorSec + (this.clock() - this.anchorClock);
    this.playing = false;
    this.stopSource();
    this.emit();
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  seek(sec: number) {
    this._sec = sec;
    if (this.playing && !this.external) {
      this.anchorSec = sec;
      if (this.buffer) this.startSource();
      this.anchorClock = this.clock();
    }
    this.emit();
  }

  /** Timecode chase writes the position directly. */
  setExternal(sec: number) { this._sec = sec; }
}

export const transport = new Transport();
