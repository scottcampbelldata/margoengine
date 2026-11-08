/// <reference lib="esnext.disposable" preserve="true" />
// Planet terrain: a cube sphere quadtree. The six faces of a cube are each a quadtree of square patches; a point (s, t)
// of a face goes to the sphere through the equal-angle (tangent) warp, s' = tan(s pi / 4), then normalised, which keeps
// cell areas within a factor of about 1.4 of each other (Zucker and Higashi 2018, "Cube-to-sphere Projections for
// Procedural Texturing and Beyond", JCGT 7(2)). A patch splits into four while the spacing of its vertices seen from the
// camera is wider than `screenError` pixels, and patches of different levels meet with skirts hung from their edges,
// as chunked level of detail does (Ulrich 2002, "Rendering Massive Terrains using Chunked Level of Detail Control",
// SIGGRAPH course notes). Patches behind the planet's horizon are culled against a sphere under the lowest ground built
// so far (the horizon cone of Cozzi and Ring 2011, "3D Engine Design for Virtual Globes", chapter 12), the others against
// the view frustum, whose planes come from the rows of the view-projection matrix (Gribb and Hartmann 2001, "Fast
// Extraction of Viewing Frustum Planes from the World-View-Projection Matrix").
// Precision: every patch stores its vertices in float32 relative to its own centre, kept in float64 on the CPU. Each
// frame the CPU subtracts the camera position from each drawn patch's centre in float64 and the GPU adds the small
// float32 vertex offset, through a view-projection matrix with no translation (rendering relative to the eye: Cozzi and
// Ring 2011, chapter 5), so a planet of Earth's size draws without jitter from orbit to a metre above the ground. With a
// `FloatingOrigin` (`@margoengine/cameras/origin`) the planet's centre follows each rebase.
// The default ground is fractal value noise over the sphere (Ebert, Musgrave, Peachey, Perlin and Worley 2003,
// "Texturing and Modeling: A Procedural Approach", chapter 16), its lattice hashed as in Wellons 2018, "Prospecting for
// Hash Functions"; octaves finer than a patch's vertex spacing are left out, so coarse patches do not alias.
import type { EngineKernel } from '@margoengine/core';
import { type Camera, type Engine, type EnginePlugin, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { displayShader } from '../../shared/display.js';
import { applyView, viewSize } from '../../shared/view-rect.js';

/**
 * Ground height in metres above `radius` at a unit direction from the planet's centre (float64). `detail` is the
 * spacing in metres of the vertices being built there (0 for a query): a procedural height may skip detail finer than it.
 */
export type PlanetHeight = (x: number, y: number, z: number, detail: number) => number;

/** A `FloatingOrigin` (`@margoengine/cameras/origin`), or anything with its `origin` and `onRebase`. */
export interface PlanetOrigin {
  readonly origin: ArrayLike<number>;
  onRebase(listener: (shift: ArrayLike<number>, origin: ArrayLike<number>) => void): () => void;
}

/** `PlanetTerrain.attach` options. Every one is optional. */
export interface PlanetTerrainOptions {
  /** Radius in metres at height 0, above 0. Default 6,371,000 (the Earth's mean radius). */
  radius?: number;
  /** World position of the centre (float64). Default [0, 0, 0]. With `origin`, a world position: the planet draws at `center - origin.origin`. */
  center?: ArrayLike<number>;
  /** Ground height. Default `planetNoise({radius, relief, seed})`. */
  height?: PlanetHeight;
  /** Height range of the default ground and of the colours, in metres above 0. Default 8,000. */
  relief?: number;
  /** Seed of the default ground, an integer. Default 1. */
  seed?: number;
  /** Ground below this height draws as flat sea; `false` for none. Default 0. */
  seaLevel?: number | false;
  /** Quads along a patch's side, an even integer 4 to 64. Default 32. */
  resolution?: number;
  /** Deepest quadtree level, an integer 0 to 24. Default 20 (vertices 0.3 m apart on the Earth at resolution 32). */
  maxLevel?: number;
  /** A patch splits while its vertex spacing on screen is wider than this, in pixels, above 0. Default 4. */
  screenError?: number;
  /** Milliseconds a frame may spend building patches, at least one patch a frame; 0 or more, Infinity for no limit. Default 4. */
  budget?: number;
  /** Patches kept on the GPU at once, an integer 6 to 16,384 (about 24 KB each at resolution 32). Default 2,048. */
  maxPatches?: number;
  /** A floating origin to follow: the planet's centre moves with each rebase. */
  origin?: PlanetOrigin;
}

/** What the last planned frame did. */
export interface PlanetStats {
  /** Patches drawn. */
  drawn: number;
  /** Patches built (heights sampled, uploaded). */
  built: number;
  /** Patches on the GPU. */
  resident: number;
  /** Deepest level drawn. */
  level: number;
}

/** A drawn patch: cube face 0 to 5 (+X, -X, +Y, -Y, +Z, -Z), quadtree level and cell. */
export interface PlanetPatch {
  readonly face: number;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

// Each face: outward normal, then the s and t axes (s x t = normal).
const FACES = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
];

/**
 * The unit direction of point (s, t) of cube face `face` (0 to 5: +X, -X, +Y, -Y, +Z, -Z; s and t from -1 to 1), through
 * the equal-angle warp. Writes `out` (float64) and returns it. Points just past a face's edge continue onto its
 * neighbour's ground.
 */
export function cubeSphere(face: number, s: number, t: number, out: number[] | Float64Array = [0, 0, 0]): number[] | Float64Array {
  const f = FACES[face];
  if (!f) throw new RangeError('Invalid cube face; pass 0 to 5');
  const a = Math.tan((s * Math.PI) / 4),
    b = Math.tan((t * Math.PI) / 4),
    x = f[0] + f[3] * a + f[6] * b,
    y = f[1] + f[4] * a + f[7] * b,
    z = f[2] + f[5] * a + f[8] * b,
    l = Math.hypot(x, y, z);
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

// Wellons 2018's lowbias32 over a lattice point, to -1..1.
function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ seed;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}
/** Trilinear value noise with quintic fades, -1..1. */
function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z),
    fx = x - xi,
    fy = y - yi,
    fz = z - zi,
    u = fx * fx * fx * (fx * (fx * 6 - 15) + 10),
    v = fy * fy * fy * (fy * (fy * 6 - 15) + 10),
    w = fz * fz * fz * (fz * (fz * 6 - 15) + 10),
    s = Math.imul(seed, 0x165667b1),
    a = hash(xi, yi, zi, s),
    b = hash(xi + 1, yi, zi, s),
    c = hash(xi, yi + 1, zi, s),
    d = hash(xi + 1, yi + 1, zi, s),
    e = hash(xi, yi, zi + 1, s),
    f = hash(xi + 1, yi, zi + 1, s),
    g = hash(xi, yi + 1, zi + 1, s),
    h = hash(xi + 1, yi + 1, zi + 1, s),
    y0 = a + (b - a) * u + (c + (d - c) * u - a - (b - a) * u) * v,
    y1 = e + (f - e) * u + (g + (h - g) * u - e - (f - e) * u) * v;
  return y0 + (y1 - y0) * w;
}

