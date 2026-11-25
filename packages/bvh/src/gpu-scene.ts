/// <reference lib="esnext.disposable" preserve="true" />
// The `gpu-scene` entry: a two-level tree on the GPU (Wald, Benthin and Slusallek 2003). Each distinct MeshBVH is one
// bottom tree in a shared pool; the top tree over the instances' world boxes is built on the CPU by binned SAH (Wald
// 2007), one instance a leaf, and refitted when matrices move. A ray enters an instance by its inverse matrix with an
// unnormalized direction, so one bottom tree serves every placement and distances stay in world units. Written from the
// papers; nothing here imports the engine, a GPUDevice is all it needs.
import { MargoError } from '@margoengine/math/errors';
import type { RayLike } from '@margoengine/math/ray';
import { invertMatrix } from '@margoengine/math/mat4';
import { NODE_WORDS, ceilFloat32 as up, floorFloat32 as down } from './build.js';
import type { MeshBVH } from './bvh.js';
import type { Side } from './math.js';
import { GPU_MAX_DEPTH, deviceOf, packNodes, packPositions, triangleWGSL, type GPUTarget } from './gpu-pack.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** Floats per ray in a ray buffer: origin xyz, near, direction xyz, far (as `@margoengine/bvh/gpu`). */
export const GPU_SCENE_RAY_FLOATS = 8;
/** 32-bit words per hit: distance (f32), face | front << 31, instance, weights b and c (f32), triangle slot, 0, 0. */
export const GPU_SCENE_HIT_WORDS = 8;
/** 32-bit words per instance record in {@link GPUSceneBVH.instances}; see {@link sceneBvhWGSL}. */
export const GPU_SCENE_INSTANCE_WORDS = 28;

const WORKGROUP = 64;
const PARAM_CACHE = 64;
const SIDES: Record<Side, number> = { double: 0, front: 1, back: 2 };
const BINS = 16;
/** Past this depth the top build splits by count, so no tree outgrows the WGSL stack. */
const SAH_DEPTH = 40;

/** Surface of an instance, read by {@link sceneBvhWGSL}'s `sceneMaterial`. Linear values. */
export interface GPUSceneMaterial {
  /** Base colour, linear RGB 0-1. Default [1, 1, 1]. */
  color?: readonly [number, number, number];
  /** Opacity 0-1, carried for the caller's shading. Default 1. */
  opacity?: number;
  /** Emitted radiance, linear RGB, any non-negative value. Default [0, 0, 0]. */
  emissive?: readonly [number, number, number];
  /** 0-1. Default 0. */
  metalness?: number;
  /** Perceptual roughness 0-1. Default 0.5. */
  roughness?: number;
}
/** One placement of a tree. */
export interface GPUSceneInstance {
  /** The tree. Instances that share one MeshBVH object share its GPU copy. */
  bvh: MeshBVH;
  /** Object-to-world matrix, 16 numbers column-major. Default identity. */
  matrix?: ArrayLike<number>;
  material?: GPUSceneMaterial;
  /** Which faces count, by the source winding with the normal carried through the matrix (mirrors included). Default 'double'. */
  side?: Side;
}
/** Options of a {@link GPUSceneBVH}. */
export interface GPUSceneBVHOptions {
  /** `update()` refits until the top tree costs this many times its SAH cost when built, then rebuilds it. Default 1.5. */
  rebuildThreshold?: number;
}
/** Settings of {@link GPUSceneBVH.raycast}. */
export interface GPUSceneRaycastOptions {
  /** 'closest' (default) or 'any' (stops at the first hit found). */
  mode?: 'closest' | 'any';
  /** Hits closer than this are ignored, for rays given as objects. Default 0. */
  near?: number;
  /** Hits farther than this are ignored, for rays given as objects. Default Infinity. */
  far?: number;
  signal?: AbortSignal;
}
/** Answers of {@link GPUSceneBVH.raycast}, one per ray. */
export interface GPUSceneHits {
  count: number;
  /** World distance along the ray, Infinity for a miss. */
  distance: Float32Array;
  /** Instance index, -1 for a miss. */
  instance: Int32Array;
  /** Source face index in that instance's mesh, -1 for a miss. */
  faceIndex: Int32Array;
  /** Three weights per ray. Zero for a miss. */
  barycoord: Float32Array;
  /** 1 where the ray met a front face. */
  frontFace: Uint8Array;
}
/** What {@link GPUSceneBVH.update} did. */
export type GPUSceneUpdate = 'unchanged' | 'refit' | 'rebuilt';
/** Where WGSL finds the scene. */
export interface GPUSceneBindingOptions {
  /** Default 0. */
  group?: number;
  /** First of its five bindings. Default 0. */
  binding?: number;
}

/**
 * WGSL for tracing a {@link GPUSceneBVH} in your own shader. Declares the five bindings {@link GPUSceneBVH.bindings}
 * fills and `sceneClosest(origin, direction, near, far)` / `sceneAny(...)`, which answer a `SceneHit` (`instance` is
 * `SCENE_MISS` for a miss; distances are world lengths along the normalized direction), `sceneNormal(hit)` (the world
 * geometric normal, toward the front side) and `sceneMaterial(instance)`.
 */
