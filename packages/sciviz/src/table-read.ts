import { fault, rangeError } from '../../shared/errors.js';
import { ColumnarTable, type TableColumn, type TableValue, type TableValues } from './table.js';
import { arrowTable } from './table-arrow.js';
import { parquetTable } from './table-parquet.js';

/** Cancellation, projection and resource limits for in-memory table readers. */
export interface TableReadOptions {
  readonly signal?: AbortSignal;
  readonly columns?: readonly string[];
  /** Default 100000000. */ readonly maxRows?: number;
  /** Input and individual decoded block limit, default 536870912. */ readonly maxBytes?: number;
}
/** CSV uses RFC 4180 quoting; empty cells are null by default. */
export interface CSVOptions extends TableReadOptions {
  readonly delimiter?: string;
  readonly types?: Readonly<Record<string, 'number' | 'bigint' | 'string' | 'boolean'>>;
  readonly nullValues?: readonly string[];
}
/** @internal */
export function invalidTable(why: string): never { throw fault('failed', `Invalid columnar table: ${why}`, 'sciviz'); }
/** @internal */
export function tableLimits(options: TableReadOptions, bytes: number, rows = 0): void {
  options.signal?.throwIfAborted();
  for (const n of [options.maxBytes ?? 536870912, options.maxRows ?? 100000000])
    if (!Number.isSafeInteger(n) || n < 0) throw rangeError('Table reader limits must be nonnegative safe integers', 'sciviz');
  if (bytes > (options.maxBytes ?? 536870912) || rows > (options.maxRows ?? 100000000)) throw rangeError('Table exceeds maxBytes or maxRows; project or partition the source', 'sciviz');
}
/** @internal Materialize a scalar column without losing int64 precision or nulls. */
export function scalarColumn(data: readonly TableValue[], unit?: string, storage?: 'i64' | 'u64'): TableColumn {
  const validity = new Uint8Array(Math.ceil(data.length / 8)); let missing = false, strings = false, big = !!storage;
  for (let i = 0; i < data.length; i++) { if (data[i] === null) missing = true; else { validity[i >> 3] |= 1 << (i & 7); strings ||= typeof data[i] === 'string'; big ||= typeof data[i] === 'bigint'; } }
  let values: TableValues; let categories: string[] | undefined;
  if (strings) {
    categories = []; const dictionary = new Map<string, number>(); values = new Uint32Array(data.length);
    for (let i = 0; i < data.length; i++) if (data[i] !== null) { const key = String(data[i]); let id = dictionary.get(key); if (id === undefined) { id = categories.length; dictionary.set(key, id); categories.push(key); } values[i] = id; }
  } else if (big) {
    values = storage === 'u64' ? new BigUint64Array(data.length) : new BigInt64Array(data.length);
    for (let i = 0; i < data.length; i++) if (data[i] !== null) { const v = BigInt(data[i]!); if (v < (storage === 'u64' ? 0n : -(1n << 63n)) || v > (storage === 'u64' ? (1n << 64n) - 1n : (1n << 63n) - 1n)) invalidTable('integer exceeds 64-bit column storage'); values[i] = v; }
  } else { values = Float64Array.from(data, (v) => v === null ? 0 : Number(v)); }
  return { values, categories, validity: missing ? validity : undefined, unit };
}

