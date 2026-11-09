// Clean-room OpenType font outline parser, polygon triangulation with holes, and 3D text extrusion.
// Specifications & Papers:
// - ISO/IEC 14496-22 (OpenType specification) / Microsoft OpenType specification (sfnt, head, maxp, hhea, hmtx, cmap, loca, glyf)
// - Adobe Technical Notes #5176 (CFF) and #5177 (Type 2 Charstrings)
// - Held, M. (2001), "FIST: Fast Industrial-Strength Triangulation of Polygons", Algorithmica, 30(4), 563-596
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
  /** Convert into a @margoengine/core Geometry instance if GeometryClass is passed or available globally. */
  toGeometry<T = unknown>(GeometryClass?: new (positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>) => T): T | { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array; groups: GeometryGroup[] };
}

/** Minimal font outline provider interface for text extrusion. */
export interface FontLike {
  readonly unitsPerEm: number;
  glyphIndex(char: string): number;
  glyphAdvance(glyphIndex: number): number;
  getGlyphContours(glyphIndex: number, curveSegments?: number): Array<Array<[number, number] | number[]>>;
}

/** Options for text extrusion. Lengths are in world units (scaled by `size`). */
export interface ExtrudeTextOptions {
  /** Font binary buffer (TTF/OTF), parsed FontOutlines, or custom FontLike instance. */
  font: FontOutlines | FontLike | ArrayBuffer | ArrayBufferView;
  /** Font size in world units. Default 1. */
  size?: number;
  /** Extrusion depth along +Z. Default 0.2. */
  depth?: number;
  /** Curve subdivision points per quadratic/cubic Bézier segment. Default 12. */
  curveSegments?: number;
  /** Enable bevels on the front and back edges. Default false. */
  bevelEnabled?: boolean;
  /** Depth of the bevel along Z. Default 0.02. */
  bevelThickness?: number;
  /** Extent of the bevel outward in XY. Default 0.02. */
  bevelSize?: number;
  /** Offset of the bevel relative to the outline. Default 0. */
  bevelOffset?: number;
  /** Bevel subdivision segments (0 for flat chamfer, >0 for rounded). Default 3. */
  bevelSegments?: number;
  /** Subdivisions along the extrusion depth. Default 1. */
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

class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(buffer: ArrayBuffer | ArrayBufferView) {
    if (ArrayBuffer.isView(buffer)) {
      this.bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      this.bytes = new Uint8Array(buffer);
      this.view = new DataView(buffer);
    }
  }

  get length(): number {
    return this.bytes.length;
  }

  seek(pos: number): void {
    this.pos = pos;
  }

