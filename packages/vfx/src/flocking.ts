/// <reference lib="esnext.disposable" preserve="true" />
// GPU flocking (`@margoengine/vfx/flocking`): Reynolds (1987) separation, alignment and cohesion with a vision cone,
// predators, attractors, obstacles and bounds, stepped on WebGPU by a counting sort into spatial-hash buckets (Green
// 2010, Hoetzlein 2014) and drawn as one instanced draw of bird or fish meshes. On the WebGL2 compatibility layer the
// same steps run on the CPU (flocking-sim.ts) and the same draw shows them. Sources: docs/clean-room.md, "GPU flocking".
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { reportBackend } from '../../shared/compat.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { applyView } from '../../shared/view-rect.js';
import {
  FLOCK_ADD_OFFSETS_WGSL,
  FLOCK_CLEAR_WGSL,
  FLOCK_COUNT_WGSL,
  FLOCK_DEBUG_VERTEX_COUNT,
  FLOCK_DEBUG_WGSL,
  FLOCK_RANK_WGSL,
  FLOCK_RENDER_WGSL,
  FLOCK_SCAN_BLOCKS_WGSL,
  FLOCK_SCAN_SUMS_WGSL,
  FLOCK_SCATTER_WGSL,
  FLOCK_SIM_FLOATS,
  FLOCK_STEP_WGSL,
  FLOCK_VELOCITY_WGSL,
} from './flocking-shaders.js';
import {
  createFishGeometry,
  createBirdGeometry,
  createFlockState,
  FLOCK_BOID_FLOATS,
  flockError,
  flockSubsteps,
  gridCellsForCount,
  MAX_FLOCK_BOIDS,
  packFlockGeometry,
  resolveFlockParams,
  stepFlockCPU,
  type FlockAttractor,
  type FlockDebugOptions,
  type FlockGeometry,
  type FlockInterleavedGeometry,
  type FlockObstacle,
  type FlockPredator,
  type FlockPreset,
  type FlockSimulationState,
  type FlockSnapshot,
  type FlockStats,
  type GPUFlockOptions,
  type ResolvedFlockParams,
} from './flocking-sim.js';

export {
  createBirdGeometry,
  createFishGeometry,
  createFlockState,
  DEFAULT_FLOCK_OPTIONS,
  FLOCK_BOID_FLOATS,
  FLOCK_MAX_STEP,
  FLOCK_MAX_SUBSTEP,
  flockStateHash,
  gridCellsForCount,
  hashCell,
  MAX_FLOCK_ATTRACTORS,
  MAX_FLOCK_BOIDS,
  MAX_FLOCK_MESH_TRIANGLES,
  MAX_FLOCK_OBSTACLES,
  MAX_FLOCK_PREDATORS,
  packFlockGeometry,
  resolveFlockParams,
  stepFlockCPU,
} from './flocking-sim.js';
export type {
  FlockAttractor,
  FlockBounds,
  FlockDebugOptions,
  FlockGeometry,
  FlockInterleavedGeometry,
  FlockObstacle,
  FlockPredator,
  FlockPreset,
  FlockSimulationState,
  FlockSnapshot,
  FlockStats,
  FlockVec3,
  GPUFlockOptions,
  ResolvedFlockParams,
} from './flocking-sim.js';

/** Packs the mesh, or the preset's own, into the draw's corner records. */
const packMesh = (geometry: GPUFlockOptions['geometry'], preset: FlockPreset) =>
  packFlockGeometry(geometry ?? (preset === 'fish' ? createFishGeometry() : createBirdGeometry()), preset);

type Context = Extract<PassContext, { backend: 'webgpu' }>;

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** Longest frame delta a frame advances the flock by, in seconds: a longer stall advances this much. */
const FRAME_DELTA_CAP = 0.25;

let nextFlockId = 0;

type Pass = [GPUComputePipeline, GPUBindGroup];
interface ComputeRuntime {
  clear: Pass;
  count: [Pass, Pass];
  scanBlocks: Pass;
  scanSums: Pass;
  addOffsets: Pass;
  scatter: Pass;
  rank: [Pass, Pass];
  step: [Pass, Pass];
}

