// Rich text: small markup into styled spans, laid out word by word, each piece drawn by its own Text.
import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from '@margoengine/math';
import type { ColorInput } from './color.js';
import { Font, type GlyphBitmap } from './font.js';
import type { TextMeasurer } from './layout.js';
import { Text, type TextStyleOptions } from './text.js';

/** One run of {@link parseRichText}: text or an image name, with its style. */
export interface RichSpan {
  /** The run's text; empty for an image. */
  text: string;
  /** Name of an inline image. */
  image?: string;
  bold: boolean;
  italic: boolean;
  /** Colour from a `color` tag. */
  color?: string;
  /** Size as a multiple of `fontSize`. Default 1. */
  size: number;
  /** Target of a `link` tag. */
  link?: string;
}

/**
 * Parses markup: `<b>`, `<i>`, `<color=#f80>`, `<size=1.5>`, `<link=url>`, closed by `</b>` and so on, and `<img=name>`.
 * `\<` is a literal bracket.
 * @throws TypeError on an unknown tag, a closing tag that does not match, an unclosed tag or a size that is not a finite
 * number above 0.
 */
export function parseRichText(markup: string): RichSpan[] {
  if (typeof markup !== 'string') throw new TypeError('Rich text markup must be a string; pass text with tags');
  const spans: RichSpan[] = [],
    stack: Array<{ tag: string; apply: Partial<RichSpan> }> = [];
  let style: Omit<RichSpan, 'text'> = { bold: false, italic: false, size: 1 },
    buffer = '';
  const flush = () => {
    if (buffer) spans.push({ ...style, text: buffer });
    buffer = '';
  };
  const restyle = () => {
    style = { bold: false, italic: false, size: 1 };
    for (const entry of stack) style = { ...style, ...entry.apply };
  };
  for (let i = 0; i < markup.length; i++) {
    const c = markup[i];
    if (c === '\\' && markup[i + 1] === '<') {
      buffer += '<';
      i++;
      continue;
    }
    if (c !== '<') {
      buffer += c;
      continue;
    }
    const end = markup.indexOf('>', i);
    if (end < 0) throw new TypeError('Rich text has a < with no >; write \\< for a literal bracket');
    const tag = markup.slice(i + 1, end);
    i = end;
    flush();
    if (tag[0] === '/') {
      const open = stack.pop();
      if (open?.tag !== tag.slice(1))
        throw new TypeError(`Rich text closes </${tag.slice(1)}> out of order; close the innermost tag first`);
      restyle();
      continue;
    }
    const split = tag.indexOf('='),
      name = split < 0 ? tag : tag.slice(0, split),
      value = split < 0 ? '' : tag.slice(split + 1);
    if (name === 'img' && value) {
      spans.push({ ...style, text: '', image: value });
      continue;
    }
    let apply: Partial<RichSpan>;
    if (name === 'b') apply = { bold: true };
    else if (name === 'i') apply = { italic: true };
    else if (name === 'color' && value) apply = { color: value };
    else if (name === 'link' && value) apply = { link: value };
    // Finite too (batch 132b): <size=Infinity> or <size=1e999> used to pass and lay every piece out at NaN.
    else if (name === 'size' && Number(value) > 0 && Number.isFinite(Number(value))) apply = { size: Number(value) };
    else throw new TypeError(`Unknown rich text tag <${tag}>; use b, i, color, size (a finite number above 0), link or img`);
    stack.push({ tag: name, apply });
    restyle();
  }
  flush();
  if (stack.length) throw new TypeError(`Rich text leaves <${stack[stack.length - 1].tag}> open; close it`);
  return spans;
}

/** One placed piece of {@link layoutRichText}: `x` at its left edge and `y` on its baseline, y up, world units. */
export interface RichPiece extends RichSpan {
  x: number;
  y: number;
  width: number;
  line: number;
}

/** Options of {@link layoutRichText}. */
export interface RichLayoutOptions {
  /** Em size in world units. Default 1. */
  fontSize?: number;
  /** Line box height as a multiple of the line's largest size. Default 1.2. */
  lineHeight?: number;
  /** Wrap width in world units. Default Infinity. */
  maxWidth?: number;
  /** Order of the pieces on a line; text inside a piece keeps its own direction. Default 'ltr'. */
  direction?: 'ltr' | 'rtl';
}

