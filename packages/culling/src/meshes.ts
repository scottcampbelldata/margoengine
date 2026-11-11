/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Batch, Engine, EnginePlugin, FrameGraph, Geometry, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { loadCompatRoute } from '../../shared/compat.js';
import { scoped } from '../../shared/error-scope.js';
import type { CullShape } from './shape.js';
import { viewSize } from '../../shared/view-rect.js';
import { Pyramid, depthKind, exactShader, levelTable, occluderPipeline } from './pyramid.js';
import { computeShader, fillFrame, instanceCull, occludedCull } from './shaders.js';

declare const GPUBufferUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
  VERTEX: number;
  UNIFORM: number;
  STORAGE: number;
  INDIRECT: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `CulledMeshes` settings; `minRadius` may also change later on the plugin. */
export interface CulledMeshesOptions {
  /** Also drop parts whose bounding sphere spans fewer than this many CSS pixels in radius (default 0: frustum only, same pixels as core). */
  minRadius?: number;
  /**
   * Also drop instances hidden behind others, with a Hi-Z test like `CulledInstances`' `'occlusion'` mode. Worth it for
   * dense or enclosed scenes; on an open layout the extra depth pass costs more than it saves. Default false.
   */
  occlusion?: boolean;
  /** With `occlusion`: instances at least this many pixels in radius become occluders for the next frame. Default 8. */
  occluderSize?: number;
}

// One dispatch triple per core batch: frustum (+ screen size) test with a workgroup scan, a scan of the workgroup totals,
// then a stable scatter of the kept 96-byte instance records (original order, so coplanar faces resolve as in core).
const shader = instanceCull('', 'records[i].m');

// With occlusion: `early` lists last frame's kept instances that are large enough to occlude, and `cull` replaces the
// plain kernel, adding the Hi-Z test; the plain scan and scatter follow it. Separate bindings: the plain kernels' six
// storage buffers plus these would pass WebGPU's eight per stage.
const occludedShader = occludedCull('', 'records[i].m');

/** What occlusion adds to a slot; bound to one instance buffer and one pyramid. */
interface Occluders {
  args: GPUBuffer;
  list: GPUBuffer;
  reset: Uint32Array;
  instance?: GPUBuffer;
  hiz?: GPUBuffer;
  early?: GPUBindGroup;
  cull?: GPUBindGroup;
  depth?: GPUBindGroup;
}
interface Slot {
  instance?: GPUBuffer;
  capacity: number;
  buffers: GPUBuffer[];
  drawn?: GPUBuffer;
  args?: GPUBuffer;
  uniform?: GPUBuffer;
  group?: GPUBindGroup;
  data: Uint32Array;
  occluders?: Occluders;
  /** The device confirmed the buffers; until then (and for good after a failure) the batch draws unculled. */
  ready?: boolean;
  failed?: boolean;
}
/** Occlusion's device resources, made by the first frame that uses it. */
interface Occlusion {
  samples: number;
  pyramid: Pyramid;
  uniform: GPUBuffer;
  table: GPUBuffer;
  early: GPUComputePipeline;
  cull: GPUComputePipeline;
  depth: GPURenderPipeline;
}
let serial = 0;
/** The part of core's instance buffer a slot uses: the whole buffer can be larger than one storage binding. */
const inUse = (buffer: GPUBuffer, slot: Slot) => ({ buffer, size: Math.min(buffer.size, slot.capacity * 96) });

/**
 * GPU culling for regular core meshes: every frame a compute pass tests each drawn instance of core's batches against
 * the frustum (and optionally a screen-size threshold), compacts the kept instances in order and points core's draws at
 * them (`Batch.redirect`). The meshes stay core meshes, so `engine.pick`, Picking and the hierarchy keep
 * working. Start with `engine.start({culling: false})` (or render with `{culling: false}`) to move frustum culling
 * off the CPU (the kept set then stays stable while the camera moves, so core reuses its instance lists). With
 * `occlusion`, instances hidden behind last frame's large ones are dropped too.
 */
