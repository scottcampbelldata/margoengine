import type { Engine, Mesh } from '@margoengine/core/extension';
import { instanceMatrix } from '../../shared/instances.js';
declare const GPUBufferUsage: { STORAGE: number; UNIFORM: number; COPY_DST: number };

/** Structural gltf-pro `PBRPrimitive`: `buffers` exist while its model is set up on a device; `deformed` replaces the vertices when skinned. */
export interface ModelPrimitive {
  readonly node: Mesh;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly material: { readonly settings: ArrayLike<number> };
  readonly buffers?: { vertex: GPUBuffer; index: GPUBuffer };
  readonly deformed?: GPUBuffer;
  /** gltf-pro PBRInstances: drawn once per instance (24 floats each, node-space matrix first). */
  readonly instances?: { readonly count: number; readonly data: Float32Array };
}
/** Structural gltf-pro `PBRModel` (@margoengine/materials meshes are PBRModels too). */
export interface Model {
  readonly root: Mesh;
  readonly primitives: readonly ModelPrimitive[];
  readonly disposed?: boolean;
}
/** gltf-pro shape: a `root` node and `primitives` with 20-float CPU vertices (the first one is checked). */
export const isModel = (value: unknown): value is Model =>
  !!value &&
  typeof value === 'object' &&
  !!(value as Model).root &&
  Array.isArray((value as Model).primitives) &&
  (!(value as Model).primitives.length || (value as Model).primitives[0].vertices instanceof Float32Array);
/** Structural pick proxy (an @margoengine/lod imposter level): local bounding sphere (x, y, z, radius) under the anchor's world matrix. */
export interface PickProxy {
  readonly anchor: Mesh;
  readonly sphere: ArrayLike<number>;
  readonly model?: object | null;
}
/** Proxies from engine plugins with `pickProxies()` (an @margoengine/lod LODSystem), copied into a new array. */
export const proxies = (e: Engine): PickProxy[] => {
  const out: PickProxy[] = [];
  if (e.plugins)
    for (const p of e.plugins.values() as Iterable<{ pickProxies?: () => readonly PickProxy[] }>)
      if (typeof p.pickProxies === 'function') out.push(...p.pickProxies());
  return out;
};
export const hidden = (e: Engine, id: number): boolean => {
  for (let slot = id; slot !== -1; slot = e.store.parents[slot]) if (e.store.hidden[slot]) return true;
  return false;
};

/** Attached gltf-pro models (engine plugins with `root` and `primitives`), rescanned only when the frame graph, mesh count or a model's liveness changes. */
export class Models {
  list: Model[] = [];
  starts: number[] = []; /** Primitives over all models: pick slots after them belong to pick proxies. */
  total = 0;
  version = 0;
  private revision = -1;
  private size = -1;
  update(e: Engine): Model[] {
    let stale = e.frameGraph.revision !== this.revision || e.meshes.size !== this.size;
    for (let i = 0; !stale && i < this.list.length; i++) stale = !!this.list[i].disposed;
    if (!stale) return this.list;
    this.revision = e.frameGraph.revision;
    this.size = e.meshes.size;
    this.version++;
    this.list = [];
    this.starts = [];
    let start = 0;
    if (e.plugins)
      for (const plugin of e.plugins.values())
        if (isModel(plugin) && !plugin.disposed) {
          this.list.push(plugin);
          this.starts.push(start);
          start += plugin.primitives.length;
        }
    this.total = start;
    return this.list;
  }
}

const spheres = new WeakMap<Uint32Array, Float64Array>();
/** Local bounding sphere (centre, radius) of a primitive's 20-float vertices, cached by its index array. */
export function sphere(p: ModelPrimitive): Float64Array {
  let s = spheres.get(p.indices);
  if (s) return s;
  const v = p.vertices,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 20)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[i + k]);
      max[k] = Math.max(max[k], v[i + k]);
    }
  const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  let r = 0;
  for (let i = 0; i < v.length; i += 20)
    r = Math.max(r, (v[i] - c[0]) ** 2 + (v[i + 1] - c[1]) ** 2 + (v[i + 2] - c[2]) ** 2);
  s = new Float64Array([...c, Math.sqrt(r)]);
  spheres.set(p.indices, s);
  return s;
}

