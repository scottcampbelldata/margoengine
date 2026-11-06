// Moves bones in world terms on a posed skeleton: what foot placement, warping and full-body IK share. Reads world
// matrices, so each change ticks the store for the next read. Bones and their ancestors need positive uniform scales.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import {
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import { MargoError } from '@margoengine/math/errors';
import { rotationBetween, solveTwoBoneIK } from './ik.js';
import type { Animator } from './index.js';

export const subtract = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number] => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export function position(node: Mesh): [number, number, number] {
  const m = node.matrix;
  return [m[12], m[13], m[14]];
}

/** The world-space bone tools of `animator`; `label` starts their errors. */
export function poseTools(animator: Animator, label: string) {
  const engine = animator.animation.model.root.engine,
    store = engine.store,
    parents = store.parents;
  const uniformScale = (m: ArrayLike<number>): number => {
    const sx = Math.hypot(m[0], m[1], m[2]),
      sy = Math.hypot(m[4], m[5], m[6]),
      sz = Math.hypot(m[8], m[9], m[10]);
    if (!(sx > 0) || Math.abs(sx - sy) > 1e-5 * sx || Math.abs(sx - sz) > 1e-5 * sx)
      throw new MargoError(
        'state',
        `${label} bones need positive uniform scales; remove non-uniform scales on the legs and above them`,
      );
    return sx;
  };
  const rotationOf = (m: ArrayLike<number>): number[] => {
    const s = uniformScale(m);
    return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 0], s, s, s));
  };
  const setWorldRotation = (bone: Mesh, next: ArrayLike<number>): void => {
    const parent = parents[bone.id],
      base = parent === -1 ? [0, 0, 0, 1] : rotationOf(engine.meshes.get(parent)!.matrix);
    animator.writeNodeRotation(
      bone,
      normalizeQuaternion(multiplyQuaternions([-base[0], -base[1], -base[2], base[3]], next)),
    );
    store.tick(false);
  };
  /** Turns `bone` by the world rotation `world`. */
  const turn = (bone: Mesh, world: number[]): void => {
    setWorldRotation(bone, multiplyQuaternions(world, rotationOf(bone.matrix)));
  };
  /** Moves `bone` by a world offset, carried into its parent's frame. */
  const moveBy = (bone: Mesh, offset: Vec3): void => {
    const parent = parents[bone.id],
      t = store.transforms,
      id = bone.id;
    let local: number[] = [offset[0], offset[1], offset[2]];
    if (parent !== -1) {
      const m = engine.meshes.get(parent)!.matrix,
        scale = uniformScale(m),
        q = rotationToQuaternion(m, [0, 0, 0, 0], scale, scale, scale),
        inverse = [-q[0], -q[1], -q[2], q[3]];
      local = rotateByQuaternion(local, inverse).map((v) => v / scale);
    }
    bone.setPosition([t.x[id] + local[0], t.y[id] + local[1], t.z[id] + local[2]]);
    store.tick(false);
  };
  /** Bends a direct hip, knee, ankle chain so the ankle reaches `target`, the knee toward `pole`. */
  const placeLimb = (hip: Mesh, knee: Mesh, ankle: Mesh, target: Vec3, pole: Vec3): void => {
    const root = position(hip),
      solved = solveTwoBoneIK(root, position(knee), position(ankle), target, pole);
    turn(hip, rotationBetween(subtract(position(knee), root), subtract(solved.knee, root)));
    turn(knee, rotationBetween(subtract(position(ankle), position(knee)), subtract(solved.ankle, position(knee))));
  };
  return { rotationOf, setWorldRotation, turn, moveBy, placeLimb };
}
