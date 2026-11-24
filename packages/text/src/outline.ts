// @margoengine/text/outline: SDF text from a font file with no browser API, so titles and captions render the same in a
// page and in Node. Clean-room record: docs/clean-room.md, "Text outline SDF (GAP-FILM-TEXT)".
import { MargoError } from '@margoengine/math/errors';
import { Font, type GlyphBitmap } from './font.js';
import { FONT_HELP } from './font-reader.js';
import { parseFontOutlines, type FontOutlines } from './font-outlines.js';
import type { FontVariationOptions } from './font-variation.js';
import { bidiClass, isIdeograph, isWhitespace, layoutText, type LayoutOptions } from './layout.js';
import { OUTLINE_SDF_VERSION, outlineSdf } from './outline-sdf.js';
import { OutlineShaper, scriptTag } from './outline-shape.js';

export { outlineSdf, flattenOutline, windingAt, OUTLINE_SDF_VERSION } from './outline-sdf.js';
export type { OutlineSdf, OutlineSdfOptions } from './outline-sdf.js';
export { OutlineShaper, scriptTag } from './outline-shape.js';
export type { FontVariationOptions, FontVariationAxis } from './font-variation.js';

/** Default-ignorable code points (joiners, variation selectors) have no glyph and no advance here. */
export const IGNORABLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;
const CACHE_MAGIC = 0x4d474c59; // "MGLY"
let names = 0;

/** Options for `new GlyphFieldFont(bytes, ...)`. */
export interface GlyphFieldFontOptions extends FontVariationOptions {
  /** Pixels per em of the stored glyph fields, an integer from 8 to 512. Default 64. */
  size?: number;
  /** Field range in pixels, above 0 and at most size / 2. Default size / 4 (outline plus shadow blur up to 0.17 em). */
  radius?: number;
  /** A name for the font in errors and logs; nothing is registered. Default a unique name. */
  family?: string;
}

/** Options for {@link GlyphFieldFont.load}. */
export interface GlyphFieldFontLoadOptions extends GlyphFieldFontOptions {
  /** Cancels the download. */
  signal?: AbortSignal;
}

/** A shaped glyph run: glyph ids with their pen offsets in em, and the run's advance in em. */
export interface OutlineRun {
  readonly glyphs: readonly number[];
  readonly x: readonly number[];
  readonly advance: number;
}

/** Work counts of an {@link GlyphFieldFont}. */
export interface GlyphFieldFontStats {
  /** Glyph fields built from outlines. */
  rasterized: number;
  /** Texel to outline distance evaluations those builds spent. */
  evaluations: number;
  /** Glyph fields taken from {@link GlyphFieldFont.importGlyphs}. */
  imported: number;
}

/** 64-bit hash of a seed string and bytes (two 32-bit FNV-style lanes), as 16 hex digits. */
function hashBytes(bytes: Uint8Array, seed: string): string {
  let a = 0x811c9dc5,
    b = 0x9e3779b1;
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ v, 0x85ebca77);
  };
  for (let i = 0; i < seed.length; i++) mix(seed.charCodeAt(i));
  for (let i = 0; i < bytes.length; i++) mix(bytes[i]);
  b = Math.imul(b ^ (b >>> 15), 0xc2b2ae3d);
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * A font file used as an SDF glyph source with no browser API on any path: advances, ascent and descent come from the
 * file, kerning from its GPOS `kern` feature (or the legacy `kern` table), and every glyph's signed distance field is
 * built on the CPU from its outlines, with the same bytes in a page, a worker and Node. Draw it with the ordinary
 * `TextRenderer`: outlines, shadows, `RichText`, `AnimatedText`, `fitText` and `Ui({font})` work as with `Font`.
 * Reads TrueType and CFF/CFF2 OpenType files, variable instances included (a varied instance gets no kerning).
 */
export class GlyphFieldFont extends Font {
  /** The parsed outlines. */
  readonly outlines: FontOutlines;
  override readonly size: number;
  override readonly radius: number;
  override readonly cutoff: number;
  override readonly buffer: number;
  /** Work counts since construction. */
  readonly stats: GlyphFieldFontStats = { rasterized: 0, evaluations: 0, imported: 0 };
  private readonly bytes: Uint8Array;
  private readonly variations: Readonly<Record<string, number>>;
  private readonly shaper: OutlineShaper;
  private readonly runs = new Map<string, OutlineRun>();
  private readonly fields = new Map<string, GlyphBitmap>();
  private cacheKey?: string;

  /** Downloads a font file and returns its GlyphFieldFont. Rejects with the signal's reason when aborted. */
  static async load(url: string | URL, options: GlyphFieldFontLoadOptions = {}): Promise<GlyphFieldFont> {
    const { signal, ...rest } = options;
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError('failed', `Font download failed with HTTP ${response.status} for ${String(url)}; check the URL and that the server returns the font file. Help: ${FONT_HELP}`);
    const data = await response.arrayBuffer(),
      head = new Uint8Array(data, 0, Math.min(4, data.byteLength));
    // CFF ('OTTO') files and variable instances need the OpenType readers: load them only then.
    const needs = String.fromCharCode(...head) === 'OTTO' || Object.keys(rest.variations ?? {}).length > 0;
    if (needs && !rest.openType) rest.openType = (await import('@margoengine/loaders/font-opentype')).openType;
    return new this(data, rest);
  }

