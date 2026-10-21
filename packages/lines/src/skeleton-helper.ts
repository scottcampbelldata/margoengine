// SkeletonHelper: a skinned model's bones as lines from each parent joint to its child joint,
// following the pose every frame. The skeleton is a structural type, so lines does not import @margoengine/animation:
// pass its `Skeleton` (parents and skeleton-space matrices) or a glTF skin's joint meshes (`SkeletonHelper.fromGLTF`).
// Each frame the helper re-reads the joint positions and rewrites its points only when one moved, into arrays it keeps.
import type { EngineKernel, Mesh } from '@margoengine/core';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { parseColor, type ColorInput } from './color.js';
import { Line } from './line.js';
import type { HelperOptions } from './helpers.js';
import type { Mat4 } from './math.js';

/** Bones as `@margoengine/animation`'s `Skeleton` keeps them: pass the Skeleton itself. */
export interface SkeletonShape {
  /** Parent bone index per bone, -1 for a root. */
  readonly parents: readonly number[];
  /** Each bone's current matrix, 16 column-major numbers per bone in the skinned mesh's local space; read every frame. */
  readonly matrices: ArrayLike<number>;
  /** Bumped on every pose change; when present, a frame with the same revision skips reading the matrices. */
  readonly revision?: number;
}
/** Bones as joint meshes that their world matrices pose, such as a glTF skin's joints among a gltf-pro model's `nodes`. */
export interface JointsShape {
  /** One core mesh per bone; each frame the helper reads their world matrices. */
  readonly joints: readonly Mesh[];
  /** Parent bone index per bone (an index into `joints`), -1 where the parent is not a joint. */
  readonly parents: readonly number[];
}
/** What `SkeletonHelper.fromGLTF` reads from a gltf-pro `PBRModel`: its glTF document and its node meshes. */
export interface GLTFSkinSource {
  readonly asset: {
    readonly doc: {
      readonly skins?: readonly { readonly joints: readonly number[] }[];
      readonly nodes?: readonly { readonly children?: readonly number[] }[];
    };
  };
  /** Core meshes by glTF node index. */
  readonly nodes: readonly Mesh[];
}
/**
 * Look and placement of a {@link SkeletonHelper}. It draws over the scene (`onTop`, default true) and
 * is not fogged (`fog`, default false).
 */
export interface SkeletonHelperOptions extends HelperOptions {
  /** Colour at each bone's own (child) end. Default blue '#0000ff'. */
  color?: ColorInput;
  /** Colour at the parent end. Default green '#00ff00'. */
  parentColor?: ColorInput;
  /** With a `SkeletonShape`: the skinned mesh whose world matrix places the skeleton (e.g. `model.primitives[0].node`). */
  mesh?: Mesh | null;
  /** With a `SkeletonShape` and no `mesh`: the model matrix, column-major. Default identity. */
  matrix?: Mat4;
}

const isJoints = (value: SkeletonShape | JointsShape): value is JointsShape => 'joints' in value;
const label = 'SkeletonHelper';

/**
 * A skeleton as lines from each parent joint to its child joint, coloured from
 * `parentColor` at the parent end to `color` at the child end. Pass `@margoengine/animation`'s `Skeleton` (with
 * `mesh`, the skinned mesh that places it) or joint meshes (`fromGLTF` builds them from a gltf-pro model's skin); it
 * follows the current pose every frame. Add it to a `Lines` plugin; `dispose()` removes it and frees its GPU buffers.
 * @throws TypeError from the constructor for a skeleton without parents, joints that are not meshes, or a malformed
 * colour; RangeError for a parent index that is not another bone's, and each frame for too few skeleton matrices.
 */
