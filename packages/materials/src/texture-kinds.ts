// What a Texture needs beyond 8-bit 2D images: data formats (float, one and two channel), 3D and array layouts,
// borrowed GPU textures, transcoded KTX2 files, cube maps (six faces or an equirectangular image) and Display P3
// pixels converted to the linear sRGB working space. Texture (built-material.ts) keeps its per-device slots and calls
// these to allocate, upload and convert.
import { MargoError } from '@margoengine/math/errors';
import { P3_TO_SRGB } from '@margoengine/math/color';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Texel formats a data texture may hold: 8-bit unorm, half and full float, one, two or four channels. */
export type DataFormat =
  | 'rgba8unorm'
  | 'rg8unorm'
  | 'r8unorm'
  | 'rgba16float'
  | 'rg16float'
  | 'r16float'
  | 'rgba32float'
  | 'rg32float'
  | 'r32float';
/** How a texture is sampled: one image, layers of images, a volume, or the six faces of a cube. */
export type TextureDimension = '2d' | '2d-array' | '3d' | 'cube';
/**
 * Raw texels, row 0 first (at UV v = 0), then each further layer or slice: `width * height * depth` texels of `format`
 * (default `rgba8unorm`). 8-bit formats take bytes; half floats take a Uint16Array of binary16 bits or a Float32Array
 * (converted on upload); 32-bit floats take a Float32Array. `depth` (default 1) counts the layers of a `'2d-array'`
 * texture or the slices of a `'3d'` one, chosen with the Texture's `dimension` option.
 */
export interface DataImage {
  data: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
  width: number;
  height: number;
  depth?: number;
  format?: DataFormat;
}
/** A cube render target (environment `CubeCamera`'s shape): a six-layer texture and its `'cube'` view. */
export interface CubeTarget {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
}
/** One mip level of a transcoded KTX2 file. */
export interface TranscodedMip {
  data: Uint8Array;
  width: number;
  height: number;
}
/** What `@margoengine/decoders` `KTX2Decoder.transcode` returns (structural, so materials does not import decoders). */
export interface TranscodedTexture {
  width: number;
  height: number;
  mipmaps: readonly TranscodedMip[];
  format: string;
  target: string;
  srgb: boolean;
  hasAlpha?: boolean;
}

/** Bytes per texel and the typed arrays each data format accepts. */
const formats: Record<DataFormat, { bytes: number; half?: boolean; wide?: boolean }> = {
  rgba8unorm: { bytes: 4 },
  rg8unorm: { bytes: 2 },
  r8unorm: { bytes: 1 },
  rgba16float: { bytes: 8, half: true },
  rg16float: { bytes: 4, half: true },
  r16float: { bytes: 2, half: true },
  rgba32float: { bytes: 16, wide: true },
  rg32float: { bytes: 8, wide: true },
  r32float: { bytes: 4, wide: true },
};
/** True for the 32-bit float formats, which filter only on devices with the `float32-filterable` feature. */
export const unfilterable = (format: string): boolean => /32float$/.test(format);
/** Checks a data image (`dimension` from the Texture options) and returns its texel count per layer and its depth. */
export function validateData(s: DataImage, dimension: TextureDimension): { format: DataFormat; depth: number } {
  const format = s.format ?? 'rgba8unorm',
    info = formats[format],
    depth = s.depth ?? 1,
    { width, height } = s;
  if (!info)
    throw new TypeError(
      `Texture data format '${String(format)}' is not supported; use rgba8unorm, rg8unorm, r8unorm, rgba16float, rg16float, r16float, rgba32float, rg32float or r32float`,
    );
  if (dimension === 'cube')
    throw new TypeError("Texture data cannot be a cube; pass six faces to CubeTexture or dimension '2d-array'");
  if (![width, height, depth].every(Number.isSafeInteger) || width < 1 || height < 1 || depth < 1)
    throw new RangeError('Texture data width, height and depth must be positive integers; pass whole texel counts');
  if (dimension === '2d' && depth !== 1)
    throw new TypeError("Texture data with depth > 1 needs dimension '2d-array' or '3d'; set the dimension option");
  if (width * height * depth > 16_777_216 * 4)
    throw new RangeError('Texture data exceeds 67,108,864 texels; split it into smaller textures');
  const d = s.data,
    bytes8 = d instanceof Uint8Array || d instanceof Uint8ClampedArray,
    fits = info.half
      ? d instanceof Uint16Array || d instanceof Float32Array
      : info.wide
        ? d instanceof Float32Array
        : bytes8;
  if (!fits)
    throw new TypeError(
      `Texture ${format} data must be ${info.half ? 'a Uint16Array of half-float bits or a Float32Array' : info.wide ? 'a Float32Array' : 'a Uint8Array'}; pass that array type`,
    );
  const components = info.bytes / (info.half ? 2 : info.wide ? 4 : 1);
  if (d.length < width * height * depth * components)
    throw new RangeError(
      `Texture ${format} data must hold width * height * depth * ${components} values; pass a longer array`,
    );
  return { format, depth };
}
const halfScratch = new Float32Array(1),
  halfBits = new Uint32Array(halfScratch.buffer);
