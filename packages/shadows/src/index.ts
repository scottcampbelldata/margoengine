/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Camera,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Mesh,
} from '@margoengine/core/extension';
import { viewMatrix } from '../../shared/view.js';
import { preset } from '../../shared/preset.js';
import { cascadeSplits, fitCascades } from './cascades.js';
import { shadowSampling, shadowDepth } from './shader.js';
import { instanceLayout, instancedDepth } from '../../shared/instances.js';
import { MargoError } from '@margoengine/math/errors';
export { cascadeSplits, fitCascades } from './cascades.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
type ShadowPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** Directional shadow settings, read every frame from `shadows.options`; out of range throws RangeError. */
export interface ShadowOptions {
  /** Texels per side of each cascade map, an integer >= 16. Default 2048. */
  resolution?: number;
  /** Farthest shadowed distance from the camera, world units, > 0. Default 500. */
  distance?: number;
  /** Cascade split blend, 0 (uniform) to 1 (logarithmic). Default 0.5. */
  lambda?: number;
  /** Angular size of the light for PCSS softness, >= 0. Default 0.02. */
  lightSize?: number;
  /** Constant depth bias, >= 0. Default 0.0005. */
  bias?: number;
  /** Receiver offset along its normal, world units, >= 0. Default 0.02. */
  normalBias?: number;
  /** World units each cascade extends towards the light for off-screen casters, >= 0. Default 100. */
  casterMargin?: number;
}
/** What a custom `ShadowSource.drawShadow` receives for one cascade. Borrowed: use it synchronously. */
export interface ShadowContext {
  /** The frame's WebGPU pass context. */
  context: ShadowPassContext;
  /** The open depth-only pass of this cascade. */
  pass: GPURenderPassEncoder;
  /** The cascade's light view-projection matrix (16 floats, column-major). */
  matrix: Float32Array;
  /** Cascade index, 0-3. */
  cascade: number;
}
/** One drawable shadow caster (the contract core and gltf-pro meshes expose as `shadowPrimitives`). */
export interface ShadowPrimitive {
  /** The mesh whose world matrix places the primitive. */
  node: Mesh;
  /** Vertex buffer: 24-byte core or 80-byte PBR vertices. */
  vertex: GPUBuffer;
  /** Uint32 triangle indices. */
  index: GPUBuffer;
  /** Index count. */
  count: number;
  /** Vertex stride in bytes: 24 (core) or 80 (PBR). */
  stride: number;
  /** Base-colour texture for alpha-masked casters. */
  alphaTexture?: GPUTextureView;
  /** Sampler of `alphaTexture`. */
  alphaSampler?: GPUSampler;
  /** Base-colour alpha factor. */
  alpha?: number;
  /** Alpha-mask cutoff, 0..1. Default 0 (nothing masked). */
  cutoff?: number;
  /** UV set of `alphaTexture`, 0 or 1. */
  texCoord?: number;
  /** gltf-pro PBRInstances (80-byte vertices only): drawn once per instance, node matrix x instance matrix. */
  instances?: { readonly count: number; upload(device: GPUDevice): GPUBuffer };
}
/**
 * Anything `shadows.add` takes besides a core mesh: a gltf-pro model, `Terrain`, `ScatterInstances`, or a custom caster
 * with `drawShadow`. It needs `shadowPrimitives` or `drawShadow`.
 */
