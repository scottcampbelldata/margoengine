// Clean-room Arrow IPC reader from Apache Arrow's columnar format and FlatBuffers metadata schemas.
import { decodeColumnarBlock } from '@margoengine/decoders/snappy';
import { ColumnarTable, type TableColumn, type TableValue } from './table.js';
import { invalidTable as bad, scalarColumn, tableLimits, type TableReadOptions } from './table-read.js';

class Flat {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  check(p: number, n: number): number { if (!Number.isSafeInteger(p) || !Number.isSafeInteger(n) || p < 0 || n < 0 || p + n > this.bytes.length) bad('Arrow metadata or body bounds'); return p; }
  u8(p: number): number { return this.view.getUint8(this.check(p, 1)); }
  u16(p: number): number { return this.view.getUint16(this.check(p, 2), true); }
  u32(p: number): number { return this.view.getUint32(this.check(p, 4), true); }
  i64(p: number): number { const v = Number(this.view.getBigInt64(this.check(p, 8), true)); if (!Number.isSafeInteger(v)) bad('Arrow offset exceeds JS safe integer'); return v; }
  ref(p: number): number { return this.check(p + this.u32(p), 4); }
  field(t: number, slot: number): number {
    const v = t - this.view.getInt32(this.check(t, 4), true), p = v + 4 + slot * 2;
    if (p + 2 > v + this.u16(v)) return 0;
    const o = this.u16(p); return o ? this.check(t + o, 1) : 0;
  }
  table(t: number, slot: number): number { const p = this.field(t, slot); return p ? this.ref(p) : 0; }
  scalar(t: number, slot: number, bytes = 4, fallback = 0): number { const p = this.field(t, slot); return p ? bytes === 1 ? this.u8(p) : bytes === 2 ? this.u16(p) : bytes === 8 ? this.i64(p) : this.u32(p) : fallback; }
  vector(t: number, slot: number, width: number): { start: number; length: number } {
    const p = this.table(t, slot); if (!p) return { start: 0, length: 0 }; const length = this.u32(p); return { start: this.check(p + 4, length * width), length };
  }
  string(t: number, slot: number): string { const p = this.table(t, slot); return p ? new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.check(p + 4, this.u32(p)), p + 4 + this.u32(p))) : ''; }
}
interface Field { name: string; type: number; bits: number; signed: boolean; unit?: string; dict?: number; index?: Field; }
function schema(f: Flat, t: number): { fields: Field[]; little: boolean } {
  const vector = f.vector(t, 1, 4), fields: Field[] = [];
  for (let i = 0; i < vector.length; i++) {
    const p = f.ref(vector.start + i * 4), type = f.scalar(p, 2, 1), detail = f.table(p, 3), dict = f.table(p, 4);
    if (f.vector(p, 5, 4).length) bad('Arrow table columns must be flat scalars; flatten nested data first');
    const field: Field = { name: f.string(p, 0), type, bits: 0, signed: true };
    if (type === 2) { field.bits = f.scalar(detail, 0); field.signed = !!f.scalar(detail, 1, 1); }
    else if (type === 3) field.bits = [16, 32, 64][f.scalar(detail, 0, 2)];
    else if (type === 8) { field.bits = f.scalar(detail, 0, 2, 1) ? 64 : 32; field.unit = field.bits === 32 ? 'date:day' : 'date:ms'; }
    else if ([9, 10, 18].includes(type)) { field.bits = type === 9 ? f.scalar(detail, 1, 4, 32) : 64; field.unit = `${type === 10 ? 'timestamp' : type === 18 ? 'duration' : 'time'}:${['s', 'ms', 'us', 'ns'][f.scalar(detail, 0, 2)]}${type === 10 && f.string(detail, 1) ? ':' + f.string(detail, 1) : ''}`; }
    else if (type === 7) { field.bits = f.scalar(detail, 2, 4, 128); field.unit = 'decimal:' + (f.scalar(detail, 1) | 0); }
    else if (type === 15) { field.bits = f.scalar(detail, 0) * 8; field.unit = 'binary:hex'; }
    else if (![1, 4, 5, 6, 19, 20].includes(type)) bad(`unsupported non-scalar Arrow type ${type}`);
    if (dict) {
      field.dict = f.scalar(dict, 0, 8); const idx = f.table(dict, 1);
      field.index = { name: field.name, type: 2, bits: idx ? f.scalar(idx, 0) : 32, signed: idx ? !!f.scalar(idx, 1, 1) : true };
    }
    fields.push(field);
  }
  if (new Set(fields.map((v) => v.name)).size !== fields.length || fields.some((v) => !v.name)) bad('Arrow needs unique named columns');
  return { fields, little: f.scalar(t, 0, 2) === 0 };
}
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function half(v: number): number { const sign = v & 32768 ? -1 : 1, exponent = (v >>> 10) & 31, fraction = v & 1023; return sign * (exponent === 31 ? fraction ? NaN : Infinity : exponent ? 2 ** (exponent - 15) * (1 + fraction / 1024) : 2 ** -14 * fraction / 1024); }
function primitive(bytes: Uint8Array, field: Field, count: number, little: boolean): TableValue[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = field.type === 6 ? 0 : field.bits / 8;
  if (field.type === 6) { if (bytes.length < Math.ceil(count / 8)) bad('Arrow boolean buffer is truncated'); return Array.from({ length: count }, (_, i) => (bytes[i >> 3] >>> (i & 7)) & 1); }
  if (!width || bytes.length < count * width || (field.type === 2 && ![8, 16, 32, 64].includes(field.bits))) bad('Arrow primitive buffer/type is invalid');
  return Array.from({ length: count }, (_, i): TableValue => {
    const p = i * width;
    if (field.type === 15) return hex(bytes.subarray(p, p + width));
    if (field.type === 7 && field.bits > 64) {
      let value = 0n; for (let j = 0; j < width; j++) value |= BigInt(bytes[p + j]) << BigInt(8 * (little ? j : width - j - 1));
      if (value & (1n << BigInt(field.bits - 1))) value -= 1n << BigInt(field.bits); return value.toString();
    }
    if (field.type === 3) return field.bits === 16 ? half(view.getUint16(p, little)) : field.bits === 32 ? view.getFloat32(p, little) : view.getFloat64(p, little);
    if (field.bits === 64) return field.signed ? view.getBigInt64(p, little) : view.getBigUint64(p, little);
    return field.bits === 8 ? field.signed ? view.getInt8(p) : view.getUint8(p) : field.bits === 16 ? field.signed ? view.getInt16(p, little) : view.getUint16(p, little) : field.signed ? view.getInt32(p, little) : view.getUint32(p, little);
  });
}

