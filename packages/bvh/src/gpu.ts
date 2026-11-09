/// <reference lib="esnext.disposable" preserve="true" />
// BVH traversal on the GPU: a MeshBVH uploaded to storage buffers and walked in WGSL compute. Nothing here imports the
// engine; a GPUDevice is all it needs, so it also serves headless tools. The ray test is the watertight one of Woop,
// Benthin and Wald (JCGT 2013), written from the paper, since a plain float32 test leaves gaps on shared edges.
import { MargoError } from '@margoengine/math/errors';
import type { RayLike } from '@margoengine/math/ray';
import { INTERNAL_FLAG, NODE_WORDS } from './build.js';
import type { MeshBVH } from './bvh.js';
import type { Side } from './math.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** Floats per ray in a ray buffer: origin xyz, near, direction xyz, far. */
export const GPU_RAY_FLOATS = 8;
/** 32-bit words per hit in a hit buffer: distance (f32), face index | front flag << 31, weights of vertices b and c (f32). */
export const GPU_HIT_WORDS = 4;
/** Deepest tree the WGSL stack walks. Every built tree fits: `maxDepth` stops at 64. */
export const GPU_MAX_DEPTH = 64;
/** Largest `far` a ray buffer may hold; WGSL has no infinity. */
export const GPU_FAR = 3e38;

const WORKGROUP = 64;
const PARAM_CACHE = 64;
const SIDES: Record<Side, number> = { double: 0, front: 1, back: 2 };

/** A device, or anything that has one in `gpu`, such as an `Engine` on WebGPU. */
export type GPUTarget = GPUDevice | { readonly gpu: GPUDevice | null };
/** What a query wants: the 'closest' hit, or 'any' hit (a shadow or occlusion test, which stops at the first found). */
export type GPUTraceMode = 'closest' | 'any';
/** Settings of one trace. */
export interface GPUTraceOptions {
  /** Default 'closest'. */
  mode?: GPUTraceMode;
  /** Which faces count, as on the CPU. Default 'double'. */
  side?: Side;
}
/** Settings of {@link GPUMeshBVH.raycast}. */
export interface GPURaycastOptions extends GPUTraceOptions {
  /** Hits closer than this are ignored, for rays given as objects. Default 0. */
  near?: number;
  /** Hits farther than this are ignored, for rays given as objects. Default Infinity. */
  far?: number;
  signal?: AbortSignal;
}
/** Answers of {@link GPUMeshBVH.raycast}, one per ray. */
export interface GPURayHits {
  /** Rays traced. */
  count: number;
  /** Distance along the ray, Infinity for a miss. */
  distance: Float32Array;
  /** Source face index, -1 for a miss. */
  faceIndex: Int32Array;
  /** Three weights per ray, for the three vertices of the face. Zero for a miss. */
  barycoord: Float32Array;
  /** 1 where the ray met a front face. */
  frontFace: Uint8Array;
}
/** Where WGSL finds the tree. */
export interface GPUBVHBindingOptions {
  /** Bind group of the tree. Default 0. */
  group?: number;
  /** First of its five bindings. Default 0. */
  binding?: number;
  /** Optional WGSL function name: (face: u32, barycoord: vec3f) -> bool. Reject before closest/any-hit acceptance. Default none. */
  accept?: string;
}

/**
 * WGSL for walking a tree inside your own shader: declares the five bindings {@link GPUMeshBVH.bindings} fills, and
 * `bvhClosest(origin, direction, near, far, side)` and `bvhAny(...)`, both answering a `BVHHit` (`face` is `BVH_MISS` for
 * a miss). `side` is 0 double, 1 front, 2 back. `direction` need not be unit length; distances are lengths in the
 * tree's space.
 */
