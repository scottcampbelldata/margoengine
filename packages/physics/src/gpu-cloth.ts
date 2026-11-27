/// <reference lib="esnext.disposable" preserve="true" />
// GPU cloth (`@margoengine/physics/gpu-cloth`): a cloth of `@margoengine/physics/soft`'s description stepped in compute on
// WebGPU, as three.js's `webgpu_compute_cloth` does with Verlet in compute, and drawn straight from the GPU buffer it writes
// (`drawGPUCloth` of `@margoengine/gltf/soft-mesh`), so the drawing costs no readback or upload. Pinned to points and to
// rigid bodies; meets spheres, capsules, boxes, planes and meshes (as signed distance fields) on or off bodies; wind, gravity,
// stretch, shear and bend compliance. On the WebGL2 compatibility layer, and with no engine at all, its CPU twin
// (gpu-cloth-sim.ts) runs the same passes. Sources: docs/clean-room.md, "GPU cloth".
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import type { Vec3 } from '@margoengine/math';
import { compatTier } from '../../shared/compat.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { PhysicsBody } from './body.js';
import type { DebugLines } from './debug.js';
import {
  CLOTH_COLLIDE_WGSL,
  CLOTH_EDGES_WGSL,
  CLOTH_INTEGRATE_WGSL,
  CLOTH_NORMALS_WGSL,
  CLOTH_PIN_WGSL,
  CLOTH_SURFACE_WGSL,
  CLOTH_TETHER_WGSL,
} from './gpu-cloth-shaders.js';
import {
  buildClothTethers,
  buildClothTopology,
  ClothCollider,
  clothDebugLines,
  clothError,
  clothStateHash,
  GPU_CLOTH_COLLIDER_FLOATS,
  GPU_CLOTH_FRAME_SUBSTEPS,
  GPU_CLOTH_SLOT_FLOATS,
  GPU_CLOTH_VERTEX_FLOATS,
  MAX_GPU_CLOTH_COLLIDERS,
  packClothFrame,
  pinPoint,
  resolveClothParams,
  rotate,
  type ClothFrame,
  type ClothPin,
  type ClothTopology,
  type ResolvedClothParams,
  type GPUClothColliderDesc,
  type GPUClothDebugOptions,
  type GPUClothOptions,
  type GPUClothSnapshot,
  type GPUClothStats,
} from './gpu-cloth-sim.js';
import type { SoftBodyDesc } from './soft.js';
import { ClothKernel, loadClothKernel, type ClothWork } from './cloth/kernel.js';

export {
  ClothCollider,
  clothStateHash,
  GPU_CLOTH_FRAME_SUBSTEPS,
  GPU_CLOTH_VERTEX_FLOATS,
  MAX_GPU_CLOTH_COLLIDERS,
  MAX_GPU_CLOTH_DEGREE,
  MAX_GPU_CLOTH_PARTICLES,
  MAX_GPU_CLOTH_SUBSTEPS,
} from './gpu-cloth-sim.js';
export type {
  GPUClothColliderDesc,
  GPUClothDebugOptions,
  GPUClothOptions,
  GPUClothSDF,
  GPUClothShape,
  GPUClothSnapshot,
  GPUClothStats,
} from './gpu-cloth-sim.js';

/** Settings fixed at construction, beside the live {@link GPUClothOptions}. */
export interface GPUClothCreateOptions extends GPUClothOptions {
  /** The rigid world whose gravity the cloth takes by default (its bodies can carry pins and colliders anyway). */
  physics?: { readonly gravity: Vec3 } | null;
  /** Texture coordinates, two a particle (default: the grid of a `cloth` or `clothAnisotropic`, else the rest shape laid flat). */
  uvs?: ArrayLike<number>;
  /** Colliders to add at once, as {@link GPUCloth.addCollider} takes them (default none). */
  colliders?: readonly GPUClothColliderDesc[];
}

type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
  VERTEX: number;
};
declare const GPUMapMode: { READ: number };
declare const GPUShaderStage: { COMPUTE: number };

/** Longest frame delta a frame advances the cloth by, seconds. */
const FRAME_DELTA_CAP = 0.25;
let nextClothId = 0;

