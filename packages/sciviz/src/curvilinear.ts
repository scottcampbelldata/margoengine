import { invertMatrix } from '@margoengine/math/mat4';
import { rangeError, fault } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import type { VolumeLayer, VolumeLayerOptions } from './volume.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { volumeDepthWGSL } from './volume-depth.js';
import {
  mappedGrid,
  trilinear,
  type CurvilinearGrid,
  type SphericalGrid,
  type MappedGrid,
} from './curvilinear-grid.js';
import { curvilinearShader } from './curvilinear-shader.js';
export { inverseCurvilinearCell } from './curvilinear-grid.js';
export type { CurvilinearGrid, SphericalGrid } from './curvilinear-grid.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; VERTEX: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Sampling and classification for mapped volumes. */
export interface CurvilinearVolumeOptions extends Omit<VolumeLayerOptions, 'dims' | 'bounds'> {
  /** Reference opacity distance in physical units. Default smallest nonzero grid edge. */
  readonly referenceStep?: number;
}
/** Direct ray marching of structured curvilinear cells or exact spherical shells. */
export class CurvilinearVolume implements Drawable {
  /** False hides the volume, independently of its sections and outline. */
  visible = true;
  /** @internal */ readonly transparent = true;
  /** @internal */ readonly needsSceneDepth = true;
  /** The owned scalar source. Use its classifier, density, quality, mode and clip controls. Its box stays hidden. */
  readonly source: VolumeLayer;
  /** Physical bounding box. */
  get bounds(): VolumeLayer['bounds'] {
    return this.source.bounds;
  }
  readonly #figure: Figure;
  readonly #grid: MappedGrid;
  readonly #valid: Uint8Array;
  readonly #reference: number;
  readonly #sections = new Set<CurvilinearSection>();
  #disposed = false;
  #uniform!: GPUBuffer;
  #layout!: GPUBindGroupLayout;
  #textures: GPUTexture[] = [];
  #group: GPUBindGroup | undefined;
  #sourceTexture: GPUTexture | undefined;
  #transfer: GPUTexture | undefined;
  readonly #values = new Float32Array(80);
  /** @internal Use curvilinearVolume(). */
  constructor(
    figure: Figure,
    grid: CurvilinearGrid | SphericalGrid,
    data: ArrayLike<number>,
    options: CurvilinearVolumeOptions = {},
  ) {
    requireGPU(figure.renderer);
    this.#figure = figure;
    this.#grid = mappedGrid(grid);
    const size = this.#grid.dims.reduce((a, b) => a * b);
    if (
      data.length !== size ||
      !Array.from(data).some(Number.isFinite) ||
      Array.from(data).some((v) => !Number.isFinite(v) && !Number.isNaN(v))
    )
      throw rangeError(
        'Mapped volume needs one finite scalar or NaN mask per node, and at least one finite scalar',
        'sciviz',
      );
    this.#valid = Uint8Array.from(data, (v) => (Number.isFinite(v) ? 255 : 0));
    this.#reference = options.referenceStep ?? this.#grid.reference;
    if (!(this.#reference > 0) || !Number.isFinite(this.#reference))
      throw rangeError('Reference step must be finite and positive', 'sciviz');
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < data.length; i++)
      if (Number.isFinite(data[i])) {
        lo = Math.min(lo, data[i]);
        hi = Math.max(hi, data[i]);
      }
    this.source = figure.volume(
      Float32Array.from(data, (v) => (Number.isFinite(v) ? v : 0)),
      { ...options, range: options.range ?? [lo, hi], dims: this.#grid.dims, bounds: this.#grid.bounds },
    );
    this.source.visible = false;
    this.#build();
  }
  #texture(values: Float32Array): GPUTexture {
    const d = this.#figure.renderer.device!,
      count = Math.max(1, values.length / 4),
      w = Math.min(count, d.limits.maxTextureDimension2D),
      h = Math.ceil(count / w);
    if (h > d.limits.maxTextureDimension2D)
      throw rangeError('Mapped topology exceeds this GPU texture limit; reduce the grid', 'sciviz');
    const tex = d.createTexture({
      size: [w, h],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const padded = new Float32Array(w * h * 4);
    padded.set(values);
    d.queue.writeTexture({ texture: tex }, padded, { bytesPerRow: w * 16 }, [w, h]);
    return tex;
  }
  #build(): void {
    const d = this.#figure.renderer.device!;
    this.#uniform = d.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ...[4, 5, 6].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
      ],
    });
    this.#textures = [
      this.#texture(this.#grid.points),
      this.#texture(this.#grid.nodes),
      this.#texture(this.#grid.axes),
    ];
    const mask = d.createTexture({
      size: [...this.#grid.dims],
      format: 'r8unorm',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    d.queue.writeTexture(
      { texture: mask },
      this.#valid,
      { bytesPerRow: this.#grid.dims[0], rowsPerImage: this.#grid.dims[1] },
      [...this.#grid.dims],
    );
    this.#textures.push(mask);
    this.#group = undefined;
    this.#sourceTexture = undefined;
    this.#transfer = undefined;
  }
  /** @internal */ center(): readonly [number, number, number] {
    return this.source.center();
  }
  /** @internal */ prepare(): void {
    if (!this.source.valid || this.#disposed) return;
    const r = this.source.resources(),
      d = this.#figure.renderer.device!,
      v = this.#values,
      g = this.#grid;
    if (
      !(this.source.quality > 0) ||
      !Number.isFinite(this.source.quality) ||
      !(this.source.density > 0) ||
      !Number.isFinite(this.source.density)
    )
      throw rangeError('Mapped volume density and quality must be finite and positive', 'sciviz');
    v.set(this.source.model);
    invertMatrix(this.source.model, v.subarray(16, 32));
    v.set([...g.dims, g.spherical ? 1 : 0], 32);
    // Lengths are measured in units of the longest box side, so the march never squares a raw physical span
    // (1e20 overflows float32, 1e-20 underflows; KB5700b). The ratio of step to reference is unchanged.
    const longest = Math.max(g.bounds[1] - g.bounds[0], g.bounds[3] - g.bounds[2], g.bounds[5] - g.bounds[4]);
    v.set(
      [
        this.#reference / longest,
        this.source.quality * (this.#figure.renderer.samplingScale ?? 1),
        this.source.density,
        this.source.mode === 'mip' ? 1 : this.source.mode === 'minip' ? 2 : 0,
      ],
      36,
    );
    v.fill(0, 44, 80);
    v.set(this.source.classificationUniforms(), 40);
    v.set([g.bounds[0], g.bounds[2], g.bounds[4], g.nodes.length / 8], 48);
    v.set(
      [g.bounds[1] - g.bounds[0], g.bounds[3] - g.bounds[2], g.bounds[5] - g.bounds[4], this.source.shading ? 1 : 0],
      52,
    );
    v.set([...g.center, this.source.clip.length], 56);
    this.source.clip.forEach((p, k) => v.set([...p.normal, p.offset], 60 + k * 4));
    d.queue.writeBuffer(this.#uniform, 0, v);
    if (this.#sourceTexture !== r.data || this.#transfer !== r.transfer) {
      this.#group = this.bind(this.#uniform);
      this.#sourceTexture = r.data;
      this.#transfer = r.transfer;
      for (const section of this.#sections) section.rebind();
    }
  }
  /** @internal */ bind(uniform: GPUBuffer): GPUBindGroup {
    const r = this.source.resources();
    return this.#figure.renderer.device!.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: r.data.createView() },
        { binding: 2, resource: r.transfer.createView() },
        { binding: 3, resource: r.sampler },
        ...this.#textures.map((t, i) => ({ binding: i + 4, resource: t.createView() })),
      ],
    });
  }
  /** @internal */ draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.#disposed && this.source.valid && this.#group) this.render(pass, context, renderer, this.#group);
  }
  /** @internal */ render(
    pass: GPURenderPassEncoder,
    context: GpuContext,
    renderer: SciRenderer,
    group: GPUBindGroup,
    section?: CurvilinearSection,
  ): void {
    const outline = section?.outline ?? false,
      blend = section ? section.opacity < 1 : true;
    const pipeline = renderer.pipeline(
      `mapped volume|${section ? 'section' : 'ray'}|${outline}|${blend}`,
      context,
      (target) => {
        const module = renderer.device!.createShaderModule({
          code: frameWGSL + volumeDepthWGSL + curvilinearShader,
          label: 'sciviz mapped volume',
        });
        return {
          layout: renderer.device!.createPipelineLayout({
            bindGroupLayouts: [renderer.frameLayout!, this.#layout, renderer.depthLayout!],
          }),
          vertex: {
            module,
            entryPoint: section ? 'sliceVertex' : 'vertex',
            buffers: section
              ? [
                  {
                    arrayStride: 24,
                    attributes: [
                      { shaderLocation: 0, offset: 0, format: 'float32x3' },
                      { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    ],
                  },
                ]
              : [],
          },
          fragment: {
            module,
            entryPoint: outline ? 'outlineFragment' : section ? 'sliceFragment' : 'fragment',
            targets: [
              {
                format: target.format,
                blend: blend
                  ? {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    }
                  : undefined,
              },
            ],
          },
          primitive: { topology: outline ? 'line-list' : 'triangle-list' },
          multisample: target.multisample,
          depthStencil: {
            format: target.depth,
            depthWriteEnabled: !!section && !blend,
            depthCompare: section ? 'greater-equal' : 'always',
          },
        };
      },
    );
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, group);
    pass.setBindGroup(2, renderer.depthGroup!);
    if (section) pass.setVertexBuffer(0, section.buffer);
    pass.draw(section ? section.count : 3);
  }
  /** Curved coordinate slice at a node index, axis 0=longitude/i, 1=latitude/j, 2=radius/k. Fractional indices interpolate adjacent coordinate surfaces. */
  slice(axis: 0 | 1 | 2, index: number, options: { readonly opacity?: number } = {}): CurvilinearSection {
    this.#alive();
    const s = new CurvilinearSection(this, this.#figure, this.#grid, axis, index, options.opacity ?? 1);
    this.#sections.add(s);
    this.#figure.renderer.add(s);
    return s;
  }
  /** Boundary grid lines. stride defaults to 8 node intervals; all twelve boundary curves are always included. */
  outline(
    options: { readonly stride?: number; readonly color?: readonly [number, number, number] } = {},
  ): CurvilinearSection {
    this.#alive();
    const s = new CurvilinearSection(this, this.#figure, this.#grid, 0, 0, 1, options);
    this.#sections.add(s);
    this.#figure.renderer.add(s);
    return s;
  }
  #alive(): void {
    if (this.#disposed) throw fault('state', 'Mapped volume is disposed', 'sciviz');
  }
  /** @internal */ values(): Float32Array {
    return this.#values;
  }
  /** @internal */ forget(s: CurvilinearSection): void {
    this.#sections.delete(s);
  }
  #release(): void {
    this.#uniform.destroy();
    for (const t of this.#textures) t.destroy();
    this.#textures = [];
    this.#group = undefined;
  }
  /** @internal */ restore(): void {
    if (!this.#disposed) {
      this.#release();
      this.#build();
    }
  }
  /** Release the owned source, mapping, slices and outline. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const s of [...this.#sections]) s.dispose();
    this.#figure.renderer.remove(this);
    this.#release();
    this.#figure.remove(this.source);
  }
  /** Same as dispose(), for using. */ [Symbol.dispose](): void {
    this.dispose();
  }
}
/** An owned coordinate slice or boundary outline. */
export class CurvilinearSection implements Drawable {
  /** False hides the section. */ visible = true;
  /** Section opacity [0,1], default 1. */ opacity: number;
  /** @internal */ readonly outline: boolean;
  /** @internal */ readonly needsSceneDepth = true;
  /** @internal */ buffer!: GPUBuffer;
  /** @internal */ count = 0;
  readonly #parent: CurvilinearVolume;
  readonly #figure: Figure;
  readonly #grid: MappedGrid;
  readonly #axis: 0 | 1 | 2;
  readonly #color: readonly [number, number, number];
  readonly #stride: number;
  #index: number;
  #disposed = false;
  #uniform!: GPUBuffer;
  #group: GPUBindGroup | undefined;
  /** @internal */ constructor(
    parent: CurvilinearVolume,
    figure: Figure,
    grid: MappedGrid,
    axis: 0 | 1 | 2,
    index: number,
    opacity: number,
    outline?: { readonly stride?: number; readonly color?: readonly [number, number, number] },
  ) {
    this.#parent = parent;
    this.#figure = figure;
    this.#grid = grid;
    this.#axis = axis;
    this.#index = index;
    this.opacity = opacity;
    this.outline = !!outline;
    this.#color = outline?.color ?? [0.6, 0.7, 0.8];
    this.#stride = outline?.stride ?? 8;
    if (
      !Number.isInteger(this.#stride) ||
      this.#stride < 1 ||
      this.#color.length !== 3 ||
      !this.#color.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    )
      throw rangeError('Outline needs an integer stride >=1 and RGB in [0,1]', 'sciviz');
    this.#check(index);
    this.#build();
  }
  /** Node index of the coordinate slice. May be fractional. */ get index(): number {
    return this.#index;
  }
  set index(value: number) {
    this.#check(value);
    this.#index = value;
    if (!this.#disposed) {
      this.buffer.destroy();
      this.#mesh();
    }
  }
  #check(v: number): void {
    if (![0, 1, 2].includes(this.#axis) || !Number.isFinite(v) || v < 0 || v > this.#grid.dims[this.#axis] - 1)
      throw rangeError('Slice index must lie on the chosen grid axis', 'sciviz');
  }
  /** @internal */ get transparent(): boolean {
    return !this.outline && this.opacity < 1;
  }
  /** @internal */ center(): readonly [number, number, number] {
    return this.#parent.center();
  }
  #mesh(): void {
    const g = this.#grid,
      verts: number[] = [],
      emit = (q: number[]) => {
        let p: number[];
        if (g.spherical) {
          const coordinates = q.map((v, a) => {
            const i = Math.min(Math.floor(v), g.dims[a] - 2),
              f = v - i;
            return g.axes[i * 4 + a] * (1 - f) + g.axes[(i + 1) * 4 + a] * f;
          });
          const [lon, lat, r] = coordinates;
          const physical = [
            g.center[0] + r * Math.cos(lat) * Math.cos(lon),
            g.center[1] + r * Math.cos(lat) * Math.sin(lon),
            g.center[2] + r * Math.sin(lat),
          ];
          p = physical.map((v, a) => (v - g.bounds[a * 2]) / (g.bounds[a * 2 + 1] - g.bounds[a * 2]));
        } else {
          const base = q.map((v, a) => Math.min(Math.floor(v), g.dims[a] - 2)),
            f = q.map((v, a) => v - base[a]),
            c = new Float64Array(24);
          for (let k = 0; k < 8; k++) {
            const i = base[0] + (k & 1) + g.dims[0] * (base[1] + ((k >> 1) & 1) + g.dims[1] * (base[2] + (k >> 2)));
            for (let a = 0; a < 3; a++) c[k * 3 + a] = g.points[i * 4 + a];
          }
          p = trilinear(c, f).point;
        }
        verts.push(...p, ...q.map((v, a) => v / (g.dims[a] - 1)));
      };
    if (this.outline) {
      for (let axis = 0; axis < 3; axis++) {
        const b = (axis + 1) % 3,
          c = (axis + 2) % 3;
        for (let j = 0; j < g.dims[b]; j++)
          for (let k = 0; k < g.dims[c]; k++) {
            const jb = j === 0 || j === g.dims[b] - 1,
              kb = k === 0 || k === g.dims[c] - 1;
            if (!(jb || kb) || (!jb && j % this.#stride) || (!kb && k % this.#stride)) continue;
            for (let i = 0; i < g.dims[axis] - 1; i++) {
              const q = [0, 0, 0];
              q[axis] = i;
              q[b] = j;
              q[c] = k;
              emit(q);
              q[axis]++;
              emit(q);
            }
          }
      }
    } else {
      const a = this.#axis,
        b = (a + 1) % 3,
        c = (a + 2) % 3;
      for (let j = 0; j < g.dims[b] - 1; j++)
        for (let k = 0; k < g.dims[c] - 1; k++)
          for (const [dj, dk] of [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
            [1, 1],
            [0, 1],
          ]) {
            const q = [0, 0, 0];
            q[a] = this.#index;
            q[b] = j + dj;
            q[c] = k + dk;
            emit(q);
          }
    }
    this.count = verts.length / 6;
    this.buffer = this.#figure.renderer.device!.createBuffer({
      size: Math.max(4, verts.length * 4),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.#figure.renderer.device!.queue.writeBuffer(this.buffer, 0, new Float32Array(verts));
  }
  #build(): void {
    this.#uniform = this.#figure.renderer.device!.createBuffer({
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#mesh();
    this.#group = undefined;
  }
  /** @internal */ rebind(): void {
    this.#group = undefined;
  }
  /** @internal */ prepare(): void {
    if (this.#disposed || !this.#parent.source.valid) return;
    if (!Number.isFinite(this.opacity) || this.opacity < 0 || this.opacity > 1)
      throw rangeError('Section opacity must be in [0,1]', 'sciviz');
    this.#parent.prepare();
    const v = this.#parent.values().slice();
    v.set([this.opacity, ...this.#color], 76);
    this.#figure.renderer.device!.queue.writeBuffer(this.#uniform, 0, v);
    this.#group ??= this.#parent.bind(this.#uniform);
  }
  /** @internal */ draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#group && !this.#disposed && this.#parent.source.valid)
      this.#parent.render(pass, context, renderer, this.#group, this);
  }
  /** @internal */ restore(): void {
    if (!this.#disposed) {
      this.#uniform.destroy();
      this.buffer.destroy();
      this.#build();
    }
  }
  /** Remove and release this section. */ dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#figure.renderer.remove(this);
    this.#parent.forget(this);
    this.#uniform.destroy();
    this.buffer.destroy();
  }
  /** Same as dispose(), for using. */ [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Attach a direct mapped volume. Values are snapshotted, x/longitude index fastest; NaN masks missing nodes. */
export function curvilinearVolume(
  figure: Figure,
  grid: CurvilinearGrid | SphericalGrid,
  values: ArrayLike<number>,
  options: CurvilinearVolumeOptions = {},
): CurvilinearVolume {
  const layer = new CurvilinearVolume(figure, grid, values, options);
  figure.renderer.add(layer);
  return layer;
}
