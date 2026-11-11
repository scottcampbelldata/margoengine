/// <reference lib="esnext.disposable" preserve="true" />
// Screen-space liquid surface from particle positions: sphere sprites to eye depth (van der Laan, Green and Sainz,
// I3D 2009), the narrow-range depth filter with bias correction, dynamic range and a 5 x 5 clean-up pass (Truong and
// Yuksel, I3D 2018), additive thickness, normals from the smaller one-sided difference, and a composite with
// refraction, Beer-Lambert absorption, exact Fresnel reflection of the sky and the sun's highlight. Rendering only:
// positions come from any source (a solver of your own, a recorded cache, a compute array). Citations: docs/clean-room.md.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { PostStack } from '@margoengine/post/stack';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { fault, rangeError } from '../../shared/errors.js';
import { group } from '../../shared/gpu.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { compositeShader, filterShader, spriteShader } from './liquid-shaders.js';
import type { Whitewater } from './liquid-whitewater.js';
import type { NarrowBand } from './liquid-band.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

const ADD = { srcFactor: 'one', dstFactor: 'one', operation: 'add' } as const;

/** Most particles one ParticleLiquid draws. */
export const MAX_LIQUID_PARTICLES = 4_194_304;

/**
 * Where the particle centres live. `positions` is a Float32Array (uploaded at creation and on `update()`), a GPUBuffer
 * with STORAGE usage, or any object with such a `buffer` (a `@margoengine/compute` GpuArray, for instance). Particle i's
 * centre is the three floats at `offset + i * stride`.
 */
export interface ParticleSource {
  positions: Float32Array | GPUBuffer | { readonly buffer: GPUBuffer };
  /** Particles to draw, integer 0..4,194,304. Default positions.length / stride for a Float32Array; required otherwise. */
  count?: number;
  /** Floats from one centre to the next, integer 3..64. Default 3. */
  stride?: number;
  /** Floats before the first centre, integer >= 0. Default 0. */
  offset?: number;
  /**
   * Particle velocities in world units per second, needed by whitewater: a Float32Array (uploaded with the centres) or
   * a STORAGE GPUBuffer or GpuArray. Particle i's velocity is the three floats at `velocityOffset + i * stride`; pass the
   * positions' own array with an offset for an interleaved layout. Default none.
   */
  velocities?: Float32Array | GPUBuffer | { readonly buffer: GPUBuffer };
  /** Floats before the first velocity, integer >= 0. Default 0. */
  velocityOffset?: number;
}

/**
 * Spray, foam and air bubbles generated from the particles' velocities (Ihmsen et al. 2012); needs
 * `particles.velocities`. The pool advances one `timeStep` per `update()`, so call it once per simulation step. Ranges
 * are pairs [min, max] of the paper's clamping function, min < max.
 */
export interface WhitewaterOptions {
  /** False keeps the pool but stops stepping and drawing it. Default true. */
  enabled?: boolean;
  /** Diffuse particles kept at once, integer 1..4,194,304; the oldest are replaced first. Default 65,536. */
  maxParticles?: number;
  /** Seconds per `update()`, 0..1. Default 1 / 60. */
  timeStep?: number;
  /** Influence radius h of the fluid, 0.0001..1000. Default 4 * radius (two particle spacings at spacing 2r). */
  support?: number;
  /** Trapped-air range of the scaled velocity difference, m/s. Default [5, 20] (the paper's). */
  trappedAir?: readonly [number, number];
  /** Wave-crest range of the curvature. Default [2, 8] (the paper's). */
  waveCrest?: readonly [number, number];
  /** Kinetic-energy range, joules. Default [5, 50] (the paper's). */
  kineticEnergy?: readonly [number, number];
  /** Diffuse particles per second one particle makes at full trapped-air potential, 0..100000. Default 100. */
  trappedAirRate?: number;
  /** Diffuse particles per second one particle makes at full wave-crest potential, 0..100000. Default 100. */
  waveCrestRate?: number;
  /** Mass of one fluid particle in kg, > 0. Default 1000 * (2 * radius)^3 (a water cube one spacing wide). */
  particleMass?: number;
  /** Foam lifetime range in seconds, set from the emission potential; 0..1000. Default [2, 6]. */
  lifetime?: readonly [number, number];
  /** Buoyancy k_b of bubbles, 0..100. Default 2. */
  buoyancy?: number;
  /** Drag k_d of bubbles toward the fluid velocity, 0..1. Default 0.8. */
  drag?: number;
  /** Gravity in m/s^2, finite. Default [0, -9.81, 0]. */
  gravity?: readonly [number, number, number];
  /** Fewer fluid neighbours than this makes spray, integer 0..1000. Default 6 (the paper's). */
  sprayNeighbours?: number;
  /** More fluid neighbours than this makes a bubble, integer 0..1000. Default 20 (the paper's). */
  bubbleNeighbours?: number;
  /** A particle is at the surface when its weighted mean neighbour direction is this long, 0..1. Default 0.25. */
  surfaceThreshold?: number;
  /** Sprite radius in world units, 0..100 (at least one pixel is drawn). Default 0.25 * radius. */
  radius?: number;
  /** Linear albedo of the diffuse material, each 0..10. Default [1, 1, 1]. */
  color?: readonly [number, number, number];
  /** Opacity of one sprite at its centre, 0..1. Default 0.7. */
  opacity?: number;
  /** Integer seed of the random sampling, 0..2^32 - 1. Default 0. */
  seed?: number;
}

