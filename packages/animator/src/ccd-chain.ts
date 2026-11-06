// CCD chains on an Animator's skeleton: a CCDSolver per chain, fed every frame from the posed transform store and
// committed through the Animator's rotation writer. Kept out of the Animator class so an app that never adds a chain
// does not bundle the solver (the package has no side effects; this module is dropped when unused).
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { rotationToQuaternion } from '@margoengine/math/quat';
import { quaternionBlend } from './blend.js';
import { CCDSolver, type CCDJointLimit, type CCDResult } from './ccd.js';
import type { Animator } from './index.js';

/**
 * A Cyclic Coordinate Descent chain on the animated skeleton ({@link addCCDChain}). The Animator keeps the object and
 * reads `target`, `rotation`, `pole`, `weight` and the solve settings every frame, so move the target by writing into it.
 */
export interface CCDChain {
  /** glTF node indices from the first joint to the last (1-256), each the child of the one before. */
  joints: readonly number[];
  /** World-space point the end effector reaches for. */
  target: Vec3;
  /** End effector in the last joint's local space (default the last joint's origin), e.g. a fingertip past the hand. */
  tip?: Vec3;
  /** World rotation (x, y, z, w) the last joint ends with; null or absent for position only. */
  rotation?: ArrayLike<number> | null;
  /** World point the chain bends toward (a knee or elbow hint); null or absent for none. */
  pole?: Vec3 | null;
  /** One limit per joint (index-aligned with `joints`, null for a free joint), relative to the joint's rest rotation. */
  limits?: readonly (CCDJointLimit | null | undefined)[];
  /** Blend from the animated pose (0) to the solved chain (1); default 1. */
  weight?: number;
  /** Most sweeps per frame (0-1,024, default 16). */
  iterations?: number;
  /** Distance that counts as reached, world units (default 0.001). */
  tolerance?: number;
  /** Orientation error that counts as reached, radians (default 0.001). */
  angleTolerance?: number;
  /** Largest turn of one joint per sweep, radians (default π). */
  maxAngle?: number;
  /** The solver's reach step after each sweep ({@link CCDSolver.reach}, default true); false runs plain CCD. */
  reach?: boolean;
  /** Called after each frame's solve with the solver's reused result (read it before the next frame). */
  onSolve?: (result: CCDResult) => void;
}

/**
 * Adds a Cyclic Coordinate Descent IK chain (Wang and Chen 1991) to `animator`, solved every frame after the pose, the
 * additive layers and foot IK: the joints turn, within their limits, so the chain's end effector reaches
 * `chain.target` (and, with `rotation`, the last joint takes that world rotation). Unreachable targets stretch the
 * chain toward them. Joints and their ancestors need positive scales; rotations commit through the Animator's
 * `writeRotation` when it has one. Returns a function that removes the chain.
 */
