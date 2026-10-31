// Integer hashes and value noise for deterministic placement and terrain. The PCG output hash is the one Jarzynski
// and Olano recommend for GPU rendering ("Hash functions for GPU rendering", Journal of Computer Graphics Techniques,
// 2020): an LCG step followed by a random xorshift and a multiply. Several inputs are combined by nesting, h(a + h(b)),
// as that paper describes. Value noise blends lattice hashes with Perlin's quintic fade ("Improving Noise", 2002).
import { divWide, fade, ONE, qmul } from './fixed.js';

/** PCG hash of a u32 (any number is taken modulo 2^32): a well mixed u32. */
export function pcg(v: number): number {
  const state = (Math.imul(v | 0, 747796405) + 2891336453) | 0,
    word = Math.imul(((state >>> (((state >>> 28) + 4) & 31)) ^ state) | 0, 277803737);
  return ((word >>> 22) ^ word) >>> 0;
}

/** Hash of two u32 values. */
export function hash2(a: number, b: number): number {
  return pcg((a | 0) + pcg(b));
}

/** Hash of three u32 values. */
export function hash3(a: number, b: number, c: number): number {
  return pcg((a | 0) + pcg((b | 0) + pcg(c)));
}

/** Hash of four u32 values. */
export function hash4(a: number, b: number, c: number, d: number): number {
  return pcg((a | 0) + pcg((b | 0) + pcg((c | 0) + pcg(d))));
}

/** Hash of five u32 values: placement uses (seed, layer, cell x, cell z, index). */
export function hash5(a: number, b: number, c: number, d: number, e: number): number {
  return pcg((a | 0) + pcg((b | 0) + pcg((c | 0) + pcg((d | 0) + pcg(e)))));
}

/**
 * Smooth 2D value noise in Q16.16: `x` and `z` are Q16.16 lattice coordinates (1.0 = one lattice cell, any i32), the
 * result is in 0..65535. Continuous, and the same everywhere for the same `seed`.
 */
export function valueNoise(seed: number, x: number, z: number): number {
  const ix = x >> 16,
    iz = z >> 16,
    fx = fade(x & 0xffff),
    fz = fade(z & 0xffff),
    // hash3(seed, ix + i, iz + j) with the inner pcg of each row shared.
    z0 = pcg(iz),
    z1 = pcg(iz + 1),
    a = pcg((seed | 0) + pcg(ix + z0)) >>> 16,
    b = pcg((seed | 0) + pcg(ix + 1 + z0)) >>> 16,
    c = pcg((seed | 0) + pcg(ix + z1)) >>> 16,
    d = pcg((seed | 0) + pcg(ix + 1 + z1)) >>> 16,
    top = a + qmul(b - a, fx),
    bottom = c + qmul(d - c, fx);
  return top + qmul(bottom - top, fz);
}

/**
 * Fractal sum of {@link valueNoise} octaves in Q16.16, normalised to 0..65535: each octave doubles the frequency and
 * halves the amplitude; every octave is rotated and offset (integer shear) so lattice lines do not line up.
 */
export function fbm(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0,
    total = 0,
    amplitude = ONE;
  for (let i = 0; i < octaves; i++) {
    sum += qmul(valueNoise(seed + i * 1013, x, z), amplitude);
    total += amplitude;
    // Double the frequency with a shear (x, z) -> (2x - z/2, x/2 + 2z) plus an offset: cheap and exact.
    const nx = 2 * x - (z >> 1) + 0x3c6ef35,
      nz = (x >> 1) + 2 * z + 0x1b873593;
    x = nx | 0;
    z = nz | 0;
    amplitude >>= 1;
  }
  return divWide(sum * 65535, total);
}

// Gradient directions of `simplexNoise`: 16 unit vectors in Q16.16, none on an axis, written out so no engine's cos or
// sin takes part.
const GRAD_X = [
    64277, 54491, 36410, 12785, -12785, -36410, -54491, -64277, -64277, -54491, -36410, -12785, 12785, 36410, 54491,
    64277,
  ],
  GRAD_Z = [
    12785, 36410, 54491, 64277, 64277, 54491, 36410, 12785, -12785, -36410, -54491, -64277, -64277, -54491, -36410,
    -12785,
  ];
