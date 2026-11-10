import type { Mesh as MeshHandle } from '@margoengine/core';
import { meshRuntime, type Engine, type Mesh, type PassContext } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import { instancedDepth } from '../../shared/instances.js';
import { displacedDepth } from '../../shared/displacement.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hemisphere, localShadowMatrix, viewportMatrix } from './local-shadow-math.js';
import { hiddenInTree } from '../../shared/visibility.js';
import {
  casterPipeline,
  nodeRecords,
  depthPassDescriptor,
  displacementGroup,
  opacityDepth,
  opacityEntries,
  solidVertexDepth,
  drawCaster,
  staleCaster,
} from '../../shared/caster.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_DST: number;
  COPY_SRC: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/**
 * Integrated local-light shadow maps (`ClusteredOptions.shadows`), fixed at construction; invalid values throw
 * TypeError or RangeError.
 */
export interface LocalShadowOptions {
  /**
   * Size of every shadow layer in texels (default 512), and the largest map a light's `shadow.resolution` may ask for.
   * Each of the `maxLights` slots reserves six `depth32float` layers at this size, whatever its lights ask for:
   * `maxLights × 6 × resolution² × 4` bytes (four slots at 512: 24 MiB; one slot at 2048: 96 MiB).
   */
  resolution?: number;
  /** Lights with a `shadow` that get maps, an integer 1-32 (default 4); `setLights` with more throws RangeError. */
  maxLights?: number;
}
/**
 * A light's shadow settings. The integrated maps (`ClusteredOptions.shadows`) read all of them; `LocalShadows` reads
 * `resolution`, `near` and `far` of a `castShadow` light (its biases are its own options, in texels).
 */
export interface LocalLightShadow {
  /** Shadow-camera near distance (default `min(0.1, far / 100)` integrated, `far / 1000` for `LocalShadows`). */
  near?: number;
  /**
   * Shadow-camera far distance (default the light's `range`; required for an unlimited range, 0). Casters and
   * receivers past it are unshadowed.
   */
  far?: number;
  /** Depth bias of the integrated maps, 0 or more (default 0.0005). */
  bias?: number;
  /** Receiver offset along its normal for the integrated maps, world units, 0 or more (default 0.02). */
  normalBias?: number;
  /**
   * This light's map size in texels: one integer (square) or `[width, height]`, each from 16 up to the `resolution`
   * of the maps that shadow it (`ClusteredOptions.shadows`, or `LocalShadows` for a castShadow light), the default. A
   * point light (or a pi/2 spot) renders all six cube faces at this size (width along each face's own x), a spot its
   * cone. A smaller map renders into
   * the top-left corner of its layers, so it costs that light's detail, not memory; it keeps two texels per side as
   * a guard band for the 3x3 filter.
   */
  resolution?: number | readonly [number, number];
  /**
   * `LocalShadows` only (a `castShadow` point or spot light): the light's radius in world units, 0 or more (default 0,
   * the 3x3 filter). Above 0 the shadow is PCSS: the penumbra widens with the receiver's distance behind its blocker,
   * `radius * (receiver - blocker) / blocker` (depths from the light), up to the map's guard band. Such a light's map
   * covers its cone plus a 0.1 UV guard band, as an area light's faces.
   */
  radius?: number;
}
/**
 * A caster primitive of a `LocalShadowSource` (gltf-pro and materials `shadowPrimitives`): vertex and index buffers of
 * a mesh node, with an optional alpha mask, instances and displacement.
 */
