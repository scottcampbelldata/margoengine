// Occluder fade: each frame, the meshes between the camera and its targets are found with rays through the scene's
// BVHs and dithered out, then back in when the view is clear again. A faded mesh drops a share of its pixels by a
// fixed 16 by 16 threshold tile (screen-door transparency), so it needs no blending and no sorting and the depth
// buffer stays right. Core meshes read their fade from a buffer indexed by mesh id (a patch of core's shader, as
// lod/fade does); gltf/pbr models and materials meshes read it from a lighting effect's uniform.
// Sources (read as papers and a book, no code):
// - Fuchs, Goldfeather, Hultquist, Spach, Austin, Brooks, Eyles, Poulton 1985, "Fast spheres, shadows, textures,
//   transparencies, and image enhancements in Pixel-planes", SIGGRAPH '85, https://doi.org/10.1145/325334.325205
// - Mulder, Groen, van Wijk 1998, "Pixel masks for screen-door transparency", IEEE Visualization '98,
//   https://doi.org/10.1109/VISUAL.1998.745323
// - Bayer 1973, "An optimum method for two-level rendition of continuous-tone pictures", IEEE ICC '73, 26-11 to 26-15
// - Ulichney 1993, "The void-and-cluster method for dither array generation", SPIE 1913,
//   https://doi.org/10.1117/12.152707
// - Haigh-Hutchinson 2009, "Real-Time Cameras", Morgan Kaufmann, ISBN 978-0-12-311634-5 (occlusion: fading the
//   geometry between the camera and its target)
// - Christie, Olivier, Normand 2008, "Camera Control in Computer Graphics", Computer Graphics Forum 27(8),
//   https://doi.org/10.1111/j.1467-8659.2008.01181.x
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { Raycaster, engineModels } from '@margoengine/bvh';
import type { EngineKernel, Mesh } from '@margoengine/core';
import { meshRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf/pbr';
import { MargoError } from '@margoengine/math/errors';
import { onStandIn } from './fade-pattern.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };

const HELP = '; see https://margoengine.com/errors#lod-occluder-fade';
/** Side of the threshold tile in pixels, and its cell count. */
const TILE = 16,
  CELLS = TILE * TILE;
/** Bindings clear of lod/fade's 95 and 97 and of the numbers other packages take. */
const CORE_BINDING = 92,
  MODEL_BINDING = 92;

/** The threshold tile: `'bayer'` is the ordered dither matrix, `'blue'` a void-and-cluster blue-noise array. */
export type OccluderPattern = 'bayer' | 'blue';
/**
 * What must stay in view: a core mesh, a model or materials mesh (anything with `root`), a point `[x, y, z]`, a sphere
 * `[x, y, z, radius]`, or a function returning one of the two arrays each frame.
 */
export type OccluderTarget = Mesh | { readonly root: Mesh } | readonly number[] | (() => readonly number[]);
/** Which meshes may be found, for {@link findOccluders}. */
export interface OccluderQuery {
  /** World radius around each sight line that must be clear, 0 or more. Default 0.25. */
  padding?: number;
  /** Render-layer mask (`setRenderLayers` of `@margoengine/cameras/layers`); a mesh on none of these never fades. Default every layer. */
  layers?: number;
  /** Return false to keep a mesh solid. Called with a core mesh, or a model's node and the model. Default none. */
  filter?: ((mesh: Mesh, model?: object) => boolean) | null;
}
/** Options of {@link OccluderFade}. */
export interface OccluderFadeOptions extends OccluderQuery {
  /** What to keep in view. Default none. */
  targets?: readonly OccluderTarget[];
  /** Seconds a mesh takes to fade out, and back in; 0 switches at once. Default 0.25. */
  fadeTime?: number;
  /** Share of its pixels a fully faded mesh keeps, 0 to 1. Default 0.25. */
  minOpacity?: number;
  /** The threshold tile, fixed for the life of the plugin. Default `'bayer'`. */
  pattern?: OccluderPattern;
  /** The eye the sight lines start from. Default the engine's camera. */
  camera?: { readonly position: readonly number[] } | null;
}

const bayer = (): Float32Array => {
  const out = new Float32Array(CELLS);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      let rank = 0;
      for (let bit = 0; bit < 4; bit++) rank = rank * 4 + 2 * (((x >> bit) ^ (y >> bit)) & 1) + ((y >> bit) & 1);
      out[y * TILE + x] = (rank + 0.5) / CELLS;
    }
  return out;
};
/** Ulichney's void-and-cluster ranks on a torus, with a Gaussian of sigma 1.5 and a fixed seed, so the tile never changes. */
const blue = (): Float32Array => {
  const mask = TILE - 1,
    kernel = new Float32Array(CELLS);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const dx = Math.min(x, TILE - x),
        dy = Math.min(y, TILE - y);
      kernel[y * TILE + x] = Math.exp(-(dx * dx + dy * dy) / 4.5);
    }
  // `energy[i]` is the filtered density of the cells equal to `of` around cell i.
  const flip = (bits: Uint8Array, energy: Float32Array, at: number, sign: number) => {
    bits[at] ^= 1;
    const ax = at & mask,
      ay = at >> 4;
    for (let i = 0; i < CELLS; i++)
      energy[i] += sign * kernel[((((i >> 4) - ay) & mask) << 4) | (((i & mask) - ax) & mask)];
  };
  /** The cell equal to `of` with the highest (a cluster) or lowest (a void) energy. */
  const pick = (bits: Uint8Array, energy: Float32Array, of: number, highest: boolean) => {
    let best = -1;
    for (let i = 0; i < CELLS; i++)
      if (bits[i] === of && (best < 0 || (highest ? energy[i] > energy[best] : energy[i] < energy[best]))) best = i;
    return best;
  };
  const start = new Uint8Array(CELLS),
    startEnergy = new Float32Array(CELLS);
  let seed = 0x9e3779b9,
    ones = 0;
  while (ones < CELLS / 10) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const at = seed >>> 24;
    if (!start[at]) {
      flip(start, startEnergy, at, 1);
      ones++;
    }
  }
  // Even out the start: move the tightest cluster into the largest void until the two are the same cell.
  for (;;) {
    const cluster = pick(start, startEnergy, 1, true);
    flip(start, startEnergy, cluster, -1);
    const hole = pick(start, startEnergy, 0, false);
    flip(start, startEnergy, hole, 1);
    if (hole === cluster) break;
  }
  const ranks = new Float32Array(CELLS);
  let bits = start.slice(),
    energy = startEnergy.slice();
  // Phase 1: the start pattern's cells, tightest cluster first, take the ranks below its count.
  for (let rank = ones - 1; rank >= 0; rank--) {
    const at = pick(bits, energy, 1, true);
    flip(bits, energy, at, -1);
    ranks[at] = rank;
  }
  // Phase 2: fill the largest voids up to half.
  bits = start.slice();
  energy = startEnergy.slice();
  let rank = ones;
  for (; rank < CELLS / 2; rank++) {
    const at = pick(bits, energy, 0, false);
    flip(bits, energy, at, 1);
    ranks[at] = rank;
  }
  // Phase 3: the zeros are now the minority; their tightest clusters go first.
  const zeros = new Float32Array(CELLS);
  for (let i = 0; i < CELLS; i++)
    if (!bits[i]) {
      const ax = i & mask,
        ay = i >> 4;
      for (let j = 0; j < CELLS; j++) zeros[j] += kernel[((((j >> 4) - ay) & mask) << 4) | (((j & mask) - ax) & mask)];
    }
  for (; rank < CELLS; rank++) {
    const at = pick(bits, zeros, 0, true);
    flip(bits, zeros, at, -1);
    ranks[at] = rank;
  }
  for (let i = 0; i < CELLS; i++) ranks[i] = (ranks[i] + 0.5) / CELLS;
  return ranks;
};
const tiles: Partial<Record<OccluderPattern, Float32Array>> = {};
/**
 * The 256 thresholds of a pattern's 16 by 16 tile, row by row, each rank once: a pixel draws while its threshold is
 * below the opacity. The same array is what the shaders read.
 * @throws RangeError for a pattern that is not `'bayer'` or `'blue'`.
 */