/** Options of {@link ParticleLiquid}; the object is kept and read every frame except `particles`. */
export interface ParticleLiquidOptions {
  /** The particle centres. Required. */
  particles: ParticleSource;
  /** Sphere radius of one particle in world units, 0.001..100. Default 0.05. */
  radius?: number;
  /** Refractive index of the liquid, 1..3. Default 1.333 (water). */
  ior?: number;
  /** Absorption per world unit per linear RGB channel, 0..100. Default [0.38, 0.1, 0.045], Water's own. */
  absorption?: readonly [number, number, number];
  /** Linear RGB tint of the transmitted light, each 0..10. Default [1, 1, 1]. */
  color?: readonly [number, number, number];
  /** World-space standard deviation of the depth filter, 0.0001..100. Default 0.7 * radius (Truong and Yuksel). */
  smoothing?: number;
  /** Largest filter kernel radius in pixels, integer 1..64. Default 32. */
  maxFilterRadius?: number;
  /** Range threshold delta of the narrow-range filter, world units, > 0. Default 10 * radius (Truong and Yuksel). */
  filterRange?: number;
  /** Clamp offset mu of the narrow-range filter, world units, 0..filterRange. Default radius. */
  filterClamp?: number;
  /** Multiplies the summed sphere chords into a path length, 0..1000. Default 1. */
  thicknessScale?: number;
  /** Resolution of the thickness pass relative to the frame: 1 or 0.5. Default 1. */
  resolutionScale?: 1 | 0.5;
  /** Blinn-Phong exponent of the sun's highlight, 1..100000. Default 2000. */
  shininess?: number;
  /** Borrowed sampleable 2D rgba16float equirectangular sky for reflections. Default the sky gradient. */
  environment?: () => GPUTexture | undefined;
  /** Linear horizon radiance for the default sky, 0..100 each. Default [0.38, 0.53, 0.67]. */
  skyHorizon?: readonly [number, number, number];
  /** Linear zenith radiance for the default sky, 0..100 each. Default [0.045, 0.16, 0.34]. */
  skyZenith?: readonly [number, number, number];
  /** False passes the scene through and draws no particles. Default true. */
  enabled?: boolean;
  /** Spray, foam and bubbles; needs `particles.velocities`. Default none. */
  whitewater?: WhitewaterOptions;
  /**
   * Draw only the particles near the surface into the depth pass and take the thickness from voxels (Oliveira and
   * Paiva 2022); rebuilt on each `update()`. Default false.
   */
  narrowBand?: boolean;
  /** Voxel size of the narrow band (the paper's 2h), 0.0001..1000. Default 4 * radius (two particle spacings). */
  bandVoxel?: number;
}

/** GPU work of the last frame, for tests and budgets. */
export interface LiquidFrameStats {
  /** Render passes recorded (6 with particles, 1 when disabled or empty). */
  passes: number;
  /** Draw calls recorded. */
  draws: number;
  /** Bytes written with queue.writeBuffer. */
  bytes: number;
  /** Instances drawn per sprite pass. */
  particles: number;
  /** Bind groups created (0 on a steady frame). */
  groups: number;
  /** Whitewater sprites drawn (the pool size while whitewater runs, else 0). */
  whitewater: number;
}

