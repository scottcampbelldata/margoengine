import { GraphModel, gridDimensions, gridIndex, type GraphOptions } from './graph.js';
/** Voxel sample, X fastest then Y then Z; arbitrary finite numerical labels. */
export interface VoxelSample {
  data: ArrayLike<number>;
  width: number;
  height: number;
  depth: number;
}
/** Pattern extraction defaults: N 2, periodic input, identity orientation and no reflections. */
export interface Overlapping3DOptions {
  N?: number;
  periodicInput?: boolean;
  symmetry?: 'none' | 'y' | 'cube';
  reflections?: boolean;
}
/** Pin an original sample value at an output voxel coordinate. */
export interface VoxelPin {
  position: readonly [number, number, number];
  value: number;
}
/** Bounded search defaults: seed 1, four attempts, 10000 backtracks, nonperiodic output and no pins or signal. */
export interface VoxelSolveOptions extends GraphOptions {
  periodic?: boolean;
  pins?: readonly VoxelPin[];
}
const steps = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
/** Learn cubic sample windows and synthesize volumes whose every NxNxN window belongs to the learned set. */
export class Overlapping3DModel {
  /** Number of distinct learned patterns. */
  readonly patterns: number;
  /** Counts from the latest bounded search. */
  readonly stats: { attempts: number; backtracks: number; decisions: number };
  private readonly pixels: number[][] = [];
  private readonly solver: GraphModel;
  private readonly N: number;
  /** At most 1048576 sample voxels and 4096 distinct patterns; N is 2..5. No source data retained. */
  constructor(
    sample: VoxelSample,
    { N = 2, periodicInput = true, symmetry = 'none', reflections = false }: Overlapping3DOptions = {},
  ) {
    const dims = gridDimensions([sample.width, sample.height, sample.depth], 1048576);
    if (
      !Number.isInteger(N) ||
      N < 2 ||
      N > 5 ||
      dims.some((n) => n < N) ||
      sample.data.length !== dims[0] * dims[1] * dims[2] ||
      !['none', 'y', 'cube'].includes(symmetry) ||
      typeof reflections !== 'boolean' ||
      typeof periodicInput !== 'boolean'
    )
      throw new RangeError('Invalid voxel sample; provide N 2..5, dimensions at least N and matching finite data');
    const image = Array.from(sample.data);
    if (image.some((n) => !Number.isFinite(n)))
      throw new RangeError('Invalid voxel value; replace NaN and Infinity with finite labels');
    this.N = N;
    const matrices: number[][] = [];
    for (const permutation of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ])
      for (let mask = 0; mask < 8; mask++) {
        const m = Array(9).fill(0);
        for (let c = 0; c < 3; c++) m[c * 3 + permutation[c]] = mask & (1 << c) ? -1 : 1;
        const det =
          m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
        if (det < 0 && !reflections) continue;
        if (symmetry === 'none' && permutation.some((a, i) => a !== i)) continue;
        if (symmetry === 'none' && mask !== 0 && !(reflections && mask === 1)) continue;
        if (symmetry === 'y' && (m[4] !== 1 || m[1] !== 0 || m[7] !== 0)) continue;
        matrices.push(m);
      }
    const found = new Map<string, number>(),
      weights: number[] = [],
      counts = dims.map((n) => (periodicInput ? n : n - N + 1)),
      center = (N - 1) / 2;
    for (let z = 0; z < counts[2]; z++)
      for (let y = 0; y < counts[1]; y++)
        for (let x = 0; x < counts[0]; x++)
          for (const m of matrices) {
            const p: number[] = [];
            for (let dz = 0; dz < N; dz++)
              for (let dy = 0; dy < N; dy++)
                for (let dx = 0; dx < N; dx++) {
                  const v = [dx - center, dy - center, dz - center],
                    at = [x, y, z].map(
                      (a, r) => (a + center + v[0] * m[r] + v[1] * m[3 + r] + v[2] * m[6 + r]) % dims[r],
                    );
                  p.push(image[at[0] + dims[0] * (at[1] + dims[1] * at[2])]);
                }
            const key = p.join(),
              id = found.get(key);
            if (id === undefined) {
              if (this.pixels.length === 4096)
                throw new RangeError(
                  'Too many voxel patterns; reduce sample complexity, N or symmetry below 4097 patterns',
                );
              found.set(key, this.pixels.length);
              this.pixels.push(p);
              weights.push(1);
            } else weights[id]++;
          }
    this.patterns = this.pixels.length;
    // Hash matching overlap slabs, avoiding a quadratic comparison of every pattern's voxels.
    const keys = this.pixels.map((p) =>
      steps.map((step, d) => {
        const axis = Math.floor(d / 2),
          positive = d % 2 === 0,
          values: number[] = [];
        for (let z = 0; z < N; z++)
          for (let y = 0; y < N; y++)
            for (let x = 0; x < N; x++) {
              const c = [x, y, z][axis];
              if (positive ? c > 0 : c < N - 1) values.push(p[x + N * (y + N * z)]);
            }
        return values.join();
      }),
    );
    const maps = steps.map((_, d) => {
      const map = new Map<string, number[]>();
      keys.forEach((k, i) => {
        const ids = map.get(k[d]) ?? [];
        ids.push(i);
        map.set(k[d], ids);
      });
      return map;
    });
    this.solver = new GraphModel(
      this.pixels.map((_, i) => ({
        weight: weights[i],
        neighbors: steps.map((_, d) => maps[d ^ 1].get(keys[i][d]) ?? []),
      })),
      6,
    );
    this.stats = this.solver.stats;
  }
  /** Return original sample labels, X fastest. Nonperiodic outputs must be at least N on each axis. */
  solve(
    width: number,
    height: number,
    depth: number,
    { periodic = false, pins = [], ...options }: VoxelSolveOptions = {},
  ): Float64Array {
    options.signal?.throwIfAborted();
    const dims = gridDimensions([width, height, depth]),
      N = this.N;
    if (typeof periodic !== 'boolean' || (!periodic && dims.some((n) => n < N)))
      throw new RangeError('Invalid voxel output; nonperiodic dimensions must be at least N');
    const lattice = dims.map((n) => (periodic ? n : n - N + 1)),
      count = lattice[0] * lattice[1] * lattice[2],
      domains = new Map<number, number[]>();
    if (count * this.patterns > 16_777_216)
      throw new RangeError(
        'Voxel output is too large; reduce dimensions or sample complexity below 16777217 cell/pattern pairs',
      );
    const wrap = (n: number, d: number) => ((n % d) + d) % d;
    for (const pin of Array.from(pins)) {
      if (!pin || !Number.isFinite(pin.value))
        throw new RangeError('Invalid voxel pin; provide a finite sample value and output position');
      gridIndex(pin.position, dims);
      for (let z = 0; z < N; z++)
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++) {
            const origin = pin.position.map((n, a) => n - [x, y, z][a]);
            if (!periodic && origin.some((n, a) => n < 0 || n >= lattice[a])) continue;
            const at = origin.map((n, a) => wrap(n, lattice[a])),
              offset = x + N * (y + N * z),
              tiles: number[] = [];
            const cell = at[0] + lattice[0] * (at[1] + lattice[1] * at[2]),
              previous = domains.get(cell);
            if (previous)
              for (const i of previous) {
                if (this.pixels[i][offset] === pin.value) tiles.push(i);
              }
            else
              this.pixels.forEach((p, i) => {
                if (p[offset] === pin.value) tiles.push(i);
              });
            domains.set(cell, tiles);
          }
    }
    const ids = this.solver.solve(
      count,
      (i, d) => {
        const p = [
          i % lattice[0],
          Math.floor(i / lattice[0]) % lattice[1],
          Math.floor(i / (lattice[0] * lattice[1])),
        ].map((v, a) => v + steps[d][a]);
        if (!periodic && p.some((v, a) => v < 0 || v >= lattice[a])) return -1;
        const at = p.map((v, a) => wrap(v, lattice[a]));
        return at[0] + lattice[0] * (at[1] + lattice[1] * at[2]);
      },
      [...domains].map(([cell, tiles]) => ({ cell, tiles })),
      options,
    );
    const out = new Float64Array(width * height * depth);
    for (let z = 0; z < depth; z++)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const p = [x, y, z],
            origin = p.map((n, a) => (periodic ? n : Math.min(n, lattice[a] - 1))),
            local = p.map((n, a) => n - origin[a]);
          out[x + width * (y + height * z)] =
            this.pixels[ids[origin[0] + lattice[0] * (origin[1] + lattice[1] * origin[2])]][
              local[0] + N * (local[1] + N * local[2])
            ];
        }
    return out;
  }
}
