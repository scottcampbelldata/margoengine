/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { Geometry, type Mesh } from '@margoengine/core';
import {
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { Imposter, ImposterFrames, imposterMaskShader, imposterShader, imposterShadowShader } from './imposter.js';
export {
  Imposter,
  ImposterFrames,
  octEncode,
  octDecode,
  frameDirection,
  frameBasis,
  frameMatrix,
  bakeShader,
  imposterShader,
  type ImposterData,
  type ImposterFramesOptions,
  type ImposterOptions,
  type ImposterSource,
} from './imposter.js';
export { normalMatrix } from './attributes.js';
import { MargoError } from '@margoengine/math/errors';
import { overlayDepthPass } from '../../shared/pass.js';
import { worldRadius } from '../../shared/sphere.js';
import { meshTriangles } from '../../shared/mesh-source.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** What a level shows: a core Mesh or a model with a `root` Mesh (gltf-pro, materials), toggled through `visible`; a core Geometry swapped onto the anchor; an Imposter or ImposterFrames; or null (nothing). */
export type LODObject = Mesh | { readonly root: Mesh } | Geometry | Imposter | ImposterFrames | DeferredLevel | null;
/** A level that is not always there (`@margoengine/lod/stream`): while `request` says no, the system keeps showing what it has. */
export interface DeferredLevel {
  visible: boolean;
  /** Asked each frame the level is wanted. True when it can show now. */
  request(): boolean;
}
/** `distance` (world units from the camera to the anchor) or `screen` (bounding-sphere height as a fraction of the viewport height); every level of one LOD uses the same one. Level 0's value is ignored. */
export interface LODLevel {
  object: LODObject;
  distance?: number;
  screen?: number;
  /** Fraction the switch distance shrinks by while this level is shown. */
  hysteresis?: number;
}
/** Per-object settings of `LODSystem.add`. */
export interface LODOptions {
  /** Local bounding radius for `screen` levels and imposter culling. Default: from a Geometry, Mesh or Imposter level. */ radius?: number;
  /** Linear RGB, multiplies the albedo while an imposter level shows. Default white. */
  color?: readonly number[];
  /** Linear RGB added to the lit colour while an imposter level shows. Default black. */
  emissive?: readonly number[];
  /** First frame of an `ImposterFrames` level, whole or not, as an offset so copies do not move in step. Default 0. */
  frame?: number;
}
/** Hooks of a lighting effect an imposter takes, as `Shadows` gives them; only `direct` applies. */
export interface ImposterLighting {
  pbr?(group: number): { declarations: string; direct?(direct: string): string } | undefined;
  bindings(): GPUBindGroupEntry[];
}
/** `LODSystem` settings shared by every object it manages. */
export interface LODSystemOptions {
  /** Default hysteresis per level. Default 0.1. */ hysteresis?: number;
  /** Multiplies every evaluated distance: above 1 switches to coarser levels sooner (a quality knob). Default 1. */
  bias?: number;
}
/** One object of a gltf-pro model's `lods`, as `LOD.fromModel` reads it. */
export interface LODModelEntry {
  node: Mesh;
  levels: readonly Mesh[];
  screenCoverage?: readonly number[];
}
/** Most levels per LOD. */
export const MAX_LEVELS = 8;

/** One registered object; `level` is the index shown (-1 before the first frame). */
export class LOD {
  /** Local bounding sphere (x, y, z, radius) of the level shown, written by `LODSystem.pickProxies()`. */
  readonly sphere = new Float64Array(4);
  /** The first gltf-pro model among the levels, reported with approximate pick hits; null without one. */
  readonly model: { readonly root: Mesh } | null;
  /** Live {@link LODOptions.color}, read each frame an imposter level shows. */
  readonly color = new Float32Array([1, 1, 1]);
  /** Live {@link LODOptions.emissive}. */
  readonly emissive = new Float32Array(3);
  /** Live {@link LODOptions.frame}. */
  frame = 0;
  /** @internal */ constructor(
    private readonly system: LODSystem,
    /** @internal */ public index: number,
    readonly anchor: Mesh,
    readonly levels: readonly LODLevel[],
  ) {
    this.model =
      (levels.find(
        (l) => (l.object as { root?: Mesh } | null)?.root && (l.object as { primitives?: unknown }).primitives,
      )?.object as { root: Mesh }) ?? null;
  }
  get level(): number {
    return this.system.levelOf(this);
  }
  /**
   * Registers each `MSFT_lod` object of a gltf-pro `model` in `system`, its `screenCoverage` as the `screen` levels
   * (default 0.25, halved per level). An extra last coverage entry adds an empty level, which hides the object.
   * @throws as {@link LODSystem.add}.
   */
  static fromModel(system: LODSystem, model: { readonly lods: readonly LODModelEntry[] }): LOD[] {
    return model.lods.map(({ node, levels, screenCoverage: coverage }) => {
      const out: LODLevel[] = levels.map((object, i) =>
        i ? { object, screen: coverage?.[i - 1] ?? 0.25 * 0.5 ** (i - 1) } : { object },
      );
      if (coverage?.length === levels.length) out.push({ object: null, screen: coverage[levels.length - 1] });
      let radius = 0;
      const source = node as unknown as { readonly geometry?: Geometry };
      for (const level of levels) {
        const triangles = meshTriangles(level),
          box = triangles?.kind === 'pbr' ? triangles.source.bounds : undefined;
        if (box)
          radius = Math.max(
            radius,
            Math.hypot(Math.max(-box[0], box[3]), Math.max(-box[1], box[4]), Math.max(-box[2], box[5])),
          );
      }
      return system.add(node, out, { radius: radius || source.geometry?.bounds[3] || 1 });
    });
  }
  /** Stops managing the object; the level shown stays shown. */
  remove(): void {
    this.system.remove(this);
  }
}
interface Atlas {
  imposter: Imposter;
  /** Set on the first atlas of an ImposterFrames level; its other frames are the next atlases. */
  frames?: ImposterFrames;
  users: number;
  data: Float32Array;
  count: number;
  buffer?: GPUBuffer;
  group?: GPUBindGroup;
  texture?: GPUTexture;
  pipeline?: GPURenderPipeline;
  /** Casters: the instances the camera culled too, since they can still shadow what it sees. */
  cast: Float32Array;
  castCount: number;
  castBuffer?: GPUBuffer;
  castGroups: GPUBindGroup[];
  castTexture?: GPUTexture;
  /** Selected instances, for the selection's mask: a buffer of their own, since the beauty pass reads `buffer`. */
  mask: Float32Array;
  maskCount: number;
  maskBuffer?: GPUBuffer;
  maskGroup?: GPUBindGroup;
  maskTexture?: GPUTexture;
  maskPipeline?: GPURenderPipeline;
}
/** Floats per instance: matrix, colour, emissive. */
const STRIDE = 24;
const isImposter = (o: LODObject): o is Imposter | ImposterFrames =>
  o instanceof Imposter || o instanceof ImposterFrames;
const target = (o: Mesh | { readonly root: Mesh } | DeferredLevel) => ('root' in o ? o.root : o);
let serial = 0;

/**
 * Level of detail for many objects at once. Every frame (before the transform tick) one loop over packed arrays picks
 * each object's level from its anchor's world position, with hysteresis, and only touches objects whose level changed;
 * it allocates nothing. Imposter levels draw as one instanced call per atlas after the opaque passes.
 * @throws RangeError / TypeError from `add` and the constructor when options or levels are invalid.
 * @throws MargoError `'state'` from `add` before the system is used on an engine.
 */
export class LODSystem implements EnginePlugin {
  readonly name = 'lod:' + serial++;
  hysteresis: number;
  bias: number;
  private engine?: Engine;
  private count = 0;
  private dirty = false;
  private ids = new Int32Array(0);
  private counts = new Uint8Array(0);
  private current = new Int8Array(0);
  private screen = new Uint8Array(0);
  private swaps = new Uint8Array(0);
  private radius = new Float32Array(0);
  private readonly proxies: LOD[] = [];
  private thresholds = new Float32Array(0);
  private bands = new Float32Array(0);
  private slots = new Int16Array(0);
  private levelSlots = new Int16Array(0);
  private anchors: Mesh[] = [];
  private objects: LODObject[][] = [];
  private handles: LOD[] = [];
  private atlases: Atlas[] = [];
  private readonly keepers = new Map<Geometry, Mesh>();
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private pipeline?: GPURenderPipeline;
  private format?: string;
  private samples = 0;
  private depthFormat?: string;
  private readonly frame = new Float32Array(32);
  private time = 0;
  private readonly effects = new Set<ImposterLighting>();
  private code = imposterShader;
  private lit?: GPUBindGroup;
  private castPipeline?: GPURenderPipeline;
  private castUniform?: GPUBuffer;
  private readonly castValues = new Float32Array(20);
  private readonly maskPipelines = new Map<string, GPURenderPipeline>();
  private transition?: (lod: LOD, from: number, to: number) => boolean;
  private readonly descriptor = overlayDepthPass();
  private readonly color = this.descriptor.colorAttachments[0];
  private readonly depth = this.descriptor.depthStencilAttachment;
  /** Same as `engine.use(new LODSystem(...))`; returns the LODSystem. */
  static attach(engine: EngineKernel, options?: LODSystemOptions): LODSystem {
    const value = new LODSystem(options);
    engine.use(value);
    return value;
  }
  constructor({ hysteresis = 0.1, bias = 1 }: LODSystemOptions = {}) {
    if (!(hysteresis >= 0 && hysteresis < 1) || !(bias > 0 && bias < Infinity))
      throw new RangeError('Invalid LOD options; pass the documented option types');
    this.hysteresis = hysteresis;
    this.bias = bias;
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta = 0): void {
    this.time += delta;
    this.update();
  }
  get size(): number {
    return this.count;
  }

  /** Registers an object. `anchor` gives the world transform (and receives Geometry levels); level objects are usually its children. */
  add(anchor: Mesh, levels: readonly LODLevel[], { radius, color, emissive, frame = 0 }: LODOptions = {}): LOD {
    const e = this.engine;
    if (!e) throw new MargoError('state', 'Use the LOD system on an engine first');
    const mesh = meshRuntime(anchor);
    mesh.check();
    if (mesh.engine !== e) throw new TypeError('Anchor belongs to another engine; use an anchor from this engine');
    const n = levels?.length,
      screen = levels?.[1]?.screen !== undefined;
    if (!Number.isInteger(n) || n < 1 || n > MAX_LEVELS) throw new RangeError('LOD needs 1-8 levels');
    if (this.count === this.ids.length) this.grow(Math.max(16, this.count * 2));
    const i = this.count,
      b = i * MAX_LEVELS;
    let previous = 0,
      swap = false;
    for (let l = 0; l < n; l++) {
      const { object, distance, screen: size, hysteresis = this.hysteresis } = levels[l];
      if (
        !(
          object === null ||
          object instanceof Geometry ||
          isImposter(object) ||
          typeof (object as Mesh)?.visible === 'boolean' ||
          typeof (object as { root: Mesh })?.root?.visible === 'boolean'
        )
      )
        throw new TypeError('Invalid LOD level object; pass a mesh or a function that builds one');
      const value = l === 0 ? 0 : screen ? 1 / (size as number) : (distance as number);
      if (
        (l > 0 &&
          (screen
            ? distance !== undefined || !(size! > 0 && size! <= 1e6)
            : size !== undefined || !(distance! >= 0 && distance! < Infinity))) ||
        !(value >= previous) ||
        !(hysteresis >= 0 && hysteresis < 1)
      )
        throw new RangeError('LOD levels need increasing distances or decreasing screen sizes');
      previous = value;
      this.thresholds[b + l] = value;
      this.bands[b + l] = hysteresis;
      this.levelSlots[b + l] = isImposter(object) ? this.atlas(object) : -1;
      if (object instanceof Geometry) {
        swap = true;
        if (!this.keepers.has(object)) {
          const keeper = e.createMesh().setGeometry(object);
          keeper.visible = false;
          this.keepers.set(object, keeper);
        }
      } else if (object && !isImposter(object)) target(object as Mesh).visible = false;
    }
    const sized = levels.find(
      (l) =>
        l.object instanceof Geometry ||
        isImposter(l.object) ||
        (l.object as { geometry?: Geometry } | null)?.geometry instanceof Geometry,
    )?.object as Geometry | Imposter | ImposterFrames | { geometry?: Geometry } | undefined;
    const r =
      radius ??
      (sized instanceof Imposter || sized instanceof ImposterFrames
        ? sized.radius
        : sized instanceof Geometry
          ? sized.bounds[3]
          : (sized?.geometry?.bounds[3] ?? mesh.geometry?.bounds[3] ?? 1));
    if (!(r > 0 && r < Infinity)) throw new RangeError('Invalid LOD radius; pass a finite radius above 0');
    this.ids[i] = mesh.id;
    this.counts[i] = n;
    this.current[i] = -1;
    this.screen[i] = +screen;
    this.swaps[i] = +swap;
    this.radius[i] = r;
    this.slots[i] = -1;
    const handle = new LOD(this, i, anchor, [...levels]);
    if (color) handle.color.set(color);
    if (emissive) handle.emissive.set(emissive);
    handle.frame = frame;
    this.anchors[i] = anchor;
    this.objects[i] = handle.levels.map((l) => l.object);
    this.handles[i] = handle;
    this.count++;
    this.dirty = true;
    return handle;
  }
  /** @internal */ levelOf(lod: LOD): number {
    return this.handles[lod.index] === lod ? this.current[lod.index] : -1;
  }
  /**
   * Objects showing an Imposter level (no triangles to hit), with `sphere` set to the imposter's local bounding sphere.
   * @margoengine/bvh raycasts and @margoengine/selection picking find this hook on the engine and hit the sphere under the
   * anchor's world matrix, flagged approximate. Reuses one array; call again for fresh results.
   */
  pickProxies(): readonly LOD[] {
    const out = this.proxies;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const slot = this.slots[i];
      if (slot < 0) continue;
      const h = this.handles[i],
        imp = this.atlases[slot].imposter,
        s = h.sphere;
      s[0] = imp.center[0];
      s[1] = imp.center[1];
      s[2] = imp.center[2];
      s[3] = imp.radius;
      out[n++] = h;
    }
    out.length = n;
    return out;
  }
  /** @internal */ remove(lod: LOD): void {
    const i = lod.index;
    if (this.handles[i] !== lod) return;
    const last = --this.count,
      b = i * MAX_LEVELS,
      lb = last * MAX_LEVELS;
    for (let l = 0; l < this.counts[i]; l++) {
      const slot = this.levelSlots[b + l];
      if (slot >= 0)
        for (let k = this.atlases[slot].frames?.imposters.length ?? 1; k-- > 0; ) this.atlases[slot + k].users--;
    }
    for (const a of [this.ids, this.counts, this.current, this.screen, this.swaps, this.radius, this.slots])
      a[i] = a[last];
    for (const a of [this.thresholds, this.bands, this.levelSlots]) a.copyWithin(b, lb, lb + MAX_LEVELS);
    this.anchors[i] = this.anchors[last];
    this.objects[i] = this.objects[last];
    this.handles[i] = this.handles[last];
    this.handles[i].index = i;
    this.anchors.length = this.objects.length = this.handles.length = last;
    lod.index = -1;
  }
  private grow(size: number): void {
    const copy = <T extends Int32Array | Uint8Array | Int8Array | Float32Array | Int16Array>(a: T, stride = 1): T => {
      const out = new (a.constructor as { new (length: number): T })(size * stride);
      out.set(a);
      return out;
    };
    this.ids = copy(this.ids);
    this.counts = copy(this.counts);
    this.current = copy(this.current);
    this.screen = copy(this.screen);
    this.swaps = copy(this.swaps);
    this.radius = copy(this.radius);
    this.slots = copy(this.slots);
    this.thresholds = copy(this.thresholds, MAX_LEVELS);
    this.bands = copy(this.bands, MAX_LEVELS);
    this.levelSlots = copy(this.levelSlots, MAX_LEVELS);
  }
  private atlas(object: Imposter | ImposterFrames): number {
    const list = object instanceof Imposter ? [object] : object.imposters;
    let s = this.atlases.findIndex((a) => a.imposter === list[0]);
    if (s < 0) {
      s = this.atlases.length;
      for (const imposter of list)
        this.atlases.push({
          imposter,
          users: 0,
          data: new Float32Array(0),
          count: 0,
          cast: new Float32Array(0),
          castCount: 0,
          castGroups: [],
          mask: new Float32Array(0),
          maskCount: 0,
        });
      if (object instanceof ImposterFrames) this.atlases[s].frames = object;
    }
    for (let k = 0; k < list.length; k++) {
      const a = this.atlases[s + k];
      if (++a.users * STRIDE > a.data.length) {
        const size = Math.max(a.users * STRIDE, a.data.length * 2),
          data = new Float32Array(size),
          cast = new Float32Array(size);
        data.set(a.data);
        a.data = data;
        a.cast = cast;
      }
    }
    return s;
  }
  /** The atlas object `i` draws from now: its level's, or for ImposterFrames the frame its time has reached. */
  private slotOf(i: number): number {
    const s = this.slots[i],
      frames = this.atlases[s].frames;
    if (!frames) return s;
    const n = frames.imposters.length,
      at = Math.floor(this.handles[i].frame + this.time * frames.fps);
    return s + (((at % n) + n) % n);
  }
  /** Writes object `i`'s instance record: world matrix `m` at `o`, then its colour and emissive. */
  private record(data: Float32Array, at: number, m: Float32Array, o: number, i: number): void {
    const h = this.handles[i];
    for (let j = 0; j < 16; j++) data[at + j] = m[o + j];
    for (let j = 0; j < 3; j++) {
      data[at + 16 + j] = h.color[j];
      data[at + 20 + j] = h.emissive[j];
    }
  }

  /**
   * Hands level switches to `transition` (`@margoengine/lod/fade` does this): it returns true when it has taken a switch
   * and shows the new level itself, false to leave it to the system. One at a time. Returns the remover.
   * @throws MargoError `'state'` when another transition is set.
   */
  setTransition(transition: (lod: LOD, from: number, to: number) => boolean): () => void {
    if (this.transition) throw new MargoError('state', 'LODSystem has a transition; remove it first');
    this.transition = transition;
    return () => {
      if (this.transition === transition) this.transition = undefined;
    };
  }
  /** Picks every object's level. Runs automatically before each frame; call it yourself only without `engine.render`. */
  update(): void {
    const e = this.engine;
    if (!e) return;
    if (this.dirty) {
      e.store.tick(false);
      this.dirty = false;
    }
    for (let s = 0; s < this.atlases.length; s++) this.atlases[s].imposter.ready();
    // Screen levels use the camera's clip matrix: w is view depth in perspective and 1 in orthographic, and the y row's
    // length is the projection's y scale, so orthographic zoom (e.g. @margoengine/cameras) changes levels as expected.
    const m = e.store.matrices,
      p = e.camera.position,
      ex = p[0],
      ey = p[1],
      ez = p[2],
      c = e.camera.matrix,
      yScale = Math.hypot(c[1], c[5], c[9]) || 1 / Math.tan((e.camera.fov * Math.PI) / 360),
      bias = this.bias,
      ids = this.ids,
      counts = this.counts,
      current = this.current,
      thresholds = this.thresholds,
      bands = this.bands;
    for (let i = 0; i < this.count; i++) {
      const o = ids[i] * 16,
        dx = m[o + 12] - ex,
        dy = m[o + 13] - ey,
        dz = m[o + 14] - ez;
      let v = Math.sqrt(dx * dx + dy * dy + dz * dz) * bias;
      if (this.screen[i]) {
        const sx = m[o] * m[o] + m[o + 1] * m[o + 1] + m[o + 2] * m[o + 2],
          sy = m[o + 4] * m[o + 4] + m[o + 5] * m[o + 5] + m[o + 6] * m[o + 6],
          sz = m[o + 8] * m[o + 8] + m[o + 9] * m[o + 9] + m[o + 10] * m[o + 10];
        const w =
          c[3] || c[7] || c[11] || c[15]
            ? Math.abs(c[3] * m[o + 12] + c[7] * m[o + 13] + c[11] * m[o + 14] + c[15])
            : v / bias;
        v = (bias * w) / (yScale * this.radius[i] * Math.sqrt(Math.max(sx, sy, sz)));
      }
      // Level choice, a dead band around each switch point (Schmitt trigger). The plain pick is the coarsest level
      // whose threshold v has reached (equality counts). Going coarser is never delayed; going finer from the shown
      // level s waits until v drops below s's threshold lowered by its own band, t_s * (1 - h_s). While v is inside
      // that band, s holds even when the band reaches past finer thresholds.
      const b = i * MAX_LEVELS,
        n = counts[i],
        shown = current[i];
      let next = 0;
      while (next + 1 < n && v >= thresholds[b + next + 1]) next++;
      if (next < shown && v >= thresholds[b + shown] * (1 - bands[b + shown])) next = shown;
      if (next !== shown) next = this.reachable(i, next, shown);
      if (next !== shown) this.show(i, shown, next);
    }
  }
  /**
   * The level to show for a wish of `next`: the first that can show, walking from it towards the level on show, or
   * towards coarser levels when none is yet. A level that needs no fetch always can.
   */
  private reachable(i: number, next: number, shown: number): number {
    const objects = this.objects[i],
      step = shown < 0 || next < shown ? 1 : -1;
    for (let l = next; l >= 0 && l < objects.length && l !== shown; l += step) {
      const object = objects[l] as Partial<DeferredLevel> | null;
      if (!object?.request || object.request()) return l;
    }
    return shown;
  }
  private show(i: number, from: number, to: number): void {
    if (from >= 0 && this.transition?.(this.handles[i], from, to)) {
      this.current[i] = to;
      this.slots[i] = this.levelSlots[i * MAX_LEVELS + to];
      return;
    }
    const objects = this.objects[i],
      a = from < 0 ? null : objects[from],
      b = objects[to],
      anchor = this.anchors[i];
    if (a && !(a instanceof Geometry) && !isImposter(a)) target(a).visible = false;
    if (b instanceof Geometry) anchor.setGeometry(b);
    else {
      if (this.swaps[i] && anchor.geometry) anchor.setGeometry(null);
      if (b && !isImposter(b)) target(b).visible = true;
    }
    this.current[i] = to;
    this.slots[i] = this.levelSlots[i * MAX_LEVELS + to];
  }

  private draw(c: Context): void {
    const atlases = this.atlases;
    if (!atlases.length) return;
    const e = this.engine!,
      m = e.store.matrices,
      hidden = e.store.hidden,
      parents = e.store.parents,
      planes = c.camera.planes;
    let total = 0;
    for (let s = 0; s < atlases.length; s++) atlases[s].count = 0;
    for (let i = 0; i < this.count; i++) {
      const s = this.slots[i];
      if (s < 0) continue;
      let shown = true;
      for (let p = this.ids[i]; p >= 0; p = parents[p])
        if (hidden[p]) {
          shown = false;
          break;
        }
      if (!shown) continue;
      const a = atlases[this.slotOf(i)],
        imp = a.imposter,
        o = this.ids[i] * 16,
        k = imp.center;
      // Frustum cull the transformed bounding sphere.
      const x = m[o] * k[0] + m[o + 4] * k[1] + m[o + 8] * k[2] + m[o + 12],
        y = m[o + 1] * k[0] + m[o + 5] * k[1] + m[o + 9] * k[2] + m[o + 13],
        z = m[o + 2] * k[0] + m[o + 6] * k[1] + m[o + 10] * k[2] + m[o + 14];
      // A bound that holds under shear too (a rotated child of a non-uniformly scaled parent).
      const r = worldRadius(m, o, imp.radius, x, y, z);
      let inside = true;
      for (let q = 0; q < 24; q += 4)
        if (planes[q] * x + planes[q + 1] * y + planes[q + 2] * z + planes[q + 3] < -r) {
          inside = false;
          break;
        }
      if (!inside) continue;
      this.record(a.data, a.count++ * STRIDE, m, o, i);
      total++;
    }
    if (!total) return;
    const device = c.device,
      samples = c.descriptor.multisample?.count ?? 1;
    if (!this.uniform) {
      this.uniform = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
    }
    const f = this.frame;
    f.set(c.camera.matrix);
    f.set(c.camera.position, 16);
    f.set(e.lighting.direction, 20);
    f.set(e.lighting.radiance, 24);
    f[28] = +(c.format === 'rgba16float');
    f[29] = +(samples > 1);
    device.queue.writeBuffer(this.uniform, 0, f);
    const depthFormat = c.descriptor.depthStencil!.format,
      code = this.lightingCode();
    if (
      !this.pipeline ||
      c.format !== this.format ||
      samples !== this.samples ||
      depthFormat !== this.depthFormat ||
      code !== this.code
    ) {
      const module = device.createShaderModule({ code });
      this.code = code;
      this.format = c.format;
      this.samples = samples;
      this.depthFormat = depthFormat;
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater-equal' },
        multisample: { count: samples, alphaToCoverageEnabled: samples > 1 },
      });
    }
    this.color.view = c.color;
    this.depth.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.descriptor);
    pass.setPipeline(this.pipeline!);
    if (code !== imposterShader) {
      this.lit = device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(1),
        entries: [...this.effects].flatMap((effect) => effect.bindings()),
      });
      pass.setBindGroup(1, this.lit);
    }
    for (let s = 0; s < atlases.length; s++) {
      const a = atlases[s],
        imp = a.imposter;
      if (!a.count || !imp.ready()) continue;
      if (!a.buffer || a.buffer.size < a.data.byteLength) {
        a.buffer?.destroy();
        a.buffer = device.createBuffer({
          size: a.data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        a.group = undefined;
      }
      // Rebuild the bind group when the pipeline, instance buffer or atlas textures change (resize, device restore).
      if (!a.group || a.texture !== imp.color || a.pipeline !== this.pipeline) {
        a.texture = imp.color;
        a.pipeline = this.pipeline;
        a.group = device.createBindGroup({
          layout: this.pipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform } },
            { binding: 1, resource: { buffer: a.buffer } },
            { binding: 2, resource: imp.color!.createView() },
            { binding: 3, resource: imp.normal!.createView() },
            { binding: 4, resource: this.sampler! },
            { binding: 5, resource: { buffer: imp.uniform! } },
            { binding: 6, resource: imp.glow!.createView() },
          ],
        });
      }
      device.queue.writeBuffer(a.buffer, 0, a.data, 0, a.count * STRIDE);
      pass.setBindGroup(0, a.group);
      pass.draw(4, a.count);
    }
    pass.end();
  }
  /** The beauty shader with the lighting effects' hooks in, at group 1. */
  private lightingCode(): string {
    let declarations = '',
      direct = '';
    for (const effect of this.effects) {
      const hooks = effect.pbr?.(1);
      if (!hooks) continue;
      declarations += hooks.declarations + '\n';
      if (hooks.direct) direct += `direct=${hooks.direct('direct').replaceAll('i.position', 'world').replaceAll('s.n', 'nn')};`;
    }
    return direct ? declarations + imposterShader.replace('/*lod:direct*/', direct) : imposterShader;
  }
  /** Lets `@margoengine/shadows` shade imposters: `shadows.add(lods)` calls it. Returns the remover. */
  addLighting(effect: ImposterLighting): () => void {
    if (typeof effect?.bindings !== 'function')
      throw new TypeError('Imposter lighting needs an effect with bindings(); pass a Shadows');
    this.effects.add(effect);
    return () => {
      this.effects.delete(effect);
    };
  }
  /** Lists the casters once per shadow frame, past the camera's cull: `shadows.add(lods)` drives it. */
  prepareShadow({ context: c }: { context: Context }): void {
    const atlases = this.atlases,
      e = this.engine;
    if (!e || !atlases.length) return;
    const m = e.store.matrices,
      hidden = e.store.hidden,
      parents = e.store.parents,
      device = c.device;
    for (const a of atlases) a.castCount = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.slots[i] < 0) continue;
      let shown = true;
      for (let p = this.ids[i]; p >= 0 && shown; p = parents[p]) shown = !hidden[p];
      if (!shown) continue;
      const a = atlases[this.slotOf(i)];
      this.record(a.cast, a.castCount++ * STRIDE, m, this.ids[i] * 16, i);
    }
    for (const a of atlases) {
      if (!a.castCount) continue;
      if (!a.castBuffer || a.castBuffer.size < a.cast.byteLength) {
        a.castBuffer?.destroy();
        a.castBuffer = device.createBuffer({
          size: a.cast.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        a.castGroups = [];
      }
      device.queue.writeBuffer(a.castBuffer, 0, a.cast, 0, a.castCount * STRIDE);
    }
  }
  /** Draws the imposters into one cascade's depth map. */
  drawShadow({
    context: c,
    pass,
    matrix,
    cascade,
  }: {
    context: Context;
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    const device = c.device;
    if (!this.atlases.some((a) => a.castCount)) return;
    if (!this.castPipeline) {
      const module = device.createShaderModule({ code: imposterShadowShader });
      this.castPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [] },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
      this.castUniform = device.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    this.sampler ??= device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
    const v = this.castValues;
    v.set(matrix);
    v.set(this.engine!.lighting.direction, 16);
    device.queue.writeBuffer(this.castUniform!, cascade * 256, v);
    pass.setPipeline(this.castPipeline);
    for (const a of this.atlases) {
      const imp = a.imposter;
      if (!a.castCount || !imp.ready()) continue;
      if (a.castTexture !== imp.color) {
        a.castTexture = imp.color;
        a.castGroups = [];
      }
      const group = (a.castGroups[cascade] ??= device.createBindGroup({
        layout: this.castPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.castUniform!, offset: cascade * 256, size: 80 } },
          { binding: 1, resource: { buffer: a.castBuffer! } },
          { binding: 2, resource: imp.color!.createView() },
          { binding: 3, resource: imp.normal!.createView() },
          { binding: 4, resource: this.sampler },
          { binding: 5, resource: { buffer: imp.uniform! } },
        ],
      }));
      pass.setBindGroup(0, group);
      pass.draw(4, a.castCount);
    }
  }
  /** Whether object `i`'s anchor or any of its levels is in the selection. */
  private marked(i: number, selected: (id: number) => boolean): boolean {
    if (selected(this.ids[i])) return true;
    for (const object of this.objects[i]) {
      const mesh = (object as { model?: { root: Mesh } } | null)?.model?.root ?? (object as { root?: Mesh } | null)?.root ?? object,
        id = (mesh as { id?: number } | null)?.id;
      if (id !== undefined && selected(id)) return true;
    }
    return false;
  }
  /** Marks the selected objects on show as imposters in the mask of `@margoengine/selection`, which calls this. */
  drawSelectionMask({
    context: c,
    xray,
    selected,
    begin,
  }: {
    context: Context;
    xray: boolean;
    selected(id: number): boolean;
    begin(): GPURenderPassEncoder;
  }): void {
    const e = this.engine,
      atlases = this.atlases;
    if (!e || !this.uniform || !atlases.length) return;
    const m = e.store.matrices,
      parents = e.store.parents,
      hidden = e.store.hidden;
    let total = 0;
    for (const a of atlases) a.maskCount = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.slots[i] < 0 || !this.marked(i, selected)) continue;
      let shown = true;
      for (let p = this.ids[i]; p >= 0 && shown; p = parents[p]) shown = !hidden[p];
      if (!shown) continue;
      const a = atlases[this.slotOf(i)];
      if (a.mask.length < a.data.length) a.mask = new Float32Array(a.data.length);
      this.record(a.mask, a.maskCount++ * STRIDE, m, this.ids[i] * 16, i);
      total++;
    }
    if (!total) return;
    const device = c.device,
      format = c.descriptor.depthStencil!.format,
      samples = c.descriptor.multisample?.count ?? 1,
      key = `${format}|${samples}|${xray}`;
    let pipeline = this.maskPipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: imposterMaskShader });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r8unorm' }] },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format, depthWriteEnabled: false, depthCompare: xray ? 'always' : 'greater-equal' },
        multisample: { count: samples },
      });
      this.maskPipelines.set(key, pipeline);
    }
    const pass = begin();
    pass.setPipeline(pipeline);
    for (const a of atlases) {
      const imp = a.imposter;
      if (!a.maskCount || !imp.ready()) continue;
      if (!a.maskBuffer || a.maskBuffer.size < a.mask.byteLength) {
        a.maskBuffer?.destroy();
        a.maskBuffer = device.createBuffer({
          size: a.mask.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        a.maskGroup = undefined;
      }
      if (!a.maskGroup || a.maskTexture !== imp.color || a.maskPipeline !== pipeline) {
        a.maskTexture = imp.color;
        a.maskPipeline = pipeline;
        a.maskGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform } },
            { binding: 1, resource: { buffer: a.maskBuffer } },
            { binding: 2, resource: imp.color!.createView() },
            { binding: 3, resource: imp.normal!.createView() },
            { binding: 4, resource: this.sampler! },
            { binding: 5, resource: { buffer: imp.uniform! } },
            { binding: 6, resource: imp.glow!.createView() },
          ],
        });
      }
      device.queue.writeBuffer(a.maskBuffer, 0, a.mask, 0, a.maskCount * STRIDE);
      pass.setBindGroup(0, a.maskGroup);
      pass.draw(4, a.maskCount);
    }
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.castUniform?.destroy();
    for (const a of this.atlases) {
      a.buffer?.destroy();
      a.castBuffer?.destroy();
      a.maskBuffer?.destroy();
      a.buffer = a.group = a.texture = a.pipeline = a.castBuffer = a.castTexture = undefined;
      a.maskBuffer = a.maskGroup = a.maskTexture = a.maskPipeline = undefined;
      a.castGroups = [];
      a.castCount = 0;
    }
    this.maskPipelines.clear();
    this.uniform = this.sampler = this.pipeline = this.castPipeline = this.castUniform = undefined;
  }
  onDeviceRestored(): void {
    this.release();
  }
  /** Removes the keeper meshes and GPU resources; level objects keep their current visibility. Imposters are not disposed. */
  dispose(): void {
    this.release();
    for (const keeper of this.keepers.values()) keeper.dispose();
    this.keepers.clear();
    for (const h of this.handles) h.index = -1;
    this.anchors = [];
    this.objects = [];
    this.handles = [];
    this.atlases = [];
    this.proxies.length = 0;
    this.count = 0;
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
