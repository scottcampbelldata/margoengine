import { MargoError } from '@margoengine/math/errors';
/** Internal N-direction reciprocal rule table. */
export interface GraphTile {
  weight?: number;
  neighbors: readonly (readonly number[])[];
}
/** Internal bounded graph search controls. */
export interface GraphOptions {
  seed?: number;
  attempts?: number;
  backtracks?: number;
  signal?: AbortSignal;
}
/** Internal solver stats, reset by every solve. */
export interface GraphStats {
  attempts: number;
  backtracks: number;
  decisions: number;
}
/** Internal generic topology search shared only by optional entries. */
export class GraphModel {
  readonly tiles: GraphTile[];
  readonly weights: Float64Array;
  readonly logs: Float64Array;
  readonly stats: GraphStats = { attempts: 0, backtracks: 0, decisions: 0 };
  constructor(
    tiles: readonly GraphTile[],
    readonly directions: number,
  ) {
    if (!tiles.length || tiles.length > 4096) throw new RangeError('Invalid WFC rules; provide 1..4096 tiles');
    this.tiles = Array.from(tiles, (t) => {
      if (!t || t.neighbors.length !== directions)
        throw new RangeError('Invalid WFC directions; provide a rule list for every face');
      return {
        weight: t.weight ?? 1,
        neighbors: Array.from(t.neighbors, (list) => {
          if (
            !list ||
            Array.from(list).some((id) => !Number.isInteger(id) || id < 0 || id >= tiles.length) ||
            new Set(list).size !== list.length
          )
            throw new RangeError('Invalid WFC adjacency; use distinct existing tile IDs');
          return [...list];
        }),
      };
    });
    this.weights = Float64Array.from(this.tiles, (t) => t.weight!);
    this.logs = this.weights.map((w) => w * Math.log(w));
    if (
      this.weights.some((w) => !Number.isFinite(w) || w <= 0) ||
      !Number.isFinite(this.weights.reduce((a, b) => a + b, 0)) ||
      !Number.isFinite(this.logs.reduce((a, b) => a + b, 0))
    )
      throw new RangeError('Invalid WFC weights; use positive finite weights with finite sums and logarithms');
    const sets = this.tiles.map((t) => t.neighbors.map((list) => new Set(list)));
    this.tiles.forEach((t, i) =>
      t.neighbors.forEach((list, d) => {
        for (const j of list)
          if (!sets[j][d ^ 1].has(i)) throw new RangeError('Nonreciprocal WFC adjacency; add every opposite rule');
      }),
    );
  }
  solve(
    count: number,
    neighbor: (cell: number, direction: number) => number,
    restrictions: readonly { cell: number; tiles: readonly number[] }[],
    { seed = 1, attempts = 4, backtracks = 10000, signal }: GraphOptions = {},
  ): Uint16Array {
    signal?.throwIfAborted();
    const T = this.tiles.length;
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000 || count * T > 16_777_216)
      throw new RangeError('Invalid WFC graph; use at most one million cells and 16777216 cell/tile pairs');
    if (
      !Number.isSafeInteger(seed) ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 64 ||
      !Number.isInteger(backtracks) ||
      backtracks < 0 ||
      backtracks > 100000
    )
      throw new RangeError('Invalid WFC search; use integer seed, 1..64 attempts and 0..100000 backtracks');
    for (const r of restrictions)
      if (
        !r ||
        !Number.isInteger(r.cell) ||
        r.cell < 0 ||
        r.cell >= count ||
        Array.from(r.tiles).some((t) => !Number.isInteger(t) || t < 0 || t >= T)
      )
        throw new RangeError('Invalid WFC restriction; provide an existing cell and tile IDs');
    const wave = new Uint8Array(count * T),
      counts = new Int32Array(count),
      queued = new Uint8Array(count),
      support = new Uint8Array(T),
      trail: number[] = [],
      queue: number[] = [],
      choices: { cell: number; tile: number; mark: number }[] = [];
    let bad = false,
      state = seed >>> 0 || 1;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    const enqueue = (c: number) => {
      if (!queued[c]) {
        queued[c] = 1;
        queue.push(c);
      }
    };
    const ban = (c: number, t: number) => {
      const e = c * T + t;
      if (wave[e]) {
        wave[e] = 0;
        trail.push(e);
        if (--counts[c] === 0) bad = true;
        enqueue(c);
      }
    };
    const restrict = (c: number, ids: readonly number[]) => {
      const allowed = new Set(ids);
      for (let t = 0; t < T; t++) if (!allowed.has(t)) ban(c, t);
    };
    const propagate = () => {
      while (queue.length && !bad) {
        signal?.throwIfAborted();
        const c = queue.pop()!;
        queued[c] = 0;
        for (let d = 0; d < this.directions; d++) {
          const other = neighbor(c, d);
          if (other < 0) continue;
          support.fill(0);
          for (let t = 0; t < T; t++) if (wave[c * T + t]) for (const u of this.tiles[t].neighbors[d]) support[u] = 1;
          for (let t = 0; t < T; t++) if (!support[t]) ban(other, t);
        }
      }
      return !bad;
    };
    this.stats.attempts = this.stats.backtracks = this.stats.decisions = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.stats.attempts = attempt;
      wave.fill(1);
      counts.fill(T);
      queued.fill(0);
      trail.length = queue.length = choices.length = 0;
      bad = false;
      for (let c = 0; c < count; c++) enqueue(c);
      for (const r of restrictions) restrict(r.cell, r.tiles);
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
        signal?.throwIfAborted();
        let cell = -1,
          best = Infinity,
          total = 0;
        for (let c = 0; c < count; c++)
          if (counts[c] > 1) {
            let sum = 0,
              logs = 0;
            for (let t = 0; t < T; t++)
              if (wave[c * T + t]) {
                sum += this.weights[t];
                logs += this.logs[t];
              }
            const entropy = Math.log(sum) - logs / sum + random() * 1e-8;
            if (entropy < best) {
              best = entropy;
              cell = c;
              total = sum;
            }
          }
        if (cell < 0) {
          const result = new Uint16Array(count);
          for (let c = 0; c < count; c++)
            for (let t = 0; t < T; t++)
              if (wave[c * T + t]) {
                result[c] = t;
                break;
              }
          return result;
        }
        let roll = random() * total,
          tile = -1;
        for (let t = 0; t < T; t++)
          if (wave[cell * T + t]) {
            tile = t;
            roll -= this.weights[t];
            if (roll <= 0) break;
          }
        choices.push({ cell, tile, mark: trail.length });
        this.stats.decisions++;
        restrict(cell, [tile]);
        ok = propagate();
      }
    }
    throw new MargoError(
      'failed',
      'WFC exhausted its search budget; check rules and pins or increase attempts/backtracks. Help: https://margoengine.com/docs/wfc',
    );
  }
}
/** Internal dense dimension validation before allocation. */
export function gridDimensions(dimensions: readonly number[], max = 1_000_000): [number, number, number] {
  if (
    dimensions.length !== 3 ||
    Array.from(dimensions).some((n) => !Number.isSafeInteger(n) || n < 1) ||
    !Number.isSafeInteger(dimensions.reduce((a, b) => a * b, 1)) ||
    dimensions.reduce((a, b) => a * b, 1) > max
  )
    throw new RangeError('Invalid WFC dimensions; provide three positive integers within the cell limit');
  return [dimensions[0], dimensions[1], dimensions[2]];
}
/** Internal dense coordinate validation. */
export function gridIndex(position: readonly number[], dimensions: readonly number[]): number {
  if (position.length !== 3 || Array.from(position).some((n, a) => !Number.isInteger(n) || n < 0 || n >= dimensions[a]))
    throw new RangeError('Invalid WFC position; provide three coordinates inside the grid');
  return position[0] + dimensions[0] * (position[1] + dimensions[1] * position[2]);
}
