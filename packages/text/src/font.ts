import {alphaToSdf, SDF_DEFAULTS} from './sdf.js';
import {bidiClass, isIdeograph, isWhitespace, type TextMeasurer} from './layout.js';

export interface FontOptions {
  /** CSS font family or family list, e.g. 'Inter' or '"Noto Sans", sans-serif'. Default 'sans-serif'. */
  family?: string;
  /** CSS font weight. Default 'normal' (or the FontFace's weight). */
  weight?: string | number;
  /** CSS font style. Default 'normal' (or the FontFace's style). */
  style?: 'normal' | 'italic' | 'oblique';
  /** A FontFace to load and register before rasterizing; its family is used when `family` is not given. */
  face?: FontFace;
}

/**
 * A rasterized grapheme cluster at the base SDF size, in base pixels. `data` holds one SDF byte per texel,
 * or premultiplied RGBA for color glyphs such as emoji.
 */
export interface GlyphBitmap {
  readonly cluster: string;
  readonly width: number;
  readonly height: number;
  /** Bitmap left edge relative to the pen position (right is positive). */
  readonly left: number;
  /** Bitmap top edge above the baseline. */
  readonly top: number;
  readonly color: boolean;
  readonly data: Uint8Array;
}

type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/;

const quoteFamily = (family: string): string => {
  const trimmed = family.trim();
  if (/[,"']/.test(trimmed) || GENERIC.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/\\/g, '\\\\')}"`;
};

let warnedLoad = false;

/**
 * A browser font used as a glyph source and text measurer. Glyphs are rasterized lazily on an
 * OffscreenCanvas (or a canvas element) at `size` pixels and turned into signed distance fields.
 * Nothing touches the DOM until the first measurement, so construction is SSR-safe. A Font can be
 * shared by any number of Text objects and engines.
 */
export class Font implements TextMeasurer {
  readonly family: string;
  readonly weight: string;
  readonly style: string;
  readonly face?: FontFace;
  /** Base rasterization size in pixels; glyph quads scale from it. */
  readonly size = SDF_DEFAULTS.size;
  /** Empty texels around each glyph, enough for the SDF ramp, outlines and soft shadows. */
  readonly buffer = SDF_DEFAULTS.buffer;
  readonly radius = SDF_DEFAULTS.radius;
  readonly cutoff = SDF_DEFAULTS.cutoff;
  private context?: Context2D;
  private readonly advances = new Map<string, number>();
  /** Kerning by left cluster, then right cluster. */
  private readonly kerns = new Map<string, Map<string, number>>();
  private readonly glyphs = new Map<string, GlyphBitmap>();
  private cachedMetrics?: {ascent: number; descent: number};
  private loading?: Promise<void>;
  private failed = false;
  /** Bumped when cached measurements are dropped after loading; text relayouts when it changes. */
  revision = 0;

  constructor(options: FontOptions = {}) {
    const {face} = options;
    if (face !== undefined && (typeof face !== 'object' || typeof face.load !== 'function')) throw new TypeError('face must be a FontFace');
    const family = options.family ?? face?.family ?? 'sans-serif';
    if (typeof family !== 'string' || !family.trim()) throw new TypeError('Font family must be a non-empty string');
    this.face = face;
    this.family = quoteFamily(family);
    this.weight = String(options.weight ?? (face && face.weight !== 'normal' && !/\s/.test(face.weight) ? face.weight : 'normal'));
    this.style = options.style ?? (face?.style === 'italic' || face?.style === 'oblique' ? face.style : 'normal');
    if (!/^(normal|bold|bolder|lighter|[1-9]00|\d{1,4}(\.\d+)?)$/.test(this.weight)) throw new TypeError('Invalid font weight');
    if (!['normal', 'italic', 'oblique'].includes(this.style)) throw new TypeError('Invalid font style');
  }

  /** CSS font shorthand at the base size. */
  get css(): string {return `${this.style} ${this.weight} ${this.size}px ${this.family}`;}

  /** False while a FontFace is still loading; text using the font waits instead of rasterizing a fallback. */
  get loaded(): boolean {return this.failed || !this.face || this.face.status === 'loaded';}

  /**
   * Loads the FontFace and registers it with the document (or worker) font set; for CSS web fonts, asks the
   * font set to load the faces needed for `sample`. Text drawn before this resolves waits. Clears cached
   * measurements so nothing measured with a fallback font survives.
   */
  load(sample = 'A'): Promise<void> {
    return this.loading ??= (async () => {
      const fonts = (globalThis as unknown as {document?: {fonts?: FontFaceSet}; fonts?: FontFaceSet}).document?.fonts ?? (globalThis as unknown as {fonts?: FontFaceSet}).fonts;
      try {
        if (this.face) {await this.face.load(); if (fonts && !fonts.has(this.face)) fonts.add(this.face);}
        else if (fonts) await fonts.load(this.css, sample);
      } catch (error) {
        this.failed = true;
        if (!warnedLoad) {warnedLoad = true; console.warn(`@margoengine/text: font ${this.css} failed to load, using a fallback.`, error);}
      }
      this.advances.clear(); this.kerns.clear(); this.glyphs.clear(); this.cachedMetrics = undefined; this.revision++;
    })();
  }

  private ctx(width = 1, height = 1): Context2D {
    let context = this.context;
    if (!context) {
      const offscreen = typeof OffscreenCanvas !== 'undefined';
      const canvas = offscreen ? new OffscreenCanvas(128, 128) : (globalThis as unknown as {document?: Document}).document?.createElement('canvas');
      if (!canvas) throw new Error('Text measurement needs OffscreenCanvas or a DOM canvas');
      if (!offscreen) {canvas.width = 128; canvas.height = 128;}
      context = (canvas.getContext('2d', {willReadFrequently: true}) as Context2D | null) ?? undefined;
      if (!context) throw new Error('2D canvas context unavailable');
      this.context = context;
      this.configure(context);
    }
    const canvas = context.canvas;
    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.max(canvas.width, Math.ceil(width / 64) * 64); canvas.height = Math.max(canvas.height, Math.ceil(height / 64) * 64);
      this.configure(context);
    }
    return context;
  }

  private configure(context: Context2D): void {
    context.font = this.css; context.textAlign = 'left'; context.textBaseline = 'alphabetic';
    context.fillStyle = '#000';
    (context as {fontKerning?: string}).fontKerning = 'normal';
  }

  /** Advance of a cluster in em. */
  advance(cluster: string): number {
    let value = this.advances.get(cluster);
    if (value === undefined) {value = this.ctx().measureText(cluster).width / this.size; this.advances.set(cluster, value);}
    return value;
  }

  /** Pair kerning in em, measured as width(ab) - width(a) - width(b) and cached. Ideographs, spaces and right-to-left pairs are not kerned. */
  kerning(left: string, right: string): number {
    if (isWhitespace(left) || isWhitespace(right) || isIdeograph(left) || isIdeograph(right) || bidiClass(left) === 'R' || bidiClass(right) === 'R') return 0;
    let row = this.kerns.get(left);
    if (!row) this.kerns.set(left, row = new Map());
    let value = row.get(right);
    if (value === undefined) {
      value = this.ctx().measureText(left + right).width / this.size - this.advance(left) - this.advance(right);
      if (Math.abs(value) < 1e-4) value = 0;
      row.set(right, value);
    }
    return value;
  }

  /** Font ascent and descent in em, from the font bounding box. */
  metrics(): {ascent: number; descent: number} {
    if (!this.cachedMetrics) {
      const m = this.ctx().measureText('Hg');
      const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent, descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
      this.cachedMetrics = {ascent: (Number.isFinite(ascent) ? ascent : this.size * 0.8) / this.size, descent: (Number.isFinite(descent) ? descent : this.size * 0.2) / this.size};
    }
    return this.cachedMetrics;
  }

  /** Rasterizes a cluster once and caches it. Returns null for clusters with no ink, such as spaces. */
  glyph(cluster: string): GlyphBitmap | null {
    const cached = this.glyphs.get(cluster);
    if (cached) return cached.width ? cached : null;
    const empty: GlyphBitmap = {cluster, width: 0, height: 0, left: 0, top: 0, color: false, data: new Uint8Array(0)};
    if (isWhitespace(cluster)) {this.glyphs.set(cluster, empty); return null;}
    const m = this.ctx().measureText(cluster), b = this.buffer;
    // One extra pixel on every side catches antialiasing that the reported bounds leave out.
    const x0 = Math.floor(-m.actualBoundingBoxLeft) - 1, x1 = Math.ceil(m.actualBoundingBoxRight) + 1;
    const y0 = Math.floor(-m.actualBoundingBoxAscent) - 1, y1 = Math.ceil(m.actualBoundingBoxDescent) + 1;
    if (!(x1 - x0 > 2 && y1 - y0 > 2) || ![x0, x1, y0, y1].every(Number.isFinite)) {this.glyphs.set(cluster, empty); return null;}
    const width = Math.min(x1 - x0 + 2 * b, 4 * this.size), height = Math.min(y1 - y0 + 2 * b, 4 * this.size);
    const context = this.ctx(width, height);
    context.clearRect(0, 0, width, height);
    context.fillText(cluster, b - x0, b - y0);
    const pixels = context.getImageData(0, 0, width, height).data;
    let color = false;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 32 && pixels[i] + pixels[i + 1] + pixels[i + 2] > 48) {color = true; break;}
    let data: Uint8Array;
    if (color) {
      data = new Uint8Array(pixels.length);
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        data[i] = Math.round(pixels[i] * a / 255); data[i + 1] = Math.round(pixels[i + 1] * a / 255); data[i + 2] = Math.round(pixels[i + 2] * a / 255); data[i + 3] = a;
      }
    } else data = alphaToSdf(pixels, width, height, this, 4, 3);
    const glyph: GlyphBitmap = {cluster, width, height, left: x0 - b, top: b - y0, color, data};
    this.glyphs.set(cluster, glyph);
    return glyph;
  }
}
