// A seeded procedural landscape in integer millimetres: fractal lowlands, ridged mountains under a mountain mask, an
// optional coast and river valleys. It is the default height of a BiomeWorld and the terrain of the reference world
// R16. Every step works on integers below 2^53 with plain arithmetic, floors and integer square roots (value noise from
// hash.ts), which every JavaScript engine computes identically, so the same options give the same heights everywhere. Our own layout; the noise is cited in hash.ts.
import { clampInt, divFloor, divWide, isqrt, ONE } from './fixed.js';
import { fbm, hash3, ridged } from './hash.js';

/** Settings of {@link createRelief}. Lengths in metres; every option is quantised once to millimetres. */
export interface ReliefOptions {
  /** u32 seed. Default 1. */
  readonly seed?: number;
  /** World XZ of the minimum corner in metres. Default: centred on the origin, `-size / 2`. */
  readonly origin?: readonly [number, number];
  /** World extent [x, z] in metres, each 64..65,536. Default [4096, 4096]. */
  readonly size?: readonly [number, number];
  /** Mean lowland height in metres. Default 120. */
  readonly base?: number;
  /** Height of the highest ridges above the lowland in metres, 0..8,000. Default 900. */
  readonly relief?: number;
  /** Side of the world that runs down into the sea, or `'none'`. Default `'none'`. */
  readonly coast?: 'none' | 'west' | 'east' | 'north' | 'south';
  /** River valleys running across the world toward the coast (or west to east without one), 0..8. Default 0. */
  readonly rivers?: number;
  /** Sea floor depth below sea level (0 m) off the coast in metres. Default 40. */
  readonly seaDepth?: number;
}

/** A river centre line in millimetres, `[x0, z0, x1, z1, ...]`, from its mouth upstream. */
export type RiverLine = Int32Array;

/** A procedural landscape: integer heights and the centre lines of its rivers. */
export interface Relief {
  /** Height in millimetres at world `(x, z)` given in millimetres (integers). */
  height(x: number, z: number): number;
  /** River centre lines in millimetres, mouth first. */
  readonly rivers: readonly RiverLine[];
  /** River valley half width in millimetres. */
  readonly valleyWidth: number;
  /** The options, with defaults filled in and every length in millimetres. */
  readonly settings: Readonly<{
    seed: number;
    origin: readonly [number, number];
    size: readonly [number, number];
    base: number;
    relief: number;
    coast: NonNullable<ReliefOptions['coast']>;
    seaDepth: number;
  }>;
}

const mm = (m: number) => Math.round(m * 1000);
const COASTS = ['none', 'west', 'east', 'north', 'south'];
// Coast shelf width and river valley half width in mm.
const SHELF = 1_500_000,
  VALLEY = 250_000;

/**
 * Builds a seeded procedural landscape. Lowlands are 7 octaves of value noise at 2 km, mountains 6 octaves of ridged
 * noise at 1.5 km under a 6 km mask, the coast a noise-warped 1.5 km shelf down to `seaDepth`, and each river a
 * meandering polyline whose valley (250 m half width) is carved down to a bed that rises from 2 m at the mouth.
 * @throws TypeError when `options` is not an object; RangeError when a value is out of range.
 * @example
 * const relief = createRelief({ seed: 7, coast: 'west', rivers: 1 });
 * const metres = relief.height(0, 0) / 1000;
 */
