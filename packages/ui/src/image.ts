import { Widget, edges, type DrawContext, type WidgetOptions, type Rect, type Edges, type Rgba } from '@margoengine/ui';
import { rangeError, typeError, fault } from '../../shared/errors.js';

function copySlice(value: Edges | undefined): [number, number, number, number] | undefined {
  if (value === undefined) return undefined;
  const [top, right, bottom, left] = edges(value);
  return [top, right, bottom, left];
}

/** Immutable straight-alpha sRGB pixels, shared by image widgets. */
export class ImageTexture {
  /** Pixel width. */
  readonly width: number;
  /** Pixel height. */
  readonly height: number;
  private readonly pixels: Uint8Array;
  private readonly cells = new Map<string, ImageTile[]>();
  /** Copy width * height * 4 RGBA bytes. */
  constructor(width: number, height: number, data: Uint8Array | Uint8ClampedArray) {
    if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0) || data.length !== width * height * 4)
      throw rangeError('ImageTexture needs positive integer dimensions and width * height * 4 RGBA bytes', 'ui');
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(data);
  }
  /** Decode a URL with cancellation; caller retains ownership of any original image. */
  static async load(url: string | URL, options: { signal?: AbortSignal } = {}): Promise<ImageTexture> {
    try {
      const response = await fetch(url, { signal: options.signal });
      if (!response.ok)
        throw fault('failed', `Image load returned HTTP ${response.status}; use an accessible image URL`, 'ui');
      const bitmap = await createImageBitmap(await response.blob());
      try {
        options.signal?.throwIfAborted();
        return ImageTexture.from(bitmap);
      } finally {
        bitmap.close();
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof Error && error.name === 'MargoError') throw error;
      throw Object.assign(
        fault('failed', 'Could not decode the UI image; use a supported, CORS-accessible image URL in a browser', 'ui'),
        { cause: error },
      );
    }
  }
  /** Snapshot a decoded image, video frame or canvas using its natural pixel size. */
  static from(source: CanvasImageSource): ImageTexture {
    const image = source as {
      naturalWidth?: number;
      naturalHeight?: number;
      videoWidth?: number;
      videoHeight?: number;
      displayWidth?: number;
      displayHeight?: number;
      width?: number | SVGAnimatedLength;
      height?: number | SVGAnimatedLength;
    };
    const pixels = (value: number | SVGAnimatedLength | undefined) =>
      typeof value === 'number' ? value : (value?.baseVal.value ?? 0);
    const width = image.naturalWidth ?? image.videoWidth ?? image.displayWidth ?? pixels(image.width),
      height = image.naturalHeight ?? image.videoHeight ?? image.displayHeight ?? pixels(image.height);
    if (!(width > 0) || !(height > 0))
      throw rangeError('ImageTexture.from needs a decoded image or a video with a current frame', 'ui');
    const canvas = new OffscreenCanvas(width, height),
      context = canvas.getContext('2d')!;
    context.drawImage(source, 0, 0);
    return new ImageTexture(width, height, context.getImageData(0, 0, width, height).data);
  }
  /** @internal Snapshot an atlas cell with clamped neighbor texels for bilinear filtering. */
  tiles(cell: Rect): readonly ImageTile[] {
    const key = `${cell.x},${cell.y},${cell.width},${cell.height}`;
    const previous = this.cells.get(key);
    if (previous) return previous;
    const result: ImageTile[] = [];
    for (let y = 0; y < cell.height; y += 60)
      for (let x = 0; x < cell.width; x += 60) {
        const w = Math.min(60, cell.width - x),
          h = Math.min(60, cell.height - y),
          data = new Uint8Array((w + 2) * (h + 2) * 4);
        for (let row = -1; row <= h; row++)
          for (let col = -1; col <= w; col++) {
            const sx = cell.x + Math.max(0, Math.min(cell.width - 1, x + col)),
              sy = cell.y + Math.max(0, Math.min(cell.height - 1, y + row));
            const from = (sy * this.width + sx) * 4,
              to = ((row + 1) * (w + 2) + col + 1) * 4,
              alpha = this.pixels[from + 3];
            for (let c = 0; c < 3; c++) data[to + c] = Math.round((this.pixels[from + c] * alpha) / 255);
            data[to + 3] = alpha;
          }
        result.push({
          x,
          y,
          width: w,
          height: h,
          bitmap: { cluster: '', left: 0, top: 0, color: true, width: w + 2, height: h + 2, data },
        });
      }
    this.cells.set(key, result);
    return result;
  }
}
interface ImageTile extends Rect {
  bitmap: import('@margoengine/text').GlyphBitmap;
}
/** Options for an Image, including atlas cropping and fixed corner borders. */
export interface ImageOptions extends WidgetOptions {
  /** Shared pixel texture. */
  texture: ImageTexture;
  /** Pixel rectangle within the texture. Default full image. */
  source?: Rect;
  /** Default contain. Cover crops the source; fill stretches it. */
  fit?: 'contain' | 'cover' | 'fill';
  /** Top, right, bottom, left source border pixels. Omit for ordinary images. */
  slice?: Edges;
  /** UI units per source border pixel. Default 1. */
  borderScale?: number;
  /** Straight sRGB tint. Default opaque white. */
  tint?: Rgba;
}
/** Textured widget with atlas cells, fit modes and nine-slice borders. */
export class Image extends Widget {
  private _texture: ImageTexture;
  private _source?: Rect;
  private _fit: 'contain' | 'cover' | 'fill';
  private _slice?: Edges;
  private _borderScale: number;
  private _tint: Rgba;
  constructor({
    texture,
    source,
    fit = 'contain',
    slice,
    borderScale = 1,
    tint = [1, 1, 1, 1],
    ...rest
  }: ImageOptions) {
    super(rest);
    this._texture = texture;
    this._source = source && { ...source };
    this._fit = fit;
    this._slice = copySlice(slice);
    this._borderScale = borderScale;
    this._tint = [...tint];
    this.validate();
    this.role = 'img';
    this.pointerEvents = rest.pointerEvents ?? 'none';
  }
  private validate(): void {
    if (!(this._texture instanceof ImageTexture))
      throw typeError('Image needs an ImageTexture; load or create one first', 'ui');
    if (!['contain', 'cover', 'fill'].includes(this._fit))
      throw typeError('Image fit must be contain, cover or fill', 'ui');
    const s = this.cell;
    if (
      ![s.x, s.y, s.width, s.height].every(Number.isInteger) ||
      s.x < 0 ||
      s.y < 0 ||
      s.width <= 0 ||
      s.height <= 0 ||
      s.x + s.width > this.texture.width ||
      s.y + s.height > this.texture.height
    )
      throw rangeError('Image source must be an integer pixel rectangle inside its texture', 'ui');
    if (
      !(this._borderScale >= 0) ||
      !Number.isFinite(this._borderScale) ||
      !this._tint ||
      this._tint.length !== 4 ||
      !this._tint.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    )
      throw rangeError(
        'Image borderScale must be finite and nonnegative and tint must contain four values in [0,1]',
        'ui',
      );
    if (this._slice !== undefined) {
      const [t, r, b, l] = edges(this._slice);
      if (![t, r, b, l].every((v) => Number.isFinite(v) && v >= 0) || l + r > s.width || t + b > s.height)
        throw rangeError('Image slice borders must be nonnegative and fit within the source rectangle', 'ui');
    }
  }
  private get cell(): Rect {
    return this._source ?? { x: 0, y: 0, width: this.texture.width, height: this.texture.height };
  }
  /** Current immutable pixel texture. */
  get texture(): ImageTexture {
    return this._texture;
  }
  set texture(v: ImageTexture) {
    const old = this._texture;
    this._texture = v;
    try {
      this.validate();
    } catch (e) {
      this._texture = old;
      throw e;
    }
    this.invalidate();
  }
  /** Source atlas cell. Undefined selects the whole texture. */
  get source(): Rect | undefined {
    return this._source && { ...this._source };
  }
  set source(v: Rect | undefined) {
    const old = this._source;
    this._source = v && { ...v };
    try {
      this.validate();
    } catch (e) {
      this._source = old;
      throw e;
    }
    this.invalidate();
  }
  /** Image sizing mode. */
  get fit(): 'contain' | 'cover' | 'fill' {
    return this._fit;
  }
  set fit(v: 'contain' | 'cover' | 'fill') {
    const old = this._fit;
    this._fit = v;
    try {
      this.validate();
    } catch (e) {
      this._fit = old;
      throw e;
    }
    this.invalidate(false);
  }
  /** Source border widths. */
  get slice(): Edges | undefined {
    return copySlice(this._slice);
  }
  set slice(v: Edges | undefined) {
    const old = this._slice;
    this._slice = copySlice(v);
    try {
      this.validate();
    } catch (e) {
      this._slice = old;
      throw e;
    }
    this.invalidate(false);
  }
  /** Border size in UI units per source pixel. */
  get borderScale(): number {
    return this._borderScale;
  }
  set borderScale(v: number) {
    const old = this._borderScale;
    this._borderScale = v;
    try {
      this.validate();
    } catch (e) {
      this._borderScale = old;
      throw e;
    }
    this.invalidate(false);
  }
  /** Multiplies texture RGBA. */
  get tint(): Rgba {
    return [...this._tint];
  }
  set tint(v: Rgba) {
    const old = this._tint;
    this._tint = [...v];
    try {
      this.validate();
    } catch (e) {
      this._tint = old;
      throw e;
    }
    this.invalidate(false);
  }
  override measure(): { width: number; height: number } {
    return { width: this.cell.width, height: this.cell.height };
  }
  override draw({ list }: DrawContext): void {
    const [pt, pr, pb, pl] = edges(this.style.padding),
      r = {
        x: this.rect.x + pl,
        y: this.rect.y + pt,
        width: Math.max(0, this.rect.width - pl - pr),
        height: Math.max(0, this.rect.height - pt - pb),
      },
      cell = this.cell;
    if (!r.width || !r.height) return;
    const patches: { src: Rect; dst: Rect }[] = [];
    if (this.slice !== undefined) {
      const [t, right, b, l] = edges(this.slice),
        k = Math.min(this.borderScale, r.width / (l + right || 1), r.height / (t + b || 1));
      const xs = [0, l, cell.width - right, cell.width],
        ys = [0, t, cell.height - b, cell.height],
        dx = [r.x, r.x + l * k, r.x + r.width - right * k, r.x + r.width],
        dy = [r.y, r.y + t * k, r.y + r.height - b * k, r.y + r.height];
      for (let y = 0; y < 3; y++)
        for (let x = 0; x < 3; x++)
          patches.push({
            src: { x: xs[x], y: ys[y], width: xs[x + 1] - xs[x], height: ys[y + 1] - ys[y] },
            dst: { x: dx[x], y: dy[y], width: dx[x + 1] - dx[x], height: dy[y + 1] - dy[y] },
          });
    } else {
      let src = { x: 0, y: 0, width: cell.width, height: cell.height },
        dst = { ...r };
      if (this.fit !== 'fill') {
        const k = (this.fit === 'contain' ? Math.min : Math.max)(r.width / cell.width, r.height / cell.height);
        if (this.fit === 'contain')
          dst = {
            x: r.x + (r.width - cell.width * k) / 2,
            y: r.y + (r.height - cell.height * k) / 2,
            width: cell.width * k,
            height: cell.height * k,
          };
        else
          src = {
            x: (cell.width - r.width / k) / 2,
            y: (cell.height - r.height / k) / 2,
            width: r.width / k,
            height: r.height / k,
          };
      }
      patches.push({ src, dst });
    }
    list.pushClip(r.x, r.y, r.width, r.height);
    for (const { src, dst } of patches) {
      if (src.width <= 0 || src.height <= 0 || dst.width <= 0 || dst.height <= 0) continue;
      for (const tile of this.texture.tiles(cell)) {
        const x = Math.max(src.x, tile.x),
          y = Math.max(src.y, tile.y),
          right = Math.min(src.x + src.width, tile.x + tile.width),
          bottom = Math.min(src.y + src.height, tile.y + tile.height);
        if (right <= x || bottom <= y) continue;
        const kx = dst.width / src.width,
          ky = dst.height / src.height,
          s = list.scale;
        list.commands.push({
          type: 'image',
          bitmap: tile.bitmap,
          x: (dst.x + (x - src.x) * kx) * s,
          y: (dst.y + (y - src.y) * ky) * s,
          width: (right - x) * kx * s,
          height: (bottom - y) * ky * s,
          source: { x: x - tile.x + 1, y: y - tile.y + 1, width: right - x, height: bottom - y },
          color: [this._tint[0], this._tint[1], this._tint[2], this._tint[3] * list.alpha],
        });
      }
    }
    list.popClip();
  }
}
