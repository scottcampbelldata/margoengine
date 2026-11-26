// Texture, CubeTexture and their loaders, apart from Material so an entry that needs only a texture (video frames,
// mips, toon ramps, soot) does not load the glTF material pipeline (the sizes gate's leak check).
import { compatTier } from '../../shared/compat.js';
import { borrow, lend, relend, type BorrowSlot } from '../../shared/borrowed.js';
/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine } from '@margoengine/core/extension';
import type { EnvironmentMap } from './env-map.js';
import { readResponse } from '../../shared/loading.js';
import { MargoError } from '@margoengine/math/errors';
import {
  convertP3,
  dataGPUFormat,
  equirectToCube,
  gpuDimension,
  unfilterable,
  uploadTranscoded,
  validateData,
  validateTranscoded,
  writeData,
  type CubeTarget,
  type DataFormat,
  type DataImage,
  type TextureDimension,
  type TranscodedTexture,
} from './texture-kinds.js';
import { generateMipmaps } from '../../shared/mipmaps.js';
import { copyExternal } from '../../shared/copy-external.js';
declare const GPUTextureUsage: {
  TEXTURE_BINDING: number;
  COPY_DST: number;
  COPY_SRC: number;
  RENDER_ATTACHMENT: number;
};
/** Raw pixels for `new Texture({ data, width, height })`: tightly packed RGBA8 rows, top row first. */
export type RawImage = { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
/**
 * What `Material.envMap` takes: a cube Texture (CubeTexture), an Environment, a cube render target or a six-layer
 * GPUTexture, or `(device) => one of those`, called once per device and again after a device restore. A plain object
 * (a six-layer GPUTexture, a `{texture, view}` target or an Environment-shaped literal) belongs to the device that made
 * it: after a restore it is dropped, reported once through `engine.onError` (`'state'`, `borrowed-lost`) while the frame
 * keeps drawing, and the material reflects black until `material.envMap = ...` gives it a new one. A Texture, an
 * `@margoengine/environment` Environment and a `CubeCamera` are live objects that remake their own GPU objects, so they
 * need no function.
 */
export type EnvMapSource =
  | Texture
  | EnvironmentMap
  | CubeTarget
  | GPUTexture
  | ((device: GPUDevice) => Texture | EnvironmentMap | CubeTarget | GPUTexture);
/** A browser image a texture or cube face uploads with copyExternalImageToTexture. */
export type ImageSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLVideoElement
  | VideoFrame;
/**
 * A cube map's source (`CubeTexture` builds these): six faces in WebGPU layer order +X, -X, +Y, -Y, +Z, -Z (square,
 * equal sizes, row 0 at the top), or an equirectangular 2D Texture resampled into `size`-texel faces.
 */
export type CubeSource =
  | { faces: readonly (ImageSource | ImageData | RawImage | DataImage)[] }
  | { equirect: Texture; size?: number };
/**
 * ImageData and `{data,width,height}` upload as raw RGBA8 rows (row 0 at UV v=0); other images use
 * copyExternalImageToTexture. A `DataImage` with a `format` or `depth` uploads float, one- or two-channel, 3D or array
 * texels. A GPUTexture (such as `KTX2Decoder.createTexture` output) or a `CubeTarget` is borrowed as is, or
 * `(device) => GPUTexture | CubeTarget` is called once per device and again after a device restore (give `dimension`
 * for a cube, a 3D or an array texture; the size reads 0 until the first device has made it). A plain texture belongs
 * to the device that made it: after a restore it is dropped, reported once through `engine.onError` (`'state'`,
 * `borrowed-lost`), the slot reads its default, and `texture.setSource(...)` gives it a new one. A `TranscodedTexture`
 * (`KTX2Decoder.transcode` output) uploads its compressed mips on each device; a `CubeSource` makes a cube map.
 */
export type TextureSource =
  | ImageSource
  | ImageData
  | RawImage
  | DataImage
  | GPUTexture
  | CubeTarget
  | TranscodedTexture
  | CubeSource
  | ((device: GPUDevice) => GPUTexture | CubeTarget);
/** Texture wrap mode on one axis: `'clamp'` (default, to the edge), `'repeat'` or `'mirror'`. */
export type Wrap = 'repeat' | 'clamp' | 'mirror';
/** How `parallaxMap` is marched: one offset step, stepped occlusion mapping, or relief mapping refined by bisection. */
export type ParallaxMode = 'offset' | 'occlusion' | 'relief';
/** The subsurface approximation: a thick object (light seen through it, wrapped diffuse) or a thin sheet lit from behind. */
export type SubsurfaceMode = 'thick' | 'thin';
/** Texture sampling filter: `'linear'` (default) or `'nearest'`. */
export type Filter = 'linear' | 'nearest';
/** Options for `new Texture(source, options)`; every field is optional and documented with its default. */
export interface TextureOptions {
  /**
   * How colour values are stored: `'srgb'` (decoded on sampling), `'linear'`, or `'display-p3'` (8-bit Display P3
   * pixels, converted once on the GPU to the linear sRGB working space, colours outside sRGB as negative channels).
   * Undefined: the slot's default (sRGB for colour slots).
   */
  colorSpace?: 'srgb' | 'linear' | 'display-p3';
  wrapS?: Wrap;
  wrapT?: Wrap;
  magFilter?: Filter;
  minFilter?: Filter;
  mipmaps?: boolean;
  anisotropy?: number;
  flipY?: boolean;
  /**
   * How the texture is sampled, fixed at construction: `'2d'` (default), `'2d-array'` and `'3d'` for a `DataImage`
   * with `depth` layers or slices, `'cube'` for a six-layer GPUTexture (CubeTexture sets it for its sources).
   */
  dimension?: TextureDimension;
}
/**
 * A pixel rectangle of a texture source, `x` and `y` from its top-left corner (raw data: its first row); for 3D and
 * array data, `z` and `depth` (defaults 0 and 1) pick the slices or layers.
 */
export interface TextureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  z?: number;
  depth?: number;
}
interface Slot {
  texture?: GPUTexture;
  /** A borrowed GPU source on this device: the object `lend` returned and what was made of it. */
  lent?: { from: unknown; texture: GPUTexture; view?: GPUTextureView };
  /** WebGL2 compressed textures cannot reinterpret sRGB: one upload per sampled colour space. */
  transcoded?: Map<string, GPUTexture>;
  /** The mipmaps option the GPU copy was made with. */
  mips?: boolean;
  views: Map<string, GPUTextureView>;
  sampler: GPUSampler;
  /** The sampler options revision and mip setting `sampler` was made with. */
  samplerVersion: number;
  samplerMips: boolean;
  version: number;
  time?: number;
  /** Union [x0, y0, x1, y1] of `update(region)` calls since this up-to-date copy was last uploaded ([x0, y0, z0, x1, y1, z1] for data). */
  region?: number[];
  /** Display P3 only: the linear sRGB rgba16float copy `texture` (the sRGB-decoded staging upload) converts into. */
  p3?: GPUTexture;
  /** Equirect cube only: the source Texture's version the faces were rendered from. */
  source?: number;
  /** `sampler` with repeat on each axis whose wrap is unset, for a triplanar projection, and the sampler it follows. */
  tiled?: GPUSampler;
  tiledFrom?: GPUSampler;
}
/** What a non-image source is, fixed at construction (absent for images and raw RGBA8, the original path). */
type Kind =
  | { type: 'data'; format: DataFormat; dimension: '2d' | '2d-array' | '3d' }
  | {
      type: 'gpu';
      /** The caller's object or function, held by the borrowed-object rule (docs/conventions.md). */
      slot: BorrowSlot<GPUTexture | CubeTarget, TextureSource>;
      /** The last texture made of it, for sizes before and after a restore (undefined until a function has run). */
      texture?: GPUTexture;
      dimension: TextureDimension;
    }
  | { type: 'ktx2'; base: string; dimension: '2d' | '2d-array' | 'cube'; own: boolean }
  | { type: 'faces'; format?: DataFormat }
  | { type: 'equirect'; source: Texture; size: number };