/** IEEE 754 binary16 bits of `value`, rounded to nearest even; overflow becomes infinity, NaN stays NaN. */
export function toHalf(value: number): number {
  halfScratch[0] = value;
  const x = halfBits[0],
    sign = (x >>> 16) & 0x8000,
    exponent = (x >>> 23) & 0xff,
    mantissa = x & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  const e = exponent - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = mantissa | 0x800000,
      shift = 14 - e,
      half = m >>> shift,
      rest = m & ((1 << shift) - 1),
      mid = 1 << (shift - 1);
    return sign | (half + +(rest > mid || (rest === mid && (half & 1) === 1)));
  }
  const half = (e << 10) | (mantissa >>> 13),
    rest = mantissa & 0x1fff;
  return sign | (half + +(rest > 0x1000 || (rest === 0x1000 && (half & 1) === 1)));
}
/**
 * binary16 bits of every value in `data`, rounded to nearest even like {@link toHalf}. Uses the built-in
 * `Float16Array` bulk conversion where the runtime has it (same IEEE rounding), else a plain loop; never the
 * per-element callback of `Uint16Array.from`, which is about 20x slower on large images.
 */
export function toHalfArray(data: Float32Array, native = true): Uint16Array {
  const F16 = native
    ? (globalThis as { Float16Array?: new (source: Float32Array) => ArrayBufferView<ArrayBuffer> }).Float16Array
    : undefined;
  if (F16) return new Uint16Array(new F16(data).buffer);
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = toHalf(data[i]);
  return out;
}
/** The bytes to upload for `s` (half floats from a Float32Array converted). */
function bytesOf(s: DataImage, format: DataFormat): ArrayBufferView {
  if (formats[format].half && s.data instanceof Float32Array) return toHalfArray(s.data);
  return s.data;
}
/** The GPU format of data `format` with an sRGB-decoding view when `srgb` (8-bit RGBA only). */
export const dataGPUFormat = (format: DataFormat, srgb: boolean): GPUTextureFormat =>
  format === 'rgba8unorm' && srgb ? 'rgba8unorm-srgb' : format;
/** Writes `s` (or the box `region` [x0, y0, z0, x1, y1, z1] of it) into mip 0 of `texture`, from array layer `layer`. */
export function writeData(
  device: GPUDevice,
  texture: GPUTexture,
  s: DataImage,
  format: DataFormat,
  region?: number[],
  layer = 0,
): void {
  const bytes = formats[format].bytes,
    { width: w, height: h } = s,
    depth = s.depth ?? 1,
    data = bytesOf(s, format);
  const [x, y, z, x1, y1, z1] = region ?? [0, 0, 0, w, h, depth];
  device.queue.writeTexture(
    { texture, origin: [x, y, z + layer] },
    data as ArrayBufferView<ArrayBuffer>,
    { offset: ((z * h + y) * w + x) * bytes, bytesPerRow: w * bytes, rowsPerImage: h },
    [x1 - x, y1 - y, z1 - z],
  );
}

