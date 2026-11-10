// Clean room from the Apache Parquet format specification and Thrift Compact protocol description.
import { decodeColumnarBlock, type ColumnarCodec } from '@margoengine/decoders/snappy';
import { collectBatches } from './table-batches.js';
import { crc32 } from '../../shared/crc32.js';
import { ColumnarTable, type TableColumn, type TableValue } from './table.js';
import { invalidTable as bad, scalarColumn, tableLimits, type TableReadOptions } from './table-read.js';

type MetaValue = number | bigint | boolean | Uint8Array | MetaValue[] | Meta;
interface Meta { [key: number]: MetaValue; }
const object = (v: MetaValue | undefined): Meta => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? v : bad('Parquet metadata struct is missing');
const array = (v: MetaValue | undefined): MetaValue[] => Array.isArray(v) ? v : bad('Parquet metadata list is missing');
const number = (v: MetaValue | undefined): number => typeof v === 'number' && Number.isSafeInteger(v) ? v : typeof v === 'bigint' && Number.isSafeInteger(Number(v)) ? Number(v) : bad('Parquet integer is missing or exceeds safe limits');
const text = (v: MetaValue | undefined): string => v instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(v) : bad('Parquet metadata string is missing');

class Cursor {
  at = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  take(n: number): Uint8Array { if (!Number.isSafeInteger(n) || n < 0 || this.at + n > this.bytes.length) bad('truncated Parquet data'); const start = this.at; this.at += n; return this.bytes.subarray(start, this.at); }
  byte(): number { return this.take(1)[0]; }
  u32(): number { const p = this.at; this.take(4); return this.view.getUint32(p, true); }
  uint(): bigint { let value = 0n; for (let shift = 0; shift <= 63; shift += 7) { const b = this.byte(); if (shift === 63 && b > 1) bad('Parquet varint exceeds 64 bits'); value |= BigInt(b & 127) << BigInt(shift); if (!(b & 128)) return value; } return bad('Parquet varint is too long'); }
  size(): number { const v = this.uint(); if (!Number.isSafeInteger(Number(v))) bad('Parquet length exceeds safe limits'); return Number(v); }
  zig(): bigint { const v = this.uint(); return (v >> 1n) ^ -(v & 1n); }
  bits(count: number, width: number): bigint[] {
    if (!Number.isInteger(width) || width < 0 || width > 64) bad('Parquet bit width exceeds 64');
    const input = this.take(Math.ceil(count * width / 8)), output: bigint[] = []; let bit = 0;
    for (let i = 0; i < count; i++) { let value = 0n; for (let k = 0; k < width;) { const take = Math.min(8 - (bit & 7), width - k); value |= BigInt((input[bit >>> 3] >>> (bit & 7)) & ((1 << take) - 1)) << BigInt(k); bit += take; k += take; } output.push(value); }
    return output;
  }
  meta(depth = 0): Meta {
    if (depth > 32) bad('Parquet metadata nesting exceeds 32');
    const out: Meta = {}; let field = 0;
    for (;;) { const tag = this.byte(); if (!tag) return out; const type = tag & 15, delta = tag >>> 4; field = delta ? field + delta : Number(this.zig()); if (field <= 0 || Object.hasOwn(out, field)) bad('invalid Parquet metadata field'); out[field] = this.value(type, depth + 1, true); }
  }
  value(type: number, depth: number, inField = false): MetaValue {
    if (depth > 32) bad('Parquet metadata nesting exceeds 32');
    if (type === 1 || type === 2) { const b = inField ? type : this.byte(); if (b !== 1 && b !== 2) bad('invalid Thrift boolean'); return b === 1; }
    if (type === 3) { const b = this.byte(); return b > 127 ? b - 256 : b; }
    if (type >= 4 && type <= 6) { const n = this.zig(); return Number.isSafeInteger(Number(n)) ? Number(n) : n; }
    if (type === 7) { const p = this.at; this.take(8); return this.view.getFloat64(p, true); }
    if (type === 8) return this.take(this.size());
    if (type === 12) return this.meta(depth);
    if (type === 9 || type === 10) {
      const tag = this.byte(), length = (tag >>> 4) === 15 ? this.size() : tag >>> 4;
      if (length > this.bytes.length - this.at) bad('Parquet metadata list length exceeds input');
      return Array.from({ length }, () => this.value(tag & 15, depth + 1));
    }
    if (type === 11) {
      const n = this.size(), tag = n ? this.byte() : 0;
      if (n > this.bytes.length - this.at) bad('Parquet map exceeds input');
      const pairs: MetaValue[] = []; for (let i = 0; i < n; i++) pairs.push([this.value(tag >>> 4, depth + 1), this.value(tag & 15, depth + 1)]); return pairs;
    }
    return bad('unsupported Thrift type');
  }
}