interface Runtime {
  device: GPUDevice;
  owned: GPUBuffer[];
  slots: GPUBuffer;
  state: GPUBuffer;
  normals: GPUBuffer;
  pins: GPUBuffer;
  tethers: GPUBuffer;
  shapes: GPUBuffer;
  sdf: GPUBuffer;
  sdfVersion: number;
  vertices: GPUBuffer;
  slotLayout: GPUBindGroupLayout;
  slotGroups: GPUBindGroup[];
  integrate: [GPUComputePipeline, GPUBindGroup];
  normalsPass: [GPUComputePipeline, GPUBindGroup];
  pin: [GPUComputePipeline, GPUBindGroup];
  edges: [GPUComputePipeline, GPUBindGroup[]];
  collide: [GPUComputePipeline, GPUBindGroup];
  tether: [GPUComputePipeline, GPUBindGroup];
  surface: [GPUComputePipeline, GPUBindGroup];
  collideLayout: GPUBindGroupLayout;
}

/**
 * A cloth stepped on the GPU (`@margoengine/physics/gpu-cloth`), an engine plugin. Build it from a
 * {@link SoftBodyDesc} with triangles (`SoftBodyDesc.cloth`, `clothAnisotropic` or `trimesh`): its particles, masses
 * (the fabric's areal density by default), pins, edges and bend edges, linear damping, gravity scale and particle radius.
 * Each substep is a few compute passes (integrate, pins, one per edge colour, tethers, colliders) with no atomics, so a run repeats
 * to the bit on one GPU and driver, also after `snapshot` and `restore`; once a frame a surface pass writes the draw
 * vertices that `drawGPUCloth` (`@margoengine/gltf/soft-mesh`) draws with no readback. On the WebGL2 compatibility layer,
 * and before it is attached, its CPU twin runs the same passes (`stats.backend`). Bad input throws a coded `MargoError`
 * linking margoengine.com/errors#gpu-cloth.
 */
export class GPUCloth implements EnginePlugin {
  /** Unique plugin name. */
  readonly name: string;
  /** Updates after the plugins that are not late, and after `Physics` when attached after it, so pins and colliders on bodies read this frame's step. */
  readonly late = true;
  /** Live settings; any field can change between frames. */
  readonly options: GPUClothOptions;
  /** Particles. */
  readonly count: number;
  /** Three particle indices a triangle, as the description's. */
  readonly indices: Uint32Array;
  /** Live statistics. */
  readonly stats: GPUClothStats;
  /**
   * The draw vertices on the CPU ({@link GPU_CLOTH_VERTEX_FLOATS} floats a particle, gltf PBR layout), updated each step
   * on the CPU routes; on the WebGPU route they stay those of the rest shape (the GPU holds the live ones, `vertexBuffer`).
   */
  readonly vertices: Float32Array;
  /** Counts the CPU steps whose `vertices` changed, so a drawer uploads only when it moves. */
  revision = 0;

  private readonly topology: ClothTopology;
  private readonly world: { readonly gravity: Vec3 } | null;
  /** Particles, velocities, predictions and normals, four floats each: the CPU state, or the last read back from the GPU. */
  private readonly mirror: Float32Array;
  private readonly pins = new Map<number, ClothPin>();
  private readonly shapes: ClothCollider[] = [];
  private sdfData = new Float32Array(1);
  private sdfDirty = true;
  private sdfVersion = 0;
  private dirtyMass = new Set<number>();
  /** Each particle's nearest pin along the cloth and the rest distance to it, rebuilt when the pins change. */
  private tethers: Uint32Array | null = null;
  private tethersUploaded = false;
  private time = 0;
  private pending = 0;
  private frame: { frame: ClothFrame; steps: number } | null = null;
  private engine?: Engine;
  private runtime?: Runtime;
  private compat = false;
  private disposed = false;
  private needsUpload = true;
  private reading: Promise<void> | null = null;
  /** The Rust kernel of the CPU routes (also the rest shape's surface on every route). */
  private readonly kernel: ClothKernel;

