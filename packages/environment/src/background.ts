/// <reference lib="esnext.disposable" preserve="true" />
// Environment background: draws an environment's equirect or cube texture behind the scene, with
// exposure, rotation and blur.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import type { Environment } from './environment.js';
import type { RGBA8Image } from './ultrahdr.js';
import { backgroundShader, imageBackground as imageBackgroundShader } from './shaders.js';
import { invertMatrix } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { applyView } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** `EnvironmentBackground` (alias `Skybox`) settings; out-of-range values throw RangeError. */
export interface EnvironmentBackgroundOptions {
  /** Linear multiplier before tone mapping. Default 1. */
  exposure?: number;
  /** 0 = sharp source, 1 = the roughest prefiltered mip. Default 0. */
  blur?: number;
  /**
   * What to sample when `blur` is 0: 'equirect' (the original image, sharpest), 'cube' (the source cube map),
   * or 'auto' (equirect when the environment kept one, else cube). Blur above 0 always samples the
   * prefiltered specular mips. Default 'auto'.
   */
  source?: 'auto' | 'equirect' | 'cube';
  /** Extra rotation about +Y in radians, added to `environment.rotation`. Default 0. */
  rotation?: number;
  /** Frame graph order; must run after core's main pass (order 0). Default 1. */
  order?: number;
  /** Plugin and pass name. Default 'environment:background'. */
  name?: string;
}

type GPUContext = Extract<PassContext, { backend: 'webgpu' }>;

interface DeviceState {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  module: GPUShaderModule;
  uniform: GPUBuffer;
  pipelines: Map<string, GPURenderPipeline>;
  group?: GPUBindGroup;
  groupVersion: number;
  fallback?: GPUTexture;
  sampler: GPUSampler;
}

