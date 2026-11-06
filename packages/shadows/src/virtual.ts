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
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { preset } from '../../shared/preset.js';
import { instancedDepth } from '../../shared/instances.js';
import { displacedDepth } from '../../shared/displacement.js';
import { shadowPrimitivesInto, coreReceives, unshadowedCore } from '../../shared/shadow-source.js';
import { viewMatrix } from '../../shared/view.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { sectionState, sectionShader } from '../../shared/section.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { invert } from '../../shared/math.js';
import {
  casterPipeline,
  casterRuntime,
  displacementGroup,
  drawCaster,
  opacityDepth,
  opacityEntries,
  solidVertexDepth,
  staleCaster,
} from '../../shared/caster.js';
import { PAGES_PER_SIDE, PAGE_TEXELS, PagePool, basePageSize, pageIndex, pageMatrix, pageSize } from './pages.js';
import { shadowDepth, type ShadowFilter } from './shader.js';
import { pageClear, pageCopy, pageFeedback, pageNearest, virtualSampling } from './virtual-shader.js';
import type { ShadowPrimitive, ShadowSource } from './index.js';
export type { ShadowFilter } from './shader.js';
declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  STORAGE: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
/** The WebGPU pass context of a frame. */
type VirtualPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** Virtual shadow map settings; invalid values throw RangeError. */
export interface VirtualShadowOptions {
  /**
   * Physical page pool size in texels (default 4096: 32 x 32 pages of 128 texels), a multiple of 256 up to the device's
   * `maxTextureDimension2D`. Memory is two `depth32float` pools: 128 MiB at 4096, 32 MiB at 2048 (for phones).
   */
  poolSize?: number;
  /** Clipmap levels, 1 to 16 (default 8). Each level's pages are twice the size of the one before. */
  levels?: number;
  /** Farthest shadowed distance from the camera in light space, world units, > 0. Default 500. */
  distance?: number;
  /** Most resident pages, 1 up to the pool's. Default the pool's. */
  budgetPages?: number;
  /** Light size for the `'soft'` filter's penumbra width, 0 or more. Default 0.02. */
  lightSize?: number;
  /** Constant depth bias along the light, world units, 0 or more. Default 0.002. */
  bias?: number;
  /** Receiver offset along its normal, world units, 0 or more. Default 0.02. */
  normalBias?: number;
  /** World units the depth range extends towards the light for off-screen casters, 0 or more. Default 100. */
  casterMargin?: number;
  /** Edge filter (default `'soft'`), as `Shadows`. Read when receiver shaders are built. */
  filter?: ShadowFilter;
}
interface Source {
  source: ShadowSource | Mesh;
  static: boolean;
  cast: boolean;
  receive: boolean;
  version: number;
  removeLighting?: () => void;
  meshPrimitive?: ShadowPrimitive[];
  primitiveBuffer?: ShadowPrimitive[];
}
/** One caster primitive's GPU records: one uniform and bind group per draw in a frame, kept for the next. */
interface Draw {
  p: ShadowPrimitive;
  uniforms: GPUBuffer[];
  groups: GPUBindGroup[];
  values: Float32Array;
  vertex: GPUBuffer;
  pipeline: GPURenderPipeline;
  alpha?: GPUTextureView;
  sampler?: GPUSampler;
  section?: GPUBuffer;
  displacement?: ShadowPrimitive['displacement'];
  displaced?: GPUBindGroup;
  opacity?: ShadowPrimitive['opacity'];
  /** Stays cached while it stays put: not a `static` registration, whose changes only `shadowVersion` reports. */
  watched: boolean;
  /** What the cached pages hold of it (world matrix, alpha, cutoff, UV set, count, then the alpha transform). */
  seen: Float32Array;
  /** The serial it last cast on; its sphere then, for the pages it leaves. */
  castSerial: number;
  lastX: number;
  lastY: number;
  lastRadius: number;
  /** A cast registration reached it this frame. */
  casts: boolean;
  /** Draws made this frame. */
  used: number;
  serial: number;
  still: boolean;
  /** World sphere in light space (x, y, radius); a NaN radius is unknown: it reaches every page. */
  x: number;
  y: number;
  radius: number;
}
const emptyPrimitives: readonly ShadowPrimitive[] = [];
const shaderKey = (filter: string, group: number) => group * 8 + (filter === 'soft' ? 0 : filter === 'pcf' ? 2 : 4);
/**
 * A directional virtual shadow map: one depth page pool mapped through a page table over a clipmap of light-space levels
 * around the camera, so resolution follows what the camera sees and still pages stay cached. The optional sibling of
 * `Shadows`, with the same `attach`, `add` and receiver hooks; importing `@margoengine/shadows` alone pays nothing for it.
 * Casters are core meshes and sources with `shadowPrimitives`; a source that only has `drawShadow` can receive
 * (`castShadow: false`) but cannot cast here, because it keeps per-cascade uniforms and a page needs its own matrix.
 * WebGPU only.
 * @throws RangeError when an option is out of range or the pool exceeds the device limits; TypeError for an invalid
 * source.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced the core PBR shader,
 * `'disposed'` for a disposed effect or source, `'attached'` for a source of another engine or one added twice,
 * `'state'` when used before attaching.
 */
