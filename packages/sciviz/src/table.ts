/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError } from '../../shared/errors.js';

export { readCSV, readArrow, readParquet, loadTable, type TableReadOptions, type CSVOptions } from './table-read.js';
export { aggregateTable, bindTableAggregate, type TableAggregateOptions, type TableAggregate, type AggregateBinding } from './table-aggregate.js';

/** Scalar typed storage. Strings are dictionary encoded in a Uint32Array. */
export type TableValues = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array;
/** Borrowed immutable column; validity is an LSB-first bitmap (one means valid). */
export interface TableColumn {
  readonly values: TableValues;
  readonly validity?: Uint8Array;
  readonly categories?: readonly string[];
  /** Physical time/decimal units are preserved, never silently rounded to JS numbers. */
  readonly unit?: string;
}
/** Decoded scalar; missing values are null, independent of NaN. */
export type TableValue = number | bigint | string | null;

/** Equal-length typed columns with explicit nulls. Keep borrowed arrays immutable. */
export class ColumnarTable {
  readonly columns: Readonly<Record<string, TableColumn>>;
  readonly length: number;
  constructor(columns: Readonly<Record<string, TableColumn | TableValues>>) {
    const entries = Object.entries(columns).map(([name, value]) => [name, ArrayBuffer.isView(value) ? { values: value } : value] as const);
    this.length = entries[0]?.[1].values.length ?? 0;
    if (this.length > 0xffffffff) throw rangeError('A table supports at most 4294967295 rows', 'sciviz');
    for (const [name, col] of entries) {
      if (!name || !ArrayBuffer.isView(col.values) || col.values instanceof DataView || col.values.length !== this.length)
        throw rangeError('Table columns need names and equal typed lengths', 'sciviz');
      if (col.validity && col.validity.length !== Math.ceil(this.length / 8))
        throw rangeError('Table validity needs one bit per row', 'sciviz');
      if (col.categories) {
        if (!(col.values instanceof Uint32Array) || new Set(col.categories).size !== col.categories.length)
          throw rangeError('Categorical columns need unique labels and Uint32 indices', 'sciviz');
        for (let i = 0; i < this.length; i++)
          if ((!col.validity || (col.validity[i >> 3] & (1 << (i & 7)))) && col.values[i] >= col.categories.length)
            throw rangeError('Category index exceeds its dictionary', 'sciviz');
      }
    }
    this.columns = Object.freeze(Object.fromEntries(entries.map(([name, col]) => [name, Object.freeze({ ...col })])));
  }
  column(name: string): TableColumn {
    const col = Object.hasOwn(this.columns, name) ? this.columns[name] : undefined;
    if (!col) throw rangeError(`Unknown table column ${name}`, 'sciviz');
    return col;
  }
  value(name: string, row: number): TableValue {
    if (!Number.isInteger(row) || row < 0 || row >= this.length) throw rangeError('Table row is out of bounds', 'sciviz');
    const col = this.column(name);
    if (col.validity && !(col.validity[row >> 3] & (1 << (row & 7)))) return null;
    return col.categories ? col.categories[Number(col.values[row])] : col.values[row];
  }
  /** Copy rows in the supplied order, preserving physical storage and nulls. */
  take(rows: ArrayLike<number>): ColumnarTable {
    for (let i = 0; i < rows.length; i++)
      if (!Number.isInteger(rows[i]) || rows[i] < 0 || rows[i] >= this.length) throw rangeError('Table subset row is out of bounds', 'sciviz');
    const columns: Record<string, TableColumn> = Object.create(null);
    for (const [name, col] of Object.entries(this.columns)) {
      const values = new (col.values.constructor as { new(length: number): TableValues })(rows.length);
      const validity = col.validity ? new Uint8Array(Math.ceil(rows.length / 8)) : undefined;
      for (let i = 0; i < rows.length; i++) {
        (values as Float64Array)[i] = (col.values as Float64Array)[rows[i]];
        if (validity && (col.validity![rows[i] >> 3] & (1 << (rows[i] & 7)))) validity[i >> 3] |= 1 << (i & 7);
      }
      columns[name] = { ...col, values, validity };
    }
    return new ColumnarTable(columns);
  }
}

