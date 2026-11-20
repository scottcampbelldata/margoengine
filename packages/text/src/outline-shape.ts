// Pair kerning and ligatures read from the font file. Clean room from the Microsoft/Adobe OpenType Specification
// v1.9.1 (https://learn.microsoft.com/en-us/typography/opentype/spec/): "OpenType Layout Common Table Formats"
// (ScriptList, FeatureList, LookupList, Coverage, ClassDef), GPOS lookup type 2 (pair adjustment, formats 1 and 2) and
// type 9 (extension), GSUB lookup type 4 (ligature substitution) and type 7 (extension), and the legacy 'kern' table
// (version 0, subtable format 0). Tables are read lazily: a pair is looked up when it is first asked for.
import { BinaryReader, fontError } from './font-reader.js';
import type { FontOutlines } from './font-outlines.js';

/** OpenType script tag for a character: kerning features are looked up under it, then DFLT, then latn. */
export function scriptTag(char: string): string {
  if (/\p{Script=Greek}/u.test(char)) return 'grek';
  if (/\p{Script=Cyrillic}/u.test(char)) return 'cyrl';
  if (/\p{Script=Latin}/u.test(char)) return 'latn';
  return 'DFLT';
}

interface Layout {
  reader: BinaryReader;
  /** Lookup indices of a feature under a script, in lookup order. */
  lookups(script: string, feature: string): readonly number[];
  /** Subtables of a lookup with the extension resolved: [type, reader] each. */
  subtables(index: number): readonly (readonly [number, BinaryReader])[];
}

/** Reads the common header of GSUB or GPOS; `extension` is the extension lookup type (7 or 9). */
function readLayout(bytes: Uint8Array, extension: number): Layout {
  const reader = new BinaryReader(bytes);
  if (reader.u16() !== 1) fontError('GPOS or GSUB major version is unsupported');
  reader.u16();
  const scriptList = reader.u16(),
    featureList = reader.u16(),
    lookupList = reader.u16();
  const featureCache = new Map<string, readonly number[]>(),
    subtableCache = new Map<number, readonly (readonly [number, BinaryReader])[]>();
  const langSys = (script: string): number | undefined => {
    reader.seek(scriptList);
    const count = reader.u16();
    for (let i = 0; i < count; i++) {
      reader.seek(scriptList + 2 + i * 6);
      const tag = reader.tag(),
        offset = reader.u16();
      if (tag !== script) continue;
      reader.seek(scriptList + offset);
      const fallback = reader.u16();
      return fallback ? scriptList + offset + fallback : undefined;
    }
    return undefined;
  };
  return {
    reader,
    lookups(script, feature) {
      const key = `${script}|${feature}`;
      const cached = featureCache.get(key);
      if (cached) return cached;
      const out = new Set<number>();
      const system = langSys(script) ?? langSys('DFLT') ?? langSys('latn');
      if (system !== undefined) {
        reader.seek(system + 4);
        const indexCount = reader.u16(),
          indices = Array.from({ length: indexCount }, () => reader.u16());
        reader.seek(featureList);
        const featureCount = reader.u16();
        for (const index of indices) {
          if (index >= featureCount) fontError('feature index exceeds the FeatureList');
          reader.seek(featureList + 2 + index * 6);
          if (reader.tag() !== feature) continue;
          const at = featureList + reader.u16();
          reader.seek(at + 2);
          const n = reader.u16();
          for (let k = 0; k < n; k++) out.add(reader.u16());
        }
      }
      const list = [...out].sort((a, b) => a - b);
      featureCache.set(key, list);
      return list;
    },
    subtables(index) {
      const cached = subtableCache.get(index);
      if (cached) return cached;
      reader.seek(lookupList);
      if (index >= reader.u16()) fontError('lookup index exceeds the LookupList');
      reader.seek(lookupList + 2 + index * 2);
      const at = lookupList + reader.u16();
      reader.seek(at);
      const type = reader.u16();
      reader.u16();
      const count = reader.u16(),
        offsets = Array.from({ length: count }, () => reader.u16());
      const list = offsets.map((offset): readonly [number, BinaryReader] => {
        let start = at + offset,
          kind = type;
        if (type === extension) {
          reader.seek(start);
          if (reader.u16() !== 1) fontError('extension subtable format is unsupported');
          kind = reader.u16();
          start += reader.u32();
        }
        return [kind, reader.slice(start, reader.length - start)];
      });
      subtableCache.set(index, list);
      return list;
    },
  };
}