export interface ShadowSource {
  /** Casters drawn by the standard depth pipeline, read every shadow frame. */
  shadowPrimitives?: readonly ShadowPrimitive[];
  /** Bumped by a static source when its casters change, so a cached static cascade re-renders. */
  shadowVersion?: number;
  /** Custom depth drawing for one cascade. */
  drawShadow?(context: ShadowContext): void;
  /** Lets the source receive shadows (patches its shader); returns the remover. */
  addLighting?(effect: Shadows): () => void;
  /** True once disposed; such a source is rejected or dropped. */
  disposed?: boolean;
}
interface Source {
  source: ShadowSource | Mesh;
  static: boolean;
  version: number;
  removeLighting?: () => void;
  meshPrimitive?: ShadowPrimitive[];
}
interface Draw {
  uniforms: GPUBuffer[];
  groups: GPUBindGroup[];
  values: Float32Array;
  vertex: GPUBuffer;
  index: GPUBuffer;
  pipeline: GPURenderPipeline;
  alpha?: GPUTextureView;
  sampler?: GPUSampler;
}
const emptyPrimitives: readonly ShadowPrimitive[] = [];
/**
 * Directional cascaded shadows with PCSS soft edges: four practical splits in a `depth32float` array, stable texel-
 * snapped extents, for core meshes and any {@link ShadowSource}. `Shadows.attach(engine, options)`, then
 * `shadows.add(mesh, {static: true})` per caster (static ones re-render only when they change). WebGPU only.
 * @throws RangeError when an option is out of range.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced the core PBR shader,
 * `'disposed'` for a disposed effect or source, `'attached'` for a source of another engine or one added twice,
 * `'state'` when used before attaching.
 */
