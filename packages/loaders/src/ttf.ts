import { LoaderError } from './types.js';
import { toBytes, type BinaryInput } from './util.js';
import type { OutlineCommand } from './outline.js';
import { OutlineFont, type OutlineGlyph } from './outline-font.js';

const F = 'TTF';
/** Nested composite glyphs deeper than this throw (the OpenType maxp table allows at most 16 levels in practice). */
const MAX_DEPTH = 16;
/** Points one glyph may expand to through composites. */
const MAX_POINTS = 1_000_000;

/** Options of `parseTTF`. */
export interface TTFParseOptions {
  /** Font to read from a TrueType collection (`.ttc`), 0-based. Default 0. Ignored for single fonts. */
  fontIndex?: number;
}

interface Table {
  offset: number;
  length: number;
}

/** Bounds-checked big-endian reads over the whole file. */
class Reader {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  check(offset: number, size: number, what: string): void {
    if (offset < 0 || offset + size > this.bytes.length)
      throw new LoaderError(
        F,
        'truncated',
        `${what} at byte ${offset} runs past the end of the ${this.bytes.length}-byte file`,
      );
  }
  u8(o: number, what = 'data'): number {
    this.check(o, 1, what);
    return this.view.getUint8(o);
  }
  i8(o: number, what = 'data'): number {
    this.check(o, 1, what);
    return this.view.getInt8(o);
  }
  u16(o: number, what = 'data'): number {
    this.check(o, 2, what);
    return this.view.getUint16(o);
  }
  i16(o: number, what = 'data'): number {
    this.check(o, 2, what);
    return this.view.getInt16(o);
  }
  u32(o: number, what = 'data'): number {
    this.check(o, 4, what);
    return this.view.getUint32(o);
  }
  f2dot14(o: number, what = 'data'): number {
    return this.i16(o, what) / 16384;
  }
  tag(o: number): string {
    this.check(o, 4, 'table tag');
    return String.fromCharCode(this.bytes[o], this.bytes[o + 1], this.bytes[o + 2], this.bytes[o + 3]);
  }
}

/** Points of one glyph: coordinates, on-curve flags and the last point index of each contour. */
interface Points {
  xs: number[];
  ys: number[];
  on: boolean[];
  ends: number[];
}

const tag = (value: number): string =>
  String.fromCharCode(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);

function tables(r: Reader, base: number): Map<string, Table> {
  const count = r.u16(base + 4, 'table count'),
    out = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const record = base + 12 + i * 16,
      name = r.tag(record),
      offset = r.u32(record + 8, 'table record'),
      length = r.u32(record + 12, 'table record');
    // Tables past the end of the file are dropped here; `need` reports a missing required one.
    if (!out.has(name) && offset + length <= r.bytes.length) out.set(name, { offset, length });
  }
  return out;
}

function need(all: Map<string, Table>, name: string, min: number): Table {
  const table = all.get(name);
  if (!table)
    throw new LoaderError(F, 'header', `the font has no complete '${name}' table, which TrueType outlines need`);
  if (table.length < min)
    throw new LoaderError(
      F,
      'truncated',
      `'${name}' table is ${table.length} bytes, shorter than its ${min}-byte header`,
    );
  return table;
}