export class VirtualShadows implements EnginePlugin {
  readonly name = 'virtual-shadows';
  /**
   * Frame counters: `residentPages` now, `pagesRendered` drawn this frame, `casterDraws` their caster draws,
   * `levelPages` the distinct pages requested per level, `overflow` the requests the budget turned away.
   */
  readonly stats = { residentPages: 0, pagesRendered: 0, casterDraws: 0, levelPages: [] as number[], overflow: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private pool?: GPUTexture;
  private cached?: GPUTexture;
  private tableTexture?: GPUTexture;
  private pages?: PagePool;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private alphaSampler?: GPUSampler;
  private white?: GPUTexture;
  private whiteView?: GPUTextureView;
  private clearPipeline?: GPURenderPipeline;
  private copyPipeline?: GPURenderPipeline;
  private copyGroup?: GPUBindGroup;
  private cachedView?: GPUTextureView;
  private uploaded = new Uint32Array(0);
  private nearestBuffer?: GPUBuffer;
  private nearestPipeline?: GPUComputePipeline;
  private nearestGroup?: GPUBindGroup;
  private nearestStale = true;
  private readonly nearestSeed = new Uint32Array(16).fill(0x3f800000);
  private clipped = false;
  /** Casters of the previous frame, to find the ones that stopped casting. */
  private previous: Draw[] = [];
  private entries: GPUBindGroupEntry[] = [];
  private disposed = false;
  private sources: Source[] = [];
  private readonly lightingOwners = new Map<ShadowSource, { remove: () => void; count: number }>();
  private readonly hooks = new Map<number, { declarations: string; direct(direct: string): string }>();
  private readonly shaders = new Map<number, Map<string, string>>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly draws = new Map<Mesh, Map<object, Draw>>();
  private casters: Draw[] = [];
  private readonly receivers: Draw[] = [];
  private readonly customReceivers: ShadowSource[] = [];
  /** Core meshes nobody added still receive, so feedback draws them too. */
  private readonly loose = new Map<Mesh, Source>();
  private feedbackDepth?: GPUTexture;
  private feedbackView?: GPUTextureView;
  private feedbackPipeline?: GPUComputePipeline;
  private feedbackGroup?: GPUBindGroup;
  private requestBuffer?: GPUBuffer;
  private ring: { buffer: GPUBuffer; busy: boolean; centers: Int32Array }[] = [];
  private ringNext = 0;
  /** The newest feedback read back, and each level's window centre on the frame it was marked. */
  private requests = new Uint32Array(0);
  private requestCenters = new Int32Array(0);
  private readonly cameraMatrix = new Float32Array(16);
  private serial = 0;
  private table = new Uint32Array(0);
  private centers = new Int32Array(0);
  private readonly values = new Float32Array(116);
  private readonly view = this.values.subarray(0, 16);
  private readonly right = this.values.subarray(16, 19);
  private readonly up = this.values.subarray(20, 23);
  private readonly forward = this.values.subarray(24, 27);
  private readonly direction = new Float64Array(3);
  private readonly pageCamera = new Float32Array(16);
  private readonly address = [0, 0, 0];
  private origin = Number.NaN;
  private dirty = true;
  constructor(readonly options: VirtualShadowOptions = {}) {
    this.options = preset('shadows', options);
    this.validate();
  }
  /** Attaches a new effect to `instance`. */
  static attach(instance: EngineKernel, options: VirtualShadowOptions = {}): VirtualShadows {
    const effect = new VirtualShadows(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  private validate(): void {
    const o = this.options,
      size = o.poolSize ?? 4096,
      levels = o.levels ?? 8,
      budget = o.budgetPages,
      side = size / PAGE_TEXELS;
    if (!Number.isInteger(size) || size < 256 || size % 256)
      throw new RangeError('Invalid virtual shadow poolSize: use a multiple of 256, such as 2048 or 4096');
    if (!Number.isInteger(levels) || levels < 1 || levels > 16)
      throw new RangeError('Invalid virtual shadow levels: use an integer from 1 to 16');
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > side * side))
      throw new RangeError(`Invalid virtual shadow budgetPages: use an integer from 1 to ${side * side}`);
    if (!((o.distance ?? 500) > 0) || !Number.isFinite(o.distance ?? 500))
      throw new RangeError('Invalid virtual shadow distance: use a finite number above 0');
    for (const v of [o.lightSize, o.bias, o.normalBias, o.casterMargin])
      if (v !== undefined && !(v >= 0 && Number.isFinite(v)))
        throw new RangeError(
          'Invalid virtual shadow options: lightSize, bias, normalBias and casterMargin must be finite and 0 or more',
        );
    const filter = o.filter ?? 'soft';
    if (filter !== 'soft' && filter !== 'pcf' && filter !== 'hard')
      throw new RangeError(`Invalid shadow filter '${String(filter)}': use 'soft', 'pcf' or 'hard'`);
  }
  /** Bytes of GPU memory the pools and the page table hold; 0 before attaching. */
  get memoryBytes(): number {
    if (!this.pool) return 0;
    const size = this.options.poolSize ?? 4096;
    return 2 * size * size * 4 + PAGES_PER_SIDE * PAGES_PER_SIDE * (this.options.levels ?? 8) * 4;
  }
  /** The engine this effect is attached to. */
  get owner(): Engine | undefined {
    return this.engine;
  }
  /**
   * Adds `source` (a core mesh, gltf-pro model, materials mesh or other source) as a caster and, for sources with their
   * own lighting (`addLighting`), a receiver. `castShadow: false` keeps it out of the map; `receiveShadow: false` leaves
   * its lighting unshadowed. `static` keeps its pages cached until it changes. Returns the remover.
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
    const custom = !('id' in runtime) && !('shadowPrimitives' in runtime);
    if (custom && typeof (runtime as ShadowSource).drawShadow !== 'function')
      throw new TypeError('Invalid shadow source; pass a mesh, group or object with shadowPrimitives.');
    if (custom && castShadow)
      throw new TypeError(
        'A drawShadow source cannot cast into virtual shadows; give it shadowPrimitives, add it with castShadow: false, or use Shadows',
      );
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
        // The lighting hook takes any effect with `pbr` or `shader` and `bindings`, this one included.
        owner = { remove: lightingSource.addLighting(this as never), count: 1 };
        this.lightingOwners.set(lightingSource, owner);
      }
      removeLighting = () => {
        if (--owner!.count === 0) {
          this.lightingOwners.delete(lightingSource);
          owner!.remove();
        }
      };
    }
    const r: Source = {
      source: runtime,
      static: cached,
      cast: castShadow,
      receive: receiveShadow,
      version: -1,
      removeLighting,
    };
    this.sources.push(r);
    this.invalidate();
    return () => {
      const index = this.sources.indexOf(r);
      if (index >= 0) {
        this.sources.splice(index, 1);
        r.removeLighting?.();
        this.invalidate();
      }
    };
  }
  /** Draws every resident page again next frame. */
  invalidate(): void {
    this.dirty = true;
  }
  /** Receiver bind group entries; throws before attaching. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.pool || this.disposed)
      throw new MargoError('state', 'VirtualShadows are not attached; attach them to an engine first');
    return this.entries;
  }
  /** Patches core's or a material's lighting shader `source` to receive, for bind group `group`. */
  shader(source: string, group = 0): string {
    const filter = this.options.filter ?? 'soft',
      receive = unshadowedCore(this.engine, source),
      key = shaderKey(filter, group) + (receive ? 1 : 0);
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
        "VirtualShadows require the standard PBR lighting shader; remove the plugin that replaced core's shader",
      );
    const output = virtualSampling(group, filter) + code;
    if (!cache) this.shaders.set(key, (cache = new Map()));
    cache.set(source, output);
    return output;
  }
  /** gltf-pro lighting hooks for bind group `group`. */
  pbr(group: number): { declarations: string; direct(direct: string): string } {
    const filter = this.options.filter ?? 'soft',
      key = shaderKey(filter, group);
    let hooks = this.hooks.get(key);
    if (!hooks)
      this.hooks.set(
        key,
        (hooks = {
          declarations: virtualSampling(group, filter),
          direct: (d) => `shadowLit(${d},i.position,s.n)`,
        }),
      );
    return hooks;
  }
  /** Allocates the pools and the page table. Called by `engine.use`. */
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'VirtualShadows require WebGPU and a live effect; attach a new VirtualShadows to a WebGPU engine',
      );
    this.engine = engine;
    const device = (this.device = engine.gpu),
      o = this.options,
      size = o.poolSize ?? 4096,
      levels = o.levels ?? 8;
    this.validate();
    if (size > device.limits.maxTextureDimension2D || levels > device.limits.maxTextureArrayLayers)
      throw new RangeError('Virtual shadow pool exceeds device limit; lower poolSize or levels');
    const pool = () =>
      device.createTexture({
        size: [size, size],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.pool = pool();
    this.cached = pool();
    this.cachedView = this.cached.createView();
    this.tableTexture = device.createTexture({
      size: [PAGES_PER_SIDE, PAGES_PER_SIDE, levels],
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.table = new Uint32Array(PAGES_PER_SIDE * PAGES_PER_SIDE * levels);
    this.uploaded = new Uint32Array(this.table.length).fill(1);
    this.centers = new Int32Array(levels * 2);
    this.pages = new PagePool({
      levels,
      base: basePageSize(o.distance ?? 500, levels),
      poolPages: size / PAGE_TEXELS,
      budgetPages: o.budgetPages,
    });
    this.nearestBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.uniform = device.createBuffer({ size: 528, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.alphaSampler = device.createSampler();
    // One white texel stands in for the alpha map of casters without one.
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    this.white = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array(4).fill(255), { bytesPerRow: 4 }, [1, 1]);
    this.whiteView = this.white.createView();
    this.entries = [
      { binding: 1, resource: { buffer: this.uniform } },
      { binding: 2, resource: this.pool.createView() },
      { binding: 3, resource: this.sampler },
      { binding: 31, resource: this.tableTexture.createView({ dimension: '2d-array' }) },
    ];
    const words = (levels * PAGES_PER_SIDE * PAGES_PER_SIDE) / 32;
    this.requestBuffer = device.createBuffer({
      size: words * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.ring = [0, 1].map(() => ({
      buffer: device.createBuffer({ size: words * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      busy: false,
      centers: new Int32Array(levels * 2),
    }));
    this.requests = new Uint32Array(words);
    this.requestCenters = new Int32Array(levels * 2);
    this.origin = Number.NaN;
    this.dirty = true;
  }
  /** Adds the frame's shadow pass (order -5). Called by `engine.use`. */
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -5,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.render(c);
        if (sectionState(c)) {
          // The scene's `section` plugin owns its binding: move the shadow declarations past the occupied slots.
          const base = Math.max(31, ...c.bindings.map((entry) => entry.binding)) + 1;
          c.shader = this.shader(c.shader)
            .replace('@binding(1) var<uniform> shadowFrame', `@binding(${base}) var<uniform> shadowFrame`)
            .replace('@binding(2) var shadowMap', `@binding(${base + 1}) var shadowMap`)
            .replace('@binding(3) var shadowSampler', `@binding(${base + 2}) var shadowSampler`)
            .replace('@binding(31) var shadowPages', `@binding(${base + 3}) var shadowPages`);
          this.bindings().forEach((entry, i) => c.bindings.push({ ...entry, binding: base + i }));
        } else {
          c.shader = this.shader(c.shader);
          const entries = this.bindings();
          for (let i = 0; i < entries.length; i++) c.bindings.push(entries[i]);
        }
      },
    });
  }
  /** Light basis as `Shadows` builds it; a changed direction invalidates every page. */
  private basis(): void {
    const d = this.engine!.lighting.direction,
      length = Math.hypot(d[0], d[1], d[2]);
    if (!length)
      throw new RangeError(
        'Shadow light direction has zero length; set engine.lighting.direction to a nonzero vector.',
      );
    const zx = -d[0] / length,
      zy = -d[1] / length,
      zz = -d[2] / length,
      seen = this.direction;
    if (seen[0] === zx && seen[1] === zy && seen[2] === zz) return;
    seen[0] = zx;
    seen[1] = zy;
    seen[2] = zz;
    this.dirty = true;
    const vertical = Math.abs(zy) > 0.99,
      ax = vertical ? -zy : zz,
      ay = vertical ? zx : 0,
      az = vertical ? 0 : -zx,
      al = Math.hypot(ax, ay, az),
      xx = ax / al,
      xy = ay / al,
      xz = az / al;
    this.right[0] = xx;
    this.right[1] = xy;
    this.right[2] = xz;
    this.up[0] = zy * xz - zz * xy;
    this.up[1] = zz * xx - zx * xz;
    this.up[2] = zx * xy - zy * xx;
    this.forward[0] = zx;
    this.forward[1] = zy;
    this.forward[2] = zz;
  }
  /** The casters of a source; empty for a receiver-only one. */
  private primitives(record: Source): readonly ShadowPrimitive[] {
    const source = record.source;
    if ('id' in source) {
      const geometry = source.geometry;
      if (!geometry) {
        const triangles = meshTriangles(source);
        return triangles?.kind === 'pbr' ? (triangles.source.shadowPrimitives ?? emptyPrimitives) : emptyPrimitives;
      }
      const buffers = this.engine!.geometryBuffers(geometry);
      if (!buffers) return emptyPrimitives;
      record.meshPrimitive ??= [
        { node: source, vertex: buffers.vertex, index: buffers.index, count: geometry.indices.length, stride: 24 },
      ];
      Object.assign(record.meshPrimitive[0], buffers).count = geometry.indices.length;
      return record.meshPrimitive;
    }
    const writer = (source as ShadowSource & { [shadowPrimitivesInto]?: (out: ShadowPrimitive[]) => boolean })[
      shadowPrimitivesInto
    ];
    if (writer) {
      const buffer = (record.primitiveBuffer ??= []);
      return writer.call(source, buffer) ? buffer : (source.shadowPrimitives ?? emptyPrimitives);
    }
    return source.shadowPrimitives ?? emptyPrimitives;
  }
  /** This frame's casters, each once, with their light-space spheres. Registered twice, the moving registration wins. */
  private gather(serial: number, section?: GPUBufferBinding): void {
    const before = this.previous;
    this.previous = this.casters;
    this.casters = before;
    before.length = 0;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const r = this.sources[i];
      if (
        ('disposed' in r.source && r.source.disposed) ||
        ('id' in r.source && this.engine!.meshes.get(r.source.id) !== r.source)
      ) {
        this.sources.splice(i, 1);
        r.removeLighting?.();
        this.dirty = true;
      }
    }
    this.receivers.length = 0;
    this.customReceivers.length = 0;
    for (const r of this.sources) this.collect(r, serial, section);
    const loose = this.loose;
    for (const mesh of this.engine!.meshes.values()) {
      if (!mesh.geometry || !mesh.receiveShadow) continue;
      let r = loose.get(mesh);
      if (!r) loose.set(mesh, (r = { source: mesh, static: true, cast: false, receive: true, version: 0 }));
      this.collect(r, serial, section);
    }
    if (loose.size > this.engine!.meshes.size * 2 + 16)
      for (const mesh of loose.keys()) if (this.engine!.meshes.get(mesh.id) !== mesh) loose.delete(mesh);
  }
  private collect(r: Source, serial: number, section?: GPUBufferBinding): void {
    const store = this.engine!.store,
      source = r.source;
    if (r.cast && r.static && 'shadowVersion' in source && r.version !== source.shadowVersion) {
      r.version = source.shadowVersion ?? 0;
      this.dirty = true;
    }
    if (!('id' in source) && !('shadowPrimitives' in source)) {
      if (r.receive) this.customReceivers.push(source);
      return;
    }
    const primitives = this.primitives(r);
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i],
        node = p.node;
      node.check();
      if (node.engine !== this.engine)
        throw new MargoError(
          'attached',
          'Shadow source belongs to another engine; use objects created by the same engine',
        );
      if (hiddenInTree(store, node.id)) continue;
      const inst = p.instances;
      if (inst && !inst.count) continue;
      const moving = r.cast && !r.static && !!(p.dynamic || inst),
        d = this.record(p, section);
      if (d.serial !== serial) {
        d.serial = serial;
        d.used = 0;
        d.still = true;
        d.casts = d.watched = false;
        d.p = p;
        this.sphere(d, p);
        this.receivers.push(d);
      }
      if (moving) d.still = false;
      if (r.cast && !r.static) d.watched = true;
      if (r.cast && !d.casts) {
        d.casts = true;
        this.casters.push(d);
      }
    }
  }
  /** The caster's light-space sphere from core's per-mesh local bounds; unknown (NaN) unless a core mesh draws it as is. */
  private sphere(d: Draw, p: ShadowPrimitive): void {
    if (!p.node.geometry || p.instances || p.displacement || p.dynamic) {
      d.radius = Number.NaN;
      return;
    }
    const store = this.engine!.store,
      m = store.matrices,
      s = store.bounds,
      o = p.node.id * 16,
      b = p.node.id * 4,
      wx = m[o] * s[b] + m[o + 4] * s[b + 1] + m[o + 8] * s[b + 2] + m[o + 12],
      wy = m[o + 1] * s[b] + m[o + 5] * s[b + 1] + m[o + 9] * s[b + 2] + m[o + 13],
      wz = m[o + 2] * s[b] + m[o + 6] * s[b + 1] + m[o + 10] * s[b + 2] + m[o + 14],
      a = m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2,
      c = m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2,
      e = m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2;
    d.x = wx * this.right[0] + wy * this.right[1] + wz * this.right[2];
    d.y = wx * this.up[0] + wy * this.up[1] + wz * this.up[2];
    d.radius = s[b + 3] * Math.sqrt(Math.max(a, c, e));
  }
  private record(p: ShadowPrimitive, section?: GPUBufferBinding): Draw {
    const pipeline = this.pipeline(p, section);
    let records = this.draws.get(p.node);
    if (!records) this.draws.set(p.node, (records = new Map()));
    const identity = p.primitive ?? p.index;
    let record = records.get(identity);
    if (staleCaster(record, p, pipeline, p.displacement) || record.section !== section?.buffer) {
      if (record) for (const b of (record as Draw).uniforms) b.destroy();
      record = {
        p,
        uniforms: [],
        groups: [],
        values: new Float32Array(p.alphaTransform ? 44 : 36),
        vertex: p.vertex,
        pipeline,
        alpha: p.alphaTexture,
        sampler: p.alphaSampler,
        section: section?.buffer,
        displacement: p.displacement,
        displaced: displacementGroup(this.device!, () => pipeline.getBindGroupLayout(1), p.displacement),
        opacity: p.opacity,
        watched: false,
        seen: new Float32Array(28),
        castSerial: -1,
        lastX: 0,
        lastY: 0,
        lastRadius: Number.NaN,
        casts: false,
        used: 0,
        serial: 0,
        still: true,
        x: 0,
        y: 0,
        radius: Number.NaN,
      };
      records.set(identity, record);
    }
    return record;
  }
  private pipeline(p: ShadowPrimitive, section?: GPUBufferBinding): GPURenderPipeline {
    if (p.stride !== 24 && p.stride !== 80)
      throw new RangeError('Unsupported shadow vertex stride; use 24-byte or 80-byte vertices.');
    const inst = p.instances,
      displacement = p.displacement,
      transform = p.alphaTransform,
      opacity = p.opacity;
    if (inst && p.stride !== 80) throw new RangeError('Instanced shadow casters need 80-byte vertices');
    if (displacement && p.stride !== 80) throw new RangeError('Displaced shadow casters need 80-byte vertices');
    if (opacity && p.stride !== 80) throw new RangeError('Opacity-mapped shadow casters need 80-byte vertices');
    const lines = p.topology === 'line-list',
      solid = p.stride === 80 && p.vertexAlpha === false,
      key =
        (displacement?.key ?? '') +
        (p.stride +
        (transform ? 1 : 0) +
        (inst ? 2 : 0) +
        (lines ? 4 : 0) +
        (section ? 8 : 0) +
        (displacement ? 16 : 0) +
        (opacity ? 32 : 0) +
        (solid ? 64 : 0));
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      let code = shadowDepth(p.stride === 80, !!transform);
      if (displacement) code = displacedDepth(code, 1, displacement);
      if (inst) code = instancedDepth(code);
      if (solid) code = solidVertexDepth(code);
      if (opacity) code = opacityDepth(code, 0);
      if (section) {
        code = code
          .replace('struct Out {', 'struct Out {@location(2) position:vec3f,')
          .replace(/o.clip=f.camera\*([^;]+);/, 'let world=$1;o.clip=f.camera*world;o.position=world.xyz;');
        code = sectionShader(code, 0, 3, 'section');
      }
      const module = this.device!.createShaderModule({ code });
      pipeline = casterPipeline(this.device!, module, p.stride, !!displacement, !!inst, lines);
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  /** One draw of a caster with `matrix`: each draw in a frame needs its own uniform, since all upload before the pass runs. */
  private draw(pass: GPURenderPassEncoder, d: Draw, matrix: Float32Array, section?: GPUBufferBinding): void {
    const p = d.p,
      n = d.used++;
    if (!d.uniforms[n]) {
      const buffer = this.device!.createBuffer({
        size: p.alphaTransform ? 176 : 144,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      d.uniforms[n] = buffer;
      d.groups[n] = this.device!.createBindGroup({
        layout: d.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: p.alphaTexture ?? this.whiteView! },
          { binding: 2, resource: p.alphaSampler ?? this.alphaSampler! },
          ...(section ? [{ binding: 3, resource: section }] : []),
          ...(p.opacity ? opacityEntries(p.opacity) : []),
        ],
      });
    }
    drawCaster(
      pass,
      this.device!,
      d.pipeline,
      d.groups[n],
      d.uniforms[n],
      d.values as Float32Array<ArrayBuffer>,
      matrix,
      p,
      p.alphaTransform,
      d.displaced,
      p.instances,
    );
    this.stats.casterDraws++;
  }
  /**
   * This frame's pages: where each known caster reaches on the coarsest level, so a receiver never reads a hole whatever
   * feedback has seen yet, then what the newest feedback marked.
   */
  private request(): void {
    const pages = this.pages!,
      coarsest = pages.levels - 1;
    for (let i = 0; i < this.casters.length; i++) {
      const d = this.casters[i];
      if (d.radius === d.radius) pages.requestCircle(coarsest, d.x, d.y, d.radius, this.centers);
    }
    pages.requestFeedback(this.requests, this.requestCenters, this.centers);
  }
  /**
   * What changed since last frame: a still caster that moved or changed marks the pages of its old and new spheres stale,
   * one that started or stopped casting likewise, and a moving caster marks the pages it reaches for this frame's redraw.
   */
  private changes(serial: number): void {
    const pages = this.pages!;
    for (let i = 0; i < this.casters.length; i++) {
      const d = this.casters[i],
        p = d.p;
      if (!d.still) {
        if (d.radius === d.radius) pages.touchCircle(d.x, d.y, d.radius);
        else pages.touchAll();
        d.castSerial = serial;
        continue;
      }
      let changed = d.castSerial !== serial - 1;
      if (d.watched) {
        const seen = d.seen,
          m = p.node.matrix,
          t = p.alphaTransform,
          tail = t ? t.length : 0;
        for (let k = 0; k < 16; k++)
          if (seen[k] !== m[k]) {
            seen[k] = m[k];
            changed = true;
          }
        for (let k = 0; k < 4; k++) {
          const v = Math.fround(
            k === 0 ? (p.alpha ?? 1) : k === 1 ? (p.cutoff ?? 0) : k === 2 ? (p.texCoord ?? 0) : p.count,
          );
          if (seen[16 + k] !== v) {
            seen[16 + k] = v;
            changed = true;
          }
        }
        for (let k = 0; k < tail; k++)
          if (seen[20 + k] !== t![k]) {
            seen[20 + k] = t![k];
            changed = true;
          }
      }
      if (changed) {
        this.staleSphere(d.lastX, d.lastY, d.lastRadius);
        this.staleSphere(d.x, d.y, d.radius);
      }
      d.castSerial = serial;
      d.lastX = d.x;
      d.lastY = d.y;
      d.lastRadius = d.radius;
    }
    for (let i = 0; i < this.previous.length; i++) {
      const d = this.previous[i];
      if (d.castSerial !== serial) {
        if (d.still) this.staleSphere(d.lastX, d.lastY, d.lastRadius);
        // Its record may still be drawn as a plain receiver: it casts afresh when it comes back.
        d.castSerial = -1;
      }
    }
  }
  private staleSphere(x: number, y: number, radius: number): void {
    if (radius === radius) this.pages!.invalidateCircle(x, y, radius);
    else this.pages!.invalidateAll();
  }
  /** Depth of everything that receives, from the camera at half size, then the compute pass that marks its pages. */
  private feedback(c: VirtualPassContext): void {
    const device = c.device,
      width = Math.max(1, c.width >> 1),
      height = Math.max(1, c.height >> 1),
      slot = this.ring[this.ringNext];
    // Both read buffers on their way back: the newest feedback stays in use one frame longer.
    if (slot.busy) return;
    if (this.feedbackDepth?.width !== width || this.feedbackDepth.height !== height) {
      this.feedbackDepth?.destroy();
      this.feedbackDepth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.feedbackView = this.feedbackDepth.createView();
      this.feedbackGroup = undefined;
    }
    const pass = c.encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.feedbackView!,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      }),
      matrix = this.cameraMatrix,
      section = sectionState(c);
    try {
      for (let i = 0; i < this.receivers.length; i++) this.draw(pass, this.receivers[i], matrix, section);
      for (const source of this.customReceivers) source.drawShadow?.({ context: c, pass, matrix, cascade: 0 });
    } catch (error) {
      try {
        pass.end();
      } catch {}
      throw error;
    }
    pass.end();
    this.feedbackPipeline ??= device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: pageFeedback }), entryPoint: 'main' },
    });
    this.feedbackGroup ??= device.createBindGroup({
      layout: this.feedbackPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: this.feedbackView! },
        { binding: 2, resource: { buffer: this.requestBuffer! } },
      ],
    });
    c.encoder.clearBuffer(this.requestBuffer!);
    const compute = c.encoder.beginComputePass();
    compute.setPipeline(this.feedbackPipeline);
    compute.setBindGroup(0, this.feedbackGroup);
    compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    compute.end();
    c.encoder.copyBufferToBuffer(this.requestBuffer!, 0, slot.buffer, 0, slot.buffer.size);
    slot.busy = true;
    slot.centers.set(this.centers);
    this.ringNext ^= 1;
    // After this frame's submit, which runs synchronously once the frame graph returns: a buffer may not be mapped before.
    queueMicrotask(() => {
      slot.buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          this.requests.set(new Uint32Array(slot.buffer.getMappedRange()));
          this.requestCenters.set(slot.centers);
          slot.buffer.unmap();
          slot.busy = false;
        },
        // The buffer went with its device or with dispose: nothing is waiting for it.
        () => {
          slot.busy = false;
        },
      );
    });
  }
  private render(c: VirtualPassContext): void {
    this.validate();
    const pages = this.pages!,
      o = this.options,
      values = this.values,
      levels = pages.levels,
      distance = o.distance ?? 500,
      camera = c.camera.position;
    this.basis();
    // Depth is absolute along the light in steps of `distance`: pages keep their values while the camera stays in a step.
    const along = camera[0] * this.forward[0] + camera[1] * this.forward[1] + camera[2] * this.forward[2],
      margin = o.casterMargin ?? 100,
      origin = Math.floor((along - distance - margin) / distance) * distance,
      range = 3 * distance + margin;
    if (origin !== this.origin) {
      this.origin = origin;
      this.dirty = true;
    }
    const cameraX = camera[0] * this.right[0] + camera[1] * this.right[1] + camera[2] * this.right[2],
      cameraY = camera[0] * this.up[0] + camera[1] * this.up[1] + camera[2] * this.up[2];
    for (let level = 0; level < levels; level++) {
      const size = pageSize(pages.base, level),
        x = pageIndex(cameraX, size),
        y = pageIndex(cameraY, size),
        at = 36 + level * 4;
      this.centers[level * 2] = x;
      this.centers[level * 2 + 1] = y;
      values[at] = x;
      values[at + 1] = y;
      values[at + 3] = size;
    }
    viewMatrix(this.view, c.camera);
    // Core's depth is reversed (near 1) and the caster pipelines keep the smallest: feedback's camera flips it.
    const flip = this.cameraMatrix;
    flip.set(c.camera.matrix);
    for (let k = 2; k < 16; k += 4) flip[k] = flip[k + 1] - flip[k];
    invert(values.subarray(100, 116), flip);
    values[27] = origin;
    values[28] = o.lightSize ?? 0.02;
    values[29] = o.bias ?? 0.002;
    values[30] = o.normalBias ?? 0.02;
    values[31] = c.height / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    values[32] = range;
    values[33] = PAGE_TEXELS / (o.poolSize ?? 4096);
    values[34] = levels;
    c.device.queue.writeBuffer(this.uniform!, 0, values as Float32Array<ArrayBuffer>);
    const serial = ++this.serial,
      section = sectionState(c);
    // Plane coefficients are live uniforms: redraw while a section is attached, and once after it goes.
    if (section || this.clipped) this.dirty = true;
    this.clipped = !!section;
    this.gather(serial, section);
    pages.beginFrame();
    this.request();
    this.changes(serial);
    if (this.dirty) {
      pages.invalidateAll();
      this.dirty = false;
    }
    pages.writeTable(this.table, this.centers);
    let same = true;
    for (let i = 0; same && i < this.table.length; i++) same = this.table[i] === this.uploaded[i];
    if (!same) {
      this.nearestStale = true;
      this.uploaded.set(this.table);
      c.device.queue.writeTexture(
        { texture: this.tableTexture! },
        this.table as Uint32Array<ArrayBuffer>,
        { bytesPerRow: PAGES_PER_SIDE * 4, rowsPerImage: PAGES_PER_SIDE },
        [PAGES_PER_SIDE, PAGES_PER_SIDE, levels],
      );
    }
    this.stats.residentPages = pages.resident;
    this.stats.levelPages = Array.from(pages.requested);
    this.stats.overflow = pages.overflow;
    this.stats.pagesRendered = 0;
    this.feedback(c);
    this.stats.casterDraws = 0;
    this.drawPages(c, origin, range);
    if ((o.filter ?? 'soft') === 'soft' && this.nearestStale) this.nearest(c);
  }
  /** Reduces each level's mapped pages to the level's nearest depth for the PCSS search, when pages changed. */
  private nearest(c: VirtualPassContext): void {
    const device = c.device;
    this.nearestPipeline ??= device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: pageNearest }), entryPoint: 'main' },
    });
    this.nearestGroup ??= device.createBindGroup({
      layout: this.nearestPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.entries[1].resource },
        { binding: 1, resource: this.entries[3].resource },
        { binding: 2, resource: { buffer: this.nearestBuffer! } },
      ],
    });
    device.queue.writeBuffer(this.nearestBuffer!, 0, this.nearestSeed);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.nearestPipeline);
    pass.setBindGroup(0, this.nearestGroup);
    pass.dispatchWorkgroups(PAGES_PER_SIDE, PAGES_PER_SIDE, this.pages!.levels);
    pass.end();
    c.encoder.copyBufferToBuffer(this.nearestBuffer!, 0, this.uniform!, 464, 64);
    this.nearestStale = false;
  }
  /**
   * The frame's page work, two render passes at most. Stale pages clear and draw their still casters into the still pool.
   * In the sampled pool, a page that changed or that a moving caster reaches now or reached last frame takes the still
   * page back, and the moving casters that reach it draw over it.
   */
  private drawPages(c: VirtualPassContext, origin: number, range: number): void {
    const pages = this.pages!,
      device = c.device,
      section = sectionState(c),
      stale = pages.stale,
      touched = pages.touched,
      before = pages.touchedBefore,
      capacity = pages.capacity;
    const depth = (view: GPUTextureView): GPURenderPassDescriptor => ({
      colorAttachments: [],
      depthStencilAttachment: { view, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    const module = device.createShaderModule;
    this.clearPipeline ??= device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: module.call(device, { code: pageClear }), entryPoint: 'vertex' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    if (!this.copyPipeline) {
      this.copyPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: module.call(device, { code: pageClear }), entryPoint: 'vertex' },
        fragment: { module: module.call(device, { code: pageCopy }), entryPoint: 'fragment', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      });
      this.copyGroup = device.createBindGroup({
        layout: this.copyPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: this.cachedView! }],
      });
    }
    let pass: GPURenderPassEncoder | undefined;
    try {
      for (let slot = 0; slot < capacity; slot++) {
        if (!stale[slot] || !pages.isUsed(slot)) continue;
        pass ??= c.encoder.beginRenderPass(depth(this.cachedView!));
        this.pageTarget(pass, slot, origin, range);
        pass.setPipeline(this.clearPipeline);
        pass.draw(3);
        for (let i = 0; i < this.casters.length; i++) {
          const d = this.casters[i];
          if (d.still && this.reaches(d, slot)) this.draw(pass, d, this.pageCamera, section);
        }
        this.stats.pagesRendered++;
      }
      pass?.end();
      pass = undefined;
      for (let slot = 0; slot < capacity; slot++) {
        if (!(stale[slot] || touched[slot] || before[slot]) || !pages.isUsed(slot)) continue;
        this.nearestStale = true;
        pass ??= c.encoder.beginRenderPass(depth(this.entries[1].resource as GPUTextureView));
        this.pageTarget(pass, slot, origin, range);
        pass.setPipeline(this.copyPipeline);
        pass.setBindGroup(0, this.copyGroup!);
        pass.draw(3);
        if (touched[slot]) {
          for (let i = 0; i < this.casters.length; i++) {
            const d = this.casters[i];
            if (!d.still && this.reaches(d, slot)) this.draw(pass, d, this.pageCamera, section);
          }
          if (!stale[slot]) this.stats.pagesRendered++;
        }
        stale[slot] = 0;
      }
    } catch (error) {
      try {
        pass?.end();
      } catch {}
      throw error;
    }
    pass?.end();
  }
  /** An unknown radius (NaN) reaches every page. */
  private reaches(d: Draw, slot: number): boolean {
    return d.radius !== d.radius || this.pages!.reaches(slot, d.x, d.y, d.radius);
  }
  /** Points `pass` at the page's rectangle (the same in both pools) and sets `pageCamera` to its matrix. */
  private pageTarget(pass: GPURenderPassEncoder, slot: number, origin: number, range: number): void {
    const pages = this.pages!,
      address = pages.address(slot, this.address),
      x = (slot % pages.poolPages) * PAGE_TEXELS,
      y = Math.floor(slot / pages.poolPages) * PAGE_TEXELS;
    pass.setViewport(x, y, PAGE_TEXELS, PAGE_TEXELS, 0, 1);
    pass.setScissorRect(x, y, PAGE_TEXELS, PAGE_TEXELS);
    pageMatrix(
      this.pageCamera,
      this.right,
      this.up,
      this.forward,
      origin,
      range,
      pageSize(pages.base, address[0]),
      address[1],
      address[2],
    );
  }
  private clearDraws(): void {
    for (const records of this.draws.values())
      for (const r of records.values()) for (const b of r.uniforms) b.destroy();
    this.draws.clear();
  }
  private release(): void {
    this.clearDraws();
    for (const texture of [this.pool, this.cached, this.tableTexture, this.white]) texture?.destroy();
    this.uniform?.destroy();
    this.requestBuffer?.destroy();
    this.nearestBuffer?.destroy();
    this.nearestBuffer = this.nearestPipeline = this.nearestGroup = undefined;
    this.nearestStale = true;
    this.feedbackDepth?.destroy();
    for (const slot of this.ring) slot.buffer.destroy();
    this.ring = [];
    this.requestBuffer =
      this.feedbackDepth =
      this.feedbackView =
      this.feedbackPipeline =
      this.feedbackGroup =
        undefined;
    this.ringNext = 0;
    this.pool = this.cached = this.tableTexture = this.white = undefined;
    this.uniform = undefined;
    this.whiteView = undefined;
    this.pages = undefined;
    this.clearPipeline = this.copyPipeline = undefined;
    this.copyGroup = undefined;
    this.cachedView = undefined;
    this.casters.length = this.previous.length = 0;
    this.pipelines.clear();
    this.shaders.clear();
    this.hooks.clear();
    this.entries = [];
  }
  /** Rebuilds the GPU resources after a lost device. */
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** Removes the effect and frees its GPU memory. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    for (const r of this.sources) r.removeLighting?.();
    this.sources.length = 0;
    this.casters.length = this.receivers.length = this.customReceivers.length = 0;
    this.loose.clear();
    this.lightingOwners.clear();
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
