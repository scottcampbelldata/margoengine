/// <reference lib="esnext.disposable" preserve="true" />
// 2D skeletal animation: a bone hierarchy, meshes skinned to it by linear blend skinning (each vertex the weighted sum
// of its bones' current-from-bind transforms; J. P. Lewis, M. Cordner and N. Fong, "Pose Space Deformation", SIGGRAPH
// 2000, section 2.3.2, skeleton subspace deformation), keyframe clips, and a layer
// that draws the skinned triangles from an atlas with exact texels. Skinning runs on the CPU, so it also runs in Node.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { atlasTexture } from '../../shared/atlas-texture.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { applyView, checkLayers, ViewStates } from '../../shared/view-rect.js';
import type { SpriteAtlas } from './index.js';
import { parseTint, type SpriteCamera } from './sprite.js';
export { solveChainIK, solveTwoBoneIK, type IKOptions2D, type IKResult2D } from './skeletal-ik.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; VERTEX: number; INDEX: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type SkeletalPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** A bone's place relative to its parent: y down, `rotation` clockwise in radians, as on a sprite. */
export interface BoneOptions {
  name: string;
  /** The parent bone's name; none for a root. */
  parent?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  /** Length along local +x, used by IK. Default 0. */
  length?: number;
}

/** One bone. Change `x`, `y`, `rotation`, `scaleX` and `scaleY` freely; {@link Skeleton2D.update} reads them. */
export class Bone {
  readonly name: string;
  readonly parent: Bone | null;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Length along local +x. Default 0. */
  length: number;
  /** World transform `[a, b, c, d, tx, ty]` after the last update: a point (x, y) maps to (a x + c y + tx, b x + d y + ty). */
  readonly world = new Float64Array([1, 0, 0, 1, 0, 0]);
  /** @internal */
  readonly setup: [number, number, number, number, number];

  constructor(options: BoneOptions, parent: Bone | null) {
    this.name = options.name;
    this.parent = parent;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.rotation = options.rotation ?? 0;
    this.scaleX = options.scaleX ?? 1;
    this.scaleY = options.scaleY ?? 1;
    this.length = options.length ?? 0;
    if (!Number.isFinite(this.length) || this.length < 0) throw rangeError('Invalid bone length', 'sprite-options');
    this.setup = [this.x, this.y, this.rotation, this.scaleX, this.scaleY];
  }
}

/** A bone hierarchy. Bones are kept with every parent before its children. */
export class Skeleton2D {
  readonly bones: readonly Bone[];
  private readonly byName = new Map<string, Bone>();
  private readonly slotList: SkeletonSlot[] = [];
  private drawList: SkeletonSlot[] = [];

  /** Slots in setup order. */
  get slots(): readonly SkeletonSlot[] {
    return this.slotList;
  }
  /** Slots in the current animated draw order. */
  get drawOrder(): readonly SkeletonSlot[] {
    return this.drawList;
  }
  /** Adds a named slot with immutable named mesh attachments. */
  addSlot(options: SkeletonSlotOptions): SkeletonSlot {
    if (this.slotList.some((s) => s.name === options.name))
      throw rangeError('Duplicate skeleton slot', 'sprite-options');
    const slot = new SkeletonSlot(this, options);
    this.slotList.push(slot);
    this.drawList = [...this.slotList];
    return slot;
  }
  /** Looks up a slot by name. */
  slot(name: string): SkeletonSlot | undefined {
    return this.slotList.find((s) => s.name === name);
  }
  /** A complete permutation of slot names, drawn back to front. */
  setDrawOrder(names: readonly string[]): void {
    if (
      names.length !== this.slotList.length ||
      new Set(names).size !== names.length ||
      names.some((n) => !this.slot(n))
    )
      throw rangeError('Draw order must name every slot exactly once', 'sprite-options');
    this.drawList = names.map((n) => this.slot(n)!);
  }

