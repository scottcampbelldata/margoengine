import type { Engine, Mesh, PassContext } from '@margoengine/core/extension';
import type { Mesh as MeshHandle } from '@margoengine/core';
import { meshTriangles } from '../../shared/mesh-source.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export interface PickingPrimitive {
  node: Mesh;
  vertex: GPUBuffer;
  index: GPUBuffer;
  count: number;
  stride: 80;
  alphaTexture?: GPUTextureView;
  alphaSampler?: GPUSampler;
  alpha?: number;
  cutoff?: number;
  texCoord?: 0 | 1;
  alphaTransform?: Float32Array;
  doubleSided?: boolean;
  side?: 'front' | 'back' | 'double';
}
export interface PickingSource {
  readonly pickingPrimitives: readonly PickingPrimitive[];
  readonly disposed?: boolean;
  readonly root?: Mesh;
  prepareDeformation?(context: { backend: 'webgpu'; device: GPUDevice; encoder: GPUCommandEncoder }): void;
}
interface DrawOptions {
  format: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount?: number;
  filter?: (node: Mesh, primitive: PickingPrimitive, source: PickingSource, index: number) => boolean;
  id?: (node: Mesh, source: PickingSource, index: number) => number;
  mask?: (node: Mesh) => boolean;
  depthCompare?: GPUCompareFunction;
}
interface Draw {
  uniform: GPUBuffer;
  values: Float32Array;
  group: GPUBindGroup;
  pipeline: GPURenderPipeline;
  texture?: GPUTextureView;
  sampler?: GPUSampler;
}
const identityUV = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]);
const budget = 65536;