export function bvhWGSL({ group = 0, binding = 0, accept }: GPUBVHBindingOptions = {}): string {
  if (accept !== undefined && !/^[A-Za-z][A-Za-z0-9_]*$/.test(accept))
    throw new TypeError('Invalid BVH candidate function; pass a WGSL identifier');
  const at = (offset: number): string => `@group(${group}) @binding(${binding + offset})`;
  return /* wgsl */ `
struct BVHNode { lo: vec3f, left: u32, hi: vec3f, right: u32 }
struct BVHParams { stride: u32, offset: u32, triangles: u32, nodes: u32 }
struct BVHHit { distance: f32, face: u32, barycoord: vec3f, front: bool }
struct BVHRay { origin: vec3f, direction: vec3f, inverse: vec3f, shear: vec3f, axes: vec3u, near: f32, far: f32 }
${at(0)} var<storage, read> bvhNodes: array<BVHNode>;
${at(1)} var<storage, read> bvhIndex: array<u32>;
${at(2)} var<storage, read> bvhFaces: array<u32>;
${at(3)} var<storage, read> bvhPositions: array<f32>;
${at(4)} var<uniform> bvhParams: BVHParams;
const BVH_MISS = 0xffffffffu;
const BVH_INTERNAL = 0x80000000u;
const BVH_NEVER = 3.4e38;

fn bvhVertex(i: u32) -> vec3f {
  let o = i * bvhParams.stride + bvhParams.offset;
  return vec3f(bvhPositions[o], bvhPositions[o + 1u], bvhPositions[o + 2u]);
}
fn bvhInverse(d: f32) -> f32 {
  // WGSL may assume no infinities, so a zero axis gets a huge finite reciprocal rather than 1 / 0.
  let m = max(abs(d), 1e-18);
  return select(1.0 / m, -1.0 / m, d < 0.0);
}
fn bvhRay(origin: vec3f, direction: vec3f, near: f32, far: f32) -> BVHRay {
  let d = normalize(direction);
  let a = abs(d);
  var z = 2u;
  if (a.x >= a.y && a.x >= a.z) { z = 0u; } else if (a.y >= a.z) { z = 1u; }
  var x = (z + 1u) % 3u;
  var y = (x + 1u) % 3u;
  if (d[z] < 0.0) { let swap = x; x = y; y = swap; }
  let shear = vec3f(d[x] / d[z], d[y] / d[z], 1.0 / d[z]);
  return BVHRay(origin, d, vec3f(bvhInverse(d.x), bvhInverse(d.y), bvhInverse(d.z)), shear, vec3u(x, y, z), near, far);
}
// Entry distance into a node, or BVH_NEVER. The exit grows by four float32 steps, so rounding never loses a hit.
fn bvhEnter(node: u32, r: BVHRay, far: f32) -> f32 {
  let n = bvhNodes[node];
  let a = (n.lo - r.origin) * r.inverse;
  let b = (n.hi - r.origin) * r.inverse;
  let near3 = min(a, b);
  let far3 = max(a, b);
  let enter = max(max(near3.x, near3.y), max(near3.z, r.near));
  let leave = min(min(far3.x, far3.y), far3.z) * 1.0000004;
  return select(BVH_NEVER, enter, enter <= leave && enter <= far);
}
// Edge function p x q of two sheared vertices. A shared edge must give two triangles exactly opposite values, or a ray
// through it can miss both. WGSL lets a compile fuse and reassociate (15.7.5), and Metal fuses p.x*q.y - p.y*q.x into one
// fma, which is not antisymmetric; so both sides evaluate the edge with its ends in one fixed order and negate.
fn bvhEdge(p: vec2f, q: vec2f) -> f32 {
  let swap = q.x < p.x || (q.x == p.x && q.y < p.y);
  let s = select(p, q, swap);
  let e = select(q, p, swap);
  let value = s.x * e.y - s.y * e.x;
  return select(value, -value, swap);
}
// Weights and distance in xyzw, w < 0 for a miss.
fn bvhTriangle(r: BVHRay, a3: vec3f, b3: vec3f, c3: vec3f, side: u32, far: f32) -> vec4f {
  let a = a3 - r.origin;
  let b = b3 - r.origin;
  let c = c3 - r.origin;
  let az = a[r.axes.z];
  let bz = b[r.axes.z];
  let cz = c[r.axes.z];
  let ax = a[r.axes.x] - r.shear.x * az;
  let ay = a[r.axes.y] - r.shear.y * az;
  let bx = b[r.axes.x] - r.shear.x * bz;
  let by = b[r.axes.y] - r.shear.y * bz;
  let cx = c[r.axes.x] - r.shear.x * cz;
  let cy = c[r.axes.y] - r.shear.y * cz;
  let u = bvhEdge(vec2f(cx, cy), vec2f(bx, by));
  let v = bvhEdge(vec2f(ax, ay), vec2f(cx, cy));
  let w = bvhEdge(vec2f(bx, by), vec2f(ax, ay));
  let det = u + v + w;
  let positive = u >= 0.0 && v >= 0.0 && w >= 0.0;
  let negative = u <= 0.0 && v <= 0.0 && w <= 0.0;
  if (det == 0.0 || !(positive || negative)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  if ((side == 1u && det < 0.0) || (side == 2u && det > 0.0)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let t = (u * az + v * bz + w * cz) * r.shear.z / det;
  if (t < r.near || t > far) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  return vec4f(u / det, v / det, w / det, t);
}
fn bvhWalk(r: BVHRay, side: u32, any: bool) -> BVHHit {
  var best = BVHHit(r.far, BVH_MISS, vec3f(0.0), false);
  var stack: array<u32, ${GPU_MAX_DEPTH}>;
  var entry: array<f32, ${GPU_MAX_DEPTH}>;
  var top = 0u;
  var node = 0u;
  if (bvhEnter(0u, r, r.far) >= BVH_NEVER) { return best; }
  loop {
    let n = bvhNodes[node];
    var next = false;
    if ((n.right & BVH_INTERNAL) != 0u) {
      let left = n.left;
      let right = n.right & ~BVH_INTERNAL;
      let tl = bvhEnter(left, r, best.distance);
      let tr = bvhEnter(right, r, best.distance);
      if (tl < BVH_NEVER && tr < BVH_NEVER) {
        // The nearer child now, the other one later.
        stack[top] = select(right, left, tr < tl);
        entry[top] = max(tl, tr);
        top += 1u;
        node = select(left, right, tr < tl);
        next = true;
      } else if (tl < BVH_NEVER) {
        node = left;
        next = true;
      } else if (tr < BVH_NEVER) {
        node = right;
        next = true;
      }
    } else {
      for (var k = 0u; k < n.right; k += 1u) {
        let at = n.left + k;
        let i = at * 3u;
        let a = bvhVertex(bvhIndex[i]);
        let b = bvhVertex(bvhIndex[i + 1u]);
        let c = bvhVertex(bvhIndex[i + 2u]);
        let hit = bvhTriangle(r, a, b, c, side, best.distance);
        if (hit.w < 0.0) { continue; }
        let face = bvhFaces[at];
        ${accept ? `if (!${accept}(face, hit.xyz)) { continue; }` : ''}
        // Equal distances answer the lowest face index, as raycastFirst does.
        if (hit.w < best.distance || best.face == BVH_MISS || face < best.face) {
          best = BVHHit(hit.w, face, hit.xyz, dot(cross(b - a, c - a), r.direction) < 0.0);
          if (any) { return best; }
        }
      }
    }
    if (next) { continue; }
    // Pop until a node that can still beat the best hit.
    var found = false;
    while (top > 0u && !found) {
      top -= 1u;
      if (entry[top] <= best.distance) {
        node = stack[top];
        found = true;
      }
    }
    if (!found) { break; }
  }
  return best;
}
fn bvhClosest(origin: vec3f, direction: vec3f, near: f32, far: f32, side: u32) -> BVHHit {
  if (dot(direction, direction) == 0.0) { return BVHHit(far, BVH_MISS, vec3f(0.0), false); }
  return bvhWalk(bvhRay(origin, direction, near, far), side, false);
}
fn bvhAny(origin: vec3f, direction: vec3f, near: f32, far: f32, side: u32) -> BVHHit {
  if (dot(direction, direction) == 0.0) { return BVHHit(far, BVH_MISS, vec3f(0.0), false); }
  return bvhWalk(bvhRay(origin, direction, near, far), side, true);
}
`;
}

