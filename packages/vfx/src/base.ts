/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Vec3,
} from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { viewMatrix } from '../../shared/view.js';
import { preset } from '../../shared/preset.js';
import { simulationShader, billboardShader, multisampled } from './shader.js';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  INDIRECT: number;
  COPY_DST: number;
  COPY_SRC: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
const defaultPosition: Vec3 = [0, 1, 0],
  defaultVelocity: Vec3 = [0, 3, 0],
  defaultGravity: Vec3 = [0, -9.81, 0],
  defaultColor: readonly [number, number, number, number] = [1, 0.5, 0.1, 1],
  defaultLife: readonly [number, number] = [1, 3];
/**
 * Particle emitter settings. Everything except `capacity` and the four feature options (`obstacles`, `wrap`, `sort`,
 * `texture`) may change between frames; validation runs before GPU commands and throws RangeError when a value is out
 * of range.
 */
export interface VFXOptions {
  /** Particle slots, an integer 1-1,000,000 (64 bytes each). Fixed at construction. Default 1,000,000 (or the quality preset's). */
  capacity?: number;
  /** Births queued on attach and after device restoration, an integer 0..capacity. Default 0. */
  initialCount?: number;
  /** Births per second, >= 0. Default capacity / 2. */
  rate?: number;
  /** Emitter centre in world units. Default [0, 1, 0]. */
  position?: Vec3;
  /** Initial velocity in world units per second. Default [0, 3, 0]. */
  velocity?: Vec3;
  /** Random velocity added at birth, world units per second, >= 0. Default 1. */
  spread?: number;
  /** Acceleration in world units per second squared. Default [0, -9.81, 0]. */
  gravity?: Vec3;
  /** Linear RGBA at birth, each 0..1; alpha fades out over the life. Default [1, 0.5, 0.1, 1]. */
  color?: readonly [number, number, number, number];
  /** Billboard radius in world units, > 0. Default 0.1. */
  size?: number;
  /** Random life [min, max] in seconds, 0 < min <= max. Default [1, 3]. */
  lifetime?: readonly [number, number];
  /** Height (world y) of the collision plane. Default 0. */
  ground?: number;
  /** Fraction of speed kept when bouncing off the ground or an obstacle, 0..1. Default 0.3. */
  bounce?: number;
  /** Curl-noise acceleration strength, >= 0 (0 turns it off). Default 0.5. */
  turbulence?: number;
  /** Spatial frequency of the curl field, per world unit, >= 0. Default 1. */
  frequency?: number;
  /** Billboard spin in radians per second (each particle gets a random birth angle). Default 0. */
  angularVelocity?: number;
  /** Half extents of the box births are spread over, around `position`, each >= 0. Default [0, 0, 0] (a point). */
  emissionExtent?: Vec3;
  /** RGB multiplier for HDR emission, 0-16. Default 1. */
  intensity?: number;
  /** Up to 64 spheres/boxes that the flow bends around and particles bounce off. Contents are read each frame; pass an array (even `[]`) before attaching. */
  obstacles?: readonly VFXObstacle[];
  /** Keep particles inside the emission box, re-entering on the opposite face (every extent must be > 0). Read at attach. */
  wrap?: boolean;
  /** Draw back to front: bitonic sort of the live list each frame. Read at attach. */
  sort?: boolean;
  /** RGBA8 sRGB sprite multiplied by the particle colour, instead of the soft disc. Read at construction. */
  texture?: VFXTexture;
}
/**
 * A sphere or axis-aligned box (world units) the curl flow bends around within one unit and particles bounce off with
 * `bounce`. Up to 64 per effect; needs the `obstacles` feature.
 */
export type VFXObstacle =
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'box'; center: Vec3; halfSize: Vec3 };
/** A particle sprite: RGBA8 sRGB texels, row-major from the top-left. Copied at construction; needs the `texture` feature. */
export interface VFXTexture {
  /** Pixels, an integer 1-4096. */
  width: number;
  /** Pixels, an integer 1-4096. */
  height: number;
  /** `width * height * 4` bytes; RGB multiplies the particle colour, alpha its opacity. */
  data: Uint8Array | Uint8ClampedArray;
}
/** Features add each GPU object they create here at once, so a setup that fails part-way still releases it. */
type OwnedResources = { destroy(): void }[];
/**
 * The optional parts of a particle effect. Pass the exports of the feature entries, for example `{sort}` from
 * `@margoengine/vfx/sort`; the shapes are internal. Effects without a feature compile the same WGSL as before.
 */
