import { invertMatrix } from '@margoengine/math/mat4';
import { rangeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import type { UnstructuredGrid } from './grids.js';
import type { VolumeLayer, VolumeLayerOptions } from './volume.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { volumeDepthWGSL } from './volume-depth.js';
import { buildTetMesh, type TetMeshData } from './tetvolume-mesh.js';
import { tetrahedralShader } from './tetvolume-shader.js';
export { tetrahedralAdjacency } from './tetvolume-mesh.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { FRAGMENT: number };

/** Classification and physical sampling of a tetrahedral scalar field. */
export interface TetrahedralVolumeOptions extends Omit<VolumeLayerOptions, 'dims' | 'bounds'> {
  /** Which scalar array to use. Default 'point' (linear barycentric); 'cell' is constant inside each cell. */
  readonly association?: 'point' | 'cell';
  /** Physical opacity distance. Default smallest tetrahedral edge. */
  readonly referenceStep?: number;
  /** Cancellation before CPU snapshot or publication. Default absent. */
  readonly signal?: AbortSignal;
}
/** Direct tetrahedral ray casting with explicit face adjacency and spatially indexed re-entry. */
export class TetrahedralVolume implements Drawable {
  /** False hides the volume. */ visible = true;
  /** @internal */ readonly transparent = true;
  /** @internal */ readonly needsSceneDepth = true;
  /** Hidden owned classifier source. Control density, quality, mode, shading, clips and transfer functions here. */
  readonly source: VolumeLayer;
  /** Physical mesh bounds. */ get bounds(): VolumeLayer['bounds'] {
    return this.source.bounds;
  }
  /** Number of direct tetrahedral cells. */ get cellCount(): number {
    return this.#mesh.count;
  }
  readonly #figure: Figure;
  readonly #mesh: TetMeshData;
  readonly #reference: number;
  #disposed = false;
  #uniform!: GPUBuffer;
  #layout!: GPUBindGroupLayout;
  #textures: GPUTexture[] = [];
  #group: GPUBindGroup | undefined;
  #data: GPUTexture | undefined;
  #transfer: GPUTexture | undefined;
  readonly #values = new Float32Array(68);
  /** @internal Attach with tetrahedralVolume(). */
  constructor(figure: Figure, grid: UnstructuredGrid, options: TetrahedralVolumeOptions = {}) {
    options.signal?.throwIfAborted();
    requireGPU(figure.renderer);
    this.#figure = figure;
    if (options.association !== undefined && !['point', 'cell'].includes(options.association))
      throw rangeError('Tetrahedral association must be point or cell', 'sciviz');
    this.#mesh = buildTetMesh(grid, options.association ?? 'point', options.range);
    const b = this.#mesh.bounds,
      maximumSpan = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
    this.#reference = (options.referenceStep ?? this.#mesh.reference) / maximumSpan;
    if (!(this.#reference > 0) || !Number.isFinite(this.#reference))
      throw rangeError('Tetrahedral referenceStep must be finite and positive', 'sciviz');
    const capacity = figure.renderer.device!.limits.maxTextureDimension2D ** 2;
    if (Math.max(this.#mesh.cells.length / 4, this.#mesh.nodes.length / 4) > capacity)
      throw rangeError('Tetrahedral cells exceed this GPU texture capacity; partition the mesh', 'sciviz');
    options.signal?.throwIfAborted();
    this.source = figure.volume(new Float32Array(8).fill(this.#mesh.range[0]), {
      ...options,
      dims: [2, 2, 2],
      bounds: this.#mesh.bounds,
      range: this.#mesh.range,
    });
    this.source.visible = false;
    this.#build();
  }
  #upload(values: Float32Array): GPUTexture {
    const d = this.#figure.renderer.device!,
      count = values.length / 4,
      w = Math.min(count, d.limits.maxTextureDimension2D),
      h = Math.ceil(count / w),
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
    const d = this.#figure.renderer.device!;
    this.#uniform = d.createBuffer({ size: 272, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.#textures = [this.#upload(this.#mesh.cells), this.#upload(this.#mesh.nodes)];
    this.#group = undefined;
    this.#data = undefined;
    this.#transfer = undefined;
  }
  /** @internal */ center(): readonly [number, number, number] {
    return this.source.center();
  }
  /** @internal */ prepare(): void {
    if (this.#disposed || !this.source.valid) return;
    const d = this.#figure.renderer.device!,
      r = this.source.resources(),
      v = this.#values,
      b = this.bounds;
    if (
      !Number.isFinite(this.source.quality) ||
      !(this.source.quality > 0) ||
      !Number.isFinite(this.source.density) ||
      !(this.source.density > 0)
    )
      throw rangeError('Tetrahedral quality and density must be finite and positive', 'sciviz');
    v.set(this.source.model);
    invertMatrix(this.source.model, v.subarray(16, 32));
    v.set(
      [
        this.#reference,
        this.source.quality * (this.#figure.renderer.samplingScale ?? 1),
        this.source.density,
        this.source.mode === 'mip' ? 1 : this.source.mode === 'minip' ? 2 : 0,
      ],
      32,
    );
    v.set(this.source.classificationUniforms().slice(0, 4), 36);
    v.set([b[0], b[2], b[4], this.#mesh.nodes.length / 8], 40);
    const maximumSpan = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
    v.set(
      [
        (b[1] - b[0]) / maximumSpan,
        (b[3] - b[2]) / maximumSpan,
        (b[5] - b[4]) / maximumSpan,
        this.source.shading ? 1 : 0,
      ],
      44,
    );
    v.set([this.#mesh.count, this.source.clip.length, 0, 0], 48);
    v.fill(0, 52);
    this.source.clip.forEach((p, k) => v.set([...p.normal, p.offset], 52 + k * 4));
    d.queue.writeBuffer(this.#uniform, 0, v);
    if (this.#data !== r.data || this.#transfer !== r.transfer) {
      this.#group = d.createBindGroup({
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          { binding: 1, resource: this.#textures[0].createView() },
          { binding: 2, resource: r.transfer.createView() },
          { binding: 3, resource: r.sampler },
          { binding: 4, resource: this.#textures[1].createView() },
        ],
      });
      this.#data = r.data;
      this.#transfer = r.transfer;
    }
  }
  /** @internal */ draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed || !this.source.valid || !this.#group) return;
    const pipeline = renderer.pipeline('tetrahedral volume', context, (target) => {
      const module = renderer.device!.createShaderModule({
        code: frameWGSL + volumeDepthWGSL + tetrahedralShader,
        label: 'sciviz tetrahedral ray casting',
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
  /** Release the owned source and direct-cell resources. Caller data is never modified or released. */
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
/** Attach a conforming VTK tetrahedral grid. Scalar arrays and geometry are snapshotted; no Cartesian resampling occurs. */
export function tetrahedralVolume(
  figure: Figure,
  grid: UnstructuredGrid,
  options: TetrahedralVolumeOptions = {},
): TetrahedralVolume {
  const layer = new TetrahedralVolume(figure, grid, options);
  figure.renderer.add(layer);
  return layer;
}