export const wraps = { repeat: 'repeat', clamp: 'clamp-to-edge', mirror: 'mirror-repeat' } as const,
  maxPixels = 16_777_216;
export const optional = (list: readonly unknown[]) => (v: unknown) => v === undefined || list.includes(v);
/** Valid values of each texture option, and how the fix reads when one is not. */
const textureOptions: Record<keyof TextureOptions, [(v: unknown) => boolean, string]> = {
  colorSpace: [
    optional(['srgb', 'linear', 'display-p3']),
    "'srgb', 'linear', 'display-p3' or undefined (the slot's default)",
  ],
  dimension: [optional(['2d', '2d-array', '3d', 'cube']), "'2d', '2d-array', '3d' or 'cube'"],
  wrapS: [optional(['repeat', 'clamp', 'mirror']), "'repeat', 'clamp' or 'mirror'"],
  wrapT: [optional(['repeat', 'clamp', 'mirror']), "'repeat', 'clamp' or 'mirror'"],
  magFilter: [optional(['linear', 'nearest']), "'linear' or 'nearest'"],
  minFilter: [optional(['linear', 'nearest']), "'linear' or 'nearest'"],
  mipmaps: [optional([true, false]), 'true or false'],
  anisotropy: [
    (v) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16),
    'an integer 1 through 16',
  ],
  flipY: [optional([true, false]), 'true or false'],
};
export const shared = new WeakMap<
  GPUDevice,
  {
    white: GPUTextureView;
    normal: GPUTextureView;
    anisotropy?: GPUTextureView;
    black?: GPUTextureView;
    sampler: GPUSampler;
    pipelines: Map<unknown, unknown>;
  }
