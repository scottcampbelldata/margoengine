// Bone-texture GPU instancing: bone poses are baked per clip frame into a texture and each crowd member skins itself in
// the vertex shader, so one draw holds any number of characters and each can blend two clips, which a vertex animation
// texture cannot do. Drawing, lighting and shadows are VATCrowd's; only the pose sampling and the instance row differ.
import { multiplyMatrices, invertMatrixStable } from '@margoengine/math/mat4';
import type { EngineKernel } from '@margoengine/core';
import type { Animation } from './index.js';
import {
  VAT_WIDTH,
  VATCrowd,
  type CrowdLayout,
  type VATBakeOptions,
  type VATClip,
  type VATCrowdOptions,
  type VATInstance,
} from './vat.js';

/** Baked bones: per row and bone three rgba32float texels (the rows of its matrix), wrapped at `width`. */
export interface BoneBake {
  /** Bones in a row: every joint of every skin used, then one per unskinned part. */
  bones: number;
  rows: number;
  width: number;
  texels: Float32Array;
  vertexCount: number;
  /** Bind-pose position and normal per vertex (6 floats). */
  vertices: Float32Array;
  /** Eight bone indices per vertex. */
  joints: Uint32Array;
  /** Eight weights per vertex, summing to 1. */
  weights: Float32Array;
  indices: Uint32Array;
  /** UV0 with v up, like `@margoengine/materials` textures. */
  uvs: Float32Array;
  clips: VATClip[];
}

/** Floats per instance: the 24 of a VAT instance (slot 19 is the blend weight), then blend clip, offset, speed, 0. */
export const SKINNED_CROWD_STRIDE = 28;

/** Texel (x, y) of a baked row's bone: k 0, 1, 2 are its matrix rows. The shader computes the same. */
export function boneTexel(row: number, bone: number, k: number, bones: number, width = VAT_WIDTH): [number, number] {
  const i = (row * bones + bone) * 3 + k;
  return [i % width, Math.floor(i / width)];
}

/**
 * Bakes clips of a glTF `Animation` on the CPU into one bone texture, all primitives merged in the model root's space.
 * Morph targets stay at the weights they have now, unanimated. The animation's clip, time and playing state are
 * restored afterwards.
 */
