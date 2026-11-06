/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/culling/models: GPU culling of the instanced primitives of gltf-pro models and materials meshes. They draw
// in their own pass, so the hook is `primitive.redirect`, which gltf-pro reads as core reads `Batch.redirect`.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { compatTier } from '../../shared/compat.js';
import { fillFrame, instanceCull } from './shaders.js';

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

/** The parts of a gltf-pro `PBRInstances` the culler reads. */
export interface CullableInstances {
  readonly count: number;
  readonly capacity: number;
  upload(device: GPUDevice): GPUBuffer;
}
/** The parts of a gltf-pro `PBRPrimitive` the culler reads. */
export interface CullablePrimitive {
  node: { readonly matrix: ArrayLike<number> };
  vertices: Float32Array;
  indices: Uint32Array;
  instances?: CullableInstances;
  deformed?: GPUBuffer;
  redirect?: { instances: GPUBuffer; args: GPUBuffer };
}
/** A gltf-pro `PBRModel` or a materials mesh: whatever has `primitives`. */
export interface CullableModel {
  readonly primitives: readonly CullablePrimitive[];
  readonly disposed?: boolean;
}
/** `CulledModels` settings; `minRadius` may also change later on the plugin. */
export interface CulledModelsOptions {
  /** Also drop instances whose bounding sphere spans fewer than this many CSS pixels in radius. Default 0 (frustum only). */
  minRadius?: number;
}
/** Settings of one model in {@link CulledModels.add}. */
export interface CulledModelOptions {
  /**
   * Added to each primitive's bounding sphere, in its own units. A shader that moves vertices past the geometry (a
   * displacement map, a material extension's `displace`) needs at least the farthest it moves them. Default 0.
   */
  padding?: number;
}

const shader = instanceCull(',node:mat4x4f', 'b.node*records[i].m');

interface Slot {
  capacity: number;
  padding: number;
  vertices?: Float32Array;
  sphere: Float32Array;
  rows?: GPUBuffer;
  buffers: GPUBuffer[];
  uniform: GPUBuffer;
  drawn: GPUBuffer;
  args: GPUBuffer;
  group?: GPUBindGroup;
  data: ArrayBuffer;
  words: Uint32Array;
  floats: Float32Array;
  redirect: { instances: GPUBuffer; args: GPUBuffer };
}
let serial = 0;

/** A vertex list's bounding sphere (80-byte vertices): the centre of its box, and the farthest vertex from there. */
function sphereOf(vertices: Float32Array, out: Float32Array): void {
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 20)
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k], vertices[i + k]);
      high[k] = Math.max(high[k], vertices[i + k]);
    }
  for (let k = 0; k < 3; k++) out[k] = (low[k] + high[k]) / 2;
  let far = 0;
  for (let i = 0; i < vertices.length; i += 20)
    far = Math.max(far, Math.hypot(vertices[i] - out[0], vertices[i + 1] - out[1], vertices[i + 2] - out[2]));
  out[3] = far;
}