export class CulledMeshes implements EnginePlugin {
  protected shape?: CullShape;
  readonly name = 'culled-meshes:' + ++serial;
  /** See {@link CulledMeshesOptions.minRadius}; may change at any time. */
  minRadius: number;
  /** See {@link CulledMeshesOptions.occlusion}; may change at any time. */
  occlusion: boolean;
  /** See {@link CulledMeshesOptions.occluderSize}; may change at any time. */
  occluderSize: number;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private pipelines?: {
    layout: GPUBindGroupLayout;
    cull: GPUComputePipeline;
    scan: GPUComputePipeline;
    scatter: GPUComputePipeline;
  };
  private frameBuffer?: GPUBuffer;
  // KB6434c: buffers wait for the device's confirmation before any use. A failure (the frame buffer, a slot, the
  // occlusion set) is reported once and holds until the next device restore; the meshes draw unculled meanwhile.
  private frameReady = false;
  private frameFailed = false;
  private occlusionPending = 0;
  private occlusionFailed = false;
  private occlusionTurn = 0;
  private readonly frame = new Float32Array(44);
  private readonly slots = new Map<Geometry, Slot>();
  private redirected: Batch[] = [];
  private occluding?: Occlusion;
  private readonly uniform = new ArrayBuffer(448);
  private readonly floats = new Float32Array(this.uniform);
  private readonly words = new Uint32Array(this.uniform);
  // The WebGL2 layer's route (./compat.js): the same test on the CPU, kept records uploaded.
  private route?: ReturnType<typeof import('./compat.js').meshesRoute>;

