// @margoengine/clustered/bounce: one bounce of light from point, spot and opening lights. The maths (capture views,
// reduction to virtual point lights, imperfect shadow maps, the packed lit-shader data and its JS twin) are in
// bounce-math.ts, with their sources.
export {
  BOUNCE_BINDING,
  CUBE_FACES,
  OPEN,
  basis,
  bounceIrradiance,
  apertureWindow,
  bounceViews,
  bounceWgsl,
  buildVisibility,
  crossesOpening,
  packBounce,
  pointFalloff,
  rectIrradiance,
  reduceBounce,
  sampleSurfaces,
  setBounceScales,
  texelRay,
  texelSolidAngle,
  type BounceCapture,
  type BounceMesh,
  type BounceOpening,
  type BouncePoint,
  type BouncePointSource,
  type BounceRectSource,
  type BounceSource,
  type BounceView,
  type BounceVpl,
  type ReduceOptions,
  type SampleOptions,
} from './bounce-math.js';

import type { EngineKernel } from '@margoengine/core';
import {
  Camera,
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import type { RectAreaLight } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type {
  Clustered,
  ClusteredBounce,
  ClusteredLightRecord,
  ClusteredLightTerm,
  PointLight,
  SpotLight,
} from './index.js';
import {
  BOUNCE_BINDING,
  OPEN,
  bounceViews,
  bounceWgsl,
  buildVisibility,
  packBounce,
  reduceBounce,
  sampleSurfaces,
  setBounceScales,
  type BounceMesh,
  type BounceOpening,
  type BouncePoint,
  type BouncePointSource,
  type BounceSource,
  type BounceView,
  type BounceVpl,
} from './bounce-math.js';
import { termEmission, termState } from './bounce-terms.js';
import { capturePipeline, frameCapture } from '../../shared/frame-capture.js';
import { captureModel, drawCapture } from '../../shared/capture.js';
import { requireCompatTier } from '../../shared/compat.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { rectFrame } from '../../shared/rect-frame.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; MAP_READ: number; UNIFORM: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUMapMode: { READ: number };

/** The capture's own Frame, in core's group 0, beside the lit-shader hooks (bindings.test.js keeps them unique). */
const CAPTURE_BINDING = 165;
type GpuPass = Extract<PassContext, { backend: 'webgpu' }>;
/** The capture's output: diffuse albedo (Snow and every surface hook included) and the distance to the source. */
const CAPTURE_TAIL = 'return vec4f(i.color*(1.0-i.material.y),length(i.position-frame.eye.xyz));';
/**
 * The capture hook LightBounce gives models (gltf/pbr's `PBRCapture`, terrain's `TerrainCapture`, voxel's and water's;
 * declared here so clustered imports none of them): one rgba16float target holding the diffuse albedo and the distance
 * to the capture's eye, as the core capture writes it.
 */
export interface BounceModelCapture {
  declarations(code: string): string;
  readonly targets: readonly GPUColorTargetState[];
  begin(): GPURenderPassEncoder;
}
/**
 * A primitive of an added model, as gltf/pbr's `PBRPrimitive` holds it (declared here so clustered does not import
 * gltf): its triangles (20 floats a vertex, position first), its node's world matrix and, when instanced, the instance
 * rows (24 floats each, the node-space matrix first).
 */
export interface BounceModelPrimitive {
  readonly vertices: Float32Array;
  readonly indices: ArrayLike<number>;
  readonly node: { readonly matrix: ArrayLike<number>; readonly id?: number };
  readonly material: {
    readonly settings: ArrayLike<number>;
    readonly tint?: unknown;
    readonly ext?: ArrayLike<number>;
    readonly extension?: { readonly afterOpaque?: boolean; readonly replacesPhysical?: boolean };
  };
  readonly extension?: { readonly afterOpaque?: boolean; readonly replacesPhysical?: boolean };
  readonly instances?: { readonly data: Float32Array; readonly count: number };
  readonly deformed?: unknown;
  readonly topology?: string;
}
/** What `bounce.add` takes: a gltf/pbr `PBRModel` (a materials `createMesh` mesh is one), a `Terrain`, a voxel renderer or anything with the same capture hook. */
export interface BounceModel {
  setCapture(hook: BounceModelCapture): () => void;
  onDispose(callback: () => void): () => void;
  draw(context: PassContext, mode: 'capture', color: GPUTextureView, depth: GPUTextureView): void;
  /** A gltf/pbr model's primitives: their triangles occlude in the visibility maps (`bounceModelMeshes`). */
  readonly primitives?: readonly BounceModelPrimitive[];
}
/**
 * The occluders a model added to the bounce gives the visibility maps besides its captured texels: the triangles of
 * every primitive its captures draw (opaque and MASK triangles of a visible node, each instance with its world matrix),
 * as `sampleSurfaces` takes them. Imperfect shadow maps sample every surface of the scene (T. Ritschel, T. Grosch,
 * M. H. Kim, H.-P. Seidel, C. Dachsbacher and J. Kautz, "Imperfect Shadow Maps for Efficient Computation of Indirect
 * Illumination", ACM TOG 27(5), 2008, doi:10.1145/1409060.1409082), so a model's wall no source sees still blocks.
 * Skinned or morphed primitives (`deformed`: their current shape is on the GPU only) and models with no primitives
 * (terrain, voxel) occlude through their captures alone.
 */
export function bounceModelMeshes(
  model: Pick<BounceModel, 'primitives'>,
  /** The engine's transform store: a node hidden there, or under a hidden parent, gives nothing. */
  store?: { readonly hidden: ArrayLike<number>; readonly parents?: ArrayLike<number> },
): BounceMesh[] {
  const out: BounceMesh[] = [];
  for (const p of model.primitives ?? []) {
    const m = p.material,
      extension = p.extension ?? m.extension;
    // As the capture leaves them out: points and lines, BLEND and tinted, after-opaque (transmission) and unlit.
    if (
      p.topology ||
      p.deformed ||
      (store && p.node.id !== undefined && hiddenInTree(store, p.node.id)) ||
      !p.indices.length ||
      m.settings[0] === 2 ||
      (!!m.tint && !extension?.replacesPhysical) ||
      extension?.afterOpaque === true ||
      m.ext?.[0]
    )
      continue;
    const N = p.node.matrix;
    if (!p.instances) {
      out.push({ vertices: p.vertices, stride: 20, indices: p.indices, matrix: N });
      continue;
    }
    const rows = p.instances.data;
    for (let r = 0; r < p.instances.count; r++) {
      const world = new Float64Array(16);
      for (let c = 0; c < 4; c++)
        for (let k = 0; k < 4; k++) {
          let sum = 0;
          for (let j = 0; j < 4; j++) sum += N[j * 4 + k] * rows[r * 24 + c * 4 + j];
          world[c * 4 + k] = sum;
        }
      out.push({ vertices: p.vertices, stride: 20, indices: p.indices, matrix: world });
    }
  }
  return out;
}
// The model capture's WGSL: gltf/pbr's PBR Surface gets `margoCapture(s, v, k)` (the base layer's share `k` after
// clearcoat and sheen weighs its albedo), other shaders (terrain, water) `margoSSR(n, v, base, metal, rough)`. The
// distance is from the drawn position (`margoPosition`, which the capture entry points set when it is declared) to the
// view's eye, the shader's own Frame (`f` in gltf/pbr, `frame` in terrain); a shader with neither writes nothing.
const pbrSurface = /struct Surface\s*\{\s*base:vec4f/;
function bounceModelTail(code: string): string {
  const eye = /var<uniform>\s*f\s*:\s*Frame/.test(code)
      ? 'f.eye.xyz'
      : /var<uniform>\s*frame\s*:\s*Frame/.test(code)
        ? 'frame.eye.xyz'
        : '',
    out = (albedo: string) => (eye ? `vec4f(${albedo},length(margoPosition-${eye}))` : 'vec4f(0)');
  return `
var<private> margoPosition:vec3f;
${
  pbrSurface.test(code)
    ? `struct MargoCapture {@location(0) bounce:vec4f}
fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {return MargoCapture(${out('s.base.rgb*(1.0-s.metal)*k')});}`
    : `struct MargoSSR {@location(0) bounce:vec4f}
fn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {return MargoSSR(${out('base*(1.0-metal)')});}`
}
`;
}
/** A readback older than this many frames is captured again. */
const STALE_FRAMES = 120;

/** The light terms of `lights` the light loop applies to its point and spot lights (IES, projector, layers). */
function lightTerms(lights: Pick<Clustered, 'ies' | 'projector' | 'layers'>): ClusteredLightTerm[] {
  return [lights.ies, lights.projector, lights.layers].filter((t): t is ClusteredLightTerm => t !== undefined);
}
/**
 * What light `index` of `lights` (`Clustered.setLights`) sends toward world point `p`, relative to its plain falloff and
 * cone: the product of its light terms' CPU twins (`ClusteredLightTerm.emission`: `IESLights`' profile, `ProjectorLights`'
 * and `CubeProjectorLights`' images, `LightLayers`' mask for core meshes), the factors the light loop multiplies in.
 * Undefined when no term shapes the light. Read when called, so it follows the terms as they are set.
 */
export function lightEmission(
  lights: Pick<Clustered, 'list' | 'ies' | 'projector' | 'layers'>,
  index: number,
): ((p: readonly number[]) => [number, number, number]) | undefined {
  const terms = lightTerms(lights);
  if (!terms.length) return undefined;
  const l = lights.list[index] as PointLight & Partial<SpotLight>,
    record: ClusteredLightRecord = { position: l.position, ...spotAxis(l) };
  return (p) => {
    const out: [number, number, number] = [1, 1, 1];
    for (const t of terms) {
      const f = termEmission(t, index, record, p);
      for (let c = 0; c < 3; c++) out[c] *= f[c];
    }
    return out;
  };
}
/** A spot's unit axis and cone cosines as `Clustered.setLights` packs them; nothing for a point light. */
function spotAxis(l: PointLight & Partial<SpotLight>): {
  direction?: [number, number, number];
  cosOuter?: number;
  cosInner?: number;
} {
  if (!l.direction) return {};
  const length = Math.hypot(l.direction[0], l.direction[1], l.direction[2]),
    outer = l.angle ?? l.outerAngle!,
    inner = l.angle !== undefined ? l.angle * (1 - (l.penumbra ?? 0)) : (l.innerAngle ?? 0);
  return {
    direction: [l.direction[0] / length, l.direction[1] / length, l.direction[2] / length],
    cosOuter: Math.cos(outer),
    cosInner: Math.cos(inner),
  };
}
/**
 * Light `index` of `lights` as a bounce source: its position, range, decay, a spot's cone (every light given a
 * `direction`, as the light loop: a half angle of pi / 2 lights a half space), and `emission` from its light terms.
 */
export function bounceLightSource(
  lights: Pick<Clustered, 'list' | 'ies' | 'projector' | 'layers'>,
  index: number,
): BouncePointSource {
  const l = lights.list[index] as PointLight & Partial<SpotLight>,
    emission = lightEmission(lights, index);
  return {
    kind: 'point',
    position: [l.position[0], l.position[1], l.position[2]],
    range: l.range,
    ...(l.decay !== undefined ? { decay: l.decay } : {}),
    ...spotAxis(l),
    ...(emission ? { emission } : {}),
  };
}
/** An opening whose light bounces: its `openingLight` (`@margoengine/clustered/area`) and its glass. */
export interface BounceOpeningLight {
  /** The opening's light, as `openingLight` returns it (its `color` x `intensity` is the opening's radiance). */
  light: RectAreaLight;
  /** The glass in it, as given to `openingLight`. Default 'clear'. */
  glazing?: 'clear' | 'frosted';
  /**
   * Lites across and up, as given to `openingLight` (two integers from 1 to 16). Default `[1, 1]`, no glazing bars.
   * With bars the capture looks out from in front of them (KB-BOUNCE-CAPEYE1).
   */
  lites?: readonly [number, number];
  /** Depth of each glazing bar, metres, centred on the glass, as given to `openingLight` (above 0, up to 0.3). Default 0.035. */
  barDepth?: number;
}
/** {@link LightBounce} settings; every number is checked (RangeError outside its range). */
export interface LightBounceOptions {
  /** The clustered lights whose point and spot lights bounce. */
  lights: Clustered;
  /**
   * Point and spot lights that bounce, 1 to 4, strongest first: every `castShadow` light (a light's `bounce: true`
   * adds one without, `bounce: false` leaves one out). Default 4.
   */
  maxLights?: number;
  /** Virtual point lights per source, 8 to 128. Default 32. */
  vpls?: number;
  /** Capture size per view, texels, 8 to 128. Default 32. */
  resolution?: number;
  /** Visibility map size per virtual point light, 8 to 64. Default 32. */
  visibility?: number;
  /** Surfaces nearer a source than this, metres, do not bounce (a lamp's own fixture). 0 to 10, default 0.15. */
  near?: number;
  /** Scale of the bounce, 0 to 16. Default 1, physical. */
  intensity?: number;
  /** Visibility maps (imperfect shadow maps). Default true; false lets every bounce through walls. */
  occlusion?: boolean;
  /** Views captured again each frame, round robin, 0 to 6; 0 captures only new sources and after `invalidate()`. Default 1. */
  refresh?: number;
  /** Openings whose light bounces outside and which count a room's light once (README, "Counting the room's light once"). */
  openings?: readonly BounceOpeningLight[];
}
interface SourceState {
  key: string;
  source: BounceSource;
  views: BounceView[];
  texels: Float32Array;
  /** Frame each view was last read back in; -1 never. */
  read: number[];
  pending: boolean[];
  buffers: GPUBuffer[];
  changed: boolean;
  vpls: BounceVpl[];
  points: BouncePoint[];
  scale: [number, number, number];
}
const int = (value: unknown, low: number, high: number, name: string, fallback: number): number => {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < low || v > high)
    throw new RangeError(`Invalid LightBounce ${name}; give an integer from ${low} to ${high}`);
  return v;
};
const real = (value: unknown, low: number, high: number, name: string, fallback: number): number => {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < low || v > high)
    throw new RangeError(`Invalid LightBounce ${name}; give a number from ${low} to ${high}`);
  return v;
};
/** IEEE 754 half to float. */
const half = (h: number): number => {
  const e = (h >> 10) & 31,
    m = h & 1023,
    s = h & 32768 ? -1 : 1;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
};
/** The capture camera's near distance for a LightBounce `near`: half of it, from 0.01 to 0.05 m. */
const captureNear = (near: number): number => Math.max(0.01, Math.min(0.05, near / 2));
const openingOf = (o: BounceOpeningLight): BounceOpening => {
  const { normal, right, up } = rectFrame(o.light.direction, o.light.up, 'LightBounce opening');
  return {
    position: [o.light.position[0], o.light.position[1], o.light.position[2]],
    normal,
    u: right.map((v) => (v * o.light.width) / 2),
    v: up.map((v) => (v * o.light.height) / 2),
    frosted: o.glazing === 'frosted',
    ...(o.light.recess ? { recess: o.light.recess } : {}),
    ...(o.light.sill ? { sill: o.light.sill } : {}),
  };
};

