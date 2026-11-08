/// <reference lib="esnext.disposable" preserve="true" />
// Inverted-hull outlines for loaded glTF-pro models and @margoengine/materials meshes: each triangle primitive is drawn a
// second time with its back faces pushed out along the world normal (Raskar & Cohen, "Image Precision Silhouette
// Edges", I3D 1999), from the vertices its deformer wrote this frame (`deformed`), so skinned and morphed characters
// keep their outline in every pose; instanced primitives draw one hull per instance. Seam-free (`smooth`): copies of a
// vertex at one position (split by a hard edge or a UV seam) are linked in a ring (rings.ts) and each pushes out
// along the average of every copy's normal, read from the same vertices, so the hull stays closed at creases.
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { instanceMatrix } from '../../shared/instances.js';
import { isModel, type ModelLike, type ModelPrimitiveLike } from '../../shared/model.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { applyView, inView } from '../../shared/view-rect.js';
import { retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
import { beginScenePass } from '../../shared/scene-pass.js';
import { positionRings } from './rings.js';
export { positionRings } from './rings.js';
declare const GPUBufferUsage: { STORAGE: number; UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link ModelOutlines}. */
export interface ModelOutlineOptions {
  /** Outline thickness in world units, 0-10 (0 hides it). Default 0.025, as `Toon`. Live as `outline`. */
  outline?: number;
  /** Outline colour, linear RGB 0..1. Default [0.015, 0.015, 0.015]. Live as `color`. */
  color?: readonly [number, number, number];
  /**
   * Seam-free: every copy of a vertex at one position pushes out along their average normal, so hard-edged meshes get
   * an unbroken outline. Default true. Live as `smooth`. Needs vertex buffers with STORAGE usage (gltf-pro's and
   * animation's have it); a primitive without draws as `smooth: false`.
   */
  smooth?: boolean;
  /** The models to outline (glTF-pro `PBRModel`s or materials meshes). Default: every model attached to the engine. */
  models?: readonly ModelLike[];
}

// camera: view projection; style: rgb colour and width. A draw row is the primitive's world matrix (node x instance).
const code = `
struct Style {camera:mat4x4f,style:vec4f}
@group(0) @binding(0) var<uniform> u:Style;
@group(0) @binding(1) var<storage,read> draws:array<mat4x4f>;
@vertex fn vertex(@location(0) position:vec3f,@location(1) own:vec3f,@builtin(instance_index) slot:u32,@builtin(vertex_index) index:u32)->@builtin(position) vec4f{
  let normal=NORMAL;let m=draws[slot];let a=m[0].xyz;let b=m[1].xyz;let c=m[2].xyz;
  let n=mat3x3f(cross(b,c),cross(c,a),cross(a,b))*normal*sign(dot(a,cross(b,c)));
  let l=length(n);let p=m*vec4f(position,1)+vec4f(select(vec3f(0),n/l,l>0)*u.style.w,0);
  return u.camera*p;
}
@fragment fn fragment()->@location(0) vec4f{return vec4f(u.style.rgb,1);}`;
// The smooth variant: the primitive's own 80-byte vertices (deformed ones when skinned) and its position rings. A
// ring longer than 64 copies stops there; normals summing to nothing (two faces back to back) keep the vertex's own.
const smoothCode =
  code.replace('NORMAL', 'smoothed(index,own)') +
  `
@group(1) @binding(0) var<storage,read> vertices:array<f32>;
@group(1) @binding(1) var<storage,read> ring:array<u32>;
fn smoothed(index:u32,own:vec3f)->vec3f{
  var sum=own;var k=ring[index];var steps=0u;
  loop{if(k==index||steps>=64u){break;}let o=k*20u;sum+=vec3f(vertices[o+4u],vertices[o+5u],vertices[o+6u]);k=ring[k];steps++;}
  return select(own,sum,dot(sum,sum)>1e-8);
}`;
const plainCode = code.replace('NORMAL', 'own');
/** A primitive's ring buffer and the group binding it with the vertices it was last drawn from. */
interface Smoothing {
  ring: GPUBuffer;
  vertices: Float32Array;
  group?: GPUBindGroup;
  source?: GPUBuffer;
  offset: number;
  seen: number;
}

/** A run of consecutive draw rows of one primitive; `mirrored` rows flip winding, so the hull culls back faces. */
interface Run {
  primitive: ModelPrimitiveLike;
  first: number;
  count: number;
  mirrored: boolean;
}

function checked(outline: number, color: readonly number[]): void {
  if (
    typeof outline !== 'number' ||
    !Number.isFinite(outline) ||
    outline < 0 ||
    outline > 10 ||
    !Array.isArray(color) ||
    color.length !== 3 ||
    color.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
  )
    throw new RangeError(
      'ModelOutlines outline must be between 0 and 10 and color three channels between 0 and 1; pass finite values in range.',
    );
}
const determinant = (m: ArrayLike<number>): number =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

/**
 * Inverted-hull outlines on loaded and animated characters: every triangle primitive of the glTF-pro models (and
 * materials meshes) on the engine, or of `models`, drawn again front-culled with its vertices pushed `outline` world
 * units out along the normal, in `color`. Skinned and morphed primitives use their deformer's vertices of this frame;
 * instanced primitives draw one hull per instance; hidden nodes and nodes outside a view's layers draw none.
 * `ModelOutlines.attach(engine, options)`; WebGPU only.
 * @throws RangeError when `outline` or `color` is out of range; TypeError for a `models` entry that is no model.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class ModelOutlines implements EnginePlugin {
  readonly name = 'toon:models';
  private engine?: Engine;
  private width: number;
  private rgb: [number, number, number];
  private readonly only?: readonly ModelLike[];
  /** Seam-free outlines (see the option). */
  smooth: boolean;
  private readonly smoothing = new Map<ModelPrimitiveLike, Smoothing>();
  private frame = 0;
  private ringLayout?: GPUBindGroupLayout;
  private readonly values = new Float32Array(20);
  private rows = new Float32Array(16 * 16);
  private readonly runs: Run[] = [];
  private readonly scratch = new Float32Array(16);
  private uniform?: GPUBuffer;
  private storage?: GPUBuffer;
  private layout?: GPUBindGroupLayout;
  private groups?: { get(copy?: GPUBufferBinding): GPUBindGroup };
  /** Plain front-culling, plain mirrored, smooth, smooth mirrored. */
  private pipelines?: GPURenderPipeline[];
  private key = '';
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined as unknown as GPUTextureView,
  };
  private disposed = false;
  constructor({ outline = 0.025, color = [0.015, 0.015, 0.015], smooth = true, models }: ModelOutlineOptions = {}) {
    checked(outline, color);
    if (models !== undefined && (!Array.isArray(models) || !models.every(isModel)))
      throw new TypeError('ModelOutlines models must be loaded models; pass the PBRModels loadGLTF returned');
    this.width = outline;
    this.rgb = [color[0], color[1], color[2]];
    this.only = models && [...models];
    this.smooth = !!smooth;
  }
  static attach(engine: EngineKernel, options: ModelOutlineOptions = {}): ModelOutlines {
    const effect = new ModelOutlines(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  /** Outline thickness in world units, 0-10 (0 hides it). */
  get outline(): number {
    return this.width;
  }
  set outline(v: number) {
    checked(v, this.rgb);
    this.width = v;
  }
  /** Outline colour, linear RGB 0..1. */
  get color(): readonly [number, number, number] {
    return this.rgb;
  }
  set color(v: readonly [number, number, number]) {
    checked(this.width, v);
    this.rgb = [v[0], v[1], v[2]];
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'ModelOutlines requires WebGPU; attach a new ModelOutlines to a WebGPU engine',
      );
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    // After the models' own opaque draws (order 1), so the hull is tested against their depth.
    graph.add({
      name: 'toon:models',
      order: 1.25,
      joins: true,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.width > 0) this.draw(c);
      },
    });
  }
  /** The models drawn this frame: `models`, or every model plugin on the engine. */
  private models(): Iterable<ModelLike> {
    if (this.only) return this.only;
    const list: ModelLike[] = [];
    for (const plugin of this.engine!.plugins.values()) if (isModel(plugin)) list.push(plugin);
    return list;
  }
  private add(primitive: ModelPrimitiveLike, m: ArrayLike<number>): void {
    const runs = this.runs,
      slot = runs.length ? runs[runs.length - 1].first + runs[runs.length - 1].count : 0,
      mirrored = determinant(m) < 0;
    if (slot * 16 + 16 > this.rows.length) {
      const rows = new Float32Array(this.rows.length * 2);
      rows.set(this.rows);
      this.rows = rows;
    }
    this.rows.set(m as ArrayLike<number>, slot * 16);
    const last = runs[runs.length - 1];
    if (last && last.primitive === primitive && last.mirrored === mirrored) last.count++;
    else runs.push({ primitive, first: slot, count: 1, mirrored });
  }
  private collect(c: Context): number {
    const e = this.engine!;
    this.runs.length = 0;
    for (const model of this.models()) {
      if (model.disposed) continue;
      for (const p of model.primitives) {
        const topology = (p as { topology?: string }).topology;
        if (!p.buffers || topology || hiddenInTree(e.store, p.node.id) || !inView(c, p.node)) continue;
        const node = p.node.matrix as ArrayLike<number>;
        if (!p.instances) this.add(p, node);
        else
          for (let k = 0; k < p.instances.count; k++)
            this.add(p, instanceMatrix(node, p.instances.data, k, this.scratch));
      }
    }
    const last = this.runs[this.runs.length - 1];
    return last ? last.first + last.count : 0;
  }
  private prepare(c: Context, rows: number): void {
    const device = c.device;
    if (!this.layout) {
      this.layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.ringLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    if (!this.storage || this.storage.size < rows * 64) {
      retire(device, this.storage);
      this.storage = device.createBuffer({
        size: Math.max(rows, 16) * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const storage = this.storage,
        layout = this.layout;
      this.groups = uniformGroups(this.uniform!, (binding) =>
        device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: binding },
            { binding: 1, resource: { buffer: storage } },
          ],
        }),
      );
    }
    const depth = c.descriptor.depthStencil!,
      samples = c.descriptor.multisample?.count ?? 1,
      key = c.format + ':' + samples + ':' + depth.format + ':' + depth.depthCompare;
    if (this.key !== key) {
      const plain = device.createShaderModule({ code: plainCode }),
        smooth = device.createShaderModule({ code: smoothCode }),
        plainLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        smoothLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout, this.ringLayout!] }),
        pipeline = (cullMode: GPUCullMode, module: GPUShaderModule, layout: GPUPipelineLayout): GPURenderPipeline =>
          device.createRenderPipeline({
            layout,
            vertex: {
              module,
              entryPoint: 'vertex',
              buffers: [
                {
                  arrayStride: 80,
                  attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                    { shaderLocation: 1, offset: 16, format: 'float32x3' },
                  ],
                },
              ],
            },
            fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
            primitive: { topology: 'triangle-list', cullMode },
            depthStencil: { format: depth.format, depthCompare: depth.depthCompare, depthWriteEnabled: false },
            multisample: c.descriptor.multisample,
          });
      // Front-facing triangles are culled; a mirrored row turns its winding round, so its own pipeline culls back.
      this.pipelines = [
        pipeline('front', plain, plainLayout),
        pipeline('back', plain, plainLayout),
        pipeline('front', smooth, smoothLayout),
        pipeline('back', smooth, smoothLayout),
      ];
      this.key = key;
    }
  }
  private draw(c: Context): void {
    const rows = this.collect(c);
    this.frame++;
    if (!rows) return;
    this.prepare(c, rows);
    const device = c.device,
      v = this.values;
    v.set(c.camera.matrix);
    v.set(this.rgb, 16);
    v[19] = this.width;
    const copy = writeUniform(device, this.uniform!, v as Float32Array<ArrayBuffer>, c.view ?? c);
    device.queue.writeBuffer(this.storage!, 0, this.rows as Float32Array<ArrayBuffer>, 0, rows * 16);
    const pass = beginScenePass(c, this.colorAttachment, this.depthAttachment);
    applyView(pass, c);
    pass.setBindGroup(0, this.groups!.get(copy));
    let bound: GPURenderPipeline | undefined;
    for (const run of this.runs) {
      const p = run.primitive,
        group = this.smooth ? this.ringGroup(device, p) : undefined,
        pipeline = this.pipelines![(group ? 2 : 0) + +run.mirrored];
      if (pipeline !== bound) pass.setPipeline((bound = pipeline));
      if (group) pass.setBindGroup(1, group);
      pass.setVertexBuffer(0, p.deformed ?? p.buffers!.vertex, (p.deformed && p.deformedOffset) || 0);
      pass.setIndexBuffer(p.buffers!.index, 'uint32');
      pass.drawIndexed(p.indices.length, run.count, 0, 0, run.first);
    }
    pass.end();
    // Rings of primitives no longer drawn go after 120 frames.
    if (this.frame % 120 === 0)
      for (const [p, s] of this.smoothing)
        if (s.seen < this.frame - 120) {
          retire(device, s.ring);
          this.smoothing.delete(p);
        }
  }
  /** Group 1 of the smooth pipelines for `p`: its vertices of this frame and its rings, baked on first use. */
  private ringGroup(device: GPUDevice, p: ModelPrimitiveLike): GPUBindGroup | undefined {
    const source = p.deformed ?? p.buffers!.vertex,
      offset = (p.deformed && p.deformedOffset) || 0;
    if (!(source.usage & GPUBufferUsage.STORAGE)) return undefined;
    let s = this.smoothing.get(p);
    if (!s || s.vertices !== p.vertices) {
      if (s) retire(device, s.ring);
      const ring = positionRings(p.vertices),
        buffer = device.createBuffer({
          size: Math.max(4, ring.byteLength),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
      device.queue.writeBuffer(buffer, 0, ring as Uint32Array<ArrayBuffer>);
      this.smoothing.set(p, (s = { ring: buffer, vertices: p.vertices, offset: 0, seen: 0 }));
    }
    s.seen = this.frame;
    if (s.source !== source || s.offset !== offset || !s.group) {
      s.group = device.createBindGroup({
        layout: this.ringLayout!,
        entries: [
          { binding: 0, resource: { buffer: source, offset, size: p.vertices.byteLength } },
          { binding: 1, resource: { buffer: s.ring } },
        ],
      });
      s.source = source;
      s.offset = offset;
    }
    return s.group;
  }
  private release(): void {
    if (this.engine?.gpu) {
      retire(this.engine.gpu, this.uniform);
      retire(this.engine.gpu, this.storage);
    }
    if (this.engine?.gpu) for (const s of this.smoothing.values()) retire(this.engine.gpu, s.ring);
    this.smoothing.clear();
    this.uniform = this.storage = this.layout = this.ringLayout = this.groups = this.pipelines = undefined;
    this.key = '';
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
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
