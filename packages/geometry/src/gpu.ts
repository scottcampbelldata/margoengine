// Geometry built on the GPU. A compute pass ahead of the scene writes positions and normals straight into the vertex
// buffer the engine draws from, every frame, so meshes that change all the time cost no vertex upload. A surface is a
// WGSL function of (u, v). A tube or ribbon follows control points on the GPU, with frames from the double reflection
// method (W. Wang, B. Juttler, D. Zheng and Y. Liu, "Computation of rotation minimizing frames", 2008).
import { Geometry } from '@margoengine/core';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** A bounding sphere as `[x, y, z, radius]`, or just its radius around the origin. */
export type GpuBounds = number | readonly [number, number, number, number];

/** Options every generated geometry takes. */
export interface GpuGeometryOptions {
  /** Where the geometry can reach, for culling. Default a radius of 1,000,000, which is never culled. */
  bounds?: GpuBounds;
  /** Four numbers the shader reads, also settable later through `params`. */
  params?: readonly [number, number, number, number];
}

/** Options of {@link GeometryGenerator.surface}. */
export interface GpuSurfaceOptions extends GpuGeometryOptions {
  /** Cells along u. Default 64. */
  columns?: number;
  /** Cells along v. Default 64. */
  rows?: number;
  /**
   * WGSL with `fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f`. Normals are `dP/du x dP/dv` by differences,
   * so a surface whose parameters turn counter-clockwise seen from outside faces out.
   */
  code: string;
}

/** Options of {@link GeometryGenerator.grid}. */
export interface GpuGridOptions extends GpuGeometryOptions {
  /** Size along x. Default 1. */
  width?: number;
  /** Size along z. Default 1. */
  depth?: number;
  columns?: number;
  rows?: number;
  /** WGSL with `fn height(u: f32, v: f32, time: f32, p: vec4f) -> f32`. Default flat. */
  code?: string;
}

/** Options of {@link GeometryGenerator.sphere}. `params[0]` is the radius. */
export interface GpuSphereOptions extends GpuGeometryOptions {
  /** Default 1. */
  radius?: number;
  columns?: number;
  rows?: number;
}

/** Options of {@link GeometryGenerator.torus}. `params` holds both radii. */
export interface GpuTorusOptions extends GpuGeometryOptions {
  /** Default 1. */
  radius?: number;
  /** Default 0.25. */
  tube?: number;
  columns?: number;
  rows?: number;
}

/** Options of {@link GeometryGenerator.cylinder}, the open side wall. `params` holds both radii and the height. */
export interface GpuCylinderOptions extends GpuGeometryOptions {
  /** Default 1. */
  radiusTop?: number;
  /** Default 1. */
  radiusBottom?: number;
  /** Default 1. */
  height?: number;
  columns?: number;
  rows?: number;
}

/** Options of {@link GeometryGenerator.tube} and {@link GeometryGenerator.ribbon}. */
export interface GpuPathOptions extends GpuGeometryOptions {
  /** How many control points the path has, at least 2 (3 when closed). */
  points: number;
  /** Rows along the path. Default 16 per control point. */
  segments?: number;
  /** The path is a loop. Default false. */
  closed?: boolean;
  /** Starting direction of the frames' normal. Default the axis least along the path. */
  up?: readonly [number, number, number];
}

/** Options of {@link GeometryGenerator.tube}. */
export interface GpuTubeOptions extends GpuPathOptions {
  /** Radius; each control point's `w` multiplies it. Default 0.1. */
  radius?: number;
  /** Sides around the tube. Default 8. */
  sides?: number;
}

/** Options of {@link GeometryGenerator.ribbon}. */
export interface GpuRibbonOptions extends GpuPathOptions {
  /** Width; each control point's `w` multiplies it. Default 0.2. */
  width?: number;
  /** Cells across. Default 1. */
  columns?: number;
}

/** Vertex data read back from the GPU. */
export interface GpuGeometryData {
  positions: Float32Array;
  normals: Float32Array;
}

/** Bytes of one vertex in core's buffers: position then normal, three floats each. */
const STRIDE = 24;
const GROUP = 64;
/** Core's largest geometry. */
const MAX_VERTICES = 1_000_000;

