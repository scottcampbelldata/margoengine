// GPU image-based lighting: the PMREMGenerator + scene.environment equivalent for WebGPU.
import type {EngineKernel, EnginePlugin} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import type {FloatImage} from './hdr.js';
import {sanitizeLighting, toHalfLighting} from './half.js';
import {radianceToIrradianceSH, evaluateSH} from './sh.js';
import * as wgsl from './shaders.js';

declare const GPUBufferUsage: {MAP_READ: number; COPY_DST: number; COPY_SRC: number; UNIFORM: number; STORAGE: number};
declare const GPUTextureUsage: {COPY_SRC: number; COPY_DST: number; TEXTURE_BINDING: number; STORAGE_BINDING: number; RENDER_ATTACHMENT: number};
declare const GPUMapMode: {READ: number};

/** Six RGBA float faces in WebGPU layer order +X, -X, +Y, -Y, +Z, -Z, each `size * size * 4` floats, row 0 at the top. */
export interface CubeFaces {size: number; faces: readonly Float32Array[]}
/** An equirectangular FloatImage (from parseHDR or parseEXR) or six cube faces. */
export type EnvironmentSource = FloatImage | CubeFaces;

export interface EnvironmentOptions {
  /** Edge of the source cube map (power of two). Default: equirect width / 4 rounded down to a power of two, clamped to 16..1024. */
  size?: number;
  /** Edge of prefiltered mip 0 (power of two, at most `size`). Default min(256, size). */
  specularSize?: number;
  /** Number of prefiltered mips, roughness 0 at mip 0 to roughness 1 at the last. Default: down to 8 px, at least 2. */
  specularMips?: number;
  /** GGX importance samples per prefiltered texel. Default 256. */
  samples?: number;
  /** BRDF LUT edge. Default 128. */
  brdfSize?: number;
  /** Importance samples per BRDF LUT texel. Default 512. */
  brdfSamples?: number;
  /** Largest source mip edge integrated for spherical harmonics. Default 64. */
  shSize?: number;
  /** Upload the equirect as rgba32float when the device has `float32-filterable`. Default true. */
  float32?: boolean;
  /** Keep the equirect texture for the background's sharp `equirect` mode. Default true. */
  keepEquirect?: boolean;
  /** Keep the CPU source so the environment can be rebuilt after device loss. Default true. */
  keepSource?: boolean;
  /** Environment rotation about +Y in radians (shared by IBL lookups and the background). Default 0. */
  rotation?: number;
  /** Multiplier for IBL lighting (envMapIntensity). Default 1. */
  intensity?: number;
  /** Plugin name when passed to `engine.use`. Default 'environment'. */
  name?: string;
}

interface Settings {size: number; specularSize: number; specularMips: number; samples: number; brdfSize: number; brdfSamples: number; shSize: number; float32: boolean; keepEquirect: boolean}

interface Resources {
  device: GPUDevice;
  cube: GPUTexture; cubeView: GPUTextureView;
  specular: GPUTexture; specularView: GPUTextureView;
  brdf: GPUBuffer;
  equirect?: GPUTexture; equirectView?: GPUTextureView;
  sampler: GPUSampler; sh: GPUBuffer; params: GPUBuffer;
  radiance: Float32Array; irradiance: Float32Array;
}

type ComputeKey = 'equirectToCube' | 'downsample' | 'sphericalHarmonics' | 'brdfLut';
const pipelineCache = /* @__PURE__ */ new WeakMap<GPUDevice, Map<string, GPUComputePipeline | GPURenderPipeline>>();
function cached<T extends GPUComputePipeline | GPURenderPipeline>(device: GPUDevice, key: string, create: () => T): T {
  let cache = pipelineCache.get(device);
  if (!cache) pipelineCache.set(device, cache = new Map());
  let result = cache.get(key) as T | undefined;
  if (!result) cache.set(key, result = create());
  return result;
}
const pipeline = (device: GPUDevice, key: ComputeKey): GPUComputePipeline =>
  cached(device, key, () => device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code: wgsl[key]}), entryPoint: 'main'}}));