export function createRelief(options: ReliefOptions = {}): Relief {
  if (typeof options !== 'object' || options === null)
    throw new TypeError('Relief options must be an object; pass {} for the defaults');
  const seed = (options.seed ?? 1) >>> 0,
    size = options.size ?? [4096, 4096],
    origin = options.origin ?? [-size[0] / 2, -size[1] / 2],
    base = options.base ?? 120,
    relief = options.relief ?? 900,
    coast = options.coast ?? 'none',
    count = options.rivers ?? 0,
    seaDepth = options.seaDepth ?? 40;
  if (
    !Array.isArray(size) ||
    !Array.isArray(origin) ||
    size.length !== 2 ||
    origin.length !== 2 ||
    !size.every((v) => v >= 64 && v <= 65536) ||
    !origin.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e6) ||
    !(Math.abs(base) <= 8000) ||
    !(relief >= 0 && relief <= 8000) ||
    !(seaDepth >= 0 && seaDepth <= 8000) ||
    !COASTS.includes(coast) ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > 8
  )
    throw new RangeError(
      'Invalid relief options; size 64..65,536 m, origin within 1,000 km, base within 8 km, relief and seaDepth 0..8,000 m, coast none/west/east/north/south and 0..8 rivers',
    );
  const ox = mm(origin[0]),
    oz = mm(origin[1]),
    sx = mm(size[0]),
    sz = mm(size[1]),
    baseMm = mm(base),
    reliefMm = mm(relief),
    sea = mm(seaDepth);
  // Coast frame: distance inland from the coast edge (u) and position along it (v), both in mm.
  const frame = (x: number, z: number): [number, number] =>
    coast === 'west'
      ? [x - ox, z - oz]
      : coast === 'east'
        ? [ox + sx - x, z - oz]
        : coast === 'north'
          ? [z - oz, x - ox]
          : [oz + sz - z, x - ox];
  const along = coast === 'north' || coast === 'south' ? sx : sz,
    across = coast === 'north' || coast === 'south' ? sz : sx;
  // Rivers: mouth at the coast (or the low-x edge), 8 segments inland, meandering by hashed offsets.
  const rivers: Int32Array[] = [];
  for (let r = 0; r < count; r++) {
    const line = new Int32Array(18);
    let v = divFloor(along * (2 * r + 1), 2 * count);
    for (let k = 0; k <= 8; k++) {
      const u = Math.floor((across * k) / 9) + (k === 0 ? Math.floor(SHELF / 3) : 0);
      if (k) v += Math.floor(((hash3(seed, r, k) >>> 16) - 32768) * Math.floor(along / 14 / 32768));
      v = clampInt(v, Math.floor(along / 16), along - Math.floor(along / 16));
      // Back to world coordinates.
      const [x, z] =
        coast === 'east'
          ? [ox + sx - u, oz + v]
          : coast === 'north'
            ? [ox + v, oz + u]
            : coast === 'south'
              ? [ox + v, oz + sz - u]
              : [ox + u, oz + v];
      line[2 * k] = x;
      line[2 * k + 1] = z;
    }
    rivers.push(line);
  }
  // Lattice coordinates: Q16 cells of `wavelength` mm.
  const lattice = (p: number, wavelength: number) => divFloor(p * ONE, wavelength);
  const height = (x: number, z: number): number => {
    const lowland = fbm(seed, lattice(x, 2_048_000), lattice(z, 2_048_000), 7),
      mask = fbm(seed + 1, lattice(x, 6_000_000), lattice(z, 6_000_000), 3),
      // Mountains where the mask passes 0.45, full height from 0.7.
      m = clampInt(Math.floor(((mask - 29491) * ONE) / 16384), 0, ONE),
      ridge = ridged(seed + 2, lattice(x, 1_500_000), lattice(z, 1_500_000), 6);
    let h =
      baseMm +
      Math.floor(((lowland - 32768) * 220_000) / 32768) +
      Math.floor((Math.floor((ridge * m) / ONE) * reliefMm) / ONE);
    if (coast !== 'none') {
      const [u, v] = frame(x, z),
        warp = Math.floor(((fbm(seed + 3, lattice(v, 3_000_000), 0, 3) - 32768) * 600_000) / 32768),
        d = u - warp;
      if (d < SHELF) {
        // Smoothstep from the sea floor at the edge to the land height at the shelf's inner end.
        const t = clampInt(Math.floor((d * ONE) / SHELF), 0, ONE),
          s = Math.floor((t * t * (3 * ONE - 2 * t)) / 4294967296);
        h = -sea + Math.floor(((h + sea) * s) / ONE);
      }
    }
    for (let r = 0; r < rivers.length; r++) {
      const line = rivers[r];
      let best = Infinity,
        bestK = 0;
      // In units of 64 mm, so every product stays below 2^53.
      for (let k = 0; k < 8; k++) {
        const ax = line[2 * k] >> 6,
          az = line[2 * k + 1] >> 6,
          bx = (line[2 * k + 2] >> 6) - ax,
          bz = (line[2 * k + 3] >> 6) - az,
          px = (x >> 6) - ax,
          pz = (z >> 6) - az,
          len = bx * bx + bz * bz,
          dot = px * bx + pz * bz,
          t = dot <= 0 || !len ? 0 : dot >= len ? 1024 : divWide(dot * 1024, len),
          dx = px - Math.floor((bx * t) / 1024),
          dz = pz - Math.floor((bz * t) / 1024),
          d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          bestK = k * 1024 + t;
        }
      }
      if (best < (VALLEY >> 6) * (VALLEY >> 6)) {
        const d = isqrt(best) * 64,
          bed = 2000 + Math.floor((bestK * 40_000) / 8192),
          t = Math.floor((d * ONE) / VALLEY),
          s = Math.floor((t * t * (3 * ONE - 2 * t)) / 4294967296);
        if (h > bed) h = bed + Math.floor(((h - bed) * s) / ONE);
      }
    }
    return h;
  };
  return {
    height,
    rivers,
    valleyWidth: VALLEY,
    settings: Object.freeze({
      seed,
      origin: [ox, oz] as const,
      size: [sx, sz] as const,
      base: baseMm,
      relief: reliefMm,
      coast,
      seaDepth: sea,
    }),
  };
}

/**
 * Quantises float heights once to integer millimetres (`Math.round(h * 1000 / unit)` per sample, plain arithmetic, so
 * every engine rounds the same way). `unit` is metres per input unit, default 1.
 * @throws TypeError when `samples` is not a Float32Array or Float64Array; RangeError for a non-finite or out-of-range
 * sample (beyond +-2,000 km).
 */
export function quantizeHeights(samples: Float32Array | Float64Array, unit = 1): Int32Array {
  if (!(samples instanceof Float32Array || samples instanceof Float64Array))
    throw new TypeError('quantizeHeights needs a Float32Array or Float64Array of heights');
  if (!(unit > 0 && Number.isFinite(unit))) throw new RangeError('quantizeHeights unit must be a positive number');
  const out = new Int32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * unit * 1000);
    if (!(Math.abs(v) <= 2e9))
      throw new RangeError(`Height sample ${i} is not finite or beyond 2,000 km; fix the input`);
    out[i] = v;
  }
  return out;
}
