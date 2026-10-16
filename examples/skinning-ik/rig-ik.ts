import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { solveTwoBoneIK } from '@margoengine/animator';
import { Quaternion } from '@margoengine/math/quaternion';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { invertMatrixStable } from '@margoengine/math/mat4';

type Point = [number, number, number];
type Rotation = [number, number, number, number];

export interface ArmIK {
  shoulder: Mesh;
  elbow: Mesh;
  wrist: Mesh;
  /** Target and pole are world-space points. */
  target: Vec3;
  pole: Vec3;
}

/** Read a node's current world position; solveArm refreshes the matrices itself. */
export function worldPosition(mesh: Mesh): Point {
  return worldPositionInto(mesh, [0, 0, 0]);
}

/** Write a world position into caller-owned storage without changing the fresh-result helper. */
export function worldPositionInto(mesh: Mesh, out: Point): Point {
  mesh.check();
  const matrix = mesh.matrix;
  out[0] = matrix[12];
  out[1] = matrix[13];
  out[2] = matrix[14];
  return out;
}

const transformPoint = (matrix: ArrayLike<number>, point: Vec3, out: Point): Point => {
  const x = point[0],
    y = point[1],
    z = point[2];
  out[0] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  out[1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  out[2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  return out;
};

/** Convert an initial world-space contact point into the joint's local coordinates. */
export function localPoint(
  mesh: Mesh,
  point: Vec3,
  out: Point = [0, 0, 0],
  inverse: Float64Array = new Float64Array(16),
): Point {
  mesh.check();
  if (!invertMatrixStable(mesh.matrix, inverse)) throw new Error('Singular grip transform');
  return transformPoint(inverse, point, out);
}

/** Contact point follows the full joint transform, including model placement and scale. */
export function gripPosition(joint: Mesh, localGrip: Vec3, out: Point = [0, 0, 0]): Point {
  joint.check();
  return transformPoint(joint.matrix, localGrip, out);
}

/** A held object's visible center is always attached to the palm, independently of its requested IK target. */
export function holdObjectAtGrip(
  object: Mesh,
  joint: Mesh,
  localGrip: Vec3,
  out: Point = [0, 0, 0],
  inverse?: Float64Array,
): Point {
  object.check();
  if (object.engine !== joint.engine) throw new Error('Grip nodes must belong to the same engine');
  const store = joint.engine.store;
  store.tick(false);
  const world = gripPosition(joint, localGrip, out),
    parent = store.parents[object.id];
  object.setPosition(parent === -1 ? world : localPoint(object.engine.meshes.get(parent)!, world, out, inverse));
  store.tick(false);
  return worldPositionInto(object, out);
}

/** World orientation for a hierarchy with positive uniform scales. */
export function worldRotation(mesh: Mesh): Rotation {
  mesh.check();
  const { transforms: t, parents } = mesh.engine.store,
    chain: number[] = [];
  for (let id = mesh.id; id !== -1; id = parents[id]) {
    const scales = [t.sx[id], t.sy[id], t.sz[id]],
      tolerance = Math.max(...scales) * 1e-5;
    if (
      scales.some((value) => !Number.isFinite(value) || value <= 0) ||
      Math.abs(scales[0] - scales[1]) > tolerance ||
      Math.abs(scales[0] - scales[2]) > tolerance
    )
      throw new Error('Arm IK requires positive uniform bone and ancestor scales');
    chain.push(id);
  }
  let rotation: Rotation = [0, 0, 0, 1];
  for (const id of chain.reverse()) rotation = multiplyQuaternions(rotation, [t.qx[id], t.qy[id], t.qz[id], t.qw[id]]);
  const length = Math.hypot(...rotation);
  return rotation.map((value) => value / length) as Rotation;
}

/** Apply a world-space rotation delta while preserving the node's local position and scale. */
export function rotateWorld(mesh: Mesh, delta: readonly number[]): void {
  if (delta.length !== 4 || delta.some((value) => !Number.isFinite(value)) || !Math.hypot(...delta))
    throw new RangeError('Invalid arm IK rotation');
  const current = worldRotation(mesh),
    parentId = mesh.engine.store.parents[mesh.id],
    parent: Rotation = parentId === -1 ? [0, 0, 0, 1] : worldRotation(mesh.engine.meshes.get(parentId)!),
    inverseParent: Rotation = [-parent[0], -parent[1], -parent[2], parent[3]];
  mesh.setQuaternion(multiplyQuaternions(inverseParent, multiplyQuaternions(delta, current)));
}

const subtract = (a: Vec3, b: Vec3): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function between(from: Vec3, to: Vec3): Rotation {
  const a = Math.hypot(...from),
    b = Math.hypot(...to);
  if (a < 1e-8 || b < 1e-8) throw new RangeError('Zero arm IK direction');
  const q = new Quaternion().setFromUnitVectors(
    { x: from[0] / a, y: from[1] / a, z: from[2] / a },
    { x: to[0] / b, y: to[1] / b, z: to[2] / b },
  );
  return [q.x, q.y, q.z, q.w];
}

/**
 * Solve a direct shoulder/elbow/wrist chain after the Animator has sampled its base pose.
 * Only rotations change. Re-evaluating world matrices between joints keeps a transformed model root correct.
 */
export function solveArm({ shoulder, elbow, wrist, target, pole }: ArmIK): {
  elbow: Point;
  wrist: Point;
  residual: number;
} {
  for (const node of [shoulder, elbow, wrist]) node.check();
  if (shoulder.engine !== elbow.engine || shoulder.engine !== wrist.engine)
    throw new Error('Arm IK nodes must belong to the same engine');
  const store = shoulder.engine.store;
  if (store.parents[elbow.id] !== shoulder.id || store.parents[wrist.id] !== elbow.id)
    throw new Error('Arm IK requires a direct shoulder/elbow/wrist chain');
  // Validate every ancestor, including the wrist, before changing either joint.
  worldRotation(wrist);
  store.tick(false);
  const t = store.transforms,
    root = worldPosition(shoulder);
  let scale = 1;
  for (let id = shoulder.id; id !== -1; id = store.parents[id]) scale *= t.sx[id];
  const upper = Math.hypot(t.x[elbow.id], t.y[elbow.id], t.z[elbow.id]) * scale,
    lower = Math.hypot(t.x[wrist.id], t.y[wrist.id], t.z[wrist.id]) * scale * t.sx[elbow.id],
    // Invariant lengths avoid cancellation in a nearly folded float32 world pose. Canonical seed points also
    // give coincident targets a deterministic direction instead of following the previous frame's roundoff.
    solved = solveTwoBoneIK(
      [0, 0, 0],
      [upper, 0, 0],
      [upper + lower, 0, 0],
      subtract(target, root),
      subtract(pole, root),
    ),
    solvedElbow: Point = solved.knee.map((value, axis) => value + root[axis]) as Point,
    solvedWrist: Point = solved.ankle.map((value, axis) => value + root[axis]) as Point;
  rotateWorld(shoulder, between(subtract(worldPosition(elbow), root), subtract(solvedElbow, root)));
  store.tick(false);
  const elbowPosition = worldPosition(elbow);
  rotateWorld(elbow, between(subtract(worldPosition(wrist), elbowPosition), subtract(solvedWrist, elbowPosition)));
  store.tick(false);
  const finalWrist = worldPosition(wrist);
  return {
    elbow: worldPosition(elbow),
    wrist: finalWrist,
    residual: Math.hypot(...subtract(finalWrist, target)),
  };
}