/**
 * The default ground: fractal value noise over the sphere, about -`relief` to `relief` metres. Octave k has a
 * wavelength of `radius / 2^(k+1)` and an amplitude of `relief / 2^(k+1)`; octaves shorter than twice the `detail` asked
 * for are left out (at most 24).
 */
export function planetNoise({ radius = 6371000, relief = 8000, seed = 1 }: { radius?: number; relief?: number; seed?: number } = {}): PlanetHeight {
  if (!(radius > 0) || !Number.isFinite(radius) || !(relief >= 0) || !Number.isFinite(relief) || !Number.isInteger(seed))
    throw new RangeError('Invalid planetNoise options; pass radius above 0, relief 0 or more and an integer seed');
  return (x, y, z, detail) => {
    let sum = 0,
      wavelength = radius / 2,
      amplitude = relief / 2;
    for (let k = 0; k < 24 && wavelength >= 2 * detail; k++) {
      const f = radius / wavelength;
      // Each octave moves by its own offset, so the lattice planes of octaves do not line up.
      sum += amplitude * valueNoise(x * f + k * 7.31, y * f - k * 3.17, z * f + k * 5.79, seed + k);
      wavelength /= 2;
      amplitude /= 2;
    }
    return sum;
  };
}

interface Node {
  face: number;
  level: number;
  x: number;
  y: number;
  /** Arc length between neighbouring vertices, metres. */
  spacing: number;
  /** Centre (float64, relative to the planet's centre) and bounding radius of every vertex, skirts included. */
  center: Float64Array;
  bound: number;
  min: number;
  max: number;
  slot: number;
  used: number;
  children?: Node[];
}

const STRIDE = 20;