/** A borrowed GPU texture's view dimension: its own for 3D, `cube` when asked (six layers), else 2D or 2D array. */
export function gpuDimension(texture: GPUTexture, asked: TextureDimension | undefined): TextureDimension {
  const layers = texture.depthOrArrayLayers,
    own: TextureDimension = texture.dimension === '3d' ? '3d' : layers > 1 ? '2d-array' : '2d';
  const dimension = asked ?? own;
  if (texture.dimension !== '2d' && texture.dimension !== '3d')
    throw new TypeError('Texture GPUTexture must be 2D or 3D; pass a 2d or 3d texture');
  if (
    dimension !== own &&
    !(dimension === 'cube' && layers === 6 && own === '2d-array') &&
    !(dimension === '2d-array' && own === '2d')
  )
    throw new TypeError(
      `Texture dimension '${dimension}' does not fit a ${texture.dimension} GPUTexture of ${layers} layer(s); omit dimension or pass '${own}'`,
    );
  return dimension;
}

/** Block size, block bytes and the device feature of each format a KTX2 transcode produces. */
const transcoded: Record<string, { block: number; bytes: number; feature?: string }> = {
  'rgba8unorm': { block: 1, bytes: 4 },
  'bc7-rgba-unorm': { block: 4, bytes: 16, feature: 'texture-compression-bc' },
  'astc-4x4-unorm': { block: 4, bytes: 16, feature: 'texture-compression-astc' },
  'etc2-rgba8unorm': { block: 4, bytes: 16, feature: 'texture-compression-etc2' },
};
/** Checks a transcoded KTX2 result and returns its base (linear) GPU format. */
export function validateTranscoded(s: TranscodedTexture): string {
  const base = typeof s.format === 'string' ? s.format.replace(/-srgb$/, '') : '',
    info = transcoded[base];
  if (!info)
    throw new TypeError(
      `Texture KTX2 format '${String(s.format)}' is not supported; transcode to rgba8, bc7, astc-4x4 or etc2 with KTX2Decoder`,
    );
  const levels = Math.floor(Math.log2(Math.max(s.width, s.height))) + 1;
  if (
    !Number.isSafeInteger(s.width) ||
    !Number.isSafeInteger(s.height) ||
    s.width < 1 ||
    s.height < 1 ||
    !Array.isArray(s.mipmaps) ||
    !s.mipmaps.length ||
    s.mipmaps.length > levels
  )
    throw new RangeError('Texture KTX2 result has invalid dimensions or mip levels; pass KTX2Decoder.transcode output');
  s.mipmaps.forEach((m, level) => {
    const width = Math.max(1, s.width >> level),
      height = Math.max(1, s.height >> level),
      size = Math.ceil(width / info.block) * info.bytes * Math.ceil(height / info.block);
    if (m?.width !== width || m.height !== height || !(m.data instanceof Uint8Array) || m.data.byteLength !== size)
      throw new RangeError(
        `Texture KTX2 mip ${level} does not match a ${width}x${height} ${base} level; pass KTX2Decoder.transcode output unchanged.`,
      );
  });
  return base;
}
/** A GPU texture of the transcoded `s` (all its mips), viewable with and without sRGB decoding. */
export function uploadTranscoded(device: GPUDevice, s: TranscodedTexture, base: string): GPUTexture {
  const info = transcoded[base];
  if (info.feature && !device.features.has(info.feature))
    throw new MargoError(
      'unsupported',
      `Texture KTX2 format ${base} needs the device feature ${info.feature}; transcode with a KTX2Decoder created for this device`,
    );
  if (Math.max(s.width, s.height) > device.limits.maxTextureDimension2D)
    throw new RangeError('Texture exceeds device limit; resize the image to the GPU maxTextureDimension2D or less.');
  const texture = device.createTexture({
    size: [s.width, s.height],
    format: base as GPUTextureFormat,
    viewFormats: [(base + '-srgb') as GPUTextureFormat],
    mipLevelCount: s.mipmaps.length,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  s.mipmaps.forEach((mip, level) => {
    // Small block-compressed mips copy at their physical (block-rounded) size.
    const blocks = Math.ceil(mip.width / info.block);
    device.queue.writeTexture(
      { texture, mipLevel: level },
      mip.data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: blocks * info.bytes },
      [blocks * info.block, Math.ceil(mip.height / info.block) * info.block],
    );
  });
  return texture;
}

const pipelines = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();
function pipeline(device: GPUDevice, key: string, code: string, format: GPUTextureFormat): GPURenderPipeline {
  let cache = pipelines.get(device);
  if (!cache) pipelines.set(device, (cache = new Map()));
  let p = cache.get(key + format);
  if (!p) {
    const module = device.createShaderModule({ code });
    p = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    });
    cache.set(key + format, p);
  }
  return p;
}
const triangle = `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}`;
// Display P3 shares sRGB's transfer curve (the -srgb staging view decodes it); its primaries become linear sRGB through
// @margoengine/math's P3_TO_SRGB, so colours outside sRGB keep negative channels. WGSL matrices take columns.
const p3 = () =>
  `${triangle}
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let c=textureLoad(image,vec2i(p.xy),0);
  let m=mat3x3f(${[0, 3, 6, 1, 4, 7, 2, 5, 8].map((k) => P3_TO_SRGB[k].toPrecision(9)).join(',')});
  return vec4f(m*c.rgb,c.a);
}`;
/** Converts the sRGB-decoded Display P3 texels of `staging` into mip 0 of `target` (rgba16float) as linear sRGB. */
export function convertP3(device: GPUDevice, staging: GPUTexture, target: GPUTexture): void {
  const p = pipeline(device, 'p3', p3(), 'rgba16float'),
    group = device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: staging.createView({ format: 'rgba8unorm-srgb' }) }],
    }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
  pass.setPipeline(p);
  pass.setBindGroup(0, group);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}
