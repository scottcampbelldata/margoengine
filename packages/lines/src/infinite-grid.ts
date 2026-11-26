/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { parseColor, type ColorInput } from './color.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { alphaBlend, overlayPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Options for {@link InfiniteGrid}. Every number is validated at construction and on every change. */
export interface InfiniteGridOptions {
  /** Plugin and pass name. Default 'infinite-grid'. */
  name?: string;
  /** Frame graph order. Default 19: just before `Lines` (20), after the scene. */
  order?: number;
  /** Distance between thin lines, world units, above 0. Default 1. */
  cellSize?: number;
  /** Distance between thick section lines, world units, at least `cellSize`; 0 draws no sections. Default 10. */
  sectionSize?: number;
  /** Thin line width in CSS-independent drawing-buffer pixels, 0 or more. Default 1. */
  cellThickness?: number;
  /** Section line width in drawing-buffer pixels, 0 or more. Default 1.5. */
  sectionThickness?: number;
  /** Thin line colour. Default a mid grey. */
  cellColor?: ColorInput;
  /** Section line colour. Default a lighter grey. */
  sectionColor?: ColorInput;
  /** Height of the grid plane (world y). Default 0. */
  y?: number;
  /** Distance from the camera (or from the origin when `followCamera` is false) where the grid is gone. Above 0. Default 100. */
  fadeDistance?: number;
  /** Overall opacity 0..1. Default 1. */
  opacity?: number;
  /** Keep the fading disc centred under the camera, so the grid never ends. false: a fixed disc around the origin. Default true. */
  followCamera?: boolean;
}

const bad = (what: string, fix: string): never => {
  throw new RangeError(`Invalid infinite grid ${what}; ${fix}`);
};
const positive = (value: unknown, what: string): void => {
  if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value))
    bad(what, `pass a finite number above 0 for ${what}`);
};
const nonNegative = (value: unknown, what: string): void => {
  if (typeof value !== 'number' || !(value >= 0) || !Number.isFinite(value))
    bad(what, `pass a finite number of 0 or more for ${what}`);
};

/**
 * Coverage 0..1 of grid lines `size` apart at world coordinate `coord` (one axis), the way the shader draws it: the
 * distance to the nearest line over the coordinate's change per pixel (`pixel`, what `fwidth` returns on the GPU) gives
 * a one-pixel antialiased ramp around a line `thickness` pixels wide, and lines closer than two pixels fade out so the
 * far grid never turns to moire. Exported so tests and CPU renderers draw what the GPU draws.
 */
export function gridCoverage(coord: number, size: number, thickness: number, pixel: number): number {
  const cells = coord / size,
    step = pixel / size,
    distance = Math.abs(cells - Math.round(cells)) / step,
    coverage = Math.min(1, Math.max(0, thickness * 0.5 + 0.5 - distance));
  return coverage * (1 - Math.min(1, Math.max(0, 2 * step - 1)));
}

const wgsl = `struct G{view:mat4x4f,a:vec4f,b:vec4f,c:vec4f,cell:vec4f,section:vec4f}
@group(0) @binding(0) var<uniform> g:G;
struct V{@builtin(position) p:vec4f,@location(0) w:vec2f}
@vertex fn vs(@builtin(vertex_index) i:u32)->V{
let q=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[i];
let w=g.a.xz+q*g.a.w;
return V(g.view*vec4f(w.x,g.a.y,w.y,1),w);}
fn cover(w:vec2f,size:f32,thick:f32)->f32{
let u=w/size;let f=fwidth(u);
let d=abs(u-round(u))/max(f,vec2f(1e-6));
let c=clamp(vec2f(thick*.5+.5)-d,vec2f(0),vec2f(1));
let m=max(f.x,f.y);
return max(c.x,c.y)*(1-clamp(2*m-1,0,1));}
@fragment fn fs(v:V)->@location(0) vec4f{
let cell=cover(v.w,g.b.x,g.b.z);
var sec=0.;
if(g.b.y>0){sec=cover(v.w,g.b.y,g.b.w);}
let fade=1-smoothstep(0,g.c.x,distance(v.w,g.c.yz));
let alpha=max(cell,sec)*fade*g.c.w;
let rgb=mix(g.cell.xyz,g.section.xyz,select(0.,sec/max(max(cell,sec),1e-6),sec>0));
return vec4f(rgb,alpha);}`;

/**
 * An endless ground grid drawn by the GPU: thin cell lines and thick section lines with analytic antialiasing, a
 * smooth distance fade, and a fading disc that follows the camera so the grid has no edge. One draw of two triangles;
 * the lines come from the shader, not from geometry, so any `cellSize` costs the same. WebGPU only (a WebGL2 preview
 * throws `unsupported` when the plugin is used).
 *
 * @example
 * const engine = await Engine.create(canvas);
 * const grid = InfiniteGrid.attach(engine, { cellSize: 0.5, sectionSize: 5, fadeDistance: 60 });
 * grid.sectionColor = '#ff8800'; // Live: read on the next frame.
 */