export function bakeBones(animation: Animation, { fps = 30, clips }: VATBakeOptions = {}): BoneBake {
  const model = animation.model,
    doc = model.asset.doc,
    asset = model.asset,
    store = model.root.engine.store;
  const ids = (clips ?? animation.clips.map((_, i) => i)).map((c) =>
    typeof c === 'string' ? animation.clips.findIndex((x) => x.name === c) : c,
  );
  if (!(fps > 0 && fps <= 1000) || !ids.length || ids.some((i) => !animation.clips[i]))
    throw new RangeError(
      'Invalid bone bake fps or clips; pass fps in (0, 1000] and clip indices that exist in animation.clips',
    );
  // A bone row: the node it follows and its inverse bind (none for an unskinned part, which follows its own node).
  const bones: { node: number; bind?: Float32Array; part?: (typeof model.primitives)[number] }[] = [],
    skinBase = new Map<number, number>(),
    vertexCount = model.primitives.reduce((n, p) => n + p.vertices.length / 20, 0),
    vertices = new Float32Array(vertexCount * 6),
    joints = new Uint32Array(vertexCount * 8),
    weights = new Float32Array(vertexCount * 8),
    uvs = new Float32Array(vertexCount * 2),
    indices: number[] = [];
  let base = 0;
  for (const p of model.primitives) {
    const def = p.definition,
      count = p.vertices.length / 20,
      skinId = doc.nodes![p.nodeIndex].skin,
      skin = skinId === undefined ? undefined : doc.skins![skinId],
      v = p.vertices,
      deltas = (def.targets ?? []).map((t: Record<string, number>) =>
        [t.POSITION, t.NORMAL].map((a) => (a === undefined ? null : asset.accessor(a, 'VEC3'))),
      );
    let first = skinId === undefined ? undefined : skinBase.get(skinId);
    if (first === undefined) {
      first = bones.length;
      if (skin) {
        skinBase.set(skinId!, first);
        const bind =
          skin.inverseBindMatrices === undefined ? undefined : asset.accessor(skin.inverseBindMatrices, 'MAT4');
        skin.joints.forEach((node, i) => bones.push({ node, bind: bind?.subarray(i * 16, i * 16 + 16) }));
      } else bones.push({ node: p.nodeIndex, part: p });
    }
    const sets = skin
      ? [
          [def.attributes!.JOINTS_0, def.attributes!.WEIGHTS_0],
          [def.attributes!.JOINTS_1, def.attributes!.WEIGHTS_1],
        ]
          .filter(([j, w]) => j !== undefined && w !== undefined)
          .map(([j, w]) => [asset.accessor(j, 'VEC4'), asset.accessor(w, 'VEC4')])
      : [];
    for (let i = 0; i < count; i++) {
      const at = base + i;
      let px = v[i * 20],
        py = v[i * 20 + 1],
        pz = v[i * 20 + 2],
        nx = v[i * 20 + 4],
        ny = v[i * 20 + 5],
        nz = v[i * 20 + 6];
      deltas.forEach(([dp, dn]: (Float32Array | null)[], t: number) => {
        const w = p.weights[t];
        if (dp) {
          px += dp[i * 3] * w;
          py += dp[i * 3 + 1] * w;
          pz += dp[i * 3 + 2] * w;
        }
        if (dn) {
          nx += dn[i * 3] * w;
          ny += dn[i * 3 + 1] * w;
          nz += dn[i * 3 + 2] * w;
        }
      });
      vertices.set([px, py, pz, nx, ny, nz], at * 6);
      uvs[at * 2] = v[i * 20 + 12];
      uvs[at * 2 + 1] = 1 - v[i * 20 + 13];
      if (!skin) {
        joints[at * 8] = first;
        weights[at * 8] = 1;
        continue;
      }
      let sum = 0;
      for (const [, w] of sets) for (let c = 0; c < 4; c++) sum += w[i * 4 + c];
      if (!(sum > 0)) throw new RangeError('Skin weights must have a positive sum; give every vertex a joint');
      sets.forEach(([j, w], s) => {
        for (let c = 0; c < 4; c++) {
          joints[at * 8 + s * 4 + c] = first! + j[i * 4 + c];
          weights[at * 8 + s * 4 + c] = w[i * 4 + c] / sum;
        }
      });
    }
    for (const i of p.indices) indices.push(base + i);
    base += count;
  }
  const frames = ids.map((i) => Math.max(1, Math.ceil(animation.clips[i].duration * fps))),
    rows = frames.reduce((n, f) => n + f + 1, 0),
    height = Math.ceil((rows * bones.length * 3) / VAT_WIDTH);
  if (height > 8192)
    throw new RangeError('Bone data exceeds 8192 texture rows; bake fewer clips, a lower fps or fewer bones');
  const saved = { clip: animation.clip, time: animation.time, playing: animation.playing },
    texels = new Float32Array(VAT_WIDTH * height * 4),
    root = new Float32Array(16),
    joint = new Float32Array(16),
    matrix = new Float32Array(16),
    work = new Float64Array(52);
  let row = 0;
  try {
    ids.forEach((clip, c) => {
      const duration = animation.clips[clip].duration;
      animation.play(clip);
      for (let r = 0; r <= frames[c]; r++, row++) {
        animation.seek((duration * r) / frames[c]);
        store.tick(false);
        if (!invertMatrixStable(model.root.matrix, root, work))
          throw new RangeError('Singular model root; give the model root a non-zero scale before baking');
        bones.forEach(({ node, bind, part }, b) => {
          const world = part ? part.node.matrix : model.nodes[node].matrix;
          if (bind) multiplyMatrices(world, bind, joint);
          else joint.set(world);
          multiplyMatrices(root, joint, matrix);
          const o = (row * bones.length + b) * 12;
          for (let k = 0; k < 3; k++)
            for (let e = 0; e < 4; e++) {
              const value = matrix[e * 4 + k];
              if (!Number.isFinite(value))
                throw new RangeError('Bone bake produced non-finite matrices; use finite joints and inverse binds');
              texels[o + k * 4 + e] = value;
            }
        });
      }
    });
  } finally {
    animation.play(saved.clip);
    animation.seek(saved.time);
    animation.playing = saved.playing;
    store.tick(false);
  }
  let start = 0;
  return {
    bones: bones.length,
    rows,
    width: VAT_WIDTH,
    texels,
    vertexCount,
    vertices,
    joints,
    weights,
    indices: Uint32Array.from(indices),
    uvs,
    clips: ids.map((i, c) => {
      const clip = {
        name: animation.clips[i].name,
        start,
        frames: frames[c],
        duration: animation.clips[i].duration,
        loop: animation.options.loop ?? true,
      };
      start += frames[c] + 1;
      return clip;
    }),
  };
}

