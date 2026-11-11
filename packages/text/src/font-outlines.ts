import { FontItemStore, FontVariations, type FontVariationOptions, type FontVariationAxis } from './font-variation.js';
import { BinaryReader, fontError, FONT_HELP } from './font-reader.js';
import { MargoError } from '@margoengine/math/errors';
// Clean-room OpenType font outline reader (TrueType glyf/loca, CFF and CFF2, variations), shared by
// @margoengine/text/extrude and @margoengine/text/vector. Specifications:
// - ISO/IEC 14496-22 (OpenType specification) / Microsoft OpenType specification (sfnt, head, maxp, hhea, hmtx, cmap, loca, glyf)
// - Adobe Technical Notes #5176 (CFF) and #5177 (Type 2 Charstrings)

/** A 2D point as an [x, y] tuple. */
export type Point2D = [number, number];

export function subdivision(name: string, value: number, min: number, max = 256): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MargoError(
      'failed',
      `extrudeText ${name} must be an integer from ${min} to ${max}; reduce subdivisions. Help: ${FONT_HELP}`,
    );
  }
  return value;
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
  private readonly variationState: FontVariations;
  private readonly variedAdvance = new Map<number, number>();
  private cff2 = false;
  private cffStore?: FontItemStore;
  private cffFontDicts: Array<{subrs: Uint8Array[]; vsindex: number; matrix: number[]}> = [];
  private cffSelect: number[] = [];

  constructor(buffer: ArrayBuffer | ArrayBufferView, options: FontVariationOptions = {}) {
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
    this.variationState = new FontVariations(tables, this.numGlyphs, options.variations);
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
    } else if (tables.has('CFF2')) {
      const parsed = this.parseCFF2(table('CFF2'));
      this.cffCharStrings = parsed.charStrings;
      this.cffGlobalSubrs = parsed.globalSubrs;
      this.cffMatrix = parsed.matrix;
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
  private parseCFF2(r: BinaryReader) {
    this.cff2 = true;
    if (r.u8() !== 2 || r.u8() !== 0) fontError('CFF2 version is unsupported');
    const header = r.u8(), topLength = r.u16();
    if (header < 5) fontError('CFF2 header is invalid');
    const top = this.parseCFFDict(r.slice(header, topLength).bytes, true);
    r.seek(header + topLength);
    const globalSubrs = this.readCFFIndex(r, true);
    const offset = (dict: Map<number, number | number[]>, op: number): number => {
      const v = dict.get(op);
      if (!Number.isInteger(v) || (v as number) < 0) fontError(`CFF2 offset ${op} is invalid`);
      return v as number;
    };
    const store = top.get(24);
    if (store !== undefined) {
      r.seek(offset(top, 24));
      const length = r.u16();
      this.cffStore = new FontItemStore(r.slice(r.pos, length), this.variationState.coordinates);
    }
    r.seek(offset(top, 17));
    const charStrings = this.readCFFIndex(r, true);
    if (charStrings.length !== this.numGlyphs) fontError('CFF2 CharStrings count differs from maxp');
    const matrix = (top.get(0x0c07) ?? [0.001, 0, 0, 0.001, 0, 0]) as number[];
    if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)) fontError('CFF2 FontMatrix is invalid');
    r.seek(offset(top, 0x0c24));
    const dicts = this.readCFFIndex(r, true);
    if (!dicts.length) fontError('CFF2 FontDICT INDEX is empty');
    this.cffFontDicts = dicts.map(bytes => {
      const dict = this.parseCFFDict(bytes, true), priv = dict.get(18);
      let subrs: Uint8Array[] = [], vsindex = 0;
      if (priv !== undefined) {
        if (!Array.isArray(priv) || priv.length !== 2) fontError('CFF2 PrivateDICT range is invalid');
        const [length, start] = priv, p = this.parseCFFDict(r.slice(start, length).bytes, true);
        vsindex = Number(p.get(22) ?? 0);
        if (p.has(19)) { r.seek(start + offset(p, 19)); subrs = this.readCFFIndex(r, true); }
      }
      let combined = matrix;
      const local = dict.get(0x0c07);
      if (local !== undefined) {
        if (!Array.isArray(local) || local.length !== 6 || !local.every(Number.isFinite)) fontError('CFF2 FontDICT matrix is invalid');
        const [a,b,c,d,x,y]=matrix,[e,f,g,h,u,v]=local;
        combined=[a*e+c*f,b*e+d*f,a*g+c*h,b*g+d*h,a*u+c*v+x,b*u+d*v+y];
      }
      return {subrs,vsindex,matrix:combined};
    });
    this.cffSelect = new Array(this.numGlyphs).fill(0);
    if (top.has(0x0c25)) {
      r.seek(offset(top, 0x0c25));
      const format=r.u8();
      if(format===0) for(let i=0;i<this.numGlyphs;i++)this.cffSelect[i]=r.u8();
      else if(format===3||format===4) {
        const wide=format===4, n=wide?r.u32():r.u16();
        const ranges=Array.from({length:n},()=>({first:wide?r.u32():r.u16(),fd:wide?r.u16():r.u8()}));
        const sentinel=wide?r.u32():r.u16();
        if(!n||ranges[0].first!==0||sentinel!==this.numGlyphs)fontError('CFF2 FDSelect range is invalid');
        for(let i=0;i<n;i++) {
          const end=i+1<n?ranges[i+1].first:sentinel;
          if(end<=ranges[i].first||end>this.numGlyphs)fontError('CFF2 FDSelect ranges are not ordered');
          this.cffSelect.fill(ranges[i].fd,ranges[i].first,end);
        }
      } else fontError('CFF2 FDSelect format is unsupported');
    } else if(dicts.length!==1) fontError('CFF2 multiple FontDICTs require FDSelect');
    if(this.cffSelect.some(i=>i>=dicts.length))fontError('CFF2 FDSelect references a missing FontDICT');
    return {charStrings,globalSubrs,matrix};
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
  private readCFFIndex(r: BinaryReader, cff2 = false): Uint8Array[] {
    const count = cff2 ? r.u32() : r.u16();
    if (count > 65536) fontError('CFF INDEX count exceeds 65536');
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
  private parseCFFDict(bytes: Uint8Array, cff2 = false): Map<number, number | number[]> {
    const r = new BinaryReader(bytes),
      dict = new Map<number, number | number[]>(),
      stack: number[] = [];
    while (r.pos < r.length) {
      const b = r.u8();
      if (cff2 && b === 23) {
        const n = stack.pop()!;
        const weights = this.cffStore?.weights(Number(dict.get(22) ?? 0)) ?? fontError('CFF2 DICT blend has no variation store');
        const start = stack.length - n * (weights.length + 1);
        if (!Number.isInteger(n) || n < 1 || start < 0) fontError('CFF2 DICT blend operand count is invalid');
        for (let i = 0; i < n; i++) for (let j = 0; j < weights.length; j++) stack[start + i] += weights[j] * stack[start + n + i * weights.length + j];
        stack.length = start + n;
      } else if (b <= (cff2 ? 25 : 21)) {
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
      if (stack.length > (cff2 ? 513 : 48)) fontError('CFF DICT operand stack exceeds its format limit');
    }
    if (stack.length) fontError('CFF DICT has trailing operands');
    return dict;
  }

  /** Number of glyph IDs in the font. */
  get glyphCount(): number { return this.numGlyphs; }
  /** Supported variation axes in user units. */
  get variationAxes(): readonly FontVariationAxis[] { return this.variationState.axes; }
  /** Create an independent immutable instance at axis values; omitted values use the font defaults. */
  withVariations(variations: Readonly<Record<string, number>>): FontOutlines {
    return new FontOutlines(this.reader.bytes, { variations });
  }
  /** Resolves Unicode code point or 1-character string to a glyph index. */
  glyphIndex(charOrCode: string | number): number {
    const cp = typeof charOrCode === 'string' ? (charOrCode.codePointAt(0) ?? 0) : charOrCode;
    return this.cmap.get(cp) ?? 0;
  }

  /** Returns advance width for glyph index, normalized to 1 em. */
  glyphAdvance(glyphIndex: number): number {
    const raw = this.hmtxAdvance[glyphIndex] ?? this.unitsPerEm;
    let delta = this.variationState.advance(glyphIndex);
    if (delta === undefined && this.variationState.hasGlyphVariations && this.locaOffsets) {
      if (!this.variedAdvance.has(glyphIndex)) this.readTrueTypeGlyph(glyphIndex, [], {points:0,components:0});
      delta = this.variedAdvance.get(glyphIndex) ?? 0;
    }
    return (raw + (delta ?? 0)) / this.unitsPerEm;
  }

  /** Extracts 2D contours for a glyph index, normalized to em coordinates (including negative bearings). */
  getGlyphContours(glyphIndex: number, curveSegments = 12): Point2D[][] {
    subdivision('curveSegments', curveSegments, 1);
    if (!Number.isInteger(glyphIndex) || glyphIndex < 0 || glyphIndex >= this.numGlyphs) return [];
    if (this.locaOffsets && this.glyfOffset !== undefined) {
      return this.getTrueTypeContours(glyphIndex, curveSegments);
    }
    if (this.cffCharStrings) {
      const [a, b, c, d, tx, ty] = this.cff2 ? this.cffFontDicts[this.cffSelect[glyphIndex]].matrix : this.cffMatrix;
      const contours = this.getCFFContours(glyphIndex, curveSegments);
      if (contours.reduce((n, loop) => n + loop.length, 0) > 16384) fontError('flattened glyph exceeds 16384 vertices');
      return contours.map((loop) => loop.map(([x, y]): Point2D => [a * x + c * y + tx, b * x + d * y + ty]));
    }
    return [];
  }

  /**
   * The glyph outline as unflattened segments in em units, variations applied: one array per closed contour,
   * each segment [x0, y0, x1, y1] (line), [x0, y0, cx, cy, x1, y1] (quadratic) or [x0, y0, c1x, c1y, c2x, c2y,
   * x1, y1] (cubic). Out-of-range glyph indices give []. Used by `@margoengine/text/vector`.
   */
  getGlyphSegments(glyphIndex: number): number[][][] {
    if (!Number.isInteger(glyphIndex) || glyphIndex < 0 || glyphIndex >= this.numGlyphs) return [];
    const em = this.unitsPerEm;
    if (this.locaOffsets && this.glyfOffset !== undefined)
      return this.readTrueTypeGlyph(glyphIndex, [], { points: 0, components: 0 })
        .map((points) => {
          // Materialize implied on-curve midpoints, start on an on-curve point and walk line and quadratic segments.
          const expanded: OutlinePoint[] = [];
          for (let i = 0; i < points.length; i++) {
            const a = points[i],
              b = points[(i + 1) % points.length];
            expanded.push(a);
            if (!a.onCurve && !b.onCurve) expanded.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, onCurve: true });
          }
          const start = expanded.findIndex((p) => p.onCurve),
            out: number[][] = [];
          if (start < 0) return out;
          const n = expanded.length;
          for (let i = 0; i < n; ) {
            const a = expanded[(start + i) % n],
              b = expanded[(start + i + 1) % n];
            if (b.onCurve) {
              out.push([a.x / em, a.y / em, b.x / em, b.y / em]);
              i++;
            } else {
              const c = expanded[(start + i + 2) % n];
              out.push([a.x / em, a.y / em, b.x / em, b.y / em, c.x / em, c.y / em]);
              i += 2;
            }
          }
          return out;
        })
        .filter((loop) => loop.length);
    if (this.cffCharStrings) {
      const [a, b, c, d, tx, ty] = this.cff2 ? this.cffFontDicts[this.cffSelect[glyphIndex]].matrix : this.cffMatrix,
        raw: number[][][] = [];
      this.getCFFContours(glyphIndex, 1, false, raw);
      return raw.map((loop) =>
        loop.map((s) => s.map((v, i) => (i % 2 ? b * s[i - 1] + d * v + ty : a * v + c * s[i + 1] + tx))),
      );
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
    if (start === end) {
      const [dx] = this.variationState.deltas(glyph, [], []);
      this.variedAdvance.set(glyph, dx[1] - dx[0]);
      return [];
    }
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
      const [dx,dy] = this.variationState.deltas(glyph, coords[0].map((x,i)=>[x,coords[1][i]]), ends);
      this.variedAdvance.set(glyph, dx[n+1]-dx[n]);
      for (let i=0;i<n;i++) { coords[0][i]+=dx[i]; coords[1][i]+=dy[i]; }
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
    const componentReader = r.slice(r.pos, r.length-r.pos), componentPoints: number[][] = [];
    let componentFlags = 0;
    do {
      componentFlags=componentReader.u16();componentReader.u16();
      const words=!!(componentFlags&1),xy=!!(componentFlags&2);
      const value=()=>words?(xy?componentReader.i16():componentReader.u16()):(xy?componentReader.i8():componentReader.u8());
      const x=value(),y=value();componentPoints.push(xy?[x,y]:[0,0]);
      componentReader.skip(componentFlags&8?2:componentFlags&64?4:componentFlags&128?8:0);
      if(componentPoints.length>4096)fontError('composite component budget exceeds 4096');
    } while(componentFlags&32);
    const [componentX,componentY]=this.variationState.deltas(glyph,componentPoints,[],true);
    this.variedAdvance.set(glyph,componentX[componentPoints.length+1]-componentX[componentPoints.length]);
    let flags = 0, componentIndex = 0;
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
      tx += componentX[componentIndex]; ty += componentY[componentIndex++];
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

  private getCFFContours(glyphIndex: number, curveSegments: number, component = false, raw?: number[][][]): Point2D[][] {
    const charString = this.cffCharStrings?.[glyphIndex];
    if (!charString) return [];
    // With `raw`, every closed contour's unflattened line and cubic segments are recorded too (font units).
    let segments: number[][] = [];
    const contours: Point2D[][] = [],
      stack: number[] = [],
      transient = new Array<number>(32).fill(0);
    let loop: Point2D[] = [],
      x = 0,
      y = 0,
      widthSeen = this.cff2,
      stems = 0,
      ended = false,
      operations = 0,
      seed = 1,
      outputPoints = 0,
      vsindex = this.cff2 ? this.cffFontDicts[this.cffSelect[glyphIndex]].vsindex : 0;
    const finish = () => {
      if (loop.length >= 3) contours.push(loop);
      if (raw && segments.length) {
        const [sx, sy] = loop[0];
        if (x !== sx || y !== sy) segments.push([x, y, sx, sy]);
        raw.push(segments);
      }
      loop = [];
      segments = [];
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
      if (raw && loop.length && (dx || dy)) segments.push([x, y, x + dx, y + dy]);
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
      if (raw) segments.push([x0, y0, x1, y1, x2, y2, x, y]);
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
        else if (this.cff2 && b === 15) {
          need(1); vsindex=pop(); this.cffStore?.weights(vsindex);
        } else if (this.cff2 && b === 16) {
          const n=pop(),weights=this.cffStore?.weights(vsindex)??fontError('CFF2 blend has no variation store');
          const start=stack.length-n*(weights.length+1);
          if(!Number.isInteger(n)||n<1||start<0)fontError('CFF2 blend operand count is invalid');
          for(let i=0;i<n;i++)for(let j=0;j<weights.length;j++)stack[start+i]+=weights[j]*stack[start+n+i*weights.length+j];
          stack.length=start+n;
        } else if (b === 10 || b === 29) {
          const subrs = (b === 10 ? (this.cff2 ? this.cffFontDicts[this.cffSelect[glyphIndex]].subrs : this.cffLocalSubrs) : this.cffGlobalSubrs) ?? [];
          const index = pop() + (subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768);
          if (!Number.isInteger(index) || !subrs[index]) fontError('Type 2 subroutine index is invalid');
          execute(subrs[index], depth + 1);
        } else if (b === 11) {
          if (this.cff2) fontError('CFF2 return operator is reserved');
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
          if (this.cff2) fontError('CFF2 endchar operator is reserved');
          width(stack.length >= 4 ? 4 : 0);
          if (stack.length === 4) {
            if (component || loop.length || contours.length)
              fontError('Type 2 endchar composites cannot be nested or contain a path');
            const [dx, dy, base, accent] = stack;
            const resolve = (code: number) => {
              const sid = standardSID(code),
                index = this.cffCharset!.indexOf(sid);
              if (!sid || index < 0) fontError('Type 2 composite component is missing from charset');
              const parts: number[][][] | undefined = raw && [];
              const result = this.getCFFContours(index, curveSegments, true, parts);
              return { result, parts: parts ?? [] };
            };
            const first = resolve(base),
              second = resolve(accent);
            contours.push(...first.result, ...second.result.map((c) => c.map(([x, y]): Point2D => [x + dx, y + dy])));
            if (raw)
              raw.push(...first.parts, ...second.parts.map((c) => c.map((s) => s.map((v, i) => v + (i % 2 ? dy : dx)))));
          } else if (stack.length) fontError('Type 2 endchar operand count is invalid');
          finish();
          ended = true;
        } else if (b === 12) {
          const op = r.u8();
          if (this.cff2 && op < 34) fontError('CFF2 escaped arithmetic operator is reserved');
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
        if (stack.length > (this.cff2 ? 513 : 48) || stack.some((v) => !Number.isFinite(v)) || !Number.isFinite(x) || !Number.isFinite(y))
          fontError('Type 2 operand stack is invalid or exceeds 48');
      }
      if (this.cff2) { if (!depth) { if(stack.length)fontError('CFF2 charstring has trailing operands'); finish(); ended=true; } }
      else if (!ended) fontError(depth ? 'Type 2 subroutine is missing return' : 'Type 2 charstring is missing endchar');
    };
    execute(charString, 0);
    return contours;
  }
}


/** Parses font binary data into a reusable FontOutlines object. */
export function parseFontOutlines(fontData: ArrayBuffer | ArrayBufferView, options: FontVariationOptions = {}): FontOutlines {
  if (!fontData || (!(fontData instanceof ArrayBuffer) && !ArrayBuffer.isView(fontData))) {
    throw new TypeError(
      'parseFontOutlines requires an ArrayBuffer or TypedArray view of font bytes; pass a valid buffer',
    );
  }
  return new FontOutlines(fontData, options);
}
