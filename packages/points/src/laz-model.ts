// The adaptive models, the running median and the return tables that LAZ's decoder (laz.ts) and writer (laz-write.ts)
// share: both must adapt in step, so they are one copy. Clean room, from the sources laz.ts names.

/** A coder renormalises when its interval's length falls below this. */
export const MIN_LENGTH = 0x01000000;
/** Probabilities take 13 bits for a bit model and 15 for a symbol model. */
export const BIT_SHIFT = 13,
  SYMBOL_SHIFT = 15;
const BIT_MAX = 1 << BIT_SHIFT,
  SYMBOL_MAX = 1 << SYMBOL_SHIFT;

/** An adaptive binary model. */
export class BitModel {
  prob = 0;
  zeros = 0;
  total = 0;
  cycle = 0;
  until = 0;
  constructor() {
    this.reset();
  }
  reset() {
    this.zeros = 1;
    this.total = 2;
    this.prob = 1 << (BIT_SHIFT - 1);
    this.cycle = this.until = 4;
  }
  update() {
    if ((this.total += this.cycle) > BIT_MAX) {
      this.total = (this.total + 1) >>> 1;
      this.zeros = (this.zeros + 1) >>> 1;
      if (this.zeros === this.total) this.total++;
    }
    const scale = Math.floor(0x80000000 / this.total);
    this.prob = Math.floor((this.zeros * scale) / 2 ** (31 - BIT_SHIFT));
    this.cycle = Math.min((5 * this.cycle) >>> 2, 64);
    this.until = this.cycle;
  }
}

/** An adaptive model of `symbols` symbols, with a lookup table to start the search when there are more than 16. */
export class SymbolModel {
  readonly symbols: number;
  readonly last: number;
  readonly dist: Uint32Array;
  readonly counts: Uint32Array;
  readonly table: Uint32Array | undefined;
  readonly tableSize: number;
  readonly tableShift: number;
  total = 0;
  cycle = 0;
  until = 0;
  /** `search` builds the table a decoder starts its symbol search from. */
  constructor(symbols: number, search = true) {
    this.symbols = symbols;
    this.last = symbols - 1;
    this.dist = new Uint32Array(symbols);
    this.counts = new Uint32Array(symbols);
    if (search && symbols > 16) {
      let bits = 3;
      while (symbols > 1 << (bits + 2)) bits++;
      this.tableSize = 1 << bits;
      this.tableShift = SYMBOL_SHIFT - bits;
      this.table = new Uint32Array(this.tableSize + 2);
    } else {
      this.tableSize = 0;
      this.tableShift = 0;
    }
    this.reset();
  }
  reset() {
    this.total = 0;
    this.cycle = this.symbols;
    this.counts.fill(1);
    this.update();
    this.cycle = this.until = (this.symbols + 6) >>> 1;
  }
  update() {
    const { counts, dist, symbols } = this;
    if ((this.total += this.cycle) > SYMBOL_MAX) {
      let total = 0;
      for (let k = 0; k < symbols; k++) total += counts[k] = (counts[k] + 1) >>> 1;
      this.total = total;
    }
    const scale = Math.floor(0x80000000 / this.total),
      down = 2 ** (31 - SYMBOL_SHIFT);
    let sum = 0;
    const table = this.table;
    if (!table)
      for (let k = 0; k < symbols; k++) {
        dist[k] = Math.floor((scale * sum) / down);
        sum += counts[k];
      }
    else {
      let s = 0;
      for (let k = 0; k < symbols; k++) {
        dist[k] = Math.floor((scale * sum) / down);
        sum += counts[k];
        const w = dist[k] >>> this.tableShift;
        while (s < w) table[++s] = k - 1;
      }
      table[0] = 0;
      while (s <= this.tableSize) table[++s] = symbols - 1;
    }
    this.cycle = Math.min((5 * this.cycle) >>> 2, (symbols + 6) << 3);
    this.until = this.cycle;
  }
}

export class Median5 {
  private readonly v = new Int32Array(5);
  private high = true;
  reset() {
    this.v.fill(0);
    this.high = true;
  }
  get(): number {
    return this.v[2];
  }
  add(x: number) {
    const v = this.v;
    if (this.high) {
      if (x < v[2]) {
        v[4] = v[3];
        v[3] = v[2];
        if (x < v[0]) {
          v[2] = v[1];
          v[1] = v[0];
          v[0] = x;
        } else if (x < v[1]) {
          v[2] = v[1];
          v[1] = x;
        } else v[2] = x;
      } else {
        if (x < v[3]) {
          v[4] = v[3];
          v[3] = x;
        } else v[4] = x;
        this.high = false;
      }
    } else if (v[2] < x) {
      v[0] = v[1];
      v[1] = v[2];
      if (v[4] < x) {
        v[2] = v[3];
        v[3] = v[4];
        v[4] = x;
      } else if (v[3] < x) {
        v[2] = v[3];
        v[3] = x;
      } else v[2] = x;
    } else {
      if (v[1] < x) {
        v[0] = v[1];
        v[1] = x;
      } else v[0] = x;
      this.high = true;
    }
  }
}

export const median5s = (n: number) => Array.from({ length: n }, () => new Median5());
export const clampByte = (n: number) => (n <= 0 ? 0 : n >= 255 ? 255 : n);
export const lazy = (models: (SymbolModel | undefined)[], i: number, symbols: number) =>
  (models[i] ??= new SymbolModel(symbols));
export const resetAll = (models: readonly (SymbolModel | undefined)[]) => {
  for (const m of models) m?.reset();
};

// Return contexts of the point10 item, indexed [returns * 8 + return number]: a map of the return to 16 groups, and
// its distance from the last return.
// biome-ignore format: an 8 x 8 table
export const MAP10 = new Uint8Array([
  15, 14, 13, 12, 11, 10, 9, 8,
  14, 0, 1, 3, 6, 10, 10, 9,
  13, 1, 2, 4, 7, 11, 11, 10,
  12, 3, 4, 5, 8, 12, 12, 11,
  11, 6, 7, 8, 9, 13, 13, 12,
  10, 10, 11, 12, 13, 14, 14, 13,
  9, 10, 11, 12, 13, 14, 15, 14,
  8, 9, 10, 11, 12, 13, 14, 15,
]);
export const LEVEL10 = new Uint8Array(64).map((_, i) => Math.abs((i >> 3) - (i & 7)));
// The point14 item's six return groups and eight levels, indexed [returns * 16 + return number]. From three returns on,
// the first return is group 3, the last 5 and those between 4: checked against real files up to six returns.
// biome-ignore format: a 16 x 16 table
export const MAP14 = new Uint8Array([
  0, 1, 2, 3, 4, 5, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5,
  1, 0, 1, 3, 4, 5, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5,
  2, 1, 2, 4, 5, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  3, 3, 4, 5, 4, 5, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  4, 3, 4, 4, 5, 5, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 5, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  3, 3, 4, 4, 4, 4, 5, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  4, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  4, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5,
]);
export const LEVEL14 = new Uint8Array(256).map((_, i) => Math.min(Math.abs((i >> 4) - (i & 15)), 7));