>();
export function defaults(device: GPUDevice) {
  let d = shared.get(device);
  if (d) return d;
  const pixel = (rgba: number[], format: 'rgba8unorm' | 'rgba16float' = 'rgba8unorm') => {
    const data = format === 'rgba16float' ? new Uint16Array(rgba) : new Uint8Array(rgba);
    const texture = device.createTexture({
      size: [1, 1],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, data, { bytesPerRow: data.byteLength }, [1, 1]);
    return texture.createView();
  };
  d = {
    white: pixel([255, 255, 255, 255]),
    // Binary16 stores 0.5 exactly, so an absent normal map cannot tilt the surface.
    normal: pixel([0x3800, 0x3800, 0x3c00, 0x3c00], 'rgba16float'),
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    pipelines: new Map(),
  };
  shared.set(device, d);
  return d;
}
export function fallback(device: GPUDevice, role: number): readonly [GPUTextureView, GPUSampler] {
  const d = defaults(device);
  if (role === 2 && !d.anisotropy) {
    const texture = device.createTexture({
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      new Uint16Array([0x3c00, 0x3800, 0x3c00, 0x3c00]),
      { bytesPerRow: 8 },
      [1, 1],
    );
    d.anisotropy = texture.createView();
  }
  // Black: a displacement or light map still loading displaces and lights nothing.
  if (role === 3 && !d.black) {
    const texture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
    d.black = texture.createView();
  }
  return [role === 3 ? d.black! : role === 2 ? d.anisotropy! : role === 1 ? d.normal : d.white, d.sampler];
}
interface ImageDimensions {
  videoWidth?: number;
  videoHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
}
const dimensions = (s: ImageDimensions): [number, number] => [
  s.videoWidth ?? s.displayWidth ?? s.naturalWidth ?? s.width ?? 0,
  s.videoHeight ?? s.displayHeight ?? s.naturalHeight ?? s.height ?? 0,
];
const raw = (s: unknown): s is RawImage =>
  !!s && typeof s === 'object' && 'data' in s && (s.data instanceof Uint8Array || s.data instanceof Uint8ClampedArray);
/**
 * Checks raw RGBA8 pixels, one condition per message (KB-MATERIALS-TEXCAP1): whole positive sizes, then the data
 * length. The size a GPU can hold is checked against the device's own maxTextureDimension2D at upload.
 */
function rawCheck({ width: w, height: h, data }: RawImage): void {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1)
    throw new RangeError(`Raw texture width and height must be whole numbers of 1 or more; got ${w} x ${h}`);
  if (data.length < w * h * 4)
    throw new RangeError(
      `Raw texture data is ${data.length} bytes; RGBA8 at ${w} x ${h} needs width * height * 4 = ${w * h * 4} bytes`,
    );
}
/** The device-limit refusal, naming the size and the limit. */
const tooLarge = (w: number, h: number, limit: number) =>
  new RangeError(
    `Texture is ${w} x ${h} pixels; this device allows ${limit} per side (maxTextureDimension2D); resize it to fit`,
  );
const borrowedSource = (source: TextureSource) =>
  borrow<GPUTexture | CubeTarget, TextureSource>(source, 'Texture source', 'texture.setSource(...)');
export const gpuTexture = (s: unknown): s is GPUTexture =>
  !!s &&
  typeof (s as GPUTexture).createView === 'function' &&
  typeof (s as GPUTexture).mipLevelCount === 'number' &&
  typeof (s as GPUTexture).depthOrArrayLayers === 'number';
/** The kind of a non-image `source` (validated), or undefined for images and raw RGBA8 data (the original path). */
function kindOf(source: TextureSource, o: TextureOptions): Kind | undefined {
  const s = source as Partial<DataImage & CubeTarget & TranscodedTexture> & {
    faces?: unknown;
    equirect?: unknown;
    size?: number;
  };
  if (typeof source === 'function')
    return { type: 'gpu', slot: borrowedSource(source), dimension: o.dimension ?? '2d' };
  if (gpuTexture(source))
    return { type: 'gpu', slot: borrowedSource(source), texture: source, dimension: gpuDimension(source, o.dimension) };
  if (gpuTexture(s.texture) && s.view) {
    if (o.dimension !== undefined && o.dimension !== 'cube')
      throw new TypeError("Texture CubeTarget is a cube; omit dimension or pass 'cube'");
    if (s.texture.depthOrArrayLayers !== 6) throw new TypeError('Texture CubeTarget texture must have six layers');
    return { type: 'gpu', slot: borrowedSource(source), texture: s.texture, dimension: 'cube' };
  }
  if (Array.isArray(s.mipmaps) && typeof s.target === 'string') {
    const result = source as TranscodedTexture,
      own = typeof result.upload === 'function',
      dimension = (own ? (result.dimension ?? '2d') : '2d') as '2d' | '2d-array' | 'cube';
    if ((dimension as string) === 'cube-array')
      throw new TypeError(
        'Texture KTX2 cube arrays have no material slot; use KTX2LayerDecoder.createTexture and a view of your own',
      );
    if (o.dimension !== undefined && o.dimension !== dimension)
      throw new TypeError(`Texture KTX2 result is ${dimension}; omit dimension or pass '${dimension}'`);
    return { type: 'ktx2', base: own ? result.format : validateTranscoded(result), dimension, own };
  }
  if (Array.isArray(s.faces)) {
    const faces = s.faces as unknown[],
      format = (faces[0] as Partial<DataImage> | undefined)?.format;
    if (faces.length !== 6 || faces.some((f) => !f || typeof f !== 'object'))
      throw new TypeError('Texture cube faces must be six images in the order +X, -X, +Y, -Y, +Z, -Z; pass six');
    if (o.dimension !== undefined && o.dimension !== 'cube')
      throw new TypeError("Texture cube faces make a cube; omit dimension or pass 'cube'");
    for (const face of faces as DataImage[])
      if ('data' in face && (face.format !== undefined || !raw(face))) validateData(face, '2d');
      else if (raw(face)) rawCheck(face);
    const sizes = faces.map((f) => dimensions(f as ImageDimensions));
    if (sizes.some(([w, h]) => w !== sizes[0][0] || h !== sizes[0][1] || (w && w !== h)))
      throw new RangeError('Texture cube faces must be square and the same size; resize them to one edge length');
    if (faces.some((f) => ((f as DataImage).format ?? 'rgba8unorm') !== (format ?? 'rgba8unorm')))
      throw new TypeError('Texture cube faces must share one format; convert them to the same one');
    return { type: 'faces', ...(format && format !== 'rgba8unorm' ? { format } : {}) };
  }
  if (s.equirect !== undefined) {
    if (!(s.equirect instanceof Texture) || s.equirect.dimension !== '2d')
      throw new TypeError('Texture equirect source must be a 2D Texture; pass new Texture(image)');
    if (o.dimension !== undefined && o.dimension !== 'cube')
      throw new TypeError("Texture equirect source makes a cube; omit dimension or pass 'cube'");
    const size = s.size ?? 2 ** Math.max(4, Math.round(Math.log2(Math.max(1, s.equirect.width / 4))));
    if (!Number.isSafeInteger(size) || size < 1 || size > 8192)
      throw new RangeError('Texture equirect cube size must be an integer from 1 through 8192; pass a face edge');
    return { type: 'equirect', source: s.equirect, size };
  }
  const data = s as DataImage,
    bytes = raw(source);
  // Plain RGBA8 2D data keeps the original raw path; any other format, depth or dimension is a data texture.
  if (
    'data' in data &&
    (!bytes ||
      (data.format ?? 'rgba8unorm') !== 'rgba8unorm' ||
      (data.depth ?? 1) !== 1 ||
      (o.dimension ?? '2d') !== '2d')
  ) {
    const dimension = o.dimension ?? ((data.depth ?? 1) > 1 ? undefined : '2d');
    if (dimension === undefined)
      throw new TypeError("Texture data with depth > 1 needs dimension '2d-array' or '3d'; set the dimension option");
    const { format } = validateData(data, dimension);
    return { type: 'data', format, dimension: dimension as '2d' | '2d-array' | '3d' };
  }
  if (o.dimension !== undefined && o.dimension !== '2d')
    throw new TypeError(`Texture dimension '${o.dimension}' needs a DataImage, GPUTexture or cube source; omit it`);
  return undefined;
}
/** Why option `key` set to `v` does not suit a texture of `kind`, or undefined when it does. */
function kindOption(kind: Kind | undefined, key: keyof TextureOptions, v: unknown): string | undefined {
  if (key === 'colorSpace' && v === 'display-p3' && kind)
    return "Texture colorSpace 'display-p3' needs an 8-bit RGBA image or raw RGBA8 data; convert other data to linear sRGB with @margoengine/math linearP3ToLinearSRGB";
  if (key === 'colorSpace' && v !== undefined && kind?.type === 'ktx2' && kind.own)
    return "Texture colorSpace of a KTX2LayerDecoder file comes from the file's format; omit colorSpace";
  if (key === 'colorSpace' && v === 'srgb') {
    const format = kind?.type === 'data' || kind?.type === 'faces' ? kind.format : undefined;
    if (format && format !== 'rgba8unorm')
      return `Texture colorSpace 'srgb' needs 8-bit RGBA texels, not ${format}; store linear values or use rgba8unorm`;
  }
  if (key === 'colorSpace' && v !== undefined && (kind?.type === 'gpu' || kind?.type === 'equirect'))
    return kind.type === 'gpu'
      ? 'Texture colorSpace does not apply to a borrowed GPUTexture; its own format decides, so omit colorSpace'
      : 'Texture colorSpace of an equirect cube comes from its source Texture; set it there';
  if (key === 'mipmaps' && v === true && kind?.type === 'data' && kind.dimension === '3d')
    return 'Texture mipmaps are not generated for 3D data; set mipmaps: false';
  if (
    key === 'mipmaps' &&
    v === true &&
    (kind?.type === 'data' || kind?.type === 'faces') &&
    unfilterable(kind.format ?? '')
  )
    return `Texture mipmaps are not generated for ${kind.format} texels; use a 16-bit float format or mipmaps: false`;
  return undefined;
}
/** Floats `liveStamp` watches: colour (4), emissive (3), specular (3), factors (4), settings (4). */
export const liveFloats = 18;
/**
 * Change stamps shared by textures and materials: each change takes the next number, so the largest stamp of a
 * material and the textures it binds grows whenever any of them changes (`MaterialShading.version`).
 */
let stamps = 0;
export const changeStamp = (): number => ++stamps;
// The textures with a GPU copy on each device, told once when it is lost. Made outside any texture's scope, so the
// reaction holds only the device and this set, which a texture leaves on dispose: one reaction per texture and device
// kept every disposed texture alive as long as the device (docs/known-bugs.md).
const lostTextures = new WeakMap<GPUDevice, Set<Texture>>();
/** The engine each device belongs to, noted when its materials bind: where a lost borrowed object is reported. */
const engines = new WeakMap<GPUDevice, Engine>();
/** @internal Notes `engine` as the owner of its current device, for `engine.onError` reports from textures. */
export function noteEngine(engine: Engine): void {
  if (engine.gpu) engines.set(engine.gpu, engine);
}
function watchTextureLost(device: GPUDevice, texture: Texture): void {
  let set = lostTextures.get(device);
  if (!set) {
    const watching = (set = new Set());
    lostTextures.set(device, watching);
    void device.lost?.then(() => {
      for (const t of watching) t['slots'].delete(device);
      watching.clear();
    });
  }
  set.add(texture);
}
/** A shareable texture. GPU copies are made lazily per device; video sources re-upload whenever `currentTime` changes, other sources on `update()`. */
export class Texture {
  private version = 0;
  private samplerVersion = 0;
  /** The stamp (`changeStamp`) of this texture's last `update()`, option change or `dispose()`. */
  private stamp = changeStamp();
  /** A flipY, colorSpace or mipmaps change makes the next `update()` a full one. */
  private reshaped = false;
  private readonly slots = new Map<GPUDevice, Slot>();
  /** What a non-image source is (undefined for images and raw RGBA8 data). */
  private readonly kind?: Kind;
  /** The options in effect (a copy of the constructor's); the accessors below change them. */
  readonly options: TextureOptions;
  constructor(
    readonly source: TextureSource,
    options: TextureOptions = {},
    protected readonly owned = false,
  ) {
    const o = options;
    if (
      !source ||
      (typeof source !== 'object' && typeof source !== 'function') ||
      !(Object.keys(textureOptions) as (keyof TextureOptions)[]).every((k) => textureOptions[k][0](o[k]))
    )
      throw new TypeError(
        'Texture needs an image, canvas, video or {data, width, height} source and valid options; check TextureOptions.',
      );
    this.options = { ...o };
    this.kind = kindOf(source, o);
    for (const key of Object.keys(o) as (keyof TextureOptions)[]) {
      const problem = kindOption(this.kind, key, o[key]);
      if (problem) throw new TypeError(problem);
    }
    if (!this.kind && raw(source)) rawCheck(source);
  }
  /** Width, height and depth (layers or slices; 6 for a cube) of the current source. */
  private size(): [number, number, number] {
    const k = this.kind,
      s = this.source as DataImage & CubeTarget & { faces: ImageDimensions[] };
    if (!k) return [...dimensions(s as ImageDimensions), 1];
    if (k.type === 'gpu') return [k.texture?.width ?? 0, k.texture?.height ?? 0, k.texture?.depthOrArrayLayers ?? 0];
    if (k.type === 'faces') return [...dimensions(s.faces[0]), 6];
    if (k.type === 'equirect') return [k.size, k.size, 6];
    if (k.type === 'ktx2') return [s.width, s.height, (s as unknown as TranscodedTexture).layers ?? 1];
    return [s.width, s.height, k.type === 'data' ? (s.depth ?? 1) : 1];
  }
  get width(): number {
    return this.kind ? this.size()[0] : dimensions(this.source as ImageDimensions)[0];
  }
  get height(): number {
    return this.kind ? this.size()[1] : dimensions(this.source as ImageDimensions)[1];
  }
  /** Layers of a `'2d-array'` texture, slices of a `'3d'` one, 6 for a cube, else 1. */
  get depth(): number {
    return this.size()[2];
  }
  /** How shaders sample it (`'2d'` unless constructed as an array, 3D or cube texture). */
  get dimension(): TextureDimension {
    const k = this.kind;
    return !k ? '2d' : k.type === 'faces' || k.type === 'equirect' ? 'cube' : k.dimension;
  }
  /** @internal True for 32-bit float texels, which filter only on devices with the `float32-filterable` feature. */
  get unfilterable(): boolean {
    const k = this.kind;
    return k?.type === 'data' || k?.type === 'faces'
      ? unfilterable(k.format ?? '')
      : k?.type === 'ktx2'
        ? unfilterable(k.base)
        : k?.type === 'gpu' && !!k.texture && unfilterable(k.texture.format);
  }
  get isVideo(): boolean {
    return typeof (this.source as HTMLVideoElement).videoWidth === 'number';
  }
  /** Sampler options, live: a change takes effect on the next frame (the sampler is rebuilt on next use). */
  get magFilter(): Filter {
    return this.options.magFilter ?? 'linear';
  }
  set magFilter(v: Filter) {
    this.setOption('magFilter', v);
  }
  get minFilter(): Filter {
    return this.options.minFilter ?? 'linear';
  }
  set minFilter(v: Filter) {
    this.setOption('minFilter', v);
  }
  get wrapS(): Wrap {
    return this.options.wrapS ?? 'clamp';
  }
  set wrapS(v: Wrap) {
    this.setOption('wrapS', v);
  }
  get wrapT(): Wrap {
    return this.options.wrapT ?? 'clamp';
  }
  set wrapT(v: Wrap) {
    this.setOption('wrapT', v);
  }
  /** Used with linear filters and mipmaps only. */
  get anisotropy(): number {
    return this.options.anisotropy ?? 1;
  }
  set anisotropy(v: number) {
    this.setOption('anisotropy', v);
  }
  /** Upload options: a change takes effect on the next `update()`, which then uploads the whole source. */
  get flipY(): boolean {
    return this.options.flipY ?? this.kind?.type !== 'faces';
  }
  set flipY(v: boolean) {
    this.setOption('flipY', v);
  }
  /**
   * Undefined: sRGB for colour slots (map, emissive, sheen and specular colour), linear for the others.
   * `'display-p3'` converts 8-bit Display P3 pixels to the linear sRGB working space.
   */
  get colorSpace(): 'srgb' | 'linear' | 'display-p3' | undefined {
    return this.options.colorSpace;
  }
  set colorSpace(v: 'srgb' | 'linear' | 'display-p3' | undefined) {
    this.setOption('colorSpace', v);
  }
  /** Default: true for images and cubes, false for videos and data; a GPUTexture or KTX2 file keeps its own levels. */
  get mipmaps(): boolean {
    const k = this.kind;
    if (k?.type === 'gpu') return !!k.texture && k.texture.mipLevelCount > 1;
    if (k?.type === 'ktx2') return (this.source as TranscodedTexture).mipmaps.length > 1;
    if (k?.type === 'faces' && unfilterable(k.format ?? '')) return this.options.mipmaps ?? false;
    return this.options.mipmaps ?? (k ? k.type !== 'data' : !this.isVideo);
  }
  set mipmaps(v: boolean) {
    this.setOption('mipmaps', v);
  }
  private setOption<K extends keyof TextureOptions>(key: K, v: TextureOptions[K]): void {
    const [valid, fix] = textureOptions[key];
    if (key === 'dimension') throw new TypeError('Texture dimension is fixed at construction; create a new Texture');
    if (!valid(v))
      throw new (key === 'anisotropy' && typeof v === 'number' ? RangeError : TypeError)(
        'Texture ' + key + ' is invalid; set ' + fix,
      );
    const problem = kindOption(this.kind, key, v);
    if (problem) throw new TypeError(problem);
    this.options[key] = v;
    this.stamp = changeStamp();
    if (key === 'flipY' || key === 'colorSpace' || key === 'mipmaps') this.reshaped = true;
    else this.samplerVersion++;
  }
  /**
   * Re-upload on next use (canvas, raw data or VideoFrame contents changed). With `region`, only that rectangle of the
   * current source uploads, into the same texture rows the full upload uses (flipped for `flipY` external sources;
   * raw data and ImageData rows are never flipped) and in the same colour space; regions updated between two uses
   * upload as their bounding rectangle. Without mipmaps nothing else is touched. With mipmaps the whole chain
   * regenerates from level 0: one GPU draw per level, about a third of a full-texture fill, whereas regenerating only
   * the affected texels needs per-level rounding (odd sizes shift the 2x2 footprint) for little gain.
   */
  update(region?: TextureRegion): void {
    this.stamp = changeStamp();
    if (region === undefined || this.reshaped) {
      this.version++;
      this.reshaped = false;
      return;
    }
    if (!region || typeof region !== 'object')
      throw new TypeError('Texture update region must be an object; pass {x, y, width, height} or nothing');
    if (this.kind) return this.updateData(region);
    const { x, y, width, height } = region,
      [w, h] = dimensions(this.source as ImageDimensions);
    if (
      ![x, y, width, height].every(Number.isSafeInteger) ||
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > w ||
      y + height > h
    )
      throw new RangeError(
        `Texture update region must be whole pixels inside the ${w}x${h} source; pass integers with width, height >= 1`,
      );
    // Out-of-date copies upload everything anyway.
    for (const slot of this.slots.values())
      if (slot.version === this.version) {
        const r = (slot.region ??= [x, y, x + width, y + height]);
        r.splice(0, 4, Math.min(r[0], x), Math.min(r[1], y), Math.max(r[2], x + width), Math.max(r[3], y + height));
      }
  }
  /** `update(region)` of a data texture: a box of texels (and layers or slices) uploads on next use. */
  private updateData(region: TextureRegion): void {
    if (this.kind?.type !== 'data')
      throw new TypeError(
        'Texture update region needs an image or data source; call update() without a region to upload it all',
      );
    const { x, y, width, height, z = 0, depth = 1 } = region,
      [w, h, d] = this.size();
    if (
      ![x, y, z, width, height, depth].every(Number.isSafeInteger) ||
      x < 0 ||
      y < 0 ||
      z < 0 ||
      width < 1 ||
      height < 1 ||
      depth < 1 ||
      x + width > w ||
      y + height > h ||
      z + depth > d
    )
      throw new RangeError(
        `Texture update region must be whole texels inside the ${w}x${h}x${d} data; pass integers with width, height, depth >= 1`,
      );
    for (const slot of this.slots.values())
      if (slot.version === this.version) {
        const r = (slot.region ??= [x, y, z, x + width, y + height, z + depth]);
        r.splice(
          0,
          6,
          Math.min(r[0], x),
          Math.min(r[1], y),
          Math.min(r[2], z),
          Math.max(r[3], x + width),
          Math.max(r[4], y + height),
          Math.max(r[5], z + depth),
        );
      }
  }
  /**
   * Frees GPU copies and closes an ImageBitmap created by `loadTexture`. A later use of a still-open source uploads
   * again. A borrowed GPUTexture or CubeTarget stays its owner's.
   */
  dispose(): void {
    this.stamp = changeStamp();
    for (const [device, slot] of this.slots) {
      lostTextures.get(device)?.delete(this);
      if (slot.transcoded) for (const texture of slot.transcoded.values()) texture.destroy();
      else slot.texture?.destroy();
      slot.p3?.destroy();
    }
    this.slots.clear();
    if (this.owned) {
      const s = this.source as { faces?: ImageBitmap[]; close?: () => void };
      if (s.faces) for (const face of s.faces) face.close();
      else s.close?.();
    }
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @internal The GPU copy on `device` after a `bind` (the borrowed texture for a GPUTexture source). */
  gpuTexture(device: GPUDevice): GPUTexture | undefined {
    return this.kind?.type === 'gpu'
      ? this.slots.get(device)?.lent?.texture
      : (this.slots.get(device)?.p3 ?? this.slots.get(device)?.texture);
  }
  /** The per-device slot, made on first use, with its sampler rebuilt after a sampler option or mip chain change. */
  private slotFor(device: GPUDevice, mips: boolean): Slot {
    let slot = this.slots.get(device);
    if (!slot) {
      slot = {
        views: new Map(),
        version: -1,
        sampler: this.sampler(device, mips),
        samplerVersion: this.samplerVersion,
        samplerMips: mips,
      };
      this.slots.set(device, slot);
      watchTextureLost(device, this);
    }
    if (slot.samplerVersion !== this.samplerVersion || slot.samplerMips !== mips) {
      slot.sampler = this.sampler(device, mips);
      slot.samplerVersion = this.samplerVersion;
      slot.samplerMips = mips;
    }
    return slot;
  }
  /** A view of `texture` (cached in `slot` by format and dimension). */
  private viewOf(slot: Slot, texture: GPUTexture, format: GPUTextureFormat, dimension: TextureDimension) {
    const key = format + ':' + dimension;
    let view = slot.views.get(key);
    if (!view) slot.views.set(key, (view = texture.createView({ format, dimension })));
    return view;
  }
  /** Checks what a borrowed source made on a device (the object or `{texture, view}`) against this texture's dimension. */
  private lentOf(k: Extract<Kind, { type: 'gpu' }>, made: GPUTexture | CubeTarget): NonNullable<Slot['lent']> {
    if (gpuTexture(made)) {
      gpuDimension(made, k.dimension);
      return { from: made, texture: made };
    }
    const target = made as CubeTarget;
    if (!gpuTexture(target?.texture) || !target.view)
      throw new TypeError('Texture source function must return a GPUTexture or a {texture, view} target');
    if (k.dimension !== 'cube')
      throw new TypeError("Texture source function returned a cube target; pass dimension: 'cube'");
    if (target.texture.depthOrArrayLayers !== 6) throw new TypeError('Texture CubeTarget texture must have six layers');
    return { from: made, texture: target.texture, view: target.view };
  }
  /**
   * Gives a GPUTexture or CubeTarget source (or a function making one) a new object: the way back after a device
   * restore dropped a plain one (`'state'` report, `borrowed-lost`). The dimension stays what the texture was made with.
   */
  setSource(source: GPUTexture | CubeTarget | ((device: GPUDevice) => GPUTexture | CubeTarget)): void {
    const k = this.kind;
    if (k?.type !== 'gpu')
      throw new TypeError(
        'Texture setSource needs a texture made from a GPUTexture, a CubeTarget or a function; create a new Texture',
      );
    if (typeof source !== 'function') {
      const own = kindOf(source, { dimension: k.dimension });
      if (own?.type !== 'gpu') throw new TypeError('Texture setSource needs a GPUTexture or a {texture, view} target');
      k.texture = own.texture;
    }
    relend(k.slot, source);
    (this as { source: TextureSource }).source = source;
    this.slots.clear();
    this.stamp = changeStamp();
    this.samplerVersion++;
  }
  /** `bind` for data, borrowed, KTX2 and cube sources. */
  private bindKind(device: GPUDevice, srgb: boolean): [GPUTextureView, GPUSampler] | undefined {
    const k = this.kind!,
      o = this.options,
      [w, h, d] = this.size();
    if (k.type === 'gpu') {
      const made = lend(k.slot, device, engines.get(device)) as GPUTexture | CubeTarget | undefined;
      if (!made) return undefined;
      let slot = this.slots.get(device);
      if (slot?.lent?.from !== made) {
        // No float32-filterable check here: a WgslMaterial reads 32-bit float texels with textureLoad, which needs no
        // filtering (KB-DEPTHTEX-BLACK1). The filtered users (material map slots, envMap) check after they bind.
        const lent = this.lentOf(k, made);
        slot = this.slotFor(device, lent.texture.mipLevelCount > 1);
        slot.lent = lent;
        slot.views.clear();
        k.texture = lent.texture;
      }
      const { texture, view } = slot!.lent!;
      return [view ?? this.viewOf(slot!, texture, texture.format, k.dimension), slot!.sampler];
    }
    const levels = Math.floor(Math.log2(Math.max(w, h, 1))) + 1,
      mips = this.mipmaps,
      // The sampler follows the mip chain of the GPU copy in use until a new one replaces it.
      slot = this.slotFor(device, this.slots.get(device)?.mips ?? mips),
      sRGB = o.colorSpace ? o.colorSpace === 'srgb' : srgb,
      refit = () => {
        if (slot.samplerMips !== slot.mips) {
          slot.sampler = this.sampler(device, slot.mips!);
          slot.samplerMips = slot.mips!;
        }
      };
    if (k.type === 'ktx2') {
      const separate = !k.own && k.base !== 'rgba8unorm' && k.base !== 'rgba16float' && compatTier(device) === 'webgl2';
      const format = (sRGB && !k.own && k.base !== 'rgba16float' ? k.base + '-srgb' : k.base) as GPUTextureFormat;
      if (!slot.texture || slot.version !== this.version) {
        if (slot.transcoded) for (const texture of slot.transcoded.values()) texture.destroy();
        else slot.texture?.destroy();
        const file = this.source as TranscodedTexture;
        slot.texture = k.own ? file.upload!(device) : uploadTranscoded(device, file, k.base, separate && sRGB);
        slot.transcoded = separate ? new Map([[format, slot.texture]]) : undefined;
        slot.mips = mips;
        slot.views.clear();
        slot.version = this.version;
        refit();
      }
      let texture = slot.texture;
      if (slot.transcoded) {
        texture = slot.transcoded.get(format)!;
        if (!texture) {
          texture = uploadTranscoded(device, this.source as TranscodedTexture, k.base, sRGB);
          slot.transcoded.set(format, texture);
        }
      }
      return [this.viewOf(slot, texture, format, k.dimension), slot.sampler];
    }
    if (k.type === 'equirect') {
      const source = k.source.sampled(device, true, 'equirect source');
      if (!source)
        return slot.texture ? [this.viewOf(slot, slot.texture, slot.texture.format, 'cube'), slot.sampler] : undefined;
      let t = slot.texture;
      if (!t || slot.mips !== mips) {
        t?.destroy();
        t = slot.texture = device.createTexture({
          size: [k.size, k.size, 6],
          format: 'rgba16float',
          mipLevelCount: mips ? levels : 1,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        slot.mips = mips;
        slot.views.clear();
        slot.version = -1;
        refit();
      }
      if (slot.version !== this.version || slot.source !== k.source.version) {
        // An image uploaded with flipY has its top row at v = 1; raw data and unflipped images keep it at v = 0.
        const flipped = !k.source.kind && !raw(k.source.source) && k.source.flipY;
        equirectToCube(device, source[0], source[1], k.source.width, t, flipped);
        mipmaps(device, t);
        slot.version = this.version;
        slot.source = k.source.version;
      }
      return [this.viewOf(slot, t, t.format, 'cube'), slot.sampler];
    }
    const faces = k.type === 'faces' ? ((this.source as { faces: TextureSource[] }).faces as ImageDimensions[]) : [],
      ready = faces.every((f) => {
        const [fw, fh] = dimensions(f);
        return fw && fh && !('readyState' in f && (f as HTMLVideoElement).readyState < 2);
      });
    if (!w || !h || !ready) return slot.texture ? [this.view3(slot, sRGB, k), slot.sampler] : undefined;
    const format = k.format ?? 'rgba8unorm',
      dimension: TextureDimension = k.type === 'faces' ? 'cube' : k.dimension,
      limit = dimension === '3d' ? device.limits.maxTextureDimension3D : device.limits.maxTextureDimension2D;
    if (w > limit || h > limit) throw tooLarge(w, h, limit);
    if (dimension === '3d' ? d > limit : d > device.limits.maxTextureArrayLayers)
      throw new RangeError(
        `Texture has ${d} ${dimension === '3d' ? 'slices' : 'layers'}; this device allows ${dimension === '3d' ? limit : device.limits.maxTextureArrayLayers}`,
      );
    let t = slot.texture;
    const pending = slot.version !== this.version;
    if (
      !t ||
      t.width !== w ||
      t.height !== h ||
      t.depthOrArrayLayers !== d ||
      (pending &&
        (slot.mips !== mips ||
          (format === 'rgba8unorm' && o.colorSpace !== undefined && t.format !== dataGPUFormat(format, sRGB))))
    ) {
      t?.destroy();
      const count = mips && dimension !== '3d' ? levels : 1;
      t = slot.texture = device.createTexture({
        size: [w, h, d],
        dimension: dimension === '3d' ? '3d' : '2d',
        format: dataGPUFormat(format, sRGB),
        ...(format === 'rgba8unorm' ? { viewFormats: [dataGPUFormat(format, !sRGB)] } : {}),
        mipLevelCount: count,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          (count > 1 || k.type === 'faces' ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
      });
      slot.mips = mips;
      slot.views.clear();
      slot.version = -1;
      refit();
    }
    if (slot.version !== this.version || slot.region) {
      if (k.type === 'faces')
        faces.forEach((face, layer) => {
          if ('data' in face) writeData(device, t, face as DataImage, format, undefined, layer);
          else
            device.queue.copyExternalImageToTexture(
              { source: face as ImageSource, flipY: o.flipY ?? false },
              { texture: t, origin: [0, 0, layer] },
              [w, h],
            );
        });
      else
        writeData(device, t, this.source as DataImage, format, slot.version === this.version ? slot.region : undefined);
      slot.version = this.version;
      slot.region = undefined;
      mipmaps(device, t);
    }
    return [this.view3(slot, sRGB, k), slot.sampler];
  }
  /** The data or faces view: an 8-bit RGBA copy decodes sRGB per colour space, other formats read as stored. */
  private view3(slot: Slot, srgb: boolean, k: Kind): GPUTextureView {
    const t = slot.texture!,
      format = (k as { format?: DataFormat }).format ?? 'rgba8unorm';
    return this.viewOf(
      slot,
      t,
      format === 'rgba8unorm' && !this.options.colorSpace ? dataGPUFormat(format, srgb) : t.format,
      k.type === 'faces' ? 'cube' : (k as { dimension: TextureDimension }).dimension,
    );
  }
  /**
   * @internal `bind` for a material map slot, which samples a filtered 2D texture: a 3D, array or cube texture, or
   * 32-bit float texels on a device without `float32-filterable`, throws instead of failing WebGPU validation.
   */
  sampled(device: GPUDevice, srgb: boolean, slot: string, tile = false): [GPUTextureView, GPUSampler] | undefined {
    if (this.dimension !== '2d')
      throw new TypeError(
        `Material ${slot} needs a 2D Texture, not a ${this.dimension} one; sample it from a WgslMaterial texture instead`,
      );
    // After the bind: a borrowed texture made by a function has no format until its first bind.
    const pair = this.bind(device, srgb),
      o = this.options;
    if (this.unfilterable && !device.features.has('float32-filterable'))
      throw new MargoError(
        'unsupported',
        `Material ${slot} samples 32-bit float texels, which needs the device feature float32-filterable; request it in Engine.create features or use a 16-bit float format`,
      );
    if (!pair || !tile || (o.wrapS && o.wrapT)) return pair;
    // A triplanar projection reads the map at the world position times the scale, far past [0, 1]: an unset wrap
    // repeats there, as the projection means (the default clamp smeared the edge texels into streaks, KB-TRIPLANAR-SIDES1).
    const held = this.slots.get(device)!;
    if (held.tiledFrom !== pair[1]) {
      held.tiled = this.sampler(device, held.samplerMips, true);
      held.tiledFrom = pair[1];
    }
    return [pair[0], held.tiled!];
  }
  /**
   * @internal A stamp that stays the same while `bind(device, srgb)` would return the same view and sampler as last
   * time without uploading anything (`MaterialShading.version`); NaN while that is not known: no GPU copy on `device`
   * yet, a pending upload, region or sampler rebuild, a source whose size no longer matches its copy, a video, or a cube
   * made from faces or an equirect source.
   */
  steady(device: GPUDevice): number {
    const k = this.kind,
      slot = this.slots.get(device),
      t = slot?.texture;
    if (!slot || slot.samplerVersion !== this.samplerVersion) return Number.NaN;
    if (k?.type === 'gpu')
      return slot.lent && slot.samplerMips === slot.lent.texture.mipLevelCount > 1 ? this.stamp : Number.NaN;
    if (
      !t ||
      slot.version !== this.version ||
      slot.region ||
      slot.samplerMips !== slot.mips ||
      k?.type === 'faces' ||
      k?.type === 'equirect' ||
      this.isVideo
    )
      return Number.NaN;
    if (k?.type === 'ktx2') return this.stamp;
    if (!k) {
      // `dimensions` without its array: this runs for every map of every steady material each frame.
      const s = this.source as ImageDimensions;
      return (s.videoWidth ?? s.displayWidth ?? s.naturalWidth ?? s.width ?? 0) === t.width &&
        (s.videoHeight ?? s.displayHeight ?? s.naturalHeight ?? s.height ?? 0) === t.height
        ? this.stamp
        : Number.NaN;
    }
    const [w, h, d] = this.size();
    return w === t.width && h === t.height && d === t.depthOrArrayLayers ? this.stamp : Number.NaN;
  }
  /** @internal View and sampler for a material slot, or undefined while the source has no pixels (unloaded image or video). */
  bind(device: GPUDevice, srgb: boolean): [GPUTextureView, GPUSampler] | undefined {
    if (this.kind) return this.bindKind(device, srgb);
    const s = this.source as ImageSource | ImageData | RawImage,
      o = this.options,
      [w, h] = dimensions(s),
      video = this.isVideo,
      p3 = o.colorSpace === 'display-p3';
    let slot = this.slots.get(device);
    if (!slot) {
      const mips = o.mipmaps ?? !video;
      slot = {
        views: new Map(),
        version: -1,
        sampler: this.sampler(device, mips),
        samplerVersion: this.samplerVersion,
        samplerMips: mips,
      };
      this.slots.set(device, slot);
      watchTextureLost(device, this);
    }
    // Rebuilt lazily: after a sampler option changed, or once the GPU copy's mip chain changed with `update()`.
    const mips = slot.mips ?? o.mipmaps ?? !video;
    if (slot.samplerVersion !== this.samplerVersion || slot.samplerMips !== mips) {
      slot.sampler = this.sampler(device, mips);
      slot.samplerVersion = this.samplerVersion;
      slot.samplerMips = mips;
    }
    if (!w || !h || ('readyState' in s && s.readyState < 2))
      return slot.texture ? [this.view(slot, srgb), slot.sampler] : undefined;
    if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D)
      throw tooLarge(w, h, device.limits.maxTextureDimension2D);
    let t = slot.texture;
    const pending = slot.version !== this.version;
    // A new colour space or mip setting needs a new GPU copy; it is made on the upload after `update()`. Display P3
    // uploads into an sRGB-decoding staging copy (one level) that converts into the rgba16float `slot.p3`.
    if (
      !t ||
      t.width !== w ||
      t.height !== h ||
      (pending &&
        (slot.mips !== (o.mipmaps ?? !video) ||
          p3 !== !!slot.p3 ||
          (o.colorSpace !== undefined && t.format !== (o.colorSpace === 'linear' ? 'rgba8unorm' : 'rgba8unorm-srgb'))))
    ) {
      t?.destroy();
      slot.p3?.destroy();
      slot.p3 = undefined;
      const format = p3 || (o.colorSpace ? o.colorSpace === 'srgb' : srgb),
        levels = (o.mipmaps ?? !video) ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
      slot.mips = o.mipmaps ?? !video;
      t = slot.texture = device.createTexture({
        size: [w, h],
        format: format ? 'rgba8unorm-srgb' : 'rgba8unorm',
        viewFormats: [format ? 'rgba8unorm' : 'rgba8unorm-srgb'],
        mipLevelCount: p3 ? 1 : levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      if (p3)
        slot.p3 = device.createTexture({
          size: [w, h],
          format: 'rgba16float',
          mipLevelCount: levels,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      slot.views.clear();
      slot.version = -1;
      if (slot.samplerMips !== slot.mips) {
        slot.sampler = this.sampler(device, slot.mips);
        slot.samplerMips = slot.mips;
      }
    }
    const currentTime = 'currentTime' in s ? s.currentTime : undefined;
    if (slot.version !== this.version || (video && currentTime !== slot.time)) {
      if (raw(s)) device.queue.writeTexture({ texture: t }, s.data, { bytesPerRow: w * 4 }, [w, h]);
      else copyExternal(device, { source: s, flipY: o.flipY ?? true }, { texture: t }, [w, h]);
      slot.version = this.version;
      slot.time = currentTime;
      slot.region = undefined;
      if (slot.p3) {
        convertP3(device, t, slot.p3);
        mipmaps(device, slot.p3);
      } else mipmaps(device, t);
    } else if (slot.region) {
      const [x, y, x1, y1] = slot.region,
        size = [x1 - x, y1 - y],
        flip = o.flipY ?? true;
      slot.region = undefined;
      if (raw(s))
        device.queue.writeTexture(
          { texture: t, origin: [x, y] },
          s.data,
          { offset: (y * w + x) * 4, bytesPerRow: w * 4 },
          size,
        );
      // flipY copies the source rectangle bottom row first, so it lands where the full flipped upload put those rows.
      else
        copyExternal(
          device,
          { source: s, origin: [x, y], flipY: flip },
          { texture: t, origin: [x, flip ? h - y1 : y] },
          size,
        );
      if (slot.p3) {
        convertP3(device, t, slot.p3);
        mipmaps(device, slot.p3);
      } else mipmaps(device, t);
    }
    return [this.view(slot, srgb), slot.sampler];
  }
  /** The sampler of this texture's options; `tile` repeats on each axis whose wrap is unset instead of clamping. */
  private sampler(device: GPUDevice, mips: boolean, tile = false): GPUSampler {
    const o = this.options,
      min = o.minFilter ?? 'linear',
      mag = o.magFilter ?? 'linear',
      unset = tile ? 'repeat' : 'clamp';
    return device.createSampler({
      addressModeU: wraps[o.wrapS ?? unset],
      addressModeV: wraps[o.wrapT ?? unset],
      magFilter: mag,
      minFilter: min,
      mipmapFilter: min,
      lodMaxClamp: mips ? 32 : 0,
      maxAnisotropy: min === 'linear' && mag === 'linear' && mips ? (o.anisotropy ?? 1) : 1,
    });
  }
  private view(slot: Slot, srgb: boolean): GPUTextureView {
    const t = slot.p3 ?? slot.texture!,
      format = this.options.colorSpace ? t.format : srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    let view = slot.views.get(format);
    if (!view) {
      view = t.createView({ format });
      slot.views.set(format, view);
    }
    return view;
  }
}
// Mip chains read through the materials sampler (made only when a texture has mips to fill).
function mipmaps(device: GPUDevice, texture: GPUTexture): void {
  if (texture.mipLevelCount < 2) return;
  const d = defaults(device);
  generateMipmaps(
    device,
    texture,
    texture.mipLevelCount,
    d.pipelines,
    texture.dimension === '2d' ? (texture.depthOrArrayLayers ?? 1) : 1,
  );
}
/** Download and decode caps of `loadTexture` (and `maxBytes` of `loadKTX2Texture`); each takes a positive integer. */
export interface TextureLimits {
  /** Most bytes downloaded (default 64 MiB, 67,108,864). */
  maxBytes?: number;
  /** Most decoded pixels, width times height (default 16,777,216, 4096 x 4096). A device's own texture size limit still applies. */
  maxPixels?: number;
}
const limit = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(
      `Texture ${name} must be a positive integer; pass a number of ${name === 'maxBytes' ? 'bytes' : 'pixels'}`,
    );
  return value;
};
/** The bytes at an http(s), blob: or data: `url` (`maxBytes`, default 64 MiB, at most) and the response's content type. */
async function download(
  url: string | URL,
  signal?: AbortSignal,
  get: typeof fetch = globalThis.fetch,
  maxBytes?: number,
  tally?: { bytes: number },
): Promise<[Uint8Array, string]> {
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:', 'blob:', 'data:'].includes(target.protocol))
    throw new TypeError('Texture URL must use HTTP(S), blob: or data:');
  const response = await get(target, { signal }),
    bytes = await readResponse(response, {
      maxBytes: limit(maxBytes, 64 * 1024 * 1024, 'maxBytes'),
      signal,
      label: 'Texture download',
    });
  if (tally) tally.bytes += bytes.length;
  return [bytes, response.headers.get('content-type') ?? ''];
}
/** The image at `url` as an ImageBitmap (4096x4096 pixels at most), pixels as stored (no colour or alpha conversion). */
async function fetchBitmap(
  url: string | URL,
  signal?: AbortSignal,
  get?: typeof fetch,
  limits: TextureLimits = {},
  tally?: { bytes: number },
): Promise<ImageBitmap> {
  const pixels = limit(limits.maxPixels, maxPixels, 'maxPixels'),
    [bytes, type] = await download(url, signal, get, limits.maxBytes, tally);
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > pixels)
      throw new RangeError(
        `Texture exceeds decoded size limit; use an image of ${pixels} pixels or fewer, or raise maxPixels.`,
      );
    return bitmap;
  } catch (error) {
    bitmap.close();
    throw error;
  }
}
/**
 * Fetches http(s), blob: or data: image bytes into an ImageBitmap the texture owns. `maxBytes` (default 64 MiB) and
 * `maxPixels` (default 4096x4096) raise or lower the caps.
 * `fetch`: default `globalThis.fetch`, e.g. a LoadingManager's or AssetCache's `fetch`.
 */
export async function loadTexture(
  url: string | URL,
  {
    signal,
    fetch: get,
    maxBytes,
    maxPixels: pixels,
    ...options
  }: TextureOptions & TextureLimits & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<Texture> {
  const bitmap = await fetchBitmap(url, signal, get, { maxBytes, maxPixels: pixels });
  try {
    return new Texture(bitmap, options, true);
  } catch (error) {
    bitmap.close();
    throw error;
  }
}
/** What `loadKTX2Texture` needs of `@margoengine/decoders`' `KTX2Decoder`: its `transcode`. */
export interface KTX2Transcoder {
  transcode(data: ArrayBuffer | ArrayBufferView, options?: { signal?: AbortSignal }): Promise<TranscodedTexture>;
}
/** What `loadKTX2Texture` needs of `@margoengine/decoders/ktx2-layers`' `KTX2LayerDecoder`. */
export interface KTX2LayerReader {
  decode(data: ArrayBuffer | ArrayBufferView, options?: { signal?: AbortSignal }): Promise<TranscodedTexture>;
  upload(device: GPUDevice, file: never, options?: { usage?: number }): GPUTexture;
}
/**
 * Fetches a `.ktx2` file (64 MiB at most) and transcodes it with `decoder` (a `KTX2Decoder` from
 * `@margoengine/decoders`, created with the engine's device so it picks a compressed format the device has) into a
 * Texture for any material map. With a `KTX2LayerDecoder` from `@margoengine/decoders/ktx2-layers` the file may also be a
 * cube map, which comes back as a CubeTexture for `envMap`, or an array, a `'2d-array'` Texture for a layer slot.
 * `fetch`: default `globalThis.fetch`, e.g. a LoadingManager's or AssetCache's `fetch`.
 * @throws TypeError without a decoder; the decoder's own errors for unsupported or corrupt files.
 */
export async function loadKTX2Texture(
  url: string | URL,
  {
    decoder,
    signal,
    fetch: get,
    maxBytes,
    ...options
  }: TextureOptions & {
    decoder: KTX2Transcoder | KTX2LayerReader;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    maxBytes?: number;
  },
): Promise<Texture> {
  const layers = decoder as KTX2LayerReader,
    plain = decoder as KTX2Transcoder;
  if (typeof layers?.decode !== 'function' && typeof plain?.transcode !== 'function')
    throw new TypeError('loadKTX2Texture needs a decoder; pass {decoder: new KTX2Decoder({device: engine.gpu})}');
  const [bytes] = await download(url, signal, get, maxBytes);
  if (typeof layers.decode !== 'function') {
    const result = await plain.transcode(bytes, { signal });
    signal?.throwIfAborted();
    return new Texture(result, options);
  }
  const file = await layers.decode(bytes, { signal });
  signal?.throwIfAborted();
  // The file stays on the CPU, so a restored device gets its upload too.
  const source = {
    ...file,
    upload: (device: GPUDevice) =>
      layers.upload(device, file as never, {
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      }),
  };
  return file.dimension === 'cube' ? new CubeTexture(source, options) : new Texture(source, options);
}
/** `CubeTexture` options: those of `Texture` (the dimension is always `'cube'`) and an equirect source's face size. */
export interface CubeTextureOptions extends Omit<TextureOptions, 'dimension'> {
  /** Equirectangular sources only: each face's edge in texels (default a power of two near the image width / 4, at least 16). */
  size?: number;
}
/**
 * A cube map for `Material.envMap` or a WgslMaterial `texture_cube<f32>`, sampled with world
 * directions. Six faces in WebGPU layer order +X, -X, +Y, -Y, +Z, -Z (square, one size, row 0 at the top, so `flipY`
 * defaults to false; @margoengine/environment's CubeFaces convention): images, raw RGBA8 or float `DataImage`s. Or one
 * equirectangular 2D Texture (centre facing -Z, +X to its right, top row straight up; @margoengine/environment's
 * convention), resampled on the GPU into rgba16float faces whenever the source updates. Mip chains are generated per
 * face (`mipmaps`, default true): rough materials read lower levels.
 */
export class CubeTexture extends Texture {
  constructor(
    source: readonly (ImageSource | ImageData | RawImage | DataImage)[] | Texture | TranscodedTexture,
    options: CubeTextureOptions = {},
    owned = false,
  ) {
    const file = (source as Partial<TranscodedTexture> | null)?.dimension === 'cube';
    if (!(source instanceof Texture) && !Array.isArray(source) && !file)
      throw new TypeError(
        'CubeTexture needs six face images, an equirectangular Texture or a KTX2 cube map; pass one of those',
      );
    const { size, ...rest } = options ?? {};
    super(
      file
        ? (source as TranscodedTexture)
        : source instanceof Texture
          ? { equirect: source, ...(size !== undefined ? { size } : {}) }
          : { faces: source as readonly (ImageSource | ImageData | RawImage | DataImage)[] },
      { ...rest, dimension: 'cube' },
      owned,
    );
  }
  /** Frees the GPU copies (and, for `loadCubeTexture`, the images or equirect Texture it loaded). */
  override dispose(): void {
    super.dispose();
    const source = this.source as { equirect?: Texture };
    if (this.owned && source.equirect) source.equirect.dispose();
  }
}
/**
 * Loads a cube map: six image URLs in the order +X, -X, +Y, -Y, +Z, -Z, or one
 * equirectangular image URL. Images download as `loadTexture` does (through `fetch`, default `globalThis.fetch`); the
 * CubeTexture owns them. `maxPixels` (default 4096x4096) caps every face. `maxBytes` caps the download of the whole
 * cube: six faces share it, taking one after another, and the one that passes it throws. Left out, each face keeps the
 * default 64 MiB cap and the six download side by side.
 */
export async function loadCubeTexture(
  urls: string | URL | readonly (string | URL)[],
  {
    signal,
    fetch: get,
    maxBytes,
    maxPixels: pixels,
    ...options
  }: CubeTextureOptions & TextureLimits & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<CubeTexture> {
  if (!Array.isArray(urls)) {
    const { size, ...rest } = options,
      image = await loadTexture(urls as string | URL, {
        signal,
        fetch: get,
        maxBytes,
        maxPixels: pixels,
        colorSpace: rest.colorSpace,
      });
    try {
      return new CubeTexture(image, { ...rest, colorSpace: undefined, ...(size !== undefined ? { size } : {}) }, true);
    } catch (error) {
      image.dispose();
      throw error;
    }
  }
  if (urls.length !== 6)
    throw new TypeError('loadCubeTexture needs six face URLs (+X, -X, +Y, -Y, +Z, -Z) or one equirect URL');
  const shared = maxBytes === undefined ? undefined : limit(maxBytes, 0, 'maxBytes'),
    tally = { bytes: 0 },
    settled: PromiseSettledResult<ImageBitmap>[] = [];
  if (shared === undefined)
    settled.push(
      ...(await Promise.allSettled(urls.map((url) => fetchBitmap(url, signal, get, { maxPixels: pixels })))),
    );
  else
    for (const url of urls) {
      // The faces take one budget: each is allowed what the earlier ones left, and the first to pass it fails the load.
      const [result] = await Promise.allSettled([
        fetchBitmap(url, signal, get, { maxBytes: Math.max(1, shared - tally.bytes), maxPixels: pixels }, tally),
      ]);
      settled.push(result);
      if (result.status === 'rejected') break;
    }
  const bitmaps = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  try {
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    return new CubeTexture(bitmaps, options, true);
  } catch (error) {
    for (const bitmap of bitmaps) bitmap.close();
    throw error;
  }
}