/** Lays spans out in lines, breaking at spaces and newlines. Pure for deterministic measurers. An image is one em high, its width from `imageWidth` in em. */
export function layoutRichText(
  spans: readonly RichSpan[],
  options: RichLayoutOptions,
  measurer: (span: RichSpan) => TextMeasurer,
  imageWidth: (name: string) => number = () => 1,
): { pieces: RichPiece[]; width: number; height: number } {
  const fontSize = options.fontSize ?? 1,
    lineHeight = options.lineHeight ?? 1.2,
    maxWidth = options.maxWidth ?? Infinity;
  if (!(fontSize > 0 && lineHeight > 0 && maxWidth > 0))
    throw new RangeError('fontSize, lineHeight and maxWidth must be above 0; pass positive numbers');
  const pieces: RichPiece[] = [];
  let line = 0,
    x = 0,
    y = 0,
    width = 0,
    first = 0,
    tallest = 0,
    hang = 0;
  const end = () => {
    const size = (tallest || 1) * fontSize,
      ascent = 0.8 * size;
    // Trailing spaces hang out of the line.
    if (hang) {
      const last = pieces[pieces.length - 1];
      last.text = last.text.trimEnd();
      last.width -= hang;
      x -= hang;
      if (!last.text) pieces.pop();
    }
    hang = 0;
    if (options.direction === 'rtl')
      for (let i = first; i < pieces.length; i++) pieces[i].x = x - pieces[i].x - pieces[i].width;
    for (let i = first; i < pieces.length; i++) pieces[i].y = y - ascent;
    width = Math.max(width, x);
    y -= size * lineHeight;
    x = tallest = 0;
    first = pieces.length;
    line++;
  };
  const place = (span: RichSpan, text: string, advance: number) => {
    if (x > 0 && x + advance > maxWidth && text.trim()) end();
    tallest = Math.max(tallest, span.size);
    // Same style next to the last piece on this line: extend it, so a sentence stays one Text.
    const last = pieces[pieces.length - 1];
    if (
      last &&
      pieces.length > first &&
      !span.image &&
      !last.image &&
      last.bold === span.bold &&
      last.italic === span.italic &&
      last.color === span.color &&
      last.size === span.size &&
      last.link === span.link
    ) {
      last.text += text;
      last.width += advance;
    } else pieces.push({ ...span, text, x, y: 0, width: advance, line });
    x += advance;
    hang = span.image || text.trim() ? 0 : advance;
  };
  for (const span of spans) {
    const em = span.size * fontSize;
    if (span.image) {
      place(span, '', imageWidth(span.image) * em);
      continue;
    }
    const m = measurer(span);
    for (const token of span.text.split(/(\n| +)/)) {
      if (!token) continue;
      if (token === '\n') end();
      else place(span, token, m.advance(token) * em);
    }
  }
  end();
  return { pieces, width, height: -y };
}

/** A Font that draws one image as one em-high colour glyph, so an inline image sits in the text atlas. Used by {@link RichText}. */
export class ImageFont extends Font {
  private bitmap?: GlyphBitmap;
  constructor(readonly image: ImageBitmap) {
    super();
  }
  override get loaded(): boolean {
    return true;
  }
  /** Width of the image in em. */
  get aspect(): number {
    return this.image.width / this.image.height;
  }
  override advance(): number {
    return this.aspect;
  }
  override kerning(): number {
    return 0;
  }
  override metrics(): { ascent: number; descent: number } {
    return { ascent: 0.8, descent: 0.2 };
  }
  override glyph(cluster: string): GlyphBitmap {
    if (this.bitmap) return this.bitmap;
    if (typeof OffscreenCanvas === 'undefined')
      throw new MargoError('unsupported', 'Inline images need OffscreenCanvas; run in a browser or worker');
    const width = Math.max(1, Math.round(this.aspect * this.size)),
      height = this.size,
      context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
    context.drawImage(this.image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data,
      data = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3];
      for (let k = 0; k < 3; k++) data[i + k] = Math.round((pixels[i + k] * a) / 255);
      data[i + 3] = a;
    }
    return (this.bitmap = { cluster, width, height, left: 0, top: Math.round(0.8 * height), color: true, data });
  }
}

