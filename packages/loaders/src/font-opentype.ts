import type { OutlineFont } from './outline-font.js';
import { CFFOutlines } from './sfnt-cff.js';
import { FontItemStore, FontVariations } from './sfnt-variation.js';
import {
  parseTTF,
  parseTTFSource,
  type OpenTypeReaders,
  type OpenTypeReaderSet,
  type TTFFontSource,
  type TTFParseOptions,
} from './ttf.js';
import type { BinaryInput } from './util.js';

export type { OpenTypeReaders } from './ttf.js';

const readers: OpenTypeReaderSet = {
  name: 'opentype',
  cff: (table, cff2, glyphCount, unitsPerEm, coordinates) =>
    new CFFOutlines(table, cff2, glyphCount, unitsPerEm, coordinates),
  variations: (tables, glyphCount, values) => new FontVariations(tables, glyphCount, values),
  layoutDeltas(gdef, coordinates) {
    // GDEF 1.3 adds the offset of the item variation store its VariationIndex tables read.
    if (gdef.u16() !== 1 || gdef.u16() < 3) return undefined;
    gdef.seek(14);
    const offset = gdef.u32();
    if (!offset) return undefined;
    const store = new FontItemStore(gdef.tail(offset), coordinates);
    return (outer, inner) => store.delta(outer, inner);
  },
};
/**
 * The CFF, CFF2 and font-variation readers for `parseTTF(bytes, {openType})`: CFF and CFF2 `.otf` outlines, and
 * instances of variable fonts (`fvar`, `avar`, `gvar`, `HVAR`, CFF2 blends). They live in this entry so an app that
 * reads only TrueType fonts does not download them.
 */
export const openType: OpenTypeReaders = readers;

/** `parseTTF` with the OpenType readers: any `.ttf`, `.otf` or `.ttc`, variable instances included. */
export function parseOpenType(input: BinaryInput, options: TTFParseOptions = {}): OutlineFont {
  return parseTTF(input, { ...options, openType });
}

/** `parseTTFSource` with the OpenType readers. */
export function parseOpenTypeSource(input: BinaryInput, options: TTFParseOptions = {}): TTFFontSource {
  return parseTTFSource(input, { ...options, openType });
}
