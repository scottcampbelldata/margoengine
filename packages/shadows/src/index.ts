/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Mesh,
  type Camera,
  type Vec3,
} from '@margoengine/core/extension';
import { preset } from '../../shared/preset.js';
import { instanceLayout, instancedDepth } from '../../shared/instances.js';
import { shadowPrimitivesInto } from '../../shared/shadow-source.js';
import { viewMatrix } from '../../shared/view.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { cascadeSplits, fitCascades } from './cascades.js';
import { shadowSampling, shadowDepth } from './shader.js';
export { cascadeSplits, fitCascades } from './cascades.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export interface ShadowOptions {
  resolution?: number;
  distance?: number;
  lambda?: number;
  lightSize?: number;
  bias?: number;
  normalBias?: number;
  casterMargin?: number;
  /** Fixed world-space caster and receiver bounds, rendered in one camera-independent map. */
  bounds?: { min: Vec3; max: Vec3; points?: readonly Vec3[] };
}
export interface ShadowContext {
  context: Context;
  pass: GPURenderPassEncoder;
  matrix: Float32Array;
  cascade: number;
}
export interface ShadowPrimitive {
  primitive?: object;
  node: Mesh;
  vertex: GPUBuffer;
  index: GPUBuffer;
  count: number;
  stride: number;
  alphaTexture?: GPUTextureView;
  alphaSampler?: GPUSampler;
  alpha?: number;
  cutoff?: number;
  texCoord?: number /** Two packed vec4 affine rows applied after UV selection. */;
  alphaTransform?: Float32Array;
  instances?: { readonly count: number; upload(device: GPUDevice): GPUBuffer };
}
export interface ShadowSource {
  shadowPrimitives?: readonly ShadowPrimitive[];
  shadowVersion?: number;
  drawShadow?(context: ShadowContext): void;
  addLighting?(effect: Shadows): () => void;
  disposed?: boolean;
}
interface Source {
  source: ShadowSource | Mesh;
  static: boolean;
  version: number;
  removeLighting?: () => void;
  meshPrimitive?: ShadowPrimitive[];
  primitiveBuffers?: ShadowPrimitive[][];
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
  private draws = new Map<Mesh, Map<object, Draw>>();
  private sources: Source[] = [];
  private primitiveDepth = 0;
  private readonly frames: {
    primitives: Map<Source, readonly ShadowPrimitive[]>;
    owners: Map<Mesh, Map<object, boolean>>;
    submitted: Map<Mesh, Set<object>>;
  }[] = [];
  private readonly cascadeCount: 1 | 4;
  private readonly fitCamera = {
    position: [0, 0, 0],
    target: [0, 0, 0],
    fov: 60,
    near: 0.1,
    far: 500,
  } as unknown as Camera;
  private readonly hooks = new Map<number, { declarations: string; direct(direct: string): string }>();
  private readonly lightingOwners = new Map<ShadowSource, { remove: () => void; count: number }>();
  private readonly values = new Float32Array(92);
  private readonly ranges = this.values.subarray(84, 88);
  private readonly previous = new Float32Array(64);
  private readonly view = this.values.subarray(64, 80);
  private dirty = true;
  private disposed = false;
  private whiteView?: GPUTextureView;
  private readonly light = new Float32Array(3);
  private readonly fitted = { matrices: this.matrices, ranges: this.ranges };
  private readonly cascadeMatrices = Array.from({ length: 4 }, (_, i) => this.matrices.subarray(i * 16, i * 16 + 16));
  private readonly shadowContexts = this.cascadeMatrices.map(
    (matrix, cascade) => ({ context: undefined!, pass: undefined!, matrix, cascade }) as ShadowContext,
  );
  private readonly shaders = new Map<number, Map<string, string>>();
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
    this.cascadeCount = this.options.bounds ? 1 : 4;
    this.copySize.depthOrArrayLayers = this.cascadeCount;
    this.validate();
  }
  get depthTexture(): GPUTexture | undefined {
    return this.combined;
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
      o.bounds !== undefined &&
      (!o.bounds ||
        !Array.isArray(o.bounds.min) ||
        !Array.isArray(o.bounds.max) ||
        o.bounds.min.length !== 3 ||
        o.bounds.max.length !== 3 ||
        !o.bounds.min.every(Number.isFinite) ||
        !o.bounds.max.every(Number.isFinite) ||
        o.bounds.min.some((value, axis) => value >= o.bounds!.max[axis]))
    )
      throw new RangeError('Invalid shadow bounds: finite world-space min < max required');
    const points = o.bounds?.points;
    let validPoints = true;
    if (points !== undefined) {
      validPoints = Array.isArray(points) && points.length >= 4;
      if (validPoints)
        for (let i = 0; i < points.length && validPoints; i++) {
          const point = points[i];
          validPoints = Array.isArray(point) && point.length === 3;
          if (validPoints)
            for (let axis = 0; axis < 3; axis++) {
              const value = point[axis];
              if (!Number.isFinite(value) || value < o.bounds!.min[axis] || value > o.bounds!.max[axis]) {
                validPoints = false;
                break;
              }
            }
        }
    }
    if (!validPoints)
      throw new RangeError('Invalid shadow bounds points: at least four finite Vec3 points inside min/max required');
    if ((o.bounds ? 1 : 4) !== this.cascadeCount)
      throw new RangeError('Shadow bounds mode cannot change after construction');
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
    if ('disposed' in source && source.disposed) throw new Error('Shadow source is disposed');
    const runtime = 'id' in source ? meshRuntime(source as MeshHandle) : (source as ShadowSource);
    if ('id' in runtime) {
      runtime.check();
      if (this.engine && runtime.engine !== this.engine) throw new Error('Shadow mesh belongs to another engine');
    } else if (!('shadowPrimitives' in runtime) && typeof runtime.drawShadow !== 'function')
      throw new TypeError('Invalid shadow source');
    if (
      this.engine &&
      'shadowPrimitives' in runtime &&
      runtime.shadowPrimitives?.some((p) => p.node.engine !== this.engine)
    )
      throw new Error('Shadow source belongs to another engine');
    if (this.sources.some((r) => r.source === runtime)) throw new Error('Duplicate shadow source');
    const triangles = 'id' in runtime ? meshTriangles(runtime) : undefined,
      lightingSource = triangles?.kind === 'pbr' ? (triangles.source.model as ShadowSource) : (runtime as ShadowSource);
    let removeLighting: (() => void) | undefined;
    if (typeof lightingSource.addLighting === 'function') {
      let owner = this.lightingOwners.get(lightingSource);
      if (owner) owner.count++;
      else {
        owner = { remove: lightingSource.addLighting(this), count: 1 };
        this.lightingOwners.set(lightingSource, owner);
      }
      removeLighting = () => {
        if (--owner!.count === 0) {
          this.lightingOwners.delete(lightingSource);
          owner!.remove();
        }
      };
    }
    const r: Source = { source: runtime, static: cached, version: -1, removeLighting };
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
    if (!this.uniform || this.disposed) throw new Error('Shadows are not attached');
    return this.entries;
  }
  shader(source: string, group = 0): string {
    let cache = this.shaders.get(group);
    const cached = cache?.get(source);
    if (cached) return cached;
    let code = source.replace('let linear=direct*', 'let linear=shadowLit(direct,i.position,i.normal)*');
    if (code === source) code = source.replace('direct+ambient(s)', 'shadowLit(direct,i.position,s.n)+ambient(s)');
    if (code === source) throw new Error('Shadows require the standard PBR lighting shader');
    const output = shadowSampling(group) + code;
    if (!cache) {
      cache = new Map();
      this.shaders.set(group, cache);
    }
    cache.set(source, output);
    return output;
  }
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
    if (this.disposed || !engine.gpu) throw new Error('Shadows require WebGPU and a live effect');
    this.engine = engine;
    this.device = engine.gpu;
    this.validate();
    const size = this.options.resolution ?? 2048;
    if (size > this.device.limits.maxTextureDimension2D || this.device.limits.maxTextureArrayLayers < this.cascadeCount)
      throw new RangeError('Shadow map exceeds device limit');
    for (const r of this.sources)
      if ('id' in r.source && r.source.engine !== engine) throw new Error('Shadow mesh belongs to another engine');
    const texture = () =>
      this.device!.createTexture({
        size: [size, size, this.cascadeCount],
        format: 'depth32float',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
    this.cached = texture();
    this.combined = texture();
    this.views = Array.from({ length: this.cascadeCount }, (_, baseArrayLayer) =>
      this.combined!.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
    );
    this.cachedViews = Array.from({ length: this.cascadeCount }, (_, baseArrayLayer) =>
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
  private range(camera: Camera): Camera {
    const fit = this.fitCamera;
    fit.position = camera.position;
    fit.target = camera.target;
    fit.fov = camera.fov;
    fit.near = camera.near;
    fit.far = Math.min(camera.far, this.options.distance ?? 500);
    if (
      this.options.distance !== undefined ||
      !this.sources.length ||
      !this.sources.every((r) => 'id' in r.source && meshTriangles(r.source)?.kind === 'core')
    )
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
  private render(c: Context): void {
    this.validate();
    for (let i = 0; i < 3; i++) this.light[i] = this.engine!.lighting.direction[i];
    if (this.options.bounds) {
      this.fitBounds();
      // All visible receivers select layer zero, including when the camera orbits outside the fixed box.
      this.splits.fill(c.camera.far);
    } else {
      const camera = this.range(c.camera);
      cascadeSplits(camera.near, camera.far, this.options.lambda ?? 0.5, this.splits);
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
    }
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
      for (let cascade = 0; cascade < this.cascadeCount; cascade++) this.depth(c, cascade, true);
      this.previous.set(this.matrices);
      this.dirty = false;
    } else this.stats.cacheHits++;
    this.copySource.texture = this.cached!;
    this.copyDestination.texture = this.combined!;
    this.copySize.width = this.copySize.height = this.options.resolution ?? 2048;
    c.encoder.copyTextureToTexture(this.copySource, this.copyDestination, this.copySize);
    if (dynamic) for (let cascade = 0; cascade < this.cascadeCount; cascade++) this.depth(c, cascade, false);
  }
  private fitBounds(): void {
    const { min, max, points } = this.options.bounds!,
      length = Math.hypot(this.light[0], this.light[1], this.light[2]);
    if (!length) throw new RangeError('Zero shadow direction');
    const zx = -this.light[0] / length,
      zy = -this.light[1] / length,
      zz = -this.light[2] / length,
      vertical = Math.abs(zy) > 0.99;
    let xx = vertical ? -zy : zz,
      xy = vertical ? zx : 0,
      xz = vertical ? 0 : -zx;
    const xl = Math.hypot(xx, xy, xz);
    xx /= xl;
    xy /= xl;
    xz /= xl;
    const yx = zy * xz - zz * xy,
      yy = zz * xx - zx * xz,
      yz = zx * xy - zy * xx;
    let centerX: number, centerY: number, centerZ: number, halfX: number, halfY: number, halfZ: number;
    if (points) {
      let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const x = p[0] * xx + p[1] * xy + p[2] * xz,
          y = p[0] * yx + p[1] * yy + p[2] * yz,
          z = p[0] * zx + p[1] * zy + p[2] * zz;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      centerX = (minX + maxX) * 0.5;
      centerY = (minY + maxY) * 0.5;
      centerZ = (minZ + maxZ) * 0.5;
      halfX = (maxX - minX) * 0.5;
      halfY = (maxY - minY) * 0.5;
      halfZ = (maxZ - minZ) * 0.5;
    } else {
      const cx = (min[0] + max[0]) * 0.5,
        cy = (min[1] + max[1]) * 0.5,
        cz = (min[2] + max[2]) * 0.5,
        hx = (max[0] - min[0]) * 0.5,
        hy = (max[1] - min[1]) * 0.5,
        hz = (max[2] - min[2]) * 0.5;
      centerX = cx * xx + cy * xy + cz * xz;
      centerY = cx * yx + cy * yy + cz * yz;
      centerZ = cx * zx + cy * zy + cz * zz;
      halfX = Math.abs(xx) * hx + Math.abs(xy) * hy + Math.abs(xz) * hz;
      halfY = Math.abs(yx) * hx + Math.abs(yy) * hy + Math.abs(yz) * hz;
      halfZ = Math.abs(zx) * hx + Math.abs(zy) * hy + Math.abs(zz) * hz;
    }
    const resolution = this.options.resolution ?? 2048,
      // Projecting the AABB half extents is equivalent to fitting all eight world-space corners.
      // Keep square world texels: the established receiver-plane PCSS filter uses one XY texel scale.
      radius = Math.max(halfX, halfY) * (1 + 2 / resolution),
      rx = radius,
      ry = radius,
      depth = 2 * (halfZ + (this.options.casterMargin ?? 100)),
      tx = (2 * rx) / resolution,
      ty = (2 * ry) / resolution,
      px = Math.round(centerX / tx) * tx,
      py = Math.round(centerY / ty) * ty,
      pz = centerZ,
      m = this.matrices;
    if (!(radius > 0) || !(depth > 0)) throw new RangeError('Shadow bounds points have no light-space extent');
    m.fill(0);
    m[0] = xx / rx;
    m[4] = xy / rx;
    m[8] = xz / rx;
    m[1] = yx / ry;
    m[5] = yy / ry;
    m[9] = yz / ry;
    m[2] = zx / depth;
    m[6] = zy / depth;
    m[10] = zz / depth;
    m[12] = -px / rx;
    m[13] = -py / ry;
    m[14] = 0.5 - pz / depth;
    m[15] = 1;
    this.ranges.fill(depth);
    for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) throw new RangeError('Shadow bounds matrix overflow');
  }
  private depth(c: Context, cascade: number, cached: boolean): void {
    this.depthAttachment.view = (cached ? this.cachedViews : this.views)[cascade];
    this.depthAttachment.depthLoadOp = cached ? 'clear' : 'load';
    const pass = c.encoder.beginRenderPass(this.depthPass),
      matrix = this.cascadeMatrices[cascade];
    const level = this.primitiveDepth++;
    const frame = (this.frames[level] ??= { primitives: new Map(), owners: new Map(), submitted: new Map() });
    const submitted = frame.submitted;
    try {
      frame.primitives.clear();
      frame.owners.clear();
      frame.submitted.clear();
      for (const record of this.sources) {
        const source = record.source;
        if ('drawShadow' in source && source.drawShadow) continue;
        let primitives: readonly ShadowPrimitive[];
        if ('id' in source) {
          const triangles = meshTriangles(source);
          if (!triangles) continue;
          if (triangles.kind === 'pbr') primitives = triangles.source.shadowPrimitives;
          else {
            const geometry = triangles.geometry,
              buffers = this.engine!.geometryBuffers(geometry);
            if (!buffers) continue;
            record.meshPrimitive ??= [
              {
                node: source,
                vertex: buffers.vertex,
                index: buffers.index,
                count: geometry.indices.length,
                stride: 24,
              },
            ];
            Object.assign(record.meshPrimitive[0], buffers, { count: geometry.indices.length });
            primitives = record.meshPrimitive;
          }
        } else {
          const writer = (source as ShadowSource & { [shadowPrimitivesInto]?: (out: ShadowPrimitive[]) => boolean })[
            shadowPrimitivesInto
          ];
          if (writer) {
            const buffers = (record.primitiveBuffers ??= []),
              buffer = (buffers[level] ??= []);
            primitives = writer.call(source, buffer) ? buffer : (source.shadowPrimitives ?? emptyPrimitives);
          } else primitives = source.shadowPrimitives ?? emptyPrimitives;
        }
        frame.primitives.set(record, primitives);
        for (const primitive of primitives) {
          let owners = frame.owners.get(primitive.node);
          if (!owners) {
            owners = new Map();
            frame.owners.set(primitive.node, owners);
          }
          const key = primitive.primitive ?? primitive.index;
          if (owners.get(key) !== false) owners.set(key, record.static);
        }
      }

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
        const primitives = frame.primitives.get(r) ?? emptyPrimitives;
        for (let i = 0; i < primitives.length; i++) {
          const primitive = primitives[i],
            node = primitive.node;
          node.check();
          if (node.engine !== this.engine) throw new Error('Shadow source belongs to another engine');
          let visible = true;
          for (let id = node.id; id !== -1; id = this.engine!.store.parents[id])
            if (this.engine!.store.hidden[id]) visible = false;
          if (!visible) continue;
          const key = primitive.primitive ?? primitive.index;
          if (frame.owners.get(node)?.get(key) !== cached) continue;
          let indices = submitted.get(node);
          if (indices?.has(key)) continue;
          if (!indices) {
            indices = new Set();
            submitted.set(node, indices);
          }
          indices.add(key);
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
    } finally {
      this.primitiveDepth--;
    }
    pass.end();
  }
  private draw(pass: GPURenderPassEncoder, p: ShadowPrimitive, matrix: Float32Array, cascade: number): void {
    if (p.stride !== 24 && p.stride !== 80) throw new RangeError('Unsupported shadow vertex stride');
    const inst = p.instances;
    if (inst && !inst.count) return;
    if (inst && p.stride !== 80) throw new RangeError('Instanced shadow casters need 80-byte vertices');
    const transform = p.alphaTransform;
    if (
      transform !== undefined &&
      (!(transform instanceof Float32Array) ||
        transform.length !== 8 ||
        transform.some((v) => !Number.isFinite(v)) ||
        p.stride !== 80)
    )
      throw new TypeError('Shadow alpha transform requires finite affine rows and PBR vertices');
    const key = p.stride + (transform ? 1 : 0) + (inst ? 2 : 0);
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const code = shadowDepth(p.stride === 80, !!transform);
      const module = this.device!.createShaderModule({ code: inst ? instancedDepth(code) : code });
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
    const identity = p.primitive ?? p.index;
    let records = this.draws.get(p.node);
    if (!records) {
      records = new Map();
      this.draws.set(p.node, records);
    }
    let record = records.get(identity);
    if (
      !record ||
      record.vertex !== p.vertex ||
      record.pipeline !== pipeline ||
      record.alpha !== p.alphaTexture ||
      record.sampler !== p.alphaSampler
    ) {
      if (record) for (const b of record.uniforms) b.destroy();
      records.delete(identity);
      const uniforms: GPUBuffer[] = [],
        groups: GPUBindGroup[] = [];
      try {
        for (let i = 0; i < 4; i++) {
          const buffer = this.device!.createBuffer({
            size: transform ? 176 : 144,
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
        values: new Float32Array(transform ? 44 : 36),
        vertex: p.vertex,
        index: p.index,
        pipeline,
        alpha: p.alphaTexture,
        sampler: p.alphaSampler,
      };
      records.set(identity, record);
    }
    record.values.set(matrix);
    record.values.set(p.node.matrix, 16);
    record.values[32] = p.alpha ?? 1;
    record.values[33] = p.cutoff ?? 0;
    record.values[34] = p.texCoord ?? 0;
    if (transform) record.values.set(transform, 36);
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
    this.frames.length = 0;
    this.lightingOwners.clear();
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  destroy(): void {
    this.dispose();
  }
}
