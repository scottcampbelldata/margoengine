/// <reference lib="esnext.disposable" preserve="true" />
import type { PBRModel, PBRDeformationContext } from '@margoengine/gltf-pro';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { Mat4, MutableVec3, Quat, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { composeMatrix, invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { normalizeQuaternion } from '@margoengine/math/quat';
import { deformationShader } from './shader.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; COPY_DST: number; COPY_SRC: number; UNIFORM: number };

/** A bone's transform local to its parent bone; omitted parts keep their value (or the default, for a new bone). */
export interface BonePose {
  /** Default [0, 0, 0]. */
  translation?: Vec3;
  /** Unit quaternion [x, y, z, w], normalised on input. Default [0, 0, 0, 1]. */
  rotation?: Quat;
  /** Default [1, 1, 1]. */
  scale?: Vec3;
}
/** One bone of a {@link Skeleton}. Its translation, rotation and scale are the base (bind) pose. */
export interface BoneData extends BonePose {
  /** Stable id that keyframe tracks target; unique in the skeleton. */
  name: string;
  /** Index of the parent bone, or -1 for the one root bone. */
  parent: number;
}

/** @internal Checks `width` finite numbers (TypeError for the shape, RangeError for the values). */
export function finite(value: unknown, width: number, label: string): ArrayLike<number> {
  const v = value as ArrayLike<number> | undefined;
  if (!v || typeof v !== 'object' || v.length !== width)
    throw new TypeError(`${label} needs ${width} numbers; pass an array of length ${width}`);
  for (let i = 0; i < width; i++)
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i]))
      throw new RangeError(`${label} has a non-finite value; pass finite numbers`);
  return v;
}
const rotation = new Float64Array(4); // normalizeQuaternion scratch (typed, like the samples it sits beside)
// True for `width` finite numbers; the checks of `finite`, without building its message.
function valid(value: unknown, width: number): value is ArrayLike<number> {
  const v = value as ArrayLike<number> | undefined;
  if (!v || typeof v !== 'object' || v.length !== width) return false;
  for (let i = 0; i < width; i++) if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return false;
  return true;
}
// Each bone keeps 10 numbers per pose: translation 0-2, rotation 3-6, scale 7-9. Validates all before writing any. The
// label ("Skeleton bone <bone>") is built only for an error: setPose runs per bone per frame.
function writePose(target: Float64Array, at: number, pose: BonePose, bone: number): void {
  const t = pose.translation,
    s = pose.scale,
    q = pose.rotation;
  if (t !== undefined && !valid(t, 3)) finite(t, 3, `Skeleton bone ${bone} translation`);
  if (s !== undefined && !valid(s, 3)) finite(s, 3, `Skeleton bone ${bone} scale`);
  if (q !== undefined && !valid(q, 4)) finite(q, 4, `Skeleton bone ${bone} rotation`);
  if (q && !(q[0] || q[1] || q[2] || q[3]))
    throw new RangeError(`Skeleton bone ${bone} rotation is a zero quaternion; pass a unit quaternion`);
  if (t) target.set(t, at);
  if (s) target.set(s, at + 7);
  // Also normalizes finite quaternions whose length overflows or underflows.
  if (q) target.set(normalizeQuaternion(q, rotation), at + 3);
}

/**
 * A bone hierarchy authored from raw data: a base (bind) pose, a current pose set bone by bone, and the matrices a
 * {@link Skin} deforms with. Matrices are in skeleton space, the local space of the skinned mesh the bones live under;
 * they are recomputed lazily after a pose change. Bone length and thickness are display concerns and not stored.
 */
