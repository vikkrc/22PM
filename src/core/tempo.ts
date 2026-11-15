// Musical time. The timeline stores beats (quarter-note beats of the song's grid); seconds are derived.
export const PPQ = 960;

export interface TempoMap {
  bpm: number;
  /** Beats per bar (time signature numerator). */
  beatsPerBar: number;
  /** Time signature denominator (display only; a beat is one grid beat). */
  beatUnit: number;
  /** Seconds from the start of the audio file to bar 1 beat 1. */
  firstDownbeatSec: number;
}

export const defaultTempo = (): TempoMap => ({ bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 });

export const beatToSec = (tm: TempoMap, beat: number) => tm.firstDownbeatSec + (beat * 60) / tm.bpm;
export const secToBeat = (tm: TempoMap, sec: number) => ((sec - tm.firstDownbeatSec) * tm.bpm) / 60;
export const beatsToDuration = (tm: TempoMap, beats: number) => (beats * 60) / tm.bpm;

export const quantizeTicks = (beat: number) => Math.round(beat * PPQ) / PPQ;

export interface BBT { bar: number; beat: number; tick: number }

/** Bars and beats are 1-based, like every DAW. Negative time (pre-roll) gives bar <= 0. */
export function beatToBBT(tm: TempoMap, beat: number): BBT {
  const totalTicks = Math.round(beat * PPQ);
  const ticksPerBar = tm.beatsPerBar * PPQ;
  const bar = Math.floor(totalTicks / ticksPerBar);
  const rem = totalTicks - bar * ticksPerBar;
  return { bar: bar + 1, beat: Math.floor(rem / PPQ) + 1, tick: rem % PPQ };
}

export function bbtToBeat(tm: TempoMap, b: BBT): number {
  return (b.bar - 1) * tm.beatsPerBar + (b.beat - 1) + b.tick / PPQ;
}

export function formatBBT(tm: TempoMap, beat: number): string {
  const b = beatToBBT(tm, beat);
  return `${b.bar}.${b.beat}.${String(b.tick).padStart(3, '0')}`;
}

/** Accepts "bar", "bar.beat", "bar.beat.tick" (also ":" or space separators). */
export function parseBBT(tm: TempoMap, s: string): number | null {
  const parts = s.trim().split(/[.:\s]+/).map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  return bbtToBeat(tm, { bar: parts[0], beat: parts[1] ?? 1, tick: parts[2] ?? 0 });
}

/** A length in beats shown as bars.beats.ticks (0-based). */
export function formatLength(tm: TempoMap, beats: number): string {
  const t = Math.round(beats * PPQ);
  const tpb = tm.beatsPerBar * PPQ;
  return `${Math.floor(t / tpb)}.${Math.floor((t % tpb) / PPQ)}.${String(t % PPQ).padStart(3, '0')}`;
}
export function parseLength(tm: TempoMap, s: string): number | null {
  const parts = s.trim().split(/[.:\s]+/).map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  return parts[0] * tm.beatsPerBar + (parts[1] ?? 0) + (parts[2] ?? 0) / PPQ;
}

export type SnapMode = 'off' | 'bar' | '1' | '1/2' | '1/4' | '1/8' | '1/3';
export const SNAP_MODES: SnapMode[] = ['off', 'bar', '1', '1/2', '1/4', '1/8', '1/3'];
export const SNAP_LABEL: Record<SnapMode, string> = {
  off: 'Off', bar: 'Bar', '1': 'Beat', '1/2': '1/2', '1/4': '1/4', '1/8': '1/8', '1/3': 'Triplet',
};

export function snapStep(tm: TempoMap, mode: SnapMode): number {
  switch (mode) {
    case 'off': return 0;
    case 'bar': return tm.beatsPerBar;
    case '1': return 1;
    case '1/2': return 0.5;
    case '1/4': return 0.25;
    case '1/8': return 0.125;
    case '1/3': return 1 / 3;
  }
}

export function snapBeat(tm: TempoMap, beat: number, mode: SnapMode): number {
  const step = snapStep(tm, mode);
  if (!step) return quantizeTicks(beat);
  return quantizeTicks(Math.round(beat / step) * step);
}

export function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}