type Batches = NonNullable<GpuPass['batches']>;
/**
 * The occluders of the visibility maps besides the captures' texels (KB-BOUNCE-SHADOWSNOW1): every instance of the
 * frame's batches that core draws itself, the geometry and world matrices the captures draw. A batch a package claims
 * (`@margoengine/materials` glass, gltf-pro, terrain) is left out, as the captures leave it out; instances a
 * GPU-culling package supplies beyond core's own rows are drawn in the captures only.
 */
function occluderMeshes(batches: Batches = []): BounceMesh[] {
  const out: BounceMesh[] = [];
  for (const batch of batches)
    if (!batch.claimed && batch.geometry.indices.length)
      for (let r = 0; r < batch.count; r++)
        out.push({
          vertices: batch.geometry.vertices,
          indices: batch.geometry.indices,
          matrix: batch.instances.subarray(r * 24, r * 24 + 16),
        });
  return out;
}
/**
 * One bounce of light from point, spot and opening lights: lantern-lit snow lights the logs round a window, a lit wall
 * lights the floor under a table. Each bouncing source's view of the scene (core meshes, with every surface hook such
 * as Snow) is captured on the GPU, read back, reduced to virtual point lights with visibility maps (the maths of this
 * entry) and added to the lit shader through `Clustered.bounce`, diffuse only. Light colours and intensities are read
 * every frame, so a flicker has no lag; the captures change only when a source moves or the scene does.
 * WebGPU and the WebGL2 layer from its half-float tier.
 * @throws TypeError without `lights`; RangeError for an option out of range; MargoError `'unsupported'` on a WebGL
 * engine, the LDR compatibility tier or a replaced core shader, `'disposed'` after `dispose()`.
 * @example
 * const bounce = LightBounce.attach(engine, {lights});
 */