const range = (name: string, value: unknown, min: number, max: number, integer = false) => {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value)))
  )
    throw rangeError(
      `ParticleLiquid ${name} must be ${integer ? 'an integer' : 'finite'} in ${min}..${max}; pass a value in range`,
      'geometry',
    );
};

/**
 * Draws a set of particles as a liquid surface over the opaque scene, as an HDR PostStack stage. Each frame: sphere
 * sprites to eye depth, three narrow-range filter passes, additive thickness, then one composite pass. Particles are
 * not written to scene depth, so effects after it in the stack see the scene behind the liquid.
 * ```ts
 * const liquid = ParticleLiquid.attach(engine, { particles: { positions }, radius: 0.05 });
 * positions.set(next); liquid.update();
 * ```
 * @throws RangeError when an option is out of range (checked now and every frame); MargoError `'state'` outside a
 * PostStack or for a bad particle source, `'unsupported'` without WebGPU or the full WebGL2 layer, `'disposed'` after
 * `dispose()`, `'attached'` when joined twice.
 */
export class ParticleLiquid implements EnginePlugin {
  readonly name = 'water:liquid';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private source: ParticleSource;
  private count = 0;
  private dirty = true;
  private uniform?: GPUBuffer;
  private steps: GPUBuffer[] = [];
  private storage?: GPUBuffer;
  private sampler?: GPUSampler;
  private depthPipeline?: GPURenderPipeline;
  private thicknessPipeline?: GPURenderPipeline;
  private filterPipeline?: GPURenderPipeline;
  private readonly composites = new Map<string, GPURenderPipeline>();
  /** raw depth, filter ping, filter pong, thickness, depth attachment. */
  private targets: GPUTexture[] = [];
  private readonly values = new Float32Array(80);
  private readonly workspace = new Float64Array(52);
  private readonly stats: LiquidFrameStats = { passes: 0, draws: 0, bytes: 0, particles: 0, groups: 0, whitewater: 0 };
  private foam?: Whitewater;
  private loading?: Promise<void>;
  private stepDue = true;
  private band?: NarrowBand;
  private bandLoading?: Promise<void>;
  private bandDue = true;

  constructor(readonly options: ParticleLiquidOptions) {
    this.validate();
    this.source = options.particles;
    this.count = this.countOf(this.source);
  }

  /** Attaches a new ParticleLiquid to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: ParticleLiquidOptions): ParticleLiquid {
    const effect = new ParticleLiquid(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  /** The last frame's GPU work: passes, draws, uploaded bytes and particles drawn. */
  get frameStats(): Readonly<LiquidFrameStats> {
    return this.stats;
  }

  /** Particles drawn each frame. */
  get particleCount(): number {
    return this.count;
  }

  /**
   * Marks the particles changed: a Float32Array source is uploaded again before the next frame (count * stride * 4
   * bytes); a GPU source is read as it stands. Pass `particles` to switch source or count.
   */
  update(particles?: ParticleSource): void {
    if (this.disposed) throw fault('disposed', 'ParticleLiquid is disposed; create another ParticleLiquid');
    if (particles !== undefined) {
      const count = this.countOf(particles);
      if (this.storage && particles.positions !== this.source.positions) {
        this.storage.destroy();
        this.storage = undefined;
      }
      this.source = particles;
      this.count = count;
    }
    this.dirty = true;
    this.stepDue = true;
    this.bandDue = true;
  }

  /**
   * The narrow band of the last update read back: grid origin, voxel size and dims, full voxels, voxels in layers 1 and
   * 2, particles counted into voxels and particles in the band.
   * @throws MargoError `'state'` without `narrowBand` or before its first frame; the signal's reason when aborted.
   */
  async readNarrowBand(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.bandLoading;
    if (!this.band?.atlas)
      throw fault('state', 'ParticleLiquid has no narrow band yet; set narrowBand, draw a frame, await ready() and draw another');
    return this.band.read(signal);
  }

  /**
   * Resolves when the code of every optional part in use (whitewater, the narrow band) has loaded; the first frame
   * starts loading it and the next frame after this resolves draws with it.
   */
  async ready(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await Promise.all([this.loading, this.bandLoading]);
    signal?.throwIfAborted();
  }