function hybrid(cursor: Cursor, count: number, width: number): number[] {
  if (width < 0 || width > 32) bad('Parquet RLE width exceeds 32');
  const out: number[] = [];
  while (out.length < count) {
    const header = cursor.size(), run = header & 1 ? (header >>> 1) * 8 : header >>> 1;
    if (!run || run > count - out.length + 7) bad('Parquet RLE run exceeds value count');
    if (header & 1) for (const value of cursor.bits(run, width)) { if (out.length < count) out.push(Number(value)); }
    else {
      let value = 0; const bytes = cursor.take(Math.ceil(width / 8)); for (let i = 0; i < bytes.length; i++) value += bytes[i] * 2 ** (8 * i);
      if (value >= 2 ** width) bad('Parquet RLE value exceeds bit width');
      for (let i = 0; i < run; i++) out.push(value);
    }
  }
  return out;
}
function delta(cursor: Cursor, expected?: number): bigint[] {
  const block = cursor.size(), minis = cursor.size(), count = cursor.size();
  if (!block || block % 128 || !minis || block % minis || (block / minis) % 32 || (expected !== undefined && count !== expected)) bad('Parquet delta block layout/count is invalid');
  if (count > 100000000 || block > 65536) bad('Parquet delta block is too large');
  const out: bigint[] = []; let last = cursor.zig(); if (count) out.push(last);
  while (out.length < count) {
    const min = cursor.zig(), widths = cursor.take(minis);
    for (const width of widths) for (const d of cursor.bits(block / minis, width)) if (out.length < count) { last += min + d; out.push(last); }
  }
  return out;
}
function lengths(cursor: Cursor, count: number): Uint8Array[] {
  return delta(cursor, count).map((size) => { if (size < 0n || size > BigInt(cursor.bytes.length)) bad('Parquet delta byte length is invalid'); return cursor.take(Number(size)); });
}
interface Field { name: string; type: number; optional: boolean; width: number; utf8: boolean; unsigned: boolean; unit?: string; decimal: boolean; }
function bytesValue(bytes: Uint8Array, field: Field): TableValue {
  if (field.utf8) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (field.decimal) { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); if (bytes[0] & 128) n -= 1n << BigInt(bytes.length * 8); return bytes.length > 8 ? n.toString() : n; }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function plain(cursor: Cursor, field: Field, count: number): TableValue[] {
  if (field.type === 0) { const b = cursor.take(Math.ceil(count / 8)); return Array.from({ length: count }, (_, i) => (b[i >>> 3] >>> (i & 7)) & 1); }
  return Array.from({ length: count }, (): TableValue => {
    const p = cursor.at;
    if (field.type === 1) { cursor.take(4); return field.unsigned ? cursor.view.getUint32(p, true) : cursor.view.getInt32(p, true); }
    if (field.type === 2) { cursor.take(8); return field.unsigned ? cursor.view.getBigUint64(p, true) : cursor.view.getBigInt64(p, true); }
    if (field.type === 3) { cursor.take(12); return cursor.view.getBigUint64(p, true) + BigInt(cursor.view.getUint32(p + 8, true) - 2440588) * 86400000000000n; }
    if (field.type === 4) { cursor.take(4); return cursor.view.getFloat32(p, true); }
    if (field.type === 5) { cursor.take(8); return cursor.view.getFloat64(p, true); }
    if (field.type === 6 || field.type === 7) return bytesValue(cursor.take(field.type === 6 ? cursor.u32() : field.width), field);
    return bad('Unknown Parquet physical type');
  });
}
function values(cursor: Cursor, field: Field, count: number, encoding: number, dictionary: TableValue[] | undefined): TableValue[] {
  if (!count) return [];
  if (encoding === 0) return plain(cursor, field, count);
  if (encoding === 2 || encoding === 8) {
    if (!dictionary) bad('Parquet dictionary indices precede dictionary');
    return hybrid(cursor, count, cursor.byte()).map((i) => i < dictionary.length ? dictionary[i] : bad('Parquet dictionary index is invalid'));
  }
  if (encoding === 3 && field.type === 0) return hybrid(new Cursor(cursor.take(cursor.u32())), count, 1);
  if (encoding === 5 && (field.type === 1 || field.type === 2)) return delta(cursor, count).map((v) => field.type === 1 ? Number(BigInt.asIntN(32, v)) : field.unsigned ? BigInt.asUintN(64, v) : BigInt.asIntN(64, v));
  if (encoding === 6 && field.type === 6) return lengths(cursor, count).map((b) => bytesValue(b, field));
  if (encoding === 7 && (field.type === 6 || field.type === 7)) {
    const prefixes = delta(cursor, count), suffixes = lengths(cursor, count); let prior = new Uint8Array();
    return suffixes.map((suffix, i) => { const prefix = Number(prefixes[i]); if (prefix < 0 || prefix > prior.length) bad('Parquet prefix length exceeds previous value'); const b = new Uint8Array(prefix + suffix.length); b.set(prior.subarray(0, prefix)); b.set(suffix, prefix); prior = b; return bytesValue(b, field); });
  }
  if (encoding === 9 && [1, 2, 4, 5, 7].includes(field.type)) {
    const width = field.type === 2 || field.type === 5 ? 8 : field.type === 7 ? field.width : 4, bytes = cursor.take(count * width), joined = new Uint8Array(bytes.length);
    for (let b = 0; b < width; b++) for (let i = 0; i < count; i++) joined[i * width + b] = bytes[b * count + i];
    return plain(new Cursor(joined), field, count);
  }
  return bad(`Parquet encoding ${encoding} is invalid for physical type ${field.type}`);
}
const codecs: Readonly<Record<number, ColumnarCodec>> = { 0: 'none', 1: 'snappy', 2: 'gzip', 4: 'brotli', 6: 'zstd', 7: 'lz4' };
function field(meta: Meta): Field {
  const type = number(meta[1]), logical = meta[10] ? object(meta[10]) : {}, converted = meta[6] === undefined ? -1 : number(meta[6]), integer = logical[10] ? object(logical[10]) : undefined;
  let unit: string | undefined;
  if (converted === 6 || logical[6]) unit = 'date:day';
  if ([7, 8, 9, 10].includes(converted)) unit = `${converted >= 9 ? 'timestamp' : 'time'}:${converted % 2 ? 'ms' : 'us'}`;
  if (logical[7] || logical[8]) { const info = object(logical[8] ?? logical[7]), time = object(info[2]); unit = `${logical[8] ? 'timestamp' : 'time'}:${time[1] ? 'ms' : time[2] ? 'us' : 'ns'}:${info[1] ? 'UTC' : 'local'}`; }
  if (type === 3) unit = 'timestamp:ns';
  const decimal = converted === 5 || !!logical[5];
  if (decimal) unit = 'decimal:' + number(logical[5] ? object(logical[5])[1] : meta[7]);
  const utf8 = converted === 0 || !!logical[1];
  if ((type === 6 || type === 7) && !utf8 && !decimal) unit = 'binary:hex';
  if (meta[5] || number(meta[3]) === 2) bad('Parquet table columns must be flat, non-repeated scalars; flatten nested data first');
  return { name: text(meta[4]), type, optional: number(meta[3]) === 1, width: meta[2] === undefined ? 0 : number(meta[2]), utf8, unsigned: integer ? !object(logical[10])[2] : converted >= 11 && converted <= 14, unit, decimal };
}

