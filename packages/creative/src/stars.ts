/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import type {Engine, EnginePlugin, FrameGraph, PassContext} from '@margoengine/core/extension';
import {invertMatrixStable} from '@margoengine/math/mat4';
import shader from './shaders/stars.wgsl?raw';

declare const GPUBufferUsage: {UNIFORM: number; COPY_DST: number};
declare const GPUShaderStage: {VERTEX: number};

export class Stars implements EnginePlugin {
  /** Same as `engine.use(new Stars(...))`; returns the Stars. */
  static attach(engine: EngineKernel): Stars {const value = new Stars(); engine.use(value); return value;}
  enabled = true;
  readonly name = 'creative:stars';
  private buffer?: GPUBuffer;
  private layout?: GPUBindGroupLayout;
  private bindings?: GPUBindGroup;
  private module?: GPUShaderModule;
  private depthFormat?: GPUTextureFormat;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly data = new Float32Array(20);
  private readonly inverse = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly color: GPURenderPassColorAttachment = {view: undefined!, loadOp: 'load', storeOp: 'store'};
  private readonly depth: GPURenderPassDepthStencilAttachment = {view: undefined!, depthReadOnly: true, stencilReadOnly: true};
  private readonly descriptor: GPURenderPassDescriptor = {colorAttachments: [this.color], depthStencilAttachment: this.depth};

  setup(engine: Engine): void {
    const device = engine.gpu;
    if (!device) throw new Error('The Earth starfield requires WebGPU');
    this.depthFormat = device.features.has('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth32float';
    this.buffer = device.createBuffer({size: this.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    try {
      this.layout = device.createBindGroupLayout({entries: [{binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: 'uniform', minBindingSize: 80}}]});
      this.bindings = device.createBindGroup({layout: this.layout, entries: [{binding: 0, resource: {buffer: this.buffer}}]});
      this.module = device.createShaderModule({code: shader});
    } catch (error) {this.dispose(); throw error;}
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({name: this.name, order: 1, execute: this.execute});
  }

  private readonly execute = (context: PassContext): void => {
    if (context.backend !== 'webgpu' || !this.enabled) return;
    if (!invertMatrixStable(context.camera.matrix, this.inverse, this.workspace)) throw new Error('Invalid starfield camera');
    let pipeline = this.pipelines.get(context.format+':'+context.descriptor.multisample?.count);
    if (!pipeline) {
      pipeline = context.device.createRenderPipeline({
        layout: context.device.createPipelineLayout({bindGroupLayouts: [this.layout!]}),
        vertex: {module: this.module!, entryPoint: 'vs_main'},
        fragment: {module: this.module!, entryPoint: 'fs_main', targets: [{format: context.format}]},
        primitive: {topology: 'triangle-list'},
        multisample:context.descriptor.multisample,
        depthStencil: {format: this.depthFormat!, depthWriteEnabled: false, depthCompare: 'greater-equal'},
      });
      this.pipelines.set(context.format+':'+context.descriptor.multisample?.count, pipeline);
    }
    this.data.set(this.inverse);
    this.data.set(context.camera.position, 16);
    context.device.queue.writeBuffer(this.buffer!, 0, this.data);
    this.color.view = context.color;
    this.depth.view = context.depth;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindings!);
    pass.draw(3);
    pass.end();
  };

  onDeviceRestored(engine: Engine): void {this.dispose(); this.setup(engine);}
  dispose(): void {
    this.buffer?.destroy();
    this.buffer = this.layout = this.bindings = this.module = undefined;
    this.pipelines.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
