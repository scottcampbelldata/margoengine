// Overlapping (sample-based) 2D Wave Function Collapse: N x N patterns from a sample, seeded observation, and
// chronological backtracking on contradictions under a fixed budget, then seeded restarts.

/** A sample image: `width * height` values (palette indices, packed RGBA, any numbers), row by row. */
export interface Sample {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}
/** Pattern extraction settings. */
export interface OverlappingOptions {
  /** Pattern size, 2..5 (default 3). */ N?: number;
  /** Patterns wrap around the sample edges (default true). */ periodicInput?: boolean;
  /** Rotations and reflections added per pattern, 1..8 (default 8: all of them). */ symmetry?: number;
}
/** `solve` settings. */
export interface OverlappingSolveOptions {
  /** Seed for observation order and pattern choice (default 1). */ seed?: number;
  /** The output wraps around its edges (default false). */ periodic?: boolean;
  /** Backtracks allowed per attempt before restarting, 0..100,000 (default 1000). */ backtracks?: number;
  /** Fresh starts after a failed attempt, 1..64 (default 4). */ attempts?: number;
}
/** What the last `solve` did. */
export interface OverlappingStats {
  backtracks: number;
  attempts: number;
}

const DX = [-1, 0, 1, 0],
  DY = [0, 1, 0, -1];

/** Overlapping-model WFC: outputs whose every N x N window appears in the sample (with the chosen symmetries). */
export class OverlappingModel {
  /** Distinct patterns found. */ readonly patterns: number;
  /** Counts from the last `solve`. */ readonly stats: OverlappingStats = { backtracks: 0, attempts: 0 };
  private readonly N: number;
  private readonly colors: number[];
  private readonly pixels: Uint16Array[];
  private readonly weights: Float64Array;
  private readonly weightLogs: Float64Array;
  private readonly propagator: Int32Array[][];

  constructor(sample: Sample, { N = 3, periodicInput = true, symmetry = 8 }: OverlappingOptions = {}) {
    const { data, width: W, height: H } = sample;
    if (
      !Number.isInteger(N) ||
      N < 2 ||
      N > 5 ||
      !Number.isInteger(symmetry) ||
      symmetry < 1 ||
      symmetry > 8 ||
      !Number.isInteger(W) ||
      !Number.isInteger(H) ||
      W < N ||
      H < N ||
      W * H > 1 << 20 ||
      data.length !== W * H
    )
      throw new RangeError('Invalid WFC sample or pattern options');
    const index = new Map<number, number>(),
      image = Uint16Array.from(data, (v) => {
        if (!Number.isFinite(v)) throw new RangeError('Sample values must be finite');
        let k = index.get(v);
        if (k === undefined) {
          k = index.size;
          if (k > 65535) throw new RangeError('Too many sample colors');
          index.set(v, k);
        }
        return k;
      });
    this.N = N;
    this.colors = [...index.keys()];
    const make = (f: (x: number, y: number) => number) =>
      Uint16Array.from({ length: N * N }, (_, i) => f(i % N, Math.floor(i / N)));
    const found = new Map<string, number>(),
      pixels: Uint16Array[] = [],
      weights: number[] = [];
    for (let y = 0; y < (periodicInput ? H : H - N + 1); y++)
      for (let x = 0; x < (periodicInput ? W : W - N + 1); x++) {
        const variants = [make((dx, dy) => image[((x + dx) % W) + ((y + dy) % H) * W])];
        for (let k = 1; k < symmetry; k++) {
          const p = variants[k & 1 ? k - 1 : k - 2];
          variants.push(k & 1 ? make((dx, dy) => p[N - 1 - dx + dy * N]) : make((dx, dy) => p[N - 1 - dy + dx * N]));
        }
        for (const p of variants) {
          const key = p.join();
          const k = found.get(key);
          if (k === undefined) {
            found.set(key, pixels.length);
            pixels.push(p);
            weights.push(1);
          } else weights[k]++;
        }
      }
    if (pixels.length > 4096) throw new RangeError('Sample has more than 4096 patterns; use a smaller N or sample');
    this.pixels = pixels;
    this.patterns = pixels.length;
    this.weights = Float64Array.from(weights);
    this.weightLogs = this.weights.map((w) => w * Math.log(w));
    const agrees = (a: Uint16Array, b: Uint16Array, dx: number, dy: number) => {
      for (let y = Math.max(0, dy); y < Math.min(N, N + dy); y++)
        for (let x = Math.max(0, dx); x < Math.min(N, N + dx); x++)
          if (a[x + N * y] !== b[x - dx + N * (y - dy)]) return false;
      return true;
    };
    this.propagator = DX.map((dx, d) =>
      pixels.map((a) => Int32Array.from(pixels.flatMap((b, t) => (agrees(a, b, dx, DY[d]) ? [t] : [])))),
    );
  }

