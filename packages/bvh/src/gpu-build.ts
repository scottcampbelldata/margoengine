/// <reference lib="esnext.disposable" preserve="true" />
// The `gpu-build` entry: a BVH that lives on the GPU and follows a vertex buffer the GPU itself writes (a skin, a morph, a
// simulation), so queries see the animated pose with no readback. 'refit' keeps a CPU-built topology and refits its
// bounds level by level; 'build' makes a new linear BVH every frame: Morton codes, a sort, then the parallel hierarchy of
// Karras (HPG 2012), written from the paper.
import { MargoError } from '@margoengine/math/errors';
import { INTERNAL_FLAG, NODE_WORDS } from './build.js';
import { MeshBVH } from './bvh.js';
import { GPUMeshBVH, type GPUTarget } from './gpu.js';

declare const GPUBufferUsage: { STORAGE: number; UNIFORM: number; COPY_DST: number };

/** Where the vertices are and how the tree follows them. */
export interface GPUDynamicBVHOptions {
  /** The buffer the GPU writes positions to, with STORAGE usage. */
  vertices: GPUBuffer;
  /** Triangles, three vertex indices each. They do not change. */
  indices: Uint32Array;
  /** Floats from one vertex to the next. Default 3. */
  stride?: number;
  /** Floats before the first vertex's position. Default 0. */
  offset?: number;
  /**
   * 'build' makes a new tree every frame, fast to query however far the mesh moves. 'refit' keeps the tree of `bvh` and
   * refits it, cheaper to update and slower to query as the pose leaves the one `bvh` was built on. Default 'build'.
   */
  mode?: 'build' | 'refit';
  /** With 'refit': a MeshBVH of the same triangles, usually of the rest pose. */
  bvh?: MeshBVH;
}

const GROUP = 64;
/** The tree's depth bound: 30 Morton bits, then at most 32 more from the index tie-break. */
const PASSES = 62;
const SLOT = 256;

const RANGE = /* wgsl */ `
struct Range { first: u32, count: u32, a: u32, b: u32 }
`;

const COMMON = /* wgsl */ `${RANGE}
struct Node { lo: vec3f, left: u32, hi: vec3f, right: u32 }
struct Mesh { stride: u32, offset: u32, triangles: u32, nodes: u32 }
const INTERNAL = ${INTERNAL_FLAG}u;
fn vertex(i: u32) -> vec3f {
  let o = i * mesh.stride + mesh.offset;
  return vec3f(positions[o], positions[o + 1u], positions[o + 2u]);
}
`;

const REFIT_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<storage, read_write> nodes: array<Node>;
@group(0) @binding(1) var<storage, read> index: array<u32>;
@group(0) @binding(2) var<storage, read> positions: array<f32>;
@group(0) @binding(3) var<uniform> mesh: Mesh;
@group(0) @binding(4) var<storage, read> order: array<u32>;
@group(1) @binding(0) var<uniform> range: Range;
@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let t = id.y * range.b + id.x;
  if (t >= range.count) { return; }
  let at = order[range.first + t];
  var n = nodes[at];
  if ((n.right & INTERNAL) != 0u) {
    let l = nodes[n.left];
    let r = nodes[n.right & ~INTERNAL];
    n.lo = min(l.lo, r.lo);
    n.hi = max(l.hi, r.hi);
  } else {
    var lo = vec3f(3.4e38);
    var hi = vec3f(-3.4e38);
    for (var i = n.left * 3u; i < (n.left + n.right) * 3u; i += 1u) {
      let p = vertex(index[i]);
      lo = min(lo, p);
      hi = max(hi, p);
    }
    n.lo = lo;
    n.hi = hi;
  }
  nodes[at] = n;
}
`;

const BUILD_HEAD = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<storage, read_write> nodes: array<Node>;
@group(0) @binding(1) var<storage, read_write> index: array<u32>;
@group(0) @binding(2) var<storage, read> positions: array<f32>;
@group(0) @binding(3) var<uniform> mesh: Mesh;
@group(0) @binding(4) var<storage, read> source: array<u32>;
@group(0) @binding(5) var<storage, read_write> faces: array<u32>;
@group(0) @binding(6) var<storage, read_write> keys: array<u32>;
@group(0) @binding(7) var<storage, read_write> scene: array<atomic<u32>, 6>;
@group(1) @binding(0) var<uniform> range: Range;
// Floats as integers that order the same way, so atomics can take a minimum.
fn ordered(f: f32) -> u32 {
  let u = bitcast<u32>(f);
  return select(u | 0x80000000u, ~u, (u & 0x80000000u) != 0u);
}
fn unordered(u: u32) -> f32 {
  return bitcast<f32>(select(~u, u & 0x7fffffffu, (u & 0x80000000u) != 0u));
}
fn middleOf(t: u32) -> vec3f {
  return (vertex(source[t * 3u]) + vertex(source[t * 3u + 1u]) + vertex(source[t * 3u + 2u])) / 3.0;
}
fn spread(v: u32) -> u32 {
  var x = v & 1023u;
  x = (x | (x << 16u)) & 0x030000ffu;
  x = (x | (x << 8u)) & 0x0300f00fu;
  x = (x | (x << 4u)) & 0x030c30c3u;
  x = (x | (x << 2u)) & 0x09249249u;
  return x;
}
fn flatten(id: vec3u) -> u32 { return id.y * range.b + id.x; }
`;