export class Skeleton {
  /** Bone names in input order; a bone's index is its position here. */
  readonly names: readonly string[];
  /** Parent bone index per bone, -1 for the root. */
  readonly parents: readonly number[];
  /** Index of the root bone; vertices whose weights sum to zero follow it. */
  readonly root: number;
  /** Increments on every pose or bind-pose change, so consumers can skip unchanged uploads. */
  revision = 0;
  private readonly pose: Float64Array;
  private readonly base: Float64Array;
  private readonly inverse: Float64Array;
  private readonly world: Float64Array;
  private readonly skin: Float64Array;
  private readonly order: number[] = [];
  private readonly byName: ReadonlyMap<string, number>;
  private readonly local = new Float64Array(16);
  private readonly workspace = new Float64Array(52);
  private dirty = true;
  /**
   * @param bones The hierarchy and base pose; exactly one bone has parent -1.
   * @param inverseBindMatrices Optional 16 column-major numbers per bone; computed from the base pose when omitted.
   */
  constructor(bones: readonly BoneData[], inverseBindMatrices?: ArrayLike<number>) {
    if (!Array.isArray(bones) || !bones.length)
      throw new TypeError('Skeleton bones must be a nonempty array; pass at least a root bone');
    const n = bones.length,
      names = bones.map((bone, i) => {
        if (!bone || typeof bone !== 'object') throw new TypeError(`Skeleton bone ${i} must be an object`);
        if (typeof bone.name !== 'string' || !bone.name)
          throw new TypeError(`Skeleton bone ${i} needs a nonempty string name`);
        return bone.name;
      });
    this.byName = new Map(names.map((name, i) => [name, i]));
    if (this.byName.size !== n) throw new TypeError('Skeleton bone names repeat; give every bone a unique name');
    const parents = bones.map(({ parent }, i) => {
      if (!Number.isInteger(parent) || parent < -1 || parent >= n || parent === i)
        throw new RangeError(`Skeleton bone ${i} parent ${parent} is invalid; use -1 or another bone's index`);
      return parent;
    });
    const roots = parents.filter((parent) => parent === -1).length;
    if (roots !== 1) throw new RangeError(`Skeleton has ${roots} root bones; give exactly one bone parent -1`);
    this.names = Object.freeze(names);
    this.parents = Object.freeze(parents);
    this.root = parents.indexOf(-1);
    // Parents before children; bones the root never reaches sit on a parent cycle.
    const children = parents.map(() => [] as number[]);
    parents.forEach((parent, i) => parent >= 0 && children[parent].push(i));
    for (let stack = [this.root]; stack.length; ) {
      const bone = stack.pop()!;
      this.order.push(bone);
      stack.push(...children[bone]);
    }
    if (this.order.length !== n)
      throw new RangeError('Skeleton bone parents form a cycle; every parent chain must end at the root');
    this.base = new Float64Array(n * 10);
    bones.forEach((bone, i) => {
      this.base.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1], i * 10);
      writePose(this.base, i * 10, bone, i);
    });
    this.pose = this.base.slice();
    this.world = new Float64Array(n * 16);
    this.skin = new Float64Array(n * 16);
    this.inverse = new Float64Array(n * 16);
    if (inverseBindMatrices === undefined) this.bind();
    else this.inverse.set(finite(inverseBindMatrices, n * 16, 'Skeleton inverse bind matrices'));
  }
  /** Number of bones. */
  get count(): number {
    return this.names.length;
  }
  /** Index of the bone with this name, or -1. */
  index(name: string): number {
    return this.byName.get(name) ?? -1;
  }
  private bone(bone: number): number {
    if (!Number.isInteger(bone) || bone < 0 || bone >= this.count)
      throw new RangeError(`Skeleton bone ${bone} does not exist; pass an index below ${this.count}`);
    return bone;
  }
  /** Sets any of a bone's local translation, rotation and scale in the current pose. */
  setPose(bone: number, pose: BonePose): this {
    writePose(this.pose, this.bone(bone) * 10, pose ?? {}, bone);
    return this.changed();
  }
  /** A copy of a bone's current local transform. */
  getPose(bone: number): { translation: MutableVec3; rotation: [number, number, number, number]; scale: MutableVec3 } {
    const p = this.pose,
      at = this.bone(bone) * 10;
    return {
      translation: [p[at], p[at + 1], p[at + 2]],
      rotation: [p[at + 3], p[at + 4], p[at + 5], p[at + 6]],
      scale: [p[at + 7], p[at + 8], p[at + 9]],
    };
  }
  /**
   * Returns bones to the base pose: every bone when `bone` is omitted, else that bone alone (Restore Pose) or, with
   * `nested`, that bone and all bones under it (Restore Pose All).
   */
  restorePose(bone?: number, nested = false): this {
    if (bone === undefined) this.pose.set(this.base);
    else {
      const marked = new Uint8Array(this.count);
      marked[this.bone(bone)] = 1;
      for (const i of this.order) {
        if (nested && this.parents[i] >= 0 && marked[this.parents[i]]) marked[i] = 1;
        if (marked[i]) this.pose.set(this.base.subarray(i * 10, i * 10 + 10), i * 10);
      }
    }
    return this.changed();
  }
  /** Makes the current pose the base pose and recomputes every inverse bind matrix from it (the mesh stays put). */
  setBindPose(): this {
    this.bind();
    this.base.set(this.pose);
    return this.changed();
  }
  private bind(): void {
    const world = this.matrices,
      inverse = this.inverse.slice();
    for (let i = 0; i < this.count; i++)
      if (
        !invertMatrixStable(world.subarray(i * 16, i * 16 + 16), inverse.subarray(i * 16, i * 16 + 16), this.workspace)
      )
        throw new RangeError(`Skeleton bone ${i} bind pose is singular; give it a non-zero scale`);
    this.inverse.set(inverse);
    this.dirty = true;
  }
  private changed(): this {
    this.dirty = true;
    this.revision++;
    return this;
  }
  private update(): void {
    if (!this.dirty) return;
    const { pose, world, local } = this;
    for (const i of this.order) {
      composeMatrix(
        pose.subarray(i * 10, i * 10 + 3),
        pose.subarray(i * 10 + 3, i * 10 + 7),
        pose.subarray(i * 10 + 7, i * 10 + 10),
        local,
      );
      const parent = this.parents[i],
        out = world.subarray(i * 16, i * 16 + 16);
      if (parent < 0) out.set(local);
      else multiplyMatrices(world.subarray(parent * 16, parent * 16 + 16), local, out);
      multiplyMatrices(out, this.inverse.subarray(i * 16, i * 16 + 16), this.skin.subarray(i * 16, i * 16 + 16));
    }
    this.dirty = false;
  }
  /** Each bone's current skeleton-space matrix, 16 column-major numbers per bone. Read-only; refreshed on access. */
  get matrices(): Float64Array {
    this.update();
    return this.world;
  }
  /** Inverse bind matrices, 16 column-major numbers per bone (for export). Read-only. */
  get inverseBindMatrices(): Float64Array {
    return this.inverse;
  }
  /** `matrices` times `inverseBindMatrices` per bone: what moves a bind-pose vertex. Read-only; refreshed on access. */
  get skinMatrices(): Float64Array {
    this.update();
    return this.skin;
  }
  /** `parent` (e.g. the skinned mesh's `primitives[0].node.matrix`) times the bone's matrix: its world matrix. */
  worldMatrix(bone: number, parent?: Mat4, out = new Float32Array(16)): Float32Array {
    const at = this.bone(bone) * 16,
      matrix = this.matrices.subarray(at, at + 16);
    if (parent === undefined) out.set(matrix);
    else multiplyMatrices(finite(parent, 16, 'Skeleton parent matrix'), matrix, out);
    return out;
  }
}