  skip(bytes: number): void {
    this.pos += bytes;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  i8(): number {
    return this.view.getInt8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  tag(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

// ---------------------------------------------------------------------------
// OpenType Outline Parser (TrueType & CFF)
// ---------------------------------------------------------------------------

interface TableRecord {
  tag: string;
  checkSum: number;
  offset: number;
  length: number;
}

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
  private readonly cffDefaultWidth: number = 0;
  private readonly cffNominalWidth: number = 0;
  private readonly reader: BinaryReader;

  constructor(buffer: ArrayBuffer | ArrayBufferView) {
    this.reader = new BinaryReader(buffer);
    const r = this.reader;
    if (r.length < 12) {
      throw new TypeError('Font file buffer is too small to be an OpenType font; provide a valid TTF/OTF buffer');
    }

    const sfntVersion = r.u32();
    if (sfntVersion !== 0x00010000 && sfntVersion !== 0x4f54544f && sfntVersion !== 0x74727565) {
      throw new MargoError(
        'unsupported',
        `Font sfnt version 0x${sfntVersion.toString(16)} is not supported; provide an OpenType font with TrueType (0x00010000) or CFF (OTTO) outlines`,
      );
    }

    const numTables = r.u16();
    r.skip(6); // searchRange, entrySelector, rangeShift

    const tables = new Map<string, TableRecord>();
    for (let i = 0; i < numTables; i++) {
      const tag = r.tag();
      const checkSum = r.u32();
      const offset = r.u32();
      const length = r.u32();
      tables.set(tag, { tag, checkSum, offset, length });
    }

    const headRecord = tables.get('head');
    if (!headRecord) {
      throw new TypeError('Font is missing required "head" table; provide a valid OpenType font');
    }
    r.seek(headRecord.offset);
    r.skip(18); // major, minor, revision, checksum, magic
    this.unitsPerEm = r.u16() || 1000;
    r.skip(30); // dates, bounds, macStyle, lowestRecPPEM, directionHint
    const indexToLocFormat = r.i16();

    const maxpRecord = tables.get('maxp');
    if (!maxpRecord) {
      throw new TypeError('Font is missing required "maxp" table; provide a valid OpenType font');
    }
    r.seek(maxpRecord.offset + 4);
    this.numGlyphs = r.u16();

    const hheaRecord = tables.get('hhea');
    let numberOfHMetrics = this.numGlyphs;
    if (hheaRecord) {
      r.seek(hheaRecord.offset + 4);
      this.ascender = r.i16();
      this.descender = r.i16();
      r.seek(hheaRecord.offset + 34);
      numberOfHMetrics = r.u16();
    } else {
      this.ascender = Math.round(this.unitsPerEm * 0.8);
      this.descender = -Math.round(this.unitsPerEm * 0.2);
    }

    this.hmtxAdvance = new Array(this.numGlyphs).fill(this.unitsPerEm);
    this.hmtxLsb = new Array(this.numGlyphs).fill(0);
    const hmtxRecord = tables.get('hmtx');
    if (hmtxRecord) {
      r.seek(hmtxRecord.offset);
      let lastAdvance = 0;
      for (let i = 0; i < numberOfHMetrics && i < this.numGlyphs; i++) {
        lastAdvance = r.u16();
        this.hmtxAdvance[i] = lastAdvance;
        this.hmtxLsb[i] = r.i16();
      }
      for (let i = numberOfHMetrics; i < this.numGlyphs; i++) {
        this.hmtxAdvance[i] = lastAdvance;
        this.hmtxLsb[i] = r.i16();
      }
    }

    this.cmap = new Map<number, number>();
    const cmapRecord = tables.get('cmap');
    if (cmapRecord) {
      this.parseCmap(cmapRecord.offset);
    }

    if (tables.has('glyf') && tables.has('loca')) {
      const locaRecord = tables.get('loca')!;
      this.glyfOffset = tables.get('glyf')!.offset;
      r.seek(locaRecord.offset);
      this.locaOffsets = [];
      if (indexToLocFormat === 0) {
        for (let i = 0; i <= this.numGlyphs; i++) {
          this.locaOffsets.push(r.u16() * 2);
        }
      } else {
        for (let i = 0; i <= this.numGlyphs; i++) {
          this.locaOffsets.push(r.u32());
        }
      }
    } else if (tables.has('CFF ')) {
      const cffRecord = tables.get('CFF ')!;
      const parsed = this.parseCFF(cffRecord.offset, cffRecord.length);
      this.cffCharStrings = parsed.charStrings;
      this.cffGlobalSubrs = parsed.globalSubrs;
      this.cffLocalSubrs = parsed.localSubrs;
      this.cffDefaultWidth = parsed.defaultWidthX;
      this.cffNominalWidth = parsed.nominalWidthX;
    } else {
      throw new MargoError(
        'unsupported',
        'Font does not contain "glyf" (TrueType) or "CFF " (PostScript) tables; provide an outline font',
      );
    }
  }

  private parseCmap(cmapOffset: number): void {
    const r = this.reader;
    r.seek(cmapOffset);
    r.skip(2); // version
    const numSubtables = r.u16();

    let subtableOffset = 0;
    let selectedFormat = 0;
    for (let i = 0; i < numSubtables; i++) {
      const platformID = r.u16();
      const encodingID = r.u16();
      const offset = r.u32();
      const absOffset = cmapOffset + offset;

      const curPos = r.pos;
      r.seek(absOffset);
      const format = r.u16();
      r.seek(curPos);

      // Prefer format 12 (full Unicode) then format 4 (BMP)
      if (format === 12 && (platformID === 3 || platformID === 0)) {
        subtableOffset = absOffset;
        selectedFormat = 12;
        break;
      }
      if (format === 4 && (platformID === 3 || platformID === 0)) {
        subtableOffset = absOffset;
        selectedFormat = 4;
      }
    }

    if (!subtableOffset) return;

    r.seek(subtableOffset);
    if (selectedFormat === 4) {
      r.skip(4); // format, length
      r.skip(2); // language
      const segCountX2 = r.u16();
      const segCount = segCountX2 >> 1;
      r.skip(6); // searchRange, entrySelector, rangeShift

      const endCodes: number[] = [];
      for (let i = 0; i < segCount; i++) endCodes.push(r.u16());
      r.skip(2); // reservedPad

      const startCodes: number[] = [];
      for (let i = 0; i < segCount; i++) startCodes.push(r.u16());

      const idDeltas: number[] = [];
      for (let i = 0; i < segCount; i++) idDeltas.push(r.i16());

      const idRangeOffsetPos = r.pos;
      const idRangeOffsets: number[] = [];
      for (let i = 0; i < segCount; i++) idRangeOffsets.push(r.u16());

      for (let i = 0; i < segCount - 1; i++) {
        const start = startCodes[i];
        const end = endCodes[i];
        const delta = idDeltas[i];
        const rangeOffset = idRangeOffsets[i];

        for (let c = start; c <= end; c++) {
          if (rangeOffset === 0) {
            const glyph = (c + delta) & 0xffff;
            if (glyph !== 0) this.cmap.set(c, glyph);
          } else {
            const glyphPos = idRangeOffsetPos + i * 2 + rangeOffset + (c - start) * 2;
            const cur = r.pos;
            r.seek(glyphPos);
            const val = r.u16();
            r.seek(cur);
            if (val !== 0) {
              const glyph = (val + delta) & 0xffff;
              if (glyph !== 0) this.cmap.set(c, glyph);
            }
          }
        }
      }
    } else if (selectedFormat === 12) {
      r.skip(4); // format, reserved
      r.skip(4); // length
      r.skip(4); // language
      const numGroups = r.u32();
      for (let i = 0; i < numGroups; i++) {
        const startCode = r.u32();
        const endCode = r.u32();
        const startGlyph = r.u32();
        for (let c = startCode; c <= endCode; c++) {
          this.cmap.set(c, startGlyph + (c - startCode));
        }
      }
    }
  }

  private parseCFF(offset: number, _length: number) {
    const r = this.reader;
    r.seek(offset);
    r.skip(2); // major, minor
    const hdrSize = r.u8();
    r.skip(1); // offSize
    r.seek(offset + hdrSize);

    // Read Name INDEX
    this.readCFFIndex();
    // Read Top DICT INDEX
    const topDictItems = this.readCFFIndex();

    let charStringsOffset = 0;
    let privateOffset = 0;
    let privateSize = 0;

    if (topDictItems.length > 0) {
      const topDict = this.parseCFFDict(topDictItems[0]);
      charStringsOffset = topDict.get(17) ?? 0;
      if (topDict.has(18)) {
        const priv = topDict.get(18);
        if (Array.isArray(priv)) {
          privateSize = priv[0];
          privateOffset = priv[1];
        }
      }
    }

    // Read String INDEX
    this.readCFFIndex();
    // Read Global Subr INDEX
    const globalSubrs = this.readCFFIndex();

    let charStrings: Uint8Array[] = [];
    if (charStringsOffset > 0) {
      r.seek(offset + charStringsOffset);
      charStrings = this.readCFFIndex();
    }

    let localSubrs: Uint8Array[] = [];
    let defaultWidthX = 0;
    let nominalWidthX = 0;

    if (privateOffset > 0 && privateSize > 0) {
      r.seek(offset + privateOffset);
      const privBytes = r.bytes.subarray(r.pos, r.pos + privateSize);
      const privDict = this.parseCFFDict(privBytes);
      defaultWidthX = privDict.get(20) ?? 0;
      nominalWidthX = privDict.get(21) ?? 0;
      const subrsOffset = privDict.get(19);
      if (subrsOffset) {
        r.seek(offset + privateOffset + subrsOffset);
        localSubrs = this.readCFFIndex();
      }
    }

    return {
      charStrings,
      globalSubrs,
      localSubrs,
      defaultWidthX,
      nominalWidthX,
    };
  }

  private readCFFIndex(): Uint8Array[] {
    const r = this.reader;
    const count = r.u16();
    if (count === 0) return [];
    const offSize = r.u8();
    const offsets: number[] = [];
    for (let i = 0; i <= count; i++) {
      let off = 0;
      for (let b = 0; b < offSize; b++) off = (off << 8) | r.u8();
      offsets.push(off);
    }
    const dataStart = r.pos;
    const items: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const start = dataStart + offsets[i] - 1;
      const end = dataStart + offsets[i + 1] - 1;
      items.push(r.bytes.subarray(start, end));
    }
    r.seek(dataStart + offsets[count] - 1);
    return items;
  }

  private parseCFFDict(bytes: Uint8Array): Map<number, any> {
    const dict = new Map<number, any>();
    const stack: number[] = [];
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i++];
      if (b0 <= 21) {
        let op = b0;
        if (b0 === 12) op = (12 << 8) | bytes[i++];
        if (stack.length === 1) dict.set(op, stack[0]);
        else dict.set(op, [...stack]);
        stack.length = 0;
      } else if (b0 === 28) {
        stack.push((((bytes[i] << 8) | bytes[i + 1]) << 16) >> 16);
        i += 2;
      } else if (b0 === 29) {
        stack.push((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]);
        i += 4;
      } else if (b0 >= 32 && b0 <= 246) {
        stack.push(b0 - 139);
      } else if (b0 >= 247 && b0 <= 250) {
        stack.push((b0 - 247) * 256 + bytes[i++] + 108);
      } else if (b0 >= 251 && b0 <= 254) {
        stack.push(-(b0 - 251) * 256 - bytes[i++] - 108);
      } else if (b0 === 30) {
        // Real number nibbles
        let s = '';
        while (i < bytes.length) {
          const byte = bytes[i++];
          const n1 = byte >> 4;
          const n2 = byte & 0x0f;
          if (n1 === 0xf) break;
          s += this.cffNibble(n1);
          if (n2 === 0xf) break;
          s += this.cffNibble(n2);
        }
        stack.push(Number.parseFloat(s));
      }
    }
    return dict;
  }

