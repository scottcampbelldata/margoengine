import type { Shape } from '@margoengine/geometry/shapes';
import { type OutlineCommand, type OutlineFillRule, outlineShapes } from './outline.js';

/** One glyph in font units: y up, origin on the baseline at the pen position. */
export interface OutlineGlyph {
  /** Glyph index in the font. */
  index: number;
  /** Horizontal advance to the next pen position. */
  advance: number;
  /** Outline commands: quadratic for TrueType, any commands for other sources. Empty for blank glyphs (space). */
  commands: readonly OutlineCommand[];
}

/** What an `OutlineFont` reads glyphs from. `parseTTF` builds one; implement it for other outline sources. */
export interface OutlineFontSource {
  /** Font units per em: `generateShapes`' size is one em. */
  unitsPerEm: number;
  /** Height above the baseline, positive. */
  ascender: number;
  /** Depth below the baseline, negative. */
  descender: number;
  /** Baseline-to-baseline distance. */
  lineHeight: number;
  /** Glyph indices run 0 to glyphCount - 1. */
  glyphCount: number;
  familyName?: string;
  styleName?: string;
  /** Glyph index of a Unicode code point, or undefined when the font has no glyph for it. */
  glyphIndex(codePoint: number): number | undefined;
  /** The glyph at `index` (0 <= index < glyphCount). */
  glyph(index: number): OutlineGlyph;
  /** Extra advance between two glyph indices, in font units; 0 when the pair has none. */
  kerning?(left: number, right: number): number;
  /** Glyph drawn for characters the font lacks (TrueType: 0, .notdef). Undefined skips such characters. */
  missingGlyph?: number;
  /** Fill rule of the outlines. Default 'nonzero'. */
  fillRule?: OutlineFillRule;
}

/** Layout options of `generateShapes` and `textGeometry`. */
export interface TextShapeOptions {
  /** Extra space after every character, in ems of `size`. Default 0. */
  letterSpacing?: number;
  /** Line distance as a multiple of the font's `lineHeight`; `'\n'` starts a new line. Default 1. */
  lineHeight?: number;
  /** Where each line sits relative to x = 0. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Apply the source's kerning pairs. Default true. */
  kerning?: boolean;
}

const NAME = 'OutlineFont';
const METRICS = ['unitsPerEm', 'ascender', 'descender', 'lineHeight', 'glyphCount'] as const;
const ALIGNS = ['left', 'center', 'right'];

/** The code point a character argument stands for: a string's first code point, or an integer code point. */
function toCodePoint(char: unknown): number {
  const cp = typeof char === 'string' ? char.codePointAt(0) : char;
  if (typeof cp !== 'number' || !Number.isInteger(cp) || cp < 0 || cp > 0x10ffff)
    throw new TypeError(
      `${NAME} character ${describe(char)} is not a character or code point; pass a one-character string or a number`,
    );
  return cp;
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value.slice(0, 16)) : String(value).slice(0, 32);
}

/**
 * A font of glyph outlines that lays out text as geometry Shapes, for `shapeGeometry`, `extrudeGeometry` or
 * `textGeometry`. Build one with `parseTTF`, or from any `OutlineFontSource`. Glyphs are decoded on first use and
 * cached.
 */
export class OutlineFont {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineHeight: number;
  readonly glyphCount: number;
  readonly familyName: string | undefined;
  readonly styleName: string | undefined;
  private readonly source: OutlineFontSource;
  private readonly glyphs = new Map<number, OutlineGlyph>();

  /** Throws `TypeError` for a source without `glyphIndex()`/`glyph()`, `RangeError` for non-finite metrics. */
  constructor(source: OutlineFontSource) {
    if (!source || typeof source.glyphIndex !== 'function' || typeof source.glyph !== 'function')
      throw new TypeError(`${NAME} source is not a font source; pass one with glyphIndex() and glyph()`);
    for (const key of METRICS)
      if (!Number.isFinite(source[key]))
        throw new RangeError(`${NAME} source ${key} is ${String(source[key])}; give a finite number`);
    if (source.unitsPerEm <= 0)
      throw new RangeError(`${NAME} source unitsPerEm is ${source.unitsPerEm}; give a positive number of units per em`);
    this.source = source;
    this.unitsPerEm = source.unitsPerEm;
    this.ascender = source.ascender;
    this.descender = source.descender;
    this.lineHeight = source.lineHeight;
    this.glyphCount = source.glyphCount;
    this.familyName = source.familyName;
    this.styleName = source.styleName;
  }

