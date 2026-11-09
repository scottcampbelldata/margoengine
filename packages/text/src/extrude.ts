// Clean-room OpenType font outline parser, polygon triangulation with holes, and 3D text extrusion.
// Specifications & Papers:
// - ISO/IEC 14496-22 (OpenType specification) / Microsoft OpenType specification (sfnt, head, maxp, hhea, hmtx, cmap, loca, glyf)
// - Adobe Technical Notes #5176 (CFF) and #5177 (Type 2 Charstrings)
// - Eberly, D. (2002), "Triangulation by Ear Clipping", Geometric Tools
import { MargoError } from '@margoengine/math/errors';

/** A 2D point as an [x, y] tuple. */
export type Point2D = [number, number];

/** A draw range sharing one material, in index units. */
export interface GeometryGroup {
  start: number;
  count: number;
  materialIndex: number;
}

/** 3D geometry data with vertex attributes, indices and material groups. */
export interface ExtrudedTextGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups: GeometryGroup[];
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  /** Convert into a @margoengine/core Geometry instance when its constructor is passed; otherwise return attributes. */
  toGeometry<T = unknown>(
    GeometryClass?: new (positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>) => T,
  ):
    | T
    | {
        positions: Float32Array;
        normals: Float32Array;
        uvs: Float32Array;
        indices: Uint32Array;
        groups: GeometryGroup[];
      };
}

/** Minimal font outline provider interface for text extrusion. */
export interface FontLike {
  readonly unitsPerEm: number;
  glyphIndex(char: string): number;
  glyphAdvance(glyphIndex: number): number;
  getGlyphContours(glyphIndex: number, curveSegments?: number): Array<Array<[number, number] | number[]>>;
}

/** Options for text extrusion. Only glyph coordinates and spacing are scaled by `size`; bevels and depth use world units. */
export interface ExtrudeTextOptions {
  /** Font binary buffer (TTF/OTF), parsed FontOutlines, or custom FontLike instance. */
  font: FontOutlines | FontLike | ArrayBuffer | ArrayBufferView;
  /** Font size in world units. Default 1. */
  size?: number;
  /** Extrusion depth along +Z. Default 0.2. */
  depth?: number;
  /** Integer subdivisions per quadratic/cubic Bezier segment, 1..256. Default 12. */
  curveSegments?: number;
  /** Enable bevels on the front and back edges. Default false. */
  bevelEnabled?: boolean;
  /** Depth of the bevel along Z. Default 0.02. */
  bevelThickness?: number;
  /** Extent of the bevel outward in XY. Default 0.02. */
  bevelSize?: number;
  /** Offset of the bevel relative to the outline. Default 0. */
  bevelOffset?: number;
  /** Integer bevel subdivisions, 0..64 (0 or 1 for a flat chamfer). Default 3. */
  bevelSegments?: number;
  /** Integer subdivisions along the extrusion depth, 1..256. Default 1. */
  steps?: number;
  /** Additional spacing between characters in em units. Default 0. */
  letterSpacing?: number;
  /** Line height multiplier for multiline text. Default 1.2. */
  lineHeight?: number;
  /** Text alignment across lines ('left', 'center', 'right'). Default 'left'. */
  align?: 'left' | 'center' | 'right';
}

// ---------------------------------------------------------------------------
// Binary Stream Reader
// ---------------------------------------------------------------------------

