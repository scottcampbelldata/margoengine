// Checked affine decomposition: Matrix4.decompose's numbers plus what they leave out (shear, reflection, a projective
// row) and whether translation * rotation * scale gives the matrix back.
import { Matrix4 } from './matrix4.js';
import { Quaternion } from './quaternion.js';
import type { Mat4, MutableVec3, Vec3Like } from './types.js';

/** What {@link decomposeAffine} found. Check `lossless` before using the TRS parts as the whole transform. */
export interface AffineDecomposition {
  /** Column 3: `Matrix4.decompose`'s position. */
  translation: MutableVec3;
  /** `Matrix4.decompose`'s quaternion `[x, y, z, w]`, normalized. */
  rotation: [x: number, y: number, z: number, w: number];
  /** `Matrix4.decompose`'s scale: the column lengths, x negated when the determinant is negative. */
  scale: MutableVec3;
  /**
   * Gram-Schmidt shear of the upper 3x3 columns c0, c1, c2 taken in that order: with u0 = c0 / |c0|,
   * c1' = c1 - (u0 · c1) u0, u1 = c1' / |c1'| and c2' = c2 - (u0 · c2) u0 - (u1 · c2) u1, it is
   * `[(u0 · c1) / |c1'|, (u0 · c2) / |c2'|, (u1 · c2) / |c2'|]`. All 0 when the columns are mutually orthogonal (any
   * TRS matrix). NaN when c0 is zero or c1' or c2' is exactly zero; nearly dependent columns give large values.
   */
  shear: MutableVec3;
  /** Sign of the upper 3x3 determinant: `'right'` (> 0), `'left'` (< 0, a reflection) or `'degenerate'` (0 or NaN). */
  handedness: 'right' | 'left' | 'degenerate';
  /** True when the bottom row is not exactly `[0, 0, 0, 1]` (a projective matrix, which no TRS represents). */
  projective: boolean;
  /**
   * Largest absolute difference over the 16 elements between the matrix and `Matrix4.compose(translation, rotation,
   * scale)`; Infinity when either has a NaN or infinite element.
   */
  error: number;
  /** `error <= tolerance`: the TRS parts rebuild the matrix. False means shear, a projective row or non-finite input. */
  lossless: boolean;
}

/**
 * Splits a column-major 4x4 into `Matrix4.decompose`'s translation, rotation and scale (the same numbers, rotation
 * normalized) and reports what that reading drops: the shear, the handedness, a projective bottom row and the
 * recomposition error. `Matrix4.decompose` never fails, so a result alone does not mean the matrix is a TRS; `lossless`
 * does. Reads `matrix` and keeps no reference to it.
 * @param matrix 16 column-major numbers: a `Matrix4.elements`, `camera.matrix` or a world matrix.
 * @param tolerance Largest accepted absolute element `error`, finite and >= 0; default 1e-5.
 * @throws TypeError when `matrix` has fewer than 16 numbers.
 * @throws RangeError when `tolerance` is negative or not finite.
 */
export function decomposeAffine(matrix: Mat4, tolerance = 1e-5): AffineDecomposition {
  if (!matrix || !(matrix.length >= 16))
    throw new TypeError('decomposeAffine needs 16 column-major numbers, such as Matrix4.elements');
  if (!(tolerance >= 0 && tolerance < Number.POSITIVE_INFINITY))
    throw new RangeError(`decomposeAffine tolerance ${tolerance} is invalid; pass a finite number >= 0, e.g. 1e-5`);
  const m = new Matrix4().fromArray(matrix),
    e = m.elements,
    position: Vec3Like = { x: 0, y: 0, z: 0 },
    scale: Vec3Like = { x: 0, y: 0, z: 0 },
    rotation = new Quaternion();
  m.decompose(position, rotation, scale);
  rotation.normalize();
  const rebuilt = new Matrix4().compose(position, rotation, scale).elements;
  let error = 0;
  for (let i = 0; i < 16; i++) {
    const d = Math.abs(rebuilt[i] - e[i]);
    error = d === d && d !== Number.POSITIVE_INFINITY ? Math.max(error, d) : Number.POSITIVE_INFINITY;
  }
  // Gram-Schmidt over the columns, in float64.
  const c = (i: number): MutableVec3 => [e[4 * i], e[4 * i + 1], e[4 * i + 2]],
    dot = (a: MutableVec3, b: MutableVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    along = (v: MutableVec3, u: MutableVec3, s: number) => v.map((x, k) => x - s * u[k]) as MutableVec3,
    unit = (v: MutableVec3) => v.map((x) => x / Math.hypot(v[0], v[1], v[2])) as MutableVec3;
  const c0 = c(0),
    c1 = c(1),
    c2 = c(2),
    u0 = unit(c0),
    a01 = dot(u0, c1),
    p1 = along(c1, u0, a01),
    u1 = unit(p1),
    a02 = dot(u0, c2),
    a12 = dot(u1, c2),
    p2 = along(along(c2, u0, a02), u1, a12),
    l1 = Math.hypot(p1[0], p1[1], p1[2]),
    l2 = Math.hypot(p2[0], p2[1], p2[2]),
    det =
      c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
      c0[1] * (c1[0] * c2[2] - c1[2] * c2[0]) +
      c0[2] * (c1[0] * c2[1] - c1[1] * c2[0]);
  return {
    translation: [position.x, position.y, position.z],
    rotation: rotation.toArray(),
    scale: [scale.x, scale.y, scale.z],
    shear: [l1 > 0 ? a01 / l1 : Number.NaN, l2 > 0 ? a02 / l2 : Number.NaN, l2 > 0 ? a12 / l2 : Number.NaN],
    handedness: det > 0 ? 'right' : det < 0 ? 'left' : 'degenerate',
    projective: e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1,
    error,
    lossless: error <= tolerance,
  };
}