// The prefilter is a fragment pass: cube sampling with explicit LOD in compute shaders reads stale seam
// texels on some Vulkan implementations (SwiftShader), while the fragment path is reliable everywhere.
const prefilterPipeline = (device: GPUDevice): GPURenderPipeline => cached(device, 'prefilter', () => {
  const module = device.createShaderModule({code: wgsl.prefilter});
  return device.createRenderPipeline({layout: 'auto', vertex: {module, entryPoint: 'vertexMain'}, fragment: {module, entryPoint: 'fragmentMain', targets: [{format: 'rgba16float'}]}, primitive: {topology: 'triangle-list'}});
});

const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
const floorPowerOfTwo = (n: number) => 2 ** Math.floor(Math.log2(Math.max(1, n)));
const isCube = (source: EnvironmentSource): source is CubeFaces => 'faces' in source;
const isDevice = (target: GPUDevice | EngineKernel): target is GPUDevice => typeof (target as GPUDevice).createTexture === 'function';

function deviceOf(target: GPUDevice | EngineKernel): GPUDevice {
  if (isDevice(target)) return target;
  const device = engineRuntime(target).gpu;
  if (!device) throw new Error('Environment requires the WebGPU backend');
  return device;
}

function validateSource(source: EnvironmentSource): void {
  if (!source || typeof source !== 'object') throw new TypeError('Expected an equirect FloatImage or CubeFaces');
  if (isCube(source)) {
    if (!isPowerOfTwo(source.size) || source.faces.length !== 6 || source.faces.some(face => !(face instanceof Float32Array) || face.length !== source.size * source.size * 4))
      throw new TypeError('CubeFaces needs a power-of-two size and six Float32Array RGBA faces of size*size*4');
  } else if (!(source.data instanceof Float32Array) || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || !(source.width > 0 && source.height > 0) || source.data.length !== source.width * source.height * 4)
    throw new TypeError('Equirect FloatImage needs width, height and RGBA Float32Array data of width*height*4');
}

function resolveSettings(device: GPUDevice, source: EnvironmentSource, options: EnvironmentOptions): Settings {
  const limit = floorPowerOfTwo(device.limits.maxTextureDimension2D);
  if (isCube(source) && options.size !== undefined && options.size !== source.size) throw new RangeError('CubeFaces size must equal the environment size');
  const size = isCube(source) ? source.size : options.size ?? Math.min(1024, limit, Math.max(16, floorPowerOfTwo(source.width / 4)));
  if (!isPowerOfTwo(size) || size > limit) throw new RangeError(`Environment size must be a power of two up to ${limit}`);
  const specularSize = options.specularSize ?? Math.min(256, size);
  if (!isPowerOfTwo(specularSize) || specularSize > size) throw new RangeError('specularSize must be a power of two no larger than size');
  const maxMips = Math.log2(specularSize) + 1;
  const specularMips = options.specularMips ?? Math.min(maxMips, Math.max(2, Math.log2(specularSize) - 2));
  if (!Number.isInteger(specularMips) || specularMips < 1 || specularMips > maxMips) throw new RangeError(`specularMips must be an integer from 1 to ${maxMips}`);
  const integer = (value: number | undefined, fallback: number, min: number, max: number, label: string) => {
    const v = value ?? fallback;
    if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
    return v;
  };
  return {
    size, specularSize, specularMips,
    samples: integer(options.samples, 256, 1, 65536, 'samples'),
    brdfSize: integer(options.brdfSize, 128, 1, 4096, 'brdfSize'),
    brdfSamples: integer(options.brdfSamples, 512, 1, 65536, 'brdfSamples'),
    shSize: integer(options.shSize, 64, 1, 4096, 'shSize'),
    float32: options.float32 ?? true,
    keepEquirect: options.keepEquirect ?? true,
  };
}

// Halves an RGBA float image until it fits the device texture limit.
function fitEquirect(image: FloatImage, limit: number): FloatImage {
  let {width, height, data} = image;
  while (width > limit || height > limit) {
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1), out = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += data[(Math.min(height - 1, y * 2 + dy) * width + Math.min(width - 1, x * 2 + dx)) * 4 + c];
      out[(y * w + x) * 4 + c] = sum / 4;
    }
    width = w; height = h; data = out;
  }
  return {width, height, data};
}