export interface LocalShadowPrimitive {
  /** Identity of the primitive's cached draw (default: its index buffer). */
  primitive?: object;
  /** The core mesh whose world matrix, visibility and engine the caster follows. */
  node: Mesh;
  /** Vertex buffer, position first in each vertex. */
  vertex: GPUBuffer;
  /** Byte offset of the caster's first vertex in `vertex` (a deformer's shared buffer). Default 0. */
  vertexOffset?: number;
  /** Index buffer (uint32). */
  index: GPUBuffer;
  /** Index count. */
  count: number;
  /** Vertex stride in bytes: 24 (core) or 80 (PBR vertices, with UVs; needed for instances, displacement and `alphaTransform`). */
  stride: number;
  /** Index topology; omitted for triangle casters. Wireframe casters supply triangle-edge line indices. */
  topology?: 'triangle-list' | 'line-list';
  alphaTexture?: GPUTextureView;
  alphaSampler?: GPUSampler;
  alpha?: number;
  cutoff?: number;
  texCoord?: number;
  alphaTransform?: Float32Array;
  instances?: { readonly count: number; upload(device: GPUDevice): GPUBuffer };
  /** Vertex displacement along the normal (materials `displacementMap`, 80-byte vertices), bound at group 1. */
  displacement?: import('../../shared/caster.js').CasterDisplacement;
  /**
   * Opacity map of the cut-out (materials `alphaMap`, 80-byte vertices): its green channel, through UV rows 0 and 1 of
   * `buffer` (the materials feature uniform), multiplies the alpha `cutoff` tests. Requires 80-byte vertices.
   */
  opacity?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
  /** False keeps vertex alpha out of the cut-out, as the colour pass does (materials `vertexColors: false`). Default true. */
  vertexAlpha?: boolean;
}
/**
 * A caster `Clustered.addShadowCaster` takes besides a core mesh: an object with `shadowPrimitives` (gltf-pro models,
 * materials meshes). A source with only a custom `drawShadow` is rejected with TypeError.
 */
export interface LocalShadowSource {
  /** Casters drawn into each shadowed light's maps. */
  shadowPrimitives?: readonly LocalShadowPrimitive[];
  /** True once disposed; such a source is rejected, or dropped once added. */
  disposed?: boolean;
  /** Another shadow system's draw hook; not supported here. */
  drawShadow?: unknown;
}
interface ShadowLight {
  position: ArrayLike<number>;
  range: number;
  direction?: ArrayLike<number>;
  outerAngle?: number;
  shadow?: boolean | LocalLightShadow;
}
interface Source {
  source: Mesh | LocalShadowSource;
  primitive?: LocalShadowPrimitive[];
}
interface DrawFace {
  uniform: GPUBuffer;
  group: GPUBindGroup;
}
interface Draw {
  faces: Map<number, DrawFace>;
  values: Float32Array;
  vertex: GPUBuffer;
  pipeline: GPURenderPipeline;
  alpha?: GPUTextureView;
  sampler?: GPUSampler;
  epoch: number;
  displacement?: LocalShadowPrimitive['displacement'];
  opacity?: LocalShadowPrimitive['opacity'];
  displaced?: GPUBindGroup;
}
const emptyPrimitives: readonly LocalShadowPrimitive[] = [];
const directions: readonly (readonly number[])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const ups: readonly (readonly number[])[] = [
  [0, -1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, -1, 0],
  [0, -1, 0],
];
const upY = [0, 1, 0],
  upZ = [0, 0, 1];
