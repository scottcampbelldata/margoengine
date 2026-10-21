import type { Shape } from '@margoengine/geometry';
import { outlineShapes, type OutlineCommand, type OutlineFillRule } from './outline.js';

/** One glyph of an `OutlineFont`, in font units: y up, origin on the baseline at the pen position. */
export interface OutlineGlyph {
  /** Glyph index in the font. */
  index: number;
  /** Horizontal advance to the next pen position. */
  advance: number;
  /** The outline: quadratic curves for TrueType; any outline commands for other sources. */
  commands: readonly OutlineCommand[];
}

/**
 * What an `OutlineFont` reads its glyphs from. `parseTTF` builds one; implement it to lay out
 * outlines from another source. Lengths are font units, y up.
 */
export interface OutlineFontSource {
  /** Font units per em; `size` in `generateShapes` is one em. */
  unitsPerEm: number;
  /** Top of the tallest letters above the baseline (positive). */
  ascender: number;
  /** Bottom of descenders, below the baseline (negative). */
  descender: number;
  /** Baseline-to-baseline distance. */
  lineHeight: number;
  /** Number of glyphs; indices run from 0 to `glyphCount - 1`. */
  glyphCount: number;
  familyName?: string;
  styleName?: string;
  /** Glyph index for a Unicode code point, or undefined when the font has none. */
  glyphIndex(codePoint: number): number | undefined;
  /** The glyph at `index` (0 <= index < `glyphCount`). */
  glyph(index: number): OutlineGlyph;
  /** Extra advance between two glyph indices, usually negative; 0 when the pair has none. */
  kerning?(left: number, right: number): number;
  /** Glyph drawn for characters the font lacks (TrueType: 0, `.notdef`); undefined skips them. */
  missingGlyph?: number;
  /** Fill rule of the outlines. Default `'nonzero'` (TrueType's). */
  fillRule?: OutlineFillRule;
}

/** Layout options of `OutlineFont.generateShapes` and `textGeometry`. */
export interface TextShapeOptions {
  /** Extra space after every character, as a fraction of `size` (CSS `letter-spacing` in em). Default 0. */
  letterSpacing?: number;
  /** Line spacing as a multiple of the font's line height; `\n` starts a line. Default 1. */
  lineHeight?: number;
  /** Horizontal alignment of each line around x = 0. Default `'left'` (lines start at x = 0). */
  align?: 'left' | 'center' | 'right';
  /** Applies the font's kerning pairs. Default true. */
  kerning?: boolean;
}

const codePoint = (char: string | number, what: string): number => {
  const value = typeof char === 'number' ? char : typeof char === 'string' ? char.codePointAt(0) : undefined;
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > 0x10ffff)
    throw new TypeError(`${what} is not a character or code point; pass a one-character string or a number`);
  return value;
};

/**
 * A font of glyph outlines (TrueType through `parseTTF`) that lays out text as geometry `Shape`s. Glyphs decode on
 * first use and are cached.
 */
export class OutlineFont {
  /** Font units per em. */
  readonly unitsPerEm: number;
  /** Font units above the baseline. */
  readonly ascender: number;
  /** Font units below the baseline (negative). */
  readonly descender: number;
  /** Baseline-to-baseline distance in font units. */
  readonly lineHeight: number;
  /** Number of glyphs in the font. */
  readonly glyphCount: number;
  /** Family name from the font, when it has one. */
  readonly familyName: string | undefined;
  /** Style name (`Regular`, `Bold Italic`, ...) from the font, when it has one. */
  readonly styleName: string | undefined;
  private readonly source: OutlineFontSource;
  private readonly glyphs = new Map<number, OutlineGlyph>();

