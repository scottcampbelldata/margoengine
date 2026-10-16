// WGSL noise nodes, twins of `@margoengine/procedural/noise`: the same seed gives the same field on the CPU (f64) and the
// GPU (f32), within float rounding (test/noise-check.mjs measures it on a real adapter). Simplex reads the seed's
// permutation table, declared once per shader as a private array; Perlin hashes lattice cells and takes the seed as a value.
import { Node, cast, vec2, vec3, type NodeInput } from './node.js';

/** Octave sum settings for `fbm` and `ridged` (same defaults as the CPU twins). */
export interface NoiseFractalOptions {
  /** Octaves summed, 1..16 (default 5). */ octaves?: number;
  /** Frequency multiplier per octave (default 2). */ lacunarity?: number;
  /** Amplitude multiplier per octave (default 0.5). */ gain?: number;
  /** Frequency of the first octave (default 1). */ frequency?: number;
}
/** `domainWarp` settings. */
export interface NoiseWarpOptions<T extends 'vec2f' | 'vec3f'> {
  /** Field displacing each axis (default: the warped field). */ warp?: (p: Node<T>) => Node<'f32'>;
  /** Displacement scale (default 1). */
  strength?: number;
}
/** A noise field over 2D or 3D positions, as `fbm`, `ridged` and `domainWarp` take it. */
export type NoiseField<T extends 'vec2f' | 'vec3f'> = (p: Node<T>) => Node<'f32'>;

/** Warp sample offsets per axis (the CPU twin's `WARP_OFFSETS`). */
const OFFSETS = [0, 5.2, 1.7, 9.2];
const G2 = (3 - Math.sqrt(3)) / 6,
  F2 = 0.5 * (Math.sqrt(3) - 1);
/** The CPU twin's permutation: xorshift32 from `seed >>> 0 || 1`, a Fisher-Yates shuffle of 0..255 from the top. */
function permutation(seed: number): Uint8Array {
  let state = seed >>> 0 || 1;
  const p = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = Math.floor(((state >>> 0) / 4294967296) * (i + 1)),
      t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}