export function sceneBvhWGSL({ group = 0, binding = 0 }: GPUSceneBindingOptions = {}): string {
  for (const [name, value] of [
    ['group', group],
    ['binding', binding],
  ] as const)
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`Invalid ${name}; pass a non-negative integer.`);
  const at = (offset: number): string => `@group(${group}) @binding(${binding + offset})`;
  return /* wgsl */ `
struct SceneNode { lo: vec3f, left: u32, hi: vec3f, right: u32 }
struct SceneInstance { r0: vec4f, r1: vec4f, r2: vec4f, base: vec4u, color: vec4f, emissive: vec4f, pbr: vec4f }
struct SceneParams { top: u32, instances: u32, pad0: u32, pad1: u32 }
struct SceneHit { distance: f32, instance: u32, face: u32, triangle: u32, barycoord: vec3f, front: bool }
struct SceneMaterial { color: vec3f, opacity: f32, emissive: vec3f, metalness: f32, roughness: f32 }
${at(0)} var<storage, read> sceneNodes: array<SceneNode>;
${at(1)} var<storage, read> sceneTris: array<vec4u>;
${at(2)} var<storage, read> scenePositions: array<f32>;
${at(3)} var<storage, read> sceneInstances: array<SceneInstance>;
${at(4)} var<uniform> sceneParams: SceneParams;
const SCENE_MISS = 0xffffffffu;
const SCENE_INTERNAL = 0x80000000u;
const SCENE_NEVER = 3.4e38;
${triangleWGSL('scene', 'Scene')}
fn sceneVertex(i: u32) -> vec3f {
  return vec3f(scenePositions[i * 3u], scenePositions[i * 3u + 1u], scenePositions[i * 3u + 2u]);
}
// A ray whose direction keeps its length: in an instance's space it is the world direction through the inverse matrix,
// so a distance along it is a world distance.
fn sceneRay(origin: vec3f, d: vec3f, near: f32, far: f32) -> SceneRay {
  let a = abs(d);
  var z = 2u;
  if (a.x >= a.y && a.x >= a.z) { z = 0u; } else if (a.y >= a.z) { z = 1u; }
  var x = (z + 1u) % 3u;
  var y = (x + 1u) % 3u;
  if (d[z] < 0.0) { let swap = x; x = y; y = swap; }
  let shear = vec3f(d[x] / d[z], d[y] / d[z], 1.0 / d[z]);
  return SceneRay(origin, d, vec3f(sceneInverse(d.x), sceneInverse(d.y), sceneInverse(d.z)), shear, vec3u(x, y, z), near, far);
}
fn sceneEnter(node: u32, r: SceneRay, far: f32) -> f32 {
  let n = sceneNodes[node];
  let a = (n.lo - r.origin) * r.inverse;
  let b = (n.hi - r.origin) * r.inverse;
  let near3 = min(a, b);
  let far3 = max(a, b);
  let enter = max(max(near3.x, near3.y), max(near3.z, r.near));
  let leave = min(min(far3.x, far3.y), far3.z) * 1.0000004;
  return select(SCENE_NEVER, enter, enter <= leave && enter <= far);
}
// Equal distances answer the lowest instance, then the lowest face, so every device and the CPU agree.
fn sceneBetter(t: f32, instance: u32, face: u32, best: SceneHit) -> bool {
  if (best.instance == SCENE_MISS || t < best.distance) { return true; }
  return t == best.distance && (instance < best.instance || (instance == best.instance && face < best.face));
}
fn sceneBottom(instance: u32, world: SceneRay, best0: SceneHit, any: bool) -> SceneHit {
  var best = best0;
  let m = sceneInstances[instance];
  let o = world.origin;
  let d = world.direction;
  let r = sceneRay(
    vec3f(dot(m.r0.xyz, o) + m.r0.w, dot(m.r1.xyz, o) + m.r1.w, dot(m.r2.xyz, o) + m.r2.w),
    vec3f(dot(m.r0.xyz, d), dot(m.r1.xyz, d), dot(m.r2.xyz, d)),
    world.near,
    best.distance,
  );
  let root = m.base.x;
  // The face test runs in the instance's space: dot(n, M^-1 d) = dot(M^-T n, d), so front faces are those of the
  // transformed normal, mirroring matrices included.
  let side = m.base.w;
  var stack: array<u32, ${GPU_MAX_DEPTH}>;
  var entry: array<f32, ${GPU_MAX_DEPTH}>;
  var top = 0u;
  var node = root;
  if (sceneEnter(root, r, best.distance) >= SCENE_NEVER) { return best; }
  loop {
    let n = sceneNodes[node];
    var next = false;
    if ((n.right & SCENE_INTERNAL) != 0u) {
      let left = root + n.left;
      let right = root + (n.right & ~SCENE_INTERNAL);
      let tl = sceneEnter(left, r, best.distance);
      let tr = sceneEnter(right, r, best.distance);
      if (tl < SCENE_NEVER && tr < SCENE_NEVER) {
        stack[top] = select(right, left, tr < tl);
        entry[top] = max(tl, tr);
        top += 1u;
        node = select(left, right, tr < tl);
        next = true;
      } else if (tl < SCENE_NEVER) {
        node = left;
        next = true;
      } else if (tr < SCENE_NEVER) {
        node = right;
        next = true;
      }
    } else {
      for (var k = 0u; k < n.right; k += 1u) {
        let slot = m.base.y + n.left + k;
        let t = sceneTris[slot];
        let a = sceneVertex(m.base.z + t.x);
        let b = sceneVertex(m.base.z + t.y);
        let c = sceneVertex(m.base.z + t.z);
        let hit = sceneTriangle(r, a, b, c, side, best.distance);
        if (hit.w < 0.0 || !sceneBetter(hit.w, instance, t.w, best)) { continue; }
        best = SceneHit(hit.w, instance, t.w, slot, hit.xyz, dot(cross(b - a, c - a), r.direction) < 0.0);
        if (any) { return best; }
      }
    }
    if (next) { continue; }
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
fn sceneWalk(origin: vec3f, direction: vec3f, near: f32, far: f32, any: bool) -> SceneHit {
  var best = SceneHit(far, SCENE_MISS, SCENE_MISS, SCENE_MISS, vec3f(0.0), false);
  if (sceneParams.instances == 0u || dot(direction, direction) == 0.0) { return best; }
  let r = sceneRay(origin, normalize(direction), near, far);
  var stack: array<u32, ${GPU_MAX_DEPTH}>;
  var entry: array<f32, ${GPU_MAX_DEPTH}>;
  var top = 0u;
  var node = 0u;
  if (sceneEnter(0u, r, far) >= SCENE_NEVER) { return best; }
  loop {
    let n = sceneNodes[node];
    var next = false;
    if ((n.right & SCENE_INTERNAL) != 0u) {
      let left = n.left;
      let right = n.right & ~SCENE_INTERNAL;
      let tl = sceneEnter(left, r, best.distance);
      let tr = sceneEnter(right, r, best.distance);
      if (tl < SCENE_NEVER && tr < SCENE_NEVER) {
        stack[top] = select(right, left, tr < tl);
        entry[top] = max(tl, tr);
        top += 1u;
        node = select(left, right, tr < tl);
        next = true;
      } else if (tl < SCENE_NEVER) {
        node = left;
        next = true;
      } else if (tr < SCENE_NEVER) {
        node = right;
        next = true;
      }
    } else {
      best = sceneBottom(n.left, r, best, any);
      if (any && best.instance != SCENE_MISS) { return best; }
    }
    if (next) { continue; }
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
fn sceneClosest(origin: vec3f, direction: vec3f, near: f32, far: f32) -> SceneHit {
  return sceneWalk(origin, direction, near, far, false);
}
fn sceneAny(origin: vec3f, direction: vec3f, near: f32, far: f32) -> SceneHit {
  return sceneWalk(origin, direction, near, far, true);
}
fn sceneNormal(h: SceneHit) -> vec3f {
  let m = sceneInstances[h.instance];
  let t = sceneTris[h.triangle];
  let a = sceneVertex(m.base.z + t.x);
  let n = cross(sceneVertex(m.base.z + t.y) - a, sceneVertex(m.base.z + t.z) - a);
  // The inverse transpose of the object-to-world matrix is the transpose of the world-to-object rows.
  let w = n.x * m.r0.xyz + n.y * m.r1.xyz + n.z * m.r2.xyz;
  return normalize(w);
}
fn sceneMaterial(instance: u32) -> SceneMaterial {
  let m = sceneInstances[instance];
  return SceneMaterial(m.color.rgb, m.color.a, m.emissive.rgb, m.pbr.x, m.pbr.y);
}
`;
}

