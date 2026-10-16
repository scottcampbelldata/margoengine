/**
 * Text layout: grapheme clusters, line breaking, simple bidi reordering, alignment and anchoring.
 * Pure CPU code. Measurements come from a TextMeasurer, so tests can pass a deterministic mock.
 */

/** Font measurements in em units (multiples of the font size). */
export interface TextMeasurer {
  /** Horizontal advance of one grapheme cluster. */
  advance(cluster: string): number;
  /** Adjustment added between two adjacent clusters, usually negative or zero. */
  kerning(left: string, right: string): number;
  /** Ascent above and descent below the baseline, both positive. */
  metrics(): { ascent: number; descent: number };
}

/** Horizontal alignment of each line inside the text block. */
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
/** Which edge of the text block sits at the local origin horizontally. */
export type AnchorX = 'left' | 'center' | 'right';
/** Which edge or baseline of the text block sits at the local origin vertically. */
export type AnchorY = 'top' | 'middle' | 'bottom' | 'baseline' | 'bottom-baseline';
/** Paragraph direction; 'auto' takes it from the first strong character. */
export type TextDirection = 'ltr' | 'rtl' | 'auto';

/** Layout options shared by `layoutText` and `Text`; checked by `validateLayoutOptions`. */
export interface LayoutOptions {
  /** Em size in world units. Default 1. */
  fontSize?: number;
  /** Line box height as a multiple of fontSize. Default 1.2. */
  lineHeight?: number;
  /** Extra space between clusters as a multiple of fontSize; may be negative. Default 0. */
  letterSpacing?: number;
  /** Wrap width in world units. Default Infinity (only explicit newlines break). */
  maxWidth?: number;
  /** Alignment of each line inside the block, whose width is the widest line. Default 'left'. */
  textAlign?: TextAlign;
  /** Which edge of the block sits at the local origin horizontally. Default 'left'. */
  anchorX?: AnchorX;
  /** Which edge or baseline sits at the local origin vertically. 'baseline' is the first line's, 'bottom-baseline' the last line's. Default 'top'. */
  anchorY?: AnchorY;
  /** Paragraph direction; 'auto' takes it from the first strong character of each paragraph. Default 'auto'. */
  direction?: TextDirection;
  /** 'nowrap' ignores maxWidth. Default 'normal'. */
  whiteSpace?: 'normal' | 'nowrap';
  /** 'break-word' splits a word wider than maxWidth; 'normal' lets it overflow. Default 'break-word'. */
  overflowWrap?: 'normal' | 'break-word';
}

/** One positioned grapheme cluster, in the text block's local space (x right, y up, world units). */
export interface LayoutGlyph {
  /** The cluster as drawn; brackets in right-to-left runs are mirrored. */
  cluster: string;
  /** UTF-16 offset of the cluster in the source string. */
  index: number;
  /** UTF-16 length of the cluster. */
  length: number;
  line: number;
  /** Left edge of the advance box. */
  x: number;
  /** Baseline height. */
  y: number;
  advance: number;
  rtl: boolean;
  whitespace: boolean;
}

/** One laid-out line, in the text block's local space (x right, y up, world units). */
export interface LayoutLine {
  /** UTF-16 range [start, end) of the source string, excluding the newline. */
  start: number;
  /** End of the UTF-16 range (exclusive). */
  end: number;
  /** Range of this line's entries in `glyphs`, in visual order left to right. */
  firstGlyph: number;
  /** Number of entries in `glyphs` belonging to this line. */
  glyphCount: number;
  /** Line box. Trailing spaces hang outside left..right. */
  left: number;
  /** Right edge of the line box. */
  right: number;
  /** Top edge of the line box. */
  top: number;
  /** Bottom edge of the line box: `top` minus the line height. */
  bottom: number;
  /** Baseline height. */
  baseline: number;
  /** True when the line's paragraph runs right to left. */
  rtl: boolean;
}