const TRACE_WGSL = /* wgsl */ `${bvhWGSL()}
struct TraceRay { origin: vec3f, near: f32, direction: vec3f, far: f32 }
struct Trace { count: u32, side: u32, any: u32, width: u32 }
@group(1) @binding(0) var<storage, read> rays: array<TraceRay>;
@group(1) @binding(1) var<storage, read_write> hits: array<vec4u>;
@group(1) @binding(2) var<uniform> trace: Trace;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.y * trace.width + id.x;
  if (i >= trace.count) { return; }
  let ray = rays[i];
  var hit: BVHHit;
  if (trace.any != 0u) {
    hit = bvhAny(ray.origin, ray.direction, ray.near, ray.far, trace.side);
  } else {
    hit = bvhClosest(ray.origin, ray.direction, ray.near, ray.far, trace.side);
  }
  if (hit.face == BVH_MISS) {
    hits[i] = vec4u(bitcast<u32>(-1.0), BVH_MISS, 0u, 0u);
    return;
  }
  let front = select(0u, BVH_INTERNAL, hit.front);
  hits[i] = vec4u(bitcast<u32>(hit.distance), hit.face | front, bitcast<u32>(hit.barycoord.y), bitcast<u32>(hit.barycoord.z));
}
`;

const pipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline>>();
function tracePipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipelineAsync({
      label: 'bvh trace',
      layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'bvh trace', code: TRACE_WGSL }), entryPoint: 'main' },
    });
    pipelines.set(device, pipeline);
    // A failed compile is not kept: the next create tries again and reports its own error.
    pipeline.catch(() => pipelines.delete(device));
  }
  return pipeline;
}

