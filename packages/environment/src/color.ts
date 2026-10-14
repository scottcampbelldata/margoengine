// Solid or vertical-gradient background: the scene.background = color equivalent.
import type {EngineKernel} from '@margoengine/core';
import type {FrameGraph, PassContext} from '@margoengine/core/extension';
import {SRGBToLinear as srgbToLinear} from '@margoengine/math/color';

declare const GPUBufferUsage: {UNIFORM: number; COPY_DST: number};

/** `'#rgb'`, `'#rrggbb'`, `0xrrggbb` or sRGB components `[r, g, b]` in 0..1. */
export type ColorInput = string | number | readonly [number, number, number];
type GPUContext = Extract<PassContext, {backend: 'webgpu'}>;

/** sRGB components 0..1 of a ColorInput; throws TypeError on anything else. */
export function srgbColor(value: ColorInput): [number, number, number] {
  if (typeof value === 'string') {
    const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
    if (hex) return srgbColor(parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex, 16));
  } else if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
  } else if (Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && v >= 0 && v <= 1)) return [value[0], value[1], value[2]];
  throw new TypeError('Invalid color');
}

const shader = /* wgsl */ `
struct Colors {top:vec4f, bottom:vec4f}
@group(0) @binding(0) var<uniform> colors:Colors;
struct Out {@builtin(position) position:vec4f, @location(0) y:f32}
@vertex fn vertexMain(@builtin(vertex_index) index:u32)->Out {
  let p=vec2f(f32((index<<1u)&2u),f32(index&2u))*2.0-1.0;var o:Out;o.position=vec4f(p,0.0,1.0);o.y=p.y*0.5+0.5;return o;
}
@fragment fn fragmentMain(i:Out)->@location(0) vec4f {return mix(colors.bottom,colors.top,clamp(i.y,0.0,1.0));}`;

export interface ColorBackgroundOptions {
  /** Background color (top of the viewport when `bottom` is set). Default '#000000'. */
  color?: ColorInput;
  /** Optional color at the bottom of the viewport for a vertical gradient. */
  bottom?: ColorInput;
  /** Frame graph order; must run after core's main pass (order 0). Default 0.5, before glTF-pro models (1). */
  order?: number;
  /** Plugin and pass name. Default 'background'. */
  name?: string;
}

/**
 * Fills every pixel the scene left empty (depth still at the cleared reversed-Z 0) with a color or a vertical
 * gradient. On the canvas the color is shown exactly (no tone mapping, like Three.js `scene.background = color`);
 * on an rgba16float pass target (tonemap, creative PostProcessing) it writes the linear value so the post chain
 * treats it like scene radiance. The canvas stays opaque: a transparent canvas needs a core change.
 */
export class ColorBackground {
  readonly name: string;
  readonly order: number;
  private top!: [number, number, number];
  private under?: [number, number, number];
  private state?: {device: GPUDevice; uniform: GPUBuffer; module: GPUShaderModule; pipelines: Map<string, {pipeline: GPURenderPipeline; group: GPUBindGroup}>};
  private disposed = false;
  private readonly values = new Float32Array(8);
  private readonly colorAttachment: GPURenderPassColorAttachment = {view: undefined!, loadOp: 'load', storeOp: 'store'};
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {view: undefined!, depthReadOnly: true};
  private readonly passDescriptor: GPURenderPassDescriptor = {label: 'color background', colorAttachments: [this.colorAttachment], depthStencilAttachment: this.depthAttachment};

  constructor(options: ColorBackgroundOptions = {}) {
    this.name = options.name ?? 'background';
    this.order = options.order ?? 0.5;
    if (!(this.order > 0) || !Number.isFinite(this.order)) throw new RangeError('Background order must be greater than 0 (after the main pass)');
    this.color = options.color ?? 0;
    this.bottom = options.bottom;
  }
  /** sRGB components of the (top) color. Accepts any ColorInput. */
  get color(): [number, number, number] {return [...this.top];}
  set color(value: ColorInput) {this.top = srgbColor(value);}
  /** sRGB components of the bottom gradient color, or undefined for a solid color. */
  get bottom(): [number, number, number] | undefined {return this.under && [...this.under];}
  set bottom(value: ColorInput | undefined) {this.under = value === undefined ? undefined : srgbColor(value);}

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new Error('ColorBackground is disposed');
    if (engine.backend === 'webgl2') throw new Error('ColorBackground requires the WebGPU backend');
  }
  registerPasses(graph: FrameGraph): void {graph.add({name: this.name, order: this.order, execute: c => {if (c.backend === 'webgpu') this.record(c);}});}
  onDeviceRestored(): void {this.release();}
  dispose(): void {this.disposed = true; this.release();}

  /** Records the background into `context.encoder` over `context.color`, testing against `context.depth`. */
  record(context: GPUContext): void {
    if (this.disposed) return;
    const {device} = context, depthFormat = context.descriptor.depthStencil?.format ?? 'depth32float', count = context.descriptor.multisample?.count ?? 1;
    if (this.state?.device !== device) {
      this.release();
      const uniform = device.createBuffer({label: 'color background', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
      try {this.state = {device, uniform, module: device.createShaderModule({code: shader}), pipelines: new Map()};} catch (error) {uniform.destroy(); throw error;}
    }
    const state = this.state, key = `${context.format}|${depthFormat}|${count}`;
    let entry = state.pipelines.get(key);
    if (!entry) {
      const pipeline = device.createRenderPipeline({label: 'color background', layout: 'auto', vertex: {module: state.module, entryPoint: 'vertexMain'},
        fragment: {module: state.module, entryPoint: 'fragmentMain', targets: [{format: context.format}]}, primitive: {topology: 'triangle-list'},
        multisample: {count}, depthStencil: {format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal'}});
      state.pipelines.set(key, entry = {pipeline, group: device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: state.uniform}}]})});
    }
    const hdr = context.format === 'rgba16float' || context.format === 'rgba32float', v = this.values, bottom = this.under ?? this.top;
    for (let i = 0; i < 3; i++) {v[i] = hdr ? srgbToLinear(this.top[i]) : this.top[i]; v[4 + i] = hdr ? srgbToLinear(bottom[i]) : bottom[i];}
    v[3] = v[7] = 1;
    device.queue.writeBuffer(state.uniform, 0, v);
    this.colorAttachment.view = context.color; this.depthAttachment.view = context.depth;
    if (depthFormat.includes('stencil')) this.depthAttachment.stencilReadOnly = true; else delete this.depthAttachment.stencilReadOnly;
    const pass = context.encoder.beginRenderPass(this.passDescriptor);
    pass.setPipeline(entry.pipeline); pass.setBindGroup(0, entry.group); pass.draw(3); pass.end();
  }
  private release(): void {this.state?.uniform.destroy(); this.state = undefined;}
}
