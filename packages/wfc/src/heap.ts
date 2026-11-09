import { prepareGrid } from './grid.js';
import type { CellPosition } from './constraints.js';
import type { Tile, Pin } from './index.js';
import { MargoError } from '@margoengine/math/errors';

/** Options for the local heap solver. Search uses restarts, without global constraints. */
export interface HeapSolveOptions {
  /** Integer seed, default 1. */ seed?: number;
  /** Fixed cells, default empty. */ pins?: readonly Pin[];
  /** Restart budget, 1..64, default 4. */ attempts?: number;
  /** Synchronous cancellation checkpoints, default absent. */ signal?: AbortSignal;
}
/** Backend loading options. */
export interface HeapBackendOptions {
  /** auto uses Wasm SIMD for <=32 unit-weight tiles; otherwise TypeScript. Default auto. */ backend?:
    | 'auto'
    | 'typescript'
    | 'wasm';
  /** Cancels loading, default absent. */ signal?: AbortSignal;
}
type Wasm = {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  release(p: number, n: number): void;
  solve(p: number): number;
};
const help = 'Help: https://margoengine.com/docs/wfc';
const offsets = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const mix = (n: number) => {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
};

/** Local bitset WFC with an indexed minimum-entropy heap; up to 4096 tile IDs. */
export class HeapWFC {
  /** Work counts for the last solve, independent of wall-clock load. */
  readonly stats = { decisions: 0, updates: 0, intersections: 0, attempts: 0 };
  /** Selected implementation. Constructor uses TypeScript; create may load Wasm. */
  backend: 'typescript' | 'wasm' = 'typescript';
  private wasm?: Wasm;
  private readonly dims: CellPosition;
  private readonly tiles: Tile[];
  private readonly weights: number[];
  private readonly equal: boolean;
  /** Snapshot dimensions/rules. Limits match ConstrainedWFC. */
  constructor(dimensions: CellPosition, tiles: readonly Tile[]) {
    const grid = prepareGrid(dimensions, tiles);
    this.dims = grid.dimensions;
    this.tiles = grid.tiles;
    this.weights = this.tiles.map((t) => t.weight!);
    this.equal = this.weights.every((w) => w === this.weights[0]);
  }
  /** Load the measured SIMD implementation lazily when eligible. No loading on import. */
  static async create(
    dimensions: CellPosition,
    tiles: readonly Tile[],
    options: HeapBackendOptions = {},
  ): Promise<HeapWFC> {
    const model = new HeapWFC(dimensions, tiles),
      { backend = 'auto', signal } = options;
    signal?.throwIfAborted();
    if (!['auto', 'typescript', 'wasm'].includes(backend))
      throw new RangeError('Invalid WFC backend; use auto, typescript or wasm');
    const eligible = model.weights.every((w) => w === 1) && tiles.length <= 32;
    if (backend === 'wasm' && !eligible)
      throw new MargoError(
        'unsupported',
        `WFC SIMD needs at most 32 unit-weight tiles; use typescript or auto. ${help}`,
      );
    if (backend === 'typescript' || !eligible) return model;
    const url = new URL('./wfc.wasm?no-inline', import.meta.url);
    let bytes: ArrayBuffer | Uint8Array;
    if (url.protocol === 'file:') {
      const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises');
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError('failed', `WFC SIMD download failed (${response.status}); check the asset URL. ${help}`);
      bytes = await response.arrayBuffer();
    }
    signal?.throwIfAborted();
    if (!WebAssembly.validate(bytes as BufferSource)) {
      if (backend === 'auto') return model;
      throw new MargoError('unsupported', `WFC SIMD unavailable; use the typescript backend. ${help}`);
    }
    const instance = await WebAssembly.instantiate(bytes as BufferSource, {});
    signal?.throwIfAborted();
    model.wasm = instance.instance.exports as unknown as Wasm;
    model.backend = 'wasm';
    return model;
  }
  /** Return X-fastest Uint16 IDs. Fixed heap tie keys are seeded per cell, unlike the legacy scan stream. */
  solve({ seed = 1, pins = [], attempts = 4, signal }: HeapSolveOptions = {}): Uint16Array {
    const [W, H, D] = this.dims,
      C = W * H * D,
      T = this.tiles.length,
      B = Math.ceil(T / 32);
    if (!Number.isSafeInteger(seed) || !Number.isInteger(attempts) || attempts < 1 || attempts > 64)
      throw new RangeError('Invalid heap WFC budget; use an integer seed and 1..64 attempts');
    const fixed = pins.map((p) => {
      if (
        p.position.length !== 3 ||
        p.position.some((v, a) => !Number.isInteger(v) || v < 0 || v >= this.dims[a]) ||
        !Number.isInteger(p.tile) ||
        p.tile < 0 ||
        p.tile >= T
      )
        throw new RangeError('Invalid heap WFC pin; use integer coordinates inside the grid and an existing tile');
      return { cell: p.position[0] + W * (p.position[1] + H * p.position[2]), tile: p.tile };
    });
    signal?.throwIfAborted();
    Object.assign(this.stats, { decisions: 0, updates: 0, intersections: 0, attempts: 0 });
    if (this.wasm) {
      const n = 12 + 8 * T + 2 * fixed.length + C,
        p = this.wasm.alloc(n);
      try {
        const data = new Uint32Array(this.wasm.memory.buffer, p, n);
        data.set([W, H, D, T, seed >>> 0 || 1, attempts, fixed.length, 0, 0, 0, 0, seed >>> 0]);
        for (let t = 0; t < T; t++)
          for (let d = 0; d < 6; d++) for (const u of this.tiles[t].neighbors[d]) data[12 + t * 8 + d] |= 1 << u;
        fixed.forEach((f, i) => data.set([f.cell, f.tile], 12 + 8 * T + 2 * i));
        const ok = this.wasm.solve(p),
          result = new Uint32Array(this.wasm.memory.buffer, p, n);
        Object.assign(this.stats, {
          decisions: result[7],
          updates: result[8],
          intersections: result[9],
          attempts: result[10],
        });
        signal?.throwIfAborted();
        if (ok) return Uint16Array.from(result.subarray(n - C));
      } finally {
        this.wasm.release(p, n);
      }
      throw new MargoError('failed', `Heap WFC exhausted attempts; check pins/rules or raise attempts. ${help}`);
    }
    const allowed = new Uint32Array(T * 6 * B),
      wave = new Uint32Array(C * B),
      counts = new Uint16Array(C),
      keys = new Float64Array(C),
      tie = Uint32Array.from({ length: C }, (_, i) => mix(i ^ (seed >>> 0))),
      position = new Int32Array(C),
      heap: number[] = [],
      queue: number[] = [],
      queued = new Uint8Array(C),
      support = new Uint32Array(6 * B);
    for (let t = 0; t < T; t++)
      for (let d = 0; d < 6; d++)
        for (const u of this.tiles[t].neighbors[d]) allowed[(t * 6 + d) * B + (u >>> 5)] |= 1 << (u & 31);
    const less = (a: number, b: number) =>
      keys[a] < keys[b] || (keys[a] === keys[b] && (tie[a] < tie[b] || (tie[a] === tie[b] && a < b)));
    const swap = (a: number, b: number) => {
      const t = heap[a];
      heap[a] = heap[b];
      heap[b] = t;
      position[heap[a]] = a;
      position[heap[b]] = b;
    };
    const update = (i: number) => {
      this.stats.updates++;
      let key = counts[i] > 1 ? counts[i] : Infinity;
      if (!this.equal && counts[i] > 1) {
        let s = 0,
          l = 0;
        for (let t = 0; t < T; t++)
          if (wave[i * B + (t >>> 5)] & (1 << (t & 31))) {
            s += this.weights[t];
            l += this.weights[t] * Math.log(this.weights[t]);
          }
        key = Math.log(s) - l / s;
      }
      keys[i] = key;
      let p = position[i];
      while (p > 0) {
        const parent = (p - 1) >>> 1;
        if (!less(heap[p], heap[parent])) break;
        swap(p, parent);
        p = parent;
      }
      for (;;) {
        let child = p * 2 + 1;
        if (child >= C) break;
        if (child + 1 < C && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], heap[p])) break;
        swap(p, child);
        p = child;
      }
    };
    const each = (i: number, fn: (t: number) => void) => {
      for (let b = 0; b < B; b++) {
        let bits = wave[i * B + b];
        while (bits) {
          const low = bits & -bits,
            t = b * 32 + 31 - Math.clz32(low);
          fn(t);
          bits = (bits ^ low) >>> 0;
        }
      }
    };
    const enqueue = (i: number) => {
      if (!queued[i]) {
        queued[i] = 1;
        queue.push(i);
      }
    };
    let state = seed >>> 0 || 1;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.stats.attempts = attempt;
      queue.length = 0;
      queued.fill(0);
      counts.fill(T);
      heap.length = 0;
      for (let i = 0; i < C; i++) {
        heap.push(i);
        position[i] = i;
        keys[i] = Infinity;
        for (let b = 0; b < B; b++) wave[i * B + b] = b === B - 1 && T % 32 ? 2 ** (T % 32) - 1 : 0xffffffff;
      }
      for (let i = 0; i < C; i++) {
        update(i);
        enqueue(i);
      }
      let bad = false;
      for (const f of fixed) {
        if (!(wave[f.cell * B + (f.tile >>> 5)] & (1 << (f.tile & 31)))) {
          bad = true;
          break;
        }
        wave.fill(0, f.cell * B, (f.cell + 1) * B);
        wave[f.cell * B + (f.tile >>> 5)] = 1 << (f.tile & 31);
        counts[f.cell] = 1;
        update(f.cell);
      }
      for (;;) {
        while (queue.length && !bad) {
          signal?.throwIfAborted();
          const i = queue.pop()!;
          queued[i] = 0;
          support.fill(0);
          each(i, (t) => {
            for (let j = 0; j < 6 * B; j++) support[j] |= allowed[t * 6 * B + j];
          });
          for (let d = 0; d < 6; d++) {
            const x = (i % W) + offsets[d][0],
              y = (Math.floor(i / W) % H) + offsets[d][1],
              z = Math.floor(i / (W * H)) + offsets[d][2];
            if (x < 0 || x >= W || y < 0 || y >= H || z < 0 || z >= D) continue;
            const j = x + W * (y + H * z);
            let changed = false,
              n = 0;
            for (let b = 0; b < B; b++) {
              const e = j * B + b,
                old = wave[e],
                next = (old & support[d * B + b]) >>> 0;
              this.stats.intersections++;
              if (next !== old) {
                wave[e] = next;
                changed = true;
              }
              let bits = next;
              while (bits) {
                n++;
                bits = (bits & (bits - 1)) >>> 0;
              }
            }
            if (changed) {
              counts[j] = n;
              update(j);
              enqueue(j);
              if (!n) {
                bad = true;
                break;
              }
            }
          }
        }
        if (bad) break;
        const cell = heap[0];
        if (counts[cell] <= 1) {
          const out = new Uint16Array(C);
          for (let i = 0; i < C; i++)
            each(i, (t) => {
              out[i] = t;
            });
          return out;
        }
        let sum = 0;
        each(cell, (t) => {
          sum += this.weights[t];
        });
        let choice = random() * sum,
          tile = -1;
        each(cell, (t) => {
          if (tile < 0) {
            choice -= this.weights[t];
            if (choice <= 0) tile = t;
          }
        });
        if (tile < 0)
          each(cell, (t) => {
            tile = t;
          });
        wave.fill(0, cell * B, (cell + 1) * B);
        wave[cell * B + (tile >>> 5)] = 1 << (tile & 31);
        counts[cell] = 1;
        update(cell);
        enqueue(cell);
        this.stats.decisions++;
      }
    }
    throw new MargoError('failed', `Heap WFC exhausted attempts; check pins/rules or raise attempts. ${help}`);
  }
}