const FONT_HELP = 'https://margoengine.com/docs/text';
function fontError(detail: string): never {
  throw new MargoError('failed', `OpenType font ${detail}; provide valid supported font bytes. Help: ${FONT_HELP}`);
}
function subdivision(name: string, value: number, min: number, max = 256): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MargoError(
      'failed',
      `extrudeText ${name} must be an integer from ${min} to ${max}; reduce subdivisions. Help: ${FONT_HELP}`,
    );
  }
  return value;
}
class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;
  constructor(buffer: ArrayBuffer | ArrayBufferView) {
    this.bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  check(pos: number, length: number): void {
    if (
      !Number.isSafeInteger(pos) ||
      !Number.isSafeInteger(length) ||
      pos < 0 ||
      length < 0 ||
      pos > this.length - length
    ) {
      fontError('offset or length exceeds its containing table, glyph or program');
    }
  }
  slice(pos: number, length: number): BinaryReader {
    this.check(pos, length);
    return new BinaryReader(this.bytes.subarray(pos, pos + length));
  }
  seek(pos: number): void {
    this.check(pos, 0);
    this.pos = pos;
  }
  skip(bytes: number): void {
    this.check(this.pos, bytes);
    this.pos += bytes;
  }
  u8(): number {
    this.check(this.pos, 1);
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    this.check(this.pos, 1);
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    this.check(this.pos, 2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.check(this.pos, 2);
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.check(this.pos, 4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.check(this.pos, 4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  tag(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  }
}
type OutlinePoint = { x: number; y: number; onCurve: boolean };

// Numerical character-set data from Adobe Technical Note #5176, Appendix C (GID order).
const cffExpert = [
  0,
  1,
  229,
  230,
  231,
  232,
  233,
  234,
  235,
  236,
  237,
  238,
  13,
  14,
  15,
  99,
  ...Array.from({ length: 10 }, (_, i) => 239 + i),
  27,
  28,
  ...Array.from({ length: 18 }, (_, i) => 249 + i),
  109,
  110,
  ...Array.from({ length: 52 }, (_, i) => 267 + i),
  158,
  155,
  163,
  ...Array.from({ length: 8 }, (_, i) => 319 + i),
  150,
  164,
  169,
  ...Array.from({ length: 52 }, (_, i) => 327 + i),
];
const cffExpertSubset = [
  0,
  1,
  231,
  232,
  235,
  236,
  237,
  238,
  13,
  14,
  15,
  99,
  ...Array.from({ length: 10 }, (_, i) => 239 + i),
  27,
  28,
  249,
  250,
  251,
  ...Array.from({ length: 14 }, (_, i) => 253 + i),
  109,
  110,
  267,
  268,
  269,
  270,
  272,
  300,
  301,
  302,
  305,
  314,
  315,
  158,
  155,
  163,
  ...Array.from({ length: 7 }, (_, i) => 320 + i),
  150,
  164,
  169,
  ...Array.from({ length: 20 }, (_, i) => 327 + i),
];
function standardSID(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) fontError('Type 2 composite character code is invalid');
  if (code >= 32 && code <= 126) return code - 31;
  const ranges = [
    [161, 175, 96],
    [177, 180, 111],
    [182, 189, 115],
    [191, 191, 123],
    [193, 200, 124],
    [202, 203, 132],
    [205, 208, 134],
    [225, 225, 138],
    [227, 227, 139],
    [232, 235, 140],
    [241, 241, 144],
    [245, 245, 145],
    [248, 251, 146],
  ];
  for (const [first, last, sid] of ranges) if (code >= first && code <= last) return sid + code - first;
  return 0;
}

// ---------------------------------------------------------------------------
// OpenType Outline Parser (TrueType & CFF)
// ---------------------------------------------------------------------------

/** Clean-room OpenType font outline reader supporting TrueType (glyf/loca) and PostScript (CFF) glyphs. */
export class FontOutlines {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  private readonly numGlyphs: number;
  private readonly hmtxAdvance: number[];
  private readonly hmtxLsb: number[];
  private readonly cmap: Map<number, number>;
  private readonly locaOffsets?: number[];
  private readonly glyfOffset?: number;
  private readonly cffCharStrings?: Uint8Array[];
  private readonly cffGlobalSubrs?: Uint8Array[];
  private readonly cffLocalSubrs?: Uint8Array[];
  private readonly cffCharset?: number[];
  private readonly cffMatrix: number[] = [0.001, 0, 0, 0.001, 0, 0];
  private readonly reader: BinaryReader;

  constructor(buffer: ArrayBuffer | ArrayBufferView) {
    this.reader = new BinaryReader(buffer);
    const root = this.reader;
    if (root.length < 12) fontError('Font file buffer is too small');
    const version = root.u32();
    if (![0x10000, 0x4f54544f, 0x74727565].includes(version)) fontError('sfnt version is unsupported');
    const count = root.u16();
    root.skip(6);
    root.check(12, count * 16);
    const tables = new Map<string, BinaryReader>();
    for (let i = 0; i < count; i++) {
      const tag = root.tag();
      root.u32();
      const offset = root.u32(),
        length = root.u32();
      if (tables.has(tag)) fontError(`contains duplicate ${tag} tables`);
      tables.set(tag, root.slice(offset, length));
    }
    const table = (tag: string): BinaryReader => tables.get(tag) ?? fontError(`is missing required ${tag} table`);
    const head = table('head');
    head.seek(18);
    this.unitsPerEm = head.u16();
    if (this.unitsPerEm < 16 || this.unitsPerEm > 16384) fontError('unitsPerEm is invalid');
    head.seek(50);
    const locaFormat = head.i16();
    if (locaFormat !== 0 && locaFormat !== 1) fontError('indexToLocFormat is invalid');
    const maxp = table('maxp');
    maxp.seek(4);
    this.numGlyphs = maxp.u16();
    const hhea = table('hhea');
    hhea.seek(4);
    this.ascender = hhea.i16();
    this.descender = hhea.i16();
    hhea.seek(34);
    const metrics = hhea.u16();
    if (metrics < 1 || metrics > this.numGlyphs) fontError('numberOfHMetrics is invalid');
    const hmtx = table('hmtx');
    this.hmtxAdvance = [];
    this.hmtxLsb = [];
    let advance = 0;
    for (let i = 0; i < this.numGlyphs; i++) {
      if (i < metrics) advance = hmtx.u16();
      this.hmtxAdvance.push(advance);
      this.hmtxLsb.push(hmtx.i16());
    }
    this.cmap = new Map();
    this.parseCmap(table('cmap'));
    if (tables.has('glyf')) {
      const glyf = table('glyf'),
        loca = table('loca');
      this.glyfOffset = glyf.bytes.byteOffset - root.bytes.byteOffset;
      this.locaOffsets = [];
      let prev = 0;
      for (let i = 0; i <= this.numGlyphs; i++) {
        const offset = locaFormat === 0 ? loca.u16() * 2 : loca.u32();
        if (offset < prev || offset > glyf.length) fontError('loca range is not monotone or exceeds glyf');
        this.locaOffsets.push(offset);
        prev = offset;
      }
    } else if (tables.has('CFF ')) {
      const parsed = this.parseCFF(table('CFF '));
      this.cffCharStrings = parsed.charStrings;
      this.cffGlobalSubrs = parsed.globalSubrs;
      this.cffLocalSubrs = parsed.localSubrs;
      this.cffCharset = parsed.charset;
      this.cffMatrix = parsed.matrix;
    } else fontError('has no supported glyf or CFF outlines');
  }
  private parseCmap(r: BinaryReader): void {
    if (r.u16() !== 0) fontError('cmap version is invalid');
    const count = r.u16();
    r.check(r.pos, count * 8);
    let selected: BinaryReader | undefined,
      rank = 0;
    for (let i = 0; i < count; i++) {
      const platform = r.u16();
      r.u16();
      const offset = r.u32();
      const sub = r.slice(offset, r.length - offset),
        format = sub.u16();
      if (platform !== 0 && platform !== 3) continue;
      const preference = format === 12 ? 2 : format === 4 ? 1 : 0;
      if (preference > rank) {
        selected = sub;
        rank = preference;
      }
    }
    if (!selected) fontError('cmap has no Unicode format 4 or 12 subtable');
    const sub = selected;
    if (rank === 2) {
      sub.u16();
      const length = sub.u32();
      const data = sub.slice(0, length);
      data.seek(12);
      const groups = data.u32();
      data.check(data.pos, groups * 12);
      let previousEnd = -1;
      for (let i = 0; i < groups; i++) {
        const start = data.u32(),
          end = data.u32(),
          glyph = data.u32();
        if (start > end || end > 0x10ffff || start <= previousEnd || glyph + end - start >= this.numGlyphs)
          fontError('cmap group range is invalid');
        for (let cp = start; cp <= end; cp++) this.cmap.set(cp, glyph + cp - start);
        previousEnd = end;
      }
    } else {
      const length = sub.u16(),
        data = sub.slice(0, length);
      data.seek(6);
      const twice = data.u16();
      if (!twice || twice % 2) fontError('cmap segment count is invalid');
      const n = twice / 2;
      data.skip(6);
      const ends = Array.from({ length: n }, () => data.u16());
      data.u16();
      const starts = Array.from({ length: n }, () => data.u16());
      const deltas = Array.from({ length: n }, () => data.i16());
      const base = data.pos,
        offsets = Array.from({ length: n }, () => data.u16());
      let prev = -1;
      for (let i = 0; i < n; i++) {
        if (starts[i] > ends[i] || starts[i] <= prev) fontError('cmap segments overlap or are reversed');
        for (let cp = starts[i]; cp <= ends[i]; cp++) {
          let glyph = 0;
          if (!offsets[i]) glyph = (cp + deltas[i]) & 0xffff;
          else {
            data.seek(base + i * 2 + offsets[i] + (cp - starts[i]) * 2);
            glyph = data.u16();
            if (glyph) glyph = (glyph + deltas[i]) & 0xffff;
          }
          if (glyph >= this.numGlyphs) fontError('cmap references a missing glyph');
          if (glyph) this.cmap.set(cp, glyph);
        }
        prev = ends[i];
      }
    }
  }
  private parseCFF(r: BinaryReader) {
    if (r.u8() !== 1) fontError('CFF version is unsupported');
    r.u8();
    const headerSize = r.u8(),
      offSize = r.u8();
    if (headerSize < 4 || offSize < 1 || offSize > 4) fontError('CFF header is invalid');
    r.seek(headerSize);
    const names = this.readCFFIndex(r),
      topItems = this.readCFFIndex(r);
    if (names.length !== 1 || topItems.length !== 1) fontError('CFF FontSet must contain one font');
    const top = this.parseCFFDict(topItems[0]);
    if (top.has(0x0c1e) || top.has(0x0c24) || top.has(0x0c25)) fontError('CID-keyed CFF is unsupported');
    if (top.has(0x0c14)) fontError('synthetic CFF is unsupported');
    if (top.has(0x0c06) && top.get(0x0c06) !== 2) fontError('CFF CharstringType must be 2');
    const matrix = top.get(0x0c07) ?? [0.001, 0, 0, 0.001, 0, 0];
    if (!Array.isArray(matrix) || matrix.length !== 6 || matrix.some((v) => !Number.isFinite(v)))
      fontError('CFF FontMatrix is invalid');
    this.readCFFIndex(r);
    const globalSubrs = this.readCFFIndex(r);
    const charOffset = top.get(17);
    if (typeof charOffset !== 'number') fontError('CFF CharStrings offset is missing');
    r.seek(charOffset);
    const charStrings = this.readCFFIndex(r);
    if (charStrings.length !== this.numGlyphs) fontError('CFF CharStrings count differs from maxp');
    const charsetOffset = top.get(15) ?? 0;
    if (typeof charsetOffset !== 'number') fontError('CFF charset offset is invalid');
    let charset: number[];
    if (charsetOffset <= 2) {
      const preset =
        charsetOffset === 0
          ? Array.from({ length: 229 }, (_, i) => i)
          : charsetOffset === 1
            ? cffExpert
            : cffExpertSubset;
      if (!Number.isInteger(charsetOffset) || charsetOffset < 0 || charStrings.length > preset.length)
        fontError('CFF predefined charset is invalid');
      charset = preset.slice(0, charStrings.length);
    } else {
      r.seek(charsetOffset);
      const format = r.u8();
      charset = [0];
      if (format > 2) fontError('CFF charset format is invalid');
      while (charset.length < charStrings.length) {
        const first = r.u16(),
          left = format === 0 ? 0 : format === 1 ? r.u8() : r.u16();
        if (charset.length + left + 1 > charStrings.length || first + left > 65535)
          fontError('CFF charset range is invalid');
        for (let i = 0; i <= left; i++) charset.push(first + i);
      }
    }
    if (new Set(charset).size !== charset.length) fontError('CFF charset contains duplicate SIDs');
    let localSubrs: Uint8Array[] = [];
    const priv = top.get(18);
    if (priv !== undefined) {
      if (!Array.isArray(priv) || priv.length !== 2) fontError('CFF Private DICT range is invalid');
      const [length, offset] = priv;
      const dict = this.parseCFFDict(r.slice(offset, length).bytes);
      if (dict.has(19)) {
        const rel = dict.get(19);
        if (typeof rel !== 'number') fontError('CFF Subrs offset is invalid');
        r.seek(offset + rel);
        localSubrs = this.readCFFIndex(r);
      }
    }
    return { charStrings, globalSubrs, localSubrs, charset, matrix };
  }
  private readCFFIndex(r: BinaryReader): Uint8Array[] {
    const count = r.u16();
    if (!count) return [];
    const size = r.u8();
    if (size < 1 || size > 4) fontError('CFF INDEX offSize is invalid');
    r.check(r.pos, (count + 1) * size);
    const offsets = Array.from({ length: count + 1 }, () => {
      let offset = 0;
      for (let j = 0; j < size; j++) offset = offset * 256 + r.u8();
      return offset;
    });
    if (offsets[0] !== 1) fontError('CFF INDEX first offset is invalid');
    const start = r.pos,
      items: Uint8Array[] = [];
    for (let i = 0; i < count; i++) items.push(r.slice(start + offsets[i] - 1, offsets[i + 1] - offsets[i]).bytes);
    r.seek(start + offsets[count] - 1);
    return items;
  }
  private parseCFFDict(bytes: Uint8Array): Map<number, number | number[]> {
    const r = new BinaryReader(bytes),
      dict = new Map<number, number | number[]>(),
      stack: number[] = [];
    while (r.pos < r.length) {
      const b = r.u8();
      if (b <= 21) {
        const op = b === 12 ? 0x0c00 + r.u8() : b;
        dict.set(op, stack.length === 1 ? stack[0] : [...stack]);
        stack.length = 0;
      } else if (b === 28) stack.push(r.i16());
      else if (b === 29) stack.push(r.i32());
      else if (b >= 32 && b <= 246) stack.push(b - 139);
      else if (b >= 247 && b <= 250) stack.push((b - 247) * 256 + r.u8() + 108);
      else if (b >= 251 && b <= 254) stack.push(-(b - 251) * 256 - r.u8() - 108);
      else if (b === 30) {
        let value = '',
          done = false;
        while (!done) {
          const byte = r.u8();
          for (const n of [byte >> 4, byte & 15]) {
            if (n === 15) {
              done = true;
              break;
            }
            if (n === 13) fontError('CFF DICT real has a reserved nibble');
            value += n < 10 ? String(n) : n === 10 ? '.' : n === 11 ? 'E' : n === 12 ? 'E-' : '-';
          }
        }
        const v = Number(value);
        if (!Number.isFinite(v)) fontError('CFF DICT real is invalid');
        stack.push(v);
      } else fontError('CFF DICT number is invalid');
      if (stack.length > 48) fontError('CFF DICT operand stack exceeds 48');
    }
    if (stack.length) fontError('CFF DICT has trailing operands');
    return dict;
  }

  /** Resolves Unicode code point or 1-character string to a glyph index. */
  glyphIndex(charOrCode: string | number): number {
    const cp = typeof charOrCode === 'string' ? (charOrCode.codePointAt(0) ?? 0) : charOrCode;
    return this.cmap.get(cp) ?? 0;
  }

  /** Returns advance width for glyph index, normalized to 1 em. */
  glyphAdvance(glyphIndex: number): number {
    const raw = this.hmtxAdvance[glyphIndex] ?? this.unitsPerEm;
    return raw / this.unitsPerEm;
  }

  /** Extracts 2D contours for a glyph index, normalized to em coordinates (including negative bearings). */
  getGlyphContours(glyphIndex: number, curveSegments = 12): Point2D[][] {
    subdivision('curveSegments', curveSegments, 1);
    if (!Number.isInteger(glyphIndex) || glyphIndex < 0 || glyphIndex >= this.numGlyphs) return [];
    if (this.locaOffsets && this.glyfOffset !== undefined) {
      return this.getTrueTypeContours(glyphIndex, curveSegments);
    }
    if (this.cffCharStrings) {
      const [a, b, c, d, tx, ty] = this.cffMatrix;
      const contours = this.getCFFContours(glyphIndex, curveSegments);
      if (contours.reduce((n, loop) => n + loop.length, 0) > 16384) fontError('flattened glyph exceeds 16384 vertices');
      return contours.map((loop) => loop.map(([x, y]): Point2D => [a * x + c * y + tx, b * x + d * y + ty]));
    }
    return [];
  }

  private getTrueTypeContours(glyphIndex: number, curveSegments: number): Point2D[][] {
    const raw = this.readTrueTypeGlyph(glyphIndex, [], { points: 0, components: 0 });
    let count = 0;
    return raw
      .map((loop) => {
        const result = this.flattenTrueTypeContour(loop, curveSegments);
        count += result.length;
        if (count > 16384) fontError('flattened glyph exceeds 16384 vertices');
        return result;
      })
      .filter((loop) => loop.length >= 3);
  }
  private readTrueTypeGlyph(
    glyph: number,
    ancestors: number[],
    work: { points: number; components: number },
  ): OutlinePoint[][] {
    if (!Number.isInteger(glyph) || glyph < 0 || glyph >= this.numGlyphs)
      fontError('composite references a missing glyph');
    if (ancestors.includes(glyph) || ancestors.length >= 32) fontError('composite cycle or depth exceeds 32');
    const start = this.locaOffsets![glyph],
      end = this.locaOffsets![glyph + 1];
    if (start === end) return [];
    const r = this.reader.slice(this.glyfOffset! + start, end - start);
    const count = r.i16();
    r.skip(8);
    if (count >= 0) {
      const ends = Array.from({ length: count }, () => r.u16());
      let prev = -1;
      for (const endpoint of ends) {
        if (endpoint <= prev) fontError('glyf contour endpoints are not increasing');
        prev = endpoint;
      }
      r.skip(r.u16());
      const n = count ? ends[count - 1] + 1 : 0;
      work.points += n;
      if (work.points > 200000) fontError('composite point budget exceeds 200000');
      const flags: number[] = [];
      while (flags.length < n) {
        const flag = r.u8();
        flags.push(flag);
        if (flag & 8) {
          const repeat = r.u8();
          if (flags.length + repeat > n) fontError('glyf flag repeats exceed point count');
          for (let j = 0; j < repeat; j++) flags.push(flag);
        }
      }
      const coords: number[][] = [];
      for (let axis = 0; axis < 2; axis++) {
        let value = 0;
        const values: number[] = [];
        for (const flag of flags) {
          const short = flag & (axis ? 4 : 2),
            positive = flag & (axis ? 32 : 16);
          value += short ? (positive ? 1 : -1) * r.u8() : positive ? 0 : r.i16();
          values.push(value);
        }
        coords.push(values);
      }
      let index = 0;
      return ends.map((endpoint) => {
        const loop: OutlinePoint[] = [];
        while (index <= endpoint) {
          loop.push({ x: coords[0][index], y: coords[1][index], onCurve: !!(flags[index] & 1) });
          index++;
        }
        return loop;
      });
    }
    if (count !== -1) fontError('glyf contour count is invalid');
    const contours: OutlinePoint[][] = [],
      parentPoints: OutlinePoint[] = [];
    let flags = 0;
    do {
      if (++work.components > 4096) fontError('composite component budget exceeds 4096');
      flags = r.u16();
      const child = r.u16(),
        xy = !!(flags & 2),
        words = !!(flags & 1);
      const arg = () => (words ? (xy ? r.i16() : r.u16()) : xy ? r.i8() : r.u8());
      const arg1 = arg(),
        arg2 = arg();
      let a = 1,
        b = 0,
        c = 0,
        d = 1;
      if (flags & 8) {
        a = r.i16() / 16384;
        d = a;
      } else if (flags & 64) {
        a = r.i16() / 16384;
        d = r.i16() / 16384;
      } else if (flags & 128) {
        a = r.i16() / 16384;
        b = r.i16() / 16384;
        c = r.i16() / 16384;
        d = r.i16() / 16384;
      }
      if ((flags & 0x1800) === 0x1800) fontError('composite offset flags conflict');
      const loops = this.readTrueTypeGlyph(child, [...ancestors, glyph], work).map((loop) =>
        loop.map((p) => ({
          x: a * p.x + c * p.y,
          y: b * p.x + d * p.y,
          onCurve: p.onCurve,
        })),
      );
      const childPoints = loops.flat();
      let tx = arg1,
        ty = arg2;
      if (xy) {
        if (flags & 0x800) {
          tx = a * arg1 + c * arg2;
          ty = b * arg1 + d * arg2;
        }
        if (flags & 4) {
          tx = Math.round(tx);
          ty = Math.round(ty);
        }
      } else {
        const parent = parentPoints[arg1],
          point = childPoints[arg2];
        if (!parent || !point) fontError('composite point attachment index is invalid');
        tx = parent.x - point.x;
        ty = parent.y - point.y;
      }
      for (const loop of loops) {
        for (const point of loop) {
          point.x += tx;
          point.y += ty;
        }
        contours.push(loop);
        parentPoints.push(...loop);
      }
    } while (flags & 32);
    if (flags & 256) r.skip(r.u16());
    return contours;
  }
  private flattenTrueTypeContour(points: OutlinePoint[], segments: number): Point2D[] {
    // Materialize every implied midpoint before walking the curve. A control point is never a curve start.
    const expanded: OutlinePoint[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length];
      expanded.push(a);
      if (!a.onCurve && !b.onCurve) expanded.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, onCurve: true });
    }
    const start = expanded.findIndex((p) => p.onCurve);
    if (start < 0) return [];
    const ordered = [...expanded.slice(start), ...expanded.slice(0, start)];
    ordered.push(ordered[0]);
    const out: Point2D[] = [[ordered[0].x / this.unitsPerEm, ordered[0].y / this.unitsPerEm]];
    let i = 1,
      current = ordered[0];
    while (i < ordered.length) {
      if (out.length > 16384) fontError('flattened glyph exceeds 16384 vertices');
      const next = ordered[i++];
      if (next.onCurve) {
        out.push([next.x / this.unitsPerEm, next.y / this.unitsPerEm]);
        current = next;
      } else {
        const end = ordered[i++];
        if (out.length + segments > 16385) fontError('flattened glyph exceeds 16384 vertices');
        for (let j = 1; j <= segments; j++) {
          const t = j / segments,
            u = 1 - t;
          out.push([
            (u * u * current.x + 2 * u * t * next.x + t * t * end.x) / this.unitsPerEm,
            (u * u * current.y + 2 * u * t * next.y + t * t * end.y) / this.unitsPerEm,
          ]);
        }
        current = end;
      }
    }
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  }

  private getCFFContours(glyphIndex: number, curveSegments: number, component = false): Point2D[][] {
    const charString = this.cffCharStrings?.[glyphIndex];
    if (!charString) return [];
    const contours: Point2D[][] = [],
      stack: number[] = [],
      transient = new Array<number>(32).fill(0);
    let loop: Point2D[] = [],
      x = 0,
      y = 0,
      widthSeen = false,
      stems = 0,
      ended = false,
      operations = 0,
      seed = 1,
      outputPoints = 0;
    const finish = () => {
      if (loop.length >= 3) contours.push(loop);
      loop = [];
    };
    const pop = (): number => (stack.length ? stack.pop()! : fontError('Type 2 operand stack underflow'));
    const need = (n: number) => {
      if (stack.length !== n) fontError('Type 2 operator operand count is invalid');
    };
    const width = (n: number, hints = false) => {
      if (!widthSeen) {
        if (hints ? stack.length % 2 === 1 : stack.length === n + 1) stack.shift();
        widthSeen = true;
      }
    };
    const line = (dx: number, dy: number) => {
      if (++outputPoints > 16384) fontError('flattened glyph exceeds 16384 vertices');
      x += dx;
      y += dy;
      loop.push([x, y]);
    };
    const curve = (dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) => {
      outputPoints += curveSegments;
      if (outputPoints > 16384) fontError('flattened glyph exceeds 16384 vertices');
      const x0 = x,
        y0 = y,
        x1 = x + dx1,
        y1 = y + dy1,
        x2 = x1 + dx2,
        y2 = y1 + dy2;
      x = x2 + dx3;
      y = y2 + dy3;
      for (let j = 1; j <= curveSegments; j++) {
        const t = j / curveSegments,
          u = 1 - t;
        loop.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        ]);
      }
    };
    const execute = (bytes: Uint8Array, depth: number): void => {
      if (depth > 10) fontError('Type 2 subroutine depth exceeds 10');
      const r = new BinaryReader(bytes);
      while (r.pos < r.length && !ended) {
        if (++operations > 100000) fontError('Type 2 execution budget exceeds 100000');
        const b = r.u8();
        if (b === 28) stack.push(r.i16());
        else if (b >= 32 && b <= 246) stack.push(b - 139);
        else if (b >= 247 && b <= 250) stack.push((b - 247) * 256 + r.u8() + 108);
        else if (b >= 251 && b <= 254) stack.push(-(b - 251) * 256 - r.u8() - 108);
        else if (b === 255) stack.push(r.i32() / 65536);
        else if (b === 10 || b === 29) {
          const subrs = (b === 10 ? this.cffLocalSubrs : this.cffGlobalSubrs) ?? [];
          const index = pop() + (subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768);
          if (!Number.isInteger(index) || !subrs[index]) fontError('Type 2 subroutine index is invalid');
          execute(subrs[index], depth + 1);
        } else if (b === 11) {
          if (!depth) fontError('Type 2 return outside a subroutine');
          return;
        } else if (b === 1 || b === 3 || b === 18 || b === 23 || b === 19 || b === 20) {
          width(0, true);
          if (stack.length % 2) fontError('Type 2 stem operand count is invalid');
          if (b !== 19 && b !== 20 && stack.length < 2) fontError('Type 2 stem requires at least one pair');
          stems += stack.length / 2;
          stack.length = 0;
          if (stems > 96) fontError('Type 2 hint count exceeds 96');
          if (b === 19 || b === 20) {
            if (!stems) fontError('Type 2 mask requires stem hints');
            r.skip(Math.ceil(stems / 8));
          }
        } else if (b === 4 || b === 21 || b === 22) {
          const count = b === 21 ? 2 : 1;
          width(count);
          need(count);
          finish();
          line(b === 4 ? 0 : stack[0], b === 22 ? 0 : stack[count - 1]);
          stack.length = 0;
        } else if (b === 14) {
          width(stack.length >= 4 ? 4 : 0);
          if (stack.length === 4) {
            if (component || loop.length || contours.length)
              fontError('Type 2 endchar composites cannot be nested or contain a path');
            const [dx, dy, base, accent] = stack;
            const resolve = (code: number) => {
              const sid = standardSID(code),
                index = this.cffCharset!.indexOf(sid);
              if (!sid || index < 0) fontError('Type 2 composite component is missing from charset');
              return this.getCFFContours(index, curveSegments, true);
            };
            contours.push(
              ...resolve(base),
              ...resolve(accent).map((c) => c.map(([x, y]): Point2D => [x + dx, y + dy])),
            );
          } else if (stack.length) fontError('Type 2 endchar operand count is invalid');
          finish();
          ended = true;
        } else if (b === 12) {
          const op = r.u8();
          if (op >= 34 && op <= 37 && !loop.length) fontError('Type 2 flex requires moveto');
          if (op === 34) {
            need(7);
            const [a, b, c, d, e, f, g] = stack;
            curve(a, 0, b, c, d, 0);
            curve(e, 0, f, -c, g, 0);
            stack.length = 0;
          } else if (op === 35) {
            need(13);
            curve(...(stack.slice(0, 6) as [number, number, number, number, number, number]));
            curve(...(stack.slice(6, 12) as [number, number, number, number, number, number]));
            stack.length = 0;
          } else if (op === 36) {
            need(9);
            const [a, b, c, d, e, f, g, h, i] = stack;
            curve(a, b, c, d, e, 0);
            curve(f, 0, g, h, i, -b - d - h);
            stack.length = 0;
          } else if (op === 37) {
            need(11);
            const v = [...stack],
              sx = v[0] + v[2] + v[4] + v[6] + v[8],
              sy = v[1] + v[3] + v[5] + v[7] + v[9];
            curve(...(v.slice(0, 6) as [number, number, number, number, number, number]));
            curve(
              v[6],
              v[7],
              v[8],
              v[9],
              Math.abs(sx) > Math.abs(sy) ? v[10] : -sx,
              Math.abs(sx) > Math.abs(sy) ? -sy : v[10],
            );
            stack.length = 0;
          } else if (op === 0) {
            /* Deprecated dotsection has no effect on outlines. */
          } else if (op === 18) pop();
          else if (op === 27) {
            const a = pop();
            stack.push(a, a);
          } else if (op === 28) {
            const b = pop(),
              a = pop();
            stack.push(b, a);
          } else if (op === 29) {
            const i = Math.max(0, Math.trunc(pop()));
            if (!stack.length) fontError('Type 2 index underflow');
            stack.push(stack[Math.max(0, stack.length - 1 - i)]);
          } else if (op === 30) {
            const j = pop(),
              n = pop();
            if (!Number.isInteger(n) || !Number.isInteger(j) || n < 0 || n > stack.length)
              fontError('Type 2 roll range is invalid');
            if (n) {
              const a = stack.splice(stack.length - n),
                k = ((j % n) + n) % n;
              stack.push(...a.slice(n - k), ...a.slice(0, n - k));
            }
          } else if (op === 20 || op === 21) {
            const i = pop();
            if (!Number.isInteger(i) || i < 0 || i >= 32) fontError('Type 2 transient index is invalid');
            if (op === 20) transient[i] = pop();
            else stack.push(transient[i]);
          } else if (op === 22) {
            const v2 = pop(),
              v1 = pop(),
              s2 = pop(),
              s1 = pop();
            stack.push(v1 <= v2 ? s1 : s2);
          } else if (op === 23) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            stack.push((seed + 1) / 4294967296);
          } else if ([5, 9, 14, 26].includes(op)) {
            const a = pop();
            stack.push(op === 5 ? Number(!a) : op === 9 ? Math.abs(a) : op === 14 ? -a : Math.sqrt(a));
          } else if ([3, 4, 10, 11, 12, 15, 24].includes(op)) {
            const b = pop(),
              a = pop();
            stack.push(
              op === 3
                ? Number(!!a && !!b)
                : op === 4
                  ? Number(!!a || !!b)
                  : op === 10
                    ? a + b
                    : op === 11
                      ? a - b
                      : op === 12
                        ? a / b
                        : op === 15
                          ? Number(a === b)
                          : a * b,
            );
          } else fontError(`Type 2 escaped operator ${op} is unsupported`);
        } else {
          const v = [...stack],
            n = v.length;
          stack.length = 0;
          const valid = (ok: boolean) => {
            if (!ok) fontError(`Type 2 operator ${b} operand count is invalid`);
          };
          if (!loop.length) fontError('Type 2 path must begin with moveto');
          if (b === 5) {
            valid(n >= 2 && n % 2 === 0);
            for (let i = 0; i < n; i += 2) line(v[i], v[i + 1]);
          } else if (b === 6 || b === 7) {
            valid(n >= 1);
            for (let i = 0; i < n; i++)
              line((i % 2 === 0) === (b === 6) ? v[i] : 0, (i % 2 === 0) === (b === 7) ? v[i] : 0);
          } else if (b === 8) {
            valid(n >= 6 && n % 6 === 0);
            for (let i = 0; i < n; i += 6)
              curve(...(v.slice(i, i + 6) as [number, number, number, number, number, number]));
          } else if (b === 24) {
            valid(n >= 8 && (n - 2) % 6 === 0);
            for (let i = 0; i < n - 2; i += 6)
              curve(...(v.slice(i, i + 6) as [number, number, number, number, number, number]));
            line(v[n - 2], v[n - 1]);
          } else if (b === 25) {
            valid(n >= 8 && (n - 6) % 2 === 0);
            for (let i = 0; i < n - 6; i += 2) line(v[i], v[i + 1]);
            curve(...(v.slice(n - 6) as [number, number, number, number, number, number]));
          } else if (b === 26 || b === 27) {
            valid(n >= 4 && (n % 4 === 0 || n % 4 === 1));
            let i = n % 4,
              extra = i ? v[0] : 0;
            for (; i < n; i += 4) {
              if (b === 27) curve(v[i], extra, v[i + 1], v[i + 2], v[i + 3], 0);
              else curve(extra, v[i], v[i + 1], v[i + 2], 0, v[i + 3]);
              extra = 0;
            }
          } else if (b === 30 || b === 31) {
            valid(n >= 4 && (n % 4 === 0 || n % 4 === 1));
            let horizontal = b === 31,
              i = 0;
            while (i < n) {
              const last = n - i === 5,
                extra = last ? v[i + 4] : 0;
              if (horizontal) curve(v[i], 0, v[i + 1], v[i + 2], extra, v[i + 3]);
              else curve(0, v[i], v[i + 1], v[i + 2], v[i + 3], extra);
              i += last ? 5 : 4;
              horizontal = !horizontal;
            }
          } else fontError(`Type 2 operator ${b} is unsupported`);
        }
        if (stack.length > 48 || stack.some((v) => !Number.isFinite(v)) || !Number.isFinite(x) || !Number.isFinite(y))
          fontError('Type 2 operand stack is invalid or exceeds 48');
      }
      if (!ended) fontError(depth ? 'Type 2 subroutine is missing return' : 'Type 2 charstring is missing endchar');
    };
    execute(charString, 0);
    return contours;
  }
}