const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();
let serial = 0;
/**
 * Up to four bone influences per vertex over a {@link Skeleton}, deforming a `createMesh` mesh (or any gltf-pro model
 * whose primitives share one vertex array) on the GPU once attached. Weights are normalised to sum 1 as they are set;
 * a vertex whose weights sum to zero follows the root bone.
 */
export class Skin implements EnginePlugin {
  readonly name = 'skin:' + serial++;
  /** Vertex count. */
  readonly count: number;
  /** The mesh it deforms, when made by `Skin.attach`. */
  mesh?: PBRModel;
  // The GPU influence layout: per vertex 4 Uint32 bone indices, then 4 Float32 weights.
  private readonly ids: Uint32Array<ArrayBuffer>;
  private readonly weights: Float32Array<ArrayBuffer>;
  private dirtyFrom = 0;
  private dirtyTo: number;
  private uploaded = -1;
  private disposed = false;
  private gpu?: {
    buffers: GPUBuffer[];
    source: GPUBuffer;
    output: GPUBuffer;
    bones: GPUBuffer;
    influences: GPUBuffer;
    group: GPUBindGroup;
    pipeline: GPUComputePipeline;
    vertices: Float32Array;
    palette: Float32Array<ArrayBuffer>;
  };
  private unsubscribe?: () => void;
  private readonly prepare = (context: PBRDeformationContext) => this.deform(context);
  /** @param joints Four bone indices per vertex. @param weights Four weights per vertex, each finite and >= 0. */
  constructor(
    readonly skeleton: Skeleton,
    joints: ArrayLike<number>,
    weights: ArrayLike<number>,
  ) {
    if (!(skeleton instanceof Skeleton)) throw new TypeError('Skin needs a Skeleton; pass new Skeleton(bones)');
    const count = joints?.length / 4;
    if (!Number.isInteger(count) || count < 1)
      throw new RangeError('Skin joints need four bone indices per vertex for at least one vertex');
    this.count = this.dirtyTo = count;
    const data = new ArrayBuffer(count * 32);
    this.ids = new Uint32Array(data);
    this.weights = new Float32Array(data);
    this.setInfluences(0, joints, weights);
  }
  /**
   * Replaces the influences of vertices `first` onward (four joints and four weights each), for weight painting. Costs
   * O(changed vertices) here; the next frame uploads 32 bytes per vertex from the lowest to the highest changed one.
   */
  setInfluences(first: number, joints: ArrayLike<number>, weights: ArrayLike<number>): this {
    const n = joints?.length / 4,
      bones = this.skeleton.count;
    if (!Number.isInteger(first) || first < 0 || !Number.isInteger(n) || first + n > this.count)
      throw new RangeError(
        `Skin influences for vertices ${first}+ exceed the ${this.count} vertices; pass 4 joints each`,
      );
    if (weights?.length !== joints.length)
      throw new RangeError('Skin weights need one weight per joint index; pass 4 weights per vertex');
    for (let i = 0; i < joints.length; i++) {
      const id = joints[i],
        w = weights[i];
      if (!Number.isInteger(id) || id < 0 || id >= bones)
        throw new RangeError(`Skin joint ${id} at vertex ${first + (i >> 2)} is not a bone; use 0 to ${bones - 1}`);
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0)
        throw new RangeError(`Skin weight ${w} at vertex ${first + (i >> 2)} is invalid; use a finite number >= 0`);
    }
    for (let v = 0; v < n; v++) {
      const at = (first + v) * 8,
        sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
      for (let c = 0; c < 4; c++) {
        this.ids[at + c] = sum > 0 ? joints[v * 4 + c] : this.skeleton.root;
        this.weights[at + 4 + c] = sum > 0 ? weights[v * 4 + c] / sum : +(c === 0);
      }
    }
    this.dirtyFrom = Math.min(this.dirtyFrom, first);
    this.dirtyTo = Math.max(this.dirtyTo, first + n);
    return this;
  }
  /**
   * CPU skinning at the skeleton's current pose, with the GPU pass's maths: bind-pose `positions` (and `normals`), xyz
   * per vertex in skeleton space, to posed copies. For picking a posed mesh and for exporting a static pose.
   */
  pose(positions: ArrayLike<number>, normals?: ArrayLike<number>): { positions: Float32Array; normals?: Float32Array } {
    const p = finite(positions, this.count * 3, 'Skin positions'),
      n = normals === undefined ? undefined : finite(normals, this.count * 3, 'Skin normals'),
      matrices = this.skeleton.skinMatrices,
      m = new Float64Array(16),
      out = new Float32Array(this.count * 3),
      outNormals = n && new Float32Array(this.count * 3);
    for (let v = 0, i = 0; v < this.count; v++, i += 3) {
      m.fill(0);
      for (let c = 0; c < 4; c++) {
        const w = this.weights[v * 8 + 4 + c],
          at = this.ids[v * 8 + c] * 16;
        if (w) for (let k = 0; k < 16; k++) m[k] += w * matrices[at + k];
      }
      for (let r = 0; r < 3; r++) out[i + r] = m[r] * p[i] + m[4 + r] * p[i + 1] + m[8 + r] * p[i + 2] + m[12 + r];
      if (!n || !outNormals) continue;
      // Cofactor columns (determinant times the inverse transpose), flipped for a mirroring blend, as the shader does.
      const a = [m[5] * m[10] - m[6] * m[9], m[6] * m[8] - m[4] * m[10], m[4] * m[9] - m[5] * m[8]],
        b = [m[9] * m[2] - m[10] * m[1], m[10] * m[0] - m[8] * m[2], m[8] * m[1] - m[9] * m[0]],
        c = [m[1] * m[6] - m[2] * m[5], m[2] * m[4] - m[0] * m[6], m[0] * m[5] - m[1] * m[4]],
        sign = Math.sign(m[0] * a[0] + m[1] * a[1] + m[2] * a[2]),
        x = (a[0] * n[i] + b[0] * n[i + 1] + c[0] * n[i + 2]) * sign,
        y = (a[1] * n[i] + b[1] * n[i + 1] + c[1] * n[i + 2]) * sign,
        z = (a[2] * n[i] + b[2] * n[i + 1] + c[2] * n[i + 2]) * sign,
        length = Math.hypot(x, y, z) || 1;
      outNormals[i] = x / length;
      outNormals[i + 1] = y / length;
      outNormals[i + 2] = z / length;
    }
    return outNormals ? { positions: out, normals: outNormals } : { positions: out };
  }
  /**
   * A skin that deforms `mesh` on the GPU from now on, as a plugin of the mesh's engine. `mesh` is a `createMesh` mesh
   * (or any gltf-pro model whose primitives share one vertex array) with one vertex per four influences.
   */
  static attach(mesh: PBRModel, skeleton: Skeleton, joints: ArrayLike<number>, weights: ArrayLike<number>): Skin {
    const skin = new Skin(skeleton, joints, weights),
      vertices = mesh?.primitives?.[0]?.vertices;
    if (!vertices || mesh.primitives.some((p) => p.vertices !== vertices))
      throw new TypeError('Skin needs a mesh whose primitives share one vertex array; use createMesh');
    if (vertices.length / 20 !== skin.count)
      throw new RangeError(`Skin has ${skin.count} vertices but the mesh has ${vertices.length / 20}; match them`);
    if (mesh.disposed) throw new MargoError('disposed', 'Skin mesh is disposed; attach the skin to a live mesh');
    if (mesh.primitives.some((p) => p.deformed))
      throw new MargoError('attached', 'Mesh is already deformed by another plugin; dispose that one first');
    skin.mesh = mesh;
    mesh.root.engine.use(skin);
    return skin;
  }
  setup(engine: Engine): void {
    const mesh = this.mesh;
    if (!mesh || this.disposed)
      throw new MargoError(
        'state',
        'Skin is not attached; create it with Skin.attach(mesh, skeleton, joints, weights)',
      );
    if (mesh.disposed) throw new MargoError('disposed', 'Skin mesh is disposed; attach the skin to a live mesh');
    const device = engine.gpu;
    if (!device) throw new MargoError('unsupported', 'Skin needs WebGPU; create the engine with the webgpu backend');
    const pipeline =
      pipelines.get(device) ??
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: deformationShader }), entryPoint: 'main' },
      });
    pipelines.set(device, pipeline);
    const buffers: GPUBuffer[] = [],
      vertices = mesh.primitives[0].vertices,
      buffer = (size: number, usage = GPUBufferUsage.STORAGE) => {
        const b = device.createBuffer({ size: Math.max(16, size), usage: usage | GPUBufferUsage.COPY_DST });
        buffers.push(b);
        return b;
      };
    if (
      Math.max(vertices.byteLength, this.count * 32, this.skeleton.count * 64) >
      Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)
    )
      throw new RangeError('Skin buffers exceed the device storage limit; use fewer vertices or bones');
    this.unsubscribe ??= mesh.onDispose(() => this.dispose());
    const source = buffer(vertices.byteLength),
      output = buffer(vertices.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC),
      bones = buffer(this.skeleton.count * 64),
      influences = buffer(this.count * 32),
      counts = buffer(16, GPUBufferUsage.UNIFORM);
    // No morph targets: binding 2 and 3 hold placeholders the shader never reads.
    const entries = [source, output, buffer(48), buffer(16), bones, influences, counts];
    device.queue.writeBuffer(counts, 0, new Uint32Array([this.count, 0, this.skeleton.count, 0]));
    this.gpu = {
      buffers,
      source,
      output,
      bones,
      influences,
      pipeline,
      vertices: undefined!,
      palette: new Float32Array(this.skeleton.count * 16),
      group: device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map((buffer, binding) => ({ binding, resource: { buffer } })),
      }),
    };
    this.uploaded = -1;
    this.dirtyFrom = 0;
    this.dirtyTo = this.count;
    for (const p of mesh.primitives) p.deformed = output;
    mesh.prepareDeformation = this.prepare;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: -10, execute: (c) => this.deform(c) });
  }
  private deform(context: PassContext | PBRDeformationContext): void {
    const gpu = this.gpu,
      mesh = this.mesh;
    if (context.backend !== 'webgpu' || !gpu || !mesh || mesh.disposed) return;
    const queue = context.device.queue,
      vertices = mesh.primitives[0].vertices;
    let changed = false;
    if (gpu.vertices !== vertices) {
      if (vertices.length !== this.count * 20)
        throw new MargoError('state', 'Skin mesh vertex count changed; create a new Skin for the new geometry');
      queue.writeBuffer(gpu.source, 0, vertices as Float32Array<ArrayBuffer>);
      gpu.vertices = vertices;
      changed = true;
    }
    if (this.uploaded !== this.skeleton.revision) {
      gpu.palette.set(this.skeleton.skinMatrices);
      queue.writeBuffer(gpu.bones, 0, gpu.palette);
      this.uploaded = this.skeleton.revision;
      changed = true;
    }
    if (this.dirtyFrom < this.dirtyTo) {
      queue.writeBuffer(gpu.influences, this.dirtyFrom * 32, this.ids.subarray(this.dirtyFrom * 8, this.dirtyTo * 8));
      this.dirtyFrom = this.count;
      this.dirtyTo = 0;
      changed = true;
    }
    // The output buffer keeps the last pose, so an unchanged skin costs no dispatch.
    if (!changed) return;
    const pass = context.encoder.beginComputePass();
    try {
      pass.setPipeline(gpu.pipeline);
      pass.setBindGroup(0, gpu.group);
      pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    } finally {
      pass.end();
    }
  }
  private release(): void {
    const mesh = this.mesh,
      gpu = this.gpu;
    if (!mesh || !gpu) return;
    if (mesh.prepareDeformation === this.prepare) mesh.prepareDeformation = undefined;
    for (const p of mesh.primitives) if (p.deformed === gpu.output) p.deformed = undefined;
    for (const b of gpu.buffers) b.destroy();
    this.gpu = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** Stops deforming the mesh and frees the GPU buffers. CPU posing keeps working. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.mesh?.root.engine.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