  /**
   * A cloth from `desc`, stepped on the CPU until it is attached (`engine.use(cloth)` or {@link GPUCloth.attach}).
   * @throws MargoError (`unsupported`) for a description without triangles, a tube, a particle with more than 16 edges,
   * or a setting out of range.
   */
  constructor(desc: SoftBodyDesc, options: GPUClothCreateOptions = {}) {
    if (!options || typeof options !== 'object') throw clothError('GPUCloth options must be an object.');
    const { physics = null, uvs, colliders = [], ...live } = options;
    if (!Array.isArray(colliders)) throw clothError('GPUCloth colliders must be an array of collider descriptions.');
    if (physics !== null && !Array.isArray((physics as { gravity?: unknown }).gravity))
      throw clothError('GPUCloth physics must be a Physics world of @margoengine/physics.');
    this.topology = buildClothTopology(desc, uvs);
    this.world = physics;
    this.options = live;
    const t = this.topology,
      N = t.count;
    resolveClothParams(this.options, t, physics?.gravity, 0);
    this.count = N;
    this.indices = t.triangles;
    this.name = `physics:gpu-cloth:${++nextClothId}`;
    this.mirror = new Float32Array(N * 16);
    for (let i = 0; i < N; i++) {
      this.mirror.set(t.rest.subarray(i * 3, i * 3 + 3), i * 4);
      this.mirror.set(t.rest.subarray(i * 3, i * 3 + 3), (2 * N + i) * 4);
      this.mirror[i * 4 + 3] = 1 / t.masses[i]!;
      this.mirror[(3 * N + i) * 4 + 3] = t.area[i]!;
    }
    for (const i of (desc as unknown as { pinned?: Set<number> }).pinned ?? [])
      if (i < N) this.pinAt(i, [t.rest[i * 3]!, t.rest[i * 3 + 1]!, t.rest[i * 3 + 2]!], null);
    this.vertices = new Float32Array(N * GPU_CLOTH_VERTEX_FLOATS);
    this.kernel = new ClothKernel(t);
    // Normals and draw vertices of the rest shape, so the first step's drag and the first frame have them.
    this.kernel.surface(this.mirror.subarray(0, 12 * N), this.mirror.subarray(12 * N), this.vertices, true);
    this.stats = {
      backend: 'cpu',
      steps: 0,
      colors: t.colors.length,
      count: N,
      work: { substeps: 0, particles: 0, edges: 0, colliderTests: 0 },
    };
    for (const c of colliders) this.addCollider(c);
  }

  /**
   * Loads the CPU route's kernel (`cloth-kernel.wasm`, Rust with SIMD) once; call it before the first `new GPUCloth`, as
   * `await Physics.load()` before a world. Later calls return at once.
   */
  static async load(signal?: AbortSignal): Promise<void> {
    await loadClothKernel(signal);
  }

  /** Creates a cloth and attaches it to `engine`. Attach it after the `Physics` whose bodies carry its pins or colliders. */
  static attach(engine: EngineKernel, desc: SoftBodyDesc, options?: GPUClothCreateOptions): GPUCloth {
    const cloth = new GPUCloth(desc, options);
    engineRuntime(engine).use(cloth);
    return cloth;
  }