/** Grid then skirt indices of a patch with `n` quads a side (vertices: the grid row by row, then 4 skirts of n + 1). */
function patchIndices(n: number): Uint16Array {
  const grid = n + 1,
    out: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => out.push(a, b, d, a, d, c);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) quad(j * grid + i, j * grid + i + 1, (j + 1) * grid + i, (j + 1) * grid + i + 1);
  const edges = [(k: number) => k, (k: number) => n * grid + k, (k: number) => k * grid, (k: number) => k * grid + n];
  edges.forEach((edge, e) => {
    const skirt = grid * grid + e * grid;
    for (let k = 0; k < n; k++) quad(edge(k), edge(k + 1), skirt + k, skirt + k + 1);
  });
  return new Uint16Array(out);
}

const shader = /* wgsl */ `${displayShader}
struct Planet {viewProj:mat4x4f,center:vec4f,light:vec4f,radiance:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> planet:Planet;
struct Output {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) height:f32}
@vertex fn vertex(@location(0) local:vec3f,@location(1) normal:vec4f,@location(2) height:f32,@location(3) offset:vec3f)->Output {
  var o:Output;let p=offset+local;o.position=p;o.clip=planet.viewProj*vec4f(p,1);o.normal=normal.xyz;o.height=height;return o;
}
@fragment fn fragment(i:Output)->@location(0) vec4f {
  let up=normalize(i.position-planet.center.xyz);var n=normalize(i.normal);let relief=max(planet.params.z,1.0);let sea=planet.params.x;
  let t=(i.height-sea)/relief;let slope=1-clamp(dot(n,up),0.0,1.0);var base:vec3f;
  if(planet.params.w>0.5&&i.height<sea){base=mix(vec3f(0.035,0.12,0.22),vec3f(0.005,0.025,0.07),smoothstep(0.0,0.3,-t));n=up;}
  else {
    base=mix(vec3f(0.62,0.56,0.40),vec3f(0.16,0.27,0.09),smoothstep(0.002,0.02,t));
    base=mix(base,vec3f(0.38,0.33,0.22),smoothstep(0.15,0.45,t));
    base=mix(base,vec3f(0.33,0.31,0.29),max(smoothstep(0.3,0.5,slope),smoothstep(0.45,0.65,t)));
    base=mix(base,vec3f(0.85,0.87,0.9),smoothstep(0.68,0.75,t)*(1-smoothstep(0.35,0.55,slope)));
  }
  let nl=clamp(dot(n,normalize(planet.light.xyz)),0.0,1.0);
  let linear=base/3.14159265*nl*planet.radiance.xyz*planet.light.w+base*planet.radiance.w;
  if(planet.params.y>0.5){return vec4f(linear,1);}
  return vec4f(toDisplay(linear),1);
}
`;

/**
 * A planet's terrain: a cube sphere quadtree of height patches with skirts, drawn relative to the eye so it holds still
 * from orbit to the ground. `PlanetTerrain.attach(engine, options)`; every option has a default.
 * @throws RangeError or TypeError on an invalid option.
 */
export class PlanetTerrain implements EnginePlugin, Disposable {
  private static nextId = 0;
  readonly name = 'terrain-planet:' + PlanetTerrain.nextId++;
  readonly radius: number;
  readonly resolution: number;
  readonly maxLevel: number;
  readonly maxPatches: number;
  readonly seaLevel: number | false;
  readonly relief: number;
  screenError: number;
  budget: number;
  /** What the last planned frame did. */
  readonly stats: PlanetStats = { drawn: 0, built: 0, resident: 0, level: 0 };
  readonly #height: PlanetHeight;
  readonly #center = new Float64Array(3);
  readonly #shift = new Float64Array(3);
  readonly #roots: Node[] = [];
  readonly #resident: Node[] = [];
  readonly #free: number[] = [];
  readonly #drawn: Node[] = [];
  readonly #offsets: Float32Array;
  readonly #uniform = new Float32Array(32);
  readonly #viewProj = new Float64Array(16);
  readonly #planes = new Float64Array(24);
  readonly #vertices: number;
  readonly #indices: Uint16Array;
  readonly #samples: Float64Array;
  readonly #heights: Float64Array;
  readonly #data: ArrayBuffer;
  #lowest = Infinity;
  #frame = 0;
  #engine?: Engine;
  #device?: GPUDevice;
  #vertexBuffer?: GPUBuffer;
  #instanceBuffer?: GPUBuffer;
  #indexBuffer?: GPUBuffer;
  #uniformBuffer?: GPUBuffer;
  #group?: GPUBindGroup;
  #layout?: GPUBindGroupLayout;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  #unfollow?: () => void;
  #disposed = false;