export function addCCDChain(animator: Animator, chain: CCDChain): () => void {
  const nodes = animator.animation.model.nodes,
    joints = chain?.joints;
  if (
    !Array.isArray(joints) ||
    joints.length < 1 ||
    joints.length > 256 ||
    joints.some((i) => !Number.isInteger(i) || i < 0 || i >= nodes.length)
  )
    throw new TypeError("CCD chain joints must be 1-256 of this model's glTF node indices");
  const engine = animator.animation.model.root.engine,
    store = engine.store,
    t = store.transforms,
    parents = store.parents;
  for (let j = 1; j < joints.length; j++)
    if (parents[nodes[joints[j]].id] !== nodes[joints[j - 1]].id)
      throw new TypeError('CCD chain joints must each be the child of the joint before; list them from first to last');
  if (chain.limits !== undefined && (!Array.isArray(chain.limits) || chain.limits.length > joints.length))
    throw new TypeError('CCD chain limits must be an array with at most one entry per joint');
  if (chain.onSolve !== undefined && typeof chain.onSolve !== 'function')
    throw new TypeError('CCD chain onSolve must be a function');
  const solver = new CCDSolver(
      joints.map((): Vec3 => [0, 0, 0]),
      chain.tip,
    ),
    chainNodes: Mesh[] = joints.map((i) => nodes[i]),
    pose = [0, 0, 0, 1],
    solved = [0, 0, 0, 1],
    out = [0, 0, 0, 1];
  joints.forEach((i, j) => {
    solver.rest.set(animator.restRotation(i), j * 4);
    solver.setLimit(j, chain.limits?.[j] ?? null);
  });
  solver.rotations.set(solver.rest);
  // Copies the chain's mutable settings into the solver (the solve validates them); returns the validated weight.
  const settings = (): number => {
    const weight = chain.weight ?? 1;
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('CCD chain weight must be from 0 to 1');
    solver.iterations = chain.iterations ?? 16;
    solver.tolerance = chain.tolerance ?? 0.001;
    solver.angleTolerance = chain.angleTolerance ?? 0.001;
    solver.maxAngle = chain.maxAngle ?? Math.PI;
    solver.reach = chain.reach ?? true;
    return weight;
  };
  // Validate the per-frame fields now, so a bad chain fails here rather than in the frame loop.
  settings();
  solver.iterations = 0;
  solver.solve(chain.target, chain.rotation ?? null, chain.pole ?? null);
  return animator.addSolver(() => {
    const weight = settings();
    if (weight === 0) return;
    const parent = parents[chainNodes[0].id];
    // The solver keeps one scale per joint, so each offset takes what the frame above has beyond that scale per axis.
    let ax = 1,
      ay = 1,
      az = 1;
    if (parent === -1) {
      solver.parentPosition.fill(0);
      solver.parentRotation.fill(0);
      solver.parentRotation[3] = 1;
      solver.parentScale[0] = 1;
    } else {
      const m = engine.meshes.get(parent)!.matrix,
        px = Math.hypot(m[0], m[1], m[2]),
        py = Math.hypot(m[4], m[5], m[6]),
        pz = Math.hypot(m[8], m[9], m[10]),
        det =
          m[0] * (m[5] * m[10] - m[6] * m[9]) -
          m[4] * (m[1] * m[10] - m[2] * m[9]) +
          m[8] * (m[1] * m[6] - m[2] * m[5]),
        mean = (px + py + pz) / 3,
        q = solver.parentRotation;
      if (!(det > 0)) throw new RangeError('CCD chain parents need positive scales; remove zero or mirrored scales');
      rotationToQuaternion(m, q, px, py, pz);
      const length = Math.hypot(q[0], q[1], q[2], q[3]);
      for (let k = 0; k < 4; k++) q[k] /= length;
      solver.parentPosition[0] = m[12];
      solver.parentPosition[1] = m[13];
      solver.parentPosition[2] = m[14];
      solver.parentScale[0] = mean;
      ax = px / mean;
      ay = py / mean;
      az = pz / mean;
    }
    for (let j = 0; j < chainNodes.length; j++) {
      const id = chainNodes[j].id,
        sx = t.sx[id],
        sy = t.sy[id],
        sz = t.sz[id];
      if (!(sx > 0 && sy > 0 && sz > 0))
        throw new RangeError('CCD chain joints need positive scales; remove zero or mirrored joint scales');
      solver.offsets[j * 3] = t.x[id] * ax;
      solver.offsets[j * 3 + 1] = t.y[id] * ay;
      solver.offsets[j * 3 + 2] = t.z[id] * az;
      solver.rotations[j * 4] = t.qx[id];
      solver.rotations[j * 4 + 1] = t.qy[id];
      solver.rotations[j * 4 + 2] = t.qz[id];
      solver.rotations[j * 4 + 3] = t.qw[id];
      const mean = (sx + sy + sz) / 3;
      solver.scales[j] = mean;
      ax = sx / mean;
      ay = sy / mean;
      az = sz / mean;
    }
    const result = solver.solve(chain.target, chain.rotation ?? null, chain.pole ?? null);
    for (let j = 0; j < chainNodes.length; j++) {
      const id = chainNodes[j].id;
      for (let k = 0; k < 4; k++) solved[k] = solver.rotations[j * 4 + k];
      if (weight < 1) {
        pose[0] = t.qx[id];
        pose[1] = t.qy[id];
        pose[2] = t.qz[id];
        pose[3] = t.qw[id];
        quaternionBlend(pose, solved, weight, out);
        animator.writeNodeRotation(chainNodes[j], out);
      } else animator.writeNodeRotation(chainNodes[j], solved);
    }
    store.tick(false);
    chain.onSolve?.(result);
  });
}