/** Result of `layoutText`: positioned glyphs and lines. Lengths are in world units. */
export interface TextLayout {
  /** The source string. */
  text: string;
  /** Positioned clusters of all lines. */
  glyphs: LayoutGlyph[];
  /** Lines from top to bottom. */
  lines: LayoutLine[];
  /** Union of the line boxes, block width by line count times line height. */
  bounds: { left: number; right: number; top: number; bottom: number };
  /** Em size in world units. */
  fontSize: number;
  /** Line box height in world units (the option times fontSize). */
  lineHeight: number;
  /** Font ascent in world units. */
  ascent: number;
  /** Font descent in world units, positive. */
  descent: number;
}

// --- Character classes -------------------------------------------------------------------------

const RTL = /^[֐-ࣿיִ-﷿ﹰ-ﻼ]|^\ud802[\udc00-\udfff]|^\ud83a[\udc00-\udfff]/;
const STRONG_LTR = /[\p{L}\p{Nd}]/u;
const SPACE = /^[\s ​]+$/u;
const IDEOGRAPH = /^[⺀-鿿豈-﫿＀-￯　-〿가-힯]|^[\ud840-\ud87f]/;
const OPENING = ['(', '[', '{', '\u00ab'],
  CLOSING = [')', ']', '}', '\u00bb'];
const MIRROR: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
  '«': '»',
  '»': '«',
};

/** 'R' for right-to-left scripts (Hebrew, Arabic and neighbours), 'L' for other letters and digits, 'N' for neutrals. */
export function bidiClass(cluster: string): 'R' | 'L' | 'N' {
  // One ASCII character, the common case, is classified by code: letters and digits are 'L', the rest neutral.
  const c = cluster.charCodeAt(0);
  if (c < 128 && cluster.length === 1)
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ? 'L' : 'N';
  if (RTL.test(cluster)) return 'R';
  return STRONG_LTR.test(cluster) ? 'L' : 'N';
}
export const isWhitespace = (cluster: string): boolean => {
  const c = cluster.charCodeAt(0);
  return c < 128 && cluster.length === 1 ? c === 32 || (c >= 9 && c <= 13) : SPACE.test(cluster);
};
/** Every ideograph range starts at or above U+2E80, so clusters that start below it skip the pattern. */
export const isIdeograph = (cluster: string): boolean => cluster.charCodeAt(0) >= 0x2e80 && IDEOGRAPH.test(cluster);

interface SegmenterLike {
  segment(text: string): Iterable<{ segment: string; index: number }>;
}
let segmenter: SegmenterLike | null | undefined;
const ASCII = /^[\t\n\x20-\x7e]*$/;
const COMBINING = /^[\p{M}‍︎️\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]/u;