export function occluderThresholds(pattern: OccluderPattern = 'bayer'): Float32Array {
  if (pattern !== 'bayer' && pattern !== 'blue')
    throw new RangeError(`Occluder fade pattern must be 'bayer' or 'blue'${HELP}`);
  return (tiles[pattern] ??= pattern === 'blue' ? blue() : bayer());
}
/** The shaders' test on the CPU, for tests and tools: whether pixel (x, y) draws at `opacity` (1 draws every pixel). */
export function occluderKeeps(x: number, y: number, opacity: number, pattern: OccluderPattern = 'bayer'): boolean {
  return (
    opacity >= 1 ||
    occluderThresholds(pattern)[(Math.floor(y) & (TILE - 1)) * TILE + (Math.floor(x) & (TILE - 1))] < opacity
  );
}

const lookup = (cell: string) => `let k=(u32(at.y)&15u)*16u+(u32(at.x)&15u);return ${cell}<1.0-f;`;
/** core's mesh shader with the fade: the tile, then each mesh's faded share by mesh id, tested before anything is lit. */
export function coreOccluderShader(code: string): string {
  if (!code.includes('@location(3) material:vec4f') || code.includes('var<storage,read> occ_fades:')) return code;
  // The flat mesh id is shared with lod/fade, whichever of the two patches first.
  const withId = code.includes('lod_id:u32')
    ? code
    : code
        .replace(
          '@location(3) material:vec4f }',
          '@location(3) material:vec4f,@location(14) @interpolate(flat) lod_id:u32 }',
        )
        .replace('o.color=i.color.rgb;', 'o.color=i.color.rgb;o.lod_id=u32(i.factors.w);');
  return withId.replace(
    /@fragment fn fragment\(i:Output,@builtin\(front_facing\) front:bool\)->@location\(0\) vec4f \{/,
    (head) =>
      `@group(0) @binding(${CORE_BINDING}) var<storage,read> occ_fades:array<f32>;\nfn occ_keep(at:vec2f,f:f32)->bool {if(f<=0.0){return true;}${lookup('occ_fades[k]')}}\n${head}\nif(!occ_keep(i.clip.xy,occ_fades[${CELLS}u+i.lod_id])){discard;}`,
  );
}
/** gltf/pbr's shader with the fade, on every entry that shades a surface, read from the uniform at `group` binding 92. */
export function modelOccluderShader(code: string, group: number): string {
  return `struct OccFade {fade:vec4f,tile:array<vec4f,64>}\n@group(${group}) @binding(${MODEL_BINDING}) var<uniform> occ_fade:OccFade;\nfn occ_keep(at:vec2f)->bool {let f=occ_fade.fade.x;if(f<=0.0){return true;}${lookup('occ_fade.tile[k/4u][k%4u]')}}\n${code.replaceAll(
    'let s=surface(i,front);',
    'if(!occ_keep(i.clip.xy)){discard;}let s=surface(i,front);',
  )}`;
}

type Model = PBRModel & { readonly bounds: Float32Array };
const modelOf = (object: unknown): Model | undefined => {
  const model = (object as { model?: Model } | null)?.model ?? (object as Model | null);
  return typeof model?.addLighting === 'function' ? model : undefined;
};
const finite = (v: unknown, least: number, most = Infinity): v is number =>
  typeof v === 'number' && v >= least && v <= most && v < Infinity;
const checkQuery = ({ padding, layers, filter }: OccluderQuery): void => {
  if (padding !== undefined && !finite(padding, 0))
    throw new RangeError(`Occluder fade padding must be a world radius of 0 or more${HELP}`);
  if (layers !== undefined && !(Number.isInteger(layers) && layers >= 0 && layers <= 0xffffffff))
    throw new RangeError(`Occluder fade layers must be a mask in 0..0xffffffff${HELP}`);
  if (filter != null && typeof filter !== 'function')
    throw new TypeError(`Occluder fade filter must be a function or null${HELP}`);
};
const badTarget = () =>
  new TypeError(
    `Occluder fade targets are meshes, models, [x, y, z] or [x, y, z, radius], or functions returning those${HELP}`,
  );
/** A target's world sphere into `out`, and the object it is (to keep it from hiding itself) into `own`. False for one that is gone. */
function sphereOf(engine: Engine, target: OccluderTarget, out: Float64Array, own: Set<object>): boolean {
  const value = typeof target === 'function' ? target() : target;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const v = value as ArrayLike<number>;
    if ((v.length !== 3 && v.length !== 4) || !Array.prototype.every.call(v, Number.isFinite) || v[3] < 0)
      throw badTarget();
    out.set([v[0], v[1], v[2], v[3] ?? 0]);
    return true;
  }
  if (!value || typeof value !== 'object') throw badTarget();
  const model = modelOf(value);
  if (model) {
    if (model.disposed) return false;
    own.add(model);
    const b = model.bounds;
    if (!(b[0] <= b[3])) return false;
    out.set([
      (b[0] + b[3]) / 2,
      (b[1] + b[4]) / 2,
      (b[2] + b[5]) / 2,
      Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2,
    ]);
    return true;
  }
  const mesh = meshRuntime('root' in value ? (value as { root: Mesh }).root : (value as Mesh));
  if (typeof mesh?.id !== 'number') throw badTarget();
  if (engine.meshes.get(mesh.id) !== mesh) return false;
  own.add(mesh);
  worldSphere(engine, mesh.id, engine.store.bounds, mesh.id * 4, out);
  return true;
}
/** Local sphere `b[s..s+3]` under mesh `id`'s world matrix, into `out`. */
function worldSphere(engine: Engine, id: number, b: ArrayLike<number>, s: number, out: Float64Array): Float64Array {
  const m = engine.store.matrices,
    o = id * 16;
  out[0] = m[o] * b[s] + m[o + 4] * b[s + 1] + m[o + 8] * b[s + 2] + m[o + 12];
  out[1] = m[o + 1] * b[s] + m[o + 5] * b[s + 1] + m[o + 9] * b[s + 2] + m[o + 13];
  out[2] = m[o + 2] * b[s] + m[o + 6] * b[s + 1] + m[o + 10] * b[s + 2] + m[o + 14];
  out[3] =
    b[s + 3] *
    Math.sqrt(
      Math.max(
        m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2,
        m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2,
        m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2,
      ),
    );
  return out;
}
const restSpheres = new WeakMap<Float32Array, Float64Array>();
/** The rest-shape sphere of a model primitive's vertices (20 floats each), kept per vertex array. */
function restSphere(vertices: Float32Array): Float64Array {
  let sphere = restSpheres.get(vertices);
  if (!sphere) {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 20)
      for (let axis = 0; axis < 3; axis++) {
        lo[axis] = Math.min(lo[axis], vertices[i + axis]);
        hi[axis] = Math.max(hi[axis], vertices[i + axis]);
      }
    sphere = new Float64Array(4);
    if (lo[0] <= hi[0])
      sphere.set([
        (lo[0] + hi[0]) / 2,
        (lo[1] + hi[1]) / 2,
        (lo[2] + hi[2]) / 2,
        Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
      ]);
    restSpheres.set(vertices, sphere);
  }
  return sphere;
}
// ponytail: five parallel rays sample the padded sight line; a shape-cast capsule if thin occluders slip between them.
const OFFSETS = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1];
/**
 * The meshes and models whose triangles cross a sight line from `eye` to a target: one ray to the target's centre and,
 * with `padding` above 0, four more beside it at that distance. Each ray stops where it reaches the target's bounding
 * sphere, so a target never hides itself, nor does what is behind it. Returns core meshes, and models (a model or
 * materials mesh counts whole, as does an instanced one when any of its instances is crossed). A skinned or morphed
 * primitive has no triangles on the CPU in its pose, so it is tested by the bounding sphere of its rest shape.
 * Synchronous, CPU only;
 * the first query of a geometry builds its BVH (`computeGeometryBVHAsync` of `@margoengine/bvh` moves that to a worker).
 * @throws RangeError or TypeError for an option or target of the wrong kind or out of range.
 */
