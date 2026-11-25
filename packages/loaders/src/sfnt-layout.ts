// OpenType Layout tables and GPOS pair kerning. Clean room from the Microsoft/Adobe OpenType Specification v1.9.1
// (https://learn.microsoft.com/en-us/typography/opentype/spec/): "OpenType Layout Common Table Formats" (ScriptList,
// FeatureList, LookupList, Coverage, ClassDef, VariationIndex), GPOS lookup type 2 (pair adjustment, formats 1 and 2)
// and type 9 (extension). Tables are read lazily: a pair is looked up when it is first asked for.
import { BinaryReader, fontError } from './sfnt-reader.js';

/** Subtables one GSUB or GPOS table may make a reader hold, over all the lookups asked for. */
const MAX_SUBTABLES = 16384;

/** The variation delta of an ItemVariationStore entry at the font instance's coordinates. */
export type VariationDelta = (outer: number, inner: number) => number;

/** OpenType script tag for a character: kerning features are looked up under it, then DFLT, then latn. */
export function scriptTag(char: string): string {
  if (/\p{Script=Greek}/u.test(char)) return 'grek';
  if (/\p{Script=Cyrillic}/u.test(char)) return 'cyrl';
  if (/\p{Script=Latin}/u.test(char)) return 'latn';
  return 'DFLT';
}

/** A GSUB or GPOS table, read lazily (`openTypeLayout`). */
export interface OpenTypeLayout {
  /** Lookup indices of a feature under a script, in lookup order. */
  lookups(script: string, feature: string): readonly number[];
  /** Subtables of a lookup with the extension resolved: [type, reader] each. */
  subtables(index: number): readonly (readonly [number, BinaryReader])[];
}

/**
 * Reads the common header of a GSUB or GPOS table (`bytes` from `TTFFontSource.table`); `extension` is the extension
 * lookup type (GSUB 7, GPOS 9). Malformed tables throw a `LoaderError`.
 */
export function openTypeLayout(bytes: Uint8Array, extension: number): OpenTypeLayout {
  const reader = new BinaryReader(bytes);
  if (reader.u16() !== 1) fontError('GPOS or GSUB major version is unsupported', 'unsupported');
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
  let parsed = 0;
  return {
    lookups(script, feature) {
      const key = `${script}|${feature}`;
      const cached = featureCache.get(key);
      if (cached) return cached;
      const out = new Set<number>(),
        seen = new Set<number>();
      let listed = 0;
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
          // Feature records may share a table; each is read once.
          if (seen.has(at)) continue;
          seen.add(at);
          reader.seek(at + 2);
          const n = reader.u16();
          // Distinct tables may still overlap, so their lists are bounded together.
          if ((listed += n) > 65536) fontError('a GPOS or GSUB feature lists more than 65536 lookups', 'limit');
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
      const count = reader.u16();
      // Lookups may share offsets, so what a file can make a reader hold is bounded by the total, not per lookup.
      if ((parsed += count) > MAX_SUBTABLES)
        fontError(`GPOS or GSUB lists more than ${MAX_SUBTABLES} subtables`, 'limit');
      const offsets = Array.from({ length: count }, () => reader.u16());
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

/** Coverage index of a glyph in the Coverage table at `at` of `r`, or -1 (formats 1 and 2). */
export function coverageIndex(r: BinaryReader, at: number, glyph: number): number {
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

/**
 * XAdvance of a ValueRecord at `at` with `format` (0 when the record has none). A variable instance adds the delta of
 * the record's X_ADVANCE_DEVICE VariationIndex table, whose offset counts from `parent`.
 */
function xAdvance(r: BinaryReader, at: number, format: number, parent: number, delta?: VariationDelta): number {
  let value = 0;
  if (format & 4) {
    r.seek(at + bits(format & 3) * 2);
    value = r.i16();
  }
  if (delta && format & 0x40) {
    r.seek(at + bits(format & 0x3f) * 2);
    const offset = r.u16();
    if (offset) {
      r.seek(parent + offset);
      const outer = r.u16(),
        inner = r.u16();
      // Other delta formats are pixel-size Device tables, which do not apply to outlines.
      if (r.u16() === 0x8000) value += Math.round(delta(outer, inner));
    }
  }
  return value;
}

/** The XAdvance a PairPos subtable gives the first glyph of a pair, or undefined when the subtable does not cover it. */
function pairAdjustment(r: BinaryReader, left: number, right: number, delta?: VariationDelta): number | undefined {
  r.seek(0);
  const format = r.u16(),
    coverageOffset = r.u16(),
    format1 = r.u16(),
    format2 = r.u16(),
    index = coverageIndex(r, coverageOffset, left);
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
      if (second === right) return xAdvance(r, at + 2, format1, set, delta);
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
  return xAdvance(r, 16 + (c1 * class2Count + c2) * size, format1, 0, delta);
}

/**
 * Pair kerning of a GPOS table's `kern` feature, in font units: `undefined` when the script has no `kern` feature
 * (the legacy 'kern' table then applies), else the sum of each lookup's first matching subtable.
 */
export function gposKerning(
  bytes: Uint8Array,
  delta?: VariationDelta,
): (left: number, right: number, script: string) => number | undefined {
  const layout = openTypeLayout(bytes, 9);
  return (left, right, script) => {
    const lookups = layout.lookups(script, 'kern');
    if (!lookups.length) return undefined;
    let value = 0;
    for (const lookup of lookups)
      for (const [type, reader] of layout.subtables(lookup)) {
        if (type !== 2) continue;
        const adjustment = pairAdjustment(reader, left, right, delta);
        if (adjustment !== undefined) {
          value += adjustment;
          break;
        }
      }
    return value;
  };
}