// Simplex skew factors in Q16.16: F = (sqrt(3) - 1) / 2 and G = (3 - sqrt(3)) / 6.
const SKEW = 23988,
  UNSKEW = 13849;

/** One corner's share of `simplexNoise`, Q48 at most 2^45: the radial falloff `(1/2 - r^2)^4` times gradient plus value. */
function corner(seed: number, i: number, j: number, x: number, z: number): number {
  const a = 32768 - Math.floor((x * x + z * z) / ONE);
  if (a <= 0) return 0;
  const h = pcg((seed | 0) + pcg((i | 0) + pcg(j | 0))),
    d = h >>> 28,
    a2 = Math.floor((a * a) / ONE);
  return a2 * a2 * (Math.floor((GRAD_X[d] * x + GRAD_Z[d] * z) / ONE) + (((h & 0xffff) - 32768) >> 1));
}

/**
 * Isotropic 2D noise in Q16.16: `x` and `z` are Q16.16 lattice coordinates, the result is in 0..65535 around 32768.
 * Simplex noise (Perlin, "Noise hardware", 2001; Gustavson, "Simplex noise demystified", 2005) in integers: each corner
 * of a triangle adds a radial falloff times its gradient, so no term follows the axes, unlike {@link valueNoise}, whose
 * product of fades draws its level lines as rounded squares round the lattice points. A hashed value joins each
 * gradient so that the level line through the middle does not pin itself to every corner. The coordinates are halved,
 * so the features match a value noise of the same cell size in size and slope.
 */
export function simplexNoise(seed: number, x: number, z: number): number {
  const u = x >> 1,
    v = z >> 1,
    s = Math.floor(((u + v) * SKEW) / ONE),
    i = Math.floor((u + s) / ONE),
    j = Math.floor((v + s) / ONE),
    // Unskew inside the cell: i * UNSKEW would carry the constant's rounding further the larger i gets.
    fx = u + s - i * ONE,
    fz = v + s - j * ONE,
    t = Math.floor(((fx + fz) * UNSKEW) / ONE),
    x0 = fx - t,
    z0 = fz - t,
    up = x0 > z0 ? 1 : 0,
    sum =
      corner(seed, i, j, x0, z0) +
      corner(seed, i + up, j + 1 - up, x0 - up * ONE + UNSKEW, z0 - (1 - up) * ONE + UNSKEW) +
      corner(seed, i + 1, j + 1, x0 - ONE + 2 * UNSKEW, z0 - ONE + 2 * UNSKEW),
    // 33 sets the spread that gives the crest statistics of a value noise, sum * 33 stays below 2^51.
    n = 32768 + Math.floor((sum * 33) / 4294967296);
  return n < 0 ? 0 : n > 65535 ? 65535 : n;
}

/**
 * Ridged fractal noise in Q16.16, 0..65535: `(1 - |2n - 1|)^2` per octave of {@link simplexNoise}, high along sharp
 * crests that run in every direction (each octave's crest is a level line of its noise, so a value noise here draws
 * rounded squares).
 */
export function ridged(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0,
    total = 0,
    amplitude = ONE;
  for (let i = 0; i < octaves; i++) {
    const n = simplexNoise(seed + i * 7919, x, z),
      r = ONE - Math.abs(2 * n - ONE);
    sum += qmul(qmul(r, r), amplitude);
    total += amplitude;
    // Offsets of tens of cells only: a coordinate that wrapped past i32 here would be a straight step in the heights.
    const nx = 2 * x + (z >> 1) + 0x2a4c15,
      nz = 2 * z - (x >> 1) + 0x45f491;
    x = nx | 0;
    z = nz | 0;
    amplitude >>= 1;
  }
  return divWide(sum * 65535, total);
}
