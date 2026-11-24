import {
  parseTTFSource,
  type FontVariationAxis,
  type OpenTypeReaders,
  type OutlineGlyph,
  type TTFFontSource,
} from '@margoengine/loaders/font';
import { MargoError } from '@margoengine/math/errors';
import { fontError, FONT_HELP } from './font-reader.js';
// Glyph outlines for @margoengine/text/extrude, /vector and /outline. The font is parsed by @margoengine/loaders
// (`parseTTFSource`, Margo's one OpenType outline parser: TrueType, CFF, CFF2 and variable fonts); this module turns
// its glyph commands into the em-unit contours and segments the text builders use.

import type { FontVariationOptions } from './font-variation.js';

/** A 2D point as an [x, y] tuple. */
export type Point2D = [number, number];

/** Vertices one flattened glyph may hold. */
const MAX_VERTICES = 16384;

export function subdivision(name: string, value: number, min: number, max = 256): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MargoError(
      'failed',
      `extrudeText ${name} must be an integer from ${min} to ${max}; reduce subdivisions. Help: ${FONT_HELP}`,
    );
  }
  return value;
}

/** Glyph outlines of one font instance in em units, read through `@margoengine/loaders/font`. */
export class FontOutlines {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  private readonly source: TTFFontSource;
  private readonly bytes: Uint8Array;
  private readonly openType: OpenTypeReaders | undefined;
  private readonly glyphs = new Map<number, OutlineGlyph>();

  constructor(buffer: ArrayBuffer | ArrayBufferView, options: FontVariationOptions = {}) {
    this.bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    this.openType = options.openType;
    this.source = parseTTFSource(this.bytes, { variations: options.variations, openType: options.openType });
    this.unitsPerEm = this.source.unitsPerEm;
    this.ascender = this.source.ascender;
    this.descender = this.source.descender;
  }

  /** Number of glyph IDs in the font. */
  get glyphCount(): number {
    return this.source.glyphCount;
  }
  /** The bytes of an sfnt table by tag (for example 'GPOS'), or undefined when the font has none. */
  tableBytes(tag: string): Uint8Array | undefined {
    return this.source.table(tag);
  }
  /** True when the instance sets any variation axis. */
  get varied(): boolean {
    return this.source.variationCoordinates.some((c) => c !== 0);
  }
  /** Supported variation axes in user units. */
  get variationAxes(): readonly FontVariationAxis[] {
    return this.source.variationAxes;
  }
  /** Create an independent immutable instance at axis values; omitted values use the font defaults. */
  withVariations(variations: Readonly<Record<string, number>>): FontOutlines {
    return new FontOutlines(this.bytes, { variations, openType: this.openType });
  }
  /** Resolves Unicode code point or 1-character string to a glyph index; 0 (.notdef) when the font lacks it. */
  glyphIndex(charOrCode: string | number): number {
    const cp = typeof charOrCode === 'string' ? (charOrCode.codePointAt(0) ?? 0) : charOrCode;
    return this.source.glyphIndex(cp) ?? 0;
  }

  /** Returns advance width for glyph index, normalized to 1 em (1 for an index outside the font). */
  glyphAdvance(glyphIndex: number): number {
    const glyph = this.glyph(glyphIndex);
    return glyph ? glyph.advance / this.unitsPerEm : 1;
  }

  /** Extracts 2D contours for a glyph index, normalized to em coordinates (including negative bearings). */
  getGlyphContours(glyphIndex: number, curveSegments = 12): Point2D[][] {
    subdivision('curveSegments', curveSegments, 1);
    const glyph = this.glyph(glyphIndex);
    if (!glyph) return [];
    const em = this.unitsPerEm,
      loops: Point2D[][] = [];
    let loop: Point2D[] = [],
      count = 0,
      x = 0,
      y = 0;
    const add = (px: number, py: number) => {
      if (++count > MAX_VERTICES) fontError(`flattened glyph exceeds ${MAX_VERTICES} vertices`);
      loop.push([px / em, py / em]);
    };
    const close = () => {
      const first = loop[0],
        last = loop[loop.length - 1];
      if (loop.length > 1 && first[0] === last[0] && first[1] === last[1]) loop.pop();
      if (loop.length >= 3) loops.push(loop);
      loop = [];
    };
    for (const c of glyph.commands) {
      if (c[0] === 'M') {
        if (loop.length) close();
        add((x = c[1]), (y = c[2]));
      } else if (c[0] === 'L') add((x = c[1]), (y = c[2]));
      else if (c[0] === 'Q') {
        for (let j = 1; j <= curveSegments; j++) {
          const t = j / curveSegments,
            u = 1 - t;
          add(u * u * x + 2 * u * t * c[1] + t * t * c[3], u * u * y + 2 * u * t * c[2] + t * t * c[4]);
        }
        [x, y] = [c[3], c[4]];
      } else if (c[0] === 'C') {
        for (let j = 1; j <= curveSegments; j++) {
          const t = j / curveSegments,
            u = 1 - t;
          add(
            u * u * u * x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
            u * u * u * y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
          );
        }
        [x, y] = [c[5], c[6]];
      }
    }
    if (loop.length) close();
    return loops;
  }

  /**
   * The glyph outline as unflattened segments in em units, variations applied: one array per closed contour,
   * each segment [x0, y0, x1, y1] (line), [x0, y0, cx, cy, x1, y1] (quadratic) or [x0, y0, c1x, c1y, c2x, c2y,
   * x1, y1] (cubic). Out-of-range glyph indices give []. Used by `@margoengine/text/vector`.
   */
  getGlyphSegments(glyphIndex: number): number[][][] {
    const glyph = this.glyph(glyphIndex);
    if (!glyph) return [];
    const em = this.unitsPerEm,
      loops: number[][][] = [];
    let loop: number[][] = [],
      sx = 0,
      sy = 0,
      x = 0,
      y = 0;
    const close = () => {
      if (loop.length && (x !== sx || y !== sy)) loop.push([x / em, y / em, sx / em, sy / em]);
      if (loop.length) loops.push(loop);
      loop = [];
      [x, y] = [sx, sy];
    };
    for (const c of glyph.commands) {
      if (c[0] === 'M') {
        close();
        [sx, sy, x, y] = [c[1], c[2], c[1], c[2]];
      } else if (c[0] === 'Z') close();
      else {
        const segment = [x / em, y / em];
        for (let i = 1; i < c.length; i++) segment.push((c[i] as number) / em);
        loop.push(segment);
        [x, y] = [c[c.length - 2] as number, c[c.length - 1] as number];
      }
    }
    close();
    return loops;
  }

  /** The decoded glyph at an index, cached; undefined outside the font. */
  private glyph(index: number): OutlineGlyph | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.source.glyphCount) return undefined;
    let glyph = this.glyphs.get(index);
    if (!glyph) {
      glyph = this.source.glyph(index);
      this.glyphs.set(index, glyph);
    }
    return glyph;
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
