import { requireWebGPU } from '../../shared/require-webgpu.js';
import { compatTier } from '../../shared/compat.js';
/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import {
  GLTFAsset,
  PBRModel,
  PBRDrawRun,
  textureTransform,
  textureCoordinates,
  type PreparedGeometry,
  type PBRMaterial,
  type PBRMaterialShading,
  type PBRRenderState,
  type TextureTransform,
  type MaterialSide,
} from '@margoengine/gltf-pro/model';
import { PBRInstances } from '@margoengine/gltf-pro/instancing';
import { extendedMaterials } from '@margoengine/gltf-pro/extended';
import { physicalMapsShader } from './physical-maps.js';
import { depthDistanceShader } from './depth-distance.js';
import { featureMaps, featureShader } from './features.js';
import { surfaceFloats } from './surface-features.js';
import { catcherLit } from './catcher.js';
import { toonDeclarations, toonEdits, toonLit } from './toon-shader.js';
import { envFloats, envMapLit, envMapShader, packEnv, type EnvCombine, type EnvironmentMap } from './env-map.js';
import { readResponse } from '../../shared/loading.js';
import { attenuationPower } from '../../shared/attenuation.js';
import { clusterBrdf } from '../../shared/light-terms.js';
import type { CasterDisplacement } from '../../shared/caster.js';
import { primitiveAfterOpaque } from '../../shared/material-routing.js';
import { MargoError } from '@margoengine/math/errors';
import { hexColor, parseColor, type ColorInput } from '@margoengine/math/color';
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
import { clipStatement, markClipDistances, sectionShader } from '../../shared/section.js';
export type { TextureTransform, MaterialSide } from '@margoengine/gltf-pro';
export {
  packAtlas,
  padTileGrid,
  remapTileUVs,
  transformUVs,
  type Atlas,
  type AtlasOptions,
  type TileGridAtlas,
  type TileGridOptions,
} from './atlas.js';
export type { EnvCombine, EnvironmentMap } from './env-map.js';
export type {
  CubeTarget,
  DataFormat,
  DataImage,
  TextureDimension,
  TranscodedMip,
  TranscodedTexture,
} from './texture-kinds.js';
declare const GPUTextureUsage: {
  TEXTURE_BINDING: number;
  COPY_DST: number;
  COPY_SRC: number;
  RENDER_ATTACHMENT: number;
};
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** Raw pixels for `new Texture({ data, width, height })`: tightly packed RGBA8 rows, top row first. */
export type RawImage = { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
/** What `Material.envMap` takes: a cube Texture (CubeTexture), an Environment, a cube render target or a six-layer GPUTexture. */
export type EnvMapSource = Texture | EnvironmentMap | CubeTarget | GPUTexture;
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
 * texels. A GPUTexture (such as `KTX2Decoder.createTexture` output) or a `CubeTarget` is borrowed as is; a
 * `TranscodedTexture` (`KTX2Decoder.transcode` output) uploads its compressed mips on each device; a `CubeSource` makes
 * a cube map.
 */
export type TextureSource =
  | ImageSource
  | ImageData
  | RawImage
  | DataImage
  | GPUTexture
  | CubeTarget
  | TranscodedTexture
  | CubeSource;
/** Texture wrap mode on one axis: `'repeat'` (default), `'clamp'` or `'mirror'`. */
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
}
/** What a non-image source is, fixed at construction (absent for images and raw RGBA8, the original path). */
type Kind =
  | { type: 'data'; format: DataFormat; dimension: '2d' | '2d-array' | '3d' }
  | { type: 'gpu'; texture: GPUTexture; view?: GPUTextureView; dimension: TextureDimension }
  | { type: 'ktx2'; base: string; dimension: '2d' | '2d-array' | 'cube'; own: boolean }
  | { type: 'faces'; format?: DataFormat }
  | { type: 'equirect'; source: Texture; size: number };
const wraps = { repeat: 'repeat', clamp: 'clamp-to-edge', mirror: 'mirror-repeat' } as const,
  maxPixels = 16_777_216;