// Equirect convention of @margoengine/environment: u = 0.5 + atan2(x, -z) / 2pi (centre faces -Z), v = acos(y) / pi
// (row 0 straight up); cube faces in WebGPU layer order with u right and v down the rows.
const equirect = `${triangle}
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
@group(0) @binding(2) var<uniform> face:vec4f;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let uv=p.xy/face.y*2-1; var d=vec3f(-uv.x,-uv.y,-1.0); let k=u32(face.x);
  if(k==0u){d=vec3f(1.0,-uv.y,-uv.x);}else if(k==1u){d=vec3f(-1.0,-uv.y,uv.x);}else if(k==2u){d=vec3f(uv.x,1.0,uv.y);}
  else if(k==3u){d=vec3f(uv.x,-1.0,-uv.y);}else if(k==4u){d=vec3f(uv.x,-uv.y,1.0);}
  let n=normalize(d); let x=select(n.x,0.0,n.x==0.0); let z=select(-n.z,0.0,n.z==0.0);
  let v=acos(clamp(n.y,-1.0,1.0))/3.14159265;
  return textureSampleLevel(image,imageSampler,vec2f(0.5+atan2(x,z)/6.28318531,select(v,1.0-v,face.w>0.5)),face.z);
}`;
/**
 * Renders the six faces of mip 0 of `target` from the equirectangular `view` (its own mips through `sampler`);
 * `flipped` when the image's top row is at v = 1 (an image uploaded with flipY).
 */
export function equirectToCube(
  device: GPUDevice,
  view: GPUTextureView,
  sampler: GPUSampler,
  sourceWidth: number,
  target: GPUTexture,
  flipped: boolean,
): void {
  const p = pipeline(device, 'equirect', equirect, target.format),
    size = target.width,
    // The source level whose texels match a face texel at the equator: 4 faces span the width.
    lod = Math.max(0, Math.log2(sourceWidth / (4 * size))),
    encoder = device.createCommandEncoder(),
    buffers: GPUBuffer[] = [];
  for (let k = 0; k < 6; k++) {
    const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    buffers.push(buffer);
    device.queue.writeBuffer(buffer, 0, new Float32Array([k, size, lod, +flipped]));
    const group = device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer } },
        ],
      }),
      pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView({
              dimension: '2d',
              baseMipLevel: 0,
              mipLevelCount: 1,
              baseArrayLayer: k,
              arrayLayerCount: 1,
            }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
    pass.setPipeline(p);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
  for (const buffer of buffers) buffer.destroy();
}
