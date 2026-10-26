// Rest skeletons as joint positions: the shape the weight solvers, checks and voxel helpers read. A joint owns the bone
// segments from its position to each child's (what rotates when the joint turns, as in glTF skinning); a leaf joint
// owns the point at its position.
import type { Vec3 } from '@margoengine/math';
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';

/**
 * A joint of a rest skeleton: the same shape as `@margoengine/exporters/skin`'s `SkinJoint`, so one array serves both.
 * Positions are in the mesh's space (the space of the vertices being weighted).
 */
export interface RigJoint {
  /** Unique, nonempty. */
  readonly name: string;
  /** Index of the parent joint, or -1 for a root. */
  readonly parent: number;
  /** Rest position. */
  readonly position: Vec3;
}

/** A bone hierarchy with local rest transforms, as `@margoengine/animation`'s `retargetRig` makes it. */
export interface RigPose {
  /** Bone names; a bone's index is its position here. */
  readonly names: readonly string[];
  /** Parent bone per bone, -1 at the top. */
  readonly parents: readonly number[];
  /** Local rest pose, 10 numbers per bone: translation xyz, rotation quaternion xyzw, scale xyz. */
  readonly rest: ArrayLike<number>;
}

/** Most joints the package accepts. */
const MAX_JOINTS = 1024;

/**
 * Checks a joint array (1-1024 joints, unique nonempty names, finite positions, parents that reach a root without a
 * cycle) and returns its parent-before-child order.
 * @throws TypeError for a malformed joint, RangeError for a bad parent or position.
 */
export function checkRig(joints: readonly RigJoint[]): number[] {
  if (!Array.isArray(joints) || !joints.length || joints.length > MAX_JOINTS)
    throw new RangeError(`A rig needs 1 to ${MAX_JOINTS} joints; pass an array of {name, parent, position}`);
  const names = new Set<string>(),
    n = joints.length,
    children: number[][] = joints.map(() => []);
  for (let i = 0; i < n; i++) {
    const joint = joints[i];
    if (!joint || typeof joint.name !== 'string' || !joint.name || names.has(joint.name))
      throw new TypeError(`Rig joint ${i} needs a unique, nonempty name; rename it`);
    names.add(joint.name);
    const parent = joint.parent;
    if (!Number.isInteger(parent) || parent < -1 || parent >= n || parent === i)
      throw new RangeError(`Rig joint ${joint.name} parent ${parent} is invalid; use -1 or another joint's index`);
    const p = joint.position;
    if (!p || p.length !== 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2]))
      throw new RangeError(`Rig joint ${joint.name} position must be three finite numbers`);
    if (parent >= 0) children[parent].push(i);
  }
  const order: number[] = [];
  for (const stack = joints.flatMap((joint, i) => (joint.parent < 0 ? [i] : [])); stack.length; ) {
    const joint = stack.pop()!;
    order.push(joint);
    for (const child of children[joint]) stack.push(child);
  }
  if (order.length !== n) throw new RangeError('Rig parents form a cycle; every joint must reach a root (parent -1)');
  return order;
}

/** Index of each named joint, or -1. */
function jointIndex(joints: readonly RigJoint[], name: string): number {
  for (let i = 0; i < joints.length; i++) if (joints[i].name === name) return i;
  return -1;
}

/** Resolves joint references (indices or names) to indices. @throws RangeError for an unknown one. */
export function resolveJoints(
  joints: readonly RigJoint[],
  list: readonly (number | string)[],
  label: string,
): number[] {
  if (!Array.isArray(list)) throw new TypeError(`${label} must be an array of joint indices or names`);
  return list.map((item) => {
    const index = typeof item === 'string' ? jointIndex(joints, item) : item;
    if (!Number.isInteger(index) || index < 0 || index >= joints.length)
      throw new RangeError(`${label} names joint ${String(item)}, which the rig does not have; fix the name or index`);
    return index;
  });
}