  /** @throws TypeError / RangeError for a missing or repeated name, an unknown parent, a cycle or a non-finite value. */
  constructor(bones: readonly BoneOptions[]) {
    if (!Array.isArray(bones) || !bones.length) throw typeError('Skeleton2D needs bones', 'sprite-options');
    const pending = new Map<string, BoneOptions>();
    for (const b of bones) {
      if (!b || typeof b.name !== 'string' || !b.name || pending.has(b.name))
        throw typeError('Each bone needs its own name', 'sprite-options');
      pending.set(b.name, b);
    }
    const list: Bone[] = [];
    while (pending.size) {
      let placed = false;
      for (const [name, b] of pending) {
        if (b.parent !== undefined && !pending.has(b.parent) && !this.byName.has(b.parent))
          throw rangeError(`Bone ${name} has an unknown parent`, 'sprite-options');
        if (b.parent !== undefined && !this.byName.has(b.parent)) continue;
        const bone = new Bone(b, b.parent === undefined ? null : this.byName.get(b.parent)!);
        this.byName.set(name, bone);
        list.push(bone);
        pending.delete(name);
        placed = true;
      }
      if (!placed) throw rangeError('Bones form a cycle', 'sprite-options');
    }
    this.bones = list;
    this.update();
  }
  /** The bone named `name`, or undefined. */
  bone(name: string): Bone | undefined {
    return this.byName.get(name);
  }
  /** Puts every bone back to the place it was made with. */
  resetPose(): void {
    for (const b of this.bones) [b.x, b.y, b.rotation, b.scaleX, b.scaleY] = b.setup;
  }
  /** Computes every bone's `world` from its local values, parents first. */
  update(): void {
    for (const b of this.bones) {
      if (!Number.isFinite(b.x + b.y + b.rotation + b.scaleX + b.scaleY))
        throw rangeError(`Invalid bone ${b.name}`, 'sprite-options');
      const cos = Math.cos(b.rotation),
        sin = Math.sin(b.rotation),
        a = cos * b.scaleX,
        bb = sin * b.scaleX,
        c = -sin * b.scaleY,
        d = cos * b.scaleY,
        w = b.world;
      if (!b.parent) w.set([a, bb, c, d, b.x, b.y]);
      else {
        const p = b.parent.world;
        w[0] = p[0] * a + p[2] * bb;
        w[1] = p[1] * a + p[3] * bb;
        w[2] = p[0] * c + p[2] * d;
        w[3] = p[1] * c + p[3] * d;
        w[4] = p[0] * b.x + p[2] * b.y + p[4];
        w[5] = p[1] * b.x + p[3] * b.y + p[5];
      }
    }
  }
}

/** Named mesh attachments sharing one bone and one draw-order position. */
export interface SkeletonSlotOptions {
  name: string;
  bone: string;
  attachments: Readonly<Record<string, SkinnedMesh>>;
  /** Setup attachment, or null for no image. Default null. */
  attachment?: string | null;
}

/** One visible attachment at a time. Use meshes weighted to the slot's bone for rigid images. */
export class SkeletonSlot {
  readonly name: string;
  readonly bone: Bone;
  readonly attachments: ReadonlyMap<string, SkinnedMesh>;
  readonly setupAttachment: string | null;
  private selected: string | null = null;
  constructor(skeleton: Skeleton2D, options: SkeletonSlotOptions) {
    const bone = skeleton.bone(options.bone);
    if (!options.name || !bone) throw rangeError('Slot needs a name and an existing bone', 'sprite-options');
    this.name = options.name;
    this.bone = bone;
    this.attachments = new Map(Object.entries(options.attachments));
    for (const mesh of this.attachments.values())
      if (!(mesh instanceof SkinnedMesh) || mesh.skeleton !== skeleton)
        throw rangeError('Slot attachments must use its skeleton', 'sprite-options');
    this.setupAttachment = options.attachment ?? null;
    this.setAttachment(this.setupAttachment);
  }
  /** Selected attachment name, null for an empty slot. */
  get attachment(): string | null {
    return this.selected;
  }
  /** Selected mesh, or undefined for an empty slot. */
  get mesh(): SkinnedMesh | undefined {
    return this.selected === null ? undefined : this.attachments.get(this.selected);
  }
  /** Swaps attachments without changing draw order. */
  setAttachment(name: string | null): void {
    if (name !== null && !this.attachments.has(name)) throw rangeError('Unknown slot attachment', 'sprite-options');
    this.selected = name;
  }
}

const invert = (m: Float64Array): Float64Array => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(det) > 1e-12)) throw rangeError('A bone is scaled to zero at bind time', 'sprite-options');
  const a = m[3] / det,
    b = -m[1] / det,
    c = -m[2] / det,
    d = m[0] / det;
  return new Float64Array([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]);
};