// ---------------------------------------------------------------------------
// 2D Polygon Triangulation with Holes (Ear Clipping & Seam Cuts)
// ---------------------------------------------------------------------------

/** Computes the signed shoelace area of a 2D loop. Positive values are counter-clockwise, negative clockwise. */
export function polygonArea(loop: readonly Point2D[]): number {
  if (loop.length < 3) return 0;
  let area = 0;
  const [x, y] = loop[0];
  for (let i = 1; i < loop.length - 1; i++)
    area += (loop[i][0] - x) * (loop[i + 1][1] - y) - (loop[i][1] - y) * (loop[i + 1][0] - x);
  return area / 2;
}

/** Tests whether a 2D point lies inside a polygon loop using ray casting. */
export function pointInPolygon(point: Point2D, loop: readonly Point2D[]): boolean {
  const [x, y] = point;
  let inside = false;
  const n = loop.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = loop[i][0];
    const yi = loop[i][1];
    const xj = loop[j][0];
    const yj = loop[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

interface PolygonShape {
  outer: Point2D[];
  holes: Point2D[][];
}

/** Classifies loops into outer boundaries and nested holes by point-in-polygon containment. */
export function classifyLoops(loops: readonly (readonly Point2D[])[]): PolygonShape[] {
  const clean = loops
    .map((loop) => loop.filter((p, i) => !samePoint(p, loop[(i + loop.length - 1) % loop.length])))
    .filter((loop) => loop.length >= 3);
  if (!clean.length) return [];
  const points = clean.flat();
  if (points.length > 16384 || points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
    polygonError('outline exceeds 16384 vertices or contains nonfinite coordinates');
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const scale = Math.max(maxX - minX, maxY - minY);
  if (!scale) return [];
  // Operate in glyph-relative coordinates so a legal small font has exactly the same topology.
  const normalized = clean.map((loop) => loop.map(([x, y]): Point2D => [(x - minX) / scale, (y - minY) / scale]));
  type Edge = { a: Point2D; b: Point2D; cuts: number[] };
  const edges: Edge[] = normalized.flatMap((loop) =>
    loop.map((a, i) => ({ a, b: loop[(i + 1) % loop.length], cuts: [0, 1] })),
  );
  const cut = (edge: Edge, t: number) => {
    if (t > 0 && t < 1) edge.cuts.push(t);
  };
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i],
        f = edges[j];
      if (
        Math.max(e.a[0], e.b[0]) < Math.min(f.a[0], f.b[0]) ||
        Math.max(f.a[0], f.b[0]) < Math.min(e.a[0], e.b[0]) ||
        Math.max(e.a[1], e.b[1]) < Math.min(f.a[1], f.b[1]) ||
        Math.max(f.a[1], f.b[1]) < Math.min(e.a[1], e.b[1])
      )
        continue;
      const ex = e.b[0] - e.a[0],
        ey = e.b[1] - e.a[1],
        fx = f.b[0] - f.a[0],
        fy = f.b[1] - f.a[1];
      const dx = f.a[0] - e.a[0],
        dy = f.a[1] - e.a[1],
        den = ex * fy - ey * fx;
      if (den !== 0) {
        const t = (dx * fy - dy * fx) / den,
          u = (dx * ey - dy * ex) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          cut(e, t);
          cut(f, u);
        }
      } else if (dx * ey - dy * ex === 0) {
        const et = ex * ex + ey * ey,
          ft = fx * fx + fy * fy;
        for (const p of [f.a, f.b]) cut(e, ((p[0] - e.a[0]) * ex + (p[1] - e.a[1]) * ey) / et);
        for (const p of [e.a, e.b]) cut(f, ((p[0] - f.a[0]) * fx + (p[1] - f.a[1]) * fy) / ft);
      }
    }
  const winding = (p: Point2D) => {
    let n = 0;
    for (const e of edges) {
      if (e.a[1] <= p[1] && e.b[1] > p[1] && cross(e.a, e.b, p) > 0) n++;
      if (e.b[1] <= p[1] && e.a[1] > p[1] && cross(e.a, e.b, p) < 0) n--;
    }
    return n;
  };
  const vertices: Point2D[] = [],
    buckets = new Map<string, number[]>();
  const vertex = (p: Point2D) => {
    const ix = Math.round(p[0] * 1e12),
      iy = Math.round(p[1] * 1e12);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of buckets.get(`${ix + dx},${iy + dy}`) ?? [])
          if (Math.hypot(vertices[i][0] - p[0], vertices[i][1] - p[1]) < 1e-12) return i;
      }
    const key = `${ix},${iy}`,
      list = buckets.get(key) ?? [],
      i = vertices.length;
    vertices.push(p);
    list.push(i);
    buckets.set(key, list);
    return i;
  };
  const boundary = new Map<string, { a: number; b: number }>();
  for (const edge of edges) {
    const cuts = [...new Set(edge.cuts)].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const at = (t: number): Point2D =>
        t === 0
          ? edge.a
          : t === 1
            ? edge.b
            : [edge.a[0] + t * (edge.b[0] - edge.a[0]), edge.a[1] + t * (edge.b[1] - edge.a[1])];
      const a = at(cuts[i]),
        b = at(cuts[i + 1]),
        dx = b[0] - a[0],
        dy = b[1] - a[1],
        len = Math.hypot(dx, dy);
      if (!len) continue;
      const mid: Point2D = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let offset = len * 1e-7;
      // Stay inside the adjacent arrangement faces, even around thin strokes.
      for (const other of edges) {
        const distance = pointSegmentDistance(mid, other.a, other.b);
        if (distance > 1e-14) offset = Math.min(offset, distance / 4);
      }
      const left = winding([mid[0] - (dy / len) * offset, mid[1] + (dx / len) * offset]) !== 0;
      const right = winding([mid[0] + (dy / len) * offset, mid[1] - (dx / len) * offset]) !== 0;
      if (left === right) continue;
      const ai = vertex(left ? a : b),
        bi = vertex(left ? b : a);
      if (ai === bi) continue;
      boundary.set(`${ai},${bi}`, { a: ai, b: bi });
    }
  }
  const remaining = new Set(boundary.values()),
    outgoing = new Map<number, Array<{ a: number; b: number }>>();
  for (const edge of remaining) {
    const list = outgoing.get(edge.a) ?? [];
    list.push(edge);
    outgoing.set(edge.a, list);
  }
  const result: Point2D[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    let edge = first;
    const loop: Point2D[] = [];
    do {
      if (!remaining.delete(edge)) polygonError('boundary cannot be closed');
      loop.push(vertices[edge.a]);
      if (edge.b === first.a) break;
      const prev = vertices[edge.a],
        current = vertices[edge.b],
        reverse = Math.atan2(prev[1] - current[1], prev[0] - current[0]);
      const candidates = (outgoing.get(edge.b) ?? []).filter((e) => remaining.has(e));
      candidates.sort((a, b) => {
        const turn = (e: { b: number }) =>
          (reverse - Math.atan2(vertices[e.b][1] - current[1], vertices[e.b][0] - current[0]) + Math.PI * 2) %
          (Math.PI * 2);
        return turn(a) - turn(b);
      });
      if (!candidates.length) polygonError('boundary has an unmatched endpoint');
      edge = candidates[0];
    } while (loop.length <= boundary.size);
    if (loop.length >= 3 && polygonArea(loop) !== 0) result.push(loop);
  }
  const shapes: PolygonShape[] = result
    .filter((loop) => polygonArea(loop) > 0)
    .map((loop) => ({ outer: loop, holes: [] }));
  for (const hole of result.filter((loop) => polygonArea(loop) < 0)) {
    const parents = shapes
      .filter((shape) => pointInPolygon(hole[0], shape.outer))
      .sort((a, b) => polygonArea(a.outer) - polygonArea(b.outer));
    if (!parents.length) polygonError('hole has no containing outline');
    parents[0].holes.push(hole);
  }
  for (const shape of shapes) {
    const world = (loop: Point2D[]) => loop.map(([x, y]): Point2D => [minX + x * scale, minY + y * scale]);
    shape.outer = world(shape.outer);
    shape.holes = shape.holes.map(world);
  }
  return shapes;
}