/** GPU-buffer sources shared by picking and selection without a dependency on a model loader. */
export class PickingPrimitives {
  private engine?: Engine;
  private device?: GPUDevice;
  private disposed = false;
  private readonly sources = new Set<PickingSource>();
  private readonly discovered = new Set<PickingSource>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly drawsByPipeline = new Map<GPURenderPipeline, Draw[]>();
  private white?: GPUTexture;
  private whiteView?: GPUTextureView;
  private sampler?: GPUSampler;
  get hasSources(): boolean {
    return this.sources.size > 0 || this.discovered.size > 0;
  }
  /** Discover loader-owned nodes without requiring callers to register their model separately. */
  discover(meshes: Iterable<MeshHandle>): void {
    if (this.disposed) throw new Error('Picking is disposed');
    const next = new Set<PickingSource>();
    let count = this.sources.size;
    for (const mesh of meshes) {
      const triangles = meshTriangles(mesh);
      if (triangles?.kind !== 'pbr') continue;
      const source = triangles.source.model as PickingSource;
      if (source.disposed || next.has(source)) continue;
      if (!this.sources.has(source) && ++count > 4096) throw new RangeError('Picking source budget exceeded');
      next.add(source);
    }
    if (next.size !== this.discovered.size || [...next].some((source) => !this.discovered.has(source)))
      this.clearDraws();
    this.discovered.clear();
    for (const source of next) this.discovered.add(source);
  }
  private allSources(): Set<PickingSource> {
    return new Set([...this.sources, ...this.discovered]);
  }
  add(source: PickingSource): () => void {
    if (this.disposed) throw new Error('Picking is disposed');
    this.validateSource(source);
    if (this.sources.has(source)) throw new Error('Duplicate picking source');
    if (!this.discovered.has(source) && this.allSources().size >= 4096)
      throw new RangeError('Picking source budget exceeded');
    this.sources.add(source);
    return () => {
      if (this.sources.delete(source)) this.clearDraws();
    };
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('Picking requires WebGPU');
    for (const source of this.allSources()) {
      if (source.disposed || (source.root?.engine === engine && engine.meshes.get(source.root.id) !== source.root)) {
        this.sources.delete(source);
        this.discovered.delete(source);
        continue;
      }
      this.validateSource(source, engine);
    }
    this.engine = engine;
    this.device = engine.gpu;
  }
  private validateSource(source: PickingSource, engine = this.engine): void {
    if (!source || typeof source !== 'object') throw new TypeError('Picking requires pickingPrimitives');
    const primitives = source.pickingPrimitives;
    if (!Array.isArray(primitives)) throw new TypeError('Picking requires pickingPrimitives');
    if (source.disposed) throw new Error('Picking source is disposed');
    if (source.prepareDeformation !== undefined && typeof source.prepareDeformation !== 'function')
      throw new TypeError('Invalid picking deformation callback');
    if (source.root) this.validateNode(source.root, engine);
    if (primitives.length > budget) throw new RangeError('Picking primitive budget exceeded');
    for (const primitive of primitives) {
      if (!primitive || typeof primitive !== 'object') throw new TypeError('Invalid picking primitive');
      this.validateNode(primitive.node, engine);
      this.validatePrimitive(primitive);
    }
  }
  private validateNode(node: Mesh, engine = this.engine): void {
    if (!node || typeof node.check !== 'function') throw new TypeError('Invalid picking node');
    node.check();
    if (engine && node.engine !== engine) throw new Error('Picking source belongs to another engine');
  }
  private validatePrimitive(p: PickingPrimitive): void {
    if (
      p.stride !== 80 ||
      !p.vertex ||
      !p.index ||
      !Number.isInteger(p.count) ||
      p.count < 0 ||
      p.count % 3 ||
      p.count > 0xffffffff ||
      (p.texCoord !== undefined && p.texCoord !== 0 && p.texCoord !== 1) ||
      !Number.isFinite(Math.fround(p.alpha ?? 1)) ||
      !Number.isFinite(Math.fround(p.cutoff ?? 0)) ||
      (p.alpha ?? 1) < 0 ||
      (p.cutoff ?? 0) < 0 ||
      (p.doubleSided !== undefined && typeof p.doubleSided !== 'boolean') ||
      (p.side !== undefined && !['front', 'back', 'double'].includes(p.side))
    )
      throw new RangeError('Invalid picking primitive');
    if (
      p.alphaTransform !== undefined &&
      (!(p.alphaTransform instanceof Float32Array) ||
        p.alphaTransform.length !== 8 ||
        p.alphaTransform.some((value) => !Number.isFinite(value)))
    )
      throw new TypeError('Picking alpha transform requires finite affine rows');
  }
  private live(source: PickingSource): boolean {
    return !source.disposed && (!source.root || this.engine!.meshes.get(source.root.id) === source.root);
  }
  /** Encode current-pose deformation before opening any picking render pass. */
  prepare(c: { backend: 'webgpu'; device: GPUDevice; encoder: GPUCommandEncoder }): void {
    if (this.disposed || !this.device || c.device !== this.device)
      throw new Error('Picking is not attached to this device');
    for (const source of this.allSources()) {
      if (!this.live(source)) {
        this.sources.delete(source);
        this.discovered.delete(source);
        this.clearDraws();
        continue;
      }
      source.prepareDeformation?.(c);
    }
  }
  contains(source: PickingSource, node: Mesh): boolean {
    return (
      (this.sources.has(source) || this.discovered.has(source)) &&
      this.live(source) &&
      source.pickingPrimitives.some((primitive) => primitive.node === node)
    );
  }
  /** Load existing depth so optional primitives compete with core meshes at the same pixel. */
  draw(c: Context, matrix: Float32Array, options: DrawOptions): Map<Mesh, PickingSource[]> {
    if (this.disposed || !this.device || c.device !== this.device)
      throw new Error('Picking is not attached to this device');
    const candidates = new Map<Mesh, PickingSource[]>(),
      primitives: PickingPrimitive[] = [],
      ids: number[] = [];
    for (const source of this.allSources()) {
      if (!this.live(source)) {
        this.sources.delete(source);
        this.discovered.delete(source);
        continue;
      }
      const values = source.pickingPrimitives;
      if (!Array.isArray(values)) throw new TypeError('Picking requires pickingPrimitives');
      for (let sourceIndex = 0; sourceIndex < values.length; sourceIndex++) {
        const p = values[sourceIndex];
        if (!p?.node) throw new TypeError('Invalid picking primitive');
        const node = p.node;
        if (node.engine !== this.engine) throw new Error('Picking source belongs to another engine');
        if (this.engine!.meshes.get(node.id) !== node) continue;
        this.validatePrimitive(p);
        let visible = true;
        for (let id = node.id; id !== -1; id = this.engine!.store.parents[id])
          if (this.engine!.store.hidden[id]) {
            visible = false;
            break;
          }
        if (
          !visible ||
          (options.filter && !options.filter(node, p, source, sourceIndex)) ||
          (options.mask && !options.mask(node)) ||
          !p.count
        )
          continue;
        if (primitives.length >= budget) throw new RangeError('Picking primitive budget exceeded');
        primitives.push(p);
        ids.push(options.id?.(node, source, sourceIndex) ?? node.id + 1);
        let owners = candidates.get(node);
        if (!owners) {
          owners = [];
          candidates.set(node, owners);
        }
        if (!owners.includes(source)) owners.push(source);
      }
    }
    if (!primitives.length) {
      this.clearDraws();
      return candidates;
    }
    const mask = !!options.mask,
      key = [
        options.format,
        options.depthFormat,
        options.sampleCount ?? 1,
        options.depthCompare ?? 'greater-equal',
        mask,
      ].join(':');
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      if (this.pipelines.size >= 64) throw new RangeError('Too many picking primitive variants');
      const module = this.device.createShaderModule({ code: shader(mask) });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 80,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x4' },
                { shaderLocation: 3, offset: 48, format: 'float32x4' },
                { shaderLocation: 4, offset: 64, format: 'float32x4' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: options.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count: options.sampleCount ?? 1 },
        depthStencil: {
          format: options.depthFormat,
          depthWriteEnabled: !mask,
          depthCompare: options.depthCompare ?? 'greater-equal',
        },
      });
      this.pipelines.set(key, pipeline);
    }
    if (!this.white) {
      this.white = this.device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this.white },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1],
      );
      this.whiteView = this.white.createView();
      this.sampler = this.device.createSampler();
    }
    let draws = this.drawsByPipeline.get(pipeline);
    if (!draws) {
      draws = [];
      this.drawsByPipeline.set(pipeline, draws);
    }
    // Each primitive owns its uniform: queue writes all complete before the submitted passes execute.
    for (let index = 0; index < primitives.length; index++) {
      const p = primitives[index];
      let record = draws[index];
      if (
        !record ||
        record.pipeline !== pipeline ||
        record.texture !== p.alphaTexture ||
        record.sampler !== p.alphaSampler
      ) {
        record?.uniform.destroy();
        const uniform = this.device.createBuffer({
          size: 192,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        try {
          record = {
            uniform,
            values: new Float32Array(48),
            pipeline,
            texture: p.alphaTexture,
            sampler: p.alphaSampler,
            group: this.device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: uniform } },
                { binding: 1, resource: p.alphaTexture ?? this.whiteView! },
                { binding: 2, resource: p.alphaSampler ?? this.sampler! },
              ],
            }),
          };
          draws[index] = record;
        } catch (error) {
          uniform.destroy();
          draws.splice(index, 1);
          throw error;
        }
      }
      const values = record.values,
        m = p.node.matrix;
      values.set(matrix);
      values.set(m, 16);
      values[32] = p.alpha ?? 1;
      values[33] = p.cutoff ?? 0;
      values[34] = p.texCoord ?? 0;
      values[35] = Math.sign(
        m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]),
      );
      values.set(p.alphaTransform ?? identityUV, 36);
      values[44] = ids[index];
      values[45] = p.side === 'back' ? 2 : p.side === 'double' ? 1 : p.side === 'front' ? 0 : +(p.doubleSided ?? false);
      this.device.queue.writeBuffer(record.uniform, 0, values as Float32Array<ArrayBuffer>);
    }
    for (const record of draws.splice(primitives.length)) record.uniform.destroy();
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: c.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(options.depthFormat.includes('stencil') ? { stencilReadOnly: true } : {}),
      },
    });
    try {
      pass.setPipeline(pipeline);
      for (let index = 0; index < primitives.length; index++) {
        const p = primitives[index];
        pass.setBindGroup(0, draws[index].group);
        pass.setVertexBuffer(0, p.vertex);
        pass.setIndexBuffer(p.index, 'uint32');
        pass.drawIndexed(p.count);
      }
    } finally {
      pass.end();
    }
    return candidates;
  }
  private clearDraws(): void {
    for (const draws of this.drawsByPipeline.values()) for (const record of draws) record.uniform.destroy();
    this.drawsByPipeline.clear();
  }
  release(): void {
    this.clearDraws();
    this.white?.destroy();
    this.white = undefined;
    this.whiteView = undefined;
    this.sampler = undefined;
    this.pipelines.clear();
    this.device = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.sources.clear();
    this.discovered.clear();
    this.engine = undefined;
  }
}