/** A mesh of {@link SkinnedMesh}: bind-pose positions in skeleton units, atlas texels and triangles. */
export interface SkinOptions {
  /** The skeleton to follow. Its pose when the mesh is made is the bind pose. */
  skeleton: Skeleton2D;
  /** Bind-pose positions, x and y per vertex, in skeleton units (y down). */
  positions: ArrayLike<number>;
  /** Atlas texel coordinates, u and v per vertex (not normalized). */
  uvs: ArrayLike<number>;
  /** Triangles, three vertex indices each. */
  indices: ArrayLike<number>;
  /** Four bone indices (into `skeleton.bones`) per vertex. */
  joints: ArrayLike<number>;
  /** Four weights per vertex, at least one above 0; each vertex's weights are scaled to sum to 1. */
  weights: ArrayLike<number>;
}

/**
 * A mesh bent by a {@link Skeleton2D} with linear blend skinning. Place it with `x`, `y`, `z`, colour it with `tint`
 * and `alpha`, and draw it with a {@link SkeletalLayer}.
 */
export class SkinnedMesh {
  readonly skeleton: Skeleton2D;
  readonly vertexCount: number;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** World offset of the skeleton's origin. Default 0. */
  x = 0;
  /** World offset of the skeleton's origin, y down. Default 0. */
  y = 0;
  /** Draw order: a higher z draws over a lower one. Default 0. */
  z = 0;
  /** Opacity, 0 to 1. Default 1. */
  alpha = 1;
  /** False leaves it out of the draw. Default true. */
  visible = true;
  /** @internal */
  index = 0;
  /** @internal */
  owner?: object;
  private readonly bind: Float32Array;
  private readonly joints: Uint32Array;
  private readonly weights: Float32Array;
  private readonly inverse: Float64Array[];
  private readonly skin = new Float64Array(0);
  private color = 0xffffff;

  /** @throws TypeError / RangeError for arrays of the wrong length, an index or joint out of range or bad weights. */
  constructor(options: SkinOptions) {
    const { skeleton, positions, uvs, indices, joints, weights } = options ?? ({} as SkinOptions);
    if (!(skeleton instanceof Skeleton2D)) throw typeError('SkinnedMesh needs a Skeleton2D', 'sprite-options');
    const n = positions?.length / 2;
    if (!Number.isInteger(n) || n < 3 || uvs?.length !== n * 2 || joints?.length !== n * 4 || weights?.length !== n * 4)
      throw rangeError('SkinnedMesh arrays differ in vertex count', 'sprite-options');
    if (!indices?.length || indices.length % 3) throw rangeError('SkinnedMesh needs whole triangles', 'sprite-options');
    this.skeleton = skeleton;
    this.vertexCount = n;
    this.bind = Float32Array.from(positions);
    this.uvs = Float32Array.from(uvs);
    this.indices = Uint32Array.from(indices);
    this.joints = Uint32Array.from(joints);
    this.weights = Float32Array.from(weights);
    if (!this.bind.every(Number.isFinite) || !this.uvs.every(Number.isFinite))
      throw rangeError('SkinnedMesh has a non-finite position or uv', 'sprite-options');
    for (let k = 0; k < indices.length; k++)
      if (!Number.isInteger(indices[k]) || indices[k] < 0 || indices[k] >= n)
        throw rangeError('SkinnedMesh index out of range', 'sprite-options');
    for (let v = 0; v < n; v++) {
      let maximum = 0;
      for (let k = 0; k < 4; k++) {
        const j = joints[v * 4 + k],
          w = weights[v * 4 + k];
        if (!Number.isInteger(j) || j < 0 || j >= skeleton.bones.length)
          throw rangeError('SkinnedMesh joint out of range', 'sprite-options');
        if (!Number.isFinite(w) || !(w >= 0))
          throw rangeError('SkinnedMesh weight below 0 or non-finite', 'sprite-options');
        maximum = Math.max(maximum, w);
      }
      if (!(maximum > 0)) throw rangeError('SkinnedMesh vertex has no weight', 'sprite-options');
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += weights[v * 4 + k] / maximum;
      for (let k = 0; k < 4; k++) this.weights[v * 4 + k] = weights[v * 4 + k] / maximum / sum;
    }
    skeleton.update();
    this.inverse = skeleton.bones.map((b) => invert(b.world));
    this.skin = new Float64Array(n * 2);
  }
  /** Colour multiplied with the atlas: set `0xrrggbb`, `'#rrggbb'` or `'#rgb'`, read `0xrrggbb`. Default white. */
  get tint(): number {
    return this.color;
  }
  set tint(value: number | string) {
    this.color = parseTint(value);
  }
  /**
   * The skinned positions, x and y per vertex in skeleton units, from the bones' `world` as of the last
   * `skeleton.update()`: each vertex is the weighted sum of `world * inverse(bind world) * position` over its bones.
   */
  deform(): Float64Array {
    const bones = this.skeleton.bones,
      out = this.skin;
    for (let v = 0; v < this.vertexCount; v++) {
      const px = this.bind[v * 2],
        py = this.bind[v * 2 + 1];
      let x = 0,
        y = 0;
      for (let k = 0; k < 4; k++) {
        const w = this.weights[v * 4 + k];
        if (!w) continue;
        const j = this.joints[v * 4 + k],
          inv = this.inverse[j],
          m = bones[j].world,
          bx = inv[0] * px + inv[2] * py + inv[4],
          by = inv[1] * px + inv[3] * py + inv[5];
        x += w * (m[0] * bx + m[2] * by + m[4]);
        y += w * (m[1] * bx + m[3] * by + m[5]);
      }
      out[v * 2] = x;
      out[v * 2 + 1] = y;
    }
    return out;
  }
}

