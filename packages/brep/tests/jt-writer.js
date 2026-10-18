// A small JT writer for the reader's tests: the file header, TOC, segments and LSG elements as the JT File Format
// Reference (9.5) and ISO 14306 (JT 10) lay them out, with only what the tests need.
import { deflateSync } from 'node:zlib';

export const T = {
  eoe: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  partition: '10dd103e-2ac8-11d1-9b6b-0080c7bb5997',
  group: '10dd101b-2ac8-11d1-9b6b-0080c7bb5997',
  instance: '10dd102a-2ac8-11d1-9b6b-0080c7bb5997',
  part: 'ce357244-38fb-11d1-a506-006097bdc6e1',
  lod: '10dd102c-2ac8-11d1-9b6b-0080c7bb5997',
  switch: '10dd10f3-2ac8-11d1-9b6b-0080c7bb5997',
  triStrip: '10dd1077-2ac8-11d1-9b6b-0080c7bb5997',
  material: '10dd1030-2ac8-11d1-9b6b-0080c7bb5997',
  transform: '10dd1083-2ac8-11d1-9b6b-0080c7bb5997',
  drawStyle: '10dd1014-2ac8-11d1-9b6b-0080c7bb5997',
  string: '10dd106e-2ac8-11d1-9b6b-0080c7bb5997',
  integer: '10dd102b-2ac8-11d1-9b6b-0080c7bb5997',
  date: 'ce357246-38fb-11d1-a506-006097bdc6e1',
  late: 'e0b05be5-fbbd-11d1-a3a7-00aa00d10954',
  xt: '873a70e0-2ac9-11d1-9b6b-0080c7bb5997',
  triStripLOD: '10dd10ab-2ac8-11d1-9b6b-0080c7bb5997',
};

/** Segment IDs of the test files. */
export const SEG = {
  lsg: 'a0000000-0000-0000-0000-000000000001',
  xt: 'a0000000-0000-0000-0000-000000000002',
  lod: 'a0000000-0000-0000-0000-000000000003',
};

