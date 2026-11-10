import { trackSpecLayer } from './spec-hooks.js';
// Optional volume lighting. References and derivations: docs/clean-room.md, batch 173 job 3.
import { invertMatrix } from '@margoengine/math/mat4';
import { rangeError, fault } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import type { VolumeLayer } from './volume.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { cinematicShader, cinematicDisplay } from './cinematic-shader.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUShaderStage: { FRAGMENT: number; VERTEX: number };

/** All expensive lighting is disabled unless explicitly enabled. Colours are linear radiance. */
export interface CinematicOptions {
  /** Local spherical transmittance integral. Default false; radius in smallest scene voxels (default 8). */
  readonly ambientOcclusion?:
    | false
    | { readonly radius?: number; readonly directions?: number; readonly steps?: number };
  /** Directional Beer-Lambert shadows. Default false, default 32 integration steps. */
  readonly shadows?: false | { readonly steps?: number };
  /** Progressive multiple scattering. Default false. */
  readonly pathTracing?:
    | false
    | {
        /** HG mean cosine, (-1,1), default 0. Positive means forward scattering. */
        readonly anisotropy?: number;
        /** Maximum scattering events per path, 1..32, default 8. */
        readonly bounces?: number;
        /** Scattering albedo multiplying the classifier RGB, [0,1], default 0.9. */
        readonly albedo?: number;
        /** Accumulation limit, 1..16777216, default 4096. */
        readonly samples?: number;
        /** Reproducible unsigned seed, default 1. */
        readonly seed?: number;
      };
  /** Scene-space unit direction toward the distant light. Default [0.4,0.6,1]. */
  readonly lightDirection?: readonly [number, number, number];
  /** Ambient environment radiance, default [0.3,0.3,0.3]. */
  readonly ambient?: readonly [number, number, number];
  /** Distant light radiance, default [0.7,0.7,0.7]. */
  readonly light?: readonly [number, number, number];
}
/** Exact shader work in the most recent transport pass, excluding the display pass. */
export interface CinematicCost {
  /** Number of scalar 3D texture samples, including gradient classification. */
  readonly scalarSamples: number;
  /** Number of directional transmittance rays. */
  readonly shadowRays: number;
  /** Number of local ambient transmittance rays. */
  readonly ambientRays: number;
  /** Number of real scattering events. */
  readonly collisions: number;
  /** Number of dispatched viewport pixels. */
  readonly pixels: number;
}
function checked(options: CinematicOptions): CinematicOptions {
  const o = structuredClone(options),
    ao = o.ambientOcclusion,
    pt = o.pathTracing;
  const integer = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  const rgb = (c: readonly number[]) => c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0);
  if (
    ao &&
    (!(ao.radius ?? 8) ||
      !Number.isFinite(ao.radius ?? 8) ||
      (ao.radius ?? 8) < 0 ||
      !integer(ao.directions ?? 8, 1, 64) ||
      !integer(ao.steps ?? 8, 1, 256))
  )
    throw rangeError('Ambient occlusion needs positive radius, 1..64 directions and 1..256 steps', 'sciviz');
  if (o.shadows && !integer(o.shadows.steps ?? 32, 1, 2048))
    throw rangeError('Volume shadows need 1..2048 steps', 'sciviz');
  if (
    pt &&
    (!(Math.abs(pt.anisotropy ?? 0) < 1) ||
      !integer(pt.bounces ?? 8, 1, 32) ||
      !Number.isFinite(pt.albedo ?? 0.9) ||
      (pt.albedo ?? 0.9) < 0 ||
      (pt.albedo ?? 0.9) > 1 ||
      !integer(pt.samples ?? 4096, 1, 16777216) ||
      !integer(pt.seed ?? 1, 0, 0xffffffff))
  )
    throw rangeError(
      'Path tracing needs HG g in (-1,1), 1..32 bounces, albedo [0,1], integer samples/uint32 seed',
      'sciviz',
    );
  const d = o.lightDirection ?? [0.4, 0.6, 1];
  if (
    d.length !== 3 ||
    !d.every(Number.isFinite) ||
    Math.hypot(...d) === 0 ||
    !rgb(o.ambient ?? [0.3, 0.3, 0.3]) ||
    !rgb(o.light ?? [0.7, 0.7, 0.7])
  )
    throw rangeError('Lighting needs a finite nonzero direction and nonnegative finite RGB radiance', 'sciviz');
  return o;
}

