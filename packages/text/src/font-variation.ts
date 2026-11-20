// Variable font instance types of the text builders. The variations themselves (fvar, avar, gvar, HVAR, CFF2
// blends) are read by @margoengine/loaders/font, Margo's one font outline parser.
import type { OpenTypeReaders } from '@margoengine/loaders/font';
export type { FontVariationAxis, OpenTypeReaders } from '@margoengine/loaders/font';

/** Instance coordinates in the font's fvar user units; omitted axes use their defaults. */
export interface FontVariationOptions {
  /** Axis tag to design value, clamped to the supported range. Default {}. */
  variations?: Readonly<Record<string, number>>;
  /**
   * The CFF, CFF2 and variation readers, `openType` from `@margoengine/loaders/font-opentype`. Needed for `.otf` (CFF)
   * fonts and for a `variations` instance; TrueType fonts at their default instance read without them, so a page
   * that uses only those does not load the readers. `GlyphFieldFont.load` and `VectorFont.load` import them on
   * their own when the file or options need them. Default none.
   */
  openType?: OpenTypeReaders;
}
