// Optional sampling controls; public definitions and derivations in docs/clean-room.md.
import { invertMatrix } from '@margoengine/math/mat4';
import { f16Bits as half } from '../../shared/f16.js';
import { rangeError, fault } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import type { VolumeLayer } from './volume.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { volumeDepthWGSL } from './volume-depth.js';
import { qualityShader, blockShader } from './volume-quality-shader.js';
import { blueNoiseRanks } from './volume-blue-noise.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Sampling controls around an existing scalar volume, with shared classification and clips. */
export interface VolumeQualityOptions {
  /** Conservative min/max blocks skip only ranges with zero classified opacity. Default true. */
  readonly emptySpaceSkipping?: boolean;
  /** Cells per block axis, integer 2..32, default 8. */
  readonly blockSize?: number;
  /** Periodic 32x32 void-and-cluster jitter. Default true; false uses segment midpoints. */
  readonly jitter?: boolean;
  /** Adaptive integration; false disables. Default { tolerance:0.01,maxStep:4 }. */
  readonly adaptive?:
    | false
    | {
        /** Normalised scalar variation budget per block, (0,1], default 0.01. */
        readonly tolerance?: number;
        /** Largest multiple of the base step, [1,16], default 4. */
        readonly maxStep?: number;
      };
  /** First scalar isosurface in physical units. Default absent: volume compositing or MIP. */
  readonly isovalue?: number;
  /** Bisection iterations, integer 4..24, default 12. */
  readonly refinement?: number;
  /** Linear isosurface RGB in [0,1]. Default uses the classifier at the hit. */
  readonly color?: readonly [number, number, number];
}
function checked(options: VolumeQualityOptions, volume: VolumeLayer): VolumeQualityOptions {
  const o = structuredClone(options),
    a = o.adaptive;
  if (
    !Number.isInteger(o.blockSize ?? 8) ||
    (o.blockSize ?? 8) < 2 ||
    (o.blockSize ?? 8) > 32 ||
    !Number.isInteger(o.refinement ?? 12) ||
    (o.refinement ?? 12) < 4 ||
    (o.refinement ?? 12) > 24 ||
    (a &&
      (!Number.isFinite(a.tolerance ?? 0.01) ||
        (a.tolerance ?? 0.01) <= 0 ||
        (a.tolerance ?? 0.01) > 1 ||
        !Number.isFinite(a.maxStep ?? 4) ||
        (a.maxStep ?? 4) < 1 ||
        (a.maxStep ?? 4) > 16))
  )
    throw rangeError(
      'Volume quality needs blockSize 2..32, refinement 4..24, tolerance (0,1], maxStep [1,16]',
      'sciviz',
    );
  if (
    o.isovalue !== undefined &&
    (!Number.isFinite(o.isovalue) || o.isovalue < volume.range[0] || o.isovalue > volume.range[1])
  )
    throw rangeError('Isovalue must be finite and inside the volume classifier range', 'sciviz');
  if (o.color && (o.color.length !== 3 || !o.color.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)))
    throw rangeError('Isosurface colour needs three linear RGB channels in [0,1]', 'sciviz');
  return o;
}

/** GPU block acceleration, spatial blue noise, adaptive steps and refined first-hit scalar surfaces. */
export class QualityVolume implements Drawable {
  /** False hides the wrapper. */
  visible = true;
  /** Integrates after opaque scientific geometry, with a current depth snapshot. */
  readonly transparent = true;
  /** @internal */
  readonly needsSceneDepth = true;
  /** Data bounds of the source. */
  get bounds(): VolumeLayer['bounds'] {
    return this.#volume.bounds;
  }
  readonly #renderer: SciRenderer;
  readonly #volume: VolumeLayer;
  readonly #wasVisible: boolean;
  #options: VolumeQualityOptions;
  #disposed = false;
  #uniform!: GPUBuffer;
  #blockUniform!: GPUBuffer;
  #layout!: GPUBindGroupLayout;
  #blockPipeline!: GPURenderPipeline;
  #blocks: GPUTexture | undefined;
  #opacity!: GPUTexture;
  #noise!: GPUTexture;
  #source: GPUTexture | undefined;
  #transfer: GPUTexture | undefined;
  #group: GPUBindGroup | undefined;
  #blockSide = 0;
  #width = 0;
  #height = 0;
  readonly #values = new Float32Array(96);

