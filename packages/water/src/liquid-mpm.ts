/// <reference lib="esnext.disposable" preserve="true" />
// GPULiquid (`@margoengine/water/liquid`): a real-time particle liquid stepped by MLS-MPM (Hu et al. 2018) in five compute
// passes a substep, held by the container's walls, stirred by the pointer, pushed by rigid colliders (and pushing back
// through `forces`), and drawn as a liquid surface by ParticleLiquid straight from the particle buffer. On the WebGL2
// compatibility layer the CPU twin (liquid-mpm-sim.ts) steps it and the same surface draws it. Sources: docs/clean-room.md,
// "GPU particle liquid".
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { compatTier } from '../../shared/compat.js';
import { fault } from '../../shared/errors.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { applyView } from '../../shared/view-rect.js';
import { ParticleLiquid, type ParticleLiquidOptions } from './liquid.js';
import {
  LIQUID_CLEAR_WGSL,
  LIQUID_DEBUG_FLOATS,
  LIQUID_DEBUG_LINES_WGSL,
  LIQUID_DEBUG_PARTICLES_WGSL,
  LIQUID_G2P_WGSL,
  LIQUID_GRID_WGSL,
  LIQUID_NORMALS_WGSL,
  LIQUID_P2G_WGSL,
  LIQUID_SIM_FLOATS,
  LIQUID_STRESS_WGSL,
} from './liquid-mpm-shaders.js';
import {
  createLiquidState,
  LIQUID_ADHESION_REACH,
  LIQUID_FORCE_FIXED,
  LIQUID_GAMMA,
  LIQUID_COLOR_OFFSET,
  LIQUID_GRID_STRIDE,
  LIQUID_PARTICLE_FLOATS,
  liquidError,
  MAX_LIQUID_MESH_SAMPLES,
  liquidSubsteps,
  MAX_LIQUID_COLLIDERS,
  resolveLiquidParams,
  stepLiquidCPU,
  type GPULiquidOptions,
  type LiquidCollider,
  type LiquidDebugOptions,
  type LiquidForce,
  type LiquidPointer,
  type LiquidSnapshot,
  type LiquidState,
  type LiquidStats,
  type LiquidVec3,
  type ResolvedLiquidParams,
} from './liquid-mpm-sim.js';

export {
  LIQUID_COLOR_OFFSET,
  LIQUID_GRID_STRIDE,
  MAX_LIQUIDS,
  bakeLiquidMesh,
  colliderDistance,
  createLiquidState,
  LIQUID_PARTICLE_FLOATS,
  liquidStateHash,
  liquidSurfaceNormals,
  liquidSubsteps,
  MAX_GPU_LIQUID_NODES,
  MAX_GPU_LIQUID_PARTICLES,
  MAX_LIQUID_COLLIDERS,
  MAX_LIQUID_MESH_SAMPLES,
  MAX_LIQUID_MESH_WORK,
  resolveLiquidParams,
  stepLiquidCPU,
} from './liquid-mpm-sim.js';
export type {
  GPULiquidOptions,
  LiquidBox,
  LiquidCollider,
  LiquidDebugOptions,
  LiquidForce,
  LiquidKindOptions,
  LiquidMeshBakeOptions,
  LiquidMeshShape,
  LiquidPointer,
  LiquidSnapshot,
  LiquidState,
  LiquidStats,
  LiquidVec3,
  ResolvedCollider,
  ResolvedLiquidKind,
  ResolvedLiquidParams,
} from './liquid-mpm-sim.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Pass = [GPUComputePipeline, GPUBindGroup];

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** Longest frame delta one frame advances the liquid by, in seconds. */
const FRAME_DELTA_CAP = 1 / 30;
const FORCE_BYTES = MAX_LIQUID_COLLIDERS * 8 * 4;

/** Options of {@link GPULiquid.attach}: the liquid's, plus its surface. */
export interface GPULiquidAttachOptions extends GPULiquidOptions {
  /**
   * The liquid surface, drawn by a ParticleLiquid from the particle buffer: its options without `particles`, or false for
   * none. Default `{ radius: particle spacing }` with ParticleLiquid's other defaults.
   */
  surface?: false | Omit<ParticleLiquidOptions, 'particles'>;
}

/**
 * A rigid body {@link GPULiquid.link} couples to the liquid. A `PhysicsBody` of `@margoengine/physics` is one; any object
 * with these members works.
 */
export interface LiquidLinkBody {
  /** World position of the body's origin. */
  readonly position: ArrayLike<number>;
  /** World orientation, a unit quaternion [x, y, z, w]. */
  readonly rotation: ArrayLike<number>;
  /** Linear velocity of the centre of mass in m/s. */
  readonly linearVelocity: ArrayLike<number>;
  /** Angular velocity in rad/s. */
  readonly angularVelocity: ArrayLike<number>;
  /** Velocity of the body at a world point; without it, linearVelocity + angularVelocity x (point - position). */
  velocityAtPoint?(point: [number, number, number]): ArrayLike<number>;
  /** Applies an impulse in N s at a world point. */
  applyImpulse(impulse: [number, number, number], point?: [number, number, number]): unknown;
  /** Applies an angular impulse in N m s. */
  applyTorqueImpulse(torque: [number, number, number]): unknown;
}

/** A linked body's collider: a collider whose `position` (default [0, 0, 0]) and `rotation` place it in the body's frame. */
export type LiquidLinkCollider = Omit<LiquidCollider, 'position'> & { position?: LiquidVec3 };

/** A body coupled to the liquid both ways by {@link GPULiquid.link}. */
export interface LiquidLink {
  /** The body. */
  readonly body: LiquidLinkBody;
  /** Its collider shape; `position` and `rotation` place it in the body's frame. */
  readonly collider: LiquidLinkCollider;
  /** Ends the coupling; the body keeps what it has taken. */
  unlink(): void;
}

interface LinkEntry extends LiquidLink {
  /** World centre of the collider at the last step, where its impulse acts. */
  center: [number, number, number];
}

let nextLiquidId = 0;