/**
 * A `columns` x `rows` grid over the atlas rectangle `rect` (`[x, y, width, height]` texels), laid out from (`x`, `y`)
 * in skeleton units at `scale` units per texel: positions, uvs and indices for a {@link SkinnedMesh}.
 */
export function gridMesh(
  rect: readonly [number, number, number, number],
  columns: number,
  rows: number,
  { x = 0, y = 0, scale = 1 }: { x?: number; y?: number; scale?: number } = {},
): { positions: Float32Array; uvs: Float32Array; indices: Uint32Array } {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1)
    throw rangeError('Invalid grid size', 'sprite-options');
  const positions = new Float32Array((columns + 1) * (rows + 1) * 2),
    uvs = new Float32Array(positions.length),
    indices = new Uint32Array(columns * rows * 6);
  for (let j = 0, at = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++, at += 2) {
      const u = rect[0] + (rect[2] * i) / columns,
        v = rect[1] + (rect[3] * j) / rows;
      uvs[at] = u;
      uvs[at + 1] = v;
      positions[at] = x + (u - rect[0]) * scale;
      positions[at + 1] = y + (v - rect[1]) * scale;
    }
  for (let j = 0, at = 0; j < rows; j++)
    for (let i = 0; i < columns; i++, at += 6) {
      const a = j * (columns + 1) + i,
        b = a + 1,
        c = a + columns + 1,
        d = c + 1;
      indices.set([a, b, c, b, d, c], at);
    }
  return { positions, uvs, indices };
}

/** Keys of one bone channel: `[time in seconds, value]` pairs, times increasing. Plain `number[][]` literals fit. */
export type BoneKeys = readonly (readonly number[])[];
/** Cubic Bezier controls (x1/y1/x2/y2), a held segment, or linear interpolation. */
export type BoneCurve = readonly [number, number, number, number] | 'linear' | 'stepped';
/** A clip: per bone name, keys for any of `x`, `y`, `rotation`, `scaleX`, `scaleY` (local values, as on {@link Bone}). */
export interface SkeletonClip {
  duration: number;
  bones: Readonly<Record<string, Partial<Record<'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY', BoneKeys>>>>;
  /** One curve per key interval. Omitted channels are linear. */
  curves?: Readonly<
    Record<string, Partial<Record<'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY', readonly BoneCurve[]>>>
  >;
  /** Discrete attachment keys. Before the first key the setup attachment is used. */
  slots?: Readonly<Record<string, readonly { time: number; attachment: string | null }[]>>;
  /** Discrete complete slot permutations. Before the first key setup order is used. */
  drawOrder?: readonly { time: number; slots: readonly string[] }[];
}