  /** @internal Attach with qualityVolume(). */
  constructor(renderer: SciRenderer, volume: VolumeLayer, options: VolumeQualityOptions = {}) {
    requireGPU(renderer);
    this.#options = checked(options, volume);
    this.#renderer = renderer;
    this.#volume = volume;
    this.#wasVisible = volume.visible;
    this.#build();
    volume.visible = false;
  }
  /** Atomically replace sampling controls. Defaults apply to omitted settings. */
  configure(options: VolumeQualityOptions): void {
    if (this.#disposed) throw fault('state', 'Quality volume is disposed', 'sciviz');
    this.#options = checked(options, this.#volume);
  }
  /** Invalidate block bounds after updating an externally owned GPU texture in place. */
  invalidate(): void {
    this.#source = undefined;
    this.#transfer = undefined;
  }
  /** @internal */
  center(): readonly [number, number, number] {
    return this.#volume.center();
  }
  #build(): void {
    const d = this.#renderer.device!,
      usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.#uniform = d.createBuffer({ size: this.#values.byteLength, usage });
    this.#blockUniform = d.createBuffer({ size: 48, usage });
    this.#layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const module = d.createShaderModule({ code: blockShader, label: 'sciviz conservative block bounds' });
    this.#blockPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] },
    });
    const textureUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    this.#opacity = d.createTexture({ size: [256, 256], format: 'r8unorm', usage: textureUsage });
    this.#noise = d.createTexture({ size: [32, 32], format: 'r16float', usage: textureUsage });
    // These binary16 values are exact: a 10-bit rank plus half an interval fits the mantissa.
    const noise = new Uint16Array(1024);
    for (let i = 0; i < 1024; i++) {
      const value = (blueNoiseRanks[i] + 0.5) / 1024;
      // Conversion uses a shared bit-exact implementation, not browser float16 support.
      noise[i] = half(value);
    }
    d.queue.writeTexture({ texture: this.#noise }, noise, { bytesPerRow: 64 }, [32, 32]);
    this.invalidate();
  }
  #opacityBounds(): void {
    const {
      size: [width, height],
      rgba,
    } = this.#volume.classificationData();
    const occupied = new Uint8Array(256),
      bounds = new Uint8Array(256 * 256);
    for (let x = 0; x < width; x++) {
      let alpha = 0;
      for (let y = 0; y < height; y++) alpha = Math.max(alpha, rgba[(y * width + x) * 4 + 3]);
      if (alpha) {
        const lo = Math.floor(((x - 1) / (width - 1)) * 255) - 1,
          hi = Math.ceil(((x + 1) / (width - 1)) * 255) + 1;
        occupied.fill(255, Math.max(0, lo), Math.min(256, hi + 1));
      }
    }
    for (let lo = 0; lo < 256; lo++) {
      let any = 0;
      for (let hi = lo; hi < 256; hi++) {
        any = Math.max(any, occupied[hi]);
        bounds[hi * 256 + lo] = any;
      }
    }
    this.#renderer.device!.queue.writeTexture({ texture: this.#opacity }, bounds, { bytesPerRow: 256 }, [256, 256]);
  }
  /** @internal */
  prepare(context: GpuContext): void {
    if (this.#disposed || !this.#volume.valid) return;
    const d = this.#renderer.device!,
      volume = this.#volume,
      o = this.#options,
      resources = volume.resources(),
      side = o.blockSize ?? 8;
    if (
      !(Number.isFinite(volume.quality) && volume.quality > 0 && Number.isFinite(volume.density) && volume.density > 0)
    )
      throw rangeError('Volume density and quality must be finite and positive', 'sciviz');
    if (this.#source !== resources.data || this.#blockSide !== side) {
      const grid = volume.dims.map((n) => Math.ceil((n - 1) / side)),
        count = grid.reduce((a, b) => a * b);
      const width = Math.ceil(Math.sqrt(count)),
        height = Math.ceil(count / width);
      if (Math.max(width, height) > d.limits.maxTextureDimension2D)
        throw rangeError('Increase blockSize to fit this GPU block texture limit', 'sciviz');
      if (this.#width !== width || this.#height !== height || !this.#blocks) {
        this.#blocks?.destroy();
        this.#blocks = d.createTexture({
          size: [width, height],
          format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.#width = width;
        this.#height = height;
      }
      d.queue.writeBuffer(
        this.#blockUniform,
        0,
        new Uint32Array([...volume.dims, 0, ...grid, 0, width, height, side, 0]),
      );
      const group = d.createBindGroup({
        layout: this.#blockPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#blockUniform } },
          { binding: 1, resource: resources.data.createView() },
        ],
      });
      const pass = context.encoder.beginRenderPass({
        colorAttachments: [{ view: this.#blocks.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(this.#blockPipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      this.#source = resources.data;
      this.#blockSide = side;
      this.#group = undefined;
    }
    if (this.#transfer !== resources.transfer) {
      this.#opacityBounds();
      this.#transfer = resources.transfer;
      this.#group = undefined;
    }
    if (!this.#group)
      this.#group = d.createBindGroup({
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          { binding: 1, resource: resources.data.createView() },
          { binding: 2, resource: resources.transfer.createView() },
          { binding: 3, resource: resources.sampler },
          { binding: 4, resource: this.#blocks!.createView() },
          { binding: 5, resource: this.#opacity.createView() },
          { binding: 6, resource: this.#noise.createView() },
        ],
      });
    const v = this.#values;
    v.set(volume.model);
    invertMatrix(volume.model, v.subarray(16, 32));
    v.fill(0, 32, 48);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) v[32 + c * 4 + r] = v[16 + r * 4 + c];
    v[47] = 1;
    v.set([...volume.dims, volume.clip.length], 48);
    const voxel = Math.min(...volume.dims.map((n, a) => Math.hypot(...volume.model.slice(a * 4, a * 4 + 3)) / (n - 1)));
    if (!(voxel > 0) || !Number.isFinite(voxel))
      throw rangeError('Quality volume needs an invertible transform', 'sciviz');
    v.set([volume.quality, volume.density, volume.shading ? 1 : 0, voxel], 52);
    v.set(volume.classificationUniforms(), 56);
    v.fill(0, 64, 80);
    volume.clip.forEach((p, k) => v.set([...p.normal, p.offset], 64 + k * 4));
    v.set(
      [
        o.emptySpaceSkipping === false ? 0 : 1,
        o.refinement ?? 12,
        o.isovalue === undefined ? -1 : (o.isovalue - volume.range[0]) / (volume.range[1] - volume.range[0]),
        o.jitter === false ? 0 : 1,
      ],
      80,
    );
    const adaptive = o.adaptive === false ? false : (o.adaptive ?? {});
    v.set([adaptive ? (adaptive.maxStep ?? 4) : 1, adaptive ? (adaptive.tolerance ?? 0.01) : 0, side, 0], 84);
    v.set([...(o.color ?? [0, 0, 0]), o.color ? 1 : 0], 88);
    v.set([this.#width, volume.mode === 'mip' ? 1 : 0, 0, 0], 92);
    d.queue.writeBuffer(this.#uniform, 0, v);
  }
  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed || !this.#volume.valid || !this.#group) return;
    const iso = this.#options.isovalue !== undefined;
    const pipeline = renderer.pipeline('volume quality|' + iso, context, (target) => {
      const module = renderer.device!.createShaderModule({
        code: frameWGSL + volumeDepthWGSL + qualityShader,
        label: 'sciviz volume quality',
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
        depthStencil: { format: target.depth, depthWriteEnabled: iso, depthCompare: iso ? 'greater-equal' : 'always' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group);
    pass.setBindGroup(2, renderer.depthGroup!);
    pass.draw(3);
  }
  #release(): void {
    this.#uniform.destroy();
    this.#blockUniform.destroy();
    this.#blocks?.destroy();
    this.#blocks = undefined;
    this.#opacity.destroy();
    this.#noise.destroy();
    this.#group = undefined;
  }
  /** @internal */
  restore(): void {
    if (!this.#disposed) {
      this.#release();
      this.#build();
    }
  }
  /** Release the acceleration resources and restore the source's previous visibility. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    this.#release();
    this.#volume.visible = this.#wasVisible;
  }
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Enhance a scalar volume with sampling quality while retaining its data, clips, slices and classifier. */
export function qualityVolume(figure: Figure, volume: VolumeLayer, options: VolumeQualityOptions = {}): QualityVolume {
  const layer = new QualityVolume(figure.renderer, volume, options);
  figure.renderer.add(layer);
  return layer;
}
