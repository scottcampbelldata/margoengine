import { MargoError } from '@margoengine/math/errors';
import { graphemes, layoutText, type LayoutOptions, type TextLayout, type TextMeasurer } from './layout.js';
import { Text, type TextOptions } from './text.js';

/** Local clipping bounds: left, bottom, right, top, in world units. */
export type ClipRect = readonly [number, number, number, number];

/** Overflow controls, independent of the font and renderer. */
export interface FitOptions extends LayoutOptions {
  /** Maximum visible lines; a positive integer or Infinity. Default Infinity. */
  maxLines?: number;
  /** Replacement at the logical end on truncation. True uses U+2026; false disables it. Default true. */
  ellipsis?: boolean | string;
  /** Local fragment clip, including outline and shadow. Default null. */
  clipRect?: ClipRect | null;
  /** Available height in world units. Default Infinity. */
  maxHeight?: number;
  /** Fit the untruncated text to maxWidth/maxHeight/maxLines. Default false. */
  autoFit?: boolean;
  /** Smallest permitted size. Default 0.1. */
  minFontSize?: number;
  /** Largest permitted size. Default fontSize (or 1). */
  maxFontSize?: number;
}

/** Layout with source-preserving overflow metadata. */
export interface FittedLayout extends TextLayout {
  /** String actually laid out, including the ellipsis. */
  displayText: string;
  /** UTF-16 source offset at which truncation begins. */
  visibleEnd: number;
  /** True when content was removed. */
  truncated: boolean;
  /** Whether the full source fitted at the selected size before truncation. */
  fits: boolean;
}

const invalid = (message: string): never => {
  throw new MargoError('failed', `${message}; use positive bounds and an ordered finite clip rectangle (https://margoengine.com/docs/text)`);
};

/** Pure fitted layout. Whole graphemes are removed and the final line is reshaped with the ellipsis. */
export function fitText(text: string, options: FitOptions, measurer: TextMeasurer): FittedLayout {
  const maxLines = options.maxLines ?? Infinity,
    maxHeight = options.maxHeight ?? Infinity,
    width = options.maxWidth ?? Infinity,
    min = options.minFontSize ?? 0.1,
    max = options.maxFontSize ?? options.fontSize ?? 1,
    clip = options.clipRect;
  if (!(maxLines === Infinity || (Number.isInteger(maxLines) && maxLines > 0))) invalid('Invalid maxLines');
  if (!(maxHeight > 0) || !(min > 0) || !Number.isFinite(min) || !Number.isFinite(max) || max < min)
    invalid('Invalid font size or height bounds');
  if (options.autoFit !== undefined && typeof options.autoFit !== 'boolean') invalid('Invalid autoFit');
  if (options.ellipsis !== undefined && typeof options.ellipsis !== 'boolean' && typeof options.ellipsis !== 'string')
    invalid('Invalid ellipsis');
  if (clip && (clip.length !== 4 || !clip.every(Number.isFinite) || clip[0] > clip[2] || clip[1] > clip[3]))
    invalid('Invalid clipRect');
  const measure = (source: string, size: number) => layoutText(source, { ...options, fontSize: size }, measurer);
  const fits = (l: TextLayout) => l.lines.length <= maxLines && l.lines.length * l.lineHeight <= maxHeight &&
    l.bounds.right - l.bounds.left <= width;
  let size = options.fontSize ?? 1;
  if (options.autoFit) {
    let lo = min, hi = max;
    if (fits(measure(text, hi))) lo = hi;
    else for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (fits(measure(text, mid))) lo = mid;
      else hi = mid;
    }
    size = lo;
  }
  let result = measure(text, size);
  const fullFits = fits(result);
  const count = Math.min(maxLines, Math.floor(maxHeight / result.lineHeight), result.lines.length);
  let end = text.length, display = text;
  if (count === 0) {
    result = { ...result, glyphs: [], lines: [], bounds: { left: 0, right: 0, top: 0, bottom: 0 } };
    end = 0;
    display = '';
  } else if (!fullFits) {
    const suffix = options.ellipsis === false ? '' : typeof options.ellipsis === 'string' ? options.ellipsis : '\u2026';
    const cutoff = result.lines[count - 1].end;
    const boundaries = [0, ...graphemes(text.slice(0, cutoff)).map(g => g.index + g.cluster.length)];
    let candidate: TextLayout | undefined;
    // Measure each candidate: kerning and shaping can change at the new boundary.
    for (let i = boundaries.length - 1; i >= 0; i--) {
      end = boundaries[i];
      display = text.slice(0, end).replace(/\s+$/u, '') + suffix;
      candidate = measure(display, size);
      if (candidate.lines.length <= count && candidate.bounds.right - candidate.bounds.left <= width) break;
    }
    result = candidate!;
    // If even the marker is too wide, show nothing rather than overflow the requested width.
    if (result.bounds.right - result.bounds.left > width || result.lines.length > count) {
      display = '';
      end = 0;
      result = measure('', size);
    }
  }
  const visibleEnd = end;
  for (const g of result.glyphs) {
    if (g.index >= visibleEnd) { g.index = visibleEnd; g.length = 0; g.carets = undefined; }
    else g.length = Math.min(g.length, visibleEnd - g.index);
  }
  for (const line of result.lines) {
    line.start = Math.min(line.start, visibleEnd);
    line.end = Math.min(line.end, visibleEnd);
  }
  return { ...result, text, displayText: display, visibleEnd, truncated: end < text.length, fits: fullFits,
    clipRect: clip ?? undefined };
}

/** Text options plus optional overflow and auto-fit controls. */
export interface FittedTextOptions extends TextOptions, FitOptions {}

/** A normal TextRenderer member with automatic fitting, ellipsis and local clipping. */
export class FittedText extends Text {
  maxLines = Infinity;
  maxHeight = Infinity;
  ellipsis: boolean | string = true;
  clipRect: ClipRect | null = null;
  autoFit = false;
  minFontSize = 0.1;
  maxFontSize: number;
  private fitted?: FittedLayout;
  private fitKey = '';
  private fitRevision = 0;
  constructor(options: FittedTextOptions = {}) {
    super(options);
    this.maxFontSize = options.maxFontSize ?? options.fontSize ?? 1;
    Object.assign(this, {
      maxLines: options.maxLines ?? Infinity, maxHeight: options.maxHeight ?? Infinity,
      ellipsis: options.ellipsis ?? true, clipRect: options.clipRect ?? null,
      autoFit: options.autoFit ?? false, minFontSize: options.minFontSize ?? 0.1,
    });
  }
  override get layout(): FittedLayout {
    const key = JSON.stringify([this.text, this.font.revision, this.fontSize, this.lineHeight, this.letterSpacing,
      this.maxWidth, this.textAlign, this.anchorX, this.anchorY, this.direction, this.whiteSpace, this.overflowWrap,
      this.ligatures, this.maxLines, this.maxHeight, this.ellipsis, this.clipRect, this.autoFit, this.minFontSize,
      this.maxFontSize]);
    if (!this.fitted || this.fitKey !== key || this.fitFont !== this.font) {
      this.fitted = fitText(this.text, this, this.font);
      this.fontSize = this.fitted.fontSize;
      this.fitKey = key;
      this.fitFont = this.font;
      this.fitRevision++;
    }
    return this.fitted;
  }
  private fitFont?: Text['font'];
  override get layoutVersion(): number { return this.fitRevision; }
}
