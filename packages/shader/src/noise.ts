// WGSL noise nodes, twins of `@margoengine/procedural/noise`: the same seed gives the same field on the CPU (f64) and the
// GPU (f32), within float rounding (test/noise-check.mjs measures it on a real adapter). Simplex reads the seed's
// permutation table, declared once per shader as a private array; Perlin hashes lattice cells and takes the seed as a value.
import { Node, cast, vec2, vec3, vec4, type NodeInput } from './node.js';
import { fractalOptions, type FractalOptions } from '../../shared/fractal.js';

/** Octave sum settings for `fbm` and `ridged` (the CPU twins' FractalOptions, same defaults). */
export type NoiseFractalOptions = FractalOptions;
/** `domainWarp` settings. */
export interface NoiseWarpOptions<T extends 'vec2f' | 'vec3f' | 'vec4f'> {
  /** Field displacing each axis (default: the warped field). */ warp?: (p: Node<T>) => Node<'f32'>;
  /** Displacement scale (default 1). */
  strength?: number;
}
/** A noise field over 2D, 3D or 4D positions, as `fbm`, `ridged` and `domainWarp` take it. */
export type NoiseField<T extends 'vec2f' | 'vec3f' | 'vec4f'> = (p: Node<T>) => Node<'f32'>;

/** Warp sample offsets per axis (the CPU twin's `WARP_OFFSETS`). */
const OFFSETS = [0, 5.2, 1.7, 9.2];
const G2 = (3 - Math.sqrt(3)) / 6,
  F2 = 0.5 * (Math.sqrt(3) - 1),
  F4 = (Math.sqrt(5) - 1) / 4,
  G4 = (5 - Math.sqrt(5)) / 20;
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
  if (!Number.isSafeInteger(seed)) throw new RangeError('Noise seed must be a safe integer; pass a whole number.');
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
const SIMPLEX4 = `fn noiseCorner4(d: vec4f, h: i32) -> f32 {
  var c = 0.5 - dot(d, d);
  if (c < 0.0) { return 0.0; }
  c = c * c;
  // Index 0..31: bits 3-4 name the zero axis, bits 0-2 the signs of the other three in axis order.
  let g = h & 31; let zero = g >> 3u;
  let s = vec3f(select(1.0, -1.0, (g & 4) != 0), select(1.0, -1.0, (g & 2) != 0), select(1.0, -1.0, (g & 1) != 0));
  var v = d.xyz;
  if (zero == 0) { v = d.yzw; } else if (zero == 1) { v = d.xzw; } else if (zero == 2) { v = d.xyw; }
  return c * c * dot(s, v);
}`;
const HASH = `fn noiseHash(x: i32, y: i32, z: i32, seed: u32) -> u32 {
  var h = (bitcast<u32>(x) * 374761393u) ^ (bitcast<u32>(y) * 668265263u) ^ (bitcast<u32>(z) * 1442695041u) ^ seed;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}`;