/**
 * A GPU particle liquid (`@margoengine/water/liquid`), an engine plugin.
 *
 * On WebGPU every substep runs on the GPU (five compute passes, no readback): particles scatter mass and APIC momentum to
 * a grid, take their density back and scatter Tait pressure and viscous stress, the grid adds gravity, the pointer,
 * colliders and walls, and the particles gather their new velocity. Sums are fixed-point integers, so the same options
 * give the same state on the same GPU and driver, also after `snapshot` and `restore`. On the WebGL2 compatibility layer
 * the CPU twin runs the same passes (`stats.backend` is `'webgl2-compat'`); keep counts there to a few thousand.
 * Throws a coded `MargoError` (help link) for any bad option.
 */
export class GPULiquid implements EnginePlugin {
  /** Unique plugin name registered on the engine's frame graph. */
  readonly name: string;
  /** Live options; change the pointer, colliders and debug view through their setters. */
  readonly options: GPULiquidOptions;
  /** Particle count, fixed at construction. */
  readonly count: number;
  /** Live statistics. */
  readonly stats: LiquidStats;
  /** The surface `attach` made, or undefined. Its `options` are live. */
  surface?: ParticleLiquid;
  /**
   * What each collider (`options.colliders`, then the linked bodies) took from the liquid, in N and N m: on WebGPU the
   * mean over the frames since the last read (read back by itself every frame while there are colliders, so usually one
   * frame behind), on the WebGL2 layer the last stepped frame.
   */
  forces: LiquidForce[] = [];

  private engine?: Engine;
  private device?: GPUDevice;
  private disposed = false;
  private compat = false;
  private params: ResolvedLiquidParams;
  private pending?: Float32Array;
  private needsInit = true;
  private cpuState?: LiquidState;
  private clocked = false;
  private ticked = false;
  private pendingDelta = 0;
  /** Seconds stepped since the force sums were last read and cleared. */
  private forceTime = 0;
  private pulling?: Promise<LiquidForce[]>;
  private links: LinkEntry[] = [];
  private sdfBuf?: GPUBuffer;
  /** Surface normals a node, made on the first step with surface tension (16 bytes until then). */
  private surfBuf?: GPUBuffer;
  private sdfKey: readonly unknown[] = [];
  private sdfOffsets: number[] = [];
  private lastPointer?: LiquidVec3;
  private surfaceHidden?: boolean;

  private owned: { destroy(): void }[] = [];
  private particleBuf?: GPUBuffer;
  private simUniform?: GPUBuffer;
  private gridBuf?: GPUBuffer;
  private forceBuf?: GPUBuffer;
  private debugUniform?: GPUBuffer;
  private lineBuf?: GPUBuffer;
  private lineCount = 0;
  private compute?: { clear: Pass; p2g: Pass; stress: Pass; normals: Pass; grid: Pass; g2p: Pass };
  private debugPipelines = new Map<string, [GPURenderPipeline, GPUBindGroup, GPURenderPipeline]>();
  private lineGroups = new Map<GPURenderPipeline, GPUBindGroup>();

