// Environment background: the scene.background = texture (equirect or cube) equivalent, with
// backgroundIntensity (exposure), backgroundRotation and backgroundBlurriness (blur).
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type FrameGraph, type PassContext} from '@margoengine/core/extension';
import type {Environment} from './environment.js';
import {background as backgroundShader} from './shaders.js';

declare const GPUBufferUsage: {UNIFORM: number; COPY_DST: number};
declare const GPUTextureUsage: {TEXTURE_BINDING: number};
declare const GPUShaderStage: {VERTEX: number; FRAGMENT: number};

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

type GPUContext = Extract<PassContext, {backend: 'webgpu'}>;

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
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RangeError(`Invalid ${label}`);
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
  private readonly colorAttachment: GPURenderPassColorAttachment = {view: undefined!, loadOp: 'load', storeOp: 'store'};
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {view: undefined!, depthReadOnly: true};
  private readonly passDescriptor: GPURenderPassDescriptor = {label: 'environment background', colorAttachments: [this.colorAttachment], depthStencilAttachment: this.depthAttachment};

  constructor(readonly environment: Environment, options: EnvironmentBackgroundOptions = {}) {
    this.name = options.name ?? 'environment:background';
    this.order = finiteNumber(options.order ?? 1, 'order');
    if (this.order <= 0) throw new RangeError('Background order must be greater than 0 (after the main pass)');
    this.exposure = options.exposure ?? 1;
    this.blur = options.blur ?? 0;
    this.rotation = options.rotation ?? 0;
    this.source = options.source ?? 'auto';
    if (!['auto', 'equirect', 'cube'].includes(this.source)) throw new TypeError('Invalid background source');
  }

  get exposure(): number {return this.exposureValue;}
  set exposure(value: number) {this.exposureValue = finiteNumber(value, 'exposure', 0);}
  get blur(): number {return this.blurValue;}
  set blur(value: number) {this.blurValue = finiteNumber(value, 'blur', 0, 1);}
  get rotation(): number {return this.rotationValue;}
  set rotation(value: number) {this.rotationValue = finiteNumber(value, 'rotation');}

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new Error('EnvironmentBackground is disposed');
    if (engine.backend !== 'webgpu') throw new Error('EnvironmentBackground requires the WebGPU backend');
    const device = engineRuntime(engine).gpu;
    if (device && this.environment.device !== device && !this.environment.disposed) this.environment.restore(device).catch(error => engine.onError(error));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({name: this.name, order: this.order, execute: context => {if (context.backend === 'webgpu') this.record(context);}});
  }
  onDeviceRestored(engine: EngineKernel): void {
    this.releaseState();
    const device = engineRuntime(engine).gpu;
    if (device && this.environment.device !== device && !this.environment.disposed) this.environment.restore(device).catch(error => engine.onError(error));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.releaseState();
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
      state.fallback ??= context.device.createTexture({size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING});
      state.group = context.device.createBindGroup({layout: state.layout, entries: [
        {binding: 0, resource: {buffer: state.uniform}},
        {binding: 1, resource: state.sampler},
        {binding: 2, resource: equirect ?? state.fallback.createView()},
        {binding: 3, resource: environment.cubeView},
        {binding: 4, resource: environment.specularView},
      ]});
      state.groupVersion = environment.version;
    }
    this.writeUniforms(context, state);
    this.colorAttachment.view = context.color;
    this.depthAttachment.view = context.depth;
    if (depthFormat.includes('stencil')) this.depthAttachment.stencilReadOnly = true; else delete this.depthAttachment.stencilReadOnly;
    const pass = context.encoder.beginRenderPass(this.passDescriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, state.group);
    pass.draw(3);
    pass.end();
  }

  private writeUniforms(context: GPUContext, state: DeviceState): void {
    const camera = context.camera, f = this.floats, environment = this.environment;
    if (!invert(camera.matrix, this.inverse)) return;
    for (let i = 0; i < 16; i++) f[i] = this.inverse[i];
    f[16] = camera.position[0]; f[17] = camera.position[1]; f[18] = camera.position[2]; f[19] = 1;
    const angle = environment.rotation + this.rotationValue;
    f[20] = this.exposureValue; f[21] = Math.cos(angle); f[22] = Math.sin(angle); f[23] = environment.roughnessToLod(this.blurValue);
    this.uints[24] = this.blurValue > 0 ? 2 : this.source === 'cube' || !environment.equirectView ? 1 : 0;
    context.device.queue.writeBuffer(state.uniform, 0, this.uniformData);
  }

  private stateFor(device: GPUDevice): DeviceState {
    if (this.state?.device === device) return this.state;
    this.releaseState();
    const texture = (viewDimension: GPUTextureViewDimension): GPUBindGroupLayoutEntry['texture'] => ({sampleType: 'float', viewDimension});
    const layout = device.createBindGroupLayout({label: 'environment background', entries: [
      {binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {type: 'uniform', minBindingSize: 112}},
      {binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {type: 'filtering'}},
      {binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: texture('2d')},
      {binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: texture('cube')},
      {binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: texture('cube')},
    ]});
    const uniform = device.createBuffer({label: 'environment background', size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.state = {device, layout, pipelineLayout: device.createPipelineLayout({bindGroupLayouts: [layout]}), module: device.createShaderModule({code: backgroundShader}), uniform, pipelines: new Map(), groupVersion: -1,
      sampler: device.createSampler({label: 'environment background', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat'})};
    return this.state;
  }

  private pipelineFor(state: DeviceState, format: GPUTextureFormat, depthFormat: GPUTextureFormat, count: number): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${count}`;
    let pipeline = state.pipelines.get(key);
    if (!pipeline) {
      pipeline = state.device.createRenderPipeline({
        label: 'environment background', layout: state.pipelineLayout,
        vertex: {module: state.module, entryPoint: 'vertexMain'},
        fragment: {module: state.module, entryPoint: 'fragmentMain', targets: [{format}], constants: {outputHdr: format === 'rgba16float' || format === 'rgba32float' ? 1 : 0}},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        multisample: {count},
        depthStencil: {format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal'},
      });
      state.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private releaseState(): void {
    this.state?.uniform.destroy(); this.state?.fallback?.destroy(); this.state = undefined;
  }
}

/** Inverts a column-major 4x4 matrix into `out`; returns false when singular. */
export function invert(m: ArrayLike<number>, out: Float64Array | Float32Array): boolean {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return false;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return true;
}
