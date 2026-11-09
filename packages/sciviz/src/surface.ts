// Surface plots: a height field z[j][i] over a regular x-y grid, drawn from a storage buffer (a GpuArray is read in
// place, so a surface computed on the GPU never comes back to the CPU). The vertex shader builds the grid from the
// vertex index and takes normals from central differences; the fragment shader colours by height through a colour
// map, lights the surface, and draws contour lines at even height steps with screen-space widths (fwidth).
import { rangeError, typeError } from '../../shared/errors.js';
import {
  colormapTexture,
  extent,
  isGpuArray,
  rangeOption,
  resolveColormap,
  sizeOf,
  storageOf,
  type ColormapSource,
  type DataSource,
} from './layer.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import type { Colormap } from './colormaps.js';
import { rayHeightField } from './pick.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Options for a surface plot. */
export interface SurfaceLayerOptions {
  /** Grid columns (x samples). Default: inferred from a GpuArray's shape [ny, nx], else the square root of the size. */
  readonly nx?: number;
  /** Grid rows (y samples). Default: size / nx. */
  readonly ny?: number;
  /** Data x range of the columns. Default [0, nx - 1]. */
  readonly x?: readonly [number, number];
  /** Data y range of the rows. Default [0, ny - 1]. */
  readonly y?: readonly [number, number];
  /** Colour map. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Height range the colour map spans. Default the data's min and max. */
  readonly range?: readonly [number, number];
  /** Contour lines across the colour range (0 for none). Default 10. */
  readonly contours?: number;
  /** Grid lines every this many cells (0 for none). Default 0. */
  readonly grid?: number;
  /** Opacity, 0 to 1. Default 1 (opaque). */
  readonly opacity?: number;
  /** Name shown in tooltips and legends. Default none. */
  readonly name?: string;
}

/** WGSL of the surface pipeline. */
const surfaceShader = /* Shader notes kept outside the uploaded source:
 * Central differences in data units (one-sided at the edges through the clamped reads).
 * Contours: darken within about one pixel of each level.
 */ /* wgsl */ `${frameWGSL}
struct Surface { model: mat4x4f, normalModel: mat4x4f, grid: vec4f, size: vec4u, style: vec4f }
@group(1) @binding(0) var<uniform> surface: Surface;
@group(1) @binding(1) var<storage, read> heights: array<f32>;
@group(1) @binding(2) var colours: texture_2d<f32>;
@group(1) @binding(3) var colourSampler: sampler;
struct Out { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f, @location(2) value: f32, @location(3) cell: vec2f }
fn height(i: i32, j: i32) -> f32 {
  let nx = i32(surface.size.x);
  let ny = i32(surface.size.y);
  return heights[u32(clamp(j, 0, ny - 1) * nx + clamp(i, 0, nx - 1))];
}
fn isNan(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u; }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let cells = surface.size.x - 1u;
  let cell = index / 6u;
  let corner = index % 6u;
  let di = select(0u, 1u, corner == 1u || corner == 2u || corner == 4u);
  let dj = select(0u, 1u, corner == 2u || corner == 4u || corner == 5u);
  let i = i32(cell % cells + di);
  let j = i32(cell / cells + dj);
  let h = height(i, j);
  let dx = surface.grid.y;
  let dy = surface.grid.w;
  let gx = (height(i + 1, j) - height(i - 1, j)) / (dx * f32(min(i + 1, i32(surface.size.x) - 1) - max(i - 1, 0)));
  let gy = (height(i, j + 1) - height(i, j - 1)) / (dy * f32(min(j + 1, i32(surface.size.y) - 1) - max(j - 1, 0)));
  let data = vec3f(surface.grid.x + f32(i) * dx, surface.grid.z + f32(j) * dy, h);
  var out: Out;
  let world = surface.model * vec4f(data, 1.0);
  out.world = world.xyz;
  out.clip = frame.clip * world;
  out.normal = normalize((surface.normalModel * vec4f(-gx, -gy, 1.0, 0.0)).xyz);
  out.value = h;
  out.cell = vec2f(f32(i), f32(j));
  if (isNan(h)) { out.clip = vec4f(0.0, 0.0, 2.0, 1.0); }
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let t = clamp((in.value - surface.style.x) / max(surface.style.y - surface.style.x, 1e-30), 0.0, 1.0);
  var albedo = textureSampleLevel(colours, colourSampler, vec2f(t, 0.5), 0.0).rgb;
  if (surface.style.z > 0.0) {
    let level = t * surface.style.z;
    let width = fwidth(level);
    let line = 1.0 - smoothstep(0.0, 1.5 * width, abs(fract(level + 0.5) - 0.5));
    albedo = mix(albedo, albedo * 0.35, line * 0.8);
  }
  if (surface.size.z > 0u) {
    let g = in.cell / f32(surface.size.z);
    let w = fwidth(g);
    let line = max(1.0 - smoothstep(0.0, 1.2 * w.x, abs(fract(g.x + 0.5) - 0.5)), 1.0 - smoothstep(0.0, 1.2 * w.y, abs(fract(g.y + 0.5) - 0.5)));
    albedo = mix(albedo, vec3f(0.92), line * 0.5);
  }
  let colour = shade(albedo, normalize(in.normal), normalize(frame.eye.xyz - in.world));
  return vec4f(toOutput(colour), surface.style.w);
}`;