  /** Same as `engine.use(new CulledMeshes(options))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: CulledMeshesOptions): CulledMeshes {
    const value = new CulledMeshes(options);
    engine.use(value);
    return value;
  }
  constructor({ minRadius = 0, occlusion = false, occluderSize = 8 }: CulledMeshesOptions = {}) {
    this.minRadius = minRadius;
    this.occlusion = occlusion;
    this.occluderSize = occluderSize;
    this.check();
  }
  private check(): void {
    if (!(this.minRadius >= 0 && this.minRadius < 1e6))
      throw new RangeError('Invalid culled mesh options; set minRadius to a number from 0 up to 1e6');
    if (typeof this.occlusion !== 'boolean')
      throw new TypeError('Invalid culled mesh options; set occlusion to true or false');
    if (!(this.occluderSize >= 0))
      throw new RangeError('Invalid culled mesh options; set occluderSize to a number of 0 or more');
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'CulledMeshes requires WebGPU; attach a new CulledMeshes to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const d = (this.device = engine.gpu);
    loadCompatRoute(d, () => import('./compat.js'))?.then(({ meshesRoute }) => {
      if (this.device === d) this.route = meshesRoute();
    });
  }
  registerPasses(graph: FrameGraph): void {
    // First in the frame, so every core draw of these batches (main pass and replays) sees this frame's culled lists.
    graph.add({
      name: this.name,
      order: -1e6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.cull(c);
      },
    });
  }
  /** Instances drawn per redirected batch in the latest submitted frame, keyed by geometry (a GPU readback; for tests and tools). */
  async readCounts(): Promise<Map<Geometry, number>> {
    const d = this.device;
    if (!d) throw new MargoError('state', 'CulledMeshes is not attached; attach it to an engine first');
    const entries = [...this.slots].filter(([, s]) => s.args),
      read = d.createBuffer({
        size: Math.max(4, entries.length * 4),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    try {
      const encoder = d.createCommandEncoder();
      entries.forEach(([, s], i) => encoder.copyBufferToBuffer(s.args!, 4, read, i * 4, 4));
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      return new Map(entries.map(([g], i) => [g, values[i]]));
    } finally {
      read.destroy();
    }
  }

  private cull(c: Context): void {
    this.check();
    this.restore();
    const d = c.device,
      batches = c.batches ?? [],
      engine = this.engine!;
    this.pipelines ??= (() => {
      // One explicit layout shared by the three entry points ('auto' layouts are per pipeline and incompatible).
      const visibility = 4,
        buffer = (type: GPUBufferBindingType) => ({ visibility, buffer: { type } });
      const layout = d.createBindGroupLayout({
        entries: [
          buffer('uniform'),
          buffer('uniform'),
          buffer('read-only-storage'),
          ...[3, 4, 5, 6, 7].map(() => buffer('storage')),
        ].map((e, binding) => ({ binding, ...e })),
      });
      const module = d.createShaderModule({ code: this.shape?.shader(shader, 'records[i].m') ?? shader }),
        pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [layout] }),
        entry = (entryPoint: string) =>
          d.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
      return { layout, cull: entry('cull'), scan: entry('scan'), scatter: entry('scatter') };
    })();
    if (this.frameFailed) return;
    if (!this.frameBuffer) {
      const [buffer, check] = scoped(d, () =>
        d.createBuffer({ size: this.frame.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      );
      this.frameBuffer = buffer;
      this.frameReady = !check;
      void check?.then((error) => {
        if (this.frameBuffer !== buffer) return;
        if (!error) this.frameReady = true;
        else {
          buffer.destroy();
          this.frameBuffer = undefined;
          this.frameFailed = true;
          this.fail(error);
        }
      });
    }
    if (!this.frameReady) return;
    fillFrame(this.frame, c, engine.canvas, this.minRadius);
    this.shape?.prepare(c, this.occlusion && !!this.route);
    d.queue.writeBuffer(this.frameBuffer, 0, this.frame as Float32Array<ArrayBuffer>);
    const route = this.route,
      p = this.pipelines,
      live = new Set<Geometry>(),
      active: Batch[] = [];
    for (const batch of batches) {
      if (!batch.count) continue;
      live.add(batch.geometry);
      // A slot the device has not confirmed is left to core, which draws every instance.
      if (this.slot(d, engine, batch)) active.push(batch);
    }
    // The depth prepass must see core's own shader unchanged; other frames cull like `occlusion: false`.
    const occluding =
        this.occlusion && !route && active.length && exactShader(c.shader) && !this.occlusionFailed
          ? this.occlude(c, active)
          : undefined,
      pass = route ? undefined : c.encoder.beginComputePass();
    for (const batch of active) {
      const slot = this.slots.get(batch.geometry)!;
      if (route) route(d, batch, slot.drawn!, slot.args!, this.frame, this.shape?.cpu);
      else {
        const groups = Math.ceil(batch.count / 256);
        pass!.setBindGroup(0, occluding ? slot.occluders!.cull! : slot.group!);
        pass!.setPipeline(occluding ? occluding.cull : p.cull);
        pass!.dispatchWorkgroups(groups);
        pass!.setBindGroup(0, slot.group!);
        pass!.setPipeline(p.scan);
        pass!.dispatchWorkgroups(1);
        pass!.setPipeline(p.scatter);
        pass!.dispatchWorkgroups(groups);
      }
      batch.redirect = { instances: slot.drawn!, args: slot.args! };
      this.redirected.push(batch);
    }
    pass?.end();
    for (const [geometry, slot] of this.slots)
      if (!live.has(geometry)) {
        for (const b of slot.buffers) b.destroy();
        this.slots.delete(geometry);
      }
  }
  // Draws last frame's large kept instances depth-only with this frame's camera and builds the pyramid from them. A
  // stale list only changes which real geometry occludes: every occluder is an instance of this frame's batch.
  private occlude(c: Context, batches: readonly Batch[]): Occlusion | undefined {
    const d = c.device,
      engine = this.engine!,
      samples = c.descriptor.multisample?.count ?? 1,
      // Every occlusion allocation is checked; frames cull without occlusion until all are confirmed.
      checked = <T>(make: () => T): T => {
        const [value, check] = scoped(d, make),
          turn = this.occlusionTurn;
        if (check) {
          this.occlusionPending++;
          void check.then((error) => {
            if (turn !== this.occlusionTurn) return;
            this.occlusionPending--;
            if (!error) return;
            this.dropOcclusion();
            this.occlusionFailed = true;
            this.fail(error);
          });
        }
        return value;
      };
    let o = this.occluding;
    if (o?.samples !== samples) {
      this.dropOcclusion();
      o = checked(() => this.makeOcclusion(d, samples));
    }
    const pyramid = o.pyramid,
      [width, height] = viewSize(c);
    // Views of different sizes share resources sized for the largest; a plain frame keeps them at the canvas size.
    if (
      c.view ? width > pyramid.width || height > pyramid.height : width !== pyramid.width || height !== pyramid.height
    ) {
      const w = Math.max(width, c.view ? pyramid.width : 0),
        h = Math.max(height, c.view ? pyramid.height : 0);
      checked(() => pyramid.resize(w, h));
    }
    for (const batch of batches) {
      const slot = this.slots.get(batch.geometry)!;
      if (!slot.occluders) checked(() => this.occluderLists(d, slot));
    }
    if (this.occlusionPending) return undefined;
    return this.drawOccluders(c, engine, o, batches, width, height);
  }
  private makeOcclusion(d: GPUDevice, samples: number): Occlusion {
    {
      const module = d.createShaderModule({ code: computeShader(samples) }),
        own = d.createShaderModule({ code: this.shape?.shader(occludedShader, 'records[i].m') ?? occludedShader }),
        entry = (shader: GPUShaderModule, entryPoint: string) =>
          d.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint } }),
        uniform = d.createBuffer({ size: 448, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        table = d.createBuffer({ size: 16 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(table, 0, levelTable() as Uint32Array<ArrayBuffer>);
      const stages = { depth0: entry(module, 'depth0'), reduce: entry(module, 'reduce') };
      const o: Occlusion = (this.occluding = {
        samples,
        uniform,
        table,
        pyramid: new Pyramid(d, samples, stages, uniform, table, this.words),
        early: entry(own, 'early'),
        cull: entry(own, 'cull'),
        depth: occluderPipeline(d, samples, true),
      });
      return o;
    }
  }
  private drawOccluders(
    c: Context,
    engine: Engine,
    o: Occlusion,
    batches: readonly Batch[],
    width: number,
    height: number,
  ): Occlusion {
    const d = c.device,
      pyramid = o.pyramid;
    pyramid.plan(width, height);
    const m = c.camera.matrix,
      floats = this.floats;
    floats.set(m);
    floats.set(c.camera.planes, 16);
    this.words.set([width, height, pyramid.levels, 0, 2, 0, depthKind(m)], 40);
    floats[47] = this.occluderSize;
    d.queue.writeBuffer(o.uniform, 0, this.words);
    const select = c.encoder.beginComputePass();
    select.setPipeline(o.early);
    for (const batch of batches) {
      const slot = this.slots.get(batch.geometry)!,
        s = this.occluders(d, o, slot);
      // A claimed batch is drawn by its package, perhaps otherwise: it is culled but does not occlude.
      if (batch.claimed) continue;
      d.queue.writeBuffer(s.args, 0, s.reset as Uint32Array<ArrayBuffer>);
      select.setBindGroup(0, s.early!);
      select.dispatchWorkgroups(Math.ceil(batch.count / 256));
    }
    select.end();
    const pass = c.encoder.beginRenderPass(pyramid.pass);
    // The target may be larger than this view (shared with a larger one).
    if (c.view) pass.setViewport(0, 0, width, height, 0, 1);
    pass.setPipeline(o.depth);
    for (const batch of batches) {
      if (batch.claimed) continue;
      const s = this.slots.get(batch.geometry)!.occluders!,
        core = engine.geometryBuffers(batch.geometry)!;
      pass.setBindGroup(0, s.depth!);
      pass.setVertexBuffer(0, core.vertex);
      pass.setVertexBuffer(1, s.list);
      pass.setIndexBuffer(core.index, 'uint32');
      pass.drawIndexedIndirect(s.args, 0);
    }
    pass.end();
    const build = c.encoder.beginComputePass();
    pyramid.encode(build, width, height);
    build.end();
    return o;
  }
  // A slot's occluder list and its bindings, rebound when core replaces its instance buffer or the pyramid is resized.
  private occluders(d: GPUDevice, o: Occlusion, slot: Slot): Occluders {
    const [, , , visible, local, groups] = slot.buffers,
      instance = slot.instance!,
      hiz = o.pyramid.buffer!;
    const s = slot.occluders!;
    s.reset[0] = slot.data[1];
    if (s.instance !== instance || s.hiz !== hiz) {
      const used = inUse(instance, slot),
        group = (pipeline: GPUPipelineBase, entries: [number, GPUBuffer][]) =>
        d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: entries.map(([binding, buffer]) => ({ binding, resource: buffer === instance ? used : { buffer } })),
        });
      const shared: [number, GPUBuffer][] = [
        [0, o.uniform],
        [1, this.frameBuffer!],
        [2, slot.uniform!],
        [3, instance],
        [4, visible],
      ];
      s.early = group(o.early, [...shared, [8, s.args], [9, s.list]]);
      s.cull = group(o.cull, [...shared, [5, hiz], [6, local], [7, groups]]);
      s.depth = group(o.depth, [
        [0, o.uniform],
        [11, instance],
      ]);
      s.instance = instance;
      s.hiz = hiz;
    }
    return s;
  }
  /** A slot's occluder list and its indirect arguments, made before any frame uses them (see `occlude`). */
  private occluderLists(d: GPUDevice, slot: Slot): void {
    const make = (size: number, usage: number) => {
      const b = d.createBuffer({ size, usage: usage | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      slot.buffers.push(b);
      return b;
    };
    slot.occluders = {
      args: make(20, GPUBufferUsage.INDIRECT),
      list: make(slot.capacity * 4, GPUBufferUsage.VERTEX),
      reset: new Uint32Array(5),
    };
  }
  /** Reports a GPU allocation the device refused, once per failure; what it was for stays off until a restore. */
  private fail(error: GPUError): void {
    if (!this.disposed)
      this.engine?.onError(
        new MargoError(
          'failed',
          `CulledMeshes could not make its GPU buffers (${error.message}); the meshes draw unculled until the next device restore; see https://margoengine.com/errors#gpu-lost`,
        ),
      );
  }
  private dropOcclusion(): void {
    this.occlusionTurn++;
    this.occlusionPending = 0;
    const o = this.occluding;
    if (!o) return;
    o.pyramid.destroy();
    o.uniform.destroy();
    o.table.destroy();
    this.occluding = undefined;
    for (const slot of this.slots.values()) if (slot.occluders) slot.occluders.instance = undefined;
  }
  // Per-geometry storage, sized to the batch count (doubling) and rebound when core replaces its instance buffer.
  private slot(d: GPUDevice, engine: Engine, batch: Batch): Slot | undefined {
    let slot = this.slots.get(batch.geometry);
    if (!slot)
      this.slots.set(batch.geometry, (slot = { capacity: 0, buffers: [], data: new Uint32Array(this.shape ? 16 : 8) }));
    if (slot.failed) return undefined;
    const instance = engine.geometryBuffers(batch.geometry)!.instance;
    if (batch.count > slot.capacity) {
      // Every per-instance buffer, core's instance buffer included, is one storage binding of 96 B an instance.
      const most = Math.floor(Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize) / 96);
      if (batch.count > most)
        throw new RangeError(`CulledMeshes: at most ${most} instances of one geometry here; use several geometries.`);
      for (const b of slot.buffers) b.destroy();
      // Doubling, but never past the binding: a count just over a power of two must still fit.
      const n = Math.min(Math.max(256, 2 ** Math.ceil(Math.log2(batch.count))), Math.max(batch.count, most - (most % 256))),
        S = GPUBufferUsage.STORAGE,
        make = (size: number, usage: number) => {
          const b = d.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
          slot!.buffers.push(b);
          return b;
        };
      slot.buffers = [];
      slot.occluders = undefined;
      slot.capacity = n;
      const s = slot,
        buffers = slot.buffers,
        [, check] = scoped(d, () => {
          s.uniform = make(s.data.byteLength, GPUBufferUsage.UNIFORM);
          s.drawn = make(n * 96, S | GPUBufferUsage.VERTEX);
          s.args = make(20, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
          make(n * 4, S);
          make(n * 4, S);
          make(Math.ceil(n / 256) * 4, S);
        });
      slot.instance = undefined;
      slot.ready = !check;
      void check?.then((error) => {
        // A later growth or a restore replaced these buffers: its own check decides.
        if (s.buffers !== buffers || this.slots.get(batch.geometry) !== s) return;
        if (!error) s.ready = true;
        else {
          for (const b of buffers) b.destroy();
          s.buffers = [];
          s.failed = true;
          this.fail(error);
        }
      });
    }
    if (!slot.ready) return undefined;
    if (slot.instance !== instance) {
      const [, , , visible, local, groups] = slot.buffers,
        r = (buffer: GPUBuffer): GPUBindingResource => ({ buffer });
      slot.group = d.createBindGroup({
        layout: this.pipelines!.layout,
        entries: [
          r(this.frameBuffer!),
          r(slot.uniform!),
          // Core's instance buffer can be larger than one binding (its capacity doubles): bind only the slots in use.
          inUse(instance, slot),
          r(visible),
          r(local),
          r(groups),
          r(slot.drawn!),
          r(slot.args!),
        ].map((resource, binding) => ({ binding, resource })),
      });
      slot.instance = instance;
    }
    const words = slot.data;
    words[0] = batch.count;
    words[1] = batch.geometry.indices.length;
    new Float32Array(words.buffer).set(batch.geometry.bounds, 4);
    this.shape?.write(new Float32Array(words.buffer), 8, batch.geometry.vertices, 6);
    d.queue.writeBuffer(slot.uniform!, 0, words as Uint32Array<ArrayBuffer>);
    return slot;
  }
  // Core draws batches without a redirect from its own instance buffer, as before.
  private restore(): void {
    for (const batch of this.redirected) batch.redirect = undefined;
    this.redirected = [];
  }
  private release(): void {
    this.restore();
    this.dropOcclusion();
    for (const slot of this.slots.values()) for (const b of slot.buffers) b.destroy();
    this.slots.clear();
    this.frameBuffer?.destroy();
    this.frameBuffer = this.pipelines = this.route = undefined;
    this.frameReady = this.frameFailed = this.occlusionFailed = false;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
