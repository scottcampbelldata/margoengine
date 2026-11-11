/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/compute/distance: distance fields by jump flooding. Clean room, from the papers only:
// G. Rong and T.-S. Tan, "Jump Flooding in GPU with Applications to Voronoi Diagram and Distance Transform", I3D 2006,
// pp. 109-116 (the algorithm: every pass each cell takes the nearest seed among the cells k away in each direction,
// for k = n/2, n/4, ..., 1); G. Rong and T.-S. Tan, "Variants of Jump Flooding Algorithm for Computing Discrete Voronoi
// Diagrams", ISVD 2007 (1+JFA, JFA+1 and JFA+2: a few more passes remove most of the errors); P. F. Felzenszwalb and
// D. P. Huttenlocher, "Distance Transforms of Sampled Functions", Theory of Computing 8 (2012) 415-428 (the exact
// separable transform behind `distanceTransformExact` and the tests, in packages/shared/distance-exact.js).
// Cells hold the row-major index of their nearest seed, a u32 (NO_SEED when none is known). Squared distances are
// integers in u32 (exact), ties go to the lower index, so every backend produces the same nearest-seed buffer.
import { rangeError, typeError } from '../../shared/errors.js';
import { squaredDistanceTransformNd } from '../../shared/distance-exact.js';
import type { GpuArray } from './array.js';
import { Operand } from './expr.js';
import type { ComputeContext } from './context.js';

/** The nearest-seed value of a cell no seed reached (no seeds at all). */
export const NO_SEED = 0xffffffff;
/** The distance of a cell with no known seed: the largest finite f32, 3.4028234663852886e38. */
export const NO_DISTANCE = 3.4028234663852886e38;

/** The pass lists of the jump flooding variants. `jfa+1` (the default) has the fewest errors per pass spent. */
export type FloodVariant = 'jfa' | '1+jfa' | 'jfa+1' | 'jfa+2';

/** Options for the flood functions. */
export interface FloodOptions {
  /** Pass list: 'jfa' (log2 n passes, the most errors), 'jfa+1' (default), '1+jfa' or 'jfa+2'. */
  readonly variant?: FloodVariant;
  /** Cell size: distances are cell counts times this. Default 1. */
  readonly spacing?: number;
  /** Rejects with the signal's reason before the work is submitted (and, on the CPU backend, while it is read). */
  readonly signal?: AbortSignal;
}

/** Options for `signedDistance`. */
export interface SignedOptions extends FloodOptions {
  /** Where the zero set lies, in cells from a cell centre toward the other side. Default 0.5 (halfway between an inside and an outside cell); 0 measures centre to centre. */
  readonly edge?: number;
}

/** A flooded field: nearest seed and distance per cell. Dispose both arrays (`using` does). */
export interface Flood {
  /** Row-major index of each cell's nearest seed, or NO_SEED. */
  readonly nearest: GpuArray<'u32'>;
  /** Distance to that seed in cells times `spacing`, or NO_DISTANCE. */
  readonly distance: GpuArray<'f32'>;
  /** Number of flood passes run (the seeding and distance passes are not counted). */
  readonly passes: number;
  dispose(): void;
  [Symbol.dispose](): void;
}

const LIMITS = { 2: 4096, 3: 512 } as const;
const fail = (s: string): never => {
  throw rangeError(s, 'compute');
};

/**
 * The step sizes of a variant for an area whose longest side is `longest` cells: n/2, ..., 1 where n is the next power
 * of two, with a 1 first ('1+jfa'), a 1 last ('jfa+1') or a 2 and a 1 last ('jfa+2').
 * @example jumpFloodSteps(8, 'jfa+1') // [4, 2, 1, 1]
 */
export function jumpFloodSteps(longest: number, variant: FloodVariant = 'jfa+1'): number[] {
  if (!Number.isInteger(longest) || longest < 1)
    fail(`Longest side must be a whole number of at least 1, got ${longest}`);
  let n = 1;
  while (n < longest) n *= 2;
  const base: number[] = [];
  for (let s = n / 2; s >= 1; s /= 2) base.push(s);
  if (variant === 'jfa') return base;
  if (variant === '1+jfa') return [1, ...base];
  if (variant === 'jfa+1') return [...base, 1];
  if (variant === 'jfa+2') return [...base, 2, 1];
  return fail(`Unknown flood variant "${String(variant)}"; use jfa, 1+jfa, jfa+1 or jfa+2`);
}