/** A surface plot layer. Create it with `figure.surface(z, options)`. */
export class SurfaceLayer implements Drawable {
  /** False hides the layer. */
  visible = true;
  /** Grid size. */
  readonly nx: number;
  readonly ny: number;
  /** Data x and y ranges of the grid. */
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  /** The colour map. */
  readonly colormap: Colormap;
  /** Name shown in tooltips and legends. */
  readonly name: string | undefined;
  #range: [number, number];
  #contours: number;
  #grid: number;
  #opacity: number;
  readonly #renderer: SciRenderer;
  readonly #data: DataSource;
  // The heights on the CPU for picking (undefined for a GpuArray source).
  #cpu: ArrayLike<number> | undefined;
  #heights: { buffer: GPUBuffer; owned: boolean } | undefined;
  #texture: GPUTexture | undefined;
  #uniform: GPUBuffer | undefined;
  #group: GPUBindGroup | undefined;
  #layout: GPUBindGroupLayout | undefined;
  readonly #values = new Float32Array(48);
  #model: Float32Array = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  #dirty = true;
  #disposed = false;

  /** @internal Use `figure.surface()`. */
  constructor(renderer: SciRenderer, z: DataSource, options: SurfaceLayerOptions = {}) {
    this.#renderer = renderer;
    this.#data = z;
    const size = sizeOf(z),
      shape = isGpuArray(z) ? z.shape : undefined;
    const nx = options.nx ?? (shape?.length === 2 ? shape[1] : Math.round(Math.sqrt(size)));
    const ny = options.ny ?? Math.round(size / nx);
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 2 || ny < 2 || nx * ny !== size)
      throw rangeError(
        `Surface needs a grid of at least 2 x 2 matching ${size} heights; pass nx and ny (got ${nx} x ${ny})`,
        'sciviz',
      );
    this.nx = nx;
    this.ny = ny;
    this.x = rangeOption(options.x, 'Surface x') ?? [0, nx - 1];
    this.y = rangeOption(options.y, 'Surface y') ?? [0, ny - 1];
    this.colormap = resolveColormap(options.colormap);
    this.name = options.name;
    this.#cpu = isGpuArray(z) ? undefined : z;
    const given = rangeOption(options.range, 'Surface range');
    if (!given && isGpuArray(z))
      throw typeError('A GpuArray surface needs range: [min, max] (read it with z.min().item())', 'sciviz');
    this.#range = given ?? extent(z as ArrayLike<number>);
    if (this.#range[0] === this.#range[1]) this.#range = [this.#range[0] - 0.5, this.#range[1] + 0.5];
    this.#contours = this.#count(options.contours ?? 10, 'contours');
    this.#grid = this.#count(options.grid ?? 0, 'grid');
    this.#opacity = options.opacity ?? 1;
    if (!(this.#opacity >= 0 && this.#opacity <= 1))
      throw rangeError(`Surface opacity must be in [0, 1], got ${this.#opacity}`, 'sciviz');
    this.#build();
  }

  #count(v: number, what: string): number {
    if (!Number.isInteger(v) || v < 0)
      throw rangeError(`Surface ${what} must be a whole number of at least 0, got ${v}`, 'sciviz');
    return v;
  }

  #build(): void {
    const device = this.#renderer.device!;
    this.#heights = storageOf(device, this.#cpu ?? this.#data, 'Surface heights');
    this.#texture = colormapTexture(device, this.colormap);
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: { buffer: this.#heights.buffer } },
        { binding: 2, resource: this.#texture.createView() },
        { binding: 3, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      ],
    });
    this.#dirty = true;
  }

