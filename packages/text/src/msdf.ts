// Prebuilt distance-field fonts: the BMFont JSON layout with PNG atlas pages, as written by public msdf and sdf font
// generators. No font rasterizing, so it works where the browser has no matching font.
import { Font, type GlyphBitmap } from './font.js';

/** One entry of a BMFont file's `chars`. */
export interface BitmapChar {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
  xadvance: number;
  page: number;
}

/** A BMFont JSON file. */
export interface BitmapFontData {
  pages: readonly string[];
  chars: readonly BitmapChar[];
  info: { size: number };
  common: { lineHeight: number; base: number };
  kernings?: ReadonlyArray<{ first: number; second: number; amount: number }>;
  distanceField?: { fieldType?: string; distanceRange: number };
}

/** RGBA pixels of one atlas page, top row first. */
export interface BitmapPage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * A font from a prebuilt distance-field atlas; pass it as `font` to any `Text`. RGB distance channels stay
 * intact through GPU filtering; the shader then takes their median, preserving sharp corners.
 * A scalar fallback is retained for glyph consumers outside TextRenderer.
 * @throws TypeError when `data` is not a BMFont file with a `distanceField`, or a page is missing.
 */
export class BitmapFont extends Font {
  private readonly chars = new Map<number, BitmapChar>();
  private readonly kernTable = new Map<number, number>();
  private readonly bitmaps = new Map<string, GlyphBitmap | null>();
  private readonly em: number;
  private readonly multi: boolean;

  constructor(
    readonly data: BitmapFontData,
    readonly pages: readonly BitmapPage[],
  ) {
    super();
    const field = data?.distanceField;
    if (!Array.isArray(data?.chars) || !data.info || !data.common || !(field && field.distanceRange > 0))
      throw new TypeError(
        'BitmapFont needs chars, info, common and distanceField; pass BMFont JSON from a distance-field generator',
      );
    if (pages.length < data.pages.length)
      throw new TypeError(`BitmapFont needs ${data.pages.length} atlas pages; pass one for each name in data.pages`);
    this.em = Math.abs(data.info.size);
    this.multi = /^mt?sdf$/.test(field.fieldType ?? 'msdf');
    const self = this as unknown as { size: number; radius: number; cutoff: number; buffer: number };
    self.size = this.em;
    self.radius = field.distanceRange;
    self.cutoff = 0.5;
    self.buffer = 0;
    for (const c of data.chars) this.chars.set(c.id, c);
    for (const k of data.kernings ?? []) this.kernTable.set(k.first * 0x200000 + k.second, k.amount);
  }

  /** Fetches a BMFont JSON file and its PNG pages, which sit next to it unless `pagesAt` says otherwise. Works in workers. */
  static async load(url: string | URL, { signal, pagesAt }: { signal?: AbortSignal; pagesAt?: string | URL } = {}) {
    const base = new URL(url, globalThis.location?.href);
    const response = await fetch(base, { signal });
    if (!response.ok) throw new TypeError(`BitmapFont could not fetch ${base}: ${response.status}; check the URL`);
    const data = (await response.json()) as BitmapFontData;
    const pages = await Promise.all(
      data.pages.map(async (page) => {
        const reply = await fetch(new URL(page, pagesAt ?? base), { signal });
        if (!reply.ok) throw new TypeError(`BitmapFont could not fetch page ${page}: ${reply.status}; check pagesAt`);
        const { decodePNG } = await import('@margoengine/decoders/png');
        signal?.throwIfAborted();
        // Font distance channels are data, including MTSDF alpha: never premultiply or colour-convert them.
        return decodePNG(new Uint8Array(await reply.arrayBuffer()));
      }),
    );
    return new BitmapFont(data, pages);
  }

  override get loaded(): boolean {
    return true;
  }
  override load(): Promise<void> {
    return Promise.resolve();
  }
  override advance(cluster: string): number {
    let sum = 0;
    for (const point of cluster) sum += (this.chars.get(point.codePointAt(0)!)?.xadvance ?? 0) / this.em;
    return sum;
  }
  override kerning(left: string, right: string): number {
    return (this.kernTable.get(left.codePointAt(0)! * 0x200000 + right.codePointAt(0)!) ?? 0) / this.em;
  }
  override metrics(): { ascent: number; descent: number } {
    const { base, lineHeight } = this.data.common;
    return { ascent: base / this.em, descent: Math.max(0, lineHeight - base) / this.em };
  }
  override glyph(cluster: string): GlyphBitmap | null {
    let glyph = this.bitmaps.get(cluster);
    if (glyph !== undefined) return glyph;
    const c = this.chars.get(cluster.codePointAt(0)!);
    glyph = null;
    if (c && c.width && c.height) {
      const page = this.pages[c.page],
        out = new Uint8Array(c.width * c.height),
        channels = this.multi ? new Uint8Array(c.width * c.height * 4) : undefined;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const i = ((c.y + y) * page.width + c.x + x) * 4,
            r = page.data[i],
            g = page.data[i + 1],
            b = page.data[i + 2];
          if (channels) channels.set(page.data.subarray(i, i + 4), (y * c.width + x) * 4);
          out[y * c.width + x] = this.multi ? Math.max(Math.min(r, g), Math.min(Math.max(r, g), b)) : r;
        }
      glyph = {
        cluster,
        width: c.width,
        height: c.height,
        left: c.xoffset,
        top: this.data.common.base - c.yoffset,
        color: false,
        data: out,
        msdf: channels,
      };
    }
    this.bitmaps.set(cluster, glyph);
    return glyph;
  }
}
