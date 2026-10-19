/// <reference lib="esnext.disposable" preserve="true" />
// Block textures of @margoengine/voxel/render: one rgba8unorm-srgb 2D array with a layer per block texture. The mips
// are filtered on the CPU once per layer (alpha-weighted colour, alpha-coverage preserving) and kept, so set() and a
// restored device upload them again without the source images.
import { MargoError } from '@margoengine/math/errors';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** Options of {@link BlockTextures}. */
export interface BlockTexturesOptions {
  /**
   * Width and height of every layer in texels, a power of two from 1 to 4,096. Images of another size are drawn at
   * this size, nearest-neighbour. Default: the first image's width, or 16.
   */
  size?: number;
  /**
   * One image per texture layer, layer 0 first, at most 256: anything `drawImage` takes, or raw `ImageData`-shaped
   * `{width, height, data}` RGBA8 pixels (top row first) of exactly `size` x `size`. Default: one white layer.
   */
  images?: readonly (CanvasImageSource | ImageData)[];
}

type Image = CanvasImageSource | ImageData;
interface State {
  levels: Uint8Array[][];
  dirty: Set<number>;
  disposed: boolean;
  gpu?: { device: GPUDevice; texture: GPUTexture; view: GPUTextureView; layers: number };
}
const states = new WeakMap<BlockTextures, State>(),
  MAX_LAYERS = 256,
  // sRGB byte -> linear, and back (IEC 61966-2-1).
  LINEAR = Float32Array.from({ length: 256 }, (_, i) =>
    i <= 10 ? i / 255 / 12.92 : ((i / 255 + 0.055) / 1.055) ** 2.4,
  ),
  srgb = (v: number): number =>
    Math.round(255 * (v <= 0.0031308 ? Math.max(0, v) * 12.92 : 1.055 * Math.min(1, v) ** (1 / 2.4) - 0.055));

// Texels an alpha test at 0.5 keeps (as the shader sees the stored bytes: 128 and up) with alpha scaled by `scale`.
function covered(alpha: Float32Array, scale: number): number {
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (Math.round(255 * Math.min(1, alpha[i] * scale)) >= 128) n++;
  return n / alpha.length;
}

/**
 * The mip chain of one `size` x `size` RGBA8 sRGB layer, level 0 (`pixels` itself) down to 1 x 1. Each level is a 2 x 2
 * box filter of the one above: colour averaged in linear light weighted by alpha (so transparent texels do not darken
 * leaf edges), alpha averaged. When every level-0 alpha is 0 or 255 (a cutout texture) the averaged alpha is then scaled
 * so an alpha test at 0.5 keeps the same share of texels as level 0 (Castano, "Computing Alpha Mipmaps", 2010): cutout
 * foliage keeps its density in the distance instead of thinning out. Other alpha (glass, water) stays the average.
 */
function mipChain(pixels: Uint8Array, size: number): Uint8Array[] {
  const out = [pixels];
  let n = size,
    alpha = Float32Array.from({ length: n * n }, (_, i) => pixels[i * 4 + 3] / 255),
    color = Float32Array.from({ length: n * n * 3 }, (_, i) => LINEAR[pixels[((i / 3) | 0) * 4 + (i % 3)]]);
  const target = alpha.every((a) => a === 0 || a === 1) && !alpha.every((a) => a === 1) ? covered(alpha, 1) : -1;
  while (n > 1) {
    const m = n >> 1,
      a = new Float32Array(m * m),
      c = new Float32Array(m * m * 3),
      level = new Uint8Array(m * m * 4);
    for (let y = 0; y < m; y++)
      for (let x = 0; x < m; x++) {
        const o = y * m + x,
          p = 2 * y * n + 2 * x,
          taps = [p, p + 1, p + n, p + n + 1];
        let sum = 0;
        for (const t of taps) sum += alpha[t];
        for (let k = 0; k < 3; k++) {
          let v = 0;
          for (const t of taps) v += color[t * 3 + k] * (sum ? alpha[t] : 1);
          c[o * 3 + k] = v / (sum || 4);
        }
        a[o] = sum / 4;
      }
    let scale = 1;
    if (target >= 0) {
      // Smallest scale reaching the target coverage (coverage only grows with it), or the one just under when nearer.
      let lo = 0,
        hi = 4096;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (covered(a, mid) < target) lo = mid;
        else hi = mid;
      }
      scale = Math.abs(covered(a, lo) - target) < Math.abs(covered(a, hi) - target) ? lo : hi;
    }
    for (let i = 0; i < m * m; i++) {
      for (let k = 0; k < 3; k++) level[i * 4 + k] = srgb(c[i * 3 + k]);
      level[i * 4 + 3] = Math.round(255 * Math.min(1, a[i] * scale));
    }
    out.push(level);
    n = m;
    alpha = a;
    color = c;
  }
  return out;
}

const isPixels = (image: Image): image is ImageData =>
  !!image && typeof image === 'object' && 'data' in image && typeof image.data?.length === 'number';