const RESET_WGSL = /* wgsl */ `${BUILD_HEAD}
@compute @workgroup_size(6)
fn main(@builtin(local_invocation_index) i: u32) {
  atomicStore(&scene[i], select(0u, 0xffffffffu, i < 3u));
}
`;

const BOUNDS_WGSL = /* wgsl */ `${BUILD_HEAD}
@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let t = flatten(id);
  if (t >= mesh.triangles) { return; }
  let c = middleOf(t);
  for (var k = 0u; k < 3u; k += 1u) {
    atomicMin(&scene[k], ordered(c[k]));
    atomicMax(&scene[k + 3u], ordered(c[k]));
  }
}
`;

// keys holds pairs: Morton code at 2i, triangle at 2i + 1, padding sorting last; then one climb stamp per node.
const MORTON_WGSL = /* wgsl */ `${BUILD_HEAD}
@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let t = flatten(id);
  if (t >= range.count) { return; }
  if (t >= mesh.triangles) {
    keys[t * 2u] = 0xffffffffu;
    keys[t * 2u + 1u] = 0xffffffffu;
    return;
  }
  var lo = vec3f(0.0);
  var hi = vec3f(0.0);
  for (var k = 0u; k < 3u; k += 1u) {
    lo[k] = unordered(atomicLoad(&scene[k]));
    hi[k] = unordered(atomicLoad(&scene[k + 3u]));
  }
  let size = max(hi - lo, vec3f(1e-30));
  let q = vec3u(clamp((middleOf(t) - lo) / size * 1024.0, vec3f(0.0), vec3f(1023.0)));
  keys[t * 2u] = (spread(q.x) << 2u) | (spread(q.y) << 1u) | spread(q.z);
  keys[t * 2u + 1u] = t;
}
`;

// One compare-exchange step of a bitonic sort: range.a is the block size, range.count the distance.
const SORT_WGSL = /* wgsl */ `${BUILD_HEAD}
fn before(a: vec2u, b: vec2u) -> bool { return a.x < b.x || (a.x == b.x && a.y < b.y); }
@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let t = flatten(id);
  let j = range.count;
  let i = ((t / j) * 2u * j) + (t % j);
  if (i + j >= range.first) { return; }
  let up = (i & range.a) == 0u;
  let x = vec2u(keys[i * 2u], keys[i * 2u + 1u]);
  let y = vec2u(keys[(i + j) * 2u], keys[(i + j) * 2u + 1u]);
  if (before(y, x) == up) {
    keys[i * 2u] = y.x;
    keys[i * 2u + 1u] = y.y;
    keys[(i + j) * 2u] = x.x;
    keys[(i + j) * 2u + 1u] = x.y;
  }
}
`;