/** Code point to glyph index through the best Unicode cmap subtable (format 12, then 4). */
function cmapLookup(r: Reader, cmap: Table): (codePoint: number) => number {
  const count = r.u16(cmap.offset + 2, 'cmap header');
  let best: { offset: number; format: number; score: number; symbol: boolean } | undefined;
  for (let i = 0; i < count; i++) {
    const record = cmap.offset + 4 + i * 8,
      platform = r.u16(record, 'cmap record'),
      encoding = r.u16(record + 2, 'cmap record'),
      offset = cmap.offset + r.u32(record + 4, 'cmap record'),
      format = r.u16(offset, 'cmap subtable');
    if (format !== 4 && format !== 12) continue;
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)),
      symbol = platform === 3 && encoding === 0,
      score = (format === 12 ? 2 : 0) + (unicode ? 4 : symbol ? 1 : 0) + (platform === 3 ? 1 : 0);
    if (!best || score > best.score) best = { offset, format, score, symbol };
  }
  if (!best)
    throw new LoaderError(
      F,
      'unsupported',
      "the font's cmap has no format 4 or 12 subtable; only Unicode cmaps are read",
    );
  const { offset, symbol } = best;
  let lookup: (c: number) => number;
  if (best.format === 4) {
    const segments = r.u16(offset + 6, 'cmap format 4') / 2,
      ends = offset + 14,
      starts = ends + segments * 2 + 2,
      deltas = starts + segments * 2,
      ranges = deltas + segments * 2;
    r.check(offset, 16 + segments * 8, 'cmap format 4 segments');
    lookup = (c) => {
      if (c > 0xffff || segments === 0) return 0;
      let lo = 0,
        hi = segments - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r.u16(ends + mid * 2) < c) lo = mid + 1;
        else hi = mid;
      }
      const start = r.u16(starts + lo * 2);
      if (r.u16(ends + lo * 2) < c || start > c) return 0;
      const delta = r.u16(deltas + lo * 2),
        range = r.u16(ranges + lo * 2);
      if (range === 0) return (c + delta) & 0xffff;
      const at = ranges + lo * 2 + range + (c - start) * 2;
      if (at + 2 > r.bytes.length) return 0;
      const glyph = r.u16(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    };
  } else {
    const groups = r.u32(offset + 12, 'cmap format 12');
    r.check(offset + 16, groups * 12, 'cmap format 12 groups');
    lookup = (c) => {
      if (groups === 0) return 0;
      let lo = 0,
        hi = groups - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r.u32(offset + 16 + mid * 12 + 4) < c) lo = mid + 1;
        else hi = mid;
      }
      const group = offset + 16 + lo * 12,
        start = r.u32(group);
      if (start > c || r.u32(group + 4) < c) return 0;
      return r.u32(group + 8) + (c - start);
    };
  }
  // Symbol fonts (3, 0) map their characters to U+F000-U+F0FF.
  return symbol ? (c) => lookup(c) || (c < 256 ? lookup(0xf000 + c) : 0) : lookup;
}

/** Pairs of the 'kern' table's horizontal format 0 subtables (Microsoft and Apple headers), keyed left * 65536 + right. */
function kernPairs(r: Reader, kern: Table | undefined): Map<number, number> {
  const pairs = new Map<number, number>();
  if (!kern || kern.length < 4) return pairs;
  const add = (at: number, count: number, override: boolean) => {
    r.check(at, count * 6, 'kern pairs');
    for (let i = 0; i < count; i++) {
      const key = r.u16(at + i * 6) * 65536 + r.u16(at + i * 6 + 2),
        value = r.i16(at + i * 6 + 4);
      pairs.set(key, override ? value : (pairs.get(key) ?? 0) + value);
    }
  };
  const end = kern.offset + kern.length;
  if (r.u16(kern.offset) === 0) {
    let at = kern.offset + 4;
    for (let t = r.u16(kern.offset + 2); t > 0 && at + 6 <= end; t--) {
      const length = r.u16(at + 2),
        coverage = r.u16(at + 4),
        format = coverage >> 8;
      if (format === 0) {
        const count = r.u16(at + 6);
        // Horizontal, not minimum values, not cross-stream.
        if ((coverage & 7) === 1) add(at + 14, count, (coverage & 8) !== 0);
        // The 16-bit length overflows for large pair lists; the pair count gives the real size.
        at += 14 + count * 6;
      } else at += length;
    }
  } else if (r.u32(kern.offset) === 0x00010000) {
    let at = kern.offset + 8;
    for (let t = r.u32(kern.offset + 4); t > 0 && at + 8 <= end; t--) {
      const length = r.u32(at),
        coverage = r.u16(at + 4);
      // Format 0, not vertical, cross-stream or variation.
      if ((coverage & 0xff) === 0 && (coverage & 0xe000) === 0) add(at + 16, r.u16(at + 8), false);
      if (length < 8) break;
      at += length;
    }
  }
  return pairs;
}