const finiteNumber = (value: unknown, label: string, min = -Infinity, max = Infinity): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Invalid ${label}; pass a finite number in the documented range`);
  return value;
};

/**
 * Draws an Environment behind the scene. The full-screen triangle sits at reversed-Z depth 0 with a
 * read-only `greater-equal` depth test, so it only covers pixels whose depth still holds the cleared 0 and
 * never touches geometry. Output follows core: Khronos PBR Neutral tone mapping and sRGB encoding
 * (shared/display.js) into the canvas
 * format, or linear radiance when the pass target is rgba16float (an HDR capture such as creative's
 * PostProcessing). Also usable without an engine through `record(context)`.
 */
export class EnvironmentBackground {
  readonly name: string;
  readonly order: number;
  private exposureValue = 1;
  private blurValue = 0;
  private rotationValue = 0;
  source: 'auto' | 'equirect' | 'cube';
  private state?: DeviceState;
  private disposed = false;
  private engine?: EngineKernel;
  private readonly uniformData = new ArrayBuffer(144);
  private readonly floats = new Float32Array(this.uniformData);
  private readonly uints = new Uint32Array(this.uniformData);
  private readonly inverse = new Float64Array(16);
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly passDescriptor: GPURenderPassDescriptor = {
    label: 'environment background',
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.depthAttachment,
  };

  /** Same as `engine.use(new EnvironmentBackground(...))`; returns the EnvironmentBackground. */
  static attach(
    engine: EngineKernel,
    environment: Environment,
    options?: EnvironmentBackgroundOptions,
  ): EnvironmentBackground {
    const value = new EnvironmentBackground(environment, options);
    engine.use(value);
    return value;
  }
  constructor(
    readonly environment: Environment,
    options: EnvironmentBackgroundOptions = {},
  ) {
    this.name = options.name ?? 'environment:background';
    this.order = finiteNumber(options.order ?? 1, 'order');
    if (this.order <= 0) throw new RangeError('Background order must be greater than 0 (after the main pass)');
    this.exposure = options.exposure ?? 1;
    this.blur = options.blur ?? 0;
    this.rotation = options.rotation ?? 0;
    this.source = options.source ?? 'auto';
    if (!['auto', 'equirect', 'cube'].includes(this.source))
      throw new TypeError('Invalid background source; pass a colour, a texture or a cube map');
  }

  get exposure(): number {
    return this.exposureValue;
  }
  set exposure(value: number) {
    this.exposureValue = finiteNumber(value, 'exposure', 0);
  }
  get blur(): number {
    return this.blurValue;
  }
  set blur(value: number) {
    this.blurValue = finiteNumber(value, 'blur', 0, 1);
  }
  get rotation(): number {
    return this.rotationValue;
  }
  set rotation(value: number) {
    this.rotationValue = finiteNumber(value, 'rotation');
  }

  setup(engine: EngineKernel): void {
    if (this.disposed)
      throw new MargoError('disposed', 'EnvironmentBackground is disposed; create a new EnvironmentBackground');
    if (engine.backend !== 'webgpu')
      throw new MargoError(
        'unsupported',
        'EnvironmentBackground requires the WebGPU backend; use an engine on the WebGPU backend; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const device = engineRuntime(engine).gpu;
    if (device && this.environment.device !== device && !this.environment.disposed)
      this.environment.restore(device).catch((error) => engine.onError(error));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (context) => {
        if (context.backend === 'webgpu') this.record(context);
      },
    });
  }
  onDeviceRestored(engine: EngineKernel): void {
    this.releaseState();
    const device = engineRuntime(engine).gpu;
    if (device && this.environment.device !== device && !this.environment.disposed)
      this.environment.restore(device).catch((error) => engine.onError(error));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseState();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /**
   * Records the background into `context.encoder` targeting `context.color` / `context.depth`. Skips (draws
   * nothing) while the environment is restoring on another device or after disposal.
   */
  record(context: GPUContext): void {
    const environment = this.environment;
    if (this.disposed || environment.disposed || environment.device !== context.device) return;
    const state = this.stateFor(context.device);
    const depthFormat = context.descriptor.depthStencil?.format ?? 'depth32float';
    const pipeline = this.pipelineFor(state, context.format, depthFormat, context.descriptor.multisample?.count ?? 1);
    if (!state.group || state.groupVersion !== environment.version) {
      const equirect = environment.equirectView;
      state.fallback ??= context.device.createTexture({
        size: [1, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
      state.group = context.device.createBindGroup({
        layout: state.layout,
        entries: [
          { binding: 0, resource: { buffer: state.uniform } },
          { binding: 1, resource: state.sampler },
          { binding: 2, resource: equirect ?? state.fallback.createView() },
          { binding: 3, resource: environment.cubeView },
          { binding: 4, resource: environment.specularView },
        ],
      });
      state.groupVersion = environment.version;
    }
    this.writeUniforms(context, state);
    this.colorAttachment.view = context.color;
    this.depthAttachment.view = context.depth;
    if (depthFormat.includes('stencil')) this.depthAttachment.stencilReadOnly = true;
    else delete this.depthAttachment.stencilReadOnly;
    const pass = context.encoder.beginRenderPass(this.passDescriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, state.group);
    applyView(pass, context);
    pass.draw(3);
    pass.end();
  }

  private writeUniforms(context: GPUContext, state: DeviceState): void {
    const camera = context.camera,
      f = this.floats,
      environment = this.environment;
    if (!invertMatrix(camera.matrix, this.inverse)) return;
    for (let i = 0; i < 16; i++) f[i] = this.inverse[i];
    f[16] = camera.position[0];
    f[17] = camera.position[1];
    f[18] = camera.position[2];
    f[19] = 1;
    const angle = environment.rotation + this.rotationValue;
    f[20] = this.exposureValue;
    f[21] = Math.cos(angle);
    f[22] = Math.sin(angle);
    f[23] = environment.roughnessToLod(this.blurValue);
    this.uints[24] = this.blurValue > 0 ? 2 : this.source === 'cube' || !environment.equirectView ? 1 : 0;
    this.writeExtra(f);
    context.device.queue.writeBuffer(state.uniform, 0, this.uniformData);
  }

  /** WGSL of the pass; the ground projection (/ground) adds its `project` function. */
  protected shaderCode(): string {
    return backgroundShader();
  }
  /** Writes subclass uniforms after the base ones (floats 28 to 35: `ground` and `dome`). */
  protected writeExtra(_floats: Float32Array): void {}

  private stateFor(device: GPUDevice): DeviceState {
    if (this.state?.device === device) return this.state;
    this.releaseState();
    const texture = (viewDimension: GPUTextureViewDimension): GPUBindGroupLayoutEntry['texture'] => ({
      sampleType: 'float',
      viewDimension,
    });
    const layout = device.createBindGroupLayout({
      label: 'environment background',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 144 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: texture('2d') },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: texture('cube') },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: texture('cube') },
      ],
    });
    const uniform = device.createBuffer({
      label: 'environment background',
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    try {
      this.state = {
        device,
        layout,
        pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        module: device.createShaderModule({ code: this.shaderCode() }),
        uniform,
        pipelines: new Map(),
        groupVersion: -1,
        sampler: device.createSampler({
          label: 'environment background',
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'linear',
          addressModeU: 'repeat',
        }),
      };
    } catch (error) {
      uniform.destroy();
      throw error;
    }
    return this.state;
  }

  private pipelineFor(
    state: DeviceState,
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    count: number,
  ): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${count}`;
    let pipeline = state.pipelines.get(key);
    if (!pipeline) {
      pipeline = state.device.createRenderPipeline({
        label: 'environment background',
        layout: state.pipelineLayout,
        vertex: { module: state.module, entryPoint: 'vertexMain' },
        fragment: {
          module: state.module,
          entryPoint: 'fragmentMain',
          targets: [{ format }],
          constants: { outputHdr: format === 'rgba16float' || format === 'rgba32float' ? 1 : 0 },
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      state.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private releaseState(): void {
    this.state?.uniform.destroy();
    this.state?.fallback?.destroy();
    this.state = undefined;
  }
}

/** An image `ImageBackground.load` decodes: an RGBA8Image or ImageData, a URL, or anything `createImageBitmap` takes. */
export type ImageBackgroundSource = RGBA8Image | ImageBitmapSource | string | URL;
/** The three skybox shapes: six cube faces, an equirectangular sphere, or a panorama around a cylinder. */
export type ImageBackgroundShape = 'box' | 'sphere' | 'cylinder';

/** Images and settings of an `ImageBackground`; `Image` is what `images` holds (decoded pixels, or any source for `load`). */
export interface ImageBackgroundOptions<Image = RGBA8Image> {
  /**
   * 'box': six square faces of one size in WebGPU cube order +X, -X, +Y, -Y, +Z, -Z, row 0 at the top (as `CubeFaces`).
   * 'sphere': one equirectangular panorama, centre column facing -Z and row 0 straight up (as the HDR equirect).
   * 'cylinder': one panorama wrapped once around a vertical unit-radius cylinder (see `height`).
   */
  shape: ImageBackgroundShape;
  /** Six faces for 'box', one panorama for 'sphere' and 'cylinder': 8-bit sRGB RGBA, row 0 at the top. */
  images: readonly Image[];
  /** 'nearest' keeps pixel-art skies crisp, 'linear' filters. Default 'linear'; settable later. */
  filter?: 'nearest' | 'linear';
  /**
   * 'cylinder' only: the height the image covers on the unit-radius cylinder, centred on the horizon. The horizontal
   * angle maps to u over the full 360 degrees (as the sphere); v = 0.5 - y / (height * r) for a view direction with
   * vertical part y and horizontal length r, so v is linear in height on the cylinder. Above and below the image the
   * top and bottom rows repeat. Default 2 * PI * imageHeight / imageWidth (square texels); settable later.
   */
  height?: number;
  /** Rotation about +Y in radians. Default 0; settable later. */
  rotation?: number;
  /** Frame graph order; must run after core's main pass (order 0). Default 0.5, before glTF-pro models (1). */
  order?: number;
  /** Plugin and pass name. Default 'background'. */
  name?: string;
}

const isPixels = (value: unknown): value is RGBA8Image =>
  typeof value === 'object' && value !== null && ArrayBuffer.isView((value as RGBA8Image).data);

/** Decodes one `ImageBackgroundSource` to 8-bit RGBA through createImageBitmap and a 2D OffscreenCanvas. */
async function decodeImage(source: ImageBackgroundSource, get: typeof fetch = globalThis.fetch): Promise<RGBA8Image> {
  if (isPixels(source)) return source;
  if (typeof source === 'string' || source instanceof URL) {
    const response = await get(source);
    if (!response.ok)
      throw new MargoError('failed', `ImageBackground: ${source} answered HTTP ${response.status}; check the URL`);
    source = await response.blob();
  }
  const bitmap = await createImageBitmap(source);
  try {
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    if (!context)
      throw new MargoError('unsupported', 'ImageBackground: no 2D OffscreenCanvas to read the image; pass ImageData');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

interface ImageState {
  device: GPUDevice;
  texture: GPUTexture;
  view: GPUTextureView;
  uniform: GPUBuffer;
  layout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  module: GPUShaderModule;
  pipelines: Map<string, GPURenderPipeline>;
  group?: GPUBindGroup;
  /** The filter `group`'s sampler was made with. */
  filter?: 'nearest' | 'linear';
}

/**
 * Skybox from ordinary 8-bit sRGB images (PNG, JPG, a canvas): six faces for a box, one panorama for a sphere
 * (equirectangular) or a cylinder. The images are kept on the CPU and uploaded as `rgba8unorm-srgb`, so sampling
 * decodes sRGB to linear exactly, on the GPU, before filtering; they are uploaded again after a device restore. Drawn
 * like `ColorBackground`: a full-screen triangle at reversed-Z depth 0 under a read-only `greater-equal` test (only
 * pixels the scene left empty), the exact sRGB pixels on the canvas (no tone mapping) and linear values on an HDR
 * target. Background only: it lights nothing. Also usable without an engine through `record(context)`.
 */
export class ImageBackground {
  readonly name: string;
  readonly order: number;
  readonly shape: ImageBackgroundShape;
  private readonly images: readonly RGBA8Image[];
  private filterValue!: 'nearest' | 'linear';
  private heightValue!: number;
  private rotationValue = 0;
  private state?: ImageState;
  private disposed = false;
  private engine?: EngineKernel;
  private readonly floats = new Float32Array(24);
  private readonly inverse = new Float64Array(16);
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly passDescriptor: GPURenderPassDescriptor = {
    label: 'image background',
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.depthAttachment,
  };

  /** Same as `engine.use(new ImageBackground(options))`; returns the ImageBackground. */
  static attach(engine: EngineKernel, options: ImageBackgroundOptions): ImageBackground {
    const value = new ImageBackground(options);
    engine.use(value);
    return value;
  }
  /**
   * Decodes `options.images` (URLs, blobs, image elements, bitmaps, canvases or ImageData), then constructs. URLs are
   * fetched through `options.fetch` (default `globalThis.fetch`; for example a LoadingManager's `fetch`).
   */
  static async load(
    options: ImageBackgroundOptions<ImageBackgroundSource> & { fetch?: typeof fetch },
  ): Promise<ImageBackground> {
    const { fetch: get, ...rest } = options;
    return new ImageBackground({
      ...rest,
      images: await Promise.all([...(options.images ?? [])].map((image) => decodeImage(image, get))),
    });
  }
  constructor(options: ImageBackgroundOptions) {
    const { shape, images } = options;
    if (!['box', 'sphere', 'cylinder'].includes(shape))
      throw new TypeError(`ImageBackground shape ${shape} is unknown; use 'box', 'sphere' or 'cylinder'`);
    const count = shape === 'box' ? 6 : 1;
    if (!Array.isArray(images) || images.length !== count)
      throw new TypeError(
        `ImageBackground ${shape} takes ${count === 6 ? 'six images (+X, -X, +Y, -Y, +Z, -Z)' : 'one image'}; pass that many`,
      );
    for (const image of images)
      if (
        !isPixels(image) ||
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        !(image.width > 0 && image.height > 0) ||
        image.data.length !== image.width * image.height * 4 ||
        (shape === 'box' && (image.width !== image.height || image.width !== images[0].width))
      )
        throw new TypeError(
          `ImageBackground images need 8-bit RGBA data of width * height * 4${shape === 'box' ? ' and square faces of one size' : ''}; decode them with ImageBackground.load`,
        );
    this.shape = shape;
    this.images = [...images];
    this.name = options.name ?? 'background';
    this.order = finiteNumber(options.order ?? 0.5, 'order');
    if (this.order <= 0) throw new RangeError('Background order must be greater than 0 (after the main pass)');
    this.filter = options.filter ?? 'linear';
    // Margo default: a cylinder of circumference 2 pi shows the image at its own aspect ratio.
    this.height = options.height ?? (2 * Math.PI * images[0].height) / images[0].width;
    this.rotation = options.rotation ?? 0;
  }

  get filter(): 'nearest' | 'linear' {
    return this.filterValue;
  }
  set filter(value: 'nearest' | 'linear') {
    if (value !== 'nearest' && value !== 'linear')
      throw new TypeError(`ImageBackground filter ${value} is unknown; use 'nearest' or 'linear'`);
    this.filterValue = value;
  }
  get height(): number {
    return this.heightValue;
  }
  set height(value: number) {
    this.heightValue = finiteNumber(value, 'cylinder height', Number.MIN_VALUE);
  }
  get rotation(): number {
    return this.rotationValue;
  }
  set rotation(value: number) {
    this.rotationValue = finiteNumber(value, 'rotation');
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', 'ImageBackground is disposed; create a new one');
    if (engine.backend !== 'webgpu')
      throw new MargoError(
        'unsupported',
        'ImageBackground requires the WebGPU backend; create the engine with WebGPU; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (context) => {
        if (context.backend === 'webgpu') this.record(context);
      },
    });
  }
  onDeviceRestored(): void {
    this.release();
  }
  /** Frees the GPU state and detaches from the engine. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** Records the background into `context.encoder` over `context.color`, testing against `context.depth`. */
  record(context: GPUContext): void {
    if (this.disposed) return;
    const device = context.device,
      state = this.state?.device === device ? this.state : this.upload(device),
      depthFormat = context.descriptor.depthStencil?.format ?? 'depth32float',
      count = context.descriptor.multisample?.count ?? 1,
      key = `${context.format}|${depthFormat}|${count}`;
    let pipeline = state.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: 'image background',
        layout: state.pipelineLayout,
        vertex: { module: state.module, entryPoint: 'vertexMain' },
        fragment: {
          module: state.module,
          entryPoint: 'fragmentMain',
          targets: [{ format: context.format }],
          constants: { outputHdr: context.format === 'rgba16float' || context.format === 'rgba32float' ? 1 : 0 },
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      state.pipelines.set(key, pipeline);
    }
    if (state.filter !== this.filterValue) {
      state.group = device.createBindGroup({
        layout: state.layout,
        entries: [
          { binding: 0, resource: { buffer: state.uniform } },
          {
            binding: 1,
            resource: device.createSampler({
              label: 'image background',
              magFilter: this.filterValue,
              minFilter: this.filterValue,
              // Panoramas wrap around in u; cube faces ignore address modes.
              addressModeU: 'repeat',
            }),
          },
          { binding: 2, resource: state.view },
        ],
      });
      state.filter = this.filterValue;
    }
    const camera = context.camera,
      f = this.floats;
    if (!invertMatrix(camera.matrix, this.inverse)) return;
    for (let i = 0; i < 16; i++) f[i] = this.inverse[i];
    f[16] = camera.position[0];
    f[17] = camera.position[1];
    f[18] = camera.position[2];
    f[19] = 1;
    f[20] = Math.cos(this.rotationValue);
    f[21] = Math.sin(this.rotationValue);
    f[22] = this.heightValue;
    device.queue.writeBuffer(state.uniform, 0, f);
    this.colorAttachment.view = context.color;
    this.depthAttachment.view = context.depth;
    if (depthFormat.includes('stencil')) this.depthAttachment.stencilReadOnly = true;
    else delete this.depthAttachment.stencilReadOnly;
    const pass = context.encoder.beginRenderPass(this.passDescriptor);
    applyView(pass, context);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, state.group!);
    pass.draw(3);
    pass.end();
  }

  /** Uploads the images to `device` (sRGB texture, cube for a box) with the uniform and pipeline layout. */
  private upload(device: GPUDevice): ImageState {
    this.release();
    const box = this.shape === 'box',
      { width, height } = this.images[0],
      limit = device.limits.maxTextureDimension2D;
    if (width > limit || height > limit)
      throw new RangeError(`ImageBackground image ${width}x${height} exceeds the device limit ${limit}; downscale it`);
    const texture = device.createTexture({
      label: 'image background',
      size: [width, height, this.images.length],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    let uniform: GPUBuffer | undefined;
    try {
      this.images.forEach((image, z) =>
        device.queue.writeTexture(
          { texture, origin: { x: 0, y: 0, z } },
          image.data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: width * 4, rowsPerImage: height },
          [width, height, 1],
        ),
      );
      uniform = device.createBuffer({
        label: 'image background',
        size: 96,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const layout = device.createBindGroupLayout({
        label: 'image background',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 96 } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'float', viewDimension: box ? 'cube' : '2d' },
          },
        ],
      });
      this.state = {
        device,
        texture,
        view: texture.createView({ dimension: box ? 'cube' : '2d' }),
        uniform,
        layout,
        pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        module: device.createShaderModule({ code: imageBackgroundShader(this.shape) }),
        pipelines: new Map(),
      };
      return this.state;
    } catch (error) {
      texture.destroy();
      uniform?.destroy();
      throw error;
    }
  }
  private release(): void {
    this.state?.texture.destroy();
    this.state?.uniform.destroy();
    this.state = undefined;
  }
}