  /** Same as `engine.use(new PlanetTerrain(options))`; returns the planet. */
  static attach(engine: EngineKernel, options: PlanetTerrainOptions = {}): PlanetTerrain {
    const planet = new PlanetTerrain(options);
    engine.use(planet);
    return planet;
  }

  constructor(options: PlanetTerrainOptions = {}) {
    const {
      radius = 6371000,
      center = [0, 0, 0],
      relief = 8000,
      seed = 1,
      seaLevel = 0,
      resolution = 32,
      maxLevel = 20,
      screenError = 4,
      budget = 4,
      maxPatches = 2048,
      origin,
    } = options;
    if (!(radius > 0) || !Number.isFinite(radius)) throw new RangeError('Invalid radius; pass metres above 0');
    if (center.length !== 3 || ![0, 1, 2].every((i) => Number.isFinite(center[i])))
      throw new RangeError('Invalid center; pass 3 finite numbers');
    if (!(relief >= 0) || !Number.isFinite(relief)) throw new RangeError('Invalid relief; pass metres, 0 or more');
    if (seaLevel !== false && !Number.isFinite(seaLevel)) throw new RangeError('Invalid seaLevel; pass metres or false');
    if (!Number.isInteger(resolution) || resolution < 4 || resolution > 64 || resolution % 2)
      throw new RangeError('Invalid resolution; pass an even integer 4 to 64');
    if (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > 24) throw new RangeError('Invalid maxLevel; pass an integer 0 to 24');
    if (!(screenError > 0) || !Number.isFinite(screenError)) throw new RangeError('Invalid screenError; pass pixels above 0');
    if (!(budget >= 0)) throw new RangeError('Invalid budget; pass milliseconds, 0 or more');
    if (!Number.isInteger(maxPatches) || maxPatches < 6 || maxPatches > 16384)
      throw new RangeError('Invalid maxPatches; pass an integer 6 to 16384');
    if (options.height !== undefined && typeof options.height !== 'function') throw new TypeError('Invalid height; pass a function');
    if (origin !== undefined && (typeof origin.onRebase !== 'function' || origin.origin?.length !== 3))
      throw new TypeError('Invalid origin; pass a FloatingOrigin');
    this.radius = radius;
    this.relief = relief;
    this.seaLevel = seaLevel;
    this.resolution = resolution;
    this.maxLevel = maxLevel;
    this.screenError = screenError;
    this.budget = budget;
    this.maxPatches = maxPatches;
    this.#height = options.height ?? planetNoise({ radius, relief, seed });
    this.#center.set([center[0], center[1], center[2]]);
    if (origin) {
      this.#shift.set([origin.origin[0], origin.origin[1], origin.origin[2]]);
      this.#unfollow = origin.onRebase((_, o) => this.#shift.set([o[0], o[1], o[2]]));
    }
    const grid = resolution + 1;
    this.#vertices = grid * grid + 4 * grid;
    this.#indices = patchIndices(resolution);
    this.#samples = new Float64Array((grid + 2) * (grid + 2) * 3);
    this.#heights = new Float64Array((grid + 2) * (grid + 2));
    this.#data = new ArrayBuffer(this.#vertices * STRIDE);
    this.#offsets = new Float32Array(maxPatches * 4);
    for (let i = maxPatches - 1; i >= 0; i--) this.#free.push(i);
    for (let face = 0; face < 6; face++) this.#roots.push(this.#node(face, 0, 0, 0));
  }

  /** World position of the planet's centre (float64; with `origin`, the world position before the origin is taken off). */
  get center(): [number, number, number] {
    return [this.#center[0], this.#center[1], this.#center[2]];
  }
  set center(value: ArrayLike<number>) {
    if (value?.length !== 3 || ![0, 1, 2].every((i) => Number.isFinite(value[i])))
      throw new RangeError('Invalid center; pass 3 finite numbers');
    this.#center.set([value[0], value[1], value[2]]);
  }

  /** The patches the last planned frame drew. */
  get patches(): PlanetPatch[] {
    return this.#drawn.map(({ face, level, x, y }) => ({ face, level, x, y }));
  }

  /** Ground height in metres at a direction from the centre (normalised here), at full detail. */
  heightAt(direction: ArrayLike<number>): number {
    const l = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(l > 0) || !Number.isFinite(l)) throw new RangeError('Invalid direction; pass 3 finite numbers, not all 0');
    return this.#ground(direction[0] / l, direction[1] / l, direction[2] / l, 0);
  }