  /**
   * Live whitewater particles by type, read back from the GPU pool (waits for the whitewater code to load).
   * @throws MargoError `'state'` without whitewater or before the first frame; the signal's reason when aborted.
   */
  async readWhitewater(signal?: AbortSignal): Promise<{ spray: number; foam: number; bubbles: number }> {
    signal?.throwIfAborted();
    await this.loading;
    if (!this.foam)
      throw fault('state', 'ParticleLiquid has no whitewater yet; set options.whitewater and draw a frame');
    return this.foam.read(signal);
  }

  private countOf(s: ParticleSource): number {
    if (!s || typeof s !== 'object' || !s.positions || typeof s.positions !== 'object')
      throw fault('state', 'ParticleLiquid particles need positions: a Float32Array, a GPUBuffer or a GpuArray');
    range('particles.stride', s.stride, 3, 64, true);
    range('particles.offset', s.offset, 0, 2 ** 31, true);
    range('particles.velocityOffset', s.velocityOffset, 0, 2 ** 31, true);
    if (s.velocities !== undefined && (!s.velocities || typeof s.velocities !== 'object'))
      throw fault('state', 'ParticleLiquid particles.velocities must be a Float32Array, a GPUBuffer or a GpuArray');
    const stride = s.stride ?? 3,
      offset = s.offset ?? 0;
    if (s.positions instanceof Float32Array) {
      const fit = s.positions.length >= offset + 3 ? Math.floor((s.positions.length - offset - 3) / stride) + 1 : 0;
      range('particles.count', s.count, 0, Math.min(fit, MAX_LIQUID_PARTICLES), true);
      const count = s.count ?? fit;
      range('particles.count', count, 0, MAX_LIQUID_PARTICLES, true);
      for (let i = 0; i < count; i++) {
        const b = offset + i * stride;
        if (!Number.isFinite(s.positions[b]! + s.positions[b + 1]! + s.positions[b + 2]!))
          throw rangeError(`ParticleLiquid particle ${i} has a non-finite position; pass finite centres`, 'geometry');
      }
      return count;
    }
    if (s.count === undefined)
      throw fault('state', 'ParticleLiquid particles.count is required for a GPU buffer source');
    range('particles.count', s.count, 0, MAX_LIQUID_PARTICLES, true);
    return s.count;
  }

