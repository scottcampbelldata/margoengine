import { invertMatrix } from '@margoengine/math/mat4';
import type { Figure, LineLayer, LineLayerOptions } from './figure.js';
import type { Bounds } from './layer.js';
import { createAMR, sampleAMR, amrError, type AMRData, type AMROptions } from './amr-data.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import type { VolumeLayer, VolumeLayerOptions } from './volume.js';
import { volumeDepthWGSL } from './volume-depth.js';
import { amrShader } from './amr-shader.js';
import { createDataSet } from './datasets.js';
import { contourGrid, type GridContours } from './contour.js';
import { sliceGrid, type SlicePlane, type TriangleSet, type UnstructuredGrid } from './grids.js';
export { createAMR, sampleAMR, traceAMR } from './amr-data.js';
export type { AMRBlock, AMRData, AMRNode, AMROptions } from './amr-data.js';
export { readAMReX, readEnzo, readFLASH } from './amr-readers.js';
export type { AMRReadOptions } from './amr-readers.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { FRAGMENT: number };

/** Direct volume options, independent of any finest-level covering grid. */
export interface AMRVolumeOptions extends Omit<VolumeLayerOptions, 'dims' | 'bounds'>, AMROptions {
  /** Physical distance to which transfer opacity applies. Default smallest cell spacing. */
  readonly referenceStep?: number;
  /** Interpolation within each owning block. Default linear. */
  readonly interpolation?: 'nearest' | 'linear';
}
/** Direct ray casting through disjoint k-d leaves, with finest-level ownership and opaque scene depth. */
export class AMRVolume implements Drawable {
  visible = true;
  /** @internal */ readonly transparent = true;
  /** @internal */ readonly needsSceneDepth = true;
  /** Hidden classifier source: density, quality, mode, shading, clips and colour map. */
  readonly source: VolumeLayer;
  /** Owned hierarchy snapshot. */
  readonly data: AMRData;
  /** Physical outer faces. */ get bounds(): Bounds {
    return this.data.bounds;
  }
  #figure: Figure;
  #reference: number;
  #linear: boolean;
  #uniform!: GPUBuffer;
  #layout!: GPUBindGroupLayout;
  #textures: GPUTexture[] = [];
  #group?: GPUBindGroup;
  #transfer?: GPUTexture;
  #values = new Float32Array(64);
  #disposed = false;
  /** @internal Use amrVolume to attach this layer. */
  constructor(figure: Figure, data: AMRData, options: AMRVolumeOptions = {}) {
    requireGPU(figure.renderer);
    this.#figure = figure;
    this.data = createAMR(data.blocks, options);
    this.#reference =
      options.referenceStep ??
      Math.min(...data.blocks.flatMap((b) => b.dims.map((n, k) => (b.bounds[2 * k + 1] - b.bounds[2 * k]) / n)));
    if (!(this.#reference > 0) || !Number.isFinite(this.#reference))
      amrError('referenceStep must be positive and finite');
    if (options.interpolation !== undefined && !['nearest', 'linear'].includes(options.interpolation))
      amrError('interpolation must be nearest or linear');
    this.#linear = options.interpolation !== 'nearest';
    const count = this.data.blocks.reduce((n, b) => n + b.values.length, 0),
      capacity = figure.renderer.device!.limits.maxTextureDimension2D ** 2;
    if (
      Math.max(Math.ceil(count / 4), this.data.nodes.length * 2, this.data.blocks.length * 3) >
        Math.min(capacity, 2 ** 23) ||
      count > 2 ** 24
    )
      amrError('block textures exceed exact float indexing or device capacity; partition the hierarchy');
    this.source = figure.volume(new Float32Array(8).fill(this.data.range[0]), {
      ...options,
      dims: [2, 2, 2],
      bounds: this.bounds,
      range: options.range ?? this.data.range,
    });
    this.source.visible = false;
    this.#build();
  }
  #upload(values: Float32Array): GPUTexture {
    const d = this.#figure.renderer.device!,
      count = Math.ceil(values.length / 4),
      w = Math.min(Math.max(1, count), d.limits.maxTextureDimension2D),
      h = Math.ceil(Math.max(1, count) / w),
      padded = new Float32Array(w * h * 4);
    padded.set(values);
    const texture = d.createTexture({
      size: [w, h],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    d.queue.writeTexture({ texture }, padded, { bytesPerRow: w * 16 }, [w, h]);
    return texture;
  }
  #build(): void {
    const d = this.#figure.renderer.device!,
      b = this.bounds,
      norm = (v: number, k: number) => (v - b[2 * k]) / (b[2 * k + 1] - b[2 * k]);
    const nodes = this.data.nodes.flatMap((n) => [
      norm(n.bounds[0], 0),
      norm(n.bounds[2], 1),
      norm(n.bounds[4], 2),
      n.end,
      norm(n.bounds[1], 0),
      norm(n.bounds[3], 1),
      norm(n.bounds[5], 2),
      n.axis >= 0 ? 0 : n.block + 1,
    ]);
    const blocks: number[] = [],
      values: number[] = [];
    const [low, high] = this.source.range,
      span = high - low || 1;
    for (const block of this.data.blocks) {
      const p = block.bounds;
      blocks.push(
        norm(p[0], 0),
        norm(p[2], 1),
        norm(p[4], 2),
        values.length,
        norm(p[1], 0),
        norm(p[3], 1),
        norm(p[5], 2),
        block.level,
        ...block.dims,
        0,
      );
      for (let i = 0; i < block.values.length; i++)
        values.push(Number.isFinite(block.values[i]) ? (block.values[i] - low) / span : NaN);
    }
    this.#textures = [
      this.#upload(new Float32Array(nodes)),
      this.#upload(new Float32Array(blocks)),
      this.#upload(new Float32Array(values)),
    ];
    this.#uniform = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ...[1, 2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#transfer = undefined;
  }
  /** @internal */ center(): readonly [number, number, number] {
    return this.source.center();
  }
  /** @internal */ prepare(): void {
    if (this.#disposed || !this.source.valid) return;
    if (
      !(this.source.quality > 0) ||
      !(this.source.density > 0) ||
      !Number.isFinite(this.source.quality + this.source.density)
    )
      amrError('quality and density must be finite and positive');
    if (this.source.classificationUniforms()[0] !== 0)
      amrError('AMR uses scalar transfer functions; remove the gradient or preintegrated classifier');
    const v = this.#values,
      b = this.bounds,
      spans = [b[1] - b[0], b[3] - b[2], b[5] - b[4]],
      max = Math.max(...spans),
      r = this.source.resources(),
      d = this.#figure.renderer.device!;
    v.set(this.source.model);
    invertMatrix(this.source.model, v.subarray(16, 32));
    v.set([0, this.source.quality, this.source.density, this.source.mode === 'mip' ? 1 : 0], 32);
    v.set([0, 0, this.#reference / max, this.#linear ? 1 : 0], 36);
    v.set([...spans.map((n) => n / max), this.source.shading ? 1 : 0], 40);
    v.set([this.data.nodes.length, this.source.clip.length, 0, 0], 44);
    v.fill(0, 48);
    this.source.clip.forEach((p, k) => v.set([...p.normal, p.offset], 48 + 4 * k));
    d.queue.writeBuffer(this.#uniform, 0, v);
    if (this.#transfer !== r.transfer) {
      this.#group = d.createBindGroup({
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          ...this.#textures.map((t, i) => ({ binding: i + 1, resource: t.createView() })),
          { binding: 4, resource: r.transfer.createView() },
          { binding: 5, resource: r.sampler },
        ],
      });
      this.#transfer = r.transfer;
    }
  }
  /** @internal */ draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed || !this.#group || !this.source.valid) return;
    const pipeline = renderer.pipeline('amr volume', context, (target) => {
      const module = renderer.device!.createShaderModule({
        code: frameWGSL + volumeDepthWGSL + amrShader,
        label: 'sciviz AMR k-d volume',
      });
      return {
        layout: renderer.device!.createPipelineLayout({
          bindGroupLayouts: [renderer.frameLayout!, this.#layout, renderer.depthLayout!],
        }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: target.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: false, depthCompare: 'always' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group);
    pass.setBindGroup(2, renderer.depthGroup!);
    pass.draw(3);
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
  /** Release all owned GPU resources and the hidden classifier layer. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#figure.renderer.remove(this);
    this.#release();
    this.#figure.remove(this.source);
  }
  /** Same as dispose(), for using. */ [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Attach a direct block volume. Source scalar values and hierarchy are snapshotted. */
export function amrVolume(figure: Figure, data: AMRData, options: AMRVolumeOptions = {}): AMRVolume {
  const layer = new AMRVolume(figure, data, options);
  figure.renderer.add(layer);
  return layer;
}

/** Independent physical edges of every block, carrying its level at both endpoints. */
export function amrOutlines(data: AMRData): { positions: Float32Array; levels: Uint32Array } {
  const positions: number[] = [],
    levels: number[] = [];
  for (const b of data.blocks)
    for (let c = 0; c < 8; c++)
      for (let axis = 0; axis < 3; axis++)
        if (!(c & (1 << axis))) {
          for (const corner of [c, c | (1 << axis)]) {
            positions.push(...[0, 1, 2].map((k) => b.bounds[2 * k + ((corner >> k) & 1)]));
            levels.push(b.level);
          }
        }
  return { positions: new Float32Array(positions), levels: new Uint32Array(levels) };
}
/** Draw each block as one connected edge walk, coloured by refinement level. Default width 1. */
export async function amrLevelOutlines(
  figure: Figure,
  data: AMRData,
  options: LineLayerOptions & { readonly signal?: AbortSignal } = {},
): Promise<readonly LineLayer[]> {
  const layers: LineLayer[] = [];
  try {
    for (const block of data.blocks) {
      options.signal?.throwIfAborted();
      const walk = [0, 1, 3, 2, 0, 4, 5, 1, 5, 7, 3, 7, 6, 2, 6, 4],
        axes = [0, 1, 2].map((k) => walk.map((c) => block.bounds[k * 2 + ((c >> k) & 1)]));
      layers.push(
        await figure.line(
          { x: axes[0], y: axes[1], z: axes[2], color: walk.map(() => block.level) },
          { width: 1, range: [0, Math.max(1, ...data.blocks.map((b) => b.level))], ...options },
        ),
      );
    }
    options.signal?.throwIfAborted();
    return layers;
  } catch (error) {
    for (const layer of layers) figure.remove(layer);
    throw error;
  }
}
/** Exact masked-cell planar slice across every level. Each visible cell keeps its own scalar value. */
export function sliceAMR(data: AMRData, plane: SlicePlane, options: AMROptions = {}): TriangleSet {
  if (
    plane.normal.length !== 3 ||
    [...plane.normal, plane.offset].some((v) => !Number.isFinite(v)) ||
    !plane.normal.some((v) => v !== 0)
  )
    amrError('a slice needs a finite non-zero normal and finite offset');
  const grid = visibleGrid(data, plane, options);
  return sliceGrid(grid, plane, { values: 'cell' });
}
function visibleGrid(data: AMRData, plane: SlicePlane, options: AMROptions): UnstructuredGrid {
  const points: number[] = [],
    connectivity: number[] = [],
    offsets: number[] = [],
    types: number[] = [],
    values: number[] = [];
  data.blocks.forEach((b, bi) => {
    for (let i = 0; i < b.values.length; i++) {
      if (i % 4096 === 0) options.signal?.throwIfAborted();
      if (!data.masks[bi][i]) continue;
      const cell = [i % b.dims[0], Math.floor(i / b.dims[0]) % b.dims[1], Math.floor(i / b.dims[0] / b.dims[1])],
        base = points.length / 3;
      const faces = cell.map((v, k) => [
        b.bounds[2 * k] + (v * (b.bounds[2 * k + 1] - b.bounds[2 * k])) / b.dims[k],
        b.bounds[2 * k] + ((v + 1) * (b.bounds[2 * k + 1] - b.bounds[2 * k])) / b.dims[k],
      ]);
      const low = faces.reduce((v, f, k) => v + Math.min(f[0] * plane.normal[k], f[1] * plane.normal[k]), 0),
        high = faces.reduce((v, f, k) => v + Math.max(f[0] * plane.normal[k], f[1] * plane.normal[k]), 0);
      if (plane.offset < low || plane.offset > high) continue;
      for (const c of [0, 1, 3, 2, 4, 5, 7, 6])
        points.push(
          ...cell.map(
            (v, k) => b.bounds[2 * k] + ((v + ((c >> k) & 1)) * (b.bounds[2 * k + 1] - b.bounds[2 * k])) / b.dims[k],
          ),
        );
      connectivity.push(...Array.from({ length: 8 }, (_, c) => base + c));
      offsets.push(connectivity.length);
      types.push(12);
      values.push(b.values[i]);
    }
  });
  return { points, connectivity, offsets, types, cellData: values };
}
/** Contours use a shared point lattice at finest spacing by default, so coarse/fine interfaces share vertices. */
export interface AMRContourOptions extends AMROptions {
  /** Sample point counts, each >=2. Default finest-level spacing plus one. */
  readonly dims?: readonly [number, number, number];
  /** Maximum sample points, default 2,000,000. */
  readonly maxPoints?: number;
}
/** Extract globally connected isosurfaces on an explicit bounded covering lattice; the volume renderer stays native. */
export async function contourAMR(
  data: AMRData,
  levels: readonly number[],
  options: AMRContourOptions = {},
): Promise<GridContours> {
  const b = data.bounds,
    spacing = [0, 1, 2].map((k) =>
      Math.min(...data.blocks.map((q) => (q.bounds[2 * k + 1] - q.bounds[2 * k]) / q.dims[k])),
    ),
    dims =
      options.dims ??
      ([0, 1, 2].map((k) => Math.round((b[2 * k + 1] - b[2 * k]) / spacing[k]) + 1) as [number, number, number]),
    max = options.maxPoints ?? 2_000_000;
  if (
    dims.some((n) => !Number.isSafeInteger(n) || n < 2) ||
    !Number.isSafeInteger(max) ||
    max < 8 ||
    dims.reduce((a, n) => a * n, 1) > max
  )
    amrError('contour sample lattice exceeds maxPoints; set a coarser dims');
  const axes = dims.map((n, k) =>
      Float64Array.from({ length: n }, (_, i) => b[2 * k] + (i / (n - 1)) * (b[2 * k + 1] - b[2 * k])),
    ),
    values = new Float64Array(dims.reduce((a, n) => a * n, 1));
  for (let i = 0; i < values.length; i++) {
    if (i % 4096 === 0) options.signal?.throwIfAborted();
    values[i] = sampleAMR(
      data,
      [axes[0][i % dims[0]], axes[1][Math.floor(i / dims[0]) % dims[1]], axes[2][Math.floor(i / dims[0] / dims[1])]],
      'linear',
    );
  }
  const grid = await createDataSet(
    { kind: 'rectilinear', axes: axes as [Float64Array, Float64Array, Float64Array], pointData: values },
    { signal: options.signal, maxPoints: max },
  );
  return contourGrid(grid, levels, options);
}