/** Lighting around an existing volume; shares its data, classifier, clips and transform. */
export class CinematicVolume implements Drawable {
  /** False hides this layer. */
  visible = true;
  /** Volume colour blends over opaque layers. */
  readonly transparent = true;
  /** @internal */
  readonly needsSceneDepth = true;
  /** Data bounds inherited from the source. */
  get bounds(): VolumeLayer['bounds'] {
    return this.#volume.bounds;
  }
  /** Camera-stable submitted frames, capped at the sample target; scene depth resets per-pixel histories. */
  get samples(): number {
    return this.#samples;
  }
  readonly #renderer: SciRenderer;
  readonly #volume: VolumeLayer;
  readonly #wasVisible: boolean;
  #options: CinematicOptions;
  #samples = 0;
  #frame = 0;
  #lastPath = false;
  #history: GPUTexture[] = [];
  #signature = '';
  #source: GPUTexture | undefined;
  #transfer: GPUTexture | undefined;
  #uniform!: GPUBuffer;
  #layout!: GPUBindGroupLayout;
  #displayLayout!: GPUBindGroupLayout;
  #pipeline!: GPURenderPipeline;
  #images: GPUTexture[] = [];
  #cost: GPUTexture | undefined;
  #width = 0;
  #height = 0;
  #index = 0;
  #displayGroup: GPUBindGroup | undefined;
  #disposed = false;
  readonly #values = new Float32Array(104);