function polygonError(detail: string): never {
  throw new MargoError(
    'failed',
    `Text extrusion polygon ${detail}; provide finite nondegenerate outlines or reduce the bevel. Help: ${FONT_HELP}`,
  );
}
function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
function cross(a: Point2D, b: Point2D, c: Point2D): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function pointSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    n = dx * dx + dy * dy;
  const t = n ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segmentBlocked(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) return false;
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  const on = (p: Point2D, x: Point2D, y: Point2D) =>
    cross(x, y, p) === 0 &&
    p[0] >= Math.min(x[0], y[0]) &&
    p[0] <= Math.max(x[0], y[0]) &&
    p[1] >= Math.min(x[1], y[1]) &&
    p[1] <= Math.max(x[1], y[1]);
  return on(c, a, b) || on(d, a, b) || on(a, c, d) || on(b, c, d);
}

/** Triangulates a polygon by visible hole bridges and complete ear clipping (Eberly, sections 2-5). */
export function triangulatePolygon(
  outer: readonly Point2D[],
  holes: readonly (readonly Point2D[])[] = [],
): { vertices: Point2D[]; indices: number[] } {
  if (outer.length < 3) return { vertices: [], indices: [] };
  let polygon = outer.map(([x, y]): Point2D => [x, y]);
  if (polygonArea(polygon) < 0) polygon.reverse();
  const inside = holes
    .filter((h) => h.length >= 3)
    .map((h) => {
      const loop = h.map(([x, y]): Point2D => [x, y]);
      if (polygonArea(loop) > 0) loop.reverse();
      return loop;
    });
  inside.sort((a, b) => Math.max(...b.map((p) => p[0])) - Math.max(...a.map((p) => p[0])));
  for (const hole of inside) {
    let hi = 0;
    for (let i = 1; i < hole.length; i++)
      if (hole[i][0] > hole[hi][0] || (hole[i][0] === hole[hi][0] && hole[i][1] < hole[hi][1])) hi = i;
    const h = hole[hi];
    let best = -1,
      distance = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i],
        dist = Math.hypot(p[0] - h[0], p[1] - h[1]);
      if (dist >= distance) continue;
      const prev = polygon[(i + polygon.length - 1) % polygon.length],
        next = polygon[(i + 1) % polygon.length];
      const leftPrev = cross(prev, p, h) > 0,
        leftNext = cross(p, next, h) > 0;
      if (cross(prev, p, next) > 0 ? !(leftPrev && leftNext) : !(leftPrev || leftNext)) continue;
      const mid: Point2D = [(p[0] + h[0]) / 2, (p[1] + h[1]) / 2];
      if (!pointInPolygon(mid, outer) || inside.some((loop) => pointInPolygon(mid, loop))) continue;
      if (
        [polygon, ...inside].some((loop) => loop.some((a, j) => segmentBlocked(h, p, a, loop[(j + 1) % loop.length])))
      )
        continue;
      best = i;
      distance = dist;
    }
    if (best < 0) polygonError('has no visible hole bridge');
    const rotated = [...hole.slice(hi), ...hole.slice(0, hi)];
    polygon = [...polygon.slice(0, best + 1), ...rotated, h, polygon[best], ...polygon.slice(best + 1)];
  }
  const active = polygon.map((_, i) => i),
    indices: number[] = [];
  let cursor = 0,
    misses = 0;
  while (active.length > 3) {
    const n = active.length,
      ai = active[(cursor + n - 1) % n],
      bi = active[cursor],
      ci = active[(cursor + 1) % n];
    const a = polygon[ai],
      b = polygon[bi],
      c = polygon[ci];
    const ear =
      cross(a, b, c) > 0 &&
      !active.some((i) => {
        const p = polygon[i];
        if (samePoint(p, a) || samePoint(p, b) || samePoint(p, c)) return false;
        return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
      });
    if (ear) {
      indices.push(ai, bi, ci);
      active.splice(cursor, 1);
      cursor %= active.length;
      misses = 0;
    } else {
      cursor = (cursor + 1) % n;
      if (++misses >= n) polygonError('ear clipping could not complete');
    }
  }
  if (active.length === 3 && cross(polygon[active[0]], polygon[active[1]], polygon[active[2]]) > 0)
    indices.push(...active);
  else polygonError('triangulation ended with a degenerate triangle');
  const expected = Math.abs(polygonArea(outer)) - inside.reduce((sum, h) => sum + Math.abs(polygonArea(h)), 0);
  let area = 0;
  for (let i = 0; i < indices.length; i += 3)
    area += cross(polygon[indices[i]], polygon[indices[i + 1]], polygon[indices[i + 2]]) / 2;
  if (Math.abs(area - expected) > Math.abs(expected) * 1e-10) polygonError('triangulation area is incomplete');
  return { vertices: polygon, indices };
}