  private cffNibble(n: number): string {
    if (n <= 9) return String(n);
    if (n === 10) return '.';
    if (n === 11) return 'E';
    if (n === 12) return 'E-';
    if (n === 14) return '-';
    return '';
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

  /** Extracts 2D contours for a glyph index, normalized to [0, 1] em coordinates. */
  getGlyphContours(glyphIndex: number, curveSegments = 12): Point2D[][] {
    if (glyphIndex < 0 || glyphIndex >= this.numGlyphs) return [];
    if (this.locaOffsets && this.glyfOffset !== undefined) {
      return this.getTrueTypeContours(glyphIndex, curveSegments);
    }
    if (this.cffCharStrings) {
      return this.getCFFContours(glyphIndex, curveSegments);
    }
    return [];
  }

  private getTrueTypeContours(glyphIndex: number, curveSegments: number): Point2D[][] {
    const startOffset = this.locaOffsets![glyphIndex];
    const endOffset = this.locaOffsets![glyphIndex + 1];
    if (startOffset >= endOffset) return []; // Empty glyph (e.g. space)

    const r = this.reader;
    r.seek(this.glyfOffset! + startOffset);
    const numberOfContours = r.i16();
    r.skip(8); // xMin, yMin, xMax, yMax

    if (numberOfContours > 0) {
      const endPts: number[] = [];
      for (let i = 0; i < numberOfContours; i++) endPts.push(r.u16());
      const instructionLength = r.u16();
      r.skip(instructionLength);

      const numPoints = endPts[endPts.length - 1] + 1;
      const flags: number[] = [];
      while (flags.length < numPoints) {
        const flag = r.u8();
        flags.push(flag);
        if (flag & 0x08) {
          const repeat = r.u8();
          for (let k = 0; k < repeat; k++) flags.push(flag);
        }
      }

      const xs: number[] = [];
      let x = 0;
      for (let i = 0; i < numPoints; i++) {
        const flag = flags[i];
        if (flag & 0x02) {
          const dx = r.u8();
          x += flag & 0x10 ? dx : -dx;
        } else if (!(flag & 0x10)) {
          x += r.i16();
        }
        xs.push(x);
      }

      const ys: number[] = [];
      let y = 0;
      for (let i = 0; i < numPoints; i++) {
        const flag = flags[i];
        if (flag & 0x04) {
          const dy = r.u8();
          y += flag & 0x20 ? dy : -dy;
        } else if (!(flag & 0x20)) {
          y += r.i16();
        }
        ys.push(y);
      }

      const scale = 1 / this.unitsPerEm;
      const contours: Point2D[][] = [];
      let contourStart = 0;

      for (let c = 0; c < numberOfContours; c++) {
        const contourEnd = endPts[c];
        const contourPoints: { x: number; y: number; onCurve: boolean }[] = [];
        for (let i = contourStart; i <= contourEnd; i++) {
          contourPoints.push({
            x: xs[i] * scale,
            y: ys[i] * scale,
            onCurve: (flags[i] & 0x01) !== 0,
          });
        }
        contourStart = contourEnd + 1;
        if (contourPoints.length === 0) continue;

        // Flatten quadratic Béziers into polyline
        const loop = this.flattenTrueTypeContour(contourPoints, curveSegments);
        if (loop.length >= 3) contours.push(loop);
      }
      return contours;
    }

    if (numberOfContours < 0) {
      // Composite glyph
      const compositeContours: Point2D[][] = [];
      let hasMore = true;
      while (hasMore) {
        const flags = r.u16();
        const componentGlyph = r.u16();
        let dx = 0;
        let dy = 0;

        if (flags & 0x01) {
          dx = r.i16();
          dy = r.i16();
        } else {
          dx = r.i8();
          dy = r.i8();
        }

        let a = 1;
        let b = 0;
        let c = 0;
        let d = 1;

        if (flags & 0x08) {
          a = r.i16() / 0x4000;
          d = a;
        } else if (flags & 0x40) {
          a = r.i16() / 0x4000;
          d = r.i16() / 0x4000;
        } else if (flags & 0x80) {
          a = r.i16() / 0x4000;
          b = r.i16() / 0x4000;
          c = r.i16() / 0x4000;
          d = r.i16() / 0x4000;
        }

        const curPos = r.pos;
        const subContours = this.getTrueTypeContours(componentGlyph, curveSegments);
        r.seek(curPos);

        const s = 1 / this.unitsPerEm;
        const tx = dx * s;
        const ty = dy * s;

        for (const sub of subContours) {
          const transformed: Point2D[] = sub.map(([px, py]) => [a * px + c * py + tx, b * px + d * py + ty]);
          compositeContours.push(transformed);
        }

        hasMore = (flags & 0x20) !== 0;
      }
      return compositeContours;
    }

    return [];
  }

  private flattenTrueTypeContour(points: { x: number; y: number; onCurve: boolean }[], segments: number): Point2D[] {
    const n = points.length;
    if (n < 2) return [];

    // TrueType outlines can start on or off curve. If it starts off-curve, find or insert start point.
    const pts: { x: number; y: number; onCurve: boolean }[] = [];
    if (!points[0].onCurve) {
      if (points[n - 1].onCurve) {
        pts.push(points[n - 1]);
        for (let i = 0; i < n - 1; i++) pts.push(points[i]);
      } else {
        pts.push({
          x: (points[0].x + points[n - 1].x) * 0.5,
          y: (points[0].y + points[n - 1].y) * 0.5,
          onCurve: true,
        });
        for (let i = 0; i < n; i++) pts.push(points[i]);
      }
    } else {
      for (let i = 0; i < n; i++) pts.push(points[i]);
    }

    const out: Point2D[] = [];
    let i = 0;
    const len = pts.length;
    out.push([pts[0].x, pts[0].y]);

    while (i < len) {
      const p0 = pts[i % len];
      const p1 = pts[(i + 1) % len];

      if (p1.onCurve) {
        out.push([p1.x, p1.y]);
        i += 1;
      } else {
        const p2 = pts[(i + 2) % len];
        let endX = p2.x;
        let endY = p2.y;
        if (!p2.onCurve) {
          // Implicit on-curve midpoint between consecutive off-curve points
          endX = (p1.x + p2.x) * 0.5;
          endY = (p1.y + p2.y) * 0.5;
          i += 1;
        } else {
          i += 2;
        }
        // Quadratic Bézier from p0 to (endX, endY) with control p1
        for (let s = 1; s <= segments; s++) {
          const t = s / segments;
          const mt = 1 - t;
          const bx = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * endX;
          const by = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * endY;
          out.push([bx, by]);
        }
      }
    }

    // Remove redundant identical closing point if present
    if (out.length > 1) {
      const first = out[0];
      const last = out[out.length - 1];
      if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
        out.pop();
      }
    }
    return out;
  }