  private readonly simData = new ArrayBuffer(LIQUID_SIM_FLOATS * 4);
  private readonly simU32 = new Uint32Array(this.simData);
  private readonly simF32 = new Float32Array(this.simData);
  private readonly debugData = new Float32Array(LIQUID_DEBUG_FLOATS);
  private readonly colorAttachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  private readonly passDesc: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.depthAttachment,
  };
  private readonly lineDepth: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly linePassDesc: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.lineDepth,
  };

  /** Creates a liquid; pass it to `engine.use(liquid)` (no surface), or use {@link GPULiquid.attach}. */
  constructor(options: GPULiquidOptions = {}) {
    this.params = resolveLiquidParams(options);
    this.options = { ...options, count: this.params.count, debug: { ...this.params.debug } };
    this.count = this.params.count;
    this.name = `water:gpu-liquid:${++nextLiquidId}`;
    const p = this.params;
    this.stats = {
      count: this.count,
      backend: 'webgpu',
      dims: p.dims,
      nodes: p.nodes,
      cellSize: p.cellSize,
      restDensity: p.restDensity,
      steps: 0,
      frameSubsteps: 0,
      substep: 0,
      realTime: true,
      dispatches: 0,
      debugDraws: 0,
    };
  }

  /** Creates a {@link GPULiquid}, attaches it to `engine` and adds its surface to the scene's PostStack. */
  static attach(engine: EngineKernel, options: GPULiquidAttachOptions = {}): GPULiquid {
    const { surface, ...rest } = options;
    if (surface !== undefined && surface !== false && (!surface || typeof surface !== 'object'))
      throw liquidError('GPULiquid surface must be ParticleLiquid options or false');
    const liquid = new GPULiquid(rest);
    engineRuntime(engine).use(liquid);
    if (surface !== false) {
      const buffer = (device: GPUDevice) => liquid.particleBuffer(device);
      liquid.surface = ParticleLiquid.attach(engine, {
        radius: liquid.spacing,
        ...surface,
        particles: {
          positions: buffer,
          velocities: buffer,
          count: liquid.count,
          stride: LIQUID_PARTICLE_FLOATS,
          offset: 0,
          velocityOffset: 4,
          // Several liquids or mixing colours tint the surface with each particle's own colour.
          ...(rest.liquids || rest.mixing ? { colorOffset: LIQUID_COLOR_OFFSET } : {}),
        },
      });
    }
    return liquid;
  }

  /** The start lattice's mean particle spacing in world units, the surface's default sprite radius. */
  get spacing(): number {
    const [x, y, z] = this.params.lattice;
    return Math.cbrt(x * y * z);
  }

  /** Mass of one particle in kg: density times the start lattice's volume per particle. */
  get particleMass(): number {
    return this.params.particleMass;
  }

  private assertAlive(action: string): void {
    if (this.disposed)
      throw fault('disposed', `GPULiquid.${action} cannot run after dispose(); attach a new GPULiquid`);
  }

  /** The options' colliders followed by every linked body's, placed from the body's pose and velocity. */
  private allColliders(extra: LiquidCollider[] = []): LiquidCollider[] {
    const own = this.options.colliders ?? [];
    if (!this.links.length && !extra.length) return own as LiquidCollider[];
    return [...own, ...this.links.map((l) => linkedCollider(l)), ...extra];
  }

  private resolve(): ResolvedLiquidParams {
    const p = (this.params = resolveLiquidParams({ ...this.options, colliders: this.allColliders() }, this.count));
    const base = p.colliders.length - this.links.length;
    this.links.forEach((l, i) => {
      const c = p.colliders[base + i]!.position;
      l.center = [c[0], c[1], c[2]];
    });
    return p;
  }

  /**
   * Couples `body` to the liquid both ways: every frame its collider follows the body's pose and velocity and pushes the
   * liquid, and the body takes the liquid's impulse on it (`applyImpulse` at the collider's centre and
   * `applyTorqueImpulse`) each time the force sums are read, so every impulse reaches it exactly once. `collider`'s
   * `position` and `rotation` place the shape in the body's frame (default its origin); its velocities come from the
   * body. Counts toward the 8 colliders.
   */
  link(body: LiquidLinkBody, collider: LiquidLinkCollider): LiquidLink {
    this.assertAlive('link');
    for (const key of ['position', 'rotation', 'linearVelocity', 'angularVelocity'] as const)
      if (!body || typeof body !== 'object' || !body[key] || typeof body[key].length !== 'number')
        throw liquidError(
          `GPULiquid.link body.${key} must be an array; pass a PhysicsBody or a body with position, rotation, linearVelocity and angularVelocity`,
        );
    if (typeof body.applyImpulse !== 'function' || typeof body.applyTorqueImpulse !== 'function')
      throw liquidError('GPULiquid.link body needs applyImpulse(impulse, point) and applyTorqueImpulse(torque)');
    if (this.links.some((l) => l.body === body)) throw liquidError('GPULiquid.link: this body is linked already; unlink it first');
    const entry: LinkEntry = { body, collider, center: [0, 0, 0], unlink: () => this.unlink(entry) };
    resolveLiquidParams({ ...this.options, colliders: this.allColliders([linkedCollider(entry)]) }, this.count);
    this.flushForces();
    this.links.push(entry);
    return entry;
  }

  private unlink(entry: LinkEntry): void {
    const i = this.links.indexOf(entry);
    if (i < 0 || this.disposed) return;
    this.flushForces();
    this.links.splice(i, 1);
    const n = this.allColliders().length;
    if (this.forces.length > n) this.forces.length = n;
  }

  /** Reads the force sums of the steps so far before the colliders change, so no sum spans two collider lists. */
  private flushForces(): void {
    if (this.compat || !this.device || !this.forceBuf || !(this.forceTime > 0)) return;
    this.pull().catch((error: unknown) => {
      if (!this.disposed) this.engine?.onError(error as Error);
    });
  }

  /** Sets the pointer (a stirring stick), or null for none. Its velocity comes from its motion unless given. */
  setPointer(pointer: LiquidPointer | null): void {
    this.assertAlive('setPointer');
    resolveLiquidParams({ ...this.options, pointer }, this.count);
    if (!pointer) this.lastPointer = undefined;
    this.options.pointer = pointer;
  }

  /** Replaces the colliders (up to 8); `forces` follows the same order. */
  setColliders(colliders: readonly LiquidCollider[]): void {
    this.assertAlive('setColliders');
    resolveLiquidParams({ ...this.options, colliders: [...colliders, ...this.links.map((l) => linkedCollider(l))] }, this.count);
    this.flushForces();
    this.options.colliders = colliders;
    const n = colliders.length + this.links.length;
    if (this.forces.length > n) this.forces.length = n;
  }

  /** Merges debug view settings. */
  setDebug(debug: LiquidDebugOptions): void {
    this.assertAlive('setDebug');
    if (!debug || typeof debug !== 'object') throw liquidError('GPULiquid.setDebug takes an object, for example { enabled: true }');
    const merged = { ...this.options.debug, ...debug };
    resolveLiquidParams({ ...this.options, debug: merged }, this.count);
    this.options.debug = merged;
  }

  /** The current debug view settings with their defaults filled in. */
  getDebug(): Required<LiquidDebugOptions> {
    return { ...this.resolve().debug };
  }

  /** Starts the liquid again from its fill block, jittered by `seed` (default `options.seed`). */
  reset(seed?: number): void {
    this.assertAlive('reset');
    resolveLiquidParams({ ...this.options, seed: seed ?? this.options.seed }, this.count);
    if (seed !== undefined) this.options.seed = seed;
    this.pending = undefined;
    this.needsInit = true;
    this.stats.steps = 0;
  }

  /**
   * Advances the liquid by `dt` seconds now (0 to 1, in equal substeps of at most `cellSize * 0.4 / speedOfSound`), also
   * while `paused`. Call it between frames; needs the liquid attached. A pointer without a velocity is still here.
   */
  step(dt: number): void {
    this.assertAlive('step');
    const device = this.device;
    if (!device) throw fault('state', 'GPULiquid.step needs the liquid attached; call GPULiquid.attach(engine) first');
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0 || dt > 1)
      throw liquidError(`GPULiquid step dt is ${String(dt)}; pass seconds from 0 to 1`);
    const params = this.resolve();
    this.ensureResources(device);
    const { n, h } = liquidSubsteps(params, dt);
    if (!n) return;
    if (this.compat) {
      this.stepCompat(device, params, dt, Infinity);
      return;
    }
    const encoder = device.createCommandEncoder();
    this.encodeSteps(encoder, device, params, n, h);
    device.queue.submit([encoder.finish()]);
  }

  /** Copies the particles, read back from the GPU (or the CPU twin on the WebGL2 layer); `restore` takes it back. */
  async snapshot(signal?: AbortSignal): Promise<LiquidSnapshot> {
    this.assertAlive('snapshot');
    signal?.throwIfAborted();
    const device = this.device;
    if (!device) throw fault('state', 'GPULiquid.snapshot needs the liquid attached; call GPULiquid.attach(engine) first');
    this.ensureResources(device);
    const steps = this.stats.steps;
    if (this.compat) return { count: this.count, steps, particles: this.cpuState!.particles.slice() };
    const bytes = this.count * LIQUID_PARTICLE_FLOATS * 4;
    const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.particleBuf!, 0, staging, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      signal?.throwIfAborted();
      return { count: this.count, steps, particles: new Float32Array(staging.getMappedRange().slice(0)) };
    } finally {
      staging.destroy();
    }
  }

  /**
   * Puts the liquid back to a `snapshot` of a liquid of the same count; the steps after it repeat exactly. The whole
   * snapshot is checked (count, length, finite values, positions inside the container) before anything changes.
   */
  restore(snapshot: LiquidSnapshot): void {
    this.assertAlive('restore');
    const F = LIQUID_PARTICLE_FLOATS;
    if (
      !snapshot ||
      snapshot.count !== this.count ||
      !(snapshot.particles instanceof Float32Array) ||
      snapshot.particles.length !== this.count * F ||
      !Number.isSafeInteger(snapshot.steps) ||
      snapshot.steps < 0
    )
      throw liquidError(`GPULiquid.restore takes a snapshot of a liquid of ${this.count} particles, from liquid.snapshot()`);
    const { boxMin, boxMax } = this.params;
    const data = snapshot.particles;
    for (let i = 0; i < data.length; i++)
      if (!Number.isFinite(data[i])) throw liquidError(`GPULiquid.restore: snapshot value ${i} is not finite`);
    for (let i = 0; i < this.count; i++) {
      for (let a = 0; a < 3; a++) {
        const x = data[i * F + a]!;
        if (x < boxMin[a]! || x > boxMax[a]!)
          throw liquidError(`GPULiquid.restore: particle ${i} lies outside the container`);
      }
      const kind = data[i * F + 7]!;
      if (!Number.isInteger(kind) || kind < 0 || kind >= this.params.kinds.length)
        throw liquidError(`GPULiquid.restore: particle ${i} names liquid ${kind}; this liquid has ${this.params.kinds.length}`);
    }
    this.pending = data.slice();
    this.needsInit = true;
    this.stats.steps = snapshot.steps;
  }

  /**
   * Reads what each collider took from the liquid since the last read (the fixed-point sums, read back from the GPU and
   * cleared in the same submit, so no step is counted twice or missed), hands each linked body its impulse, and updates
   * `forces`; it runs by itself every frame while there are colliders.
   */
  async readForces(signal?: AbortSignal): Promise<LiquidForce[]> {
    this.assertAlive('readForces');
    signal?.throwIfAborted();
    const device = this.device;
    if (!device) throw fault('state', 'GPULiquid.readForces needs the liquid attached; call GPULiquid.attach(engine) first');
    this.ensureResources(device);
    if (this.compat) return this.forces.slice(0, this.params.colliders.length);
    const forces = await this.pull();
    signal?.throwIfAborted();
    return forces.slice();
  }

  /** Copies the force sums out and clears them in one submit, then decodes them and hands linked bodies their impulses. */
  private pull(): Promise<LiquidForce[]> {
    if (this.pulling) return this.pulling.then(() => (this.forceTime > 0 ? this.pull() : this.forces));
    const device = this.device!;
    const time = this.forceTime;
    if (!(time > 0)) return Promise.resolve(this.forces);
    this.forceTime = 0;
    const k = this.params.colliders.length;
    const links = this.links.slice();
    const centers = links.map((l) => l.center.slice() as [number, number, number]);
    const staging = device.createBuffer({ size: FORCE_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.forceBuf!, 0, staging, 0, FORCE_BYTES);
    encoder.clearBuffer(this.forceBuf!);
    device.queue.submit([encoder.finish()]);
    const done: Promise<LiquidForce[]> = staging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const sums = new Int32Array(staging.getMappedRange().slice(0));
        const forces = this.decodeForces((i) => sums[i]!, 8, k, time);
        if (this.device === device) {
          this.forces = forces;
          this.deliver((i) => sums[i]!, 8, k, links, centers);
        }
        return forces;
      })
      .finally(() => {
        staging.destroy();
        if (this.pulling === done) this.pulling = undefined;
      });
    this.pulling = done;
    return done;
  }

  /** Hands each linked body (the last of the k colliders) its impulse and angular impulse from the fixed-point sums. */
  private deliver(
    sum: (i: number) => number,
    stride: number,
    k: number,
    links: LinkEntry[],
    centers: [number, number, number][],
  ): void {
    const scale = this.params.particleMass / LIQUID_FORCE_FIXED;
    const base = k - links.length;
    if (base < 0) return;
    links.forEach((l, i) => {
      const o = (base + i) * stride;
      l.body.applyImpulse([sum(o) * scale, sum(o + 1) * scale, sum(o + 2) * scale], centers[i]);
      l.body.applyTorqueImpulse([sum(o + 3) * scale, sum(o + 4) * scale, sum(o + 5) * scale]);
    });
  }

  private decodeForces(sum: (i: number) => number, stride: number, k: number, time: number): LiquidForce[] {
    const scale = time > 0 ? this.params.particleMass / (LIQUID_FORCE_FIXED * time) : 0;
    const out: LiquidForce[] = [];
    for (let c = 0; c < k; c++) {
      const o = c * stride;
      out.push({
        force: [sum(o) * scale, sum(o + 1) * scale, sum(o + 2) * scale],
        torque: [sum(o + 3) * scale, sum(o + 4) * scale, sum(o + 5) * scale],
      });
    }
    return out;
  }

  /** Checks WebGPU and the device's buffer limits for this count and grid. */
  setup(engine: Engine): void {
    requireWebGPU(engine, 'GPULiquid');
    const device = engine.gpu!;
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const need = Math.max(this.count * LIQUID_PARTICLE_FLOATS * 4, this.params.nodes * LIQUID_GRID_STRIDE * 4, MAX_LIQUID_MESH_SAMPLES * 4);
    if (need > limit)
      throw fault(
        'unsupported',
        `GPULiquid needs a ${need} byte buffer and this device binds at most ${limit}; pass a smaller count or resolution`,
        'gpu-liquid',
      );
    this.engine = engine;
    this.device = device;
    this.compat = compatTier(device) === 'webgl2';
    this.stats.backend = this.compat ? 'webgl2-compat' : 'webgpu';
  }

  /** Registers the step, the debug particles and the debug lines on the frame graph. */
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name + ':simulate', order: -8, execute: (c) => c.backend === 'webgpu' && this.simulate(c) });
    graph.add({ name: this.name + ':debug', order: 2, execute: (c) => c.backend === 'webgpu' && this.drawParticles(c) });
    graph.add({ name: this.name + ':lines', order: 8, execute: (c) => c.backend === 'webgpu' && this.drawLines(c) });
  }

  /** Takes the frame delta once a tick, and starts reading the colliders' forces of the frames since the last read. */
  onPreUpdate(delta: number): void {
    if (this.disposed) return;
    this.pendingDelta = delta;
    this.clocked = true;
    this.ticked = true;
    if (this.compat || this.pulling || !this.device || !this.forceBuf || !this.params.colliders.length || !(this.forceTime > 0)) return;
    const device = this.device;
    this.pull().catch((error: unknown) => {
      // A read cut short by dispose() or a device loss has nothing to report.
      if (!this.disposed && this.device === device) this.engine?.onError(error as Error);
    });
  }

  /** The particle buffer on `device` (made on first use): the surface's source, and any caller's. */
  particleBuffer(device: GPUDevice): GPUBuffer {
    this.assertAlive('particleBuffer');
    if (device !== this.device)
      throw fault('state', 'GPULiquid.particleBuffer takes the device of the engine the liquid is attached to');
    this.ensureResources(device);
    return this.particleBuf!;
  }

  private buffer(device: GPUDevice, size: number, usage: number): GPUBuffer {
    const buf = device.createBuffer({ size, usage });
    this.owned.push(buf);
    return buf;
  }

  private ensureResources(device: GPUDevice): void {
    const STORAGE = GPUBufferUsage.STORAGE;
    if (!this.particleBuf) {
      const p = this.params;
      this.particleBuf = this.buffer(
        device,
        this.count * LIQUID_PARTICLE_FLOATS * 4,
        STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      );
      this.debugUniform = this.buffer(device, LIQUID_DEBUG_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      if (!this.compat) {
        this.simUniform = this.buffer(device, this.simData.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        this.gridBuf = this.buffer(device, p.nodes * LIQUID_GRID_STRIDE * 4, STORAGE);
        this.forceBuf = this.buffer(device, FORCE_BYTES, STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        this.sdfBuf = undefined;
        this.sdfKey = [];
        this.meshFields(device);
        this.surfBuf = this.buffer(device, 16, STORAGE);
        this.buildPasses(device);
      }
      this.needsInit = true;
    }
    if (this.needsInit) {
      const state = createLiquidState(this.params);
      if (this.pending) state.particles.set(this.pending);
      this.pending = undefined;
      device.queue.writeBuffer(this.particleBuf, 0, state.particles as Float32Array<ArrayBuffer>);
      this.cpuState = this.compat ? state : undefined;
      this.forceTime = 0;
      this.forces = [];
      if (this.forceBuf) device.queue.writeBuffer(this.forceBuf, 0, new Int32Array(FORCE_BYTES / 4));
      this.needsInit = false;
    }
  }

  /** The five compute passes, bound to the current buffers. */
  private buildPasses(device: GPUDevice): void {
    const sim = this.simUniform!,
      grid = this.gridBuf!,
      forces = this.forceBuf!,
      particles = this.particleBuf!,
      sdf = this.sdfBuf!,
      surf = this.surfBuf!;
    const pass = (code: string, buffers: GPUBuffer[]): Pass => {
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      return [pipeline, group];
    };
    this.compute = {
      clear: pass(LIQUID_CLEAR_WGSL, [sim, grid]),
      p2g: pass(LIQUID_P2G_WGSL, [sim, particles, grid]),
      stress: pass(LIQUID_STRESS_WGSL, [sim, particles, grid, sdf]),
      normals: pass(LIQUID_NORMALS_WGSL, [sim, grid, surf, sdf]),
      grid: pass(LIQUID_GRID_WGSL, [sim, grid, forces, sdf, surf]),
      g2p: pass(LIQUID_G2P_WGSL, [sim, particles, grid, forces, sdf]),
    };
  }

  /**
   * The mesh colliders' distance fields in one storage buffer (at least 16 bytes), uploaded again when the list of fields
   * changes; a bigger list replaces the buffer, and the passes that bind it are made again. Fills `sdfOffsets`.
   */
  private meshFields(device: GPUDevice): void {
    const meshes = this.params.colliders.map((c) => c.mesh);
    this.sdfOffsets = [];
    let total = 0;
    for (const m of meshes) {
      this.sdfOffsets.push(total);
      total += m ? m.distances.length : 0;
    }
    if (this.sdfBuf && meshes.length === this.sdfKey.length && meshes.every((m, i) => m === this.sdfKey[i])) return;
    if (!this.sdfBuf || this.sdfBuf.size < total * 4) {
      if (this.sdfBuf) {
        this.sdfBuf.destroy();
        this.owned.splice(this.owned.indexOf(this.sdfBuf), 1);
      }
      this.sdfBuf = this.buffer(device, Math.max(16, total * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.compute = undefined;
    }
    meshes.forEach((m, i) => {
      if (m) device.queue.writeBuffer(this.sdfBuf!, this.sdfOffsets[i]! * 4, m.distances as Float32Array<ArrayBuffer>);
    });
    this.sdfKey = meshes;
  }

  /** The params of this frame, with the pointer's velocity taken from its motion over `dt` when it has none. */
  private frameParams(dt: number): ResolvedLiquidParams {
    const p = this.resolve();
    const given = this.options.pointer;
    if (p.pointer && given && given.velocity === undefined) {
      const last = this.lastPointer;
      const at = p.pointer.position;
      p.pointer.velocity =
        last && dt > 0 ? [(at[0] - last[0]) / dt, (at[1] - last[1]) / dt, (at[2] - last[2]) / dt] : [0, 0, 0];
      if (dt > 0 || !last) this.lastPointer = at;
    }
    return p;
  }

  private writeSimUniforms(device: GPUDevice, p: ResolvedLiquidParams, h: number): void {
    const u = this.simU32,
      f = this.simF32;
    const [hx, hy, hz] = p.cell;
    u.set([p.count, p.nodes, p.colliders.length, p.pointer ? 1 : 0], 0);
    u.set([p.dims[0], p.dims[1], p.dims[2], p.dims[0] * p.dims[1]], 4);
    u.set([p.cells[0], p.cells[1], p.cells[2], 0], 8);
    f.set([...p.origin, h], 12);
    f.set([hx, hy, hz, p.cellSize / h], 16);
    f.set([1 / hx, 1 / hy, 1 / hz, p.restDensity], 20);
    f.set([4 / (hx * hx), 4 / (hy * hy), 4 / (hz * hz), (h * p.speedOfSound * p.speedOfSound) / LIQUID_GAMMA], 24);
    f.set([...p.boxMin, h * p.viscosity], 28);
    f.set([...p.boxMax, Math.cbrt(hx * hy * hz)], 32);
    f.set([...p.gravity, 0], 36);
    const ptr = p.pointer;
    f.set(ptr ? [...ptr.position, ptr.radius, ...ptr.velocity, ptr.strength] : [0, 0, 0, 1, 0, 0, 0, 0], 40);
    f.set([(h * p.surfaceTension) / p.density, p.adhesion, LIQUID_ADHESION_REACH * p.cellSize, p.mixing ? 1 - Math.exp(-p.mixing * h) : 0], 48);
    for (let k = 0; k < 4; k++) {
      const kind = p.kinds[Math.min(k, p.kinds.length - 1)]!;
      f.set([kind.massRatio, h * kind.viscosity * kind.massRatio, 0, 0], 52 + k * 4);
    }
    p.colliders.forEach((c, i) => {
      const m = c.mesh;
      f.set(
        [
          ...c.position,
          c.kind,
          ...c.half,
          c.friction,
          ...c.rotation,
          ...c.velocity,
          this.sdfOffsets[i] ?? 0,
          ...c.angularVelocity,
          m ? m.resolution : 0,
          ...(m ? m.center : [0, 0, 0]),
          0,
        ],
        68 + i * 24,
      );
    });
    device.queue.writeBuffer(this.simUniform!, 0, this.simData);
  }

  /** Encodes `n` substeps of `h` seconds in one compute pass. */
  private encodeSteps(encoder: GPUCommandEncoder, device: GPUDevice, p: ResolvedLiquidParams, n: number, h: number): void {
    this.meshFields(device);
    const tension = p.surfaceTension > 0;
    if (!this.surfBuf || (tension && this.surfBuf.size < p.nodes * 16)) {
      if (this.surfBuf) {
        this.surfBuf.destroy();
        this.owned.splice(this.owned.indexOf(this.surfBuf), 1);
      }
      this.surfBuf = this.buffer(device, tension ? p.nodes * 16 : 16, GPUBufferUsage.STORAGE);
      this.compute = undefined;
    }
    if (!this.compute) this.buildPasses(device);
    const rt = this.compute!;
    this.writeSimUniforms(device, p, h);
    const particleGroups = Math.ceil(this.count / 256);
    const nodeGroups = Math.ceil(p.nodes / 256);
    const pass = encoder.beginComputePass();
    const run = ([pipeline, group]: Pass, groups: number) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(groups);
    };
    for (let s = 0; s < n; s++) {
      run(rt.clear, nodeGroups);
      run(rt.p2g, particleGroups);
      run(rt.stress, particleGroups);
      if (tension) run(rt.normals, nodeGroups);
      run(rt.grid, nodeGroups);
      run(rt.g2p, particleGroups);
    }
    pass.end();
    this.stats.steps += n;
    this.stats.dispatches = (tension ? 6 : 5) * n;
    this.forceTime += n * h;
  }

  /** Steps the CPU twin and uploads its particles (the WebGL2 layer's route). */
  private stepCompat(device: GPUDevice, p: ResolvedLiquidParams, dt: number, cap: number): void {
    const state = this.cpuState!;
    const n = stepLiquidCPU(state, p, dt, cap);
    const { h } = liquidSubsteps(p, dt, cap);
    this.stats.steps += n;
    this.stats.dispatches = 0;
    this.forces = this.decodeForces((i) => state.impulses[i]!, 6, p.colliders.length, n * h);
    this.deliver((i) => state.impulses[i]!, 6, p.colliders.length, this.links, this.links.map((l) => l.center));
    device.queue.writeBuffer(this.particleBuf!, 0, state.particles as Float32Array<ArrayBuffer>);
  }

  private simulate(c: Context): void {
    if (this.disposed) return;
    let dt = 0;
    const paused = this.options.paused === true;
    if (!paused) {
      if (!this.clocked) dt = c.delta;
      else if (this.ticked) dt = this.pendingDelta;
    }
    this.ticked = false;
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), FRAME_DELTA_CAP) : 0;
    const p = this.frameParams(dt);
    this.ensureResources(c.device);
    this.syncSurface(p);
    const { n, h } = liquidSubsteps(p, dt, p.maxSubsteps);
    this.stats.frameSubsteps = n;
    this.stats.substep = h;
    this.stats.realTime = n * h >= dt - 1e-9;
    if (!n) return;
    if (this.compat) this.stepCompat(c.device, p, dt, p.maxSubsteps);
    else {
      this.encodeSteps(c.encoder, c.device, p, n, h);
    }
  }

  /** Hides the surface while the debug view colours the particles, and gives it back after. */
  private syncSurface(p: ResolvedLiquidParams): void {
    const surface = this.surface;
    if (!surface) return;
    const hide = p.debug.enabled && p.debug.particles !== 'off';
    if (hide && this.surfaceHidden === undefined) {
      this.surfaceHidden = surface.options.enabled !== false;
      surface.options.enabled = false;
    } else if (!hide && this.surfaceHidden !== undefined) {
      surface.options.enabled = this.surfaceHidden;
      this.surfaceHidden = undefined;
    }
  }

  private writeDebugUniforms(c: Context, p: ResolvedLiquidParams): void {
    const e = c.camera.position,
      t = c.camera.target;
    let fx = t[0] - e[0],
      fy = t[1] - e[1],
      fz = t[2] - e[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    // right = forward x up(0, 1, 0), or +x looking straight up or down; up = right x forward.
    let rx = -fz,
      rz = fx;
    const rl = Math.hypot(rx, rz);
    if (rl < 1e-6) {
      rx = 1;
      rz = 0;
    } else {
      rx /= rl;
      rz /= rl;
    }
    const ux = -rz * fy,
      uy = rz * fx - rx * fz,
      uz = rx * fy;
    const encode = !c.format.includes('float') && !c.format.endsWith('-srgb');
    const u = this.debugData;
    u.set(c.camera.matrix, 0);
    u.set([rx, 0, rz, this.spacing * 0.5], 16);
    u.set([ux, uy, uz, p.debug.particles === 'density' ? 2 : p.debug.particles === 'color' ? 3 : 1], 20);
    u.set([p.debug.speedScale, 0, encode ? 1 : 0, 0], 24);
    c.device.queue.writeBuffer(this.debugUniform!, 0, u as Float32Array<ArrayBuffer>);
  }

  private pipelines(c: Context): [GPURenderPipeline, GPUBindGroup, GPURenderPipeline] {
    const depthFormat = c.descriptor.depthStencil!.format;
    const key = `${c.format}:${depthFormat}:${c.descriptor.multisample?.count ?? 1}`;
    let entry = this.debugPipelines.get(key);
    if (!entry) {
      const make = (code: string, topology: GPUPrimitiveTopology, write: boolean) => {
        const module = c.device.createShaderModule({ code });
        return c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
          primitive: { topology, cullMode: 'none' },
          multisample: c.descriptor.multisample,
          depthStencil: { format: depthFormat, depthWriteEnabled: write, depthCompare: write ? 'greater' : 'greater-equal' },
        });
      };
      const sprites = make(LIQUID_DEBUG_PARTICLES_WGSL, 'triangle-list', true);
      const group = c.device.createBindGroup({
        layout: sprites.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.debugUniform! } },
          { binding: 1, resource: { buffer: this.particleBuf! } },
        ],
      });
      entry = [sprites, group, make(LIQUID_DEBUG_LINES_WGSL, 'line-list', false)];
      this.debugPipelines.set(key, entry);
    }
    return entry;
  }

  private drawParticles(c: Context): void {
    this.stats.debugDraws = 0;
    if (this.disposed || !this.particleBuf) return;
    const p = this.params;
    if (!p.debug.enabled || p.debug.particles === 'off') return;
    this.writeDebugUniforms(c, p);
    const [pipeline, group] = this.pipelines(c);
    const depthFormat = c.descriptor.depthStencil!.format;
    this.colorAttachment.view = c.color;
    this.depthAttachment.view = c.depth;
    const stencil = depthFormat.includes('stencil');
    this.depthAttachment.stencilLoadOp = stencil ? 'load' : undefined;
    this.depthAttachment.stencilStoreOp = stencil ? 'store' : undefined;
    const pass = c.encoder.beginRenderPass(this.passDesc);
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(6, this.count);
    pass.end();
    this.stats.debugDraws++;
    if (this.engine) this.engine.stats.drawCalls++;
  }

  /** Line end points of the container, the grid on its floor and back wall, the colliders and the pointer. */
  debugLines(): Float32Array {
    const p = this.resolve();
    const d = p.debug;
    const out: number[] = [];
    const line = (a: readonly number[], b: readonly number[], color: number) => out.push(a[0]!, a[1]!, a[2]!, color, b[0]!, b[1]!, b[2]!, color);
    const [x0, y0, z0] = p.boxMin;
    const [x1, y1, z1] = p.boxMax;
    if (d.container) {
      const xs = [x0, x1],
        ys = [y0, y1],
        zs = [z0, z1];
      for (const y of ys) for (const z of zs) line([x0, y, z], [x1, y, z], 0);
      for (const x of xs) for (const z of zs) line([x, y0, z], [x, y1, z], 0);
      for (const x of xs) for (const y of ys) line([x, y, z0], [x, y, z1], 0);
    }
    if (d.grid) {
      // Every wall lies on a node, so the cells divide each side exactly.
      const ticks = (a: number) =>
        Array.from({ length: p.cells[a]! + 1 }, (_, i) => p.boxMin[a]! + (i * (p.boxMax[a]! - p.boxMin[a]!)) / p.cells[a]!);
      for (const z of ticks(2)) line([x0, y0, z], [x1, y0, z], 1);
      for (const x of ticks(0)) line([x, y0, z0], [x, y0, z1], 1);
      for (const y of ticks(1)) line([x0, y, z0], [x1, y, z0], 1);
      for (const x of ticks(0)) line([x, y0, z0], [x, y1, z0], 1);
    }
    if (d.colliders) {
      const circles = (c: LiquidVec3, r: number, color: number) => {
        const k = 32;
        for (let axis = 0; axis < 3; axis++)
          for (let i = 0; i < k; i++) {
            const point = (j: number) => {
              const a = (2 * Math.PI * j) / k;
              const q = [Math.cos(a) * r, Math.sin(a) * r];
              const v = axis === 0 ? [0, q[0]!, q[1]!] : axis === 1 ? [q[0]!, 0, q[1]!] : [q[0]!, q[1]!, 0];
              return [c[0] + v[0]!, c[1] + v[1]!, c[2] + v[2]!];
            };
            line(point(i), point(i + 1), color);
          }
      };
      for (const c of p.colliders) {
        if (c.kind === 0) {
          circles(c.position, c.half[0], 2);
          continue;
        }
        const turn = (v: readonly number[]): number[] => {
          const r = rotateVec(c.rotation, v[0]!, v[1]!, v[2]!);
          return [c.position[0] + r[0], c.position[1] + r[1], c.position[2] + r[2]];
        };
        if (c.kind === 2) {
          // The capsule: rings round both cap centres and four lines along its sides.
          const [r, hh] = c.half;
          const ends = [turn([0, -hh, 0]), turn([0, hh, 0])] as unknown as LiquidVec3[];
          for (const e of ends) circles(e, r, 2);
          for (const [x, z] of [[r, 0], [-r, 0], [0, r], [0, -r]]) line(turn([x!, -hh, z!]), turn([x!, hh, z!]), 2);
          continue;
        }
        if (c.kind === 3) {
          // The plane: a square across the container's size round its point, and its normal.
          const n = c.half;
          const t = Math.abs(n[1]) < 0.9 ? [n[2], 0, -n[0]] : [0, -n[2], n[1]];
          const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
          const u = [t[0]! / tl, t[1]! / tl, t[2]! / tl];
          const w = [n[1] * u[2]! - n[2] * u[1]!, n[2] * u[0]! - n[0] * u[2]!, n[0] * u[1]! - n[1] * u[0]!];
          const size = Math.max(x1 - x0, y1 - y0, z1 - z0) / 2;
          const at = (a: number, b: number) => c.position.map((v, i) => v + (a * u[i]! + b * w[i]!) * size);
          const quad = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
          for (let i = 0; i < 4; i++) line(quad[i]!, quad[(i + 1) % 4]!, 2);
          line(c.position, c.position.map((v, i) => v + n[i]! * size * 0.2), 2);
          continue;
        }
        // A box, or a mesh's field box round its centre.
        const mid = c.mesh ? c.mesh.center : [0, 0, 0];
        const [qx, qy, qz, qw] = c.rotation;
        const corner = (sx: number, sy: number, sz: number) => {
          const vx = mid[0]! + sx * c.half[0],
            vy = mid[1]! + sy * c.half[1],
            vz = mid[2]! + sz * c.half[2];
          const tx = qy * vz - qz * vy + qw * vx,
            ty = qz * vx - qx * vz + qw * vy,
            tz = qx * vy - qy * vx + qw * vz;
          return [
            c.position[0] + vx + 2 * (qy * tz - qz * ty),
            c.position[1] + vy + 2 * (qz * tx - qx * tz),
            c.position[2] + vz + 2 * (qx * ty - qy * tx),
          ];
        };
        for (const s of [-1, 1])
          for (const t of [-1, 1]) {
            line(corner(-1, s, t), corner(1, s, t), 2);
            line(corner(s, -1, t), corner(s, 1, t), 2);
            line(corner(s, t, -1), corner(s, t, 1), 2);
          }
      }
      if (p.pointer) circles(p.pointer.position, p.pointer.radius, 3);
    }
    return new Float32Array(out);
  }

  private drawLines(c: Context): void {
    if (this.disposed || !this.debugUniform) return;
    const p = this.params;
    const d = p.debug;
    if (!d.enabled || !(d.grid || d.container || d.colliders)) return;
    const points = this.debugLines();
    this.lineCount = points.length / 4;
    if (!this.lineCount) return;
    if (!this.lineBuf || this.lineBuf.size < points.byteLength) {
      if (this.lineBuf) {
        this.lineBuf.destroy();
        this.owned.splice(this.owned.indexOf(this.lineBuf), 1);
      }
      this.lineBuf = this.buffer(c.device, Math.max(4096, points.byteLength * 2), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.lineGroups.clear();
    }
    c.device.queue.writeBuffer(this.lineBuf, 0, points as Float32Array<ArrayBuffer>);
    this.writeDebugUniforms(c, p);
    const lines = this.pipelines(c)[2];
    let group = this.lineGroups.get(lines);
    if (!group) {
      group = c.device.createBindGroup({
        layout: lines.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.debugUniform } },
          { binding: 1, resource: { buffer: this.lineBuf } },
        ],
      });
      this.lineGroups.set(lines, group);
    }
    const depthFormat = c.descriptor.depthStencil!.format;
    this.colorAttachment.view = c.color;
    this.lineDepth.view = c.depth;
    this.lineDepth.stencilReadOnly = depthFormat.includes('stencil') ? true : undefined;
    const pass = c.encoder.beginRenderPass(this.linePassDesc);
    applyView(pass, c);
    pass.setPipeline(lines);
    pass.setBindGroup(0, group);
    pass.draw(this.lineCount);
    pass.end();
    this.stats.debugDraws++;
    if (this.engine) this.engine.stats.drawCalls++;
  }

  private release(): void {
    for (const resource of this.owned) resource.destroy();
    this.owned = [];
    this.particleBuf = this.simUniform = this.gridBuf = this.forceBuf = this.debugUniform = this.lineBuf = this.sdfBuf = this.surfBuf = undefined;
    this.sdfKey = [];
    this.pulling = undefined;
    this.forceTime = 0;
    this.compute = undefined;
    this.debugPipelines.clear();
    this.lineGroups.clear();
    this.needsInit = true;
  }

  /** Rebuilds every GPU buffer and pipeline after a device restore; the liquid starts again from its fill block. */
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.stats.steps = 0;
    this.setup(engine);
  }

  /** Releases every GPU resource, removes the surface and detaches the liquid from its engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.surface?.dispose();
    this.surface = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.links = [];
    this.cpuState = undefined;
    this.engine = undefined;
    this.device = undefined;
  }

  /** `using liquid = GPULiquid.attach(...)` disposes it at the end of the scope. */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** A linked body's collider in world space: its shape placed by the body's pose, moving with the body. */
