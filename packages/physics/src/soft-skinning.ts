// Linear blend skinning for skinned cloth (Magnenat-Thalmann, Laperriere and Thalmann, "Joint-dependent local deformations
// for hand animation and object grasping", Graphics Interface 1988; the glTF 2.0 skin, section 3.7.3): each vertex is the sum
// of its bind position carried by up to four joints, each joint's matrix (its world matrix times its inverse bind matrix) by
// that joint's weight. It is the skinned mesh a renderer draws, worked out on the CPU so a cloth can be held to it.

import { softError } from './soft-error.js';
/** A mesh bound to a skeleton: four joints and four weights a vertex, as glTF's JOINTS_0 and WEIGHTS_0. */
export interface SkinBinding {
  /** Bind-pose positions, x, y, z a vertex. */
  readonly positions: ArrayLike<number>;
  /** Bind-pose normals, x, y, z a vertex (optional: without them no normals are skinned). */
  readonly normals?: ArrayLike<number> | null;
  /** Four joint indices a vertex. */
  readonly joints: ArrayLike<number>;
  /** Four weights a vertex; they are used as given (glTF asks that they sum to 1). */
  readonly weights: ArrayLike<number>;
}

/** Skinned positions and, when the binding has normals, skinned normals (unit length), x, y, z a vertex. */
export interface SkinnedVertices {
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
}

/**
 * Skins a mesh by a skeleton's joint matrices (column-major 4 by 4, sixteen numbers a joint, each the joint's world matrix
 * times its inverse bind matrix, as glTF and every engine's skinning use): the positions and normals a skinned cloth is held
 * to with {@link SoftBody.setSkinnedPositions}. Normals take the joints' linear part and are normalised, exact for rotations
 * and uniform scale. Pass `target` to skin into arrays you keep, so a frame loop allocates nothing.
 * @throws RangeError for lists of the wrong length, or a joint index with no matrix.
 */
export function skinVertices(
  binding: SkinBinding,
  matrices: ArrayLike<number>,
  target?: { positions: Float32Array; normals?: Float32Array | null },
): SkinnedVertices {
  const { positions, joints, weights } = binding,
    normals = binding.normals ?? null,
    n = positions.length / 3,
    jointCount = matrices.length / 16;
  if (!Number.isInteger(n)) throw softError(`Give three position numbers a vertex (got ${positions.length}).`);
  if (joints.length !== 4 * n || weights.length !== 4 * n)
    throw softError(
      `Give four joints and four weights a vertex: ${4 * n} each (got ${joints.length} and ${weights.length}).`,
    );
  if (normals !== null && normals.length !== 3 * n)
    throw softError(`Give three normal numbers a vertex: ${3 * n} (got ${normals.length}).`);
  if (!Number.isInteger(jointCount))
    throw softError(`Give sixteen numbers a joint matrix (got ${matrices.length}).`);
  const outP = target?.positions ?? new Float32Array(3 * n),
    outN = normals === null ? null : (target?.normals ?? new Float32Array(3 * n));
  if (outP.length !== 3 * n || (outN !== null && outN.length !== 3 * n))
    throw softError(`The target arrays must hold ${3 * n} numbers each.`);
  for (let v = 0; v < n; v++) {
    const px = positions[3 * v]!,
      py = positions[3 * v + 1]!,
      pz = positions[3 * v + 2]!;
    let x = 0,
      y = 0,
      z = 0,
      nx = 0,
      ny = 0,
      nz = 0;
    for (let k = 0; k < 4; k++) {
      const weight = weights[4 * v + k]!;
      if (weight === 0) continue;
      const joint = joints[4 * v + k]!;
      if (!Number.isInteger(joint) || joint < 0 || joint >= jointCount)
        throw softError(`Vertex ${v} uses joint ${joint}, which has no matrix; give 0 to ${jointCount - 1}.`);
      const m = 16 * joint;
      x += weight * (matrices[m]! * px + matrices[m + 4]! * py + matrices[m + 8]! * pz + matrices[m + 12]!);
      y += weight * (matrices[m + 1]! * px + matrices[m + 5]! * py + matrices[m + 9]! * pz + matrices[m + 13]!);
      z += weight * (matrices[m + 2]! * px + matrices[m + 6]! * py + matrices[m + 10]! * pz + matrices[m + 14]!);
      if (normals !== null) {
        const ax = normals[3 * v]!,
          ay = normals[3 * v + 1]!,
          az = normals[3 * v + 2]!;
        nx += weight * (matrices[m]! * ax + matrices[m + 4]! * ay + matrices[m + 8]! * az);
        ny += weight * (matrices[m + 1]! * ax + matrices[m + 5]! * ay + matrices[m + 9]! * az);
        nz += weight * (matrices[m + 2]! * ax + matrices[m + 6]! * ay + matrices[m + 10]! * az);
      }
    }
    outP[3 * v] = x;
    outP[3 * v + 1] = y;
    outP[3 * v + 2] = z;
    if (outN !== null) {
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz),
        scale = length > 0 ? 1 / length : 0;
      outN[3 * v] = nx * scale;
      outN[3 * v + 1] = ny * scale;
      outN[3 * v + 2] = nz * scale;
    }
  }
  return { positions: outP, normals: outN };
}