// One feature point per cell, at the hashes the CPU twin uses. Two cells each side is exact: the nearest point in a cell
// three away is at least 2 off, and the two nearest points are always within sqrt(3). The result is the nearest distance,
// the second nearest and the nearest point's cell id, 0 to 1.
const VORONOI2 = `fn noiseVoronoi2(p: vec2f, seed: u32) -> vec3f {
  let c = floor(p); let f = p - c; let i = vec2i(c);
  var best = vec2f(1e30); var id = 0u;
  for (var a = -2; a <= 2; a++) { for (var b = -2; b <= 2; b++) {
    let x = i.x + a; let y = i.y + b;
    let h = vec2f(f32(noiseHash(x, y, 0, seed)), f32(noiseHash(x, y, 0, seed ^ 0x9e3779b9u)));
    let d = vec2f(f32(a), f32(b)) + h / 4294967296.0 - f;
    let e = dot(d, d);
    if (e < best.x) { best = vec2f(e, best.x); id = noiseHash(x, y, 0, seed ^ 0xc2b2ae35u); }
    else if (e < best.y) { best.y = e; }
  } }
  return vec3f(sqrt(best), f32(id >> 8u) / 16777216.0);
}`;
const VORONOI3 = `fn noiseVoronoi3(p: vec3f, seed: u32) -> vec3f {
  let c = floor(p); let f = p - c; let i = vec3i(c);
  var best = vec2f(1e30); var id = 0u;
  for (var a = -2; a <= 2; a++) { for (var b = -2; b <= 2; b++) { for (var k = -2; k <= 2; k++) {
    let x = i.x + a; let y = i.y + b; let z = i.z + k;
    let h = vec3f(f32(noiseHash(x, y, z, seed)), f32(noiseHash(x, y, z, seed ^ 0x9e3779b9u)), f32(noiseHash(x, y, z, seed ^ 0x85ebca6bu)));
    let d = vec3f(f32(a), f32(b), f32(k)) + h / 4294967296.0 - f;
    let e = dot(d, d);
    if (e < best.x) { best = vec2f(e, best.x); id = noiseHash(x, y, z, seed ^ 0xc2b2ae35u); }
    else if (e < best.y) { best.y = e; }
  } } }
  return vec3f(sqrt(best), f32(id >> 8u) / 16777216.0);
}`;
const PERLIN3 = `// Perlin's 2002 gradient set: the 12 cube-edge midpoints padded to 16 (indexed by the hash's low 4 bits), in the same
// index order as the CPU table, so every seed gives the same field on both sides.
var<private> noisePerlinGradients: array<vec3f, 16> = array<vec3f, 16>(
  vec3f(1, 1, 0), vec3f(-1, 1, 0), vec3f(1, -1, 0), vec3f(-1, -1, 0), vec3f(1, 0, 1), vec3f(-1, 0, 1), vec3f(1, 0, -1),
  vec3f(-1, 0, -1), vec3f(0, 1, 1), vec3f(0, -1, 1), vec3f(0, 1, -1), vec3f(0, -1, -1), vec3f(1, 1, 0), vec3f(0, -1, 1),
  vec3f(-1, 1, 0), vec3f(0, -1, -1));
fn noisePerlinGrad(h: u32, d: vec3f) -> f32 { return dot(noisePerlinGradients[h & 15u], d); }
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
const simplex4Code = (P: string) => `fn ${P}Simplex4(v: vec4f) -> f32 {
  let s = (v.x + v.y + v.z + v.w) * ${F4}; let c = floor(v + s); let t = (c.x + c.y + c.z + c.w) * ${G4};
  let x0 = v - (c - t);
  // Rank of each offset among the four (ties go to the later axis, as on the CPU); corner n steps along the top n.
  let a = select(0, 1, x0.x > x0.y); let b = select(0, 1, x0.x > x0.z); let d = select(0, 1, x0.x > x0.w);
  let e = select(0, 1, x0.y > x0.z); let g = select(0, 1, x0.y > x0.w); let h = select(0, 1, x0.z > x0.w);
  let rank = vec4i(a + b + d, 1 - a + e + g, 2 - b - e + h, 3 - d - g - h);
  let i = vec4i(c) & vec4i(255);
  var sum = 0.0;
  for (var n = 0; n < 5; n++) {
    let o = vec4i(rank >= vec4i(4 - n));
    sum += noiseCorner4(x0 - vec4f(o) + f32(n) * ${G4}, ${P}(i.x + o.x + ${P}(i.y + o.y + ${P}(i.z + o.z + ${P}(i.w + o.w)))));
  }
  return 62.0 * sum;
}`;
/** A call to a generated function; `parts` are [key, code] module declarations it needs. */
function call<T extends 'f32' | 'vec3f' = 'f32'>(
  name: string,
  args: Node[],
  parts: readonly (readonly [string, string])[],
  type: T = 'f32' as T,
): Node<T> {
  return new Node(type, 'z' + name, args, (b, n) => {
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
/** 4D simplex in about [-1, 1]; `new Noise(seed).simplex4(x, y, z, w)` on the CPU. Walk w, or a circle in two axes, to animate or loop a field. */
export const simplex4 = (p: NodeInput<'vec4f'>, seed = 1): Node<'f32'> =>
  seeded(seed, SIMPLEX4, simplex4Code, 'Simplex4', cast(p, 'vec4f', 'simplex4 position'));
const liveSeed = (seed: number | Node<'u32'>): Node<'u32'> => {
  if (typeof seed === 'number' && !Number.isSafeInteger(seed))
    throw new RangeError('Noise seed must be a safe integer; pass a whole number.');
  return typeof seed === 'number' ? cast((seed | 0) >>> 0, 'u32') : seed;
};
/** 3D gradient noise; `new Noise(seed).perlin(x, y, z)` on the CPU. `seed` may be a u32 node (a uniform reseeds without recompiling). */
export const perlin3 = (p: NodeInput<'vec3f'>, seed: number | Node<'u32'> = 1): Node<'f32'> =>
  call(
    'noisePerlin3',
    [cast(p, 'vec3f', 'perlin3 position'), liveSeed(seed)],
    [
      ['noise:hash', HASH],
      ['noise:perlin3', PERLIN3],
    ],
  );
/**
 * Cellular noise in 2D, as `vec3f`: `.x` the distance to the nearest cell point, `.y` to the second nearest, `.z` the
 * nearest cell's id from 0 to 1. `.y.sub(.x)` is 0 on the borders, for cracks; `.z` gives each cell its own value. `seed`
 * may be a u32 node.
 */
export const voronoi2 = (p: NodeInput<'vec2f'>, seed: number | Node<'u32'> = 1): Node<'vec3f'> =>
  call(
    'noiseVoronoi2',
    [cast(p, 'vec2f', 'voronoi2 position'), liveSeed(seed)],
    [
      ['noise:hash', HASH],
      ['noise:voronoi2', VORONOI2],
    ],
    'vec3f',
  );
/** {@link voronoi2} in 3D, with the feature points of `new Noise(seed).worley`. */
export const voronoi3 = (p: NodeInput<'vec3f'>, seed: number | Node<'u32'> = 1): Node<'vec3f'> =>
  call(
    'noiseVoronoi3',
    [cast(p, 'vec3f', 'voronoi3 position'), liveSeed(seed)],
    [
      ['noise:hash', HASH],
      ['noise:voronoi3', VORONOI3],
    ],
    'vec3f',
  );
/** Distance to the nearest cell point, from 0; about 0.5 on average. */
export const worley2 = (p: NodeInput<'vec2f'>, seed: number | Node<'u32'> = 1): Node<'f32'> => voronoi2(p, seed).x;
/** {@link worley2} in 3D; `new Noise(seed).worley(x, y, z)` on the CPU. */
export const worley3 = (p: NodeInput<'vec3f'>, seed: number | Node<'u32'> = 1): Node<'f32'> => voronoi3(p, seed).x;

const octaves = fractalOptions;
function sum<T extends 'vec2f' | 'vec3f' | 'vec4f'>(
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
export const fbm = <T extends 'vec2f' | 'vec3f' | 'vec4f'>(
  noise: NoiseField<T>,
  p: Node<T>,
  options: NoiseFractalOptions = {},
): Node<'f32'> => sum(p, options, noise);
/** Ridged multifractal in [0, 1]: octaves of `(1 - |noise|)^2` (`ridged` on the CPU). */
export const ridged = <T extends 'vec2f' | 'vec3f' | 'vec4f'>(
  noise: NoiseField<T>,
  p: Node<T>,
  options: NoiseFractalOptions = {},
): Node<'f32'> =>
  sum(p, options, (q) => {
    const r = noise(q).abs().oneMinus();
    return r.mul(r);
  });
/** Domain warping: `noise(p + strength * (warp(p + o0), warp(p + o1), ...))`, one term per axis (`domainWarp` on the CPU). */
export function domainWarp<T extends 'vec2f' | 'vec3f' | 'vec4f'>(
  noise: NoiseField<T>,
  p: Node<T>,
  { warp = noise, strength = 1 }: NoiseWarpOptions<T> = {},
): Node<'f32'> {
  if (!Number.isFinite(strength))
    throw new RangeError('Domain warp strength must be a finite number; pass a number such as 0.5.');
  const at = (o: number) => warp(p.add(o)).mul(strength),
    offset =
      p.type === 'vec2f'
        ? vec2(at(OFFSETS[0]), at(OFFSETS[1]))
        : p.type === 'vec3f'
          ? vec3(at(OFFSETS[0]), at(OFFSETS[1]), at(OFFSETS[2]))
          : vec4(at(OFFSETS[0]), at(OFFSETS[1]), at(OFFSETS[2]), at(OFFSETS[3]));
  return noise(cast(p.add(offset), p.type, 'warped position'));
}