function linkedCollider(l: LinkEntry): LiquidCollider {
  const b = l.body;
  const c = l.collider;
  if (!c || typeof c !== 'object')
    throw liquidError("GPULiquid.link collider must be a collider, for example { shape: 'box', position: [0, 0, 0] }");
  const bq = [b.rotation[0]!, b.rotation[1]!, b.rotation[2]!, b.rotation[3]!];
  const lp = c.position ?? [0, 0, 0];
  const lq = c.rotation ?? [0, 0, 0, 1];
  const off = rotateVec(bq, lp[0], lp[1], lp[2]);
  const position: [number, number, number] = [b.position[0]! + off[0], b.position[1]! + off[1], b.position[2]! + off[2]];
  const w: [number, number, number] = [b.angularVelocity[0]!, b.angularVelocity[1]!, b.angularVelocity[2]!];
  let v: [number, number, number];
  if (typeof b.velocityAtPoint === 'function') {
    const at = b.velocityAtPoint(position);
    v = [at[0]!, at[1]!, at[2]!];
  } else {
    const lv = b.linearVelocity;
    v = [lv[0]! + w[1] * off[2] - w[2] * off[1], lv[1]! + w[2] * off[0] - w[0] * off[2], lv[2]! + w[0] * off[1] - w[1] * off[0]];
  }
  // The body's turn after the shape's own: q_body * q_shape.
  const [ax, ay, az, aw] = bq as [number, number, number, number];
  const [bx, by, bz, bw] = lq;
  const rotation: [number, number, number, number] = [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
  const n = c.shape === 'plane' ? (c.normal ?? [0, 1, 0]) : undefined;
  const normal = n ? rotateVec(bq, n[0], n[1], n[2]) : undefined;
  return { ...c, position, rotation, velocity: v, angularVelocity: w, ...(normal ? { normal } : {}) };
}

/** v turned by the unit quaternion q. */
function rotateVec(q: readonly number[], vx: number, vy: number, vz: number): [number, number, number] {
  const qx = q[0]!,
    qy = q[1]!,
    qz = q[2]!,
    qw = q[3]!;
  const tx = qy * vz - qz * vy + qw * vx,
    ty = qz * vx - qx * vz + qw * vy,
    tz = qx * vy - qy * vx + qw * vz;
  return [vx + 2 * (qy * tz - qz * ty), vy + 2 * (qz * tx - qx * tz), vz + 2 * (qx * ty - qy * tx)];
}