/**
 * GPU boid flock (`@margoengine/vfx/flocking`), an engine plugin.
 *
 * On WebGPU every step runs on the GPU (eight compute passes, no readback) and one instanced draw shows up to
 * 262,144 birds or fish facing their velocity, banking into turns and flapping or swimming. Steps are deterministic: the
 * same options and seed give the same state on the same GPU and driver, also after `snapshot` and `restore`. On the
 * WebGL2 compatibility layer the same steps run on the CPU (`stats.backend` is `'webgl2-compat'`) and the same draw shows
 * them; keep counts there to a few thousand. Throws a coded `MargoError` (help link) for any bad option.
 */
export class GPUFlock implements EnginePlugin {
  /** Unique plugin name registered on the engine's frame graph. */
  readonly name: string;
  /** Live options; every field but `count` can change between frames. */
  readonly options: GPUFlockOptions;
  /** Boid count, fixed at construction. */
  readonly count: number;
  /** Live statistics. */
  readonly stats: FlockStats;

  private engine?: Engine;
  private device?: GPUDevice;
  private disposed = false;
  private compat = false;
  private ping = 0;
  private readonly gridCells: number;
  private meshVertexCount = 0;
  private meshDirty = true;
  private mesh: { corners: Float32Array; vertexCount: number };
  private pending?: Float32Array;
  private needsInit = true;
  private cpuState?: FlockSimulationState;
  private cpuDirty = false;
  private clocked = false;
  private ticked = false;
  private pendingDelta = 0;

  private owned: { destroy(): void }[] = [];
  private states: GPUBuffer[] = [];
  private meshBuf?: GPUBuffer;
  private simUniform?: GPUBuffer;
  private debugBuf?: GPUBuffer;
  private renderUniform?: GPUBuffer;
  private debugUniform?: GPUBuffer;
  private compute?: ComputeRuntime;
  private renderModule?: GPUShaderModule;
  private debugModule?: GPUShaderModule;
  private velocityModule?: GPUShaderModule;
  private renderPipelines = new Map<string, [GPURenderPipeline, GPUBindGroup, GPUBindGroup]>();
  private debugPipelines = new Map<
    string,
    [GPURenderPipeline, GPUBindGroup, GPURenderPipeline, GPUBindGroup, GPUBindGroup]
  >();

