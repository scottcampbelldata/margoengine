// Affine world matrices shared by every command: one check, one inverse and one point transform (math's checked
// transform, so each point matches `Vector3.applyMatrix4` bit for bit for an affine matrix).
import { Matrix4, type Mat4, type MutableVec3, type Vec3 } from '@margoengine/math';
import { invertMatrixStable, transformPointChecked } from '@margoengine/math/mat4';

/** Column-major identity, the default world matrix. */
export const IDENTITY: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Owned float64 copy of an affine column-major matrix.
 * @throws TypeError unless `value` holds 16 finite numbers; RangeError for a projective bottom row.
 */
export function affineMatrix(value: Mat4, label: string): Float64Array {
  if (!value || typeof value !== 'object' || value.length !== 16)
    throw new TypeError(`${label} needs 16 finite column-major numbers; supply an affine matrix.`);
  const matrix = new Float64Array(16);
  for (let i = 0; i < 16; i++) {
    const component = value[i];
    if (typeof component !== 'number' || !Number.isFinite(component))
      throw new TypeError(`${label} needs 16 finite column-major numbers; supply an affine matrix.`);
    matrix[i] = component;
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
    throw new RangeError(`${label} must be affine; remove perspective terms from the transform.`);
  return matrix;
}

/** Determinant of an affine matrix (its upper 3x3). */
export const affineDeterminant = (matrix: Mat4): number => new Matrix4().fromArray(matrix).determinant();

/**
 * Inverse of a checked affine matrix.
 * @throws RangeError when it is singular or its inverse is not finite.
 */
export function invertAffine(matrix: Float64Array, label: string): Float64Array {
  const inverse = invertMatrixStable(matrix, new Float64Array(16));
  if (!inverse) throw new RangeError(`${label} must be invertible; use nonzero finite scales.`);
  return inverse;
}

/**
 * Transform one point by an affine matrix.
 * @throws RangeError when the result is not finite.
 */
export function transformPoint(matrix: Mat4, point: Vec3, label: string): MutableVec3 {
  const result = transformPointChecked(matrix, point);
  if (!result.ok)
    throw new RangeError(`${label} produces nonfinite positions; reduce the transform or coordinate magnitude.`);
  return result.point;
}

/** Transform every point by an affine matrix; see {@link transformPoint}. */
export const transformPoints = (matrix: Mat4, points: readonly Vec3[], label: string): MutableVec3[] =>
  points.map((point) => transformPoint(matrix, point, label));