/** @internal Footer-driven row groups; projected column chunks are fetched independently. */
export async function* parquetBatches(read: (offset: number, length: number) => Promise<Uint8Array>, size: number, options: TableReadOptions): AsyncGenerator<ColumnarTable> {
  const magic = (b: Uint8Array) => new TextDecoder().decode(b) === 'PAR1';
  if (size < 12 || !magic(await read(0, 4))) bad('Parquet PAR1 magic is missing (encrypted files are unsupported)');
  const tail = await read(size - 8, 8);
  if (!magic(tail.subarray(4))) bad('Parquet footer magic is missing');
  const footerSize = new DataView(tail.buffer, tail.byteOffset, 8).getUint32(0, true), footerStart = size - 8 - footerSize;
  if (footerStart < 4) bad('Parquet footer exceeds input');
  tableLimits(options, footerSize);
  const cursor = new Cursor(await read(footerStart, footerSize)), metadata = cursor.meta();
  if (cursor.at !== cursor.bytes.length || ![1, 2].includes(number(metadata[1]))) bad('Parquet footer length/version is invalid');
  const schema = array(metadata[2]); if (schema.length < 1 || number(object(schema[0])[5]) !== schema.length - 1) bad('Parquet table schema must contain flat scalar columns');
  const fields = schema.slice(1).map((v) => field(object(v))), rows = number(metadata[3]); tableLimits(options, 0, rows);
  if (new Set(fields.map((f) => f.name)).size !== fields.length || fields.some((f) => !f.name)) bad('Parquet needs unique named columns');
  for (const name of options.columns ?? []) if (!fields.some((f) => f.name === name)) bad(`Parquet column ${name} does not exist`);
  let groupRows = 0;
  const columns = new Map(fields.filter((f) => !options.columns || options.columns.includes(f.name)).map((f) => [f.name, [] as TableValue[]]));
  for (const groupValue of array(metadata[4])) {
    for (const values of columns.values()) values.length = 0;
    const result: Record<string, TableColumn> = Object.create(null);
    options.signal?.throwIfAborted(); const group = object(groupValue), n = number(group[3]), chunks = array(group[1]);
    if (n < 0 || groupRows + n > rows || chunks.length !== fields.length) bad('Parquet row group counts do not match schema/footer'); groupRows += n;
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k], target = columns.get(f.name); if (!target) continue;
      const chunk = object(chunks[k]); if (chunk[1] || chunk[8]) bad('External or encrypted Parquet column chunks are unsupported');
      const m = object(chunk[3]), path = array(m[3]);
      if (path.length !== 1 || text(path[0]) !== f.name || number(m[1]) !== f.type || number(m[5]) !== n) bad('Parquet column metadata disagrees with schema');
      const codec = codecs[number(m[4])]; if (!codec) bad(`Unsupported Parquet compression codec ${number(m[4])}`);
      let at = number(m[11] ?? m[9]), seen = 0; const end = at + number(m[7]); let dictionary: TableValue[] | undefined;
      if (at < 4 || end > footerStart || end < at) bad('Parquet column chunk exceeds file bounds');
      tableLimits(options, end - at);
      const chunkStart = at, chunkBytes = await read(at, end - at);
      while (at < end && seen < n) {
        options.signal?.throwIfAborted(); const header = new Cursor(chunkBytes.subarray(at - chunkStart)), h = header.meta(), type = number(h[1]), decodedSize = number(h[2]), size = number(h[3]); at += header.at;
        tableLimits(options, decodedSize); if (size < 0 || at + size > end) bad('Parquet page exceeds chunk');
        const compressed = chunkBytes.subarray(at - chunkStart, at - chunkStart + size); at += size;
        if (h[4] !== undefined && crc32(compressed) !== (number(h[4]) >>> 0)) bad('Parquet page checksum mismatch');
        if (type === 1) continue;
        if (type === 2) {
          if (dictionary || seen) bad('Parquet dictionary must occur once before data pages');
          const d = object(h[7]); if (![0, 2].includes(number(d[2]))) bad('Parquet dictionary must use plain encoding');
          const decoded = await decodeColumnarBlock(codec, compressed, decodedSize, { signal: options.signal, maxOutputSize: options.maxBytes ?? 536870912 });
          dictionary = plain(new Cursor(decoded), f, number(d[1])); continue;
        }
        if (type !== 0 && type !== 3) bad(`Unsupported Parquet page type ${type}`);
        const v2 = type === 3, d = object(h[v2 ? 8 : 5]), count = number(d[1]), encoding = number(d[v2 ? 4 : 2]);
        if (count < 0 || seen + count > n) bad('Parquet page value count exceeds row group');
        let definitions: number[], payload: Cursor;
        if (v2) {
          const defBytes = number(d[5]), repBytes = number(d[6]);
          if (repBytes !== 0 || defBytes < 0 || defBytes > compressed.length || number(d[3]) !== count) bad('Invalid flat Parquet v2 levels/rows');
          definitions = f.optional ? hybrid(new Cursor(compressed.subarray(0, defBytes)), count, 1) : new Array<number>(count).fill(1);
          const data = compressed.subarray(defBytes);
          payload = new Cursor(d[7] === false ? data : await decodeColumnarBlock(codec, data, decodedSize - defBytes, { signal: options.signal, maxOutputSize: options.maxBytes ?? 536870912 }));
        } else {
          payload = new Cursor(await decodeColumnarBlock(codec, compressed, decodedSize, { signal: options.signal, maxOutputSize: options.maxBytes ?? 536870912 }));
          definitions = !f.optional ? new Array<number>(count).fill(1) : number(d[3]) === 3 ? hybrid(new Cursor(payload.take(payload.u32())), count, 1) : number(d[3]) === 4 ? payload.bits(count, 1).map(Number) : bad('Invalid Parquet definition level encoding');
        }
        const present = definitions.reduce((a, b) => a + b, 0);
        if (v2 && number(d[2]) !== count - present) bad('Parquet v2 null count disagrees with levels');
        const data = values(payload, f, present, encoding, dictionary); let i = 0;
        for (const defined of definitions) target.push(defined ? data[i++] : null);
        if (payload.at !== payload.bytes.length) bad('Parquet page has unexpected trailing values'); seen += count;
      }
      if (seen !== n) bad('Parquet column row count is incomplete');
    }
    for (const f of fields) if (columns.has(f.name)) result[f.name] = scalarColumn(columns.get(f.name)!, f.unit, f.type === 2 || f.type === 3 ? f.unsigned ? 'u64' : 'i64' : undefined);
    yield new ColumnarTable(result);
  }
  if (groupRows !== rows) bad('Parquet row group total disagrees with footer');
  if (!array(metadata[4]).length) {
    const result: Record<string, TableColumn> = Object.create(null);
    for (const f of fields) if (columns.has(f.name)) result[f.name] = scalarColumn([], f.unit, f.type === 2 || f.type === 3 ? f.unsigned ? 'u64' : 'i64' : undefined);
    yield new ColumnarTable(result);
  }
}

/** @internal */
export async function parquetTable(bytes: Uint8Array, options: TableReadOptions): Promise<ColumnarTable> {
  return collectBatches(parquetBatches(async (at, n) => bytes.subarray(at, at + n), bytes.length, options));
}