function check(shape: readonly number[], options: FloodOptions, bytesLimit?: number) {
  const rank = shape.length;
  if (rank !== 2 && rank !== 3) fail(`A distance field needs a 2D or 3D shape, got ${rank} dimensions`);
  const cap = LIMITS[rank as 2 | 3];
  for (const d of shape)
    if (!Number.isInteger(d) || d < 2 || d > cap)
      fail(`Distance field sides must be whole numbers from 2 to ${cap} in ${rank}D, got [${shape.join(', ')}]`);
  const cells = shape.reduce((a, b) => a * b, 1);
  if (bytesLimit !== undefined && cells * 4 > bytesLimit)
    fail(
      `A ${shape.join(' x ')} field needs ${cells * 4} bytes per buffer, over this device's storage binding limit of ${bytesLimit}; use fewer cells`,
    );
  const spacing = options.spacing ?? 1;
  if (!(spacing > 0) || !Number.isFinite(spacing)) fail(`Spacing must be a positive finite number, got ${spacing}`);
  const steps = jumpFloodSteps(Math.max(...shape), options.variant);
  return { cells, spacing, steps, dims: [shape[0], shape[1], shape[2] ?? 1] as const };
}

// One shader, four modes: 0 seeds the nearest buffer from the mask (nonzero = seed, flipped by `inv`), 1 is a flood
// pass, 2 writes the distance (f32 bits) and 3 the site id (mask - 1 at the nearest cell) into `out`.
const shader = /* wgsl */ `struct P { w: u32, h: u32, d: u32, step: u32, mode: u32, inv: u32, spacing: f32, pad: u32 }
@group(0) @binding(0) var<storage, read> mask: array<u32>;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32>;
@group(0) @binding(4) var<uniform> p: P;
const NONE = 0xffffffffu;
fn squared(c: u32, x: u32, y: u32, z: u32) -> u32 {
  let cx = i32(c % p.w) - i32(x);
  let cy = i32((c / p.w) % p.h) - i32(y);
  let cz = i32(c / (p.w * p.h)) - i32(z);
  return u32(cx * cx + cy * cy + cz * cz);
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h || id.z >= p.d) { return; }
  let i = (id.z * p.h + id.y) * p.w + id.x;
  if (p.mode == 0u) {
    dst[i] = select(NONE, i, (mask[i] != 0u) != (p.inv == 1u));
  } else if (p.mode == 1u) {
    var best = NONE;
    var bd = NONE;
    let s = i32(p.step);
    let lz = select(0, 1, p.d > 1u);
    for (var oz = -lz; oz <= lz; oz++) {
      let z = i32(id.z) + oz * s;
      if (z < 0 || z >= i32(p.d)) { continue; }
      for (var oy = -1; oy <= 1; oy++) {
        let y = i32(id.y) + oy * s;
        if (y < 0 || y >= i32(p.h)) { continue; }
        for (var ox = -1; ox <= 1; ox++) {
          let x = i32(id.x) + ox * s;
          if (x < 0 || x >= i32(p.w)) { continue; }
          let c = src[(u32(z) * p.h + u32(y)) * p.w + u32(x)];
          if (c == NONE) { continue; }
          let q = squared(c, id.x, id.y, id.z);
          if (q < bd || (q == bd && c < best)) { bd = q; best = c; }
        }
      }
    }
    dst[i] = best;
  } else {
    let c = src[i];
    if (c == NONE) { out[i] = select(NONE, 0x7f7fffffu, p.mode == 2u); }
    else if (p.mode == 3u) { out[i] = mask[c] - 1u; }
    else { out[i] = bitcast<u32>(sqrt(f32(squared(c, id.x, id.y, id.z))) * p.spacing); }
  }
}`;