  /** @internal The device was restored: rebuild from the CPU data (a GpuArray source must be rebuilt by you). */
  restore(): void {
    if (!isGpuArray(this.#data)) this.#build();
    else {
      this.#group = undefined;
      this.visible = false;
    }
  }

  /** Heights are blended only when opacity is below 1. */
  get transparent(): boolean {
    return this.#opacity < 1;
  }

  /** The height range the colour map spans. */
  get range(): readonly [number, number] {
    return this.#range;
  }
  set range(value: readonly [number, number]) {
    this.#range = rangeOption(value, 'Surface range')!;
    this.#dirty = true;
  }

  /** Data bounds of the surface: [xmin, xmax, ymin, ymax, zmin, zmax]. */
  get bounds(): [number, number, number, number, number, number] {
    return [this.x[0], this.x[1], this.y[0], this.y[1], this.#range[0], this.#range[1]];
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

  /** Writes new heights (same grid size) from the CPU. A GpuArray source updates in place; call `invalidate()` instead. */
  setHeights(values: ArrayLike<number>): void {
    if (values.length !== this.nx * this.ny)
      throw rangeError(`setHeights needs ${this.nx * this.ny} values, got ${values.length}`, 'sciviz');
    if (!this.#heights?.owned)
      throw typeError('This surface reads a GpuArray; write to the GpuArray instead', 'sciviz');
    const copy = Float32Array.from(values);
    this.#cpu = copy;
    this.#renderer.device!.queue.writeBuffer(this.#heights.buffer, 0, copy);
  }

  /**
   * @internal The first point where a ray in data units meets the surface: data position, grid cell and height, or
   * null (also for a GpuArray source, whose heights stay on the GPU).
   */
  raycast(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { x: number; y: number; z: number; t: number; index: number } | null {
    if (!this.#cpu) return null;
    const dx = (this.x[1] - this.x[0]) / (this.nx - 1),
      dy = (this.y[1] - this.y[0]) / (this.ny - 1);
    const hit = rayHeightField(origin, direction, {
      heights: this.#cpu,
      nx: this.nx,
      ny: this.ny,
      x0: this.x[0],
      dx,
      y0: this.y[0],
      dy,
    });
    if (!hit) return null;
    const i = Math.min(this.nx - 1, Math.max(0, Math.round((hit.x - this.x[0]) / dx))),
      j = Math.min(this.ny - 1, Math.max(0, Math.round((hit.y - this.y[0]) / dy)));
    return { ...hit, index: j * this.nx + i };
  }

  /** @internal */
  prepare(): void {
    if (!this.#group) return;
    if (!this.#dirty) return;
    const v = this.#values,
      m = this.#model;
    v.set(m, 0);
    // Normals: inverse transpose of the model's linear part (a scale and an axis swap: the inverse scale).
    const inv = (s: number) => (s ? 1 / s : 0);
    v.set([inv(m[0]), 0, 0, 0, 0, 0, inv(m[6]), 0, 0, inv(m[9]), 0, 0, 0, 0, 0, 1], 16);
    v.set([this.x[0], (this.x[1] - this.x[0]) / (this.nx - 1), this.y[0], (this.y[1] - this.y[0]) / (this.ny - 1)], 32);
    new Uint32Array(v.buffer, 36 * 4, 4).set([this.nx, this.ny, this.#grid, 0]);
    v.set([this.#range[0], this.#range[1], this.#contours, this.#opacity], 40);
    this.#renderer.device!.queue.writeBuffer(this.#uniform!, 0, v);
    this.#dirty = false;
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.#group) return;
    const transparent = this.transparent;
    const pipeline = renderer.pipeline(`surface|${transparent}`, context, (target) => {
      const module = renderer.device!.createShaderModule({ code: surfaceShader, label: 'sciviz surface' });
      return {
        label: 'sciviz surface',
        layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout!] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: target.format,
              blend: transparent
                ? {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: !transparent, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group!);
    pass.draw((this.nx - 1) * (this.ny - 1) * 6);
  }

  /** Frees the GPU resources (not a GpuArray source). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    if (this.#heights?.owned) this.#heights.buffer.destroy();
    this.#texture?.destroy();
    this.#uniform?.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