export interface VFXFeatures {
  obstacles?: { patch(simulation: string): string; write(list: readonly VFXObstacle[], extra: Float32Array): void };
  wrap?: { patch(simulation: string): string };
  sort?: {
    create(
      device: GPUDevice,
      particles: GPUBuffer,
      alive: GPUBuffer,
      indirect: GPUBuffer,
      extra: GPUBuffer,
      size: number,
      owned: OwnedResources,
    ): { run(pass: GPUComputePassEncoder): void };
  };
  texture?: {
    copy(texture: VFXTexture): VFXTexture;
    patch(billboard: string): string;
    create(device: GPUDevice, texture: VFXTexture, owned: OwnedResources): GPUBindGroupEntry[];
  };
}
let nextId = 0;
/** GPU particles built from the features given: `new VFX(options, {sort})`. `VFX` from `@margoengine/vfx` has every feature. */
export class VFX implements EnginePlugin {
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly presentation: GPURenderPassDescriptor = {
    colorAttachments: [this.attachment],
    depthStencilAttachment: this.depthAttachment,
  };
  private renderFormat = '';
  private renderDepth = '';
  private renderKey = '';
  readonly name = 'vfx:' + nextId++;
  readonly capacity: number;
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private particles?: GPUBuffer;
  private alive?: GPUBuffer;
  private indirect?: GPUBuffer;
  private visible?: GPUBuffer;
  private respawn?: GPUBuffer;
  private simulation?: GPUComputePipeline;
  private computeGroup?: GPUBindGroup;
  private renderGroups = new Map<GPURenderPipeline, GPUBindGroup>();
  private renders = new Map<string, GPURenderPipeline>();
  private billboard = '';
  private extra?: GPUBuffer;
  private readonly extraValues = new Float32Array(524);
  private sprite?: VFXTexture;
  private spriteEntries: GPUBindGroupEntry[] = [];
  private sorter?: ReturnType<NonNullable<VFXFeatures['sort']>['create']>;
  private owned: OwnedResources = [];
  private readonly values = new Float32Array(56);
  private readonly ints = new Uint32Array(this.values.buffer);
  private readonly view = new Float32Array(16);
  private time = 0;
  private remainder = 0;
  private burstCount = 0;
  private disposed = false;
  constructor(
    readonly options: VFXOptions = {},
    private readonly features: VFXFeatures = {},
  ) {
    // A preset capacity below an explicit initialCount is ignored: the app asked for that many particles.
    const tier = preset('vfx', options);
    this.options = (tier.capacity ?? 0) < (options.initialCount ?? 0) ? options : tier;
    this.capacity = this.options.capacity ?? 1_000_000;
    this.validate();
    const t = options.texture;
    if (t) {
      if (!features.texture)
        throw new TypeError(
          'VFX texture needs textureFeature from @margoengine/vfx/texture: pass {texture: textureFeature}',
        );
      this.sprite = features.texture.copy(t);
    }
  }
  static attach(instance: EngineKernel, options: VFXOptions = {}, features: VFXFeatures = {}): VFX {
    const effect = new VFX(options, features);
    engineRuntime(instance).use(effect);
    return effect;
  }
  private validate(): void {
    const o = this.options;
    if (!Number.isInteger(o.initialCount ?? 0) || (o.initialCount ?? 0) < 0 || (o.initialCount ?? 0) > this.capacity)
      throw new RangeError('Invalid initial particle count');
    if (o.emissionExtent) {
      finiteVector(o.emissionExtent, 3, 'Emission extent');
      for (let i = 0; i < 3; i++)
        if (o.emissionExtent[i] < 0) throw new RangeError('Emission extent must be nonnegative');
    }
    if (!Number.isFinite(o.intensity ?? 1) || (o.intensity ?? 1) < 0 || (o.intensity ?? 1) > 16)
      throw new RangeError('Invalid particle intensity');
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 1_000_000 ||
      (o.capacity !== undefined && o.capacity !== this.capacity) ||
      !Number.isFinite(o.rate ?? this.capacity / 2) ||
      (o.rate ?? this.capacity / 2) < 0 ||
      !Number.isFinite(Math.fround(o.ground ?? 0)) ||
      !Number.isFinite(Math.fround(o.angularVelocity ?? 0)) ||
      !Number.isFinite(o.bounce ?? 0.3) ||
      (o.bounce ?? 0.3) < 0 ||
      (o.bounce ?? 0.3) > 1 ||
      !Number.isFinite(Math.fround(o.size ?? 0.1)) ||
      (o.size ?? 0.1) <= 0
    )
      throw new RangeError('Invalid VFX options');
    for (let i = 0; i < 3; i++) {
      const v = i === 0 ? (o.spread ?? 1) : i === 1 ? (o.turbulence ?? 0.5) : (o.frequency ?? 1);
      if (!Number.isFinite(Math.fround(v)) || v < 0) throw new RangeError('Invalid VFX options');
    }
    finiteVector(o.position ?? defaultPosition, 3, 'Emitter position');
    finiteVector(o.velocity ?? defaultVelocity, 3, 'Emitter velocity');
    finiteVector(o.gravity ?? defaultGravity, 3, 'Particle gravity');
    finiteVector(o.color ?? defaultColor, 4, 'Particle color');
    const color = o.color ?? defaultColor;
    for (let i = 0; i < 4; i++) if (color[i] < 0 || color[i] > 1) throw new RangeError('Invalid particle color');
    const life = o.lifetime ?? defaultLife;
    finiteVector(life, 2, 'Particle lifetime');
    if (life[0] <= 0 || life[1] < life[0]) throw new RangeError('Invalid particle lifetime');
    if (
      (o.sort !== undefined && typeof o.sort !== 'boolean') ||
      (o.wrap !== undefined && typeof o.wrap !== 'boolean') ||
      (o.wrap && !o.emissionExtent?.every((v) => v > 0))
    )
      throw new RangeError('Invalid VFX sort or wrap');
    for (const key of ['obstacles', 'wrap', 'sort'] as const)
      if (o[key] && !this.features[key]) throw new TypeError(`VFX ${key} needs ${key} from @margoengine/vfx/${key}`);
    if (o.obstacles) this.features.obstacles!.write(o.obstacles, this.extraValues);
  }
  burst(count: number): this {
    if (this.disposed || !Number.isInteger(count) || count < 0 || count > this.capacity)
      throw new RangeError('Invalid particle burst');
    this.burstCount = Math.min(this.capacity, this.burstCount + count);
    return this;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'VFX requires WebGPU and a live effect; attach a new VFX to a WebGPU engine',
      );
    this.engine = engine;
    this.device = engine.gpu;
    if (
      this.capacity * 64 > this.device.limits.maxStorageBufferBindingSize ||
      this.capacity * 64 > this.device.limits.maxBufferSize ||
      this.device.limits.maxComputeInvocationsPerWorkgroup < 256 ||
      this.device.limits.maxComputeWorkgroupSizeX < 256
    )
      throw new RangeError('VFX capacity exceeds device limits');
    const buffer = (size: number, usage: number) =>
        this.device!.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST }),
      o = this.options,
      f = this.features;
    this.uniform = buffer(224, GPUBufferUsage.UNIFORM);
    this.particles = buffer(this.capacity * 64, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const size = o.sort ? 2 ** Math.ceil(Math.log2(this.capacity)) : this.capacity;
    if (o.obstacles || o.sort) this.extra = buffer(2096, GPUBufferUsage.UNIFORM);
    // Optional features patch the default shaders, so effects without them compile byte-identical WGSL.
    let simulation = simulationShader;
    if (o.obstacles) simulation = f.obstacles!.patch(simulation);
    if (o.wrap) simulation = f.wrap!.patch(simulation);
    this.billboard = this.sprite ? f.texture!.patch(billboardShader) : billboardShader;
    this.alive = buffer(size * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.indirect = buffer(20, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
    this.respawn = buffer(8, GPUBufferUsage.STORAGE);
    // indirect counts live particles; visible holds the draw's [vertexCount, instanceCount, firstVertex, firstInstance] for the on-screen ones listed in alive.
    this.visible = buffer(20, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
    for (const b of [this.indirect, this.visible])
      this.device.queue.writeBuffer(b, 0, new Uint32Array([3, 0, 0, 0, 0]));
    this.simulation = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code: simulation }), entryPoint: 'main' },
    });
    this.computeGroup = this.device.createBindGroup({
      layout: this.simulation.getBindGroupLayout(0),
      entries: [this.uniform!, this.particles!, this.alive!, this.indirect!, this.respawn!]
        .map((buffer, binding) => ({ binding: binding < 2 ? binding : binding + 1, resource: { buffer } }))
        .concat(
          { binding: 2, resource: { buffer: this.visible } },
          o.obstacles ? [{ binding: 6, resource: { buffer: this.extra! } }] : [],
        ),
    });
    if (o.sort)
      this.sorter = f.sort!.create(
        this.device,
        this.particles,
        this.alive,
        this.visible,
        this.extra!,
        size,
        this.owned,
      );
    if (this.sprite) this.spriteEntries = f.texture!.create(this.device, this.sprite, this.owned);
    this.burst(this.options.initialCount ?? 0);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':simulate',
      order: -8,
      execute: (c) => {
        if (c.backend === 'webgpu') this.simulate(c);
      },
    });
    graph.add({
      name: this.name + ':draw',
      order: 6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private simulate(c: Context): void {
    this.validate();
    const o = this.options;
    this.time += c.delta;
    const emissions = (o.rate ?? this.capacity / 2) * c.delta + this.remainder;
    this.remainder = emissions % 1;
    const budget = Math.min(this.capacity, Math.floor(emissions) + this.burstCount);
    this.burstCount = 0;
    this.values.set(c.camera.matrix);
    viewMatrix(this.view, c.camera);
    for (let i = 0; i < 3; i++) {
      this.values[16 + i] = this.view[i * 4];
      this.values[20 + i] = this.view[i * 4 + 1];
      this.values[48 + i] = o.emissionExtent?.[i] ?? 0;
    }
    this.values.set(o.gravity ?? defaultGravity, 24);
    this.values[27] = c.delta;
    this.values.set(o.position ?? defaultPosition, 28);
    this.values[31] = this.time;
    this.values.set(o.velocity ?? defaultVelocity, 32);
    this.values[35] = o.spread ?? 1;
    this.values.set(o.color ?? defaultColor, 36);
    const life = o.lifetime ?? defaultLife;
    this.values[40] = o.size ?? 0.1;
    this.values[41] = life[0];
    this.values[42] = life[1];
    this.values[43] = o.ground ?? 0;
    this.values[44] = o.turbulence ?? 0.5;
    this.values[45] = o.frequency ?? 1;
    this.values[46] = o.bounce ?? 0.3;
    this.values[47] = o.angularVelocity ?? 0;
    this.values[51] = o.intensity ?? 1;
    this.ints[52] = this.capacity;
    this.ints[53] = budget;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    if (this.extra) {
      const e = this.extraValues;
      e.set(c.camera.position);
      for (let i = 0; i < 3; i++) e[4 + i] = -this.view[i * 4 + 2];
      c.device.queue.writeBuffer(this.extra, 0, e as Float32Array<ArrayBuffer>);
    }
    c.encoder.clearBuffer(this.indirect!, 4, 4);
    c.encoder.clearBuffer(this.visible!, 4, 4);
    c.encoder.clearBuffer(this.respawn!, 0, 4);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.simulation!);
    pass.setBindGroup(0, this.computeGroup!);
    pass.dispatchWorkgroups(Math.ceil(this.capacity / 256));
    this.sorter?.run(pass);
    pass.end();
  }
  private draw(c: Context): void {
    if (this.renderFormat !== c.format || this.renderDepth !== c.descriptor.depthStencil!.format) {
      this.renderFormat = c.format;
      this.renderDepth = c.descriptor.depthStencil!.format;
      this.renderKey = this.renderFormat + ':' + this.renderDepth;
    }
    const key = this.renderKey + ':' + c.descriptor.multisample?.count;
    let pipeline = this.renders.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({
        code: (c.descriptor.multisample?.count ?? 1) > 1 ? multisampled(this.billboard) : this.billboard,
      });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: false,
          depthCompare: 'greater-equal',
        },
      });
      this.renders.set(key, pipeline);
    }
    // Auto layouts are pipeline-specific, including output format variants.
    let group = this.renderGroups.get(pipeline);
    if (!group) {
      group = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...[this.uniform!, this.particles!, this.alive!].map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
          ...this.spriteEntries,
        ],
      });
      this.renderGroups.set(pipeline, group);
    }
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    this.depthAttachment.stencilReadOnly = c.descriptor.depthStencil!.format.includes('stencil') ? true : undefined;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.drawIndirect(this.visible!, 0);
    pass.end();
    this.engine!.stats.drawCalls++;
  }
  get gpuState(): { particles: GPUBuffer; indirect: GPUBuffer; alive: GPUBuffer; visible: GPUBuffer } {
    if (!this.indirect || !this.particles || !this.alive || !this.visible)
      throw new MargoError('state', 'VFX is not attached; attach it to an engine first');
    return { particles: this.particles, indirect: this.indirect, alive: this.alive, visible: this.visible };
  }
  private release(): void {
    for (const buffer of [
      this.uniform,
      this.particles,
      this.alive,
      this.indirect,
      this.visible,
      this.respawn,
      this.extra,
      ...this.owned,
    ])
      buffer?.destroy();
    this.owned = [];
    this.spriteEntries = [];
    this.extra = this.sorter = undefined;
    this.uniform = this.particles = this.alive = this.indirect = this.visible = this.respawn = undefined;
    this.computeGroup = undefined;
    this.renderGroups.clear();
    this.renders.clear();
    this.simulation = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