  private validate(): void {
    const o = this.options;
    if (!o || typeof o !== 'object' || !o.particles)
      throw fault('state', 'ParticleLiquid needs options.particles, for example { positions: new Float32Array(...) }');
    range('radius', o.radius, 0.001, 100);
    range('ior', o.ior, 1, 3);
    range('smoothing', o.smoothing, 0.0001, 100);
    range('maxFilterRadius', o.maxFilterRadius, 1, 64, true);
    range('filterRange', o.filterRange, 1e-6, 1e6);
    range('filterClamp', o.filterClamp, 0, o.filterRange ?? 10 * (o.radius ?? 0.05));
    range('thicknessScale', o.thicknessScale, 0, 1000);
    range('shininess', o.shininess, 1, 100000);
    range('bandVoxel', o.bandVoxel, 0.0001, 1000);
    if (o.narrowBand !== undefined && typeof o.narrowBand !== 'boolean')
      throw fault('state', 'ParticleLiquid narrowBand must be true or false');
    if (o.resolutionScale !== undefined && o.resolutionScale !== 1 && o.resolutionScale !== 0.5)
      throw rangeError('ParticleLiquid resolutionScale must be 1 or 0.5', 'geometry');
    for (const [name, max] of [
      ['absorption', 100],
      ['color', 10],
      ['skyHorizon', 100],
      ['skyZenith', 100],
    ] as const) {
      const value = o[name];
      if (
        value !== undefined &&
        (typeof value !== 'object' ||
          value.length !== 3 ||
          [0, 1, 2].some((i) => !Number.isFinite(value[i]) || value[i]! < 0 || value[i]! > max))
      )
        throw rangeError(`ParticleLiquid ${name} needs three finite channels in 0..${max}`, 'geometry');
    }
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw fault('state', 'ParticleLiquid enabled must be true or false');
    if (o.environment !== undefined && typeof o.environment !== 'function')
      throw fault('state', 'ParticleLiquid environment must be a function returning a sampleable sky texture');
    const w = o.whitewater;
    if (w === undefined) return;
    if (!w || typeof w !== 'object') throw fault('state', 'ParticleLiquid whitewater must be an options object');
    if (!o.particles.velocities)
      throw fault(
        'state',
        'ParticleLiquid whitewater needs particles.velocities, for example { positions, velocities }',
      );
    const big = 1e9;
    for (const [name, min, max, integer] of [
      ['maxParticles', 1, MAX_LIQUID_PARTICLES, true],
      ['timeStep', 0, 1, false],
      ['support', 0.0001, 1000, false],
      ['trappedAirRate', 0, 100000, false],
      ['waveCrestRate', 0, 100000, false],
      ['particleMass', 1e-12, big, false],
      ['buoyancy', 0, 100, false],
      ['drag', 0, 1, false],
      ['sprayNeighbours', 0, 1000, true],
      ['bubbleNeighbours', 0, 1000, true],
      ['surfaceThreshold', 0, 1, false],
      ['radius', 0, 100, false],
      ['opacity', 0, 1, false],
      ['seed', 0, 2 ** 32 - 1, true],
    ] as const)
      range(`whitewater.${name}`, w[name], min, max, integer);
    for (const name of ['trappedAir', 'waveCrest', 'kineticEnergy', 'lifetime'] as const) {
      const v = w[name];
      if (
        v !== undefined &&
        (typeof v !== 'object' ||
          v.length !== 2 ||
          !(v[0] >= 0) ||
          !(v[1] <= big) ||
          !(v[0] < v[1] || (name === 'lifetime' && v[0] === v[1])))
      )
        throw rangeError(`ParticleLiquid whitewater.${name} needs [min, max] with 0 <= min < max`, 'geometry');
    }
    for (const [name, lo, hi] of [
      ['gravity', -big, big],
      ['color', 0, 10],
    ] as const) {
      const v = w[name];
      if (
        v !== undefined &&
        (typeof v !== 'object' || v.length !== 3 || [0, 1, 2].some((i) => !(v[i]! >= lo && v[i]! <= hi)))
      )
        throw rangeError(`ParticleLiquid whitewater.${name} needs three finite values in ${lo}..${hi}`, 'geometry');
    }
    if (w.enabled !== undefined && typeof w.enabled !== 'boolean')
      throw fault('state', 'ParticleLiquid whitewater.enabled must be true or false');
  }