/** Family (name ID 1) and style (name ID 2), preferring Windows English, then any Unicode, then Macintosh Roman. */
function names(r: Reader, name: Table | undefined): { family?: string; style?: string } {
  if (!name || name.length < 6) return {};
  const count = r.u16(name.offset + 2),
    strings = name.offset + r.u16(name.offset + 4),
    best: { score: number; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    const record = name.offset + 6 + i * 12;
    if (record + 12 > name.offset + name.length) break;
    const platform = r.u16(record),
      encoding = r.u16(record + 2),
      language = r.u16(record + 4),
      id = r.u16(record + 6),
      length = r.u16(record + 8),
      at = strings + r.u16(record + 10);
    if ((id !== 1 && id !== 2) || at + length > r.bytes.length) continue;
    const utf16 = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)),
      score = platform === 3 && language === 0x409 ? 4 : utf16 ? 3 : platform === 1 && encoding === 0 ? 1 : 0;
    if (!score || (best[id] && best[id].score >= score)) continue;
    let text = '';
    if (utf16) for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(r.u16(at + k));
    else for (let k = 0; k < length; k++) text += String.fromCharCode(r.u8(at + k));
    best[id] = { score, text };
  }
  return { family: best[1]?.text, style: best[2]?.text };
}

/** TrueType quadratic B-spline contours to move/line/quadratic commands (implied on-curve midpoints included). */
function contourCommands(points: Points, out: OutlineCommand[]): void {
  let first = 0;
  for (const last of points.ends) {
    const n = last - first + 1;
    if (n < 2) {
      first = last + 1;
      continue;
    }
    const x = (k: number) => points.xs[first + ((k + n) % n)],
      y = (k: number) => points.ys[first + ((k + n) % n)],
      on = (k: number) => points.on[first + ((k + n) % n)];
    let begin = 0;
    while (begin < n && !on(begin)) begin++;
    // With no on-curve point the contour starts halfway between the last and first points.
    const startX = begin < n ? x(begin) : (x(-1) + x(0)) / 2,
      startY = begin < n ? y(begin) : (y(-1) + y(0)) / 2,
      from = begin < n ? begin + 1 : 0,
      count = begin < n ? n - 1 : n;
    out.push(['M', startX, startY]);
    let control: [number, number] | null = null;
    for (let k = 0; k <= count; k++) {
      const closing = k === count,
        px = closing ? startX : x(from + k),
        py = closing ? startY : y(from + k),
        onCurve = closing || on(from + k);
      if (onCurve) {
        if (control) out.push(['Q', control[0], control[1], px, py]);
        else if (!closing || px !== startX || py !== startY) out.push(['L', px, py]);
        control = null;
      } else {
        if (control) out.push(['Q', control[0], control[1], (control[0] + px) / 2, (control[1] + py) / 2]);
        control = [px, py];
      }
    }
    out.push(['Z']);
    first = last + 1;
  }
}

/**
 * Parses a TrueType font (`.ttf`, or one font of a `.ttc` collection) from the OpenType specification's tables: `head`,
 * `hhea`, `maxp`, `hmtx`, `loca` and `glyf` (simple and composite glyphs with offsets, scales, 2x2 transforms and
 * point matching), `cmap` formats 4 and 12, `kern` format 0 pairs and the family and style names. Glyphs decode lazily.
 * Fonts with CFF outlines (`OTTO`), WOFF and WOFF2 throw a `LoaderError` with code `'unsupported'`; malformed tables
 * throw `'header'`, `'truncated'` or `'range'`.
 */
