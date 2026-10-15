// Native reader for USD Crate (.usdc) layers 0.4-0.12: TOC, tokens, strings, fields, field sets, paths and specs,
// with TfFastCompression (chunked LZ4 blocks) and Usd integer coding. Output matches the USDA spec map shape.
export type Specs = Record<string, { specType: number; fields: Record<string, any> }>;
function fail(message: string): never {
  throw new Error('USD: ' + message);
}
/** Decodes one raw LZ4 block into `out` from `at`; returns the end offset. */
function lz4(src: Uint8Array, out: Uint8Array, at: number): number {
  let p = 0,
    o = at;
  const byte = () => {
    if (p >= src.length) fail('truncated LZ4 block');
    return src[p++];
  };
  const length = (n: number) => {
    if (n === 15)
      for (let b = 255; b === 255; ) {
        b = byte();
        n += b;
      }
    return n;
  };
  while (p < src.length) {
    const token = byte(),
      literal = length(token >> 4);
    if (p + literal > src.length || o + literal > out.length) fail('LZ4 literals overflow');
    out.set(src.subarray(p, p + literal), o);
    p += literal;
    o += literal;
    if (p >= src.length) break;
    const offset = byte() | (byte() << 8),
      match = length(token & 15) + 4;
    if (!offset || offset > o || o + match > out.length) fail('LZ4 match outside output');
    for (let k = 0; k < match; k++, o++) out[o] = out[o - offset];
  }
  return o;
}
/** TfFastCompression: a chunk count byte, then one LZ4 block (count 0) or `count` size-prefixed blocks. */
function inflate(src: Uint8Array, max: number): Uint8Array {
  if (!src.length) fail('empty compressed block');
  const out = new Uint8Array(max),
    chunks = src[0],
    view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (!chunks) return out.subarray(0, lz4(src.subarray(1), out, 0));
  let p = 1,
    o = 0;
  for (let i = 0; i < chunks; i++) {
    if (p + 4 > src.length) fail('truncated LZ4 chunk');
    const size = view.getInt32(p, true);
    if (size < 0 || p + 4 + size > src.length) fail('LZ4 chunk outside block');
    o = lz4(src.subarray(p + 4, p + 4 + size), out, o);
    p += 4 + size;
  }
  return out.subarray(0, o);
}
/** Usd integer coding: common value, 2-bit codes, then 8/16/32-bit (or 16/32/64-bit) deltas. */
function decodeInts(data: Uint8Array, count: number, wide: boolean): number[] {
  const width = wide ? 8 : 4,
    view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    codes = width,
    out = new Array<number>(count);
  let at = codes + ((count * 2 + 7) >> 3),
    previous = 0;
  if (at > data.length) fail('truncated integer codes');
  const common = wide ? Number(view.getBigInt64(0, true)) : view.getInt32(0, true);
  for (let i = 0; i < count; i++) {
    const code = (data[codes + (i >> 2)] >> ((i & 3) * 2)) & 3,
      size = code ? (wide ? 0.5 : 0.25) * (2 << code) : 0;
    if (at + size > data.length) fail('truncated integer values');
    const delta = !code
      ? common
      : size === 1
        ? view.getInt8(at)
        : size === 2
          ? view.getInt16(at, true)
          : size === 4
            ? view.getInt32(at, true)
            : Number(view.getBigInt64(at, true));
    at += size;
    previous = wide ? previous + delta : (previous + delta) | 0;
    out[i] = previous;
  }
  return out;
}
const half = (h: number) => {
  const e = (h >> 10) & 31,
    m = h & 1023,
    s = h & 32768 ? -1 : 1;
  return s * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15));
};
// Element type per Crate type enum: [bytes, reader]. 13-30 are matrices, quaternions and vectors.
const SHAPES: Record<number, [number, string]> = {
  1: [1, 'u8'],
  2: [1, 'u8'],
  3: [1, 'i32'],
  4: [1, 'u32'],
  5: [1, 'i64'],
  6: [1, 'u64'],
  7: [1, 'f16'],
  8: [1, 'f32'],
  9: [1, 'f64'],
  13: [4, 'f64'],
  14: [9, 'f64'],
  15: [16, 'f64'],
  16: [4, 'f64'],
  17: [4, 'f32'],
  18: [4, 'f16'],
  56: [1, 'f64'],
};
for (let t = 19; t <= 30; t++) SHAPES[t] = [Math.floor((t - 19) / 4) + 2, ['f64', 'f32', 'f16', 'i32'][(t - 19) % 4]];
const WIDTH: Record<string, number> = { u8: 1, f16: 2, i32: 4, u32: 4, f32: 4, i64: 8, u64: 8, f64: 8 };
const UNSUPPORTED = new Set([35, 45, 46, 47, 55]),
  SKIPPED = new Set([31, 36, 37, 38, 39, 49, 51, 52, 53, 54]);

