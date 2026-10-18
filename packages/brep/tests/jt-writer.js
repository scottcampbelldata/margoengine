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

/** A shape LOD segment's one element (contents not read by the parser yet). */
export function lodElement({ little }) {
  const d = new Bytes(little);
  d.guid(T.triStripLOD).u8(4).i32(200).i32(1).i32(2).i32(3);
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