export class InfiniteGrid implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  cellSize: number;
  sectionSize: number;
  cellThickness: number;
  sectionThickness: number;
  cellColor: ColorInput;
  sectionColor: ColorInput;
  y: number;
  fadeDistance: number;
  opacity: number;
  followCamera: boolean;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private group?: GPUBindGroup;
  private layout?: GPUBindGroupLayout;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly data = new Float32Array(36);
  private readonly descriptor = overlayPass();
  private module?: GPUShaderModule;

  constructor(options: InfiniteGridOptions = {}) {
    this.name = options.name ?? 'infinite-grid';
    this.order = options.order ?? 19;
    this.cellSize = options.cellSize ?? 1;
    this.sectionSize = options.sectionSize ?? 10;
    this.cellThickness = options.cellThickness ?? 1;
    this.sectionThickness = options.sectionThickness ?? 1.5;
    this.cellColor = options.cellColor ?? [0.37, 0.37, 0.37];
    this.sectionColor = options.sectionColor ?? [0.56, 0.56, 0.56];
    this.y = options.y ?? 0;
    this.fadeDistance = options.fadeDistance ?? 100;
    this.opacity = options.opacity ?? 1;
    this.followCamera = options.followCamera ?? true;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw new TypeError('Infinite grid needs a non-empty name and a finite order; pass { name, order }');
    this.check();
  }

  /** Makes a grid and adds it to `engine`. */
  static attach(engine: Pick<Engine, 'use'>, options?: InfiniteGridOptions): InfiniteGrid {
    const grid = new InfiniteGrid(options);
    engine.use(grid);
    return grid;
  }

  private check(): void {
    positive(this.cellSize, 'cellSize');
    nonNegative(this.sectionSize, 'sectionSize');
    if (this.sectionSize > 0 && this.sectionSize < this.cellSize)
      bad('sectionSize', 'pass a sectionSize of 0 (no sections) or at least cellSize');
    nonNegative(this.cellThickness, 'cellThickness');
    nonNegative(this.sectionThickness, 'sectionThickness');
    positive(this.fadeDistance, 'fadeDistance');
    if (typeof this.y !== 'number' || !Number.isFinite(this.y)) bad('y', 'pass a finite number for y');
    if (typeof this.opacity !== 'number' || !(this.opacity >= 0 && this.opacity <= 1))
      bad('opacity', 'pass an opacity from 0 to 1');
    parseColor(this.cellColor);
    parseColor(this.sectionColor);
  }

  setup(engine: Engine): void {
    requireWebGPU(engine, 'InfiniteGrid');
    const device = (this.device = engine.gpu);
    this.engine = engine;
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: this.data.byteLength },
        },
      ],
    });
    this.buffer = device.createBuffer({
      size: this.data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.group = device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }],
    });
    this.module = device.createShaderModule({ code: wgsl });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  private readonly execute = (context: PassContext): void => {
    if (context.backend !== 'webgpu' || !this.device || context.device !== this.device) return;
    this.check();
    const { camera, device } = context,
      data = this.data,
      centre = this.followCamera ? camera.position : [0, 0, 0],
      cell = parseColor(this.cellColor),
      section = parseColor(this.sectionColor);
    data.set(camera.matrix);
    data.set([centre[0], this.y, centre[2], this.fadeDistance], 16);
    data.set([this.cellSize, this.sectionSize, this.cellThickness, this.sectionThickness], 20);
    data.set([this.fadeDistance, centre[0], centre[2], this.opacity], 24);
    data.set([cell[0], cell[1], cell[2], 1], 28);
    data.set([section[0], section[1], section[2], 1], 32);
    device.queue.writeBuffer(this.buffer!, 0, data);
    const depth = context.descriptor.depthStencil!.format,
      count = context.descriptor.multisample?.count ?? 1,
      key = `${context.format} ${depth} ${count}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
        vertex: { module: this.module!, entryPoint: 'vs' },
        fragment: {
          module: this.module!,
          entryPoint: 'fs',
          targets: [{ format: context.format, blend: alphaBlend }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: depth, depthWriteEnabled: false, depthCompare: 'less-equal' },
        multisample: { count },
      });
      this.pipelines.set(key, pipeline);
    }
    this.descriptor.colorAttachments[0].view = context.color;
    this.descriptor.depthStencilAttachment.view = context.depth;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    applyView(pass, context);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group!);
    pass.draw(6);
    pass.end();
  };

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  private release(): void {
    this.buffer?.destroy();
    this.buffer = this.group = this.layout = this.module = this.device = undefined;
    this.pipelines.clear();
  }

  /** Leaves its engine and frees the GPU buffer. Safe to call twice. */
  dispose(): void {
    this.engine?.sceneOf?.(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