// Internal node i, then leaves after them. `index` and `faces` take leaf order here; every internal node gets its two
// children, found by the longest common prefix of the sorted codes, ties split by position.
const HIERARCHY_WGSL = /* wgsl */ `${BUILD_HEAD}
fn prefix(i: i32, j: i32) -> i32 {
  let n = i32(mesh.triangles);
  if (j < 0 || j >= n) { return -1; }
  let a = keys[u32(i) * 2u];
  let b = keys[u32(j) * 2u];
  if (a == b) { return 32 + i32(countLeadingZeros(u32(i) ^ u32(j))); }
  return i32(countLeadingZeros(a ^ b));
}
@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let t = flatten(id);
  let n = mesh.triangles;
  if (t >= n) { return; }
  let face = keys[t * 2u + 1u];
  faces[t] = face;
  index[t * 3u] = source[face * 3u];
  index[t * 3u + 1u] = source[face * 3u + 1u];
  index[t * 3u + 2u] = source[face * 3u + 2u];
  // The lone triangle of a one-triangle mesh is the root.
  let leaf = select(n - 1u + t, 0u, n == 1u);
  nodes[leaf] = Node(vec3f(0.0), t, vec3f(0.0), 1u);
  keys[range.first + leaf] = 0u;
  if (t + 1u >= n) { return; }
  let i = i32(t);
  let d = select(-1, 1, prefix(i, i + 1) > prefix(i, i - 1));
  let least = prefix(i, i - d);
  var most = 2;
  while (prefix(i, i + most * d) > least) { most *= 2; }
  var length = 0;
  for (var step = most / 2; step >= 1; step /= 2) {
    if (prefix(i, i + (length + step) * d) > least) { length += step; }
  }
  let end = i + length * d;
  let shared_prefix = prefix(i, end);
  var split = 0;
  var part = length;
  loop {
    part = (part + 1) / 2;
    if (prefix(i, i + (split + part) * d) > shared_prefix) { split += part; }
    if (part <= 1) { break; }
  }
  let middle = i + split * d + min(d, 0);
  let first = min(i, end);
  let last = max(i, end);
  let left = select(u32(middle), n - 1u + u32(middle), first == middle);
  let right = select(u32(middle + 1), n - 1u + u32(middle + 1), last == middle + 1);
  nodes[t] = Node(vec3f(0.0), left, vec3f(0.0), right | INTERNAL);
  keys[range.first + t] = 0u;
}
`;

// Bounds climb a level a dispatch. A node's stamp names the dispatch that finished it, and a parent takes only children
// stamped by an earlier dispatch: threads of one dispatch have no ordering, so a node being written is never read.
const CLIMB_WGSL = /* wgsl */ `${BUILD_HEAD}
@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let t = flatten(id);
  if (t >= mesh.nodes) { return; }
  let stamps = range.first;
  if (keys[stamps + t] != 0u) { return; }
  var n = nodes[t];
  if ((n.right & INTERNAL) != 0u) {
    let right = n.right & ~INTERNAL;
    let a = keys[stamps + n.left];
    let b = keys[stamps + right];
    if (a == 0u || b == 0u || a >= range.a || b >= range.a) { return; }
    n.lo = min(nodes[n.left].lo, nodes[right].lo);
    n.hi = max(nodes[n.left].hi, nodes[right].hi);
  } else {
    let a = vertex(index[n.left * 3u]);
    let b = vertex(index[n.left * 3u + 1u]);
    let c = vertex(index[n.left * 3u + 2u]);
    n.lo = min(min(a, b), c);
    n.hi = max(max(a, b), c);
  }
  nodes[t] = n;
  keys[stamps + t] = range.a;
}
`;

function levels(bvh: MeshBVH): { order: Uint32Array; ranges: [number, number][] } {
  // Height of each node: leaves 0, then one above the taller child, so a level reads only levels already done.
  const count = bvh.nodeCount,
    data = bvh.nodeData,
    height = new Uint8Array(count);
  for (let node = count - 1; node >= 0; node--) {
    const w = node * NODE_WORDS;
    if (data[w + 7] & INTERNAL_FLAG) height[node] = Math.max(height[node + 1], height[data[w + 6]]) + 1;
  }
  const buckets: number[][] = [];
  height.forEach((h, node) => (buckets[h] ??= []).push(node));
  const order = new Uint32Array(count),
    ranges: [number, number][] = [];
  let at = 0;
  for (const bucket of buckets) {
    ranges.push([at, bucket.length]);
    order.set(bucket, at);
    at += bucket.length;
  }
  return { order, ranges };
}

interface Step {
  pipeline: GPUComputePipeline;
  groups: GPUBindGroup;
  slot: number;
  x: number;
  y: number;
}

/**
 * A BVH that follows a GPU vertex buffer. Each frame, after whatever writes the vertices, `encode(encoder)` updates the
 * tree; `tree` then traces as any {@link GPUMeshBVH} does, in the same encoder, with no readback.
 */
export class GPUDynamicBVH {
  readonly device: GPUDevice;
  /** The tree on the GPU: `raycast`, `encodeTrace`, `bindings` and the WGSL of `@margoengine/bvh/gpu` all work on it. */
  readonly tree: GPUMeshBVH;
  readonly mode: 'build' | 'refit';
  #steps: Step[] = [];
  #owned: GPUBuffer[] = [];
  #ranges!: GPUBuffer;
  #disposed = false;

