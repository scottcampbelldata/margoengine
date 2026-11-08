import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension, VFXSkinned, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };

/** Most triangles of a skinned emitter (16 bytes each on the GPU, beside the 80-byte vertices). */
export const MAX_SKINNED_TRIANGLES = 262_144;
/** Floats a vertex in a deformer's output (gltf-pro's layout), position first. */
const STRIDE = 20;

const origin =
  'let origin=f.emitterTime.xyz+(vec3f(random(seed+5u),random(seed+6u),random(seed+7u))*2-1)*f.emissionExtent.xyz;';
const velocity = 'f.velocitySpread.xyz+(vec3f(random(seed+1u),random(seed+2u),random(seed+3u))*2-1)*f.velocitySpread.w';

/**
 * One storage buffer (the simulation may already use eight with events, fields and the rest): triangles first, four
 * words each (the three vertex indices and the running bind-pose area share as float bits), then the posed vertices,
 * 20 words each, copied from the deformer's output every frame.
 */
const declarations = /* wgsl */ `
struct Skinned {m:mat4x4f,a:vec4f,count:vec4u}
@group(0) @binding(22) var<uniform> sk:Skinned;
@group(0) @binding(23) var<storage,read> skin:array<u32>;
fn skinVertex(i:u32)->vec3f {let b=sk.count.y+i*${STRIDE}u;return (sk.m*vec4f(bitcast<f32>(skin[b]),bitcast<f32>(skin[b+1u]),bitcast<f32>(skin[b+2u]),1)).xyz;}
`;

/**
 * A triangle chosen by its bind-pose area (binary search of the running share), a uniform point of its posed corners
 * (Osada et al., Shape Distributions, 2002), placed by `transform`; the posed face normal is the direction `speed`
 * scales. A triangle the pose collapsed has no normal: those births get none.
 */
const birth = /* wgsl */ `
  let share=random(seed+8u);var lo=0u;var hi=sk.count.x-1u;
  loop{if(lo>=hi){break;}let mid=(lo+hi)/2u;if(bitcast<f32>(skin[mid*4u+3u])<share){lo=mid+1u;}else{hi=mid;}}
  let ta=skinVertex(skin[lo*4u]);let tb=skinVertex(skin[lo*4u+1u]);let tc=skinVertex(skin[lo*4u+2u]);
  let r1=sqrt(random(seed+9u));let r2=random(seed+10u);
  origin+=ta*(1.0-r1)+tb*(r1*(1.0-r2))+tc*(r1*r2);
  let face=cross(tb-ta,tc-ta);let shapeDir=select(vec3f(0),face*inverseSqrt(max(dot(face,face),1e-30)),dot(face,face)>1e-24);`;

function once(code: string, from: string, to: string): string {
  if (code.split(from).length !== 2)
    throw new MargoError('unsupported', 'VFX skinned needs the simulation shader it was written for; update the edits');
  return code.replace(from, to);
}

/** The triangle words: indices and running area share of the bind pose; zero-area triangles left out. */
export function skinnedTriangles(vertices: Float32Array, indices: ArrayLike<number>): Uint32Array {
  const kept: number[] = [],
    areas: number[] = [];
  const at = (i: number) => [0, 1, 2].map((c) => vertices[i * STRIDE + c]);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = at(indices[t]),
      b = at(indices[t + 1]),
      c = at(indices[t + 2]),
      u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
      area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (area > 0) kept.push(t), areas.push(area);
  }
  if (!kept.length)
    throw new RangeError('VFX skinned primitive has no triangle with an area in its bind pose; pass a real surface');
  const total = areas.reduce((s, x) => s + x, 0),
    out = new Uint32Array(kept.length * 4),
    share = new Float32Array(out.buffer);
  let run = 0;
  kept.forEach((t, k) => {
    run += areas[k];
    out.set([indices[t], indices[t + 1], indices[t + 2]], k * 4);
    share[k * 4 + 3] = k === kept.length - 1 ? 1 : run / total;
  });
  return out;
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * The `skinned` feature: births on the surface of an animated (skinned or morphed) primitive, following its pose.
 * Pass it as `{skinned}` to `VFX` from `@margoengine/vfx/base`; the root `VFX` has it. The primitive's triangles and
 * bind pose are read at attach; its `deformed` buffer and offset, `transform` and `speed` every frame.
 */