// An image's pixel size: natural size for <img>, display size for a VideoFrame, else width x height.
function dimensions(image: Image): [number, number] {
  const i = image as { naturalWidth?: number; naturalHeight?: number; displayWidth?: number; displayHeight?: number };
  if (i.naturalWidth) return [i.naturalWidth, i.naturalHeight ?? 0];
  if (i.displayWidth) return [i.displayWidth, i.displayHeight ?? 0];
  const { width, height } = image as { width: number; height: number };
  return [Number(width), Number(height)];
}

// The size x size RGBA8 pixels of the (sx, sy) sw x sh region of `image`, scaled (raw pixels are only cropped).
function read(image: Image, size: number, sx: number, sy: number, sw: number, sh: number, what: string): Uint8Array {
  if (isPixels(image)) {
    const { width, height, data } = image;
    if (sw !== size || sh !== size || sx + size > width || sy + size > height || data.length < width * height * 4)
      throw new RangeError(
        `${what} has ${width} x ${height} raw pixels, which do not hold a ${size} x ${size} tile; pass pixels of the ` +
          'texture size or an image the browser can scale',
      );
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size * 4; x++) out[y * size * 4 + x] = data[((sy + y) * width + sx) * 4 + x];
    return out;
  }
  if (typeof OffscreenCanvas !== 'function')
    throw new MargoError(
      'unsupported',
      `${what} needs OffscreenCanvas to read its pixels; pass {width, height, data} pixels instead`,
    );
  const context = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
  if (!context) throw new MargoError('unsupported', `${what} needs a 2D OffscreenCanvas context to read its pixels`);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
  return new Uint8Array(context.getImageData(0, 0, size, size).data.buffer);
}

function checkSize(size: unknown): number {
  if (typeof size !== 'number') throw new TypeError('BlockTextures size must be a number of texels, such as 16');
  if (!Number.isInteger(size) || size < 1 || size > 4096 || size & (size - 1))
    throw new RangeError(`BlockTextures size ${size} is not a power of two from 1 to 4,096; pass 16, 32 or 64`);
  return size;
}

function checkLayer(layer: unknown): number {
  if (typeof layer !== 'number') throw new TypeError('Block texture layer must be a number from 0 to 255');
  if (!Number.isInteger(layer) || layer < 0 || layer >= MAX_LAYERS)
    throw new RangeError(`Block texture layer ${layer} is not an integer from 0 to 255; pass a layer index`);
  return layer;
}

/**
 * The block textures of a {@link VoxelRenderer}: one `rgba8unorm-srgb` 2D-array texture, a layer per texture index of
 * `BlockTypeOptions.textures`, sampled nearest-neighbour up close and trilinear in the distance. Mips are made once on
 * the CPU per layer (see the README); the renderer creates the GPU texture on its device. Missing layers are white.
 *
 * ```ts
 * const textures = await BlockTextures.load(['stone.png', 'dirt.png', 'grass-top.png']); // layers 0, 1, 2
 * const atlas = BlockTextures.fromAtlas(image, { size: 16 }); // a grid of 16 x 16 tiles, row by row
 * textures.set(1, canvas); // live: the next frame shows it
 * ```
 */
export class BlockTextures {
  /** Width and height of every layer in texels. */
  readonly size: number;

  /**
   * @throws TypeError when an option or image has the wrong type.
   * @throws RangeError for a size that is not a power of two up to 4,096, more than 256 images, or raw pixels of
   * another size.
   * @throws MargoError `unsupported` for an image to scale or draw without OffscreenCanvas (raw pixels work anywhere).
   */
  constructor(options: BlockTexturesOptions = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('BlockTextures options must be an object');
    const images = options.images ?? [];
    if (!Array.isArray(images)) throw new TypeError('BlockTextures images must be an array of images');
    if (images.length > MAX_LAYERS)
      throw new RangeError(`BlockTextures got ${images.length} images; a texture array holds at most 256 layers`);
    this.size = checkSize(options.size ?? (images.length ? dimensions(images[0])[0] : 16));
    states.set(this, { levels: [], dirty: new Set(), disposed: false });
    for (let i = 0; i < images.length; i++) this.#put(i, images[i]);
  }

  /**
   * Fetches one image per URL (layer i from `urls[i]`) and makes the textures from them.
   * @throws TypeError when `urls` is not an array of 1 to 256 URLs (in the promise, like every failure).
   * @throws MargoError `failed` when an image does not load.
   */
  static async load(
    urls: readonly (string | URL)[],
    options: Omit<BlockTexturesOptions, 'images'> = {},
  ): Promise<BlockTextures> {
    if (!Array.isArray(urls) || !urls.length || urls.length > MAX_LAYERS)
      throw new TypeError('BlockTextures.load expects an array of 1 to 256 image URLs');
    const images = await Promise.all(
      urls.map(async (url) => {
        const response = await fetch(url);
        if (!response.ok)
          throw new MargoError('failed', `Block texture ${url} answered HTTP ${response.status}; check the URL`);
        return createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      }),
    );
    try {
      return new BlockTextures({ ...options, images });
    } finally {
      for (const image of images) image.close();
    }
  }