/** Coverage index of a glyph, or -1 (formats 1 and 2). */
function coverage(r: BinaryReader, at: number, glyph: number): number {
  r.seek(at);
  const format = r.u16(),
    count = r.u16();
  let lo = 0,
    hi = count - 1;
  if (format === 1) {
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      r.seek(at + 4 + mid * 2);
      const value = r.u16();
      if (value === glyph) return mid;
      if (value < glyph) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
  if (format !== 2) fontError('Coverage format is unsupported');
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    r.seek(at + 4 + mid * 6);
    const start = r.u16(),
      end = r.u16(),
      index = r.u16();
    if (glyph < start) hi = mid - 1;
    else if (glyph > end) lo = mid + 1;
    else return index + glyph - start;
  }
  return -1;
}

/** Class of a glyph in a ClassDef table (formats 1 and 2); 0 when it is not listed. */
function classOf(r: BinaryReader, at: number, glyph: number): number {
  r.seek(at);
  const format = r.u16();
  if (format === 1) {
    const start = r.u16(),
      count = r.u16();
    if (glyph < start || glyph >= start + count) return 0;
    r.seek(at + 6 + (glyph - start) * 2);
    return r.u16();
  }
  if (format !== 2) fontError('ClassDef format is unsupported');
  const count = r.u16();
  let lo = 0,
    hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    r.seek(at + 4 + mid * 6);
    const start = r.u16(),
      end = r.u16(),
      value = r.u16();
    if (glyph < start) hi = mid - 1;
    else if (glyph > end) lo = mid + 1;
    else return value;
  }
  return 0;
}

const bits = (format: number): number => {
  let n = 0;
  for (let f = format & 0xff; f; f >>= 1) n += f & 1;
  return n;
};

/** XAdvance of a ValueRecord at `at` with `format` (0 when the record has none). */
function xAdvance(r: BinaryReader, at: number, format: number): number {
  if (!(format & 4)) return 0;
  r.seek(at + bits(format & 3) * 2);
  return r.i16();
}

/** The XAdvance a PairPos subtable gives the first glyph of a pair, or undefined when the subtable does not cover it. */
function pairAdjustment(r: BinaryReader, left: number, right: number): number | undefined {
  r.seek(0);
  const format = r.u16(),
    coverageOffset = r.u16(),
    format1 = r.u16(),
    format2 = r.u16(),
    index = coverage(r, coverageOffset, left);
  if (index < 0) return undefined;
  const size = (bits(format1) + bits(format2)) * 2;
  if (format === 1) {
    r.seek(8);
    if (index >= r.u16()) fontError('PairPos pair set index exceeds its count');
    r.seek(10 + index * 2);
    const set = r.u16();
    r.seek(set);
    const count = r.u16(),
      stride = 2 + size;
    let lo = 0,
      hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1,
        at = set + 2 + mid * stride;
      r.seek(at);
      const second = r.u16();
      if (second === right) return xAdvance(r, at + 2, format1);
      if (second < right) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }
  if (format !== 2) fontError('PairPos format is unsupported');
  r.seek(8);
  const class1Def = r.u16(),
    class2Def = r.u16(),
    class1Count = r.u16(),
    class2Count = r.u16(),
    c1 = classOf(r, class1Def, left),
    c2 = classOf(r, class2Def, right);
  if (c1 >= class1Count || c2 >= class2Count) return undefined;
  return xAdvance(r, 16 + (c1 * class2Count + c2) * size, format1);
}

/**
 * Kerning and ligatures of one font file, read lazily from GPOS (feature `kern`) or the legacy `kern` table when GPOS
 * has no `kern` feature, and from GSUB (feature `liga`). Values are in font units.
 */