const optional = (list: readonly unknown[]) => (v: unknown) => v === undefined || list.includes(v);
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
const shared = new WeakMap<
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
function defaults(device: GPUDevice) {
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
function fallback(device: GPUDevice, role: number): readonly [GPUTextureView, GPUSampler] {
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
/** Queues whose browser refused a video as a copyExternalImageToTexture source (Firefox takes only images and canvases). */
const noVideoCopies = new WeakSet<GPUQueue>();
const frameCanvases = new WeakMap<object, { canvas: HTMLCanvasElement | OffscreenCanvas; w: number; h: number }>();
const isVideoSource = (s: unknown): boolean =>
  !!s && typeof s === 'object' && ('videoWidth' in s || 'displayWidth' in s);
/**
 * queue.copyExternalImageToTexture. A browser that does not take a video or VideoFrame as the source (Firefox 157 throws
 * a TypeError from WebIDL conversion, not a validation error) gets the frame through a canvas it is drawn on instead:
 * the same pixels, one extra draw per upload. The queue is remembered, so the fallback is chosen once.
 */
function copyExternal(
  device: GPUDevice,
  info: { source: ImageSource | HTMLCanvasElement | OffscreenCanvas; origin?: number[]; flipY?: boolean },
  destination: { texture: GPUTexture; origin?: number[] },
  size: number[],
): void {
  const queue = device.queue,
    source = info.source;
  const video = isVideoSource(source);
  if (video && !noVideoCopies.has(queue))
    try {
      return queue.copyExternalImageToTexture(info as GPUCopyExternalImageSourceInfo, destination, size);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      noVideoCopies.add(queue);
    }
  if (!video) return queue.copyExternalImageToTexture(info as GPUCopyExternalImageSourceInfo, destination, size);
  const [w, h] = dimensions(source as ImageDimensions);
  let frame = frameCanvases.get(source);
  if (!frame || frame.w !== w || frame.h !== h) {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    frameCanvases.set(source, (frame = { canvas, w, h }));
  }
  (frame.canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(source as CanvasImageSource, 0, 0);
  queue.copyExternalImageToTexture({ ...info, source: frame.canvas } as GPUCopyExternalImageSourceInfo, destination, size);
}
const raw = (s: unknown): s is RawImage =>
  !!s && typeof s === 'object' && 'data' in s && (s.data instanceof Uint8Array || s.data instanceof Uint8ClampedArray);
const gpuTexture = (s: unknown): s is GPUTexture =>
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
  if (gpuTexture(source)) return { type: 'gpu', texture: source, dimension: gpuDimension(source, o.dimension) };
  if (gpuTexture(s.texture) && s.view) {
    if (o.dimension !== undefined && o.dimension !== 'cube')
      throw new TypeError("Texture CubeTarget is a cube; omit dimension or pass 'cube'");
    if (s.texture.depthOrArrayLayers !== 6) throw new TypeError('Texture CubeTarget texture must have six layers');
    return { type: 'gpu', texture: s.texture, view: s.view, dimension: 'cube' };
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
      else if (raw(face) && face.data.length < face.width * face.height * 4)
        throw new RangeError('Raw texture data must be RGBA8 of width*height*4 bytes');
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
const liveFloats = 18;
/**
 * Change stamps shared by textures and materials: each change takes the next number, so the largest stamp of a
 * material and the textures it binds grows whenever any of them changes (`MaterialShading.version`).
 */
let stamps = 0;
const changeStamp = (): number => ++stamps;
// The textures with a GPU copy on each device, told once when it is lost. Made outside any texture's scope, so the
// reaction holds only the device and this set, which a texture leaves on dispose: one reaction per texture and device
// kept every disposed texture alive as long as the device (docs/known-bugs.md).
const lostTextures = new WeakMap<GPUDevice, Set<Texture>>();
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
    const o = options,
      [w, h] = dimensions(source as ImageDimensions);
    if (
      !source ||
      typeof source !== 'object' ||
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
    if (
      !this.kind &&
      raw(source) &&
      (!Number.isInteger(w) ||
        !Number.isInteger(h) ||
        w < 1 ||
        h < 1 ||
        w * h > maxPixels ||
        source.data.length < w * h * 4)
    )
      throw new RangeError('Raw texture data must be RGBA8 of width*height*4 bytes');
  }
  /** Width, height and depth (layers or slices; 6 for a cube) of the current source. */
  private size(): [number, number, number] {
    const k = this.kind,
      s = this.source as DataImage & CubeTarget & { faces: ImageDimensions[] };
    if (!k) return [...dimensions(s as ImageDimensions), 1];
    if (k.type === 'gpu') return [k.texture.width, k.texture.height, k.texture.depthOrArrayLayers];
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
        : k?.type === 'gpu' && unfilterable(k.texture.format);
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
    if (k?.type === 'gpu') return k.texture.mipLevelCount > 1;
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
      ? this.kind.texture
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
  /** `bind` for data, borrowed, KTX2 and cube sources. */
  private bindKind(device: GPUDevice, srgb: boolean): [GPUTextureView, GPUSampler] | undefined {
    const k = this.kind!,
      o = this.options,
      [w, h, d] = this.size();
    if (k.type === 'gpu') {
      const slot = this.slotFor(device, k.texture.mipLevelCount > 1);
      return [k.view ?? this.viewOf(slot, k.texture, k.texture.format, k.dimension), slot.sampler];
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
    if (w > limit || h > limit || (dimension === '3d' ? d > limit : d > device.limits.maxTextureArrayLayers))
      throw new RangeError('Texture exceeds device limit; resize it to maxTextureDimension2D or less.');
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
  sampled(device: GPUDevice, srgb: boolean, slot: string): [GPUTextureView, GPUSampler] | undefined {
    if (this.dimension !== '2d')
      throw new TypeError(
        `Material ${slot} needs a 2D Texture, not a ${this.dimension} one; sample it from a WgslMaterial texture instead`,
      );
    if (this.unfilterable && !device.features.has('float32-filterable'))
      throw new MargoError(
        'unsupported',
        `Material ${slot} samples 32-bit float texels, which needs the device feature float32-filterable; request it in Engine.create features or use a 16-bit float format`,
      );
    return this.bind(device, srgb);
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
    if (k?.type === 'gpu') return slot.samplerMips === k.texture.mipLevelCount > 1 ? this.stamp : Number.NaN;
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
      throw new RangeError('Texture exceeds device limit; resize it to maxTextureDimension2D or less.');
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
  private sampler(device: GPUDevice, mips: boolean): GPUSampler {
    const o = this.options,
      min = o.minFilter ?? 'linear',
      mag = o.magFilter ?? 'linear';
    return device.createSampler({
      addressModeU: wraps[o.wrapS ?? 'clamp'],
      addressModeV: wraps[o.wrapT ?? 'clamp'],
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
/** The bytes at an http(s), blob: or data: `url` (64 MiB at most) and the response's content type. */
async function download(
  url: string | URL,
  signal?: AbortSignal,
  get: typeof fetch = globalThis.fetch,
): Promise<[Uint8Array, string]> {
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:', 'blob:', 'data:'].includes(target.protocol))
    throw new TypeError('Texture URL must use HTTP(S), blob: or data:');
  const response = await get(target, { signal }),
    bytes = await readResponse(response, { maxBytes: 64 * 1024 * 1024, signal, label: 'Texture download' });
  return [bytes, response.headers.get('content-type') ?? ''];
}
/** The image at `url` as an ImageBitmap (4096x4096 pixels at most), pixels as stored (no colour or alpha conversion). */
async function fetchBitmap(url: string | URL, signal?: AbortSignal, get?: typeof fetch): Promise<ImageBitmap> {
  const [bytes, type] = await download(url, signal, get);
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > maxPixels)
      throw new RangeError('Texture exceeds decoded size limit; use an image of 4096x4096 pixels or fewer.');
    return bitmap;
  } catch (error) {
    bitmap.close();
    throw error;
  }
}
/**
 * Fetches http(s), blob: or data: image bytes (64 MiB, 4096x4096 pixels at most) into an ImageBitmap the texture owns.
 * `fetch`: default `globalThis.fetch`, e.g. a LoadingManager's or AssetCache's `fetch`.
 */
export async function loadTexture(
  url: string | URL,
  { signal, fetch: get, ...options }: TextureOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<Texture> {
  const bitmap = await fetchBitmap(url, signal, get);
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
    ...options
  }: TextureOptions & { decoder: KTX2Transcoder | KTX2LayerReader; signal?: AbortSignal; fetch?: typeof fetch },
): Promise<Texture> {
  const layers = decoder as KTX2LayerReader,
    plain = decoder as KTX2Transcoder;
  if (typeof layers?.decode !== 'function' && typeof plain?.transcode !== 'function')
    throw new TypeError('loadKTX2Texture needs a decoder; pass {decoder: new KTX2Decoder({device: engine.gpu})}');
  const [bytes] = await download(url, signal, get);
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
 * CubeTexture owns them.
 */
export async function loadCubeTexture(
  urls: string | URL | readonly (string | URL)[],
  { signal, fetch: get, ...options }: CubeTextureOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<CubeTexture> {
  if (!Array.isArray(urls)) {
    const { size, ...rest } = options,
      image = await loadTexture(urls as string | URL, { signal, fetch: get, colorSpace: rest.colorSpace });
    try {
      return new CubeTexture(image, { ...rest, colorSpace: undefined, ...(size !== undefined ? { size } : {}) }, true);
    } catch (error) {
      image.dispose();
      throw error;
    }
  }
  if (urls.length !== 6)
    throw new TypeError('loadCubeTexture needs six face URLs (+X, -X, +Y, -Y, +Z, -Z) or one equirect URL');
  const settled = await Promise.allSettled(urls.map((url) => fetchBitmap(url, signal, get))),
    bitmaps = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  try {
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    return new CubeTexture(bitmaps, options, true);
  } catch (error) {
    for (const bitmap of bitmaps) bitmap.close();
    throw error;
  }
}

/**
 * `lambert` is diffuse only; `phong` adds a Blinn-Phong highlight (`specular`, `shininess`); `toon` bands the diffuse
 * light through a ramp (`gradientMap` or `steps`); `basic` is unlit.
 */
export type Shading = 'standard' | 'basic' | 'normal' | 'matcap' | 'depth' | 'distance' | 'lambert' | 'phong' | 'toon';
/** How depth and distance materials store their value: `'basic'` (grayscale, default for depth) or `'rgba'` (24-bit fixed point, default for distance). */
export type DepthPacking = 'basic' | 'rgba';
/** How a material combines with what is behind it: `'normal'` (default), `'additive'`, `'multiply'` or `'none'` (opaque write). */
export type Blending = 'normal' | 'additive' | 'multiply' | 'none';
/** A live linear colour array (what gltf-pro reads every frame) whose `set` takes any colour input, like the option. */
type LiveColor = number[] & { set(value: ColorInput): number[] };
/**
 * Physical options (glTF KHR_materials_* meaning; gltf-pro's physical shader draws
 * them, so a mesh and the same glTF material render alike). Any of them, at construction or set later, makes the
 * material physical (standard shading only); `transmission` and its maps make it transmissive (drawn after opaque
 * meshes). Values stay live.
 */
export interface PhysicalOptions {
  /** KHR_materials_clearcoat: layer strength and roughness, 0-1. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Linear R strength, G roughness, and tangent-space RGB normal, respectively. */
  clearcoatMap?: Texture | null;
  clearcoatRoughnessMap?: Texture | null;
  clearcoatNormalMap?: Texture | null;
  clearcoatNormalScale?: number;
  /** KHR_materials_sheen: sheen colour (default black: none) and roughness 0-1. */
  sheenColor?: ColorInput;
  sheenRoughness?: number;
  /** sRGB RGB colour and linear A roughness. */
  sheenColorMap?: Texture | null;
  sheenRoughnessMap?: Texture | null;
  /** KHR_materials_specular: dielectric specular strength 0-1 and F0 colour. */
  specularIntensity?: number;
  specularColor?: ColorInput;
  /** Linear A intensity and sRGB RGB colour. */
  specularIntensityMap?: Texture | null;
  specularColorMap?: Texture | null;
  /** KHR_materials_anisotropy: strength 0-1, rotation in radians; linear RG direction and B strength. */
  anisotropy?: number;
  anisotropyRotation?: number;
  anisotropyMap?: Texture | null;
  /** KHR_materials_iridescence: strength 0-1, film IOR >= 1, thickness range in nanometres. */
  iridescence?: number;
  iridescenceIOR?: number;
  iridescenceThicknessRange?: readonly [number, number];
  /** Linear R strength and G thickness within the configured range. */
  iridescenceMap?: Texture | null;
  iridescenceThicknessMap?: Texture | null;
  /** KHR_materials_ior: index of refraction, >= 1 (default 1.5). */
  ior?: number;
  /** KHR_materials_dispersion: chromatic refraction strength, finite and >= 0 (default 0). Needs transmission and volume thickness for a visible effect. */
  dispersion?: number;
  /** KHR_materials_transmission: share of light passing through, 0-1. Refracts the scene with `@margoengine/materials/transmission`; otherwise the background shows through tinted. */
  transmission?: number;
  /** Linear R transmission and G volume thickness. Either makes the material transmissive, even at factor 0. */
  transmissionMap?: Texture | null;
  thicknessMap?: Texture | null;
  /** KHR_materials_volume: thickness in mesh units (0 = thin-walled, no refraction), and the colour white light reaches after `attenuationDistance` world units inside. */
  thickness?: number;
  attenuationColor?: ColorInput;
  attenuationDistance?: number;
}
/** Options for `new Material(options)`. Every field is optional; the default is a white `'standard'` PBR material. Invalid values throw a `TypeError` or `RangeError` that names the fix. */
export interface MaterialOptions extends PhysicalOptions {
  shading?: Shading;
  /** Depth/distance output: grayscale or RGBA-packed normalized depth. Defaults to basic for depth, rgba for distance. */
  depthPacking?: DepthPacking;
  /** World-space origin for distance shading. Copied on assignment; default [0, 0, 0]. */
  referencePosition?: readonly [number, number, number];
  /** Distance normalization bounds, finite as float32: 0 <= nearDistance < farDistance. Defaults to 1 and 1000. */
  nearDistance?: number;
  farDistance?: number;
  /** Phong only: highlight colour (default sRGB `#111111`) and Blinn-Phong exponent, finite and >= 0 (default 30). Live. */
  specular?: ColorInput;
  shininess?: number;
  color?: ColorInput;
  opacity?: number;
  roughness?: number;
  metalness?: number;
  emissive?: ColorInput;
  /** Scales `emissive` (and its map), finite and >= 0 (default 1), so emission can exceed 1 for bloom. Live. */
  emissiveIntensity?: number;
  /** Shades each triangle with its own face normal instead of the interpolated vertex normals; default false. Live. */
  flatShading?: boolean;
  /** Multiplies colour and opacity by the geometry's vertex colours (default true); false ignores them. Live. */
  vertexColors?: boolean;
  /** Lit shadings: false leaves this material out of the scene fog (default true; unlit output is never fogged). Live. */
  fog?: boolean;
  /**
   * Lit shadings: false skips the display tone map (PBR Neutral) and only clamps before sRGB encoding, as unlit
   * output does (default true; unlit, normal, matcap, depth and distance output never tone map). Live.
   */
  toneMapped?: boolean;
  /** A step of per-pixel noise before 8-bit output, which removes banding in dark gradients. Default false. Live. */
  dithering?: boolean;
  map?: Texture | null;
  metalRoughnessMap?: Texture | null;
  normalMap?: Texture | null;
  normalScale?: number;
  aoMap?: Texture | null;
  aoMapIntensity?: number;
  emissiveMap?: Texture | null;
  matcap?: Texture | null;
  /**
   * Toon only: the gradient ramp the diffuse light is read through, its RGB at u = n.l * 0.5 + 0.5 (left
   * texel unlit, right texel facing the light). Linear by default; use `magFilter: 'nearest'` for hard bands. Live.
   */
  gradientMap?: Texture | null;
  /** Toon only, without a gradientMap: the number of flat light bands, an integer 2 through 256 (default 3). Live. */
  steps?: number;
  /**
   * A cube map the material reflects: a `CubeTexture`, an `@margoengine/environment` Environment, a
   * cube render target `{texture, view}` (environment's CubeCamera) or a six-layer GPUTexture. Standard shading lights
   * itself with it in place of its ambient light (specular by roughness from the mip chain, diffuse from coarse mips or
   * the Environment's harmonics); basic, Lambert and Phong shading `combine` its sharp reflection with their colour.
   * Other shadings refuse it. Live.
   */
  envMap?: EnvMapSource | null;
  /** Scales the envMap's light, finite and >= 0 (default 1). Live. */
  envMapIntensity?: number;
  /** Turns the envMap about +Y, in radians (default 0; added to an Environment's own rotation). Live. */
  envMapRotation?: number;
  /** `'reflection'` (default) samples along the mirrored view ray, `'refraction'` along the ray bent by `refractionRatio`. Live. */
  envMapMode?: 'reflection' | 'refraction';
  /** Refraction only: the ratio of the indices of refraction, finite and > 0 (default 1/1.5, about 0.667: from air, index 1, into crown glass, index about 1.5). Live. */
  refractionRatio?: number;
  /** Basic, Lambert and Phong: how the reflection meets the colour (default 'multiply'). Live. */
  combine?: EnvCombine;
  /** Basic, Lambert and Phong: the reflection's weight, 0 through 1 (default 1). Live. */
  reflectivity?: number;
  /** Opacity map: its green channel (linear) multiplies opacity, before `alphaTest` and blending. Live. */
  alphaMap?: Texture | null;
  /** Height map (red, linear) that tilts the shading normal by its screen-space slope, after `normalMap`. Live. */
  bumpMap?: Texture | null;
  /** Height of `bumpMap`'s full range in mesh units, finite (negative inverts); default 1. Live. */
  bumpScale?: number;
  /**
   * Moves each vertex along its normal by red (linear) * `displacementScale` + `displacementBias` mesh units, in every
   * pass that draws the material (beauty, G-buffer, directional and clustered shadow maps). Live.
   */
  displacementMap?: Texture | null;
  /** Finite; defaults 1 and 0. Live. */
  displacementScale?: number;
  displacementBias?: number;
  /**
   * Baked light (sRGB colour by default), on UV1 unless its UV transform names another set: lit shadings add diffuse
   * colour * map * `lightMapIntensity` as indirect light (aoMap applies), unlit ones multiply their colour by it. Live.
   */
  lightMap?: Texture | null;
  /** Finite; default 1. Live. */
  lightMapIntensity?: number;
  /** Multiply by the light map (default), or Lambertian irradiance / pi on lit shadings. Use a linear lightMap texture; physical intensity must be nonnegative. Live. */
  lightMapResponse?: 'multiply' | 'lambertian';
  /**
   * Height map (red, linear: 1 the surface, 0 `parallaxScale` below it) the view ray is marched through, so every map
   * on its UV set (UV0 unless its UV transform names UV1) shifts as if the surface had that relief. Shading only: the
   * silhouette, depth, shadows and picking keep the flat mesh. Live; null for none.
   */
  parallaxMap?: Texture | null;
  /** Depth of `parallaxMap`'s full range in world units, finite and >= 0 (default 0.05). Live. */
  parallaxScale?: number;
  /**
   * `'occlusion'` (default) steps along the ray and interpolates the hit, `'relief'` refines it by bisection (sharper
   * steps), `'offset'` takes one cheap step that flattens at grazing angles. Live.
   */
  parallaxMode?: ParallaxMode;
  /** Steps of the occlusion and relief march, an integer 1 through 64 (default 16). Live. */
  parallaxSteps?: number;
  /**
   * Projects the maps on UV0 from world space along X, Y and Z and blends the three by the normal, so a mesh needs no
   * unwrap and textures meet without seams or stretching; UV1 maps (a lightMap) keep their UVs. Default false. Live.
   */
  triplanar?: boolean;
  /** Texture repeats per world unit of the triplanar projection, finite and > 0 (default 1). Live. */
  triplanarScale?: number;
  /** Exponent of the blend weights |n|^sharpness, finite and >= 1 (default 4): higher gives narrower transitions. Live. */
  triplanarSharpness?: number;
  /**
   * Subsurface scattering weight, 0 through 1 (default 0: off). Standard, Lambert and Phong shading. Light from the
   * engine's directional light enters the surface and leaves elsewhere, tinted by the base colour and
   * `subsurfaceColor`. Live.
   */
  subsurface?: number;
  /**
   * `'thick'` (default): light seen through the object around the light (statues, skin, wax) plus a diffuse that wraps
   * past the terminator; `'thin'`: a sheet lit from behind shows the light through it (leaves, paper, cloth). Live.
   */
  subsurfaceMode?: SubsurfaceMode;
  /** Colour the scattered light picks up, multiplied by the base colour (default white). Live. */
  subsurfaceColor?: ColorInput;
  /** Local thickness 0 through 1 (default 0.5); light passes through 1 - thickness. Times `subsurfaceThicknessMap`. Live. */
  subsurfaceThickness?: number;
  /** Local thickness (red, linear) times `subsurfaceThickness`: white blocks the light, black lets it through. Live. */
  subsurfaceThicknessMap?: Texture | null;
  /** Thick only: how far the surface normal bends the light seen through the object, finite and >= 0 (default 0.2). Live. */
  subsurfaceDistortion?: number;
  /** Thick only: how tightly the light seen through gathers around the light's direction, finite and > 0 (default 4). Live. */
  subsurfacePower?: number;
  /** Thick only: how far diffuse light wraps past the terminator, 0 through 1 (default 0.5). Live. */
  subsurfaceWrap?: number;
  /**
   * Up to 6 world-space planes `[a, b, c, d]`: points with `a x + b y + c z + d < 0` are cut away (the section
   * convention), in every pass that draws the material. Live; default none.
   */
  clippingPlanes?: readonly (readonly number[])[];
  /** The planes clip the material's directional shadows too (default true). Live. */
  clipShadows?: boolean;
  /**
   * false (default): cut away what is behind any plane (the union of their negative sides). true: cut away only what is
   * behind every plane (their intersection), e.g. a wedge out of a solid. Live.
   */
  clipIntersection?: boolean;
  transparent?: boolean;
  alphaTest?: number;
  /** Optional features from this package's entries (`alphaHash()` from `/alpha-hash`, ...). Live; default none. */
  features?: readonly MaterialFeature[];
  /** Faces drawn by triangle meshes. Explicit side takes precedence over doubleSided. */
  side?: MaterialSide;
  doubleSided?: boolean;
  /** Draws triangle edges instead of filled surfaces; defaults to false. Live, like all render state below. */
  wireframe?: boolean;
  blending?: Blending;
  depthWrite?: boolean;
  depthTest?: boolean;
  colorWrite?: boolean;
  /** With `alphaTest` on a multisampled target, cut edges by sample coverage, so they come out smooth; defaults to false. */
  alphaToCoverage?: boolean;
  /** Positive factors/units push polygons away from the camera, including the reverse-Z renderer. */
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  polygonOffsetClamp?: number;
  /** Enables stencil comparison and operations. Other stencil options are inactive when false. */
  stencilWrite?: boolean;
  stencilRef?: number;
  stencilReadMask?: number;
  stencilWriteMask?: number;
  stencilFunc?: GPUCompareFunction;
  stencilFail?: GPUStencilOperation;
  stencilZFail?: GPUStencilOperation;
  stencilZPass?: GPUStencilOperation;
  /** UV offset/scale/rotation for every map but `matcap` (KHR_texture_transform semantics), e.g. an atlas region. */
  uvTransform?: TextureTransform;
}
/** Every map slot of a material, in the order its physical maps are numbered. */
export const mapSlots = [
  'map',
  'metalRoughnessMap',
  'normalMap',
  'aoMap',
  'emissiveMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'transmissionMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularIntensityMap',
  'specularColorMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap',
  'thicknessMap',
] as const;
/** Names of the texture maps a material can hold, such as `'map'`, `'normalMap'` or `'aoMap'`. */
export type MapSlot = (typeof mapSlots)[number];
/**
 * An optional surface feature from one of this package's entries (`@margoengine/materials/alpha-hash` and the like),
 * assigned through `Material.features`. It costs a material that does not list it nothing: its WGSL lives in its entry.
 */
export interface MaterialFeature {
  /** Portable owner options. Custom features can instead supply a serialization codec. */
  serialization?(): unknown;
  /** Optional private state of this feature's attachment to one material. */
  captureState?(material: Material): unknown;
  /** Restore the state returned by captureState after attachment. */
  restoreState?(material: Material, state: unknown): void;
  /** What it is: a material holds one feature of each name. */
  readonly name: string;
  /** Edits the material's finished shader (`group` is its bind group). The text a feature writes is fixed at creation; assign a new feature to change it. */
  shader(code: string, group: number, material: Material): string;
  /** True when `shader` reads the tangent frame `t` and `b` for a normal map of its own, so the frame points as a normal map's does. */
  tangentFrame?: boolean;
  /** Edits the shader once the scene's lighting effects are composed into it. */
  lit?(code: string, material: Material): string;
  /** Bind group entries of `group`, read on every draw; `owner` keys what it allocates. */
  bindings?(device: GPUDevice, owner: object, material: Material): GPUBindGroupEntry[];
  /** Called when the feature joins a material. */
  attach?(material: Material): void;
  /** Called when the feature leaves a material. */
  detach?(material: Material): void;
}
const slots = ['map', 'metalRoughnessMap', 'normalMap', 'aoMap', 'emissiveMap', 'matcap'] as const,
  names = ['baseMap', 'mrMap', 'normalMap', 'aoMap', 'emissiveMap', 'matcap'];
const unit = (v: unknown, label: string) => {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1))
    throw new RangeError(`Material ${label} must be in [0, 1]; set a number from 0 to 1.`);
  return v;
};
const rasterMask = (v: number, label: string): number => {
  if (typeof v !== 'number') throw new TypeError(`Material ${label} must be a number; set an unsigned 32-bit integer`);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff)
    throw new RangeError(`Material ${label} is out of range; set an integer from 0 through 4294967295`);
  return v;
};
const rasterFloat = (v: number, label: string): number => {
  if (typeof v !== 'number') throw new TypeError(`Material ${label} must be a number; set a finite float32 value`);
  if (!Number.isFinite(Math.fround(v)))
    throw new RangeError(`Material ${label} is not finite as float32; set a finite float32 value`);
  return v;
};
const stencilFunctions: readonly string[] = [
  'never',
  'less',
  'equal',
  'less-equal',
  'greater',
  'not-equal',
  'greater-equal',
  'always',
];
const stencilOperations: readonly string[] = [
  'keep',
  'zero',
  'replace',
  'invert',
  'increment-clamp',
  'decrement-clamp',
  'increment-wrap',
  'decrement-wrap',
];
// GPU uniforms are float32: a finite double such as 1e39 would upload as Infinity.
const finiteFloat = (v: unknown, label: string, min = -Infinity): number => {
  if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || !(v >= min))
    throw new RangeError(
      `Material ${label} must be finite as float32${min > -Infinity ? ` and >= ${min}` : ''}; set a number in that range.`,
    );
  return v;
};
/** Render state, live: each change selects the matching beauty pipeline on the next draw. */
interface Raster {
  blending: Blending;
  depthWrite: boolean | undefined;
  depthTest: boolean;
  colorWrite: boolean;
  alphaToCoverage: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  polygonOffsetClamp: number;
  stencilWrite: boolean;
  stencilRef: number;
  stencilReadMask: number;
  stencilWriteMask: number;
  stencilFunc: GPUCompareFunction;
  stencilFail: GPUStencilOperation;
  stencilZFail: GPUStencilOperation;
  stencilZPass: GPUStencilOperation;
  wireframe: boolean;
}
const rasterDefaults: Raster = {
  blending: 'normal',
  depthWrite: undefined,
  depthTest: true,
  colorWrite: true,
  alphaToCoverage: false,
  polygonOffset: false,
  polygonOffsetFactor: 0,
  polygonOffsetUnits: 0,
  polygonOffsetClamp: 0,
  stencilWrite: false,
  stencilRef: 0,
  stencilReadMask: 255,
  stencilWriteMask: 255,
  stencilFunc: 'always',
  stencilFail: 'keep',
  stencilZFail: 'keep',
  stencilZPass: 'keep',
  wireframe: false,
};
const flag = (v: unknown, label: string): boolean => {
  if (typeof v !== 'boolean') throw new TypeError(`Material ${label} must be a boolean; set true or false`);
  return v;
};
const oneOf = (list: readonly string[], kind: string) => (v: unknown, label: string) => {
  if (!list.includes(v as string)) throw new TypeError(`Material ${label} is invalid; set ${kind}`);
  return v;
};
const rasterChecks: Record<keyof Raster, (v: never, label: string) => unknown> = {
  blending: oneOf(['normal', 'additive', 'multiply', 'none'], "'normal', 'additive', 'multiply' or 'none'"),
  depthWrite: (v, label) => (v === undefined ? v : flag(v, label)),
  depthTest: flag,
  colorWrite: flag,
  alphaToCoverage: flag,
  polygonOffset: flag,
  polygonOffsetFactor: rasterFloat,
  polygonOffsetUnits: (v: number) => {
    if (typeof v !== 'number')
      throw new TypeError(
        'Material polygonOffsetUnits must be a number; set an integer between -2147483647 and 2147483647',
      );
    if (!Number.isInteger(v) || Math.abs(v) > 0x7fffffff)
      throw new RangeError(
        'Material polygonOffsetUnits is out of range; set an integer between -2147483647 and 2147483647',
      );
    return v;
  },
  polygonOffsetClamp: rasterFloat,
  stencilWrite: flag,
  stencilRef: rasterMask,
  stencilReadMask: rasterMask,
  stencilWriteMask: rasterMask,
  stencilFunc: oneOf(stencilFunctions, 'a WebGPU comparison name'),
  stencilFail: oneOf(stencilOperations, 'a WebGPU stencil operation name'),
  stencilZFail: oneOf(stencilOperations, 'a WebGPU stencil operation name'),
  stencilZPass: oneOf(stencilOperations, 'a WebGPU stencil operation name'),
  wireframe: flag,
};
function distanceRange(near: number, far: number): void {
  finiteFloat(near, 'nearDistance');
  finiteFloat(far, 'farDistance');
  if (near < 0 || Math.fround(far) <= Math.fround(near))
    throw new RangeError('Material distance bounds must satisfy 0 <= nearDistance < farDistance as float32');
}
// glTF extension of each physical option (the exported material names them).
const extensions: Record<keyof PhysicalOptions, string> = {
  clearcoat: 'clearcoat',
  clearcoatRoughness: 'clearcoat',
  clearcoatMap: 'clearcoat',
  clearcoatRoughnessMap: 'clearcoat',
  clearcoatNormalMap: 'clearcoat',
  clearcoatNormalScale: 'clearcoat',
  sheenColor: 'sheen',
  sheenRoughness: 'sheen',
  sheenColorMap: 'sheen',
  sheenRoughnessMap: 'sheen',
  specularIntensity: 'specular',
  specularColor: 'specular',
  specularIntensityMap: 'specular',
  specularColorMap: 'specular',
  anisotropy: 'anisotropy',
  anisotropyRotation: 'anisotropy',
  anisotropyMap: 'anisotropy',
  iridescence: 'iridescence',
  iridescenceIOR: 'iridescence',
  iridescenceThicknessRange: 'iridescence',
  iridescenceMap: 'iridescence',
  iridescenceThicknessMap: 'iridescence',
  ior: 'ior',
  dispersion: 'dispersion',
  transmission: 'transmission',
  transmissionMap: 'transmission',
  thicknessMap: 'volume',
  thickness: 'volume',
  attenuationColor: 'volume',
  attenuationDistance: 'volume',
};
// '#rrggbb', '#rgb' and 0xrrggbb are sRGB (math's parseColor); arrays are linear [r, g, b] or [r, g, b, a], each 0-1.
const linear = (c: ColorInput, label: string): number[] => {
  if (typeof c === 'number' && !(Number.isInteger(c) && c >= 0 && c <= 0xffffff))
    throw new RangeError(`Material ${label} number must be a 0xrrggbb sRGB colour; set 0x000000 through 0xffffff`);
  const v =
    typeof c === 'number' || (typeof c === 'string' && hexColor(c))
      ? (parseColor(c) as number[])
      : Array.isArray(c)
        ? [...c]
        : [];
  if (v.length < 3 || v.length > 4)
    throw new TypeError(
      `Invalid material ${label}; set '#rrggbb', '#rgb', 0xrrggbb or linear [r, g, b] with components 0-1`,
    );
  v.forEach((x) => unit(x, label));
  return v;
};
/** The `set` of live colours by label: one function per label, so all colours of a label keep one hidden class. */
const colorSetters = new Map<string, (this: number[], input: ColorInput) => number[]>();
/** `values` with a `set(input)` that writes the parsed colour into it (opacity only from a four-component array). */
function liveColor(values: number[], label: string): LiveColor {
  let set = colorSetters.get(label);
  if (!set)
    colorSetters.set(
      label,
      (set = function (this: number[], input: ColorInput) {
        const v = linear(input, label);
        for (let k = 0; k < Math.min(v.length, this.length); k++) this[k] = v[k];
        return this;
      }),
    );
  return Object.defineProperty(values, 'set', { value: set }) as LiveColor;
}
// Lambert and Blinn-Phong rewrite gltf-pro's direct and hemisphere terms in place, so every lighting hook point
// (direct+ambient(s), var color=, fn ambient, the tone-map line) and the shadows, fog and SSAO hooks stay. Radiance is
// scaled as on the standard path: the diffuse BRDF base/pi times n.l times the light's irradiance, the hemisphere times
// base. Blinn-Phong (Blinn 1977) is the microfacet BRDF D*F*G/(4 n.l n.v) with Blinn's distribution normalised over
// projected microfacet area, D = (n+2)/(2 pi) (n.h)^n, the implicit G = n.l n.v and F = the specular colour, which
// leaves (n+2)/(8 pi) (n.h)^n * specular. margoFront and margoAmbientLayers are the layered hook interface
// (shared/pbr-hooks.js): clustered point and spot lights get these same BRDFs (`litShader`); other local-light hooks
// (area lights) shade the surface as a dielectric of the matching microfacet roughness (Walter et al. 2007: Beckmann
// alpha = sqrt(2/(n+2)), roughness = sqrt(alpha); Lambert is roughness 1), and an ambient hook (IBL, probes) keeps only
// its diffuse part, the term on the surface minus the term on a black surface.
// Normalisation (n+2)/(8 pi): Akenine-Moller et al., Real-Time Rendering; Hoffman 2010 SIGGRAPH course notes. The
// hemisphere ambient (ground (0.35, 0.3, 0.25) to sky 1) is a Margo design choice; the margoFront roughness floor 0.045
// is the minimum perceptual roughness of the Filament design document (published engine standard).
const phongLobe = (n: string) => `mat_phong.rgb*(mat_phong.w+2)/25.13274123*pow(max(dot(${n},h),0.0001),mat_phong.w)`;
const litEdits = (phong: boolean): [RegExp | string, string][] => [
  [
    /fn hemisphere_ambient\(s:Surface\)->vec3f \{[^}]*\}/,
    'fn hemisphere_ambient(s:Surface)->vec3f {return s.base.rgb*mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w*s.occlusion;}',
  ],
  [
    /fn direct_light\(s:Surface,v:vec3f,l:vec3f\)->vec3f \{[^}]*\}/,
    `fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {
  let nl=clamp(dot(s.n,l),0.0,1.0);${phong ? `\n  let h=(v+l)/max(length(v+l),0.0001); let spec=${phongLobe('s.n')};` : ''}
  return (s.base.rgb/3.14159265${phong ? '+spec' : ''})*nl*f.radiance.rgb*f.light.w;
}`,
  ],
  [
    '@fragment fn fragment(',
    `fn margoFront(s:Surface)->Surface {var o=s; o.metal=0; o.roughness=${phong ? 'max(pow(2/(mat_phong.w+2),0.25),0.045)' : '1.0'}; return o;}
fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}
fn margoAmbientLayers(i:Out,s:Surface,v:vec3f)->vec3f {var o=margoFront(s); let d=margoAmbientTerm(i,o,v); o.base=vec4f(vec3f(0),o.base.a); return d-margoAmbientTerm(i,o,v);}
@fragment fn fragment(`,
  ],
  // Auxiliary entries (G-buffer, ambient) keep the beauty bind group layout.
  ...(phong
    ? [
        ['fn surface(i:Out,front:bool)->Surface {', 'fn surface(i:Out,front:bool)->Surface {\n  _=mat_phong;'] as [
          string,
          string,
        ],
      ]
    : []),
];
const outputs: Record<Exclude<Shading, 'standard' | 'depth' | 'distance' | 'lambert' | 'phong' | 'toon'>, string> = {
  basic: 'return vec4f(mat_out(s.base.rgb+s.emissive),alpha);',
  normal: 'return vec4f(normalize((f.view*vec4f(s.n,0)).xyz)*0.5+0.5,alpha);',
  // Lit-sphere lookup (Sloan et al. 2001) by the view-space normal, in a frame facing the eye from the shaded point (so
  // the image does not slide toward the screen edges) with a level right axis: right = +Y x eye, up = eye x right.
  // Eye along +/-Y has no level frame and falls back to the view axes. uv = 0.5 + 0.49 d keeps the disc's rim one
  // percent inside the image, clear of the texture border.
  matcap:
    'let mat_n=normalize((f.view*vec4f(s.n,0)).xyz);let mat_e=normalize(-(f.view*vec4f(i.position,1)).xyz);let mat_x=vec3f(mat_e.z,0.0,-mat_e.x);let mat_level=dot(mat_x,mat_x)>0.0000000001;let mat_r=select(vec3f(1,0,0),mat_x*inverseSqrt(max(dot(mat_x,mat_x),0.0000000001)),mat_level);let mat_u=select(vec3f(0,1,0),cross(mat_e,mat_r),mat_level);return vec4f(mat_out(s.base.rgb*textureSample(mat_matcap,mat_matcapS,vec2f(0.5)+0.49*vec2f(dot(mat_n,mat_r),dot(mat_n,mat_u))).rgb),alpha);',
};
const encode =
  'fn mat_out(c:vec3f)->vec3f {if(f.settings.w>0.5){return c;}let x=clamp(c,vec3f(0),vec3f(1));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}';
const patched = new Map<string, Map<string, string>>();
/** A material's GPU state for one engine: `buffer` its shading's uniform, `features` the feature uniform (features.ts). */
type MapState = {
  refs: number;
  device?: GPUDevice;
  buffer?: GPUBuffer;
  /** The clipping-plane uniform (section layout) and its binding, kept while the buffer lives. */
  clip?: GPUBuffer;
  clipBinding?: GPUBufferBinding;
  clipData?: Float32Array;
  values?: Float32Array;
  features?: GPUBuffer;
  featureData?: Float32Array;
  /** The surface-feature uniform (surface-features.ts MargoSurface) and its values. */
  surface?: GPUBuffer;
  surfaceData?: Float32Array;
  /** The envMap uniform (env-map.ts MargoEnv) and its values. */
  env?: GPUBuffer;
  envData?: Float32Array;
  displacement?: { buffer: GPUBuffer; view: GPUTextureView; sampler: GPUSampler };
  castMask?: CastMask;
  /** The uniforms watched for their device's loss, by field (`watchUniformLost`). */
  lost?: Map<UniformField, LostUniform>;
};
/** gltf-pro `PBRMaterial.castMask`, kept and refilled per material and owner: read for every caster, every pass. */
type CastMask = {
  view: GPUTextureView;
  sampler: GPUSampler;
  texCoord: 0 | 1;
  transform: Float32Array;
  opacity?: { buffer: GPUBuffer; view: GPUTextureView; sampler: GPUSampler };
};
const mapStates = new WeakMap<Material, Map<object, MapState>>(),
  disposedMaterials = new WeakSet<Material>();
/** Throws for a disposed material: meshes may not start drawing one. */
function usable(m: Material): void {
  if (disposedMaterials.has(m))
    throw new MargoError('disposed', 'Material is disposed; create a new Material or clone() it before disposing');
}
/** A field copy for clone/copy: arrays and plain objects are duplicated, everything else (textures, nodes) shared. */
const duplicate = (v: unknown): unknown =>
  Array.isArray(v) ? v.slice() : v && Object.getPrototypeOf(v) === Object.prototype ? { ...v } : v;
let baseKeys: readonly string[] | undefined;
function mapState(m: Material, owner: object): MapState {
  let states = mapStates.get(m);
  if (!states) mapStates.set(m, (states = new Map()));
  let state = states.get(owner);
  if (!state) states.set(owner, (state = { refs: 0 }));
  return state;
}
function retainMaps(m: Material, engine: Engine): () => void {
  const state = mapState(m, engine);
  state.refs++;
  return () => {
    if (--state.refs) return;
    // Bind groups made with these buffers must not be reused (`MaterialShading.version`).
    m['changes'] = changeStamp();
    state.buffer?.destroy();
    state.features?.destroy();
    state.surface?.destroy();
    state.env?.destroy();
    state.clip?.destroy();
    unwatchUniforms(state);
    mapStates.get(m)?.delete(engine);
  };
}
type UniformField = 'buffer' | 'features' | 'surface' | 'env' | 'clip';
type LostUniform = { state: MapState; field: UniformField; buffer: GPUBuffer; device: GPUDevice };
// The material uniforms on each device, destroyed once when it is lost. One reaction per device over this set, which a
// material's state leaves when its last mesh goes or it is disposed: one reaction per uniform kept every released
// state and its buffers alive as long as the device (docs/known-bugs.md).
const lostUniforms = new WeakMap<GPUDevice, Set<LostUniform>>();
function watchUniformLost(state: MapState, field: UniformField, device: GPUDevice, buffer: GPUBuffer): void {
  let set = lostUniforms.get(device);
  if (!set) {
    const watching = (set = new Set());
    lostUniforms.set(device, watching);
    void device.lost?.then(() => {
      for (const u of watching)
        if (u.state[u.field] === u.buffer) {
          u.buffer.destroy();
          u.state[u.field] = undefined;
        }
      watching.clear();
    });
  }
  const old = state.lost?.get(field);
  if (old) lostUniforms.get(old.device)?.delete(old);
  const entry = { state, field, buffer, device };
  set.add(entry);
  (state.lost ??= new Map()).set(field, entry);
}
/** The state's uniforms go: none is watched for a device loss any more. */
function unwatchUniforms(state: MapState): void {
  for (const u of state.lost?.values() ?? []) lostUniforms.get(u.device)?.delete(u);
  state.lost?.clear();
}
function materialBuffer(
  m: Material,
  device: GPUDevice,
  owner: object,
  size: number,
  field: UniformField = 'buffer',
): GPUBuffer {
  const state = mapState(m, owner);
  if (state.device !== device || !state[field]) {
    state[field]?.destroy();
    state.device = device;
    // A new buffer is a new binding: bind groups made with the old one must be made again (`MaterialShading.version`).
    m['changes'] = changeStamp();
    const buffer = (state[field] = device.createBuffer({
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    watchUniformLost(state, field, device, buffer);
  }
  return state[field];
}
const lit: readonly Shading[] = ['standard', 'lambert', 'phong', 'toon'];
/** The feature maps `m` draws now; a lightMap means nothing to normal, matcap, depth and distance output. */
function featureMapsUsed(m: Material): boolean[] {
  const maps = m['featureTextures'];
  return [!!maps[0], !!maps[1], !!maps[2], !!maps[3] && (m.shading === 'basic' || lit.includes(m.shading))];
}
/**
 * The feature letters (features.ts) `m` uses now on gltf-pro shader `code`: its shader variant. An extension lobe
 * sampling a tangent-space map (clearcoat(), materialLobes anisotropy, a node graph's normalMap) calls the shared
 * frame from declarations placed ahead of its definition, so it takes `n` too.
 */
function featureKey(m: Material, code: string): string {
  const [alpha, bump, displacement, light] = featureMapsUsed(m),
    first = code.indexOf('margoCotangentFrame('),
    lobeFrame = first > 2 && !code.startsWith('fn ', first - 3);
  return (
    (alpha ? 'a' : '') +
    (bump ? 'b' : '') +
    (displacement ? 'd' : '') +
    (light ? (m.shading === 'basic' ? 'u' : 'l') : '') +
    (m.flatShading && m.shading !== 'basic' && m.shading !== 'depth' && m.shading !== 'distance' ? 'f' : '') +
    (m.vertexColors ? '' : 'v') +
    (lit.includes(m.shading) ? (m.fog ? '' : 'g') + (m.toneMapped ? '' : 't') : '') +
    (m.normalMap ||
    m.clearcoatNormalMap ||
    m.extensions.includes('anisotropy') ||
    lobeFrame ||
    m['added'].some((v) => v.tangentFrame)
      ? 'n'
      : '') +
    surfaceKey(m) +
    (m.dithering && !unencoded.includes(m.shading) ? 'q' : '')
  );
}
/** Shadings that write data rather than a colour for the screen, so output dithering has nothing to do. */
const unencoded: readonly Shading[] = ['normal', 'depth', 'distance'];
/** The surface maps (surface-features.ts bindings 171-174), in uniform-row order. */
const surfaceMaps = ['parallaxMap', 'subsurfaceThicknessMap'] as const;
const parallaxModes: readonly ParallaxMode[] = ['offset', 'occlusion', 'relief'];
/** Shadings the subsurface terms light (their fragment keeps gltf-pro's directional-light line). */
const scattering: readonly Shading[] = ['standard', 'lambert', 'phong'];
/** The surface features (surface-features.ts) `m` uses now: parallax, triplanar, subsurface and its thickness map. */
function surfaceUsed(m: Material): readonly [boolean, boolean, boolean, boolean] {
  const maps = m['surfaceTextures'],
    subsurface = m.subsurface > 0 && scattering.includes(m.shading);
  return [!!maps[0], m.triplanar, subsurface, subsurface && !!maps[1]];
}
/** The feature letters of the surface features `m` uses: `p` parallax, `x` triplanar, `s` subsurface, `k` its map. */
function surfaceKey(m: Material): string {
  const [parallax, triplanar, subsurface, thickness] = surfaceUsed(m);
  return (parallax ? 'p' : '') + (triplanar ? 'x' : '') + (subsurface ? 's' : '') + (thickness ? 'k' : '');
}
/** The surface uniform of `m` for `owner`, written with its current values. */
function surfaceUniform(m: Material, device: GPUDevice, owner: object): GPUBuffer {
  const buffer = materialBuffer(m, device, owner, surfaceFloats * 4, 'surface'),
    data = (mapState(m, owner).surfaceData ??= new Float32Array(surfaceFloats));
  data.set(m['surfaceValues']);
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
/** Surface map `k`'s view and sampler (0 parallax, 1 thickness); one still loading reads white (no relief, full thickness). */
const surfaceTexture = (m: Material, k: number, device: GPUDevice) =>
  m['surfaceTextures'][k]!.sampled(device, false, surfaceMaps[k]) ?? fallback(device, 0);
/** The feature uniform of `m` for `owner`, written with its current values. */
function featureUniform(m: Material, device: GPUDevice, owner: object): GPUBuffer {
  const buffer = materialBuffer(m, device, owner, 144, 'features'),
    data = (mapState(m, owner).featureData ??= new Float32Array(36));
  data.set(m['featureValues']);
  // Lambertian response: radiance = irradiance / pi (Lambert).
  if (m.lightMapResponse === 'lambertian') data[3] = m.lightMapIntensity / Math.PI;
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
/** Feature map `k`'s view and sampler; a map still loading reads white (alpha, bump) or black (displacement, light). */
const featureTexture = (m: Material, k: number, device: GPUDevice) =>
  m['featureTextures'][k]!.sampled(device, k === 3, featureMaps[k]) ?? fallback(device, k < 2 ? 0 : 3);
/** `entries` plus the feature uniform and maps `m` uses now (none for a material without features). */
function featureBindings(m: Material, device: GPUDevice, owner: object, entries: GPUBindGroupEntry[]) {
  const maps = featureMapsUsed(m),
    [parallax, triplanar, subsurface, thickness] = surfaceUsed(m),
    mapped = maps.some(Boolean);
  if (!mapped && !parallax && !triplanar && !subsurface) return entries;
  const out = [...entries];
  if (mapped) out.push({ binding: 198, resource: { buffer: featureUniform(m, device, owner) } });
  maps.forEach((used, k) => {
    if (!used) return;
    const [view, sampler] = featureTexture(m, k, device);
    out.push({ binding: 180 + k * 2, resource: view }, { binding: 181 + k * 2, resource: sampler });
  });
  if (parallax || triplanar || subsurface)
    out.push({ binding: 170, resource: { buffer: surfaceUniform(m, device, owner) } });
  for (const [used, k] of [
    [parallax, 0],
    [thickness, 1],
  ] as const)
    if (used) {
      const [view, sampler] = surfaceTexture(m, k, device);
      out.push({ binding: 171 + k * 2, resource: view }, { binding: 172 + k * 2, resource: sampler });
    }
  return out;
}
/** What shadow casters bind to displace `m` like its beauty shader (gltf-pro `PBRMaterial.displacement`), kept while the same. */
function displacementOf(m: Material, device: GPUDevice | null | undefined, owner: object) {
  if (!m.displacementMap || !device) return undefined;
  const state = mapState(m, owner),
    buffer = featureUniform(m, device, owner),
    [view, sampler] = featureTexture(m, 2, device),
    last = state.displacement;
  return last?.buffer === buffer && last.view === view && last.sampler === sampler
    ? last
    : (state.displacement = { buffer, view, sampler });
}
/**
 * The map and alphaMap of `m` as a pass other than its colour pass binds them. Triplanar projects the map from world
 * space, which such a pass's UVs cannot follow: it keeps its whole surface (README).
 */
function surfaceMask(m: Material, device: GPUDevice | null | undefined, owner: object): CastMask | undefined {
  if (!device || m.triplanar || (!m.map && !m.alphaMap)) return undefined;
  const state = mapState(m, owner),
    [view, sampler] = m.map?.sampled(device, true, 'map') ?? fallback(device, 0),
    mask = (state.castMask ??= { view, sampler, texCoord: 0, transform: new Float32Array(8) }),
    rows = m.uvt.length >= 8 ? m.uvt : m['uvDefault'];
  mask.view = view;
  mask.sampler = sampler;
  for (let k = 0; k < 8; k++) mask.transform[k] = rows[k];
  mask.texCoord = rows[3] > 0.5 ? 1 : 0;
  if (m.alphaMap) {
    const buffer = featureUniform(m, device, owner),
      [view, sampler] = featureTexture(m, 0, device),
      last = mask.opacity;
    if (last?.buffer !== buffer || last.view !== view || last.sampler !== sampler)
      mask.opacity = { buffer, view, sampler };
  } else delete mask.opacity;
  return mask;
}
/** What shadow casters cut `m` out with: only `alphaTest` cuts, so an opaque or blended caster's draw does not change. */
const castMaskOf = (m: Material, device: GPUDevice | null | undefined, owner: object): CastMask | undefined =>
  m.settings[0] === 1 ? surfaceMask(m, device, owner) : undefined;
/** What picking tests `m` with: a blended material has holes too, where its coverage is 0. */
const pickMaskOf = (m: Material, device: GPUDevice | null | undefined, owner: object): CastMask | undefined =>
  m.settings[0] !== 0 ? surfaceMask(m, device, owner) : undefined;
/** The clipping-plane uniform of `m` for `owner` (section layout: 6 planes, count in settings.x), written now. */
function clipUniform(m: Material, device: GPUDevice, owner: object): GPUBufferBinding {
  const buffer = materialBuffer(m, device, owner, 112, 'clip'),
    state = mapState(m, owner),
    data = (state.clipData ??= new Float32Array(28)),
    planes = m['clipping'];
  data.fill(0);
  data.set(planes);
  data[24] = planes.length / 4;
  data[25] = +m.clipIntersection;
  device.queue.writeBuffer(buffer, 0, data);
  if (state.clipBinding?.buffer !== buffer) state.clipBinding = { buffer };
  return state.clipBinding;
}
/** What shadow casters bind to clip `m` like its beauty shader (gltf-pro `PBRMaterial.clip`), or undefined. */
function clipOf(m: Material, device: GPUDevice | null | undefined, owner: object) {
  return device && m['clipping'].length && m.clipShadows ? clipUniform(m, device, owner) : undefined;
}
/** What passes that follow the surface bind to clip `m`, whether or not its shadows are clipped (gltf-pro `surfaceClip`). */
function surfaceClipOf(m: Material, device: GPUDevice | null | undefined, owner: object) {
  return device && m['clipping'].length ? clipUniform(m, device, owner) : undefined;
}
const surfaceAnchor = 'if(!facing&&f.settings.z<0.5){discard;}';
/**
 * `code` discarding what the material's planes cut away: in every fragment entry, and in gltf-pro's `surface()` so
 * fragments appended later (the SSAO occlusion output) clip too.
 */
/** Whether `m`'s planes may cut in the rasterizer on `device`. Clip distances cut a union; an intersection stays on discard. */
const hardwareClip = (m: Material, device: GPUDevice | null | undefined): boolean =>
  !m.clipIntersection && !!device?.features?.has('clip-distances');
/**
 * Whether the vertex stage of `code` has room for clip distances: six take two of the device's inter-stage slots, and
 * instanced drawing passes one more variable. Otherwise, as with an eye's three, the planes stay on discard.
 */
function roomForDistances(code: string, device: GPUDevice): boolean {
  const fields = /struct Out \{[^}]*\}/.exec(code)?.[0];
  if (!fields || !code.includes('var o:Out;')) return false;
  const top = Math.max(...[...fields.matchAll(/@location\((\d+)\)/g)].map((match) => +match[1]));
  return top + 4 <= device.limits.maxInterStageShaderVariables;
}
function clipShader(code: string, group: number): string {
  const out = sectionShader(code, group, 199, 'materialClip');
  return out.replace(surfaceAnchor, clipStatement('materialClip') + surfaceAnchor);
}
function mapped(m: Material): boolean {
  return !!m.physical && (m.physical.length > 12 || mapSlots.slice(5).some((k) => m[k] != null));
}
function mapPlan(m: Material) {
  const textures: { texture: Texture; srgb: boolean; fallback: number }[] = [],
    samplers: Texture[] = [];
  const slots = mapSlots.map((k, i): readonly [number, number] | null => {
    const texture = m[k];
    if (!texture) return null;
    if (!(texture instanceof Texture)) throw new TypeError(`Material ${k} must be a Texture; pass a Texture instance.`);
    const srgb = texture.options.colorSpace ? texture.options.colorSpace === 'srgb' : [0, 4, 9, 12].includes(i);
    const fallback = i === 2 || i === 7 ? 1 : i === 15 ? 2 : 0,
      pending = !texture.width || !texture.height || ('readyState' in texture.source && texture.source.readyState < 2);
    let t = textures.findIndex(
        (v) => v.texture === texture && v.srgb === srgb && (!pending || v.fallback === fallback),
      ),
      s = samplers.indexOf(texture);
    if (t < 0) {
      t = textures.length;
      textures.push({ texture, srgb, fallback });
    }
    if (s < 0) {
      s = samplers.length;
      samplers.push(texture);
    }
    return [t, s];
  });
  return { textures, samplers, slots };
}
/** True for a standard material with no texture at all: it draws {@link bareShader} and binds no textures. */
function bare(m: Material): boolean {
  return (
    !m.physical &&
    m.shading === 'standard' &&
    slots.every((k) => m[k] == null) &&
    !featureMapsUsed(m).some(Boolean) &&
    !m.envMap
  );
}
const bareCode = new Map<string, string>();
/**
 * gltf-pro's shader for a standard material without maps: each texture read becomes the value of the texture a missing
 * map stands for (white; the flat normal (0.5, 0.5, 1), exactly what the defaults hold), and gltf-pro's group-1
 * textures are dropped. Without it such a material read ten textures per fragment (gltf-pro's white defaults times
 * this package's). The tangent frame stays: extension lobes on the primitive may still use it.
 */
function bareShader(source: string): string {
  let out = bareCode.get(source);
  if (out !== undefined) return out;
  const dropped: string[] = [];
  out = source.replace(/@group\(1\) @binding\(\d+\) var (\w+):[^;]+;\n?/g, (_, name: string) => {
    dropped.push(name);
    return '';
  });
  let count = 0;
  const edit = (from: string | RegExp, to: string) => {
    const next = out!.replace(from, () => to);
    if (next !== out) count++;
    out = next;
  };
  for (const map of ['base', 'mr', 'ao', 'emissive'])
    edit(new RegExp(`textureSample\\(${map}Map,${map}Sampler,uv\\(i,f\\.coords[AB]\\.[xyzw]\\)\\)`, 'g'), 'vec4f(1)');
  edit(/textureSample\(normalMap,normalSampler,uv\(i,f\.coordsA\.z\)\)/g, 'vec4f(0.5,0.5,1,1)');
  // gltf-pro's KHR physical and extended variants read their extension maps (slots 5-17) from group 1 too; a missing
  // one holds white, the clearcoat normal map a flat normal (gltf-pro's normalMaps).
  out = out.replace(/textureSample\((\w+)Map,\1Sampler,uv\(i,\d+\)\)/g, (_, name: string) =>
    name === 'clearcoatNormal' ? 'vec4f(0.5,0.5,1,1)' : 'vec4f(1)',
  );
  if (count !== 5 || dropped.some((name) => new RegExp(`\\b${name}\\b`).test(out!)))
    throw new MargoError(
      'unsupported',
      'Materials require the standard gltf-pro PBR shader; draw the mesh with gltf-pro',
    );
  if (bareCode.size >= 64) bareCode.clear();
  bareCode.set(source, out);
  return out;
}
/** Rewrites gltf-pro's beauty shader to multiply in this package's maps (group 2, bindings 32-43) and, for non-standard shading, return early. */
export function materialShader(source: string, group: number, shading: Shading): string {
  let cache = patched.get(source);
  const key = shading + group,
    cached = cache?.get(key);
  if (cached) return cached;
  if (shading === 'depth' || shading === 'distance') {
    const output = depthDistanceShader(materialShader(source, group, 'standard'), group, shading);
    patched.get(source)!.set(key, output);
    return output;
  }
  let count = 0;
  let code = source
    .replace(
      /textureSample\((baseMap|mrMap|aoMap|emissiveMap),(\w+),(uv\(i,f\.coords[AB]\.[xyzw]\))\)/g,
      (_, map, sampler, uv) => {
        count++;
        return `(textureSample(mat_${map},mat_${map}S,${uv})*textureSample(${map},${sampler},${uv}))`;
      },
    )
    .replace(/textureSample\(normalMap,normalSampler,(uv\(i,f\.coordsA\.z\))\)\.xyz\*2-1/, (_, uv) => {
      count++;
      return `textureSample(mat_normalMap,mat_normalMapS,${uv}).xyz*2-1+0*textureSample(normalMap,normalSampler,${uv}).xyz`;
    });
  const lit = shading === 'lambert' || shading === 'phong' || shading === 'toon',
    edits = shading === 'toon' ? toonEdits : lit ? litEdits(shading === 'phong') : [];
  if (shading !== 'standard' && !lit)
    code = code.replace(/@fragment fn fragment\([^{]*\{\s*let s=surface\(i,front\);/, (head) => {
      count++;
      return `${head}\n  let alpha=select(1.0,s.base.a,f.settings.x>1.5);\n  if(f.coordsB.w<0.5){${outputs[shading]}}`;
    });
  for (const [from, to] of edits)
    code = code.replace(from, () => {
      count++;
      return to;
    });
  if (shading === 'matcap')
    // Auxiliary entries call surface() but not the beauty fragment. Retain the same bind group layout there.
    code = code.replace('fn surface(i:Out,front:bool)->Surface {', '$&\n  _=mat_matcap;_=mat_matcapS;');
  if (count !== (shading === 'standard' ? 5 : lit ? 5 + edits.length : 6))
    throw new MargoError(
      'state',
      'Materials require the standard gltf-pro PBR shader; update @margoengine/gltf-pro to a version that matches this package.',
    );
  const declarations = names
    .slice(0, shading === 'matcap' ? 6 : 5)
    .map(
      (name, i) =>
        `@group(${group}) @binding(${32 + i * 2}) var mat_${name}:texture_2d<f32>;\n@group(${group}) @binding(${33 + i * 2}) var mat_${name}S:sampler;`,
    )
    .join('\n');
  const output =
    declarations +
    '\n' +
    (shading === 'phong' ? `@group(${group}) @binding(197) var<uniform> mat_phong:vec4f;\n` : '') +
    (shading === 'toon' ? toonDeclarations(group) : '') +
    (shading === 'basic' || shading === 'matcap' ? encode + '\n' : '') +
    code;
  if (!cache) patched.set(source, (cache = new Map()));
  cache.set(key, output);
  return output;
}
const localTerm = 'result+=' + clusterBrdf + '*nl*',
  composed = { lambert: new Map<string, string>(), phong: new Map<string, string>() };
/**
 * `code` with its lighting effects composed in (gltf-pro's `lit` hook): Lambert and Phong put their own BRDF in place of
 * clustered's per-light GGX term, so point and spot lights shade them exactly as the directional light does; a shadow
 * catcher then measures its shadows (catcher.ts). Other materials, and code without clustered lights, come back
 * unchanged.
 */
function litShader(m: Material, code: string): string {
  if (m.shading === 'toon') return toonLit(code);
  const phong = m.shading === 'phong';
  if (!phong && m.shading !== 'lambert') return code;
  const cache = composed[m.shading as 'lambert' | 'phong'];
  let out = cache.get(code);
  if (out === undefined) {
    if (cache.size >= 64) cache.clear();
    out = code.includes(localTerm)
      ? code.split(localTerm).join('result+=margoLocalBrdf(n,v,l,base)*nl*') +
        `\nfn margoLocalBrdf(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {${phong ? `let h=(v+l)/max(length(v+l),0.0001);return base/3.14159265+${phongLobe('n')};` : 'return base/3.14159265;'}}\n`
      : code;
    cache.set(code, out);
  }
  return phong ? out : catcherLit(out);
}
/** Live values: colours, scalar setters, map assignments and render state apply on the next frame to every mesh using the material. Shading is fixed. */
export class Material {
  readonly shading: Shading;
  private readonly raster: Raster = { ...rasterDefaults };
  private packing: DepthPacking = 'basic';
  private reference: readonly [number, number, number] = [0, 0, 0];
  private near = 1;
  private far = 1000;
  private readonly rgba: LiveColor;
  private readonly glow: LiveColor;
  private readonly highlight: LiveColor;
  private gloss = 30;
  /** Toon: the band count and gradient ramp. */
  private toonSteps = 3;
  private toonMap: Texture | null = null;
  /** The environment map and how it is read (env-map.ts). */
  private readonly env: {
    map: EnvMapSource | null;
    intensity: number;
    rotation: number;
    mode: 'reflection' | 'refraction';
    ratio: number;
    combine: EnvCombine;
    reflectivity: number;
  } = {
    map: null,
    intensity: 1,
    rotation: 0,
    mode: 'reflection',
    ratio: 1 / 1.5,
    combine: 'multiply',
    reflectivity: 1,
  };
  private glowScale = 1;
  /** On/off features (features.ts letters f...). */
  /** Optional features and the stamp of their last assignment (their shader text is fixed, so it names the variant). */
  private added: readonly MaterialFeature[] = [];
  private addedStamp = 0;
  private readonly switches = { flatShading: false, vertexColors: true, fog: true, toneMapped: true, dithering: false };
  /** gltf-pro layout: [roughness, metalness, normalScale, aoMapIntensity] and [alphaMode, alphaTest, side (front 0, double 1, back 2), 0]. */
  readonly factors: number[];
  readonly settings: number[];
  private blend: boolean;
  /** gltf-pro layout: two rows per map slot (offset*rotation*scale), in `MapSlot` order. */
  readonly uvt: number[] = [];
  private uvDefault = textureTransform({}, 0);
  /** The base maps in `slots` order: map, metalRoughnessMap, normalMap, aoMap, emissiveMap, matcap. */
  private readonly baseMaps: (Texture | null)[] = [null, null, null, null, null, null];
  /**
   * The change stamp (`changeStamp`) of this material's last edit: every setter, `setUVTransform` and `copy` take a
   * new one once meshes draw it (`trackChanges`), and an in-place colour write is found by `liveStamp`.
   */
  private changes = changeStamp();
  private setBaseMap(i: number, v: Texture | null): void {
    if (v != null && !(v instanceof Texture))
      throw new TypeError(`Material ${slots[i]} must be a Texture; pass a Texture instance or null.`);
    this.baseMaps[i] = v ?? null;
  }
  /** Base colour map (sRGB unless its colorSpace says otherwise), live; null for none. */
  get map(): Texture | null {
    return this.baseMaps[0];
  }
  set map(v: Texture | null) {
    this.setBaseMap(0, v);
  }
  /** glTF metallic-roughness map (G roughness, B metalness, linear), live; null for none. */
  get metalRoughnessMap(): Texture | null {
    return this.baseMaps[1];
  }
  set metalRoughnessMap(v: Texture | null) {
    this.setBaseMap(1, v);
  }
  /** Tangent-space normal map (linear), live; null for none. */
  get normalMap(): Texture | null {
    return this.baseMaps[2];
  }
  set normalMap(v: Texture | null) {
    this.setBaseMap(2, v);
  }
  /** Ambient occlusion map (R, linear), live; null for none. */
  get aoMap(): Texture | null {
    return this.baseMaps[3];
  }
  set aoMap(v: Texture | null) {
    this.setBaseMap(3, v);
  }
  /** Emissive map (sRGB), live; null for none. */
  get emissiveMap(): Texture | null {
    return this.baseMaps[4];
  }
  set emissiveMap(v: Texture | null) {
    this.setBaseMap(4, v);
  }
  /** Matcap texture (matcap shading), live; null for none. */
  get matcap(): Texture | null {
    return this.baseMaps[5];
  }
  set matcap(v: Texture | null) {
    this.setBaseMap(5, v);
  }
  /** The feature maps (features.ts `featureMaps` order). */
  private readonly featureTextures: (Texture | null)[] = [null, null, null, null];
  /** The feature uniform (features.ts): four values, then two UV rows per feature map (lightMap's on UV1). */
  private readonly featureValues: number[] = [
    1,
    1,
    0,
    1,
    ...Array(3).fill(textureTransform({}, 0)).flat(),
    ...textureTransform({}, 1),
  ];
  private lightResponse: 'multiply' | 'lambertian' = 'multiply';
  /** Clipping planes, four normalised numbers each (at most 24), and whether they clip shadows. */
  private clipping: number[] = [];
  private clipShadow = true;
  private clipAll = false;
  /**
   * Up to 6 world-space planes `[a, b, c, d]`; points with `a x + b y + c z + d < 0` are cut away in every pass that
   * draws the material (beauty, G-buffer and, with `clipShadows`, directional shadows). Reading gives normalised copies;
   * assign a new list to change them (live). Throws TypeError for a malformed plane, RangeError for more than 6.
   */
  get clippingPlanes(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.clipping.length; i += 4) out.push(this.clipping.slice(i, i + 4));
    return out;
  }
  set clippingPlanes(v: readonly (readonly number[])[]) {
    if (!Array.isArray(v)) throw new TypeError('Material clippingPlanes must be an array of [a, b, c, d] planes');
    if (v.length > 6) throw new RangeError('Material clippingPlanes holds at most 6 planes; pass fewer');
    const flat: number[] = [];
    for (const p of v) {
      if (
        !Array.isArray(p) ||
        p.length !== 4 ||
        !p.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x)))
      )
        throw new TypeError('Material clipping plane must be four finite numbers [a, b, c, d]');
      const length = Math.hypot(p[0], p[1], p[2]);
      if (!length) throw new TypeError('Material clipping plane needs a non-zero normal [a, b, c]');
      flat.push(p[0] / length, p[1] / length, p[2] / length, p[3] / length);
    }
    this.clipping = flat;
  }
  /**
   * false (default): `clippingPlanes` cut away what is behind any plane (their union). true: only what is behind every
   * plane (their intersection). Live; shadows follow.
   */
  get clipIntersection(): boolean {
    return this.clipAll;
  }
  set clipIntersection(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Material clipIntersection must be a boolean; pass true or false');
    this.clipAll = v;
  }
  /** Whether `clippingPlanes` clip this material's directional shadows too (default true), live. */
  get clipShadows(): boolean {
    return this.clipShadow;
  }
  set clipShadows(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Material clipShadows must be a boolean; pass true or false');
    this.clipShadow = v;
  }
  private setFeatureMap(k: number, v: Texture | null): void {
    if (v != null && !(v instanceof Texture))
      throw new TypeError(`Material ${featureMaps[k]} must be a Texture; pass a Texture or null`);
    this.featureTextures[k] = v ?? null;
  }
  get alphaMap(): Texture | null {
    return this.featureTextures[0];
  }
  set alphaMap(v: Texture | null) {
    this.setFeatureMap(0, v);
  }
  get bumpMap(): Texture | null {
    return this.featureTextures[1];
  }
  set bumpMap(v: Texture | null) {
    this.setFeatureMap(1, v);
  }
  get bumpScale(): number {
    return this.featureValues[0];
  }
  set bumpScale(v: number) {
    this.featureValues[0] = rasterFloat(v, 'bumpScale');
  }
  get displacementMap(): Texture | null {
    return this.featureTextures[2];
  }
  set displacementMap(v: Texture | null) {
    this.setFeatureMap(2, v);
  }
  get displacementScale(): number {
    return this.featureValues[1];
  }
  set displacementScale(v: number) {
    this.featureValues[1] = rasterFloat(v, 'displacementScale');
  }
  get displacementBias(): number {
    return this.featureValues[2];
  }
  set displacementBias(v: number) {
    this.featureValues[2] = rasterFloat(v, 'displacementBias');
  }
  get lightMap(): Texture | null {
    return this.featureTextures[3];
  }
  set lightMap(v: Texture | null) {
    this.setFeatureMap(3, v);
  }
  get lightMapIntensity(): number {
    return this.featureValues[3];
  }
  set lightMapIntensity(v: number) {
    const value = rasterFloat(v, 'lightMapIntensity');
    if (this.lightResponse === 'lambertian' && value < 0)
      throw new RangeError('Material Lambertian lightMapIntensity must be nonnegative; use physical irradiance');
    this.featureValues[3] = value;
  }
  /** The live baked-light response; Lambertian requires lit shading, a linear irradiance texture and nonnegative intensity. */
  get lightMapResponse(): 'multiply' | 'lambertian' {
    return this.lightResponse;
  }
  set lightMapResponse(v: 'multiply' | 'lambertian') {
    if (v !== 'multiply' && v !== 'lambertian')
      throw new TypeError("Material lightMapResponse must be 'multiply' or 'lambertian'; choose a supported response");
    if (v === 'lambertian') {
      if (!lit.includes(this.shading))
        throw new TypeError('Material Lambertian lightMapResponse needs lit shading; use standard, lambert or phong');
      if (this.featureValues[3] < 0)
        throw new RangeError('Material Lambertian lightMapIntensity must be nonnegative; use physical irradiance');
    }
    this.lightResponse = v;
  }
  /** The surface maps (`surfaceMaps` order): parallaxMap, subsurfaceThicknessMap. */
  private readonly surfaceTextures: (Texture | null)[] = [null, null];
  /** The surface uniform (surface-features.ts MargoSurface), at its defaults: every feature off. */
  private readonly surfaceValues: number[] = [
    0.05,
    16,
    1,
    0,
    ...textureTransform({}, 0),
    1,
    4,
    0,
    0,
    0,
    0,
    0.2,
    4,
    1,
    1,
    1,
    0.5,
    0.5,
    0,
    0,
    0,
    ...textureTransform({}, 0),
  ];
  private triplanarOn = false;
  private setSurfaceMap(k: number, v: Texture | null): void {
    if (v != null && !(v instanceof Texture))
      throw new TypeError(`Material ${surfaceMaps[k]} must be a Texture; pass a Texture or null`);
    this.surfaceTextures[k] = v ?? null;
  }
  /** Sets surface uniform value `k` to the already checked `v`. */
  private setSurface(k: number, v: number): void {
    this.surfaceValues[k] = v;
  }
  /** Height map the view ray is marched through (red, linear; 1 the surface), live; null for none. */
  get parallaxMap(): Texture | null {
    return this.surfaceTextures[0];
  }
  set parallaxMap(v: Texture | null) {
    this.setSurfaceMap(0, v);
  }
  /** Depth of `parallaxMap`'s full range in world units, finite and >= 0 (default 0.05), live. */
  get parallaxScale(): number {
    return this.surfaceValues[0];
  }
  set parallaxScale(v: number) {
    if (rasterFloat(v, 'parallaxScale') < 0)
      throw new RangeError('Material parallaxScale must be >= 0; set a depth in world units');
    this.setSurface(0, v);
  }
  /** Steps of the occlusion and relief march, an integer 1 through 64 (default 16), live. */
  get parallaxSteps(): number {
    return this.surfaceValues[1];
  }
  set parallaxSteps(v: number) {
    if (typeof v !== 'number') throw new TypeError('Material parallaxSteps must be a number; set an integer 1 to 64');
    if (!Number.isInteger(v) || v < 1 || v > 64)
      throw new RangeError('Material parallaxSteps must be an integer from 1 through 64; set one in that range');
    this.setSurface(1, v);
  }
  /** `'occlusion'` (default), `'relief'` or `'offset'`, live. */
  get parallaxMode(): ParallaxMode {
    return parallaxModes[this.surfaceValues[2]];
  }
  set parallaxMode(v: ParallaxMode) {
    const mode = parallaxModes.indexOf(v);
    if (mode < 0)
      throw new TypeError("Material parallaxMode must be 'occlusion', 'relief' or 'offset'; set one of them");
    this.setSurface(2, mode);
  }
  /** World-space triplanar projection of the UV0 maps (default false), live. */
  get triplanar(): boolean {
    return this.triplanarOn;
  }
  set triplanar(v: boolean) {
    this.triplanarOn = flag(v, 'triplanar');
  }
  /** Texture repeats per world unit of the triplanar projection, finite and > 0 (default 1), live. */
  get triplanarScale(): number {
    return this.surfaceValues[12];
  }
  set triplanarScale(v: number) {
    if (!(rasterFloat(v, 'triplanarScale') > 0))
      throw new RangeError('Material triplanarScale must be > 0; set texture repeats per world unit');
    this.setSurface(12, v);
  }
  /** Exponent of the triplanar blend weights, finite and >= 1 (default 4), live. */
  get triplanarSharpness(): number {
    return this.surfaceValues[13];
  }
  set triplanarSharpness(v: number) {
    if (rasterFloat(v, 'triplanarSharpness') < 1)
      throw new RangeError('Material triplanarSharpness must be >= 1; set 1 (soft) or more (sharper)');
    this.setSurface(13, v);
  }
  /** Subsurface scattering weight 0 through 1 (default 0: off); standard, Lambert and Phong shading. Live. */
  get subsurface(): number {
    return this.surfaceValues[16];
  }
  set subsurface(v: number) {
    unit(v, 'subsurface');
    if (v > 0 && !scattering.includes(this.shading))
      throw new TypeError('Material subsurface needs standard, lambert or phong shading; use one of those materials');
    this.setSurface(16, v);
  }
  /** `'thick'` (default) or `'thin'`, live. */
  get subsurfaceMode(): SubsurfaceMode {
    return this.surfaceValues[17] ? 'thin' : 'thick';
  }
  set subsurfaceMode(v: SubsurfaceMode) {
    if (v !== 'thick' && v !== 'thin')
      throw new TypeError("Material subsurfaceMode must be 'thick' or 'thin'; set one");
    this.setSurface(17, +(v === 'thin'));
  }
  /** Linear colour the scattered light picks up (default white); assign any colour input. Live. */
  get subsurfaceColor(): number[] {
    return this.surfaceValues.slice(20, 23);
  }
  set subsurfaceColor(c: ColorInput) {
    const v = linear(c, 'subsurfaceColor');
    this.surfaceValues.splice(20, 3, v[0], v[1], v[2]);
  }
  /** Local thickness 0 through 1 (default 0.5), times `subsurfaceThicknessMap`. Live. */
  get subsurfaceThickness(): number {
    return this.surfaceValues[23];
  }
  set subsurfaceThickness(v: number) {
    this.setSurface(23, unit(v, 'subsurfaceThickness'));
  }
  /** Local thickness map (red, linear), live; null for none. */
  get subsurfaceThicknessMap(): Texture | null {
    return this.surfaceTextures[1];
  }
  set subsurfaceThicknessMap(v: Texture | null) {
    this.setSurfaceMap(1, v);
  }
  /** Thick only: normal distortion of the light seen through, finite and >= 0 (default 0.2). Live. */
  get subsurfaceDistortion(): number {
    return this.surfaceValues[18];
  }
  set subsurfaceDistortion(v: number) {
    if (rasterFloat(v, 'subsurfaceDistortion') < 0)
      throw new RangeError('Material subsurfaceDistortion must be >= 0; set 0 for none');
    this.setSurface(18, v);
  }
  /** Thick only: exponent of the light seen through, finite and > 0 (default 4). Live. */
  get subsurfacePower(): number {
    return this.surfaceValues[19];
  }
  set subsurfacePower(v: number) {
    if (!(rasterFloat(v, 'subsurfacePower') > 0))
      throw new RangeError('Material subsurfacePower must be > 0; set 1 (broad) or more (tight)');
    this.setSurface(19, v);
  }
  /** Thick only: diffuse wrap past the terminator, 0 through 1 (default 0.5). Live. */
  get subsurfaceWrap(): number {
    return this.surfaceValues[24];
  }
  set subsurfaceWrap(v: number) {
    this.setSurface(24, unit(v, 'subsurfaceWrap'));
  }
  private readonly physicalTextures: (Texture | null)[] = Array(12).fill(null);
  private setMap(i: number, value: Texture | null): void {
    const key = mapSlots[i + 5] as keyof PhysicalOptions;
    if (value != null) {
      if (!(value instanceof Texture))
        throw new TypeError(`Material ${key} must be a Texture; pass a Texture instance.`);
      this.enable(key);
      while (this.uvt.length < mapSlots.length * 8) this.uvt.push(...this.uvDefault);
    }
    this.physicalTextures[i] = value ?? null;
  }
  get clearcoatMap(): Texture | null {
    return this.physicalTextures[0];
  }
  set clearcoatMap(v: Texture | null) {
    this.setMap(0, v);
  }
  get clearcoatRoughnessMap(): Texture | null {
    return this.physicalTextures[1];
  }
  set clearcoatRoughnessMap(v: Texture | null) {
    this.setMap(1, v);
  }
  get clearcoatNormalMap(): Texture | null {
    return this.physicalTextures[2];
  }
  set clearcoatNormalMap(v: Texture | null) {
    this.setMap(2, v);
  }
  get transmissionMap(): Texture | null {
    return this.physicalTextures[3];
  }
  set transmissionMap(v: Texture | null) {
    this.setMap(3, v);
  }
  get sheenColorMap(): Texture | null {
    return this.physicalTextures[4];
  }
  set sheenColorMap(v: Texture | null) {
    this.setMap(4, v);
  }
  get sheenRoughnessMap(): Texture | null {
    return this.physicalTextures[5];
  }
  set sheenRoughnessMap(v: Texture | null) {
    this.setMap(5, v);
  }
  get specularIntensityMap(): Texture | null {
    return this.physicalTextures[6];
  }
  set specularIntensityMap(v: Texture | null) {
    this.setMap(6, v);
  }
  get specularColorMap(): Texture | null {
    return this.physicalTextures[7];
  }
  set specularColorMap(v: Texture | null) {
    this.setMap(7, v);
  }
  get iridescenceMap(): Texture | null {
    return this.physicalTextures[8];
  }
  set iridescenceMap(v: Texture | null) {
    this.setMap(8, v);
  }
  get iridescenceThicknessMap(): Texture | null {
    return this.physicalTextures[9];
  }
  set iridescenceThicknessMap(v: Texture | null) {
    this.setMap(9, v);
  }
  get anisotropyMap(): Texture | null {
    return this.physicalTextures[10];
  }
  set anisotropyMap(v: Texture | null) {
    this.setMap(10, v);
  }
  get thicknessMap(): Texture | null {
    return this.physicalTextures[11];
  }
  set thicknessMap(v: Texture | null) {
    this.setMap(11, v);
  }
  private rotation = 0;
  /**
   * Physical materials only (set once any physical option is), gltf-pro layout: [clearcoat, clearcoatRoughness, 1,
   * transmission, specularColor rgb, specularIntensity, sheenColor rgb, sheenRoughness], and [0, ior, 0, dispersion].
   */
  readonly physical?: number[];
  readonly ext?: number[];
  /** Transmissive materials only (set once transmission or its maps are), gltf-pro layout: [thickness, transmittance per world unit rgb]. */
  readonly volume?: number[];
  /** glTF extensions (`KHR_materials_<name>`) the physical options use, in the order they were first set. */
  readonly extensions: readonly string[] = [];
  private attenuation = [1, 1, 1, Infinity];
  private readonly tinted = [0, 0, 0];
  constructor(o: MaterialOptions = {}) {
    const shading = o.shading ?? 'standard';
    for (const key of Object.keys(rasterDefaults) as (keyof Raster)[])
      if (o[key] !== undefined) this.setRaster(key, o[key]);
    if (
      !['standard', 'basic', 'normal', 'matcap', 'depth', 'distance', 'lambert', 'phong', 'toon'].includes(shading) ||
      (o.side !== undefined && !['front', 'back', 'double'].includes(o.side)) ||
      [o.transparent, o.doubleSided].some((v) => v !== undefined && typeof v !== 'boolean') ||
      (o.normalScale !== undefined &&
        (typeof o.normalScale !== 'number' || !Number.isFinite(Math.fround(o.normalScale))))
    )
      throw new TypeError('Invalid material options; check shading, side, transparent, doubleSided and normalScale.');
    for (const slot of [...mapSlots, 'matcap'] as const)
      if (o[slot] != null && !(o[slot] instanceof Texture))
        throw new TypeError(`Material ${slot} must be a Texture; pass a Texture instance.`);
    this.shading = shading;
    this.switches.toneMapped = lit.includes(shading);
    this.depthPacking = o.depthPacking === undefined ? (shading === 'distance' ? 'rgba' : 'basic') : o.depthPacking;
    if (o.referencePosition !== undefined) this.referencePosition = o.referencePosition;
    const near = o.nearDistance === undefined ? 1 : o.nearDistance,
      far = o.farDistance === undefined ? 1000 : o.farDistance;
    distanceRange(near, far);
    this.near = near;
    this.far = far;
    this.blend = o.transparent ?? false;
    const rgba = linear(o.color ?? [1, 1, 1], 'color');
    if (rgba.length === 3) rgba.push(unit(o.opacity ?? 1, 'opacity'));
    this.rgba = liveColor(rgba, 'color');
    this.glow = liveColor(linear(o.emissive ?? [0, 0, 0], 'emissive').slice(0, 3), 'emissive');
    if ((o.specular !== undefined || o.shininess !== undefined) && shading !== 'phong')
      throw new TypeError("Material specular and shininess need phong shading; set shading: 'phong'");
    this.highlight = liveColor(linear(o.specular ?? '#111111', 'specular').slice(0, 3), 'specular');
    // 30 (Margo's): the exponent whose Walter et al. 2007 GGX roughness (2/(n+2))^(1/4) is 0.5, core's default.
    this.shininess = o.shininess ?? 30;
    if ((o.steps !== undefined || o.gradientMap != null) && shading !== 'toon')
      throw new TypeError("Material steps and gradientMap need toon shading; set shading: 'toon'");
    if (o.steps !== undefined) this.steps = o.steps;
    if (o.gradientMap != null) this.gradientMap = o.gradientMap;
    for (const key of [
      'envMapIntensity',
      'envMapRotation',
      'envMapMode',
      'refractionRatio',
      'combine',
      'reflectivity',
      'envMap',
    ] as const)
      if (o[key] !== undefined) this[key] = o[key] as never;
    this.factors = [
      unit(o.roughness ?? 1, 'roughness'),
      unit(o.metalness ?? 0, 'metalness'),
      o.normalScale ?? 1,
      unit(o.aoMapIntensity ?? 1, 'aoMapIntensity'),
    ];
    this.settings = [0, unit(o.alphaTest ?? 0, 'alphaTest'), +(o.doubleSided ?? false), 0];
    if (o.side !== undefined) this.side = o.side;
    this.sync();
    this.setUVTransform(o.uvTransform ?? null);
    this.map = o.map ?? null;
    this.metalRoughnessMap = o.metalRoughnessMap ?? null;
    this.normalMap = o.normalMap ?? null;
    this.aoMap = o.aoMap ?? null;
    this.emissiveMap = o.emissiveMap ?? null;
    this.matcap = o.matcap ?? null;
    for (const key of [
      'alphaMap',
      'bumpMap',
      'bumpScale',
      'displacementMap',
      'displacementScale',
      'displacementBias',
      'lightMap',
      'lightMapIntensity',
      'lightMapResponse',
      'emissiveIntensity',
      'flatShading',
      'vertexColors',
      'fog',
      'toneMapped',
      'dithering',
      'clippingPlanes',
      'clipShadows',
      'clipIntersection',
      'parallaxMap',
      'parallaxScale',
      'parallaxMode',
      'parallaxSteps',
      'triplanar',
      'triplanarScale',
      'triplanarSharpness',
      'subsurface',
      'subsurfaceMode',
      'subsurfaceColor',
      'subsurfaceThickness',
      'subsurfaceThicknessMap',
      'subsurfaceDistortion',
      'subsurfacePower',
      'subsurfaceWrap',
      'features',
    ] as const)
      if (o[key] !== undefined) this[key] = o[key] as never;
    // Physical options enable their lobes as they are set (transmission before the volume values that need it); the
    // constructor names every extension its options use.
    const used = (Object.keys(extensions) as (keyof PhysicalOptions)[]).filter((k) => o[k] != null);
    if (o.dispersion === null) throw new RangeError('Material dispersion must be a finite number >= 0');
    if (used.length && shading !== 'standard') throw new TypeError('Physical options need standard shading');
    this.extensions = [
      ...new Set([...used.map((k) => extensions[k]), ...(o.thicknessMap != null ? ['transmission'] : [])]),
    ];
    Object.assign(this, Object.fromEntries(used.map((k) => [k, o[k]])));
  }
  /** Beauty-pass blending (default 'normal'). It and the depth, colour-write, polygon-offset and stencil state below are live: a change selects the matching pipeline on the next draw. */
  get blending(): Blending {
    return this.raster.blending;
  }
  set blending(v: Blending) {
    this.setRaster('blending', v);
  }
  get depthWrite(): boolean | undefined {
    return this.raster.depthWrite;
  }
  set depthWrite(v: boolean | undefined) {
    this.setRaster('depthWrite', v);
  }
  get depthTest(): boolean {
    return this.raster.depthTest;
  }
  set depthTest(v: boolean) {
    this.setRaster('depthTest', v);
  }
  get alphaToCoverage(): boolean {
    return this.raster.alphaToCoverage;
  }
  set alphaToCoverage(v: boolean) {
    this.setRaster('alphaToCoverage', v);
  }
  get colorWrite(): boolean {
    return this.raster.colorWrite;
  }
  set colorWrite(v: boolean) {
    this.setRaster('colorWrite', v);
  }
  get polygonOffset(): boolean {
    return this.raster.polygonOffset;
  }
  set polygonOffset(v: boolean) {
    this.setRaster('polygonOffset', v);
  }
  get polygonOffsetFactor(): number {
    return this.raster.polygonOffsetFactor;
  }
  set polygonOffsetFactor(v: number) {
    this.setRaster('polygonOffsetFactor', v);
  }
  get polygonOffsetUnits(): number {
    return this.raster.polygonOffsetUnits;
  }
  set polygonOffsetUnits(v: number) {
    this.setRaster('polygonOffsetUnits', v);
  }
  get polygonOffsetClamp(): number {
    return this.raster.polygonOffsetClamp;
  }
  set polygonOffsetClamp(v: number) {
    this.setRaster('polygonOffsetClamp', v);
  }
  get stencilWrite(): boolean {
    return this.raster.stencilWrite;
  }
  set stencilWrite(v: boolean) {
    this.setRaster('stencilWrite', v);
  }
  get stencilRef(): number {
    return this.raster.stencilRef;
  }
  set stencilRef(v: number) {
    this.setRaster('stencilRef', v);
  }
  get stencilReadMask(): number {
    return this.raster.stencilReadMask;
  }
  set stencilReadMask(v: number) {
    this.setRaster('stencilReadMask', v);
  }
  get stencilWriteMask(): number {
    return this.raster.stencilWriteMask;
  }
  set stencilWriteMask(v: number) {
    this.setRaster('stencilWriteMask', v);
  }
  get stencilFunc(): GPUCompareFunction {
    return this.raster.stencilFunc;
  }
  set stencilFunc(v: GPUCompareFunction) {
    this.setRaster('stencilFunc', v);
  }
  get stencilFail(): GPUStencilOperation {
    return this.raster.stencilFail;
  }
  set stencilFail(v: GPUStencilOperation) {
    this.setRaster('stencilFail', v);
  }
  get stencilZFail(): GPUStencilOperation {
    return this.raster.stencilZFail;
  }
  set stencilZFail(v: GPUStencilOperation) {
    this.setRaster('stencilZFail', v);
  }
  get stencilZPass(): GPUStencilOperation {
    return this.raster.stencilZPass;
  }
  set stencilZPass(v: GPUStencilOperation) {
    this.setRaster('stencilZPass', v);
  }
  /** Draws triangle edges instead of filled surfaces (default false), live. */
  get wireframe(): boolean {
    return this.raster.wireframe;
  }
  set wireframe(v: boolean) {
    this.setRaster('wireframe', v);
  }
  private setRaster<K extends keyof Raster>(key: K, v: unknown): void {
    this.raster[key] = rasterChecks[key](v as never, key) as Raster[K];
    renderStates.delete(this);
  }
  /**
   * Base colour, linear RGBA with opacity in [3]: the live array every mesh reads. `color.set(input)` and
   * `color = input` take '#rrggbb', '#rgb', 0xrrggbb (sRGB) or linear [r, g, b] (keeping opacity) or [r, g, b, a];
   * writing elements in place also works.
   */
  get color(): LiveColor {
    return this.rgba;
  }
  set color(v: ColorInput) {
    this.rgba.set(v);
  }
  /** Emissive colour, linear RGB, live like `color`. */
  get emissive(): LiveColor {
    return this.glow;
  }
  set emissive(v: ColorInput) {
    this.glow.set(v);
  }
  /** Face normals instead of interpolated ones (default false), for lit, normal and matcap shading. */
  /** The optional features this material uses, in the order their shader edits apply. Assign a new list to change them (live). */
  get features(): readonly MaterialFeature[] {
    return this.added;
  }
  set features(list: readonly MaterialFeature[]) {
    if (!Array.isArray(list) || list.some((v) => typeof v?.name !== 'string' || typeof v.shader !== 'function'))
      throw new TypeError('Material features must be an array of features; pass entries such as [alphaHash()]');
    if (new Set(list.map((v) => v.name)).size !== list.length)
      throw new TypeError('Material features must have different names; pass each kind of feature once');
    const before = this.added;
    this.added = Object.freeze(list.slice());
    this.addedStamp = changeStamp();
    for (const v of before) if (!list.includes(v)) v.detach?.(this);
    for (const v of list) if (!before.includes(v)) v.attach?.(this);
  }
  get flatShading(): boolean {
    return this.switches.flatShading;
  }
  set flatShading(v: boolean) {
    this.switches.flatShading = flag(v, 'flatShading');
  }
  /** Geometry vertex colours (RGBA) multiply colour and opacity while true (default); instance tints still apply. */
  get vertexColors(): boolean {
    return this.switches.vertexColors;
  }
  set vertexColors(v: boolean) {
    this.switches.vertexColors = flag(v, 'vertexColors');
  }
  /** Scene fog (`@margoengine/environment` Fog) mixes into this lit material while true (default). */
  get fog(): boolean {
    return this.switches.fog;
  }
  set fog(v: boolean) {
    this.switches.fog = flag(v, 'fog');
  }
  /** The display tone map, while true (the default for lit shadings, false for the others, which never tone map). */
  /** A step of per-pixel noise before 8-bit output while true (default false), compiled in only then. Live. */
  get dithering(): boolean {
    return this.switches.dithering;
  }
  set dithering(v: boolean) {
    this.switches.dithering = flag(v, 'dithering');
  }
  get toneMapped(): boolean {
    return this.switches.toneMapped;
  }
  set toneMapped(v: boolean) {
    this.switches.toneMapped = flag(v, 'toneMapped');
  }
  /** Scales `emissive` (default 1, finite, >= 0): the emission drawn is emissive x emissiveMap x emissiveIntensity. */
  get emissiveIntensity(): number {
    return this.glowScale;
  }
  set emissiveIntensity(v: number) {
    if (typeof v !== 'number')
      throw new TypeError('Material emissiveIntensity must be a number; set a finite number >= 0');
    if (!(v >= 0 && Number.isFinite(Math.fround(v))))
      throw new RangeError('Material emissiveIntensity is out of range; set a finite number >= 0');
    this.glowScale = v;
  }
  /** Phong highlight colour, linear RGB, live like `color`. */
  get specular(): LiveColor {
    return this.highlight;
  }
  set specular(v: ColorInput) {
    this.highlight.set(v);
  }
  get depthPacking(): DepthPacking {
    return this.packing;
  }
  set depthPacking(v: DepthPacking) {
    if (v !== 'basic' && v !== 'rgba') throw new TypeError("Invalid material depthPacking; use 'basic' or 'rgba'.");
    this.packing = v;
  }
  get referencePosition(): readonly [number, number, number] {
    return [...this.reference];
  }
  set referencePosition(v: readonly [number, number, number]) {
    if (!Array.isArray(v) || v.length !== 3)
      throw new RangeError('Material referencePosition must have three finite float32 components');
    const x = finiteFloat(v[0], 'referencePosition'),
      y = finiteFloat(v[1], 'referencePosition'),
      z = finiteFloat(v[2], 'referencePosition');
    this.reference = [x, y, z];
  }
  get nearDistance(): number {
    return this.near;
  }
  set nearDistance(v: number) {
    distanceRange(v, this.far);
    this.near = v;
  }
  get farDistance(): number {
    return this.far;
  }
  set farDistance(v: number) {
    distanceRange(this.near, v);
    this.far = v;
  }
  /**
   * Makes this a physical material with `key`'s lobe, on first use: gltf-pro then draws it with the matching physical
   * shader variant (by pipeline key), while materials that never set a physical option keep the plain one.
   */
  private enable(key: keyof PhysicalOptions): number[] {
    if (this.shading !== 'standard')
      throw new TypeError(`Material ${key} needs standard shading; use PbrMaterial or shading: 'standard'`);
    // `extensions` gains a name only with a capability: the first physical option, a thin-film or anisotropy lobe,
    // transmission. Other live edits of a physical material leave it as constructed (exporters read it).
    const self = this as { physical?: number[]; ext?: number[]; volume?: number[] },
      list = this.extensions as string[],
      add = (name: string) => list.includes(name) || list.push(name),
      name = extensions[key];
    if (!self.physical) add(name);
    const physical = (self.physical ??= [0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0]);
    self.ext ??= [0, 1.5, 0, 0];
    if (name === 'anisotropy' || name === 'iridescence') {
      if (physical.length <= 12) physical.push(0, 1.3, 100, 400, 0, 1, 0, 0, 0, 1, 1, 1);
      add(name);
    }
    if (!this.volume && (key === 'transmission' || key === 'transmissionMap' || key === 'thicknessMap')) {
      self.volume = [0, 1, 1, 1];
      add(name);
      add('transmission');
    }
    if (mapped(this)) while (this.uvt.length < mapSlots.length * 8) this.uvt.push(...this.uvDefault);
    return physical;
  }
  private set(i: number, v: number, label: keyof PhysicalOptions): void {
    const x = unit(v, label);
    this.enable(label)[i] = x;
  }
  private setColor(i: number, c: ColorInput, label: keyof PhysicalOptions): void {
    const v = linear(c, label);
    for (let k = 0; k < 3; k++) this.set(i + k, v[k], label);
  }
  private setVolume(i: number, v: number, label: 'thickness' | 'attenuationColor' | 'attenuationDistance'): void {
    if (!this.volume)
      throw new TypeError(
        `Material ${label} is part of transmission; set transmission (or a transmission or thickness map) first`,
      );
    if (!(v >= 0 && (v < Infinity || i === 4))) throw new RangeError(`Material ${label} must be a finite number >= 0`);
    if (i === 0) finiteFloat(v, label);
    if (i) this.attenuation[i - 1] = v;
    else this.volume[0] = v;
    const [r, g, b, d] = this.attenuation;
    this.volume[1] = attenuationPower(r, 1 / d);
    this.volume[2] = attenuationPower(g, 1 / d);
    this.volume[3] = attenuationPower(b, 1 / d);
  }
  get clearcoat(): number {
    return this.physical?.[0] ?? 0;
  }
  set clearcoat(v: number) {
    this.set(0, v, 'clearcoat');
  }
  get clearcoatRoughness(): number {
    return this.physical?.[1] ?? 0;
  }
  set clearcoatRoughness(v: number) {
    this.set(1, v, 'clearcoatRoughness');
  }
  get clearcoatNormalScale(): number {
    return this.physical?.[2] ?? 1;
  }
  set clearcoatNormalScale(v: number) {
    this.enable('clearcoatNormalScale')[2] = finiteFloat(v, 'clearcoatNormalScale');
  }
  get anisotropy(): number {
    return this.physical?.[16] ?? 0;
  }
  set anisotropy(v: number) {
    this.set(16, v, 'anisotropy');
  }
  get anisotropyRotation(): number {
    return this.rotation;
  }
  set anisotropyRotation(v: number) {
    if (!Number.isFinite(v)) throw new RangeError('Invalid anisotropyRotation; set a finite angle in radians.');
    const p = this.enable('anisotropyRotation');
    this.rotation = v;
    p[17] = Math.cos(v);
    p[18] = Math.sin(v);
  }
  get iridescence(): number {
    return this.physical?.[12] ?? 0;
  }
  set iridescence(v: number) {
    this.set(12, v, 'iridescence');
  }
  get iridescenceIOR(): number {
    return this.physical?.[13] ?? 1.3;
  }
  set iridescenceIOR(v: number) {
    this.enable('iridescenceIOR')[13] = finiteFloat(v, 'iridescenceIOR', 1);
  }
  get iridescenceThicknessRange(): readonly [number, number] {
    return [this.physical?.[14] ?? 100, this.physical?.[15] ?? 400];
  }
  set iridescenceThicknessRange(v: readonly [number, number]) {
    if (!Array.isArray(v) || v.length !== 2)
      throw new RangeError('Material iridescenceThicknessRange must be [min, max] nanometres');
    finiteFloat(v[1], 'iridescenceThicknessRange', finiteFloat(v[0], 'iridescenceThicknessRange', 0));
    const p = this.enable('iridescenceThicknessRange');
    p[14] = v[0];
    p[15] = v[1];
  }
  get transmission(): number {
    return this.physical?.[3] ?? 0;
  }
  set transmission(v: number) {
    this.set(3, v, 'transmission');
  }
  get specularColor(): number[] {
    return this.physical?.slice(4, 7) ?? [1, 1, 1];
  }
  set specularColor(c: ColorInput) {
    this.setColor(4, c, 'specularColor');
  }
  get specularIntensity(): number {
    return this.physical?.[7] ?? 1;
  }
  set specularIntensity(v: number) {
    this.set(7, v, 'specularIntensity');
  }
  get sheenColor(): number[] {
    return this.physical?.slice(8, 11) ?? [0, 0, 0];
  }
  set sheenColor(c: ColorInput) {
    this.setColor(8, c, 'sheenColor');
  }
  get sheenRoughness(): number {
    return this.physical?.[11] ?? 0;
  }
  set sheenRoughness(v: number) {
    this.set(11, v, 'sheenRoughness');
  }
  get ior(): number {
    return this.ext?.[1] ?? 1.5;
  }
  set ior(v: number) {
    finiteFloat(v, 'ior', 1);
    this.enable('ior');
    this.ext![1] = v;
  }
  get dispersion(): number {
    return this.ext?.[3] ?? 0;
  }
  set dispersion(v: number) {
    if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || v < 0)
      throw new RangeError('Material dispersion must be a finite number >= 0');
    this.enable('dispersion');
    this.ext![3] = v;
  }
  get thickness(): number {
    return this.volume?.[0] ?? 0;
  }
  set thickness(v: number) {
    this.setVolume(0, v, 'thickness');
  }
  get attenuationColor(): number[] {
    return this.attenuation.slice(0, 3);
  }
  set attenuationColor(c: ColorInput) {
    const v = linear(c, 'attenuationColor');
    for (let k = 0; k < 3; k++) this.setVolume(k + 1, v[k], 'attenuationColor');
  }
  get attenuationDistance(): number {
    return this.attenuation[3];
  }
  set attenuationDistance(v: number) {
    if (!(v > 0)) throw new RangeError('Material attenuationDistance must be > 0');
    this.setVolume(4, v, 'attenuationDistance');
  }
  get transmissive(): boolean {
    return !!this.volume;
  }
  /** @internal gltf-pro's tinted-blend constant when no transmission pass refracts: color x transmission x volume attenuation. */
  get tint(): number[] | undefined {
    if (!this.volume) return undefined;
    for (let k = 0; k < 3; k++)
      this.tinted[k] = this.color[k] * this.physical![3] * this.volume[k + 1] ** this.volume[0];
    return this.tinted;
  }
  get roughness(): number {
    return this.factors[0];
  }
  set roughness(v: number) {
    this.factors[0] = unit(v, 'roughness');
  }
  get metalness(): number {
    return this.factors[1];
  }
  set metalness(v: number) {
    this.factors[1] = unit(v, 'metalness');
  }
  get normalScale(): number {
    return this.factors[2];
  }
  set normalScale(v: number) {
    this.factors[2] = finiteFloat(v, 'normalScale');
  }
  get aoMapIntensity(): number {
    return this.factors[3];
  }
  set aoMapIntensity(v: number) {
    this.factors[3] = unit(v, 'aoMapIntensity');
  }
  /** Toon's band count without a gradientMap, an integer 2 through 256 (default 3); band k of n is k / (n - 1). */
  get steps(): number {
    return this.toonSteps;
  }
  set steps(v: number) {
    if (typeof v !== 'number') throw new TypeError('Material steps must be a number; set an integer 2 through 256');
    if (!Number.isInteger(v) || v < 2 || v > 256)
      throw new RangeError('Material steps is out of range; set an integer 2 through 256');
    this.toonSteps = v;
  }
  /** Toon's ramp texture, or null for `steps` bands. */
  get gradientMap(): Texture | null {
    return this.toonMap;
  }
  set gradientMap(v: Texture | null) {
    if (v != null && !(v instanceof Texture))
      throw new TypeError('Material gradientMap must be a Texture; pass a Texture or null');
    if (v != null && this.shading !== 'toon')
      throw new TypeError("Material gradientMap needs toon shading; set shading: 'toon'");
    this.toonMap = v ?? null;
  }
  /** The environment map, or null (default): see `MaterialOptions.envMap`. */
  get envMap(): EnvMapSource | null {
    return this.env.map;
  }
  set envMap(v: EnvMapSource | null) {
    if (v != null && !['standard', 'basic', 'lambert', 'phong'].includes(this.shading))
      throw new TypeError(`Material envMap needs standard, basic, lambert or phong shading, not '${this.shading}'`);
    this.env.map = v == null ? null : envSource(v);
  }
  /** Scales the envMap's light, finite and >= 0 (default 1). */
  get envMapIntensity(): number {
    return this.env.intensity;
  }
  set envMapIntensity(v: number) {
    if (typeof v !== 'number' || !(v >= 0 && Number.isFinite(Math.fround(v))))
      throw new RangeError('Material envMapIntensity must be a finite number >= 0; set one (default 1)');
    this.env.intensity = v;
  }
  /** Turns the envMap about +Y, in radians (default 0). */
  get envMapRotation(): number {
    return this.env.rotation;
  }
  set envMapRotation(v: number) {
    this.env.rotation = finiteFloat(v, 'envMapRotation');
  }
  /** Samples the envMap along the mirrored (`'reflection'`, default) or bent (`'refraction'`) view ray. */
  get envMapMode(): 'reflection' | 'refraction' {
    return this.env.mode;
  }
  set envMapMode(v: 'reflection' | 'refraction') {
    this.env.mode = oneOf(['reflection', 'refraction'], "'reflection' or 'refraction'")(v, 'envMapMode') as
      | 'reflection'
      | 'refraction';
  }
  /** The ratio of indices of refraction for `envMapMode: 'refraction'`, finite and > 0 (default 1/1.5: air into crown glass). */
  get refractionRatio(): number {
    return this.env.ratio;
  }
  set refractionRatio(v: number) {
    if (typeof v !== 'number' || !(v > 0 && Number.isFinite(Math.fround(v))))
      throw new RangeError(
        'Material refractionRatio must be a finite number > 0; set one (default 1/1.5, air into glass)',
      );
    this.env.ratio = v;
  }
  /** Basic, Lambert and Phong: how the reflection meets the colour (default 'multiply'). */
  get combine(): EnvCombine {
    return this.env.combine;
  }
  set combine(v: EnvCombine) {
    this.env.combine = oneOf(['multiply', 'mix', 'add'], "'multiply', 'mix' or 'add'")(v, 'combine') as EnvCombine;
  }
  /** Basic, Lambert and Phong: the reflection's weight, 0 through 1 (default 1). */
  get reflectivity(): number {
    return this.env.reflectivity;
  }
  set reflectivity(v: number) {
    this.env.reflectivity = unit(v, 'reflectivity');
  }
  /** Phong's Blinn-Phong exponent, finite and >= 0: higher is a smaller, sharper highlight. */
  get shininess(): number {
    return this.gloss;
  }
  set shininess(v: number) {
    this.gloss = finiteFloat(v, 'shininess', 0);
  }
  get opacity(): number {
    return this.color[3];
  }
  set opacity(v: number) {
    this.color[3] = unit(v, 'opacity');
  }
  get alphaTest(): number {
    return this.settings[1];
  }
  set alphaTest(v: number) {
    this.settings[1] = unit(v, 'alphaTest');
    this.sync();
  }
  get transparent(): boolean {
    return this.blend;
  }
  set transparent(v: boolean) {
    this.blend = !!v;
    this.sync();
  }
  get side(): MaterialSide {
    return this.settings[2] === 1 ? 'double' : this.settings[2] === 2 ? 'back' : 'front';
  }
  set side(v: MaterialSide) {
    if (!['front', 'back', 'double'].includes(v))
      throw new TypeError("Invalid material side; use 'front', 'back' or 'double'.");
    this.settings[2] = v === 'double' ? 1 : v === 'back' ? 2 : 0;
  }
  get doubleSided(): boolean {
    return this.settings[2] === 1;
  }
  set doubleSided(v: boolean) {
    this.settings[2] = +!!v;
  }
  /**
   * Live: sets one map slot's UV transform, or every slot's without `slot` (but `lightMap`'s, which stays on its own
   * UV set); null restores the identity (UV1 for `lightMap`, unless the transform names a `texCoord`).
   */
  setUVTransform(
    t: TextureTransform | null,
    slot?: MapSlot | (typeof featureMaps)[number] | (typeof surfaceMaps)[number],
  ): this {
    const f = featureMaps.indexOf(slot as (typeof featureMaps)[number]),
      g = surfaceMaps.indexOf(slot as (typeof surfaceMaps)[number]),
      i = slot === undefined || f >= 0 || g >= 0 ? -1 : mapSlots.indexOf(slot as MapSlot);
    if (slot !== undefined && f < 0 && g < 0 && i < 0)
      throw new TypeError('Invalid UV transform slot; pass a map name such as map or normalMap, or omit it.');
    const transform: TextureTransform = f === 3 ? { texCoord: 1, ...t } : (t ?? {}),
      { texCoord } = textureCoordinates({ extensions: { KHR_texture_transform: transform } });
    if (texCoord > 1) throw new RangeError('Material meshes have two UV sets; pass texCoord 0 or 1.');
    const rows = textureTransform(transform, texCoord);
    if (f >= 0) {
      this.featureValues.splice(4 + f * 8, 8, ...rows);
      return this;
    }
    if (g >= 0) {
      this.surfaceValues.splice(4 + g * 24, 8, ...rows);
      return this;
    }
    if (i < 0) {
      this.uvDefault = rows;
      for (let k = 0; k < 3; k++) this.featureValues.splice(4 + k * 8, 8, ...rows);
      for (let k = 0; k < 2; k++) this.surfaceValues.splice(4 + k * 24, 8, ...rows);
    }
    while (this.uvt.length < Math.max(40, (i + 1) * 8)) this.uvt.push(...this.uvDefault);
    for (let k = 0; k < this.uvt.length / 8; k++) if (i < 0 || k === i) this.uvt.splice(k * 8, 8, ...rows);
    return this;
  }
  /** True when the beauty pipeline needs explicit render controls. */
  get customState(): boolean {
    return (
      this.blending !== 'normal' ||
      this.depthWrite !== undefined ||
      !this.depthTest ||
      !this.colorWrite ||
      this.alphaToCoverage ||
      this.polygonOffset ||
      this.stencilWrite
    );
  }
  private sync(): void {
    this.settings[0] = this.blend ? 2 : this.settings[1] > 0 ? 1 : 0;
  }
  /**
   * A new material of the same class with this one's values; it shares the textures (and a NodeMaterial's nodes) and
   * nothing else, so editing either leaves the other alone.
   */
  clone(): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    for (const [key, value] of Object.entries(this)) (c as Record<string, unknown>)[key] = duplicate(value);
    return Object.assign(c, {
      rgba: liveColor(this.rgba.slice(), 'color'),
      glow: liveColor(this.glow.slice(), 'emissive'),
      highlight: liveColor(this.highlight.slice(), 'specular'),
    });
  }
  /**
   * Copies every Material value of `source` (same shading) into this material in place, textures shared: meshes using
   * this material show them next frame. Fields a subclass adds (a NodeMaterial's nodes) stay this material's.
   */
  copy(source: Material): this {
    usable(this);
    if (!(source instanceof Material)) throw new TypeError('Material copy needs a source Material; pass one');
    if (source.shading !== this.shading)
      throw new TypeError(
        `Material copy needs the same shading ('${this.shading}', not '${source.shading}'); clone() the source instead`,
      );
    const to = this as unknown as Record<string, unknown>,
      from = source as unknown as Record<string, unknown>;
    for (const key of (baseKeys ??= Object.keys(new Material()))) {
      const a = to[key],
        b = from[key];
      // Arrays copy into the existing ones: live colours and gltf-pro rows keep their identity.
      if (Array.isArray(a) && Array.isArray(b)) a.splice(0, a.length, ...b);
      else to[key] = duplicate(b);
    }
    renderStates.delete(this);
    return this;
  }
  /**
   * Frees what this material owns that no live mesh uses (uniform buffers it made outside a mesh); meshes still
   * drawing it keep theirs until they go. Afterwards `createMesh` and `mesh.material = ` refuse it (MargoError
   * 'disposed'); `clone()` still works. Textures stay the caller's.
   */
  dispose(): void {
    disposedMaterials.add(this);
    const states = mapStates.get(this);
    this.changes = changeStamp();
    for (const [owner, state] of states ?? [])
      if (!state.refs) {
        state.buffer?.destroy();
        state.features?.destroy();
        state.surface?.destroy();
        state.env?.destroy();
        state.clip?.destroy();
        unwatchUniforms(state);
        states!.delete(owner);
      }
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** gltf-pro beauty shader patch; subclasses (such as `@margoengine/shader`'s NodeMaterial) may extend it. */
  shader(source: string, group: number): string {
    if (mapped(this)) return physicalMapsShader(source, group, mapPlan(this).slots);
    if (bare(this)) return bareShader(source);
    return materialShader(source, group, this.shading);
  }
  /** @internal What depth passes draw in place of the displacement map, for a subclass that moves vertices its own way. */
  caster(_device: GPUDevice, _engine?: Engine): CasterDisplacement | undefined {
    return undefined;
  }
  /** @internal A subclass's edit of `code` once the scene's lighting effects are composed into it. */
  relight(code: string): string {
    return code;
  }
  /** @internal gltf-pro LightingEffect bindings for one device; `engine` is the drawing engine. */
  bindings(device: GPUDevice, engine?: Engine): GPUBindGroupEntry[] {
    if (mapped(this)) {
      const plan = mapPlan(this),
        buffer = materialBuffer(this, device, engine ?? device, 560);
      const values = new Float32Array(140);
      for (let k = 0; k < mapSlots.length; k++)
        values.set(this.uvt.length > k * 8 ? this.uvt.slice(k * 8, k * 8 + 8) : this.uvDefault, k * 8);
      values.set(this.volume ?? [0, 1, 1, 1], 136);
      device.queue.writeBuffer(buffer, 0, values);
      const entries: GPUBindGroupEntry[] = [{ binding: 200, resource: { buffer } }];
      const bound = plan.textures.map(({ texture, srgb, fallback: role }) => {
        const pair = texture.sampled(device, srgb, 'map');
        if (pair) return pair;
        return fallback(device, role);
      });
      bound.forEach((pair, i) => entries.push({ binding: 201 + i, resource: pair[0] }));
      plan.samplers.forEach((texture, i) =>
        entries.push({ binding: 240 + i, resource: bound[plan.textures.findIndex((t) => t.texture === texture)][1] }),
      );
      return entries;
    }
    const d = defaults(device),
      entries: GPUBindGroupEntry[] = [];
    if (bare(this)) return entries;
    for (let i = 0; i < (this.shading === 'matcap' ? 6 : 5); i++) {
      const texture = this[slots[i]],
        bound = texture?.sampled(device, i === 0 || i >= 4, slots[i]) ?? [i === 2 ? d.normal : d.white, d.sampler];
      entries.push({ binding: 32 + i * 2, resource: bound[0] }, { binding: 33 + i * 2, resource: bound[1] });
    }
    if (this.shading === 'depth' || this.shading === 'distance') {
      const owner = engine ?? device,
        state = mapState(this, owner),
        buffer = materialBuffer(this, device, owner, 32),
        values = (state.values ??= new Float32Array(8));
      values.set(this.reference, 0);
      values[4] = this.near;
      values[5] = this.far;
      values[6] = +(this.packing === 'rgba');
      device.queue.writeBuffer(buffer, 0, values);
      entries.push({ binding: 196, resource: { buffer } });
    }
    if (this.shading === 'toon') {
      const owner = engine ?? device,
        state = mapState(this, owner),
        buffer = materialBuffer(this, device, owner, 16),
        values = (state.values ??= new Float32Array(4)),
        [view, sampler] = this.toonMap?.sampled(device, false, 'gradientMap') ?? fallback(device, 0);
      values.set([+!!this.toonMap, this.toonSteps, 0, 0]);
      device.queue.writeBuffer(buffer, 0, values);
      entries.push(
        { binding: 191, resource: { buffer } },
        { binding: 192, resource: view },
        { binding: 193, resource: sampler },
      );
    }
    if (this.shading === 'phong') {
      const owner = engine ?? device,
        state = mapState(this, owner),
        buffer = materialBuffer(this, device, owner, 16),
        values = (state.values ??= new Float32Array(4));
      values.set(this.specular, 0);
      values[3] = this.gloss;
      device.queue.writeBuffer(buffer, 0, values);
      entries.push({ binding: 197, resource: { buffer } });
    }
    return entries;
  }
}

/** Any CPU geometry with a bottom-left UV origin (v increases up the image); `@margoengine/geometry` output fits directly. Colors are RGB or RGBA, floats 0-1 or bytes. */
export interface MeshGeometry {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  /** Independent UV1 coordinates. Omitted UV1 duplicates UV0 for compatibility. */
  uvs1?: ArrayLike<number>;
  indices?: ArrayLike<number>;
  tangents?: ArrayLike<number>;
  colors?: ArrayLike<number>;
  /** Triangle ranges in index units (vertex units without indices). Used with a material array. */
  groups?: readonly { start: number; count: number; materialIndex: number }[];
}
const packed = new WeakMap<object, PreparedGeometry>();
/** Packs once per geometry object into gltf-pro's 80-byte vertex (position, normal, tangent, UV0, UV1, color). Later edits to the object are not seen; `mesh.setGeometry` repacks. */
export function packGeometry(g: MeshGeometry): PreparedGeometry {
  let out = packed.get(g);
  if (!out) packed.set(g, (out = pack(g)));
  return out;
}
function vertexCount(g: MeshGeometry): number {
  const { positions: p, normals: n, uvs, uvs1, tangents: t, colors: c } = g ?? ({} as MeshGeometry),
    count = p?.length / 3,
    width = c ? c.length / count : 0;
  if (
    !Number.isInteger(count) ||
    count < 3 ||
    count > 1_000_000 ||
    n?.length !== count * 3 ||
    (uvs && uvs.length !== count * 2) ||
    (uvs1 && uvs1.length !== count * 2) ||
    (t && t.length !== count * 4) ||
    (c && width !== 3 && width !== 4)
  )
    throw new RangeError(
      'Mesh geometry attributes do not match; give 3 to 1,000,000 vertices, each with a normal, and size the other attributes to match.',
    );
  return count;
}
/** Packed vertices `from` to `to` (exclusive) of validated geometry, in a new array. */
function packVertices(g: MeshGeometry, from: number, to: number): Float32Array {
  const { positions: p, normals: n, uvs, uvs1, tangents: t, colors: c } = g,
    width = c ? c.length / (p.length / 3) : 0,
    scale = c instanceof Uint8Array || c instanceof Uint8ClampedArray ? 1 / 255 : 1;
  const v = new Float32Array((to - from) * 20);
  for (let i = from, o = 0; i < to; i++, o += 20) {
    const length = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]),
      tl = t ? Math.hypot(t[i * 4], t[i * 4 + 1], t[i * 4 + 2]) : 0;
    if (!length) throw new RangeError('Mesh normals must be non-zero');
    for (let k = 0; k < 3; k++) {
      v[o + k] = p[i * 3 + k];
      v[o + 4 + k] = n[i * 3 + k] / length;
      if (tl) v[o + 8 + k] = t![i * 4 + k] / tl;
    }
    v[o + 3] = 1;
    if (tl) v[o + 11] = t![i * 4 + 3] < 0 ? -1 : 1;
    if (uvs) {
      v[o + 12] = uvs[i * 2];
      v[o + 13] = uvs[i * 2 + 1];
    }
    const second = uvs1 ?? uvs;
    if (second) {
      v[o + 14] = second[i * 2];
      v[o + 15] = second[i * 2 + 1];
    }
    for (let k = 0; k < 4; k++) v[o + 16 + k] = c && k < width ? c[i * width + k] * scale : 1;
  }
  if (v.some((value) => !Number.isFinite(value)))
    throw new RangeError('Mesh geometry attributes must be finite; remove NaN and Infinity values.');
  return v;
}
function pack(g: MeshGeometry): PreparedGeometry {
  const count = vertexCount(g),
    v = packVertices(g, 0, count);
  const indexCount = g.indices?.length ?? count;
  if (!Number.isSafeInteger(indexCount) || indexCount < 3 || indexCount % 3)
    throw new RangeError('Mesh indices must contain complete triangles');
  if (g.indices)
    for (let i = 0; i < indexCount; i++)
      if (!Number.isSafeInteger(g.indices[i]) || g.indices[i] < 0 || g.indices[i] >= count)
        throw new RangeError(
          'Mesh geometry index is out of range; use whole numbers from 0 to the vertex count minus 1.',
        );
  return {
    vertices: v,
    indices: g.indices ? Uint32Array.from(g.indices) : Uint32Array.from({ length: count }, (_, i) => i),
  };
}
type Group = { start: number; count: number; materialIndex: number };
/** The validated triangle groups `createMesh` turns into primitives, in primitive order. */
function meshGroups(geometry: MeshGeometry, indexCount: number, materials: readonly Material[], array: boolean) {
  const groups: readonly Group[] | undefined = array
    ? geometry.groups
    : [{ start: 0, count: indexCount, materialIndex: 0 }];
  if (!Array.isArray(groups) || !groups.length) throw new RangeError('Material arrays require geometry groups');
  for (const g of groups)
    if (
      !g ||
      !Number.isSafeInteger(g.start) ||
      !Number.isSafeInteger(g.count) ||
      !Number.isSafeInteger(g.materialIndex) ||
      g.start < 0 ||
      g.count <= 0 ||
      g.start % 3 ||
      g.count % 3 ||
      g.start + g.count > indexCount ||
      g.materialIndex < 0 ||
      g.materialIndex >= materials.length
    )
      throw new RangeError(
        'Mesh geometry group is invalid; use a start and count that are multiples of 3 within the indices, and an existing materialIndex.',
      );
  const ranges = [...groups].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].start + ranges[i - 1].count)
      throw new RangeError('Mesh geometry groups must not overlap');
  return groups;
}
const groupIndices = (indices: Uint32Array, g: Group) =>
  g.start === 0 && g.count === indices.length ? indices : indices.slice(g.start, g.start + g.count);
/** Vertex range of a `setGeometry` update: `count` vertices from vertex `start`. */
export interface GeometryRange {
  start: number;
  count: number;
}
interface Entry {
  model: PBRModel;
  /** The material each primitive draws with, in primitive order. */
  materials: Material[];
  order: number;
  opaque: boolean;
  blend: boolean;
  /** Squared camera distance this frame, for the late phase's back-to-front sort. */
  distance: number;
}
interface Phase {
  entry: Entry;
  /** The entry's model, read once per draw without going through the entry. */
  model: PBRModel;
  blend: boolean;
  phase: 'all' | 'opaque' | 'blend';
}
const blends: Record<Blending, GPUBlendState | null | undefined> = {
  normal: undefined,
  none: null,
  additive: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
  multiply: { color: { srcFactor: 'zero', dstFactor: 'src' }, alpha: { srcFactor: 'zero', dstFactor: 'src-alpha' } },
};
interface MaterialDraws {
  add(entry: Entry): void;
  delete(entry: Entry): void;
  /** Re-sorts on the next frame (a render order changed). */
  reorder(): void;
}
const queues = new WeakMap<Engine['frameGraph'], MaterialDraws>(),
  late = (m: Material) => m.transparent || m.transmissive;
function lateEntry(entry: Entry, index: number): boolean {
  return late(entry.materials[index]) || primitiveAfterOpaque(entry.model.primitives[index]);
}
/** Bit 1: some slot of the mesh draws in the opaque phase; bit 2: some slot draws in the blend phase. No allocation: it runs for every mesh every frame. */
function lateFlags(entry: Entry): number {
  let flags = 0;
  for (let i = 0; i < entry.materials.length; i++) flags |= lateEntry(entry, i) ? 2 : 1;
  return flags;
}
let serial = 0;
/** One pass per engine draws every material mesh: opaque then transparent, each by renderOrder; transparent meshes back to front. */
function queue(runtime: Engine): MaterialDraws {
  const graph = runtime.frameGraph;
  let draws = queues.get(graph);
  if (draws) return draws;
  const members: Entry[] = [],
    tail: Phase[] = [],
    name = 'materials:' + serial++,
    // One run, reused every frame: it keeps its batch records (gltf-pro draw-batch.ts) instead of making new ones.
    run = new PBRDrawRun();
  // Each arrange() makes a new list, so a loop that is drawing one keeps it while a draw re-arranges the queue.
  let phases: Phase[] = [],
    opaqueEnd = 0,
    arranged = false,
    running = false,
    epoch = 0;
  /** True when the entry's slots still draw in the phases it was arranged into. */
  const current = (entry: Entry): boolean => {
    const flags = lateFlags(entry);
    return ((flags & 1) !== 0) === entry.opaque && ((flags & 2) !== 0) === entry.blend;
  };
  // Opaque order is stable until membership or a transparent flag changes. Distance sorts only the late phase.
  const arrange = () => {
    const next: Phase[] = [];
    for (let i = 0; i < members.length; i++) {
      const entry = members[i],
        flags = lateFlags(entry),
        opaque = (flags & 1) !== 0,
        blend = (flags & 2) !== 0;
      entry.opaque = opaque;
      entry.blend = blend;
      if (opaque) next.push({ entry, model: entry.model, blend: false, phase: blend ? 'opaque' : 'all' });
      if (blend) next.push({ entry, model: entry.model, blend: true, phase: opaque ? 'blend' : 'all' });
    }
    next.sort((a, b) => +a.blend - +b.blend || a.entry.order - b.entry.order);
    opaqueEnd = 0;
    while (opaqueEnd < next.length && !next[opaqueEnd].blend) opaqueEnd++;
    phases = next;
    arranged = true;
    epoch++;
  };
  /** Sorts the late phase back to front from `eye`. With `check`, returns false (unsorted) when one of its entries changed phase. */
  const sortLate = (eye: ArrayLike<number>, check: boolean): boolean => {
    if (opaqueEnd === phases.length) return true;
    for (let i = opaqueEnd; i < phases.length; i++) {
      const entry = phases[i].entry;
      if (check && !current(entry)) return false;
      const matrix = entry.model.primitives[0].node.matrix;
      // The squared distance sorts alike and needs no square root (2,000 blended meshes a frame).
      const x = eye[0] - matrix[12],
        y = eye[1] - matrix[13],
        z = eye[2] - matrix[14];
      entry.distance = x * x + y * y + z * z;
    }
    const count = phases.length - opaqueEnd;
    for (let i = 0; i < count; i++) tail[i] = phases[opaqueEnd + i];
    tail.length = count;
    tail.sort((a, b) => a.entry.order - b.entry.order || b.entry.distance - a.entry.distance);
    for (let i = 0; i < count; i++) phases[opaqueEnd + i] = tail[i];
    return true;
  };
  const plugin: EnginePlugin = {
    name,
    setup(engine) {
      requireWebGPU(engine, 'Material draw queue');
    },
    dispose() {
      queues.delete(graph);
    },
    registerPasses(graph) {
      graph.add({
        name,
        order: 1,
        joins: true,
        execute: (c) => {
          if (c.backend !== 'webgpu') return;
          if (!arranged) arrange();
          // The late phase's entries are checked before anything draws, so one that turned opaque draws with the
          // opaque phase this frame.
          const eye = c.camera.position;
          while (!sortLate(eye, true)) arrange();
          // One render pass for every mesh: a pass per mesh stores and reloads the multisampled colour and depth each
          // time and costs a begin, an end and a command-buffer flush (10,000 meshes: 168 ms of CPU a frame).
          // A frame drawn inside this one (a draw callback rendering a probe) takes a run of its own.
          const own = running ? new PBRDrawRun() : run,
            color = c.color,
            depth = c.depth,
            first = epoch;
          running = true;
          try {
            // Each opaque entry is checked beside its draw rather than in a pass of its own over every mesh first
            // (10,000 meshes: one more trip through memory a frame). An entry that changed phase re-arranges the queue,
            // and so may a frame drawn inside a draw; the loop then continues on the new list, skipping what drew.
            let list = phases,
              end = opaqueEnd,
              at = epoch,
              drawn: Set<Entry> | undefined;
            for (let i = 0; i < end; i++) {
              const item = list[i],
                entry = item.entry;
              if (drawn?.has(entry)) continue;
              let done = 0;
              if (current(entry)) {
                item.model.draw(c, 'beauty', color, depth, item.phase, undefined, own);
                if (at === epoch) continue;
                done = 1;
              } else arrange();
              drawn ??= new Set();
              for (let k = 0; k < i + done; k++) drawn.add(list[k].entry);
              list = phases;
              end = opaqueEnd;
              at = epoch;
              i = -1;
            }
            // Re-arranged while drawing: the late phase is sorted again (a change from here on shows next frame).
            if (epoch !== first) sortLate(eye, false);
            list = phases;
            end = list.length;
            for (let i = opaqueEnd; i < end; i++) {
              const item = list[i];
              item.model.draw(c, 'beauty', color, depth, item.phase, undefined, own);
            }
          } finally {
            if (own === run) running = false;
            own.end();
          }
        },
      });
    },
  };
  runtime.use(plugin);
  draws = {
    add(entry) {
      members.push(entry);
      arranged = false;
    },
    delete(entry) {
      const index = members.indexOf(entry);
      if (index >= 0) members.splice(index, 1);
      arranged = false;
      // The scene's last material mesh is gone: the queue and its pass leave with it; the next mesh makes a new one.
      if (!members.length) {
        queues.delete(graph);
        runtime.sceneOf(plugin)?.removePlugin(name);
      }
    },
    reorder() {
      arranged = false;
    },
  };
  queues.set(graph, draws);
  return draws;
}
const renderStates = new WeakMap<Material, PBRRenderState>(),
  features = new WeakMap<Material, NonNullable<PBRMaterial['extended']>>(),
  named = new WeakMap<Material, { key: string; value: Record<string, object> }>();
/** gltf-pro's beauty pipeline overrides for `m`, or undefined for the default pipeline. */
function renderStateOf(m: Material): PBRRenderState | undefined {
  if (!m.customState) return undefined;
  let state = renderStates.get(m);
  if (state) return state;
  const stencil: GPUStencilFaceState = {
    compare: m.stencilFunc,
    failOp: m.stencilFail,
    depthFailOp: m.stencilZFail,
    passOp: m.stencilZPass,
  };
  state = {
    blend: blends[m.blending],
    depthWrite: m.depthWrite,
    depthCompare: m.depthTest ? undefined : 'always',
    ...(m.colorWrite ? {} : { colorWrite: false }),
    ...(m.alphaToCoverage ? { alphaToCoverage: true } : {}),
    ...(m.polygonOffset
      ? {
          depthBiasMode: 'away' as const,
          depthBias: m.polygonOffsetUnits,
          depthBiasSlopeScale: m.polygonOffsetFactor,
          depthBiasClamp: m.polygonOffsetClamp,
        }
      : {}),
    ...(m.stencilWrite
      ? {
          stencilFront: stencil,
          stencilBack: { ...stencil },
          stencilReference: m.stencilRef,
          stencilReadMask: m.stencilReadMask,
          stencilWriteMask: m.stencilWriteMask,
        }
      : {}),
  };
  renderStates.set(m, state);
  return state;
}
const scaledEmission = new WeakMap<Material, number[]>();
/** gltf-pro's emission row: the live emissive colour itself, or (emissiveIntensity not 1) it scaled. */
function emissionOf(m: Material): number[] {
  const k = m.emissiveIntensity;
  if (k === 1) return m.emissive;
  let out = scaledEmission.get(m);
  if (!out) scaledEmission.set(m, (out = [0, 0, 0]));
  for (let i = 0; i < 3; i++) out[i] = m.emissive[i] * k;
  return out;
}
/** gltf-pro's extended-material features (iridescence, anisotropy rows) for `m`, kept while they stay the same. */
function extendedOf(m: Material): PBRMaterial['extended'] {
  if (!m.physical || m.physical.length <= 12) return undefined;
  const iridescence = m.extensions.includes('iridescence'),
    anisotropy = m.extensions.includes('anisotropy');
  let f = features.get(m);
  if (f?.iridescence !== iridescence || f.anisotropy !== anisotropy)
    features.set(m, (f = { iridescence, anisotropy, diffuseTransmission: false }));
  return f;
}
/** The glTF `extensions` record @margoengine/exporters reads to name the KHR_materials_* in use; one object per list. */
function extensionsOf(m: Material): Record<string, object> | undefined {
  if (!m.physical) return undefined;
  const key = m.extensions.join();
  let record = named.get(m);
  if (record?.key !== key)
    named.set(m, (record = { key, value: Object.fromEntries(m.extensions.map((e) => ['KHR_materials_' + e, {}])) }));
  return record.value;
}
/** Which envMap shader `m` takes: standard image-based light, basic output, or Lambert and Phong lit colour. */
const envKind = (m: Material) => (m.shading === 'standard' ? 'standard' : m.shading === 'basic' ? 'basic' : 'lit');
const envSamplers = new WeakMap<GPUDevice, GPUSampler>(),
  envViews = new WeakMap<GPUTexture, GPUTextureView>(),
  blackCubes = new WeakMap<GPUDevice, GPUTextureView>();
/** Checks an envMap value: a cube Texture, an Environment, a cube render target or a six-layer GPUTexture. */
function envSource(v: unknown): EnvMapSource {
  if (v instanceof Texture) {
    if (v.dimension !== 'cube')
      throw new TypeError(`Material envMap must be a cube Texture, not a ${v.dimension} one; use a CubeTexture`);
    return v;
  }
  const o = v as Partial<EnvironmentMap & CubeTarget & GPUTexture> | null;
  if (o && typeof o === 'object') {
    if (o.specularView && typeof o.specularMips === 'number' && o.sampler && o.sh) return o as EnvironmentMap;
    if (o.texture && o.view && o.texture.depthOrArrayLayers === 6) return o as CubeTarget;
    if (typeof o.createView === 'function' && o.depthOrArrayLayers === 6 && o.dimension === '2d')
      return o as GPUTexture;
  }
  throw new TypeError(
    'Material envMap must be a CubeTexture, an Environment, a cube render target {texture, view} or a six-layer GPUTexture; pass one of those or null',
  );
}
/** The envMap's cube, sampler and uniform for `m` on `device` (188-190). */
function envBindings(m: Material, device: GPUDevice, owner: object): GPUBindGroupEntry[] {
  const e = m['env'],
    map = e.map!;
  let view: GPUTextureView,
    sampler: GPUSampler | undefined,
    levels = 1,
    sh: ArrayLike<number> | undefined,
    rotation = e.rotation,
    intensity = e.intensity;
  if (map instanceof Texture) {
    if (map.unfilterable && !device.features.has('float32-filterable'))
      throw new MargoError(
        'unsupported',
        'Material envMap samples 32-bit float texels, which needs the device feature float32-filterable; request it in Engine.create features, use a 16-bit float format, or pass the cube through prefilterCube',
      );
    const pair = map.bind(device, true);
    levels = map.gpuTexture(device)?.mipLevelCount ?? 1;
    if (pair) [view, sampler] = pair;
    else {
      // A cube whose face images are still loading reflects black.
      let black = blackCubes.get(device);
      if (!black) {
        const texture = device.createTexture({
          size: [1, 1, 6],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture }, new Uint8Array(24), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 6]);
        blackCubes.set(device, (black = texture.createView({ dimension: 'cube' })));
      }
      view = black;
    }
  } else if ('specularView' in map) {
    view = map.specularView;
    sampler = map.sampler;
    levels = map.specularMips;
    sh = map.sh.irradiance;
    rotation += map.rotation;
    intensity *= map.intensity * (map.radianceScale ?? 1);
  } else {
    const texture = 'view' in map ? map.texture : map;
    levels = texture.mipLevelCount;
    if ('view' in map) view = map.view;
    else {
      let cached = envViews.get(texture);
      if (!cached) envViews.set(texture, (cached = texture.createView({ dimension: 'cube' })));
      view = cached;
    }
  }
  if (!sampler) {
    sampler = envSamplers.get(device);
    if (!sampler)
      envSamplers.set(
        device,
        (sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })),
      );
  }
  const state = mapState(m, owner),
    buffer = materialBuffer(m, device, owner, envFloats * 4, 'env'),
    values = packEnv(
      (state.envData ??= new Float32Array(envFloats)),
      rotation,
      levels,
      intensity,
      sh,
      e.mode === 'refraction' ? e.ratio : 0,
      e.reflectivity,
      e.combine,
    );
  device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
  return [
    { binding: 188, resource: view },
    { binding: 189, resource: sampler },
    { binding: 190, resource: { buffer } },
  ];
}
/** A record's material, engine and placeholder ext row: hidden (not enumerable), so `{...record}` copies skip them. */
const recordMaterial = Symbol('material'),
  recordRuntime = Symbol('runtime'),
  recordExt = Symbol('ext'),
  recordState = Symbol('renderState');
type MaterialRecord = PBRMaterial & {
  [recordMaterial]: Material;
  [recordRuntime]: Engine;
  [recordExt]: number[];
  [recordState]?: PBRRenderState;
};
/**
 * A live record field, read from the record's material on every access. Enumerable and configurable like the data
 * properties they replace (`{...record}` copies still work). The getters are made once and shared by every record, so
 * all records have one shape and gltf-pro's per-draw reads of them stay fast with thousands of materials.
 */
const live = (read: (m: Material, g: MaterialRecord) => unknown): PropertyDescriptor => ({
  get(this: MaterialRecord) {
    return read(this[recordMaterial], this);
  },
  enumerable: true,
  configurable: true,
});
const surfaceFields: PropertyDescriptorMap = {
  extendedFrame: { value: true, enumerable: true },
  // gltf-pro's placeholder record makes its own `side` accessor per record, which gave every record a hidden class
  // of its own (gltf-pro's reads of thousands of records then missed every inline cache).
  side: {
    get(this: MaterialRecord) {
      return this[recordMaterial].side;
    },
    set(this: MaterialRecord, v: MaterialSide) {
      this[recordMaterial].side = v;
    },
    enumerable: true,
    configurable: true,
  },
  base: live((m) => m.color),
  emission: live(emissionOf),
  factors: live((m) => m.factors),
  settings: live((m) => m.settings),
  // The native frame holds 13 slots; the sparse map uniform owns all 17 slots.
  uvt: live((m) => m.uvt.slice(0, extendedOf(m) ? 144 : 104)),
  // Physical: gltf-pro's factor-only variant (five maps), live arrays, and the tinted-blend constant.
  physical: live((m) => m.physical),
  ext: live((m, g) => m.ext ?? g[recordExt]),
  volume: live((m) => m.volume),
  dispersion: live((m) => m.dispersion),
  tint: live((m) => m.tint),
  extended: live(extendedOf),
  extensions: live(extensionsOf),
  // Read from the material, unless this primitive was given a native state of its own (undefined gives it back).
  renderState: {
    ...live((m, g) => g[recordState] ?? renderStateOf(m)),
    set(this: MaterialRecord, v: PBRRenderState | undefined) {
      this[recordState] = v;
      // A steady material's draws are not looked at again, so the next frame has to see a change.
      this[recordMaterial]['changes'] = changeStamp();
    },
  },
  displacement: live((m, g) => {
    const device = g[recordRuntime].gpu;
    return (device && m.caster(device, g[recordRuntime])) ?? displacementOf(m, device, g[recordRuntime]);
  }),
  clip: live((m, g) => clipOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  clipHardware: live((m, g) => hardwareClip(m, g[recordRuntime].gpu)),
  surfaceClip: live((m, g) => surfaceClipOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  castMask: live((m, g) => castMaskOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  pickMask: live((m, g) => pickMaskOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  vertexAlpha: live((m) => m.vertexColors),
  wireframe: {
    ...live((m) => m.wireframe),
    set(this: MaterialRecord, v: boolean) {
      this[recordMaterial].wireframe = v;
    },
  },
};
/** gltf-pro's shading hook for a record of `m` (see `surface`). */
class MaterialShading implements PBRMaterialShading {
  /** What `liveStamp` last saw of the arrays a caller may write in place (colour, emissive, specular, factors, settings). */
  private readonly seen = new Float64Array(liveFloats).fill(Number.NaN);
  constructor(
    private readonly m: Material,
    private readonly runtime: Engine,
  ) {}
  get replacesTextures(): boolean {
    return mapped(this.m) || bare(this.m);
  }
  get texturedTint(): boolean {
    return mapped(this.m) && this.m.transmissive;
  }
  get shaderRevision(): number {
    return shaderRevision(this.m);
  }
  /**
   * gltf-pro `PBRMaterialShading.version`: the largest change stamp of the material and of every texture its bindings
   * read, so it grows whenever anything this record, `shader()`, `lit()` or `bindings()` reads changes. NaN where that
   * cannot be known: a material with its own `shader` or `bindings` (NodeMaterial, WgslMaterial), physical maps, an
   * envMap that is not a Texture, or a texture that is not steady (`Texture.steady`).
   */
  get version(): number {
    const m = this.m,
      device = this.runtime.gpu;
    if (
      !device ||
      m.shader !== Material.prototype.shader ||
      m.bindings !== Material.prototype.bindings ||
      mapped(m) ||
      m['added'].some((v) => v.bindings)
    )
      return Number.NaN;
    let v = liveStamp(m, this.seen);
    const base = m['baseMaps'],
      features = m['featureTextures'],
      surface = m['surfaceTextures'],
      toon = m['toonMap'],
      env = m['env'].map;
    for (let i = 0; i < base.length; i++) {
      const s = base[i]?.steady(device) ?? 0;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    for (let i = 0; i < features.length; i++) {
      const s = features[i]?.steady(device) ?? 0;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    for (let i = 0; i < surface.length; i++) {
      const s = surface[i]?.steady(device) ?? 0;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    if (toon) {
      const s = toon.steady(device);
      if (s !== s) return s;
      if (s > v) v = s;
    }
    if (env) {
      const s = env instanceof Texture ? env.steady(device) : Number.NaN;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    return v;
  }
  shader(code: string, group: number): string {
    const m = this.m,
      key = featureKey(m, code),
      own = m.shader(code, group),
      out = key ? featureShader(own, group, key) : own,
      env = m.envMap ? envMapShader(out, group, envKind(m)) : out;
    const feed = (from: string) => {
      let text = from;
      for (const v of m['added']) text = v.shader(text, group, m);
      return text;
    };
    if (!m['clipping'].length) return feed(env);
    const device = this.runtime.gpu;
    if (device && hardwareClip(m, device)) {
      const text = feed(env);
      if (roomForDistances(text, device)) return markClipDistances(text, group, 199, 'materialClip');
    }
    return feed(clipShader(env, group));
  }
  lit(code: string): string {
    const m = this.m,
      out = litShader(m, code);
    let text = m.relight(m.envMap ? envMapLit(out, envKind(m)) : out);
    for (const v of m['added']) if (v.lit) text = v.lit(text, m);
    return text;
  }
  bindings(): GPUBindGroupEntry[] {
    const m = this.m,
      runtime = this.runtime,
      entries = featureBindings(m, runtime.gpu!, runtime, m.bindings(runtime.gpu!, runtime)),
      all = m.envMap ? [...entries, ...envBindings(m, runtime.gpu!, runtime)] : entries,
      out = m['clipping'].length ? [...all, { binding: 199, resource: clipUniform(m, runtime.gpu!, runtime) }] : all;
    if (!m['added'].length) return out;
    return [...out, ...m['added'].flatMap((v) => v.bindings?.(runtime.gpu!, runtime, m) ?? [])];
  }
}
/**
 * A gltf-pro material record for `m` from the placeholder record's fields `blank`, read on every draw: values, maps
 * (through the shading hook), physical rows, render state and wireframe all follow a live edit from the next frame.
 * It is made in one `defineProperties` call from shared descriptors (redefining data properties as accessors would
 * leave each record a dictionary of its own).
 */
function surface(blank: PropertyDescriptorMap, m: Material, runtime: Engine): PBRMaterial {
  const fields: PropertyDescriptorMap = {};
  for (const key of Object.keys(blank)) if (!(key in surfaceFields) && key !== 'shading') fields[key] = blank[key];
  Object.assign(fields, surfaceFields);
  fields.shading = { enumerable: true, value: new MaterialShading(m, runtime) };
  fields[recordMaterial] = { value: m };
  fields[recordRuntime] = { value: runtime };
  fields[recordExt] = { value: blank.ext?.value };
  fields[recordState] = { value: undefined, writable: true };
  return Object.defineProperties({}, fields) as PBRMaterial;
}
const shaderRevisions = new WeakMap<Material, { key: number; revision: number }>();
let nextShaderRevision = 1;
/**
 * gltf-pro `PBRMaterialShading.shaderRevision` for `m`: a number that changes whenever what `shader()` and `lit()` read
 * of `m` changes, so gltf-pro composes a material's shader again only then. Their text depends on the shading (fixed),
 * whether the material is bare, the feature maps in use, the feature switches, the normal maps and anisotropy (the
 * tangent frame), the envMap, the clipping planes and the optional features. Materials with physical maps (their plan follows texture loading)
 * and classes or instances with their own `shader` give NaN: composed on every frame, as before.
 */
function shaderRevision(m: Material): number {
  if (m.shader !== Material.prototype.shader || mapped(m)) return Number.NaN;
  const used = featureMapsUsed(m),
    surface = surfaceUsed(m),
    key =
      +bare(m) |
      (+used[0] << 1) |
      (+used[1] << 2) |
      (+used[2] << 3) |
      (+used[3] << 4) |
      (+m.flatShading << 5) |
      (+m.vertexColors << 6) |
      (+m.fog << 7) |
      (+m.toneMapped << 8) |
      (+(m.normalMap != null) << 9) |
      (+(m.clearcoatNormalMap != null) << 10) |
      (+m.extensions.includes('anisotropy') << 11) |
      (+(m.envMap != null) << 12) |
      (+(m['clipping'].length > 0) << 13) |
      (+surface[0] << 14) |
      (+surface[1] << 15) |
      (+surface[2] << 16) |
      (+surface[3] << 17) |
      (+m.dithering << 18) |
      (+m.clipIntersection << 19),
    variant = key + m['addedStamp'] * 1048576;
  let state = shaderRevisions.get(m);
  if (!state) shaderRevisions.set(m, (state = { key: variant, revision: nextShaderRevision++ }));
  else if (state.key !== variant) {
    state.key = variant;
    state.revision = nextShaderRevision++;
  }
  return state.revision;
}
/**
 * `m`'s change stamp, after a look at the arrays a caller may write element by element (`color[0] = 1`; gltf-pro's
 * factor and settings rows): a difference from `seen` (what one record last saw of them) takes a new stamp.
 */
function liveStamp(m: Material, seen: Float64Array): number {
  const a = m['rgba'],
    b = m['glow'],
    c = m['highlight'],
    d = m.factors,
    e = m.settings;
  if (
    seen[0] !== a[0] ||
    seen[1] !== a[1] ||
    seen[2] !== a[2] ||
    seen[3] !== a[3] ||
    seen[4] !== b[0] ||
    seen[5] !== b[1] ||
    seen[6] !== b[2] ||
    seen[7] !== c[0] ||
    seen[8] !== c[1] ||
    seen[9] !== c[2] ||
    seen[10] !== d[0] ||
    seen[11] !== d[1] ||
    seen[12] !== d[2] ||
    seen[13] !== d[3] ||
    seen[14] !== e[0] ||
    seen[15] !== e[1] ||
    seen[16] !== e[2] ||
    seen[17] !== e[3]
  ) {
    for (let i = 0; i < 4; i++) {
      seen[i] = a[i];
      seen[10 + i] = d[i];
      seen[14 + i] = e[i];
    }
    for (let i = 0; i < 3; i++) {
      seen[4 + i] = b[i];
      seen[7 + i] = c[i];
    }
    m['changes'] = changeStamp();
  }
  return m['changes'];
}
let tracking = false;
/**
 * Makes every Material setter, `setUVTransform` and `copy` take a new change stamp (`Material.changes`), from the first
 * mesh record on: a record's `version` (gltf-pro `PBRMaterialShading.version`) then lets gltf-pro skip reading a steady
 * material's rows and bindings. Edits before that need no stamp, as gltf-pro has derived nothing yet.
 */
function trackChanges(): void {
  if (tracking) return;
  tracking = true;
  const proto = Material.prototype as unknown as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
    const set = descriptor.set;
    if (set)
      Object.defineProperty(proto, key, {
        ...descriptor,
        set(this: Material, v: unknown) {
          set.call(this, v);
          this['changes'] = changeStamp();
        },
      });
  }
  for (const key of ['setUVTransform', 'copy']) {
    const method = proto[key] as (this: Material, ...args: unknown[]) => unknown;
    Object.defineProperty(proto, key, {
      ...Object.getOwnPropertyDescriptor(proto, key),
      value(this: Material, ...args: unknown[]) {
        const out = method.apply(this, args);
        this['changes'] = changeStamp();
        return out;
      },
    });
  }
}
const records = new WeakMap<Material, WeakMap<Engine, PBRMaterial>>();
/**
 * The gltf-pro material record the meshes of `runtime` draw `m` with: one per material, as glTF primitives that use one
 * material share one record, so gltf-pro derives a material's shader, pipeline and uniform rows once per frame for
 * all of its meshes instead of once per mesh. `blank` is gltf-pro's record for the placeholder material (`{}`).
 */
function recordOf(m: Material, runtime: Engine, blank: PropertyDescriptorMap): PBRMaterial {
  let byEngine = records.get(m);
  if (!byEngine) records.set(m, (byEngine = new WeakMap()));
  let record = byEngine.get(runtime);
  if (!record) {
    trackChanges();
    record = surface(blank, m, runtime);
    byEngine.set(runtime, record);
  }
  return record;
}
/** A materials mesh: the gltf-pro model plus the live `material` it draws with (read by @margoengine/exporters `exportModel`). */
export type MaterialMesh<M extends Material | readonly Material[] = Material> = PBRModel & {
  /**
   * The material it draws with, or a frozen snapshot of the material array (one per slot that `groups` index).
   * Assigning swaps it live from the next frame: one Material for a single-material mesh, an array of the same length
   * for a grouped one. Transform, geometry, render order, skin and shadow, clustered, fog, IBL, SSAO, OIT and
   * selection registrations stay; transparent sorting and picking follow the new material.
   */
  material: M extends Material ? Material : readonly Material[];
  /**
   * Live edit: repacks `geometry` (the same object edited in place, or a new one) into this mesh's buffers, reusing
   * the GPU buffers while the data fits (gltf-pro `writeGeometry`). Groups may move and resize but keep their number
   * and material slots. With `range`, only those vertices are repacked and uploaded and the vertex count must stay;
   * indices and groups are not read, so a per-frame UV animation uploads just its vertices. Raycasts,
   * `worldTriangles`, bounds and exports see the new data at once.
   */
  setGeometry(geometry: MeshGeometry, range?: GeometryRange): MaterialMesh<M>;
  /** Draw order among materials meshes, lower first within the opaque and the transparent phase; live. */
  renderOrder: number;
};
/**
 * Creates one gltf-pro `PBRModel`. A material array draws the geometry's nonempty, nonoverlapping triangle groups;
 * uncovered indices are omitted. A scalar material draws the entire geometry, ignoring groups.
 * Move it with `model.root`, edit it with `model.setGeometry(geometry, range?)`, remove it with `model.destroy()`.
 * It works with `shadows.add`, `clustered.add` and `ssao.add` like a loaded glTF. Textures are not disposed with the model.
 */
export function createMesh<M extends Material | readonly Material[]>(
  engine: EngineKernel,
  geometry: MeshGeometry,
  material: M,
  { renderOrder = 0 }: { renderOrder?: number } = {},
): MaterialMesh<M> {
  const array = Array.isArray(material),
    // The current material of each slot (`groups[i].materialIndex`); a swap replaces the contents.
    assigned: Material[] = array ? [...(material as readonly Material[])] : [material as Material];
  if (!assigned.length || assigned.some((m) => !(m instanceof Material)) || !Number.isFinite(renderOrder))
    throw new TypeError(
      'Material mesh needs a Material or a non-empty array of them and a finite renderOrder; pass those.',
    );
  assigned.forEach(usable);
  const data = packGeometry(geometry),
    groups = meshGroups(geometry, data.indices.length, assigned, array);
  const prepared = groups.map((g) => ({ vertices: data.vertices, indices: groupIndices(data.indices, g) }));
  const runtime = engineRuntime(engine),
    set = queue(runtime);
  // Placeholder glTF materials: every value gltf-pro draws comes from the slot's current Material (`surface`).
  const doc = {
    asset: { version: '2.0' },
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: groups.map((g) => ({ material: g.materialIndex })) }],
    materials: assigned.map(() => ({})),
  };
  const model = new PBRModel(
    engine,
    new GLTFAsset(doc, [], undefined, { materials: extendedMaterials }),
    [],
    [prepared],
  );
  // Per-engine uniform buffers are retained once per material in use and released when the last use goes.
  const held = new Map<Material, () => void>(),
    hold = () => {
      const used = new Set(groups.map((g) => assigned[g.materialIndex]));
      for (const m of used) if (!held.has(m)) held.set(m, retainMaps(m, runtime));
      for (const [m, release] of held)
        if (!used.has(m)) {
          held.delete(m);
          release();
        }
    };
  hold();
  model.onDispose(() => {
    for (const release of held.values()) release();
    held.clear();
  });
  // gltf-pro's record for the placeholder material, copied for each material's shared record (own arrays each).
  const fresh = model.primitives[0].material,
    blank = Object.getOwnPropertyDescriptors(fresh);
  for (const key of Object.keys(blank)) {
    const value = blank[key].value;
    if (Array.isArray(value)) blank[key].value = [...value];
  }
  // Own and writable, so the per-frame routing check (primitiveAfterOpaque) reads it without a prototype-chain miss.
  blank.extension ??= { value: undefined, writable: true, configurable: true, enumerable: false };
  const point = () => {
    for (const primitive of model.primitives)
      primitive.material = recordOf(assigned[primitive.definition.material!], runtime, blank);
  };
  point();
  const entry: Entry = {
    model,
    materials: groups.map((g) => assigned[g.materialIndex]),
    order: renderOrder,
    opaque: false,
    blend: false,
    distance: 0,
  };
  let snapshot = array ? Object.freeze([...assigned]) : undefined;
  const swap = (next: Material | readonly Material[]) => {
    if (model.disposed) throw new MargoError('disposed', 'Material mesh is disposed; create a new mesh');
    const list: readonly unknown[] = Array.isArray(next) ? next : [next];
    if (Array.isArray(next) !== array || list.length !== assigned.length || list.some((m) => !(m instanceof Material)))
      throw new TypeError(
        array
          ? `Material mesh material must be an array of ${assigned.length} Materials, one per slot; pass one for each`
          : 'Material mesh material must be one Material; pass a Material (a material array needs a grouped mesh)',
      );
    (list as Material[]).forEach(usable);
    assigned.splice(0, assigned.length, ...(list as Material[]));
    point();
    for (let i = 0; i < groups.length; i++) entry.materials[i] = assigned[groups[i].materialIndex];
    if (array) snapshot = Object.freeze([...assigned]);
    hold();
  };
  model.registerPasses = () => {};
  try {
    runtime.use(model);
  } catch (error) {
    model.dispose();
    throw error;
  }
  set.add(entry);
  model.onDispose(() => set.delete(entry));
  let current = groups,
    owned = false; // false while the primitives still draw packGeometry's cached (shareable) arrays
  const setGeometry = (next: MeshGeometry, range?: GeometryRange): MaterialMesh<M> => {
    if (model.disposed) throw new MargoError('disposed', 'Material mesh is disposed; create a new mesh');
    const mesh = model as MaterialMesh<M>;
    if (range === undefined) {
      const data = pack(next),
        list = meshGroups(next, data.indices.length, assigned, array);
      if (list.length !== current.length || list.some((g, i) => g.materialIndex !== current[i].materialIndex))
        throw new RangeError('Mesh geometry groups must keep their number and material slots; create a new mesh');
      model.writeGeometry(list.map((g) => ({ vertices: data.vertices, indices: groupIndices(data.indices, g) })));
      current = list;
    } else {
      const vertices = model.primitives[0].vertices,
        total = vertices.length / 20,
        { start, count } = range;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(count) ||
        start < 0 ||
        count < 1 ||
        start + count > total
      )
        throw new RangeError(
          'Mesh geometry range must be whole vertices inside the mesh; pass start >= 0 and count >= 1',
        );
      if (vertexCount(next) !== total)
        throw new RangeError('A ranged mesh geometry update keeps the vertex count; omit the range to resize');
      const chunk = packVertices(next, start, start + count);
      let moved = false;
      for (let i = 0; i < chunk.length && !moved; i += 20)
        for (let k = 0; k < 3; k++) moved ||= chunk[i + k] !== vertices[start * 20 + i + k];
      // Moved positions need new array identities: BVH and selection caches key on them.
      const target = owned && !moved ? vertices : vertices.slice();
      target.set(chunk, start * 20);
      model.writeGeometry(
        model.primitives.map((p) => ({ vertices: target, indices: moved ? p.indices.slice() : p.indices })),
        range,
      );
    }
    owned = true;
    packed.delete(next);
    return mesh;
  };
  return Object.defineProperties(model, {
    material: { get: () => snapshot ?? assigned[0], set: swap },
    renderOrder: {
      get: () => entry.order,
      set: (v: number) => {
        if (typeof v !== 'number')
          throw new TypeError('Material mesh renderOrder must be a number; set a finite number');
        if (!Number.isFinite(v)) throw new RangeError('Material mesh renderOrder must be finite; set a finite number');
        entry.order = v;
        set.reorder();
      },
    },
    setGeometry: { value: setGeometry },
  }) as MaterialMesh<M>;
}
/** A materials mesh drawn as `instances.count` instances in one draw call; `instances` holds each one's matrix, tint and UV transform. */
export type InstancedMesh<M extends Material | readonly Material[] = Material> = MaterialMesh<M> & {
  readonly instances: PBRInstances;
};
/**
 * `createMesh` for `capacity` copies in one instanced draw: `mesh.instances.setMatrixAt(i, m)`, `setColorAt`, `setUVTransformAt`
 * (an atlas region), `count`. Instance matrices are relative to `mesh.root`. Works with shadows, clustered, IBL, fog and SSAO.
 */
export function createInstancedMesh<M extends Material | readonly Material[]>(
  engine: EngineKernel,
  geometry: MeshGeometry,
  material: M,
  capacity: number,
  options: { renderOrder?: number } = {},
): InstancedMesh<M> {
  const instances = new PBRInstances(capacity),
    model = createMesh(engine, geometry, material, options);
  for (const primitive of model.primitives) primitive.instances = instances;
  return Object.defineProperty(model, 'instances', { value: instances }) as InstancedMesh<M>;
}
