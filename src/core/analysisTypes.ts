// Result of offline audio analysis. Plain data, cached per audio asset.
export const ANALYSIS_RATE = 200; // envelope frames per second
export const ANALYSIS_BANDS = 32; // log-spaced bands, 30 Hz .. 16 kHz
export const BAND_LO_HZ = 30;
export const BAND_HI_HZ = 16000;

export interface OnsetList { times: Float32Array; strengths: Float32Array }

export interface Analysis {
  version: number;
  duration: number;
  rate: number;
  frames: number;
  /** frames × ANALYSIS_BANDS, magnitudes normalised to roughly 0..1. */
  bands: Float32Array;
  onsets: { kick: OnsetList; snare: OnsetList; other: OnsetList };
  bpm: number;
  firstDownbeatSec: number;
  beatsPerBar: number;
  /** min/max pairs for the waveform overview. */
  peaks: Float32Array;
  peaksPerSec: number;
}

export function bandIndexForHz(hz: number): number {
  const x = Math.log(Math.max(hz, 1) / BAND_LO_HZ) / Math.log(BAND_HI_HZ / BAND_LO_HZ);
  return Math.min(ANALYSIS_BANDS, Math.max(0, x * ANALYSIS_BANDS));
}
export const bandHz = (i: number) => BAND_LO_HZ * Math.pow(BAND_HI_HZ / BAND_LO_HZ, i / ANALYSIS_BANDS);