export class OutlineShaper {
  private readonly gpos?: Layout;
  private readonly gsub?: Layout;
  private readonly legacy?: BinaryReader;
  private readonly pairs = new Map<string, number>();

  constructor(outlines: FontOutlines) {
    const gpos = outlines.tableBytes('GPOS'),
      gsub = outlines.tableBytes('GSUB'),
      kern = outlines.tableBytes('kern');
    if (gpos) this.gpos = readLayout(gpos, 9);
    if (gsub) this.gsub = readLayout(gsub, 7);
    if (kern && (!this.gpos || !['DFLT', 'latn', 'grek', 'cyrl'].some((s) => this.gpos!.lookups(s, 'kern').length)))
      this.legacy = new BinaryReader(kern);
  }

  /** Kerning between two glyphs in font units under a script tag: the sum of each `kern` lookup's first match. */
  kerning(left: number, right: number, script = 'latn'): number {
    const key = `${script}|${left}|${right}`;
    let value = this.pairs.get(key);
    if (value !== undefined) return value;
    value = 0;
    if (this.gpos)
      for (const lookup of this.gpos.lookups(script, 'kern'))
        for (const [type, reader] of this.gpos.subtables(lookup)) {
          if (type !== 2) continue;
          const adjustment = pairAdjustment(reader, left, right);
          if (adjustment !== undefined) {
            value += adjustment;
            break;
          }
        }
    if (this.legacy) value += this.legacyKerning(left, right);
    this.pairs.set(key, value);
    return value;
  }

  private legacyKerning(left: number, right: number): number {
    const r = this.legacy!;
    r.seek(0);
    if (r.u16() !== 0) return 0; // Apple's version 1 table is not read.
    const tables = r.u16();
    let at = 4,
      value = 0;
    for (let t = 0; t < tables; t++) {
      r.seek(at);
      r.u16();
      const length = r.u16(),
        coverageBits = r.u16();
      // Format 0, horizontal, not minimum values and not cross-stream.
      if (coverageBits >> 8 === 0 && (coverageBits & 7) === 1) {
        const count = r.u16(),
          key = left * 65536 + right;
        let lo = 0,
          hi = count - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          r.seek(at + 14 + mid * 6);
          const pair = r.u16() * 65536 + r.u16();
          if (pair === key) {
            const v = r.i16();
            value = coverageBits & 8 ? v : value + v;
            break;
          }
          if (pair < key) lo = mid + 1;
          else hi = mid - 1;
        }
      }
      if (length < 6) break;
      at += length;
    }
    return value;
  }

  /** Applies the font's `liga` ligatures to a glyph run (each lookup over the run in lookup order, longest first as listed). */
  ligatures(glyphs: readonly number[], script = 'latn'): number[] {
    let run = [...glyphs];
    if (!this.gsub || run.length < 2) return run;
    for (const lookup of this.gsub.lookups(script, 'liga')) {
      const next: number[] = [];
      for (let i = 0; i < run.length; ) {
        let matched = 0,
          replacement = 0;
        for (const [type, r] of this.gsub.subtables(lookup)) {
          if (type !== 4) continue;
          r.seek(0);
          if (r.u16() !== 1) fontError('LigatureSubst format is unsupported');
          const index = coverage(r, r.u16(), run[i]);
          if (index < 0) continue;
          r.seek(4);
          if (index >= r.u16()) fontError('ligature set index exceeds its count');
          r.seek(6 + index * 2);
          const set = r.u16();
          r.seek(set);
          const count = r.u16();
          for (let l = 0; l < count && !matched; l++) {
            r.seek(set + 2 + l * 2);
            const at = set + r.u16();
            r.seek(at);
            const glyph = r.u16(),
              components = r.u16();
            if (components < 2 || i + components > run.length) continue;
            let same = true;
            for (let c = 1; c < components && same; c++) same = r.u16() === run[i + c];
            if (same) {
              matched = components;
              replacement = glyph;
            }
          }
          break;
        }
        if (matched) {
          next.push(replacement);
          i += matched;
        } else next.push(run[i++]);
      }
      run = next;
    }
    return run;
  }
}
