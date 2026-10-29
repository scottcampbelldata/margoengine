// Height sources of a biome world, sampled in integer millimetres. Coarse inputs are interpolated with Catmull-Rom
// cubic convolution (Keys, "Cubic convolution interpolation for digital image processing", IEEE TASSP 1981, a = -0.5)
// in Q16 weights, so slope and curvature stay continuous across sample lines and every machine gets the same heights.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { divFloor, ONE } from './fixed.js';
import type { createRelief, Relief, ReliefOptions } from './relief.js';

/**
 * Where a world's heights come from.
 * - `samples`: a heightmap whose corners are the world's corners (`width` x `depth` samples, rows of increasing z),
 *   Int32Array in mm or Float32Array in m (`unit` says otherwise); interpolated with Catmull-Rom between samples.
 * - `field`: a function of world (x, z) in metres returning metres, sampled once per tile and region cell.
 * - `relief`: {@link createRelief} settings (the default: a 4 km seeded landscape), evaluated every 4 m and
 *   interpolated with Catmull-Rom.
 */
export type HeightSource =
  | {
      readonly samples: Int32Array | Float32Array;
      readonly width: number;
      readonly depth: number;
      readonly unit?: 'm' | 'mm';
    }
  | { readonly field: (x: number, z: number) => number }
  | { readonly relief: ReliefOptions };

/** Spacing of the procedural relief lattice, mm. */
const LATTICE = 4000;
const Q32 = 4294967296,
  Q33 = 8589934592;

/** Catmull-Rom weights for a Q16 fraction t, in Q16, summing to exactly 1.0. */
function weights(t: number, out: Int32Array, at: number): void {
  const t2 = t * t, // Q32
    t3 = t2 * t, // Q48, below 2^53
    w0 = Math.floor((-t * Q32 + 2 * t2 * ONE - t3) / Q33),
    w2 = Math.floor((t * Q32 + 4 * t2 * ONE - 3 * t3) / Q33),
    w3 = Math.floor((t3 - t2 * ONE) / Q33);
  out[at] = w0;
  out[at + 1] = ONE - w0 - w2 - w3;
  out[at + 2] = w2;
  out[at + 3] = w3;
}

/**
 * Catmull-Rom resampling of a lattice. `get(i, j)` returns lattice values (any integer index, clamped by the caller);
 * output cell (c, r) lies at lattice position ((x0 + c) * nx / dx, (z0 + r) * nz / dz), written row-major into `out`.
 */
function resample(
  get: ((i: number, j: number) => number) | LatticeFill,
  count: number,
  rows: number,
  x0: number,
  z0: number,
  nx: number,
  dx: number,
  nz: number,
  dz: number,
  out: Int32Array,
): void {
  const ix = new Int32Array(count),
    wx = new Int32Array(count * 4),
    iz = new Int32Array(rows),
    wz = new Int32Array(rows * 4);
  const place = (p: number, num: number, den: number, index: Int32Array, w: Int32Array, k: number) => {
    const scaled = p * num,
      i = divFloor(scaled, den),
      rem = scaled - i * den;
    index[k] = i;
    weights(divFloor(rem * ONE, den), w, k * 4);
  };
  for (let c = 0; c < count; c++) place(x0 + c, nx, dx, ix, wx, c);
  for (let r = 0; r < rows; r++) place(z0 + r, nz, dz, iz, wz, r);
  const lo = ix[0] - 1,
    span = ix[count - 1] + 3 - lo,
    jlo = iz[0] - 1,
    jspan = iz[rows - 1] + 3 - jlo,
    lattice = new Float64Array(span * jspan);
  if (typeof get === 'function')
    for (let j = 0; j < jspan; j++) for (let i = 0; i < span; i++) lattice[j * span + i] = get(lo + i, jlo + j);
  else get.fill(lo, jlo, span, jspan, lattice);
  // Along x for every lattice row, then along z.
  const across = new Float64Array(jspan * count);
  for (let j = 0; j < jspan; j++)
    for (let c = 0; c < count; c++) {
      const base = j * span + ix[c] - 1 - lo,
        k = c * 4;
      across[j * count + c] = Math.floor(
        (wx[k] * lattice[base] +
          wx[k + 1] * lattice[base + 1] +
          wx[k + 2] * lattice[base + 2] +
          wx[k + 3] * lattice[base + 3]) /
          ONE,
      );
    }
  for (let r = 0; r < rows; r++) {
    const k = r * 4,
      base = (iz[r] - 1 - jlo) * count;
    for (let c = 0; c < count; c++)
      out[r * count + c] = Math.floor(
        (wz[k] * across[base + c] +
          wz[k + 1] * across[base + count + c] +
          wz[k + 2] * across[base + 2 * count + c] +
          wz[k + 3] * across[base + 3 * count + c]) /
          ONE,
      );
  }
}

