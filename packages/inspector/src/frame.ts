/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type FramePass,
  type PassContext,
} from '@margoengine/core/extension';
import { GPUProfiler } from '@margoengine/stats';
import { FramePanel } from './frame-panel.js';

declare const GPUBufferUsage: { COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** A texture used by the captured frame, read from the GPUTexture itself. */
export interface TextureReport {
  label: string;
  format: string;
  width: number;
  height: number;
  depthOrArrayLayers: number;
  sampleCount: number;
  mipLevelCount: number;
}

/** One render target of a render pass. `view` is null when the view was created before the debugger attached. */
export interface AttachmentReport {
  target: 'color' | 'depth';
  index: number;
  view: TextureReport | null;
  resolveTarget?: TextureReport | null;
  loadOp?: string;
  storeOp?: string;
  stencilLoadOp?: string;
  stencilStoreOp?: string;
  readOnly?: boolean;
}

/** What a bind group entry points at. */
export interface BindingReport {
  binding: number;
  kind: 'buffer' | 'texture' | 'sampler' | 'external-texture' | 'unknown';
  resource: string;
}

/** A bind group used by the frame. `entries` is null when the group was created before the debugger attached. */
export interface BindGroupReport {
  id: number;
  label: string;
  entries: BindingReport[] | null;
}

/**
 * A pipeline used (or compiled) by the frame. Descriptor fields are absent when the pipeline was created before the
 * debugger attached. `textures`/`samplers` are the most bound by any one command using it (all its bind groups
 * summed), against the 16 of each per shader stage that WebGPU guarantees.
 */
export interface PipelineReport {
  id: number;
  kind: 'render' | 'compute';
  label: string;
  createdThisFrame: boolean;
  known: boolean;
  /** Frame graph passes that used it (names most WebGPU code leaves unlabeled pipelines by). */
  passes: string[];
  topology?: string;
  cullMode?: string;
  /** Per color target: `none` or `operation(srcFactor, dstFactor)` of the color blend. */
  blend?: string[];
  formats?: string[];
  depth?: { format: string; write: boolean; compare: string } | null;
  samples?: number;
  textures: number;
  samplers: number;
}

/** Kinds of recorded commands. */
export type CommandKind =
  | 'draw'
  | 'drawIndexed'
  | 'drawIndirect'
  | 'drawIndexedIndirect'
  | 'dispatchWorkgroups'
  | 'dispatchWorkgroupsIndirect'
  | 'executeBundles';

/**
 * One draw, dispatch or bundle execution. Indirect counts are read back after the frame when the arguments buffer has
 * COPY_SRC usage, else null. `entities` are core mesh ids whose geometry owns this draw's vertex buffer.
 */
export interface CommandReport {
  kind: CommandKind;
  pipeline: number | null;
  bindGroups: Array<number | null>;
  vertexCount?: number | null;
  indexCount?: number | null;
  instanceCount?: number | null;
  workgroups?: [number, number, number] | null;
  bundles?: number;
  indirect?: { buffer: string; offset: number };
  triangles: number | null;
  entities: number[];
}

/** One GPU render or compute pass. `gpuMilliseconds` needs timestamp queries and a pass on the frame graph's encoder. */
export interface GPUPassReport {
  kind: 'render' | 'compute';
  label: string;
  encoder: number;
  gpuMilliseconds: number | null;
  attachments: AttachmentReport[];
  commands: CommandReport[];
}

/** One frame graph pass (core's `main`, or a plugin pass) and the GPU passes it encoded. */
export interface FramePassReport {
  name: string;
  /** Plugin that registered the pass; `core` for the main pass, `engine` for work outside the graph, `app` for unowned passes. */
  owner: string;
  order: number | null;
  cpuMilliseconds: number;
  gpuMilliseconds: number | null;
  passes: GPUPassReport[];
}

/** Live GPU memory created while the debugger was attached (earlier resources are not counted). */
export interface MemoryReport {
  bytes: number;
  buffers: { count: number; bytes: number };
  textures: { count: number; bytes: number };
  largest: Array<{ kind: 'buffer' | 'texture'; label: string; bytes: number }>;
}

/** Everything `FrameDebugger.capture()` recorded for one frame; plain JSON. */
export interface FrameReport {
  /** `gpu` when pass times come from timestamp queries, else `cpu` (encode time). */
  timing: 'gpu' | 'cpu';
  note: string;
  cpuMilliseconds: number;
  gpuMilliseconds: number | null;
  graph: FramePassReport[];
  pipelines: PipelineReport[];
  bindGroups: BindGroupReport[];
  totals: {
    draws: number;
    indexedDraws: number;
    indirectDraws: number;
    dispatches: number;
    triangles: number;
    instances: number;
    renderPasses: number;
    computePasses: number;
    encoders: number;
    submits: number;
    pipelinesCreated: number;
    shaderModulesCreated: number;
    bindGroupsCreated: number;
    uploads: number;
    uploadBytes: number;
  };
  /** Uploads per destination, largest first (at most 20). */
  uploads: Array<{ target: string; calls: number; bytes: number }>;
  memory: MemoryReport;
  warnings: string[];
}

/** Options for `FrameDebugger.attach`. */
export interface FrameDebuggerOptions {
  /** Element for the DOM panel; null for no panel (tests, CI). Default `document.body` when there is a document. */
  parent?: HTMLElement | null;
}

/** Options for `FrameDebugger.capture`. */
export interface CaptureOptions {
  /** Render the frame now instead of waiting for the engine's next frame (static scenes, tests). */
  render?: boolean;
}

// ---- internals ----

type Unpatch<T> = (target: T) => void;
/** Replaces `target[key]`; the returned function restores it unless someone wrapped on top since (ours then stays as a pass-through). */
function patch<T extends object, K extends keyof T>(target: T, key: K, make: (original: T[K]) => T[K]): Unpatch<T> {
  const own = Object.hasOwn(target, key),
    original = target[key];
  // A method the object lacks stays missing, so feature checks (`if (device.createRenderPipelineAsync)`) still hold.
  if (typeof original !== 'function') return () => {};
  const wrapper = make(original);
  target[key] = wrapper;
  return (object) => {
    if (object[key] !== wrapper) return;
    if (own) object[key] = original;
    else Reflect.deleteProperty(object, key);
  };
}
function hold<T>(list: Array<() => void>, target: T, unpatch: Unpatch<T>): void {
  list.push(() => unpatch(target));
}
type Method = (this: unknown, ...args: unknown[]) => unknown;
/** Untyped view of an object's methods, for wrappers that only observe and forward their arguments. */
const methods = (target: object): Record<string, Method> => target as unknown as Record<string, Method>;

type AnyPipeline = GPURenderPipeline | GPUComputePipeline;
type GraphRecord = FramePass & { owner?: string };
type PipelineFields = Pick<PipelineReport, 'topology' | 'cullMode' | 'blend' | 'formats' | 'depth' | 'samples'>;
interface PipelineInfo {
  kind: 'render' | 'compute';
  fields: PipelineFields;
}
interface GroupInfo {
  label: string;
  entries: GPUBindGroupEntry[];
}
interface Tracked {
  kind: 'buffer' | 'texture';
  ref: WeakRef<GPUBuffer | GPUTexture>;
  unpatch: Array<Unpatch<Record<string, Method>>>;
}
interface RawCommand {
  kind: CommandKind;
  pipeline: AnyPipeline | null;
  groups: Array<GPUBindGroup | null>;
  vertex?: GPUBuffer;
  args: number[];
  indirect?: { buffer: GPUBuffer; offset: number; slot: number };
}
interface RawPass {
  kind: 'render' | 'compute';
  label: string;
  encoder: number;
  timestamp: number;
  attachments: AttachmentReport[];
  commands: RawCommand[];
}
interface RawGraphPass {
  name: string;
  owner: string;
  order: number | null;
  cpu: number;
  passes: RawPass[];
}

const isPass = (value: unknown): value is GraphRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as FramePass).execute === 'function' &&
  typeof (value as FramePass).name === 'string';