  private getCFFContours(glyphIndex: number, curveSegments: number): Point2D[][] {
    const charString = this.cffCharStrings?.[glyphIndex];
    if (!charString) return [];

    const scale = 1 / this.unitsPerEm;
    const contours: Point2D[][] = [];
    let currentLoop: Point2D[] = [];
    let cx = 0;
    let cy = 0;

    const execute = (bytes: Uint8Array) => {
      const stack: number[] = [];
      let i = 0;
      let hasWidth = false;

      const subrBias = (subrs: Uint8Array[]) => {
        if (subrs.length < 1240) return 107;
        if (subrs.length < 33900) return 1131;
        return 32768;
      };

      while (i < bytes.length) {
        const b0 = bytes[i++];
        if (b0 <= 27 || b0 === 29 || b0 === 30 || b0 === 31) {
          let op = b0;
          if (b0 === 12) op = (12 << 8) | bytes[i++];

          switch (op) {
            case 21: // rmoveto: dx, dy
              if (!hasWidth && stack.length > 2) hasWidth = true;
              if (currentLoop.length >= 3) contours.push(currentLoop);
              currentLoop = [];
              cx += stack[stack.length - 2] * scale;
              cy += stack[stack.length - 1] * scale;
              currentLoop.push([cx, cy]);
              stack.length = 0;
              break;
            case 22: // hmoveto: dx
              if (!hasWidth && stack.length > 1) hasWidth = true;
              if (currentLoop.length >= 3) contours.push(currentLoop);
              currentLoop = [];
              cx += stack[stack.length - 1] * scale;
              currentLoop.push([cx, cy]);
              stack.length = 0;
              break;
            case 4: // vmoveto: dy
              if (!hasWidth && stack.length > 1) hasWidth = true;
              if (currentLoop.length >= 3) contours.push(currentLoop);
              currentLoop = [];
              cy += stack[stack.length - 1] * scale;
              currentLoop.push([cx, cy]);
              stack.length = 0;
              break;
            case 5: // rlineto: (dx, dy)+
              for (let k = 0; k < stack.length; k += 2) {
                cx += stack[k] * scale;
                cy += stack[k + 1] * scale;
                currentLoop.push([cx, cy]);
              }
              stack.length = 0;
              break;
            case 6: // hlineto: alternating dx, dy, dx, ...
            case 7: {
              // vlineto: alternating dy, dx, dy, ...
              let horizontal = op === 6;
              for (let k = 0; k < stack.length; k++) {
                if (horizontal) cx += stack[k] * scale;
                else cy += stack[k] * scale;
                currentLoop.push([cx, cy]);
                horizontal = !horizontal;
              }
              stack.length = 0;
              break;
            }
            case 8: // rrcurveto: (dx1, dy1, dx2, dy2, dx3, dy3)+
              for (let k = 0; k < stack.length; k += 6) {
                const x0 = cx;
                const y0 = cy;
                const x1 = x0 + stack[k] * scale;
                const y1 = y0 + stack[k + 1] * scale;
                const x2 = x1 + stack[k + 2] * scale;
                const y2 = y1 + stack[k + 3] * scale;
                const x3 = x2 + stack[k + 4] * scale;
                const y3 = y2 + stack[k + 5] * scale;
                for (let s = 1; s <= curveSegments; s++) {
                  const t = s / curveSegments;
                  const mt = 1 - t;
                  const bx = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
                  const by = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
                  currentLoop.push([bx, by]);
                }
                cx = x3;
                cy = y3;
              }
              stack.length = 0;
              break;
            case 10: {
              // callsubr
              const subrIndex = stack.pop()! + subrBias(this.cffLocalSubrs ?? []);
              const subr = this.cffLocalSubrs?.[subrIndex];
              if (subr) execute(subr);
              break;
            }
            case 29: {
              // callgsubr
              const gsubrIndex = stack.pop()! + subrBias(this.cffGlobalSubrs ?? []);
              const gsubr = this.cffGlobalSubrs?.[gsubrIndex];
              if (gsubr) execute(gsubr);
              break;
            }
            case 11: // return
              return;
            case 14: // endchar
              if (currentLoop.length >= 3) contours.push(currentLoop);
              currentLoop = [];
              return;
            default:
              stack.length = 0;
              break;
          }
        } else if (b0 === 28) {
          stack.push((((bytes[i] << 8) | bytes[i + 1]) << 16) >> 16);
          i += 2;
        } else if (b0 >= 32 && b0 <= 246) {
          stack.push(b0 - 139);
        } else if (b0 >= 247 && b0 <= 250) {
          stack.push((b0 - 247) * 256 + bytes[i++] + 108);
        } else if (b0 >= 251 && b0 <= 254) {
          stack.push(-(b0 - 251) * 256 - bytes[i++] - 108);
        }
      }
    };

    execute(charString);
    if (currentLoop.length >= 3) contours.push(currentLoop);
    return contours;
  }
}