/**
 * The compute cull of `CulledMeshes` for the instanced primitives of loaded models and materials meshes: each frame every
 * primitive with `instances` tests each row against the frustum (and optionally a screen-size threshold), compacts the
 * kept rows in order and draws them with one indirect draw, so the CPU cost per frame does not grow with the rows. The
 * rows stay the source for shadows, picking and export, which see every instance. Skinned and morphed primitives and
 * primitives without `instances` draw as before. On the WebGL2 compatibility layer nothing is culled: the same image.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class CulledModels implements EnginePlugin {
  readonly name = 'culled-models:' + ++serial;
  /** See {@link CulledModelsOptions.minRadius}; may change at any time. */
  minRadius: number;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private compat = false;
  private readonly models = new Map<CullableModel, number>();
  private readonly slots = new Map<CullablePrimitive, Slot>();
  private pipelines?: {
    layout: GPUBindGroupLayout;
    cull: GPUComputePipeline;
    scan: GPUComputePipeline;
    scatter: GPUComputePipeline;
  };
  private frameBuffer?: GPUBuffer;
  private readonly frame = new Float32Array(44);

  /** Same as `engine.use(new CulledModels(options))` plus `add` for each model; returns the plugin. */
  static attach(
    engine: EngineKernel,
    models: readonly CullableModel[] = [],
    options?: CulledModelsOptions,
  ): CulledModels {
    const value = new CulledModels(options);
    engine.use(value);
    for (const model of models) value.add(model);
    return value;
  }
  constructor({ minRadius = 0 }: CulledModelsOptions = {}) {
    this.minRadius = minRadius;
    this.check();
  }
  private check(): void {
    if (!(this.minRadius >= 0 && this.minRadius < 1e6))
      throw new RangeError('Invalid culled model options; set minRadius to a number from 0 up to 1e6');
  }
  /**
   * Culls a model's instanced primitives from the next frame on, with their bounds as of each frame's vertices. A model
   * added twice takes the later `padding`.
   * @throws TypeError for something without `primitives`, RangeError for a negative `padding`.
   */
  add(model: CullableModel, { padding = 0 }: CulledModelOptions = {}): this {
    if (!Array.isArray(model?.primitives))
      throw new TypeError('Invalid culled model; pass a gltf-pro model or materials mesh, which have primitives');
    if (!(padding >= 0 && Number.isFinite(padding)))
      throw new RangeError('Invalid culled model padding; pass a finite number of 0 or more');
    this.models.set(model, padding);
    return this;
  }
  /** Stops culling a model; it draws every instance again from the next frame. */
  remove(model: CullableModel): this {
    if (this.models.delete(model)) for (const primitive of model.primitives) this.drop(primitive);
    return this;
  }
  /** Rows drawn per culled primitive in the latest submitted frame (a GPU readback; for tests and tools). */
  async readCounts(): Promise<Map<CullablePrimitive, number>> {
    const d = this.device;
    if (!d) throw new MargoError('state', 'CulledModels is not attached; attach it to an engine first');
    const entries = [...this.slots],
      read = d.createBuffer({
        size: Math.max(4, entries.length * 4),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    try {
      const encoder = d.createCommandEncoder();
      entries.forEach(([, s], i) => encoder.copyBufferToBuffer(s.args, 4, read, i * 4, 4));
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      return new Map(entries.map(([p], i) => [p, values[i]]));
    } finally {
      read.destroy();
    }
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'CulledModels requires WebGPU; attach a new CulledModels to a WebGPU engine',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.compat = compatTier(engine.gpu) === 'webgl2';
  }
  registerPasses(graph: FrameGraph): void {
    // First in the frame, so every draw of these primitives (main pass, depth and normal replays) sees this frame's lists.
    graph.add({
      name: this.name,
      order: -1e6,
      execute: (c) => {
        if (c.backend === 'webgpu' && !this.compat) this.cull(c);
      },
    });
  }

  private cull(c: Context): void {
    this.check();
    const d = c.device,
      p = (this.pipelines ??= this.compile(d));
    this.frameBuffer ??= d.createBuffer({
      size: this.frame.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    fillFrame(this.frame, c, this.engine!.canvas, this.minRadius);
    d.queue.writeBuffer(this.frameBuffer, 0, this.frame as Float32Array<ArrayBuffer>);
    const pass = c.encoder.beginComputePass();
    for (const [model, padding] of this.models) {
      if (model.disposed) {
        this.remove(model);
        continue;
      }
      for (const primitive of model.primitives) {
        const instances = primitive.instances;
        if (!instances?.count || primitive.deformed) {
          this.drop(primitive);
          continue;
        }
        const slot = this.slot(d, primitive, instances, padding),
          groups = Math.ceil(instances.count / 256);
        pass.setBindGroup(0, slot.group!);
        pass.setPipeline(p.cull);
        pass.dispatchWorkgroups(groups);
        pass.setPipeline(p.scan);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(p.scatter);
        pass.dispatchWorkgroups(groups);
        primitive.redirect = slot.redirect;
      }
    }
    pass.end();
  }
  private compile(d: GPUDevice): NonNullable<CulledModels['pipelines']> {
    // One explicit layout shared by the three entry points ('auto' layouts are per pipeline and incompatible).
    const visibility = 4,
      buffer = (type: GPUBufferBindingType) => ({ visibility, buffer: { type } }),
      layout = d.createBindGroupLayout({
        entries: [
          buffer('uniform'),
          buffer('uniform'),
          buffer('read-only-storage'),
          ...[3, 4, 5, 6, 7].map(() => buffer('storage')),
        ].map((e, binding) => ({ binding, ...e })),
      }),
      module = d.createShaderModule({ code: shader }),
      pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      entry = (entryPoint: string) =>
        d.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
    return { layout, cull: entry('cull'), scan: entry('scan'), scatter: entry('scatter') };
  }
  // A primitive's storage, sized to its instances' capacity and rebound when they get a new GPU buffer.
  private slot(d: GPUDevice, primitive: CullablePrimitive, instances: CullableInstances, padding: number): Slot {
    let slot = this.slots.get(primitive);
    if (slot && slot.capacity !== instances.capacity) {
      this.drop(primitive);
      slot = undefined;
    }
    if (!slot) {
      const n = instances.capacity,
        S = GPUBufferUsage.STORAGE,
        buffers: GPUBuffer[] = [],
        make = (size: number, usage: number) => {
          const b = d.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
          buffers.push(b);
          return b;
        },
        data = new ArrayBuffer(96),
        drawn = make(n * 96, S | GPUBufferUsage.VERTEX),
        args = make(20, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
      slot = {
        capacity: n,
        padding: -1,
        sphere: new Float32Array(4),
        buffers,
        uniform: make(96, GPUBufferUsage.UNIFORM),
        drawn,
        args,
        data,
        words: new Uint32Array(data),
        floats: new Float32Array(data),
        redirect: { instances: drawn, args },
      };
      make(n * 4, S);
      make(n * 4, S);
      make(Math.ceil(n / 256) * 4, S);
      this.slots.set(primitive, slot);
    }
    const rows = instances.upload(d);
    if (slot.rows !== rows) {
      const [, , , visible, local, groups] = slot.buffers;
      slot.group = d.createBindGroup({
        layout: this.pipelines!.layout,
        entries: [this.frameBuffer!, slot.uniform, rows, visible, local, groups, slot.drawn, slot.args].map(
          (buffer, binding) => ({ binding, resource: { buffer } }),
        ),
      });
      slot.rows = rows;
    }
    if (slot.vertices !== primitive.vertices || slot.padding !== padding) {
      sphereOf(primitive.vertices, slot.sphere);
      slot.sphere[3] += padding;
      slot.vertices = primitive.vertices;
      slot.padding = padding;
    }
    slot.words[0] = instances.count;
    slot.words[1] = primitive.indices.length;
    slot.floats.set(slot.sphere, 4);
    slot.floats.set(primitive.node.matrix, 8);
    d.queue.writeBuffer(slot.uniform, 0, slot.data);
    return slot;
  }
  // The primitive draws all its rows again, from gltf-pro's own buffer.
  private drop(primitive: CullablePrimitive): void {
    const slot = this.slots.get(primitive);
    if (!slot) return;
    if (primitive.redirect === slot.redirect) primitive.redirect = undefined;
    for (const buffer of slot.buffers) buffer.destroy();
    this.slots.delete(primitive);
  }
  private release(): void {
    for (const primitive of [...this.slots.keys()]) this.drop(primitive);
    this.frameBuffer?.destroy();
    this.frameBuffer = this.pipelines = undefined;
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
    this.models.clear();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