  /**
   * @throws MargoError `failed` for bytes that are not a TrueType or CFF OpenType font.
   * @throws RangeError for a size that is not an integer from 8 to 512, or a radius outside (0, size / 2].
   */
  constructor(data: ArrayBuffer | ArrayBufferView, options: GlyphFieldFontOptions = {}) {
    const size = options.size ?? 64;
    if (!Number.isInteger(size) || size < 8 || size > 512)
      throw new RangeError('GlyphFieldFont size must be an integer from 8 to 512 pixels per em; 64 suits captions, 128 or 256 large titles');
    const radius = options.radius ?? size / 4;
    if (typeof radius !== 'number' || !(radius > 0 && radius <= size / 2))
      throw new RangeError('GlyphFieldFont radius must be above 0 and at most size / 2 pixels');
    const outlines = parseFontOutlines(data, options);
    super({ family: options.family ?? `margo-outline-${++names}` });
    this.outlines = outlines;
    this.size = size;
    this.radius = radius;
    this.cutoff = 0.25;
    this.buffer = Math.ceil(radius * (1 - this.cutoff));
    this.bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.variations = { ...(options.variations ?? {}) };
    this.shaper = new OutlineShaper(outlines);
  }

  /** Units per em of the font file. */
  get unitsPerEm(): number {
    return this.outlines.unitsPerEm;
  }

  /** Always true: the outlines are in memory. */
  override get loaded(): boolean {
    return true;
  }

