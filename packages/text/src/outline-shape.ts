// Pair kerning and ligatures of a font file. Kerning (GPOS 'kern', else the 'kern' table) comes from
// @margoengine/loaders/font, Margo's one font parser. GSUB lookup type 4 (ligature substitution) and type 7 (extension)
// are read here, clean room from the Microsoft/Adobe OpenType Specification v1.9.1
// (https://learn.microsoft.com/en-us/typography/opentype/spec/gsub).
import {
  coverageIndex,
  openTypeLayout,
  scriptTag as parserScriptTag,
  type OpenTypeLayout,
} from '@margoengine/loaders/font';
import { fontError } from './font-reader.js';
import type { FontOutlines } from './font-outlines.js';

/** OpenType script tag for a character: kerning features are looked up under it, then DFLT, then latn. */
export function scriptTag(char: string): string {
  return parserScriptTag(char);
}

/** Kerning and ligatures of one font file: GPOS or 'kern' pairs, and GSUB `liga`. Values are in font units. */
export class OutlineShaper {
  private readonly gsub?: OpenTypeLayout;
  private readonly outlines: FontOutlines;

  constructor(outlines: FontOutlines) {
    this.outlines = outlines;
    const gsub = outlines.tableBytes('GSUB');
    if (gsub) this.gsub = openTypeLayout(gsub, 7);
  }

  /** Kerning between two glyphs in font units under a script tag: the sum of each `kern` lookup's first match. */
  kerning(left: number, right: number, script = 'latn'): number {
    return this.outlines.kerning(left, right, script);
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
          const index = coverageIndex(r, r.u16(), run[i]);
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