const TAU = Math.PI * 2;
const ease = (f: number, curve: BoneCurve = 'linear'): number => {
  if (curve === 'linear') return f;
  if (curve === 'stepped') return f < 1 ? 0 : 1;
  const [x1, y1, x2, y2] = curve;
  const cubic = (t: number, a: number, b: number) =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 48; i++) {
    const m = (lo + hi) / 2;
    if (cubic(m, x1, x2) < f) lo = m;
    else hi = m;
  }
  return cubic((lo + hi) / 2, y1, y2);
};
const sample = (keys: BoneKeys, time: number, angle: boolean, curves?: readonly BoneCurve[]): number => {
  if (time <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (time > t1) continue;
    const [t0, v0] = keys[i - 1],
      f = t1 > t0 ? (time - t0) / (t1 - t0) : 1;
    // Rotations take the shorter way round.
    const delta = angle ? ((((v1 - v0) % TAU) + TAU + Math.PI) % TAU) - Math.PI : v1 - v0;
    return v0 + delta * ease(f, curves?.[i - 1]);
  }
  return keys[keys.length - 1][1];
};

/**
 * Poses `skeleton` from `clip` at `time` seconds (wrapped into the clip with `loop`, default true; held at the ends
 * otherwise), keys linearly interpolated and rotations the short way round, then updates it. Channels without keys
 * keep their values.
 * @throws RangeError for a non-positive duration, an unknown bone or keys not in time order.
 */
export function poseSkeleton(skeleton: Skeleton2D, clip: SkeletonClip, time: number, loop = true): void {
  if (!(clip?.duration > 0) || !Number.isFinite(clip.duration) || !Number.isFinite(time))
    throw rangeError('Invalid skeleton clip', 'sprite-options');
  const t = loop
    ? ((time % clip.duration) + clip.duration) % clip.duration
    : Math.min(Math.max(time, 0), clip.duration);
  for (const [name, channels] of Object.entries(clip.bones)) {
    const bone = skeleton.bone(name);
    if (!bone) throw rangeError(`Clip names unknown bone ${name}`, 'sprite-options');
    for (const [channel, keys] of Object.entries(channels) as [keyof typeof channels, BoneKeys][]) {
      if (
        !keys?.length ||
        keys.some((k, i) => k?.length !== 2 || !Number.isFinite(k[0] + k[1]) || (i && k[0] < keys[i - 1][0]))
      )
        throw rangeError(`Invalid keys for ${name}.${channel}`, 'sprite-options');
      const curves = clip.curves?.[name]?.[channel];
      if (
        curves &&
        (curves.length !== keys.length - 1 ||
          curves.some(
            (c) =>
              c !== 'linear' &&
              c !== 'stepped' &&
              (!Array.isArray(c) ||
                c.length !== 4 ||
                !c.every(Number.isFinite) ||
                c[0] < 0 ||
                c[0] > 1 ||
                c[2] < 0 ||
                c[2] > 1),
          ))
      )
        throw rangeError('Invalid skeleton Bezier curves', 'sprite-options');
      bone[channel] = sample(keys, t, channel === 'rotation', curves);
    }
  }
  for (const [name, keys] of Object.entries(clip.slots ?? {})) {
    const slot = skeleton.slot(name);
    if (!slot) throw rangeError('Clip names unknown slot', 'sprite-options');
    if (
      keys.some(
        (k, i) =>
          !Number.isFinite(k.time) ||
          k.time < 0 ||
          (i > 0 && k.time < keys[i - 1].time) ||
          (k.attachment !== null && !slot.attachments.has(k.attachment)),
      )
    )
      throw rangeError('Invalid slot attachment keys', 'sprite-options');
    let selected = slot.setupAttachment;
    for (const k of keys) if (k.time <= t) selected = k.attachment;
    slot.setAttachment(selected);
  }
  if (clip.drawOrder) {
    if (
      clip.drawOrder.some(
        (k, i) =>
          !Number.isFinite(k.time) ||
          k.time < 0 ||
          (i > 0 && k.time < clip.drawOrder![i - 1].time) ||
          k.slots.length !== skeleton.slots.length ||
          new Set(k.slots).size !== k.slots.length ||
          k.slots.some((n) => !skeleton.slot(n)),
      )
    )
      throw rangeError('Invalid slot draw-order keys', 'sprite-options');
    let order = skeleton.slots.map((s) => s.name);
    for (const key of clip.drawOrder) if (key.time <= t) order = [...key.slots];
    skeleton.setDrawOrder(order);
  }
  skeleton.update();
}

