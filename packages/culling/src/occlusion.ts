/// <reference lib="esnext.disposable" preserve="true" />
// App-facing hardware occlusion queries (README, "Occlusion queries"). After the main pass, each object's bounding box
// is drawn depth-test-only into the frame's own depth buffer inside one WebGPU occlusion query; the results are resolved,
// copied into one of three readback buffers and read with mapAsync, so the CPU never waits for the GPU and an object's
// `isOccluded` is the newest result that has landed (usually one to three frames old). Boxes outside the view are
// occluded and boxes cut by the near or far plane are visible without a query (the GPU Gems chapters in the README).
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, Geometry, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { localBox } from './software-depth.js';

declare const GPUBufferUsage: {
  MAP_READ: number;
  COPY_SRC: number;
  COPY_DST: number;
  VERTEX: number;
  UNIFORM: number;
  QUERY_RESOLVE: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** A world-space axis-aligned box, read every frame (move it by changing `min` and `max`). */
export interface OcclusionBox {
  min: ArrayLike<number>;
  max: ArrayLike<number>;
}
/** A core `Mesh` (or anything with a world `matrix` and a core `geometry`): its geometry's box in world space. */
export interface OcclusionMesh {
  readonly matrix: ArrayLike<number>;
  readonly geometry: Geometry | null;
}
/**
 * What a query tests: a world box, a core `Mesh` (its runtime object carries the world `matrix`) or anything shaped
 * like {@link OcclusionMesh}.
 */
export type OcclusionTarget = OcclusionBox | OcclusionMesh | Mesh;
/**
 * What a query that waited more than `retries` frames reads: `'optimistic'` visible, `'strict'` occluded.
 */
export type OcclusionStrategy = 'optimistic' | 'strict';

/** Per-object settings; unset fields take the {@link OcclusionQueries} value. */
export interface OcclusionQueryOptions {
  /**
   * Frames a result may be outstanding before `strategy` decides, a whole number from -1; -1 (the default) keeps the
   * last result however long the GPU takes. Results normally land one to three frames after the query.
   */
  retries?: number;
  /** Default `'optimistic'`. */
  strategy?: OcclusionStrategy;
}
/** `OcclusionQueries` settings. */
export interface OcclusionQueriesOptions extends OcclusionQueryOptions {
  /** Most objects queried per frame, 1 to 65,536 (4,096 a query set; more use several). Default 1,024. Fixed. */
  capacity?: number;
  /**
   * The view (its `id`) to query in. Default: the canvas's first view, or the plain canvas frame. Each other view is
   * left alone.
   */
  view?: string;
  /** Frame graph order; after core's main pass (order 0) and before passes that write other depth. Default 1. */
  order?: number;
}

const SET = 4096,
  RING = 3,
  // The corners of a unit box's 12 triangles, in the box's [0, 1] cube.
  CUBE = new Float32Array(
    [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5,
    ].flatMap((c) => [c & 1, (c >> 1) & 1, (c >> 2) & 1]),
  ),
  SHADER = `@group(0) @binding(0) var<uniform> camera: mat4x4f;
@vertex fn vertex(@location(0) corner: vec3f, @location(1) lo: vec3f, @location(2) hi: vec3f) -> @builtin(position) vec4f {
  return camera * vec4f(mix(lo, hi, corner), 1.0);
}`;

const whole = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
function checkObject(retries: unknown, strategy: unknown): void {
  if (retries !== undefined && !whole(retries as number, -1, 1e9))
    throw new RangeError('Invalid occlusion retries; pass a whole number from -1 (never force) up');
  if (strategy !== undefined && strategy !== 'optimistic' && strategy !== 'strict')
    throw new TypeError('Invalid occlusion strategy; use "optimistic" or "strict"');
}

/** One object's query state, made by {@link OcclusionQueries.add}. */
export class OcclusionQuery {
  /** True when no sample of the box passed the depth test in the newest result (off-screen counts as occluded). */
  isOccluded = false;
  /**
   * Samples that passed in the newest GPU result: 0 when occluded, nonzero when visible. WebGPU promises only zero or
   * not (D3D12 and the WebGL2 layer report 1); a box decided without a query reads 0 off-screen and 1 when cut by the
   * near or far plane.
   */
  samples = 0;
  /** Frames since the newest result (0 the frame it landed or was decided on the CPU). */
  pendingFrames = 0;
  /** A result has landed or been decided since `add`. */
  hasResult = false;
  retries: number | undefined;
  strategy: OcclusionStrategy | undefined;
  /** @internal The query frame of the newest result (or of `add`). */
  frame: number;
  /** @internal */
  owner: OcclusionQueries | undefined;
  constructor(
    readonly target: OcclusionTarget,
    owner: OcclusionQueries,
    frame: number,
    { retries, strategy }: OcclusionQueryOptions,
  ) {
    checkObject(retries, strategy);
    this.owner = owner;
    this.frame = frame;
    this.retries = retries;
    this.strategy = strategy;
  }
  /** Stops querying this object (same as `queries.remove(this)`). */
  dispose(): void {
    this.owner?.remove(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Where a world box [lo, hi] lies against normalized inside-positive frustum planes (core's `camera.planes`, near and
 * far at 4 and 5): 0 outside, 1 cut by the near or far plane (a query would miss the clipped part), 2 inside.
 */
export function classifyBox(lo: ArrayLike<number>, hi: ArrayLike<number>, planes: ArrayLike<number>): 0 | 1 | 2 {
  let cut = false;
  for (let p = 0; p < 6; p++) {
    const nx = planes[p * 4],
      ny = planes[p * 4 + 1],
      nz = planes[p * 4 + 2],
      centre = nx * (lo[0] + hi[0]) * 0.5 + ny * (lo[1] + hi[1]) * 0.5 + nz * (lo[2] + hi[2]) * 0.5 + planes[p * 4 + 3],
      reach = (Math.abs(nx) * (hi[0] - lo[0]) + Math.abs(ny) * (hi[1] - lo[1]) + Math.abs(nz) * (hi[2] - lo[2])) * 0.5;
    if (centre + reach < 0) return 0;
    if (p >= 4 && centre - reach < 0) cut = true;
  }
  return cut ? 1 : 2;
}

interface Slot {
  buffer: GPUBuffer;
  busy: boolean;
  serial: number;
  list: OcclusionQuery[];
}
interface Gpu {
  device: GPUDevice;
  sets: GPUQuerySet[];
  resolve: GPUBuffer;
  stamp: GPUBuffer;
  instances: GPUBuffer;
  cube: GPUBuffer;
  camera: GPUBuffer;
  slots: Slot[];
  pipelines: Map<string, { pipeline: GPURenderPipeline; group: GPUBindGroup }>;
}

let serial = 0;
/**
 * Hardware occlusion queries for app objects: add boxes or core meshes, read `isOccluded` and `samples` each frame.
 * Works on WebGPU and on the WebGL2 compatibility layer; refuses core's WebGL2 preview.
 * @throws MargoError `'unsupported'` on the WebGL2 preview, `'disposed'` after `dispose()`.
 */
export class OcclusionQueries implements EnginePlugin {
  readonly name = 'occlusion-queries:' + ++serial;
  readonly capacity: number;
  /** Default retries for objects that set none. */
  retries: number;
  /** Default strategy for objects that set none. */
  strategy: OcclusionStrategy;
  readonly view: string | undefined;
  readonly order: number;
  disposed = false;
  private engine?: Engine;
  private gpu?: Gpu;
  private readonly list: OcclusionQuery[] = [];
  private readonly data: Float32Array;
  private readonly stampWord = new Uint32Array(2);
  private readonly lo = new Float64Array(3);
  private readonly hi = new Float64Array(3);
  private readonly boxes = new WeakMap<Geometry, Float64Array>();
  private serial = 0;
  private waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  /** Same as `engine.use(new OcclusionQueries(options))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: OcclusionQueriesOptions): OcclusionQueries {
    const value = new OcclusionQueries(options);
    engine.use(value);
    return value;
  }
  constructor({
    capacity = 1024,
    retries = -1,
    strategy = 'optimistic',
    view,
    order = 1,
  }: OcclusionQueriesOptions = {}) {
    if (!whole(capacity, 1, 65536))
      throw new RangeError('Invalid occlusion capacity; pass a whole number from 1 to 65536');
    checkObject(retries, strategy);
    if (view !== undefined && typeof view !== 'string')
      throw new TypeError('Invalid occlusion view; pass a view id string');
    if (!(order > 0 && Number.isFinite(order)))
      throw new RangeError("Invalid occlusion order; pass a finite number above 0 (after core's main pass)");
    this.capacity = capacity;
    this.retries = retries;
    this.strategy = strategy;
    this.view = view;
    this.order = order;
    this.data = new Float32Array(capacity * 6);
  }
  /** Objects added. */
  get size(): number {
    return this.list.length;
  }
  /** Starts querying `target` from the next frame; until its first result it reads visible. */
  add(target: OcclusionTarget, options: OcclusionQueryOptions = {}): OcclusionQuery {
    this.live();
    if (!target || !(('matrix' in target && 'geometry' in target) || ('min' in target && 'max' in target)))
      throw new TypeError('Invalid occlusion target; pass { min, max } world box or a core Mesh');
    if (this.list.length >= this.capacity)
      throw new RangeError(
        `OcclusionQueries holds ${this.capacity} objects; remove one or create it with a larger capacity`,
      );
    const query = new OcclusionQuery(target, this, this.serial, options);
    this.list.push(query);
    return query;
  }
  /** Stops querying; a result still in flight for it is dropped. */
  remove(query: OcclusionQuery): void {
    const i = this.list.indexOf(query);
    if (i < 0) return;
    this.list.splice(i, 1);
    query.owner = undefined;
  }
  /**
   * Resolves once the next set of results has been applied (a GPU readback landing, or a frame that needed no query).
   * Rejects with the signal's reason when `signal` aborts, and with MargoError `'disposed'` on `dispose()`.
   */
  next({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    this.live();
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
        reject,
      };
      const abort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }
  setup(engine: Engine): void {
    this.live();
    requireWebGPU(engine, 'OcclusionQueries');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.mine(c)) this.query(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.release();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
    for (const q of this.list) q.owner = undefined;
    this.list.length = 0;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(new MargoError('disposed', 'OcclusionQueries is disposed; create a new one'));
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'OcclusionQueries is disposed; create a new one');
  }
  private mine(c: Context): boolean {
    const v = c.view;
    return this.view === undefined ? !v || (v.index === 0 && !v.target) : v?.id === this.view;
  }
  /** The world box of `q` into lo/hi; false when it has nothing to draw. */
  private box(q: OcclusionQuery): boolean {
    const t = q.target,
      lo = this.lo,
      hi = this.hi;
    if ('min' in t) {
      for (let k = 0; k < 3; k++) {
        lo[k] = t.min[k];
        hi[k] = t.max[k];
        if (!(Number.isFinite(lo[k]) && Number.isFinite(hi[k]) && lo[k] <= hi[k]))
          throw new RangeError('Invalid occlusion box; min and max need three finite numbers with min <= max');
      }
    } else {
      // A core Mesh's runtime object holds its world matrix view (core's Mesh class); `add` checked both fields.
      const g = (t as OcclusionMesh).geometry;
      if (!g?.indices.length) return false;
      let local = this.boxes.get(g);
      if (!local) this.boxes.set(g, (local = localBox(g)));
      // Arvo 1990: the world box of a transformed box is the centre moved and the extent through |M|.
      const m = (t as OcclusionMesh).matrix;
      for (let k = 0; k < 3; k++) {
        let c = m[12 + k],
          e = 0;
        for (let a = 0; a < 3; a++) {
          const centre = (local[a] + local[a + 3]) * 0.5,
            half = (local[a + 3] - local[a]) * 0.5;
          c += m[a * 4 + k] * centre;
          e += Math.abs(m[a * 4 + k]) * half;
        }
        lo[k] = c - e;
        hi[k] = c + e;
      }
    }
    // Grown by 0.1% of the largest side (and a float32 step of the position) so an object's own faces, drawn by
    // core with another rounding of the same transform, never hide its box.
    const pad =
      Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-3 +
      1e-6 *
        Math.max(
          Math.abs(lo[0]),
          Math.abs(hi[0]),
          Math.abs(lo[1]),
          Math.abs(hi[1]),
          Math.abs(lo[2]),
          Math.abs(hi[2]),
          1,
        );
    for (let k = 0; k < 3; k++) {
      lo[k] -= pad;
      hi[k] += pad;
    }
    return true;
  }
  private decide(q: OcclusionQuery, samples: number, frame: number): void {
    q.samples = samples;
    q.isOccluded = samples === 0;
    q.frame = frame;
    q.pendingFrames = this.serial - frame;
    q.hasResult = true;
  }
  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve();
  }
  private create(c: Context): Gpu {
    const d = c.device,
      U = GPUBufferUsage,
      cube = d.createBuffer({
        label: 'occlusion box',
        size: CUBE.byteLength,
        usage: U.VERTEX | U.COPY_DST,
      });
    d.queue.writeBuffer(cube, 0, CUBE);
    const bytes = this.capacity * 8;
    return {
      device: d,
      sets: Array.from({ length: Math.ceil(this.capacity / SET) }, (_, i) =>
        d.createQuerySet({
          label: 'occlusion queries',
          type: 'occlusion',
          count: Math.min(SET, this.capacity - i * SET),
        }),
      ),
      resolve: d.createBuffer({
        label: 'occlusion results',
        size: bytes,
        usage: U.QUERY_RESOLVE | U.COPY_SRC,
      }),
      stamp: d.createBuffer({
        label: 'occlusion frame',
        size: 8,
        usage: U.COPY_SRC | U.COPY_DST,
      }),
      instances: d.createBuffer({
        label: 'occlusion boxes',
        size: this.capacity * 24,
        usage: U.VERTEX | U.COPY_DST,
      }),
      cube,
      camera: d.createBuffer({
        label: 'occlusion camera',
        size: 64,
        usage: U.UNIFORM | U.COPY_DST,
      }),
      slots: Array.from({ length: RING }, () => ({
        buffer: d.createBuffer({
          label: 'occlusion readback',
          size: bytes + 8,
          usage: U.MAP_READ | U.COPY_DST,
        }),
        busy: false,
        serial: -1,
        list: [],
      })),
      pipelines: new Map(),
    };
  }
  /** The depth-test-only box pipeline for the frame's depth format, compare and sample count. */
  private pipeline(g: Gpu, c: Context): { pipeline: GPURenderPipeline; group: GPUBindGroup } {
    const ds = c.descriptor.depthStencil!,
      samples = c.descriptor.multisample?.count ?? 1,
      compare = ds.depthCompare ?? 'greater-equal',
      key = `${ds.format} ${compare} ${samples}`;
    let entry = g.pipelines.get(key);
    if (!entry) {
      const d = g.device,
        module = d.createShaderModule({ label: 'occlusion box', code: SHADER }),
        pipeline = d.createRenderPipeline({
          label: 'occlusion box',
          layout: 'auto',
          vertex: {
            module,
            entryPoint: 'vertex',
            buffers: [
              {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
              },
              {
                arrayStride: 24,
                stepMode: 'instance',
                attributes: [
                  { shaderLocation: 1, offset: 0, format: 'float32x3' },
                  { shaderLocation: 2, offset: 12, format: 'float32x3' },
                ],
              },
            ],
          },
          // Both faces: a box drawn from inside or edge-on still covers every pixel its object can.
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: { count: samples },
          depthStencil: {
            format: ds.format,
            depthWriteEnabled: false,
            depthCompare: compare,
          },
        });
      entry = {
        pipeline,
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: g.camera } }],
        }),
      };
      g.pipelines.set(key, entry);
    }
    return entry;
  }
  private query(c: Context): void {
    if (this.gpu && this.gpu.device !== c.device) this.release();
    const g = (this.gpu ??= this.create(c)),
      frame = ++this.serial,
      slot = g.slots.find((s) => !s.busy),
      planes = c.camera.planes,
      data = this.data,
      list = slot?.list;
    let n = 0;
    if (list) list.length = 0;
    for (const q of this.list) {
      const where = this.box(q) ? classifyBox(this.lo, this.hi, planes) : 0;
      if (where === 2 && list) {
        for (let k = 0; k < 3; k++) {
          data[n * 6 + k] = this.lo[k];
          data[n * 6 + 3 + k] = this.hi[k];
        }
        list[n++] = q;
      } else if (where !== 2) this.decide(q, where, frame);
      if (q.frame === frame) continue;
      q.pendingFrames = frame - q.frame;
      const retries = q.retries ?? this.retries;
      if (retries >= 0 && q.pendingFrames > retries) q.isOccluded = (q.strategy ?? this.strategy) === 'strict';
    }
    if (!n) {
      if (list) this.wake();
      return;
    }
    const d = g.device,
      { pipeline, group } = this.pipeline(g, c),
      e = c.encoder,
      v = c.view,
      stencil = c.descriptor.depthStencil!.format.includes('stencil');
    d.queue.writeBuffer(g.instances, 0, data as Float32Array<ArrayBuffer>, 0, n * 6);
    d.queue.writeBuffer(g.camera, 0, c.camera.matrix as Float32Array<ArrayBuffer>);
    this.stampWord[0] = frame;
    d.queue.writeBuffer(g.stamp, 0, this.stampWord);
    for (let first = 0; first < n; first += SET) {
      const count = Math.min(SET, n - first),
        pass = e.beginRenderPass({
          label: 'occlusion queries',
          colorAttachments: [],
          depthStencilAttachment: {
            view: c.depth,
            depthReadOnly: true,
            stencilReadOnly: stencil || undefined,
          },
          occlusionQuerySet: g.sets[first / SET],
        });
      if (v) {
        pass.setViewport(...v.viewport, 0, 1);
        pass.setScissorRect(...(v.scissor ?? v.viewport));
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, g.cube);
      pass.setVertexBuffer(1, g.instances);
      for (let i = 0; i < count; i++) {
        pass.beginOcclusionQuery(i);
        pass.draw(36, 1, 0, first + i);
        pass.endOcclusionQuery();
      }
      pass.end();
      e.resolveQuerySet(g.sets[first / SET], 0, count, g.resolve, first * 8);
    }
    e.copyBufferToBuffer(g.resolve, 0, slot!.buffer, 0, n * 8);
    e.copyBufferToBuffer(g.stamp, 0, slot!.buffer, this.capacity * 8, 8);
    slot!.busy = true;
    slot!.serial = frame;
    // Mapped once core has submitted this frame (after the graph, in the same task). A frame that threw before its
    // submit leaves the slot's old stamp, so its stale results are dropped.
    queueMicrotask(() => this.read(g, slot!));
  }
  private read(g: Gpu, slot: Slot): void {
    const buffer = slot.buffer;
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const words = new Uint32Array(buffer.getMappedRange()),
          frame = slot.serial;
        if (this.gpu === g && words[this.capacity * 2] === frame)
          for (let i = 0; i < slot.list.length; i++) {
            const q = slot.list[i];
            if (q.owner === this && q.frame < frame) this.decide(q, words[i * 2] + words[i * 2 + 1] * 2 ** 32, frame);
          }
        buffer.unmap();
        slot.busy = false;
        if (this.gpu === g) this.wake();
      },
      (error) => {
        // A released buffer (device restored or dispose) rejects its mapping: its results belong to no device now.
        if (this.gpu === g) throw error;
      },
    );
  }
  private release(): void {
    const g = this.gpu;
    this.gpu = undefined;
    if (!g) return;
    for (const s of g.sets) s.destroy();
    for (const b of [g.resolve, g.stamp, g.instances, g.cube, g.camera, ...g.slots.map((s) => s.buffer)]) b.destroy();
  }
}