const TRACE_WGSL = /* wgsl */ `${sceneBvhWGSL()}
struct TraceRay { origin: vec3f, near: f32, direction: vec3f, far: f32 }
struct Trace { count: u32, any: u32, width: u32, pad: u32 }
@group(1) @binding(0) var<storage, read> rays: array<TraceRay>;
@group(1) @binding(1) var<storage, read_write> hits: array<vec4u>;
@group(1) @binding(2) var<uniform> trace: Trace;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.y * trace.width + id.x;
  if (i >= trace.count) { return; }
  let ray = rays[i];
  let hit = sceneWalk(ray.origin, ray.direction, ray.near, ray.far, trace.any != 0u);
  if (hit.instance == SCENE_MISS) {
    hits[i * 2u] = vec4u(bitcast<u32>(-1.0), SCENE_MISS, SCENE_MISS, 0u);
    hits[i * 2u + 1u] = vec4u(0u);
    return;
  }
  let front = select(0u, SCENE_INTERNAL, hit.front);
  hits[i * 2u] = vec4u(bitcast<u32>(hit.distance), hit.face | front, hit.instance, bitcast<u32>(hit.barycoord.y));
  hits[i * 2u + 1u] = vec4u(bitcast<u32>(hit.barycoord.z), hit.triangle, 0u, 0u);
}
`;

const pipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline>>();
function tracePipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipelineAsync({
      label: 'bvh scene trace',
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ label: 'bvh scene trace', code: TRACE_WGSL }),
        entryPoint: 'main',
      },
    });
    pipelines.set(device, pipeline);
    pipeline.catch(() => pipelines.delete(device));
  }
  return pipeline;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
interface Bottom {
  bvh: MeshBVH;
  /** Root bounds of the tree, from its first node. */
  lo: [number, number, number];
  hi: [number, number, number];
  node: number;
  tri: number;
  vertex: number;
}
interface Placed {
  bottom: Bottom;
  matrix: Float64Array;
  material: Required<GPUSceneMaterial>;
  side: number;
}