/** Settings of {@link SkeletalLayer}. */
export interface SkeletalLayerOptions {
  /** The texels meshes map, read with no filtering. Required. */
  atlas: SpriteAtlas;
  /** World units to pixels, read each frame. Default `{x: 0, y: 0, zoom: 1}`. */
  camera?: SpriteCamera;
  /** Frame-graph order. Default 10, as a `SpriteLayer`. */
  order?: number;
  /** Render-layer bits. Default 1. */
  layers?: number;
  /** Plugin name, unique per scene. Default `skeletal-1`, ... */
  name?: string;
}

const shader = /* wgsl */ `
@group(0) @binding(0) var<uniform> size:vec4f;
@group(0) @binding(1) var atlas:texture_2d<f32>;
struct Varying{@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) @interpolate(flat) tint:vec4f}
@vertex fn vertexMain(@location(0) p:vec2f,@location(1) uv:vec2f,@location(2) tint:vec4f)->Varying{
  var v:Varying;
  v.position=vec4f(p/size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);
  v.uv=uv;
  v.tint=tint;
  return v;
}
@fragment fn fragmentMain(v:Varying)->@location(0) vec4f{
  let t=vec2i(clamp(floor(v.uv),vec2f(0),vec2f(textureDimensions(atlas))-1));
  let c=textureLoad(atlas,t,0)*v.tint;
  if(c.a==0){discard;}
  return c;
}`;

interface ViewState {
  uniform: GPUBuffer;
  values: Float32Array<ArrayBuffer>;
  group?: GPUBindGroup;
  generation: number;
}
let layerCount = 0;

/**
 * Draws {@link SkinnedMesh}es in one indexed draw, skinned on the CPU each frame, in z then add order, with exact texels
 * on a single-sample target, like a `SpriteLayer`. WebGPU only.
 * @throws MargoError `'unsupported'` on WebGL, `'disposed'` after `dispose()`, `'attached'` for a mesh in another layer.
 */
export class SkeletalLayer implements EnginePlugin {
  readonly name: string;
  /** World units to pixels, read each frame. */
  camera: SpriteCamera;
  private readonly order: number;
  private readonly layerMask: number;
  private atlas: SpriteAtlas;
  private stale = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private texture?: { texture: GPUTexture; owned: boolean };
  private layout?: GPUBindGroupLayout;
  private module?: GPUShaderModule;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private vertices?: GPUBuffer;
  private indexBuffer?: GPUBuffer;
  private vertexData = new ArrayBuffer(0);
  private indexData = new Uint32Array(0);
  private list: SkinnedMesh[] = [];
  private added = 0;
  private readonly rigs = new Map<Skeleton2D, number>();
  private readonly rigMeshes = new Set<SkinnedMesh>();
  private generation = 0;
  private disposed = false;
  private readonly states = new ViewStates<ViewState>(
    () => ({
      uniform: this.device!.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      values: new Float32Array(4),
      generation: -1,
    }),
    (state) => state.uniform.destroy(),
  );