export function parseTTF(input: BinaryInput, options: TTFParseOptions = {}): OutlineFont {
  const r = new Reader(toBytes(input, F));
  r.check(0, 12, 'font header');
  let base = 0;
  const signature = r.u32(0);
  if (signature === 0x74746366) {
    const count = r.u32(8, 'collection header'),
      index = options.fontIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new LoaderError(
        F,
        'range',
        `fontIndex ${index} is outside the collection's ${count} fonts; pick 0 to ${count - 1}`,
      );
    base = r.u32(12 + index * 4, 'collection offsets');
  }
  const version = r.u32(base, 'font header');
  if (version === 0x4f54544f)
    throw new LoaderError(
      F,
      'unsupported',
      "the font has CFF (PostScript) outlines ('OTTO'), which parseTTF does not read; convert it to TrueType outlines (.ttf) first",
    );
  if (version === 0x774f4646 || version === 0x774f4632)
    throw new LoaderError(F, 'unsupported', 'WOFF and WOFF2 fonts are compressed; decompress the font to .ttf first');
  if (version !== 0x00010000 && version !== 0x74727565)
    throw new LoaderError(
      F,
      'header',
      `not a TrueType font (signature '${tag(version)}'); pass the bytes of a .ttf file`,
    );
  const all = tables(r, base);
  if (!all.has('glyf') && all.has('CFF '))
    throw new LoaderError(F, 'unsupported', 'the font has CFF outlines, which parseTTF does not read; use a .ttf font');
  const head = need(all, 'head', 54),
    hhea = need(all, 'hhea', 36),
    maxp = need(all, 'maxp', 6),
    hmtx = need(all, 'hmtx', 4),
    loca = need(all, 'loca', 2),
    glyf = need(all, 'glyf', 0),
    cmap = need(all, 'cmap', 4);
  if (r.u32(head.offset + 12) !== 0x5f0f3cf5)
    throw new LoaderError(F, 'header', "the 'head' table's magic number is wrong; the file is not a valid font");
  const unitsPerEm = r.u16(head.offset + 18),
    longOffsets = r.i16(head.offset + 50) === 1,
    glyphCount = r.u16(maxp.offset + 4),
    ascender = r.i16(hhea.offset + 4),
    descender = r.i16(hhea.offset + 6),
    lineGap = r.i16(hhea.offset + 8),
    metrics = Math.min(r.u16(hhea.offset + 34), glyphCount);
  if (unitsPerEm === 0) throw new LoaderError(F, 'header', "the 'head' table gives 0 units per em");
  if (glyphCount === 0) throw new LoaderError(F, 'header', 'the font has no glyphs');
  if (metrics === 0) throw new LoaderError(F, 'header', "the 'hhea' table gives no horizontal metrics");
  if (hmtx.length < metrics * 4)
    throw new LoaderError(F, 'truncated', `'hmtx' holds fewer than its ${metrics} advance widths`);
  if (loca.length < (glyphCount + 1) * (longOffsets ? 4 : 2))
    throw new LoaderError(F, 'truncated', `'loca' holds fewer than its ${glyphCount + 1} offsets`);
  const location = (index: number) =>
    longOffsets ? r.u32(loca.offset + index * 4) : r.u16(loca.offset + index * 2) * 2;
  const glyphIndex = cmapLookup(r, cmap),
    kerning = kernPairs(r, all.get('kern')),
    { family, style } = names(r, all.get('name'));

  const decode = (index: number, depth: number): Points => {
    if (depth > MAX_DEPTH)
      throw new LoaderError(
        F,
        'limit',
        `composite glyphs nest deeper than ${MAX_DEPTH} levels (or refer to themselves)`,
      );
    if (index >= glyphCount)
      throw new LoaderError(F, 'range', `glyph ${index} is outside the font's ${glyphCount} glyphs`);
    const start = location(index),
      end = location(index + 1),
      points: Points = { xs: [], ys: [], on: [], ends: [] };
    if (end <= start) return points;
    if (end > glyf.length)
      throw new LoaderError(
        F,
        'range',
        `glyph ${index} ends at byte ${end}, past the ${glyf.length}-byte 'glyf' table`,
      );
    const at = glyf.offset + start,
      limit = glyf.offset + end,
      within = (o: number, size: number) => {
        if (o + size > limit) throw new LoaderError(F, 'truncated', `glyph ${index} runs past its 'loca' length`);
        return o;
      },
      contours = r.i16(within(at, 10));
    if (contours >= 0) {
      let p = at + 10,
        previous = -1;
      for (let c = 0; c < contours; c++, p += 2) {
        const last = r.u16(within(p, 2));
        if (last <= previous && c > 0)
          throw new LoaderError(F, 'range', `glyph ${index} has contour end points out of order`);
        points.ends.push(last);
        previous = last;
      }
      const count = contours ? previous + 1 : 0;
      p += 2 + r.u16(within(p, 2));
      const flags = new Uint8Array(count);
      for (let k = 0; k < count; ) {
        const flag = r.u8(within(p++, 1));
        flags[k++] = flag;
        if (flag & 8) {
          let repeat = r.u8(within(p++, 1));
          if (k + repeat > count) throw new LoaderError(F, 'range', `glyph ${index} repeats a flag past its points`);
          while (repeat-- > 0) flags[k++] = flag;
        }
      }
      for (const [short, same, list] of [
        [2, 16, points.xs],
        [4, 32, points.ys],
      ] as const) {
        let value = 0;
        for (let k = 0; k < count; k++) {
          const flag = flags[k];
          if (flag & short) {
            const delta = r.u8(within(p++, 1));
            value += flag & same ? delta : -delta;
          } else if (!(flag & same)) {
            value += r.i16(within(p, 2));
            p += 2;
          }
          list.push(value);
        }
      }
      for (let k = 0; k < count; k++) points.on.push((flags[k] & 1) !== 0);
      return points;
    }
    // Composite: components, each with a transform and an offset or matched points.
    let p = at + 10,
      flags: number;
    do {
      flags = r.u16(within(p, 4));
      const component = r.u16(p + 2);
      p += 4;
      let arg1: number, arg2: number;
      if (flags & 1) {
        arg1 = flags & 2 ? r.i16(within(p, 4)) : r.u16(within(p, 4));
        arg2 = flags & 2 ? r.i16(p + 2) : r.u16(p + 2);
        p += 4;
      } else {
        arg1 = flags & 2 ? r.i8(within(p, 2)) : r.u8(within(p, 2));
        arg2 = flags & 2 ? r.i8(p + 1) : r.u8(p + 1);
        p += 2;
      }
      let a = 1,
        b = 0,
        c = 0,
        d = 1;
      if (flags & 8) {
        a = d = r.f2dot14(within(p, 2));
        p += 2;
      } else if (flags & 0x40) {
        a = r.f2dot14(within(p, 4));
        d = r.f2dot14(p + 2);
        p += 4;
      } else if (flags & 0x80) {
        a = r.f2dot14(within(p, 8));
        b = r.f2dot14(p + 2);
        c = r.f2dot14(p + 4);
        d = r.f2dot14(p + 6);
        p += 8;
      }
      const child = decode(component, depth + 1),
        offset = points.xs.length;
      if (offset + child.xs.length > MAX_POINTS)
        throw new LoaderError(F, 'limit', `glyph ${index} expands to more than ${MAX_POINTS} points`);
      for (let k = 0; k < child.xs.length; k++) {
        points.xs.push(a * child.xs[k] + c * child.ys[k]);
        points.ys.push(b * child.xs[k] + d * child.ys[k]);
        points.on.push(child.on[k]);
      }
      let dx: number, dy: number;
      if (flags & 2) {
        // SCALED_COMPONENT_OFFSET transforms the offset too; the default (and UNSCALED_COMPONENT_OFFSET) does not.
        const scaled = (flags & 0x800) !== 0 && (flags & 0x1000) === 0;
        dx = scaled ? a * arg1 + c * arg2 : arg1;
        dy = scaled ? b * arg1 + d * arg2 : arg2;
      } else {
        const matched = offset + arg2;
        if (arg1 >= offset || matched >= points.xs.length)
          throw new LoaderError(F, 'range', `glyph ${index} matches point ${arg1} to ${arg2}, which do not exist`);
        dx = points.xs[arg1] - points.xs[matched];
        dy = points.ys[arg1] - points.ys[matched];
      }
      for (let k = offset; k < points.xs.length; k++) {
        points.xs[k] += dx;
        points.ys[k] += dy;
      }
      for (const last of child.ends) points.ends.push(offset + last);
    } while (flags & 0x20);
    return points;
  };

  return new OutlineFont({
    unitsPerEm,
    ascender,
    descender,
    lineHeight: ascender - descender + lineGap,
    glyphCount,
    familyName: family,
    styleName: style,
    missingGlyph: 0,
    glyphIndex(c) {
      const index = glyphIndex(c);
      return index > 0 && index < glyphCount ? index : undefined;
    },
    glyph(index): OutlineGlyph {
      if (!Number.isInteger(index) || index < 0 || index >= glyphCount)
        throw new RangeError(`glyph index ${index} is outside 0..${glyphCount - 1}; pass an index from glyphIndex()`);
      const commands: OutlineCommand[] = [];
      contourCommands(decode(index, 0), commands);
      const advance = r.u16(hmtx.offset + Math.min(index, metrics - 1) * 4);
      return { index, advance, commands };
    },
    kerning: (left, right) => kerning.get(left * 65536 + right) ?? 0,
  });
}