/** Splits text into grapheme clusters with their UTF-16 offsets (Intl.Segmenter when available). */
export function graphemes(text: string): Array<{ cluster: string; index: number }> {
  if (segmenter === undefined) {
    const Segmenter = (
      globalThis as unknown as { Intl?: { Segmenter?: new (locale?: string, options?: object) => SegmenterLike } }
    ).Intl?.Segmenter;
    segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  const out: Array<{ cluster: string; index: number }> = [];
  // Tabs, line feeds and printable ASCII are always one cluster each (no CR, which joins a following LF).
  if (ASCII.test(text)) {
    for (let index = 0; index < text.length; index++) out.push({ cluster: text[index], index });
    return out;
  }
  if (segmenter) {
    for (const { segment, index } of segmenter.segment(text)) out.push({ cluster: segment, index });
    return out;
  }
  // Fallback: code points, with combining marks, joiners, variation selectors and skin tones attached to the previous cluster.
  let index = 0,
    joined = false;
  for (const point of text) {
    const last = out[out.length - 1];
    if (last && (joined || COMBINING.test(point) || (point === '\n' && last.cluster === '\r'))) last.cluster += point;
    else out.push({ cluster: point, index });
    joined = point === '‍';
    index += point.length;
  }
  return out;
}

// --- Layout ------------------------------------------------------------------------------------

const ALIGNS: readonly TextAlign[] = ['left', 'center', 'right', 'justify'];
const ANCHORS_X: readonly AnchorX[] = ['left', 'center', 'right'];
const ANCHORS_Y: readonly AnchorY[] = ['top', 'middle', 'bottom', 'baseline', 'bottom-baseline'];
const DIRECTIONS: readonly string[] = ['ltr', 'rtl', 'auto'],
  WHITE_SPACES: readonly string[] = ['normal', 'nowrap'],
  WRAPS: readonly string[] = ['normal', 'break-word'];

/**
 * Fills in layout defaults and checks ranges.
 * @throws RangeError when fontSize or lineHeight is not positive and finite, letterSpacing is not finite, or maxWidth is not positive.
 * @throws TypeError for an unknown textAlign, anchor, direction, whiteSpace or overflowWrap.
 */
export function validateLayoutOptions(options: LayoutOptions): Required<LayoutOptions> {
  const o: Required<LayoutOptions> = {
    fontSize: options.fontSize ?? 1,
    lineHeight: options.lineHeight ?? 1.2,
    letterSpacing: options.letterSpacing ?? 0,
    maxWidth: options.maxWidth ?? Infinity,
    textAlign: options.textAlign ?? 'left',
    anchorX: options.anchorX ?? 'left',
    anchorY: options.anchorY ?? 'top',
    direction: options.direction ?? 'auto',
    whiteSpace: options.whiteSpace ?? 'normal',
    overflowWrap: options.overflowWrap ?? 'break-word',
  };
  if (typeof o.fontSize !== 'number' || !Number.isFinite(o.fontSize) || o.fontSize <= 0)
    throw new RangeError('fontSize must be a positive finite number');
  if (typeof o.lineHeight !== 'number' || !Number.isFinite(o.lineHeight) || o.lineHeight <= 0)
    throw new RangeError('lineHeight must be a positive finite number');
  if (typeof o.letterSpacing !== 'number' || !Number.isFinite(o.letterSpacing))
    throw new RangeError('letterSpacing must be finite');
  if (typeof o.maxWidth !== 'number' || Number.isNaN(o.maxWidth) || o.maxWidth <= 0)
    throw new RangeError('maxWidth must be positive (Infinity for no wrapping)');
  if (!ALIGNS.includes(o.textAlign) || !ANCHORS_X.includes(o.anchorX) || !ANCHORS_Y.includes(o.anchorY))
    throw new TypeError('Unknown textAlign or anchor');
  if (!DIRECTIONS.includes(o.direction) || !WHITE_SPACES.includes(o.whiteSpace) || !WRAPS.includes(o.overflowWrap))
    throw new TypeError('Unknown direction, whiteSpace or overflowWrap');
  return o;
}

interface Item {
  cluster: string;
  index: number;
  advance: number;
  kern: number;
  space: boolean;
  bidi: 'R' | 'L' | 'N';
}

/** Lays out `text` with a measurer. Pure and deterministic for a deterministic measurer. */
export function layoutText(text: string, options: LayoutOptions, measurer: TextMeasurer): TextLayout {
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  const o = validateLayoutOptions(options),
    fs = o.fontSize,
    spacing = o.letterSpacing * fs;
  const { ascent: emAscent, descent: emDescent } = measurer.metrics();
  const ascent = emAscent * fs,
    descent = emDescent * fs,
    lineHeight = o.lineHeight * fs;
  const kern = (a: string, b: string) => measurer.kerning(a, b) * fs;
  const glyphs: LayoutGlyph[] = [],
    lines: LayoutLine[] = [];

  // Paragraphs: split at newlines while keeping source offsets.
  const all = graphemes(text),
    paragraphs: Item[][] = [[]],
    ends: number[] = [];
  for (const { cluster, index } of all) {
    if (cluster === '\n' || cluster === '\r\n' || cluster === '\r' || cluster === ' ') {
      ends.push(index);
      paragraphs.push([]);
      continue;
    }
    paragraphs[paragraphs.length - 1].push({
      cluster,
      index,
      advance: measurer.advance(cluster) * fs,
      kern: 0,
      space: isWhitespace(cluster),
      bidi: bidiClass(cluster),
    });
  }
  ends.push(text.length);

  const raw: Array<{ items: Item[]; start: number; end: number; rtl: boolean; last: boolean; width: number }> = [];
  for (let p = 0; p < paragraphs.length; p++) {
    const items = paragraphs[p],
      n = items.length;
    let rtl = o.direction === 'rtl';
    if (o.direction === 'auto')
      for (const item of items)
        if (item.bidi !== 'N') {
          rtl = item.bidi === 'R';
          break;
        }
    // Logical pen positions: pos[i] is where cluster i starts if nothing wraps.
    for (let i = 0; i + 1 < n; i++) {
      const a = items[i],
        b = items[i + 1];
      if (!a.space && !b.space && a.bidi === b.bidi) a.kern = kern(a.cluster, b.cluster);
    }
    const pos = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pos[i + 1] = pos[i] + items[i].advance + items[i].kern + spacing;
    const width = (a: number, b: number) => (b > a ? pos[b] - pos[a] - items[b - 1].kern - spacing : 0);
    const paragraphEnd = ends[p];
    const wrap = o.whiteSpace === 'normal' && Number.isFinite(o.maxWidth);
    let start = 0;
    do {
      let end = n,
        lastBreak = -1;
      if (wrap)
        for (let i = start; i < n; i++) {
          if (
            i > start &&
            !items[i].space &&
            (items[i - 1].space || isIdeograph(items[i].cluster) || isIdeograph(items[i - 1].cluster))
          )
            lastBreak = i;
          if (items[i].space || width(start, i + 1) <= o.maxWidth + 1e-9 * Math.max(1, o.maxWidth)) continue;
          if (lastBreak > start) {
            end = lastBreak;
            break;
          }
          if (o.overflowWrap === 'break-word' && i > start) {
            end = i;
            break;
          }
        }
      let visible = end;
      while (visible > start && items[visible - 1].space) visible--;
      const lineItems = items.slice(start, end);
      raw.push({
        items: lineItems,
        start: lineItems.length ? lineItems[0].index : end < n ? items[end].index : paragraphEnd,
        end: end < n ? items[end].index : paragraphEnd,
        rtl,
        last: end === n,
        width: 0,
      });
      raw[raw.length - 1].width = width(start, visible);
      start = end;
    } while (start < n);
  }

  // Visual order, positions, alignment.
  let blockWidth = 0;
  const placed = raw.map((line) => {
    const visibleCount = (() => {
      let v = line.items.length;
      while (v > 0 && line.items[v - 1].space) v--;
      return v;
    })();
    const visible = line.items.slice(0, visibleCount),
      trailing = line.items.slice(visibleCount);
    const base = line.rtl ? 1 : 0,
      levels = resolveLevels(visible, base);
    const order = reorder(levels);
    const visual = order.map((i) => ({ item: visible[i], level: levels[i] }));
    const xs: number[] = [];
    let x = 0;
    for (let j = 0; j < visual.length; j++) {
      xs.push(x);
      const { item, level } = visual[j],
        next = visual[j + 1];
      x += item.advance;
      if (next) {
        x += spacing;
        if (next.level === level && !item.space && !next.item.space && item.bidi === next.item.bidi)
          x += level & 1 ? kern(next.item.cluster, item.cluster) : kern(item.cluster, next.item.cluster);
      }
    }
    const width = visual.length ? x : 0;
    blockWidth = Math.max(blockWidth, width);
    return { line, visual, xs, width, trailing, base };
  });

  const height = Math.max(1, raw.length) * lineHeight;
  const dx = o.anchorX === 'left' ? 0 : o.anchorX === 'center' ? -blockWidth / 2 : -blockWidth;
  const firstBaseline = -(lineHeight - ascent - descent) / 2 - ascent;
  const dy =
    o.anchorY === 'top'
      ? 0
      : o.anchorY === 'middle'
        ? height / 2
        : o.anchorY === 'bottom'
          ? height
          : o.anchorY === 'baseline'
            ? -firstBaseline
            : -(firstBaseline - (raw.length - 1) * lineHeight);

  placed.forEach(({ line, visual, xs, width, trailing, base }, index) => {
    const top = dy - index * lineHeight,
      baseline = top + firstBaseline;
    let offset = 0,
      gap = 0;
    const align = o.textAlign === 'justify' && line.last ? (line.rtl ? 'right' : 'left') : o.textAlign;
    if (align === 'center') offset = (blockWidth - width) / 2;
    else if (align === 'right') offset = blockWidth - width;
    else if (align === 'justify') {
      let spaces = 0;
      for (let j = 1; j < visual.length - 1; j++) if (visual[j].item.space) spaces++;
      if (spaces) gap = (blockWidth - width) / spaces;
      else if (line.rtl) offset = blockWidth - width;
    }
    const left = dx + offset,
      firstGlyph = glyphs.length;
    let extra = 0;
    const push = (item: Item, x: number, rtl: boolean) =>
      glyphs.push({
        cluster: rtl && MIRROR[item.cluster] ? MIRROR[item.cluster] : item.cluster,
        index: item.index,
        length: item.cluster.length,
        line: index,
        x,
        y: baseline,
        advance: item.advance,
        rtl,
        whitespace: item.space,
      });
    // Hanging trailing spaces sit past the end edge: to the left of right-to-left lines.
    if (base === 1) {
      let x = left;
      const hanging: Array<[Item, number]> = [];
      for (const item of trailing) {
        x -= item.advance + spacing;
        hanging.push([item, x]);
      }
      for (let t = hanging.length - 1; t >= 0; t--) push(hanging[t][0], hanging[t][1], true);
    }
    for (let j = 0; j < visual.length; j++) {
      if (gap && j > 0 && j < visual.length - 1 && visual[j].item.space) {
        push(visual[j].item, left + xs[j] + extra, (visual[j].level & 1) === 1);
        extra += gap;
        glyphs[glyphs.length - 1].advance += gap;
        continue;
      }
      push(visual[j].item, left + xs[j] + extra, (visual[j].level & 1) === 1);
    }
    if (base === 0) {
      let x = left + width + (visual.length ? spacing : 0) + extra;
      for (const item of trailing) {
        push(item, x, false);
        x += item.advance + spacing;
      }
    }
    lines.push({
      start: line.start,
      end: line.end,
      firstGlyph,
      glyphCount: glyphs.length - firstGlyph,
      left,
      right: left + width + extra,
      top,
      bottom: top - lineHeight,
      baseline,
      rtl: line.rtl,
    });
  });
  if (!lines.length)
    lines.push({
      start: 0,
      end: 0,
      firstGlyph: 0,
      glyphCount: 0,
      left: dx,
      right: dx,
      top: dy,
      bottom: dy - lineHeight,
      baseline: dy + firstBaseline,
      rtl: o.direction === 'rtl',
    });
  return {
    text,
    glyphs,
    lines,
    bounds: { left: dx, right: dx + blockWidth, top: dy, bottom: dy - height },
    fontSize: fs,
    lineHeight,
    ascent,
    descent,
  };
}

/** Simplified Unicode bidi: strong R and L classes, neutrals between equal directions take that direction, others the base. */
function resolveLevels(items: Item[], base: number): number[] {
  const strong = items.map((item) => item.bidi),
    n = items.length,
    levels = new Array<number>(n);
  const levelOf = (cls: 'R' | 'L') => (cls === 'R' ? 1 : base === 1 ? 2 : 0);
  const baseClass = base === 1 ? 'R' : 'L';
  // Rule N0, simplified: a matched bracket pair takes the base direction when it encloses base-direction text,
  // otherwise the opposite direction when it encloses that and the text before the pair runs that way too.
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = items[i].cluster;
    if (OPENING.includes(c)) {
      stack.push(i);
      continue;
    }
    const kind = CLOSING.indexOf(c);
    if (kind < 0) continue;
    let k = stack.length - 1;
    while (k >= 0 && items[stack[k]].cluster !== OPENING[kind]) k--;
    if (k < 0) continue;
    const open = stack[k];
    stack.length = k;
    let inside: 'R' | 'L' | 'N' = 'N';
    for (let j = open + 1; j < i; j++)
      if (strong[j] !== 'N') {
        inside = strong[j];
        if (inside === baseClass) break;
      }
    if (inside === 'N') continue;
    let before: 'R' | 'L' = baseClass;
    for (let j = open - 1; j >= 0; j--)
      if (strong[j] !== 'N') {
        before = strong[j] as 'R' | 'L';
        break;
      }
    strong[open] = strong[i] = inside === baseClass || before !== inside ? baseClass : inside;
  }
  let previous: 'R' | 'L' = baseClass;
  for (let i = 0; i < n; i++) {
    if (strong[i] !== 'N') {
      previous = strong[i] as 'R' | 'L';
      levels[i] = levelOf(previous);
      continue;
    }
    let j = i;
    while (j < n && strong[j] === 'N') j++;
    const next: 'R' | 'L' = j < n ? (strong[j] as 'R' | 'L') : baseClass;
    const level = previous === next ? levelOf(next) : base;
    for (let k = i; k < j; k++) levels[k] = level;
    i = j - 1;
  }
  return levels;
}

