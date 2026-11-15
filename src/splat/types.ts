/** Decoded splat in a renderer-friendly layout. Colours are linear RGB (SH band 0 only). */
export interface SplatData {
  count: number;
  /** xyz per Gaussian. */
  pos: Float32Array;
  /** Linear scale xyz. */
  scale: Float32Array;
  /** Unit quaternion xyzw. */
  quat: Float32Array;
  /** Linear RGB. */
  color: Float32Array;
  /** 0..1 */
  opacity: Float32Array;
}

export interface PreparedSplat extends SplatData {
  /** Smoothed unit normal xyz, oriented away from the splat's centre of mass. */
  normal: Float32Array;
  /** Low-frequency luminance around each Gaussian (for de-lighting). */
  lowLum: Float32Array;
  meanLum: number;
  /** Robust bounds (1st–99th percentile). */
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  center: [number, number, number];
}

export function allocSplat(count: number): SplatData {
  return {
    count, pos: new Float32Array(count * 3), scale: new Float32Array(count * 3), quat: new Float32Array(count * 4),
    color: new Float32Array(count * 3), opacity: new Float32Array(count),
  };
}
