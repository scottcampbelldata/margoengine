// Seeded CPU noise, no dependencies. Simplex follows Perlin (2001) and Gustavson ("Simplex noise demystified", 2005, with
// the 2012 rank ordering): skew the input onto the simplex lattice, find the containing simplex by ranking the offsets,
// and sum one radial kernel (0.5 - |d|^2)^4 (g . d) per corner. The kernel's squared radius is 0.5 in every dimension, so
// each contribution is zero on the faces of its simplex and the field has no seams (the often used 0.6 in 3D/4D leaves
// small jumps there). Gradients are the 8 compass directions (2D), the 12 cube-edge midpoints (3D) and the 32
// tesseract-edge midpoints (4D), picked by nested lookups in a seeded permutation. `@margoengine/shader/noise` has WGSL
// twins of simplex2/simplex3/perlin and of fbm/ridged/domainWarp.

/** A field of 2, 3 or 4 coordinates; a 2D field ignores `z` and `w`. */
export type NoiseFunction = (x: number, y: number, z?: number, w?: number) => number;
/** Octave sum settings shared by `fbm` and `ridged`. */
export interface FractalOptions {
  /** Octaves summed, 1..16 (default 5). */ octaves?: number;
  /** Frequency multiplier per octave (default 2). */ lacunarity?: number;
  /** Amplitude multiplier per octave (default 0.5). */ gain?: number;
  /** Frequency of the first octave (default 1). */ frequency?: number;
}
/** `domainWarp` settings. */
export interface WarpOptions {
  /** Field displacing each axis (default: the warped field itself). */ warp?: NoiseFunction;
  /** Displacement scale in input units (default 1). */ strength?: number;
  /** Axes displaced, 2..4 (default 3). */ dimensions?: 2 | 3 | 4;
}

// Skew (F) and unskew (G) factors: F = (sqrt(n + 1) - 1) / n, G = (1 - 1 / sqrt(n + 1)) / n.
const F2 = (Math.sqrt(3) - 1) / 2,
  G2 = (3 - Math.sqrt(3)) / 6,
  F3 = 1 / 3,
  G3 = 1 / 6,
  F4 = (Math.sqrt(5) - 1) / 4,
  G4 = (5 - Math.sqrt(5)) / 20;
/** Output scale per dimension (index 2..4), just under 1 / the largest raw value found by sampling and hill-climbing, so |values| < 1. */
export const SIMPLEX_SCALE: readonly number[] = [0, 0, 70, 76, 62];
// 3D gradients by index 0..11: (+-1, +-1, 0), (+-1, 0, +-1), (0, +-1, +-1); bit 0 flips the first non-zero axis, bit 1 the second.
const G3X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0],
  G3Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1],
  G3Z = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
/** Warp sample offsets per axis; the WGSL twin uses the same constants. */
export const WARP_OFFSETS: readonly number[] = [0, 5.2, 1.7, 9.2];
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
function gradient(h: number, x: number, y: number, z: number): number {
  h &= 15;
  const u = h < 8 ? x : y,
    v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}
const coordinates = (x: number, y: number, z = 0, w = 0): void => {
  if (!(Math.abs(x) <= 1e7 && Math.abs(y) <= 1e7 && Math.abs(z) <= 1e7 && Math.abs(w) <= 1e7))
    throw new RangeError('Noise coordinates exceed finite bounds');
};

