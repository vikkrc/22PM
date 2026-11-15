// SMPTE timecode, MIDI Timecode decoding and the chase state machine (brief section 9).
// Everything here is pure and takes "now" as an argument, so it is unit-testable.

export interface Smpte { h: number; m: number; s: number; f: number }

export function parseTimecode(s: string): Smpte | null {
  const m = s.trim().match(/^(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})$/);
  if (!m) return null;
  return { h: +m[1], m: +m[2], s: +m[3], f: +m[4] };
}
export const smpteToSeconds = (t: Smpte, fps: number) => t.h * 3600 + t.m * 60 + t.s + t.f / fps;
export function secondsToSmpte(sec: number, fps: number): Smpte {
  const total = Math.max(0, Math.round(sec * fps));
  const f = total % fps;
  const s = Math.floor(total / fps);
  return { h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60, f };
}
export const formatTimecode = (t: Smpte) => [t.h, t.m, t.s, t.f].map((n) => String(n).padStart(2, '0')).join(':');
export const timecodeToSeconds = (s: string, fps: number) => {
  const t = parseTimecode(s);
  return t ? smpteToSeconds(t, fps) : 0;
};

const MTC_FPS = [24, 25, 29.97, 30];

/** Decodes MTC quarter-frame (F1 xx) and full-frame SysEx messages. */
export class MtcDecoder {
  private nibbles = new Uint8Array(8);
  private have = 0;
  fps = 25;
  /** Returns the timecode in seconds when a message completes one, else null. */
  feed(data: ArrayLike<number>): number | null {
    if (data[0] === 0xf1 && data.length >= 2) {
      const piece = (data[1] >> 4) & 7;
      this.nibbles[piece] = data[1] & 15;
      this.have |= 1 << piece;
      if (piece === 7 && this.have === 0xff) {
        const n = this.nibbles;
        const f = n[0] | ((n[1] & 1) << 4);
        const s = n[2] | ((n[3] & 3) << 4);
        const m = n[4] | ((n[5] & 3) << 4);
        const h = n[6] | ((n[7] & 1) << 4);
        this.fps = MTC_FPS[(n[7] >> 1) & 3];
        const fps = Math.round(this.fps);
        // A full quarter-frame cycle takes two frames; the time it describes was two frames ago.
        return h * 3600 + m * 60 + s + (f + 2) / fps;
      }
      return null;
    }
    if (data[0] === 0xf0 && data[1] === 0x7f && data[3] === 0x01 && data[4] === 0x01 && data.length >= 10) {
      this.fps = MTC_FPS[(data[5] >> 5) & 3];
      this.have = 0;
      return (data[5] & 31) * 3600 + data[6] * 60 + data[7] + data[8] / Math.round(this.fps);
    }
    return null;
  }
}

export type ChaseStatus = 'idle' | 'locked' | 'freewheel' | 'hold';

export interface ChaseState {
  status: ChaseStatus;
  /** Local time (s) of the last timecode message. */
  lastRxLocal: number;
  /** Timecode (s) carried by that message. */
  lastRxTc: number;
  /** Position frozen at when holding. */
  holdTc: number;
}

export const chaseInit = (): ChaseState => ({ status: 'idle', lastRxLocal: 0, lastRxTc: 0, holdTc: 0 });

/** New timecode arrived. Any jump is an instant relocate, since position is always derived from the last message. */
export function chaseReceive(_s: ChaseState, tc: number, nowLocal: number): ChaseState {
  return { status: 'locked', lastRxLocal: nowLocal, lastRxTc: tc, holdTc: tc };
}

/**
 * Current position. While messages keep arriving we extrapolate from the latest one (sub-frame smooth);
 * after `dropoutSec` without one we freewheel for `freewheelSec`, then hold the last frame. Never black.
 */
export function chasePosition(s: ChaseState, nowLocal: number, freewheelSec: number, dropoutSec = 0.25): { state: ChaseState; tc: number } {
  if (s.status === 'idle') return { state: s, tc: s.holdTc };
  if (s.status === 'hold') return { state: s, tc: s.holdTc };
  const since = nowLocal - s.lastRxLocal;
  if (since <= dropoutSec) return { state: s.status === 'locked' ? s : { ...s, status: 'locked' }, tc: s.lastRxTc + since };
  if (since <= dropoutSec + freewheelSec) return { state: s.status === 'freewheel' ? s : { ...s, status: 'freewheel' }, tc: s.lastRxTc + since };
  const holdTc = s.lastRxTc + dropoutSec + freewheelSec;
  return { state: { ...s, status: 'hold', holdTc }, tc: holdTc };
}

/** Which song does a timecode fall in? Songs are matched by start timecode; the latest start ≤ tc wins. */
export function locateSong(starts: number[], lengths: number[], tc: number): { index: number; sec: number } | null {
  let best = -1;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= tc && (best < 0 || starts[i] > starts[best])) best = i;
  if (best < 0) return null;
  const sec = tc - starts[best];
  if (sec > lengths[best] + 30) return null;
  return { index: best, sec };
}
