import { MargoError } from '@margoengine/math/errors';
import type { Pin, Tile } from './index.js';
/** Grid coordinates in X, Y, Z order. */
export type CellPosition = readonly [number, number, number];
/** A bound on the total number of cells using any tile in a group. */
export interface TileCount {
  /** Tile IDs counted as one group, without duplicates. */ readonly tiles: readonly number[];
  /** Inclusive minimum, default 0. */ readonly min?: number;
  /** Inclusive maximum, default cell count. */ readonly max?: number;
}
/** A six-neighbour path whose cells all use tiles from the given group. */
export interface TilePath {
  /** First cell; forced to the path's tile group. */ readonly from: CellPosition;
  /** Last cell; forced to the path's tile group. */ readonly to: CellPosition;
  /** Walkable tile IDs. */ readonly tiles: readonly number[];
}
/** Global constraints, combined with reciprocal local adjacency. */
export interface GlobalConstraints {
  /** All cells using these tiles must form one nonempty six-neighbour component. Default absent. */
  readonly connected?: readonly number[];
  /** Required paths. Default none. */ readonly paths?: readonly TilePath[];
  /** Tile-group count bounds. Default none. */ readonly counts?: readonly TileCount[];
}
/** Bounded backtracking search options. */
export interface ConstrainedSolveOptions {
  /** Integer seed, default 1. */ seed?: number;
  /** Fixed tile cells, default none. */ pins?: readonly Pin[];
  /** Backtrack budget per attempt, 0..100,000, default 10,000. */ backtracks?: number;
  /** Attempts, 1..64, default 4. */ attempts?: number;
  /** Synchronous cancellation checkpoints, default absent. */ signal?: AbortSignal;
}
const offsets = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;
const help = 'Help: https://margoengine.com/docs/wfc';
/** CPU WFC with domain propagation, count bounds, reachability pruning and bounded chronological backtracking. */
export class ConstrainedWFC {
  /** Copied grid dimensions. */ readonly dimensions: CellPosition;
  /** Counts from the latest solve. */ readonly stats = { attempts: 0, backtracks: 0, decisions: 0 };
  private readonly tiles: readonly Tile[];
  private readonly weights: Float64Array;
  private readonly logs: Float64Array;
  private readonly size: number;
  private readonly connected?: readonly number[];
  private readonly paths: { from: number; to: number; tiles: readonly number[] }[];
  private readonly limits: { tiles: readonly number[]; min: number; max: number }[];
  /** Dimensions: positive integers, at most 1,000,000 cells and 16,777,216 cell/tile pairs. Tiles: 1..4096. */
  constructor(dimensions: CellPosition, tiles: readonly Tile[], constraints: GlobalConstraints = {}) {
    const size = dimensions[0] * dimensions[1] * dimensions[2];
    if (
      dimensions.length !== 3 ||
      dimensions.some((n) => !Number.isInteger(n) || n < 1) ||
      size > 1_000_000 ||
      tiles.length < 1 ||
      tiles.length > 4096 ||
      size * tiles.length > 16_777_216
    )
      throw new RangeError(
        'Invalid constrained WFC grid; use 1..4096 tiles, positive dimensions and at most 16,777,216 cell/tile pairs',
      );
    this.dimensions = [...dimensions];
    this.size = size;
    this.weights = Float64Array.from(tiles, (t) => t.weight ?? 1);
    this.logs = this.weights.map((w) => w * Math.log(w));
    if (
      this.weights.some((w) => !Number.isFinite(w) || w <= 0) ||
      !Number.isFinite(this.weights.reduce((a, b) => a + b, 0)) ||
      !Number.isFinite(this.logs.reduce((a, b) => a + b, 0))
    )
      throw new RangeError(
        'Invalid WFC weights; use positive finite weights whose sum and weighted logarithms stay finite',
      );
    this.tiles = tiles.map((tile, t) => {
      if (tile.neighbors.length !== 6)
        throw new TypeError('Invalid WFC adjacency; give each tile exactly six neighbour lists');
      return {
        weight: this.weights[t],
        neighbors: tile.neighbors.map((list, d) => {
          for (const u of list)
            if (!Number.isInteger(u) || u < 0 || u >= tiles.length || !tiles[u].neighbors[d ^ 1]?.includes(t))
              throw new RangeError('Invalid WFC adjacency; use existing tile IDs and reciprocal opposite directions');
          return [...new Set(list)];
        }),
      };
    });
    const group = (ids: readonly number[]) => {
      if (
        !ids.length ||
        ids.some((t) => !Number.isInteger(t) || t < 0 || t >= tiles.length) ||
        new Set(ids).size !== ids.length
      )
        throw new RangeError('Invalid WFC tile group; use a nonempty list of distinct existing tile IDs');
      return [...ids];
    };
    this.connected = constraints.connected && group(constraints.connected);
    this.paths = (constraints.paths ?? []).map((p) => ({
      from: this.index(p.from),
      to: this.index(p.to),
      tiles: group(p.tiles),
    }));
    this.limits = (constraints.counts ?? []).map((c) => {
      const min = c.min ?? 0,
        max = c.max ?? size;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > size)
        throw new RangeError('Invalid WFC count bound; use integers with 0 <= min <= max <= cell count');
      return { tiles: group(c.tiles), min, max };
    });
  }
  private index(position: CellPosition): number {
    if (position.length !== 3 || position.some((v, a) => !Number.isInteger(v) || v < 0 || v >= this.dimensions[a]))
      throw new RangeError('Invalid WFC position; use three integer coordinates inside the grid');
    return position[0] + this.dimensions[0] * (position[1] + this.dimensions[1] * position[2]);
  }
  /** Return Uint16 tile IDs, X fastest. A returned solution satisfies every local and global constraint. */
  solve({ seed = 1, pins = [], backtracks = 10_000, attempts = 4, signal }: ConstrainedSolveOptions = {}): Uint16Array {
    if (
      !Number.isSafeInteger(seed) ||
      !Number.isInteger(backtracks) ||
      backtracks < 0 ||
      backtracks > 100_000 ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 64
    )
      throw new RangeError('Invalid WFC search budget; use an integer seed, 0..100,000 backtracks and 1..64 attempts');
    const T = this.tiles.length,
      C = this.size,
      [W, H, D] = this.dimensions;
    const fixed = pins.map((pin) => {
      if (!Number.isInteger(pin.tile) || pin.tile < 0 || pin.tile >= T)
        throw new RangeError('Invalid WFC pin tile; use an existing tile ID');
      return { cell: this.index(pin.position), tile: pin.tile };
    });
    signal?.throwIfAborted();
    const wave = new Uint8Array(C * T),
      counts = new Int32Array(C),
      trail: number[] = [],
      queue: number[] = [],
      queued = new Uint8Array(C);
    const support = new Uint8Array(T),
      possible = new Uint8Array(C),
      forced = new Uint8Array(C),
      seen = new Uint8Array(C),
      bfs = new Int32Array(C);
    const choices: { mark: number; cell: number; tile: number }[] = [];
    let state = seed >>> 0 || 1,
      bad = false;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    const neighbor = (i: number, d: number) => {
      const x = (i % W) + offsets[d][0],
        y = (Math.floor(i / W) % H) + offsets[d][1],
        z = Math.floor(i / (W * H)) + offsets[d][2];
      return x < 0 || x >= W || y < 0 || y >= H || z < 0 || z >= D ? -1 : x + W * (y + H * z);
    };
    const enqueue = (i: number) => {
      if (!queued[i]) {
        queued[i] = 1;
        queue.push(i);
      }
    };
    const ban = (i: number, t: number) => {
      const e = i * T + t;
      if (!wave[e]) return;
      wave[e] = 0;
      trail.push(e);
      if (--counts[i] === 0) bad = true;
      enqueue(i);
    };
    const restrict = (i: number, group: readonly number[], inside: boolean) => {
      for (let t = 0; t < T; t++) if (group.includes(t) !== inside) ban(i, t);
    };
    // Potential connectivity is a necessary condition during search and exact at singleton domains.
    const reach = (group: readonly number[], from?: number, to?: number) => {
      let start = from ?? -1,
        required = false;
      for (let i = 0; i < C; i++) {
        let n = 0;
        for (const t of group) n += wave[i * T + t];
        possible[i] = n > 0 ? 1 : 0;
        forced[i] = n === counts[i] ? 1 : 0;
        if (from === undefined && (start < 0 || (!required && forced[i]))) start = possible[i] ? i : start;
        if (forced[i]) required = true;
      }
      if (start < 0 || !possible[start]) {
        bad = true;
        return;
      }
      seen.fill(0);
      seen[start] = 1;
      bfs[0] = start;
      let head = 0,
        tail = 1;
      while (head < tail) {
        const i = bfs[head++];
        for (let d = 0; d < 6; d++) {
          const j = neighbor(i, d);
          if (j >= 0 && possible[j] && !seen[j]) {
            seen[j] = 1;
            bfs[tail++] = j;
          }
        }
      }
      if (to !== undefined) {
        if (!seen[to]) bad = true;
        return;
      }
      if (required)
        for (let i = 0; i < C; i++)
          if (!seen[i]) {
            if (forced[i]) {
              bad = true;
              return;
            }
            for (const t of group) ban(i, t);
          }
    };
    const propagate = () => {
      for (;;) {
        signal?.throwIfAborted();
        while (queue.length && !bad) {
          const i = queue.pop()!;
          queued[i] = 0;
          for (let d = 0; d < 6; d++) {
            const j = neighbor(i, d);
            if (j < 0) continue;
            support.fill(0);
            for (let t = 0; t < T; t++) if (wave[i * T + t]) for (const u of this.tiles[t].neighbors[d]) support[u] = 1;
            for (let u = 0; u < T; u++) if (!support[u]) ban(j, u);
          }
        }
        if (bad) return false;
        for (const limit of this.limits) {
          let lower = 0,
            upper = 0;
          for (let i = 0; i < C; i++) {
            let n = 0;
            for (const t of limit.tiles) n += wave[i * T + t];
            possible[i] = n > 0 ? 1 : 0;
            forced[i] = n === counts[i] ? 1 : 0;
            lower += forced[i];
            upper += possible[i];
          }
          if (lower > limit.max || upper < limit.min) {
            bad = true;
            return false;
          }
          if (lower === limit.max || upper === limit.min)
            for (let i = 0; i < C; i++) if (possible[i] && !forced[i]) restrict(i, limit.tiles, upper === limit.min);
        }
        if (this.connected) reach(this.connected);
        for (const path of this.paths) reach(path.tiles, path.from, path.to);
        if (bad) return false;
        if (!queue.length) return true;
      }
    };
    this.stats.attempts = this.stats.backtracks = this.stats.decisions = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.stats.attempts = attempt;
      bad = false;
      wave.fill(1);
      counts.fill(T);
      queued.fill(0);
      trail.length = queue.length = choices.length = 0;
      for (let i = 0; i < C; i++) enqueue(i);
      for (const pin of fixed) restrict(pin.cell, [pin.tile], true);
      for (const path of this.paths) {
        restrict(path.from, path.tiles, true);
        restrict(path.to, path.tiles, true);
      }
      let ok = propagate(),
        used = 0;
      for (;;) {
        if (!ok) {
          const last = choices.pop();
          if (!last || used++ >= backtracks) break;
          this.stats.backtracks++;
          while (trail.length > last.mark) {
            const e = trail.pop()!;
            wave[e] = 1;
            counts[Math.floor(e / T)]++;
          }
          queue.length = 0;
          queued.fill(0);
          bad = false;
          ban(last.cell, last.tile);
          ok = propagate();
          continue;
        }
        let cell = -1,
          best = Infinity,
          sum = 0;
        for (let i = 0; i < C; i++)
          if (counts[i] > 1) {
            let s = 0,
              l = 0;
            for (let t = 0; t < T; t++)
              if (wave[i * T + t]) {
                s += this.weights[t];
                l += this.logs[t];
              }
            const entropy = Math.log(s) - l / s + random() * 1e-8;
            if (entropy < best) {
              best = entropy;
              cell = i;
              sum = s;
            }
          }
        if (cell < 0) {
          const out = new Uint16Array(C);
          for (let i = 0; i < C; i++)
            for (let t = 0; t < T; t++)
              if (wave[i * T + t]) {
                out[i] = t;
                break;
              }
          return out;
        }
        let choice = random() * sum,
          tile = -1;
        for (let t = 0; t < T; t++)
          if (wave[cell * T + t]) {
            tile = t;
            choice -= this.weights[t];
            if (choice <= 0) break;
          }
        this.stats.decisions++;
        choices.push({ mark: trail.length, cell, tile });
        restrict(cell, [tile], true);
        ok = propagate();
      }
    }
    throw new MargoError(
      'failed',
      `WFC exhausted its search budget; check global constraints or raise backtracks/attempts. ${help}`,
    );
  }
}
