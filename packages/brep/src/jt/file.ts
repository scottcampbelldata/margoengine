// JT container, read from the JT File Format Reference (9.5) and ISO 14306 (JT 10): the file header (version string,
// byte order, TOC offset, LSG segment ID), the TOC (segment ID, offset, length, type), data segments (segment header,
// then elements, the whole segment zlib-compressed in JT 9 or LZMA-compressed in JT 10 for the types that allow it),
// and elements (length, object type ID, base type, object ID, data).
//
// This software reads the JT Data Format as described in the Siemens JT File Format Reference and ISO 14306. Copyright
// in the JT data structures and operators is owned by Siemens Product Lifecycle Management Software Inc. (Siemens
// Digital Industries Software) and they are used under the Siemens JT Data Format Reference Intellectual Property
// License Terms. US 8,019,788, US 2011/0199382 and corresponding foreign patents are licensed royalty-free under the
// Siemens JT Data Format Reference Patent Clarification Notice. JT and Parasolid are trademarks of Siemens; they are
// named here only to identify the format. This software is not endorsed by or affiliated with Siemens.
import { inflateZlib } from './inflate.js';
import { inflateLZMA } from './lzma.js';

export const fail = (message: string): never => {
  throw new TypeError(`Invalid JT file: ${message}`);
};

/** Bounds-checked reader over a byte range in the file's byte order. */
export class JTReader {
  at: number;
  private readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    readonly little: boolean,
    at = 0,
    readonly end = bytes.length,
  ) {
    this.at = at;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get left(): number {
    return this.end - this.at;
  }
  need(n: number): number {
    if (n < 0 || this.at + n > this.end) fail(`data ends at byte ${this.end}, ${n} bytes wanted at ${this.at}`);
    const at = this.at;
    this.at += n;
    return at;
  }
  u8(): number {
    return this.bytes[this.need(1)];
  }
  i16(): number {
    return this.view.getInt16(this.need(2), this.little);
  }
  u16(): number {
    return this.view.getUint16(this.need(2), this.little);
  }
  i32(): number {
    return this.view.getInt32(this.need(4), this.little);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), this.little);
  }
  u64(): number {
    const a = this.u32(),
      b = this.u32();
    return this.little ? b * 2 ** 32 + a : a * 2 ** 32 + b;
  }
  f32(): number {
    return this.view.getFloat32(this.need(4), this.little);
  }
  f64(): number {
    return this.view.getFloat64(this.need(8), this.little);
  }
  /** A GUID as lower-case hex `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (U32, two U16, eight U8). */
  guid(): string {
    const hex = (v: number, n: number) => v.toString(16).padStart(n, '0');
    let s = `${hex(this.u32(), 8)}-${hex(this.u16(), 4)}-${hex(this.u16(), 4)}-`;
    for (let i = 0; i < 8; i++) s += (i === 2 ? '-' : '') + hex(this.u8(), 2);
    return s;
  }
  /** A count, checked against the bytes left (`size` bytes per item). */
  count(size: number): number {
    const n = this.i32();
    if (n < 0 || n * size > this.left) fail(`count ${n} at byte ${this.at - 4} runs past the data`);
    return n;
  }
  /** MbString: I32 count, then UTF-16 code units. */
  mbString(): string {
    const n = this.count(2);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s;
  }
  /** String: I32 count, then single-byte characters. */
  string(): string {
    const n = this.count(1),
      at = this.need(n);
    return new TextDecoder('latin1').decode(this.bytes.subarray(at, at + n));
  }
  vecI32(): Int32Array {
    const n = this.count(4),
      out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.i32();
    return out;
  }
  vecU32(): Uint32Array {
    const n = this.count(4),
      out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.u32();
    return out;
  }
  vecF32(): Float32Array {
    const n = this.count(4),
      out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.f32();
    return out;
  }
  f32s(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.f32());
    return out;
  }
  /** A reader over the next `n` bytes; this reader moves past them. */
  sub(n: number): JTReader {
    const at = this.need(n);
    return new JTReader(this.bytes, this.little, at, at + n);
  }
}

/** One TOC entry: a data segment's ID, place in the file and type. */
export interface JTSegment {
  readonly id: string;
  readonly offset: number;
  readonly length: number;
  /** Segment type: 1 LSG, 2 JT B-rep, 3 PMI, 4 meta data, 6 shape, 7-16 shape LODs, 17 XT B-rep, 18 wireframe. */
  readonly type: number;
}