export class Shadows implements EnginePlugin {
  readonly name = 'shadows';
  readonly matrices = new Float32Array(64);
  readonly splits = new Float32Array(4);
  readonly stats = { staticDraws: 0, dynamicDraws: 0, cacheHits: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private cached?: GPUTexture;
  private combined?: GPUTexture;
  private white?: GPUTexture;
  private sampler?: GPUSampler;
  private alphaSampler?: GPUSampler;
  private views: GPUTextureView[] = [];
  private cachedViews: GPUTextureView[] = [];
  private entries: GPUBindGroupEntry[] = [];
  private pipelines = new Map<number, GPURenderPipeline>();
  private draws = new Map<Mesh, Map<GPUBuffer, Draw>>();
  private sources: Source[] = [];
  private readonly values = new Float32Array(92);
  private readonly ranges = this.values.subarray(84, 88);
  private readonly previous = new Float32Array(64);
  private readonly view = this.values.subarray(64, 80);
  private dirty = true;
  private disposed = false;
  private whiteView?: GPUTextureView;
  private readonly light = new Float32Array(3);
  private readonly fitCamera = {
    position: [0, 0, 0],
    target: [0, 0, 0],
    fov: 60,
    near: 0.1,
    far: 500,
  } as unknown as Camera;
  private readonly fitted = { matrices: this.matrices, ranges: this.ranges };
  private readonly cascadeMatrices = Array.from({ length: 4 }, (_, i) => this.matrices.subarray(i * 16, i * 16 + 16));
  private readonly shadowContexts = this.cascadeMatrices.map(
    (matrix, cascade) => ({ context: undefined!, pass: undefined!, matrix, cascade }) as ShadowContext,
  );
  private readonly shaders = new Map<number, Map<string, string>>();
  private readonly hooks = new Map<number, { declarations: string; direct(direct: string): string }>();
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthClearValue: 1,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
  };
  private readonly depthPass: GPURenderPassDescriptor = {
    colorAttachments: [],
    depthStencilAttachment: this.depthAttachment,
  };
  private readonly copySource: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly copyDestination: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly copySize = { width: 0, height: 0, depthOrArrayLayers: 4 };
  constructor(readonly options: ShadowOptions = {}) {
    this.options = preset('shadows', options);
    this.validate();
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: ShadowOptions = {}): Shadows {
    const effect = new Shadows(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  private validate(): void {
    const o = this.options;
    if (
      !Number.isInteger(o.resolution ?? 2048) ||
      (o.resolution ?? 2048) < 16 ||
      !Number.isFinite(o.distance ?? 500) ||
      (o.distance ?? 500) <= 0 ||
      !Number.isFinite(o.lambda ?? 0.5) ||
      (o.lambda ?? 0.5) < 0 ||
      (o.lambda ?? 0.5) > 1
    )
      throw new RangeError('Invalid shadow options');
    for (let i = 0; i < 4; i++) {
      const v =
        i === 0
          ? (o.lightSize ?? 0.02)
          : i === 1
            ? (o.bias ?? 0.0005)
            : i === 2
              ? (o.normalBias ?? 0.02)
              : (o.casterMargin ?? 100);
      if (!Number.isFinite(Math.fround(v)) || v < 0) throw new RangeError('Invalid shadow options');
    }
  }
  add(source: ShadowSource | MeshHandle, { static: cached = false }: { static?: boolean } = {}): () => void {
    if (this.disposed || !source || typeof cached !== 'boolean') throw new TypeError('Invalid shadow source');
    if ('disposed' in source && source.disposed)
      throw new MargoError('disposed', 'Shadow source is disposed; add a live mesh');
    const runtime = 'id' in source ? meshRuntime(source as MeshHandle) : (source as ShadowSource);
    if ('id' in runtime) {
      runtime.check();
      if (this.engine && runtime.engine !== this.engine)
        throw new MargoError(
          'attached',
          'Shadow mesh belongs to another engine; use objects created by the same engine',
        );
    } else if (!('shadowPrimitives' in runtime) && typeof runtime.drawShadow !== 'function')
      throw new TypeError('Invalid shadow source');
    if (
      this.engine &&
      'shadowPrimitives' in runtime &&
      runtime.shadowPrimitives?.some((p) => p.node.engine !== this.engine)
    )
      throw new MargoError(
        'attached',
        'Shadow source belongs to another engine; use objects created by the same engine',
      );
    if (this.sources.some((r) => r.source === runtime))
      throw new MargoError('attached', 'Duplicate shadow source; add each source once');
    const r: Source = {
      source: runtime,
      static: cached,
      version: -1,
      removeLighting: 'addLighting' in runtime ? runtime.addLighting?.(this) : undefined,
    };
    this.sources.push(r);
    this.invalidate();
    return () => {
      const index = this.sources.indexOf(r);
      if (index >= 0) {
        this.sources.splice(index, 1);
        r.removeLighting?.();
        this.invalidate();
        this.clearDraws();
      }
    };
  }
  invalidate(): void {
    this.dirty = true;
  }
  bindings(): GPUBindGroupEntry[] {
    if (!this.uniform || this.disposed)
      throw new MargoError('state', 'Shadows are not attached; attach them to an engine first');
    return this.entries;
  }
  shader(source: string, group = 0): string {
    let cache = this.shaders.get(group);
    const cached = cache?.get(source);
    if (cached) return cached;
    const code = source.replace('let linear=direct*', 'let linear=shadowLit(direct,i.position,i.normal)*');
    if (code === source)
      throw new MargoError(
        'unsupported',
        "Shadows require the standard PBR lighting shader; remove the plugin that replaced core's shader",
      );
    const output = shadowSampling(group) + code;
    if (!cache) {
      cache = new Map();
      this.shaders.set(group, cache);
    }
    cache.set(source, output);
    return output;
  }
  /** gltf-pro lighting hooks: the directional term is shadowed. */
  pbr(group: number): { declarations: string; direct(direct: string): string } {
    let hooks = this.hooks.get(group);
    if (!hooks)
      this.hooks.set(
        group,
        (hooks = { declarations: shadowSampling(group), direct: (d) => `shadowLit(${d},i.position,s.n)` }),
      );
    return hooks;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Shadows require WebGPU and a live effect; attach a new Shadows to a WebGPU engine',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.validate();
    const size = this.options.resolution ?? 2048;
    if (size > this.device.limits.maxTextureDimension2D || this.device.limits.maxTextureArrayLayers < 4)
      throw new RangeError('Shadow map exceeds device limit');
    for (const r of this.sources)
      if ('id' in r.source && r.source.engine !== engine)
        throw new MargoError(
          'attached',
          'Shadow mesh belongs to another engine; use objects created by the same engine',
        );
    const texture = () =>
      this.device!.createTexture({
        size: [size, size, 4],
        format: 'depth32float',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
    this.cached = texture();
    this.combined = texture();
    this.views = Array.from({ length: 4 }, (_, baseArrayLayer) =>
      this.combined!.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
    );
    this.cachedViews = Array.from({ length: 4 }, (_, baseArrayLayer) =>
      this.cached!.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
    );
    this.uniform = this.device.createBuffer({ size: 368, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = this.device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.alphaSampler = this.device.createSampler();
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
    this.entries = [
      { binding: 1, resource: { buffer: this.uniform } },
      { binding: 2, resource: this.combined.createView({ dimension: '2d-array' }) },
      { binding: 3, resource: this.sampler },
    ];
    this.dirty = true;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -5,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.render(c);
        c.shader = this.shader(c.shader);
        c.bindings.push(...this.bindings());
      },
    });
  }
  /**
   * Without a `distance` option and with only core-mesh casters, the cascades span the core meshes' bounding box (every
   * receiver is then a core mesh) instead of up to 500 m: the stage's 1 m cube on a 6 m floor gets about 1 cm texels
   * instead of 13 cm. Near and far snap to quarter octaves so orbiting and small dollies keep the cascades still.
   */
  private range(camera: Camera): Camera {
    const fit = this.fitCamera;
    fit.position = camera.position;
    fit.target = camera.target;
    fit.fov = camera.fov;
    fit.near = camera.near;
    fit.far = Math.min(camera.far, this.options.distance ?? 500);
    if (this.options.distance !== undefined || !this.sources.length || !this.sources.every((r) => 'id' in r.source))
      return fit;
    // ponytail: one pass over every core mesh per frame; cache on store revisions if 100k-part scenes leave distance unset.
    // World bounding spheres from core's per-mesh local spheres; their box centre, then the sphere around them all.
    const store = this.engine!.store,
      m = store.matrices,
      s = store.bounds,
      box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
      w = [0, 0, 0, 0];
    const sphere = (id: number) => {
      const o = id * 16,
        b = id * 4;
      for (let k = 0; k < 3; k++)
        w[k] = m[o + k] * s[b] + m[o + 4 + k] * s[b + 1] + m[o + 8 + k] * s[b + 2] + m[o + 12 + k];
      w[3] =
        s[b + 3] *
        Math.sqrt(
          Math.max(
            m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2,
            m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2,
            m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2,
          ),
        );
      return w;
    };
    for (const [id, mesh] of this.engine!.meshes)
      if (mesh.geometry) {
        sphere(id);
        for (let k = 0; k < 3; k++) {
          box[k] = Math.min(box[k], w[k] - w[3]);
          box[k + 3] = Math.max(box[k + 3], w[k] + w[3]);
        }
      }
    const cx = (box[0] + box[3]) / 2,
      cy = (box[1] + box[4]) / 2,
      cz = (box[2] + box[5]) / 2;
    let radius = 0;
    for (const [id, mesh] of this.engine!.meshes)
      if (mesh.geometry) {
        sphere(id);
        radius = Math.max(radius, Math.hypot(w[0] - cx, w[1] - cy, w[2] - cz) + w[3]);
      }
    const d = Math.hypot(cx - camera.position[0], cy - camera.position[1], cz - camera.position[2]);
    const far = 2 ** (Math.ceil(Math.log2(d + radius) * 4) / 4),
      near = d > radius ? 2 ** (Math.floor(Math.log2(d - radius) * 4) / 4) : 0;
    if (far < fit.far && far > camera.near) fit.far = far;
    if (near > fit.near && near < fit.far) fit.near = near;
    return fit;
  }
  private render(c: ShadowPassContext): void {
    this.validate();
    const camera = this.range(c.camera);
    cascadeSplits(camera.near, camera.far, this.options.lambda ?? 0.5, this.splits);
    for (let i = 0; i < 3; i++) this.light[i] = this.engine!.lighting.direction[i];
    fitCascades(
      camera,
      c.width / c.height,
      this.light as unknown as [number, number, number],
      this.options.resolution ?? 2048,
      this.splits,
      this.matrices,
      this.ranges,
      this.options.casterMargin ?? 100,
      this.fitted,
    );
    for (let i = 0; i < 64; i++) if (this.matrices[i] !== this.previous[i]) this.dirty = true;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const r = this.sources[i];
      if (
        ('disposed' in r.source && r.source.disposed) ||
        ('id' in r.source && this.engine!.meshes.get(r.source.id) !== r.source)
      ) {
        this.sources.splice(i, 1);
        r.removeLighting?.();
        this.clearDraws();
        this.dirty = true;
      }
    }
    let dynamic = false;
    for (let i = 0; i < this.sources.length; i++) {
      const r = this.sources[i];
      if (!r.static) dynamic = true;
      else if ('shadowVersion' in r.source && r.version !== r.source.shadowVersion) {
        r.version = r.source.shadowVersion ?? 0;
        this.dirty = true;
      }
    }
    this.values.set(this.matrices);
    viewMatrix(this.view, c.camera);
    this.values.set(this.splits, 80);
    this.values[88] = this.options.lightSize ?? 0.02;
    this.values[89] = this.options.bias ?? 0.0005;
    this.values[90] = this.options.normalBias ?? 0.02;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    this.stats.staticDraws = this.stats.dynamicDraws = 0;
    if (this.dirty) {
      for (let cascade = 0; cascade < 4; cascade++) this.depth(c, cascade, true);
      this.previous.set(this.matrices);
      this.dirty = false;
    } else this.stats.cacheHits++;
    this.copySource.texture = this.cached!;
    this.copyDestination.texture = this.combined!;
    this.copySize.width = this.copySize.height = this.options.resolution ?? 2048;
    c.encoder.copyTextureToTexture(this.copySource, this.copyDestination, this.copySize);
    if (dynamic) for (let cascade = 0; cascade < 4; cascade++) this.depth(c, cascade, false);
  }
  private depth(c: ShadowPassContext, cascade: number, cached: boolean): void {
    this.depthAttachment.view = (cached ? this.cachedViews : this.views)[cascade];
    this.depthAttachment.depthLoadOp = cached ? 'clear' : 'load';
    const pass = c.encoder.beginRenderPass(this.depthPass),
      matrix = this.cascadeMatrices[cascade];
    try {
      for (let i = 0; i < this.sources.length; i++) {
        const r = this.sources[i];
        if (r.static !== cached || ('disposed' in r.source && r.source.disposed)) continue;
        if ('drawShadow' in r.source && r.source.drawShadow) {
          const shadow = this.shadowContexts[cascade];
          shadow.context = c;
          shadow.pass = pass;
          r.source.drawShadow(shadow);
          continue;
        }
        let primitives: readonly ShadowPrimitive[];
        if ('id' in r.source) {
          const node = r.source;
          if (this.engine!.meshes.get(node.id) !== node || !node.geometry) continue;
          const buffers = this.engine!.geometryBuffers(node.geometry);
          if (!buffers) continue;
          if (!r.meshPrimitive)
            r.meshPrimitive = [
              { node, vertex: buffers.vertex, index: buffers.index, count: node.geometry.indices.length, stride: 24 },
            ];
          const primitive = r.meshPrimitive[0];
          primitive.vertex = buffers.vertex;
          primitive.index = buffers.index;
          primitive.count = node.geometry.indices.length;
          primitives = r.meshPrimitive;
        } else primitives = r.source.shadowPrimitives ?? emptyPrimitives;
        for (let i = 0; i < primitives.length; i++) {
          const primitive = primitives[i],
            node = primitive.node;
          node.check();
          if (node.engine !== this.engine)
            throw new MargoError(
              'attached',
              'Shadow source belongs to another engine; use objects created by the same engine',
            );
          let visible = true;
          for (let id = node.id; id !== -1; id = this.engine!.store.parents[id])
            if (this.engine!.store.hidden[id]) visible = false;
          if (!visible) continue;
          this.draw(pass, primitive, matrix, cascade);
          if (cached) this.stats.staticDraws++;
          else this.stats.dynamicDraws++;
        }
      }
    } catch (error) {
      try {
        pass.end();
      } catch {}
      throw error;
    }
    pass.end();
  }
  private draw(pass: GPURenderPassEncoder, p: ShadowPrimitive, matrix: Float32Array, cascade: number): void {
    const inst = p.instances,
      key = p.stride + (inst ? 1 : 0);
    if (inst && !inst.count) return;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      if (![24, 80].includes(p.stride)) throw new RangeError('Unsupported shadow vertex stride');
      if (inst && p.stride !== 80) throw new RangeError('Instanced shadow casters need 80-byte vertices');
      const code = shadowDepth(p.stride === 80),
        module = this.device!.createShaderModule({ code: inst ? instancedDepth(code) : code });
      pipeline = this.device!.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: p.stride,
              attributes:
                p.stride === 80
                  ? [
                      { shaderLocation: 0, offset: 0, format: 'float32x4' },
                      { shaderLocation: 3, offset: 48, format: 'float32x4' },
                      { shaderLocation: 4, offset: 64, format: 'float32x4' },
                    ]
                  : [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
            ...(inst ? [instanceLayout] : []),
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
      this.pipelines.set(key, pipeline);
    }
    // Primitives sharing a node can have different alpha maps and geometry.
    let records = this.draws.get(p.node);
    if (!records) {
      records = new Map();
      this.draws.set(p.node, records);
    }
    let record = records.get(p.index);
    if (
      !record ||
      record.vertex !== p.vertex ||
      record.pipeline !== pipeline ||
      record.alpha !== p.alphaTexture ||
      record.sampler !== p.alphaSampler
    ) {
      if (record) for (const b of record.uniforms) b.destroy();
      records.delete(p.index);
      const uniforms: GPUBuffer[] = [],
        groups: GPUBindGroup[] = [];
      try {
        for (let i = 0; i < 4; i++) {
          const buffer = this.device!.createBuffer({
            size: 144,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          uniforms.push(buffer);
          groups.push(
            this.device!.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer } },
                { binding: 1, resource: p.alphaTexture ?? this.whiteView! },
                { binding: 2, resource: p.alphaSampler ?? this.alphaSampler! },
              ],
            }),
          );
        }
      } catch (error) {
        for (const buffer of uniforms) buffer.destroy();
        throw error;
      }
      record = {
        uniforms,
        groups,
        values: new Float32Array(36),
        vertex: p.vertex,
        index: p.index,
        pipeline,
        alpha: p.alphaTexture,
        sampler: p.alphaSampler,
      };
      records.set(p.index, record);
    }
    record.values.set(matrix);
    record.values.set(p.node.matrix, 16);
    record.values[32] = p.alpha ?? 1;
    record.values[33] = p.cutoff ?? 0;
    record.values[34] = p.texCoord ?? 0;
    this.device!.queue.writeBuffer(record.uniforms[cascade], 0, record.values as Float32Array<ArrayBuffer>);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, record.groups[cascade]);
    pass.setVertexBuffer(0, p.vertex);
    pass.setIndexBuffer(p.index, 'uint32');
    if (inst) {
      pass.setVertexBuffer(1, inst.upload(this.device!));
      pass.drawIndexed(p.count, inst.count);
    } else pass.drawIndexed(p.count);
  }
  private clearDraws(): void {
    for (const records of this.draws.values())
      for (const r of records.values()) for (const b of r.uniforms) b.destroy();
    this.draws.clear();
  }
  private release(): void {
    this.clearDraws();
    for (const texture of [this.cached, this.combined, this.white]) texture?.destroy();
    this.uniform?.destroy();
    this.cached = this.combined = this.white = undefined;
    this.whiteView = undefined;
    this.uniform = undefined;
    this.views = [];
    this.cachedViews = [];
    this.entries = [];
    this.pipelines.clear();
    this.shaders.clear();
    for (const shadow of this.shadowContexts) {
      shadow.context = undefined!;
      shadow.pass = undefined!;
    }
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    for (const r of this.sources) r.removeLighting?.();
    this.sources.length = 0;
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