  constructor(source: OutlineFontSource) {
    if (!source || typeof source.glyphIndex !== 'function' || typeof source.glyph !== 'function')
      throw new TypeError('OutlineFont source is not a font source; pass one with glyphIndex() and glyph()');
    for (const key of ['unitsPerEm', 'ascender', 'descender', 'lineHeight', 'glyphCount'] as const)
      if (!Number.isFinite(source[key]))
        throw new RangeError(`OutlineFont source ${key} is ${source[key]}; give a finite number`);
    if (source.unitsPerEm <= 0) throw new RangeError('OutlineFont unitsPerEm must be positive; give units per em');
    this.source = source;
    this.unitsPerEm = source.unitsPerEm;
    this.ascender = source.ascender;
    this.descender = source.descender;
    this.lineHeight = source.lineHeight;
    this.glyphCount = source.glyphCount;
    this.familyName = source.familyName;
    this.styleName = source.styleName;
  }

  /** Glyph index of a character (a string's first code point, or a code point), or undefined when it is missing. */
  glyphIndex(char: string | number): number | undefined {
    return this.source.glyphIndex(codePoint(char, 'OutlineFont character'));
  }

  /** The glyph of a character in font units, or undefined when the font lacks it. */
  glyph(char: string | number): OutlineGlyph | undefined {
    const index = this.glyphIndex(char);
    return index === undefined ? undefined : this.glyphAt(index);
  }

  /** Kerning between two characters in font units (0 when the pair has none). */
  kerning(left: string | number, right: string | number): number {
    const a = this.glyphIndex(left),
      b = this.glyphIndex(right);
    return a === undefined || b === undefined || !this.source.kerning ? 0 : this.source.kerning(a, b);
  }

  private glyphAt(index: number): OutlineGlyph {
    let glyph = this.glyphs.get(index);
    if (!glyph) this.glyphs.set(index, (glyph = this.source.glyph(index)));
    return glyph;
  }

  /**
   * Lays out `text` with one em = `size` units and returns its glyph outlines as geometry `Shape`s, holes assigned
   * (three.js `Font.generateShapes`). The first baseline is y = 0 and lines go down by the line height; `\n` breaks a
   * line. Characters the font lacks draw its missing glyph. Feed the result to `extrudeGeometry` or `shapeGeometry`.
   */
  generateShapes(text: string, size = 100, options: TextShapeOptions = {}): Shape[] {
    if (typeof text !== 'string') throw new TypeError('generateShapes text is not a string; pass a string');
    if (!Number.isFinite(size) || size <= 0) throw new RangeError(`generateShapes size ${size} must be positive`);
    const spacing = options.letterSpacing ?? 0,
      leading = options.lineHeight ?? 1,
      align = options.align ?? 'left',
      kern = options.kerning ?? true;
    if (!Number.isFinite(spacing)) throw new RangeError('letterSpacing must be a finite number of ems');
    if (!Number.isFinite(leading)) throw new RangeError('lineHeight must be a finite multiple of the line height');
    if (align !== 'left' && align !== 'center' && align !== 'right')
      throw new RangeError(`align "${String(align)}" is not left, center or right`);
    const source = this.source,
      scale = size / this.unitsPerEm,
      fillRule = source.fillRule ?? 'nonzero',
      shapes: Shape[] = [];
    text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .forEach((line, row) => {
        const y = -row * this.lineHeight * scale * leading,
          placed: [OutlineGlyph, number][] = [];
        let x = 0,
          previous: number | undefined;
        for (const char of line) {
          const index = source.glyphIndex(char.codePointAt(0) as number) ?? source.missingGlyph;
          if (index === undefined) continue;
          if (kern && previous !== undefined && source.kerning) x += source.kerning(previous, index) * scale;
          const glyph = this.glyphAt(index);
          placed.push([glyph, x]);
          x += glyph.advance * scale + spacing * size;
          previous = index;
        }
        const width = placed.length ? x - spacing * size : 0,
          shift = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
        for (const [glyph, at] of placed)
          if (glyph.commands.length)
            shapes.push(
              ...outlineShapes(glyph.commands, fillRule, (gx, gy) => [at + shift + gx * scale, y + gy * scale]),
            );
      });
    return shapes;
  }
}
