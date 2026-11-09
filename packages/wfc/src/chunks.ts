import { HeapWFC } from './heap.js';
import type { HeapBackendOptions, HeapSolveOptions } from './heap.js';
import type { Tile, Pin } from './index.js';
import type { CellPosition } from './constraints.js';
import { MargoError } from '@margoengine/math/errors';
export { HeapWFC };
export type { HeapBackendOptions, HeapSolveOptions };

/** Chunked local WFC. Previously committed neighbour cells constrain a one-cell halo. */
export class ChunkedWFC {
  private readonly dimensions: CellPosition;
  private readonly tiles: Tile[];
  private readonly chunks = new Map<string, Uint16Array>();
  private busy = false;
  /** Construct a world with fixed chunk dimensions and rules. Seed defaults to 1. */
  constructor(
    dimensions: CellPosition,
    tiles: readonly Tile[],
    private readonly seed = 1,
  ) {
    if (!Number.isSafeInteger(seed)) throw new RangeError('Invalid WFC world seed; use a safe integer');
    new HeapWFC(dimensions.map((n) => n + 2) as unknown as CellPosition, tiles);
    this.dimensions = [...dimensions];
    if (dimensions.length !== 3 || dimensions.some((n) => !Number.isInteger(n) || n < 1))
      throw new RangeError('Invalid WFC chunk; use positive integer dimensions');
    this.tiles = tiles.map((t) => ({ weight: t.weight, neighbors: t.neighbors.map((n) => [...n]) }));
  }
  /** Number of retained chunks. Memory grows with visited coordinates until clear/dispose. */
  get size(): number {
    return this.chunks.size;
  }
  /** Generate or return a copy of a chunk. Serial calls commit atomically; concurrent calls are rejected. */
  async solveChunk(
    coordinate: CellPosition,
    options: HeapBackendOptions & Pick<HeapSolveOptions, 'attempts'> = {},
  ): Promise<Uint16Array> {
    const coord = [...coordinate] as [number, number, number];
    if (
      coord.length !== 3 ||
      coord.some(
        (n, a) =>
          !Number.isSafeInteger(n) ||
          !Number.isSafeInteger(n * this.dimensions[a]) ||
          !Number.isSafeInteger(n * this.dimensions[a] - 1) ||
          !Number.isSafeInteger((n + 1) * this.dimensions[a]),
      )
    )
      throw new RangeError('Invalid WFC chunk coordinate; coordinates and world cell bounds must be safe integers');
    options.signal?.throwIfAborted();
    if (this.busy)
      throw new MargoError(
        'failed',
        `WFC chunk solve already active; await it before solving or clearing. Help: https://margoengine.com/docs/wfc`,
      );
    const key = coord.join(',');
    const cached = this.chunks.get(key);
    if (cached) return cached.slice();
    this.busy = true;
    try {
      const [W, H, D] = this.dimensions,
        [A, B, E] = [W + 2, H + 2, D + 2],
        pins: Pin[] = [];
      // Sample only the surrounding halo, never scan every retained chunk.
      for (let z = -1; z <= D; z++)
        for (let y = -1; y <= H; y++)
          for (let x = -1; x <= W; x++) {
            if (x >= 0 && x < W && y >= 0 && y < H && z >= 0 && z < D) continue;
            const local = [x, y, z],
              owner = local.map((n, a) => coord[a] + Math.floor(n / this.dimensions[a]));
            const previous = this.chunks.get(owner.join(','));
            if (previous) {
              const q = local.map((n, a) => ((n % this.dimensions[a]) + this.dimensions[a]) % this.dimensions[a]);
              pins.push({ position: [x + 1, y + 1, z + 1], tile: previous[q[0] + W * (q[1] + H * q[2])] });
            }
          }
      const model = await HeapWFC.create([A, B, E], this.tiles, options);
      options.signal?.throwIfAborted();
      // Address hashing uses both halves of each integer, including distant and negative coordinates.
      let seed = this.seed >>> 0;
      for (const n of coord) {
        seed = Math.imul(seed ^ (n >>> 0), 16777619);
        seed = Math.imul(seed ^ (Math.floor(n / 4294967296) >>> 0), 16777619);
      }
      const solved = model.solve({ seed, pins, attempts: options.attempts, signal: options.signal }),
        out = new Uint16Array(W * H * D);
      for (let z = 0; z < D; z++)
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) out[x + W * (y + H * z)] = solved[x + 1 + A * (y + 1 + B * (z + 1))];
      options.signal?.throwIfAborted();
      this.chunks.set(key, out);
      return out.slice();
    } finally {
      this.busy = false;
    }
  }
  /** Release saved chunks. Solve order affects new boundaries after clearing. */
  clear(): void {
    if (this.busy)
      throw new MargoError(
        'failed',
        'WFC chunk solve already active; await it before clearing. Help: https://margoengine.com/docs/wfc',
      );
    this.chunks.clear();
  }
  /** Release retained chunk outputs. */
  dispose(): void {
    this.clear();
  }
  /** Explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