// ---------------------------------------------------------------------------
// 2D Polygon Triangulation with Holes (Ear Clipping & Seam Cuts)
// ---------------------------------------------------------------------------

/** Computes the signed shoelace area of a 2D loop. Positive values are counter-clockwise, negative clockwise. */
export function polygonArea(loop: readonly Point2D[]): number {
  let a = 0;
  const n = loop.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1];
  }
  return a * 0.5;
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
export function classifyLoops(loops: Point2D[][]): PolygonShape[] {
  if (loops.length === 0) return [];

  // Remove degenerate vertices
  const cleanLoops: Point2D[][] = [];
  for (const loop of loops) {
    const cleaned: Point2D[] = [];
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const next = loop[(i + 1) % loop.length];
      const d = Math.hypot(next[0] - p[0], next[1] - p[1]);
      if (d > 1e-7) cleaned.push(p);
    }
    if (cleaned.length >= 3 && Math.abs(polygonArea(cleaned)) > 1e-8) {
      cleanLoops.push(cleaned);
    }
  }

  // Count containment depth for each loop
  const depths: number[] = new Array(cleanLoops.length).fill(0);
  for (let i = 0; i < cleanLoops.length; i++) {
    const pt = cleanLoops[i][0];
    for (let j = 0; j < cleanLoops.length; j++) {
      if (i !== j && pointInPolygon(pt, cleanLoops[j])) {
        depths[i]++;
      }
    }
  }

  const shapes: PolygonShape[] = [];
  const holeMap = new Map<number, Point2D[][]>();

  // Even depth = outer boundary; odd depth = hole
  for (let i = 0; i < cleanLoops.length; i++) {
    if (depths[i] % 2 === 0) {
      // Outer boundary: ensure CCW
      const loop = cleanLoops[i];
      if (polygonArea(loop) < 0) loop.reverse();
      shapes.push({ outer: loop, holes: [] });
      holeMap.set(shapes.length - 1, []);
    }
  }

  // Assign holes to the innermost outer loop containing them
  for (let i = 0; i < cleanLoops.length; i++) {
    if (depths[i] % 2 === 1) {
      const hole = cleanLoops[i];
      if (polygonArea(hole) > 0) hole.reverse(); // Ensure CW for holes

      let bestShapeIndex = -1;
      let minOuterArea = Number.POSITIVE_INFINITY;

      for (let s = 0; s < shapes.length; s++) {
        if (pointInPolygon(hole[0], shapes[s].outer)) {
          const a = Math.abs(polygonArea(shapes[s].outer));
          if (a < minOuterArea) {
            minOuterArea = a;
            bestShapeIndex = s;
          }
        }
      }

      if (bestShapeIndex >= 0) {
        shapes[bestShapeIndex].holes.push(hole);
      }
    }
  }

  return shapes;
}