export class LightBounce implements EnginePlugin, ClusteredBounce {
  readonly name = 'clustered:bounce';
  readonly lights: Clustered;
  readonly maxLights: number;
  readonly vpls: number;
  readonly resolution: number;
  readonly visibility: number;
  readonly near: number;
  readonly intensity: number;
  readonly occlusion: boolean;
  readonly refresh: number;
  private openingList: readonly BounceOpeningLight[];
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  /** Data buffers a larger one replaced: this frame's bind groups may still hold them, so they go next frame. */
  private retired: GPUBuffer[] = [];
  private frameBuffer?: GPUBuffer;
  private color?: GPUTexture;
  private depth?: GPUTexture;
  private entries: GPUBindGroupEntry[] = [];
  private states: SourceState[] = [];
  private data: Float32Array = new Float32Array(4);
  private pipeline?: { source: string; buffers: number | undefined; pipeline: GPURenderPipeline };
  private readonly camera = new Camera({ fov: 90, position: [0, 0, 0], target: [0, 0, 1], near: 0.05, far: 100 });
  private readonly values = new Float32Array(32);
  private frame = 0;
  private turn = 0;
  private generation = 0;
  private captured = 0;
  private occluders = 0;
  private dirty = false;
  private scaled = false;
  private disposed = false;
  private readonly models = new Map<BounceModel, () => void>();
  private readonly modelCode = new Map<string, string>();
  private modelPass?: GPURenderPassEncoder;
  private modelTarget?: { color: GPUTextureView; depth: GPUTextureView; stencil: boolean };
  // Added models draw into the capture's own target after the core meshes, depth tested against them.
  private readonly hook: BounceModelCapture = {
    targets: [{ format: 'rgba16float' }],
    declarations: (code) => {
      let out = this.modelCode.get(code);
      if (out === undefined) {
        if (this.modelCode.size >= 64) this.modelCode.clear();
        this.modelCode.set(code, (out = bounceModelTail(code)));
      }
      return out;
    },
    begin: () => {
      if (this.modelPass) return this.modelPass;
      const t = this.modelTarget!;
      return (this.modelPass = this.captureEncoder!.beginRenderPass({
        colorAttachments: [{ view: t.color, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: t.depth,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
          ...(t.stencil ? { stencilLoadOp: 'load', stencilStoreOp: 'store' } : {}),
        },
      }));
    },
  };
  private captureEncoder?: GPUCommandEncoder;

  constructor(options: LightBounceOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('LightBounce needs the Clustered lights; pass {lights}');
    this.lights = options.lights;
    this.maxLights = int(options.maxLights, 1, 4, 'maxLights', 4);
    this.vpls = int(options.vpls, 8, 128, 'vpls', 32);
    this.resolution = int(options.resolution, 8, 128, 'resolution', 32);
    this.visibility = int(options.visibility, 8, 64, 'visibility', 32);
    this.near = real(options.near, 0, 10, 'near', 0.15);
    this.intensity = real(options.intensity, 0, 16, 'intensity', 1);
    this.refresh = int(options.refresh, 0, 6, 'refresh', 1);
    if (options.occlusion !== undefined && typeof options.occlusion !== 'boolean')
      throw new TypeError('LightBounce occlusion must be a boolean');
    this.occlusion = options.occlusion ?? true;
    this.openingList = this.checkOpenings(options.openings ?? []);
  }
  static attach(instance: EngineKernel, options: LightBounceOptions): LightBounce {
    const effect = new LightBounce(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  /** Views captured so far, virtual point lights in use and bouncing sources. */
  /** `occluders`: the scene triangles and merged surfels of the last visibility rebuild (besides the capture texels). */
  get stats(): { captures: number; vpls: number; sources: number; occluders: number } {
    return { captures: this.captured, vpls: this.data[1] ?? 0, sources: this.states.length, occluders: this.occluders };
  }
  /** The openings whose light bounces. */
  get openings(): readonly BounceOpeningLight[] {
    return this.openingList;
  }
  /** Replaces the openings (each `openingLight`'s light and its glass). */
  setOpenings(openings: readonly BounceOpeningLight[]): this {
    this.openingList = this.checkOpenings(openings);
    this.dirty = true;
    return this;
  }
  /**
   * Makes a gltf/pbr model, a `@margoengine/materials` mesh, terrain or voxel renderer reflect the bounce: its own
   * materials (maps, alpha mask, instances, skinning, clearcoat) are drawn into every capture after the core meshes. Returns a remover; a model not added still receives
   * the bounce but reflects none. Adding or removing captures every source again.
   */
  add(model: BounceModel): () => void {
    if (this.disposed) throw new MargoError('disposed', 'LightBounce is disposed; attach a new LightBounce');
    if (typeof model?.setCapture !== 'function')
      throw new TypeError(
        'LightBounce add takes a model with a capture hook (gltf/pbr PBRModel, materials mesh, Terrain)',
      );
    const remove = captureModel(this.models, model, this.hook);
    this.invalidate();
    return () => {
      remove();
      this.invalidate();
    };
  }
  /** Captures every source again (after the scene changed while `refresh` is 0). */
  invalidate(): void {
    for (const state of this.states) state.read.fill(-1);
  }
  private checkOpenings(list: readonly BounceOpeningLight[]): readonly BounceOpeningLight[] {
    if (!Array.isArray(list) || list.length > 4)
      throw new RangeError('Invalid LightBounce openings; give an array of up to 4');
    for (const o of list) {
      if (
        !o?.light ||
        !(o.light.width > 0) ||
        !(o.light.height > 0) ||
        ![o.light.recess ?? 0, o.light.sill ?? 0].every((v) => Number.isFinite(v) && v >= 0)
      )
        throw new RangeError('Invalid LightBounce opening; give {light: openingLight(...), glazing}');
      if (o.glazing !== undefined && o.glazing !== 'clear' && o.glazing !== 'frosted')
        throw new RangeError("Invalid LightBounce opening glazing; give 'clear' or 'frosted'");
      const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16;
      if (
        (o.lites !== undefined &&
          !(Array.isArray(o.lites) && o.lites.length === 2 && count(o.lites[0]) && count(o.lites[1]))) ||
        (o.barDepth !== undefined && !(Number.isFinite(o.barDepth) && o.barDepth > 0 && o.barDepth <= 0.3))
      )
        throw new RangeError('Invalid LightBounce opening lites or barDepth; give them as openingLight takes them');
      openingOf(o);
    }
    return Object.freeze(list.map((o) => ({ ...o })));
  }
  declarations(group: number): string {
    return bounceWgsl(group);
  }
  bindings(): GPUBindGroupEntry[] {
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'LightBounce requires WebGPU and a live effect; attach a new LightBounce to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    requireCompatTier(engine.gpu, 'LightBounce', 'half-float');
    this.engine = engine;
    this.device = engine.gpu;
    const res = this.resolution;
    this.frameBuffer = this.device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.color = this.device.createTexture({
      size: [res, res, 6],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.data = new Float32Array(4);
    this.upload();
    this.lights.bounce = this;
  }
  /** The packed data to the GPU, in a buffer of at least its size (a new buffer gives new bindings). */
  private upload(): void {
    const device = this.device!,
      bytes = Math.max(16, this.data.byteLength);
    if (!this.buffer || this.buffer.size < bytes) {
      if (this.buffer) this.retired.push(this.buffer);
      this.buffer = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.entries = [{ binding: BOUNCE_BINDING, resource: { buffer: this.buffer } }];
    }
    device.queue.writeBuffer(this.buffer, 0, this.data as Float32Array<ArrayBuffer>);
  }
  private termIds = new WeakMap<object, number>();
  private termCount = 0;
  /** A number per light term or packed words object, so a term put in place of another, or set again, is a change. */
  private termId(term: object): number {
    let id = this.termIds.get(term);
    if (id === undefined) this.termIds.set(term, (id = ++this.termCount));
    return id;
  }
  /**
   * This frame's sources: the bouncing lights that matter most to the view, then the openings; a source that stays
   * keeps its capture. A light's weight is its luminous power over its squared distance from `eye` (the camera), the
   * flux-over-distance importance of many-light rendering (Walter et al., "Lightcuts", SIGGRAPH 2005; Dachsbacher et
   * al., "Scalable Realistic Rendering with Many-Light Methods", Computer Graphics Forum 33(1), 2014), so of a row of
   * equal lamps the ones beside the camera bounce, not the first four in the list (KB-BOUNCE-NEAREST1). Without an eye
   * the weight is the power alone.
   */
  private select(eye?: ArrayLike<number>): void {
    const lights = (this.lights.list as readonly (PointLight & Partial<SpotLight>)[])
      .map((l, index) => ({ l, index }))
      .filter(({ l }) => (l.bounce ?? !!l.castShadow) && (l.intensity ?? 1) > 0)
      .map(({ l, index }) => {
        const c = l.color ?? [1, 1, 1],
          k = (l.intensity ?? 1) * this.intensity;
        const p = l.position,
          d2 = eye ? Math.max(1e-4, (p[0] - eye[0]) ** 2 + (p[1] - eye[1]) ** 2 + (p[2] - eye[2]) ** 2) : 1;
        return {
          index,
          power: (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / d2,
          scale: [c[0] * k, c[1] * k, c[2] * k],
        };
      })
      .sort((a, b) => b.power * b.scale[1] - a.power * a.scale[1])
      .slice(0, this.maxLights);
    // A term's change (a new profile, image or mask) is a new source: its texels reflect other light.
    const terms = lightTerms(this.lights)
        .map((t) => {
          const state = termState(t);
          return `${this.termId(t)}.${typeof state === 'number' ? state : (state as object[]).map((w) => (w ? this.termId(w) : 0)).join('.')}`;
        })
        .join(','),
      next: { key: string; source: BounceSource; scale: [number, number, number] }[] = lights.map(
        ({ index, scale }) => {
          const source = bounceLightSource(this.lights, index);
          return { key: `${JSON.stringify(source)}|${terms}`, source, scale: scale as [number, number, number] };
        },
      );
    for (const o of this.openingList) {
      const opening = openingOf(o),
        k = (o.light.intensity ?? 1) * this.intensity,
        c = o.light.color ?? [1, 1, 1],
        // Bars centred on the glass stand (barDepth - thickness) / 2 in front of the light's position, its outdoor face;
        // half the bar depth clears them, and the capture camera's near distance keeps its clip out of them.
        front = (o.lites?.[0] ?? 1) * (o.lites?.[1] ?? 1) > 1 ? (o.barDepth ?? 0.035) / 2 + captureNear(this.near) : 0,
        source: BounceSource = {
          kind: 'rect',
          position: opening.position,
          normal: opening.normal,
          u: opening.u,
          v: opening.v,
          ...(opening.recess ? { recess: opening.recess } : {}),
          ...(opening.sill ? { sill: opening.sill } : {}),
          ...(front ? { front } : {}),
        };
      next.push({ key: JSON.stringify(source), source, scale: [c[0] * k, c[1] * k, c[2] * k] });
    }
    const old = new Map(this.states.map((s) => [s.key, s])),
      res = this.resolution,
      states = next.map(({ key, source, scale }): SourceState => {
        const state = old.get(key);
        old.delete(key);
        if (state) {
          if (state.scale.some((v, i) => v !== scale[i])) this.scaled = true;
          state.scale = scale;
          return state;
        }
        this.dirty = true;
        const views = bounceViews(source);
        return {
          key,
          source,
          views,
          texels: new Float32Array(views.length * res * res * 4),
          read: views.map(() => -1),
          pending: views.map(() => false),
          buffers: [],
          changed: false,
          vpls: [],
          points: [],
          scale,
        };
      });
    for (const gone of old.values()) {
      for (const b of gone.buffers) b.destroy();
      this.dirty = true;
    }
    this.states = states;
  }
  registerPasses(graph: FrameGraph): void {
    // After every shader patch (order -1), before the main draw (0), as LightProbes' capture.
    graph.add({
      name: this.name,
      order: -0.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || c.device !== this.device || this.disposed) return;
        this.frame++;
        for (const b of this.retired) b.destroy();
        this.retired.length = 0;
        this.select(c.camera?.position);
        // Views never read, or read too long ago, first; then `refresh` more, round robin.
        const due: [SourceState, number][] = [],
          all: [SourceState, number][] = [];
        for (const s of this.states)
          for (let v = 0; v < s.views.length; v++) {
            all.push([s, v]);
            if (!s.pending[v] && (s.read[v] < 0 || this.frame - s.read[v] > STALE_FRAMES)) due.push([s, v]);
          }
        for (let n = 0; n < this.refresh && all.length; n++) {
          const [s, v] = all[this.turn++ % all.length];
          if (!s.pending[v] && !due.some(([a, b]) => a === s && b === v)) due.push([s, v]);
        }
        for (const [s, v] of due) this.capture(c, s, v);
        if (this.dirty || this.states.some((s) => s.changed)) this.rebuild(c.batches);
        else if (this.scaled) {
          setBounceScales(
            this.data,
            this.states.map((s) => s.scale),
          );
          c.device.queue.writeBuffer(
            this.buffer!,
            16,
            this.data as Float32Array<ArrayBuffer>,
            4,
            this.states.length * 4,
          );
        }
        this.scaled = false;
      },
    });
  }
  /** Draws view `v` of a source with the frame's own lit shader, ending in albedo and distance, and reads it back. */
  private capture(c: GpuPass, s: SourceState, v: number): void {
    const device = c.device,
      res = this.resolution,
      view = s.views[v],
      camera = this.camera,
      buffers = c.descriptor.vertex.buffers?.length,
      // The scene's depth format: core's draw sets the stencil operations from it.
      depthFormat = c.descriptor.depthStencil?.format ?? 'depth32float';
    if (this.depth?.format !== depthFormat) {
      this.depth?.destroy();
      this.depth = device.createTexture({
        size: [res, res],
        format: depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.pipeline = undefined;
    }
    if (this.pipeline?.source !== c.shader || this.pipeline?.buffers !== buffers) {
      this.pipeline = {
        source: c.shader,
        buffers,
        pipeline: capturePipeline(
          device,
          frameCapture(c.shader, CAPTURE_BINDING, CAPTURE_TAIL, 'LightBounce'),
          c.descriptor.vertex.buffers,
          depthFormat,
        ),
      };
    }
    const pipeline = this.pipeline.pipeline;
    camera.fov = (2 * Math.atan(view.tan) * 180) / Math.PI;
    camera.near = captureNear(this.near);
    camera.far = s.source.kind === 'point' && s.source.range > 0 ? s.source.range : 1000;
    camera.position = [view.eye[0], view.eye[1], view.eye[2]];
    camera.target = [view.eye[0] + view.forward[0], view.eye[1] + view.forward[1], view.eye[2] + view.forward[2]];
    camera.up = [view.up[0], view.up[1], view.up[2]];
    camera.project = undefined;
    camera.cancelFit();
    camera.update(1, true);
    const values = this.values;
    values.fill(0);
    values.set(camera.matrix);
    values.set(view.eye, 16);
    device.queue.writeBuffer(this.frameBuffer!, 0, values);
    const layer = this.color!.createView({ dimension: '2d', baseArrayLayer: v, arrayLayerCount: 1 }),
      depth = this.depth!.createView(),
      encoder = device.createCommandEncoder(),
      saved = {
        encoder: c.encoder,
        color: c.color,
        depth: c.depth,
        camera: c.camera,
        width: c.width,
        height: c.height,
        format: c.format,
        view: c.view,
        descriptor: c.descriptor,
      },
      hadView = Object.hasOwn(c, 'view');
    encoder
      .beginRenderPass({
        colorAttachments: [{ view: layer, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: {
          view: depth,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          ...(depthFormat.includes('stencil')
            ? { stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store' }
            : {}),
        },
      })
      .end();
    try {
      c.encoder = encoder;
      c.color = layer;
      c.depth = depth;
      c.camera = camera;
      c.width = c.height = res;
      c.format = 'rgba16float';
      if (hadView) delete (c as { view?: unknown }).view;
      c.draw({
        pipeline,
        bindings: [...c.bindings, { binding: CAPTURE_BINDING, resource: { buffer: this.frameBuffer! } }],
        clear: false,
        clearDepth: false,
      });
      if (this.models.size) {
        // The capture's target is single-sampled whatever the scene's.
        c.descriptor = {
          ...c.descriptor,
          multisample: { count: 1 },
          depthStencil: { ...c.descriptor.depthStencil!, format: depthFormat },
        };
        this.captureEncoder = encoder;
        this.modelTarget = { color: layer, depth, stencil: depthFormat.includes('stencil') };
        for (const model of this.models.keys()) drawCapture(model, this.hook, c);
      }
    } finally {
      this.modelPass?.end();
      this.modelPass = this.captureEncoder = this.modelTarget = undefined;
      Object.assign(c, saved);
      if (!hadView) delete (c as { view?: unknown }).view;
    }
    const row = Math.ceil((res * 8) / 256) * 256,
      read = (s.buffers[v] ??= device.createBuffer({
        size: row * res,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }));
    encoder.copyTextureToBuffer(
      { texture: this.color!, origin: [0, 0, v] },
      { buffer: read, bytesPerRow: row, rowsPerImage: res },
      [res, res, 1],
    );
    device.queue.submit([encoder.finish()]);
    this.captured++;
    s.pending[v] = true;
    const generation = this.generation,
      frame = this.frame;
    read.mapAsync(GPUMapMode.READ).then(
      () => {
        s.pending[v] = false;
        if (this.disposed || generation !== this.generation) return;
        const halves = new Uint16Array(read.getMappedRange()),
          base = v * res * res * 4;
        let changed = false;
        for (let j = 0; j < res; j++)
          for (let i = 0; i < res * 4; i++) {
            const value = half(halves[(j * row) / 2 + i]),
              k = base + j * res * 4 + i;
            if (s.texels[k] !== value) {
              s.texels[k] = value;
              changed = true;
            }
          }
        read.unmap();
        s.read[v] = frame;
        if (changed) s.changed = true;
      },
      // Disposal or a device restore destroys the buffer, which aborts the map: the view is captured again.
      () => (s.pending[v] = false),
    );
  }
  /** VPLs of the sources whose captures changed, every visibility map, then the packed data to the GPU. */
  private rebuild(batches?: Batches): void {
    const openings = this.openingList.map(openingOf);
    this.states.forEach((s, index) => {
      if (!s.changed && !this.dirty && s.vpls.length) return;
      const out = reduceBounce({ views: s.views, resolution: this.resolution, texels: s.texels }, s.source, {
        vpls: this.vpls,
        near: this.near,
        openings,
        source: index,
      });
      s.vpls = out.vpls;
      s.points = out.points;
      s.changed = false;
    });
    // Source indices follow this frame's order.
    const vpls = this.states.flatMap((s, index) => s.vpls.map((v) => ({ ...v, source: index }))),
      res = this.visibility,
      occluders = this.occlusion
        ? sampleSurfaces(
            [...occluderMeshes(batches), ...[...this.models.keys()].flatMap((m) => bounceModelMeshes(m, this.engine?.store))],
            vpls,
            { resolution: res },
          )
        : [],
      maps = this.occlusion
        ? buildVisibility(
            vpls,
            this.states.flatMap((s) => s.points),
            { resolution: res, openings, occluders },
          )
        : new Float32Array(vpls.length * res * res).fill(OPEN);
    this.occluders = occluders.length;
    this.data = packBounce(
      this.states.map((s) => s.scale),
      vpls,
      maps,
      res,
    );
    this.dirty = false;
    this.upload();
  }
  private release(): void {
    this.generation++;
    if (this.lights.bounce === this) this.lights.bounce = undefined;
    for (const s of this.states) for (const b of s.buffers) b.destroy();
    this.states = [];
    for (const r of [this.buffer, this.frameBuffer, this.color, this.depth, ...this.retired]) r?.destroy();
    this.retired.length = 0;
    this.buffer = this.frameBuffer = this.color = this.depth = undefined;
    this.pipeline = undefined;
    this.entries = [];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of [...this.models.values()]) remove();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
