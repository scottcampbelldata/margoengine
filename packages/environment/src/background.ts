/// <reference lib="esnext.disposable" preserve="true" />
// Environment background: the scene.background = texture (equirect or cube) equivalent, with
// backgroundIntensity (exposure), backgroundRotation and backgroundBlurriness (blur).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import type { Environment } from './environment.js';
import { background as backgroundShader } from './shaders.js';
import { invertMatrix } from '@margoengine/math/mat4';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

export interface EnvironmentBackgroundOptions {
  /** Linear multiplier before tone mapping (Three.js backgroundIntensity). Default 1. */
  exposure?: number;
  /** 0 = sharp source, 1 = the roughest prefiltered mip (Three.js backgroundBlurriness). Default 0. */
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
    throw new RangeError(`Invalid ${label}`);
  return value;
};

/**
 * Draws an Environment behind the scene. The full-screen triangle sits at reversed-Z depth 0 with a
 * read-only `greater-equal` depth test, so it only covers pixels whose depth still holds the cleared 0 and
 * never touches geometry. Output follows core: Reinhard tone mapping and sRGB encoding into the canvas
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
  private readonly uniformData = new ArrayBuffer(112);
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
    if (!['auto', 'equirect', 'cube'].includes(this.source)) throw new TypeError('Invalid background source');
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
    if (this.disposed) throw new Error('EnvironmentBackground is disposed');
    if (engine.backend !== 'webgpu') throw new Error('EnvironmentBackground requires the WebGPU backend');
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
    context.device.queue.writeBuffer(state.uniform, 0, this.uniformData);
  }

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
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 112 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: texture('2d') },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: texture('cube') },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: texture('cube') },
      ],
    });
    const uniform = device.createBuffer({
      label: 'environment background',
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    try {
      this.state = {
        device,
        layout,
        pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        module: device.createShaderModule({ code: backgroundShader }),
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
