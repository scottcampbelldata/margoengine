// Pieces the gpu and gpu-scene entries share: the tree's GPU node order, its positions, the device lookup and the
// watertight ray/triangle WGSL of Woop, Benthin and Wald (JCGT 2013), written from the paper.
import { MargoError } from '@margoengine/math/errors';
import { INTERNAL_FLAG, NODE_WORDS } from './build.js';
import type { MeshBVH } from './bvh.js';

/** Deepest tree the WGSL stack walks. Every built tree fits: `maxDepth` stops at 64. */
export const GPU_MAX_DEPTH = 64;
/** A device, or anything that has one in `gpu`, such as an `Engine` on WebGPU. */
export type GPUTarget = GPUDevice | { readonly gpu: GPUDevice | null };

export const deviceOf = (target: GPUTarget): GPUDevice => {
  const device = (target as { gpu?: GPUDevice | null })?.gpu ?? (target as GPUDevice);
  if (!device || typeof device.createBuffer !== 'function')
    throw new MargoError('unsupported', 'GPU BVH needs WebGPU; pass a GPUDevice or an Engine running on WebGPU.');
  return device;
};

/** The tree in its GPU order: lo xyz, left child or first triangle, hi xyz, right child | flag or triangle count. */
export function packNodes(bvh: MeshBVH): ArrayBuffer {
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

export function packPositions(bvh: MeshBVH): Float32Array {
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

/** The ray struct, reciprocal, edge and triangle functions, named with prefix `p` and struct prefix `R`. */
export const triangleWGSL = (p: string, R: string): string => `
struct ${R}Ray { origin: vec3f, direction: vec3f, inverse: vec3f, shear: vec3f, axes: vec3u, near: f32, far: f32 }
fn ${p}Inverse(d: f32) -> f32 {
  // WGSL may assume no infinities, so a zero axis gets a huge finite reciprocal rather than 1 / 0.
  let m = max(abs(d), 1e-18);
  return select(1.0 / m, -1.0 / m, d < 0.0);
}
// Edge function p x q of two sheared vertices. A shared edge must give two triangles exactly opposite values, or a ray
// through it can miss both. WGSL lets a compile fuse and reassociate (15.7.5), and Metal fuses p.x*q.y - p.y*q.x into one
// fma, which is not antisymmetric; so both sides evaluate the edge with its ends in one fixed order and negate.
fn ${p}Edge(p: vec2f, q: vec2f) -> f32 {
  let swap = q.x < p.x || (q.x == p.x && q.y < p.y);
  let s = select(p, q, swap);
  let e = select(q, p, swap);
  let value = s.x * e.y - s.y * e.x;
  return select(value, -value, swap);
}
// Weights and distance in xyzw, w < 0 for a miss.
fn ${p}Triangle(r: ${R}Ray, a3: vec3f, b3: vec3f, c3: vec3f, side: u32, far: f32) -> vec4f {
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
  let u = ${p}Edge(vec2f(cx, cy), vec2f(bx, by));
  let v = ${p}Edge(vec2f(ax, ay), vec2f(cx, cy));
  let w = ${p}Edge(vec2f(bx, by), vec2f(ax, ay));
  let det = u + v + w;
  let positive = u >= 0.0 && v >= 0.0 && w >= 0.0;
  let negative = u <= 0.0 && v <= 0.0 && w <= 0.0;
  if (det == 0.0 || !(positive || negative)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  if ((side == 1u && det < 0.0) || (side == 2u && det > 0.0)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let t = (u * az + v * bz + w * cz) * r.shear.z / det;
  if (t < r.near || t > far) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  return vec4f(u / det, v / det, w / det, t);
}
`;