const unit = (value: number, name: string): number => {
  if (!(value >= 0 && value <= 1)) throw new RangeError(`Invalid ${name}; pass a number from 0 to 1.`);
  return value;
};
function readMaterial(material: GPUSceneMaterial = {}): Required<GPUSceneMaterial> {
  const rgb = (value: readonly number[], name: string, max: number): [number, number, number] => {
    if (value.length !== 3 || !value.every((v) => v >= 0 && v <= max))
      throw new RangeError(`Invalid ${name}; pass three numbers from 0 to ${max === Infinity ? 'any size' : max}.`);
    return [value[0], value[1], value[2]];
  };
  return {
    color: rgb(material.color ?? [1, 1, 1], 'color', 1),
    opacity: unit(material.opacity ?? 1, 'opacity'),
    emissive: rgb(material.emissive ?? [0, 0, 0], 'emissive', Infinity),
    metalness: unit(material.metalness ?? 0, 'metalness'),
    roughness: unit(material.roughness ?? 0.5, 'roughness'),
  };
}
function readMatrix(matrix: ArrayLike<number> = IDENTITY, index: number): Float64Array {
  if (matrix.length !== 16) throw new RangeError(`Invalid matrix of instance ${index}; pass 16 numbers.`);
  const m = Float64Array.from(matrix);
  if (!m.every(Number.isFinite))
    throw new RangeError(`Matrix of instance ${index} is not finite; pass 16 finite numbers.`);
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1)
    throw new RangeError(`Matrix of instance ${index} is not affine; the last row must be 0, 0, 0, 1.`);
  if (!invertMatrix(m))
    throw new RangeError(`Matrix of instance ${index} is not invertible; give every axis a non-zero scale.`);
  return m;
}

/** Top tree in its GPU order, plus its SAH cost (sum of internal node areas over the root area). */
interface Top {
  nodes: Float32Array;
  words: Uint32Array;
  count: number;
}

/** World bounds of an instance: the eight corners of its tree's root box through its matrix. */
function worldBox(placed: Placed, out: Float64Array, o: number): void {
  const { lo, hi } = placed.bottom,
    m = placed.matrix;
  out.fill(Infinity, o, o + 3);
  out.fill(-Infinity, o + 3, o + 6);
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? hi[0] : lo[0],
      y = k & 2 ? hi[1] : lo[1],
      z = k & 4 ? hi[2] : lo[2];
    for (let a = 0; a < 3; a++) {
      const v = m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a];
      if (v < out[o + a]) out[o + a] = v;
      if (v > out[o + 3 + a]) out[o + 3 + a] = v;
    }
  }
}
const area = (b: ArrayLike<number>, o: number): number => {
  const x = Math.max(0, b[o + 3] - b[o]),
    y = Math.max(0, b[o + 4] - b[o + 1]),
    z = Math.max(0, b[o + 5] - b[o + 2]);
  return x * y + y * z + z * x;
};

/**
 * Binned SAH over instance boxes, one instance a leaf, depth-first: an internal node's left child is the next node.
 * Writes boxes rounded outward to float32 (the tree must hold its float64 boxes).
 */