  private readonly simData = new ArrayBuffer(FLOCK_SIM_FLOATS * 4);
  private readonly simU32 = new Uint32Array(this.simData);
  private readonly simF32 = new Float32Array(this.simData);
  private readonly renderData = new Float32Array(36);
  private readonly debugUniformData = new Float32Array(40);

  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  private readonly renderPassDesc: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.depthAttachment,
  };
  private readonly debugDepthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthReadOnly: true,
  };
  private readonly debugPassDesc: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.debugDepthAttachment,
  };

  /** Creates a flock; pass it to `engine.use(flock)`, or use {@link GPUFlock.attach}. */
  constructor(options: GPUFlockOptions = {}) {
    const resolved = resolveFlockParams(options);
    this.options = { ...options, count: resolved.count, debug: { ...resolved.debug } };
    this.count = resolved.count;
    this.gridCells = gridCellsForCount(this.count);
    this.mesh = packMesh(this.options.geometry, resolved.preset);
    this.name = `vfx:flocking:${++nextFlockId}`;
    this.stats = {
      count: this.count,
      backend: 'webgpu',
      drawCalls: 0,
      gridCells: this.gridCells,
      steps: 0,
      debugEnabled: resolved.debug.enabled,
    };
  }

  /** Creates a {@link GPUFlock} and attaches it to `engine`. */
  static attach(engine: EngineKernel, options: GPUFlockOptions = {}): GPUFlock {
    const flock = new GPUFlock(options);
    engineRuntime(engine).use(flock);
    return flock;
  }

  private assertAlive(action: string): void {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        `GPUFlock.${action} cannot run after dispose(); attach a new GPUFlock; see https://margoengine.com/errors#disposed`,
      );
  }

  /** Merges debug overlay settings (velocity lines, grid, perception, vectors, inspected boid). */
  setDebug(debug: FlockDebugOptions): void {
    this.assertAlive('setDebug');
    if (!debug || typeof debug !== 'object')
      throw flockError(
        'GPUFlock.setDebug takes an object; pass { enabled, velocities?, grid?, perception?, vectors? }.',
      );
    const merged = { ...this.options.debug, ...debug };
    this.stats.debugEnabled = resolveFlockParams({ ...this.options, debug: merged }, this.count).debug.enabled;
    this.options.debug = merged;
  }

  /** The current debug overlay settings with their defaults filled in. */
  getDebug(): Required<FlockDebugOptions> {
    return { ...resolveFlockParams(this.options, this.count).debug };
  }

  /**
   * Switches between the `'bird'` and `'fish'` presets, and optionally the mesh (copied now, so its source can be
   * disposed), without recreating the flock. Change the mesh or the preset through this, not `options`.
   */
  setPreset(preset: FlockPreset, geometry?: FlockGeometry | FlockInterleavedGeometry | null): void {
    this.assertAlive('setPreset');
    if (preset !== 'bird' && preset !== 'fish')
      throw flockError(`GPUFlock.setPreset takes 'bird' or 'fish', not ${String(preset)}.`);
    const mesh = packMesh(geometry === undefined ? this.options.geometry : geometry, preset);
    this.options.preset = preset;
    if (geometry !== undefined) this.options.geometry = geometry;
    this.mesh = mesh;
    this.meshDirty = true;
  }

  /** Replaces the attractors (up to 16). */
  setAttractors(attractors: readonly FlockAttractor[]): void {
    this.assertAlive('setAttractors');
    resolveFlockParams({ ...this.options, attractors }, this.count);
    this.options.attractors = attractors;
  }

  /** Replaces the predators (up to 16); a pointer is a predator at its world position. */
  setPredators(predators: readonly FlockPredator[]): void {
    this.assertAlive('setPredators');
    resolveFlockParams({ ...this.options, predators }, this.count);
    this.options.predators = predators;
  }

  /** Replaces the sphere obstacles (up to 32). */
  setObstacles(obstacles: readonly FlockObstacle[]): void {
    this.assertAlive('setObstacles');
    resolveFlockParams({ ...this.options, obstacles }, this.count);
    this.options.obstacles = obstacles;
  }

  /** Starts the flock again from `seed` (default: `options.seed`), the same state every time for a seed. */
  reset(seed?: number): void {
    this.assertAlive('reset');
    resolveFlockParams({ ...this.options, seed: seed ?? this.options.seed }, this.count);
    if (seed !== undefined) this.options.seed = seed;
    this.pending = undefined;
    this.needsInit = true;
    this.stats.steps = 0;
  }

  /**
   * Advances the flock by `dt` seconds now (0 to 1, in equal steps of at most 0.05 s), also while `paused`. Call it
   * between frames; needs the flock attached.
   */
  step(dt: number): void {
    this.assertAlive('step');
    const n = flockSubsteps(dt);
    const device = this.device;
    if (!device)
      throw new MargoError('state', 'GPUFlock.step needs the flock attached; call GPUFlock.attach(engine) first.');
    if (!n) return;
    const params = resolveFlockParams(this.options, this.count);
    this.ensureResources(device, params);
    if (this.compat) {
      this.stats.steps += stepFlockCPU(this.cpuState!, this.options, dt);
      this.cpuDirty = true;
      return;
    }
    const encoder = device.createCommandEncoder();
    this.encodeSteps(encoder, device, params, dt, n);
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Copies the flock's state, read back from the GPU (or the CPU twin on the WebGL2 layer). `restore` takes it back;
   * `flockStateHash(snapshot.boids)` compares two.
   */
  async snapshot(): Promise<FlockSnapshot> {
    this.assertAlive('snapshot');
    const device = this.device;
    if (!device)
      throw new MargoError('state', 'GPUFlock.snapshot needs the flock attached; call GPUFlock.attach(engine) first.');
    const params = resolveFlockParams(this.options, this.count);
    this.ensureResources(device, params);
    const steps = this.stats.steps;
    if (this.compat) return { count: this.count, steps, boids: this.cpuState!.boids.slice() };
    const bytes = this.count * FLOCK_BOID_FLOATS * 4;
    const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.states[this.ping], 0, staging, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      return { count: this.count, steps, boids: new Float32Array(staging.getMappedRange().slice(0)) };
    } finally {
      staging.destroy();
    }
  }

  /** Puts the flock back to a `snapshot` of a flock of the same count; the steps after it repeat exactly. */
  restore(snapshot: FlockSnapshot): void {
    this.assertAlive('restore');
    if (
      !snapshot ||
      snapshot.count !== this.count ||
      !(snapshot.boids instanceof Float32Array) ||
      snapshot.boids.length !== this.count * FLOCK_BOID_FLOATS ||
      !Number.isSafeInteger(snapshot.steps) ||
      snapshot.steps < 0
    )
      throw flockError(`GPUFlock.restore takes a snapshot of a flock of ${this.count} boids, from flock.snapshot().`);
    for (let i = 0; i < snapshot.boids.length; i++)
      if (!Number.isFinite(snapshot.boids[i])) throw flockError(`GPUFlock.restore: snapshot value ${i} is not finite.`);
    this.pending = snapshot.boids.slice();
    this.needsInit = true;
    this.stats.steps = snapshot.steps;
  }

  /** Checks WebGPU and the device's buffer limits for this count. */
  setup(engine: Engine): void {
    requireWebGPU(engine, 'GPUFlock');
    const device = engine.gpu!;
    const maxByBinding = Math.floor(
      Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / (FLOCK_BOID_FLOATS * 4),
    );
    const maxByDispatch = device.limits.maxComputeWorkgroupsPerDimension * 256;
    const deviceMax = Math.min(MAX_FLOCK_BOIDS, maxByBinding, maxByDispatch);
    if (this.count > deviceMax)
      throw new MargoError(
        'unsupported',
        `GPUFlock count ${this.count} is more than this device holds (${deviceMax}); pass a smaller count; see https://margoengine.com/errors#unsupported`,
      );
    this.engine = engine;
    this.device = device;
    this.compat = reportBackend(this.stats, device);
  }

  /** Registers the step, the instanced draw and the debug overlay on the frame graph. */
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name + ':simulate', order: -8, execute: (c) => c.backend === 'webgpu' && this.simulate(c) });
    graph.add({ name: this.name + ':draw', order: 2, execute: (c) => c.backend === 'webgpu' && this.draw(c) });
    graph.add({ name: this.name + ':debug', order: 8, execute: (c) => c.backend === 'webgpu' && this.drawDebug(c) });
  }

  /** Takes the frame delta once a tick, so a frame drawn into several views steps once. */
  onPreUpdate(delta: number): void {
    if (this.disposed) return;
    this.pendingDelta = delta;
    this.clocked = true;
    this.ticked = true;
  }

  private buffer(device: GPUDevice, size: number, usage: number): GPUBuffer {
    const buf = device.createBuffer({ size, usage });
    this.owned.push(buf);
    return buf;
  }

  private ensureResources(device: GPUDevice, params: ResolvedFlockParams): void {
    if (!this.renderUniform) {
      const n = this.count;
      const g = this.gridCells;
      const stateBytes = n * FLOCK_BOID_FLOATS * 4;
      const STORAGE = GPUBufferUsage.STORAGE;
      const stateUsage = STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      this.states = [this.buffer(device, stateBytes, stateUsage)];
      this.debugBuf = this.buffer(device, 128, STORAGE | GPUBufferUsage.COPY_DST);
      this.renderUniform = this.buffer(
        device,
        this.renderData.byteLength,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      this.debugUniform = this.buffer(
        device,
        this.debugUniformData.byteLength,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      if (!this.compat) {
        this.states.push(this.buffer(device, stateBytes, stateUsage));
        const sim = (this.simUniform = this.buffer(
          device,
          this.simData.byteLength,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        ));
        const grid = this.buffer(device, (2 * g + 512) * 4, STORAGE);
        const keys = this.buffer(device, 4 * n * 4, STORAGE);
        const sorted = this.buffer(device, stateBytes, STORAGE);
        const [a, b] = this.states;
        const pipe = (code: string): GPUComputePipeline =>
          device.createComputePipeline({
            layout: 'auto',
            compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
          });
        const pass = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]): Pass => [
          pipeline,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
          }),
        ];
        const count = pipe(FLOCK_COUNT_WGSL);
        const rank = pipe(FLOCK_RANK_WGSL);
        const step = pipe(FLOCK_STEP_WGSL);
        this.compute = {
          clear: pass(pipe(FLOCK_CLEAR_WGSL), [sim, grid]),
          count: [pass(count, [sim, a, grid, keys]), pass(count, [sim, b, grid, keys])],
          scanBlocks: pass(pipe(FLOCK_SCAN_BLOCKS_WGSL), [sim, grid]),
          scanSums: pass(pipe(FLOCK_SCAN_SUMS_WGSL), [sim, grid]),
          addOffsets: pass(pipe(FLOCK_ADD_OFFSETS_WGSL), [sim, grid]),
          scatter: pass(pipe(FLOCK_SCATTER_WGSL), [sim, grid, keys]),
          rank: [pass(rank, [sim, a, grid, keys, sorted]), pass(rank, [sim, b, grid, keys, sorted])],
          step: [
            pass(step, [sim, a, sorted, keys, grid, b, this.debugBuf]),
            pass(step, [sim, b, sorted, keys, grid, a, this.debugBuf]),
          ],
        };
      }
      this.needsInit = true;
      this.meshDirty = true;
    }

    if (this.meshDirty) {
      const { corners, vertexCount } = this.mesh;
      if (this.meshBuf) {
        this.meshBuf.destroy();
        this.owned.splice(this.owned.indexOf(this.meshBuf), 1);
      }
      this.meshBuf = this.buffer(device, corners.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(this.meshBuf, 0, corners as Float32Array<ArrayBuffer>);
      this.meshVertexCount = vertexCount;
      this.meshDirty = false;
      this.renderPipelines.clear();
    }

    if (this.needsInit) {
      const state = createFlockState(this.options);
      if (this.pending) state.boids.set(this.pending);
      this.pending = undefined;
      device.queue.writeBuffer(this.states[0], 0, state.boids as Float32Array<ArrayBuffer>);
      this.cpuState = this.compat ? state : undefined;
      this.cpuDirty = false;
      // The inspected boid's record before its first step, so a paused flock's overlay shows it.
      const sel = params.debug.selectedIndex * FLOCK_BOID_FLOATS;
      const cellSize = Math.max(params.neighborRadius, params.separationRadius, 0.25);
      const dbg = new Float32Array(32);
      dbg.set(state.boids.subarray(sel, sel + 8), 0);
      dbg[7] = 0;
      for (let a = 0; a < 3; a++) dbg[24 + a] = Math.floor(dbg[a] / cellSize);
      dbg[27] = cellSize;
      dbg[31] = 1;
      device.queue.writeBuffer(this.debugBuf!, 0, dbg);
      this.ping = 0;
      this.needsInit = false;
    }
  }

  private writeSimUniforms(device: GPUDevice, p: ResolvedFlockParams, h: number): void {
    const u = this.simU32;
    const f = this.simF32;
    const cellSize = Math.max(p.neighborRadius, p.separationRadius, 0.25);
    u.set([p.count, this.gridCells, this.gridCells - 1, p.maxNeighbors], 0);
    f.set([...p.boundsCenter, p.boundsShape, ...p.boundsHalf, p.boundsRadius], 4);
    f.set([p.neighborRadius, p.separationRadius, p.cosHalfVision, 1 / cellSize], 12);
    f.set([p.separation, p.alignment, p.cohesion, p.boundsStrength], 16);
    f.set([p.minSpeed, p.maxSpeed, p.maxForce, p.maxTurnAccel], 20);
    f.set([h, p.boundsMargin, p.scale, cellSize], 24);
    f.set([p.bankStrength, p.flapFrequency, p.preset === 'fish' ? 0.25 : 1.0, 0], 28);
    u.set([p.attractors.length, p.predators.length, p.obstacles.length, 0], 32);
    u.set([p.debug.enabled ? 1 : 0, p.debug.selectedIndex, 0, 0], 36);
    p.attractors.forEach((a, i) => f.set([...a.position, a.strength ?? 2.5, a.radius ?? 0], 40 + i * 8));
    p.predators.forEach((q, i) => f.set([...q.position, q.radius ?? 6, q.strength ?? 12], 168 + i * 8));
    p.obstacles.forEach((o, i) => f.set([...o.position, o.radius, o.strength ?? 8], 296 + i * 8));
    device.queue.writeBuffer(this.simUniform!, 0, this.simData);
  }

  /** Encodes `n` equal steps of `dt / n` seconds, ping-ponging the state buffers. */
  private encodeSteps(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    p: ResolvedFlockParams,
    dt: number,
    n: number,
  ): void {
    const rt = this.compute!;
    this.writeSimUniforms(device, p, dt / n);
    const boidGroups = Math.ceil(this.count / 256);
    const gridGroups = this.gridCells >> 8;
    const pass = encoder.beginComputePass();
    const run = ([pipeline, group]: Pass, groups: number) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(groups);
    };
    for (let s = 0; s < n; s++) {
      const from = this.ping;
      run(rt.clear, gridGroups);
      run(rt.count[from], boidGroups);
      run(rt.scanBlocks, gridGroups);
      run(rt.scanSums, 1);
      run(rt.addOffsets, gridGroups);
      run(rt.scatter, boidGroups);
      run(rt.rank[from], boidGroups);
      run(rt.step[from], boidGroups);
      this.ping = 1 - from;
    }
    pass.end();
    this.stats.steps += n;
  }

  private simulate(c: Context): void {
    if (this.disposed) return;
    const params = resolveFlockParams(this.options, this.count);
    this.stats.debugEnabled = params.debug.enabled;
    this.ensureResources(c.device, params);
    let dt = 0;
    if (!params.paused) {
      if (!this.clocked) dt = c.delta;
      else if (this.ticked) dt = this.pendingDelta;
    }
    this.ticked = false;
    dt = Math.min(Math.max(dt, 0), FRAME_DELTA_CAP);
    const n = Number.isFinite(dt) ? flockSubsteps(dt) : 0;
    if (this.compat) {
      if (n) {
        this.stats.steps += stepFlockCPU(this.cpuState!, this.options, dt);
        this.cpuDirty = true;
      }
      if (this.cpuDirty) {
        c.device.queue.writeBuffer(this.states[0], 0, this.cpuState!.boids as Float32Array<ArrayBuffer>);
        c.device.queue.writeBuffer(this.debugBuf!, 0, this.cpuState!.debugData as Float32Array<ArrayBuffer>);
        this.cpuDirty = false;
      }
      return;
    }
    if (n) this.encodeSteps(c.encoder, c.device, params, dt, n);
  }

  private draw(c: Context): void {
    if (this.disposed) return;
    const params = resolveFlockParams(this.options, this.count);
    this.ensureResources(c.device, params);
    const encode = !c.format.includes('float') && !c.format.endsWith('-srgb');
    const u = this.renderData;
    u.set(c.camera.matrix, 0);
    u.set([...c.camera.position, params.scale], 16);
    u.set([...params.lightDirection, params.ambient], 20);
    u.set([...params.color, params.flapAmplitude], 24);
    u.set([...params.accentColor, params.preset === 'fish' ? 1 : 0], 28);
    u.set([...params.lightColor, encode ? 1 : 0], 32);
    c.device.queue.writeBuffer(this.renderUniform!, 0, u as Float32Array<ArrayBuffer>);

    const depthFormat = c.descriptor.depthStencil!.format;
    const key = `${c.format}:${depthFormat}:${c.descriptor.multisample?.count ?? 1}`;
    let entry = this.renderPipelines.get(key);
    if (!entry) {
      this.renderModule ??= c.device.createShaderModule({ code: FLOCK_RENDER_WGSL });
      const pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: this.renderModule, entryPoint: 'vertex' },
        fragment: { module: this.renderModule, entryPoint: 'fragment', targets: [{ format: c.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: c.descriptor.multisample,
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
      });
      const group = (state: GPUBuffer) =>
        c.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.renderUniform! } },
            { binding: 1, resource: { buffer: state } },
            { binding: 2, resource: { buffer: this.meshBuf! } },
          ],
        });
      const a = group(this.states[0]);
      entry = [pipeline, a, this.states[1] ? group(this.states[1]) : a];
      this.renderPipelines.set(key, entry);
    }

    this.colorAttachment.view = c.color;
    this.depthAttachment.view = c.depth;
    const hasStencil = depthFormat.includes('stencil');
    this.depthAttachment.stencilLoadOp = hasStencil ? 'load' : undefined;
    this.depthAttachment.stencilStoreOp = hasStencil ? 'store' : undefined;
    const pass = c.encoder.beginRenderPass(this.renderPassDesc);
    applyView(pass, c);
    pass.setPipeline(entry[0]);
    pass.setBindGroup(0, this.ping === 0 ? entry[1] : entry[2]);
    pass.draw(this.meshVertexCount, this.count);
    pass.end();
    this.stats.drawCalls = 1;
    if (this.engine) this.engine.stats.drawCalls++;
  }

  private drawDebug(c: Context): void {
    if (this.disposed || !this.debugBuf) return;
    const params = resolveFlockParams(this.options, this.count);
    const dbg = params.debug;
    const inspected = dbg.grid || dbg.perception || dbg.vectors;
    if (!dbg.enabled || !(dbg.velocities || inspected)) return;

    const encode = !c.format.includes('float') && !c.format.endsWith('-srgb');
    const u = this.debugUniformData;
    u.set(c.camera.matrix, 0);
    u.set([...params.boundsCenter, params.boundsShape, ...params.boundsHalf, params.boundsRadius], 16);
    u.set([params.neighborRadius, params.separationRadius, params.visionAngle * 0.5, 0], 24);
    u.set([dbg.grid ? 1 : 0, dbg.perception ? 1 : 0, dbg.vectors ? 1 : 0, encode ? 1 : 0], 28);
    u.set([0.15, params.maxSpeed, 0, 0], 32);
    c.device.queue.writeBuffer(this.debugUniform!, 0, u as Float32Array<ArrayBuffer>);

    const depthFormat = c.descriptor.depthStencil!.format;
    const key = `${c.format}:${depthFormat}:${c.descriptor.multisample?.count ?? 1}`;
    let entry = this.debugPipelines.get(key);
    if (!entry) {
      const lines = (module: GPUShaderModule) =>
        c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
          primitive: { topology: 'line-list' },
          multisample: c.descriptor.multisample,
          depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        });
      this.debugModule ??= c.device.createShaderModule({ code: FLOCK_DEBUG_WGSL });
      this.velocityModule ??= c.device.createShaderModule({ code: FLOCK_VELOCITY_WGSL });
      const one = lines(this.debugModule);
      const all = lines(this.velocityModule);
      const group = (pipeline: GPURenderPipeline, buffer: GPUBuffer) =>
        c.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.debugUniform! } },
            { binding: 1, resource: { buffer } },
          ],
        });
      const a = group(all, this.states[0]);
      entry = [one, group(one, this.debugBuf), all, a, this.states[1] ? group(all, this.states[1]) : a];
      this.debugPipelines.set(key, entry);
    }

    this.colorAttachment.view = c.color;
    this.debugDepthAttachment.view = c.depth;
    this.debugDepthAttachment.stencilReadOnly = depthFormat.includes('stencil') ? true : undefined;
    const pass = c.encoder.beginRenderPass(this.debugPassDesc);
    applyView(pass, c);
    if (dbg.velocities) {
      pass.setPipeline(entry[2]);
      pass.setBindGroup(0, this.ping === 0 ? entry[3] : entry[4]);
      pass.draw(2, this.count);
      this.stats.drawCalls++;
      if (this.engine) this.engine.stats.drawCalls++;
    }
    if (inspected) {
      pass.setPipeline(entry[0]);
      pass.setBindGroup(0, entry[1]);
      pass.draw(FLOCK_DEBUG_VERTEX_COUNT);
      this.stats.drawCalls++;
      if (this.engine) this.engine.stats.drawCalls++;
    }
    pass.end();
  }

  private release(): void {
    for (const resource of this.owned) resource.destroy();
    this.owned = [];
    this.states = [];
    this.meshBuf = this.simUniform = this.debugBuf = this.renderUniform = this.debugUniform = undefined;
    this.compute = undefined;
    this.renderModule = this.debugModule = this.velocityModule = undefined;
    this.renderPipelines.clear();
    this.debugPipelines.clear();
    this.meshDirty = true;
    this.needsInit = true;
  }

  /** Rebuilds every GPU buffer and pipeline after a device restore; the flock starts again from its seed. */
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.stats.steps = 0;
    this.setup(engine);
  }

  /** Releases every GPU resource and detaches the flock from its engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.cpuState = undefined;
    this.engine = undefined;
    this.device = undefined;
  }

  /** `using flock = GPUFlock.attach(...)` disposes it at the end of the scope. */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