function shader(mask: boolean): string {
  return /* wgsl */ `
struct PickFrame {camera:mat4x4f,model:mat4x4f,settings:vec4f,uv0:vec4f,uv1:vec4f,info:vec4f}
@group(0) @binding(0) var<uniform> f:PickFrame;
@group(0) @binding(1) var alphaMap:texture_2d<f32>;
@group(0) @binding(2) var alphaSampler:sampler;
struct PickInput {@location(0) position:vec4f,@location(3) uv:vec4f,@location(4) color:vec4f}
struct PickOutput {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:PickInput)->PickOutput {var o:PickOutput;let p=f.model*vec4f(i.position.xyz,1);o.position=f.camera*p;o.uv=select(i.uv.xy,i.uv.zw,f.settings.z>0.5);o.alpha=i.color.a;return o;}
@fragment fn fragment(i:PickOutput,@builtin(front_facing) front:bool)->@location(0) ${mask ? 'vec4f' : 'u32'} {
 let uv=vec2f(dot(f.uv0.xy,i.uv)+f.uv0.z,dot(f.uv1.xy,i.uv)+f.uv1.z);let alpha=textureSample(alphaMap,alphaSampler,uv).a*f.settings.x*i.alpha;
 let facing=front==(f.settings.w>0.0);if((!facing&&f.info.y<0.5)||(facing&&f.info.y>1.5)||alpha<f.settings.y){discard;}return ${mask ? 'vec4f(1,0,0,1)' : 'u32(f.info.x)'};
}`;
}
