export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Where `value` sits between `a` and `b` (0 at a, 1 at b). Returns 0 when a === b. */
export const inverseLerp = (a: number, b: number, value: number): number => a === b ? 0 : (value - a) / (b - a);
export const mapLinear = (x: number, a1: number, a2: number, b1: number, b2: number): number => b1 + (x - a1) * (b2 - b1) / (a2 - a1);
/** Frame-rate independent exponential approach of `x` toward `y`; `lambda` is the rate per second, `dt` in seconds. */
export const damp = (x: number, y: number, lambda: number, dt: number): number => lerp(x, y, 1 - Math.exp(-lambda * dt));
export const smoothstep = (x: number, min: number, max: number): number => {
  if (x <= min) return 0;
  if (x >= max) return 1;
  x = (x - min) / (max - min);
  return x * x * (3 - 2 * x);
};
export const smootherstep = (x: number, min: number, max: number): number => {
  if (x <= min) return 0;
  if (x >= max) return 1;
  x = (x - min) / (max - min);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
export const degToRad = (degrees: number): number => degrees * DEG2RAD;
export const radToDeg = (radians: number): number => radians * RAD2DEG;
/** Modulo that is always non-negative for a positive `m`. */
export const euclideanModulo = (n: number, m: number): number => ((n % m) + m) % m;
export const isPowerOfTwo = (value: number): boolean => Number.isInteger(value) && value > 0 && Math.log2(value) % 1 === 0;
export const ceilPowerOfTwo = (value: number): number => 2 ** Math.ceil(Math.log2(value));
export const floorPowerOfTwo = (value: number): number => 2 ** Math.floor(Math.log2(value));

const step = (state: number): number => {
  let t = Math.imul(state ^ (state >>> 15), state | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** An independent seeded generator returning floats in [0, 1). Same seed, same sequence (mulberry32). */
export function createRandom(seed = 0): () => number {
  let state = seed | 0;
  return () => step(state = (state + 0x6d2b79f5) | 0);
}
let shared = 1234567;
/** three.js-style shared seeded random in [0, 1). Passing `seed` restarts the shared sequence. Prefer `createRandom` for isolated streams. */
export function seededRandom(seed?: number): number {
  if (seed !== undefined) shared = seed | 0;
  return step(shared = (shared + 0x6d2b79f5) | 0);
}
export const randFloat = (low: number, high: number, random: () => number = Math.random): number => low + random() * (high - low);
/** Integer in [low, high], both inclusive. */
export const randInt = (low: number, high: number, random: () => number = Math.random): number => low + Math.floor(random() * (high - low + 1));
export const randFloatSpread = (range: number, random: () => number = Math.random): number => range * (0.5 - random());