/** Number of set bits in one word. */
export function bitmapCount(word: number): number {
  word -= (word >>> 1) & 0x55555555;
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
  return (((word + (word >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
const full = (rows: number): Uint32Array => {
  const mask = new Uint32Array(Math.ceil(rows / 32)).fill(0xffffffff);
  if (rows % 32) mask[mask.length - 1] = 0xffffffff >>> (32 - rows % 32);
  return mask;
};

/** AND across dimensions; range/set updates visit only the changed index spans. */
export class CrossFilter extends EventTarget {
  readonly table: ColumnarTable;
  readonly #dimensions = new Set<TableDimension>();
  readonly #mask: Uint32Array;
  #count: number;
  #version = 0;
  #disposed = false;
  constructor(table: ColumnarTable) {
    super(); this.table = table; this.#mask = full(table.length); this.#count = table.length;
  }
  get count(): number { return this.#count; }
  get version(): number { return this.#version; }
  get bitmap(): Uint32Array { return this.#mask.slice(); }
  has(row: number): boolean { return Number.isInteger(row) && row >= 0 && row < this.table.length && !!(this.#mask[row >>> 5] & (1 << (row & 31))); }
  *rows(): IterableIterator<number> {
    for (let w = 0; w < this.#mask.length; w++) {
      let bits = this.#mask[w];
      while (bits) { const bit = 31 - Math.clz32(bits & -bits); yield w * 32 + bit; bits &= bits - 1; }
    }
  }
  dimension(name: string): TableDimension {
    this.check(); const d = new TableDimension(this, name); this.#dimensions.add(d); return d;
  }
  /** @internal */
  check(): void { if (this.#disposed) throw fault('state', 'CrossFilter is disposed', 'sciviz'); }
  /** @internal Combine changed words only; no other column is re-evaluated. */
  update(words: Set<number>, removed?: TableDimension): void {
    this.check(); if (removed) this.#dimensions.delete(removed);
    for (const w of words) {
      let value = w === this.#mask.length - 1 && this.table.length % 32 ? 0xffffffff >>> (32 - this.table.length % 32) : 0xffffffff;
      for (const dim of this.#dimensions) value &= dim.mask[w];
      this.#count += bitmapCount(value) - bitmapCount(this.#mask[w]); this.#mask[w] = value;
    }
    this.#version++; this.dispatchEvent(new Event('change'));
  }
  dispose(): void { this.#disposed = true; this.#dimensions.clear(); }
  [Symbol.dispose](): void { this.dispose(); }
}

/** Indexed range [lower, upper), exact set membership, or all rows. Nulls match only explicit set(null). */
export class TableDimension {
  readonly #filter: CrossFilter;
  readonly #name: string;
  /** @internal */ readonly mask: Uint32Array;
  #order?: Uint32Array;
  #groups?: Map<TableValue, number[]>;
  #range?: readonly [number, number];
  #set?: Set<TableValue>;
  #mode: 'all' | 'range' | 'set' = 'all';
  #disposed = false;
  #visits = 0;
  #words = 0;
  constructor(filter: CrossFilter, name: string) { filter.table.column(name); this.#filter = filter; this.#name = name; this.mask = full(filter.table.length); }
  get work(): Readonly<{ rowsVisited: number; wordsCombined: number }> { return { rowsVisited: this.#visits, wordsCombined: this.#words }; }
  #check(): void { this.#filter.check(); if (this.#disposed) throw fault('state', 'Table dimension is disposed', 'sciviz'); }
  #index(): Uint32Array {
    if (!this.#order) {
      const col = this.#filter.table.column(this.#name);
      if (col.categories) throw rangeError('Range filters require a numeric column', 'sciviz');
      let n = 0; const order = new Uint32Array(this.#filter.table.length);
      for (let i = 0; i < order.length; i++) if (this.#filter.table.value(this.#name, i) !== null && Number.isFinite(Number(col.values[i]))) order[n++] = i;
      this.#order = order.slice(0, n).sort((a, b) => col.values[a] < col.values[b] ? -1 : col.values[a] > col.values[b] ? 1 : a - b);
    }
    return this.#order;
  }
  #write(row: number, pass: boolean, words: Set<number>): void {
    this.#visits++; const w = row >>> 5, bit = 1 << (row & 31), previous = this.mask[w];
    this.mask[w] = pass ? previous | bit : previous & ~bit;
    if (this.mask[w] !== previous) words.add(w);
  }
  #done(words: Set<number>): void { this.#words = words.size; this.#filter.update(words); }
  filterRange(lower: number | bigint, upper: number | bigint): this {
    this.#check();
    if (lower > upper || (typeof lower === 'number' && !Number.isFinite(lower)) || (typeof upper === 'number' && !Number.isFinite(upper))) throw rangeError('Range needs ordered finite endpoints', 'sciviz');
    const order = this.#index(), col = this.#filter.table.column(this.#name), search = (value: number | bigint) => {
      let a = 0, b = order.length; while (a < b) { const m = (a + b) >>> 1; if (col.values[order[m]] < value) a = m + 1; else b = m; } return a;
    }, next = [search(lower), search(upper)] as const, words = new Set<number>();
    this.#visits = 0;
    if (this.#mode === 'range') {
      const old = this.#range!;
      for (let j = Math.min(old[0], next[0]); j < Math.max(old[0], next[0]); j++) this.#write(order[j], j >= next[0] && j < next[1], words);
      for (let j = Math.min(old[1], next[1]); j < Math.max(old[1], next[1]); j++) this.#write(order[j], j >= next[0] && j < next[1], words);
    } else {
      const nextMask = new Uint32Array(this.mask.length);
      for (let j = next[0]; j < next[1]; j++) nextMask[order[j] >>> 5] |= 1 << (order[j] & 31);
      for (let w = 0; w < nextMask.length; w++) if (nextMask[w] !== this.mask[w]) { this.mask[w] = nextMask[w]; words.add(w); }
      this.#visits = next[1] - next[0];
    }
    this.#mode = 'range'; this.#range = next; this.#set = undefined; this.#done(words); return this;
  }
  filterSet(values: Iterable<TableValue>): this {
    this.#check(); const next = new Set(values), words = new Set<number>(); this.#visits = 0;
    if (!this.#groups) {
      this.#groups = new Map();
      for (let i = 0; i < this.#filter.table.length; i++) {
        const key = this.#filter.table.value(this.#name, i), rows = this.#groups.get(key);
        if (rows) rows.push(i); else this.#groups.set(key, [i]);
      }
    }
    if (this.#mode === 'set') {
      for (const key of new Set([...this.#set!, ...next])) if (this.#set!.has(key) !== next.has(key))
        for (const row of this.#groups.get(key) ?? []) this.#write(row, next.has(key), words);
    } else {
      const nextMask = new Uint32Array(this.mask.length);
      for (const key of next) for (const row of this.#groups.get(key) ?? []) { nextMask[row >>> 5] |= 1 << (row & 31); this.#visits++; }
      for (let w = 0; w < nextMask.length; w++) if (nextMask[w] !== this.mask[w]) { this.mask[w] = nextMask[w]; words.add(w); }
    }
    this.#mode = 'set'; this.#set = next; this.#range = undefined; this.#done(words); return this;
  }
  clear(): this {
    this.#check(); const next = full(this.#filter.table.length), words = new Set<number>(); this.#visits = 0;
    for (let w = 0; w < next.length; w++) if (this.mask[w] !== next[w]) { this.mask[w] = next[w]; words.add(w); }
    this.#mode = 'all'; this.#range = undefined; this.#set = undefined; this.#done(words); return this;
  }
  dispose(): void { if (this.#disposed) return; this.clear(); this.#filter.update(new Set(), this); this.#disposed = true; this.#order = undefined; this.#groups = undefined; }
  [Symbol.dispose](): void { this.dispose(); }
}