/** The bindings, pose sampling and vertex stage a {@link SkinnedCrowd} draws with. Exposed for tooling and tests. */
export const skinnedCrowdVertex = /* wgsl */ `
struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,base:vec4f,options:vec4f,vat:vec4f}
struct Instance {m:mat4x4f,p:vec4f,uv:vec4f,q:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
@group(0) @binding(2) var<storage,read> clips:array<vec4f>;
@group(0) @binding(3) var vat:texture_2d<f32>;
@group(0) @binding(4) var map:texture_2d<f32>;
@group(0) @binding(5) var mapSampler:sampler;
struct Out {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) uv:vec2f}
struct SkinPhase {row:u32,w:f32}
struct SkinnedVertex {position:vec3f,normal:vec3f}
fn skinPhase(c:vec4f,time:f32)->SkinPhase {
 var t=time/max(c.z,0.000001);t=select(clamp(t,0.0,1.0),fract(t),c.w>0.5);let x=t*c.y;let a=min(floor(x),c.y-1.0);
 return SkinPhase(u32(c.x+a),x-a);
}
fn boneTexel(row:u32,bone:u32,k:u32)->vec4f {let i=(row*u32(f.vat.x)+bone)*3u+k;let w=u32(f.vat.y);return textureLoad(vat,vec2u(i%w,i/w),0);}
fn bonePose(a:SkinPhase,bone:u32,k:u32)->vec4f {return mix(boneTexel(a.row,bone,k),boneTexel(a.row+1u,bone,k),a.w);}
fn skinned(s:Instance,position:vec3f,normal:vec3f,j0:vec4u,j1:vec4u,w0:vec4f,w1:vec4f)->SkinnedVertex {
 let a=skinPhase(clips[u32(s.p.x)],f.options.x*s.p.z+s.p.y);let b=skinPhase(clips[u32(s.q.x)],f.options.x*s.q.z+s.q.y);let blend=s.p.w;
 var r0=vec4f(0.0);var r1=vec4f(0.0);var r2=vec4f(0.0);
 for(var i=0u;i<8u;i++) {
  let w=select(w1[i&3u],w0[i&3u],i<4u);
  if(w>0.0) {
   let j=select(j1[i&3u],j0[i&3u],i<4u);
   var x=bonePose(a,j,0u);var y=bonePose(a,j,1u);var z=bonePose(a,j,2u);
   if(blend>0.0) {x=mix(x,bonePose(b,j,0u),blend);y=mix(y,bonePose(b,j,1u),blend);z=mix(z,bonePose(b,j,2u),blend);}
   r0+=x*w;r1+=y*w;r2+=z*w;
  }
 }
 let p=vec4f(position,1.0);let c0=cross(r1.xyz,r2.xyz);
 return SkinnedVertex(vec3f(dot(r0,p),dot(r1,p),dot(r2,p)),vec3f(dot(c0,normal),dot(cross(r2.xyz,r0.xyz),normal),dot(cross(r0.xyz,r1.xyz),normal))*sign(dot(r0.xyz,c0)));
}
@vertex fn vertex(@location(0) uv:vec2f,@location(1) position:vec3f,@location(2) normal:vec3f,@location(3) j0:vec4u,@location(4) j1:vec4u,@location(5) w0:vec4f,@location(6) w1:vec4f,@builtin(instance_index) id:u32)->Out {
 let s=instances[id];let k=skinned(s,position,normal,j0,j1,w0,w1);
 let m=s.m;let c0=cross(m[1].xyz,m[2].xyz);let world=m*vec4f(k.position,1.0);
 var o:Out;o.clip=f.camera*world;o.position=world.xyz;o.normal=mat3x3f(c0,cross(m[2].xyz,m[0].xyz),cross(m[0].xyz,m[1].xyz))*k.normal*sign(dot(m[0].xyz,c0));o.uv=s.uv.xy+uv*s.uv.zw;return o;
}
`;

const layout = (bake: BoneBake): CrowdLayout => ({
  vertex: skinnedCrowdVertex,
  stride: SKINNED_CROWD_STRIDE,
  rowSize: bake.bones,
  vertices: [bake.vertices, bake.joints, bake.weights],
  attributes: [
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 1, offset: 0, format: 'float32x3' },
        { shaderLocation: 2, offset: 12, format: 'float32x3' },
      ],
    },
    {
      arrayStride: 32,
      attributes: [
        { shaderLocation: 3, offset: 0, format: 'uint32x4' },
        { shaderLocation: 4, offset: 16, format: 'uint32x4' },
      ],
    },
    {
      arrayStride: 32,
      attributes: [
        { shaderLocation: 5, offset: 0, format: 'float32x4' },
        { shaderLocation: 6, offset: 16, format: 'float32x4' },
      ],
    },
  ],
});

/** One crowd member for {@link SkinnedCrowd.add} and {@link SkinnedCrowd.set}. */
export interface SkinnedCrowdInstance extends VATInstance {
  /** The second clip, an index into `bake.clips`. Default 0. */
  blendClip?: number;
  /** Time offset into the second clip in seconds. Default 0. */
  blendOffset?: number;
  /** Playback speed of the second clip. Default 1. */
  blendSpeed?: number;
  /** How much of the second clip shows, 0 to 1. Default 0. */
  blend?: number;
}