const seedOf = (seed: number): number => {
  if (!Number.isSafeInteger(seed)) throw new RangeError('Invalid noise seed');
  return seed >>> 0 || 1;
};
const tableCode = (state: number): string => {
  const p = permutation(state),
    packed = Array.from(
      { length: 64 },
      (_, i) => ((p[i * 4] | (p[i * 4 + 1] << 8) | (p[i * 4 + 2] << 16) | (p[i * 4 + 3] << 24)) >>> 0) + 'u',
    ),
    name = 'noisePerm' + state.toString(16);
  return `var<private> ${name}Table: array<u32, 64> = array<u32, 64>(${packed.join(', ')});\nfn ${name}(i: i32) -> i32 {\n  let k = u32(i) & 255u;\n  return i32((${name}Table[k >> 2u] >> ((k & 3u) * 8u)) & 255u);\n}`;
};
const SIMPLEX2 = `fn noiseGrad2(h: i32) -> vec2f {
  let g = h & 7; let a = select(1.0, -1.0, (g & 1) != 0); let b = select(1.0, -1.0, (g & 2) != 0);
  if (g < 4) { return vec2f(a, b); }
  if (g < 6) { return vec2f(a, 0.0); }
  return vec2f(0.0, a);
}
fn noiseCorner2(d: vec2f, h: i32) -> f32 {
  var c = 0.5 - dot(d, d);
  if (c < 0.0) { return 0.0; }
  c = c * c;
  return c * c * dot(noiseGrad2(h), d);
}`;
const SIMPLEX3 = `fn noiseGrad3(h: i32) -> vec3f {
  let g = h % 12; let a = select(1.0, -1.0, (g & 1) != 0); let b = select(1.0, -1.0, (g & 2) != 0);
  if (g < 4) { return vec3f(a, b, 0.0); }
  if (g < 8) { return vec3f(a, 0.0, b); }
  return vec3f(0.0, a, b);
}
fn noiseCorner3(d: vec3f, h: i32) -> f32 {
  var c = 0.5 - dot(d, d);
  if (c < 0.0) { return 0.0; }
  c = c * c;
  return c * c * dot(noiseGrad3(h), d);
}`;
const PERLIN3 = `fn noiseHash(x: i32, y: i32, z: i32, seed: u32) -> u32 {
  var h = (bitcast<u32>(x) * 374761393u) ^ (bitcast<u32>(y) * 668265263u) ^ (bitcast<u32>(z) * 1442695041u) ^ seed;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
fn noisePerlinGrad(h: u32, d: vec3f) -> f32 {
  let k = h & 15u; let u = select(d.y, d.x, k < 8u); let v = select(select(d.z, d.x, k == 12u || k == 14u), d.y, k < 4u);
  return select(u, -u, (k & 1u) != 0u) + select(v, -v, (k & 2u) != 0u);
}
fn noisePerlin3(p: vec3f, seed: u32) -> f32 {
  let c = floor(p); let f = p - c; let i = vec3i(c); let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var value = 0.0;
  for (var a = 0; a < 2; a++) { for (var b = 0; b < 2; b++) { for (var e = 0; e < 2; e++) {
    let o = vec3i(a, b, e); let s = select(1.0 - w, w, o == vec3i(1));
    value += noisePerlinGrad(noiseHash(i.x + a, i.y + b, i.z + e, seed), f - vec3f(o)) * s.x * s.y * s.z;
  } } }
  return value;
}`;
const simplex2Code = (P: string) => `fn ${P}Simplex2(v: vec2f) -> f32 {
  let s = (v.x + v.y) * ${F2}; let i = floor(v.x + s); let j = floor(v.y + s); let t = (i + j) * ${G2};
  let x0 = v - vec2f(i - t, j - t); let o = select(vec2i(0, 1), vec2i(1, 0), x0.x > x0.y);
  let ii = i32(i) & 255; let jj = i32(j) & 255;
  return 70.0 * (noiseCorner2(x0, ${P}(ii + ${P}(jj))) + noiseCorner2(x0 - vec2f(o) + ${G2}, ${P}(ii + o.x + ${P}(jj + o.y))) +
    noiseCorner2(x0 - 1.0 + ${2 * G2}, ${P}(ii + 1 + ${P}(jj + 1))));
}`;
const simplex3Code = (P: string) => `fn ${P}Simplex3(v: vec3f) -> f32 {
  let s = (v.x + v.y + v.z) * ${1 / 3}; let c = floor(v + s); let t = (c.x + c.y + c.z) * ${1 / 6};
  let x0 = v - (c - t);
  // Rank of each offset among the three (ties go to the later axis, as on the CPU); corner n steps along the top n.
  let gt = vec3i(select(0, 1, x0.x > x0.y), select(0, 1, x0.x > x0.z), select(0, 1, x0.y > x0.z));
  let rank = vec3i(gt.x + gt.y, 1 - gt.x + gt.z, 2 - gt.y - gt.z);
  let o1 = vec3i(rank >= vec3i(2)); let o2 = vec3i(rank >= vec3i(1));
  let i = vec3i(c) & vec3i(255);
  return 76.0 * (noiseCorner3(x0, ${P}(i.x + ${P}(i.y + ${P}(i.z)))) +
    noiseCorner3(x0 - vec3f(o1) + ${1 / 6}, ${P}(i.x + o1.x + ${P}(i.y + o1.y + ${P}(i.z + o1.z)))) +
    noiseCorner3(x0 - vec3f(o2) + ${2 / 6}, ${P}(i.x + o2.x + ${P}(i.y + o2.y + ${P}(i.z + o2.z)))) +
    noiseCorner3(x0 - 0.5, ${P}(i.x + 1 + ${P}(i.y + 1 + ${P}(i.z + 1)))));
}`;
/** A call to a generated function; `parts` are [key, code] module declarations it needs. */
function call(name: string, args: Node[], parts: readonly (readonly [string, string])[]): Node<'f32'> {
  return new Node('f32', 'z' + name, args, (b, n) => {
    for (const [key, code] of parts) b.declare(key, code);
    return `${name}(${n.args.map((a) => b.expr(a)).join(', ')})`;
  });
}
const seeded = (
  seed: number,
  helpers: string,
  code: (perm: string) => string,
  suffix: string,
  p: Node,
): Node<'f32'> => {
  const state = seedOf(seed),
    perm = 'noisePerm' + state.toString(16);
  return call(
    perm + suffix,
    [p],
    [
      ['noise:' + perm, tableCode(state)],
      ['noise:' + suffix, helpers],
      ['noise:' + perm + suffix, code(perm)],
    ],
  );
};