  /** @internal Attach with cinematicVolume(). */
  constructor(renderer: SciRenderer, volume: VolumeLayer, options: CinematicOptions = {}) {
    requireGPU(renderer);
    this.#options = checked(options);
    this.#renderer = renderer;
    this.#volume = volume;
    this.#wasVisible = volume.visible;
    this.#build();
    volume.visible = false;
  }
  /** Replace lighting atomically and discard accumulation. Defaults apply to omitted settings. */
  configure(options: CinematicOptions): void {
    if (this.#disposed) throw fault('state', 'Cinematic volume is disposed', 'sciviz');
    this.#options = checked(options);
    this.reset();
  }
  /** Discard accumulation, for example after updating externally owned GPU data. */
  reset(): void {
    this.#samples = 0;
    this.#frame = 0;
    this.#signature = '';
  }
  /** @internal */
  center(): readonly [number, number, number] {
    return this.#volume.center();
  }
  #build(): void {
    const d = this.#renderer.device!;
    this.#uniform = d.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.#displayLayout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
    });
    const module = d.createShaderModule({ code: cinematicShader, label: 'sciviz cinematic transport' });
    this.#pipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
      vertex: { module, entryPoint: 'vertex' },
      fragment: {
        module,
        entryPoint: 'fragment',
        targets: [{ format: 'rgba32float' }, { format: 'rg32uint' }, { format: 'rg32float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.reset();
  }
  #releaseImages(): void {
    for (const t of this.#images) t.destroy();
    this.#images = [];
    for (const t of this.#history) t.destroy();
    this.#history = [];
    this.#cost?.destroy();
    this.#cost = undefined;
    this.#width = 0;
    this.#height = 0;
    this.#displayGroup = undefined;
  }
  /** @internal Rebuild device resources; source restoration is owned by VolumeLayer. */
  restore(): void {
    if (this.#disposed) return;
    this.#uniform.destroy();
    this.#releaseImages();
    this.#build();
  }
  /** @internal Integrate one sample before the figure's pass. */
  prepare(context: GpuContext): void {
    if (this.#disposed || !this.#volume.valid) return;
    if (this.#volume.mode !== 'composite')
      throw fault('state', 'Cinematic lighting requires composite volume mode', 'sciviz');
    const d = this.#renderer.device!,
      v = this.#values,
      volume = this.#volume,
      o = this.#options;
    if (
      !(Number.isFinite(volume.density) && volume.density > 0 && Number.isFinite(volume.quality) && volume.quality > 0)
    )
      throw rangeError('Cinematic density and quality must be finite and positive', 'sciviz');
    if (context.width !== this.#width || context.height !== this.#height) {
      this.#releaseImages();
      this.#width = context.width;
      this.#height = context.height;
      const desc = {
        size: [context.width, context.height],
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      };
      this.#images = [0, 1].map(() => d.createTexture({ ...desc, format: 'rgba32float' }));
      this.#cost = d.createTexture({ ...desc, format: 'rg32uint' });
      this.#history = [0, 1].map(() => d.createTexture({ ...desc, format: 'rg32float' }));
      this.reset();
    }
    const resources = volume.resources();
    if (this.#source !== resources.data || this.#transfer !== resources.transfer) {
      this.#source = resources.data;
      this.#transfer = resources.transfer;
      this.reset();
    }
    invertMatrix(context.camera.matrix, v.subarray(0, 16));
    invertMatrix(volume.model, v.subarray(16, 32));
    v.set(volume.model, 32);
    v.set([...volume.dims, volume.clip.length], 48);
    v.set(volume.classificationUniforms(), 52);
    const voxel = Math.min(...volume.dims.map((n, a) => Math.hypot(...volume.model.slice(a * 4, a * 4 + 3)) / (n - 1)));
    if (!(voxel > 0) || !Number.isFinite(voxel))
      throw rangeError('Cinematic volume transform must be invertible', 'sciviz');
    v.set([volume.quality, volume.density, voxel, o.pathTracing ? (o.pathTracing.samples ?? 4096) : 1], 60);
    const ao = o.ambientOcclusion,
      pt = o.pathTracing;
    v.set(ao ? [ao.directions ?? 8, ao.radius ?? 8, ao.steps ?? 8, 0] : [0, 0, 0, 0], 64);
    v.set([...(o.lightDirection ?? [0.4, 0.6, 1]), o.shadows ? (o.shadows.steps ?? 32) : 0], 68);
    v.set([0, pt ? (pt.anisotropy ?? 0) : 0, pt ? (pt.bounces ?? 8) : 0, pt ? (pt.albedo ?? 0.9) : 0], 72);
    v.set([...(o.ambient ?? [0.3, 0.3, 0.3]), 0], 76);
    v.set([...(o.light ?? [0.7, 0.7, 0.7]), 0], 80);
    v.set([context.width, context.height, pt ? (pt.seed ?? 1) : 0, pt ? 1 : 0], 84);
    v.fill(0, 88);
    volume.clip.forEach((p, k) => v.set([...p.normal, p.offset], 88 + k * 4));
    new Uint32Array(v.buffer)[86] = pt ? (pt.seed ?? 1) : 0;
    const signature = Array.from(new Uint32Array(v.buffer)).join(',');
    if (signature !== this.#signature) {
      this.#samples = 0;
      this.#frame = 0;
      this.#signature = signature;
    }
    v[72] = pt ? this.#frame : 0;
    this.#lastPath = !!pt;
    d.queue.writeBuffer(this.#uniform, 0, v);
    const index = 1 - this.#index;
    const group = d.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: resources.data.createView() },
        { binding: 2, resource: resources.transfer.createView() },
        { binding: 3, resource: resources.sampler },
        { binding: 4, resource: this.#images[this.#index].createView() },
        { binding: 5, resource: this.#renderer.depthView! },
        { binding: 6, resource: this.#history[this.#index].createView() },
      ],
    });
    const pass = context.encoder.beginRenderPass({
      colorAttachments: [
        { view: this.#images[index].createView(), loadOp: 'clear', storeOp: 'store' },
        { view: this.#cost!.createView(), loadOp: 'clear', storeOp: 'store' },
        { view: this.#history[index].createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    this.#index = index;
    this.#samples = pt ? Math.min(this.#samples + 1, pt.samples ?? 4096) : 1;
    this.#frame = (this.#frame + 1) % 16777216;
    this.#displayGroup = d.createBindGroup({
      layout: this.#displayLayout,
      entries: [{ binding: 0, resource: this.#images[index].createView() }],
    });
  }
  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed || !this.#volume.valid || !this.#displayGroup) return;
    const pipeline = renderer.pipeline('cinematic display', context, (target) => {
      const module = renderer.device!.createShaderModule({ code: frameWGSL + cinematicDisplay });
      return {
        layout: renderer.device!.createPipelineLayout({
          bindGroupLayouts: [renderer.frameLayout!, this.#displayLayout],
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
    pass.setBindGroup(1, this.#displayGroup);
    pass.draw(3);
  }
  /** Read exact counters after rendering. Abort does not discard or alter the accumulated image. */
  async cost(options: { readonly signal?: AbortSignal } = {}): Promise<CinematicCost> {
    options.signal?.throwIfAborted();
    if (!this.#cost || this.#disposed)
      throw fault('state', 'Render the cinematic volume before reading cost', 'sciviz');
    const d = this.#renderer.device!,
      width = this.#width,
      height = this.#height,
      row = Math.ceil((width * 8) / 256) * 256,
      path = this.#lastPath;
    const buffer = d.createBuffer({ size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = d.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: this.#cost }, { buffer, bytesPerRow: row }, [width, height]);
      d.queue.submit([encoder.finish()]);
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        buffer.mapAsync(1).then(
          () => {
            signal.removeEventListener('abort', abort);
            resolve();
          },
          (error) => {
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        );
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      const values = new Uint32Array(buffer.getMappedRange()),
        sums = [0, 0, 0, 0];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * row) / 4 + x * 2,
            packed = values[i + 1];
          sums[0] += values[i];
          sums[1] += packed & (path ? 63 : 4095);
          if (path) sums[3] += packed >>> 6;
          else sums[2] += packed >>> 12;
        }
      return {
        scalarSamples: sums[0],
        shadowRays: sums[1],
        ambientRays: sums[2],
        collisions: sums[3],
        pixels: width * height,
      };
    } finally {
      buffer.destroy();
    }
  }
  /** Release lighting resources and restore the source's previous visibility. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    this.#releaseImages();
    this.#uniform.destroy();
    this.#volume.visible = this.#wasVisible;
  }
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Light an existing figure volume, sharing its transfer function and data texture. */
export function cinematicVolume(figure: Figure, volume: VolumeLayer, options: CinematicOptions = {}): CinematicVolume {
  const layer = new CinematicVolume(figure.renderer, volume, options);
  figure.renderer.add(layer);
  return trackSpecLayer(figure, 'cinematic', [volume, options], layer);
}