/** Optional clustered-light depth maps; the owning Clustered effect controls its passes. */
export class LocalShadowMaps {
  readonly resolution: number;
  readonly maxLights: number;
  readonly stats = { passes: 0, draws: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private depth?: GPUTexture;
  private white?: GPUTexture;
  private whiteView?: GPUTextureView;
  private uniform?: GPUBuffer;
  private alphaSampler?: GPUSampler;
  private views: GPUTextureView[] = [];
  private entries: GPUBindGroupEntry[] = [];
  private pipelines = new Map<string, GPURenderPipeline>();
  private draws = new Map<Mesh, Map<object, Draw>>();
  private sources: Source[] = [];
  private readonly values: Float32Array;
  private indices: number[] = [];
  private activeLayers: number[] = [];
  /** Depth-pass matrices per layer; `values` holds the sampling ones (the same unless the light's map is smaller). */
  private readonly cameras: Float32Array;
  private matrices: Float32Array[] = [];
  /** Per layer: viewport width and height of a smaller light's map, 0 for the whole layer. */
  private viewports = new Uint32Array(0);
  private dirty = true;
  private disposed = false;
  private epoch = 0;
  private readonly depthPass = depthPassDescriptor();
  private readonly depthAttachment = this.depthPass.depthStencilAttachment;
  constructor(options: LocalShadowOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new TypeError('Invalid local shadow options; pass an options object such as {maxLights: 8}');
    this.resolution = options.resolution ?? 512;
    this.maxLights = options.maxLights ?? 4;
    if (
      !Number.isInteger(this.resolution) ||
      this.resolution < 16 ||
      !Number.isInteger(this.maxLights) ||
      this.maxLights < 1 ||
      this.maxLights > 32
    )
      throw new RangeError(
        'Invalid local shadow options; set maxLights to an integer from 1 to 32 and resolution to a valid size',
      );
    this.values = new Float32Array(this.maxLights * 6 * 20);
    this.cameras = new Float32Array(this.maxLights * 6 * 16);
    this.matrices = Array.from({ length: this.maxLights * 6 }, (_, i) => this.cameras.subarray(i * 16, i * 16 + 16));
  }
  /** Validate and stage the entire replacement before changing any live light state. */
  configure(lights: readonly ShadowLight[]): void {
    if (this.disposed || !Array.isArray(lights) || lights.length > 1024)
      throw new RangeError('Expected at most 1,024 lights');
    const values = new Float32Array(this.values.length),
      cameras = new Float32Array(this.cameras.length),
      viewports = new Uint32Array(this.maxLights * 12),
      indices: number[] = [],
      layers: number[] = [];
    let slot = 0;
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i];
      if (!light || typeof light !== 'object')
        throw new TypeError('Invalid shadow light; pass light objects (or null) in the lights array');
      const option = light.shadow;
      if (option === undefined || option === false) {
        indices.push(0);
        continue;
      }
      if (option !== true && (!option || typeof option !== 'object' || Array.isArray(option)))
        throw new TypeError('Invalid local light shadow; set castShadow to true or to an options object');
      if (slot === this.maxLights) throw new RangeError(`At most ${this.maxLights} lights may cast local shadows`);
      finiteVector(light.position, 3, 'Shadow light position');
      const settings = option === true ? {} : option;
      if (
        typeof light.range !== 'number' ||
        [settings.near, settings.far, settings.bias, settings.normalBias].some(
          (value) => value !== undefined && typeof value !== 'number',
        )
      )
        throw new TypeError('Local shadow settings must be numbers');
      const far = Math.fround(settings.far ?? light.range);
      // Margo defaults: near min(0.1, far / 100), bias 0.0005, normalBias 0.02.
      const near = Math.fround(settings.near ?? Math.min(0.1, far / 100)),
        bias = Math.fround(settings.bias ?? 0.0005),
        normalBias = Math.fround(settings.normalBias ?? 0.02);
      if (
        !Number.isFinite(far) ||
        far <= 0 ||
        !Number.isFinite(near) ||
        near <= 0 ||
        near >= far ||
        !Number.isFinite(bias) ||
        bias < 0 ||
        !Number.isFinite(normalBias) ||
        normalBias < 0
      )
        throw new RangeError(
          'Invalid local light shadow settings; set bias and normalBias to finite numbers of 0 or more',
        );
      const size = settings.resolution ?? this.resolution,
        pair = Array.isArray(size) && size.length === 2,
        width = typeof size === 'number' ? size : pair ? size[0] : NaN,
        height = typeof size === 'number' ? size : pair ? size[1] : NaN;
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        Math.min(width, height) < 16 ||
        Math.max(width, height) > this.resolution
      )
        throw new RangeError(
          `Invalid local light shadow resolution: give an integer or [width, height] from 16 to ${this.resolution} (LocalShadowOptions.resolution)`,
        );
      const scaled = width !== this.resolution || height !== this.resolution;
      const spot = light.direction !== undefined;
      if (spot) {
        finiteVector(light.direction, 3, 'Shadow spot direction');
        if (
          !Math.hypot(light.direction![0], light.direction![1], light.direction![2]) ||
          typeof light.outerAngle !== 'number' ||
          !Number.isFinite(light.outerAngle) ||
          light.outerAngle <= 0 ||
          light.outerAngle > Math.PI / 2
        )
          throw new RangeError(
            'Invalid shadow spot cone; set outerAngle above 0 and at most PI / 2 on a shadow-casting spot light',
          );
      }
      // One perspective map for a spot cone; a point light or a hemisphere spot gets the six cube faces.
      const cone = spot && !hemisphere(Math.cos(light.outerAngle!));
      for (let face = 0; face < (cone ? 1 : 6); face++) {
        const layer = slot * 6 + face,
          offset = layer * 20,
          direction = cone ? light.direction! : directions[face],
          up = cone
            ? Math.abs(direction[1]) / Math.hypot(direction[0], direction[1], direction[2]) > 0.99
              ? upZ
              : upY
            : ups[face];
        localShadowMatrix(
          cameras,
          layer * 16,
          light.position,
          direction,
          up,
          near,
          far,
          cone ? light.outerAngle! * 2 : Math.PI / 2,
        );
        if (scaled) {
          viewportMatrix(cameras, layer * 16, values, offset, width, height, this.resolution);
          viewports[layer * 2] = width;
          viewports[layer * 2 + 1] = height;
        } else values.set(cameras.subarray(layer * 16, layer * 16 + 16), offset);
        values[offset + 16] = bias;
        values[offset + 17] = normalBias;
        // settings.z: a hemisphere spot picks its cube face like a point light.
        if (spot && !cone) values[offset + 18] = 1;
        layers.push(layer);
      }
      indices.push(++slot);
    }
    this.values.set(values);
    this.cameras.set(cameras);
    this.viewports = viewports;
    this.indices = indices;
    this.activeLayers = layers;
    this.dirty = true;
  }
  shadowIndex(index: number): number {
    return this.indices[index] ?? 0;
  }
  add(source: MeshHandle | LocalShadowSource): () => void {
    if (this.disposed || !source || typeof source !== 'object')
      throw new TypeError(
        'Invalid local shadow source; add a core mesh or a model with shadowPrimitives, and only before dispose()',
      );
    const runtime = 'id' in source ? meshRuntime(source as MeshHandle) : (source as LocalShadowSource);
    this.validateSource(runtime, this.engine);
    if (this.sources.some((record) => record.source === runtime))
      throw new MargoError('attached', 'Duplicate local shadow source; add each caster once');
    const record: Source = { source: runtime };
    this.sources.push(record);
    return () => {
      const index = this.sources.indexOf(record);
      if (index >= 0) {
        this.sources.splice(index, 1);
        this.clearDraws();
      }
    };
  }
  private validateSource(source: Mesh | LocalShadowSource, engine?: Engine): void {
    if ('disposed' in source && source.disposed)
      throw new MargoError('disposed', 'Local shadow source is disposed; add a live mesh');
    if ('id' in source) {
      source.check();
      if (engine && source.engine !== engine)
        throw new MargoError(
          'attached',
          'Local shadow mesh belongs to another engine; use objects created by the same engine',
        );
      return;
    }
    if (!Array.isArray(source.shadowPrimitives))
      throw new TypeError('Local shadows require shadowPrimitives; custom drawShadow sources are unsupported');
    for (const primitive of source.shadowPrimitives) {
      if (!primitive?.node || typeof primitive.node.check !== 'function')
        throw new TypeError(
          'Invalid local shadow primitive; give every shadowPrimitives entry a shader node with check()',
        );
      primitive.node.check();
      if (engine && primitive.node.engine !== engine)
        throw new MargoError(
          'attached',
          'Local shadow source belongs to another engine; use objects created by the same engine',
        );
    }
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu || this.device)
      throw new MargoError(
        this.disposed ? 'disposed' : this.device ? 'attached' : 'unsupported',
        'Local shadows require WebGPU and a live effect; attach a new Clustered to a WebGPU engine',
      );
    const device = engine.gpu,
      size = this.resolution,
      layers = this.maxLights * 6,
      bytes = this.values.byteLength;
    if (
      size > device.limits.maxTextureDimension2D ||
      layers > device.limits.maxTextureArrayLayers ||
      bytes > device.limits.maxStorageBufferBindingSize ||
      bytes > device.limits.maxBufferSize
    )
      throw new RangeError('Local shadow maps exceed device limits; lower resolution or maxLights');
    for (const record of this.sources) this.validateSource(record.source, engine);
    let depth: GPUTexture | undefined, white: GPUTexture | undefined, uniform: GPUBuffer | undefined;
    try {
      depth = device.createTexture({
        label: 'clustered local shadow maps',
        size: [size, size, layers],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const views = Array.from({ length: layers }, (_, baseArrayLayer) =>
        depth!.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
      );
      uniform = device.createBuffer({
        label: 'clustered local shadow matrices',
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const sampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' }),
        alphaSampler = device.createSampler();
      white = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
      const whiteView = white.createView(),
        entries: GPUBindGroupEntry[] = [
          { binding: 28, resource: { buffer: uniform } },
          { binding: 29, resource: depth.createView({ dimension: '2d-array' }) },
          { binding: 30, resource: sampler },
        ];
      this.depth = depth;
      this.white = white;
      this.whiteView = whiteView;
      this.uniform = uniform;
      this.alphaSampler = alphaSampler;
      this.views = views;
      this.entries = entries;
      this.engine = engine;
      this.device = device;
      this.dirty = true;
    } catch (error) {
      depth?.destroy();
      white?.destroy();
      uniform?.destroy();
      throw error;
    }
  }
  bindings(): GPUBindGroupEntry[] {
    if (!this.device || this.disposed)
      throw new MargoError('state', 'Local shadows are not attached; attach the Clustered effect first');
    return this.entries;
  }
  render(context: Context): void {
    if (!this.device || this.disposed)
      throw new MargoError('state', 'Local shadows are not attached; attach the Clustered effect first');
    this.stats.passes = this.stats.draws = 0;
    this.epoch++;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const source = this.sources[i].source;
      if (
        ('disposed' in source && source.disposed) ||
        ('id' in source && this.engine!.meshes.get(source.id) !== source)
      )
        this.sources.splice(i, 1);
    }
    if (this.dirty) {
      context.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
      this.dirty = false;
    }
    try {
      for (const layer of this.activeLayers) {
        this.depthAttachment.view = this.views[layer];
        const pass = context.encoder.beginRenderPass(this.depthPass),
          width = this.viewports[layer * 2];
        // The clear covers the whole layer; outside a smaller map it reads as unoccluded.
        if (width) pass.setViewport(0, 0, width, this.viewports[layer * 2 + 1], 0, 1);
        this.stats.passes++;
        const submitted = new Map<Mesh, Set<object>>();
        try {
          for (const record of this.sources) {
            const source = record.source;
            let primitives: readonly LocalShadowPrimitive[];
            if ('id' in source) {
              const triangles = meshTriangles(source);
              if (!triangles) continue;
              if (triangles.kind === 'pbr') primitives = triangles.source.shadowPrimitives;
              else {
                const geometry = triangles.geometry,
                  buffers = this.engine!.geometryBuffers(geometry);
                if (!buffers) continue;
                if (!record.primitive)
                  record.primitive = [
                    {
                      node: source,
                      vertex: buffers.vertex,
                      index: buffers.index,
                      count: geometry.indices.length,
                      stride: 24,
                    },
                  ];
                const primitive = record.primitive[0];
                primitive.vertex = buffers.vertex;
                primitive.index = buffers.index;
                primitive.count = geometry.indices.length;
                primitives = record.primitive;
              }
            } else primitives = source.shadowPrimitives ?? emptyPrimitives;
            for (const primitive of primitives) {
              const node = primitive.node;
              if (this.engine!.meshes.get(node.id) !== node) continue;
              node.check();
              if (node.engine !== this.engine)
                throw new MargoError(
                  'attached',
                  'Local shadow source belongs to another engine; use objects created by the same engine',
                );
              if (hiddenInTree(this.engine!.store, node.id)) continue;
              const key = primitive.primitive ?? primitive.index;
              let indices = submitted.get(node);
              if (indices?.has(key)) continue;
              if (!indices) {
                indices = new Set();
                submitted.set(node, indices);
              }
              indices.add(key);
              this.draw(pass, primitive, layer);
              this.stats.draws++;
            }
          }
        } finally {
          pass.end();
        }
      }
    } finally {
      this.sweepDraws();
    }
  }
  private draw(pass: GPURenderPassEncoder, primitive: LocalShadowPrimitive, layer: number): void {
    const p = primitive,
      transform = p.alphaTransform,
      inst = p.instances;
    if (inst && !inst.count) return;
    if (inst && p.stride !== 80) throw new RangeError('Instanced local shadow casters need PBR vertices');
    if (p.stride !== 24 && p.stride !== 80)
      throw new RangeError('Unsupported local shadow vertex stride; use core (24-byte) or PBR (80-byte) vertices');
    const displacement = p.displacement;
    if (displacement && p.stride !== 80) throw new RangeError('Displaced local shadow casters need PBR vertices');
    const opacity = p.opacity;
    if (opacity && p.stride !== 80) throw new RangeError('Opacity-mapped local shadow casters need PBR vertices');
    if (
      transform !== undefined &&
      (!(transform instanceof Float32Array) ||
        transform.length !== 8 ||
        transform.some((value) => !Number.isFinite(value)) ||
        p.stride !== 80)
    )
      throw new TypeError('Local shadow alpha transform requires finite affine rows and PBR vertices');
    if (
      !Number.isInteger(p.count) ||
      p.count < 0 ||
      (p.texCoord !== undefined && p.texCoord !== 0 && p.texCoord !== 1) ||
      !Number.isFinite(Math.fround(p.alpha ?? 1)) ||
      !Number.isFinite(Math.fround(p.cutoff ?? 0))
    )
      throw new RangeError(
        'Invalid local shadow primitive; set texCoord to 0 or 1 and alpha and cutoff to finite numbers',
      );
    const lines = p.topology === 'line-list',
      solid = p.stride === 80 && p.vertexAlpha === false,
      key =
        (displacement?.key ?? '') +
        (p.stride +
        (transform ? 1 : 0) +
        (inst ? 2 : 0) +
        (lines ? 4 : 0) +
        (displacement ? 8 : 0) +
        (opacity ? 16 : 0) +
        (solid ? 32 : 0));
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const depth = depthShader(p.stride === 80, !!transform),
        code = displacement ? displacedDepth(depth, 1, displacement) : depth,
        placed = inst
          ? instancedDepth(code).replaceAll(
              'localDepth.model*vec4f(',
              'localDepth.model*mat4x4f(i.m0,i.m1,i.m2,i.m3)*vec4f(',
            )
          : code,
        cut = solid ? solidVertexDepth(placed) : placed,
        module = this.device!.createShaderModule({ code: opacity ? opacityDepth(cut, 0) : cut });
      pipeline = casterPipeline(this.device!, module, p.stride, !!displacement, !!inst, lines);
      this.pipelines.set(key, pipeline);
    }
    const identity = p.primitive ?? p.index,
      records = nodeRecords(this.draws, p.node);
    let record = records.get(identity);
    if (staleCaster(record, p, pipeline, displacement)) {
      if (record) this.destroyDraw(record);
      records.delete(identity);
      record = {
        faces: new Map(),
        values: new Float32Array(transform ? 44 : 36),
        vertex: p.vertex,
        pipeline,
        alpha: p.alphaTexture,
        sampler: p.alphaSampler,
        epoch: this.epoch,
        displacement,
        opacity,
        displaced: displacementGroup(this.device!, () => pipeline.getBindGroupLayout(1), displacement),
      };
      records.set(identity, record);
    }
    let face = record.faces.get(layer);
    if (!face) {
      const uniform = this.device!.createBuffer({
        size: record.values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      try {
        face = {
          uniform,
          group: this.device!.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: p.alphaTexture ?? this.whiteView! },
              { binding: 2, resource: p.alphaSampler ?? this.alphaSampler! },
              ...(opacity ? opacityEntries(opacity) : []),
            ],
          }),
        };
        record.faces.set(layer, face);
      } catch (error) {
        uniform.destroy();
        throw error;
      }
    }
    record.epoch = this.epoch;
    drawCaster(
      pass,
      this.device!,
      pipeline,
      face.group,
      face.uniform,
      record.values as Float32Array<ArrayBuffer>,
      this.matrices[layer],
      p,
      transform,
      record.displaced,
      inst,
    );
  }
  private destroyDraw(record: Draw): void {
    for (const face of record.faces.values()) face.uniform.destroy();
  }
  private clearDraws(): void {
    for (const records of this.draws.values()) for (const record of records.values()) this.destroyDraw(record);
    this.draws.clear();
  }
  private sweepDraws(): void {
    for (const [node, records] of this.draws) {
      for (const [index, record] of records) {
        if (record.epoch !== this.epoch) {
          this.destroyDraw(record);
          records.delete(index);
        } else
          for (const [layer, face] of record.faces)
            if (!this.activeLayers.includes(layer)) {
              face.uniform.destroy();
              record.faces.delete(layer);
            }
      }
      if (!records.size) this.draws.delete(node);
    }
  }
  release(): void {
    this.clearDraws();
    this.depth?.destroy();
    this.white?.destroy();
    this.uniform?.destroy();
    this.depth = this.white = undefined;
    this.whiteView = undefined;
    this.uniform = undefined;
    this.alphaSampler = undefined;
    this.entries = [];
    this.views = [];
    this.pipelines.clear();
    this.device = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.sources.length = 0;
    this.engine = undefined;
  }
}

