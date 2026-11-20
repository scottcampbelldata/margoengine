// Hand-built Arrow IPC and Parquet files for reader edge cases no fixture covers; written from the format specs.
// Minimal FlatBuffers writer for Arrow IPC test streams: tables omit default-valued fields, as writers do.
const out = [];
const u8 = (v) => out.push(v & 255);
const u16 = (v) => { u8(v); u8(v >> 8); };
const u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); };
const i64 = (v) => { u32(Number(BigInt.asUintN(64, BigInt(v)) & 0xffffffffn)); u32(Number(BigInt.asUintN(64, BigInt(v)) >> 32n)); };
const patch = (at, v) => { for (let k = 0; k < 4; k++) out[at + k] = (v >>> (8 * k)) & 255; };
// table: array of [slot, kind, value] with kind 'u8' | 'u16' | 'i64' | 'ref' (value is a writer function).
function table(fields) {
  const slots = fields.length ? Math.max(...fields.map((f) => f[0])) + 1 : 0, vt = out.length;
  u16(4 + slots * 2); u16(4 + fields.length * 8);
  const at = Array(slots).fill(0); fields.forEach((f, k) => (at[f[0]] = 4 + k * 8)); at.forEach(u16);
  const start = out.length; u32(start - vt);
  const refs = [];
  for (const [, kind, value] of fields) {
    const p = out.length;
    if (kind === 'u8') u8(value); else if (kind === 'u16') u16(value); else if (kind === 'i64') i64(value); else refs.push([p, value]);
    while (out.length < p + 8) u8(0);
  }
  for (const [p, write] of refs) { const target = write(); patch(p, target - p); }
  return start;
}
const string = (s) => () => { const p = out.length, b = new TextEncoder().encode(s); u32(b.length); b.forEach(u8); u8(0); return p; };
const tables = (items) => () => {
  const p = out.length; u32(items.length); const slots = items.map(() => { const q = out.length; u32(0); return q; });
  items.forEach((item, k) => patch(slots[k], item() - slots[k])); return p;
};
const structs = (rows) => () => { const p = out.length; u32(rows.length); for (const r of rows) r.forEach(i64); return p; };
const message = (headerType, header, bodyLength) => {
  out.length = 0; u32(0); patch(0, table([[0, 'u16', 4], [1, 'u8', headerType], [2, 'ref', header], [3, 'i64', bodyLength]]));
  while (out.length % 8) u8(0);
  return Uint8Array.from(out);
};
const empty = () => table([]);
const field = (name, type) => () => table([[0, 'ref', string(name)], [1, 'u8', 1], [2, 'u8', type], [3, 'ref', empty]]);
/** Arrow stream with a Time (type 9) and a Duration (type 18) column whose units are left at the schema default. */
export function defaultUnitStream() {
  const schema = message(1, () => table([[1, 'ref', tables([field('t', 9), field('d', 18)])]]), 0);
  const batch = message(3, () => table([[0, 'i64', 1], [1, 'ref', structs([[1, 0], [1, 0]])], [2, 'ref', structs([[0, 0], [0, 8], [8, 0], [8, 8]])]]), 16);
  const body = new Uint8Array(16), view = new DataView(body.buffer); view.setInt32(0, 1500, true); view.setBigInt64(8, 2500n, true);
  const parts = [], frame = (m) => { const h = new DataView(new ArrayBuffer(8)); h.setUint32(0, 0xffffffff, true); h.setUint32(4, m.length, true); parts.push(new Uint8Array(h.buffer), m); };
  frame(schema); frame(batch); parts.push(body, Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 0));
  const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { total.set(p, o); o += p.length; }
  return total;
}
// Minimal Thrift Compact writer for a Parquet file whose optional INT32 columns are all null, as writers emit them:
// column a is DELTA_BINARY_PACKED (its header still written for zero values), column b is RLE_DICTIONARY (an empty
// dictionary page, then the index bit-width byte with no runs).
const varint = (out, v) => { v = BigInt(v); do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; out.push(b); } while (v); };
const zig = (v) => (BigInt(v) << 1n) ^ (BigInt(v) < 0n ? -1n : 0n);
// struct fields: [id, type, value]; types 5 i32, 6 i64, 8 binary, 9 list ([elemType, items]), 12 struct.
function struct(out, fields) {
  let last = 0;
  for (const [id, type, value] of fields) { out.push(((id - last) << 4) | type); last = id; write(out, type, value); }
  out.push(0);
}
function write(out, type, value) {
  if (type === 5 || type === 6) varint(out, zig(value));
  else if (type === 8) { const b = typeof value === 'string' ? new TextEncoder().encode(value) : value; varint(out, b.length); out.push(...b); }
  else if (type === 9) { const [elem, items] = value; out.push((items.length << 4) | elem); for (const item of items) write(out, elem, item); }
  else if (type === 12) struct(out, value);
}
const bytes = (fields) => { const out = []; struct(out, fields); return out; };
export function allNullParquet(levelRun = 3) {
  const file = [...new TextEncoder().encode('PAR1')], rows = 3, chunks = [];
  const definitions = [2, 0, 0, 0, levelRun << 1, 0]; // u32 length 2, then one RLE run of zero levels
  for (const [name, encoding, payload, dictionary] of [['a', 5, [128, 1, 4, 0, 0], false], ['b', 8, [0], true]]) {
    const start = file.length;
    if (dictionary) file.push(...bytes([[1, 5, 2], [2, 5, 0], [3, 5, 0], [7, 12, [[1, 5, 0], [2, 5, 0]]]]));
    const page = [...definitions, ...payload], dataAt = file.length;
    file.push(...bytes([[1, 5, 0], [2, 5, page.length], [3, 5, page.length], [5, 12, [[1, 5, rows], [2, 5, encoding], [3, 5, 3], [4, 5, 3]]]]), ...page);
    chunks.push({ name, start, dataAt, size: file.length - start, dictionary, encoding });
  }
  const meta = bytes([
    [1, 5, 1],
    [2, 9, [12, [[[4, 8, 'schema'], [5, 5, 2]], [[1, 5, 1], [3, 5, 1], [4, 8, 'a']], [[1, 5, 1], [3, 5, 1], [4, 8, 'b']]]]],
    [3, 6, rows],
    [4, 9, [12, [[[1, 9, [12, chunks.map((c) => [[2, 6, c.start], [3, 12, [
      [1, 5, 1], [2, 9, [5, [c.encoding, 3]]], [3, 9, [8, [c.name]]], [4, 5, 0], [5, 6, rows], [6, 6, c.size], [7, 6, c.size], [9, 6, c.dataAt],
      ...(c.dictionary ? [[11, 6, c.start]] : []),
    ]]])]], [2, 6, 0], [3, 6, rows]]]]],
  ]);
  file.push(...meta, meta.length & 255, (meta.length >> 8) & 255, 0, 0, ...new TextEncoder().encode('PAR1'));
  return Uint8Array.from(file);
}
// One required column per annotated byte-array type, each in one PLAIN v1 data page: FLOAT16 (logical 15) on
// FIXED_LEN_BYTE_ARRAY(2), JSON and ENUM by logical type (12, 4) and by converted type (19, 4) on BYTE_ARRAY, and
// UUID (logical 14) on FIXED_LEN_BYTE_ARRAY(16); the bytes follow the Parquet LogicalTypes.md encodings.
export function annotatedParquet(uuidWidth = 16) {
  const utf8 = (s) => [...new TextEncoder().encode(s)], sized = (s) => { const b = utf8(s); return [b.length, 0, 0, 0, ...b]; };
  const uuid = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
  const columns = [
    // 1, -2, 65504 (largest half), 2^-24 (smallest subnormal), -0, Infinity, NaN; little-endian.
    { name: 'h', type: 7, width: 2, schema: [[10, 12, [[15, 12, []]]]], rows: [[0x00, 0x3c], [0x00, 0xc0], [0xff, 0x7b], [0x01, 0x00], [0x00, 0x80], [0x00, 0x7c], [0x00, 0x7e]] },
    { name: 'j', type: 6, schema: [[10, 12, [[12, 12, []]]]], rows: ['{"a":1}', '[1,2]', 'null', '"λ"', '{}', '0', 'true'].map(sized) },
    { name: 'e', type: 6, schema: [[10, 12, [[4, 12, []]]]], rows: ['red', 'green', 'red', 'blue', 'red', 'green', 'red'].map(sized) },
    { name: 'jc', type: 6, schema: [[6, 5, 19]], rows: ['{"b":2}', '[]', '1', '2', '3', '4', '5'].map(sized) },
    { name: 'ec', type: 6, schema: [[6, 5, 4]], rows: ['x', 'y', 'x', 'y', 'x', 'y', 'x'].map(sized) },
    { name: 'u', type: 7, width: uuidWidth, schema: [[10, 12, [[14, 12, []]]]], rows: Array.from({ length: 7 }, (_, i) => [...uuid.slice(0, 15), i]) },
  ];
  const file = [...new TextEncoder().encode('PAR1')], rows = 7, chunks = [];
  for (const c of columns) {
    const page = c.rows.flat(), start = file.length;
    file.push(...bytes([[1, 5, 0], [2, 5, page.length], [3, 5, page.length], [5, 12, [[1, 5, rows], [2, 5, 0], [3, 5, 3], [4, 5, 3]]]]), ...page);
    chunks.push({ ...c, start, size: file.length - start });
  }
  const meta = bytes([
    [1, 5, 1],
    [2, 9, [12, [[[4, 8, 'schema'], [5, 5, columns.length]], ...columns.map((c) => [[1, 5, c.type], ...(c.width ? [[2, 5, c.width]] : []), [3, 5, 0], [4, 8, c.name], ...c.schema].sort((a, b) => a[0] - b[0]))]]],
    [3, 6, rows],
    [4, 9, [12, [[[1, 9, [12, chunks.map((c) => [[2, 6, c.start], [3, 12, [
      [1, 5, c.type], [2, 9, [5, [0]]], [3, 9, [8, [c.name]]], [4, 5, 0], [5, 6, rows], [6, 6, c.size], [7, 6, c.size], [9, 6, c.start],
    ]]])]], [2, 6, 0], [3, 6, rows]]]]],
  ]);
  file.push(...meta, meta.length & 255, (meta.length >> 8) & 255, 0, 0, ...new TextEncoder().encode('PAR1'));
  return Uint8Array.from(file);
}