  private live(action: string): void {
    if (this.disposed) throw clothError(`GPUCloth.${action} cannot run after dispose(); make a new GPUCloth.`, 'disposed');
  }
  private index(i: number, action: string): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.count)
      throw clothError(`GPUCloth.${action} takes a particle index from 0 to ${this.count - 1}, not ${String(i)}.`);
    return i;
  }
  /** The mean of the particles where the cloth last had them: where a flow-field wind is sampled. */
  private centre(): Vec3 {
    let x = 0,
      y = 0,
      z = 0;
    for (let i = 0; i < this.count; i++) {
      x += this.mirror[i * 4]!;
      y += this.mirror[i * 4 + 1]!;
      z += this.mirror[i * 4 + 2]!;
    }
    return [x / this.count, y / this.count, z / this.count];
  }
  /** Where the cloth last had particle `i`: the CPU state, or on the WebGPU route the last read back (the rest shape before one). */
  private known(i: number): Vec3 {
    return [this.mirror[i * 4]!, this.mirror[i * 4 + 1]!, this.mirror[i * 4 + 2]!];
  }
  private pinAt(i: number, local: Vec3, body: PhysicsBody | null): void {
    const pin: ClothPin = { index: i, point: local, body, from: [0, 0, 0] };
    pin.from = pinPoint(pin);
    this.pins.delete(i);
    this.pins.set(i, pin);
    this.mirror[i * 4 + 3] = 0;
    this.dirtyMass.add(i);
    this.tethers = null;
  }
  private tetherTable(): Uint32Array {
    if (!this.tethers) {
      this.tethers = buildClothTethers(this.topology, this.pins.keys());
      this.tethersUploaded = false;
    }
    return this.tethers;
  }

  /**
   * Holds particle `index` at `point` in the world (default: where the cloth last had it). Setting it again moves the pin
   * over the next step.
   */
  pin(index: number, point?: Vec3): this {
    this.live('pin');
    const i = this.index(index, 'pin');
    const p = point === undefined ? this.known(i) : point;
    if (!p || p.length !== 3 || !p.every(Number.isFinite)) throw clothError('GPUCloth.pin point must be [x, y, z], finite.');
    const old = this.pins.get(i);
    this.pinAt(i, [p[0], p[1], p[2]], null);
    if (old && !old.body) this.pins.get(i)!.from = old.from;
    return this;
  }

  /**
   * Ties particle `index` to `body` at `point` (world, default where the cloth last had it): the body carries the particle
   * every frame, read after the physics step. The tie is one way: the body does not feel the cloth's pull (the CPU cloth's
   * `attachParticle` is two way).
   */
  attach(index: number, body: PhysicsBody, point?: Vec3): this {
    this.live('attach');
    const i = this.index(index, 'attach');
    if (!body || typeof body !== 'object' || !Array.isArray(body.position))
      throw clothError('GPUCloth.attach takes a PhysicsBody of @margoengine/physics.');
    if (!body.valid) throw clothError('GPUCloth.attach was given a removed body.', 'state');
    const p = point === undefined ? this.known(i) : point;
    if (!p || p.length !== 3 || !p.every(Number.isFinite)) throw clothError('GPUCloth.attach point must be [x, y, z], finite.');
    const x = body.position,
      q = body.rotation;
    this.pinAt(i, rotate([-q[0], -q[1], -q[2], q[3]], [p[0] - x[0], p[1] - x[1], p[2] - x[2]]), body);
    return this;
  }

  /** Lets particle `index` go (a pin or a tie to a body). */
  unpin(index: number): this {
    this.live('unpin');
    const i = this.index(index, 'unpin');
    if (!this.pins.delete(i)) return this;
    this.mirror[i * 4 + 3] = 1 / this.topology.masses[i]!;
    this.dirtyMass.add(i);
    this.tethers = null;
    return this;
  }

  /** The pinned or tied particles, in the order they were pinned. */
  get pinned(): number[] {
    return [...this.pins.keys()];
  }

  /** Adds a collider (up to 32): a sphere, capsule, box, plane or sdf, in the world or on a body. Returns it; `remove()` takes it away. */
  addCollider(desc: GPUClothColliderDesc): ClothCollider {
    this.live('addCollider');
    if (this.shapes.length >= MAX_GPU_CLOTH_COLLIDERS)
      throw clothError(`GPUCloth meets at most ${MAX_GPU_CLOTH_COLLIDERS} colliders; remove one first.`);
    const c = new ClothCollider(desc);
    c.from = c.pose();
    c.onRemove = () => {
      const at = this.shapes.indexOf(c);
      if (at >= 0) this.shapes.splice(at, 1);
      if (c.shape === 'sdf') this.sdfDirty = true;
    };
    this.shapes.push(c);
    if (c.shape === 'sdf') this.sdfDirty = true;
    return c;
  }

  /** The colliders, in the order they are met. */
  get colliders(): readonly ClothCollider[] {
    return this.shapes;
  }

  /** Every sdf collider's samples end to end, in collider order (rebuilt when one is added or removed). */
  private sdf(): Float32Array {
    if (this.sdfDirty) {
      const parts = this.shapes.flatMap((c) => (c.desc.shape === 'sdf' ? [c.desc.sdf.data] : []));
      const data = new Float32Array(Math.max(1, parts.reduce((n, p) => n + p.length, 0)));
      let at = 0;
      for (const p of parts) {
        data.set(p, at);
        at += p.length;
      }
      this.sdfData = data;
      this.sdfDirty = false;
      this.sdfVersion++;
    }
    return this.sdfData;
  }

  /** Packs `steps` steps from the poses now and moves every pin's and collider's start to its pose now. */
  private plan(steps: number, params: ResolvedClothParams): ClothFrame {
    const pins = [...this.pins.values()];
    const frame = packClothFrame(params, this.count, steps, this.time, pins, this.shapes, this.sdf());
    for (const pin of pins) pin.from = pinPoint(pin);
    for (const c of this.shapes) c.from = c.pose();
    for (let k = 0; k < steps; k++) this.time += params.timestep;
    return frame;
  }

  private runCPU(frame: ClothFrame, steps: number): void {
    const N = this.count;
    const work: ClothWork = this.kernel.step(
      this.mirror.subarray(0, 12 * N),
      this.mirror.subarray(12 * N),
      this.vertices,
      frame,
      frame.tethers ? this.tetherTable() : undefined,
    );
    const total = this.stats.work;
    total.substeps += work.substeps;
    total.particles += work.particles;
    total.edges += work.edges;
    total.colliderTests += work.colliderTests;
    this.stats.steps += steps;
    this.revision++;
  }

  /**
   * Steps the cloth `steps` fixed steps now (default 1), also while `paused`: on the GPU in a submission of its own, or on
   * the CPU twin. Pins and colliders move to where they are now over these steps.
   */
  step(steps = 1): void {
    this.live('step');
    if (!Number.isInteger(steps) || steps < 1 || steps > 1000)
      throw clothError(`GPUCloth.step takes a whole number of steps from 1 to 1000, not ${String(steps)}.`);
    for (let done = 0; done < steps; ) {
      const params = resolveClothParams(this.options, this.topology, this.world?.gravity, this.time, this.centre());
      const n = Math.min(steps - done, Math.max(1, Math.floor(GPU_CLOTH_FRAME_SUBSTEPS / params.substeps)));
      const frame = this.plan(n, params);
      const rt = this.runtime;
      if (rt && !this.compat) {
        const encoder = rt.device.createCommandEncoder();
        this.encode(rt, encoder, frame);
        rt.device.queue.submit([encoder.finish()]);
        this.stats.steps += n;
      } else this.runCPU(frame, n);
      done += n;
    }
  }

  /**
   * The particles as the cloth last had them: x, y, z each, into `out` when given. Exact on the CPU routes; on the WebGPU
   * route the last read back (`readPositions`, `snapshot` or the debug lines), the rest shape before one.
   */
  positions(out = new Float32Array(this.count * 3)): Float32Array {
    if (!(out instanceof Float32Array) || out.length < this.count * 3)
      throw clothError(`GPUCloth.positions needs a Float32Array of at least ${this.count * 3} floats.`);
    for (let i = 0; i < this.count; i++) {
      out[i * 3] = this.mirror[i * 4]!;
      out[i * 3 + 1] = this.mirror[i * 4 + 1]!;
      out[i * 3 + 2] = this.mirror[i * 4 + 2]!;
    }
    return out;
  }

  /** Reads the particles back from the GPU (at once on the CPU routes) and returns them as {@link GPUCloth.positions} does. */
  async readPositions(): Promise<Float32Array> {
    this.live('readPositions');
    await this.readBack();
    return this.positions();
  }

  private async readBack(): Promise<void> {
    const rt = this.runtime;
    if (!rt || this.compat) return;
    const bytes = this.mirror.byteLength;
    const staging = rt.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = rt.device.createCommandEncoder();
      // Pending uploads first (a cloth not yet stepped on the GPU holds its state on the CPU only).
      this.encode(rt, encoder);
      encoder.copyBufferToBuffer(rt.state, 0, staging, 0, this.count * 48);
      encoder.copyBufferToBuffer(rt.normals, 0, staging, this.count * 48, this.count * 16);
      rt.device.queue.submit([encoder.finish()]);
      try {
        await staging.mapAsync(GPUMapMode.READ);
      } catch (error) {
        // Disposed, or the device lost and rebuilt, while the read was in flight: there is nothing left to read into.
        if (this.runtime !== rt) return;
        throw error;
      }
      if (this.runtime === rt) this.mirror.set(new Float32Array(staging.getMappedRange()));
    } finally {
      staging.destroy();
    }
  }

  /** Copies the cloth's state (read back from the GPU on that route). `restore` puts it back; `clothStateHash(s.state)` compares two. */
  async snapshot(): Promise<GPUClothSnapshot> {
    this.live('snapshot');
    await this.readBack();
    return { count: this.count, steps: this.stats.steps, time: this.time, state: this.mirror.slice() };
  }

  /** The state's hash after a read back: equal for two runs that did the same. */
  async hash(): Promise<string> {
    return clothStateHash((await this.snapshot()).state);
  }

  /**
   * Puts the cloth back to a `snapshot` of a cloth of as many particles; the steps after it repeat exactly when the pins
   * and colliders do. The pins in force now are kept. Checks the whole snapshot before it writes anything.
   */
  restore(snapshot: GPUClothSnapshot): void {
    this.live('restore');
    const N = this.count;
    if (
      !snapshot ||
      snapshot.count !== N ||
      !(snapshot.state instanceof Float32Array) ||
      snapshot.state.length !== N * 16 ||
      !Number.isSafeInteger(snapshot.steps) ||
      snapshot.steps < 0 ||
      !Number.isFinite(snapshot.time)
    )
      throw clothError(`GPUCloth.restore takes a snapshot of a cloth of ${N} particles, from cloth.snapshot().`);
    const s = snapshot.state;
    for (let i = 0; i < s.length; i++) if (!Number.isFinite(s[i])) throw clothError(`GPUCloth.restore: snapshot value ${i} is not finite.`);
    this.mirror.set(s);
    for (let i = 0; i < N; i++) this.mirror[i * 4 + 3] = this.pins.has(i) ? 0 : 1 / this.topology.masses[i]!;
    this.stats.steps = snapshot.steps;
    this.time = snapshot.time;
    this.pending = 0;
    // The draw vertices of the restored shape; the snapshot's own normals stay (a copy takes the recomputed ones).
    this.kernel.surface(this.mirror.subarray(0, 12 * N), this.mirror.slice(12 * N), this.vertices, false);
    this.revision++;
    this.needsUpload = true;
  }

  /**
   * The cloth's debug lines (`{vertices, colors}`, as `physics.debugRender`): edges by strain, pins, colliders, normals and
   * the wind. Pass the cloth to `PhysicsDebugView.add`. On the WebGPU route it reads the particles back once a frame, so
   * the lines trail the picture by a frame or two.
   */
  debugRender(options?: GPUClothDebugOptions): DebugLines {
    this.live('debugRender');
    if (this.runtime && !this.compat && !this.reading)
      this.reading = this.readBack().finally(() => (this.reading = null));
    const params = resolveClothParams(this.options, this.topology, this.world?.gravity, this.time, this.centre());
    const N = this.count;
    return clothDebugLines(
      this.mirror.subarray(0, N * 4),
      this.mirror.subarray(12 * N),
      this.topology,
      [...this.pins.values()],
      this.shapes,
      params.wind,
      options,
    );
  }

  /** The GPU buffer of draw vertices on the WebGPU route (storage and vertex usage), for `drawGPUCloth`; undefined otherwise. */
  get vertexBuffer(): GPUBuffer | undefined {
    return this.compat ? undefined : this.runtime?.vertices;
  }

  /** @internal Engine plugin hook: checks WebGPU and picks the route. */
  setup(engine: Engine): void {
    this.live('setup');
    requireWebGPU(engine, 'GPUCloth');
    const device = engine.gpu!;
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (this.count * GPU_CLOTH_VERTEX_FLOATS * 4 > limit || Math.ceil(this.count / 64) > device.limits.maxComputeWorkgroupsPerDimension)
      throw clothError(`GPUCloth of ${this.count} particles is more than this device holds; use fewer particles.`);
    this.engine = engine;
    this.compat = compatTier(device) === 'webgl2';
    this.stats.backend = this.compat ? 'webgl2-compat' : 'webgpu';
    if (!this.compat) this.build(device);
  }

  /** @internal Registers the step on the frame graph, before the draws. */
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: -10, execute: (c) => c.backend === 'webgpu' && this.simulate(c) });
  }

  /** @internal Each frame, after the physics step: reads the pins' and colliders' poses and plans the frame's steps. */
  onPreUpdate(delta: number): void {
    if (this.disposed) return;
    const params = resolveClothParams(this.options, this.topology, this.world?.gravity, this.time, this.centre());
    if (params.paused || !(delta > 0)) return;
    this.pending += Math.min(delta, FRAME_DELTA_CAP);
    const most = Math.max(1, Math.floor(GPU_CLOTH_FRAME_SUBSTEPS / params.substeps));
    let steps = Math.floor(this.pending / params.timestep + 1e-9);
    if (steps > most) {
      steps = most;
      this.pending = 0;
    } else this.pending -= steps * params.timestep;
    if (steps === 0) return;
    const frame = this.plan(steps, params);
    if (this.compat || !this.runtime) this.runCPU(frame, steps);
    else this.frame = { frame, steps };
  }

  private simulate(c: Context): void {
    const rt = this.runtime;
    if (this.disposed || !rt || this.compat) return;
    const planned = this.frame;
    this.frame = null;
    if (!planned && !this.needsUpload && this.dirtyMass.size === 0) return;
    this.encode(rt, c.encoder, planned?.frame);
    if (planned) this.stats.steps += planned.steps;
  }

  private build(device: GPUDevice): void {
    const t = this.topology,
      N = this.count,
      owned: GPUBuffer[] = [];
    const buffer = (size: number, usage: number, data?: ArrayBufferView): GPUBuffer => {
      const b = device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
      owned.push(b);
      if (data) device.queue.writeBuffer(b, 0, data as Uint8Array<ArrayBuffer>);
      return b;
    };
    const S = GPUBufferUsage.STORAGE;
    const slots = buffer(GPU_CLOTH_FRAME_SUBSTEPS * GPU_CLOTH_SLOT_FLOATS * 4, GPUBufferUsage.UNIFORM);
    const state = buffer(N * 48, S | GPUBufferUsage.COPY_SRC);
    const normals = buffer(N * 16, S | GPUBufferUsage.COPY_SRC);
    const pins = buffer(N * 32, S);
    const tethers = buffer(N * 8, S);
    const shapes = buffer(MAX_GPU_CLOTH_COLLIDERS * GPU_CLOTH_COLLIDER_FLOATS * 4, S);
    const edges = buffer(t.edges.byteLength, S, t.edges);
    const adjacency = buffer(t.adjacency.byteLength, S, t.adjacency);
    const triangles = buffer(t.triangles.byteLength, S, t.triangles);
    const uvs = buffer(t.uvs.byteLength, S, t.uvs);
    const vertices = buffer(N * GPU_CLOTH_VERTEX_FLOATS * 4, S | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC, this.vertices);
    const sdfData = this.sdf();
    const sdf = buffer(sdfData.byteLength, S, sdfData);

    const C = GPUShaderStage.COMPUTE;
    const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type },
    });
    const slotLayout = device.createBindGroupLayout({ entries: [entry(0, 'uniform')] });
    const pipeline = (code: string, types: GPUBufferBindingType[]): [GPUComputePipeline, GPUBindGroupLayout] => {
      const layout = device.createBindGroupLayout({ entries: types.map((type, i) => entry(i, type)) });
      const p = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [slotLayout, layout] }),
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      });
      return [p, layout];
    };
    const group = (layout: GPUBindGroupLayout, entries: GPUBufferBinding[]): GPUBindGroup =>
      device.createBindGroup({ layout, entries: entries.map((resource, binding) => ({ binding, resource })) });
    const RW: GPUBufferBindingType = 'storage',
      RO: GPUBufferBindingType = 'read-only-storage';
    const [integrateP, integrateL] = pipeline(CLOTH_INTEGRATE_WGSL, [RW, RO]);
    const [normalsP, normalsL] = pipeline(CLOTH_NORMALS_WGSL, [RO, RW, RO, RO]);
    const [pinP, pinL] = pipeline(CLOTH_PIN_WGSL, [RW, RO]);
    const [edgesP, edgesL] = pipeline(CLOTH_EDGES_WGSL, [RW, RO]);
    const [collideP, collideL] = pipeline(CLOTH_COLLIDE_WGSL, [RW, RO, RO]);
    const [tetherP, tetherL] = pipeline(CLOTH_TETHER_WGSL, [RW, RO]);
    const [surfaceP, surfaceL] = pipeline(CLOTH_SURFACE_WGSL, [RO, RW, RO, RO, RO, RW]);
    this.runtime = {
      device,
      owned,
      slots,
      state,
      normals,
      pins,
      tethers,
      shapes,
      sdf,
      sdfVersion: this.sdfVersion,
      vertices,
      slotLayout,
      slotGroups: [],
      collideLayout: collideL,
      integrate: [integrateP, group(integrateL, [{ buffer: state }, { buffer: normals }])],
      normalsPass: [
        normalsP,
        group(normalsL, [{ buffer: state }, { buffer: normals }, { buffer: adjacency }, { buffer: triangles }]),
      ],
      pin: [pinP, group(pinL, [{ buffer: state }, { buffer: pins }])],
      edges: [
        edgesP,
        t.colors.map(([start, n]) => group(edgesL, [{ buffer: state }, { buffer: edges, offset: start * 16, size: n * 16 }])),
      ],
      collide: [collideP, group(collideL, [{ buffer: state }, { buffer: shapes }, { buffer: sdf }])],
      tether: [tetherP, group(tetherL, [{ buffer: state }, { buffer: tethers }])],
      surface: [
        surfaceP,
        group(surfaceL, [{ buffer: state }, { buffer: normals }, { buffer: adjacency }, { buffer: triangles }, { buffer: uvs }, { buffer: vertices }]),
      ],
    };
    this.needsUpload = true;
    this.tethersUploaded = false;
  }

  /** Encodes one frame's substeps and a surface pass after each step (or only the pending uploads). */
  private encode(rt: Runtime, encoder: GPUCommandEncoder, frame?: ClothFrame): void {
    const q = rt.device.queue,
      N = this.count;
    if (this.needsUpload) {
      q.writeBuffer(rt.state, 0, this.mirror as Float32Array<ArrayBuffer>, 0, N * 12);
      q.writeBuffer(rt.normals, 0, this.mirror as Float32Array<ArrayBuffer>, N * 12, N * 4);
      q.writeBuffer(rt.vertices, 0, this.vertices as Float32Array<ArrayBuffer>);
      this.needsUpload = false;
      this.dirtyMass.clear();
    }
    for (const i of this.dirtyMass) q.writeBuffer(rt.state, i * 16 + 12, this.mirror as Float32Array<ArrayBuffer>, i * 4 + 3, 1);
    this.dirtyMass.clear();
    if (!frame || frame.slotCount === 0) return;
    if (rt.sdfVersion !== this.sdfVersion) {
      if (frame.sdf.byteLength > rt.sdf.size) {
        rt.sdf.destroy();
        rt.owned.splice(rt.owned.indexOf(rt.sdf), 1);
        rt.sdf = rt.device.createBuffer({ size: frame.sdf.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        rt.owned.push(rt.sdf);
        rt.collide[1] = rt.device.createBindGroup({
          layout: rt.collideLayout,
          entries: [rt.state, rt.shapes, rt.sdf].map((buffer, binding) => ({ binding, resource: { buffer } })),
        });
      }
      q.writeBuffer(rt.sdf, 0, frame.sdf as Float32Array<ArrayBuffer>);
      rt.sdfVersion = this.sdfVersion;
    }
    if (frame.tethers && (!this.tethers || !this.tethersUploaded)) {
      q.writeBuffer(rt.tethers, 0, this.tetherTable() as Uint32Array<ArrayBuffer>);
      this.tethersUploaded = true;
    }
    q.writeBuffer(rt.slots, 0, frame.slots as Float32Array<ArrayBuffer>, 0, frame.slotCount * GPU_CLOTH_SLOT_FLOATS);
    if (frame.pinCount) q.writeBuffer(rt.pins, 0, frame.pins as Float32Array<ArrayBuffer>, 0, frame.pinCount * 8);
    if (frame.colliderCount)
      q.writeBuffer(rt.shapes, 0, frame.colliders as Float32Array<ArrayBuffer>, 0, frame.colliderCount * GPU_CLOTH_COLLIDER_FLOATS);
    while (rt.slotGroups.length < frame.slotCount)
      rt.slotGroups.push(
        rt.device.createBindGroup({
          layout: rt.slotLayout,
          entries: [{ binding: 0, resource: { buffer: rt.slots, offset: rt.slotGroups.length * 256, size: 256 } }],
        }),
      );
    const groups = Math.ceil(N / 64),
      drag = frame.slots[12]! > 0;
    const pass = encoder.beginComputePass();
    try {
      for (let s = 0; s < frame.slotCount; s++) {
        pass.setBindGroup(0, rt.slotGroups[s]!);
        if (drag) {
          pass.setPipeline(rt.normalsPass[0]);
          pass.setBindGroup(1, rt.normalsPass[1]);
          pass.dispatchWorkgroups(groups);
        }
        pass.setPipeline(rt.integrate[0]);
        pass.setBindGroup(1, rt.integrate[1]);
        pass.dispatchWorkgroups(groups);
        if (frame.pinCount) {
          pass.setPipeline(rt.pin[0]);
          pass.setBindGroup(1, rt.pin[1]);
          pass.dispatchWorkgroups(Math.ceil(frame.pinCount / 64));
        }
        pass.setPipeline(rt.edges[0]);
        for (let c = 0; c < this.topology.colors.length; c++) {
          pass.setBindGroup(1, rt.edges[1][c]!);
          pass.dispatchWorkgroups(Math.ceil(this.topology.colors[c]![1] / 64));
        }
        if (frame.tethers) {
          pass.setPipeline(rt.tether[0]);
          pass.setBindGroup(1, rt.tether[1]);
          pass.dispatchWorkgroups(groups);
        }
        if (frame.colliderCount) {
          pass.setPipeline(rt.collide[0]);
          pass.setBindGroup(1, rt.collide[1]);
          pass.dispatchWorkgroups(groups);
        }
        if ((s + 1) % frame.substeps === 0) {
          // The surface at the end of each step: the next step's drag reads its normals.
          pass.setPipeline(rt.surface[0]);
          pass.setBindGroup(1, rt.surface[1]);
          pass.dispatchWorkgroups(groups);
        }
      }
    } finally {
      pass.end();
    }
  }

  private release(): void {
    for (const b of this.runtime?.owned ?? []) b.destroy();
    this.runtime = undefined;
    this.frame = null;
  }

  /** @internal Rebuilds the GPU buffers after a device restore; the cloth goes on from the last state read back. */
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  /** Frees the GPU buffers and leaves the engine. Safe to call twice; `using` works. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