  /**
   * Cuts an atlas into layers: `size` x `size` tiles (default 16) row by row, so the tile at column c and row r of a
   * `columns`-wide atlas is layer `r * columns + c`. Pixels past the last whole tile are ignored.
   * @throws TypeError when `atlas` is not an image or pixels.
   * @throws RangeError for a bad size, an atlas smaller than one tile, or more than 256 tiles.
   * @throws MargoError `unsupported` for an image without OffscreenCanvas (raw pixels work anywhere).
   */
  static fromAtlas(
    atlas: CanvasImageSource | ImageData,
    options: Omit<BlockTexturesOptions, 'images'> = {},
  ): BlockTextures {
    if (!atlas || typeof atlas !== 'object') throw new TypeError('BlockTextures.fromAtlas expects an image or pixels');
    const size = checkSize(options?.size ?? 16),
      [width, height] = dimensions(atlas),
      columns = Math.floor(width / size),
      rows = Math.floor(height / size);
    if (!columns || !rows || columns * rows > MAX_LAYERS)
      throw new RangeError(
        `Atlas of ${width} x ${height} holds ${columns * rows} tiles of ${size} texels; it needs 1 to 256 tiles`,
      );
    const textures = new BlockTextures({ size });
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < columns; c++) textures.#put(r * columns + c, atlas, c * size, r * size, [size, size]);
    return textures;
  }

  /** Number of layers: one past the highest layer given. */
  get layers(): number {
    return Math.max(1, this.#state().levels.length);
  }

  /**
   * Replaces layer `layer` (0-255) with `image`, drawn at `size` x `size`; a layer past the current count adds layers
   * (white up to it). Live: renderers upload it before their next frame.
   * @throws TypeError or RangeError for a bad layer or image (as the constructor).
   * @throws MargoError `disposed` after {@link BlockTextures.dispose}.
   */
  set(layer: number, image: CanvasImageSource | ImageData): void {
    this.#put(checkLayer(layer), image);
  }

  /** Destroys the GPU texture. Renderers still using these textures throw on their next frame. */
  dispose(): void {
    const state = this.#state(false);
    state.disposed = true;
    state.gpu?.texture.destroy();
    state.gpu = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #state(live = true): State {
    const state = states.get(this) as State;
    if (live && state.disposed) throw new MargoError('disposed', 'BlockTextures is disposed; create new BlockTextures');
    return state;
  }

  #put(layer: number, image: Image, sx = 0, sy = 0, region?: [number, number]): void {
    const state = this.#state(),
      what = `Block texture layer ${layer}`;
    if (!image || typeof image !== 'object')
      throw new TypeError(`${what} must be an image, canvas, ImageBitmap or {width, height, data} pixels`);
    const [sw, sh] = region ?? (isPixels(image) ? [image.width, image.height] : dimensions(image)),
      levels = mipChain(read(image, this.size, sx, sy, sw, sh, what), this.size);
    for (let i = state.levels.length; i < layer; i++) {
      state.levels[i] = mipChain(new Uint8Array(this.size * this.size * 4).fill(255), this.size);
      state.dirty.add(i);
    }
    state.levels[layer] = levels;
    state.dirty.add(layer);
  }
}

/**
 * VoxelRenderer's view of `textures` on `device` (2d-array): creates the texture (again after a device change or new
 * layers) and uploads the layers changed since the last call. Not part of the public API.
 * @throws MargoError `disposed` after `textures.dispose()`.
 */
export function blockTextureView(textures: BlockTextures, device: GPUDevice): GPUTextureView {
  const state = states.get(textures) as State;
  if (state.disposed)
    throw new MargoError('disposed', 'VoxelRenderer textures are disposed; pass live BlockTextures to the renderer');
  const layers = textures.layers,
    size = textures.size;
  let gpu = state.gpu;
  if (gpu?.device !== device || gpu.layers !== layers) {
    gpu?.texture.destroy();
    const texture = device.createTexture({
      size: [size, size, layers],
      format: 'rgba8unorm-srgb',
      mipLevelCount: Math.log2(size) + 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    gpu = state.gpu = { device, texture, view: texture.createView({ dimension: '2d-array' }), layers };
    for (let i = 0; i < layers; i++) state.dirty.add(i);
  }
  for (const layer of state.dirty) {
    const levels = state.levels[layer] ?? mipChain(new Uint8Array(size * size * 4).fill(255), size);
    for (let level = 0, n = size; level < levels.length; level++, n >>= 1)
      device.queue.writeTexture(
        { texture: gpu.texture, mipLevel: level, origin: [0, 0, layer] },
        levels[level] as Uint8Array<ArrayBuffer>,
        { bytesPerRow: n * 4, rowsPerImage: n },
        [n, n, 1],
      );
  }
  state.dirty.clear();
  return gpu.view;
}