// ---------------------------------------------------------------------------
// 3D Extrusion Engine
// ---------------------------------------------------------------------------

function extrudeShapeGeometry(
  outer: Point2D[],
  holes: Point2D[][],
  options: ExtrudeTextOptions,
  capVertices: number[],
  capNormals: number[],
  capUVs: number[],
  capIndices: number[],
  wallVertices: number[],
  wallNormals: number[],
  wallUVs: number[],
  wallIndices: number[],
  bbox: { min: [number, number, number]; max: [number, number, number] },
): void {
  const depth = options.depth ?? 0.2,
    steps = options.steps ?? 1;
  const enabled = options.bevelEnabled ?? false,
    thickness = enabled ? (options.bevelThickness ?? 0.02) : 0;
  const size = enabled ? (options.bevelSize ?? 0.02) : 0,
    offset = enabled ? (options.bevelOffset ?? 0) : 0;
  const bevelSegments = Math.max(1, options.bevelSegments ?? 3);
  const loops = [outer, ...holes];
  const miters = loops.map((loop) =>
    loop.map((p, i): Point2D => {
      if (!size && !offset) return [0, 0];
      const prev = loop[(i + loop.length - 1) % loop.length],
        next = loop[(i + 1) % loop.length];
      const l1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]),
        l2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
      const n1: Point2D = [(p[1] - prev[1]) / l1, (prev[0] - p[0]) / l1],
        n2: Point2D = [(next[1] - p[1]) / l2, (p[0] - next[0]) / l2];
      const denominator = 1 + n1[0] * n2[0] + n1[1] * n2[1];
      if (denominator <= 1e-12) polygonError('bevel corner reverses direction');
      return [(n1[0] + n2[0]) / denominator, (n1[1] + n2[1]) / denominator];
    }),
  );
  const ring = (distance: number) =>
    loops.map((loop, j) =>
      loop.map((p, i): Point2D => [p[0] + miters[j][i][0] * distance, p[1] + miters[j][i][1] * distance]),
    );
  const profile: Array<{ z: number; offset: number }> = [];
  if (enabled && (size || thickness)) {
    for (let i = 0; i <= bevelSegments; i++) {
      const angle = ((i / bevelSegments) * Math.PI) / 2;
      profile.push({
        z: i === 0 ? 0 : i === bevelSegments ? thickness : thickness * (1 - Math.cos(angle)),
        offset: offset + (i === bevelSegments ? size : size * Math.sin(angle)),
      });
    }
    for (let i = 1; i <= steps; i++)
      profile.push({ z: thickness + ((depth - 2 * thickness) * i) / steps, offset: offset + size });
    for (let i = bevelSegments - 1; i >= 0; i--) {
      const angle = ((i / bevelSegments) * Math.PI) / 2;
      profile.push({
        z: i === 0 ? depth : depth - thickness * (1 - Math.cos(angle)),
        offset: offset + size * Math.sin(angle),
      });
    }
  } else for (let i = 0; i <= steps; i++) profile.push({ z: (depth * i) / steps, offset });
  const pointCount = loops.reduce((n, loop) => n + loop.length, 0);
  if ((capVertices.length + wallVertices.length) / 3 + pointCount * (4 + 4 * (profile.length - 1)) > 1000000)
    polygonError('mesh exceeds 1000000 vertices');
  // No cap ring is inferred separately: caps and walls consume these exact same coordinates.
  const rings = profile.map((level) => ring(level.offset));
  for (const level of rings) {
    for (let j = 0; j < level.length; j++) {
      const loop = level[j],
        source = loops[j];
      if (polygonArea(loop) * polygonArea(source) <= 0) polygonError('bevel collapses a contour');
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i],
          b = loop[(i + 1) % loop.length],
          sa = source[i],
          sb = source[(i + 1) % loop.length];
        if ((b[0] - a[0]) * (sb[0] - sa[0]) + (b[1] - a[1]) * (sb[1] - sa[1]) <= 0)
          polygonError('bevel reverses an edge');
        for (let k = i + 2; k < loop.length; k++) {
          if (i === 0 && k === loop.length - 1) continue;
          if (segmentBlocked(a, b, loop[k], loop[(k + 1) % loop.length])) polygonError('bevel intersects itself');
        }
        for (let k = j + 1; k < level.length; k++)
          for (let l = 0; l < level[k].length; l++) {
            if (segmentBlocked(a, b, level[k][l], level[k][(l + 1) % level[k].length]))
              polygonError('bevel contours intersect');
          }
      }
    }
  }
  const bounds = (x: number, y: number, z: number) => {
    bbox.min[0] = Math.min(bbox.min[0], x);
    bbox.max[0] = Math.max(bbox.max[0], x);
    bbox.min[1] = Math.min(bbox.min[1], y);
    bbox.max[1] = Math.max(bbox.max[1], y);
    bbox.min[2] = Math.min(bbox.min[2], z);
    bbox.max[2] = Math.max(bbox.max[2], z);
  };
  for (const end of [0, rings.length - 1]) {
    const level = rings[end],
      z = profile[end].z,
      front = end === 0;
    const { vertices, indices } = triangulatePolygon(level[0], level.slice(1)),
      start = capVertices.length / 3;
    for (const [x, y] of vertices) {
      capVertices.push(x, y, z);
      capNormals.push(0, 0, front ? -1 : 1);
      capUVs.push(x, y);
      bounds(x, y, z);
    }
    for (let i = 0; i < indices.length; i += 3) {
      capIndices.push(start + indices[i], start + indices[i + (front ? 2 : 1)], start + indices[i + (front ? 1 : 2)]);
    }
  }
  for (let j = 0; j < loops.length; j++) {
    const source = loops[j],
      n = source.length,
      lengths = [0];
    for (let i = 0; i < n; i++)
      lengths.push(
        lengths[i] + Math.hypot(source[(i + 1) % n][0] - source[i][0], source[(i + 1) % n][1] - source[i][1]),
      );
    for (let l = 0; l < rings.length - 1; l++) {
      if (profile[l].z === profile[l + 1].z && profile[l].offset === profile[l + 1].offset) continue;
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const a = [...rings[l][j][i], profile[l].z],
          b = [...rings[l][j][next], profile[l].z];
        const c = [...rings[l + 1][j][next], profile[l + 1].z],
          d = [...rings[l + 1][j][i], profile[l + 1].z];
        const ux = b[0] - a[0],
          uy = b[1] - a[1],
          uz = b[2] - a[2],
          vx = c[0] - a[0],
          vy = c[1] - a[1],
          vz = c[2] - a[2];
        const nx = uy * vz - uz * vy,
          ny = uz * vx - ux * vz,
          nz = ux * vy - uy * vx,
          len = Math.hypot(nx, ny, nz);
        if (!len) {
          if (depth === 0) continue;
          polygonError('wall triangle is degenerate');
        }
        const start = wallVertices.length / 3;
        for (const p of [a, b, c, d]) {
          wallVertices.push(...p);
          wallNormals.push(nx / len, ny / len, nz / len);
          bounds(p[0], p[1], p[2]);
        }
        const u0 = lengths[i] / lengths[n],
          u1 = lengths[i + 1] / lengths[n];
        wallUVs.push(
          u0,
          l / (rings.length - 1),
          u1,
          l / (rings.length - 1),
          u1,
          (l + 1) / (rings.length - 1),
          u0,
          (l + 1) / (rings.length - 1),
        );
        wallIndices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extruded Text High-Level API
// ---------------------------------------------------------------------------

/** Parses font binary data into a reusable FontOutlines object. */
export function parseFontOutlines(fontData: ArrayBuffer | ArrayBufferView): FontOutlines {
  if (!fontData || (!(fontData instanceof ArrayBuffer) && !ArrayBuffer.isView(fontData))) {
    throw new TypeError(
      'parseFontOutlines requires an ArrayBuffer or TypedArray view of font bytes; pass a valid buffer',
    );
  }
  return new FontOutlines(fontData);
}

/**
 * Creates 3D extruded geometry for text with front/back caps, side walls and optional bevels.
 * Material group 0 is front and back caps; material group 1 is side and bevel walls.
 */
export function extrudeText(text: string, options: ExtrudeTextOptions): ExtrudedTextGeometry {
  if (!options || !options.font) {
    throw new TypeError('extrudeText requires a font; pass {font: parseFontOutlines(bytes)} or font bytes');
  }

  const font: FontLike =
    options.font instanceof FontOutlines || typeof (options.font as any).getGlyphContours === 'function'
      ? (options.font as FontLike)
      : parseFontOutlines(options.font as ArrayBuffer | ArrayBufferView);
  const size = options.size ?? 1;
  if (typeof size !== 'number' || size <= 0 || !Number.isFinite(size)) {
    throw new RangeError(`extrudeText size must be a positive finite number; got ${size}`);
  }

  const depth = options.depth ?? 0.2;
  if (typeof depth !== 'number' || depth < 0 || !Number.isFinite(depth)) {
    throw new RangeError(`extrudeText depth must be a non-negative finite number; got ${depth}`);
  }

  const letterSpacing = options.letterSpacing ?? 0;
  const lineHeight = options.lineHeight ?? 1.2;
  const align = options.align ?? 'left';
  const curveSegments = subdivision('curveSegments', options.curveSegments ?? 12, 1);
  subdivision('steps', options.steps ?? 1, 1);
  subdivision('bevelSegments', options.bevelSegments ?? 3, 0, 64);
  for (const name of ['bevelThickness', 'bevelSize', 'bevelOffset', 'letterSpacing', 'lineHeight'] as const) {
    const value = options[name];
    if (value !== undefined && !Number.isFinite(value)) polygonError(`${name} must be finite`);
  }
  if (options.bevelEnabled) {
    const t = options.bevelThickness ?? 0.02,
      s = options.bevelSize ?? 0.02;
    if (t < 0 || s < 0 || t > depth / 2 || (t === 0) !== (s === 0))
      polygonError('bevel size and thickness must be positive together and thickness at most half the depth');
  }

  const lines = text.split('\n');
  const lineMetrics: { glyphs: { char: string; index: number; advance: number }[]; width: number }[] = [];

  for (const line of lines) {
    const glyphs: { char: string; index: number; advance: number }[] = [];
    let lineWidth = 0;
    for (const char of line) {
      const index = font.glyphIndex(char);
      const advance = font.glyphAdvance(index) * size;
      glyphs.push({ char, index, advance });
      lineWidth += advance + letterSpacing * size;
    }
    if (glyphs.length > 0) lineWidth -= letterSpacing * size;
    lineMetrics.push({ glyphs, width: lineWidth });
  }

  const maxLineWidth = Math.max(0, ...lineMetrics.map((l) => l.width));

  const capVertices: number[] = [];
  const capNormals: number[] = [];
  const capUVs: number[] = [];
  const capIndices: number[] = [];

  const wallVertices: number[] = [];
  const wallNormals: number[] = [];
  const wallUVs: number[] = [];
  const wallIndices: number[] = [];

  const bbox = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] as [number, number, number],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY] as [number, number, number],
  };

  const lineSpacing = size * lineHeight;
  let cursorY = 0;

  for (let l = 0; l < lineMetrics.length; l++) {
    const { glyphs, width } = lineMetrics[l];
    let cursorX = 0;
    if (align === 'center') cursorX = (maxLineWidth - width) * 0.5;
    else if (align === 'right') cursorX = maxLineWidth - width;

    for (const { index, advance } of glyphs) {
      const contours = font.getGlyphContours(index, curveSegments);
      if (contours.length > 0) {
        // Scale and translate glyph contours to world space
        const worldLoops: Point2D[][] = contours.map((loop) =>
          loop.map((p) => [cursorX + p[0] * size, cursorY + p[1] * size]),
        );

        const shapes = classifyLoops(worldLoops);
        for (const shape of shapes) {
          extrudeShapeGeometry(
            shape.outer,
            shape.holes,
            options,
            capVertices,
            capNormals,
            capUVs,
            capIndices,
            wallVertices,
            wallNormals,
            wallUVs,
            wallIndices,
            bbox,
          );
        }
      }
      cursorX += advance + letterSpacing * size;
    }
    cursorY -= lineSpacing;
  }

  // Combine caps and walls
  const numCapVerts = capVertices.length / 3;
  const numWallVerts = wallVertices.length / 3;
  const totalVerts = numCapVerts + numWallVerts;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(capIndices.length + wallIndices.length);

  // Copy caps
  positions.set(capVertices, 0);
  normals.set(capNormals, 0);
  uvs.set(capUVs, 0);
  indices.set(capIndices, 0);

  // Copy walls with offset indices
  positions.set(wallVertices, numCapVerts * 3);
  normals.set(wallNormals, numCapVerts * 3);
  uvs.set(wallUVs, numCapVerts * 2);

  const wallOffset = capIndices.length;
  for (let i = 0; i < wallIndices.length; i++) {
    indices[wallOffset + i] = wallIndices[i] + numCapVerts;
  }

  const groups: GeometryGroup[] = [];
  if (capIndices.length > 0) {
    groups.push({ start: 0, count: capIndices.length, materialIndex: 0 });
  }
  if (wallIndices.length > 0) {
    groups.push({ start: capIndices.length, count: wallIndices.length, materialIndex: 1 });
  }

  if (totalVerts === 0) {
    bbox.min = [0, 0, 0];
    bbox.max = [0, 0, 0];
  }

  return {
    positions,
    normals,
    uvs,
    indices,
    groups,
    boundingBox: bbox,
    toGeometry(GeometryClass?: any) {
      if (GeometryClass) return new GeometryClass(positions, normals, indices);
      return { positions, normals, uvs, indices, groups };
    },
  };
}
