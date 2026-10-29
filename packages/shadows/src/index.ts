/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  type meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Mesh,
  type Camera,
  type Vec3,
} from '@margoengine/core/extension';
import { preset } from '../../shared/preset.js';
import { instancedDepth } from '../../shared/instances.js';
import { displacedDepth } from '../../shared/displacement.js';
import { shadowPrimitivesInto, coreReceives, unshadowedCore } from '../../shared/shadow-source.js';
import { viewMatrix } from '../../shared/view.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { sectionState, sectionShader } from '../../shared/section.js';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import { cascadeSplits, fitCascades } from './cascades.js';
import { shadowSampling, shadowDepth, nearestDepth, type ShadowFilter } from './shader.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { hypot, hypotOf, hypotTerms } from '../../shared/hypot.js';
import {
  casterBuffers,
  casterPipeline,
  casterRuntime,
  nodeRecords,
  depthPassDescriptor,
  displacementGroup,
  drawCaster,
  staleCaster,
} from '../../shared/caster.js';
export { cascadeSplits, fitCascades } from './cascades.js';
export type { ShadowFilter } from './shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; COPY_SRC: number; STORAGE: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
/** The WebGPU pass context a custom caster's `drawShadow` receives (`ShadowContext.context`). */
type ShadowPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** Directional shadow settings, read every frame from `shadows.options`; invalid values throw RangeError or TypeError. */
export interface ShadowOptions {
  /**
   * Map size in texels (default 2048): one integer of 16 or more for a square map, or `[width, height]`, each a power of
   * two from 16, up to the device's `maxTextureDimension2D`. Memory is two `depth32float` arrays of width × height ×
   * one layer per cascade (2048 square with four cascades: 128 MiB). Cascades and `bounds` cover a square light-space
   * region, so a non-square map gives its axes different texel sizes; a `frustum` spreads the map over its own
   * extents. Live: a new size reallocates the maps next frame (only then).
   */
  resolution?: number | readonly [number, number];
  /**
   * Farthest shadowed distance from the camera, world units, > 0. Default 500; when unset and every caster is a core
   * mesh, the cascades also tighten to the casters' bounds.
   */
  distance?: number;
  /** Cascade split blend, 0 (uniform) to 1 (logarithmic). Default 0.5. */
  lambda?: number;
  /** Light size for the `'soft'` filter's penumbra width, 0 or more. Default 0.02. */
  lightSize?: number;
  /** Constant depth bias, 0 or more. Default 0.0005. */
  bias?: number;
  /** Receiver offset along its normal, world units, 0 or more. Default 0.02. */
  normalBias?: number;
  /** World units each cascade extends towards the light for off-screen casters, 0 or more. Default 100. */
  casterMargin?: number;
  /** Fixed world-space caster and receiver bounds, rendered in one camera-independent map. */
  bounds?: { min: Vec3; max: Vec3; points?: readonly Vec3[] };
  /**
   * An explicit orthographic shadow camera in place of the cascades (`distance`) and `bounds`, as Crocotile's light
   * shadow camera: one camera-independent map. It sits at `position` and looks along the engine's light direction with
   * world +Y up (+Z when the light is within about 8 degrees of vertical); `left`/`right` and `bottom`/`top` are its
   * view extents around `position`, `near`/`far` distances in front of it along the light. Casters and receivers
   * outside that box get no shadow. Give `bounds` or `frustum`, not both; edits take effect next frame. Requires finite
   * `left < right`, `bottom < top` and `near < far` (near may be negative).
   */
  frustum?: { position: Vec3; left: number; right: number; top: number; bottom: number; near: number; far: number };
  /**
   * Edge filter (default `'soft'`). `'soft'` is PCSS: penumbrae widen with blocker distance and `lightSize`, 16
   * blocker reads and 32 comparison taps per lit pixel. `'pcf'` takes four hardware comparison taps (an edge about
   * three texels wide, `lightSize` unused): the light and phone quality tiers use it. `'hard'` takes one. Read when
   * receiver shaders are built.
   */
  filter?: ShadowFilter;
  /**
   * Cascades, 1 to 4 (default 4). Fewer cascades render fewer depth passes per frame and cover `distance` with coarser
   * texels; the phone quality tier uses 2. Ignored with `bounds` or `frustum` (always one map). Fixed at construction.
   */
  cascades?: number;
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
/** One drawable shadow caster (the contract gltf-pro models, materials meshes and terrain expose as `shadowPrimitives`). */
export interface ShadowPrimitive {
  /** Identity of the primitive's cached draw (default: its index buffer). */
  primitive?: object;
  /** The mesh whose world matrix, visibility and engine the caster follows. */
  node: Mesh;
  /** Vertex buffer: 24-byte core or 80-byte PBR vertices. */
  vertex: GPUBuffer;
  /** Byte offset of the caster's first vertex in `vertex` (a deformer's shared buffer). Default 0. */
  vertexOffset?: number;
  /** Uint32 indices. */
  index: GPUBuffer;
  /** Index count. */
  count: number;
  /** Vertex stride in bytes: 24 (core) or 80 (PBR). */
  stride: number;
  /** Index topology; omitted for triangle casters. Wireframe casters supply triangle-edge line indices. */
  topology?: 'triangle-list' | 'line-list';
  /** Base-colour texture for alpha-masked casters. */
  alphaTexture?: GPUTextureView;
  /** Sampler of `alphaTexture`. */
  alphaSampler?: GPUSampler;
  /** Base-colour alpha factor. */
  alpha?: number;
  /** Alpha-mask cutoff, 0..1. Default 0 (nothing masked). */
  cutoff?: number;
  /** UV set of `alphaTexture`, 0 or 1. */
  texCoord?: number /** Two packed vec4 affine rows applied after UV selection. */;
  alphaTransform?: Float32Array;
  instances?: { readonly count: number; upload(device: GPUDevice): GPUBuffer };
  /**
   * Planes that clip this caster (materials `clippingPlanes`): a uniform of up to 6 world planes in the scene
   * `section` binding's layout. A scene's `section` binding takes precedence over it.
   */
  clip?: GPUBufferBinding;
  /** Vertex displacement along the normal (materials `displacementMap`, 80-byte vertices): bound at group 1. */
  displacement?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
  /** Skinned, morphed, instanced, or deformed casters redraw every frame. Unset casters are cached while they stay put. */
  dynamic?: boolean;
}
/**
 * Anything `shadows.add` takes besides a core mesh: a gltf-pro model, materials mesh, `Terrain`, `ScatterInstances`, or
 * a custom caster with `drawShadow`. It needs `shadowPrimitives` or `drawShadow`.
 */
export interface ShadowSource {
  /** Casters drawn by the standard depth pipeline, read every shadow frame. */
  shadowPrimitives?: readonly ShadowPrimitive[];
  /** Bumped by a static source when its casters change, so the cached still map re-renders. */
  shadowVersion?: number;
  /** Custom depth drawing for one cascade. */
  drawShadow?(context: ShadowContext): void;
  /** Lets the source receive shadows (patches its shader); returns the remover. */
  addLighting?(effect: Shadows): () => void;
  /** True once disposed; such a source is rejected, or dropped once added. */
  disposed?: boolean;
}
interface Source {
  source: ShadowSource | Mesh;
  static: boolean;
  /** Draws into the shadow map (`castShadow`). */
  cast: boolean;
  version: number;
  removeLighting?: () => void;
  meshPrimitive?: ShadowPrimitive[];
  primitiveBuffers?: ShadowPrimitive[][];
}
/** One caster primitive in one depth pass: whether every copy of it is still, and whether it was drawn. */
interface CasterState {
  serial: number;
  still?: boolean;
  drawn: boolean;
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
  section?: GPUBuffer;
  displacement?: ShadowPrimitive['displacement'];
  displaced?: GPUBindGroup;
}
/** Core-mesh casters sharing one geometry, drawn as one instanced draw per cascade (see Shadows.batchable). */
interface Batch {
  /** The first `count` are this pass's casters. Never emptied with length = 0: V8 then drops the array's storage and
   * the next push allocates it again, every pass. */
  primitives: ShadowPrimitive[];
  count: number;
  matrices: Float32Array;
  buffer?: GPUBuffer;
  groups: GPUBindGroup[];
  packed: number;
}
// Below this many casters sharing a geometry, each keeps its own draw: the instanced path pays a storage upload and
// its own pipeline, which only pays off for many copies (a field of identical boxes, rocks, parts).
const BATCH_MIN = 8;
// Depth-only, no fragment stage: core casters have no alpha. One world matrix per instance from a storage array.
const batchDepth = /* wgsl */ `@group(0) @binding(0) var<uniform> camera:mat4x4f;
@group(0) @binding(1) var<storage,read> models:array<mat4x4f>;
@vertex fn vertex(@location(0) position:vec3f,@builtin(instance_index) k:u32)->@builtin(position) vec4f {return camera*models[k]*vec4f(position,1);}`;
const emptyPrimitives: readonly ShadowPrimitive[] = [];
/** A shader cache key: filter, bind group and anisotropy as one number (bit 1 is left for the receive patch). */
const shaderKey = (filter: string, group: number, anisotropic: boolean) =>
  group * 16 + (filter === 'soft' ? 0 : filter === 'pcf' ? 4 : 8) + (anisotropic ? 1 : 0);
const powerOfTwo = (v: number) => Number.isInteger(v) && v >= 16 && Number.isInteger(Math.log2(v));
/**
 * Directional shadows from the engine's light: up to four cascades (practical splits, stable texel-snapped
 * extents) in a `depth32float` array, or one camera-independent map for `bounds` or an explicit `frustum`, filtered
 * `'soft'` (PCSS), `'pcf'` or `'hard'`. Casts from core meshes and any {@link ShadowSource}; static casters render
 * into a still map that re-renders only when they change. `Shadows.attach(engine, options)`, then
 * `shadows.add(mesh, {static: true})` per caster. WebGPU only.
 * @throws RangeError when an option is out of range or a map exceeds the device limits; TypeError for an invalid
 * source or conflicting options.
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
  /** Each layer's nearest depth (f32 bits), reduced from the combined map for the PCSS search; copied into `uniform`. */
  private nearestBuffer?: GPUBuffer;
  private nearestPipeline?: GPUComputePipeline;
  private nearestGroup?: GPUBindGroup;
  /** The map changed since the last reduction (while the filter was not `'soft'`, or before the first frame). */
  private nearestStale = true;
  private readonly nearestSeed = new Uint32Array(4).fill(0x3f800000);
  private combinedView?: GPUTextureView;
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
  /** Per nesting level and pass kind (level * 2 + cached): vertex buffer, then index buffer, to its batch. */
  private readonly batches: Map<GPUBuffer, Map<GPUBuffer, Batch>>[] = [];
  private batchPipeline?: GPURenderPipeline;
  private batchCameras: GPUBuffer[] = [];
  private frameSerial = 0;
  private sources: Source[] = [];
  private primitiveDepth = 0;
  /** Per nesting level: the pass's sources and their primitives by index, and its batches waiting to draw. */
  private readonly frames: {
    records: Source[];
    primitives: (readonly ShadowPrimitive[])[];
    /** The first `waiting` batches have casters this pass (kept, not emptied: see Batch.primitives). */
    pending: Batch[];
    waiting: number;
  }[] = [];
  /** Per caster node and primitive key, its state in the latest depth pass (see casterState); dropped with draws. */
  // One map per nesting level: a depth pass started from a draw callback must not restamp the outer pass's states.
  private readonly casterStates: Map<Mesh, Map<object, CasterState>>[] = [];
  private passSerial = 0;
  /** range() scratch: the casters' world box (min xyz, max xyz), a world sphere, and the centre and radius. */
  private readonly rangeBox = new Float64Array(6);
  private readonly sphere = new Float64Array(4);
  private readonly rangeCenter = new Float64Array(4);
  private readonly cascadeCount: number;
  /** Validated map size, and the size the maps were allocated at. */
  private width = 2048;
  private height = 2048;
  private mapWidth = 0;
  private mapHeight = 0;
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
  private clipped = false;
  private stillHash = 0;
  private readonly hashWord = new Uint32Array(1);
  private readonly hashFloat = new Float32Array(this.hashWord.buffer);
  private readonly objectIds = new WeakMap<object, number>();
  private objectSerial = 0;
  private disposed = false;
  private whiteView?: GPUTextureView;
  private readonly light = new Float32Array(3);
  private readonly fitted = { matrices: this.matrices, ranges: this.ranges };
  private readonly cascadeMatrices = Array.from({ length: 4 }, (_, i) => this.matrices.subarray(i * 16, i * 16 + 16));
  private readonly shadowContexts = this.cascadeMatrices.map(
    (matrix, cascade) => ({ context: undefined!, pass: undefined!, matrix, cascade }) as ShadowContext,
  );
  private readonly shaders = new Map<number, Map<string, string>>();
  private readonly depthPass = depthPassDescriptor();
  private readonly depthAttachment = this.depthPass.depthStencilAttachment;
  private readonly copySource: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly copyDestination: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly copySize = { width: 0, height: 0, depthOrArrayLayers: 4 };
  constructor(readonly options: ShadowOptions = {}) {
    this.options = preset('shadows', options);
    this.cascadeCount = this.options.bounds || this.options.frustum ? 1 : (this.options.cascades ?? 4);
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
      throw new RangeError(
        'Invalid shadow bounds; pass finite world-space min and max with min below max on every axis.',
      );
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
    const frustum = o.frustum;
    if (frustum !== undefined) {
      if (o.bounds !== undefined) throw new TypeError('Shadow bounds and frustum are alternatives: give one of them');
      if (!frustum || typeof frustum !== 'object')
        throw new TypeError('Invalid shadow frustum: give {position, left, right, top, bottom, near, far}');
      finiteVector(frustum.position, 3, 'Shadow frustum position');
      const { left, right, top, bottom, near, far } = frustum,
        finite = Number.isFinite;
      if (
        !(finite(left) && finite(right) && finite(top) && finite(bottom) && finite(near) && finite(far)) ||
        left >= right ||
        bottom >= top ||
        near >= far
      )
        throw new RangeError(
          'Invalid shadow frustum; pass finite values with left < right, bottom < top and near < far.',
        );
    }
    const cascades = o.cascades ?? 4;
    if (!Number.isInteger(cascades) || cascades < 1 || cascades > 4)
      throw new RangeError('Invalid shadow cascades: use an integer from 1 to 4');
    if ((o.bounds || frustum ? 1 : cascades) !== this.cascadeCount)
      throw new RangeError(
        'Shadow bounds mode, frustum mode and cascade count cannot change after construction; create a new Shadows instead',
      );
    const filter = o.filter ?? 'soft';
    if (filter !== 'soft' && filter !== 'pcf' && filter !== 'hard')
      throw new RangeError(`Invalid shadow filter '${String(filter)}': use 'soft', 'pcf' or 'hard'`);
    const resolution = o.resolution ?? 2048,
      square = typeof resolution === 'number';
    if (!square && (!Array.isArray(resolution) || resolution.length !== 2 || !resolution.every(powerOfTwo)))
      throw new RangeError(
        'Invalid shadow resolution: give one integer of 16 or more, or [width, height] powers of two from 16',
      );
    const width = square ? resolution : resolution[0],
      height = square ? resolution : resolution[1];
    if (
      !Number.isInteger(width) ||
      width < 16 ||
      !Number.isFinite(o.distance ?? 500) ||
      (o.distance ?? 500) <= 0 ||
      !Number.isFinite(o.lambda ?? 0.5) ||
      (o.lambda ?? 0.5) < 0 ||
      (o.lambda ?? 0.5) > 1
    )
      throw new RangeError(
        'Invalid shadow options; distance must be above 0, lambda between 0 and 1, and the resolution an integer of 16 or more.',
      );
    for (let i = 0; i < 4; i++) {
      const v =
        i === 0
          ? (o.lightSize ?? 0.02)
          : i === 1
            ? (o.bias ?? 0.0005)
            : i === 2
              ? (o.normalBias ?? 0.02)
              : (o.casterMargin ?? 100);
      // Runs every frame: f - f is 0 exactly for a finite f, and Number.isFinite would box each fractional f.
      const f = Math.fround(v);
      if (f - f !== 0 || v < 0)
        throw new RangeError(
          'Invalid shadow options; lightSize, bias, normalBias and casterMargin must be finite and 0 or more.',
        );
    }
    this.width = width;
    this.height = height;
  }
  /** Light-space x and y scale differently: receivers take the per-axis filter (shader.ts `shadowSampling`). */
  private anisotropic(): boolean {
    return !!this.options.frustum || this.width !== this.height;
  }
  /**
   * Adds `source` (a core mesh, gltf-pro model, materials mesh or custom source) as a shadow caster and, for sources
   * with their own lighting (`addLighting`: gltf-pro models, materials meshes, terrain), a receiver. `castShadow: false`
   * keeps it out of the shadow map; `receiveShadow: false` leaves its lighting unshadowed (both default true, as
   * Crocotile's per-object Cast Shadows and Receive Shadows). For a core mesh `receiveShadow: false` sets
   * `mesh.receiveShadow = false` and the remover restores it. `static` caches it in the still map. Returns the remover.
   */
  add(
    source: ShadowSource | MeshHandle,
    {
      static: cached = false,
      castShadow = true,
      receiveShadow = true,
    }: { static?: boolean; castShadow?: boolean; receiveShadow?: boolean } = {},
  ): () => void {
    if (
      this.disposed ||
      !source ||
      typeof cached !== 'boolean' ||
      typeof castShadow !== 'boolean' ||
      typeof receiveShadow !== 'boolean'
    )
      throw new TypeError('Invalid shadow source; pass a live mesh, group or shadow source and boolean options.');
    const runtime = casterRuntime<object, ReturnType<typeof meshRuntime> | ShadowSource>(
      source,
      this.engine,
      'Shadow source',
    );
    if (!('id' in runtime) && !('shadowPrimitives' in runtime) && typeof runtime.drawShadow !== 'function')
      throw new TypeError('Invalid shadow source; pass a mesh, group or object with drawShadow().');
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
    const triangles = 'id' in runtime ? meshTriangles(runtime) : undefined,
      lightingSource = triangles?.kind === 'pbr' ? (triangles.source.model as ShadowSource) : (runtime as ShadowSource);
    let removeLighting: (() => void) | undefined;
    if (!receiveShadow && 'id' in runtime && triangles?.kind !== 'pbr') {
      const previous = runtime.receiveShadow;
      runtime.receiveShadow = false;
      removeLighting = () => {
        runtime.receiveShadow = previous;
      };
    } else if (receiveShadow && typeof lightingSource.addLighting === 'function') {
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
    const r: Source = { source: runtime, static: cached, cast: castShadow, version: -1, removeLighting };
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
    const filter = this.options.filter ?? 'soft',
      receive = unshadowedCore(this.engine, source),
      anisotropic = this.anisotropic(),
      // A number: a string key built from these would be garbage every frame.
      key = shaderKey(filter, group, anisotropic) + (receive ? 2 : 0);
    let cache = this.shaders.get(key);
    const cached = cache?.get(source);
    if (cached) return cached;
    let code = source.replace(
      'let linear=direct*',
      receive
        ? `let linear=select(direct,shadowLit(direct,i.position,i.normal),${coreReceives})*`
        : 'let linear=shadowLit(direct,i.position,i.normal)*',
    );
    if (code === source) code = source.replace('direct+ambient(s)', 'shadowLit(direct,i.position,s.n)+ambient(s)');
    if (code === source)
      throw new MargoError(
        'unsupported',
        "Shadows require the standard PBR lighting shader; remove the plugin that replaced core's shader",
      );
    const output = shadowSampling(group, filter, anisotropic) + code;
    if (!cache) {
      cache = new Map();
      this.shaders.set(key, cache);
    }
    cache.set(source, output);
    return output;
  }
  pbr(group: number): { declarations: string; direct(direct: string): string } {
    const filter = this.options.filter ?? 'soft',
      anisotropic = this.anisotropic(),
      key = shaderKey(filter, group, anisotropic);
    let hooks = this.hooks.get(key);
    if (!hooks)
      this.hooks.set(
        key,
        (hooks = {
          declarations: shadowSampling(group, filter, anisotropic),
          direct: (d) => `shadowLit(${d},i.position,s.n)`,
        }),
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
    this.checkLimits();
    for (const r of this.sources)
      if ('id' in r.source && r.source.engine !== engine)
        throw new MargoError(
          'attached',
          'Shadow mesh belongs to another engine; use objects created by the same engine',
        );
    this.textures();
    // 368 bytes written each frame from `values`, then 16 for `nearest`, which the GPU reduction copies in.
    this.uniform = this.device.createBuffer({ size: 384, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.nearestBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
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
    this.bind();
  }
  private checkLimits(): void {
    const limits = this.device!.limits;
    if (
      this.width > limits.maxTextureDimension2D ||
      this.height > limits.maxTextureDimension2D ||
      limits.maxTextureArrayLayers < this.cascadeCount
    )
      throw new RangeError('Shadow map exceeds device limit; lower resolution');
  }
  /** (Re)creates the cached and combined depth arrays at the validated size. */
  private textures(): void {
    this.cached?.destroy();
    this.combined?.destroy();
    const texture = () =>
      this.device!.createTexture({
        size: [this.width, this.height, this.cascadeCount],
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
    this.mapWidth = this.width;
    this.mapHeight = this.height;
  }
  /** Receiver bindings: a fresh array view whenever the maps are reallocated, so receivers rebuild their groups. */
  private bind(): void {
    this.entries = [
      { binding: 1, resource: { buffer: this.uniform! } },
      { binding: 2, resource: (this.combinedView = this.combined!.createView({ dimension: '2d-array' })) },
      { binding: 3, resource: this.sampler! },
    ];
    this.nearestGroup = undefined;
    this.dirty = true;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -5,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.render(c);
        if (sectionState(c)) {
          // The scene's `section` plugin owns its existing binding. Move only the shadow
          // sampling declarations and resources past the occupied slots.
          const base = Math.max(0, ...c.bindings.map((entry) => entry.binding)) + 1;
          c.shader = this.shader(c.shader)
            .replace('@binding(1) var<uniform> shadowFrame', `@binding(${base}) var<uniform> shadowFrame`)
            .replace('@binding(2) var shadowMap', `@binding(${base + 1}) var shadowMap`)
            .replace('@binding(3) var shadowSampler', `@binding(${base + 2}) var shadowSampler`);
          c.bindings.push(...this.bindings().map((entry) => ({ ...entry, binding: entry.binding + base - 1 })));
        } else {
          c.shader = this.shader(c.shader);
          const entries = this.bindings();
          for (let i = 0; i < entries.length; i++) c.bindings.push(entries[i]);
        }
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
    let core = this.options.distance === undefined && this.sources.length > 0;
    for (let i = 0; core && i < this.sources.length; i++) {
      const source = this.sources[i].source;
      core = 'id' in source && !!source.geometry;
    }
    if (!core) return fit;
    // ponytail: one pass over every core mesh per frame; cache on store revisions if 100k-part scenes leave distance unset.
    // World bounding spheres from core's per-mesh local spheres; their box centre, then the sphere around them all.
    const box = this.rangeBox,
      center = this.rangeCenter;
    box.fill(Infinity, 0, 3).fill(-Infinity, 3);
    this.engine!.meshes.forEach(this.extendBox);
    const cx = (center[0] = (box[0] + box[3]) / 2),
      cy = (center[1] = (box[1] + box[4]) / 2),
      cz = (center[2] = (box[2] + box[5]) / 2);
    center[3] = 0;
    this.engine!.meshes.forEach(this.extendRadius);
    const h = hypotTerms;
    h[0] = cx - camera.position[0];
    h[1] = cy - camera.position[1];
    h[2] = cz - camera.position[2];
    hypotOf(3);
    const radius = center[3],
      d = h[4];
    const far = 2 ** (Math.ceil(Math.log2(d + radius) * 4) / 4),
      near = d > radius ? 2 ** (Math.floor(Math.log2(d - radius) * 4) / 4) : 0;
    if (far < fit.far && far > camera.near) fit.far = far;
    if (near > fit.near && near < fit.far) fit.near = near;
    return fit;
  }
  /** The world bounding sphere of core mesh `id` (centre, radius) into `this.sphere`, from its local one. */
  private worldSphere(id: number): Float64Array {
    const store = this.engine!.store,
      m = store.matrices,
      s = store.bounds,
      w = this.sphere,
      o = id * 16,
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
  }
  // range()'s two passes over the engine's meshes, made once (Map.forEach callbacks).
  private readonly extendBox = (mesh: Mesh, id: number): void => {
    if (!mesh.geometry) return;
    const w = this.worldSphere(id),
      box = this.rangeBox;
    for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k], w[k] - w[3]);
      box[k + 3] = Math.max(box[k + 3], w[k] + w[3]);
    }
  };
  private readonly extendRadius = (mesh: Mesh, id: number): void => {
    if (!mesh.geometry) return;
    const w = this.worldSphere(id),
      c = this.rangeCenter;
    const h = hypotTerms;
    h[0] = w[0] - c[0];
    h[1] = w[1] - c[1];
    h[2] = w[2] - c[2];
    hypotOf(3);
    c[3] = Math.max(c[3], h[4] + w[3]);
  };
  private render(c: ShadowPassContext): void {
    this.validate();
    this.frameSerial++;
    if (this.width !== this.mapWidth || this.height !== this.mapHeight) {
      this.checkLimits();
      this.textures();
      this.bind();
    }
    const clipped = !!sectionState(c);
    // Plane coefficients and enabled are live uniforms. Redraw while a
    // section is attached, and once after removal, rather than caching an
    // atlas made with obsolete plane values.
    if (clipped || this.clipped) this.dirty = true;
    this.clipped = clipped;
    for (let i = 0; i < 3; i++) this.light[i] = this.engine!.lighting.direction[i];
    if (this.options.bounds || this.options.frustum) {
      this.fitBounds();
      // All visible receivers select layer zero, including when the camera orbits outside the fixed box.
      this.splits.fill(c.camera.far);
    } else {
      const camera = this.range(c.camera);
      // Splits past the last cascade repeat the far distance, so receivers never select an unrendered layer.
      cascadeSplits(camera.near, camera.far, this.options.lambda ?? 0.5, this.splits, this.cascadeCount);
      fitCascades(
        camera,
        c.width / c.height,
        this.light as unknown as [number, number, number],
        // The coarser axis's texel: whole texels on both power-of-two axes, so snapping stays stable.
        Math.min(this.width, this.height),
        this.splits,
        this.matrices,
        this.ranges,
        this.options.casterMargin ?? 100,
        this.fitted,
        this.cascadeCount,
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
    let moving = false;
    let hash = 2166136261;
    for (let i = 0; i < this.sources.length; i++) {
      const r = this.sources[i];
      if (!r.cast) continue;
      if (r.static) {
        if ('shadowVersion' in r.source && r.version !== r.source.shadowVersion) {
          r.version = r.source.shadowVersion ?? 0;
          this.dirty = true;
        }
        continue;
      }
      if ('drawShadow' in r.source && r.source.drawShadow) {
        moving = true;
        continue;
      }
      const primitives = this.casters(r, this.primitiveDepth);
      for (let j = 0; j < primitives.length; j++) {
        const primitive = primitives[j];
        if (primitive.dynamic || primitive.instances) {
          moving = true;
          continue;
        }
        hash = this.mixStill(hash, primitive);
      }
    }
    if (hash !== this.stillHash) {
      this.stillHash = hash;
      this.dirty = true;
    }
    this.values.set(this.matrices);
    viewMatrix(this.view, c.camera);
    this.values.set(this.splits, 80);
    this.values[88] = this.options.lightSize ?? 0.02;
    this.values[89] = this.options.bias ?? 0.0005;
    this.values[90] = this.options.normalBias ?? 0.02;
    // Pixels per unit at view depth 1: the sampler rebuilds each fragment's screen pixel for its per-pixel noise.
    this.values[91] = c.height / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    this.stats.staticDraws = this.stats.dynamicDraws = 0;
    const rendered = this.dirty;
    if (this.dirty) {
      for (let cascade = 0; cascade < this.cascadeCount; cascade++) this.depth(c, cascade, true);
      this.previous.set(this.matrices);
      this.dirty = false;
    } else this.stats.cacheHits++;
    this.copySource.texture = this.cached!;
    this.copyDestination.texture = this.combined!;
    this.copySize.width = this.width;
    this.copySize.height = this.height;
    c.encoder.copyTextureToTexture(this.copySource, this.copyDestination, this.copySize);
    if (moving) for (let cascade = 0; cascade < this.cascadeCount; cascade++) this.depth(c, cascade, false);
    if ((this.options.filter ?? 'soft') !== 'soft') this.nearestStale ||= rendered || moving;
    else if (rendered || moving || this.nearestStale) this.nearest(c);
  }
  /**
   * Reduces each layer of the combined map to its nearest depth and copies it into the frame uniform: the PCSS search
   * spans the receiver's light-space distance to that depth (shader.ts `soft`). Runs when the map changed.
   */
  private nearest(c: ShadowPassContext): void {
    const device = c.device;
    this.nearestPipeline ??= device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: nearestDepth }), entryPoint: 'main' },
    });
    this.nearestGroup ??= device.createBindGroup({
      layout: this.nearestPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.combinedView! },
        { binding: 1, resource: { buffer: this.nearestBuffer! } },
      ],
    });
    device.queue.writeBuffer(this.nearestBuffer!, 0, this.nearestSeed);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.nearestPipeline);
    pass.setBindGroup(0, this.nearestGroup);
    pass.dispatchWorkgroups(Math.ceil(this.width / 32), Math.ceil(this.height / 32), this.cascadeCount);
    pass.end();
    c.encoder.copyBufferToBuffer(this.nearestBuffer!, 0, this.uniform!, 368, 16);
    this.nearestStale = false;
  }
  private fitBounds(): void {
    const { bounds, frustum } = this.options,
      points = bounds?.points,
      length = hypot(3, this.light[0], this.light[1], this.light[2]);
    if (!length)
      throw new RangeError(
        'Shadow light direction has zero length; set engine.lighting.direction to a nonzero vector.',
      );
    const zx = -this.light[0] / length,
      zy = -this.light[1] / length,
      zz = -this.light[2] / length,
      vertical = Math.abs(zy) > 0.99;
    let xx = vertical ? -zy : zz,
      xy = vertical ? zx : 0,
      xz = vertical ? 0 : -zx;
    const xl = hypot(3, xx, xy, xz);
    xx /= xl;
    xy /= xl;
    xz /= xl;
    const yx = zy * xz - zz * xy,
      yy = zz * xx - zx * xz,
      yz = zx * xy - zy * xx;
    let centerX: number, centerY: number, centerZ: number, halfX: number, halfY: number, halfZ: number;
    if (frustum) {
      // This basis is a camera looking along the light (z, its travel) with x minus that camera's right and y its up.
      const e = frustum.position;
      centerX = e[0] * xx + e[1] * xy + e[2] * xz - (frustum.left + frustum.right) * 0.5;
      centerY = e[0] * yx + e[1] * yy + e[2] * yz + (frustum.bottom + frustum.top) * 0.5;
      centerZ = e[0] * zx + e[1] * zy + e[2] * zz + (frustum.near + frustum.far) * 0.5;
      halfX = (frustum.right - frustum.left) * 0.5;
      halfY = (frustum.top - frustum.bottom) * 0.5;
      halfZ = (frustum.far - frustum.near) * 0.5;
    } else if (points) {
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
      const { min, max } = bounds!,
        cx = (min[0] + max[0]) * 0.5,
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
    const resolution = Math.min(this.width, this.height),
      // Projecting the AABB half extents is equivalent to fitting all eight world-space corners.
      // Bounds keep a square light-space region (square world texels on a square map), snapped by the coarser axis's
      // texel; a frustum is the user's box exactly, so it neither pads nor snaps nor adds the caster margin.
      radius = Math.max(halfX, halfY) * (1 + 2 / resolution),
      rx = frustum ? halfX : radius,
      ry = frustum ? halfY : radius,
      depth = frustum ? 2 * halfZ : 2 * (halfZ + (this.options.casterMargin ?? 100)),
      tx = (2 * rx) / resolution,
      ty = (2 * ry) / resolution,
      px = frustum ? centerX : Math.round(centerX / tx) * tx,
      py = frustum ? centerY : Math.round(centerY / ty) * ty,
      pz = centerZ,
      m = this.matrices;
    if (!(radius > 0) || !(depth > 0))
      throw new RangeError('Shadow bounds points have no light-space extent; give points that span some volume.');
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
    // Not Number.isFinite, which boxes each fractional value per frame (cascades.ts fitCascades).
    for (let i = 0; i < 16; i++)
      if (m[i] - m[i] !== 0)
        throw new RangeError('Shadow bounds matrix is not finite; check the bounds for extreme values.');
  }
  private identity(object: object): number {
    let id = this.objectIds.get(object);
    if (id === undefined) this.objectIds.set(object, (id = ++this.objectSerial));
    return id;
  }
  private mixFloat(hash: number, value: number): number {
    this.hashFloat[0] = value;
    return Math.imul(hash, 16777619) ^ this.hashWord[0];
  }
  /** Still-caster identity. A changed matrix, buffer, alpha map, or hidden bit redraws the whole cached atlas. */
  private mixStill(hash: number, primitive: ShadowPrimitive): number {
    hash = Math.imul(hash, 16777619) ^ this.identity(primitive.vertex);
    hash = Math.imul(hash, 16777619) ^ (primitive.vertexOffset ?? 0);
    hash = Math.imul(hash, 16777619) ^ this.identity(primitive.index);
    hash = Math.imul(hash, 16777619) ^ primitive.count;
    hash = Math.imul(hash, 16777619) ^ primitive.stride;
    hash = Math.imul(hash, 16777619) ^ (primitive.topology === 'line-list' ? 1 : 0);
    hash = Math.imul(hash, 16777619) ^ (primitive.node.id + 1);
    hash = Math.imul(hash, 16777619) ^ (primitive.alphaTexture ? this.identity(primitive.alphaTexture) : 0);
    hash = Math.imul(hash, 16777619) ^ (primitive.alphaSampler ? this.identity(primitive.alphaSampler) : 0);
    hash = this.mixFloat(hash, primitive.alpha ?? 1);
    hash = this.mixFloat(hash, primitive.cutoff ?? 0);
    hash = this.mixFloat(hash, primitive.texCoord ?? 0);
    const transform = primitive.alphaTransform;
    hash = Math.imul(hash, 16777619) ^ (transform?.length ?? 0);
    if (transform) for (let i = 0; i < transform.length; i++) hash = this.mixFloat(hash, transform[i]);
    const matrix = primitive.node.matrix;
    for (let i = 0; i < 16; i++) hash = this.mixFloat(hash, matrix[i]);
    const store = this.engine?.store,
      hidden = store && hiddenInTree(store, primitive.node.id) ? 1 : 0;
    return Math.imul(hash, 16777619) ^ hidden;
  }
  private casters(record: Source, level: number): readonly ShadowPrimitive[] {
    const source = record.source;
    if (!record.cast || ('drawShadow' in source && source.drawShadow)) return emptyPrimitives;
    if ('id' in source) {
      // A core mesh is read directly: meshTriangles builds an object on every call, and this runs every pass.
      const geometry = source.geometry;
      if (!geometry) {
        const triangles = meshTriangles(source);
        return triangles?.kind === 'pbr' ? (triangles.source.shadowPrimitives ?? emptyPrimitives) : emptyPrimitives;
      }
      const buffers = this.engine!.geometryBuffers(geometry);
      if (!buffers) return emptyPrimitives;
      record.meshPrimitive ??= [
        {
          node: source,
          vertex: buffers.vertex,
          index: buffers.index,
          count: geometry.indices.length,
          stride: 24,
        },
      ];
      Object.assign(record.meshPrimitive[0], buffers).count = geometry.indices.length;
      return record.meshPrimitive;
    }
    const writer = (source as ShadowSource & { [shadowPrimitivesInto]?: (out: ShadowPrimitive[]) => boolean })[
      shadowPrimitivesInto
    ];
    if (writer) {
      const buffers = (record.primitiveBuffers ??= []),
        buffer = (buffers[level] ??= []);
      return writer.call(source, buffer) ? buffer : (source.shadowPrimitives ?? emptyPrimitives);
    }
    return source.shadowPrimitives ?? emptyPrimitives;
  }
  private depth(c: ShadowPassContext, cascade: number, cached: boolean): void {
    this.depthAttachment.view = (cached ? this.cachedViews : this.views)[cascade];
    this.depthAttachment.depthLoadOp = cached ? 'clear' : 'load';
    const pass = c.encoder.beginRenderPass(this.depthPass),
      matrix = this.cascadeMatrices[cascade];
    const level = this.primitiveDepth++;
    // Everything a pass keeps is reused: the per-level arrays, and per caster (node and primitive) one state object
    // stamped with the pass serial. Maps and sets cleared and refilled every pass were garbage every frame.
    const frame = (this.frames[level] ??= { records: [], primitives: [], pending: [], waiting: 0 }),
      serial = ++this.passSerial,
      section = sectionState(c),
      batches = (this.batches[level * 2 + (cached ? 1 : 0)] ??= new Map()),
      pending = frame.pending;
    try {
      const count = this.sources.length;
      frame.records.length = frame.primitives.length = count;
      for (let s = 0; s < count; s++) {
        const record = this.sources[s],
          primitives = this.casters(record, level);
        frame.records[s] = record;
        frame.primitives[s] = primitives;
        for (let i = 0; i < primitives.length; i++) {
          const primitive = primitives[i],
            state = this.casterState(level, primitive.node, primitive.primitive ?? primitive.index, serial);
          // Moving wins: a primitive still in one source and moving in another is drawn with the moving ones.
          if (state.still !== false) state.still = record.static || !(primitive.dynamic || primitive.instances);
        }
      }

      for (let i = 0; i < this.sources.length; i++) {
        const r = this.sources[i];
        const callback = 'drawShadow' in r.source ? r.source.drawShadow : undefined;
        if (!r.cast || ('disposed' in r.source && r.source.disposed)) continue;
        // Explicit static sources and drawShadow callbacks stay on one pass. Other sources carry both.
        if ((r.static || callback) && r.static !== cached) continue;
        if (callback) {
          const shadow = this.shadowContexts[cascade];
          shadow.context = c;
          shadow.pass = pass;
          // The function is a method on the source. Terrain, VAT and scatter read `this` inside it.
          callback.call(r.source, shadow);
          continue;
        }
        const primitives = frame.records[i] === r ? frame.primitives[i] : emptyPrimitives;
        for (let i = 0; i < primitives.length; i++) {
          const primitive = primitives[i],
            node = primitive.node;
          node.check();
          if (node.engine !== this.engine)
            throw new MargoError(
              'attached',
              'Shadow source belongs to another engine; use objects created by the same engine',
            );
          if (hiddenInTree(this.engine!.store, node.id)) continue;
          const state = this.casterState(level, node, primitive.primitive ?? primitive.index, serial);
          if (state.still !== cached || state.drawn) continue;
          state.drawn = true;
          if (!section && this.batchable(primitive)) {
            let byIndex = batches.get(primitive.vertex);
            if (!byIndex) batches.set(primitive.vertex, (byIndex = new Map()));
            let batch = byIndex.get(primitive.index);
            if (!batch)
              byIndex.set(
                primitive.index,
                (batch = { primitives: [], count: 0, matrices: new Float32Array(0), groups: [], packed: 0 }),
              );
            if (!batch.count) pending[frame.waiting++] = batch;
            batch.primitives[batch.count++] = primitive;
          } else this.draw(pass, primitive, matrix, cascade, section);
          if (cached) this.stats.staticDraws++;
          else this.stats.dynamicDraws++;
        }
      }
      for (let i = 0; i < frame.waiting; i++) {
        const batch = pending[i];
        if (batch.count < BATCH_MIN)
          for (let j = 0; j < batch.count; j++) this.draw(pass, batch.primitives[j], matrix, cascade, section);
        else this.drawBatch(pass, batch, matrix, cascade);
        batch.count = 0;
      }
      frame.waiting = 0;
    } catch (error) {
      for (let i = 0; i < frame.waiting; i++) pending[i].count = 0;
      frame.waiting = 0;
      try {
        pass.end();
      } catch {}
      throw error;
    } finally {
      this.primitiveDepth--;
    }
    pass.end();
  }
  /** The state of caster `node`'s primitive `key` in pass `serial`: made once, reset when the pass is new to it. */
  private casterState(level: number, node: Mesh, key: object, serial: number): CasterState {
    const states = (this.casterStates[level] ??= new Map());
    let byKey = states.get(node);
    if (!byKey) states.set(node, (byKey = new Map()));
    let state = byKey.get(key);
    if (!state) byKey.set(key, (state = { serial, still: undefined, drawn: false }));
    else if (state.serial !== serial) {
      state.serial = serial;
      state.still = undefined;
      state.drawn = false;
    }
    return state;
  }
  /** A plain core-mesh caster: 24-byte triangles, no alpha mask, displacement or instances. */
  private batchable(p: ShadowPrimitive): boolean {
    return (
      p.stride === 24 &&
      !p.instances &&
      !p.displacement &&
      !p.clip &&
      !p.alphaTexture &&
      p.alphaTransform === undefined &&
      p.topology !== 'line-list' &&
      (p.alpha ?? 1) === 1 &&
      (p.cutoff ?? 0) === 0
    );
  }
  /** One instanced draw for every caster of `batch` (one geometry): world matrices packed once per frame and pass. */
  private drawBatch(pass: GPURenderPassEncoder, batch: Batch, matrix: Float32Array, cascade: number): void {
    const device = this.device!,
      n = batch.count;
    if (!this.batchPipeline) {
      const module = device.createShaderModule({ code: batchDepth });
      this.batchPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex', buffers: casterBuffers(24) },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
    }
    if (!this.batchCameras.length)
      for (let i = 0; i < 4; i++)
        this.batchCameras.push(
          device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        );
    if (batch.packed !== this.frameSerial) {
      if (batch.matrices.length < n * 16) batch.matrices = new Float32Array(2 ** Math.ceil(Math.log2(n)) * 16);
      for (let i = 0; i < n; i++) batch.matrices.set(batch.primitives[i].node.matrix, i * 16);
      if (!batch.buffer || batch.buffer.size < batch.matrices.byteLength) {
        batch.buffer?.destroy();
        batch.buffer = device.createBuffer({
          size: batch.matrices.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        batch.groups.length = 0;
      }
      device.queue.writeBuffer(batch.buffer, 0, batch.matrices as Float32Array<ArrayBuffer>, 0, n * 16);
      batch.packed = this.frameSerial;
    }
    const camera = this.batchCameras[cascade];
    device.queue.writeBuffer(camera, 0, matrix as Float32Array<ArrayBuffer>);
    const group = (batch.groups[cascade] ??= device.createBindGroup({
      layout: this.batchPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: camera } },
        { binding: 1, resource: { buffer: batch.buffer! } },
      ],
    }));
    const first = batch.primitives[0];
    pass.setPipeline(this.batchPipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, first.vertex);
    pass.setIndexBuffer(first.index, 'uint32');
    pass.drawIndexed(first.count, n);
  }
  private clearBatches(): void {
    for (const level of this.batches)
      for (const byIndex of level?.values() ?? []) for (const batch of byIndex.values()) batch.buffer?.destroy();
    this.batches.length = 0;
    for (const buffer of this.batchCameras) buffer.destroy();
    this.batchCameras = [];
    this.batchPipeline = undefined;
  }
  private draw(
    pass: GPURenderPassEncoder,
    p: ShadowPrimitive,
    matrix: Float32Array,
    cascade: number,
    scene?: GPUBufferBinding,
  ): void {
    if (p.stride !== 24 && p.stride !== 80)
      throw new RangeError('Unsupported shadow vertex stride; use 24-byte or 80-byte vertices.');
    // A scene's `section` binding wins; a material's planes (union or intersection, settings.y) bind under their own name.
    const section = scene ?? p.clip,
      material = !scene && !!p.clip;
    const inst = p.instances;
    if (inst && !inst.count) return;
    if (inst && p.stride !== 80) throw new RangeError('Instanced shadow casters need 80-byte vertices');
    const displacement = p.displacement;
    if (displacement && p.stride !== 80) throw new RangeError('Displaced shadow casters need 80-byte vertices');
    const transform = p.alphaTransform;
    if (
      transform !== undefined &&
      (!(transform instanceof Float32Array) ||
        transform.length !== 8 ||
        transform.some((v) => !Number.isFinite(v)) ||
        p.stride !== 80)
    )
      throw new TypeError('Shadow alpha transform requires finite affine rows and PBR vertices');
    const lines = p.topology === 'line-list',
      key =
        p.stride +
        (transform ? 1 : 0) +
        (inst ? 2 : 0) +
        (lines ? 4 : 0) +
        (section ? 8 : 0) +
        (displacement ? 16 : 0) +
        (material ? 32 : 0);
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      let code = shadowDepth(p.stride === 80, !!transform);
      if (displacement) code = displacedDepth(code, 1);
      if (inst) code = instancedDepth(code);
      if (section) {
        code = code
          .replace('struct Out {', 'struct Out {@location(2) position:vec3f,')
          .replace(/o.clip=f.camera\*([^;]+);/, 'let world=$1;o.clip=f.camera*world;o.position=world.xyz;');
        code = sectionShader(code, 0, 3, material ? 'materialClip' : 'section');
      }
      const module = this.device!.createShaderModule({ code });
      pipeline = casterPipeline(this.device!, module, p.stride, !!displacement, !!inst, lines);
      this.pipelines.set(key, pipeline);
    }
    // Primitives sharing a node can have different alpha maps and geometry.
    const identity = p.primitive ?? p.index,
      records = nodeRecords(this.draws, p.node);
    let record = records.get(identity);
    if (staleCaster(record, p, pipeline, displacement) || record.section !== section?.buffer) {
      if (record) for (const b of record.uniforms) b.destroy();
      records.delete(identity);
      // The closure below captures this block's const, not draw's pipeline: a captured function variable makes V8
      // allocate a context on every draw call, used or not; a block's is made only when the block runs.
      const made = pipeline;
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
                ...(section ? [{ binding: 3, resource: section }] : []),
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
        section: section?.buffer,
        displacement,
        displaced: displacementGroup(this.device!, () => made.getBindGroupLayout(1), displacement),
      };
      records.set(identity, record);
    }
    drawCaster(
      pass,
      this.device!,
      pipeline,
      record.groups[cascade],
      record.uniforms[cascade],
      record.values as Float32Array<ArrayBuffer>,
      matrix,
      p,
      transform,
      record.displaced,
      inst,
    );
  }
  private clearDraws(): void {
    for (const records of this.draws.values())
      for (const r of records.values()) for (const b of r.uniforms) b.destroy();
    this.draws.clear();
    this.casterStates.length = 0;
    // Batches hold a geometry's buffers as keys: drop them with the casters they were built for.
    this.clearBatches();
  }
  private release(): void {
    this.clearDraws();
    for (const texture of [this.cached, this.combined, this.white]) texture?.destroy();
    this.uniform?.destroy();
    this.nearestBuffer?.destroy();
    this.nearestBuffer = this.nearestPipeline = this.nearestGroup = this.combinedView = undefined;
    this.nearestStale = true;
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