const HEADER = /* wgsl */ `
struct Settings { columns: u32, rows: u32, time: f32, closed: u32, p: vec4f, up: vec4f }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read_write> vertices: array<f32>;
const PI = 3.14159265358979;
fn put(index: u32, position: vec3f, normal: vec3f) {
  let at = index * 6u;
  vertices[at] = position.x; vertices[at + 1u] = position.y; vertices[at + 2u] = position.z;
  vertices[at + 3u] = normal.x; vertices[at + 4u] = normal.y; vertices[at + 5u] = normal.z;
}
`;

const SURFACE_MAIN = /* wgsl */ `
fn at(u: f32, v: f32) -> vec3f { return surface(u, v, settings.time, settings.p); }
fn normalAt(u: f32, v: f32, du: f32, dv: f32) -> vec3f {
  let normal = cross(at(u + du, v) - at(u - du, v), at(u, v + dv) - at(u, v - dv));
  let size = length(normal);
  if (size > 0.0) { return normal / size; }
  return normal;
}
@compute @workgroup_size(${GROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let across = settings.columns + 1u;
  if (id.x >= across * (settings.rows + 1u)) { return; }
  let column = id.x % across;
  let row = id.x / across;
  let u = f32(column) / f32(settings.columns);
  let v = f32(row) / f32(settings.rows);
  let du = 0.25 / f32(settings.columns);
  let dv = 0.25 / f32(settings.rows);
  // At a pole every u gives one point, so the first and last rows carry the normal on from two samples inside.
  var normal = normalAt(u, v, du, dv);
  if (row == 0u) { normal = 2.0 * normalAt(u, dv, du, dv) - normalAt(u, 2.0 * dv, du, dv); }
  if (row == settings.rows) { normal = 2.0 * normalAt(u, 1.0 - dv, du, dv) - normalAt(u, 1.0 - 2.0 * dv, du, dv); }
  let size = length(normal);
  if (size > 0.0) { normal = normal / size; }
  put(id.x, at(u, v), normal);
}
`;

const GRID = (code: string) => /* wgsl */ `
${code}
fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f {
  return vec3f((u - 0.5) * p.x, height(u, v, time, p), (0.5 - v) * p.y);
}
`;

const FLAT = /* wgsl */ `fn height(u: f32, v: f32, time: f32, p: vec4f) -> f32 { return 0.0; }`;

const SPHERE = /* wgsl */ `
fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f {
  let around = -2.0 * PI * u;
  let down = PI * (1.0 - v);
  return p.x * vec3f(sin(down) * cos(around), cos(down), sin(down) * sin(around));
}
`;

const TORUS = /* wgsl */ `
fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f {
  let around = -2.0 * PI * u;
  let section = 2.0 * PI * v;
  let reach = p.x + p.y * cos(section);
  return vec3f(reach * cos(around), p.y * sin(section), reach * sin(around));
}
`;

const CYLINDER = /* wgsl */ `
fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f {
  let around = -2.0 * PI * u;
  let radius = mix(p.y, p.x, v);
  return vec3f(radius * cos(around), (v - 0.5) * p.z, radius * sin(around));
}
`;