/** One element: object type ID, base type, object ID and its data (a reader positioned after the header). */
export interface JTElement {
  readonly type: string;
  readonly baseType: number;
  readonly id: number;
  readonly data: JTReader;
}

/** The end-of-elements marker's object type ID. */
export const END_OF_ELEMENTS = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** Segment types whose whole data may be compressed (zlib in JT 9, LZMA in JT 10). */
const COMPRESSIBLE = new Set([1, 2, 3, 4, 6, 17, 18, 20, 24]);

/** The file header and table of contents of a JT file. */
export class JTContainer {
  /** Format version, e.g. 9.5 or 10.0. */
  readonly version: number;
  /** The 80-character version string, trimmed. */
  readonly versionText: string;
  readonly little: boolean;
  /** The LSG segment's ID. */
  readonly lsg: string;
  readonly segments: ReadonlyMap<string, JTSegment>;

  constructor(readonly bytes: Uint8Array) {
    if (bytes.length < 128) fail('too short for a file header');
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, 80)),
      match = /^Version (\d+)\.(\d+)/.exec(text);
    if (!match) fail('no "Version M.n" string at the start');
    const [, major, minor] = match as RegExpExecArray;
    this.versionText = text.replace(/[\r\n]/g, ' ').trim();
    this.version = Number(`${major}.${minor}`);
    if (this.version < 9.5)
      throw new RangeError(
        `JT ${major}.${minor} files are not supported: the reader covers JT 9.5 and later (ISO 14306); re-export the file as JT 9.5 or 10`,
      );
    const order = bytes[80];
    if (order !== 0 && order !== 1) fail(`byte order ${order} (0 or 1 expected)`);
    this.little = order === 0;
    const r = new JTReader(bytes, this.little, 81);
    r.i32(); // reserved
    const toc = this.version >= 10 ? r.u64() : r.u32();
    this.lsg = r.guid();
    if (toc + 4 > bytes.length) fail(`TOC offset ${toc} past the end of the file`);
    const t = new JTReader(bytes, this.little, toc),
      n = t.count(this.version >= 10 ? 32 : 28),
      segments = new Map<string, JTSegment>();
    for (let i = 0; i < n; i++) {
      const id = t.guid(),
        offset = this.version >= 10 ? t.u64() : t.u32(),
        length = t.u32(),
        type = t.u32() >>> 24;
      if (offset + length > bytes.length) fail(`segment ${id} (${offset} + ${length} bytes) runs past the file`);
      segments.set(id, { id, offset, length, type });
    }
    this.segments = segments;
    if (!segments.has(this.lsg)) fail(`the LSG segment ${this.lsg} is not in the TOC`);
  }

  /**
   * A segment's element data: a reader at its first element, the whole segment decompressed when it is stored
   * compressed. Throws a TypeError for a segment the TOC does not list or a header that does not match it.
   */
  data(id: string): JTReader {
    const segment = this.segments.get(id) ?? fail(`segment ${id} is not in the TOC`);
    const r = new JTReader(this.bytes, this.little, segment.offset, segment.offset + segment.length),
      header = r.guid(),
      type = r.i32(),
      length = r.i32();
    if (header !== id) fail(`segment at byte ${segment.offset} says it is ${header}, the TOC says ${id}`);
    if (type !== segment.type || length !== segment.length)
      fail(`segment ${id}: header type ${type} / ${length} bytes, TOC type ${segment.type} / ${segment.length} bytes`);
    if (!COMPRESSIBLE.has(type)) return r;
    const flag = r.i32(),
      packed = r.i32(),
      algorithm = r.u8();
    if (!((flag === 2 && algorithm === 2) || (flag === 3 && algorithm === 3))) return r;
    const stream = r.sub(packed - 1),
      input = this.bytes.subarray(stream.at, stream.end),
      inflated = algorithm === 2 ? inflateZlib(input) : inflateLZMA(input);
    return new JTReader(inflated, this.little);
  }
}

/** The next element of `r`, or undefined at an end-of-elements marker (which is read past). */
export function readElement(r: JTReader): JTElement | undefined {
  const length = r.i32(),
    start = r.at;
  if (length < 16 || length > r.left) fail(`element length ${length} at byte ${start - 4}`);
  const type = r.guid();
  if (type === END_OF_ELEMENTS) {
    r.at = start + length;
    return undefined;
  }
  const baseType = r.u8(),
    id = r.i32(),
    data = new JTReader(r.bytes, r.little, r.at, start + length);
  r.at = start + length;
  return { type, baseType, id, data };
}
