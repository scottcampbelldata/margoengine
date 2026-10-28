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

/** Ridged fractal noise in Q16.16, 0..65535: `(1 - |2n - 1|)^2` per octave, high along sharp crests. */
export function ridged(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0,
    total = 0,
    amplitude = ONE;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise(seed + i * 7919, x, z),
      r = ONE - Math.abs(2 * n - ONE);
    sum += qmul(qmul(r, r), amplitude);
    total += amplitude;
    const nx = 2 * x + (z >> 1) + 0x7f4a7c15,
      nz = 2 * z - (x >> 1) + 0x2545f491;
    x = nx | 0;
    z = nz | 0;
    amplitude >>= 1;
  }
  return divWide(sum * 65535, total);
}