export function parseCrate(data: Uint8Array, maxBytes: number): Specs {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    [major, minor] = [data[8], data[9]];
  if (major !== 0 || minor < 4 || minor > 12) fail('unsupported Crate version');
  let p = 0,
    decoded = 0;
  const seek = (offset: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length) fail('Crate offset outside layer');
    p = offset;
  };
  const take = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || p + n > data.length) fail('Crate read outside layer');
    const at = p;
    p += n;
    return at;
  };
  const u32 = () => view.getUint32(take(4), true);
  const u64 = () => {
    const v = view.getBigUint64(take(8), true);
    if (v > BigInt(maxBytes)) fail('Crate count or size exceeds limit');
    return Number(v);
  };
  const budget = (bytes: number) => {
    if ((decoded += bytes) > maxBytes) fail('decoded Crate streams exceed limit');
  };
  const ints = (count: number, wide = false) => {
    const size = u64(),
      width = wide ? 8 : 4;
    budget(count * 8);
    return decodeInts(
      inflate(data.subarray(take(size), p), width + ((count * 2 + 7) >> 3) + count * width),
      count,
      wide,
    );
  };
  // Table of contents.
  seek(Number(view.getBigUint64(16, true)));
  if (view.getBigUint64(p, true) > 32n) fail('too many Crate sections');
  const sections: Record<string, number> = {},
    sectionCount = u64();
  for (let i = 0; i < sectionCount; i++) {
    const name = new TextDecoder().decode(data.subarray(take(16), p)).replace(/\0.*$/s, ''),
      start = u64(),
      size = u64();
    if (start < 24 || size < 8 || start + size > data.length) fail('Crate section outside layer');
    if (view.getBigUint64(start, true) > BigInt(Math.floor(maxBytes / 32))) fail('Crate table exceeds limit');
    sections[name] = start;
  }
  const section = (name: string) => {
    if (sections[name] === undefined) fail('missing Crate section ' + name);
    seek(sections[name]);
  };
  section('TOKENS');
  const tokenCount = u64(),
    rawSize = u64(),
    packedSize = u64(),
    raw = inflate(data.subarray(take(packedSize), p), rawSize);
  const tokens = new TextDecoder().decode(raw).split('\0').slice(0, tokenCount);
  if (tokens.length !== tokenCount) fail('truncated Crate tokens');
  const token = (i: number) => {
    if (!(i >= 0 && i < tokens.length)) fail('token index outside table');
    return tokens[i];
  };
  section('STRINGS');
  const strings = Array.from({ length: u64() }, () => u32()),
    string = (i: number) => token(strings[i] ?? -1);
  section('FIELDS');
  const fieldCount = u64(),
    fieldNames = ints(fieldCount).map(token),
    repBytes = inflate(data.subarray(take(u64()), p), fieldCount * 8);
  if (repBytes.length !== fieldCount * 8) fail('truncated Crate value reps');
  const reps = new DataView(repBytes.buffer, repBytes.byteOffset, repBytes.byteLength);
  section('FIELDSETS');
  const fieldSets = ints(u64());
  section('PATHS');
  const pathCount = u64(),
    encoded = u64(),
    pathIndex = ints(encoded),
    elements = ints(encoded),
    jumps = ints(encoded),
    paths = new Array<string>(pathCount);
  const set = (i: number, path: string) => {
    if (!(pathIndex[i] >= 0 && pathIndex[i] < pathCount)) fail('path index outside table');
    paths[pathIndex[i]] = path;
  };
  // Each entry names its element; jumps say whether it has a child (next entry) and where its next sibling starts.
  for (const stack: [number, string][] = encoded ? [[0, '']] : []; stack.length; ) {
    let [index, parent] = stack.pop()!;
    for (let more = true; more; ) {
      if (index >= encoded) fail('path jump outside table');
      const here = index++,
        element = token(Math.abs(elements[here])),
        path = !parent
          ? '/'
          : elements[here] < 0
            ? parent + '.' + element
            : (parent === '/' ? '' : parent) + '/' + element;
      set(here, path);
      const child = jumps[here] > 0 || jumps[here] === -1,
        sibling = jumps[here] >= 0;
      if (child && sibling) stack.push([here + jumps[here], parent]);
      if (child) parent = path;
      more = child || sibling;
    }
  }
  const pathAt = (i: number) => {
    if (paths[i] === undefined) fail('path index outside table');
    return paths[i];
  };
  // Values.
  function scalars(kind: string, count: number): number[] {
    const width = WIDTH[kind],
      at = take(count * width),
      out = new Array<number>(count);
    budget(count * 8);
    for (let i = 0; i < count; i++) {
      const o = at + i * width;
      out[i] =
        kind === 'f64'
          ? view.getFloat64(o, true)
          : kind === 'f32'
            ? view.getFloat32(o, true)
            : kind === 'f16'
              ? half(view.getUint16(o, true))
              : kind === 'i32'
                ? view.getInt32(o, true)
                : kind === 'u32'
                  ? view.getUint32(o, true)
                  : kind === 'u8'
                    ? data[o]
                    : Number(view.getBigInt64(o, true));
    }
    return out;
  }
  const listOp = (item: () => any) => {
    const header = data[take(1)],
      lists: any[][] = [];
    // Stored as explicit, added, prepended, appended, deleted, ordered; header bits 1, 2, 4, 32, 64, 8, 16.
    for (const bit of [2, 4, 32, 64, 8, 16])
      lists.push(header & bit ? Array.from({ length: u64() }, item) : (undefined as any));
    const [explicit, added, prepended, appended, deleted] = lists;
    return header & 1
      ? (explicit ?? [])
      : [...(prepended ?? []), ...(appended ?? []), ...(added ?? [])].filter((v) => !deleted?.includes(v));
  };
  function value(rep: bigint): any {
    const type = Number((rep >> 48n) & 0xffn),
      array = !!((rep >> 63n) & 1n),
      inline = !!((rep >> 62n) & 1n),
      compressed = !!((rep >> 61n) & 1n),
      payload = Number(rep & 0xffffffffffffn);
    if (UNSUPPORTED.has(type)) fail('composition, animation or unsupported Crate value');
    if (SKIPPED.has(type)) return undefined;
    if (inline) {
      const low = payload >>> 0,
        bytes = [0, 1, 2, 3].map((i) => (((low >> (i * 8)) & 255) << 24) >> 24),
        f = new DataView(new ArrayBuffer(4));
      f.setUint32(0, low);
      if (type === 1) return !!payload;
      if (type === 10) return string(payload);
      if (type === 11 || type === 12) return token(payload);
      if (type === 8 || type === 9) return f.getFloat32(0);
      if (type === 7) return half(low & 65535);
      if (type === 3) return low | 0;
      if (type >= 19 && type <= 30) return bytes.slice(0, SHAPES[type][0]);
      if (type >= 13 && type <= 15) {
        const n = type - 11,
          m = new Array(n * n).fill(0);
        for (let i = 0; i < n; i++) m[i * n + i] = bytes[i];
        return m;
      }
      if (type === 40 || type === 41) return [];
      return payload;
    }
    seek(payload);
    if (type === 40 || type === 41)
      return Array.from({ length: u64() }, () => (type === 40 ? pathAt(u32()) : token(u32())));
    if (type === 50) return Array.from({ length: u64() }, () => string(u32()));
    if (type === 48) return scalars('f64', u64());
    if (type === 34) return listOp(() => pathAt(u32()));
    if (type === 32) return listOp(() => token(u32()));
    if (type === 33) return listOp(() => string(u32()));
    if (type === 42 || type === 43 || type === 44) return u32();
    if (type === 10 || type === 11 || type === 12) {
      const count = array ? (minor < 7 ? u32() : u64()) : 1,
        values = Array.from({ length: count }, () => u32()).map((i) => (type === 10 ? string(i) : token(i)));
      return array ? values : values[0];
    }
    const shape = SHAPES[type];
    if (!shape) return undefined;
    const [size, kind] = shape;
    if (!array) {
      const v = scalars(kind, size);
      return size === 1 ? (type === 1 ? !!v[0] : v[0]) : v;
    }
    const count = minor < 7 ? u32() : u64();
    if (!compressed) return scalars(kind, count * size);
    if (kind === 'i32' || kind === 'u32') return ints(count).map((v) => (kind === 'u32' ? v >>> 0 : v));
    if (kind === 'i64' || kind === 'u64') return ints(count, true);
    const code = String.fromCharCode(data[take(1)]);
    if (code === 'i') return ints(count);
    if (code !== 't') fail('unknown Crate float array encoding');
    const table = scalars(kind, u32()),
      index = ints(count);
    return index.map((i) => {
      if (!(i >= 0 && i < table.length)) fail('float table index outside table');
      return table[i];
    });
  }
  section('SPECS');
  const specCount = u64(),
    specPaths = ints(specCount),
    specSets = ints(specCount),
    specTypes = ints(specCount),
    specs: Specs = {};
  const BLOCKED = [
    'references',
    'payload',
    'timeSamples',
    'subLayers',
    'inheritPaths',
    'specializes',
    'variantSetNames',
    'variantSelection',
  ];
  for (let i = 0; i < specCount; i++) {
    // Null prototype: field names are tokens from the file (a `__proto__` token swapped a plain object's prototype).
    const fields: Record<string, any> = Object.create(null);
    for (let f = specSets[i]; ; f++) {
      if (!(f >= 0 && f < fieldSets.length)) fail('field set outside table');
      const field = fieldSets[f];
      if (field < 0) break;
      if (field >= fieldCount) fail('field index outside table');
      if (BLOCKED.includes(fieldNames[field])) fail('composition and animation are unsupported');
      const v = value(reps.getBigUint64(field * 8, true));
      if (v !== undefined) fields[fieldNames[field]] = v;
    }
    if (specTypes[i] === 6 && fields.specifier !== undefined && fields.specifier !== 0) continue;
    specs[pathAt(specPaths[i])] = { specType: specTypes[i], fields };
  }
  return specs;
}