function buildTop(boxes: Float64Array, count: number): Top {
  const total = Math.max(1, 2 * count - 1),
    nodes = new Float32Array(total * NODE_WORDS),
    words = new Uint32Array(nodes.buffer),
    order = new Uint32Array(count),
    centre = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    order[i] = i;
    for (let a = 0; a < 3; a++) centre[i * 3 + a] = (boxes[i * 6 + a] + boxes[i * 6 + 3 + a]) * 0.5;
  }
  let next = 0;
  const binBox = new Float64Array(BINS * 6),
    binCount = new Uint32Array(BINS),
    rightArea = new Float64Array(BINS),
    rightCount = new Uint32Array(BINS);
  const node = (first: number, end: number, depth: number): number => {
    const index = next++,
      o = index * NODE_WORDS,
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity],
      clo = [Infinity, Infinity, Infinity],
      chi = [-Infinity, -Infinity, -Infinity];
    for (let i = first; i < end; i++) {
      const b = order[i];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], boxes[b * 6 + a]);
        hi[a] = Math.max(hi[a], boxes[b * 6 + 3 + a]);
        clo[a] = Math.min(clo[a], centre[b * 3 + a]);
        chi[a] = Math.max(chi[a], centre[b * 3 + a]);
      }
    }
    for (let a = 0; a < 3; a++) {
      nodes[o + a] = down(lo[a]);
      nodes[o + 4 + a] = up(hi[a]);
    }
    if (end - first === 1) {
      words[o + 3] = order[first];
      words[o + 7] = 1;
      return index;
    }
    let split = -1,
      axis = 0;
    if (depth < SAH_DEPTH) {
      let best = Infinity;
      for (let a = 0; a < 3; a++) {
        const extent = chi[a] - clo[a];
        if (!(extent > 0)) continue;
        binBox.fill(Infinity);
        for (let k = 0; k < BINS; k++) binBox.fill(-Infinity, k * 6 + 3, k * 6 + 6);
        binCount.fill(0);
        for (let i = first; i < end; i++) {
          const b = order[i],
            k = Math.min(BINS - 1, Math.floor(((centre[b * 3 + a] - clo[a]) / extent) * BINS));
          binCount[k]++;
          for (let c = 0; c < 3; c++) {
            binBox[k * 6 + c] = Math.min(binBox[k * 6 + c], boxes[b * 6 + c]);
            binBox[k * 6 + 3 + c] = Math.max(binBox[k * 6 + 3 + c], boxes[b * 6 + 3 + c]);
          }
        }
        const run = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        let n = 0;
        for (let k = BINS - 1; k > 0; k--) {
          for (let c = 0; c < 3; c++) {
            run[c] = Math.min(run[c], binBox[k * 6 + c]);
            run[3 + c] = Math.max(run[3 + c], binBox[k * 6 + 3 + c]);
          }
          n += binCount[k];
          rightArea[k] = n ? area(run, 0) : 0;
          rightCount[k] = n;
        }
        run.fill(Infinity, 0, 3);
        run.fill(-Infinity, 3, 6);
        n = 0;
        for (let k = 0; k < BINS - 1; k++) {
          for (let c = 0; c < 3; c++) {
            run[c] = Math.min(run[c], binBox[k * 6 + c]);
            run[3 + c] = Math.max(run[3 + c], binBox[k * 6 + 3 + c]);
          }
          n += binCount[k];
          const right = rightCount[k + 1];
          if (!n || !right) continue;
          const cost = area(run, 0) * n + rightArea[k + 1] * right;
          if (cost < best) {
            best = cost;
            axis = a;
            split = k + 1;
          }
        }
      }
    }
    let middle: number;
    if (split >= 0) {
      // Partition by bin, the same arithmetic as the binning, so no centre lands on the wrong side.
      const extent = chi[axis] - clo[axis];
      let i = first,
        j = end - 1;
      const bin = (b: number) => Math.min(BINS - 1, Math.floor(((centre[b * 3 + axis] - clo[axis]) / extent) * BINS));
      while (i <= j) {
        if (bin(order[i]) < split) i++;
        else {
          const swap = order[i];
          order[i] = order[j];
          order[j--] = swap;
        }
      }
      middle = i;
    } else {
      // Coincident centres or too deep: split by count along the widest axis, which halves the depth each time.
      let a = 0;
      for (let c = 1; c < 3; c++) if (chi[c] - clo[c] > chi[a] - clo[a]) a = c;
      const part = Array.from(order.subarray(first, end)).sort(
        (x, y) => centre[x * 3 + a] - centre[y * 3 + a] || x - y,
      );
      order.set(part, first);
      middle = (first + end) >> 1;
    }
    node(first, middle, depth + 1);
    const right = node(middle, end, depth + 1);
    words[o + 3] = index + 1;
    words[o + 7] = (right | 0x80000000) >>> 0;
    return index;
  };
  if (count) node(0, count, 0);
  return { nodes, words, count: total };
}
// A GPU node keeps lo at o..o+2 and hi at o+4..o+6.
const nodeArea = (n: Float32Array, o: number): number =>
  area([n[o], n[o + 1], n[o + 2], n[o + 4], n[o + 5], n[o + 6]], 0);
/** SAH cost of a top tree: internal node areas over the root area, so a refit can be compared with the build. */
function topCost(top: Top): number {
  const root = nodeArea(top.nodes, 0) || 1;
  let sum = 0;
  for (let i = 0; i < top.count; i++)
    if (top.words[i * NODE_WORDS + 7] & 0x80000000) sum += nodeArea(top.nodes, i * NODE_WORDS);
  return sum / root;
}

/**
 * A scene of placed trees on the GPU, for ray tracing inside your own shaders through {@link sceneBvhWGSL} or by
 * `raycast`. `await GPUSceneBVH.create(device, instances)` uploads it; `setMatrix`/`setMaterial` then `update()` move
 * and restyle instances (a refit, or a rebuild once the top tree has grown past `rebuildThreshold`). Queries run in
 * float32.
 */
export class GPUSceneBVH {
  readonly device: GPUDevice;
  /** Top nodes then every bottom tree's nodes, 32 bytes each. */
  readonly nodes: GPUBuffer;
  /** Per triangle slot: three vertex indices and the source face, 16 bytes. */
  readonly triangles: GPUBuffer;
  /** Vertex positions of every bottom tree, three floats each. */
  readonly positions: GPUBuffer;
  /** {@link GPU_SCENE_INSTANCE_WORDS} words per instance. */
  readonly instances: GPUBuffer;
  /** Top node count and instance count, read by the WGSL. */
  readonly params: GPUBuffer;
  /** Number of instances. */
  readonly count: number;
  readonly rebuildThreshold: number;
  #placed: Placed[];
  #top: Top;
  #topNodes: number;
  #builtCost: number;
  #boxes: Float64Array;
  #dirtyMatrix = false;
  #dirtyMaterial = false;
  #pipeline: GPUComputePipeline | null;
  #tree: GPUBindGroup | null;
  #traces = new Map<string, GPUBuffer>();
  #disposed = false;

  /** Uploads the scene with a trace pipeline for `raycast`. */
  static async create(
    target: GPUTarget,
    instances: Iterable<GPUSceneInstance>,
    options?: GPUSceneBVHOptions,
  ): Promise<GPUSceneBVH> {
    const device = deviceOf(target);
    return new GPUSceneBVH(device, [...instances], options ?? {}, await tracePipeline(device));
  }

  /** Uploads the scene for your own shader only, at once: `raycast` throws. */
  static forShader(
    target: GPUTarget,
    instances: Iterable<GPUSceneInstance>,
    options?: GPUSceneBVHOptions,
  ): GPUSceneBVH {
    return new GPUSceneBVH(deviceOf(target), [...instances], options ?? {}, null);
  }

