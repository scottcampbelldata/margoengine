// Filled rectangles in data units: the bars of bar charts and histograms and the cells of heatmaps. One instanced draw:
// each instance reads its rectangle and packed sRGB colour from storage buffers and the vertex shader builds its two
// triangles. Rectangles sit a little below lines and points (data z -0.5 in a 2D figure) and above the grid.
import { rangeError } from '../../shared/errors.js';
import { rectAt } from './charts.js';
import type { Bounds } from './layer.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

const rectShader = /* wgsl */ `${frameWGSL}
struct Rects { model: mat4x4f, depth: vec4f }
@group(1) @binding(0) var<uniform> layer: Rects;
@group(1) @binding(1) var<storage, read> rects: array<vec4f>;
@group(1) @binding(2) var<storage, read> colours: array<u32>;
struct Out { @builtin(position) clip: vec4f, @location(0) @interpolate(flat) colour: vec3f }
fn linear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
@vertex fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) k: u32) -> Out {
  let r = rects[k];
  let corner = v % 6u;
  let x = select(r.x, r.z, corner == 1u || corner == 2u || corner == 4u);
  let y = select(r.y, r.w, corner == 2u || corner == 4u || corner == 5u);
  var out: Out;
  out.clip = frame.clip * (layer.model * vec4f(x, y, layer.depth.x, 1.0));
  out.colour = linear(unpack4x8unorm(colours[k]).rgb);
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f { return vec4f(toOutput(in.colour), 1.0); }`;

/** Packs an sRGB colour (0..1 channels) as the u32 the rectangle shader unpacks. */
export const packColour = (r: number, g: number, b: number): number =>
  (Math.round(r * 255) | (Math.round(g * 255) << 8) | (Math.round(b * 255) << 16) | (255 << 24)) >>> 0;

/** A layer of filled rectangles: a bar chart, histogram or heatmap. Create it with `figure.bar()`, `figure.histogram()` or `figure.heatmap()`. */
export class RectsLayer implements Drawable {
  /** @internal Inventory for the optional monitor entry. */
  get memoryResources(): import('./resources.js').LayerResources {
    return {
      cpu: [this.rects, this.values, this.#colours, this.#uniform, this.#model],
      gpu: this.#disposed ? [] : this.#buffers,
    };
  }
  /** False hides the layer. */
  visible = true;
  /** Rectangles are opaque. */
  readonly transparent = false;
  /** Which chart made the layer. */
  readonly kind: 'bar' | 'histogram' | 'heatmap';
  /** Name shown in tooltips and legends. */
  readonly name: string | undefined;
  /** [x0, y0, x1, y1] per rectangle, in data units. */
  readonly rects: Float32Array;
  /** The value each rectangle shows: a bar's height, a bin's count or a cell's value. */
  readonly values: Float32Array;
  /** A representative colour (`#rrggbb`) for legends. */
  readonly swatch: string;
  readonly #colours: Uint32Array;

  /** Each rectangle's packed sRGB colour (red in the low byte). */
  get colours(): Uint32Array {
    return this.#colours;
  }
  readonly #renderer: SciRenderer;
  readonly #uniform = new Float32Array(20);
  #model: Float32Array = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  #buffers: GPUBuffer[] = [];
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  #dirty = true;
  #disposed = false;

  /** @internal Use the figure's chart methods. */
  constructor(
    renderer: SciRenderer,
    kind: 'bar' | 'histogram' | 'heatmap',
    rects: Float32Array,
    values: Float32Array,
    colours: Uint32Array,
    options: { readonly name?: string; readonly swatch: string },
  ) {
    if (rects.length !== values.length * 4 || colours.length !== values.length)
      throw rangeError(`${kind} needs four rectangle numbers and one colour per value`, 'sciviz');
    this.#renderer = renderer;
    this.kind = kind;
    this.rects = rects;
    this.values = values;
    this.#colours = colours;
    this.name = options.name;
    this.swatch = options.swatch;
    this.#build();
  }

  #build(): void {
    const device = this.#renderer.device!;
    const buffer = (data: Float32Array | Uint32Array, usage: number) => {
      const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage });
      device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      return b;
    };
    this.#buffers = [
      device.createBuffer({ size: this.#uniform.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      buffer(this.rects, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      buffer(this.#colours, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    ];
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: this.#buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.#dirty = true;
  }

  /** @internal The device was restored: rebuild from the CPU copies. */
  restore(): void {
    this.#build();
  }

  /** Data bounds of the rectangles: [xmin, xmax, ymin, ymax, 0, 0]. */
  get bounds(): Bounds {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    const r = this.rects;
    for (let k = 0; k < r.length; k += 4) {
      // Empty cells (NaN values) collapse to a point and do not count.
      if (r[k] === r[k + 2] && r[k + 1] === r[k + 3]) continue;
      x0 = Math.min(x0, r[k]);
      y0 = Math.min(y0, r[k + 1]);
      x1 = Math.max(x1, r[k + 2]);
      y1 = Math.max(y1, r[k + 3]);
    }
    return x0 <= x1 ? [x0, x1, y0, y1, 0, 0] : [0, 1, 0, 1, 0, 0];
  }

  /** The rectangle containing data (x, y), or -1. */
  indexAt(x: number, y: number): number {
    return rectAt(this.rects, x, y);
  }

  /** @internal The figure's data-to-scene transform. */
  setModel(model: Float32Array): void {
    this.#model = model;
    this.#dirty = true;
  }

  /** @internal */
  center(): readonly [number, number, number] {
    return [this.#model[12], this.#model[13], this.#model[14]];
  }

  /** @internal */
  prepare(): void {
    if (!this.#dirty) return;
    this.#uniform.set(this.#model, 0);
    this.#uniform[16] = -0.5;
    this.#renderer.device!.queue.writeBuffer(this.#buffers[0], 0, this.#uniform);
    this.#dirty = false;
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const pipeline = renderer.pipeline('rects', context, (target) => {
      const module = renderer.device!.createShaderModule({ code: rectShader, label: 'sciviz rects' });
      return {
        label: 'sciviz rects',
        layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout!] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group!);
    pass.draw(6, this.values.length);
  }

  /** Frees the GPU buffers. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    for (const b of this.#buffers) b.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