// The same passes on the host: the CPU backend's path, and the reference the GPU output is compared with in tests.
function floodHost(
  seed: ArrayLike<number>,
  dims: readonly number[],
  steps: readonly number[],
  invert = false,
): Uint32Array {
  const [w, h, d] = dims,
    n = w * h * d;
  let a = new Uint32Array(n).fill(NO_SEED),
    b = new Uint32Array(n);
  for (let i = 0; i < n; i++) if ((seed[i] !== 0) !== invert) a[i] = i;
  const lz = d > 1 ? 1 : 0;
  for (const s of steps) {
    for (let z = 0, i = 0; z < d; z++)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++, i++) {
          let best = NO_SEED,
            bd = NO_SEED;
          for (let oz = -lz; oz <= lz; oz++) {
            const zz = z + oz * s;
            if (zz < 0 || zz >= d) continue;
            for (let oy = -1; oy <= 1; oy++) {
              const yy = y + oy * s;
              if (yy < 0 || yy >= h) continue;
              for (let ox = -1; ox <= 1; ox++) {
                const xx = x + ox * s;
                if (xx < 0 || xx >= w) continue;
                const c = a[(zz * h + yy) * w + xx];
                if (c === NO_SEED) continue;
                const cx = (c % w) - x,
                  cy = (Math.floor(c / w) % h) - y,
                  cz = Math.floor(c / (w * h)) - z,
                  q = cx * cx + cy * cy + cz * cz;
                if (q < bd || (q === bd && c < best)) {
                  bd = q;
                  best = c;
                }
              }
            }
          }
          b[i] = best;
        }
    [a, b] = [b, a];
  }
  return a;
}

interface Run {
  readonly nearest: GpuArray<'u32'>;
  readonly distance: GpuArray<'f32'>;
  readonly ids?: GpuArray<'u32'>;
  readonly passes: number;
}

// Floods a contiguous u32 mask (nonzero = seed, or zero = seed when `invert`); `withIds` also writes mask - 1 at the
// nearest seed per cell (the site index of a Voronoi map).
async function flood(
  ctx: ComputeContext,
  mask: GpuArray<'u32'>,
  shape: readonly number[],
  options: FloodOptions,
  invert: boolean,
  withIds: boolean,
): Promise<Run> {
  ctx.check();
  const gpu = ctx.backend !== 'cpu';
  const { cells, spacing, steps, dims } = check(
    shape,
    options,
    gpu ? Math.min(ctx.device.limits.maxStorageBufferBindingSize, ctx.device.limits.maxBufferSize) : undefined,
  );
  options.signal?.throwIfAborted();
  const distance = ctx.empty([...shape], 'f32'),
    ids = withIds ? ctx.empty([...shape], 'u32') : undefined;
  if (!gpu) {
    const seed = await mask.read({ signal: options.signal });
    const near = floodHost(seed, dims, steps, invert),
      values = new Float32Array(cells),
      sites = new Uint32Array(cells);
    for (let i = 0; i < cells; i++) {
      const c = near[i];
      if (c === NO_SEED) {
        values[i] = NO_DISTANCE;
        sites[i] = NO_SEED;
        continue;
      }
      const cx = (c % dims[0]) - (i % dims[0]),
        cy = (Math.floor(c / dims[0]) % dims[1]) - (Math.floor(i / dims[0]) % dims[1]),
        cz = Math.floor(c / (dims[0] * dims[1])) - Math.floor(i / (dims[0] * dims[1]));
      values[i] = Math.fround(Math.sqrt(cx * cx + cy * cy + cz * cz) * spacing);
      sites[i] = seed[c] - 1;
    }
    distance.write(values);
    ids?.write(sites);
    return { nearest: ctx.array(near, { shape: [...shape], dtype: 'u32' }), distance, ids, passes: steps.length };
  }
  let a = ctx.empty([...shape], 'u32'),
    b = ctx.empty([...shape], 'u32');
  const program = ctx.program(shader, undefined, 'distance.flood');
  const uniform = (step: number, mode: number) => {
    const view = new DataView(new ArrayBuffer(32));
    [dims[0], dims[1], dims[2], step, mode, invert ? 1 : 0].forEach((v, k) => view.setUint32(4 * k, v, true));
    view.setFloat32(24, spacing, true);
    return new Uint8Array(view.buffer);
  };
  const workgroups = [Math.ceil(dims[0] / 8), Math.ceil(dims[1] / 8), dims[2]] as [number, number, number];
  const pass = (src: GpuArray<'u32'>, dst: GpuArray<'u32'>, out: GpuArray, step: number, mode: number) => ({
    program,
    resources: { mask, src, dst, out, p: uniform(step, mode) },
    workgroups,
  });
  const passes = [pass(b, a, distance, 0, 0)];
  for (const s of steps) {
    passes.push(pass(a, b, distance, s, 1));
    [a, b] = [b, a];
  }
  passes.push(pass(a, b, distance, 0, 2));
  if (ids) passes.push(pass(a, b, ids, 0, 3));
  ctx.submit(passes);
  b.dispose();
  return { nearest: a, distance, ids, passes: steps.length };
}