/** 2D simplex in about [-1, 1]; `new Noise(seed).simplex2(x, y)` on the CPU. */
export const simplex2 = (p: NodeInput<'vec2f'>, seed = 1): Node<'f32'> =>
  seeded(seed, SIMPLEX2, simplex2Code, 'Simplex2', cast(p, 'vec2f', 'simplex2 position'));
/** 3D simplex in about [-1, 1]; `new Noise(seed).simplex(x, y, z)` on the CPU. */
export const simplex3 = (p: NodeInput<'vec3f'>, seed = 1): Node<'f32'> =>
  seeded(seed, SIMPLEX3, simplex3Code, 'Simplex3', cast(p, 'vec3f', 'simplex3 position'));
/** 3D gradient noise; `new Noise(seed).perlin(x, y, z)` on the CPU. `seed` may be a u32 node (a uniform reseeds without recompiling). */
export function perlin3(p: NodeInput<'vec3f'>, seed: number | Node<'u32'> = 1): Node<'f32'> {
  if (typeof seed === 'number' && !Number.isSafeInteger(seed)) throw new RangeError('Invalid noise seed');
  return call(
    'noisePerlin3',
    [cast(p, 'vec3f', 'perlin3 position'), typeof seed === 'number' ? cast((seed | 0) >>> 0, 'u32') : seed],
    [['noise:perlin3', PERLIN3]],
  );
}

function octaves({
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
  frequency = 1,
}: NoiseFractalOptions): [number, number, number, number] {
  if (
    !Number.isInteger(octaves) ||
    octaves < 1 ||
    octaves > 16 ||
    ![lacunarity, gain, frequency].every(Number.isFinite)
  )
    throw new RangeError('Invalid fractal options');
  return [octaves, lacunarity, gain, frequency];
}
function sum<T extends 'vec2f' | 'vec3f'>(
  p: Node<T>,
  options: NoiseFractalOptions,
  octave: (q: Node<T>) => Node<'f32'>,
): Node<'f32'> {
  const [count, lacunarity, gain, frequency] = octaves(options);
  let total = 0,
    amplitude = 1,
    f = frequency,
    value: Node<'f32'> | undefined;
  for (let o = 0; o < count; o++) {
    const term = octave(p.mul(f)).mul(amplitude);
    value = value ? value.add(term) : term;
    total += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }
  return value!.div(total);
}
/** Fractal Brownian motion: octaves of `noise` divided by the total amplitude (unrolled; `fbm` on the CPU). */
export const fbm = <T extends 'vec2f' | 'vec3f'>(
  noise: NoiseField<T>,
  p: Node<T>,
  options: NoiseFractalOptions = {},
): Node<'f32'> => sum(p, options, noise);
/** Ridged multifractal in [0, 1]: octaves of `(1 - |noise|)^2` (`ridged` on the CPU). */
export const ridged = <T extends 'vec2f' | 'vec3f'>(
  noise: NoiseField<T>,
  p: Node<T>,
  options: NoiseFractalOptions = {},
): Node<'f32'> =>
  sum(p, options, (q) => {
    const r = noise(q).abs().oneMinus();
    return r.mul(r);
  });
/** Domain warping: `noise(p + strength * (warp(p + o0), warp(p + o1)[, warp(p + o2)]))` (`domainWarp` on the CPU). */
export function domainWarp<T extends 'vec2f' | 'vec3f'>(
  noise: NoiseField<T>,
  p: Node<T>,
  { warp = noise, strength = 1 }: NoiseWarpOptions<T> = {},
): Node<'f32'> {
  if (!Number.isFinite(strength)) throw new RangeError('Invalid warp options');
  const at = (o: number) => warp(p.add(o)).mul(strength),
    offset =
      p.type === 'vec2f' ? vec2(at(OFFSETS[0]), at(OFFSETS[1])) : vec3(at(OFFSETS[0]), at(OFFSETS[1]), at(OFFSETS[2]));
  return noise(cast(p.add(offset), p.type, 'warped position'));
}