/**
 * World rest positions of a {@link RigPose} (glTF nodes, a `Skeleton` or `retargetRig` output) as {@link RigJoint}s.
 * Unnamed bones are named `bone<index>`.
 */
export function rigJoints(rig: RigPose): RigJoint[] {
  const { names, parents, rest } = rig ?? ({} as RigPose),
    n = names?.length;
  if (!Array.isArray(names) || !Array.isArray(parents) || parents.length !== n || rest?.length !== n * 10)
    throw new TypeError('rigJoints needs {names, parents, rest} with 10 rest numbers per bone (see retargetRig)');
  const order = checkRig(
      names.map((name, i) => ({ name: name || `bone${i}`, parent: parents[i], position: [0, 0, 0] as Vec3 })),
    ),
    rotation = new Float64Array(n * 4),
    position = new Float64Array(n * 3),
    scale = new Float64Array(n * 3);
  for (const b of order) {
    const p = parents[b],
      l = b * 10;
    for (let c = 0; c < 10; c++)
      if (!Number.isFinite(rest[l + c]))
        throw new RangeError(`rigJoints bone ${b} rest pose is not finite; make all 10 rest numbers finite`);
    if (p < 0) {
      for (let c = 0; c < 3; c++) (position[b * 3 + c] = rest[l + c]), (scale[b * 3 + c] = rest[l + 7 + c]);
      for (let c = 0; c < 4; c++) rotation[b * 4 + c] = rest[l + 3 + c];
      continue;
    }
    const parent = rotation.subarray(p * 4, p * 4 + 4),
      offset = rotateByQuaternion(
        [scale[p * 3] * rest[l], scale[p * 3 + 1] * rest[l + 1], scale[p * 3 + 2] * rest[l + 2]],
        parent,
      );
    for (let c = 0; c < 3; c++) position[b * 3 + c] = position[p * 3 + c] + offset[c];
    rotation.set(multiplyQuaternions(parent, [rest[l + 3], rest[l + 4], rest[l + 5], rest[l + 6]]), b * 4);
    for (let c = 0; c < 3; c++) scale[b * 3 + c] = scale[p * 3 + c] * rest[l + 7 + c];
  }
  return names.map((name, i) => ({
    name: name || `bone${i}`,
    parent: parents[i],
    position: [position[i * 3], position[i * 3 + 1], position[i * 3 + 2]] as Vec3,
  }));
}

/**
 * The bone segments the weight solvers measure distance to: per deforming joint, a segment from it to each child (a
 * point at a leaf). Six numbers per segment (start xyz, end xyz) and the owning joint per segment.
 */
export function boneSegments(
  joints: readonly RigJoint[],
  deforms: (joint: number) => boolean,
): { points: Float64Array; owners: Int32Array } {
  const points: number[] = [],
    owners: number[] = [],
    children = joints.map(() => [] as number[]);
  joints.forEach((joint, i) => {
    if (joint.parent >= 0) children[joint.parent].push(i);
  });
  joints.forEach((joint, i) => {
    if (!deforms(i)) return;
    const a = joint.position,
      ends = children[i].length ? children[i].map((c) => joints[c].position) : [a];
    for (const b of ends) {
      points.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      owners.push(i);
    }
  });
  return { points: Float64Array.from(points), owners: Int32Array.from(owners) };
}

/**
 * Squared distance from (x, y, z) to segment `s` of `points` (six numbers per segment); writes the closest point to
 * `out` when given.
 */
export function segmentDistance2(
  points: Float64Array,
  s: number,
  x: number,
  y: number,
  z: number,
  out?: Float64Array,
): number {
  const o = s * 6,
    ax = points[o],
    ay = points[o + 1],
    az = points[o + 2],
    dx = points[o + 3] - ax,
    dy = points[o + 4] - ay,
    dz = points[o + 5] - az,
    length2 = dx * dx + dy * dy + dz * dz;
  let t = length2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t,
    cy = ay + dy * t,
    cz = az + dz * t;
  if (out) (out[0] = cx), (out[1] = cy), (out[2] = cz);
  return (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
}