/** Same world and clip transform as gltf-pro's vertex shader, so equal-depth tests against its depth hold. info: id, doubleSided, front sign. */
export const modelCode = (fragment: string) => `
struct Draw {model:mat4x4f,info:vec4u}
@group(0) @binding(0) var<uniform> camera:mat4x4f;
@group(0) @binding(1) var<storage,read> draws:array<Draw>;
struct Out {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) info:vec4u}
@vertex fn vertex(@location(0) position:vec4f,@builtin(instance_index) slot:u32)->Out {let d=draws[slot];let p=d.model*vec4f(position.xyz,1);return Out(camera*p,d.info);}
fn culled(i:Out,front:bool)->bool {return i.info.y==0u&&front!=(i.info.z==1u);}
${fragment}`;
export function modelPipeline(
  device: GPUDevice,
  code: string,
  format: GPUTextureFormat,
  depthStencil: GPUDepthStencilState,
  multisample?: GPUMultisampleState,
): GPURenderPipeline {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vertex',
      buffers: [{ arrayStride: 80, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    },
    fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil,
    multisample,
  });
}

/** Per-draw model matrices and info in one storage buffer, drawn with `firstInstance` as the slot. Grows, never shrinks; no per-frame allocation. */
export class ModelDraws {
  count = 0;
  private data = new Float32Array(20 * 16);
  private words = new Uint32Array(this.data.buffer);
  private primitives: ModelPrimitive[] = [];
  private runs: number[] = [];
  private storage?: GPUBuffer;
  private camera?: GPUBuffer;
  private group?: GPUBindGroup;
  private pipeline?: GPURenderPipeline;
  reset(): void {
    this.count = 0;
    this.runs.length = 0;
  }
  add(p: ModelPrimitive, id: number, m: ArrayLike<number> = p.node.matrix): void {
    const o = this.count * 20;
    if (o + 20 > this.data.length) {
      const data = new Float32Array(this.data.length * 2);
      data.set(this.data);
      this.data = data;
      this.words = new Uint32Array(data.buffer);
    }
    this.data.set(m, o);
    this.words[o + 16] = id;
    this.words[o + 17] = +(p.material.settings[2] >= 0.5);
    this.words[o + 18] = +(
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]) >
      0
    );
    this.primitives[this.count++] = p;
  }
  /** Every drawn instance of `p` (world = node x instance) with one ID, drawn as one instanced draw over consecutive slots. */
  addInstances(p: ModelPrimitive, id: number, node: ArrayLike<number>): void {
    const inst = p.instances!,
      first = this.count,
      m = new Float32Array(16);
    for (let k = 0; k < inst.count; k++) this.add(p, id, instanceMatrix(node, inst.data, k, m));
    this.runs[first] = inst.count;
  }
  /** Uploads the draws and camera and binds them; call inside a pass using `pipeline`. */
  draw(device: GPUDevice, pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, camera: Float32Array): void {
    if (!this.count) return;
    if (!this.storage || this.storage.size < this.data.byteLength) {
      this.storage?.destroy();
      this.storage = device.createBuffer({
        size: this.data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.group = undefined;
    }
    if (!this.camera) {
      this.camera = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.group = undefined;
    }
    if (!this.group || this.pipeline !== pipeline) {
      this.pipeline = pipeline;
      this.group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.camera } },
          { binding: 1, resource: { buffer: this.storage } },
        ],
      });
    }
    device.queue.writeBuffer(this.camera, 0, camera as Float32Array<ArrayBuffer>);
    device.queue.writeBuffer(this.storage, 0, this.data, 0, this.count * 20);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group);
    for (let i = 0; i < this.count; ) {
      const p = this.primitives[i],
        n = this.runs[i] || 1;
      pass.setVertexBuffer(0, p.deformed ?? p.buffers!.vertex);
      pass.setIndexBuffer(p.buffers!.index, 'uint32');
      pass.drawIndexed(p.indices.length, n, 0, 0, i);
      i += n;
    }
  }
  release(): void {
    this.storage?.destroy();
    this.camera?.destroy();
    this.storage = this.camera = this.group = this.pipeline = undefined;
    this.primitives = [];
    this.count = 0;
  }
}