const deviceOf = (target: GPUTarget): GPUDevice => {
  const device = (target as { gpu?: GPUDevice | null })?.gpu ?? (target as GPUDevice);
  if (!device || typeof device.createBuffer !== 'function')
    throw new MargoError('unsupported', 'GPU BVH needs WebGPU; pass a GPUDevice or an Engine running on WebGPU.');
  return device;
};

/** The tree in its GPU order: lo xyz, left child or first triangle, hi xyz, right child | flag or triangle count. */
function packNodes(bvh: MeshBVH): ArrayBuffer {
  const count = bvh.nodeCount,
    packed = new ArrayBuffer(count * NODE_WORDS * 4),
    floats = new Float32Array(packed),
    words = new Uint32Array(packed),
    depth = new Uint8Array(count),
    bounds = bvh.nodeBounds,
    data = bvh.nodeData;
  for (let i = 0; i < count; i++) {
    const o = i * NODE_WORDS,
      first = data[o + 6],
      second = data[o + 7];
    floats[o] = bounds[o];
    floats[o + 1] = bounds[o + 1];
    floats[o + 2] = bounds[o + 2];
    floats[o + 4] = bounds[o + 3];
    floats[o + 5] = bounds[o + 4];
    floats[o + 6] = bounds[o + 5];
    if (second & INTERNAL_FLAG) {
      if (depth[i] >= GPU_MAX_DEPTH)
        throw new RangeError(`BVH is deeper than ${GPU_MAX_DEPTH}; rebuild it with a maxDepth of at most 64.`);
      depth[i + 1] = depth[first] = depth[i] + 1;
      words[o + 3] = i + 1;
      words[o + 7] = (first | INTERNAL_FLAG) >>> 0;
    } else {
      words[o + 3] = first;
      words[o + 7] = second;
    }
  }
  return packed;
}

function packPositions(bvh: MeshBVH): Float32Array {
  const { positions, stride } = bvh,
    vertices = Math.floor((positions.length - 3) / stride) + 1,
    packed = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) {
    packed[i * 3] = positions[i * stride];
    packed[i * 3 + 1] = positions[i * stride + 1];
    packed[i * 3 + 2] = positions[i * stride + 2];
  }
  return packed;
}