  /** Resolves at once; there is nothing to load. */
  override load(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Glyphs of a string after normalisation to NFC (when the font has every NFC code point), default-ignorable code
   * points dropped, `liga` ligatures and pair kerning applied between neighbours, with pen offsets in em.
   */
  shape(text: string): OutlineRun {
    let run = this.runs.get(text);
    if (run) return run;
    const outlines = this.outlines;
    const pick = (value: string) => [...value].filter((char) => !IGNORABLE.test(char));
    let chars = pick(text);
    const nfc = pick(text.normalize('NFC'));
    if (nfc.length !== chars.length && nfc.every((char) => outlines.glyphIndex(char) !== 0)) chars = nfc;
    const script = chars.length ? scriptTag(chars[0]) : 'latn';
    const glyphs = this.shaper.ligatures(chars.map((char) => outlines.glyphIndex(char)), script),
      x: number[] = [];
    let pen = 0;
    for (let i = 0; i < glyphs.length; i++) {
      const advance = outlines.glyphAdvance(glyphs[i]);
      if (i > 0 && advance !== 0) pen += this.glyphKerning(glyphs[i - 1], glyphs[i], script);
      x.push(pen);
      pen += advance;
    }
    run = { glyphs, x, advance: pen };
    this.runs.set(text, run);
    return run;
  }

  /** Kerning between two glyph ids in em from the file; 0 on a varied instance (variable kerning deltas are not read). */
  glyphKerning(left: number, right: number, script = 'latn'): number {
    if (this.outlines.varied) return 0;
    return this.shaper.kerning(left, right, script) / this.outlines.unitsPerEm;
  }

  /** Advance of a cluster or shaped run in em, kerning inside a run included. */
  override advance(cluster: string): number {
    return this.shape(cluster).advance;
  }

  /** Pair kerning in em from the font file. Spaces, ideographs and right-to-left pairs are not kerned (as with `Font`). */
  override kerning(left: string, right: string): number {
    if (
      isWhitespace(left) ||
      isWhitespace(right) ||
      isIdeograph(left) ||
      isIdeograph(right) ||
      bidiClass(left) === 'R' ||
      bidiClass(right) === 'R'
    )
      return 0;
    const a = this.shape(left).glyphs,
      b = this.shape(right).glyphs;
    if (!a.length || !b.length) return 0;
    const char = [...right][0];
    return this.glyphKerning(a[a.length - 1], b[0], scriptTag(char));
  }

  /** Ascent and descent in em from the horizontal header (`hhea`). */
  override metrics(): { ascent: number; descent: number } {
    return { ascent: this.outlines.ascender / this.unitsPerEm, descent: -this.outlines.descender / this.unitsPerEm };
  }

  /** The signed distance field of a cluster or shaped run, built once from the outlines. Null when it has no ink. */
  override glyph(cluster: string): GlyphBitmap | null {
    const cached = this.fields.get(cluster);
    if (cached) return cached.width ? cached : null;
    let glyph: GlyphBitmap = { cluster, width: 0, height: 0, left: 0, top: 0, color: false, data: new Uint8Array(0) };
    if (!isWhitespace(cluster)) {
      const run = this.shape(cluster),
        contours: number[][][] = [];
      for (let i = 0; i < run.glyphs.length; i++) {
        const dx = run.x[i];
        for (const loop of this.outlines.getGlyphSegments(run.glyphs[i]))
          contours.push(loop.map((s) => s.map((v, k) => (k % 2 ? v : v + dx))));
      }
      const field = outlineSdf(contours, this);
      if (field) {
        this.stats.rasterized++;
        this.stats.evaluations += field.evaluations;
        glyph = { cluster, width: field.width, height: field.height, left: field.left, top: field.top, color: false, data: field.data };
      }
    }
    this.fields.set(cluster, glyph);
    return glyph.width ? glyph : null;
  }

  /**
   * Builds the glyph fields `text` needs, laid out with `options` (pass the Text's `ligatures` so shaped runs are
   * built too). Returns how many fields were built now.
   */
  prepare(text: string, options: LayoutOptions = {}): number {
    const before = this.stats.rasterized;
    for (const g of layoutText(text, options, this).glyphs) if (!g.whitespace) this.glyph(g.cluster);
    return this.stats.rasterized - before;
  }

  /**
   * Identity of this font's glyph fields: a hash of the font bytes, size, radius, cutoff, buffer, variation values and
   * the rasteriser version. {@link importGlyphs} accepts only bytes with the same key.
   */
  get key(): string {
    return (this.cacheKey ??= hashBytes(
      this.bytes,
      JSON.stringify([OUTLINE_SDF_VERSION, this.size, this.radius, this.cutoff, this.buffer, Object.entries(this.variations).sort()]),
    ));
  }

  /** Every glyph field built so far, as bytes for {@link importGlyphs} in another process (for example a scene render). */
  exportGlyphs(): Uint8Array {
    const encoder = new TextEncoder(),
      key = encoder.encode(this.key),
      entries = [...this.fields.values()].map((g) => [encoder.encode(g.cluster), g] as const);
    let length = 14 + key.length;
    for (const [name, g] of entries) length += 14 + name.length + g.data.length;
    const out = new Uint8Array(length),
      view = new DataView(out.buffer);
    view.setUint32(0, CACHE_MAGIC, true);
    view.setUint32(4, OUTLINE_SDF_VERSION, true);
    view.setUint16(8, key.length, true);
    out.set(key, 10);
    let at = 10 + key.length;
    view.setUint32(at, entries.length, true);
    at += 4;
    for (const [name, g] of entries) {
      view.setUint16(at, name.length, true);
      out.set(name, at + 2);
      at += 2 + name.length;
      view.setUint16(at, g.width, true);
      view.setUint16(at + 2, g.height, true);
      view.setInt32(at + 4, g.left, true);
      view.setInt32(at + 8, g.top, true);
      out.set(g.data, at + 12);
      at += 12 + g.data.length;
    }
    return out;
  }

  /**
   * Takes glyph fields from {@link exportGlyphs}. Returns false, taking nothing, for bytes of another font, size,
   * radius, variation or rasteriser version (a stale cache); true once every field is in.
   * @throws MargoError `failed` for bytes with this font's key that are cut short or malformed.
   */
  importGlyphs(bytes: Uint8Array): boolean {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('importGlyphs takes a Uint8Array; pass the bytes exportGlyphs returned');
    if (bytes.length < 10) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      decoder = new TextDecoder();
    if (view.getUint32(0, true) !== CACHE_MAGIC || view.getUint32(4, true) !== OUTLINE_SDF_VERSION) return false;
    const keyLength = view.getUint16(8, true);
    if (bytes.length < 14 + keyLength || decoder.decode(bytes.subarray(10, 10 + keyLength)) !== this.key) return false;
    const broken = (): never => {
      throw new MargoError('failed', `Glyph cache bytes for this font are cut short or malformed; rebuild the cache. Help: ${FONT_HELP}`);
    };
    let at = 10 + keyLength;
    const count = view.getUint32(at, true),
      glyphs: GlyphBitmap[] = [];
    at += 4;
    for (let n = 0; n < count; n++) {
      if (at + 2 > bytes.length) broken();
      const nameLength = view.getUint16(at, true);
      if (at + 14 + nameLength > bytes.length) broken();
      const cluster = decoder.decode(bytes.subarray(at + 2, at + 2 + nameLength));
      at += 2 + nameLength;
      const width = view.getUint16(at, true),
        height = view.getUint16(at + 2, true),
        left = view.getInt32(at + 4, true),
        top = view.getInt32(at + 8, true);
      at += 12;
      if (at + width * height > bytes.length || (width === 0) !== (height === 0)) broken();
      glyphs.push({ cluster, width, height, left, top, color: false, data: bytes.slice(at, at + width * height) });
      at += width * height;
    }
    if (at !== bytes.length) broken();
    for (const g of glyphs) if (!this.fields.has(g.cluster)) {
      this.fields.set(g.cluster, g);
      this.stats.imported++;
    }
    return true;
  }
}