  /** Compiles the passes and makes the buffers. Throws a RangeError for a mesh over the device's limits. */
  static async create(target: GPUTarget, options: GPUDynamicBVHOptions): Promise<GPUDynamicBVH> {
    const { vertices, indices, stride = 3, offset = 0, mode = 'build', bvh } = options;
    if (!vertices || typeof vertices.size !== 'number') throw new TypeError('Missing vertices; pass a GPUBuffer of positions.');
    if (!(indices instanceof Uint32Array) || !indices.length || indices.length % 3)
      throw new RangeError('Invalid indices; pass a Uint32Array of whole triangles.');
    if (!Number.isInteger(stride) || stride < 3 || !Number.isInteger(offset) || offset < 0)
      throw new RangeError('Invalid stride or offset; pass whole floats, a stride of at least 3.');
    if (mode !== 'build' && mode !== 'refit') throw new TypeError("Invalid mode; use 'build' or 'refit'.");
    if (mode === 'refit' && (!(bvh instanceof MeshBVH) || bvh.triangleCount !== indices.length / 3))
      throw new TypeError("'refit' needs a MeshBVH of the same triangles; pass it as bvh.");
    const highest = indices.reduce((a, b) => Math.max(a, b), 0);
    if ((highest * stride + offset + 3) * 4 > vertices.size)
      throw new RangeError('The vertices buffer is too small for these indices; check stride and offset.');
    const tree = await GPUMeshBVH.follow(target, {
      vertices,
      stride,
      offset,
      triangles: indices.length / 3,
      nodes: mode === 'refit' ? bvh!.nodeCount : Math.max(indices.length / 3 * 2 - 1, 1),
      bvh: mode === 'refit' ? bvh! : null,
    });
    const self = new GPUDynamicBVH(tree, mode);
    try {
      await (mode === 'refit' ? self.#planRefit(bvh!, vertices) : self.#planBuild(indices, vertices));
    } catch (error) {
      self.dispose();
      throw error;
    }
    return self;
  }

  private constructor(tree: GPUMeshBVH, mode: 'build' | 'refit') {
    this.device = tree.device;
    this.tree = tree;
    this.mode = mode;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Adds the passes that bring the tree up to the vertices' current contents, once they are written in this encoder. */
  encode(encoder: GPUCommandEncoder): void {
    if (this.#disposed) throw new MargoError('disposed', 'GPUDynamicBVH is disposed; create a new one to follow a mesh.');
    const pass = encoder.beginComputePass({ label: 'bvh follow' });
    for (const { pipeline, groups, slot, x, y } of this.#steps) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groups);
      pass.setBindGroup(1, this.#rangeGroup(pipeline), [slot * SLOT]);
      pass.dispatchWorkgroups(x, y);
    }
    pass.end();
  }

  /** Frees the tree and the working buffers. The vertex buffer stays the caller's. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.tree.dispose();
    for (const buffer of this.#owned) buffer.destroy();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #groups = new Map<GPUComputePipeline, GPUBindGroup>();
  #rangeGroup(pipeline: GPUComputePipeline): GPUBindGroup {
    let group = this.#groups.get(pipeline);
    if (!group) {
      group = this.device.createBindGroup({
        label: 'bvh follow range',
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: this.#ranges, size: 16 } }],
      });
      this.#groups.set(pipeline, group);
    }
    return group;
  }

  #buffer(label: string, data: Uint32Array | null, size: number, usage: number): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size, usage: usage | GPUBufferUsage.COPY_DST });
    if (data) this.device.queue.writeBuffer(buffer, 0, data as BufferSource);
    this.#owned.push(buffer);
    return buffer;
  }

  #grid(threads: number): [number, number, number] {
    const groups = Math.max(Math.ceil(threads / GROUP), 1),
      max = this.device.limits.maxComputeWorkgroupsPerDimension,
      x = Math.min(groups, max);
    return [x, Math.ceil(groups / x), x * GROUP];
  }

  async #pipeline(code: string, layout: GPUPipelineLayout): Promise<GPUComputePipeline> {
    return this.device.createComputePipelineAsync({
      label: 'bvh follow',
      layout,
      compute: { module: this.device.createShaderModule({ label: 'bvh follow', code }), entryPoint: 'main' },
    });
  }

  #layout(entries: readonly ('read' | 'write' | 'uniform')[]): GPUPipelineLayout {
    const device = this.device,
      visibility = 4,
      group = device.createBindGroupLayout({
        label: 'bvh follow',
        entries: entries.map((kind, binding) => ({
          binding,
          visibility,
          buffer: { type: kind === 'uniform' ? 'uniform' : kind === 'read' ? 'read-only-storage' : 'storage' },
        })),
      }),
      range = device.createBindGroupLayout({
        label: 'bvh follow range',
        entries: [{ binding: 0, visibility, buffer: { type: 'uniform', hasDynamicOffset: true } }],
      });
    return device.createPipelineLayout({ label: 'bvh follow', bindGroupLayouts: [group, range] });
  }

  #writeRanges(ranges: readonly (readonly [number, number, number, number])[]): void {
    const data = new Uint32Array((ranges.length * SLOT) / 4);
    ranges.forEach((range, i) => data.set(range, (i * SLOT) / 4));
    this.#ranges = this.#buffer('bvh follow ranges', data, data.byteLength, GPUBufferUsage.UNIFORM);
  }

  async #planRefit(bvh: MeshBVH, vertices: GPUBuffer): Promise<void> {
    const { order, ranges } = levels(bvh),
      { tree, device } = this,
      list = this.#buffer('bvh follow order', order, order.byteLength, GPUBufferUsage.STORAGE),
      pipeline = await this.#pipeline(REFIT_WGSL, this.#layout(['write', 'read', 'read', 'uniform', 'read'])),
      groups = device.createBindGroup({
        label: 'bvh refit',
        layout: pipeline.getBindGroupLayout(0),
        entries: [tree.nodes, tree.index, vertices, tree.params, list].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
    this.#writeRanges(
      ranges.map(([first, count], slot) => {
        const [x, y, width] = this.#grid(count);
        this.#steps.push({ pipeline, groups, slot, x, y });
        return [first, count, 0, width];
      }),
    );
  }

  async #planBuild(indices: Uint32Array, vertices: GPUBuffer): Promise<void> {
    const { tree, device } = this,
      triangles = indices.length / 3,
      nodes = Math.max(triangles * 2 - 1, 1);
    let padded = 1;
    while (padded < triangles) padded *= 2;
    const keysBytes = padded * 8 + nodes * 4,
      limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (keysBytes > limit || indices.byteLength > limit)
      throw new RangeError(`${triangles} triangles need ${keysBytes} bytes, over this device's ${limit}; split the mesh.`);
    const source = this.#buffer('bvh follow source', indices, indices.byteLength, GPUBufferUsage.STORAGE),
      keys = this.#buffer('bvh follow keys', null, keysBytes, GPUBufferUsage.STORAGE),
      scene = this.#buffer('bvh follow scene', null, 32, GPUBufferUsage.STORAGE),
      layout = this.#layout(['write', 'write', 'read', 'uniform', 'read', 'write', 'write', 'write']);
    const [reset, bounds, morton, sort, hierarchy, climb] = await Promise.all(
      [RESET_WGSL, BOUNDS_WGSL, MORTON_WGSL, SORT_WGSL, HIERARCHY_WGSL, CLIMB_WGSL].map((code) =>
        this.#pipeline(code, layout),
      ),
    );
    const groups = device.createBindGroup({
        label: 'bvh build',
        layout: bounds.getBindGroupLayout(0),
        entries: [tree.nodes, tree.index, vertices, tree.params, source, tree.faces, keys, scene].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      }),
      ranges: [number, number, number, number][] = [],
      step = (pipeline: GPUComputePipeline, threads: number, first: number, count: number, a: number): void => {
        const [x, y, width] = this.#grid(threads);
        this.#steps.push({ pipeline, groups, slot: ranges.length, x, y });
        ranges.push([first, count, a, width]);
      };
    step(reset, 1, 0, 0, 0);
    step(bounds, triangles, 0, triangles, 0);
    step(morton, padded, 0, padded, 0);
    for (let block = 2; block <= padded; block *= 2)
      for (let distance = block / 2; distance >= 1; distance /= 2) step(sort, padded / 2, padded, distance, block);
    step(hierarchy, triangles, padded * 2, triangles, 0);
    for (let turn = 1; turn <= PASSES + 2; turn++) step(climb, nodes, padded * 2, nodes, turn);
    this.#writeRanges(ranges);
  }
}
