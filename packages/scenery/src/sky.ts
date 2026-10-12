import type {Engine, EnginePlugin, FrameGraph, PassContext} from '@margoengine/core/extension';
import {invert} from '../../shared/math.js';
import {SkyMoonPass, type SkyMoonConfig} from './sky-moon.js';

export class SkyMoon implements EnginePlugin {
  readonly name = 'sky-moon';
  private sky?: SkyMoonPass;
  private hdr?: SkyMoonPass;
  private format?: GPUTextureFormat;
  private time = 0;
  private readonly inverse = new Float32Array(16);
  private readonly inverseWorkspace = new Float64Array(52);
  private readonly color: GPURenderPassColorAttachment = {view: undefined!, loadOp: 'load', storeOp: 'store'};
  private readonly depth: GPURenderPassDepthStencilAttachment = {view: undefined!, depthReadOnly: true, stencilReadOnly: true};
  private readonly descriptor: GPURenderPassDescriptor = {colorAttachments: [this.color], depthStencilAttachment: this.depth};

  constructor(readonly options: SkyMoonConfig = {}) {}

  setup(engine: Engine): void {
    if (!engine.gpu) throw new Error('SkyMoon requires WebGPU');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    const depthFormat = engine.gpu.features.has('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth32float';
    this.sky = new SkyMoonPass(engine.gpu, this.format, depthFormat);
    this.sky.setConfig(this.options);
    this.hdr = new SkyMoonPass(engine.gpu, 'rgba16float', depthFormat);
    this.hdr.setConfig(this.options);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({name: 'scenery:sky-moon', order: 1, execute: this.execute});
  }

  private readonly execute = (context: PassContext): void => {
    if (context.backend !== 'webgpu') return;
    if (context.format !== this.format && context.format !== 'rgba16float') throw new Error('Unsupported SkyMoon target format');
    if (!invert(this.inverse, context.camera.matrix, 0, this.inverseWorkspace)) throw new Error('Invalid sky camera');
    this.time += context.delta;
    const sky = context.format === 'rgba16float' ? this.hdr! : this.sky!;
    sky.updateFrame(this.inverse, context.camera.position, this.time);
    this.color.view = context.color; this.depth.view = context.depth;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    sky.record(pass, context.descriptor.multisample?.count); pass.end();
  };

  onDeviceRestored(engine: Engine): void {this.dispose(); this.setup(engine);}
  dispose(): void {this.sky?.dispose(); this.hdr?.dispose(); this.sky = this.hdr = undefined;}
}
