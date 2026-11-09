/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/culling/models: GPU culling of the primitives of gltf-pro models and materials meshes. They draw in their
// own pass, so the hooks are `primitive.redirect` for instance rows, which gltf-pro reads as core reads `Batch.redirect`,
// and `primitive.culled` for a plain primitive: one indirect draw record, one dispatch for all of them.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { compatTier } from '../../shared/compat.js';
import { viewSize } from '../../shared/view-rect.js';
import { OccluderList, type OccluderInput } from './occluders.js';
import { Pyramid, depthKind, levelTable } from './pyramid.js';
import {
  common,
  computeShader,
  cullInputs,
  fillFrame,
  instanceCull,
  occludedCull,
  occlusionCode,
  sphereCode,
} from './shaders.js';

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
  culled?: { args: GPUBuffer; offset: number };
}
/** A gltf-pro `PBRModel` or a materials mesh: whatever has `primitives`. */
export interface CullableModel {
  readonly primitives: readonly CullablePrimitive[];
  readonly disposed?: boolean;
}
/** `CulledModels` settings; `minRadius` may also change later on the plugin. */
export interface CulledModelsOptions {
  /** Also drop instances and primitives whose bounding sphere spans fewer than this many CSS pixels in radius. Default 0 (frustum only). */
  minRadius?: number;
  /**
   * Also drop what is hidden behind the occluders given to {@link CulledModels.addOccluder}, with a Hi-Z test. Worth it for
   * dense or enclosed scenes; with no occluders nothing changes and nothing is paid. Default false.
   */
  occlusion?: boolean;
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
const occludedShader = occludedCull(',node:mat4x4f', 'b.node*records[i].m');
// Every plain primitive in one dispatch: 96 bytes each in, one 20-byte indirect draw record each out.
const plainShader =
  common +
  cullInputs() +
  `
struct Item {node:mat4x4f,sphere:vec4f,shape:vec4u}
@group(0) @binding(1) var<uniform> f:Frame;
@group(0) @binding(2) var<storage,read> items:array<Item>;
@group(0) @binding(3) var<storage,read_write> args:array<u32>;
@group(0) @binding(5) var<storage,read> hiz:array<f32>;
var<private> b:Part;
${sphereCode}${occlusionCode}
@compute @workgroup_size(64) fn plain(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=u.size.w){return;}
  b.sphere=items[i].sphere;let s=bound(items[i].node);
  var n=0u;if(keep(s)&&(u.mode.x!=2u||unoccluded(s))){n=1u;}
  let a=i*5u;args[a]=items[i].shape.x;args[a+1u]=n;args[a+2u]=0u;args[a+3u]=0u;args[a+4u]=0u;
}
`;
/** Floats of one plain primitive in the items buffer: matrix, sphere, shape. */
const ITEM = 24;

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
  /** The Hi-Z kernel's bindings, rebuilt when the rows or the pyramid change. */
  occluded?: { group: GPUBindGroup; rows: GPUBuffer; hiz: GPUBuffer };
}
/** What `primitive.culled` holds, plus the cached sphere. */
interface PlainRecord {
  args: GPUBuffer;
  offset: number;
  frame: number;
  padding: number;
  vertices?: Float32Array;
  sphere: Float32Array;
}
/** The plain primitives' shared storage, doubled as they grow. */
interface PlainList {
  capacity: number;
  items: GPUBuffer;
  args: GPUBuffer;
  data: Float32Array;
  words: Uint32Array;
  group?: GPUBindGroup;
  hiz?: GPUBuffer;
}
/** What occlusion adds: rebuilt when the sample count changes. */
interface Occlusion {
  samples: number;
  table: GPUBuffer;
  pyramid: Pyramid;
  cull: GPUComputePipeline;
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
 * The compute cull of `CulledMeshes` for loaded models and materials meshes. Each frame every primitive with `instances`
 * tests each row against the frustum (and optionally a screen-size threshold), compacts the kept rows in order and draws
 * them with one indirect draw, so the CPU cost per frame does not grow with the rows. Every primitive without `instances`
 * gets one indirect draw record, written by a single dispatch: a culled one still costs its draw call on the CPU, as
 * WebGPU has no multi-draw, but no vertex or fragment work. With `occlusion` both also drop what is hidden behind
 * {@link CulledModels.addOccluder} surfaces. Shadows, picking and export see everything. Skinned and morphed primitives
 * draw as before. On the WebGL2 compatibility layer nothing is culled: the same image.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class CulledModels implements EnginePlugin {
  readonly name = 'culled-models:' + ++serial;
  /** See {@link CulledModelsOptions.minRadius}; may change at any time. */
  minRadius: number;
  /** See {@link CulledModelsOptions.occlusion}; may change at any time. */
  occlusion: boolean;
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
    plain: GPUComputePipeline;
  };
  private frameBuffer?: GPUBuffer;
  private readonly frame = new Float32Array(44);
  private readonly records = new Map<CullablePrimitive, PlainRecord>();
  private readonly live: CullablePrimitive[] = [];
  private list?: PlainList;
  private tick = 0;
  // The `Cull` uniform of shaders.ts, as occlusionCode and the pyramid read it.
  private readonly words = new Uint32Array(112);
  private readonly floats = new Float32Array(this.words.buffer);
  private uniform?: GPUBuffer;
  private noDepth?: GPUBuffer;
  private outside?: OccluderList;
  private occluding?: Occlusion;

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
  constructor({ minRadius = 0, occlusion = false }: CulledModelsOptions = {}) {
    this.minRadius = minRadius;
    this.occlusion = occlusion;
    this.check();
  }
  private check(): void {
    if (!(this.minRadius >= 0 && this.minRadius < 1e6))
      throw new RangeError('Invalid culled model options; set minRadius to a number from 0 up to 1e6');
  }
  /**
   * Culls a model's primitives from the next frame on, with their bounds as of each frame's vertices. A model added twice
   * takes the later `padding`.
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
  /**
   * With `occlusion`, lets `source` hide what is behind it: a core mesh, a gltf-pro model, a materials mesh or a Terrain.
   * Give it the large things. It draws depth-only each frame, so a wall the frame shows hides at once, and cut-out, blended,
   * displaced and clipped primitives do not occlude, and neither do back faces.
   * @throws TypeError for anything else.
   */
  addOccluder(source: OccluderInput): this {
    (this.outside ??= new OccluderList()).add(source);
    return this;
  }
  /** Stops `source` occluding from the next frame. */
  removeOccluder(source: OccluderInput): this {
    this.outside?.remove(source);
    return this;
  }
  /** Stops culling a model; it draws every instance and primitive again from the next frame. */
  remove(model: CullableModel): this {
    if (this.models.delete(model)) for (const primitive of model.primitives) this.drop(primitive);
    return this;
  }
  /** Rows drawn per culled primitive in the latest submitted frame, 0 or 1 for a plain one (a GPU readback; for tests and tools). */
  async readCounts(): Promise<Map<CullablePrimitive, number>> {
    const d = this.device;
    if (!d) throw new MargoError('state', 'CulledModels is not attached; attach it to an engine first');
    const entries: [CullablePrimitive, GPUBuffer, number][] = [
        ...[...this.slots].map(([p, s]): [CullablePrimitive, GPUBuffer, number] => [p, s.args, 4]),
        ...[...this.records].map(([p, r]): [CullablePrimitive, GPUBuffer, number] => [p, r.args, r.offset + 4]),
      ],
      read = d.createBuffer({
        size: Math.max(4, entries.length * 4),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    try {
      const encoder = d.createCommandEncoder();
      entries.forEach(([, args, offset], i) => encoder.copyBufferToBuffer(args, offset, read, i * 4, 4));
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
        'CulledModels requires WebGPU; attach a new CulledModels to a WebGPU engine; see https://margoengine.com/errors#webgpu',
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
    this.uniform ??= d.createBuffer({ size: 448, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    fillFrame(this.frame, c, this.engine!.canvas, this.minRadius);
    d.queue.writeBuffer(this.frameBuffer, 0, this.frame as Float32Array<ArrayBuffer>);
    const o = this.occlusion && this.outside?.size ? this.occlude(c) : undefined;
    this.tick++;
    this.live.length = 0;
    const pass = c.encoder.beginComputePass();
    for (const [model, padding] of this.models) {
      if (model.disposed) {
        this.remove(model);
        continue;
      }
      for (const primitive of model.primitives) {
        const instances = primitive.instances;
        if (!instances && !primitive.deformed) {
          this.plain(primitive, padding);
          continue;
        }
        this.dropPlain(primitive);
        if (!instances?.count || primitive.deformed) {
          this.drop(primitive);
          continue;
        }
        const slot = this.slot(d, primitive, instances, padding),
          groups = Math.ceil(instances.count / 256);
        if (o) {
          pass.setBindGroup(0, this.occludedGroup(d, o, slot));
          pass.setPipeline(o.cull);
        } else {
          pass.setBindGroup(0, slot.group!);
          pass.setPipeline(p.cull);
        }
        pass.dispatchWorkgroups(groups);
        pass.setBindGroup(0, slot.group!);
        pass.setPipeline(p.scan);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(p.scatter);
        pass.dispatchWorkgroups(groups);
        primitive.redirect = slot.redirect;
      }
    }
    this.cullPlain(d, pass, o);
    pass.end();
  }
  // Notes a plain primitive for this frame's dispatch; `cullPlain` writes its row.
  private plain(primitive: CullablePrimitive, padding: number): void {
    let record = this.records.get(primitive);
    if (!record) {
      record = { args: undefined!, offset: 0, frame: 0, padding: -1, sphere: new Float32Array(4) };
      this.records.set(primitive, record);
    }
    if (record.vertices !== primitive.vertices || record.padding !== padding) {
      sphereOf(primitive.vertices, record.sphere);
      record.sphere[3] += padding;
      record.vertices = primitive.vertices;
      record.padding = padding;
    }
    record.frame = this.tick;
    this.live.push(primitive);
  }
  private cullPlain(d: GPUDevice, pass: GPUComputePassEncoder, o: Occlusion | undefined): void {
    const live = this.live,
      n = live.length;
    if (this.records.size !== n)
      for (const [primitive, record] of this.records) if (record.frame !== this.tick) this.dropPlain(primitive);
    this.words[43] = n;
    this.words[44] = o ? 2 : 1;
    d.queue.writeBuffer(this.uniform!, 0, this.words as Uint32Array<ArrayBuffer>);
    if (!n) return;
    const list = this.plainList(d, n),
      hiz = o?.pyramid.buffer ?? (this.noDepth ??= d.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE }));
    for (let i = 0; i < n; i++) {
      const primitive = live[i],
        record = this.records.get(primitive)!,
        at = i * ITEM;
      list.data.set(primitive.node.matrix, at);
      list.data.set(record.sphere, at + 16);
      list.words[at + 20] = primitive.indices.length;
      record.args = list.args;
      record.offset = i * 20;
      primitive.culled = record;
    }
    d.queue.writeBuffer(list.items, 0, list.data as Float32Array<ArrayBuffer>, 0, n * ITEM);
    const { plain } = this.pipelines!;
    if (list.hiz !== hiz) {
      list.group = d.createBindGroup({
        layout: plain.getBindGroupLayout(0),
        entries: [
          [0, this.uniform!],
          [1, this.frameBuffer!],
          [2, list.items],
          [3, list.args],
          [5, hiz],
        ].map(([binding, buffer]) => ({ binding: binding as number, resource: { buffer: buffer as GPUBuffer } })),
      });
      list.hiz = hiz;
    }
    pass.setPipeline(plain);
    pass.setBindGroup(0, list.group!);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
  }
  private plainList(d: GPUDevice, n: number): PlainList {
    let list = this.list;
    if (list && list.capacity >= n) return list;
    list?.items.destroy();
    list?.args.destroy();
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(n))),
      data = new Float32Array(capacity * ITEM);
    list = this.list = {
      capacity,
      items: d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      args: d.createBuffer({
        size: capacity * 20,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC,
      }),
      data,
      words: new Uint32Array(data.buffer),
    };
    return list;
  }
  // Draws the occluders depth-only with this frame's camera and builds the pyramid from them, so a surface that moved
  // this frame hides only what it hides now.
  private occlude(c: Context): Occlusion {
    const d = c.device,
      samples = c.descriptor.multisample?.count ?? 1;
    let o = this.occluding;
    if (o?.samples !== samples) {
      this.dropOcclusion();
      const entry = (code: string, entryPoint: string) =>
          d.createComputePipeline({
            layout: 'auto',
            compute: { module: d.createShaderModule({ code }), entryPoint },
          }),
        pyramidCode = computeShader(samples),
        table = d.createBuffer({ size: 16 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(table, 0, levelTable() as Uint32Array<ArrayBuffer>);
      const stages = { depth0: entry(pyramidCode, 'depth0'), reduce: entry(pyramidCode, 'reduce') };
      o = this.occluding = {
        samples,
        table,
        pyramid: new Pyramid(d, samples, stages, this.uniform!, table, this.words),
        cull: entry(occludedShader, 'cull'),
      };
    }
    const pyramid = o.pyramid,
      [width, height] = viewSize(c);
    // Views of different sizes share resources sized for the largest; a plain frame keeps them at the canvas size.
    if (
      c.view ? width > pyramid.width || height > pyramid.height : width !== pyramid.width || height !== pyramid.height
    )
      pyramid.resize(Math.max(width, c.view ? pyramid.width : 0), Math.max(height, c.view ? pyramid.height : 0));
    pyramid.plan(width, height);
    const m = c.camera.matrix;
    this.floats.set(m);
    this.floats.set(c.camera.planes, 16);
    this.words.set([width, height, pyramid.levels, 0, 2, 0, depthKind(m)], 40);
    d.queue.writeBuffer(this.uniform!, 0, this.words as Uint32Array<ArrayBuffer>);
    const pass = c.encoder.beginRenderPass(pyramid.pass);
    // The target may be larger than this view (shared with a larger one).
    if (c.view) pass.setViewport(0, 0, width, height, 0, 1);
    this.outside!.draw(pass, c, this.engine!, samples);
    pass.end();
    const build = c.encoder.beginComputePass();
    pyramid.encode(build, width, height);
    build.end();
    return o;
  }
  private occludedGroup(d: GPUDevice, o: Occlusion, slot: Slot): GPUBindGroup {
    const hiz = o.pyramid.buffer!,
      rows = slot.rows!;
    if (slot.occluded?.rows !== rows || slot.occluded.hiz !== hiz) {
      const [, , uniform, visible, local, groups] = slot.buffers,
        entries: [number, GPUBuffer][] = [
          [0, this.uniform!],
          [1, this.frameBuffer!],
          [2, uniform],
          [3, rows],
          [4, visible],
          [5, hiz],
          [6, local],
          [7, groups],
        ];
      slot.occluded = {
        group: d.createBindGroup({
          layout: o.cull.getBindGroupLayout(0),
          entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
        }),
        rows,
        hiz,
      };
    }
    return slot.occluded.group;
  }
  private dropOcclusion(): void {
    const o = this.occluding;
    if (!o) return;
    o.pyramid.destroy();
    o.table.destroy();
    this.occluding = undefined;
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
    return {
      layout,
      cull: entry('cull'),
      scan: entry('scan'),
      scatter: entry('scatter'),
      plain: d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: plainShader }), entryPoint: 'plain' },
      }),
    };
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
  // The primitive draws straight again.
  private dropPlain(primitive: CullablePrimitive): void {
    const record = this.records.get(primitive);
    if (!record) return;
    if (primitive.culled === record) primitive.culled = undefined;
    this.records.delete(primitive);
  }
  // The primitive draws all its rows again, from gltf-pro's own buffer.
  private drop(primitive: CullablePrimitive): void {
    this.dropPlain(primitive);
    const slot = this.slots.get(primitive);
    if (!slot) return;
    if (primitive.redirect === slot.redirect) primitive.redirect = undefined;
    for (const buffer of slot.buffers) buffer.destroy();
    this.slots.delete(primitive);
  }
  private release(): void {
    for (const primitive of [...this.slots.keys()]) this.drop(primitive);
    for (const primitive of [...this.records.keys()]) this.dropPlain(primitive);
    this.dropOcclusion();
    this.outside?.release();
    this.list?.items.destroy();
    this.list?.args.destroy();
    this.noDepth?.destroy();
    this.uniform?.destroy();
    this.frameBuffer?.destroy();
    this.frameBuffer = this.pipelines = this.list = this.noDepth = this.uniform = undefined;
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
