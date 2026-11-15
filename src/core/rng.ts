// Deterministic hashing. No Math.random anywhere in the evaluate path.
export function hash32(a: number, b = 0, c = 0): number {
  let h = (a | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= Math.imul(b | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h ^= Math.imul(c | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 16;
  return h >>> 0;
}
/** 0..1 */
export const rand01 = (a: number, b = 0, c = 0) => hash32(a, b, c) / 4294967296;

export function strSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idCounter = 0;
/** Ids are for editing only (never used as random seeds in evaluate). */
export function newId(prefix: string): string {
  idCounter++;
  const r = (typeof crypto !== 'undefined' && crypto.getRandomValues)
    ? crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
    : (Date.now() + idCounter).toString(36);
  return `${prefix}_${r}${idCounter.toString(36)}`;
}