/** Triangulates a 2D polygon with optional holes using ear clipping and hole bridging. */
export function triangulatePolygon(
  outer: readonly Point2D[],
  holes: readonly (readonly Point2D[])[] = [],
): { vertices: Point2D[]; indices: number[] } {
  if (outer.length < 3) return { vertices: [], indices: [] };

  // Make working copies
  const outerLoop: Point2D[] = outer.map(([x, y]) => [x, y]);
  if (polygonArea(outerLoop) < 0) outerLoop.reverse();

  let bridgedPolygon = outerLoop;

  // Bridge holes into outer loop
  for (const hole of holes) {
    if (hole.length < 3) continue;
    const holeLoop: Point2D[] = hole.map(([x, y]) => [x, y]);
    if (polygonArea(holeLoop) > 0) holeLoop.reverse();

    // Find vertex with max X on hole
    let maxHx = -Number.MAX_VALUE;
    let maxHIdx = 0;
    for (let i = 0; i < holeLoop.length; i++) {
      if (holeLoop[i][0] > maxHx) {
        maxHx = holeLoop[i][0];
        maxHIdx = i;
      }
    }
    const h = holeLoop[maxHIdx];

    // Find mutually visible vertex on bridged polygon
    let bestDist = Number.MAX_VALUE;
    let bestOuterIdx = 0;

    for (let i = 0; i < bridgedPolygon.length; i++) {
      const p = bridgedPolygon[i];
      const d = Math.hypot(p[0] - h[0], p[1] - h[1]);
      if (d < bestDist) {
        bestDist = d;
        bestOuterIdx = i;
      }
    }

    // Insert bridge cut: outer[0..bestOuterIdx], holeLoop[rotated], outer[bestOuterIdx..end]
    const rotatedHole: Point2D[] = [];
    for (let i = 0; i < holeLoop.length; i++) {
      rotatedHole.push(holeLoop[(maxHIdx + i) % holeLoop.length]);
    }
    rotatedHole.push(rotatedHole[0]); // Return to hole entry

    const newPolygon: Point2D[] = [
      ...bridgedPolygon.slice(0, bestOuterIdx + 1),
      ...rotatedHole,
      bridgedPolygon[bestOuterIdx], // Seam cut back
      ...bridgedPolygon.slice(bestOuterIdx + 1),
    ];
    bridgedPolygon = newPolygon;
  }

  // Ear clipping on simple bridged polygon
  const n = bridgedPolygon.length;
  if (n < 3) return { vertices: bridgedPolygon, indices: [] };

  interface PolyNode {
    idx: number;
    pt: Point2D;
    prev: PolyNode;
    next: PolyNode;
  }

  const nodes: PolyNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ idx: i, pt: bridgedPolygon[i], prev: null as any, next: null as any });
  }
  for (let i = 0; i < n; i++) {
    nodes[i].prev = nodes[(i + n - 1) % n];
    nodes[i].next = nodes[(i + 1) % n];
  }

  const isConvex = (node: PolyNode) => {
    const a = node.prev.pt;
    const b = node.pt;
    const c = node.next.pt;
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-7;
  };

  const pointInTri = (p: Point2D, a: Point2D, b: Point2D, c: Point2D) => {
    // Ignore points with identical coordinates to triangle corners (duplicate seam vertices)
    if (
      (Math.abs(p[0] - a[0]) < 1e-6 && Math.abs(p[1] - a[1]) < 1e-6) ||
      (Math.abs(p[0] - b[0]) < 1e-6 && Math.abs(p[1] - b[1]) < 1e-6) ||
      (Math.abs(p[0] - c[0]) < 1e-6 && Math.abs(p[1] - c[1]) < 1e-6)
    ) {
      return false;
    }
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (area <= 1e-7) return false;
    const s = (a[1] * c[0] - a[0] * c[1]) + (c[1] - a[1]) * p[0] + (a[0] - c[0]) * p[1];
    const t = (a[0] * b[1] - a[1] * b[0]) + (a[1] - b[1]) * p[0] + (b[0] - a[0]) * p[1];
    return s > 1e-7 && t > 1e-7 && s + t < area - 1e-7;
  };

  const isEar = (node: PolyNode) => {
    if (!isConvex(node)) return false;
    const a = node.prev.pt;
    const b = node.pt;
    const c = node.next.pt;
    let curr = node.next.next;
    while (curr !== node.prev) {
      if (pointInTri(curr.pt, a, b, c)) return false;
      curr = curr.next;
    }
    return true;
  };

  const indices: number[] = [];
  let curr = nodes[0];
  let remaining = n;
  let iterations = 0;
  const maxIterations = n * 4;

  while (remaining > 3 && iterations < maxIterations) {
    iterations++;
    if (isEar(curr)) {
      indices.push(curr.prev.idx, curr.idx, curr.next.idx);
      curr.prev.next = curr.next;
      curr.next.prev = curr.prev;
      remaining--;
      curr = curr.next;
    } else {
      curr = curr.next;
    }
  }

  if (remaining === 3) {
    indices.push(curr.prev.idx, curr.idx, curr.next.idx);
  }

  return { vertices: bridgedPolygon, indices };
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
  const depth = options.depth ?? 0.2;
  const bevelEnabled = options.bevelEnabled ?? false;
  const bevelThickness = bevelEnabled ? (options.bevelThickness ?? 0.02) : 0;
  const bevelSize = bevelEnabled ? (options.bevelSize ?? 0.02) : 0;
  const bevelSegments = bevelEnabled ? Math.max(0, options.bevelSegments ?? 3) : 0;
  const steps = Math.max(1, options.steps ?? 1);

  // 1. Triangulate caps
  const { vertices: cap2D, indices: triIndices } = triangulatePolygon(outer, holes);
  if (cap2D.length === 0 || triIndices.length === 0) return;

  // Compute 2D bounds for UV mapping
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of cap2D) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);

  // Front Cap
  const frontZ = bevelThickness;
  const frontCapStart = capVertices.length / 3;
  for (const [x, y] of cap2D) {
    capVertices.push(x, y, frontZ);
    capNormals.push(0, 0, 1);
    capUVs.push((x - minX) / spanX, (y - minY) / spanY);
    bbox.min[0] = Math.min(bbox.min[0], x);
    bbox.max[0] = Math.max(bbox.max[0], x);
    bbox.min[1] = Math.min(bbox.min[1], y);
    bbox.max[1] = Math.max(bbox.max[1], y);
    bbox.min[2] = Math.min(bbox.min[2], frontZ);
    bbox.max[2] = Math.max(bbox.max[2], frontZ);
  }
  for (let i = 0; i < triIndices.length; i += 3) {
    capIndices.push(
      frontCapStart + triIndices[i],
      frontCapStart + triIndices[i + 1],
      frontCapStart + triIndices[i + 2],
    );
  }

  // Back Cap
  const backZ = depth - bevelThickness;
  const backCapStart = capVertices.length / 3;
  for (const [x, y] of cap2D) {
    capVertices.push(x, y, backZ);
    capNormals.push(0, 0, -1);
    capUVs.push((x - minX) / spanX, (y - minY) / spanY);
    bbox.min[2] = Math.min(bbox.min[2], backZ);
    bbox.max[2] = Math.max(bbox.max[2], backZ);
  }
  // Reverse winding for back cap
  for (let i = 0; i < triIndices.length; i += 3) {
    capIndices.push(backCapStart + triIndices[i + 2], backCapStart + triIndices[i + 1], backCapStart + triIndices[i]);
  }

  // 2. Extrude Side Walls and Bevels
  const allLoops = [outer, ...holes];
  const profileLevels: { z: number; offset: number; nz: number }[] = [];

  if (bevelEnabled && bevelSegments > 0) {
    // Front bevel layers
    for (let i = 0; i <= bevelSegments; i++) {
      const angle = (i / bevelSegments) * (Math.PI * 0.5);
      const bz = bevelThickness * (1 - Math.cos(angle));
      const bo = bevelSize * (1 - Math.sin(angle));
      profileLevels.push({ z: bz, offset: bo, nz: Math.cos(angle) });
    }
    // Main depth body
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      profileLevels.push({
        z: bevelThickness + t * (depth - 2 * bevelThickness),
        offset: 0,
        nz: 0,
      });
    }
    // Back bevel layers
    for (let i = 0; i <= bevelSegments; i++) {
      const angle = (i / bevelSegments) * (Math.PI * 0.5);
      const bz = depth - bevelThickness + bevelThickness * Math.sin(angle);
      const bo = bevelSize * (1 - Math.cos(angle));
      profileLevels.push({ z: bz, offset: bo, nz: -Math.sin(angle) });
    }
  } else {
    for (let s = 0; s <= steps; s++) {
      profileLevels.push({ z: (s / steps) * depth, offset: 0, nz: 0 });
    }
  }

  for (const loop of allLoops) {
    const m = loop.length;
    if (m < 2) continue;

    // Precompute edge lengths and normals
    const edgeNormals: [number, number][] = [];
    const cumulativeDist: number[] = [0];
    let totalLen = 0;

    for (let i = 0; i < m; i++) {
      const p1 = loop[i];
      const p2 = loop[(i + 1) % m];
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const len = Math.hypot(dx, dy) || 1e-6;
      totalLen += len;
      cumulativeDist.push(totalLen);
      // Normal perpendicular to edge in XY plane
      edgeNormals.push([dy / len, -dx / len]);
    }

    const numLevels = profileLevels.length;

    // Emit vertices for all levels of this loop
    const loopStartIdx = wallVertices.length / 3;
    for (let l = 0; l < numLevels; l++) {
      const lvl = profileLevels[l];
      const vCoord = lvl.z / Math.max(1e-6, depth);

      for (let i = 0; i < m; i++) {
        const pt = loop[i];
        // Average adjacent edge normals for smooth loop vertices
        const prevNorm = edgeNormals[(i + m - 1) % m];
        const nextNorm = edgeNormals[i];
        const nx = (prevNorm[0] + nextNorm[0]) * 0.5;
        const ny = (prevNorm[1] + nextNorm[1]) * 0.5;
        const nlen = Math.hypot(nx, ny) || 1;
        const unx = nx / nlen;
        const uny = ny / nlen;

        const vx = pt[0] + unx * lvl.offset;
        const vy = pt[1] + uny * lvl.offset;
        const vz = lvl.z;

        wallVertices.push(vx, vy, vz);
        wallNormals.push(unx, uny, lvl.nz);
        wallUVs.push(cumulativeDist[i] / Math.max(1e-6, totalLen), vCoord);

        bbox.min[0] = Math.min(bbox.min[0], vx);
        bbox.max[0] = Math.max(bbox.max[0], vx);
        bbox.min[1] = Math.min(bbox.min[1], vy);
        bbox.max[1] = Math.max(bbox.max[1], vy);
        bbox.min[2] = Math.min(bbox.min[2], vz);
        bbox.max[2] = Math.max(bbox.max[2], vz);
      }
    }

    // Connect levels with quad strips
    for (let l = 0; l < numLevels - 1; l++) {
      const l0 = loopStartIdx + l * m;
      const l1 = loopStartIdx + (l + 1) * m;
      for (let i = 0; i < m; i++) {
        const next = (i + 1) % m;
        const a = l0 + i;
        const b = l0 + next;
        const c = l1 + next;
        const d = l1 + i;
        wallIndices.push(a, b, c, a, c, d);
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
    throw new TypeError('parseFontOutlines requires an ArrayBuffer or TypedArray view of font bytes; pass a valid buffer');
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
  const curveSegments = Math.max(1, options.curveSegments ?? 12);

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
      try {
        const { Geometry } = (globalThis as any).__margo_core ?? {};
        if (Geometry) return new Geometry(positions, normals, indices);
      } catch {}
      return { positions, normals, uvs, indices, groups };
    },
  };
}