/** Fills `out` (`span` x `rows`, row-major) with lattice values from lattice point (i0, j0). */
interface LatticeFill {
  fill(i0: number, j0: number, span: number, rows: number, out: Float64Array): void;
}

/** Lattice points per side of a cached relief block (64 m at the 4 m lattice), and the most blocks kept (4 MB). */
const BLOCK = 16,
  BLOCKS = 4096;

/**
 * The procedural relief's lattice, cached per world in 16 x 16 blocks: neighbouring tiles (and a tile's apron) read
 * the same lattice points, so each is evaluated once while its block stays cached (oldest blocks go first). The
 * values are those of `at`, so the cache changes no output.
 */
function latticeCache(at: (i: number, j: number) => number): LatticeFill {
  const blocks = new Map<number, Int32Array>(),
    block = (bi: number, bj: number) => {
      // Block indices stay within +-2^15 for every world (64 km at 4 m is 16,384 lattice points, 1,024 blocks).
      const key = (bi + 32768) * 65536 + (bj + 32768);
      let b = blocks.get(key);
      if (b) return b;
      b = new Int32Array(BLOCK * BLOCK);
      for (let j = 0; j < BLOCK; j++)
        for (let i = 0; i < BLOCK; i++) b[j * BLOCK + i] = at(bi * BLOCK + i, bj * BLOCK + j);
      if (blocks.size >= BLOCKS) blocks.delete(blocks.keys().next().value!);
      blocks.set(key, b);
      return b;
    };
  return {
    fill(i0, j0, span, rows, out) {
      for (let bj = Math.floor(j0 / BLOCK); bj * BLOCK < j0 + rows; bj++)
        for (let bi = Math.floor(i0 / BLOCK); bi * BLOCK < i0 + span; bi++) {
          const b = block(bi, bj),
            x0 = Math.max(i0, bi * BLOCK),
            x1 = Math.min(i0 + span, (bi + 1) * BLOCK),
            z0 = Math.max(j0, bj * BLOCK),
            z1 = Math.min(j0 + rows, (bj + 1) * BLOCK);
          for (let j = z0; j < z1; j++)
            for (let i = x0; i < x1; i++)
              out[(j - j0) * span + (i - i0)] = b[(j - bj * BLOCK) * BLOCK + i - bi * BLOCK];
        }
    },
  };
}

/** A world's heights: grids of samples at a given spacing, in mm, positions relative to the world's minimum corner. */
export interface Heights {
  /** Heights of `count` x `rows` cells starting at cell (gx, gz), `step` mm apart. */
  grid(gx: number, gz: number, count: number, rows: number, step: number): Int32Array;
  /** The procedural relief, when the source is one (its rivers are water sources). */
  readonly relief?: Relief;
}

/**
 * Normalises a height source for a world with minimum corner `origin` and extent `size` (both mm).
 * @throws TypeError when the source has the wrong shape; RangeError for bad sizes or samples.
 */
