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

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

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
  private readonly stats: LiquidFrameStats = { passes: 0, draws: 0, bytes: 0, particles: 0, groups: 0 };

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
  }

  private countOf(s: ParticleSource): number {
    if (!s || typeof s !== 'object' || !s.positions || typeof s.positions !== 'object')
      throw fault('state', 'ParticleLiquid particles need positions: a Float32Array, a GPUBuffer or a GpuArray');
    range('particles.stride', s.stride, 3, 64, true);
    range('particles.offset', s.offset, 0, 2 ** 31, true);
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
    const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' } as const;
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
    v.set([light.ambient[0], light.ambient[1], light.ambient[2], 0], 68);
    v.set([...(o.skyHorizon ?? [0.38, 0.53, 0.67]), this.environment ? 1 : 0], 72);
    v.set([...(o.skyZenith ?? [0.045, 0.16, 0.34]), scale], 76);
    c.device.queue.writeBuffer(this.uniform!, 0, v);
    this.stats.bytes += v.byteLength;
  }

  private environment?: GPUTexture;
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
    s.passes = s.draws = s.bytes = s.particles = s.groups = 0;
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
      pass.setPipeline(this.depthPipeline!);
      pass.setBindGroup(0, g0);
      applyView(pass, c);
      pass.draw(6, this.count);
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
      pass.setPipeline(this.thicknessPipeline!);
      pass.setBindGroup(0, g1);
      const [x, y, w, h] = c.view?.viewport ?? [0, 0, c.width, c.height];
      const x0 = Math.floor(x * scale),
        y0 = Math.floor(y * scale),
        x1 = Math.min(thick.width, Math.ceil((x + w) * scale)),
        y1 = Math.min(thick.height, Math.ceil((y + h) * scale));
      pass.setViewport(x * scale, y * scale, w * scale, h * scale, 0, 1);
      pass.setScissorRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      pass.draw(6, this.count);
      pass.end();
      s.passes += 5;
      s.draws += 5;
      s.particles = this.count;
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
    if (this.cached(1, [pipeline, input, ping, thick, environment]))
      this.final = group(device, pipeline, [
        { buffer: this.uniform! },
        input,
        ping.createView(),
        thick.createView(),
        this.sampler!,
        (environment ?? thick).createView(),
      ]);
    pass.setBindGroup(0, this.final!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
    s.passes += 1;
    s.draws += 1;
  }
}