  /** Height in metres of a point (the engine's coordinates, float64) above the ground (sea surface included) under it. */
  altitude(position: ArrayLike<number>): number {
    const c = this.#local(),
      x = position[0] - c[0],
      y = position[1] - c[1],
      z = position[2] - c[2],
      d = Math.hypot(x, y, z);
    if (!Number.isFinite(d)) throw new RangeError('Invalid position; pass 3 finite numbers');
    if (!d) return -this.radius;
    return d - this.radius - this.#ground(x / d, y / d, z / d, 0);
  }

  /** The centre in the engine's coordinates: `center` less the floating origin. */
  #local(): [number, number, number] {
    return [this.#center[0] - this.#shift[0], this.#center[1] - this.#shift[1], this.#center[2] - this.#shift[2]];
  }

  #ground(x: number, y: number, z: number, detail: number): number {
    const h = this.#raw(x, y, z, detail);
    return this.seaLevel === false ? h : Math.max(h, this.seaLevel);
  }

  #raw(x: number, y: number, z: number, detail: number): number {
    const h = this.#height(x, y, z, detail);
    if (!Number.isFinite(h)) throw new RangeError('PlanetTerrain height returned a value that is not finite; return finite metres from height');
    return h;
  }

  #node(face: number, level: number, x: number, y: number): Node {
    const size = 2 / 2 ** level,
      s0 = -1 + x * size,
      t0 = -1 + y * size,
      a = cubeSphere(face, s0, t0),
      b = cubeSphere(face, s0 + size, t0),
      c = cubeSphere(face, s0, t0 + size),
      angle = (p: ArrayLike<number>, q: ArrayLike<number>) => Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
    return {
      face,
      level,
      x,
      y,
      spacing: (this.radius * Math.max(angle(a, b), angle(a, c))) / this.resolution,
      center: new Float64Array(3),
      bound: 0,
      min: 0,
      max: 0,
      slot: -1,
      used: -1,
    };
  }

  /** Samples a patch's heights with a one-sample border, writes its vertices and uploads them to a free slot. */
  #build(node: Node): boolean {
    if (!this.#free.length && !this.#evict()) return false;
    const n = this.resolution,
      grid = n + 1,
      side = grid + 2,
      size = 2 / 2 ** node.level,
      s0 = -1 + node.x * size,
      t0 = -1 + node.y * size,
      p = this.#samples,
      hs = this.#heights,
      dir = [0, 0, 0];
    let min = Infinity,
      max = -Infinity;
    for (let j = -1; j <= grid; j++)
      for (let i = -1; i <= grid; i++) {
        cubeSphere(node.face, s0 + (i / n) * size, t0 + (j / n) * size, dir);
        // The colour reads the ground's own height (below the sea too); the surface stands on the sea where it is lower.
        const raw = this.#raw(dir[0], dir[1], dir[2], node.spacing),
          h = this.seaLevel === false ? raw : Math.max(raw, this.seaLevel),
          k = (j + 1) * side + i + 1,
          r = this.radius + h;
        hs[k] = raw;
        p[k * 3] = dir[0] * r;
        p[k * 3 + 1] = dir[1] * r;
        p[k * 3 + 2] = dir[2] * r;
        if (i >= 0 && j >= 0 && i < grid && j < grid) {
          if (h < min) min = h;
          if (h > max) max = h;
        }
      }
    const mid = ((n / 2 + 1) * side + n / 2 + 1) * 3,
      c = node.center;
    c[0] = p[mid];
    c[1] = p[mid + 1];
    c[2] = p[mid + 2];
    // Skirts hang below the lowest point a coarser or finer neighbour can put on the shared edge.
    const skirt = max - min + 2 * node.spacing,
      f32 = new Float32Array(this.#data),
      i8 = new Int8Array(this.#data);
    let bound = 0;
    const put = (v: number, k: number, drop: number) => {
      const r = Math.hypot(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]),
        scale = (r - drop) / r,
        x = p[k * 3] * scale - c[0],
        y = p[k * 3 + 1] * scale - c[1],
        z = p[k * 3 + 2] * scale - c[2];
      bound = Math.max(bound, Math.hypot(x, y, z));
      f32[v * 5] = x;
      f32[v * 5 + 1] = y;
      f32[v * 5 + 2] = z;
      f32[v * 5 + 4] = hs[k];
      // Normal from central differences across the border (s x t points outward).
      const e = (k + 1) * 3,
        w = (k - 1) * 3,
        north = (k + side) * 3,
        south = (k - side) * 3,
        ax = p[e] - p[w],
        ay = p[e + 1] - p[w + 1],
        az = p[e + 2] - p[w + 2],
        bx = p[north] - p[south],
        by = p[north + 1] - p[south + 1],
        bz = p[north + 2] - p[south + 2],
        nx = ay * bz - az * by,
        ny = az * bx - ax * bz,
        nz = ax * by - ay * bx,
        nl = Math.hypot(nx, ny, nz) || 1;
      i8[v * STRIDE + 12] = Math.round((nx / nl) * 127);
      i8[v * STRIDE + 13] = Math.round((ny / nl) * 127);
      i8[v * STRIDE + 14] = Math.round((nz / nl) * 127);
      i8[v * STRIDE + 15] = 0;
    };
    const at = (i: number, j: number) => (j + 1) * side + i + 1;
    for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) put(j * grid + i, at(i, j), 0);
    const edges = [(k: number) => at(k, 0), (k: number) => at(k, n), (k: number) => at(0, k), (k: number) => at(n, k)];
    edges.forEach((edge, e) => {
      for (let k = 0; k < grid; k++) put(grid * grid + e * grid + k, edge(k), skirt);
    });
    node.bound = bound;
    node.min = min;
    node.max = max;
    node.slot = this.#free.pop()!;
    this.#resident.push(node);
    if (min < this.#lowest) this.#lowest = min;
    this.#device?.queue.writeBuffer(this.#vertexBuffer!, node.slot * this.#vertices * STRIDE, this.#data);
    this.stats.built++;
    return true;
  }

  /** Frees the slot of the patch used longest ago that this frame has not touched; roots stay. */
  #evict(): boolean {
    let oldest = -1;
    for (let i = 0; i < this.#resident.length; i++) {
      const node = this.#resident[i];
      if (node.level && node.used < this.#frame && (oldest < 0 || node.used < this.#resident[oldest].used)) oldest = i;
    }
    if (oldest < 0) return false;
    const [node] = this.#resident.splice(oldest, 1);
    this.#free.push(node.slot);
    node.slot = -1;
    return true;
  }

  /**
   * Plans a frame for `camera` drawn `size` pixels wide and high: picks the patches, builds those it needs within the
   * budget and fills the per-patch offsets. The frame calls it; call it yourself to warm the patches up before a cut.
   * Returns `stats`.
   */
  update(camera: Camera, size: readonly [number, number]): PlanetStats {
    if (this.#disposed) throw margoError('disposed', 'PlanetTerrain is disposed; attach a new one');
    const [width, height] = size;
    if (!(width > 0) || !(height > 0)) throw new RangeError('Invalid size; pass pixels above 0');
    this.#frame++;
    this.stats.built = 0;
    this.#drawn.length = 0;
    const eye = camera.position,
      c = this.#local(),
      ex = eye[0] - c[0],
      ey = eye[1] - c[1],
      ez = eye[2] - c[2];
    this.#matrix(camera, width / height);
    const k = height / 2 / Math.tan((camera.fov * Math.PI) / 360),
      d = Math.hypot(ex, ey, ez),
      r = this.radius + Math.min(this.#lowest, this.seaLevel === false ? Infinity : this.seaLevel) - 1,
      horizon = d > r && r > 0,
      cone = horizon ? Math.asin(r / d) : 0,
      plane = horizon ? (d * d - r * r) / d : 0,
      start = performance.now();
    let builds = 0;
    const wants: { node: Node; error: number }[] = [];
    const budget = () => builds === 0 || performance.now() - start < this.budget;
    const visible = (node: Node): boolean => {
      // Centre relative to the eye.
      const qx = node.center[0] - ex,
        qy = node.center[1] - ey,
        qz = node.center[2] - ez,
        rb = node.bound;
      const pl = this.#planes;
      for (let i = 0; i < 24; i += 4) if (pl[i] * qx + pl[i + 1] * qy + pl[i + 2] * qz + pl[i + 3] < -rb) return false;
      if (!horizon) return true;
      const q = Math.hypot(qx, qy, qz);
      if (q <= rb) return true;
      // Inside the cone of the occluding sphere and behind the plane of its tangent circle: hidden.
      const along = -(qx * ex + qy * ey + qz * ez) / d,
        theta = Math.acos(Math.max(-1, Math.min(1, along / q)));
      return !(theta + Math.asin(rb / q) < cone && along - rb > plane);
    };
    const visit = (node: Node) => {
      node.used = this.#frame;
      if (!visible(node)) return;
      const dx = node.center[0] - ex,
        dy = node.center[1] - ey,
        dz = node.center[2] - ez,
        distance = Math.max(Math.hypot(dx, dy, dz) - node.bound, camera.near),
        split = node.level < this.maxLevel && (node.spacing * k) / distance > this.screenError;
      if (split) {
        node.children ??= [0, 1, 2, 3].map((q) =>
          this.#node(node.face, node.level + 1, node.x * 2 + (q & 1), node.y * 2 + (q >> 1)),
        );
        let ready = true;
        for (const child of node.children) {
          child.used = this.#frame;
          if (child.slot < 0) ready = false;
        }
        if (ready) {
          for (const child of node.children) visit(child);
          return;
        }
        // Drawn whole until all four children are built; the widest error on screen is built first.
        wants.push({ node, error: (node.spacing * k) / distance });
      }
      if (this.#drawn.length < this.maxPatches) {
        const o = this.#drawn.length * 4;
        this.#offsets[o] = dx;
        this.#offsets[o + 1] = dy;
        this.#offsets[o + 2] = dz;
        this.#drawn.push(node);
      }
    };
    for (const root of this.#roots) {
      root.used = this.#frame;
      if (root.slot < 0) this.#build(root);
    }
    // Plan, build the children the plan wants (widest error first) while the budget lasts, and plan again with them,
    // until nothing more is wanted, the budget is spent or no slot can be freed.
    let more = true;
    while (more) {
      this.#drawn.length = 0;
      wants.length = 0;
      for (const root of this.#roots) visit(root);
      wants.sort((a, b) => b.error - a.error);
      more = false;
      // A batch is the wants within half the widest error, so the ground nearest the camera is refined first.
      const cut = (wants[0]?.error ?? 0) / 2;
      build: for (const { node, error } of wants)
        for (const child of error >= cut ? node.children! : [])
          if (child.slot < 0) {
            if (!budget() || !this.#build(child)) break build;
            child.used = this.#frame;
            builds++;
            more = true;
          }
    }
    this.stats.drawn = this.#drawn.length;
    this.stats.resident = this.#resident.length;
    this.stats.level = this.#drawn.reduce((m, n) => Math.max(m, n.level), 0);
    return this.stats;
  }

  /** The view-projection without translation (the eye at the origin), float64, and its frustum planes. */
  #matrix(camera: Camera, aspect: number): void {
    const p = camera.position,
      t = camera.target,
      u = camera.up;
    let zx = p[0] - t[0],
      zy = p[1] - t[1],
      zz = p[2] - t[2];
    const zl = Math.hypot(zx, zy, zz);
    if (!zl) throw new RangeError('Camera at target; move camera.position off camera.target');
    zx /= zl;
    zy /= zl;
    zz /= zl;
    let xx = u[1] * zz - u[2] * zy,
      xy = u[2] * zx - u[0] * zz,
      xz = u[0] * zy - u[1] * zx;
    const xl = Math.hypot(xx, xy, xz);
    if (!xl) throw new RangeError('Vertical camera; set camera.up off the view direction');
    xx /= xl;
    xy /= xl;
    xz /= xl;
    const yx = zy * xz - zz * xy,
      yy = zz * xx - zx * xz,
      yz = zx * xy - zy * xx;
    // Rows of the view rotation, as core's camera builds them.
    const view = [xx, xy, xz, yx, yy, yz, zx, zy, zz],
      proj = new Float64Array(16);
    if (camera.project) camera.project(proj, aspect, true);
    else {
      const f = 1 / Math.tan((camera.fov * Math.PI) / 360),
        dn = camera.near - camera.far;
      proj[0] = f / aspect;
      proj[5] = f;
      proj[10] = -camera.near / dn;
      proj[11] = -1;
      proj[14] = (-camera.far * camera.near) / dn;
    }
    const m = this.#viewProj;
    for (let col = 0; col < 3; col++)
      for (let row = 0; row < 4; row++)
        m[col * 4 + row] = proj[row] * view[col] + proj[4 + row] * view[3 + col] + proj[8 + row] * view[6 + col];
    for (let row = 0; row < 4; row++) m[12 + row] = proj[12 + row];
    const pl = this.#planes,
      rowOf = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]],
      r0 = rowOf(0),
      r1 = rowOf(1),
      r2 = rowOf(2),
      r3 = rowOf(3);
    [r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]), r3.map((v, i) => v + r1[i]), r3.map((v, i) => v - r1[i]), r2, r3.map((v, i) => v - r2[i])].forEach((q, i) => {
      const l = Math.hypot(q[0], q[1], q[2]) || 1;
      for (let j = 0; j < 4; j++) pl[i * 4 + j] = q[j] / l;
    });
  }

  setup(engine: Engine): void {
    if (this.#disposed || !engine.gpu)
      throw margoError(this.#disposed ? 'disposed' : 'unsupported', 'PlanetTerrain requires WebGPU and a live planet; attach a new PlanetTerrain to a WebGPU engine');
    this.#engine = engine;
    this.#create(engine.gpu);
  }

  #create(device: GPUDevice): void {
    this.#device = device;
    this.#vertexBuffer = device.createBuffer({ size: this.maxPatches * this.#vertices * STRIDE, usage: 0x20 | 0x8 });
    this.#instanceBuffer = device.createBuffer({ size: this.maxPatches * 16, usage: 0x20 | 0x8 });
    this.#indexBuffer = device.createBuffer({ size: Math.ceil(this.#indices.byteLength / 4) * 4, usage: 0x10 | 0x8 });
    const padded = new Uint16Array(this.#indexBuffer.size / 2);
    padded.set(this.#indices);
    device.queue.writeBuffer(this.#indexBuffer, 0, padded);
    this.#uniformBuffer = device.createBuffer({ size: 128, usage: 0x40 | 0x8 });
    this.#layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1 | 2, buffer: { type: 'uniform' } }],
    });
    this.#group = device.createBindGroup({ layout: this.#layout, entries: [{ binding: 0, resource: { buffer: this.#uniformBuffer } }] });
    // Every slot is empty on a new device: the tree is planned again from the roots.
    this.#resident.length = 0;
    this.#free.length = 0;
    for (let i = this.maxPatches - 1; i >= 0; i--) this.#free.push(i);
    const reset = (node: Node) => {
      node.slot = -1;
      node.children?.forEach(reset);
    };
    this.#roots.forEach(reset);
    this.#lowest = Infinity;
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':prepare',
      order: -6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.#prepare(c);
      },
    });
    graph.add({
      name: this.name,
      order: 1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.#draw(c);
      },
    });
  }

  #prepare(c: PassContext & { backend: 'webgpu' }): void {
    this.update(c.camera, viewSize(c));
    const u = this.#uniform,
      e = this.#engine!,
      eye = c.camera.position,
      l = this.#local();
    u.set(this.#viewProj);
    u.set([l[0] - eye[0], l[1] - eye[1], l[2] - eye[2], this.radius], 16);
    u.set(e.lighting.direction, 20);
    u.set(e.lighting.radiance, 24);
    u.set([this.seaLevel === false ? 0 : this.seaLevel, +(c.format === 'rgba16float'), this.relief, +(this.seaLevel !== false)], 28);
    c.device.queue.writeBuffer(this.#uniformBuffer!, 0, u as Float32Array<ArrayBuffer>);
    if (this.#drawn.length) c.device.queue.writeBuffer(this.#instanceBuffer!, 0, this.#offsets as Float32Array<ArrayBuffer>, 0, this.#drawn.length * 4);
  }

  #draw(c: PassContext & { backend: 'webgpu' }): void {
    if (!this.#drawn.length) return;
    const depth = c.descriptor.depthStencil!.format,
      key = c.descriptor.multisample?.count + ':' + c.format + ':' + depth;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code: shader });
      pipeline = c.device.createRenderPipeline({
        layout: c.device.createPipelineLayout({ bindGroupLayouts: [this.#layout!] }),
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: STRIDE,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'snorm8x4' },
                { shaderLocation: 2, offset: 16, format: 'float32' },
              ],
            },
            { arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x3' }] },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: { format: depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      });
      this.#pipelines.set(key, pipeline);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: c.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(depth.includes('stencil') ? { stencilLoadOp: 'load', stencilStoreOp: 'store' } : {}),
      },
    });
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#group!);
    pass.setVertexBuffer(0, this.#vertexBuffer!);
    pass.setVertexBuffer(1, this.#instanceBuffer!);
    pass.setIndexBuffer(this.#indexBuffer!, 'uint16');
    for (let i = 0; i < this.#drawn.length; i++) {
      pass.drawIndexed(this.#indices.length, 1, 0, this.#drawn[i].slot * this.#vertices, i);
      this.#engine!.stats.drawCalls++;
    }
    pass.end();
  }

  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.#pipelines.clear();
    this.#create(engine.gpu!);
  }

  #release(): void {
    this.#vertexBuffer?.destroy();
    this.#instanceBuffer?.destroy();
    this.#indexBuffer?.destroy();
    this.#uniformBuffer?.destroy();
    this.#vertexBuffer = this.#instanceBuffer = this.#indexBuffer = this.#uniformBuffer = undefined;
  }

  /** Detaches from the engine and frees the GPU buffers; also `using`. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unfollow?.();
    this.#release();
    this.#pipelines.clear();
    this.#engine?.removePlugin(this.name);
    this.#engine = this.#device = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