/** Core's FrameGraph keeps its pass list private (and its build renames the field), so it is found by shape. */
function graphPasses(graph: FrameGraph): GraphRecord[] {
  for (const value of Object.values(graph))
    if (Array.isArray(value) && value.length && value.every(isPass)) return value;
  return [];
}

const MAX_INDIRECT = 1024;
/** drawIndexedIndirect reads 5 u32 arguments, drawIndirect 4. */
const argumentBytes = (kind: CommandKind): number => (kind === 'drawIndexedIndirect' ? 20 : 16);
const nameOf = (value: object): string => (value as { constructor?: { name?: string } }).constructor?.name ?? '';

/** Bytes per texel of a WebGPU texture format (block-compressed formats averaged over the block). */
export function texelBytes(format: string): number {
  const astc = /^astc-(\d+)x(\d+)/.exec(format);
  if (astc) return 16 / (Number(astc[1]) * Number(astc[2]));
  if (/^(bc[14]-|etc2-rgb8|eac-r11)/.test(format)) return 0.5;
  if (/^(bc|etc2|eac)/.test(format)) return 1;
  if (format === 'depth32float-stencil8') return 5;
  if (format === 'stencil8') return 1;
  if (format === 'depth16unorm') return 2;
  const plain = /^(rgba|bgra|rg|r)(8|16|32)/.exec(format);
  return plain ? (plain[1].length * Number(plain[2])) / 8 : 4;
}

/** Estimated bytes of a texture: every mip level, layer and sample. */
export function textureBytes(texture: GPUTexture): number {
  let texels = 0;
  for (let level = 0; level < texture.mipLevelCount; level++) {
    const depth =
      texture.dimension === '3d' ? Math.max(1, texture.depthOrArrayLayers >> level) : texture.depthOrArrayLayers;
    texels += Math.max(1, texture.width >> level) * Math.max(1, texture.height >> level) * depth;
  }
  return Math.ceil(texels * texelBytes(texture.format) * texture.sampleCount);
}

function describeTexture(texture: GPUTexture): TextureReport {
  const { label, format, width, height, depthOrArrayLayers, sampleCount, mipLevelCount } = texture;
  return { label, format, width, height, depthOrArrayLayers, sampleCount, mipLevelCount };
}
const describeBuffer = (buffer: GPUBuffer): string => `${buffer.label || 'buffer'} (${buffer.size} B)`;

function describePipeline(descriptor: GPURenderPipelineDescriptor): PipelineFields {
  const targets = [...(descriptor.fragment?.targets ?? [])].filter((target): target is GPUColorTargetState => !!target);
  const depth = descriptor.depthStencil;
  return {
    topology: descriptor.primitive?.topology ?? 'triangle-list',
    cullMode: descriptor.primitive?.cullMode ?? 'none',
    formats: targets.map((target) => target.format),
    blend: targets.map(({ blend }) =>
      blend
        ? `${blend.color.operation ?? 'add'}(${blend.color.srcFactor ?? 'one'}, ${blend.color.dstFactor ?? 'zero'})`
        : 'none',
    ),
    depth: depth
      ? { format: depth.format, write: !!depth.depthWriteEnabled, compare: depth.depthCompare ?? 'always' }
      : null,
    samples: descriptor.multisample?.count ?? 1,
  };
}