/** The simplex permutation for `seed`: a xorshift32 Fisher-Yates shuffle of 0..255, stored twice (512 entries) so nested lookups need no wrap. */
export function permutation(seed: number): Uint8Array {
  if (!Number.isSafeInteger(seed)) throw new RangeError('Invalid noise seed');
  let state = seed >>> 0 || 1;
  const p = Uint8Array.from({ length: 512 }, (_, i) => i & 255);
  for (let i = 255; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = Math.floor(((state >>> 0) / 4294967296) * (i + 1)),
      t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  p.copyWithin(256, 0, 256);
  return p;
}
// One corner's kernel times the gradient dot product; zero outside the radius.
function corner2(h: number, x: number, y: number): number {
  let k = 0.5 - x * x - y * y;
  if (k <= 0) return 0;
  k *= k;
  const g = h & 7,
    d = g < 4 ? (g & 1 ? -x : x) + (g & 2 ? -y : y) : g < 6 ? (g & 1 ? -x : x) : g & 1 ? -y : y;
  return k * k * d;
}
// `g` holds the gradient of each permutation slot (3 numbers per slot), so a corner costs one lookup after its hash.
function corner3(g: Float64Array, slot: number, x: number, y: number, z: number): number {
  let k = 0.5 - x * x - y * y - z * z;
  if (k <= 0) return 0;
  k *= k;
  return k * k * (g[slot * 3] * x + g[slot * 3 + 1] * y + g[slot * 3 + 2] * z);
}
function corner4(h: number, x: number, y: number, z: number, w: number): number {
  let k = 0.5 - x * x - y * y - z * z - w * w;
  if (k <= 0) return 0;
  k *= k;
  // Index 0..31: bits 3-4 name the zero axis, bits 0-2 the signs of the other three in axis order.
  const g = h & 31,
    zero = g >> 3,
    a = g & 4 ? -1 : 1,
    b = g & 2 ? -1 : 1,
    c = g & 1 ? -1 : 1;
  return (
    k *
    k *
    (zero === 0
      ? a * y + b * z + c * w
      : zero === 1
        ? a * x + b * z + c * w
        : zero === 2
          ? a * x + b * y + c * w
          : a * x + b * y + c * z)
  );
}

/** Seeded noise: simplex (2D/3D/4D), gradient Perlin and Worley F1. Values are deterministic per seed across runs. */
export class Noise {
  /** The simplex permutation (see `permutation`). */
  readonly perm: Uint8Array;
  private readonly gradients3: Float64Array;
  constructor(readonly seed = 1) {
    const p = (this.perm = permutation(seed));
    this.gradients3 = Float64Array.from(
      { length: 512 * 3 },
      (_, i) => [G3X, G3Y, G3Z][i % 3][p[Math.floor(i / 3)] % 12],
    );
  }
  /** 2D simplex in about [-1, 1]. */
  simplex2(x: number, y: number): number {
    coordinates(x, y);
    const p = this.perm,
      s = (x + y) * F2,
      i = Math.floor(x + s),
      j = Math.floor(y + s),
      t = (i + j) * G2,
      x0 = x - i + t,
      y0 = y - j + t;
    const a = x0 > y0 ? 1 : 0,
      b = 1 - a,
      ii = i & 255,
      jj = j & 255;
    return (
      SIMPLEX_SCALE[2] *
      (corner2(p[ii + p[jj]], x0, y0) +
        corner2(p[ii + a + p[jj + b]], x0 - a + G2, y0 - b + G2) +
        corner2(p[ii + 1 + p[jj + 1]], x0 - 1 + 2 * G2, y0 - 1 + 2 * G2))
    );
  }
  /** 3D simplex in about [-1, 1]. */
  simplex(x: number, y: number, z: number): number {
    coordinates(x, y, z);
    const p = this.perm,
      g = this.gradients3,
      s = (x + y + z) * F3,
      i = Math.floor(x + s),
      j = Math.floor(y + s),
      k = Math.floor(z + s),
      t = (i + j + k) * G3;
    const x0 = x - i + t,
      y0 = y - j + t,
      z0 = z - k + t,
      ii = i & 255,
      jj = j & 255,
      kk = k & 255;
    // Rank of each offset among the three; corner n steps along the axes ranked in the top n.
    let rx = 0,
      ry = 0,
      rz = 0;
    if (x0 > y0) rx++;
    else ry++;
    if (x0 > z0) rx++;
    else rz++;
    if (y0 > z0) ry++;
    else rz++;
    const a1 = +(rx >= 2),
      b1 = +(ry >= 2),
      c1 = +(rz >= 2),
      a2 = +(rx >= 1),
      b2 = +(ry >= 1),
      c2 = +(rz >= 1);
    return (
      SIMPLEX_SCALE[3] *
      (corner3(g, ii + p[jj + p[kk]], x0, y0, z0) +
        corner3(g, ii + a1 + p[jj + b1 + p[kk + c1]], x0 - a1 + G3, y0 - b1 + G3, z0 - c1 + G3) +
        corner3(g, ii + a2 + p[jj + b2 + p[kk + c2]], x0 - a2 + 2 * G3, y0 - b2 + 2 * G3, z0 - c2 + 2 * G3) +
        corner3(g, ii + 1 + p[jj + 1 + p[kk + 1]], x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3))
    );
  }
  /** 4D simplex in about [-1, 1] (e.g. a 3D field animated along `w`). */
  simplex4(x: number, y: number, z: number, w: number): number {
    coordinates(x, y, z, w);
    const p = this.perm,
      s = (x + y + z + w) * F4,
      i = Math.floor(x + s),
      j = Math.floor(y + s),
      k = Math.floor(z + s),
      l = Math.floor(w + s),
      t = (i + j + k + l) * G4;
    const x0 = x - i + t,
      y0 = y - j + t,
      z0 = z - k + t,
      w0 = w - l + t,
      ii = i & 255,
      jj = j & 255,
      kk = k & 255,
      ll = l & 255;
    let rx = 0,
      ry = 0,
      rz = 0,
      rw = 0;
    if (x0 > y0) rx++;
    else ry++;
    if (x0 > z0) rx++;
    else rz++;
    if (x0 > w0) rx++;
    else rw++;
    if (y0 > z0) ry++;
    else rz++;
    if (y0 > w0) ry++;
    else rw++;
    if (z0 > w0) rz++;
    else rw++;
    let sum = 0;
    for (let n = 0; n < 5; n++) {
      const a = +(rx >= 4 - n),
        b = +(ry >= 4 - n),
        c = +(rz >= 4 - n),
        d = +(rw >= 4 - n);
      sum += corner4(
        p[ii + a + p[jj + b + p[kk + c + p[ll + d]]]],
        x0 - a + n * G4,
        y0 - b + n * G4,
        z0 - c + n * G4,
        w0 - d + n * G4,
      );
    }
    return SIMPLEX_SCALE[4] * sum;
  }
  /** 3D gradient (Perlin) noise from an integer hash of the lattice cell; the seed takes effect as an int32. */
  perlin(x: number, y: number, z: number): number {
    coordinates(x, y, z);
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z);
    x -= ix;
    y -= iy;
    z -= iz;
    const u = fade(x),
      v = fade(y),
      w = fade(z);
    let value = 0;
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++)
        for (let c = 0; c < 2; c++)
          value +=
            gradient(hash(ix + a, iy + b, iz + c, this.seed), x - a, y - b, z - c) *
            (a ? u : 1 - u) *
            (b ? v : 1 - v) *
            (c ? w : 1 - w);
    return value;
  }
  /** F1 cellular distance; each integer cell has one seeded feature point. */
  worley(x: number, y: number, z: number): number {
    coordinates(x, y, z);
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z);
    let distance = Infinity;
    for (let a = -2; a <= 2; a++)
      for (let b = -2; b <= 2; b++)
        for (let c = -2; c <= 2; c++) {
          const cx = ix + a,
            cy = iy + b,
            cz = iz + c;
          const dx = cx + hash(cx, cy, cz, this.seed) / 4294967296 - x;
          const dy = cy + hash(cx, cy, cz, this.seed ^ 0x9e3779b9) / 4294967296 - y;
          const dz = cz + hash(cx, cy, cz, this.seed ^ 0x85ebca6b) / 4294967296 - z;
          distance = Math.min(distance, dx * dx + dy * dy + dz * dz);
        }
    return Math.sqrt(distance);
  }
}