/** Parse UTF-8 CSV with quoted newlines, doubled quotes, nulls, projection and explicit/inferred scalar types. */
export function readCSV(input: string | Uint8Array, options: CSVOptions = {}): ColumnarTable {
  const text = (typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)).replace(/^\uFEFF/, '');
  tableLimits(options, typeof input === 'string' ? new TextEncoder().encode(input).length : input.length);
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw rangeError('CSV delimiter must be one non-quote, non-newline character', 'sciviz');
  let names: string[] | undefined, row: string[] = [], cell = '', quoted = false, closed = false, rows = 0;
  const columns: string[][] = [];
  const finish = () => {
    row.push(cell); cell = ''; closed = false;
    if (!names) {
      names = row;
      if (!names.length || names.some((v) => !v) || new Set(names).size !== names.length) invalidTable('CSV needs unique nonempty headers');
      for (const name of options.columns ?? []) if (!names.includes(name)) invalidTable(`CSV column ${name} does not exist`);
      names.forEach(() => columns.push([]));
    } else {
      if (row.length !== names.length) invalidTable(`CSV row ${rows + 2} has the wrong field count`);
      tableLimits(options, 0, ++rows);
      row.forEach((v, i) => { if (!options.columns || options.columns.includes(names![i])) columns[i].push(v); });
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    if ((i & 65535) === 0) options.signal?.throwIfAborted();
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += ch; }
    else if (ch === delimiter) { row.push(cell); cell = ''; closed = false; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; finish(); }
    else if (ch === '"' && !cell && !closed) quoted = true;
    else { if (closed || ch === '"') invalidTable('unexpected character outside a quoted CSV field'); cell += ch; }
  }
  if (quoted) invalidTable('unterminated CSV quote');
  if (cell || row.length || closed) finish();
  const result: Record<string, TableColumn> = Object.create(null), nulls = new Set(options.nullValues ?? ['']);
  (names ?? []).forEach((name, i) => {
    if (options.columns && !options.columns.includes(name)) return;
    const cells = columns[i], present = cells.filter((v) => !nulls.has(v));
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    const kind = (options.types && Object.hasOwn(options.types, name) ? options.types[name] : undefined) ?? (present.length && present.every((v) => numeric.test(v) && Number.isFinite(Number(v))) ? present.every((v) => /^[+-]?\d+$/.test(v)) && present.some((v) => !Number.isSafeInteger(Number(v))) ? 'bigint' : 'number' : 'string');
    const values = cells.map((v): TableValue => {
      if (nulls.has(v)) return null;
      if (kind === 'string') return v;
      if (kind === 'boolean') { if (!['true', 'false', '0', '1'].includes(v)) invalidTable(`CSV ${name} is not boolean`); return v === 'true' || v === '1' ? 1 : 0; }
      if (kind === 'bigint') { if (!/^[+-]?\d+$/.test(v)) invalidTable(`CSV ${name} is not an integer`); return BigInt(v); }
      if (!numeric.test(v) || !Number.isFinite(Number(v))) invalidTable(`CSV ${name} is not numeric`); return Number(v);
    });
    result[name] = scalarColumn(values);
  });
  return new ColumnarTable(result);
}
/** Read Arrow IPC files or streams. Flat scalar columns; dictionaries and compressed record batches supported. */
export async function readArrow(input: Uint8Array, options: TableReadOptions = {}): Promise<ColumnarTable> { tableLimits(options, input.length); return arrowTable(input, options); }
/** Read flat scalar Parquet row groups and v1/v2 data pages from the format specification. */
export async function readParquet(input: Uint8Array, options: TableReadOptions = {}): Promise<ColumnarTable> { tableLimits(options, input.length); return parquetTable(input, options); }
/** Fetch an immutable table with cancellation; format inferred from URL unless specified. */
export async function loadTable(url: string | URL, options: CSVOptions & { readonly format?: 'csv' | 'arrow' | 'parquet' } = {}): Promise<ColumnarTable> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw fault('failed', `Table request returned HTTP ${response.status}`, 'sciviz');
  const size = Number(response.headers.get('content-length') ?? 0); tableLimits(options, size);
  const reader = response.body!.getReader(), parts: Uint8Array[] = []; let length = 0;
  try { for (;;) { options.signal?.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; length += value.length; tableLimits(options, length); parts.push(value); } }
  finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const format = options.format ?? (/\.parquet(?:[?#]|$)/i.test(String(url)) ? 'parquet' : /\.(?:arrow|feather|ipc)(?:[?#]|$)/i.test(String(url)) ? 'arrow' : 'csv');
  return format === 'csv' ? readCSV(bytes, options) : format === 'arrow' ? readArrow(bytes, options) : readParquet(bytes, options);
}