export function findOccluders(
  engine: EngineKernel,
  eye: readonly number[],
  targets: readonly OccluderTarget[],
  query: OccluderQuery = {},
  ray: Raycaster = new Raycaster(),
): Set<object> {
  checkQuery(query);
  if (!eye || eye.length < 3 || ![eye[0], eye[1], eye[2]].every(Number.isFinite))
    throw new TypeError(`Occluder fade needs an eye position [x, y, z]${HELP}`);
  if (!Array.isArray(targets)) throw badTarget();
  const { padding = 0.25, layers = 0xffffffff, filter } = query,
    runtime = engine as unknown as Engine,
    out = new Set<object>(),
    own = new Set<object>(),
    spheres: Float64Array[] = [];
  // World matrices of targets moved since the last frame.
  runtime.store.tick(false);
  for (const target of targets) {
    const sphere = new Float64Array(4);
    if (sphereOf(runtime, target, sphere, own)) spheres.push(sphere);
  }
  ray.near = 0;
  ray.side = 'double';
  ray.firstHitOnly = false;
  ray.layers = layers;
  // Posed primitives: the raycaster refuses them, so each is a world sphere tested here and kept from the raycaster.
  const posed = new Map<object, { model: object; sphere: Float64Array }>();
  for (const model of engineModels(runtime as never))
    for (const p of model.primitives)
      if (p.deformed && !posed.has(p.node)) {
        const node = meshRuntime(p.node);
        posed.set(node, {
          model,
          sphere: worldSphere(runtime, node.id, restSphere(p.vertices), 0, new Float64Array(4)),
        });
      }
  ray.filter = (mesh, model) => {
    if (own.has(model ?? meshRuntime(mesh)) || (filter && !filter(mesh, model))) return false;
    const pose = posed.get(meshRuntime(mesh));
    if (!pose) return true;
    const [cx, cy, cz, r] = pose.sphere,
      o = ray.origin,
      d = ray.direction,
      t = Math.min(Math.max((cx - o[0]) * d[0] + (cy - o[1]) * d[1] + (cz - o[2]) * d[2], 0), ray.far);
    if (r > 0 && Math.hypot(o[0] + d[0] * t - cx, o[1] + d[1] * t - cy, o[2] + d[2] * t - cz) <= r) out.add(pose.model);
    return false;
  };
  for (const [x, y, z, radius] of spheres) {
    const dx = x - eye[0],
      dy = y - eye[1],
      dz = z - eye[2],
      length = Math.hypot(dx, dy, dz),
      far = length - radius;
    if (!(far > 1e-6)) continue;
    const d = [dx / length, dy / length, dz / length],
      // Two unit vectors across the sight line.
      a = Math.abs(d[1]) < 0.9 ? [d[2], 0, -d[0]] : [0, -d[2], d[1]],
      al = Math.hypot(a[0], a[1], a[2]),
      u = [a[0] / al, a[1] / al, a[2] / al],
      v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    ray.far = far;
    for (let i = 0; i < (padding > 0 ? OFFSETS.length : 2); i += 2) {
      const p = OFFSETS[i] * padding,
        q = OFFSETS[i + 1] * padding;
      ray.set([eye[0] + u[0] * p + v[0] * q, eye[1] + u[1] * p + v[1] * q, eye[2] + u[2] * p + v[2] * q], d);
      for (const hit of ray.intersectEngine(runtime as never)) if (!hit.approximate) out.add(hit.model ?? hit.mesh);
    }
  }
  ray.filter = null;
  return out;
}