/** Little- or big-endian byte builder. */
export class Bytes {
  constructor(little) {
    this.little = little;
    this.chunks = [];
    this.length = 0;
  }
  push(size, write) {
    const b = new Uint8Array(size);
    write(new DataView(b.buffer));
    this.chunks.push(b);
    this.length += size;
    return this;
  }
  u8(v) {
    return this.push(1, (d) => d.setUint8(0, v));
  }
  i16(v) {
    return this.push(2, (d) => d.setInt16(0, v, this.little));
  }
  u16(v) {
    return this.push(2, (d) => d.setUint16(0, v, this.little));
  }
  i32(v) {
    return this.push(4, (d) => d.setInt32(0, v, this.little));
  }
  u32(v) {
    return this.push(4, (d) => d.setUint32(0, v, this.little));
  }
  u64(v) {
    return this.push(8, (d) => d.setBigUint64(0, BigInt(v), this.little));
  }
  f32(...vs) {
    for (const v of vs) this.push(4, (d) => d.setFloat32(0, v, this.little));
    return this;
  }
  guid(s) {
    const h = s.replace(/-/g, '');
    this.u32(Number.parseInt(h.slice(0, 8), 16));
    this.u16(Number.parseInt(h.slice(8, 12), 16));
    this.u16(Number.parseInt(h.slice(12, 16), 16));
    for (let i = 16; i < 32; i += 2) this.u8(Number.parseInt(h.slice(i, i + 2), 16));
    return this;
  }
  mbString(s) {
    this.i32(s.length);
    for (const c of s) this.u16(c.charCodeAt(0));
    return this;
  }
  raw(bytes) {
    this.chunks.push(Uint8Array.from(bytes));
    this.length += bytes.length;
    return this;
  }
  get bytes() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** Repetitive text with a run of noise (exercises long matches and literals when compressed). */
export function note() {
  const words = ['face', 'edge', 'loop', 'shell', 'body', 'vertex', 'curve', 'surface'];
  let x = 12345,
    s = '';
  for (let i = 0; i < 600; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    s += `${words[(x >> 16) % 8]} `;
  }
  for (let i = 0; i < 64; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    s += String.fromCharCode(33 + ((x >> 16) % 90));
  }
  return s + s.slice(0, 900);
}

/**
 * The LSG element stream: a root partition over an assembly group (red material) holding two instances (one moved
 * 10 units along x, one turned a quarter about z and moved 20 along y) of part "Disc", whose LOD node offers two
 * tri-strip shapes; then the property atoms and the property table (names, units, the part's XT B-rep and the first
 * shape's LOD segment).
 */
export function lsgStream({ jt10, little }) {
  const b = new Bytes(little),
    ver = (d) => (jt10 ? d.u8(1) : d.i16(1));
  const element = (type, baseType, id, fill) => {
    const d = new Bytes(little);
    d.guid(type).u8(baseType).i32(id);
    fill(d);
    b.i32(d.length).raw(d.bytes);
  };
  const baseNode = (d, attrs) => {
    ver(d);
    d.u32(0).i32(attrs.length);
    for (const a of attrs) d.i32(a);
  };
  const groupNode = (d, attrs, children) => {
    baseNode(d, attrs);
    ver(d);
    d.i32(children.length);
    for (const c of children) d.i32(c);
  };
  const baseAttr = (d) => {
    ver(d);
    d.u8(0).u32(0);
    if (jt10) d.u32(0);
  };
  const shapeNode = (d) => {
    baseNode(d, []);
    ver(d);
    d.f32(0, 0, 0, 0, 0, 0, -1, -1, -1, 1, 1, 1, 6);
    for (let i = 0; i < 6; i++) d.i32(0);
    d.i32(0).f32(0);
  };
  element(T.partition, 1, 1, (d) => {
    groupNode(d, [], [2]);
    if (jt10) d.u8(0);
    d.i32(0).mbString('').f32(-1, -1, -1, 1, 1, 1, 6);
    for (let i = 0; i < 6; i++) d.i32(0);
  });
  element(T.group, 1, 2, (d) => groupNode(d, [10], [3, 4]));
  element(T.instance, 0, 3, (d) => {
    baseNode(d, [11]);
    ver(d);
    d.i32(5);
  });
  element(T.instance, 0, 4, (d) => {
    baseNode(d, [12]);
    ver(d);
    d.i32(5);
  });
  element(T.part, 1, 5, (d) => {
    groupNode(d, [], [6]);
    ver(d);
    ver(d);
    d.i32(0);
  });
  element(T.lod, 1, 6, (d) => {
    groupNode(d, [], [7, 8]);
    ver(d);
    d.i32(0).i32(0);
  });
  element(T.triStrip, 2, 7, shapeNode);
  element(T.triStrip, 2, 8, shapeNode);
  element(T.material, 3, 10, (d) => {
    baseAttr(d);
    ver(d);
    d.u16(0).f32(0.2, 0.2, 0.2, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 10);
  });
  element(T.transform, 3, 11, (d) => {
    baseAttr(d);
    ver(d);
    d.u16(0x0008).f32(10);
  });
  element(T.transform, 3, 12, (d) => {
    baseAttr(d);
    ver(d);
    // Elements 0, 1, 4, 5 (rows: x to +y, y to -x) and 13 (y translation).
    d.u16(0xcc04).f32(0, 1, -1, 0, 20);
  });
  element(T.drawStyle, 3, 13, (d) => {
    baseAttr(d);
    ver(d);
    d.u8(1);
  });
  b.i32(16).guid(T.eoe);

  const atom = (type, id, fill) =>
    element(type, 5, id, (d) => {
      ver(d);
      d.u32(0);
      ver(d);
      fill(d);
    });
  const str = (id, s) => atom(T.string, id, (d) => d.mbString(s));
  const late = (id, segment, type) =>
    element(T.late, 8, id, (d) => {
      ver(d);
      d.u32(0);
      ver(d);
      d.guid(segment).i32(type).i32(0).i32(1);
    });
  str(20, 'JT_PROP_NAME');
  str(21, 'Assembly;0;1:');
  str(22, 'Disc;0;1:');
  str(23, 'JT_PROP_MEASUREMENT_UNITS');
  str(24, 'millimeters');
  str(25, 'JT_LLPROP_XTBREP');
  late(26, SEG.xt, 17);
  str(27, 'JT_LLPROP_SHAPEIMPL');
  late(28, SEG.lod, 7);
  str(29, 'CAD_COUNT');
  atom(T.integer, 30, (d) => d.i32(42));
  str(31, 'NOTE');
  str(32, note());
  str(33, 'CREATED');
  atom(T.date, 34, (d) => {
    for (const v of [2026, 9, 18, 7, 5, 3]) d.i16(v);
  });
  b.i32(16).guid(T.eoe);

  b.i16(1).i32(3);
  b.i32(2).i32(20).i32(21).i32(23).i32(24).i32(31).i32(32).i32(0);
  b.i32(5).i32(20).i32(22).i32(25).i32(26).i32(29).i32(30).i32(33).i32(34).i32(0);
  b.i32(7).i32(27).i32(28).i32(0);
  return b.bytes;
}

/** The XT B-rep element (Parasolid data `xt`) in the layout of the version. */
export function xtElement({ jt10, little }, xt) {
  const d = new Bytes(little);
  d.guid(T.xt).u8(255).i32(100);
  if (jt10) d.u8(1).u8(0).i32(26).i32(1).i32(0).u32(1);
  else d.i32(2).i32(26).i32(1).i32(0);
  d.i32(xt.length).raw(xt);
  return new Bytes(little).i32(d.length).raw(d.bytes).bytes;
}

/** Jenkins' 1996 hash of bytes, as the format's Appendix D gives it (a byte-wise check on the reader's word-wise one). */
function jenkins(bytes, seed) {
  const s = new Uint32Array([0x9e3779b9, 0x9e3779b9, seed]);
  const mix = () => {
    let [a, b, c] = s;
    a = ((a - b - c) ^ (c >>> 13)) >>> 0;
    b = ((b - c - a) ^ (a << 8)) >>> 0;
    c = ((c - a - b) ^ (b >>> 13)) >>> 0;
    a = ((a - b - c) ^ (c >>> 12)) >>> 0;
    b = ((b - c - a) ^ (a << 16)) >>> 0;
    c = ((c - a - b) ^ (b >>> 5)) >>> 0;
    a = ((a - b - c) ^ (c >>> 3)) >>> 0;
    b = ((b - c - a) ^ (a << 10)) >>> 0;
    c = ((c - a - b) ^ (b >>> 15)) >>> 0;
    s.set([a, b, c]);
  };
  const word = (k) => bytes[k] + bytes[k + 1] * 256 + bytes[k + 2] * 65536 + bytes[k + 3] * 16777216;
  let k = 0;
  for (; bytes.length - k >= 12; k += 12) {
    s[0] += word(k);
    s[1] += word(k + 4);
    s[2] += word(k + 8);
    mix();
  }
  s[2] += bytes.length;
  const tail = bytes.length - k;
  for (let i = tail - 1; i >= 0; i--) {
    const v = bytes[k + i];
    if (i >= 8) s[2] += v * 2 ** (8 * (i - 8 + 1));
    else if (i >= 4) s[1] += v * 2 ** (8 * (i - 4));
    else s[0] += v * 2 ** (8 * i);
  }
  mix();
  return s[2];
}

/** hash32 of the format: the words' little-endian bytes. */
export function hash32(words, seed) {
  const b = new Uint8Array(words.length * 4),
    v = new DataView(b.buffer);
  words.forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  return jenkins(b, seed);
}

/** hash16 of the format (Appendix D hash3): 16-bit values, two to a word, the length counted in values. */
export function hash16(values, seed) {
  const s = new Uint32Array([0x9e3779b9, 0x9e3779b9, seed]),
    n = values.length;
  const mix = () => {
    let [a, b, c] = s;
    a = ((a - b - c) ^ (c >>> 13)) >>> 0;
    b = ((b - c - a) ^ (a << 8)) >>> 0;
    c = ((c - a - b) ^ (b >>> 13)) >>> 0;
    a = ((a - b - c) ^ (c >>> 12)) >>> 0;
    b = ((b - c - a) ^ (a << 16)) >>> 0;
    c = ((c - a - b) ^ (b >>> 5)) >>> 0;
    a = ((a - b - c) ^ (c >>> 3)) >>> 0;
    b = ((b - c - a) ^ (a << 10)) >>> 0;
    c = ((c - a - b) ^ (b >>> 15)) >>> 0;
    s.set([a, b, c]);
  };
  let k = 0;
  for (; n - k >= 6; k += 6) {
    s[0] += values[k] + values[k + 1] * 65536;
    s[1] += values[k + 2] + values[k + 3] * 65536;
    s[2] += values[k + 4] + values[k + 5] * 65536;
    mix();
  }
  s[2] += n;
  const left = n - k;
  if (left >= 5) s[2] += values[k + 4] * 65536;
  if (left >= 4) s[1] += values[k + 3] * 65536;
  if (left >= 3) s[1] += values[k + 2];
  if (left >= 2) s[0] += values[k + 1] * 65536;
  if (left >= 1) s[0] += values[k];
  mix();
  return s[2];
}

/** An Int32 Compressed Data Packet Mk. 2 holding `values` uncoded (null codec). */
function nullPacket(d, values) {
  d.i32(values.length);
  if (!values.length) return;
  d.u8(0)
    .i32(values.length * 32)
    .i32(values.length);
  for (const v of values) d.i32(v);
}

/**
 * An Int32 Compressed Data Packet Mk. 2 arithmetic-coded: `table` lists [value, count] entries, values not in it are
 * escaped (count `escape`) to the out-of-band packet. The encoder is the 16-bit range coder with underflow bits that
 * the format's decoder inverts.
 */
function arithmeticPacket(d, values, table, escape) {
  const entries = [
    ...table.map(([value, count], i) => ({ symbol: i, value, count })),
    { symbol: -2, value: 0, count: escape },
  ];
  let cumulative = 0;
  for (const e of entries) {
    e.cum = cumulative;
    cumulative += e.count;
  }
  const total = cumulative,
    oob = [],
    code = [];
  let low = 0,
    high = 0xffff,
    underflow = 0;
  const emit = (bit) => {
    code.push(bit);
    for (; underflow > 0; underflow--) code.push(bit ^ 1);
  };
  for (const v of values) {
    let e = entries.find((x) => x.symbol !== -2 && x.value === v);
    if (!e) {
      e = entries[entries.length - 1];
      oob.push(v);
    }
    const range = high - low + 1;
    high = low + Math.floor((range * (e.cum + e.count)) / total) - 1;
    low = low + Math.floor((range * e.cum) / total);
    for (;;) {
      if ((high & 0x8000) === (low & 0x8000)) emit(high >> 15);
      else if (low & 0x4000 && !(high & 0x4000)) {
        underflow++;
        low &= 0x3fff;
        high |= 0x4000;
      } else break;
      low = (low << 1) & 0xffff;
      high = ((high << 1) | 1) & 0xffff;
    }
  }
  underflow++;
  emit((low >> 14) & 1);
  const words = [];
  for (let i = 0; i < code.length; i += 32) {
    let w = 0;
    for (let k = 0; k < 32; k++) w = w * 2 + (code[i + k] ?? 0);
    words.push(w);
  }
  d.i32(values.length).u8(3).i32(code.length).i32(words.length);
  for (const w of words) d.u32(w);
  // The context table: bit fields packed most significant bit first.
  const min = Math.min(...entries.map((e) => e.value)),
    bits = [],
    put = (v, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2);
    };
  put(entries.length, 16);
  put(4, 6);
  put(8, 6);
  put(16, 6);
  put(min >>> 0, 32);
  for (const e of entries) {
    put(e.symbol + 2, 4);
    put(e.count, 8);
    put(e.value - min, 16);
  }
  while (bits.length % 8) bits.push(0);
  for (let i = 0; i < bits.length; i += 8) d.u8(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  nullPacket(d, oob);
}

/**
 * A Tri-Strip Set Shape LOD element: a closed tetrahedron on the corners (0,0,0), (1,0,0), (0,1,0), (0,0,1) (in file
 * units), as the JT 9 topology coder writes it: four dual vertices of valence 3 (the triangles, one face group each)
 * and four dual faces of degree 3 (the corners), every packet null-coded. `split` attribute bits per corner give 1
 * vertex record per corner (smooth) or 3 (one per triangle).
 */
export function lodElement({ little }, { split = false } = {}) {
  const d = new Bytes(little),
    mask = split ? 7 : 1;
  d.guid(T.triStripLOD).u8(4).i32(200);
  d.i16(1).i16(1).u64(2); // base shape LOD, vertex shape LOD, bindings: 3-component coordinates
  d.i16(1).i32(201).i16(1); // TopoMesh LOD data, topologically compressed LOD data
  // The decoder asks for the first corner's degree in context 1 (no known neighbours), the other three in context 0.
  const degrees = [[3, 3, 3], [3], [], [], [], [], [], []],
    valences = [3, 3, 3, 3],
    groups = [0, 1, 2, 3],
    flags = [0, 0, 0, 0],
    masks = [[], [mask, mask, mask, mask], [], [], [], [], [], []];
  for (const list of degrees) nullPacket(d, list);
  nullPacket(d, valences);
  nullPacket(d, groups);
  nullPacket(d, flags);
  for (const list of masks) nullPacket(d, list);
  nullPacket(d, []);
  nullPacket(d, []);
  d.i32(0); // high-degree masks
  nullPacket(d, []);
  nullPacket(d, []);
  let h = 0;
  for (const list of degrees) h = hash32(list, h);
  h = hash32(valences, h);
  h = hash32(groups, h);
  h = hash16(flags, h);
  for (const list of masks) h = hash32(list, h);
  for (let i = 0; i < 5; i++) h = hash32([], h);
  d.u32(h);
  // Vertex records: coordinates quantized to 10 bits over [0, 1].
  const records = split ? 12 : 4,
    codes = [
      [0, 1023, 0, 0],
      [0, 0, 1023, 0],
      [0, 0, 0, 1023],
    ];
  d.u64(2).u8(10).u8(0).u8(0).u8(0).i32(4).i32(records);
  d.i32(4).u8(3);
  for (let c = 0; c < 3; c++) d.f32(0, 1).u8(10);
  let hc = 0;
  // x arithmetic-coded (1023 escaped to the out-of-band values), y and z null-coded.
  arithmeticPacket(d, codes[0], [[0, 3]], 1);
  nullPacket(d, codes[1]);
  nullPacket(d, codes[2]);
  for (const list of codes) hc = hash32(list, hc);
  d.u32(hc);
  d.i16(1); // tri-strip set shape LOD version
  return new Bytes(little).i32(d.length).raw(d.bytes).bytes;
}

/** A compressible segment's data: the compression header, then the elements (zlib with `zlib`, else as given). */
export function packed(little, elements, { zlib = false, lzma } = {}) {
  const b = new Bytes(little);
  if (lzma)
    return b
      .i32(3)
      .i32(lzma.length + 1)
      .u8(3)
      .raw(lzma).bytes;
  if (zlib) {
    const z = deflateSync(elements);
    return b
      .i32(2)
      .i32(z.length + 1)
      .u8(2)
      .raw(z).bytes;
  }
  return b.i32(0).i32(0).u8(1).raw(elements).bytes;
}

/** A JT file: header, TOC right after it, then the segments ({ id, type, data }). */
export function jtFile({ version, little }, segments) {
  const jt10 = version >= 10,
    headerLength = 80 + 1 + 4 + (jt10 ? 8 : 4) + 16,
    tocLength = 4 + segments.length * (jt10 ? 32 : 28);
  const text = `Version ${version.toFixed(1)} JT margo test`.padEnd(75, ' ') + ' \n\r\n ';
  const b = new Bytes(little);
  b.raw(Uint8Array.from(text, (c) => c.charCodeAt(0)));
  b.u8(little ? 0 : 1).i32(0);
  if (jt10) b.u64(headerLength);
  else b.u32(headerLength);
  b.guid(SEG.lsg);
  b.i32(segments.length);
  let offset = headerLength + tocLength;
  for (const s of segments) {
    const length = 24 + s.data.length;
    b.guid(s.id);
    if (jt10) b.u64(offset);
    else b.u32(offset);
    b.u32(length).u32(s.type << 24);
    offset += length;
  }
  for (const s of segments)
    b.guid(s.id)
      .i32(s.type)
      .i32(24 + s.data.length)
      .raw(s.data);
  return b.bytes;
}