/**
 * Draws any number of copies of a {@link bakeBones} bake in one instanced call, skinned in the vertex shader. Each
 * instance has its own matrix, two clips with their own offsets and speeds, a blend between them and an atlas region,
 * and the CPU does no per-instance work per frame. Everything else is as `VATCrowd`: opaque, no CPU culling,
 * `shadows.add(crowd)`, `lighting.add(crowd)`.
 */
export class SkinnedCrowd extends VATCrowd {
  /** Same as `engine.use(new SkinnedCrowd(...))`; returns the crowd. */
  static override attach(engine: EngineKernel, bake: BoneBake, options?: VATCrowdOptions): SkinnedCrowd {
    const value = new SkinnedCrowd(bake, options);
    engine.use(value);
    return value;
  }
  constructor(
    readonly bake: BoneBake,
    options?: VATCrowdOptions,
  ) {
    if (!(bake?.vertices instanceof Float32Array) || !(bake.bones > 0))
      throw new TypeError('Invalid skinned crowd; pass the result of bakeBones');
    super(bake, options, layout(bake));
  }
  override add(instance: SkinnedCrowdInstance = {}): number {
    return super.add(instance);
  }
  /** Changes the given fields of one instance. */
  override set(index: number, instance: SkinnedCrowdInstance): this {
    const { blendClip, blendOffset, blendSpeed, blend } = instance;
    if (
      (blendClip !== undefined && !(Number.isInteger(blendClip) && blendClip >= 0 && blendClip < this.bake.clips.length)) ||
      (blendOffset !== undefined && !Number.isFinite(blendOffset)) ||
      (blendSpeed !== undefined && !Number.isFinite(blendSpeed)) ||
      (blend !== undefined && !(blend >= 0 && blend <= 1))
    )
      throw new RangeError(
        'Invalid crowd blend; use a blendClip from bake.clips, a finite blendOffset and blendSpeed, and a blend in 0..1',
      );
    super.set(index, instance);
    const o = index * SKINNED_CROWD_STRIDE,
      d = this.rows;
    if (blend !== undefined) d[o + 19] = blend;
    if (blendClip !== undefined) d[o + 24] = blendClip;
    if (blendOffset !== undefined) d[o + 25] = blendOffset;
    if (blendSpeed !== undefined) d[o + 26] = blendSpeed;
    return this;
  }
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function phase(clip: VATClip, time: number): [number, number] {
  let t = time / Math.max(clip.duration, 1e-6);
  t = clip.loop ? t - Math.floor(t) : Math.min(1, Math.max(0, t));
  const x = t * clip.frames,
    a = Math.min(Math.floor(x), clip.frames - 1);
  return [clip.start + a, x - a];
}

/**
 * Where a member's vertices are at `time` (the crowd's clock), in the model root's space before its matrix, as
 * `[x, y, z]` triples: the CPU twin of the shader, for checks, picking and bounds.
 */
export function poseBones(
  bake: BoneBake,
  { clip = 0, offset = 0, speed = 1, blendClip = 0, blendOffset = 0, blendSpeed = 1, blend = 0 }: SkinnedCrowdInstance,
  time: number,
  out = new Float32Array(bake.vertexCount * 3),
): Float32Array {
  if (!bake.clips[clip] || !bake.clips[blendClip] || out.length < bake.vertexCount * 3)
    throw new RangeError('Invalid pose; use clips from bake.clips and an output of 3 floats per vertex');
  const a = phase(bake.clips[clip], time * speed + offset),
    b = phase(bake.clips[blendClip], time * blendSpeed + blendOffset),
    read = (row: number, bone: number, k: number, e: number) => {
      const [x, y] = boneTexel(row, bone, k, bake.bones, bake.width);
      return bake.texels[(y * bake.width + x) * 4 + e];
    },
    at = (p: [number, number], bone: number, k: number, e: number) =>
      mix(read(p[0], bone, k, e), read(p[0] + 1, bone, k, e), p[1]);
  for (let v = 0; v < bake.vertexCount; v++) {
    const [x, y, z] = bake.vertices.subarray(v * 6, v * 6 + 3);
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (let i = 0; i < 8; i++) {
        const w = bake.weights[v * 8 + i];
        if (!w) continue;
        const j = bake.joints[v * 8 + i],
          e = (n: number) => mix(at(a, j, k, n), at(b, j, k, n), blend);
        sum += w * (e(0) * x + e(1) * y + e(2) * z + e(3));
      }
      out[v * 3 + k] = sum;
    }
  }
  return out;
}