interface Fading {
  /** 0 solid, 1 fully faded. */
  amount: number;
  /** Writes the share of pixels to drop. */
  set(share: number): void;
  alive(): boolean;
}

/**
 * Keeps targets in view: every frame the meshes between the camera and each target dissolve to `minOpacity` over
 * `fadeTime` seconds, and return when they stop hiding it. Core meshes, gltf/pbr models and materials meshes fade
 * (a model, materials mesh or instanced mesh as a whole), on native WebGPU and the full WebGL2 compatibility layer.
 * Every option is a property and may change at any time, except `pattern`.
 * @throws RangeError or TypeError for an option out of range; MargoError `'unsupported'` on the small WebGL2 preview;
 * `'state'` when attached twice or updated before it is attached.
 */
export class OccluderFade implements EnginePlugin {
  readonly name = 'lod-occluder-fade';
  targets: OccluderTarget[];
  fadeTime: number;
  minOpacity: number;
  padding: number;
  layers: number;
  filter: ((mesh: Mesh, model?: object) => boolean) | null;
  camera: { readonly position: readonly number[] } | null;
  readonly pattern: OccluderPattern;
  /** False fades everything back in and finds nothing; true resumes. */
  enabled = true;
  private engine?: Engine;
  private readonly ray = new Raycaster();
  private readonly fades = new Map<object, Fading>();
  private hits: ReadonlySet<object> = new Set();
  private readonly effects = new Map<PBRModel, { buffer?: GPUBuffer; data: Float32Array; remove(): void }>();
  private readonly shaders = new Map<string, string>();
  /** What core's shader reads: the tile, then the faded share of each mesh id. */
  private values: Float32Array;
  private readonly touched = new Set<number>();
  private buffer?: GPUBuffer;
  private unlink?: () => void;
  /** Same as `engine.use(new OccluderFade(options))`; returns the OccluderFade. */
  static attach(engine: EngineKernel, options?: OccluderFadeOptions): OccluderFade {
    const value = new OccluderFade(options);
    engine.use(value);
    return value;
  }
  constructor(options: OccluderFadeOptions = {}) {
    const { targets = [], fadeTime = 0.25, minOpacity = 0.25, pattern = 'bayer', camera = null } = options;
    checkQuery(options);
    if (!Array.isArray(targets)) throw badTarget();
    if (!finite(fadeTime, 0)) throw new RangeError(`Occluder fade fadeTime must be seconds of 0 or more${HELP}`);
    if (!finite(minOpacity, 0, 1)) throw new RangeError(`Occluder fade minOpacity must be in 0..1${HELP}`);
    this.values = new Float32Array(CELLS);
    this.values.set(occluderThresholds(pattern));
    this.targets = [...targets];
    this.fadeTime = fadeTime;
    this.minOpacity = minOpacity;
    this.pattern = pattern;
    this.padding = options.padding ?? 0.25;
    this.layers = options.layers ?? 0xffffffff;
    this.filter = options.filter ?? null;
    this.camera = camera;
  }
  setup(engine: Engine): void {
    requireWebGPU(engine, 'OccluderFade');
    if (this.engine) throw new MargoError('state', `OccluderFade is in use; make one per engine${HELP}`);
    this.engine = engine;
    this.unlink = onStandIn(engine, (from, to) => this.adopt(from, to));
  }
  /**
   * `to` starts to draw in place of `from` (the incoming level of an lod/fade cross-fade, or the ghost of an outgoing
   * geometry): it takes `from`'s fade as it stands, at once, so the pair stays one surface with one opacity instead of
   * `to` starting solid and fading out again. The next update steps each on its own sight lines.
   */
  private adopt(from: object, to: object): void {
    const amount = this.fades.get(modelOf(from) ?? from)?.amount ?? 0,
      key = modelOf(to) ?? to;
    let fade = this.fades.get(key);
    if (!fade) {
      if (!amount) return;
      this.fades.set(key, (fade = this.fading(key)));
    }
    fade.amount = amount;
    fade.set(amount * (1 - this.minOpacity));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        let code = this.shaders.get(c.shader);
        if (!code) {
          if (this.shaders.size >= 64) this.shaders.clear();
          this.shaders.set(c.shader, (code = coreOccluderShader(c.shader)));
        }
        if (code === c.shader) return;
        c.shader = code;
        c.bindings.push({ binding: CORE_BINDING, resource: { buffer: this.upload(c.device) } });
      },
    });
  }
  private grow(): void {
    const size = CELLS + this.engine!.store.capacity;
    if (this.values.length >= size) return;
    const values = new Float32Array(size);
    values.set(this.values);
    this.values = values;
  }
  /** The core values on the GPU, sized to the store: only the meshes that changed are written. */
  private upload(device: GPUDevice): GPUBuffer {
    this.grow();
    if (!this.buffer || this.buffer.size < this.values.byteLength) {
      this.buffer?.destroy();
      this.buffer = device.createBuffer({
        size: this.values.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.buffer, 0, this.values);
      this.touched.clear();
    }
    for (const at of this.touched) device.queue.writeBuffer(this.buffer, at * 4, this.values, at, 1);
    this.touched.clear();
    return this.buffer;
  }
  /** What hid a target at the last update: core meshes and models. */
  get occluders(): ReadonlySet<object> {
    return this.hits;
  }
  /** Objects that are not fully solid now, those on their way back in included. */
  get active(): number {
    return this.fades.size;
  }
  /** The share of its pixels `object` (a core mesh, model or materials mesh) draws now: 1 when it is not fading. */
  opacityOf(object: object): number {
    const fade = this.fades.get(modelOf(object) ?? object);
    return fade ? 1 - fade.amount * (1 - this.minOpacity) : 1;
  }
  onPreUpdate(delta = 0): void {
    this.update(delta);
  }
  /**
   * Finds the occluders and steps every fade by `delta` seconds. The engine calls it each frame; call it yourself only
   * to step by hand.
   * @throws MargoError `'state'` before the plugin is attached; RangeError or TypeError for a property set out of range.
   */
  update(delta = 0): void {
    const engine = this.engine;
    if (!engine) throw new MargoError('state', `OccluderFade is on no engine; pass it to engine.use${HELP}`);
    if (!finite(this.fadeTime, 0)) throw new RangeError(`Occluder fade fadeTime must be seconds of 0 or more${HELP}`);
    if (!finite(this.minOpacity, 0, 1)) throw new RangeError(`Occluder fade minOpacity must be in 0..1${HELP}`);
    const hits = (this.hits = this.enabled
      ? findOccluders(
          engine as unknown as EngineKernel,
          (this.camera ?? engine.camera).position,
          this.targets,
          this,
          this.ray,
        )
      : new Set());
    for (const key of hits) if (!this.fades.has(key)) this.fades.set(key, this.fading(key));
    const step = this.fadeTime > 0 ? Math.max(delta, 0) / this.fadeTime : 1;
    for (const [key, fade] of this.fades) {
      const alive = fade.alive();
      fade.amount = !alive ? 0 : hits.has(key) ? Math.min(1, fade.amount + step) : Math.max(0, fade.amount - step);
      // A slot of a mesh that is gone is cleared too: the next mesh to take its id starts solid.
      fade.set(fade.amount * (1 - this.minOpacity));
      if (!fade.amount && !(alive && hits.has(key))) this.fades.delete(key);
    }
  }
  /** Ends every fade now: everything draws solid until the next update finds it again. */
  finish(): void {
    for (const fade of this.fades.values()) fade.set(0);
    this.fades.clear();
  }
  private fading(key: object): Fading {
    const engine = this.engine!,
      model = modelOf(key);
    if (model) {
      const set = this.effect(model);
      return { amount: 0, set, alive: () => !model.disposed };
    }
    const mesh = meshRuntime(key as Mesh),
      at = CELLS + mesh.id;
    return {
      amount: 0,
      set: (share) => {
        this.grow();
        if (this.values[at] === share) return;
        this.values[at] = share;
        this.touched.add(at);
      },
      alive: () => engine.meshes.get(mesh.id) === mesh,
    };
  }
  private effect(model: PBRModel): (share: number) => void {
    let entry = this.effects.get(model);
    if (!entry) {
      const made: { buffer?: GPUBuffer; data: Float32Array; remove(): void } = {
        data: new Float32Array(4 + CELLS),
        remove: () => {},
      };
      made.data.set(this.values.subarray(0, CELLS), 4);
      made.remove = model.addLighting({
        owner: this.engine,
        shader: modelOccluderShader,
        bindings: () => {
          const device = this.engine!.gpu!;
          if (!made.buffer) {
            made.buffer = device.createBuffer({
              size: made.data.byteLength,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(made.buffer, 0, made.data);
          }
          return [{ binding: MODEL_BINDING, resource: { buffer: made.buffer } }];
        },
      });
      model.onDispose(() => {
        made.buffer?.destroy();
        this.effects.delete(model);
      });
      this.effects.set(model, (entry = made));
    }
    const held = entry;
    return (share) => {
      if (held.data[0] === share) return;
      held.data[0] = share;
      if (held.buffer) this.engine?.gpu?.queue.writeBuffer(held.buffer, 0, held.data, 0, 4);
    };
  }
  onDeviceRestored(): void {
    for (const entry of this.effects.values()) entry.buffer = undefined;
    this.buffer = undefined;
  }
  dispose(): void {
    const engine = this.engine;
    this.finish();
    this.unlink?.();
    this.unlink = undefined;
    this.hits = new Set();
    for (const entry of this.effects.values()) {
      entry.remove();
      entry.buffer?.destroy();
    }
    this.effects.clear();
    this.buffer?.destroy();
    this.buffer = undefined;
    this.engine = undefined;
    // engine.removePlugin calls dispose again, which finds nothing left to free.
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