/** Packs rays into the buffer layout: origin xyz, near, direction xyz, far. */
export function packRays(
  rays: readonly RayLike[],
  { near = 0, far = Infinity }: Pick<GPURaycastOptions, 'near' | 'far'> = {},
): Float32Array {
  if (!(near >= 0) || !(far >= near)) throw new RangeError('Invalid near or far; pass 0 <= near <= far.');
  const packed = new Float32Array(rays.length * GPU_RAY_FLOATS),
    end = Math.min(far, GPU_FAR);
  rays.forEach(({ origin, direction }, i) => {
    const o = i * GPU_RAY_FLOATS;
    for (let k = 0; k < 3; k++) {
      packed[o + k] = origin[k];
      packed[o + 4 + k] = direction[k];
    }
    packed[o + 3] = near;
    packed[o + 7] = end;
  });
  return packed;
}

/** @internal A tree over a vertex buffer the GPU writes; see `@margoengine/bvh/gpu-build`. */
export interface GPUFollowedVertices {
  vertices: GPUBuffer;
  stride: number;
  offset: number;
  triangles: number;
  nodes: number;
  /** Uploads this topology; null leaves the tree blank for a GPU build. */
  bvh: MeshBVH | null;
}

/**
 * A MeshBVH on the GPU. `await GPUMeshBVH.create(device, bvh)` uploads it; `raycast` traces rays and reads the answers
 * back, `encodeTrace` keeps rays and hits on the GPU, and {@link bvhWGSL} walks the tree inside your own shader.
 * Queries run in float32: a float64 source is rounded on upload.
 */
export class GPUMeshBVH {
  readonly device: GPUDevice;
  /** Nodes: 32 bytes each, see {@link bvhWGSL}. */
  readonly nodes: GPUBuffer;
  /** Three vertex indices per triangle, in leaf order. */
  readonly index: GPUBuffer;
  /** Source face index per triangle, in leaf order. */
  readonly faces: GPUBuffer;
  /** Vertex positions, three floats each. */
  readonly positions: GPUBuffer;
  /** Stride, offset and counts, read by the WGSL. */
  readonly params: GPUBuffer;
  /** The CPU tree it came from; null for a tree built on the GPU. */
  readonly bvh: MeshBVH | null;
  #followed: boolean;
  #pipeline: GPUComputePipeline | null;
  #tree: GPUBindGroup | null;
  #traces = new Map<string, GPUBuffer>();
  #disposed = false;

  /** Uploads `bvh`. Throws a RangeError if it does not fit the device's storage limits. */
  static async create(target: GPUTarget, bvh: MeshBVH): Promise<GPUMeshBVH> {
    const device = deviceOf(target);
    return new GPUMeshBVH(device, bvh, await tracePipeline(device));
  }

  /**
   * Uploads `bvh` for walking in your own shader through {@link bvhWGSL}, at once and with no compute pipeline: the tree's own
   * ray calls throw. Throws a RangeError if it does not fit the device's storage limits.
   */
  static forShader(target: GPUTarget, bvh: MeshBVH): GPUMeshBVH {
    return new GPUMeshBVH(deviceOf(target), bvh, null);
  }

  /** @internal A tree whose positions stay in a GPU buffer the caller writes. */
  static async follow(target: GPUTarget, followed: GPUFollowedVertices): Promise<GPUMeshBVH> {
    const device = deviceOf(target);
    return new GPUMeshBVH(device, followed.bvh, await tracePipeline(device), followed);
  }