/** Options of {@link RichText}: markup, its fonts and layout, and the style every piece starts from. */
export interface RichTextOptions extends RichLayoutOptions, TextStyleOptions {
  /** The markup; see {@link parseRichText}. */
  markup: string;
  /** Regular font. Default a new sans-serif Font. */
  font?: Font;
  /** Bold, italic and bold italic fonts. Default made from `font`'s family. */
  bold?: Font;
  /** See `bold`. */
  italic?: Font;
  /** See `bold`. */
  boldItalic?: Font;
  /** Images for `<img=name>`. */
  images?: Readonly<Record<string, ImageBitmap>>;
  /** Top-left corner of the block. Default [0, 0, 0]. */
  position?: Vec3;
  /** Colour of `<link>` text. Default '#4080ff'. */
  linkColor?: ColorInput;
}

/**
 * A block of styled text: one `Text` per run of equal style. Add its {@link texts} to a `TextRenderer`:
 * `for (const t of rich.texts) renderer.add(t)`. Wait for `await rich.load()` before measuring with web fonts.
 * @throws TypeError on bad markup or an `<img>` missing from `images`.
 */
export class RichText {
  /** The Text objects to add to a renderer. */
  readonly texts: Text[] = [];
  /** Width of the block in world units. */
  readonly width: number;
  /** Height of the block in world units. */
  readonly height: number;
  private readonly pieces: RichPiece[];

  constructor(readonly options: RichTextOptions) {
    const { markup, font = new Font(), images = {}, position = [0, 0, 0], linkColor = '#4080ff' } = options,
      fonts = options,
      made = new Map<string, Font>(),
      fontFor = (span: RichSpan): Font => {
        if (!span.bold && !span.italic) return font;
        const given = span.bold && span.italic ? fonts.boldItalic : span.bold ? fonts.bold : fonts.italic;
        if (given) return given;
        const key = `${span.bold}${span.italic}`;
        let derived = made.get(key);
        if (!derived)
          made.set(
            key,
            (derived = new Font({
              family: font.family,
              weight: span.bold ? 'bold' : font.weight,
              style: span.italic ? 'italic' : (font.style as 'normal'),
            })),
          );
        return derived;
      },
      imageFonts = new Map<string, ImageFont>(),
      imageFont = (name: string): ImageFont => {
        const image = images[name];
        if (!image) throw new TypeError(`Rich text names image "${name}"; add it to images`);
        let found = imageFonts.get(name);
        if (!found) imageFonts.set(name, (found = new ImageFont(image)));
        return found;
      };
    const result = layoutRichText(parseRichText(markup), options, fontFor, (name) => imageFont(name).aspect),
      fontSize = options.fontSize ?? 1,
      style: TextStyleOptions = {};
    for (const key of Object.keys(options) as Array<keyof RichTextOptions>)
      if (!NOT_STYLE.has(key)) (style as Record<string, unknown>)[key] = options[key];
    this.width = result.width;
    this.height = result.height;
    this.pieces = result.pieces;
    for (const piece of result.pieces)
      this.texts.push(
        new Text({
          ...style,
          text: piece.image ? '￼' : piece.text,
          font: piece.image ? imageFont(piece.image) : fontFor(piece),
          fontSize: piece.size * fontSize,
          whiteSpace: 'nowrap',
          anchorY: 'baseline',
          position: [position[0] + piece.x, position[1] + piece.y, position[2]],
          ...(piece.color && { color: piece.color }),
          ...(piece.link && !piece.color && { color: linkColor }),
        }),
      );
  }

  /** Waits for the fonts of every piece. */
  async load(): Promise<void> {
    await Promise.all(this.texts.map((text) => text.font.load()));
  }

  /** The link under a point in the block's local space (x right, y up, origin at the top-left corner), or undefined. */
  linkAt(x: number, y: number): string | undefined {
    const fontSize = this.options.fontSize ?? 1;
    for (const piece of this.pieces) {
      const em = piece.size * fontSize;
      if (
        piece.link &&
        x >= piece.x &&
        x <= piece.x + piece.width &&
        y <= piece.y + 0.8 * em &&
        y >= piece.y - 0.2 * em
      )
        return piece.link;
    }
    return undefined;
  }
}

const NOT_STYLE = new Set<string>([
  'markup',
  'font',
  'bold',
  'italic',
  'boldItalic',
  'images',
  'position',
  'linkColor',
  'fontSize',
  'lineHeight',
  'maxWidth',
  'direction',
]);
