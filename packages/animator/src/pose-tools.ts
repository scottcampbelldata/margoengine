// Moves bones in world terms on a posed skeleton: what foot placement, warping and full-body IK share. Reads world
// matrices, so each change ticks the store for the next read. Bones and their ancestors need positive scales.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import {
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import { MargoError } from '@margoengine/math/errors';
import { anatomyOf, jointOf, limitRotation, rotationBetween, solveLimbIK, solveTwoBoneIK } from './ik.js';
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
  // Exported rigs carry scales a little off uniform, so each axis keeps its own.
  const scales = (m: ArrayLike<number>): [number, number, number] => {
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (!(det > 0))
      throw new MargoError(
        'state',
        `${label} bones need positive scales; remove zero or mirrored scales on the legs and above them`,
      );
    return [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
  };
  const rotationOf = (m: ArrayLike<number>): number[] => {
    const [sx, sy, sz] = scales(m);
    return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 0], sx, sy, sz));
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
        axes = scales(m),
        q = rotationOf(m),
        inverse = [-q[0], -q[1], -q[2], q[3]];
      local = rotateByQuaternion(local, inverse).map((v, i) => v / axes[i]);
    }
    bone.setPosition([t.x[id] + local[0], t.y[id] + local[1], t.z[id] + local[2]]);
    store.tick(false);
  };
  // glTF node index by transform id, for finding a bone's joint in the body.
  let indices: Map<number, number> | null = null;
  const indexOf = (bone: Mesh): number => {
    if (!indices) {
      indices = new Map();
      const nodes = animator.animation.model.nodes;
      for (let i = 0; i < nodes.length; i++) indices.set(nodes[i].id, i);
    }
    return indices.get(bone.id) ?? -1;
  };
  /** The world rotation of the bone a joint is measured against. */
  const referenceOf = (reference: number): number[] =>
    reference < 0 ? [0, 0, 0, 1] : rotationOf(animator.animation.model.nodes[reference].matrix);
  return { rotationOf, setWorldRotation, turn, moveBy, indexOf, referenceOf };
}

/**
 * The limb tools on top of {@link poseTools}, kept apart from it so a solver that moves no limb (spline IK) carries
 * none of the anatomical limb code in its bundle (KB-SIZE-SPLINEANATOMY1).
 */
export function limbTools(animator: Animator, tools: ReturnType<typeof poseTools>) {
  const { rotationOf, setWorldRotation, turn, indexOf, referenceOf } = tools;
  /**
   * Holds `bone` inside its joint's range when the Animator has a body (`setAnatomy`) with limits on; true when it
   * turned the bone back.
   */
  const limitBone = (bone: Mesh): boolean => {
    const body = anatomyOf(animator),
      joint = body?.limits ? jointOf(body, indexOf(bone)) : null;
    if (!joint) return false;
    const held = [0, 0, 0, 1];
    if (!limitRotation(joint, referenceOf(joint.reference), rotationOf(bone.matrix), held)) return false;
    setWorldRotation(bone, held);
    return true;
  };
  /**
   * Bends a direct hip, knee, ankle chain so the ankle reaches `target`. When the Animator has a body
   * (`setAnatomy`) with limits on and the knee is one of its hinges, the knee turns about its own axis the anatomical
   * way, inside its range, and `pole` only picks the limb's swivel inside the hip's range (a `hint` pole is a guess
   * for a rig without a body and is then left out). Otherwise the knee bends toward `pole`.
   */
  const placeLimb = (
    hip: Mesh,
    knee: Mesh,
    ankle: Mesh,
    target: Vec3,
    pole: Vec3,
    options: { limits?: boolean; hint?: boolean; soft?: number } = {},
  ): void => {
    const root = position(hip),
      body = options.limits === false ? null : anatomyOf(animator);
    if (body?.limits) {
      const upper = indexOf(hip),
        hinge = jointOf(body, indexOf(knee));
      if (hinge?.kind === 'hinge' && hinge.reference === upper) {
        const ball = jointOf(body, upper),
          solved = solveLimbIK({
            root,
            mid: position(knee),
            end: position(ankle),
            upperRotation: rotationOf(hip.matrix),
            lowerRotation: rotationOf(knee.matrix),
            target,
            pole: options.hint ? null : pole,
            hinge,
            ball,
            reference: ball ? referenceOf(ball.reference) : undefined,
            soft: options.soft,
          });
        setWorldRotation(hip, solved.upper);
        setWorldRotation(knee, solved.lower);
        return;
      }
    }
    const solved = solveTwoBoneIK(root, position(knee), position(ankle), target, pole);
    turn(hip, rotationBetween(subtract(position(knee), root), subtract(solved.knee, root)));
    turn(knee, rotationBetween(subtract(position(ankle), position(knee)), subtract(solved.ankle, position(knee))));
  };
  return { placeLimb, limitBone };
}