  private constructor(
    device: GPUDevice,
    bvh: MeshBVH | null,
    pipeline: GPUComputePipeline | null,
    followed: GPUFollowedVertices | null = null,
  ) {
    this.device = device;
    this.bvh = bvh;
    this.#followed = !!followed;
    this.#pipeline = pipeline;
    const nodes = bvh && packNodes(bvh),
      positions = followed ? null : packPositions(bvh!),
      triangles = followed?.triangles ?? bvh!.triangleCount,
      nodeCount = followed?.nodes ?? bvh!.nodeCount,
      limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    for (const [name, bytes] of [
      ['nodes', nodeCount * NODE_WORDS * 4],
      ['positions', positions?.byteLength ?? followed!.vertices.size],
      ['indices', triangles * 12],
    ] as const)
      if (bytes > limit)
        throw new RangeError(
          `BVH ${name} take ${bytes} bytes, over this device's ${limit}; request a higher maxStorageBufferBindingSize or split the mesh.`,
        );
    const upload = (
      label: string,
      data: ArrayBuffer | ArrayBufferView | null,
      size: number,
      usage: number,
    ): GPUBuffer => {
      const buffer = device.createBuffer({ label, size, usage: usage | GPUBufferUsage.COPY_DST });
      if (data) device.queue.writeBuffer(buffer, 0, data as BufferSource);
      return buffer;
    };
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    this.nodes = upload('bvh nodes', nodes, nodeCount * NODE_WORDS * 4, storage);
    this.index = upload('bvh index', bvh?.index ?? null, triangles * 12, storage);
    this.faces = upload('bvh faces', bvh?.triangles ?? null, triangles * 4, storage);
    this.positions = followed?.vertices ?? upload('bvh positions', positions, positions!.byteLength, storage);
    this.params = upload(
      'bvh params',
      new Uint32Array([followed?.stride ?? 3, followed?.offset ?? 0, triangles, nodeCount]),
      16,
      GPUBufferUsage.UNIFORM,
    );
    this.#tree =
      pipeline &&
      device.createBindGroup({
        label: 'bvh tree',
        layout: pipeline.getBindGroupLayout(0),
        entries: this.bindings(),
      });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** The five bind group entries {@link bvhWGSL} declares, from binding `first`. */
  bindings(first = 0): GPUBindGroupEntry[] {
    return [this.nodes, this.index, this.faces, this.positions, this.params].map((buffer, i) => ({
      binding: first + i,
      resource: { buffer },
    }));
  }

  /** Sends bounds and positions again after `bvh.refit()`. The topology must be the one uploaded. */
  update(): void {
    this.#live();
    if (this.#followed || !this.bvh)
      throw new MargoError('state', 'This tree follows a GPU buffer; update it with encode on its GPUDynamicBVH.');
    this.device.queue.writeBuffer(this.nodes, 0, packNodes(this.bvh));
    this.device.queue.writeBuffer(this.positions, 0, packPositions(this.bvh) as BufferSource);
  }

  /**
   * Adds a trace to `encoder`. `rays` holds {@link GPU_RAY_FLOATS} floats a ray, with STORAGE usage; `hits` receives
   * {@link GPU_HIT_WORDS} words a ray, with STORAGE usage. Directions need no normalizing; `far` must be finite.
   */
  encodeTrace(
    encoder: GPUCommandEncoder,
    rays: GPUBuffer,
    hits: GPUBuffer,
    count: number,
    { mode = 'closest', side = 'double' }: GPUTraceOptions = {},
  ): void {
    this.#live();
    if (!Number.isInteger(count) || count < 0) throw new RangeError('Invalid ray count; pass a non-negative integer.');
    if (mode !== 'closest' && mode !== 'any') throw new TypeError('Invalid trace mode; use closest or any.');
    if (!Object.hasOwn(SIDES, side)) throw new TypeError('Invalid side; use front, back or double.');
    if (!count) return;
    if (rays.size < count * GPU_RAY_FLOATS * 4 || hits.size < count * GPU_HIT_WORDS * 4)
      throw new RangeError(
        `Ray or hit buffer is too small for ${count} rays; size them with GPU_RAY_FLOATS and GPU_HIT_WORDS.`,
      );
    const groups = Math.ceil(count / WORKGROUP),
      max = this.device.limits.maxComputeWorkgroupsPerDimension,
      x = Math.min(groups, max),
      y = Math.ceil(groups / x);
    if (y > max) throw new RangeError(`${count} rays are more than one dispatch holds; trace them in parts.`);
    const pipeline = this.#pipeline;
    if (!pipeline)
      throw new MargoError('state', 'This tree is for your own shader; make one with GPUMeshBVH.create to trace rays.');
    const pass = encoder.beginComputePass({ label: 'bvh trace' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#tree);
    pass.setBindGroup(
      1,
      this.device.createBindGroup({
        label: 'bvh rays',
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: rays } },
          { binding: 1, resource: { buffer: hits } },
          { binding: 2, resource: { buffer: this.#trace(count, SIDES[side], mode === 'any' ? 1 : 0, x * WORKGROUP) } },
        ],
      }),
    );
    pass.dispatchWorkgroups(x, y);
    pass.end();
  }

  /**
   * Traces rays and reads the answers back. `rays` is objects with `origin` and `direction`, or a Float32Array in the
   * buffer layout, near and far included.
   */
  async raycast(rays: readonly RayLike[] | Float32Array, options: GPURaycastOptions = {}): Promise<GPURayHits> {
    this.#live();
    const { signal } = options;
    signal?.throwIfAborted();
    const packed = rays instanceof Float32Array ? rays : packRays(rays, options);
    if (packed.length % GPU_RAY_FLOATS)
      throw new RangeError('Incomplete ray buffer; pass whole rays of GPU_RAY_FLOATS floats.');
    const count = packed.length / GPU_RAY_FLOATS,
      device = this.device;
    for (let i = 0; i < packed.length; i++)
      if (!Number.isFinite(packed[i]))
        throw new RangeError(`Ray ${Math.floor(i / GPU_RAY_FLOATS)} is not finite; far must be at most GPU_FAR.`);
    const result: GPURayHits = {
      count,
      distance: new Float32Array(count),
      faceIndex: new Int32Array(count),
      barycoord: new Float32Array(count * 3),
      frontFace: new Uint8Array(count),
    };
    if (!count) return result;
    const limit = device.limits.maxStorageBufferBindingSize;
    if (packed.byteLength > limit)
      throw new RangeError(
        `${count} rays take ${packed.byteLength} bytes, over this device's ${limit}; trace them in parts.`,
      );
    const bytes = count * GPU_HIT_WORDS * 4,
      input = device.createBuffer({
        label: 'bvh rays',
        size: packed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      output = device.createBuffer({
        label: 'bvh hits',
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      read = device.createBuffer({
        label: 'bvh read',
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    try {
      device.queue.writeBuffer(input, 0, packed as BufferSource);
      const encoder = device.createCommandEncoder({ label: 'bvh raycast' });
      this.encodeTrace(encoder, input, output, count, options);
      encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      signal?.throwIfAborted();
      const mapped = read.getMappedRange(),
        floats = new Float32Array(mapped),
        words = new Uint32Array(mapped);
      for (let i = 0; i < count; i++) {
        const o = i * GPU_HIT_WORDS,
          word = words[o + 1];
        if (word === 0xffffffff) {
          result.distance[i] = Infinity;
          result.faceIndex[i] = -1;
          continue;
        }
        const b = floats[o + 2],
          c = floats[o + 3];
        result.distance[i] = floats[o];
        result.faceIndex[i] = word & 0x7fffffff;
        result.frontFace[i] = word >>> 31;
        result.barycoord[i * 3] = 1 - b - c;
        result.barycoord[i * 3 + 1] = b;
        result.barycoord[i * 3 + 2] = c;
      }
      return result;
    } finally {
      input.destroy();
      output.destroy();
      read.destroy();
    }
  }

  /** Frees the GPU buffers. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const buffer of [this.nodes, this.index, this.faces, this.params]) buffer.destroy();
    if (!this.#followed) this.positions.destroy();
    for (const buffer of this.#traces.values()) buffer.destroy();
    this.#traces.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  // One buffer per distinct trace, never rewritten: an encoder that holds several traces before its submit cannot see
  // another trace's settings, as it could with one shared uniform. An evicted buffer is left to the collector, since a
  // pending encoder may still use it.
  #trace(count: number, side: number, any: number, width: number): GPUBuffer {
    const key = `${count},${side},${any},${width}`;
    let buffer = this.#traces.get(key);
    if (!buffer) {
      if (this.#traces.size >= PARAM_CACHE) this.#traces.delete(this.#traces.keys().next().value as string);
      buffer = this.device.createBuffer({
        label: 'bvh trace',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buffer, 0, new Uint32Array([count, side, any, width]));
      this.#traces.set(key, buffer);
    }
    return buffer;
  }

  #live(): void {
    if (this.#disposed) throw new MargoError('disposed', 'GPUMeshBVH is disposed; create a new one to trace rays.');
  }
}