const PATH_HEADER = /* wgsl */ `
struct Frame { centre: vec4f, normal: vec4f, tangent: vec4f }
@group(0) @binding(2) var<storage, read> points: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> frames: array<Frame>;
fn point(index: i32) -> vec4f {
  let count = i32(arrayLength(&points));
  if (settings.closed != 0u) { return points[(index + count) % count]; }
  if (index < 0) { return 2.0 * points[0] - points[1]; }
  if (index >= count) { return 2.0 * points[count - 1] - points[count - 2]; }
  return points[index];
}
// A uniform Catmull-Rom curve through the points; s runs over the whole path, 0 to 1.
fn pathAt(s: f32) -> vec4f {
  let spans = i32(arrayLength(&points)) - select(1, 0, settings.closed != 0u);
  let x = clamp(s, 0.0, 1.0) * f32(spans);
  let span = min(i32(x), spans - 1);
  let t = x - f32(span);
  let a = point(span - 1); let b = point(span); let c = point(span + 1); let d = point(span + 2);
  return b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a)));
}
fn pathTangent(s: f32) -> vec3f {
  let step = 0.25 / f32(settings.rows);
  var behind = s - step;
  var ahead = s + step;
  if (settings.closed == 0u) { behind = max(behind, 0.0); ahead = min(ahead, 1.0); }
  else { behind = fract(behind + 1.0); ahead = fract(ahead); }
  return normalize(pathAt(ahead).xyz - pathAt(behind).xyz);
}
fn across(direction: vec3f, tangent: vec3f) -> vec3f {
  return normalize(direction - tangent * dot(direction, tangent));
}
// One invocation walks the path: each frame depends on the one before.
@compute @workgroup_size(1) fn walk() {
  let rows = settings.rows;
  var tangent = pathTangent(0.0);
  var normal: vec3f;
  let wanted = settings.up.xyz;
  if (dot(wanted, wanted) > 0.0 && length(cross(wanted, tangent)) > 1e-5) { normal = across(wanted, tangent); }
  else {
    let size = abs(tangent);
    var axis = vec3f(0.0, 0.0, 1.0);
    if (size.x <= size.y && size.x <= size.z) { axis = vec3f(1.0, 0.0, 0.0); }
    else if (size.y <= size.z) { axis = vec3f(0.0, 1.0, 0.0); }
    normal = across(axis, tangent);
  }
  let first = normal;
  var here = pathAt(0.0);
  frames[0] = Frame(here, vec4f(normal, 0.0), vec4f(tangent, 0.0));
  for (var i = 1u; i <= rows; i = i + 1u) {
    let s = f32(i) / f32(rows);
    let next = pathAt(s);
    let nextTangent = pathTangent(select(s, 0.0, settings.closed != 0u && i == rows));
    let v1 = next.xyz - here.xyz;
    let c1 = dot(v1, v1);
    if (c1 > 0.0) {
      let turned = normal - (2.0 / c1) * dot(v1, normal) * v1;
      let turnedTangent = tangent - (2.0 / c1) * dot(v1, tangent) * v1;
      let v2 = nextTangent - turnedTangent;
      let c2 = dot(v2, v2);
      normal = turned;
      if (c2 > 0.0) { normal = turned - (2.0 / c2) * dot(v2, turned) * v2; }
    }
    normal = across(normal, nextTangent);
    tangent = nextTangent;
    here = next;
    frames[i] = Frame(here, vec4f(normal, 0.0), vec4f(tangent, 0.0));
  }
  if (settings.closed != 0u) {
    // Spread what is left of the turn after one lap evenly over the frames, so the last meets the first.
    let t = frames[0].tangent.xyz;
    let miss = atan2(dot(cross(normal, first), t), dot(normal, first));
    for (var i = 1u; i <= rows; i = i + 1u) {
      let angle = miss * f32(i) / f32(rows);
      let f = frames[i];
      let n = f.normal.xyz;
      let side = cross(f.tangent.xyz, n);
      frames[i].normal = vec4f(n * cos(angle) + side * sin(angle), 0.0);
    }
  }
}
`;

const TUBE_MAIN = /* wgsl */ `
@compute @workgroup_size(${GROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let around = settings.columns + 1u;
  if (id.x >= around * (settings.rows + 1u)) { return; }
  let f = frames[id.x / around];
  let angle = 2.0 * PI * f32(id.x % around) / f32(settings.columns);
  let n = f.normal.xyz;
  let direction = cos(angle) * n + sin(angle) * cross(f.tangent.xyz, n);
  put(id.x, f.centre.xyz + direction * settings.p.x * f.centre.w, direction);
}
`;

const RIBBON_MAIN = /* wgsl */ `
@compute @workgroup_size(${GROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let across = settings.columns + 1u;
  if (id.x >= across * (settings.rows + 1u)) { return; }
  let f = frames[id.x / across];
  let n = f.normal.xyz;
  let share = f32(id.x % across) / f32(settings.columns) - 0.5;
  put(id.x, f.centre.xyz + n * share * settings.p.x * f.centre.w, cross(n, f.tangent.xyz));
}
`;

const COPY = /* wgsl */ `
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> copied: array<f32>;
@compute @workgroup_size(${GROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&copied)) { copied[id.x] = source[id.x]; }
}
`;