function uploadBytes(data: AllowSharedBufferSource, offset = 0, size?: number): number {
  const element = ArrayBuffer.isView(data) ? ((data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : 1;
  return size === undefined ? data.byteLength - offset * element : size * element;
}

function extent(size: unknown): number[] {
  if (typeof size === 'object' && size !== null && Symbol.iterator in size) return [...(size as Iterable<number>)];
  const { width, height = 1, depthOrArrayLayers = 1 } = size as GPUExtent3DDict;
  return [width, height, depthOrArrayLayers];
}

function triangles(topology: string | undefined, count: number | null, instances: number | null): number | null {
  if (count === null || instances === null) return null;
  if (topology === 'triangle-strip') return Math.max(0, count - 2) * instances;
  return !topology || topology === 'triangle-list' ? Math.floor(count / 3) * instances : 0;
}

/** State of one capture, alive only while its frame is recorded. */
class Session {
  live = true;
  readonly start = performance.now();
  cpu = 0;
  readonly before: RawGraphPass = { name: '(before frame graph)', owner: 'engine', order: null, cpu: 0, passes: [] };
  readonly after: RawGraphPass = { name: '(after frame graph)', owner: 'engine', order: null, cpu: 0, passes: [] };
  readonly graph: RawGraphPass[] = [];
  current = this.before;
  main?: GPUCommandEncoder;
  encoders = 0;
  submits = 0;
  timed = 0;
  resolved = false;
  shaderModules = 0;
  asyncPipelines = 0;
  bindGroups = 0;
  readback?: GPUBuffer;
  readonly created = new Set<AnyPipeline>();
  readonly uploads = new Map<object, { target: string; calls: number; bytes: number }>();
  readonly indirect: RawCommand[] = [];
  readonly unpatch: Array<() => void> = [];
  constructor(readonly profiled: boolean) {}

  upload(target: object, label: string, bytes: number): void {
    const entry = this.uploads.get(target) ?? { target: label, calls: 0, bytes: 0 };
    entry.calls++;
    entry.bytes += bytes;
    this.uploads.set(target, entry);
  }

  close(): void {
    this.live = false;
    this.cpu = performance.now() - this.start;
    for (const restore of this.unpatch.reverse()) restore();
  }
}

/**
 * Frame debugger: `capture()` records one frame (frame graph passes, GPU passes, draws, pipelines, bind groups,
 * render targets, uploads, GPU memory) and resolves with a JSON report; an optional DOM panel shows it.
 *
 * While attached it wraps only the device's resource-creation calls (pipeline and bind group descriptions, GPU memory).
 * The per-frame path (engine.render, the frame graph, command encoders, passes, queue writes) is wrapped only for the
 * captured frame and restored right after. Not importing `@margoengine/inspector/frame` costs nothing.
 */
export class FrameDebugger implements EnginePlugin {
  readonly name = 'frame-debugger';
  /** The last completed report. */
  report: FrameReport | null = null;
  private engine?: Engine;
  private device?: GPUDevice;
  private profiler?: GPUProfiler;
  private disposed = false;
  private paused = false;
  private session?: Session;
  private pending?: { promise: Promise<FrameReport>; reject: (error: unknown) => void; disarm: () => void };
  private readonly panel?: FramePanel;
  private unpatchDevice: Array<() => void> = [];
  private readonly tracked = new Set<Tracked>();
  private readonly pipelines = new WeakMap<object, PipelineInfo>();
  private readonly groups = new WeakMap<object, GroupInfo>();
  private readonly views = new WeakMap<object, GPUTexture>();

  constructor({ parent }: FrameDebuggerOptions = {}) {
    const host = parent === undefined ? (typeof document === 'undefined' ? null : document.body) : parent;
    if (host)
      this.panel = new FramePanel(
        host,
        () => this.captureFromPanel(),
        (entity) => this.select(entity),
      );
  }

  /** Creates the debugger and attaches it to the engine (`engine.use(new FrameDebugger(options))`). */
  static attach(engine: EngineKernel, options: FrameDebuggerOptions = {}): FrameDebugger {
    const instance = new FrameDebugger(options);
    try {
      engineRuntime(engine).use(instance);
      return instance;
    } catch (error) {
      instance.dispose();
      throw error;
    }
  }

  /** Engine plugin hook: starts resource bookkeeping on the engine's device. */
  setup(engine: Engine): void {
    if (this.disposed || this.engine) throw new Error('FrameDebugger is disposed or attached');
    this.engine = engine;
    if (engine.gpu) this.track(engine.gpu);
  }

  /** Engine plugin hook: moves bookkeeping to the restored device (memory counts restart from zero). */
  onDeviceRestored(engine: Engine): void {
    this.untrack();
    if (engine.gpu) this.track(engine.gpu);
  }

  /**
   * Records the next frame the engine renders (or one rendered now with `{render: true}`) and resolves with its report
   * once GPU timestamps and indirect arguments are read back. A call while one is pending returns the same promise.
   */
  capture(options: CaptureOptions = {}): Promise<FrameReport> {
    const engine = this.engine;
    if (this.disposed || !engine) return Promise.reject(new Error('FrameDebugger is not attached'));
    if (engine.backend !== 'webgpu' || !engine.gpu) return Promise.reject(new Error('Frame capture needs WebGPU'));
    let pending = this.pending;
    if (!pending) {
      let resolve!: (report: FrameReport) => void, reject!: (error: unknown) => void;
      const promise = new Promise<FrameReport>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const self = this,
        restore = patch(
          engine,
          'render',
          (original) =>
            function (this: Engine, frame?: Parameters<Engine['render']>[0]): void {
              if (self.pending?.promise !== promise) return original.call(this, frame);
              self.pending.disarm();
              self.record(() => original.call(this, frame), resolve, reject);
            },
        );
      pending = this.pending = {
        promise,
        reject,
        disarm: () => {
          restore(engine);
          this.pending = undefined;
        },
      };
    }
    if (options.render) {
      try {
        engine.render();
      } catch {
        // The capture promise carries the error.
      }
    }
    return pending.promise;
  }

  /** GPU memory of the live buffers and textures created while attached. */
  memory(): MemoryReport {
    const report: MemoryReport = {
      bytes: 0,
      buffers: { count: 0, bytes: 0 },
      textures: { count: 0, bytes: 0 },
      largest: [],
    };
    for (const entry of this.tracked) {
      const resource = entry.ref.deref();
      if (!resource) {
        this.tracked.delete(entry);
        continue;
      }
      const bytes = entry.kind === 'buffer' ? (resource as GPUBuffer).size : textureBytes(resource as GPUTexture);
      const bucket = entry.kind === 'buffer' ? report.buffers : report.textures;
      bucket.count++;
      bucket.bytes += bytes;
      report.bytes += bytes;
      const texture = resource as GPUTexture;
      report.largest.push({
        kind: entry.kind,
        label:
          entry.kind === 'buffer'
            ? resource.label || 'buffer'
            : `${texture.label || 'texture'} ${texture.format} ${texture.width}x${texture.height}${texture.sampleCount > 1 ? ' x' + texture.sampleCount : ''}`,
        bytes,
      });
    }
    report.largest = report.largest.sort((a, b) => b.bytes - a.bytes).slice(0, 10);
    return report;
  }

  /** Removes the panel and every wrapper, rejects a pending capture and detaches from the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.pending;
    pending?.disarm();
    pending?.reject(new Error('FrameDebugger disposed'));
    this.untrack();
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
    this.panel?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private captureFromPanel(): void {
    const promise = this.capture();
    promise.catch((error) => this.engine?.onError(error));
    // A stopped engine never renders on its own: render once if the next display frame did not.
    requestAnimationFrame(() => {
      if (this.pending?.promise === promise) void this.capture({ render: true }).catch(() => {});
    });
  }

  private select(entity: number): void {
    const mesh = this.engine?.meshes.get(entity);
    const inspector = this.engine?.plugins.get('inspector') as
      | (EnginePlugin & { select?: (mesh: MeshHandle | null) => void })
      | undefined;
    if (mesh && typeof inspector?.select === 'function') inspector.select(mesh);
  }

  // ---- resource bookkeeping, while attached ----

  private track(device: GPUDevice): void {
    this.device = device;
    const self = this,
      keep = <T>(target: T, unpatch: Unpatch<T>): void => hold(this.unpatchDevice, target, unpatch);
    keep(
      device,
      patch(
        device,
        'createBuffer',
        (original) =>
          function (this: GPUDevice, descriptor: GPUBufferDescriptor): GPUBuffer {
            const buffer = original.call(this, descriptor);
            if (self.device === device && !self.paused) self.trackResource(buffer, 'buffer');
            return buffer;
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createTexture',
        (original) =>
          function (this: GPUDevice, descriptor: GPUTextureDescriptor): GPUTexture {
            const texture = original.call(this, descriptor);
            if (self.device === device && !self.paused) self.trackResource(texture, 'texture');
            return texture;
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createRenderPipeline',
        (original) =>
          function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
            const pipeline = original.call(this, descriptor);
            self.pipelineCreated(device, pipeline, 'render', describePipeline(descriptor), true);
            return pipeline;
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createComputePipeline',
        (original) =>
          function (this: GPUDevice, descriptor: GPUComputePipelineDescriptor): GPUComputePipeline {
            const pipeline = original.call(this, descriptor);
            self.pipelineCreated(device, pipeline, 'compute', {}, true);
            return pipeline;
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createRenderPipelineAsync',
        (original) =>
          function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
            const promise = original.call(this, descriptor);
            if (self.session?.live) self.session.asyncPipelines++;
            promise.then(
              (pipeline) => self.pipelineCreated(device, pipeline, 'render', describePipeline(descriptor), false),
              () => {},
            );
            return promise;
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createComputePipelineAsync',
        (original) =>
          function (this: GPUDevice, descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline> {
            const promise = original.call(this, descriptor);
            if (self.session?.live) self.session.asyncPipelines++;
            promise.then(
              (pipeline) => self.pipelineCreated(device, pipeline, 'compute', {}, false),
              () => {},
            );
            return promise;
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createBindGroup',
        (original) =>
          function (this: GPUDevice, descriptor: GPUBindGroupDescriptor): GPUBindGroup {
            const group = original.call(this, descriptor);
            if (self.device === device) {
              self.groups.set(group, { label: descriptor.label ?? '', entries: [...descriptor.entries] });
              if (self.session?.live) self.session.bindGroups++;
            }
            return group;
          },
      ),
    );
  }

  private pipelineCreated(
    device: GPUDevice,
    pipeline: AnyPipeline,
    kind: 'render' | 'compute',
    fields: PipelineFields,
    sync: boolean,
  ): void {
    if (this.device !== device) return;
    this.pipelines.set(pipeline, { kind, fields });
    if (sync && this.session?.live) this.session.created.add(pipeline);
  }

  private trackResource(resource: GPUBuffer | GPUTexture, kind: 'buffer' | 'texture'): void {
    // The entry holds the resource weakly: tracking never keeps a dropped buffer or texture alive.
    const entry: Tracked = { kind, ref: new WeakRef(resource), unpatch: [] },
      tracked = this.tracked,
      views = this.views,
      target = methods(resource);
    tracked.add(entry);
    entry.unpatch.push(
      patch(
        target,
        'destroy',
        (original) =>
          function (this: unknown): unknown {
            tracked.delete(entry);
            for (const unpatch of entry.unpatch) unpatch(methods(this as object));
            return original.call(this);
          },
      ),
    );
    if (kind === 'texture') {
      entry.unpatch.push(
        patch(
          target,
          'createView',
          (original) =>
            function (this: unknown, ...args: unknown[]): unknown {
              const view = Reflect.apply(original, this, args) as GPUTextureView;
              views.set(view, this as GPUTexture);
              return view;
            },
        ),
      );
    }
  }

  private untrack(): void {
    for (const restore of this.unpatchDevice.reverse()) restore();
    this.unpatchDevice = [];
    for (const entry of this.tracked) {
      const resource = entry.ref.deref();
      if (resource) for (const unpatch of entry.unpatch) unpatch(methods(resource));
    }
    this.tracked.clear();
    this.profiler?.dispose();
    this.profiler = undefined;
    this.device = undefined;
  }

  // ---- one captured frame ----

  private record(run: () => void, resolve: (report: FrameReport) => void, reject: (error: unknown) => void): void {
    const engine = this.engine!,
      device = engine.gpu!;
    if (device !== this.device) {
      this.untrack();
      this.track(device);
    }
    if (!this.profiler && device.features.has('timestamp-query')) {
      this.paused = true;
      try {
        this.profiler = new GPUProfiler(device);
      } finally {
        this.paused = false;
      }
    }
    const session = new Session(!!this.profiler?.beginFrame());
    this.session = session;
    this.instrument(session, engine, device);
    try {
      run();
    } catch (error) {
      session.close();
      reject(error);
      throw error;
    }
    session.close();
    if (session.profiled && !session.resolved) {
      // The frame graph's encoder never finished (device loss): replace the profiler stuck mid-frame next time.
      this.profiler?.dispose();
      this.profiler = undefined;
    }
    this.finish(session, engine).then((report) => {
      this.report = report;
      this.panel?.show(report);
      resolve(report);
    }, reject);
  }

  private instrument(session: Session, engine: Engine, device: GPUDevice): void {
    const self = this,
      keep = <T>(target: T, unpatch: Unpatch<T>): void => hold(session.unpatch, target, unpatch);
    const graph = engine.frameGraph;
    keep(
      graph,
      patch(
        graph,
        'execute',
        (original) =>
          function (this: FrameGraph, context: PassContext): void {
            if (!session.live) return original.call(this, context);
            if (context.backend === 'webgpu') session.main = context.encoder;
            const restores: Array<() => void> = [];
            for (const record of graphPasses(this)) {
              const entry: RawGraphPass = {
                name: record.name,
                owner: record.owner ?? (record.name === 'main' ? 'core' : 'app'),
                order: record.order,
                cpu: 0,
                passes: [],
              };
              session.graph.push(entry);
              hold(
                restores,
                record,
                patch(
                  record,
                  'execute',
                  (run) =>
                    function (this: GraphRecord, pass: PassContext): void {
                      session.current = entry;
                      const start = performance.now();
                      try {
                        run.call(this, pass);
                      } finally {
                        entry.cpu += performance.now() - start;
                        session.current = session.after;
                      }
                    },
                ),
              );
            }
            try {
              original.call(this, context);
            } finally {
              for (const restore of restores) restore();
              session.current = session.after;
            }
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createCommandEncoder',
        (original) =>
          function (this: GPUDevice, descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder {
            const encoder = original.call(this, descriptor);
            if (session.live) self.wrapEncoder(session, encoder, session.encoders++);
            return encoder;
          },
      ),
    );
    keep(
      device,
      patch(
        device,
        'createShaderModule',
        (original) =>
          function (this: GPUDevice, descriptor: GPUShaderModuleDescriptor): GPUShaderModule {
            if (session.live) session.shaderModules++;
            return original.call(this, descriptor);
          },
      ),
    );
    const queue = device.queue;
    keep(
      queue,
      patch(
        queue,
        'writeBuffer',
        (original) =>
          function (
            this: GPUQueue,
            buffer: GPUBuffer,
            offset: number,
            data: AllowSharedBufferSource,
            dataOffset?: number,
            size?: number,
          ): void {
            if (session.live) session.upload(buffer, describeBuffer(buffer), uploadBytes(data, dataOffset, size));
            return original.call(this, buffer, offset, data, dataOffset, size);
          },
      ),
    );
    // Overloaded methods: observe the arguments and forward them untouched.
    const queueMethods = methods(queue);
    keep(
      queueMethods,
      patch(
        queueMethods,
        'writeTexture',
        (original) =>
          function (this: unknown, ...args: unknown[]): unknown {
            const [destination, data, layout] = args as [
              GPUTexelCopyTextureInfo,
              AllowSharedBufferSource,
              GPUTexelCopyBufferLayout,
            ];
            if (session.live)
              session.upload(
                destination.texture,
                destination.texture.label || 'texture',
                data.byteLength - (layout.offset ?? 0),
              );
            return Reflect.apply(original, this, args);
          },
      ),
    );
    keep(
      queueMethods,
      patch(
        queueMethods,
        'copyExternalImageToTexture',
        (original) =>
          function (this: unknown, ...args: unknown[]): unknown {
            const [width = 1, height = 1, layers = 1] = extent(args[2]),
              texture = (args[1] as GPUCopyExternalImageDestInfo).texture;
            if (session.live)
              session.upload(
                texture,
                texture.label || 'texture',
                Math.ceil(width * height * layers * texelBytes(texture.format)),
              );
            return Reflect.apply(original, this, args);
          },
      ),
    );
    keep(
      queue,
      patch(
        queue,
        'submit',
        (original) =>
          function (this: GPUQueue, buffers: GPUCommandBuffer[]): void {
            if (session.live) session.submits++;
            return original.call(this, buffers);
          },
      ),
    );
    // Views created during the frame (the canvas texture's, for one) resolve to their texture too.
    if (typeof GPUTexture !== 'undefined') {
      const views = this.views;
      keep(
        GPUTexture.prototype,
        patch(
          GPUTexture.prototype,
          'createView',
          (original) =>
            function (this: GPUTexture, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
              const view = original.call(this, descriptor);
              if (session.live) views.set(view, this);
              return view;
            },
        ),
      );
    }
  }

  private wrapEncoder(session: Session, encoder: GPUCommandEncoder, index: number): void {
    const self = this,
      profiler = this.profiler,
      keep = <T>(target: T, unpatch: Unpatch<T>): void => hold(session.unpatch, target, unpatch);
    // Timestamps go on passes of the frame graph's encoder only, and never replace the caller's own.
    const timestamp = (
      owner: GPUCommandEncoder,
      descriptor: GPURenderPassDescriptor | GPUComputePassDescriptor | undefined,
    ): GPURenderPassTimestampWrites | undefined =>
      session.profiled && owner === session.main && !descriptor?.timestampWrites
        ? profiler?.timestampWrites()
        : undefined;
    keep(
      encoder,
      patch(
        encoder,
        'beginRenderPass',
        (original) =>
          function (this: GPUCommandEncoder, descriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
            if (!session.live) return original.call(this, descriptor);
            const writes = timestamp(this, descriptor),
              pass = original.call(this, writes ? { ...descriptor, timestampWrites: writes } : descriptor);
            self.wrapPass(session, pass, {
              kind: 'render',
              label: descriptor.label ?? '',
              encoder: index,
              timestamp: writes ? session.timed++ : -1,
              attachments: self.attachments(descriptor),
              commands: [],
            });
            return pass;
          },
      ),
    );
    keep(
      encoder,
      patch(
        encoder,
        'beginComputePass',
        (original) =>
          function (this: GPUCommandEncoder, descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder {
            if (!session.live) return original.call(this, descriptor);
            const writes = timestamp(this, descriptor),
              pass = original.call(this, writes ? { ...descriptor, timestampWrites: writes } : descriptor);
            self.wrapPass(session, pass, {
              kind: 'compute',
              label: descriptor?.label ?? '',
              encoder: index,
              timestamp: writes ? session.timed++ : -1,
              attachments: [],
              commands: [],
            });
            return pass;
          },
      ),
    );
    keep(
      encoder,
      patch(
        encoder,
        'finish',
        (original) =>
          function (this: GPUCommandEncoder, descriptor?: GPUCommandBufferDescriptor): GPUCommandBuffer {
            if (session.live && this === session.main) {
              session.resolved = true;
              self.copyIndirect(session, this);
              if (session.profiled && !profiler?.resolve(this)) session.timed = 0;
            }
            return original.call(this, descriptor);
          },
      ),
    );
  }

  /** Copies indirect draw arguments (from buffers with COPY_SRC) into one readback buffer at the end of the frame graph's encoder. */
  private copyIndirect(session: Session, encoder: GPUCommandEncoder): void {
    const copies = session.indirect
      .filter(({ kind, indirect }) => {
        const { buffer, offset } = indirect!;
        return (
          (buffer.usage & GPUBufferUsage.COPY_SRC) !== 0 &&
          offset % 4 === 0 &&
          offset + argumentBytes(kind) <= buffer.size
        );
      })
      .slice(0, MAX_INDIRECT);
    if (!copies.length) return;
    this.paused = true;
    try {
      session.readback = this.device!.createBuffer({
        label: 'frame-debugger:indirect',
        size: copies.length * 20,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    } finally {
      this.paused = false;
    }
    copies.forEach((command, slot) => {
      const indirect = command.indirect!;
      indirect.slot = slot;
      encoder.copyBufferToBuffer(
        indirect.buffer,
        indirect.offset,
        session.readback!,
        slot * 20,
        argumentBytes(command.kind),
      );
    });
  }

  private wrapPass(session: Session, pass: GPURenderPassEncoder | GPUComputePassEncoder, raw: RawPass): void {
    session.current.passes.push(raw);
    const state: { pipeline: AnyPipeline | null; groups: Array<GPUBindGroup | null>; vertex?: GPUBuffer } = {
        pipeline: null,
        groups: [],
      },
      target = methods(pass);
    const wrap = (key: string, observe: (args: unknown[]) => void): void =>
      hold(
        session.unpatch,
        target,
        patch(
          target,
          key,
          (original) =>
            function (this: unknown, ...args: unknown[]): unknown {
              if (session.live) observe(args);
              return Reflect.apply(original, this, args);
            },
        ),
      );
    wrap('setPipeline', ([pipeline]) => {
      state.pipeline = pipeline as AnyPipeline;
    });
    wrap('setBindGroup', ([slot, group]) => {
      state.groups[slot as number] = group as GPUBindGroup | null;
    });
    const command = (kind: CommandKind): void =>
      wrap(kind, (args) => {
        const entry: RawCommand = {
          kind,
          pipeline: state.pipeline,
          groups: state.groups.slice(),
          vertex: state.vertex,
          args: [],
        };
        if (kind === 'executeBundles') entry.args = [[...(args[0] as Iterable<GPURenderBundle>)].length];
        else if (kind.endsWith('Indirect')) {
          entry.indirect = { buffer: args[0] as GPUBuffer, offset: Number(args[1] ?? 0), slot: -1 };
          if (kind !== 'dispatchWorkgroupsIndirect') session.indirect.push(entry);
        } else entry.args = args.map(Number);
        raw.commands.push(entry);
      });
    if (raw.kind === 'render') {
      wrap('setVertexBuffer', ([slot, buffer]) => {
        if (slot === 0) state.vertex = (buffer as GPUBuffer | null) ?? undefined;
      });
      for (const kind of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'executeBundles'] as const)
        command(kind);
    } else for (const kind of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'] as const) command(kind);
  }

  private texture(view: GPUTextureView | GPUTexture | undefined): TextureReport | null {
    if (!view) return null;
    const texture =
      this.views.get(view) ??
      (nameOf(view) === 'GPUTexture' || 'mipLevelCount' in view ? (view as GPUTexture) : undefined);
    return texture ? describeTexture(texture) : null;
  }

  private attachments(descriptor: GPURenderPassDescriptor): AttachmentReport[] {
    const list: AttachmentReport[] = [];
    [...descriptor.colorAttachments].forEach((attachment, index) => {
      if (!attachment) return;
      const entry: AttachmentReport = {
        target: 'color',
        index,
        view: this.texture(attachment.view),
        loadOp: attachment.loadOp,
        storeOp: attachment.storeOp,
      };
      if (attachment.resolveTarget) entry.resolveTarget = this.texture(attachment.resolveTarget);
      list.push(entry);
    });
    const depth = descriptor.depthStencilAttachment;
    if (depth) {
      const entry: AttachmentReport = {
        target: 'depth',
        index: 0,
        view: this.texture(depth.view),
        loadOp: depth.depthLoadOp,
        storeOp: depth.depthStoreOp,
        readOnly: !!depth.depthReadOnly,
      };
      if (depth.stencilLoadOp) entry.stencilLoadOp = depth.stencilLoadOp;
      if (depth.stencilStoreOp) entry.stencilStoreOp = depth.stencilStoreOp;
      list.push(entry);
    }
    return list;
  }

  private binding(entry: GPUBindGroupEntry): BindingReport {
    const resource = entry.resource,
      binding = entry.binding;
    if ('buffer' in resource && resource.buffer) {
      const { buffer, offset = 0, size } = resource;
      return {
        binding,
        kind: 'buffer',
        resource: `${describeBuffer(buffer)} @${offset}${size === undefined ? '' : `+${size}`}`,
      };
    }
    const texture = this.views.get(resource);
    if (texture)
      return {
        binding,
        kind: 'texture',
        resource: `${texture.label || 'texture'} ${texture.format} ${texture.width}x${texture.height}`,
      };
    switch (nameOf(resource)) {
      case 'GPUBuffer':
        return { binding, kind: 'buffer', resource: describeBuffer(resource as GPUBuffer) };
      case 'GPUTexture':
        return {
          binding,
          kind: 'texture',
          resource: `${(resource as GPUTexture).label || 'texture'} ${(resource as GPUTexture).format}`,
        };
      case 'GPUTextureView':
        return {
          binding,
          kind: 'texture',
          resource: (resource as GPUTextureView).label || 'texture view (created before attach)',
        };
      case 'GPUSampler':
        return { binding, kind: 'sampler', resource: (resource as GPUSampler).label || 'sampler' };
      case 'GPUExternalTexture':
        return { binding, kind: 'external-texture', resource: 'external texture' };
      default:
        return { binding, kind: 'unknown', resource: 'unknown' };
    }
  }

  private async finish(session: Session, engine: Engine): Promise<FrameReport> {
    const profiler = this.profiler,
      notes: string[] = [],
      read: { gpu: Float64Array | null; words: Uint32Array | null } = { gpu: null, words: null };
    const timing =
      session.profiled && session.timed > 0 && profiler
        ? profiler.read().then(
            (value) => {
              if (value !== null) read.gpu = profiler.passMilliseconds;
            },
            (error: unknown) => {
              notes.push(`GPU timestamps unusable: ${String(error)}.`);
            },
          )
        : undefined;
    const buffer = session.readback;
    const readback = buffer
      ? buffer
          .mapAsync(GPUMapMode.READ)
          .then(
            () => {
              read.words = new Uint32Array(buffer.getMappedRange().slice(0));
              buffer.unmap();
            },
            () => {},
          )
          .finally(() => buffer.destroy())
      : undefined;
    await Promise.all([timing, readback]);
    if (!session.profiled && !profiler)
      notes.push(
        "GPU timing needs Engine.create(canvas, {features: ['timestamp-query']}); pass times are CPU encode times.",
      );
    else if (!read.gpu && !notes.length)
      notes.push(
        'GPU timestamps were unavailable for this frame (profiler busy or over 128 passes); pass times are CPU encode times.',
      );
    return this.build(session, engine, read.gpu, read.words, notes);
  }

  private build(
    session: Session,
    engine: Engine,
    gpu: Float64Array | null,
    words: Uint32Array | null,
    notes: string[],
  ): FrameReport {
    const pipelineIds = new Map<AnyPipeline, PipelineReport>(),
      groupIds = new Map<GPUBindGroup, BindGroupReport>(),
      warnings: string[] = [];
    const pipelineOf = (pipeline: AnyPipeline, kind: 'render' | 'compute'): PipelineReport => {
      let report = pipelineIds.get(pipeline);
      if (!report) {
        const info = this.pipelines.get(pipeline);
        report = {
          id: pipelineIds.size,
          kind: info?.kind ?? kind,
          label: pipeline.label ?? '',
          createdThisFrame: session.created.has(pipeline),
          known: !!info,
          passes: [],
          ...info?.fields,
          textures: 0,
          samplers: 0,
        };
        pipelineIds.set(pipeline, report);
      }
      return report;
    };
    const groupOf = (group: GPUBindGroup): BindGroupReport => {
      let report = groupIds.get(group);
      if (!report) {
        const info = this.groups.get(group);
        report = {
          id: groupIds.size,
          label: info?.label ?? group.label ?? '',
          entries: info ? info.entries.map((entry) => this.binding(entry)) : null,
        };
        groupIds.set(group, report);
      }
      return report;
    };
    // Core geometry vertex buffer -> mesh ids, so a draw can name the objects it drew.
    let owners: Map<GPUBuffer, number[]> | undefined;
    const entities = (vertex: GPUBuffer | undefined): number[] => {
      if (!vertex) return [];
      if (!owners) {
        owners = new Map();
        for (const mesh of engine.meshes.values()) {
          if (!mesh.geometry) continue;
          try {
            const buffer = engine.geometryBuffers(mesh.geometry)?.vertex;
            if (buffer) owners.set(buffer, [...(owners.get(buffer) ?? []), mesh.id].slice(0, 64));
          } catch {
            // Geometry not on the GPU (device recovery): no owner.
          }
        }
      }
      return owners.get(vertex) ?? [];
    };
    const totals: FrameReport['totals'] = {
      draws: 0,
      indexedDraws: 0,
      indirectDraws: 0,
      dispatches: 0,
      triangles: 0,
      instances: 0,
      renderPasses: 0,
      computePasses: 0,
      encoders: session.encoders,
      submits: session.submits,
      pipelinesCreated: session.created.size + session.asyncPipelines,
      shaderModulesCreated: session.shaderModules,
      bindGroupsCreated: session.bindGroups,
      uploads: 0,
      uploadBytes: 0,
    };
    let unknownIndirect = 0,
      bundles = 0;
    const command = (raw: RawCommand, kind: 'render' | 'compute', pass: string): CommandReport => {
      const pipeline = raw.pipeline ? pipelineOf(raw.pipeline, kind) : null,
        groups = raw.groups.map((group) => (group ? groupOf(group) : null));
      if (pipeline && !pipeline.passes.includes(pass)) pipeline.passes.push(pass);
      const report: CommandReport = {
        kind: raw.kind,
        pipeline: pipeline?.id ?? null,
        bindGroups: groups.map((group) => group?.id ?? null),
        triangles: null,
        entities: entities(raw.vertex),
      };
      if (pipeline) {
        let textures = 0,
          samplers = 0;
        for (const group of groups)
          for (const entry of group?.entries ?? []) {
            if (entry.kind === 'texture' || entry.kind === 'external-texture') textures++;
            else if (entry.kind === 'sampler') samplers++;
          }
        pipeline.textures = Math.max(pipeline.textures, textures);
        pipeline.samplers = Math.max(pipeline.samplers, samplers);
      }
      let args = raw.args;
      if (raw.indirect) {
        report.indirect = { buffer: describeBuffer(raw.indirect.buffer), offset: raw.indirect.offset };
        const slot = raw.indirect.slot;
        args = words && slot >= 0 ? [...words.subarray(slot * 5, slot * 5 + 5)] : [];
        if (raw.kind !== 'dispatchWorkgroupsIndirect' && !args.length) unknownIndirect++;
      }
      if (raw.kind === 'executeBundles') {
        report.bundles = args[0];
        bundles += args[0];
      } else if (raw.kind.startsWith('dispatch')) {
        totals.dispatches++;
        report.workgroups = args.length ? [args[0], args[1] ?? 1, args[2] ?? 1] : null;
      } else {
        const indexed = raw.kind === 'drawIndexed' || raw.kind === 'drawIndexedIndirect';
        totals.draws++;
        if (indexed) totals.indexedDraws++;
        if (raw.indirect) totals.indirectDraws++;
        const count = args.length ? args[0] : null,
          instances = args.length ? (args[1] ?? 1) : null;
        if (indexed) report.indexCount = count;
        else report.vertexCount = count;
        report.instanceCount = instances;
        report.triangles = triangles(pipeline?.topology, count, instances);
        totals.triangles += report.triangles ?? 0;
        totals.instances += instances ?? 0;
      }
      return report;
    };
    const graph = [session.before, ...session.graph, session.after]
      .filter((entry) => entry.owner !== 'engine' || entry.passes.length)
      .map((entry): FramePassReport => {
        const passes = entry.passes.map((raw): GPUPassReport => {
          if (raw.kind === 'render') totals.renderPasses++;
          else totals.computePasses++;
          return {
            kind: raw.kind,
            label: raw.label,
            encoder: raw.encoder,
            gpuMilliseconds: gpu && raw.timestamp >= 0 ? gpu[raw.timestamp] : null,
            attachments: raw.attachments,
            commands: raw.commands.map((item) => command(item, raw.kind, entry.name)),
          };
        });
        const timed = passes.filter((pass) => pass.gpuMilliseconds !== null);
        return {
          name: entry.name,
          owner: entry.owner,
          order: entry.order,
          cpuMilliseconds: entry.cpu,
          gpuMilliseconds: timed.length ? timed.reduce((sum, pass) => sum + (pass.gpuMilliseconds ?? 0), 0) : null,
          passes,
        };
      });
    for (const pipeline of session.created) pipelineOf(pipeline, this.pipelines.get(pipeline)?.kind ?? 'render');
    const pipelines = [...pipelineIds.values()];
    for (const pipeline of pipelines) {
      if (Math.max(pipeline.textures, pipeline.samplers) >= 15) {
        warnings.push(
          `Pipeline #${pipeline.id} "${pipeline.label}" binds ${pipeline.textures} textures and ${pipeline.samplers} samplers; WebGPU guarantees 16 of each per shader stage.`,
        );
      }
    }
    if (totals.pipelinesCreated)
      warnings.push(`${totals.pipelinesCreated} pipeline(s) compiled during this frame (a likely hitch).`);
    if (unknownIndirect)
      warnings.push(
        `${unknownIndirect} indirect draw(s) with unknown counts (arguments buffer without COPY_SRC usage); not in the triangle total.`,
      );
    if (bundles) warnings.push(`${bundles} render bundle(s) executed; draws inside bundles are not listed.`);
    const uploads = [...session.uploads.values()].sort((a, b) => b.bytes - a.bytes);
    for (const upload of uploads) {
      totals.uploads += upload.calls;
      totals.uploadBytes += upload.bytes;
    }
    return {
      timing: gpu ? 'gpu' : 'cpu',
      note: notes.join(' '),
      cpuMilliseconds: session.cpu,
      gpuMilliseconds: gpu ? graph.reduce((sum, entry) => sum + (entry.gpuMilliseconds ?? 0), 0) : null,
      graph,
      pipelines,
      bindGroups: [...groupIds.values()],
      totals,
      uploads: uploads.slice(0, 20),
      memory: this.memory(),
      warnings,
    };
  }
}