export const skinned: VFXExtension<VFXSkinned> = {
  validate(s, o) {
    if (!s || typeof s !== 'object' || !s.primitive || typeof s.primitive !== 'object')
      throw new TypeError(
        'VFX skinned needs {primitive}: an entry of a loaded model.primitives with a deformer attached',
      );
    if (o.emitter) throw new TypeError('VFX skinned and emitter both place births; use one of them');
    const { vertices, indices } = s.primitive;
    if (!(vertices instanceof Float32Array) || vertices.length < STRIDE * 3 || vertices.length % STRIDE)
      throw new TypeError(
        'VFX skinned primitive.vertices must be a Float32Array of 20 floats a vertex (gltf-pro layout)',
      );
    if (!indices || typeof indices.length !== 'number' || indices.length < 3 || indices.length % 3)
      throw new TypeError('VFX skinned primitive.indices must be triangle triples');
    if (indices.length / 3 > MAX_SKINNED_TRIANGLES)
      throw new RangeError(
        `VFX skinned primitive has more than ${MAX_SKINNED_TRIANGLES} triangles; pass a simpler mesh`,
      );
    const count = vertices.length / STRIDE;
    for (let i = 0; i < indices.length; i++)
      if (!(indices[i] >= 0 && indices[i] < count && Number.isInteger(indices[i])))
        throw new RangeError('VFX skinned primitive index points past its vertices; check the index buffer');
    const t = s.transform ?? identity;
    if (t.length !== 16 || !Array.from(t).every(Number.isFinite))
      throw new TypeError('VFX skinned transform must be 16 finite numbers, a column-major matrix');
    const speed = s.speed ?? 0;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < -1000 || speed > 1000)
      throw new RangeError('VFX skinned speed must be -1000 to 1000 world units a second; pass e.g. 1');
    skinnedTriangles(vertices, indices);
  },
  simulation(code) {
    code = once(code, 'fn update(', declarations + 'fn update(');
    // `transform` alone places the mesh: the emitter's `position` (default [0, 1, 0]) is not added.
    code = once(code, origin, 'var origin=' + origin.slice('let origin=f.emitterTime.xyz+'.length) + birth);
    return once(
      code,
      velocity,
      'f.velocitySpread.xyz+shapeDir*sk.a.x+(' + velocity.slice('f.velocitySpread.xyz+('.length),
    );
  },
  create(state: VFXState, s, owned) {
    const { device, options } = state,
      { primitive } = s,
      triangles = skinnedTriangles(primitive.vertices, primitive.indices),
      head = triangles.byteLength,
      bytes = primitive.vertices.byteLength,
      uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      storage = device.createBuffer({ size: head + bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    owned.push(uniform, storage);
    // The bind pose until a deformer writes: births before the first copy start on the rest pose.
    device.queue.writeBuffer(storage, 0, triangles as Uint32Array<ArrayBuffer>);
    device.queue.writeBuffer(storage, head, primitive.vertices as Float32Array<ArrayBuffer>);
    const values = new Float32Array(24),
      ints = new Uint32Array(values.buffer);
    return {
      compute: [
        { binding: 22, resource: { buffer: uniform } },
        { binding: 23, resource: { buffer: storage } },
      ],
      write(c) {
        const now = options.skinned;
        if (!now || now.primitive !== primitive)
          throw new TypeError('VFX skinned primitive is fixed at attach; change transform and speed in place');
        // This frame's pose as the deformer last wrote it (a deformer recorded later in the frame shows next frame).
        if (primitive.deformed)
          c.encoder.copyBufferToBuffer(primitive.deformed, primitive.deformedOffset ?? 0, storage, head, bytes);
        values.set(now.transform ?? identity, 0);
        values.fill(0, 16);
        values[16] = now.speed ?? 0;
        ints[20] = triangles.length / 4;
        ints[21] = head / 4;
        c.device.queue.writeBuffer(uniform, 0, values as Float32Array<ArrayBuffer>);
      },
    };
  },
};
