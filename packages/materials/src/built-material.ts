/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine } from '@margoengine/core/extension';
import {
  GLTFAsset,
  PBRModel,
  textureTransform,
  textureCoordinates,
  type PreparedGeometry,
  type PBRMaterial,
  type PBRMaterialShading,
  type PBRRenderState,
  type TextureTransform,
  type MaterialSide,
} from '@margoengine/gltf-pro';
import { PBRInstances } from '@margoengine/gltf-pro/instancing';
import { extendedMaterials } from '@margoengine/gltf-pro/extended';
import { physicalMapsShader } from './physical-maps.js';
import { depthDistanceShader } from './depth-distance.js';
import { featureMaps, featureShader } from './features.js';
import { catcherLit } from './catcher.js';
import { readResponse } from '../../shared/loading.js';
import { clusterBrdf } from '../../shared/light-terms.js';
import { MargoError } from '@margoengine/math/errors';
import { parseColor, type ColorInput } from '@margoengine/math/color';
export type { TextureTransform, MaterialSide } from '@margoengine/gltf-pro';
export { packAtlas, transformUVs, type Atlas, type AtlasOptions } from './atlas.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
export type RawImage = { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
/** ImageData and `{data,width,height}` upload as raw RGBA8 rows (row 0 at UV v=0); other sources use copyExternalImageToTexture. */
export type TextureSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLVideoElement
  | VideoFrame
  | ImageData
  | RawImage;
export type Wrap = 'repeat' | 'clamp' | 'mirror';
export type Filter = 'linear' | 'nearest';
export interface TextureOptions {
  colorSpace?: 'srgb' | 'linear';
  wrapS?: Wrap;
  wrapT?: Wrap;
  magFilter?: Filter;
  minFilter?: Filter;
  mipmaps?: boolean;
  anisotropy?: number;
  flipY?: boolean;
}
/** A pixel rectangle of a texture source, `x` and `y` from its top-left corner (raw data: its first row). */
export interface TextureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Slot {
  texture?: GPUTexture;
  /** The mipmaps option the GPU copy was made with. */
  mips?: boolean;
  views: Map<string, GPUTextureView>;
  sampler: GPUSampler;
  /** The sampler options revision and mip setting `sampler` was made with. */
  samplerVersion: number;
  samplerMips: boolean;
  version: number;
  time?: number;
  /** Union [x0, y0, x1, y1] of `update(region)` calls since this up-to-date copy was last uploaded. */
  region?: number[];
}
const wraps = { repeat: 'repeat', clamp: 'clamp-to-edge', mirror: 'mirror-repeat' } as const,
  maxPixels = 16_777_216;
const optional = (list: readonly unknown[]) => (v: unknown) => v === undefined || list.includes(v);
/** Valid values of each texture option, and how the fix reads when one is not. */
const textureOptions: Record<keyof TextureOptions, [(v: unknown) => boolean, string]> = {
  colorSpace: [optional(['srgb', 'linear']), "'srgb', 'linear' or undefined (the slot's default)"],
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
const mipShader = `struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;}
@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var imageSampler:sampler;
@fragment fn fragment(i:Out)->@location(0) vec4f {return textureSample(image,imageSampler,i.uv);}`;
const shared = new WeakMap<
  GPUDevice,
  {
    white: GPUTextureView;
    normal: GPUTextureView;
    anisotropy?: GPUTextureView;
    black?: GPUTextureView;
    sampler: GPUSampler;
    pipelines: Map<string, GPURenderPipeline>;
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
const raw = (s: unknown): s is RawImage =>
  !!s && typeof s === 'object' && 'data' in s && (s.data instanceof Uint8Array || s.data instanceof Uint8ClampedArray);
/** A shareable texture. GPU copies are made lazily per device; video sources re-upload whenever `currentTime` changes, other sources on `update()`. */
export class Texture {
  private version = 0;
  private samplerVersion = 0;
  /** A flipY, colorSpace or mipmaps change makes the next `update()` a full one. */
  private reshaped = false;
  private readonly slots = new Map<GPUDevice, Slot>();
  /** The options in effect (a copy of the constructor's); the accessors below change them. */
  readonly options: TextureOptions;
  constructor(
    readonly source: TextureSource,
    options: TextureOptions = {},
    private readonly owned = false,
  ) {
    const o = options,
      [w, h] = dimensions(source);
    if (
      !source ||
      typeof source !== 'object' ||
      !(Object.keys(textureOptions) as (keyof TextureOptions)[]).every((k) => textureOptions[k][0](o[k]))
    )
      throw new TypeError('Invalid texture source or options');
    this.options = { ...o };
    if (
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
  get width(): number {
    return dimensions(this.source)[0];
  }
  get height(): number {
    return dimensions(this.source)[1];
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
    return this.options.flipY ?? true;
  }
  set flipY(v: boolean) {
    this.setOption('flipY', v);
  }
  /** Undefined: sRGB for colour slots (map, emissive, sheen and specular colour), linear for the others. */
  get colorSpace(): 'srgb' | 'linear' | undefined {
    return this.options.colorSpace;
  }
  set colorSpace(v: 'srgb' | 'linear' | undefined) {
    this.setOption('colorSpace', v);
  }
  get mipmaps(): boolean {
    return this.options.mipmaps ?? !this.isVideo;
  }
  set mipmaps(v: boolean) {
    this.setOption('mipmaps', v);
  }
  private setOption<K extends keyof TextureOptions>(key: K, v: TextureOptions[K]): void {
    const [valid, fix] = textureOptions[key];
    if (!valid(v))
      throw new (key === 'anisotropy' && typeof v === 'number' ? RangeError : TypeError)(
        'Texture ' + key + ' is invalid; set ' + fix,
      );
    this.options[key] = v;
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
    if (region === undefined || this.reshaped) {
      this.version++;
      this.reshaped = false;
      return;
    }
    if (!region || typeof region !== 'object')
      throw new TypeError('Texture update region must be an object; pass {x, y, width, height} or nothing');
    const { x, y, width, height } = region,
      [w, h] = dimensions(this.source);
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
  /** Frees GPU copies and closes an ImageBitmap created by `loadTexture`. A later use of a still-open source uploads again. */
  dispose(): void {
    for (const slot of this.slots.values()) slot.texture?.destroy();
    this.slots.clear();
    if (this.owned) (this.source as ImageBitmap).close();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @internal View and sampler for a material slot, or undefined while the source has no pixels (unloaded image or video). */
  bind(device: GPUDevice, srgb: boolean): [GPUTextureView, GPUSampler] | undefined {
    const s = this.source,
      o = this.options,
      [w, h] = dimensions(s),
      video = this.isVideo;
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
      device.lost?.then(() => this.slots.delete(device));
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
      throw new RangeError('Texture exceeds device limit');
    let t = slot.texture;
    const pending = slot.version !== this.version;
    // A new colour space or mip setting needs a new GPU copy; it is made on the upload after `update()`.
    if (
      !t ||
      t.width !== w ||
      t.height !== h ||
      (pending &&
        (slot.mips !== (o.mipmaps ?? !video) ||
          (o.colorSpace !== undefined && t.format !== (o.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm'))))
    ) {
      t?.destroy();
      const format = o.colorSpace ? o.colorSpace === 'srgb' : srgb,
        levels = (o.mipmaps ?? !video) ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
      slot.mips = o.mipmaps ?? !video;
      t = slot.texture = device.createTexture({
        size: [w, h],
        format: format ? 'rgba8unorm-srgb' : 'rgba8unorm',
        viewFormats: [format ? 'rgba8unorm' : 'rgba8unorm-srgb'],
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
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
      else device.queue.copyExternalImageToTexture({ source: s, flipY: o.flipY ?? true }, { texture: t }, [w, h]);
      slot.version = this.version;
      slot.time = currentTime;
      slot.region = undefined;
      mipmaps(device, t);
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
        device.queue.copyExternalImageToTexture(
          { source: s, origin: [x, y], flipY: flip },
          { texture: t, origin: [x, flip ? h - y1 : y] },
          size,
        );
      mipmaps(device, t);
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
    const t = slot.texture!,
      format = this.options.colorSpace ? t.format : srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    let view = slot.views.get(format);
    if (!view) {
      view = t.createView({ format });
      slot.views.set(format, view);
    }
    return view;
  }
}
function mipmaps(device: GPUDevice, texture: GPUTexture): void {
  if (texture.mipLevelCount < 2) return;
  const d = defaults(device),
    format = texture.format;
  let pipeline = d.pipelines.get(format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: mipShader });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    });
    d.pipelines.set(format, pipeline);
  }
  const encoder = device.createCommandEncoder(),
    level = (baseMipLevel: number) => texture.createView({ format, baseMipLevel, mipLevelCount: 1 });
  for (let i = 1; i < texture.mipLevelCount; i++) {
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: level(i - 1) },
        { binding: 1, resource: d.sampler },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: level(i), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
}
/** Fetches http(s), blob: or data: image bytes (64 MiB, 4096x4096 pixels at most) into an ImageBitmap the texture owns. */
export async function loadTexture(
  url: string | URL,
  { signal, ...options }: TextureOptions & { signal?: AbortSignal } = {},
): Promise<Texture> {
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:', 'blob:', 'data:'].includes(target.protocol))
    throw new TypeError('Texture URL must use HTTP(S), blob: or data:');
  const response = await fetch(target, { signal }),
    bytes = await readResponse(response, { maxBytes: 64 * 1024 * 1024, signal, label: 'Texture download' });
  const bitmap = await createImageBitmap(new Blob([bytes], { type: response.headers.get('content-type') ?? '' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > maxPixels) throw new RangeError('Texture exceeds decoded size limit');
    return new Texture(bitmap, options, true);
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

/** `lambert` is diffuse only; `phong` adds a Blinn-Phong highlight (`specular`, `shininess`); `basic` is unlit. */
export type Shading = 'standard' | 'basic' | 'normal' | 'matcap' | 'depth' | 'distance' | 'lambert' | 'phong';
export type DepthPacking = 'basic' | 'rgba';
export type Blending = 'normal' | 'additive' | 'multiply' | 'none';
/** A live linear colour array (what gltf-pro reads every frame) whose `set` takes any colour input, like the option. */
type LiveColor = number[] & { set(value: ColorInput): number[] };
/**
 * Physical options (three.js MeshPhysicalMaterial names, glTF KHR_materials_* meaning; gltf-pro's physical shader draws
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
  map?: Texture | null;
  metalRoughnessMap?: Texture | null;
  normalMap?: Texture | null;
  normalScale?: number;
  aoMap?: Texture | null;
  aoMapIntensity?: number;
  emissiveMap?: Texture | null;
  matcap?: Texture | null;
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
  transparent?: boolean;
  alphaTest?: number;
  /** Faces drawn by triangle meshes. Explicit side takes precedence over doubleSided. */
  side?: MaterialSide;
  doubleSided?: boolean;
  /** Draws triangle edges instead of filled surfaces; defaults to false. Live, like all render state below. */
  wireframe?: boolean;
  blending?: Blending;
  depthWrite?: boolean;
  depthTest?: boolean;
  colorWrite?: boolean;
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
const mapSlots = [
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
export type MapSlot = (typeof mapSlots)[number];
const slots = ['map', 'metalRoughnessMap', 'normalMap', 'aoMap', 'emissiveMap', 'matcap'] as const,
  names = ['baseMap', 'mrMap', 'normalMap', 'aoMap', 'emissiveMap', 'matcap'];
const unit = (v: unknown, label: string) => {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new RangeError('Material ' + label + ' must be in [0, 1]');
  return v;
};
const rasterMask = (v: number, label: string): number => {
  if (typeof v !== 'number')
    throw new TypeError('Material ' + label + ' must be a number; set an unsigned 32-bit integer');
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff)
    throw new RangeError('Material ' + label + ' is out of range; set an integer from 0 through 4294967295');
  return v;
};
const rasterFloat = (v: number, label: string): number => {
  if (typeof v !== 'number') throw new TypeError('Material ' + label + ' must be a number; set a finite float32 value');
  if (!Number.isFinite(Math.fround(v)))
    throw new RangeError('Material ' + label + ' is not finite as float32; set a finite float32 value');
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
const finiteFloat = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)))
    throw new RangeError('Material ' + label + ' must be finite as float32');
  return v;
};
/** Render state, live: each change selects the matching beauty pipeline on the next draw. */
interface Raster {
  blending: Blending;
  depthWrite: boolean | undefined;
  depthTest: boolean;
  colorWrite: boolean;
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
  if (typeof v !== 'boolean') throw new TypeError('Material ' + label + ' must be a boolean; set true or false');
  return v;
};
const oneOf = (list: readonly string[], kind: string) => (v: unknown, label: string) => {
  if (!list.includes(v as string)) throw new TypeError('Material ' + label + ' is invalid; set ' + kind);
  return v;
};
const rasterChecks: Record<keyof Raster, (v: never, label: string) => unknown> = {
  blending: oneOf(['normal', 'additive', 'multiply', 'none'], "'normal', 'additive', 'multiply' or 'none'"),
  depthWrite: (v, label) => (v === undefined ? v : flag(v, label)),
  depthTest: flag,
  colorWrite: flag,
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
    throw new RangeError('Material ' + label + ' number must be a 0xrrggbb sRGB colour; set 0x000000 through 0xffffff');
  const v =
    typeof c === 'number' || (typeof c === 'string' && /^#([0-9a-f]{3}){1,2}$/i.test(c))
      ? (parseColor(c) as number[])
      : Array.isArray(c)
        ? [...c]
        : [];
  if (v.length < 3 || v.length > 4)
    throw new TypeError(
      'Invalid material ' + label + "; set '#rrggbb', '#rgb', 0xrrggbb or linear [r, g, b] with components 0-1",
    );
  v.forEach((x) => unit(x, label));
  return v;
};
/** `values` with a `set(input)` that writes the parsed colour into it (opacity only from a four-component array). */
const liveColor = (values: number[], label: string): LiveColor =>
  Object.defineProperty(values, 'set', {
    value(input: ColorInput) {
      const v = linear(input, label);
      for (let k = 0; k < Math.min(v.length, values.length); k++) values[k] = v[k];
      return values;
    },
  }) as LiveColor;
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
        ['fn surface(i:Out,front:bool)->Surface {', 'fn surface(i:Out,front:bool)->Surface {\n  _=&mat_phong;'] as [
          string,
          string,
        ],
      ]
    : []),
];
const outputs: Record<Exclude<Shading, 'standard' | 'depth' | 'distance' | 'lambert' | 'phong'>, string> = {
  basic: 'return vec4f(mat_out(s.base.rgb+s.emissive),alpha);',
  normal: 'return vec4f(normalize((f.view*vec4f(s.n,0)).xyz)*0.5+0.5,alpha);',
  matcap:
    'let e=normalize(-(f.view*vec4f(i.position,1)).xyz);let n=normalize((f.view*vec4f(s.n,0)).xyz);let x=normalize(vec3f(e.z,0,-e.x));let m=textureSample(mat_matcap,mat_matcapS,vec2f(dot(x,n),dot(cross(e,x),n))*0.495+0.5).rgb;return vec4f(mat_out(s.base.rgb*m),alpha);',
};
const encode =
  'fn mat_out(c:vec3f)->vec3f {if(f.settings.w>0.5){return c;}let x=clamp(c,vec3f(0),vec3f(1));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}';
const patched = new Map<string, Map<string, string>>();
/** A material's GPU state for one engine: `buffer` its shading's uniform, `features` the feature uniform (features.ts). */
type MapState = {
  refs: number;
  device?: GPUDevice;
  buffer?: GPUBuffer;
  values?: Float32Array;
  features?: GPUBuffer;
  featureData?: Float32Array;
  displacement?: { buffer: GPUBuffer; view: GPUTextureView; sampler: GPUSampler };
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
    state.buffer?.destroy();
    state.features?.destroy();
    mapStates.get(m)?.delete(engine);
  };
}
function materialBuffer(
  m: Material,
  device: GPUDevice,
  owner: object,
  size: number,
  field: 'buffer' | 'features' = 'buffer',
): GPUBuffer {
  const state = mapState(m, owner);
  if (state.device !== device || !state[field]) {
    state[field]?.destroy();
    state.device = device;
    const buffer = (state[field] = device.createBuffer({
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    device.lost?.then(() => {
      if (state[field] === buffer) {
        buffer.destroy();
        state[field] = undefined;
      }
    });
  }
  return state[field];
}
const lit: readonly Shading[] = ['standard', 'lambert', 'phong'];
/** The feature maps `m` draws now; a lightMap means nothing to normal, matcap, depth and distance output. */
function featureMapsUsed(m: Material): boolean[] {
  const maps = m['featureTextures'];
  return [!!maps[0], !!maps[1], !!maps[2], !!maps[3] && (m.shading === 'basic' || lit.includes(m.shading))];
}
/** The feature letters (features.ts) `m` uses now: its shader variant. */
function featureKey(m: Material): string {
  const [alpha, bump, displacement, light] = featureMapsUsed(m);
  return (
    (alpha ? 'a' : '') +
    (bump ? 'b' : '') +
    (displacement ? 'd' : '') +
    (light ? (m.shading === 'basic' ? 'u' : 'l') : '') +
    (m.flatShading && m.shading !== 'basic' && m.shading !== 'depth' && m.shading !== 'distance' ? 'f' : '') +
    (m.vertexColors ? '' : 'v') +
    (lit.includes(m.shading) ? (m.fog ? '' : 'g') + (m.toneMapped ? '' : 't') : '') +
    (m.normalMap || m.clearcoatNormalMap || m.extensions.includes('anisotropy') ? 'n' : '')
  );
}
/** The feature uniform of `m` for `owner`, written with its current values. */
function featureUniform(m: Material, device: GPUDevice, owner: object): GPUBuffer {
  const buffer = materialBuffer(m, device, owner, 144, 'features'),
    data = (mapState(m, owner).featureData ??= new Float32Array(36));
  data.set(m['featureValues']);
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
/** Feature map `k`'s view and sampler; a map still loading reads white (alpha, bump) or black (displacement, light). */
const featureTexture = (m: Material, k: number, device: GPUDevice) =>
  m['featureTextures'][k]!.bind(device, k === 3) ?? fallback(device, k < 2 ? 0 : 3);
/** `entries` plus the feature uniform and maps `m` uses now (none for a material without features). */
function featureBindings(m: Material, device: GPUDevice, owner: object, entries: GPUBindGroupEntry[]) {
  const maps = featureMapsUsed(m);
  if (!maps.some(Boolean)) return entries;
  const out = [...entries, { binding: 198, resource: { buffer: featureUniform(m, device, owner) } }];
  maps.forEach((used, k) => {
    if (!used) return;
    const [view, sampler] = featureTexture(m, k, device);
    out.push({ binding: 180 + k * 2, resource: view }, { binding: 181 + k * 2, resource: sampler });
  });
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
function mapped(m: Material): boolean {
  return !!m.physical && (m.physical.length > 12 || mapSlots.slice(5).some((k) => m[k] != null));
}
function mapPlan(m: Material) {
  const textures: { texture: Texture; srgb: boolean; fallback: number }[] = [],
    samplers: Texture[] = [];
  const slots = mapSlots.map((k, i): readonly [number, number] | null => {
    const texture = m[k];
    if (!texture) return null;
    if (!(texture instanceof Texture)) throw new TypeError('Material ' + k + ' must be a Texture');
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
  const lit = shading === 'lambert' || shading === 'phong',
    edits = lit ? litEdits(shading === 'phong') : [];
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
    throw new Error('Materials require the standard gltf-pro PBR shader');
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
  private glowScale = 1;
  /** On/off features (features.ts letters f...). */
  private readonly switches = { flatShading: false, vertexColors: true, fog: true, toneMapped: true };
  /** gltf-pro layout: [roughness, metalness, normalScale, aoMapIntensity] and [alphaMode, alphaTest, side (front 0, double 1, back 2), 0]. */
  readonly factors: number[];
  readonly settings: number[];
  private blend: boolean;
  /** gltf-pro layout: two rows per map slot (offset*rotation*scale), in `MapSlot` order. */
  readonly uvt: number[] = [];
  private uvDefault = textureTransform({}, 0);
  map: Texture | null;
  metalRoughnessMap: Texture | null;
  normalMap: Texture | null;
  aoMap: Texture | null;
  emissiveMap: Texture | null;
  matcap: Texture | null;
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
    this.featureValues[3] = rasterFloat(v, 'lightMapIntensity');
  }
  private readonly physicalTextures: (Texture | null)[] = Array(12).fill(null);
  private setMap(i: number, value: Texture | null): void {
    const key = mapSlots[i + 5] as keyof PhysicalOptions;
    if (value != null) {
      if (!(value instanceof Texture)) throw new TypeError('Material ' + key + ' must be a Texture');
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
      !['standard', 'basic', 'normal', 'matcap', 'depth', 'distance', 'lambert', 'phong'].includes(shading) ||
      (o.side !== undefined && !['front', 'back', 'double'].includes(o.side)) ||
      [o.transparent, o.doubleSided].some((v) => v !== undefined && typeof v !== 'boolean') ||
      (o.normalScale !== undefined && !Number.isFinite(o.normalScale))
    )
      throw new TypeError('Invalid material options');
    for (const slot of [...mapSlots, 'matcap'] as const)
      if (o[slot] != null && !(o[slot] instanceof Texture))
        throw new TypeError('Material ' + slot + ' must be a Texture');
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
    this.shininess = o.shininess ?? 30;
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
      'emissiveIntensity',
      'flatShading',
      'vertexColors',
      'fog',
      'toneMapped',
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
    if (v !== 'basic' && v !== 'rgba') throw new TypeError('Invalid material depthPacking');
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
    if (i) this.attenuation[i - 1] = v;
    else this.volume[0] = v;
    const [r, g, b, d] = this.attenuation;
    this.volume[1] = r ** (1 / d);
    this.volume[2] = g ** (1 / d);
    this.volume[3] = b ** (1 / d);
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
    if (!Number.isFinite(v)) throw new RangeError('Invalid clearcoatNormalScale');
    this.enable('clearcoatNormalScale')[2] = v;
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
    if (!Number.isFinite(v)) throw new RangeError('Invalid anisotropyRotation');
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
    if (!(v >= 1 && v < Infinity)) throw new RangeError('Invalid iridescenceIOR');
    this.enable('iridescenceIOR')[13] = v;
  }
  get iridescenceThicknessRange(): readonly [number, number] {
    return [this.physical?.[14] ?? 100, this.physical?.[15] ?? 400];
  }
  set iridescenceThicknessRange(v: readonly [number, number]) {
    if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite) || v[0] < 0 || v[1] < v[0])
      throw new RangeError('Invalid iridescenceThicknessRange');
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
    if (!(v >= 1 && v < Infinity)) throw new RangeError('Material ior must be a finite number >= 1');
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
    if (!Number.isFinite(v)) throw new RangeError('Invalid normalScale');
    this.factors[2] = v;
  }
  get aoMapIntensity(): number {
    return this.factors[3];
  }
  set aoMapIntensity(v: number) {
    this.factors[3] = unit(v, 'aoMapIntensity');
  }
  /** Phong's Blinn-Phong exponent, finite and >= 0: higher is a smaller, sharper highlight. */
  get shininess(): number {
    return this.gloss;
  }
  set shininess(v: number) {
    if (typeof v !== 'number' || !(v >= 0 && v < Infinity))
      throw new RangeError('Material shininess must be a finite number >= 0 (default 30)');
    this.gloss = v;
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
    if (!['front', 'back', 'double'].includes(v)) throw new TypeError('Invalid material side');
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
    slot?: MapSlot | 'alphaMap' | 'bumpMap' | 'displacementMap' | 'lightMap',
  ): this {
    const f = featureMaps.indexOf(slot as (typeof featureMaps)[number]),
      i = slot === undefined || f >= 0 ? -1 : mapSlots.indexOf(slot as MapSlot);
    if (slot !== undefined && f < 0 && i < 0) throw new TypeError('Invalid UV transform slot');
    const transform: TextureTransform = f === 3 ? { texCoord: 1, ...t } : (t ?? {}),
      { texCoord } = textureCoordinates({ extensions: { KHR_texture_transform: transform } }),
      rows = textureTransform(transform, texCoord);
    if (f >= 0) {
      this.featureValues.splice(4 + f * 8, 8, ...rows);
      return this;
    }
    if (i < 0) {
      this.uvDefault = rows;
      for (let k = 0; k < 3; k++) this.featureValues.splice(4 + k * 8, 8, ...rows);
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
    for (const [owner, state] of states ?? [])
      if (!state.refs) {
        state.buffer?.destroy();
        state.features?.destroy();
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
    return materialShader(source, group, this.shading);
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
        const pair = texture.bind(device, srgb);
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
    for (let i = 0; i < (this.shading === 'matcap' ? 6 : 5); i++) {
      const bound = this[slots[i]]?.bind(device, i === 0 || i >= 4) ?? [i === 2 ? d.normal : d.white, d.sampler];
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

/** Any CPU geometry with three.js UV orientation; `@margoengine/geometry` output fits directly. Colors are RGB or RGBA, floats 0-1 or bytes. */
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
    throw new RangeError('Mismatched mesh geometry attributes');
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
  if (v.some((value) => !Number.isFinite(value))) throw new RangeError('Non-finite mesh geometry attribute');
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
        throw new RangeError('Invalid mesh geometry index');
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
      throw new RangeError('Invalid mesh geometry group');
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
}
interface Phase {
  entry: Entry;
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
const queues = new WeakMap<Engine, MaterialDraws>(),
  late = (m: Material) => m.transparent || m.transmissive;
let serial = 0;
/** One pass per engine draws every material mesh: opaque then transparent, each by renderOrder; transparent meshes back to front. */
function queue(runtime: Engine): MaterialDraws {
  let draws = queues.get(runtime);
  if (draws) return draws;
  const members: Entry[] = [],
    phases: Phase[] = [],
    tail: Phase[] = [],
    distance = new Map<Entry, number>(),
    name = 'materials:' + serial++;
  let opaqueEnd = 0,
    arranged = false;
  // Opaque order is stable until membership or a transparent flag changes. Distance sorts only the late phase.
  const arrange = () => {
    phases.length = 0;
    for (let i = 0; i < members.length; i++) {
      const entry = members[i],
        opaque = entry.materials.some((m) => !late(m)),
        blend = entry.materials.some(late);
      entry.opaque = opaque;
      entry.blend = blend;
      if (opaque) phases.push({ entry, blend: false, phase: blend ? 'opaque' : 'all' });
      if (blend) phases.push({ entry, blend: true, phase: opaque ? 'blend' : 'all' });
    }
    phases.sort((a, b) => +a.blend - +b.blend || a.entry.order - b.entry.order);
    opaqueEnd = 0;
    while (opaqueEnd < phases.length && !phases[opaqueEnd].blend) opaqueEnd++;
    arranged = true;
  };
  runtime.use({
    name,
    setup() {},
    dispose() {
      queues.delete(runtime);
    },
    registerPasses(graph) {
      graph.add({
        name,
        order: 1,
        execute: (c) => {
          if (c.backend !== 'webgpu') return;
          let stale = !arranged;
          if (!stale)
            for (let i = 0; i < members.length; i++) {
              const entry = members[i],
                opaque = entry.materials.some((m) => !late(m)),
                blend = entry.materials.some(late);
              if (opaque !== entry.opaque || blend !== entry.blend) {
                stale = true;
                break;
              }
            }
          if (stale) arrange();
          distance.clear();
          if (opaqueEnd < phases.length) {
            const eye = c.camera.position;
            for (let i = opaqueEnd; i < phases.length; i++) {
              const entry = phases[i].entry;
              if (distance.has(entry)) continue;
              const matrix = entry.model.primitives[0].node.matrix;
              distance.set(entry, Math.hypot(eye[0] - matrix[12], eye[1] - matrix[13], eye[2] - matrix[14]));
            }
            const count = phases.length - opaqueEnd;
            for (let i = 0; i < count; i++) tail[i] = phases[opaqueEnd + i];
            tail.length = count;
            tail.sort((a, b) => a.entry.order - b.entry.order || distance.get(b.entry)! - distance.get(a.entry)!);
            for (let i = 0; i < count; i++) phases[opaqueEnd + i] = tail[i];
          }
          for (let i = 0; i < phases.length; i++) {
            const item = phases[i];
            item.entry.model.draw(c, 'beauty', c.color, c.depth, item.phase);
          }
        },
      });
    },
  });
  draws = {
    add(entry) {
      members.push(entry);
      arranged = false;
    },
    delete(entry) {
      const index = members.indexOf(entry);
      if (index >= 0) members.splice(index, 1);
      arranged = false;
    },
    reorder() {
      arranged = false;
    },
  };
  queues.set(runtime, draws);
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
/**
 * Points gltf-pro material record `g` at `current()`, read on every draw: values, maps (through the shading hook),
 * physical rows, render state and wireframe all follow a material swap or a live edit from the next frame.
 */
function surface(g: PBRMaterial, current: () => Material, runtime: Engine): void {
  const plain = g.ext,
    // Enumerable and configurable like the data properties they replace (`{...record}` copies still work).
    get = (read: (m: Material) => unknown): PropertyDescriptor => ({
      get: () => read(current()),
      enumerable: true,
      configurable: true,
    });
  Object.defineProperties(g, {
    extendedFrame: { value: true, enumerable: true },
    base: get((m) => m.color),
    emission: get(emissionOf),
    factors: get((m) => m.factors),
    settings: get((m) => m.settings),
    // The native frame holds 13 slots; the sparse map uniform owns all 17 slots.
    uvt: get((m) => m.uvt.slice(0, extendedOf(m) ? 144 : 104)),
    // Physical: gltf-pro's factor-only variant (five maps), live arrays, and the tinted-blend constant.
    physical: get((m) => m.physical),
    ext: get((m) => m.ext ?? plain),
    volume: get((m) => m.volume),
    dispersion: get((m) => m.dispersion),
    tint: get((m) => m.tint),
    extended: get(extendedOf),
    extensions: get(extensionsOf),
    renderState: get(renderStateOf),
    displacement: get((m) => displacementOf(m, runtime.gpu, runtime)),
    wireframe: {
      ...get((m) => m.wireframe),
      set: (v: boolean) => {
        current().wireframe = v;
      },
    },
    shading: {
      enumerable: true,
      value: {
        get replacesTextures() {
          return mapped(current());
        },
        get texturedTint() {
          const m = current();
          return mapped(m) && m.transmissive;
        },
        shader: (code: string, group: number) => {
          const m = current(),
            key = featureKey(m),
            own = m.shader(code, group);
          return key ? featureShader(own, group, key) : own;
        },
        lit: (code: string) => litShader(current(), code),
        bindings: () => {
          const m = current();
          return featureBindings(m, runtime.gpu!, runtime, m.bindings(runtime.gpu!, runtime));
        },
      } satisfies PBRMaterialShading,
    },
  });
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
    throw new TypeError('Invalid material mesh');
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
  for (const primitive of model.primitives) {
    const slot = primitive.definition.material!;
    // Primitives of one slot share their glTF material.
    if (!Object.hasOwn(primitive.material, 'extendedFrame')) surface(primitive.material, () => assigned[slot], runtime);
  }
  const entry: Entry = {
    model,
    materials: groups.map((g) => assigned[g.materialIndex]),
    order: renderOrder,
    opaque: false,
    blend: false,
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
/** A materials mesh drawn as `instances.count` instances in one draw call (three.js InstancedMesh); `instances` holds each one's matrix, tint and UV transform. */
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