  constructor(options: SkeletalLayerOptions) {
    if (!options?.atlas) throw typeError('SkeletalLayer needs an atlas', 'sprite-options');
    const order = options.order ?? 10;
    if (!Number.isFinite(order)) throw rangeError('Invalid skeletal order', 'sprite-options');
    this.atlas = options.atlas;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.order = order;
    this.layerMask = checkLayers(options.layers ?? 1, 'SkeletalLayer layers');
    this.name = options.name ?? `skeletal-${++layerCount}`;
  }
  /** Creates a layer and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: SkeletalLayerOptions): SkeletalLayer {
    const layer = new SkeletalLayer(options);
    engineRuntime(instance).use(layer);
    return layer;
  }
  /** The meshes in add order. */
  get meshes(): readonly SkinnedMesh[] {
    return this.list;
  }
  /** Adds a mesh and returns it. */
  add(mesh: SkinnedMesh): SkinnedMesh {
    if (this.disposed) throw fault('disposed', 'SkeletalLayer disposed', 'disposed');
    if (!(mesh instanceof SkinnedMesh)) throw typeError('SkeletalLayer draws SkinnedMesh', 'sprite-options');
    if (mesh.owner) throw fault('attached', 'SkinnedMesh already in a layer', 'sprite-state');
    mesh.owner = this;
    mesh.index = this.added++;
    this.list.push(mesh);
    return mesh;
  }
  /** Draws active slot attachments, following attachment and draw-order keys each frame. */
  addSkeleton(skeleton: Skeleton2D): Skeleton2D {
    if (this.disposed) throw fault('disposed', 'SkeletalLayer disposed', 'disposed');
    if (this.rigs.has(skeleton)) throw fault('attached', 'Skeleton already in layer', 'sprite-state');
    this.claimSkeleton(skeleton);
    this.rigs.set(skeleton, this.added++);
    return skeleton;
  }
  /** Removes the skeleton and releases all its slot attachments. */
  removeSkeleton(skeleton: Skeleton2D): boolean {
    if (!this.rigs.delete(skeleton)) return false;
    for (const mesh of this.rigMeshes)
      if (mesh.skeleton === skeleton) {
        mesh.owner = undefined;
        this.rigMeshes.delete(mesh);
      }
    return true;
  }
  private claimSkeleton(skeleton: Skeleton2D): void {
    const meshes = skeleton.slots.flatMap((s) => [...new Set(s.attachments.values())]);
    if (new Set(meshes).size !== meshes.length || meshes.some((m) => m.owner && !this.rigMeshes.has(m)))
      throw fault('attached', 'Slot mesh already attached; use a separate mesh for each slot', 'sprite-state');
    for (const mesh of meshes) {
      mesh.owner = this;
      this.rigMeshes.add(mesh);
    }
  }
  /** Takes a mesh out; false when it is not in this layer. */
  remove(mesh: SkinnedMesh): boolean {
    if (mesh.owner !== this) return false;
    mesh.owner = undefined;
    this.list.splice(this.list.indexOf(mesh), 1);
    return true;
  }
  setup(engine: Engine): void {
    if (this.disposed || engine.backend !== 'webgpu')
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed ? 'SkeletalLayer disposed' : 'SkeletalLayer needs WebGPU',
        this.disposed ? 'disposed' : 'webgpu',
      );
    this.engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) this.states.prune();
  }
  onDeviceRestored(): void {
    // A caller's plain GPUTexture went with the device; bytes, bitmaps and functions come back by themselves.
    this.stale = !!this.texture && typeof this.atlas !== 'function' && 'createView' in this.atlas;
    this.release();
  }
  /** Replaces the atlas; mesh texels are read from it next frame. */
  setAtlas(atlas: SpriteAtlas): void {
    if (!atlas) throw typeError('SkeletalLayer needs an atlas', 'sprite-options');
    if (this.texture?.owned) this.texture.texture.destroy();
    this.texture = undefined;
    this.atlas = atlas;
    this.stale = false;
    this.generation++;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    for (const mesh of this.list) mesh.owner = undefined;
    this.list.length = 0;
    for (const mesh of this.rigMeshes) mesh.owner = undefined;
    this.rigMeshes.clear();
    this.rigs.clear();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private release(): void {
    this.states.clear();
    if (this.texture?.owned) this.texture.texture.destroy();
    this.vertices?.destroy();
    this.indexBuffer?.destroy();
    this.texture = this.vertices = this.indexBuffer = this.layout = this.module = this.device = undefined;
    this.pipelines.clear();
    this.generation++;
  }
  /** Skins every visible mesh into one vertex list; returns the index count. */
  private build(device: GPUDevice): number {
    const records = this.list.map((mesh) => ({ mesh, index: mesh.index, slot: 0 }));
    for (const [skeleton, index] of this.rigs) {
      this.claimSkeleton(skeleton);
      skeleton.update();
      skeleton.drawOrder.forEach((s, slot) => {
        if (s.mesh) records.push({ mesh: s.mesh, index, slot });
      });
    }
    const meshes = records
      .filter((r) => r.mesh.visible)
      .sort((a, b) => a.mesh.z - b.mesh.z || a.index - b.index || a.slot - b.slot)
      .map((r) => r.mesh);
    let vertices = 0,
      indices = 0;
    for (const m of meshes) {
      vertices += m.vertexCount;
      indices += m.indices.length;
    }
    if (vertices * 20 > this.vertexData.byteLength) {
      this.vertexData = new ArrayBuffer(Math.max(vertices * 20, this.vertexData.byteLength * 2));
      this.vertices?.destroy();
      this.vertices = undefined;
    }
    if (indices > this.indexData.length) {
      this.indexData = new Uint32Array(Math.max(indices, this.indexData.length * 2));
      this.indexBuffer?.destroy();
      this.indexBuffer = undefined;
    }
    const floats = new Float32Array(this.vertexData),
      bits = new Uint32Array(this.vertexData),
      { x: cx, y: cy, zoom } = this.camera;
    if (!(zoom > 0) || !Number.isFinite(zoom + cx + cy)) throw rangeError('Invalid skeletal camera', 'sprite-options');
    let v = 0,
      i = 0;
    for (const m of meshes) {
      if (!Number.isFinite(m.x + m.y + m.z) || !(m.alpha >= 0 && m.alpha <= 1))
        throw rangeError('Invalid skinned mesh', 'sprite-options');
      const skin = m.deform(),
        t = m.tint,
        tint = ((t >> 16) | (t & 0xff00) | ((t & 0xff) << 16) | (Math.round(m.alpha * 255) << 24)) >>> 0;
      for (let k = 0; k < m.vertexCount; k++) {
        const at = (v + k) * 5;
        floats[at] = (skin[k * 2] + m.x - cx) * zoom;
        floats[at + 1] = (skin[k * 2 + 1] + m.y - cy) * zoom;
        floats[at + 2] = m.uvs[k * 2];
        floats[at + 3] = m.uvs[k * 2 + 1];
        bits[at + 4] = tint;
      }
      for (const index of m.indices) this.indexData[i++] = index + v;
      v += m.vertexCount;
    }
    if (!i) return 0;
    this.vertices ??= device.createBuffer({
      label: 'skeletal vertices',
      size: this.vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.indexBuffer ??= device.createBuffer({
      label: 'skeletal indices',
      size: this.indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertices, 0, this.vertexData, 0, v * 20);
    device.queue.writeBuffer(this.indexBuffer, 0, this.indexData, 0, i);
    return i;
  }
  private draw(c: SkeletalPassContext): void {
    const view = c.view;
    if (view?.layers !== undefined && !(view.layers & this.layerMask)) return;
    const device = c.device;
    if (this.device !== device) {
      if (this.device) this.release();
      this.device = device;
    }
    if (this.stale) throw fault('state', 'Skeletal atlas lost with the device; call setAtlas', 'sprite-state');
    this.texture ??= atlasTexture(device, this.atlas, () => rangeError('Invalid sprite pixels', 'sprite-options'));
    if (!this.layout) {
      this.layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        ],
      });
      this.module = device.createShaderModule({ label: 'skeletal', code: shader });
    }
    // Several views of a frame skin once: the first builds, later ones reuse its buffers.
    const count = view?.index ? this.lastCount : (this.lastCount = this.build(device));
    const samples = c.descriptor.multisample?.count ?? 1,
      key = `${c.format}/${samples}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: 'skeletal',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: {
          module: this.module!,
          entryPoint: 'vertexMain',
          buffers: [
            {
              arrayStride: 20,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x2' },
                { shaderLocation: 2, offset: 16, format: 'unorm8x4' },
              ],
            },
          ],
        },
        fragment: {
          module: this.module!,
          entryPoint: 'fragmentMain',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        multisample: { count: samples },
      });
      this.pipelines.set(key, pipeline);
    }
    const state = this.states.get(c),
      width = view ? view.viewport[2] : c.width,
      height = view ? view.viewport[3] : c.height;
    if (state.values[0] !== width || state.values[1] !== height) {
      state.values[0] = width;
      state.values[1] = height;
      device.queue.writeBuffer(state.uniform, 0, state.values);
    }
    if (state.generation !== this.generation) {
      state.generation = this.generation;
      state.group = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: state.uniform } },
          { binding: 1, resource: this.texture.texture.createView() },
        ],
      });
    }
    const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
    applyView(pass, c);
    if (count) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, state.group!);
      pass.setVertexBuffer(0, this.vertices!);
      pass.setIndexBuffer(this.indexBuffer!, 'uint32');
      pass.drawIndexed(count);
    }
    pass.end();
  }
  private lastCount = 0;
}
