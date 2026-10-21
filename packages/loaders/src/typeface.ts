import { LoaderError } from './types.js';
import type { OutlineCommand } from './outline.js';
import { OutlineFont, type OutlineGlyph } from './outline-font.js';

const F = 'Typeface';

/** One glyph of a typeface JSON font. */
export interface TypefaceGlyph {
  /** Horizontal advance in font units. */
  ha: number;
  x_min?: number;
  x_max?: number;
  /**
   * Outline: `m x y`, `l x y`, `q x y cx cy` (end point, then control point), `b x y c1x c1y c2x c2y` (end point,
   * then both control points) and `z`, separated by spaces.
   */
  o?: string;
}

/** A typeface JSON font (the format three.js `FontLoader` reads, written by facetype.js), keyed by character. */
export interface TypefaceJSON {
  glyphs: Record<string, TypefaceGlyph>;
  /** Font units per em. */
  resolution: number;
  familyName?: string;
  ascender?: number;
  descender?: number;
  underlinePosition?: number;
  underlineThickness?: number;
  boundingBox?: { xMin: number; xMax: number; yMin: number; yMax: number };
  cssFontWeight?: string;
  cssFontStyle?: string;
}

function outline(text: string, char: string): OutlineCommand[] {
  const tokens = text.trim().split(/\s+/),
    out: OutlineCommand[] = [];
  let i = 0;
  const value = (): number => {
    const token = tokens[i++],
      number = Number(token);
    if (token === undefined || token === '' || !Number.isFinite(number))
      throw new LoaderError(F, 'syntax', `glyph "${char}" has "${String(token).slice(0, 16)}" where a number belongs`);
    return number;
  };
  while (i < tokens.length) {
    const command = tokens[i++];
    switch (command) {
      case '':
        break;
      case 'm':
        out.push(['M', value(), value()]);
        break;
      case 'l':
        out.push(['L', value(), value()]);
        break;
      case 'q': {
        const x = value(),
          y = value();
        out.push(['Q', value(), value(), x, y]);
        break;
      }
      case 'b': {
        const x = value(),
          y = value(),
          c1x = value(),
          c1y = value();
        out.push(['C', c1x, c1y, value(), value(), x, y]);
        break;
      }
      case 'z':
        out.push(['Z']);
        break;
      default:
        throw new LoaderError(F, 'syntax', `glyph "${char}" has the unknown command "${command.slice(0, 16)}"`);
    }
  }
  return out;
}

/**
 * Reads a typeface JSON font (three.js `FontLoader`'s format: `glyphs` keyed by character with `ha` advances and `o`
 * outlines, `resolution` units per em) into an `OutlineFont`. Pass the parsed object or its JSON text. The line
 * height is the bounding box height plus the underline thickness, as three.js lays out these fonts; characters the
 * font lacks draw its `?` glyph. Outlines parse on first use; a malformed one throws a `LoaderError` naming the glyph.
 */
export function parseTypefaceJSON(json: TypefaceJSON | string): OutlineFont {
  let data: TypefaceJSON;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (error) {
    throw new LoaderError(F, 'syntax', `the text is not JSON (${(error as Error).message})`);
  }
  if (!data || typeof data !== 'object' || !data.glyphs || typeof data.glyphs !== 'object')
    throw new TypeError('parseTypefaceJSON input has no glyphs object; pass a typeface JSON font');
  const resolution = data.resolution;
  if (!Number.isFinite(resolution) || resolution <= 0)
    throw new LoaderError(F, 'header', `resolution ${String(resolution)} is not a positive number of units per em`);
  const keys = Object.keys(data.glyphs),
    byCode = new Map<number, number>();
  keys.forEach((key, index) => {
    const code = key.codePointAt(0);
    if (code !== undefined && key.length === String.fromCodePoint(code).length) byCode.set(code, index);
  });
  const box = data.boundingBox,
    ascender = data.ascender ?? box?.yMax ?? resolution * 0.8,
    descender = data.descender ?? box?.yMin ?? -resolution * 0.2,
    lineHeight = box ? box.yMax - box.yMin + (data.underlineThickness ?? 0) : ascender - descender;
  return new OutlineFont({
    unitsPerEm: resolution,
    ascender,
    descender,
    lineHeight,
    glyphCount: keys.length,
    familyName: data.familyName,
    missingGlyph: byCode.get(63),
    glyphIndex: (c) => byCode.get(c),
    glyph(index): OutlineGlyph {
      const key = keys[index],
        glyph = key === undefined ? undefined : data.glyphs[key];
      if (!glyph) throw new RangeError(`glyph index ${index} is outside 0..${keys.length - 1}; use glyphIndex()`);
      const advance = Number(glyph.ha ?? 0);
      if (!Number.isFinite(advance))
        throw new LoaderError(F, 'syntax', `glyph "${key}" has the advance ${String(glyph.ha)}, not a number`);
      return { index, advance, commands: glyph.o ? outline(String(glyph.o), key) : [] };
    },
  });
}