/** Visual order of logical indices (rule L2: reverse runs from the highest level down to 1). */
function reorder(levels: number[]): number[] {
  const order = levels.map((_, i) => i);
  const max = levels.reduce((a, b) => Math.max(a, b), 0);
  for (let level = max; level >= 1; level--) {
    for (let i = 0; i < order.length; i++) {
      if (levels[order[i]] < level) continue;
      let j = i;
      while (j < order.length && levels[order[j]] >= level) j++;
      const run = order.slice(i, j).reverse();
      for (let k = 0; k < run.length; k++) order[i + k] = run[k];
      i = j;
    }
  }
  return order;
}

// --- Hit testing and carets --------------------------------------------------------------------

/** Caret position in local space for the UTF-16 offset `index` (clamped to the text). */
export function caretRect(layout: TextLayout, index: number): { x: number; top: number; bottom: number; line: number } {
  if (!Number.isFinite(index)) throw new RangeError('Caret index must be finite');
  index = Math.max(0, Math.min(layout.text.length, Math.round(index)));
  let lineIndex = layout.lines.findIndex((line) => index >= line.start && index < line.end);
  if (lineIndex < 0) lineIndex = layout.lines.findIndex((line) => index >= line.start && index <= line.end);
  if (lineIndex < 0) lineIndex = layout.lines.length - 1;
  const line = layout.lines[lineIndex],
    glyphs = layout.glyphs.slice(line.firstGlyph, line.firstGlyph + line.glyphCount);
  const at = glyphs.find((g) => g.index === index),
    before = glyphs.find((g) => g.index + g.length === index);
  let x = line.rtl ? line.right : line.left;
  if (at) x = at.rtl ? at.x + at.advance : at.x;
  else if (before) x = before.rtl ? before.x : before.x + before.advance;
  return { x, top: line.top, bottom: line.bottom, line: lineIndex };
}

/** UTF-16 caret offset nearest to the local point (x, y): the line under y, then the nearer edge of the cluster under x. */
export function hitTest(layout: TextLayout, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Hit test point must be finite');
  const lines = layout.lines;
  let lineIndex = lines.findIndex((line) => y <= line.top && y > line.bottom);
  if (lineIndex < 0) lineIndex = y > lines[0].top ? 0 : lines.length - 1;
  const line = lines[lineIndex],
    glyphs = layout.glyphs.slice(line.firstGlyph, line.firstGlyph + line.glyphCount);
  if (!glyphs.length) return line.start;
  let best = glyphs[0],
    distance = Infinity;
  for (const glyph of glyphs) {
    const d = x < glyph.x ? glyph.x - x : x > glyph.x + glyph.advance ? x - glyph.x - glyph.advance : 0;
    if (d < distance) {
      distance = d;
      best = glyph;
    }
  }
  const leftHalf = x < best.x + best.advance / 2;
  return leftHalf !== best.rtl ? best.index : best.index + best.length;
}