export class SkeletonHelper extends Line {
  /** The bones drawn: the skeleton or joints given. */
  readonly skeleton: SkeletonShape | JointsShape;
  private readonly pairs: number[] = [];
  private readonly seen: Float64Array;
  private readonly out: Float32Array;
  private revisionSeen = NaN;
  private valid = false;
  constructor(skeleton: SkeletonShape | JointsShape, options: SkeletonHelperOptions = {}) {
    const parents = skeleton?.parents;
    if (!skeleton || typeof skeleton !== 'object' || !Array.isArray(parents) || !parents.length)
      throw new TypeError(`${label} needs a skeleton with parents; pass an animation Skeleton or {joints, parents}`);
    const n = parents.length;
    parents.forEach((parent, i) => {
      if (!Number.isInteger(parent) || parent < -1 || parent >= n || parent === i)
        throw new RangeError(`${label} bone ${i} parent ${parent} is not another bone; use -1 or an index below ${n}`);
    });
    if (isJoints(skeleton)) {
      if (!Array.isArray(skeleton.joints) || skeleton.joints.length !== n)
        throw new TypeError(`${label} needs one joint mesh per parent entry; pass ${n} joints`);
      for (const joint of skeleton.joints)
        if (!joint || typeof joint.check !== 'function')
          throw new TypeError(`${label} joints must be Margo Engine meshes; pass model.nodes entries`);
    } else if (!skeleton.matrices || typeof skeleton.matrices.length !== 'number')
      throw new TypeError(`${label} skeleton needs matrices, 16 numbers per bone; pass an animation Skeleton`);
    const { color = '#0000ff', parentColor = '#00ff00', mesh = null, matrix, ...style } = options,
      joints = isJoints(skeleton);
    super({
      cap: 'butt',
      join: 'miter',
      onTop: true,
      fog: false,
      ...style,
      mode: 'segments',
      mesh: joints ? null : mesh,
      matrix: joints ? undefined : matrix,
    });
    this.skeleton = skeleton;
    for (let i = 0; i < n; i++) if (parents[i] >= 0) this.pairs.push(parents[i], i);
    if (joints) for (const joint of skeleton.joints) joint.check();
    this.seen = new Float64Array(n * 3).fill(NaN);
    // A skeleton of one bone still needs one (degenerate) segment for the Line to exist.
    this.out = new Float32Array(Math.max(2, this.pairs.length) * 3);
    this.setPositions(this.out);
    this.setColors(color, parentColor);
  }
  /** A helper for skin `skin` (default 0) of a gltf-pro model: its joint nodes, each joined to its parent node when that is a joint too. */
  static fromGLTF(model: GLTFSkinSource, skin = 0, options?: SkeletonHelperOptions): SkeletonHelper {
    const doc = model?.asset?.doc,
      joints = doc?.skins?.[skin]?.joints;
    if (!Array.isArray(joints) || !Array.isArray(model.nodes))
      throw new TypeError(
        `${label}.fromGLTF: the model has no skin ${skin}; pass a gltf-pro model and one of its skins`,
      );
    const parentOf = new Map<number, number>();
    (doc.nodes ?? []).forEach((node, index) => node?.children?.forEach((child) => parentOf.set(child, index)));
    return new SkeletonHelper(
      {
        joints: joints.map((node) => model.nodes[node]),
        parents: joints.map((node) => joints.indexOf(parentOf.get(node) ?? -1)),
      },
      options,
    );
  }
  /** Recolours the bones: `color` at the child end, `parentColor` at the parent end. With one argument, as `Line.setColors`. */
  override setColors(color: ColorInput | ArrayLike<number> | null, parentColor?: ColorInput): this {
    if (parentColor === undefined) return super.setColors(color as ArrayLike<number> | null);
    const child = parseColor(color as ColorInput) as number[],
      parent = parseColor(parentColor) as number[],
      colors: number[] = [];
    for (let i = 0; i < this.count; i += 2) colors.push(...parent, ...child);
    return super.setColors(colors);
  }
  override update(engine: EngineKernel): boolean {
    const s = this.skeleton,
      n = s.parents.length,
      seen = this.seen;
    let moved = false;
    const at = (bone: number, x: number, y: number, z: number) => {
      if (seen[bone * 3] !== x || seen[bone * 3 + 1] !== y || seen[bone * 3 + 2] !== z) {
        seen[bone * 3] = x;
        seen[bone * 3 + 1] = y;
        seen[bone * 3 + 2] = z;
        moved = true;
      }
    };
    if (isJoints(s)) {
      for (let i = 0; i < n; i++) {
        // A removed or hidden joint hides the helper until it is back.
        const m = meshWorldMatrix(engine, s.joints[i]);
        if (!m) return false;
        at(i, m[12], m[13], m[14]);
      }
    } else {
      const revision = s.revision;
      if (revision !== undefined && revision === this.revisionSeen && this.valid) return true;
      const m = s.matrices;
      if (m.length < n * 16)
        throw new RangeError(`${label} skeleton has ${m.length} matrix numbers for ${n} bones; pass 16 per bone`);
      for (let i = 0; i < n; i++) at(i, m[i * 16 + 12], m[i * 16 + 13], m[i * 16 + 14]);
      this.revisionSeen = revision ?? NaN;
    }
    if (!moved) return this.valid;
    const pairs = this.pairs,
      out = this.out;
    for (let p = 0; p < pairs.length; p++) for (let k = 0; k < 3; k++) out[p * 3 + k] = seen[pairs[p] * 3 + k];
    if (!out.every(Number.isFinite)) return (this.valid = false);
    this.setPositions(out);
    return (this.valid = true);
  }
}