function octaves({
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
  frequency = 1,
}: FractalOptions): [number, number, number, number] {
  if (
    !Number.isInteger(octaves) ||
    octaves < 1 ||
    octaves > 16 ||
    ![lacunarity, gain, frequency].every(Number.isFinite)
  )
    throw new RangeError('Invalid fractal options');
  return [octaves, lacunarity, gain, frequency];
}
/** Fractal Brownian motion: octaves of `noise` summed and divided by the total amplitude, so the range stays `noise`'s. */
export function fbm(noise: NoiseFunction, options: FractalOptions = {}): NoiseFunction {
  const [count, lacunarity, gain, frequency] = octaves(options);
  return (x, y, z = 0, w = 0) => {
    let sum = 0,
      total = 0,
      amplitude = 1,
      f = frequency;
    for (let o = 0; o < count; o++) {
      sum += amplitude * noise(x * f, y * f, z * f, w * f);
      total += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }
    return sum / total;
  };
}
/** Ridged multifractal in [0, 1]: octaves of `(1 - |noise|)^2`, sharp crests where `noise` crosses zero (mountain ridges). */
export function ridged(noise: NoiseFunction, options: FractalOptions = {}): NoiseFunction {
  const [count, lacunarity, gain, frequency] = octaves(options);
  return (x, y, z = 0, w = 0) => {
    let sum = 0,
      total = 0,
      amplitude = 1,
      f = frequency;
    for (let o = 0; o < count; o++) {
      const r = 1 - Math.abs(noise(x * f, y * f, z * f, w * f));
      sum += amplitude * r * r;
      total += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }
    return sum / total;
  };
}
/** Domain warping: samples `noise` at `p + strength * (warp(p + o0), warp(p + o1), ...)`, o = `WARP_OFFSETS` on every axis. */
export function domainWarp(
  noise: NoiseFunction,
  { warp = noise, strength = 1, dimensions = 3 }: WarpOptions = {},
): NoiseFunction {
  if (!Number.isFinite(strength) || ![2, 3, 4].includes(dimensions)) throw new RangeError('Invalid warp options');
  return (x, y, z = 0, w = 0) => {
    const at = (o: number) => strength * warp(x + o, y + o, z + o, w + o);
    return noise(
      x + at(WARP_OFFSETS[0]),
      y + at(WARP_OFFSETS[1]),
      dimensions > 2 ? z + at(WARP_OFFSETS[2]) : z,
      dimensions > 3 ? w + at(WARP_OFFSETS[3]) : w,
    );
  };
}