// A contiguous u32 array that is nonzero where `seeds` is; `owned` says the caller must dispose it.
function maskOf(seeds: Operand): { mask: GpuArray<'u32'>; owned: boolean } {
  if (!(seeds instanceof Operand))
    throw typeError('Seeds must be a GpuArray (or an expression) of a 2D or 3D mask', 'compute');
  const array = seeds.eval();
  const direct = array.dtype === 'u32' || array.dtype === 'i32';
  const mask = (direct ? array.ascontiguous() : array.ne(0).astype('u32').eval()) as unknown as GpuArray<'u32'>;
  if (array !== seeds && array !== (mask as unknown)) array.dispose();
  return { mask, owned: (mask as unknown) !== seeds };
}

/**
 * Floods the nearest seed to every cell of a 2D (up to 4096 x 4096) or 3D (up to 512 per side, and as many cells as the
 * device's storage binding allows) mask in log2(longest side) + 1 passes. A cell is a seed when its mask value is not
 * 0. The result holds the row-major index of each cell's nearest seed and the distance to it.
 * @example using f = await jumpFlood(mask); // f.distance is an f32 array shaped like the mask
 */
export async function jumpFlood(seeds: Operand, options: FloodOptions = {}): Promise<Flood> {
  const { mask, owned } = maskOf(seeds);
  try {
    const { nearest, distance, passes } = await flood(seeds.context, mask, seeds.shape, options, false, false);
    const dispose = () => {
      nearest.dispose();
      distance.dispose();
    };
    return { nearest, distance, passes, dispose, [Symbol.dispose]: dispose };
  } finally {
    if (owned) mask.dispose();
  }
}

/** Distance from every cell to the nearest seed cell (nonzero mask value), in cells times `spacing`. */
export async function distanceTransform(seeds: Operand, options: FloodOptions = {}): Promise<GpuArray<'f32'>> {
  const f = await jumpFlood(seeds, options);
  f.nearest.dispose();
  return f.distance;
}

/**
 * Signed distance of a mask: negative inside (nonzero cells), positive outside, the zero set `edge` (default half a
 * cell) from the cell centres. Two floods, one from the inside cells and one from the outside cells.
 */
export async function signedDistance(mask: Operand, options: SignedOptions = {}): Promise<GpuArray<'f32'>> {
  const { mask: m, owned } = maskOf(mask);
  const ctx = mask.context,
    edge = (options.edge ?? 0.5) * (options.spacing ?? 1);
  try {
    const inside = await flood(ctx, m, mask.shape, options, false, false);
    inside.nearest.dispose();
    const outside = await flood(ctx, m, mask.shape, options, true, false);
    outside.nearest.dispose();
    const signed = ctx
      .where(m.ne(0), outside.distance.sub(edge).mul(-1), inside.distance.sub(edge))
      .eval() as GpuArray<'f32'>;
    inside.distance.dispose();
    outside.distance.dispose();
    return signed;
  } finally {
    if (owned) m.dispose();
  }
}

/** A Voronoi map: the nearest site of every cell, and the distance to it. */
export interface VoronoiMap {
  /** Index of each cell's nearest site (its position in the `sites` list), or NO_SEED. */
  readonly id: GpuArray<'u32'>;
  /** Distance to that site's cell in cells times `spacing`, or NO_DISTANCE. */
  readonly distance: GpuArray<'f32'>;
  /** Flood passes run. */
  readonly passes: number;
}

