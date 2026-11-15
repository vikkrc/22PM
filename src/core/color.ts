// Colours are linear internally; sRGB only at UI and output.
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}
export function linearToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Approximate black-body colour (Tanner Helland fit), returned linear and normalised to max 1. */
export function kelvinToLinear(k: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, k)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number) => srgbToLinear(Math.min(255, Math.max(0, v)) / 255);
  const out: [number, number, number] = [c(r), c(g), c(b)];
  const m = Math.max(out[0], out[1], out[2]) || 1;
  return [out[0] / m, out[1] / m, out[2] / m];
}