function cells(value: number | undefined, fallback: number, name: string): number {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`Invalid ${name}; pass a whole number of at least 1`);
  return count;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Invalid ${name}; pass a finite number`);
  return value;
}

/**
 * Indices of a grid of `columns` x `rows` cells with `columns + 1` vertices across. Counter-clockwise seen along
 * `dP/du x dP/dv`.
 */
export function gridIndices(columns: number, rows: number): Uint32Array {
  const indices = new Uint32Array(columns * rows * 6),
    across = columns + 1;
  let at = 0;
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const a = row * across + column,
        b = a + 1,
        c = b + across,
        d = a + across;
      indices.set([a, b, c, a, c, d], at);
      at += 6;
    }
  return indices;
}

/** One generated geometry. Draw it with `engine.createMesh().setGeometry(item.geometry)`. */
export class GpuGeometry {
  /** The geometry to draw. Its vertices live on the GPU; the copy in `geometry.vertices` stays zero. */
  readonly geometry: Geometry;
  /** Four numbers the shader reads; change them at any time. */
  readonly params: Float32Array;
  /** Seconds passed to the shader. It advances with the engine; set it to scrub. */
  time = 0;
  /** Stops generating, keeping the last result, while false. Default true. */
  active = true;
  /** @internal */
  readonly columns: number;
  /** @internal */
  readonly rows: number;
  /** @internal */
  readonly spec: GeneratedSpec;
  /** @internal */
  readonly owner: GeometryGenerator;

  /** @internal */
  constructor(owner: GeometryGenerator, spec: GeneratedSpec, columns: number, rows: number, options: GpuGeometryOptions) {
    const vertices = (columns + 1) * (rows + 1);
    if (vertices > MAX_VERTICES)
      throw new RangeError(`Generated geometry of ${vertices} vertices; pass at most ${MAX_VERTICES}`);
    const bounds = options.bounds ?? 1_000_000,
      sphere = typeof bounds === 'number' ? [0, 0, 0, bounds] : bounds;
    if (sphere.length !== 4 || !sphere.every(Number.isFinite) || !(sphere[3] > 0))
      throw new RangeError('Invalid bounds; pass a positive radius or [x, y, z, radius]');
    this.owner = owner;
    this.spec = spec;
    this.columns = columns;
    this.rows = rows;
    this.params = Float32Array.from(options.params ?? [0, 0, 0, 0]);
    if (this.params.length !== 4 || !this.params.every(Number.isFinite))
      throw new RangeError('Invalid params; pass four finite numbers');
    this.geometry = new Geometry(new Float32Array(vertices * 3), new Float32Array(vertices * 3), gridIndices(columns, rows));
    this.geometry.bounds.set(sphere);
  }

  /** Vertices in the geometry. */
  get vertexCount(): number {
    return (this.columns + 1) * (this.rows + 1);
  }

  /**
   * Copies the current vertices back, for picking, physics or export. Slow by nature: it waits for the GPU. The geometry
   * must be on a mesh.
   */
  read(options: { signal?: AbortSignal } = {}): Promise<GpuGeometryData> {
    return this.owner.readBack(this, options.signal);
  }

  /** Stops generating and frees the GPU memory this item owns. Meshes keep the last result. */
  dispose(): void {
    this.owner.remove(this);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** A tube or ribbon, which follows control points held on the GPU. */
export class GpuPath extends GpuGeometry {
  /** How many control points there are. */
  readonly pointCount: number;

  /** @internal */
  constructor(
    owner: GeometryGenerator,
    spec: GeneratedSpec,
    columns: number,
    rows: number,
    options: GpuPathOptions,
    pointCount: number,
  ) {
    super(owner, spec, columns, rows, options);
    this.pointCount = pointCount;
  }

  /**
   * The control points as a GPU buffer of `vec4f` (`xyz`, and `w` multiplying the radius or width). Bind it in a compute
   * pass of your own, such as a rope simulation, and nothing passes through the CPU. It stays valid until the device is
   * lost or the path disposed.
   */
  get points(): GPUBuffer {
    return this.owner.pointsOf(this);
  }

  /** Uploads the control points: xyzw per point, or `[x, y, z]` arrays with `w` of 1. */
  setPoints(points: Float32Array | readonly (readonly number[])[]): void {
    const flat =
      points instanceof Float32Array
        ? points
        : Float32Array.from((points as readonly (readonly number[])[]).flatMap((p) => [p[0], p[1], p[2], p[3] ?? 1]));
    if (flat.length !== this.pointCount * 4 || !flat.every(Number.isFinite))
      throw new RangeError(`Invalid points; pass ${this.pointCount} finite xyzw points`);
    this.owner.writePoints(this, flat);
  }
}

/** What a kind of geometry needs on the GPU. */
interface GeneratedSpec {
  /** Full shader source. */
  code: string;
  closed: boolean;
  up: readonly [number, number, number];
  /** Control points, for a path. */
  points?: number;
}

/** GPU objects of one item, rebuilt after the device is lost. */
interface GpuState {
  settings: GPUBuffer;
  points?: GPUBuffer;
  frames?: GPUBuffer;
  /** Last control points, for after a device loss. */
  saved?: Float32Array;
  vertex?: GPUBuffer;
  group?: GPUBindGroup;
  walk?: GPUBindGroup;
}

/**
 * Generates geometry on the GPU before each frame's scene pass. WebGPU only: on the WebGL2 backend `attach` throws.
 * @example
 * const generator = GeometryGenerator.attach(engine);
 * const rope = generator.tube({ points: 16, radius: 0.03 });
 * engine.createMesh().setGeometry(rope.geometry);
 * engine.onFrame(() => rope.setPoints(simulate()));
 */
export class GeometryGenerator implements EnginePlugin {
  /** Plugin name, unique per generator. */
  readonly name = `geometry-generator:${serial++}`;
  readonly #order: number;
  readonly #items = new Map<GpuGeometry, GpuState>();
  readonly #pipelines = new Map<string, { main: GPUComputePipeline; walk?: GPUComputePipeline }>();
  #engine: Engine | undefined;
  #device: GPUDevice | undefined;
  /** Generated this frame: a later view adds only what it newly draws. */
  readonly #done = new Set<GpuGeometry>();
  #copy: GPUComputePipeline | undefined;

  /** Creates the generator and attaches it to `engine`. */
  static attach(engine: EngineKernel, options: { order?: number } = {}): GeometryGenerator {
    const generator = new GeometryGenerator(options);
    (engine as unknown as Engine).use(generator);
    return generator;
  }

  /** @param options `order` of the compute pass among the frame's passes. Default -1000, before the scene. */
  constructor(options: { order?: number } = {}) {
    this.#order = finite(options.order ?? -1000, 'order');
  }

  /** @internal EnginePlugin hook. */
  setup(engine: Engine): void {
    if (!engine.gpu) throw margoError('unsupported', 'GeometryGenerator needs the WebGPU backend; the engine runs WebGL2');
    this.#engine = engine;
    this.#device = engine.gpu;
  }

  /** @internal EnginePlugin hook. */
  onPreUpdate(delta: number): void {
    this.#done.clear();
    for (const item of this.#items.keys()) if (item.active) item.time += delta;
  }

  /** @internal EnginePlugin hook. */
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:generate`, order: this.#order, execute: (context) => this.#execute(context) });
  }

  /** @internal EnginePlugin hook: the old device's buffers are gone, so each item's are made again. */
  onDeviceRestored(engine: Engine): void {
    this.#device = engine.gpu ?? undefined;
    this.#pipelines.clear();
    this.#copy = undefined;
    for (const [item, state] of this.#items) this.#items.set(item, this.#state(item, state.saved));
  }

  /** A surface from your own WGSL function of (u, v). */
  surface(options: GpuSurfaceOptions): GpuGeometry {
    if (typeof options?.code !== 'string' || !options.code.includes('surface'))
      throw new TypeError('Invalid code; pass WGSL with fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f');
    return this.#surface(options.code, options);
  }

  /** A flat or animated sheet in the xz plane, facing +y. `params` holds the width and depth. */
  grid(options: GpuGridOptions = {}): GpuGeometry {
    const { width = 1, depth = 1, params } = options;
    return this.#surface(GRID(options.code ?? FLAT), { ...options, params: params ?? [width, depth, 0, 0] });
  }

  /** A sphere. `params[0]` is the radius. */
  sphere(options: GpuSphereOptions = {}): GpuGeometry {
    const { radius = 1, params } = options;
    return this.#surface(SPHERE, { columns: 32, rows: 16, ...options, params: params ?? [radius, 0, 0, 0] });
  }

  /** A torus around y. `params[0]` and `params[1]` are the radius and the tube's radius. */
  torus(options: GpuTorusOptions = {}): GpuGeometry {
    const { radius = 1, tube = 0.25, params } = options;
    return this.#surface(TORUS, { columns: 48, rows: 16, ...options, params: params ?? [radius, tube, 0, 0] });
  }

  /** An open cylinder or cone around y. `params` holds the top radius, bottom radius and height. */
  cylinder(options: GpuCylinderOptions = {}): GpuGeometry {
    const { radiusTop = 1, radiusBottom = 1, height = 1, params } = options;
    return this.#surface(CYLINDER, {
      columns: 32,
      rows: 1,
      ...options,
      params: params ?? [radiusTop, radiusBottom, height, 0],
    });
  }

  /** A tube along control points, for ropes and cables. The ends are open. `params[0]` is the radius. */
  tube(options: GpuTubeOptions): GpuPath {
    const { radius = 0.1, params } = options;
    return this.#path(TUBE_MAIN, cells(options.sides, 8, 'sides'), options, params ?? [radius, 0, 0, 0]);
  }

  /** A flat band along control points, wide along the frames' normal. `params[0]` is the width. */
  ribbon(options: GpuRibbonOptions): GpuPath {
    const { width = 0.2, params } = options;
    return this.#path(RIBBON_MAIN, cells(options.columns, 1, 'columns'), options, params ?? [width, 0, 0, 0]);
  }

  #surface(code: string, options: GpuSurfaceOptions | (GpuGeometryOptions & { columns?: number; rows?: number })) {
    const spec: GeneratedSpec = { code: HEADER + code + SURFACE_MAIN, closed: false, up: [0, 0, 0] };
    return this.#add(
      new GpuGeometry(this, spec, cells(options.columns, 64, 'columns'), cells(options.rows, 64, 'rows'), options),
    );
  }

  #path(main: string, columns: number, options: GpuPathOptions, params: readonly number[]): GpuPath {
    const { points, closed = false, up = [0, 0, 0] } = options,
      least = closed ? 3 : 2;
    if (!Number.isInteger(points) || points < least)
      throw new RangeError(`Invalid points; pass a count of at least ${least}`);
    if (!up.every(Number.isFinite)) throw new RangeError('Invalid up; pass three finite numbers');
    const spec: GeneratedSpec = { code: HEADER + PATH_HEADER + main, closed, up, points },
      rows = cells(options.segments, points * 16, 'segments');
    return this.#add(
      new GpuPath(this, spec, columns, rows, { ...options, params: params as [number, number, number, number] }, points),
    );
  }

  #add<T extends GpuGeometry>(item: T): T {
    this.#items.set(item, this.#state(item));
    return item;
  }

  #need(): GPUDevice {
    if (!this.#device) throw margoError('state', 'GeometryGenerator is not attached; call GeometryGenerator.attach(engine)');
    return this.#device;
  }

  #state(item: GpuGeometry, saved?: Float32Array): GpuState {
    const device = this.#need(),
      { spec, rows } = item,
      state: GpuState = {
        settings: device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      };
    if (spec.points) {
      state.points = device.createBuffer({
        size: spec.points * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      state.frames = device.createBuffer({ size: (rows + 1) * 48, usage: GPUBufferUsage.STORAGE });
      state.saved = saved ?? straightLine(spec.points);
      device.queue.writeBuffer(state.points, 0, state.saved as Float32Array<ArrayBuffer>);
    }
    return state;
  }

  #pipeline(code: string, path: boolean) {
    const known = this.#pipelines.get(code);
    if (known) return known;
    const device = this.#need(),
      module = device.createShaderModule({ label: 'geometry generator', code }),
      made = {
        main: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
        walk: path ? device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'walk' } }) : undefined,
      };
    this.#pipelines.set(code, made);
    return made;
  }

  #execute(context: PassContext): void {
    if (context.backend !== 'webgpu' || !context.batches) return;
    const drawn = new Set<Geometry>();
    for (const batch of context.batches) drawn.add(batch.geometry);
    for (const [item, state] of this.#items) {
      if (!item.active || this.#done.has(item) || !drawn.has(item.geometry)) continue;
      this.#done.add(item);
      this.#generate(item, state, context.device, context.encoder);
    }
  }

  #generate(item: GpuGeometry, state: GpuState, device: GPUDevice, encoder: GPUCommandEncoder): void {
    const { spec } = item,
      pipelines = this.#pipeline(spec.code, !!spec.points),
      buffers = this.#engine!.geometryBuffers(item.geometry)!,
      header = new ArrayBuffer(64),
      words = new Uint32Array(header),
      floats = new Float32Array(header);
    words[0] = item.columns;
    words[1] = item.rows;
    floats[2] = item.time;
    words[3] = +spec.closed;
    floats.set(item.params, 4);
    floats.set(spec.up, 8);
    device.queue.writeBuffer(state.settings, 0, header);
    // Core makes new buffers when a geometry's mesh count grows.
    if (state.vertex !== buffers.vertex) {
      state.vertex = buffers.vertex;
      state.group = undefined;
    }
    const entries = [
      { binding: 0, resource: { buffer: state.settings } },
      { binding: 1, resource: { buffer: buffers.vertex } },
    ];
    const pass = encoder.beginComputePass({ label: 'geometry generator' });
    if (pipelines.walk) {
      pass.setPipeline(pipelines.walk);
      state.walk ??= device.createBindGroup({
        layout: pipelines.walk.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: state.settings } },
          { binding: 2, resource: { buffer: state.points! } },
          { binding: 3, resource: { buffer: state.frames! } },
        ],
      });
      pass.setBindGroup(0, state.walk);
      pass.dispatchWorkgroups(1);
    }
    state.group ??= device.createBindGroup({
      layout: pipelines.main.getBindGroupLayout(0),
      entries: pipelines.walk ? [...entries, { binding: 3, resource: { buffer: state.frames! } }] : entries,
    });
    pass.setPipeline(pipelines.main);
    pass.setBindGroup(0, state.group);
    pass.dispatchWorkgroups(Math.ceil(item.vertexCount / GROUP));
    pass.end();
  }

  /** @internal */
  pointsOf(item: GpuPath): GPUBuffer {
    const state = this.#items.get(item);
    if (!state) throw margoError('disposed', 'Generated geometry disposed; make a new one');
    return state.points!;
  }

  /** @internal */
  writePoints(item: GpuPath, points: Float32Array): void {
    const state = this.#items.get(item);
    if (!state) throw margoError('disposed', 'Generated geometry disposed; make a new one');
    state.saved = points.slice();
    this.#need().queue.writeBuffer(state.points!, 0, state.saved as Float32Array<ArrayBuffer>);
  }

  /** @internal */
  async readBack(item: GpuGeometry, signal?: AbortSignal): Promise<GpuGeometryData> {
    signal?.throwIfAborted();
    const device = this.#need(),
      source = this.#engine!.geometryBuffers(item.geometry)!.vertex,
      size = item.vertexCount * STRIDE,
      copy = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      // Core's vertex buffers cannot be copied from directly, so a shader moves the data first.
      this.#copy ??= device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ label: 'geometry read', code: COPY }), entryPoint: 'main' },
      });
      const encoder = device.createCommandEncoder({ label: 'geometry read' }),
        pass = encoder.beginComputePass();
      pass.setPipeline(this.#copy);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: this.#copy.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: source } },
            { binding: 1, resource: { buffer: copy } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(size / 4 / GROUP));
      pass.end();
      encoder.copyBufferToBuffer(copy, 0, staging, 0, size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      signal?.throwIfAborted();
      const interleaved = new Float32Array(staging.getMappedRange().slice(0)),
        positions = new Float32Array(item.vertexCount * 3),
        normals = new Float32Array(item.vertexCount * 3);
      for (let i = 0; i < item.vertexCount; i++) {
        positions.set(interleaved.subarray(i * 6, i * 6 + 3), i * 3);
        normals.set(interleaved.subarray(i * 6 + 3, i * 6 + 6), i * 3);
      }
      return { positions, normals };
    } finally {
      copy.destroy();
      staging.destroy();
    }
  }

  /** @internal */
  remove(item: GpuGeometry): void {
    const state = this.#items.get(item);
    if (!state) return;
    this.#items.delete(item);
    this.#done.delete(item);
    state.settings.destroy();
    state.points?.destroy();
    state.frames?.destroy();
  }

  /** Stops every item and detaches from the engine. */
  dispose(): void {
    for (const item of [...this.#items.keys()]) this.remove(item);
    this.#pipelines.clear();
    this.#device = undefined;
    this.#engine = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

let serial = 0;

/** Points along +x, so a path draws something before its first `setPoints`. */
function straightLine(count: number): Float32Array {
  const points = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    points[i * 4] = i;
    points[i * 4 + 3] = 1;
  }
  return points;
}