/**
 * Voronoi map of point sites on a 2D or 3D grid of `shape` cells. Sites are flat cell coordinates `[x, y, x, y, ...]`
 * (or x, y, z), rounded to the nearest cell; when two sites share a cell the lower index wins.
 */
export async function voronoiMap(
  ctx: ComputeContext,
  sites: ArrayLike<number>,
  shape: readonly number[],
  options: FloodOptions = {},
): Promise<VoronoiMap> {
  const rank = shape.length;
  check(shape, options);
  if (sites.length % rank !== 0) fail(`Sites need ${rank} coordinates each, got ${sites.length} numbers`);
  const owner = new Uint32Array(shape.reduce((a, b) => a * b, 1));
  for (let k = sites.length / rank - 1; k >= 0; k--) {
    let index = 0;
    for (let axis = rank - 1; axis >= 0; axis--) {
      const c = Math.round(sites[k * rank + axis]);
      if (!(c >= 0 && c < shape[axis])) fail(`Site ${k} is outside the ${shape.join(' x ')} grid`);
      index = index * shape[axis] + c;
    }
    owner[index] = k + 1;
  }
  const mask = ctx.array(owner, { shape: [...shape], dtype: 'u32' });
  try {
    const run = await flood(ctx, mask, shape, options, false, true);
    run.nearest.dispose();
    return { id: run.ids!, distance: run.distance, passes: run.passes };
  } finally {
    mask.dispose();
  }
}

/** Options for `distanceTransformExact`. */
export interface ExactOptions {
  /** Cell size. Default 1. */
  readonly spacing?: number;
  /** Signed: negative inside (nonzero cells), with the zero set `edge` cells from the centres. Default false. */
  readonly signed?: boolean;
  /** As `SignedOptions.edge`. Default 0.5. */
  readonly edge?: number;
}

/**
 * The exact distance transform on the CPU (Felzenszwalb and Huttenlocher, linear time per axis): distance from every cell
 * of a row-major 2D or 3D `mask` (`shape` is [width, height] or [width, height, depth]; nonzero = seed) to the nearest
 * seed. The oracle the flooded results are tested against, and the right tool below a few thousand cells.
 * @example distanceTransformExact(new Uint8Array([1, 0, 0, 0, 0, 0]), [3, 2]) // [0, 1, 2, 1, 1.414, 2.236]
 */
export function distanceTransformExact(
  mask: ArrayLike<number>,
  shape: readonly number[],
  options: ExactOptions = {},
): Float32Array {
  const rank = shape.length;
  if (rank !== 2 && rank !== 3) fail(`A distance field needs a 2D or 3D shape, got ${rank} dimensions`);
  const n = shape.reduce((a, b) => a * b, 1);
  if (shape.some((d) => !Number.isInteger(d) || d < 1) || mask.length !== n)
    fail(`The mask has ${mask.length} cells but shape [${shape.join(', ')}] needs ${n}`);
  const spacing = options.spacing ?? 1;
  if (!(spacing > 0) || !Number.isFinite(spacing)) fail(`Spacing must be a positive finite number, got ${spacing}`);
  const FAR = 1e20;
  const run = (inverted: boolean) => {
    const grid = new Float64Array(n);
    for (let i = 0; i < n; i++) grid[i] = (mask[i] !== 0) !== inverted ? 0 : FAR;
    return squaredDistanceTransformNd(grid, shape);
  };
  const distance = (q: number) => (q >= FAR / 2 ? NO_DISTANCE : Math.sqrt(q) * spacing);
  const toSeeds = run(false),
    out = new Float32Array(n);
  if (!options.signed) {
    for (let i = 0; i < n; i++) out[i] = distance(toSeeds[i]);
    return out;
  }
  const toOutside = run(true),
    edge = (options.edge ?? 0.5) * spacing;
  for (let i = 0; i < n; i++) out[i] = mask[i] !== 0 ? -(distance(toOutside[i]) - edge) : distance(toSeeds[i]) - edge;
  return out;
}