  /**
   * Generates a `width * height` image of sample values (X fastest). Contradictions undo the latest choice and forbid it
   * (chronological backtracking); past the backtrack budget the attempt restarts. Throws when every attempt fails.
   */
  solve(
    width: number,
    height: number,
    { seed = 1, periodic = false, backtracks = 1000, attempts = 4 }: OverlappingSolveOptions = {},
  ): Float64Array {
    const N = this.N,
      T = this.patterns,
      FW = periodic ? width : width - N + 1,
      FH = periodic ? height : height - N + 1,
      cells = FW * FH;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      FW < 1 ||
      FH < 1 ||
      cells * T > 1 << 22 ||
      !Number.isSafeInteger(seed) ||
      !Number.isInteger(backtracks) ||
      backtracks < 0 ||
      backtracks > 100_000 ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 64
    )
      throw new RangeError('Invalid WFC output size or solve options');
    const { weights, weightLogs, propagator } = this,
      wave = new Uint8Array(cells * T),
      compatible = new Int32Array(cells * T * 4),
      applied = new Uint8Array(cells * T);
    const counts = new Int32Array(cells),
      sums = new Float64Array(cells),
      logSums = new Float64Array(cells),
      trail: number[] = [],
      stack: number[] = [];
    const decisions: { mark: number; cell: number; pattern: number }[] = [];
    let state = seed >>> 0 || 1,
      contradiction = false;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    const neighbor = (i: number, d: number) => {
      let x = (i % FW) + DX[d],
        y = Math.floor(i / FW) + DY[d];
      if (periodic) {
        x = (x + FW) % FW;
        y = (y + FH) % FH;
      } else if (x < 0 || y < 0 || x >= FW || y >= FH) return -1;
      return x + y * FW;
    };
    const ban = (i: number, t: number) => {
      const e = i * T + t;
      wave[e] = 0;
      trail.push(e);
      stack.push(e);
      sums[i] -= weights[t];
      logSums[i] -= weightLogs[t];
      if (--counts[i] === 0) contradiction = true;
    };
    const propagate = (): boolean => {
      while (stack.length && !contradiction) {
        const e = stack.pop()!,
          i = Math.floor(e / T),
          t = e % T;
        for (let d = 0; d < 4; d++) {
          const j = neighbor(i, d);
          if (j < 0) continue;
          for (const u of propagator[d][t]) if (--compatible[(j * T + u) * 4 + d] === 0 && wave[j * T + u]) ban(j, u);
        }
        applied[e] = 1;
      }
      return !contradiction;
    };
    const undo = (mark: number) => {
      while (trail.length > mark) {
        const e = trail.pop()!,
          i = Math.floor(e / T),
          t = e % T;
        if (applied[e]) {
          for (let d = 0; d < 4; d++) {
            const j = neighbor(i, d);
            if (j >= 0) for (const u of propagator[d][t]) compatible[(j * T + u) * 4 + d]++;
          }
          applied[e] = 0;
        }
        wave[e] = 1;
        counts[i]++;
        sums[i] += weights[t];
        logSums[i] += weightLogs[t];
      }
      stack.length = 0;
      contradiction = false;
    };
    this.stats.backtracks = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.stats.attempts = attempt;
      wave.fill(1);
      applied.fill(0);
      trail.length = stack.length = decisions.length = 0;
      contradiction = false;
      const total = weights.reduce((s, w) => s + w, 0),
        totalLog = weightLogs.reduce((s, w) => s + w, 0);
      counts.fill(T);
      sums.fill(total);
      logSums.fill(totalLog);
      for (let i = 0; i < cells; i++)
        for (let t = 0; t < T; t++)
          for (let d = 0; d < 4; d++) compatible[(i * T + t) * 4 + d] = propagator[(d + 2) % 4][t].length;
      // Patterns with no partner in some direction can never sit next to a neighbour there.
      for (let i = 0; i < cells; i++)
        for (let t = 0; t < T; t++)
          for (let d = 0; d < 4; d++)
            if (!propagator[(d + 2) % 4][t].length && neighbor(i, (d + 2) % 4) >= 0 && wave[i * T + t]) ban(i, t);
      let ok = propagate(),
        used = 0;
      for (;;) {
        if (!ok) {
          // Undo the latest choice and forbid it there; an empty decision stack means this start is unsatisfiable.
          const last = decisions.pop();
          if (!last || used++ >= backtracks) break;
          this.stats.backtracks++;
          undo(last.mark);
          ban(last.cell, last.pattern);
          ok = propagate();
          continue;
        }
        // ponytail: a full entropy scan per choice is O(cells^2); a heap keyed by entropy is the upgrade past ~128 x 128.
        let cell = -1,
          best = Infinity;
        for (let i = 0; i < cells; i++)
          if (counts[i] > 1) {
            const entropy = Math.log(sums[i]) - logSums[i] / sums[i] + 1e-6 * random();
            if (entropy < best) {
              best = entropy;
              cell = i;
            }
          }
        if (cell < 0) return this.render(wave, width, height, FW, periodic);
        let choice = random() * sums[cell],
          pattern = -1;
        for (let t = 0; t < T; t++)
          if (wave[cell * T + t]) {
            pattern = t;
            choice -= weights[t];
            if (choice <= 0) break;
          }
        decisions.push({ mark: trail.length, cell, pattern });
        for (let t = 0; t < T; t++) if (t !== pattern && wave[cell * T + t]) ban(cell, t);
        ok = propagate();
      }
    }
    throw new Error('WFC contradicted within the backtrack and attempt budget');
  }

  private render(wave: Uint8Array, width: number, height: number, FW: number, periodic: boolean): Float64Array {
    const N = this.N,
      T = this.patterns,
      out = new Float64Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        // Non-periodic outputs read the last row/column of cells for the final N - 1 pixels.
        const dx = periodic || x < FW ? 0 : x - FW + 1,
          dy = periodic || y < height - N + 1 ? 0 : y - (height - N + 1) + 1,
          cell = x - dx + (y - dy) * FW;
        let t = 0;
        while (!wave[cell * T + t]) t++;
        out[x + y * width] = this.colors[this.pixels[t][dx + dy * N]];
      }
    return out;
  }
}