  private joinStack(host: StackHost): StackStage {
    if (this.disposed) throw fault('disposed', 'ParticleLiquid is disposed; create another ParticleLiquid');
    if (this.engine || this.stacked)
      throw fault('attached', 'ParticleLiquid is already attached; create another ParticleLiquid', 'state');
    this.stacked = true;
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'ParticleLiquid is disposed; create another ParticleLiquid');
    if (this.engine) throw fault('attached', 'ParticleLiquid is already attached', 'state');
    if (!this.stacked) throw fault('state', 'Use ParticleLiquid.attach or add ParticleLiquid to a PostStack');
    if (!engine.gpu)
      throw fault('unsupported', 'ParticleLiquid requires WebGPU or full WebGL2 compatibility', 'webgpu');
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.steps = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ].map((s) => {
      const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Float32Array(s));
      return buffer;
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const sprite = device.createShaderModule({ code: spriteShader });
    this.depthPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: sprite, entryPoint: 'sprite' },
      fragment: { module: sprite, entryPoint: 'depth', targets: [{ format: 'r32float' }] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const add = ADD;
    this.thicknessPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: sprite, entryPoint: 'sprite' },
      fragment: {
        module: sprite,
        entryPoint: 'thickness',
        targets: [{ format: 'r16float', blend: { color: add, alpha: add } }],
      },
    });
    const filter = device.createShaderModule({ code: filterShader });
    this.filterPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: filter, entryPoint: 'vertex' },
      fragment: { module: filter, entryPoint: 'fragment', targets: [{ format: 'r32float' }] },
    });
    this.dirty = true;
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }

  /** Removes the effect, releases its GPU resources and disposes the stack `attach` created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private release(): void {
    for (const t of this.targets) t.destroy();
    this.targets = [];
    for (const b of this.steps) b.destroy();
    this.steps = [];
    this.uniform?.destroy();
    this.storage?.destroy();
    this.uniform = this.storage = this.sampler = undefined;
    this.depthPipeline = this.thicknessPipeline = this.filterPipeline = undefined;
    this.composites.clear();
    this.groups = [];
    this.views = [];
    this.final = undefined;
    this.bound[0] = [];
    this.bound[1] = [];
    this.foam?.destroy();
    this.foam = this.loading = undefined;
    this.band?.destroy();
    this.band = this.bandLoading = undefined;
    this.bandDue = true;
  }

  private resize(c: Context, scale: number): void {
    const t = this.targets;
    const tw = Math.max(1, Math.ceil(c.width * scale)),
      th = Math.max(1, Math.ceil(c.height * scale));
    if (t[0]?.width === c.width && t[0].height === c.height && t[3]!.width === tw && t[3]!.height === th) return;
    for (const texture of t) texture.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const make = (format: GPUTextureFormat, w = c.width, h = c.height) =>
      c.device.createTexture({ size: [w, h], format, usage });
    this.targets = [
      make('r32float'),
      make('r32float'),
      make('r32float'),
      make('r16float', tw, th),
      make('depth32float'),
    ];
  }

  /** The GPU buffer holding the centres and its float offset; uploads a CPU source when marked changed. */
  private positions(c: Context): GPUBuffer {
    const p = this.source.positions,
      stride = this.source.stride ?? 3,
      offset = this.source.offset ?? 0;
    if (p instanceof Float32Array) {
      const floats = this.count ? offset + (this.count - 1) * stride + 3 : 4;
      const bytes = Math.max(16, Math.ceil((floats * 4) / 16) * 16);
      if (!this.storage || this.storage.size < bytes) {
        this.storage?.destroy();
        this.storage = c.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.dirty = true;
      }
      if (this.dirty && this.count) {
        const length = Math.min(p.length, floats);
        c.device.queue.writeBuffer(this.storage, 0, p, 0, length);
        this.stats.bytes += length * 4;
      }
      this.dirty = false;
      return this.storage;
    }
    // A GPUBuffer has getMappedRange; anything else is a holder such as a GpuArray.
    const buffer =
      typeof (p as GPUBuffer).getMappedRange === 'function' ? (p as GPUBuffer) : (p as { buffer: GPUBuffer }).buffer;
    const need = (offset + Math.max(0, this.count - 1) * stride + 3) * 4;
    if (!buffer || typeof buffer.size !== 'number' || (this.count && buffer.size < need))
      throw fault(
        'state',
        `ParticleLiquid GPU source holds ${buffer?.size ?? 0} bytes; ${need} are needed for its count`,
      );
    this.dirty = false;
    return buffer;
  }

  private write(c: Context, scale: number): void {
    const o = this.options,
      v = this.values,
      camera = c.camera,
      radius = o.radius ?? 0.05,
      light = this.engine!.lighting;
    v.fill(0);
    v.set(camera.matrix);
    if (!invertMatrixStable(camera.matrix, v.subarray(16, 32), this.workspace))
      throw fault('state', 'ParticleLiquid needs an invertible camera; give it a finite projection');
    const e = camera.position,
      t = camera.target;
    let fx = t[0] - e[0],
      fy = t[1] - e[1],
      fz = t[2] - e[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    v.set([e[0], e[1], e[2], radius], 32);
    v.set([fx, fy, fz, Math.tan((camera.fov * Math.PI) / 360)], 36);
    v.set(c.view?.viewport ?? [0, 0, c.width, c.height], 40);
    v.set([this.source.stride ?? 3, this.source.offset ?? 0, this.count, o.thicknessScale ?? 1], 44);
    v.set(
      [o.smoothing ?? 0.7 * radius, o.filterRange ?? 10 * radius, o.filterClamp ?? radius, o.maxFilterRadius ?? 32],
      48,
    );
    v.set([...(o.absorption ?? [0.38, 0.1, 0.045]), o.ior ?? 1.333], 52);
    v.set([...(o.color ?? [1, 1, 1]), o.enabled === false || !this.count ? 0 : 1], 56);
    const d = light.direction,
      dl = Math.hypot(d[0], d[1], d[2]) || 1;
    v.set([d[0] / dl, d[1] / dl, d[2] / dl, o.shininess ?? 2000], 60);
    v.set([light.radiance[0] * d[3], light.radiance[1] * d[3], light.radiance[2] * d[3], 0], 64);
    v.set([light.ambient[0], light.ambient[1], light.ambient[2], this.foamOn ? 1 : 0], 68);
    v.set([...(o.skyHorizon ?? [0.38, 0.53, 0.67]), this.environment ? 1 : 0], 72);
    v.set([...(o.skyZenith ?? [0.045, 0.16, 0.34]), scale], 76);
    c.device.queue.writeBuffer(this.uniform!, 0, v);
    this.stats.bytes += v.byteLength;
  }

  private environment?: GPUTexture;
  private foamOn = false;
  private groups: GPUBindGroup[] = [];
  private views: GPUTextureView[] = [];
  private final?: GPUBindGroup;
  private readonly bound: unknown[][] = [[], []];

  /** True (and the record reset) when any part differs from the last frame's; slot 0 sprites and filter, 1 composite. */
  private cached(slot: 0 | 1, parts: unknown[]): boolean {
    const last = this.bound[slot]!;
    if (parts.length === last.length && parts.every((p, i) => p === last[i])) return false;
    this.bound[slot] = parts;
    if (slot === 0) this.groups = [];
    this.stats.groups += slot === 0 ? 5 : 1;
    return true;
  }

  private draw(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const o = this.options,
      device = c.device,
      s = this.stats;
    s.passes = s.draws = s.bytes = s.particles = s.groups = s.whitewater = 0;
    const environment = (this.environment = o.environment?.());
    if (
      environment &&
      (environment.format !== 'rgba16float' ||
        environment.sampleCount !== 1 ||
        environment.dimension !== '2d' ||
        environment.depthOrArrayLayers !== 1)
    )
      throw fault('state', 'ParticleLiquid environment needs a sampleable single-sample 2D rgba16float sky texture');
    const scale = o.resolutionScale ?? 1;
    this.resize(c, scale);
    const live = o.enabled !== false && this.count > 0;
    const buffer = live ? this.positions(c) : undefined;
    const ww = o.whitewater;
    const wanted = live && ww !== undefined && ww.enabled !== false;
    if (wanted && !this.foam && !this.loading) {
      const engine = this.engine;
      this.loading = import('./liquid-whitewater.js').then((m) => {
        if (this.engine === engine && !this.disposed) this.foam = new m.Whitewater(device);
      });
    }
    this.foamOn = wanted && this.foam !== undefined;
    if (live && o.narrowBand && !this.band && !this.bandLoading) {
      const engine = this.engine,
        depth = this.depthPipeline!,
        thickness = this.thicknessPipeline!;
      this.bandLoading = import('./liquid-band.js').then((m) => {
        if (this.engine !== engine || this.disposed) return;
        // The band's sprites and voxel balls draw into the same targets as the liquid's own pipelines.
        const like = (base: GPURenderPipeline, vertex: string, fragment: string) => (code: string) => {
          const module = device.createShaderModule({ code });
          const blend = base === thickness;
          return device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: vertex },
            fragment: {
              module,
              entryPoint: fragment,
              targets: [blend ? { format: 'r16float', blend: { color: ADD, alpha: ADD } } : { format: 'r32float' }],
            },
            ...(blend
              ? {}
              : { depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } }),
          });
        };
        this.band = new m.NarrowBand(device, like(depth, 'sprite', 'depth'), like(thickness, 'vertex', 'fragment'));
      });
    }
    const band = live && o.narrowBand && this.band ? this.band : undefined;
    this.write(c, scale);
    const [raw, ping, pong, thick, attachment] = this.targets as [
      GPUTexture,
      GPUTexture,
      GPUTexture,
      GPUTexture,
      GPUTexture,
    ];
    if (live) {
      const depthTexture = this.host!.depthTexture!;
      if (this.cached(0, [depthTexture, buffer, raw])) {
        const sceneDepth = depthTexture.createView({ aspect: 'depth-only' });
        for (const pipeline of [this.depthPipeline!, this.thicknessPipeline!])
          this.groups.push(group(device, pipeline, [{ buffer: this.uniform! }, { buffer: buffer! }, sceneDepth]));
        for (const [from, step] of [
          [raw, 0],
          [ping, 1],
          [pong, 2],
        ] as const)
          this.groups.push(
            group(device, this.filterPipeline!, [
              { buffer: this.uniform! },
              from.createView(),
              { buffer: this.steps[step]! },
            ]),
          );
        this.views = [raw, ping, pong, thick, attachment].map((t) => t.createView());
      }
      const [g0, g1, g2, g3, g4] = this.groups as [
        GPUBindGroup,
        GPUBindGroup,
        GPUBindGroup,
        GPUBindGroup,
        GPUBindGroup,
      ];
      const [vRaw, vPing, vPong, vThick, vAttachment] = this.views as GPUTextureView[];
      if (band) {
        band.record(
          c,
          this.count,
          o.bandVoxel ?? 4 * (o.radius ?? 0.05),
          o.radius ?? 0.05,
          this.uniform!,
          buffer!,
          depthTexture,
          this.bandDue,
        );
        this.bandDue = false;
        s.passes += band.passes;
        s.draws += band.passes;
        s.groups += band.groupsMade;
        s.bytes += band.bytes;
      }
      // 1. Nearest sphere depth, tested against the opaque scene.
      let pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: vRaw!, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        depthStencilAttachment: {
          view: vAttachment!,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          depthClearValue: 0,
        },
      });
      applyView(pass, c);
      if (band) band.drawDepth(pass, this.count);
      else {
        pass.setPipeline(this.depthPipeline!);
        pass.setBindGroup(0, g0);
        pass.draw(6, this.count);
      }
      pass.end();
      // 2. Narrow-range filter: horizontal, vertical, then the 5 x 5 clean-up.
      for (const [to, bind] of [
        [vPing!, g2],
        [vPong!, g3],
        [vPing!, g4],
      ] as const) {
        pass = c.encoder.beginRenderPass({
          colorAttachments: [{ view: to, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        });
        pass.setPipeline(this.filterPipeline!);
        pass.setBindGroup(0, bind);
        applyView(pass, c);
        pass.draw(3);
        pass.end();
      }
      // 3. Thickness: every sphere's chord, added.
      pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: vThick!, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
      const [x, y, w, h] = c.view?.viewport ?? [0, 0, c.width, c.height];
      const x0 = Math.floor(x * scale),
        y0 = Math.floor(y * scale),
        x1 = Math.min(thick.width, Math.ceil((x + w) * scale)),
        y1 = Math.min(thick.height, Math.ceil((y + h) * scale));
      pass.setViewport(x * scale, y * scale, w * scale, h * scale, 0, 1);
      pass.setScissorRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      if (band) band.drawThickness(pass);
      else {
        pass.setPipeline(this.thicknessPipeline!);
        pass.setBindGroup(0, g1);
        pass.draw(6, this.count);
      }
      pass.end();
      s.passes += 5;
      s.draws += 5;
      s.particles = this.count;
      const foam = this.foam;
      if (this.foamOn && foam) {
        foam.record(
          c,
          ww!,
          o.radius ?? 0.05,
          this.source,
          this.count,
          this.uniform!,
          buffer!,
          depthTexture,
          ping,
          this.stepDue,
        );
        this.stepDue = false;
        s.passes += foam.passes;
        s.draws += foam.draws;
        s.groups += foam.groupsMade;
        s.bytes += foam.bytes;
        s.whitewater = foam.pool;
      }
    }
    // 4 and 5. Normals and the composite over the scene.
    const key = `${output.format}:${output.multisample.count ?? 1}:${+output.hdr}`;
    let pipeline = this.composites.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: compositeShader(!output.hdr, displayShader) });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: output.format }] },
        multisample: output.multisample,
      });
      this.composites.set(key, pipeline);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    const layer = (this.foamOn && this.foam?.layer) || thick;
    if (this.cached(1, [pipeline, input, ping, thick, environment, layer]))
      this.final = group(device, pipeline, [
        { buffer: this.uniform! },
        input,
        ping.createView(),
        thick.createView(),
        this.sampler!,
        (environment ?? thick).createView(),
        layer.createView(),
      ]);
    pass.setBindGroup(0, this.final!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
    s.passes += 1;
    s.draws += 1;
  }
}