  /** Glyph index of a character (a string's first code point) or code point; undefined when the font lacks it. */
  glyphIndex(char: string | number): number | undefined {
    return this.source.glyphIndex(toCodePoint(char));
  }

  /** The glyph of a character or code point, in font units; undefined when the font lacks it. */
  glyph(char: string | number): OutlineGlyph | undefined {
    const index = this.glyphIndex(char);
    return index === undefined ? undefined : this.decoded(index);
  }

  /** Kerning between two characters or code points, in font units; 0 when either is missing or there is none. */
  kerning(left: string | number, right: string | number): number {
    const l = this.glyphIndex(left),
      r = this.glyphIndex(right);
    if (l === undefined || r === undefined || !this.source.kerning) return 0;
    return this.source.kerning(l, r);
  }

  /**
   * Lays out `text` as Shapes with holes, `size` units per em (default 100). The first baseline lies on y = 0 with
   * y up, and each `'\n'` (also CR LF or CR) moves down one line. Characters the font lacks draw its `missingGlyph`,
   * or are skipped when it has none.
   */
  generateShapes(text: string, size = 100, options: TextShapeOptions = {}): Shape[] {
    if (typeof text !== 'string')
      throw new TypeError(`${NAME} text is ${typeof text}, not a string; pass the text to lay out`);
    if (!Number.isFinite(size) || size <= 0)
      throw new RangeError(`${NAME} size is ${String(size)}; give a positive number of units per em`);
    const opts = options ?? {},
      spacing = opts.letterSpacing === undefined ? 0 : opts.letterSpacing,
      leading = opts.lineHeight === undefined ? 1 : opts.lineHeight,
      align = opts.align === undefined ? 'left' : opts.align;
    if (!Number.isFinite(spacing))
      throw new RangeError(`${NAME} letterSpacing is ${String(spacing)}; give a finite number of ems`);
    if (!Number.isFinite(leading))
      throw new RangeError(`${NAME} lineHeight is ${String(leading)}; give a finite multiple of the line height`);
    if (!ALIGNS.includes(align as string))
      throw new RangeError(`${NAME} align is ${describe(align)}; use 'left', 'center' or 'right'`);
    const source = this.source,
      scale = size / this.unitsPerEm,
      fillRule = source.fillRule ?? 'nonzero',
      kern = opts.kerning !== false && typeof source.kerning === 'function',
      gap = spacing * size,
      lineStep = this.lineHeight * scale * leading,
      shapes: Shape[] = [];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let row = 0; row < lines.length; row++) {
      const baseline = row ? -row * lineStep : 0,
        placed: { glyph: OutlineGlyph; x: number }[] = [];
      let pen = 0,
        previous: number | undefined;
      for (const char of lines[row]) {
        const index = source.glyphIndex(char.codePointAt(0) as number) ?? source.missingGlyph;
        if (index === undefined) continue;
        if (kern && previous !== undefined)
          pen += (source.kerning as (l: number, r: number) => number)(previous, index) * scale;
        const glyph = this.decoded(index);
        placed.push({ glyph, x: pen });
        pen += glyph.advance * scale + gap;
        previous = index;
      }
      const width = placed.length ? pen - gap : 0,
        shift = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
      for (const { glyph, x } of placed) {
        if (!glyph.commands?.length) continue;
        const left = x + shift;
        shapes.push(...outlineShapes(glyph.commands, fillRule, (gx, gy) => [left + gx * scale, baseline + gy * scale]));
      }
    }
    return shapes;
  }

  /** The glyph at a font index, decoded once and then served from the cache. */
  private decoded(index: number): OutlineGlyph {
    let glyph = this.glyphs.get(index);
    if (!glyph) {
      glyph = this.source.glyph(index);
      this.glyphs.set(index, glyph);
    }
    return glyph;
  }
}
