import type { Engine, Mesh, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Mesh as MeshHandle } from '@margoengine/core';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
import {
  casterBuffers,
  clippedDepth,
  displacementGroup,
  opacityDepth,
  opacityEntries,
  solidVertexDepth,
} from '../../shared/caster.js';
import { displacedDepth } from '../../shared/displacement.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** One indexed triangle draw of a `PickingSource`: GPU vertex and index buffers (80-byte vertices) for one engine mesh node, with optional alpha-test data. */
export interface PickingPrimitive {
  node: Mesh;
  vertex: GPUBuffer;
  /** Byte offset of the primitive's first vertex in `vertex` (a deformer's shared buffer). Default 0. */
  vertexOffset?: number;
  index: GPUBuffer;
  count: number;
  stride: 80;
  alphaTexture?: GPUTextureView;
  alphaSampler?: GPUSampler;
  alpha?: number;
  cutoff?: number;
  texCoord?: 0 | 1;
  alphaTransform?: Float32Array;
  /** Opacity map of the surface (materials `alphaMap`): its green channel multiplies the alpha `cutoff` tests. */
  opacity?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
  /** False keeps vertex alpha out of the test, as the colour pass does (materials `vertexColors: false`). Default true. */
  vertexAlpha?: boolean;
  /** Vertex displacement of the surface (materials `displacementMap`): the shape a click lands on. */
  displacement?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
  /** Planes that clip the surface (materials `clippingPlanes`): a click through them misses. */
  clip?: GPUBufferBinding;
  doubleSided?: boolean;
  side?: 'front' | 'back' | 'double';
}
/** Optional geometry (a model loader) that `Picking` and `Selection` draw besides core meshes; register it with `add(source)`. `disposed` sources are skipped. */
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
  /** Group 0 per uniform binding: a second view of a frame binds its own uniform slice. */
  groups: { get(copy?: GPUBufferBinding): GPUBindGroup };
  slice?: GPUBufferBinding;
  pipeline: GPURenderPipeline;
  texture?: GPUTextureView;
  sampler?: GPUSampler;
  opacity?: PickingPrimitive['opacity'];
  displacement?: PickingPrimitive['displacement'];
  displaced?: GPUBindGroup;
  clip?: GPUBuffer;
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
    if (this.disposed)
      throw new MargoError('disposed', 'Picking is disposed; create a new Picking to register sources.');
    const next = new Set<PickingSource>();
    let count = this.sources.size;
    for (const mesh of meshes) {
      const triangles = meshTriangles(mesh);
      if (triangles?.kind !== 'pbr') continue;
      const source = triangles.source.model as PickingSource;
      if (source.disposed || next.has(source)) continue;
      if (!this.sources.has(source) && ++count > 4096)
        throw new RangeError('Picking source budget exceeded; register at most 4096 sources.');
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
    if (this.disposed)
      throw new MargoError('disposed', 'Picking is disposed; create a new Picking to register sources.');
    this.validateSource(source);
    if (this.sources.has(source))
      throw new MargoError(
        'state',
        'Duplicate picking source; add each source once, or call its remove function first.',
      );
    if (!this.discovered.has(source) && this.allSources().size >= 4096)
      throw new RangeError('Picking source budget exceeded; register at most 4096 sources.');
    this.sources.add(source);
    return () => {
      if (this.sources.delete(source)) this.clearDraws();
    };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'Picking is disposed; create a new Picking to attach.');
    if (!engine.gpu) throw new MargoError('unsupported', 'Picking requires WebGPU; use a browser with WebGPU enabled.');
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
    if (!source || typeof source !== 'object')
      throw new TypeError('Picking source needs a pickingPrimitives array; pass an object with pickingPrimitives.');
    const primitives = source.pickingPrimitives;
    if (!Array.isArray(primitives))
      throw new TypeError('Picking source needs a pickingPrimitives array; pass an object with pickingPrimitives.');
    if (source.disposed) throw new MargoError('disposed', 'Picking source is disposed; add a live source.');
    if (source.prepareDeformation !== undefined && typeof source.prepareDeformation !== 'function')
      throw new TypeError('Invalid picking deformation callback; pass a function as prepareDeformation or omit it.');
    if (source.root) this.validateNode(source.root, engine);
    if (primitives.length > budget)
      throw new RangeError('Picking primitive budget exceeded; split the model into sources of fewer primitives.');
    for (const primitive of primitives) {
      if (!primitive || typeof primitive !== 'object')
        throw new TypeError('Invalid picking primitive; each pickingPrimitives entry must be an object with a node.');
      this.validateNode(primitive.node, engine);
      this.validatePrimitive(primitive);
    }
  }
  private validateNode(node: Mesh, engine = this.engine): void {
    if (!node || typeof node.check !== 'function')
      throw new TypeError('Invalid picking node; pass a live mesh of this engine as root.');
    node.check();
    if (engine && node.engine !== engine)
      throw new MargoError(
        'attached',
        'Picking source belongs to another engine; add only sources made on this engine.',
      );
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
      throw new RangeError(
        'Invalid picking primitive; use stride 80, vertex and index buffers, a count divisible by 3, finite alpha and cutoff of 0 or more, and side front, back or double.',
      );
    if (
      p.alphaTransform !== undefined &&
      (!(p.alphaTransform instanceof Float32Array) ||
        p.alphaTransform.length !== 8 ||
        p.alphaTransform.some((value) => !Number.isFinite(value)))
    )
      throw new TypeError(
        'Picking alpha transform requires finite affine rows; pass a Float32Array of 8 finite numbers.',
      );
  }
  private live(source: PickingSource): boolean {
    return !source.disposed && (!source.root || this.engine!.meshes.get(source.root.id) === source.root);
  }
  /** Encode current-pose deformation before opening any picking render pass. */
  prepare(c: { backend: 'webgpu'; device: GPUDevice; encoder: GPUCommandEncoder }): void {
    if (this.disposed || !this.device || c.device !== this.device)
      throw new MargoError(
        'state',
        'Picking is not attached to this device; attach it with engine.use before drawing.',
      );
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
      throw new MargoError(
        'state',
        'Picking is not attached to this device; attach it with engine.use before drawing.',
      );
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
      if (!Array.isArray(values))
        throw new TypeError('Picking source needs a pickingPrimitives array; pass an object with pickingPrimitives.');
      for (let sourceIndex = 0; sourceIndex < values.length; sourceIndex++) {
        const p = values[sourceIndex];
        if (!p?.node)
          throw new TypeError('Invalid picking primitive; each pickingPrimitives entry must be an object with a node.');
        const node = p.node;
        if (node.engine !== this.engine)
          throw new MargoError(
            'attached',
            'Picking source belongs to another engine; add only sources made on this engine.',
          );
        if (this.engine!.meshes.get(node.id) !== node) continue;
        this.validatePrimitive(p);
        if (
          hiddenInTree(this.engine!.store, node.id) ||
          (options.filter && !options.filter(node, p, source, sourceIndex)) ||
          (options.mask && !options.mask(node)) ||
          !p.count
        )
          continue;
        if (primitives.length >= budget)
          throw new RangeError('Picking primitive budget exceeded; split the model into sources of fewer primitives.');
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
    const pipeline = this.pipeline(options);
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
    // Records live under the plain pipeline of these options; each holds its own variant.
    let draws = this.drawsByPipeline.get(pipeline);
    if (!draws) {
      draws = [];
      this.drawsByPipeline.set(pipeline, draws);
    }
    // Each primitive owns its uniform; another view of the same frame writes a frame-arena slice.
    for (let index = 0; index < primitives.length; index++) {
      const p = primitives[index],
        { opacity, displacement, clip } = p,
        variant =
          opacity || displacement || clip || p.vertexAlpha === false
            ? this.pipeline(options, !!opacity, p.vertexAlpha === false, !!displacement, !!clip)
            : pipeline;
      let record = draws[index];
      if (
        !record ||
        record.pipeline !== variant ||
        record.texture !== p.alphaTexture ||
        record.sampler !== p.alphaSampler ||
        record.opacity !== opacity ||
        record.displacement !== displacement ||
        record.clip !== clip?.buffer
      ) {
        retire(this.device!, record?.uniform);
        const uniform = this.device.createBuffer({
          size: 192,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const texture = p.alphaTexture ?? this.whiteView!,
          sampler = p.alphaSampler ?? this.sampler!;
        try {
          record = {
            uniform,
            values: new Float32Array(48),
            pipeline: variant,
            texture: p.alphaTexture,
            sampler: p.alphaSampler,
            opacity,
            displacement,
            displaced: displacementGroup(this.device!, () => variant.getBindGroupLayout(1), displacement),
            clip: clip?.buffer,
            groups: uniformGroups(uniform, (binding) =>
              this.device!.createBindGroup({
                layout: variant.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: binding },
                  { binding: 1, resource: texture },
                  { binding: 2, resource: sampler },
                  ...(clip ? [{ binding: 3, resource: clip }] : []),
                  ...(opacity ? opacityEntries(opacity) : []),
                ],
              }),
            ),
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
      record.slice = writeUniform(this.device, record.uniform, values as Float32Array<ArrayBuffer>, c.view ?? c);
    }
    for (const record of draws.splice(primitives.length)) retire(this.device!, record.uniform);
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
      let bound: GPURenderPipeline | undefined;
      for (let index = 0; index < primitives.length; index++) {
        const p = primitives[index];
        if (draws[index].pipeline !== bound) pass.setPipeline((bound = draws[index].pipeline));
        pass.setBindGroup(0, draws[index].groups.get(draws[index].slice));
        if (draws[index].displaced) pass.setBindGroup(1, draws[index].displaced!);
        pass.setVertexBuffer(0, p.vertex, p.vertexOffset || undefined);
        pass.setIndexBuffer(p.index, 'uint32');
        pass.drawIndexed(p.count);
      }
    } finally {
      pass.end();
    }
    return candidates;
  }
  /** The pipeline of `options`; a primitive with an opacity map, no vertex alpha, displacement or planes takes its own shader. */
  private pipeline(
    options: DrawOptions,
    opacity = false,
    solid = false,
    displaced = false,
    clipped = false,
  ): GPURenderPipeline {
    const mask = !!options.mask,
      key = [
        options.format,
        options.depthFormat,
        options.sampleCount ?? 1,
        options.depthCompare ?? 'greater-equal',
        mask,
        opacity,
        solid,
        displaced,
        clipped,
      ].join(':');
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      if (this.pipelines.size >= 64)
        throw new RangeError(
          'Too many picking primitive variants; reduce distinct formats, sample counts and mask modes to 64 or fewer.',
        );
      let code = shader(mask);
      if (displaced) code = displacedDepth(code, 1);
      if (solid) code = solidVertexDepth(code);
      if (opacity) code = opacityDepth(code, 0);
      if (clipped) code = clippedDepth(code, 3, 'materialClip');
      const module = this.device!.createShaderModule({ code });
      pipeline = this.device!.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: casterBuffers(80, displaced),
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
    return pipeline;
  }
  private clearDraws(): void {
    for (const draws of this.drawsByPipeline.values()) for (const record of draws) retire(this.device!, record.uniform);
    this.drawsByPipeline.clear();
  }
  release(): void {
    this.clearDraws();
    retire(this.device!, this.white);
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
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:PickInput)->Out {var o:Out;let p=f.model*vec4f(i.position.xyz,1);o.clip=f.camera*p;o.uv=select(i.uv.xy,i.uv.zw,f.settings.z>0.5);o.alpha=i.color.a;return o;}
@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) ${mask ? 'vec4f' : 'u32'} {
 let uv=vec2f(dot(f.uv0.xy,i.uv)+f.uv0.z,dot(f.uv1.xy,i.uv)+f.uv1.z);let alpha=textureSample(alphaMap,alphaSampler,uv).a*f.settings.x*i.alpha;
 let facing=front==(f.settings.w>0.0);if((!facing&&f.info.y<0.5)||(facing&&f.info.y>1.5)||alpha<f.settings.y){discard;}return ${mask ? 'vec4f(1,0,0,1)' : 'u32(f.info.x)'};
}`;
}