  private constructor(
    device: GPUDevice,
    list: GPUSceneInstance[],
    { rebuildThreshold = 1.5 }: GPUSceneBVHOptions,
    pipeline: GPUComputePipeline | null,
  ) {
    if (!(rebuildThreshold >= 1)) throw new RangeError('Invalid rebuildThreshold; pass a number of at least 1.');
    this.device = device;
    this.rebuildThreshold = rebuildThreshold;
    this.count = list.length;
    this.#pipeline = pipeline;
    const bottoms = new Map<MeshBVH, Bottom>();
    let nodeCount = 0,
      triCount = 0,
      vertexCount = 0;
    this.#placed = list.map((instance, i) => {
      const bvh = instance?.bvh;
      if (!bvh || !(bvh.nodeBounds instanceof Float32Array))
        throw new TypeError(`Instance ${i} has no bvh; pass a MeshBVH.`);
      if (instance.side !== undefined && !Object.hasOwn(SIDES, instance.side))
        throw new TypeError(`Invalid side of instance ${i}; use front, back or double.`);
      let bottom = bottoms.get(bvh);
      if (!bottom) {
        const b = bvh.nodeBounds;
        bottom = {
          bvh,
          lo: [b[0], b[1], b[2]],
          hi: [b[3], b[4], b[5]],
          node: 0,
          tri: triCount,
          vertex: vertexCount,
        };
        nodeCount += bvh.nodeCount;
        triCount += bvh.triangleCount;
        vertexCount += Math.floor((bvh.positions.length - 3) / bvh.stride) + 1;
        bottoms.set(bvh, bottom);
      }
      return {
        bottom,
        matrix: readMatrix(instance.matrix, i),
        material: readMaterial(instance.material),
        side: SIDES[instance.side ?? 'double'],
      };
    });
    this.#boxes = new Float64Array(this.count * 6);
    this.#placed.forEach((placed, i) => worldBox(placed, this.#boxes, i * 6));
    this.#top = buildTop(this.#boxes, this.count);
    this.#builtCost = topCost(this.#top);
    // The top tree's size is fixed by the count (2n - 1 nodes), so rebuilds reuse the buffer.
    this.#topNodes = this.#top.count;
    let at = this.#topNodes;
    for (const bottom of bottoms.values()) {
      bottom.node = at;
      at += bottom.bvh.nodeCount;
    }
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    for (const [name, bytes] of [
      ['nodes', (this.#topNodes + nodeCount) * NODE_WORDS * 4],
      ['positions', vertexCount * 12],
      ['triangles', triCount * 16],
      ['instances', this.count * GPU_SCENE_INSTANCE_WORDS * 4],
    ] as const)
      if (bytes > limit)
        throw new RangeError(
          `Scene ${name} take ${bytes} bytes, over this device's ${limit}; request a higher maxStorageBufferBindingSize or split the scene.`,
        );
    // An empty array still binds one element: a buffer under one struct fails validation.
    const make = (label: string, size: number, usage: number, least = 16): GPUBuffer =>
      device.createBuffer({ label, size: Math.max(least, size), usage: usage | GPUBufferUsage.COPY_DST });
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    this.nodes = make('bvh scene nodes', (this.#topNodes + nodeCount) * NODE_WORDS * 4, storage, NODE_WORDS * 4);
    this.triangles = make('bvh scene triangles', triCount * 16, storage);
    this.positions = make('bvh scene positions', vertexCount * 12, storage);
    this.instances = make(
      'bvh scene instances',
      this.count * GPU_SCENE_INSTANCE_WORDS * 4,
      storage,
      GPU_SCENE_INSTANCE_WORDS * 4,
    );
    this.params = make('bvh scene params', 16, GPUBufferUsage.UNIFORM);
    for (const bottom of bottoms.values()) {
      const { bvh } = bottom;
      if (bvh.nodeCount > 0) device.queue.writeBuffer(this.nodes, bottom.node * NODE_WORDS * 4, packNodes(bvh));
      const tris = new Uint32Array(bvh.triangleCount * 4);
      for (let t = 0; t < bvh.triangleCount; t++) {
        tris[t * 4] = bvh.index[t * 3];
        tris[t * 4 + 1] = bvh.index[t * 3 + 1];
        tris[t * 4 + 2] = bvh.index[t * 3 + 2];
        tris[t * 4 + 3] = bvh.triangles[t];
      }
      if (tris.length) device.queue.writeBuffer(this.triangles, bottom.tri * 16, tris as BufferSource);
      const positions = packPositions(bvh);
      if (positions.length) device.queue.writeBuffer(this.positions, bottom.vertex * 12, positions as BufferSource);
    }
    device.queue.writeBuffer(this.params, 0, new Uint32Array([this.#topNodes, this.count, 0, 0]));
    this.#writeTop();
    this.#writeInstances();
    this.#tree =
      pipeline &&
      device.createBindGroup({ label: 'bvh scene', layout: pipeline.getBindGroupLayout(0), entries: this.bindings() });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** The five bind group entries {@link sceneBvhWGSL} declares, from binding `first`. */
  bindings(first = 0): GPUBindGroupEntry[] {
    return [this.nodes, this.triangles, this.positions, this.instances, this.params].map((buffer, i) => ({
      binding: first + i,
      resource: { buffer },
    }));
  }

  /** Moves instance `index` (object-to-world, 16 numbers column-major); sent by the next `update()`. */
  setMatrix(index: number, matrix: ArrayLike<number>): void {
    this.#live();
    this.#index(index);
    this.#placed[index].matrix = readMatrix(matrix, index);
    this.#dirtyMatrix = true;
  }

  /** Restyles instance `index`; sent by the next `update()`. */
  setMaterial(index: number, material: GPUSceneMaterial): void {
    this.#live();
    this.#index(index);
    this.#placed[index].material = readMaterial(material);
    this.#dirtyMaterial = true;
  }

  /** World bounds of instance `index`: lo xyz then hi xyz, float64. */
  instanceBounds(index: number): Float64Array {
    this.#index(index);
    return this.#boxes.slice(index * 6, index * 6 + 6);
  }

  /**
   * Sends changed matrices and materials. Moved instances refit the top tree; once its SAH cost passes
   * `rebuildThreshold` times the cost at its last build, it is built again.
   */
  update(): GPUSceneUpdate {
    this.#live();
    if (!this.#dirtyMatrix && !this.#dirtyMaterial) return 'unchanged';
    let result: GPUSceneUpdate = 'refit';
    if (this.#dirtyMatrix) {
      this.#placed.forEach((placed, i) => worldBox(placed, this.#boxes, i * 6));
      this.#refit();
      if (topCost(this.#top) > this.#builtCost * this.rebuildThreshold) {
        this.#top = buildTop(this.#boxes, this.count);
        this.#builtCost = topCost(this.#top);
        result = 'rebuilt';
      }
      this.#writeTop();
    }
    this.#writeInstances();
    this.#dirtyMatrix = this.#dirtyMaterial = false;
    return result;
  }

  /** The top tree's SAH cost now (internal node areas over the root area). */
  get cost(): number {
    return topCost(this.#top);
  }

  /**
   * Adds a trace to `encoder`: `rays` holds {@link GPU_SCENE_RAY_FLOATS} floats a ray and `hits` receives
   * {@link GPU_SCENE_HIT_WORDS} words a ray, both with STORAGE usage. `far` must be finite.
   */
  encodeTrace(
    encoder: GPUCommandEncoder,
    rays: GPUBuffer,
    hits: GPUBuffer,
    count: number,
    { mode = 'closest' }: Pick<GPUSceneRaycastOptions, 'mode'> = {},
  ): void {
    this.#live();
    if (!Number.isInteger(count) || count < 0) throw new RangeError('Invalid ray count; pass a non-negative integer.');
    if (mode !== 'closest' && mode !== 'any') throw new TypeError('Invalid trace mode; use closest or any.');
    const pipeline = this.#pipeline;
    if (!pipeline)
      throw new MargoError(
        'state',
        'This scene is for your own shader; make one with GPUSceneBVH.create to trace rays.',
      );
    if (!count) return;
    if (rays.size < count * GPU_SCENE_RAY_FLOATS * 4 || hits.size < count * GPU_SCENE_HIT_WORDS * 4)
      throw new RangeError(
        `Ray or hit buffer is too small for ${count} rays; size them with GPU_SCENE_RAY_FLOATS and GPU_SCENE_HIT_WORDS.`,
      );
    const groups = Math.ceil(count / WORKGROUP),
      max = this.device.limits.maxComputeWorkgroupsPerDimension,
      x = Math.min(groups, max),
      y = Math.ceil(groups / x);
    if (y > max) throw new RangeError(`${count} rays are more than one dispatch holds; trace them in parts.`);
    const pass = encoder.beginComputePass({ label: 'bvh scene trace' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#tree);
    pass.setBindGroup(
      1,
      this.device.createBindGroup({
        label: 'bvh scene rays',
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: rays } },
          { binding: 1, resource: { buffer: hits } },
          { binding: 2, resource: { buffer: this.#trace(count, mode === 'any' ? 1 : 0, x * WORKGROUP) } },
        ],
      }),
    );
    pass.dispatchWorkgroups(x, y);
    pass.end();
  }

  /** Traces rays and reads the answers back. Rays are objects with `origin` and `direction`, or a packed Float32Array. */
  async raycast(rays: readonly RayLike[] | Float32Array, options: GPUSceneRaycastOptions = {}): Promise<GPUSceneHits> {
    this.#live();
    const { signal, near = 0, far = Infinity } = options;
    signal?.throwIfAborted();
    if (!(near >= 0) || !(far >= near)) throw new RangeError('Invalid near or far; pass 0 <= near <= far.');
    let packed: Float32Array;
    if (rays instanceof Float32Array) packed = rays;
    else {
      packed = new Float32Array(rays.length * GPU_SCENE_RAY_FLOATS);
      rays.forEach(({ origin, direction }, i) => {
        const o = i * GPU_SCENE_RAY_FLOATS;
        for (let k = 0; k < 3; k++) {
          packed[o + k] = origin[k];
          packed[o + 4 + k] = direction[k];
        }
        packed[o + 3] = near;
        packed[o + 7] = Math.min(far, 3e38);
      });
    }
    if (packed.length % GPU_SCENE_RAY_FLOATS)
      throw new RangeError('Incomplete ray buffer; pass whole rays of GPU_SCENE_RAY_FLOATS floats.');
    for (let i = 0; i < packed.length; i++)
      if (!Number.isFinite(packed[i]))
        throw new RangeError(`Ray ${Math.floor(i / GPU_SCENE_RAY_FLOATS)} is not finite; far must be at most 3e38.`);
    const count = packed.length / GPU_SCENE_RAY_FLOATS,
      device = this.device,
      result: GPUSceneHits = {
        count,
        distance: new Float32Array(count),
        instance: new Int32Array(count),
        faceIndex: new Int32Array(count),
        barycoord: new Float32Array(count * 3),
        frontFace: new Uint8Array(count),
      };
    if (!count) return result;
    if (packed.byteLength > device.limits.maxStorageBufferBindingSize)
      throw new RangeError(`${count} rays are over this device's storage binding size; trace them in parts.`);
    const bytes = count * GPU_SCENE_HIT_WORDS * 4,
      input = device.createBuffer({
        label: 'bvh scene rays',
        size: packed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      output = device.createBuffer({
        label: 'bvh scene hits',
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      read = device.createBuffer({
        label: 'bvh scene read',
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    try {
      device.queue.writeBuffer(input, 0, packed as BufferSource);
      const encoder = device.createCommandEncoder({ label: 'bvh scene raycast' });
      this.encodeTrace(encoder, input, output, count, options);
      encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      signal?.throwIfAborted();
      const mapped = read.getMappedRange(),
        floats = new Float32Array(mapped),
        words = new Uint32Array(mapped);
      for (let i = 0; i < count; i++) {
        const o = i * GPU_SCENE_HIT_WORDS;
        if (words[o + 2] === 0xffffffff) {
          result.distance[i] = Infinity;
          result.instance[i] = result.faceIndex[i] = -1;
          continue;
        }
        const b = floats[o + 3],
          c = floats[o + 4];
        result.distance[i] = floats[o];
        result.faceIndex[i] = words[o + 1] & 0x7fffffff;
        result.frontFace[i] = words[o + 1] >>> 31;
        result.instance[i] = words[o + 2];
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
    for (const buffer of [this.nodes, this.triangles, this.positions, this.instances, this.params]) buffer.destroy();
    for (const buffer of this.#traces.values()) buffer.destroy();
    this.#traces.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  // Bottom-up: a child always follows its parent in the depth-first order.
  #refit(): void {
    const { nodes, words, count } = this.#top,
      boxes = this.#boxes;
    for (let i = count - 1; i >= 0; i--) {
      const o = i * NODE_WORDS;
      if (words[o + 7] & 0x80000000) {
        const l = words[o + 3] * NODE_WORDS,
          r = (words[o + 7] & 0x7fffffff) * NODE_WORDS;
        for (let a = 0; a < 3; a++) {
          nodes[o + a] = Math.min(nodes[l + a], nodes[r + a]);
          nodes[o + 4 + a] = Math.max(nodes[l + 4 + a], nodes[r + 4 + a]);
        }
      } else if (this.count) {
        const b = words[o + 3] * 6;
        for (let a = 0; a < 3; a++) {
          nodes[o + a] = down(boxes[b + a]);
          nodes[o + 4 + a] = up(boxes[b + 3 + a]);
        }
      }
    }
  }

  #writeTop(): void {
    if (this.count) this.device.queue.writeBuffer(this.nodes, 0, this.#top.nodes as BufferSource);
  }

  #writeInstances(): void {
    if (!this.count) return;
    const packed = new Float32Array(this.count * GPU_SCENE_INSTANCE_WORDS),
      words = new Uint32Array(packed.buffer),
      inverse = new Float64Array(16);
    this.#placed.forEach(({ bottom, matrix: m, material, side }, i) => {
      const o = i * GPU_SCENE_INSTANCE_WORDS;
      invertMatrix(m, inverse);
      // World-to-object rows: row a holds column-major entries a, 4 + a, 8 + a, 12 + a.
      for (let a = 0; a < 3; a++) for (let c = 0; c < 4; c++) packed[o + a * 4 + c] = inverse[c * 4 + a];
      words[o + 12] = bottom.node;
      words[o + 13] = bottom.tri;
      words[o + 14] = bottom.vertex;
      words[o + 15] = side;
      packed.set(material.color, o + 16);
      packed[o + 19] = material.opacity;
      packed.set(material.emissive, o + 20);
      packed[o + 24] = material.metalness;
      packed[o + 25] = material.roughness;
    });
    this.device.queue.writeBuffer(this.instances, 0, packed as BufferSource);
  }

  // One uniform per distinct trace, never rewritten, so traces encoded together keep their own settings; owned by the
  // scene and freed with it. An evicted one is left to the collector, since a pending encoder may still use it.
  #trace(count: number, any: number, width: number): GPUBuffer {
    const key = `${count},${any},${width}`;
    let buffer = this.#traces.get(key);
    if (!buffer) {
      if (this.#traces.size >= PARAM_CACHE) this.#traces.delete(this.#traces.keys().next().value as string);
      buffer = this.device.createBuffer({
        label: 'bvh scene trace',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buffer, 0, new Uint32Array([count, any, width, 0]));
      this.#traces.set(key, buffer);
    }
    return buffer;
  }

  #index(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count)
      throw new RangeError(`Invalid instance ${index}; pass 0 to ${this.count - 1}.`);
  }

  #live(): void {
    if (this.#disposed) throw new MargoError('disposed', 'GPUSceneBVH is disposed; create a new one to trace rays.');
  }
}