export function heightsOf(
  source: HeightSource | undefined,
  origin: readonly [number, number],
  size: readonly [number, number],
  seed: number,
  relief?: typeof createRelief,
): Heights {
  if (source === undefined || 'relief' in source) {
    if (!relief)
      throw fault(
        'state',
        "A relief height needs the relief entry; pass it to BiomeWorld.create or await import('@margoengine/biomes/relief') first",
        'biomes',
      );
    const made = relief({
      seed,
      origin: [origin[0] / 1000, origin[1] / 1000],
      size: [size[0] / 1000, size[1] / 1000],
      ...(source?.relief ?? {}),
    });
    const at = (i: number, j: number) => made.height(origin[0] + i * LATTICE, origin[1] + j * LATTICE),
      cached = latticeCache(at);
    return {
      relief: made,
      grid(gx, gz, count, rows, step) {
        const out = new Int32Array(count * rows);
        if (step % LATTICE === 0) {
          const k = step / LATTICE;
          for (let r = 0; r < rows; r++)
            for (let c = 0; c < count; c++) out[r * count + c] = at((gx + c) * k, (gz + r) * k);
        } else resample(cached, count, rows, gx, gz, step, LATTICE, step, LATTICE, out);
        return out;
      },
    };
  }
  if (typeof source !== 'object' || source === null)
    throw typeError('A height source is { samples, width, depth }, { field } or { relief }', 'biomes');
  if ('field' in source) {
    const field = source.field;
    if (typeof field !== 'function') throw typeError('A height field must be a function (x, z) => metres', 'biomes');
    return {
      grid(gx, gz, count, rows, step) {
        const out = new Int32Array(count * rows);
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < count; c++) {
            const v = Math.round(
              field((origin[0] + (gx + c) * step) / 1000, (origin[1] + (gz + r) * step) / 1000) * 1000,
            );
            if (!(Math.abs(v) <= 2e9))
              throw rangeError('A height field returned a non-finite or huge value; return metres', 'biomes');
            out[r * count + c] = v;
          }
        return out;
      },
    };
  }
  if (!('samples' in source))
    throw typeError('A height source is { samples, width, depth }, { field } or { relief }', 'biomes');
  const { samples, width, depth } = source,
    unit = source.unit ?? (samples instanceof Int32Array ? 'mm' : 'm');
  if (!(samples instanceof Int32Array || samples instanceof Float32Array))
    throw typeError('Height samples must be an Int32Array (mm) or a Float32Array (m)', 'biomes');
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(depth) ||
    width < 2 ||
    depth < 2 ||
    samples.length !== width * depth
  )
    throw rangeError('Height samples need width and depth of 2 or more and width x depth values', 'biomes');
  if (unit !== 'm' && unit !== 'mm') throw rangeError("Height sample unit must be 'm' or 'mm'", 'biomes');
  const mm = new Int32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = unit === 'mm' ? samples[i] : Math.round(samples[i] * 1000);
    if (!(Math.abs(v) <= 2e9)) throw rangeError(`Height sample ${i} is not finite; fix the input`, 'biomes');
    mm[i] = v;
  }
  // Beyond the edges, extend linearly from the last two samples, so a plane stays a plane (Catmull-Rom then
  // reproduces linear data exactly up to the border).
  const row = (i: number, j: number) => {
    const r = j * width;
    if (i < 0) return mm[r] + i * (mm[r + 1] - mm[r]);
    if (i >= width) return mm[r + width - 1] + (i - width + 1) * (mm[r + width - 1] - mm[r + width - 2]);
    return mm[r + i];
  };
  const at = (i: number, j: number) => {
    if (j < 0) return row(i, 0) + j * (row(i, 1) - row(i, 0));
    if (j >= depth) return row(i, depth - 1) + (j - depth + 1) * (row(i, depth - 1) - row(i, depth - 2));
    return row(i, j);
  };
  return {
    grid(gx, gz, count, rows, step) {
      const out = new Int32Array(count * rows);
      resample(at, count, rows, gx, gz, step * (width - 1), size[0], step * (depth - 1), size[1], out);
      return out;
    },
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
    throw typeError('quantizeHeights needs a Float32Array or Float64Array of heights', 'biomes');
  if (!(unit > 0 && Number.isFinite(unit)))
    throw rangeError('quantizeHeights unit must be a positive number', 'biomes');
  const out = new Int32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * unit * 1000);
    if (!(Math.abs(v) <= 2e9))
      throw rangeError(`Height sample ${i} is not finite or beyond 2,000 km; fix the input`, 'biomes');
    out[i] = v;
  }
  return out;
}