/** @internal */
export async function arrowTable(bytes: Uint8Array, options: TableReadOptions): Promise<ColumnarTable> {
  const file = new TextDecoder().decode(bytes.subarray(0, 6)) === 'ARROW1', whole = new Flat(bytes);
  let at = file ? 8 : 0, end = bytes.length, fields: Field[] | undefined, little = true, total = 0;
  const dictionaries = new Map<number, TableValue[]>(), columns: Record<string, TableValue[]> = Object.create(null);
  if (file) {
    if (bytes.length < 18 || new TextDecoder().decode(bytes.subarray(-6)) !== 'ARROW1') bad('Arrow footer magic is missing');
    const footerSize = whole.u32(bytes.length - 10); end = bytes.length - 10 - footerSize;
    if (end < 8) bad('Arrow footer exceeds file');
  }
  const decode = async (f: Flat, header: number, body: Uint8Array, layout: Field[]): Promise<TableValue[][]> => {
    const count = f.scalar(header, 0, 8), nodes = f.vector(header, 1, 16), buffers = f.vector(header, 2, 16), compression = f.table(header, 3);
    tableLimits(options, body.length, count);
    if (nodes.length !== layout.length) bad('Arrow scalar node count does not match schema');
    if (compression && f.scalar(compression, 1, 1) !== 0) bad('Arrow compression method is not BUFFER');
    let bufferIndex = 0;
    const get = async () => {
      if (bufferIndex >= buffers.length) bad('Arrow buffer count does not match schema');
      const p = buffers.start + 16 * bufferIndex++, offset = f.i64(p), size = f.i64(p + 8);
      if (offset < 0 || size < 0 || offset + size > body.length) bad('Arrow buffer exceeds record body');
      const data = body.subarray(offset, offset + size);
      if (!compression || !size) return data;
      if (size < 8) bad('Arrow compressed buffer has no size prefix');
      const decoded = new Flat(data).i64(0); if (decoded === -1) return data.subarray(8);
      tableLimits(options, decoded);
      const codec = f.scalar(compression, 0, 1); if (codec > 1) bad('Unknown Arrow compression codec');
      return decodeColumnarBlock(codec ? 'zstd' : 'lz4-frame', data.subarray(8), decoded, { signal: options.signal, maxOutputSize: options.maxBytes ?? 536870912 });
    };
    const result: TableValue[][] = [];
    for (let k = 0; k < layout.length; k++) {
      options.signal?.throwIfAborted(); const field = layout[k], node = nodes.start + 16 * k, n = f.i64(node), nulls = f.i64(node + 8);
      if (n !== count || nulls < 0 || nulls > count) bad('Arrow scalar row or null count is invalid');
      if (field.type === 1 && field.dict === undefined) { result.push(new Array<TableValue>(count).fill(null)); continue; }
      const validity = await get(), physical = field.index ?? field;
      if (nulls && validity.length < Math.ceil(count / 8)) bad('Arrow null bitmap is truncated');
      let data: TableValue[];
      if ([4, 5, 19, 20].includes(physical.type)) {
        const offsets = await get(), values = await get(), offsetView = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength), width = physical.type >= 19 ? 8 : 4;
        if (offsets.length < (count + 1) * width) bad('Arrow string offsets are truncated');
        const offset = (i: number) => width === 4 ? offsetView.getInt32(i * 4, little) : Number(offsetView.getBigInt64(i * 8, little));
        data = Array.from({ length: count }, (_, i) => {
          const a = offset(i), b = offset(i + 1); if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a || b > values.length) bad('Arrow string offset is invalid');
          return physical.type === 5 || physical.type === 20 ? new TextDecoder('utf-8', { fatal: true }).decode(values.subarray(a, b)) : hex(values.subarray(a, b));
        });
      } else data = primitive(await get(), physical, count, little);
      const dictionary = field.dict === undefined ? undefined : dictionaries.get(field.dict);
      if (field.dict !== undefined && !dictionary) bad('Arrow dictionary was not sent before its indices');
      let observedNulls = 0;
      for (let i = 0; i < count; i++) {
        if (validity.length && !(validity[i >> 3] & (1 << (i & 7)))) { data[i] = null; observedNulls++; }
        else if (dictionary) { const index = Number(data[i]); if (!Number.isSafeInteger(index) || index < 0 || index >= dictionary.length) bad('Arrow dictionary index is out of bounds'); data[i] = dictionary[index]; }
      }
      if (observedNulls !== nulls) bad('Arrow null count disagrees with bitmap');
      result.push(data);
    }
    if (bufferIndex !== buffers.length) bad('Arrow record has unexpected buffers'); return result;
  };
  while (at < end) {
    options.signal?.throwIfAborted();
    let size = whole.u32(at); at += 4; if (size === 0xffffffff) { size = whole.u32(at); at += 4; }
    if (!size) break;
    if (at + size > end) bad('Arrow message metadata is truncated');
    const f = new Flat(bytes.subarray(at, at + size)), root = f.ref(0), type = f.scalar(root, 1, 1), header = f.table(root, 2), bodySize = f.scalar(root, 3, 8);
    at += size; if (bodySize < 0 || at + bodySize > end) bad('Arrow message body is truncated');
    const body = bytes.subarray(at, at + bodySize); at += bodySize;
    if (type === 1) {
      if (fields) bad('Multiple Arrow schemas in one stream');
      ({ fields, little } = schema(f, header));
      for (const name of options.columns ?? []) if (!fields.some((field) => field.name === name)) bad(`Arrow column ${name} does not exist`);
      for (const field of fields) if (!options.columns || options.columns.includes(field.name)) columns[field.name] = [];
    } else if (type === 2) {
      if (!fields) bad('Arrow dictionary before schema');
      const id = f.scalar(header, 0, 8), field = fields.find((field) => field.dict === id); if (!field) bad('Unknown Arrow dictionary id');
      const layout = { ...field, dict: undefined, index: undefined }, data = (await decode(f, f.table(header, 1), body, [layout]))[0];
      if (f.scalar(header, 2, 1)) { const prior = dictionaries.get(id); if (!prior) bad('Arrow dictionary delta has no base'); dictionaries.set(id, prior.concat(data)); } else dictionaries.set(id, data);
    } else if (type === 3) {
      if (!fields) bad('Arrow record before schema');
      const data = await decode(f, header, body, fields); total += f.scalar(header, 0, 8); tableLimits(options, 0, total);
      fields.forEach((field, k) => { const target = columns[field.name]; if (target) for (const value of data[k]) target.push(value); });
    } else bad(`Unsupported Arrow message ${type}`);
  }
  if (!fields) bad('Arrow schema is missing');
  const result: Record<string, TableColumn> = Object.create(null);
  for (const field of fields) if (columns[field.name]) result[field.name] = scalarColumn(columns[field.name], field.unit, field.bits === 64 && field.type !== 3 ? field.signed ? 'i64' : 'u64' : undefined);
  return new ColumnarTable(result);
}