// Kept in this optional package so local shadows never add a dependency to core or stage.
function depthShader(pbr: boolean, transformed: boolean): string {
  return /* wgsl */ `
struct LocalDepthFrame {camera:mat4x4f,model:mat4x4f,alpha:vec4f${transformed ? ',alphaUV0:vec4f,alphaUV1:vec4f' : ''}}
@group(0) @binding(0) var<uniform> localDepth:LocalDepthFrame;
@group(0) @binding(1) var localAlphaMap:texture_2d<f32>;
@group(0) @binding(2) var localAlphaSampler:sampler;
struct LocalDepthIn {@location(0) position:${pbr ? 'vec4f' : 'vec3f'},${pbr ? '@location(3) uv:vec4f,@location(4) color:vec4f' : ''}}
struct LocalDepthOut {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:LocalDepthIn)->LocalDepthOut {var o:LocalDepthOut;o.clip=localDepth.camera*localDepth.model*vec4f(i.position.xyz,1);${pbr ? 'o.uv=select(i.uv.xy,i.uv.zw,localDepth.alpha.z>0.5);o.alpha=i.color.a;' : 'o.uv=vec2f(0);o.alpha=1;'}${transformed ? 'let sourceUV=o.uv;o.uv=vec2f(dot(localDepth.alphaUV0.xy,sourceUV)+localDepth.alphaUV0.z,dot(localDepth.alphaUV1.xy,sourceUV)+localDepth.alphaUV1.z);' : ''}return o;}
@fragment fn fragment(i:LocalDepthOut){if(textureSampleLevel(localAlphaMap,localAlphaSampler,i.uv,0).a*localDepth.alpha.x*i.alpha<localDepth.alpha.y){discard;}}
`;
}