// Runs synchronous encoding inside validation and out-of-memory error scopes, then reports any GPU error.
async function guarded(device: GPUDevice, encode: () => void): Promise<void> {
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let thrown: unknown;
  try {encode();} catch (error) {thrown = error;}
  const validation = device.popErrorScope(), memory = device.popErrorScope();
  const failure = (await validation.catch(() => null)) ?? (await memory.catch(() => null));
  if (thrown) throw thrown;
  if (failure) throw new Error(`Environment processing failed: ${failure.message}`);
}

async function build(device: GPUDevice, source: EnvironmentSource, settings: Settings, rotation: number, intensity: number): Promise<Resources> {
  const created: Array<GPUTexture | GPUBuffer> = [];
  const track = <T extends GPUTexture | GPUBuffer>(resource: T): T => {created.push(resource); return resource;};
  const {size, specularSize, specularMips} = settings;
  const cubeMips = Math.log2(size) + 1;
  const storageUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
  const renderUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
  const uniform = (data: ArrayBufferView & {buffer: ArrayBuffer}) => {
    const buffer = track(device.createBuffer({size: Math.max(16, data.byteLength), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
    device.queue.writeBuffer(buffer, 0, data); return buffer;
  };
  const level = (texture: GPUTexture, mip: number) => texture.createView({dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1});
  const groups = (n: number) => Math.ceil(n / 8);
  const dispatch = (encoder: GPUCommandEncoder, key: ComputeKey, entries: GPUBindGroupEntry[], x: number, y: number, z: number) => {
    const compute = pipeline(device, key);
    const pass = encoder.beginComputePass({label: `environment ${key}`});
    pass.setPipeline(compute);
    pass.setBindGroup(0, device.createBindGroup({layout: compute.getBindGroupLayout(0), entries}));
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
  };
  let cube!: GPUTexture, specular!: GPUTexture, brdf!: GPUBuffer, sh!: GPUBuffer, params!: GPUBuffer, sampler!: GPUSampler, readback!: GPUBuffer;
  let equirect: GPUTexture | undefined, equirectView: GPUTextureView | undefined, cubeView!: GPUTextureView;
  const temporary: GPUBuffer[] = [];
  try {
    // Phase 1: upload and build the source cube with its mip chain.
    await guarded(device, () => {
      sampler = device.createSampler({label: 'environment', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear'});
      cube = track(device.createTexture({label: 'environment source cube', size: [size, size, 6], mipLevelCount: cubeMips, format: 'rgba16float', usage: storageUsage}));
      specular = track(device.createTexture({label: 'environment specular', size: [specularSize, specularSize, 6], mipLevelCount: specularMips, format: 'rgba16float', usage: renderUsage}));
      brdf = track(device.createBuffer({label: 'environment BRDF LUT', size: settings.brdfSize * settings.brdfSize * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC}));
      sh = track(device.createBuffer({label: 'environment SH', size: 512, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC}));
      params = track(device.createBuffer({label: 'environment params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
      readback = track(device.createBuffer({size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ}));
      device.queue.writeBuffer(params, 0, new Float32Array([Math.cos(rotation), Math.sin(rotation), specularMips - 1, intensity]));
      const encoder = device.createCommandEncoder({label: 'environment source cube'});
      if (isCube(source)) {
        for (let face = 0; face < 6; face++)
          device.queue.writeTexture({texture: cube, origin: {x: 0, y: 0, z: face}}, toHalfLighting(source.faces[face]) as Uint16Array<ArrayBuffer>, {bytesPerRow: source.size * 8, rowsPerImage: source.size}, [source.size, source.size, 1]);
      } else {
        const image = fitEquirect(source, device.limits.maxTextureDimension2D);
        const float32 = settings.float32 && device.features.has('float32-filterable');
        equirect = track(device.createTexture({label: 'environment equirect', size: [image.width, image.height], format: float32 ? 'rgba32float' : 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST}));
        const texels = float32 ? sanitizeLighting(image.data) : toHalfLighting(image.data);
        device.queue.writeTexture({texture: equirect}, texels as Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>, {bytesPerRow: image.width * (float32 ? 16 : 8), rowsPerImage: image.height}, [image.width, image.height]);
        equirectView = equirect.createView();
        const supersample = Math.min(4, Math.max(1, Math.ceil(image.width / (4 * size))));
        const unit = uniform(new Uint32Array([size, supersample, 0, 0])); temporary.push(unit);
        dispatch(encoder, 'equirectToCube', [
          {binding: 0, resource: equirectView}, {binding: 1, resource: device.createSampler({magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat'})},
          {binding: 2, resource: level(cube, 0)}, {binding: 3, resource: {buffer: unit}},
        ], groups(size), groups(size), 6);
      }
      for (let mip = 1; mip < cubeMips; mip++)
        dispatch(encoder, 'downsample', [{binding: 0, resource: level(cube, mip - 1)}, {binding: 1, resource: level(cube, mip)}], groups(size >> mip), groups(size >> mip), 6);
      device.queue.submit([encoder.finish()]);
    });
    // Phase 2: prefiltered specular, SH and the BRDF LUT.
    await guarded(device, () => {
      const encoder = device.createCommandEncoder({label: 'environment lighting'});
      cubeView = cube.createView({dimension: 'cube'});
      const prefilter = prefilterPipeline(device), stride = 256;
      const settingsBuffer = track(device.createBuffer({size: stride * specularMips * 6, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
      temporary.push(settingsBuffer);
      const data = new ArrayBuffer(stride * specularMips * 6), view = new DataView(data);
      for (let mip = 0; mip < specularMips; mip++) for (let face = 0; face < 6; face++) {
        const roughness = specularMips > 1 ? mip / (specularMips - 1) : 0, edge = specularSize >> mip, offset = (mip * 6 + face) * stride;
        view.setFloat32(offset, roughness, true); view.setFloat32(offset + 4, size, true); view.setUint32(offset + 8, settings.samples, true);
        view.setFloat32(offset + 12, Math.log2(size / edge), true); view.setUint32(offset + 16, face, true); view.setFloat32(offset + 20, edge, true);
      }
      device.queue.writeBuffer(settingsBuffer, 0, data);
      for (let mip = 0; mip < specularMips; mip++) for (let face = 0; face < 6; face++) {
        const pass = encoder.beginRenderPass({label: 'environment prefilter', colorAttachments: [{
          view: specular.createView({dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: face, arrayLayerCount: 1}), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1],
        }]});
        pass.setPipeline(prefilter);
        pass.setBindGroup(0, device.createBindGroup({layout: prefilter.getBindGroupLayout(0), entries: [
          {binding: 0, resource: cubeView}, {binding: 1, resource: sampler}, {binding: 2, resource: {buffer: settingsBuffer, offset: (mip * 6 + face) * stride, size: 32}},
        ]}));
        pass.draw(3);
        pass.end();
      }
      const shMip = Math.max(0, Math.log2(size) - Math.floor(Math.log2(Math.min(settings.shSize, size))));
      dispatch(encoder, 'sphericalHarmonics', [{binding: 0, resource: level(cube, shMip)}, {binding: 1, resource: {buffer: sh}}], 1, 1, 1);
      const brdfUnit = uniform(new Uint32Array([settings.brdfSamples, settings.brdfSize, 0, 0])); temporary.push(brdfUnit);
      dispatch(encoder, 'brdfLut', [{binding: 0, resource: {buffer: brdf}}, {binding: 1, resource: {buffer: brdfUnit}}], groups(settings.brdfSize), groups(settings.brdfSize), 1);
      encoder.copyBufferToBuffer(sh, 0, readback, 0, 512);
      device.queue.submit([encoder.finish()]);
    });
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap(); readback.destroy();
    for (const buffer of temporary) buffer.destroy();
    if (!settings.keepEquirect && equirect) {equirect.destroy(); equirect = undefined; equirectView = undefined;}
    const radiance = new Float32Array(27), irradiance = new Float32Array(27);
    for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) {irradiance[k * 3 + c] = values[k * 4 + c]; radiance[k * 3 + c] = values[64 + k * 4 + c];}
    if (!radiance.every(Number.isFinite)) throw new Error('Environment processing produced non-finite SH');
    return {
      device, cube, cubeView, specular, specularView: specular.createView({dimension: 'cube'}), brdf,
      equirect, equirectView, sampler, sh, params, radiance, irradiance,
    };
  } catch (error) {
    for (const resource of created) resource.destroy();
    throw error;
  }
}

function destroy(resources: Resources | undefined): void {
  if (!resources) return;
  resources.cube.destroy(); resources.specular.destroy(); resources.brdf.destroy(); resources.equirect?.destroy();
  resources.sh.destroy(); resources.params.destroy();
}

/**
 * Processed image-based lighting for one environment: the source cube map with a box-filtered mip chain,
 * a GGX-prefiltered specular cube (roughness 0..1 across its mips), L2 spherical-harmonic irradiance and a
 * split-sum BRDF LUT. All textures are rgba16float. Replaces Three.js PMREMGenerator output plus
 * `scene.environment`. Pass it to `engine.use` to rebuild automatically after a device loss.
 */
export class Environment implements EnginePlugin {
  readonly name: string;
  private resources?: Resources;
  private readonly settings: Settings;
  private source?: EnvironmentSource;
  private restoring?: {device: GPUDevice; promise: Promise<void>};
  private readonly listeners = new Set<(environment: Environment) => void>();
  private rotationValue: number;
  private intensityValue: number;
  private readonly paramsData = new Float32Array(4);
  /** Increments every time GPU resources are replaced (device restore); rebuild bind groups when it changes. */
  version = 0;
  disposed = false;

  private constructor(resources: Resources, settings: Settings, source: EnvironmentSource | undefined, options: EnvironmentOptions) {
    this.resources = resources; this.settings = settings; this.source = source;
    this.name = options.name ?? 'environment';
    this.rotationValue = options.rotation ?? 0; this.intensityValue = options.intensity ?? 1;
  }

  /** Processes `source` on the GPU. `target` is a GPUDevice or a WebGPU engine. */
  static async create(target: GPUDevice | EngineKernel, source: EnvironmentSource, options: EnvironmentOptions = {}): Promise<Environment> {
    validateSource(source);
    for (const [label, value] of [['rotation', options.rotation], ['intensity', options.intensity]] as const)
      if (value !== undefined && (!Number.isFinite(value) || (label === 'intensity' && value < 0))) throw new RangeError(`Invalid ${label}`);
    const device = deviceOf(target);
    const settings = resolveSettings(device, source, options);
    const resources = await build(device, source, settings, options.rotation ?? 0, options.intensity ?? 1);
    return new Environment(resources, settings, options.keepSource === false ? undefined : source, options);
  }

  private get live(): Resources {
    if (this.disposed) throw new Error('Environment is disposed');
    if (!this.resources) throw new Error('Environment is being restored');
    return this.resources;
  }
  /** The device the current resources belong to, or null while restoring or after dispose. */
  get device(): GPUDevice | null {return this.disposed ? null : this.resources?.device ?? null;}
  /** Source cube edge in texels. */
  get size(): number {return this.settings.size;}
  /** Prefiltered mip 0 edge in texels. */
  get specularSize(): number {return this.settings.specularSize;}
  /** Number of prefiltered mips; mip m holds roughness m / (specularMips - 1). */
  get specularMips(): number {return this.settings.specularMips;}
  /** Source cube texture (rgba16float, 6 layers, full mip chain, box filtered). */
  get cubeTexture(): GPUTexture {return this.live.cube;}
  /** `texture_cube<f32>` view of the source cube with all mips. */
  get cubeView(): GPUTextureView {return this.live.cubeView;}
  /** Prefiltered specular texture (rgba16float, 6 layers, `specularMips` mips). */
  get specularTexture(): GPUTexture {return this.live.specular;}
  /** `texture_cube<f32>` view of the prefiltered specular mips. */
  get specularView(): GPUTextureView {return this.live.specularView;}
  /**
   * Split-sum BRDF LUT: a STORAGE buffer of brdfSize x brdfSize u32, row-major (x = NdotV, y = perceptual roughness at
   * texel centers), each `pack2x16float(scale, bias)`. A buffer, not a texture, so IBL binds one sampled texture per stage.
   */
  get brdfLut(): GPUBuffer {return this.live.brdf;}
  /** Equirect source texture (rgba16float, or rgba32float with float32-filterable), if kept. */
  get equirectTexture(): GPUTexture | undefined {return this.live.equirect;}
  get equirectView(): GPUTextureView | undefined {return this.live.equirectView;}
  /** Trilinear clamp-to-edge sampler for the cube maps. */
  get sampler(): GPUSampler {return this.live.sampler;}
  /** 512-byte STORAGE|UNIFORM buffer: bytes 0..143 = 9 vec4f irradiance/PI coefficients, bytes 256..399 = radiance coefficients. */
  get shBuffer(): GPUBuffer {return this.live.sh;}
  /** 16-byte uniform buffer vec4f(cos(rotation), sin(rotation), specularMips - 1, intensity). */
  get paramsBuffer(): GPUBuffer {return this.live.params;}
  /** SH coefficients as 27 floats (9 coefficients x RGB): `radiance` is the plain projection, `irradiance` is diffuse ready (E / PI). */
  get sh(): {radiance: Float32Array; irradiance: Float32Array} {const r = this.live; return {radiance: r.radiance, irradiance: r.irradiance};}

  get rotation(): number {return this.rotationValue;}
  set rotation(value: number) {if (!Number.isFinite(value)) throw new RangeError('Invalid rotation'); this.rotationValue = value; this.writeParams();}
  get intensity(): number {return this.intensityValue;}
  set intensity(value: number) {if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid intensity'); this.intensityValue = value; this.writeParams();}
  private writeParams(): void {
    const r = this.resources;
    if (!r || this.disposed) return;
    const p = this.paramsData;
    p[0] = Math.cos(this.rotationValue); p[1] = Math.sin(this.rotationValue); p[2] = this.settings.specularMips - 1; p[3] = this.intensityValue;
    r.device.queue.writeBuffer(r.params, 0, p);
  }

  /** Mip level (fractional) holding perceptual `roughness` (clamped to 0..1): roughness * (specularMips - 1). */
  roughnessToLod(roughness: number): number {return Math.min(1, Math.max(0, roughness)) * (this.settings.specularMips - 1);}
  lodToRoughness(lod: number): number {return this.settings.specularMips > 1 ? Math.min(1, Math.max(0, lod / (this.settings.specularMips - 1))) : 0;}
  /** Diffuse-ready irradiance / PI in world direction `normal` (rotation applied), times intensity. Multiply by albedo. */
  irradianceAt(normal: readonly [number, number, number]): [number, number, number] {
    const c = Math.cos(this.rotationValue), s = Math.sin(this.rotationValue), [x, y, z] = normal;
    return evaluateSH(this.live.irradiance, [c * x - s * z, y, s * x + c * z]).map(v => v * this.intensityValue) as [number, number, number];
  }

  /** Calls `listener` after GPU resources are replaced by a device restore. Returns an unsubscribe function. */
  onChange(listener: (environment: Environment) => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}

  /**
   * Rebuilds every GPU resource on `target` from the retained source (requires keepSource). Concurrent calls
   * for the same device share one rebuild. Resources stay unavailable (`device === null`) until it finishes.
   */
  restore(target: GPUDevice | EngineKernel): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Environment is disposed'));
    const device = deviceOf(target);
    if (this.resources?.device === device) return Promise.resolve();
    if (this.restoring?.device === device) return this.restoring.promise;
    if (!this.source) return Promise.reject(new Error('Environment cannot be restored without keepSource'));
    destroy(this.resources); this.resources = undefined;
    const promise = build(device, this.source, this.settings, this.rotationValue, this.intensityValue).then(resources => {
      if (this.disposed || this.restoring?.promise !== promise) {destroy(resources); return;}
      this.resources = resources; this.restoring = undefined; this.version++;
      this.writeParams();
      for (const listener of this.listeners) listener(this);
    }, error => {if (this.restoring?.promise === promise) this.restoring = undefined; throw error;});
    this.restoring = {device, promise};
    return promise;
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new Error('Environment is disposed');
    const device = engineRuntime(engine).gpu;
    if (!device) throw new Error('Environment requires the WebGPU backend');
    if (device !== this.resources?.device) this.restore(device).catch(error => engine.onError(error));
  }
  onDeviceRestored(engine: EngineKernel): void {
    const device = engineRuntime(engine).gpu;
    if (device && !this.disposed) this.restore(device).catch(error => engine.onError(error));
  }
  /** Destroys all GPU resources. Also called by `engine.removePlugin` and `engine.dispose`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; destroy(this.resources); this.resources = undefined; this.source = undefined; this.restoring = undefined;
    this.listeners.clear();
  }
}
